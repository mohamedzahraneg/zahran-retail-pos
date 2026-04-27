import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CreateDailyExpenseDto,
  CreateExpenseCategoryDto,
  CreateExpenseDto,
  ListExpensesDto,
  ReportRangeDto,
  UpdateExpenseCategoryDto,
  UpdateExpenseDto,
} from './dto/accounting.dto';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';
import { ExpenseApprovalService } from './approval.service';
import { CostAccountResolver } from './cost-account-resolver.service';

@Injectable()
export class AccountingService {
  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly posting?: AccountingPostingService,
    @Optional() private readonly engine?: FinancialEngineService,
    @Optional() private readonly approvals?: ExpenseApprovalService,
    @Optional() private readonly resolver?: CostAccountResolver,
  ) {}

  // ─── Expense Categories ──────────────────────────────────────────────
  /**
   * List categories with COA mapping preview joined so the Daily
   * Expenses screen can render the "DR <code> <name>" preview without
   * a second round-trip. Includes `account_code` + `account_name` +
   * `account_id` (nullable when category is unmapped).
   */
  listCategories(includeInactive = false) {
    return this.ds.query(
      `SELECT ec.*,
              coa.code    AS account_code,
              coa.name_ar AS account_name_ar,
              (ec.account_id IS NOT NULL) AS has_account
         FROM expense_categories ec
         LEFT JOIN chart_of_accounts coa ON coa.id = ec.account_id
        ${includeInactive ? '' : 'WHERE ec.is_active = TRUE'}
        ORDER BY ec.name_ar`,
    );
  }

  async createCategory(dto: CreateExpenseCategoryDto) {
    const [row] = await this.ds.query(
      `INSERT INTO expense_categories
         (code, name_ar, name_en, is_fixed, allocate_to_cogs, account_id)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        dto.code,
        dto.name_ar,
        dto.name_en ?? null,
        dto.is_fixed ?? false,
        dto.allocate_to_cogs ?? false,
        dto.account_id ?? null,
      ],
    );
    return row;
  }

  async updateCategory(id: string, dto: UpdateExpenseCategoryDto) {
    const fields: string[] = [];
    const params: any[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i++}`);
      params.push(v);
    }
    if (!fields.length) throw new BadRequestException('No fields to update');
    params.push(id);
    const [row] = await this.ds.query(
      `UPDATE expense_categories SET ${fields.join(', ')}
       WHERE id = $${i} RETURNING *`,
      params,
    );
    if (!row) throw new NotFoundException('التصنيف غير موجود');
    return row;
  }

  async deleteCategory(id: string) {
    const [{ n }] = await this.ds.query(
      `SELECT COUNT(*)::int AS n FROM expenses WHERE category_id = $1`,
      [id],
    );
    if (Number(n) > 0) {
      // Soft-delete (archive) when in use
      const [row] = await this.ds.query(
        `UPDATE expense_categories SET is_active = false
          WHERE id = $1 RETURNING id`,
        [id],
      );
      if (!row) throw new NotFoundException('التصنيف غير موجود');
      return { archived: true };
    }
    // Hard-delete when no expenses reference it
    const res = await this.ds.query(
      `DELETE FROM expense_categories WHERE id = $1 RETURNING id`,
      [id],
    );
    if (!res.length) throw new NotFoundException('التصنيف غير موجود');
    return { archived: true };
  }

  // ─── Expenses ────────────────────────────────────────────────────────
  /**
   * Create an expense + post the GL/cashbox entries in one transaction.
   *
   * `opts.strictCategoryMapping` (PR-1 of Daily Expenses series): when
   * true, the resolver refuses to fall through to the 529 catch-all.
   * The supplied `category_id` MUST be mapped to an explicit
   * `account_id` on `expense_categories`. Daily Expenses sets this;
   * legacy / recurring callers do not (preserves their behaviour).
   */
  async createExpense(
    dto: CreateExpenseDto,
    userId: string,
    opts: { strictCategoryMapping?: boolean } = {},
  ) {
    return this.ds.transaction(async (em) => {
      // Auto-resolve cashbox_id AND shift_id from the user's open
      // shift when not supplied — PR-2 records the shift link so the
      // register, close-out reconciliation, and expense analytics
      // can group/filter by shift.
      let cashboxId = dto.cashbox_id ?? null;
      let shiftId: string | null = (dto as any).shift_id ?? null;

      // PR-15 — when the caller picked an explicit shift via the
      // source selector, validate it before auto-resolution. Catches
      // closed shifts and cashbox mismatch with friendly Arabic errors
      // instead of letting the row land on the wrong drawer.
      if (shiftId) {
        const [pickedShift] = await em.query(
          `SELECT id, status, cashbox_id FROM shifts WHERE id = $1`,
          [shiftId],
        );
        if (!pickedShift) {
          throw new BadRequestException('الوردية المختارة غير موجودة');
        }
        if (
          pickedShift.status !== 'open' &&
          pickedShift.status !== 'pending_close'
        ) {
          throw new BadRequestException(
            'لا يمكن الصرف من وردية مغلقة — اختر وردية مفتوحة أو خزنة مباشرة',
          );
        }
        if (cashboxId && cashboxId !== pickedShift.cashbox_id) {
          throw new BadRequestException(
            'الخزنة المختارة لا تطابق خزنة الوردية المختارة',
          );
        }
        cashboxId = cashboxId ?? pickedShift.cashbox_id;
      }

      // Single lookup whether we need cashbox, shift, or both.
      if (!cashboxId || !shiftId) {
        const [openShift] = await em.query(
          `SELECT id AS shift_id, cashbox_id FROM shifts
            WHERE opened_by = $1 AND status = 'open'
            ORDER BY opened_at DESC LIMIT 1`,
          [userId],
        );
        if (openShift) {
          if (!cashboxId) cashboxId = openShift.cashbox_id || null;
          if (!shiftId) shiftId = openShift.shift_id || null;
        }
      }
      // If caller provided a cashbox without a shift, still try to
      // pin the shift via (cashbox + open status) so register rows
      // are consistent. NULL stays NULL when no open shift exists.
      if (cashboxId && !shiftId) {
        const [shift] = await em.query(
          `SELECT id FROM shifts
            WHERE cashbox_id = $1 AND status = 'open'
            ORDER BY opened_at DESC LIMIT 1`,
          [cashboxId],
        );
        shiftId = shift?.id || null;
      }

      // ━━━ CRITICAL INVARIANT ━━━
      // A cash-paid expense MUST move cash when approved. Without a
      // cashbox the engine would silently post the credit side to
      // 210 (Accounts Payable) instead of cash — the expense would be
      // "approved" without any cash leaving the drawer, which violates
      // the core financial contract of the system. Reject at create
      // time so the user gets a clear, fixable error instead of a
      // phantom expense downstream.
      const paymentMethod = dto.payment_method ?? 'cash';
      if (paymentMethod === 'cash' && !cashboxId) {
        throw new BadRequestException(
          'مصروف نقدي يتطلب خزنة مفتوحة — افتح وردية أو حدد خزنة',
        );
      }
      // Employee link:
      //   1. Explicit `employee_user_id` on the DTO (Daily Expenses
      //      screen, migration 060) wins — always.
      //   2. Otherwise fall back to the category-code ↔ employee_no
      //      auto-match for legacy rows.
      let employeeUserId: string | null = (dto as any).employee_user_id ?? null;
      if (!employeeUserId && dto.category_id) {
        const [link] = await em.query(
          `SELECT u.id
             FROM expense_categories ec
             JOIN users u ON u.employee_no = ec.code
            WHERE ec.id = $1 AND u.is_active = TRUE
            LIMIT 1`,
          [dto.category_id],
        );
        if (link?.id) employeeUserId = link.id;
      }
      // Mark as advance either when the caller says so OR when the
      // category-match logic found an employee (legacy behaviour).
      const isAdvance =
        (dto as any).is_advance === true ||
        (employeeUserId !== null && (dto as any).employee_user_id == null);

      // ━━━ PR-ESS-2B — disbursement linkage pre-validation ━━━
      //
      // When the operator passes `source_employee_request_id` we are
      // claiming "this advance daily-expense disburses request #N".
      // Validate that claim BEFORE inserting the expense — any mismatch
      // throws and the transaction rolls back without writing anything.
      //
      // SELECT … FOR UPDATE acquires a row-level lock on the request
      // until the wrapping transaction commits or rolls back. If two
      // disbursement attempts race, the second one blocks until the
      // first commits; whichever loses the race sees status='disbursed'
      // and is rejected with the duplicate-disbursement error.
      const sourceRequestId: number | null =
        (dto as any).source_employee_request_id ?? null;

      if (sourceRequestId !== null) {
        if (!isAdvance) {
          throw new BadRequestException(
            'لا يمكن ربط طلب سلفة بمصروف ليس بسلفة (is_advance=true مطلوب)',
          );
        }
        const [reqRow] = await em.query(
          `SELECT id, user_id, kind, status, amount
             FROM employee_requests
            WHERE id = $1
            FOR UPDATE`,
          [sourceRequestId],
        );
        if (!reqRow) {
          throw new BadRequestException(
            `طلب السلفة (id=${sourceRequestId}) غير موجود`,
          );
        }
        if (reqRow.kind !== 'advance_request') {
          throw new BadRequestException(
            `طلب السلفة المرتبط من نوع غير مدعوم (${reqRow.kind}) — يجب أن يكون advance_request`,
          );
        }
        if (reqRow.status !== 'approved') {
          throw new BadRequestException(
            `طلب السلفة في حالة "${reqRow.status}" — يجب أن يكون "approved" قبل الصرف`,
          );
        }
        if (
          !employeeUserId ||
          reqRow.user_id !== employeeUserId
        ) {
          throw new BadRequestException(
            'الموظف المختار لا يطابق صاحب طلب السلفة',
          );
        }
        // Exact amount match (no partial disbursement in this PR).
        if (Number(reqRow.amount) !== Number(dto.amount)) {
          throw new BadRequestException(
            `قيمة المصروف (${dto.amount}) لا تطابق قيمة طلب السلفة (${reqRow.amount}) — يجب أن تكون متطابقة تمامًا`,
          );
        }
        // Duplicate-disbursement guard: refuse if any other expense
        // already links to this request. The partial unique index from
        // migration 117's index makes this lookup cheap and the FOR
        // UPDATE row lock prevents a TOCTOU race.
        const [existingLink] = await em.query(
          `SELECT id FROM expenses
            WHERE source_employee_request_id = $1
            LIMIT 1`,
          [sourceRequestId],
        );
        if (existingLink) {
          throw new BadRequestException(
            `طلب السلفة مرتبط بالفعل بمصروف آخر (${existingLink.id}) — لا يمكن الصرف مرتين`,
          );
        }
      }

      // `expense_no` is auto-generated by the `trg_set_expense_no` trigger
      // when NULL is passed. We omit it from the column list and pass NULL
      // so the trigger fires before the NOT-NULL check is evaluated.
      // PR-2: shift_id added to the INSERT (column added in migration 093).
      // PR-ESS-2B: source_employee_request_id added (column added in migration 117).
      const [row] = await em.query(
        `INSERT INTO expenses
           (expense_no, warehouse_id, cashbox_id, category_id, amount,
            payment_method, expense_date, description, receipt_url, vendor_name,
            created_by, employee_user_id, is_advance, shift_id,
            source_employee_request_id)
         VALUES (NULL,$1,$2,$3,$4,$5::payment_method_code,COALESCE($6,CURRENT_DATE),
                 $7,$8,$9,$10,$11,$12,$13,$14)
         RETURNING *`,
        [
          dto.warehouse_id,
          cashboxId,
          dto.category_id,
          dto.amount,
          dto.payment_method ?? 'cash',
          dto.expense_date ?? null,
          dto.description ?? null,
          dto.receipt_url ?? null,
          dto.vendor_name ?? null,
          userId,
          employeeUserId,
          isAdvance,
          shiftId,
          sourceRequestId,
        ],
      );
      // ━━━ NO CASH MOVEMENT AT CREATE TIME ━━━
      // The previous implementation decremented the cashbox at insert
      // and *again* at approval (accounting.service.ts:158–188 + 268–292
      // in the old code), producing the user-reported "doubled 2120".
      // Cash now moves exactly once, inside the engine, at approval.

      // Spawn approval rows if any rule matches. If none match, the
      // expense is auto-approved and we post it through the engine
      // immediately — cash + GL in one idempotent call.
      let autoApproved = true;
      if (this.approvals) {
        const spawned = await this.approvals
          .spawnForExpense(row.id, Number(dto.amount), em)
          .catch(() => ({ spawned: 0 } as any));
        if (spawned && spawned.spawned > 0) {
          autoApproved = false;
        }
      }

      if (autoApproved) {
        await em.query(
          `UPDATE expenses SET is_approved = TRUE, approved_by = $1,
              updated_at = NOW() WHERE id = $2`,
          [userId, row.id],
        );
        row.is_approved = true;
        row.approved_by = userId;

        // Route through the engine — cash move (if cash-backed) + GL
        // entry in one atomic, idempotent call. Awaited; no fire-and-
        // forget. Any failure rolls back the whole createExpense
        // transaction, so a failed post leaves zero residue.
        await this.postViaEngine(em, row, userId, {
          strictCategoryMapping: opts.strictCategoryMapping === true,
        });
      }

      return row;
    });
  }

  /**
   * Route an approved expense through FinancialEngineService. Single
   * source of truth for both the cashbox_transactions write and the
   * journal_entries post. Idempotent on (expense, expense_id) — safe
   * to call multiple times.
   */
  private async postViaEngine(
    em: import('typeorm').EntityManager,
    expense: any,
    userId: string,
    opts: { strictCategoryMapping?: boolean } = {},
  ): Promise<void> {
    if (!this.engine) {
      // Legacy fallback — if the engine isn't wired, fall back to the
      // old posting service. Should never happen in production but
      // keeps unit tests that stub only AccountingPostingService green.
      await this.posting
        ?.postExpense(expense.id, userId, em)
        .catch(() => undefined);
      return;
    }

    // Resolve the GL account via the centralized CostAccountResolver
    // (migration 065). Falls back to 529 unless `strictCategoryMapping`
    // is set (Daily Expenses path), in which case the resolver throws
    // UnmappedCategoryError → caught below + surfaced as 400.
    let categoryAccountId: string | null = null;
    if (this.resolver) {
      const hint =
        (expense.category_code as string | undefined) ??
        (expense.description as string | undefined) ??
        undefined;
      try {
        const res = await this.resolver.resolve({
          category_id: expense.category_id,
          hint,
          em,
          strict: opts.strictCategoryMapping === true,
        });
        categoryAccountId = res.account_id;
      } catch (err: any) {
        if (err?.name === 'UnmappedCategoryError') {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
    } else if (expense.category_id) {
      // Defensive legacy path — only hit when resolver isn't wired
      // (e.g., a stubbed unit test). Production always has the
      // resolver via DI.
      const [row] = await em.query(
        `SELECT account_id FROM expense_categories WHERE id = $1`,
        [expense.category_id],
      );
      categoryAccountId = row?.account_id ?? null;
      if (opts.strictCategoryMapping && !categoryAccountId) {
        throw new BadRequestException(
          'هذا البند غير مربوط بحساب محاسبي. اختر الحساب أولًا.',
        );
      }
    }

    // Safety net: even with the resolver, the engine accepts
    // `category_account_id: null` and falls back to 529 internally
    // (financial-engine.service.ts:858-860). For Daily Expenses we
    // refuse that path entirely.
    if (
      opts.strictCategoryMapping &&
      !categoryAccountId &&
      expense.is_advance !== true
    ) {
      throw new BadRequestException(
        'هذا البند غير مربوط بحساب محاسبي. اختر الحساب أولًا.',
      );
    }

    const res = await this.engine.recordExpense({
      expense_id: expense.id,
      expense_no: expense.expense_no,
      amount: Number(expense.amount),
      category_account_id: categoryAccountId,
      cashbox_id: expense.cashbox_id,
      payment_method: expense.payment_method,
      user_id: userId,
      entry_date: expense.expense_date ?? undefined,
      em,
      description: expense.description ?? undefined,
      is_advance: expense.is_advance === true,
      employee_user_id: expense.employee_user_id ?? null,
    });

    if (!res.ok) {
      // Engine returned a structured failure — surface it so the
      // surrounding transaction rolls back and the caller sees the
      // error at the API boundary instead of silently losing the
      // cashbox/GL side.
      throw new BadRequestException(
        `فشل ترحيل المصروف: ${res.error}`,
      );
    }

    // ━━━ PR-ESS-2B — flip the linked employee_request to 'disbursed' ━━━
    //
    // Runs INSIDE the same transaction as the engine post: if the engine
    // succeeded, the status flip joins the same atomic commit. If the
    // engine threw above, we never reach here and the request stays
    // 'approved'.
    //
    // The pre-validation block (createExpense, lines ~225-285) already
    // proved the linked request is in `kind='advance_request',
    // status='approved'` and acquired a row lock via SELECT … FOR
    // UPDATE. The UPDATE here can therefore be unguarded on those
    // fields, but we still match `status='approved'` so a hypothetical
    // out-of-band concurrent flip (which would have to violate the row
    // lock) is treated as a no-op rather than a corruption.
    if (expense.source_employee_request_id) {
      const flipped = await em.query(
        `UPDATE employee_requests
            SET status = 'disbursed',
                decision_reason = COALESCE(decision_reason || E'\n\n', '') ||
                                  'Disbursed via expense ' || $2 ||
                                  ' (PR-ESS-2B).'
          WHERE id = $1
            AND status = 'approved'
          RETURNING id`,
        [expense.source_employee_request_id, expense.expense_no],
      );
      if (!flipped.length) {
        // Defensive — the row lock should have prevented this. Throwing
        // rolls back the engine post too, keeping the books consistent.
        throw new BadRequestException(
          `لم يتم تحديث حالة طلب السلفة (id=${expense.source_employee_request_id}) — قد يكون قد تم صرفه بالفعل`,
        );
      }
    }
  }

  /**
   * Daily Expenses screen (migration 060).
   *
   * Thin wrapper on `createExpense` that enforces the "must be tied to
   * an employee" contract:
   *
   *   * admin / manager → may pick any employee
   *   * anyone else     → is forced to book the expense against their
   *                       own user id (no picking someone else)
   *
   * The underlying posting path is identical to a regular expense —
   * we reuse the engine, cashbox movement, idempotency guard, audit
   * trigger, and category ↔ GL account mapping. No duplicate pipeline.
   */
  async createDailyExpense(
    dto: CreateDailyExpenseDto,
    userId: string,
    userPermissions: string[] = [],
  ) {
    const canPickOthers =
      userPermissions.includes('*') ||
      userPermissions.includes('expenses.*') ||
      userPermissions.includes('expenses.daily.pick_employee') ||
      userPermissions.includes('employee.team.view') ||
      userPermissions.includes('accounts.journal.post');

    const effectiveEmployee =
      canPickOthers ? dto.employee_user_id : userId;

    if (!canPickOthers && dto.employee_user_id && dto.employee_user_id !== userId) {
      throw new ForbiddenException(
        'لا يمكنك تسجيل المصروف على موظف آخر — تواصل مع المدير',
      );
    }

    // Daily expenses aren't branch-scoped. When the bundle hasn't been
    // built with VITE_DEFAULT_WAREHOUSE_ID (the common case on prod)
    // the request arrives with warehouse_id undefined — resolve the
    // first active warehouse here so the expense still posts.
    let warehouseId = dto.warehouse_id ?? null;
    if (!warehouseId) {
      const [wh] = await this.ds.query(
        `SELECT id FROM warehouses WHERE is_active = TRUE
          ORDER BY created_at ASC LIMIT 1`,
      );
      if (!wh) {
        throw new BadRequestException(
          'لا يوجد مخزن فعّال — أضف مخزن قبل تسجيل المصروفات اليومية',
        );
      }
      warehouseId = wh.id;
    }

    // PR-1 (Daily Expenses): strict category mapping. Refuses to fall
    // back to 529 silently. Admin must map the category to an explicit
    // GL account first; if the category is missing or unmapped the
    // resolver throws and the response is a 400 with the Arabic
    // message users see in the UI.
    return this.createExpense(
      {
        ...dto,
        warehouse_id: warehouseId,
        employee_user_id: effectiveEmployee,
      } as any,
      userId,
      { strictCategoryMapping: true },
    );
  }

  async updateExpense(id: string, dto: UpdateExpenseDto) {
    const fields: string[] = [];
    const params: any[] = [];
    let i = 1;
    for (const [k, v] of Object.entries(dto)) {
      if (v === undefined) continue;
      fields.push(`${k} = $${i++}`);
      params.push(v);
    }
    if (!fields.length) throw new BadRequestException('No fields to update');
    fields.push(`updated_at = NOW()`);
    params.push(id);
    const [row] = await this.ds.query(
      `UPDATE expenses SET ${fields.join(', ')}
       WHERE id = $${i} AND is_approved = FALSE
       RETURNING *`,
      params,
    );
    if (!row)
      throw new NotFoundException(
        'المصروف غير موجود أو تم اعتماده بالفعل',
      );
    return row;
  }

  async approveExpense(id: string, userId: string) {
    return this.ds.transaction(async (em) => {
      const [exp] = await em.query(
        `SELECT * FROM expenses WHERE id = $1 FOR UPDATE`,
        [id],
      );
      if (!exp) throw new NotFoundException('المصروف غير موجود');
      if (exp.is_approved)
        throw new BadRequestException('تم اعتماد هذا المصروف من قبل');

      const [row] = await em.query(
        `UPDATE expenses SET is_approved = TRUE, approved_by = $1, updated_at = NOW()
         WHERE id = $2 RETURNING *`,
        [userId, id],
      );

      // Route through the engine — it writes the cashbox_transactions
      // row AND the GL entry atomically, and is idempotent on the
      // expense id. No more duplicate-deduction bug (the old code
      // debited the cashbox here *and* at create time).
      await this.postViaEngine(em, row, userId);

      return row;
    });
  }

  async deleteExpense(id: string) {
    const res = await this.ds.query(
      `DELETE FROM expenses WHERE id = $1 AND is_approved = FALSE RETURNING id`,
      [id],
    );
    if (!res.length)
      throw new NotFoundException(
        'المصروف غير موجود أو تم اعتماده ولا يمكن حذفه',
      );
    return { deleted: true };
  }

  async listExpenses(filters: ListExpensesDto) {
    const conds: string[] = [];
    const ps: any[] = [];
    if (filters.from) {
      ps.push(filters.from);
      conds.push(`e.expense_date >= $${ps.length}`);
    }
    if (filters.to) {
      ps.push(filters.to);
      conds.push(`e.expense_date <= $${ps.length}`);
    }
    if (filters.category_id) {
      ps.push(filters.category_id);
      conds.push(`e.category_id = $${ps.length}`);
    }
    if (filters.warehouse_id) {
      ps.push(filters.warehouse_id);
      conds.push(`e.warehouse_id = $${ps.length}`);
    }
    if (filters.status === 'approved') conds.push(`e.is_approved = TRUE`);
    else if (filters.status === 'pending') conds.push(`e.is_approved = FALSE`);
    // PR-3: register filters — employee, cashbox, shift.
    if (filters.employee_user_id) {
      ps.push(filters.employee_user_id);
      conds.push(`e.employee_user_id = $${ps.length}`);
    }
    if (filters.cashbox_id) {
      ps.push(filters.cashbox_id);
      conds.push(`e.cashbox_id = $${ps.length}`);
    }
    if (filters.shift_id) {
      ps.push(filters.shift_id);
      conds.push(`e.shift_id = $${ps.length}`);
    }
    if (filters.q) {
      ps.push(`%${filters.q}%`);
      conds.push(
        `(e.description ILIKE $${ps.length} OR e.vendor_name ILIKE $${ps.length} OR e.expense_no ILIKE $${ps.length})`,
      );
    }
    // PR-12 — edit-status filter. Implemented as EXISTS subqueries on
    // expense_edit_requests so the index `ix_expense_edit_requests_pending`
    // (partial, status='pending') stays usable when filtering pending.
    if (filters.edit_status === 'none') {
      conds.push(
        `NOT EXISTS (SELECT 1 FROM expense_edit_requests r WHERE r.expense_id = e.id)`,
      );
    } else if (filters.edit_status === 'pending') {
      conds.push(
        `EXISTS (SELECT 1 FROM expense_edit_requests r WHERE r.expense_id = e.id AND r.status = 'pending')`,
      );
    } else if (filters.edit_status === 'approved') {
      conds.push(
        `EXISTS (SELECT 1 FROM expense_edit_requests r WHERE r.expense_id = e.id AND r.status = 'approved')`,
      );
    } else if (filters.edit_status === 'rejected') {
      conds.push(
        `EXISTS (SELECT 1 FROM expense_edit_requests r WHERE r.expense_id = e.id AND r.status = 'rejected')`,
      );
    } else if (filters.edit_status === 'any') {
      conds.push(
        `EXISTS (SELECT 1 FROM expense_edit_requests r WHERE r.expense_id = e.id)`,
      );
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    ps.push(filters.limit ?? 100);
    ps.push(filters.offset ?? 0);

    // PR-2: JOIN shifts + cashboxes + the responsible employee.
    // PR-3: also LATERAL-JOIN the JE so the register can show the
    // entry_no and is_void status of the posted journal_entry. The
    // engine writes journal_entries with reference_type='expense' AND
    // reference_id=expenses.id; one expense → at most one JE.
    const rows = await this.ds.query(
      `SELECT e.*,
              c.name_ar     AS category_name,
              c.code        AS category_code,
              coa.code      AS account_code,
              coa.name_ar   AS account_name_ar,
              w.name_ar     AS warehouse_name,
              uc.full_name  AS created_by_name,
              ua.full_name  AS approved_by_name,
              ue.full_name  AS employee_name,
              ue.username   AS employee_username,
              cb.name_ar    AS cashbox_name,
              s.shift_no    AS shift_no,
              je.entry_no   AS je_entry_no,
              je.is_void    AS je_is_void,
              COALESCE(er.has_pending_edit_request, FALSE) AS has_pending_edit_request,
              er.last_edit_status        AS last_edit_status,
              COALESCE(er.edit_request_count,    0) AS edit_request_count,
              COALESCE(er.approved_edit_count,   0) AS approved_edit_count,
              COALESCE(er.rejected_edit_count,   0) AS rejected_edit_count
       FROM expenses e
       LEFT JOIN expense_categories c ON c.id = e.category_id
       LEFT JOIN chart_of_accounts coa ON coa.id = c.account_id
       LEFT JOIN warehouses w         ON w.id = e.warehouse_id
       LEFT JOIN users uc             ON uc.id = e.created_by
       LEFT JOIN users ua             ON ua.id = e.approved_by
       LEFT JOIN users ue             ON ue.id = e.employee_user_id
       LEFT JOIN cashboxes cb         ON cb.id = e.cashbox_id
       LEFT JOIN shifts s             ON s.id  = e.shift_id
       LEFT JOIN LATERAL (
         SELECT entry_no, is_void
           FROM journal_entries
          WHERE reference_type = 'expense' AND reference_id = e.id
          ORDER BY created_at DESC
          LIMIT 1
       ) je ON TRUE
       LEFT JOIN LATERAL (
         -- PR-11 (migration 094) + PR-12: rolled-up edit-request state
         -- so the register can render badges + filter on edit status
         -- in a single round-trip.
         --
         --   has_pending_edit_request   — at least one pending request
         --   last_edit_status           — status of the latest request
         --                                (pending / approved / rejected
         --                                 / cancelled), NULL when none
         --   edit_request_count         — total requests on this expense
         --                                across the whole lifetime
         --   approved_edit_count        — non-zero when row was edited
         SELECT
           BOOL_OR(status = 'pending')                                 AS has_pending_edit_request,
           (ARRAY_AGG(status ORDER BY requested_at DESC))[1]           AS last_edit_status,
           COUNT(*)::int                                               AS edit_request_count,
           COUNT(*) FILTER (WHERE status = 'approved')::int            AS approved_edit_count,
           COUNT(*) FILTER (WHERE status = 'rejected')::int            AS rejected_edit_count
           FROM expense_edit_requests
          WHERE expense_id = e.id
       ) er ON TRUE
       ${where}
       ORDER BY e.expense_date DESC, e.created_at DESC
       LIMIT $${ps.length - 1} OFFSET $${ps.length}`,
      ps,
    );

    const [tot] = await this.ds.query(
      `SELECT COUNT(*)::int AS total, COALESCE(SUM(amount),0)::numeric AS total_amount
       FROM expenses e ${where}`,
      ps.slice(0, ps.length - 2),
    );

    return { items: rows, total: tot.total, total_amount: Number(tot.total_amount) };
  }

  // ─── Reports ─────────────────────────────────────────────────────────

  /** Profit & Loss for a date range */
  /**
   * Smart human-readable analysis of a P&L range. Returns Arabic strings the
   * UI can show directly (e.g. "ربح جيد" / "خسارة — السبب: زيادة المصروفات").
   */
  async profitAndLossAnalysis(dto: ReportRangeDto) {
    const pl = await this.profitAndLoss(dto);
    const revenue = Number(pl.revenue || 0);
    const netRev = Number(pl.net_revenue || 0);
    const netProfit = Number(pl.net_profit || 0);
    const cogs = Number(pl.cogs || 0);
    const expenses = Number(pl.total_expenses || 0);
    const returns = Number(pl.returns || 0);
    const grossPct = Number(pl.gross_margin_pct || 0);
    const netPct = Number(pl.net_margin_pct || 0);

    // Headline classification
    let headline: 'profit' | 'loss' | 'breakeven' = 'breakeven';
    let headlineLabel = 'تعادل';
    let headlineTone: 'green' | 'red' | 'amber' = 'amber';
    if (netProfit > 0) {
      headline = 'profit';
      headlineTone = 'green';
      if (netPct >= 20) headlineLabel = 'ربح ممتاز';
      else if (netPct >= 10) headlineLabel = 'ربح جيد';
      else headlineLabel = 'ربح ضعيف';
    } else if (netProfit < 0) {
      headline = 'loss';
      headlineTone = 'red';
      headlineLabel = 'خسارة';
    }

    // Reasons (plain-Arabic diagnostics, ordered by severity)
    const reasons: Array<{ code: string; message: string; severity: 'info' | 'warning' | 'critical' }> = [];

    if (revenue === 0) {
      reasons.push({
        code: 'no_sales',
        message: 'لا توجد مبيعات في هذه الفترة.',
        severity: 'critical',
      });
    }
    if (returns > 0 && revenue > 0) {
      const retPct = (returns / revenue) * 100;
      if (retPct >= 20) {
        reasons.push({
          code: 'high_returns',
          message: `نسبة المرتجعات مرتفعة (${retPct.toFixed(1)}% من الإيراد) — راجع أسباب الإرجاع.`,
          severity: 'critical',
        });
      } else if (retPct >= 10) {
        reasons.push({
          code: 'elevated_returns',
          message: `نسبة المرتجعات ${retPct.toFixed(1)}% — تستحق المتابعة.`,
          severity: 'warning',
        });
      }
    }
    if (cogs > 0 && revenue > 0) {
      const cogsPct = (cogs / revenue) * 100;
      if (cogsPct >= 80) {
        reasons.push({
          code: 'high_cogs',
          message: `تكلفة البضاعة المباعة ${cogsPct.toFixed(0)}% من الإيراد — الأسعار منخفضة أو التكلفة مرتفعة.`,
          severity: 'warning',
        });
      }
    }
    if (expenses > 0 && netRev > 0) {
      const expPct = (expenses / netRev) * 100;
      if (expPct >= 40) {
        reasons.push({
          code: 'high_expenses',
          message: `المصروفات التشغيلية ${expPct.toFixed(0)}% من صافي الإيراد — راجع أكبر بنود المصاريف.`,
          severity: 'warning',
        });
      }
    }
    if (grossPct < 15 && revenue > 0) {
      reasons.push({
        code: 'low_margin',
        message: `هامش الربح الإجمالي منخفض (${grossPct.toFixed(1)}%) — فكّر في رفع الأسعار أو خفض التكلفة.`,
        severity: 'warning',
      });
    }
    if (headline === 'profit' && reasons.length === 0) {
      reasons.push({
        code: 'healthy',
        message: 'المؤشرات كلها في المدى الصحي. استمر!',
        severity: 'info',
      });
    }

    // Actionable suggestions
    const suggestions: string[] = [];
    if (returns > 0) {
      suggestions.push('راجع تقرير المرتجعات لمعرفة السبب الأكثر تكراراً.');
    }
    if (expenses > revenue * 0.3) {
      suggestions.push('قارن المصاريف بالفترة السابقة لكشف البنود التي زادت.');
    }
    if (netPct < 5 && netPct > 0) {
      suggestions.push('أضف منتجات ذات هامش أعلى، أو اعرض عروض تسريع الدوران.');
    }
    if (headline === 'loss') {
      suggestions.push('حدّد أكبر 3 بنود مصاريف وتفاوض أو ألغِ ما يمكن تأجيله.');
      suggestions.push('افحص أسعار البيع — هل تغطي التكلفة + هامش أدنى 20%؟');
    }

    return {
      ...pl,
      analysis: {
        headline,
        headline_label: headlineLabel,
        headline_tone: headlineTone,
        reasons,
        suggestions,
      },
    };
  }

  async profitAndLoss(dto: ReportRangeDto) {
    const wCond = dto.warehouse_id ? `AND warehouse_id = $3` : '';
    const params: any[] = [dto.from, dto.to];
    if (dto.warehouse_id) params.push(dto.warehouse_id);

    // Revenue (completed invoices) — exclude VAT so it ties to the GL
    // account (411 = grand_total − tax_amount). Tax is tracked
    // separately via 214.
    const [revRow] = await this.ds.query(
      `SELECT
         COALESCE(SUM(grand_total - tax_amount),0)::numeric          AS revenue,
         COALESCE(SUM(tax_amount),0)::numeric                        AS tax,
         COALESCE(SUM(grand_total),0)::numeric                       AS gross_sales,
         COALESCE(SUM(invoice_discount
                     + items_discount_total
                     + coupon_discount),0)::numeric                  AS discounts,
         COALESCE(SUM(cogs_total),0)::numeric                        AS cogs,
         COUNT(*)::int                                               AS invoice_count
       FROM invoices
       WHERE status IN ('completed','paid','partially_paid')
         AND (COALESCE(completed_at, created_at) AT TIME ZONE 'Africa/Cairo')::date
             BETWEEN $1 AND $2
         ${wCond}`,
      params,
    );

    // Returns table uses 'approved'/'refunded' statuses and the
    // net_refund column — the old code referenced return_receipts
    // which doesn't exist in this schema, so every return was lost.
    const [retRow] = await this.ds.query(
      `SELECT COALESCE(SUM(net_refund),0)::numeric AS returns_total
       FROM returns
       WHERE status IN ('approved','refunded')
         AND (requested_at AT TIME ZONE 'Africa/Cairo')::date BETWEEN $1 AND $2`,
      [dto.from, dto.to],
    );

    // Expenses by category — accept all expenses regardless of
    // is_approved (that flag isn't always populated) and tolerate the
    // optional allocate_to_cogs / is_fixed columns.
    const expByCat = await this.ds.query(
      `SELECT c.code, c.name_ar,
              COALESCE(c.is_fixed, FALSE)         AS is_fixed,
              COALESCE(c.allocate_to_cogs, FALSE) AS allocate_to_cogs,
              COALESCE(SUM(e.amount),0)::numeric  AS total
       FROM expenses e
       JOIN expense_categories c ON c.id = e.category_id
       WHERE e.expense_date BETWEEN $1 AND $2
         ${dto.warehouse_id ? 'AND e.warehouse_id = $3' : ''}
       GROUP BY c.id, c.code, c.name_ar, c.is_fixed, c.allocate_to_cogs
       ORDER BY total DESC`,
      params,
    );

    const revenue = Number(revRow.revenue);
    const cogs = Number(revRow.cogs);
    const returns = Number(retRow.returns_total);
    const totalExpenses = expByCat.reduce(
      (s: number, r: any) => s + Number(r.total),
      0,
    );
    const allocatedExpenses = expByCat
      .filter((r: any) => r.allocate_to_cogs)
      .reduce((s: number, r: any) => s + Number(r.total), 0);
    const operatingExpenses = totalExpenses - allocatedExpenses;

    const netRevenue = revenue - returns;
    const grossProfit = netRevenue - cogs - allocatedExpenses;
    const netProfit = grossProfit - operatingExpenses;

    return {
      range: { from: dto.from, to: dto.to },
      warehouse_id: dto.warehouse_id ?? null,
      revenue,                               // net of VAT (matches GL 411)
      gross_sales: Number(revRow.gross_sales), // including VAT (cash received)
      tax: Number(revRow.tax),
      discounts: Number(revRow.discounts),
      invoice_count: revRow.invoice_count,
      returns,
      net_revenue: netRevenue,
      cogs,
      allocated_expenses: allocatedExpenses,
      gross_profit: grossProfit,
      operating_expenses: operatingExpenses,
      total_expenses: totalExpenses,
      net_profit: netProfit,
      gross_margin_pct: netRevenue > 0 ? (grossProfit / netRevenue) * 100 : 0,
      net_margin_pct: netRevenue > 0 ? (netProfit / netRevenue) * 100 : 0,
      expenses_by_category: expByCat,
    };
  }

  /** Cashflow summary using cashbox_transactions */
  async cashflow(dto: ReportRangeDto) {
    const params: any[] = [dto.from, dto.to];
    const wCond = dto.warehouse_id
      ? `AND cb.warehouse_id = $3`
      : '';
    if (dto.warehouse_id) params.push(dto.warehouse_id);

    const byCat = await this.ds.query(
      `SELECT t.category, t.direction,
              COALESCE(SUM(t.amount),0)::numeric AS total,
              COUNT(*)::int                     AS count
       FROM cashbox_transactions t
       JOIN cashboxes cb ON cb.id = t.cashbox_id
       WHERE t.created_at::date BETWEEN $1 AND $2
         ${wCond}
       GROUP BY t.category, t.direction
       ORDER BY total DESC`,
      params,
    );

    const inflow = byCat
      .filter((r: any) => r.direction === 'in')
      .reduce((s: number, r: any) => s + Number(r.total), 0);
    const outflow = byCat
      .filter((r: any) => r.direction === 'out')
      .reduce((s: number, r: any) => s + Number(r.total), 0);

    return {
      range: { from: dto.from, to: dto.to },
      inflow,
      outflow,
      net: inflow - outflow,
      breakdown: byCat,
    };
  }

  /** Trial balance — opening balance + period activity per cashbox */
  async trialBalance(dto: ReportRangeDto) {
    const params: any[] = [dto.from, dto.to];
    const wCond = dto.warehouse_id ? `AND cb.warehouse_id = $3` : '';
    if (dto.warehouse_id) params.push(dto.warehouse_id);

    return this.ds.query(
      `SELECT
         cb.id                                   AS cashbox_id,
         cb.name_ar                              AS cashbox_name,
         cb.warehouse_id,
         w.name_ar                               AS warehouse_name,
         cb.current_balance::numeric             AS current_balance,
         COALESCE(SUM(CASE WHEN t.direction = 'in'  AND t.created_at::date BETWEEN $1 AND $2
                          THEN t.amount END),0)::numeric AS period_in,
         COALESCE(SUM(CASE WHEN t.direction = 'out' AND t.created_at::date BETWEEN $1 AND $2
                          THEN t.amount END),0)::numeric AS period_out,
         COALESCE(SUM(CASE WHEN t.direction = 'in'  AND t.created_at::date < $1
                          THEN t.amount END),0)::numeric AS opening_in,
         COALESCE(SUM(CASE WHEN t.direction = 'out' AND t.created_at::date < $1
                          THEN t.amount END),0)::numeric AS opening_out
       FROM cashboxes cb
       LEFT JOIN warehouses w ON w.id = cb.warehouse_id
       LEFT JOIN cashbox_transactions t ON t.cashbox_id = cb.id
       WHERE cb.is_active = TRUE
         ${wCond}
       GROUP BY cb.id, w.name_ar
       ORDER BY cb.name_ar`,
      params,
    );
  }

  /** General ledger — paginated cashbox transactions */
  async generalLedger(filters: {
    from?: string;
    to?: string;
    cashbox_id?: string;
    category?: string;
    limit?: number;
    offset?: number;
  }) {
    const conds: string[] = [];
    const ps: any[] = [];
    if (filters.from) {
      ps.push(filters.from);
      conds.push(`t.created_at::date >= $${ps.length}`);
    }
    if (filters.to) {
      ps.push(filters.to);
      conds.push(`t.created_at::date <= $${ps.length}`);
    }
    if (filters.cashbox_id) {
      ps.push(filters.cashbox_id);
      conds.push(`t.cashbox_id = $${ps.length}`);
    }
    if (filters.category) {
      ps.push(filters.category);
      conds.push(`t.category = $${ps.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    ps.push(filters.limit ?? 200);
    ps.push(filters.offset ?? 0);

    return this.ds.query(
      `SELECT t.*, cb.name_ar AS cashbox_name, u.full_name AS user_name
       FROM cashbox_transactions t
       LEFT JOIN cashboxes cb ON cb.id = t.cashbox_id
       LEFT JOIN users u      ON u.id  = t.user_id
       ${where}
       ORDER BY t.created_at DESC
       LIMIT $${ps.length - 1} OFFSET $${ps.length}`,
      ps,
    );
  }

  /**
   * Quick financial KPIs for the accounting page header.
   *
   * Without args → today's snapshot (Cairo calendar). With `from`/`to`
   * → inclusive range; the "today_*" keys hold the range totals so the
   * UI labels can rename themselves freely.
   */
  async kpis(args?: { date?: string; from?: string; to?: string }) {
    const [{ cairo_today }] = await this.ds.query(
      `SELECT (now() AT TIME ZONE 'Africa/Cairo')::date::text AS cairo_today`,
    );
    const isISO = (s?: string) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
    const single = isISO(args?.date) ? args!.date! : cairo_today;
    const from = isISO(args?.from) ? args!.from! : single;
    const to = isISO(args?.to) ? args!.to! : single;
    const monthStart = to.slice(0, 7) + '-01';

    const [today_pl, month_pl] = await Promise.all([
      this.profitAndLoss({ from, to } as any),
      this.profitAndLoss({ from: monthStart, to } as any),
    ]);

    const [pendingRow] = await this.ds.query(
      `SELECT COUNT(*)::int AS pending_expenses,
              COALESCE(SUM(amount),0)::numeric AS pending_amount
       FROM expenses
       WHERE is_approved = FALSE`,
    );

    const [invCount] = await this.ds.query(
      `SELECT COUNT(*)::int AS n
         FROM invoices
        WHERE status IN ('paid','completed','partially_paid')
          AND (COALESCE(completed_at, created_at) AT TIME ZONE 'Africa/Cairo')::date
              BETWEEN $1::date AND $2::date`,
      [from, to],
    );
    const [expCount] = await this.ds.query(
      `SELECT COUNT(*)::int AS n
         FROM expenses
        WHERE expense_date BETWEEN $1::date AND $2::date`,
      [from, to],
    );
    // Payments: money ACTUALLY received in the period. Uses the
    // payment timestamp (not the invoice's completed_at). Excludes
    // payments whose parent invoice was voided — those rows stay in
    // the table for audit but shouldn't count toward today's cash in.
    const [payments] = await this.ds.query(
      `SELECT COALESCE(SUM(ip.amount), 0)::numeric(14,2) AS today_payments,
              COUNT(*)::int                               AS payments_count
         FROM invoice_payments ip
         JOIN invoices i ON i.id = ip.invoice_id
        WHERE (ip.created_at AT TIME ZONE 'Africa/Cairo')::date
              BETWEEN $1::date AND $2::date
          AND COALESCE(i.status, 'paid') <> 'cancelled'`,
      [from, to],
    );
    // Shift variance across every CLOSED shift in the range.
    // variance = actual - expected   →   +surplus / −deficit
    // Open/pending shifts are excluded — they have no variance yet.
    const [shift] = await this.ds.query(
      `SELECT COALESCE(SUM(COALESCE(actual_closing, 0) - expected_closing), 0)
                ::numeric(14,2) AS variance
         FROM shifts
        WHERE status = 'closed'
          AND actual_closing IS NOT NULL
          AND (opened_at AT TIME ZONE 'Africa/Cairo')::date
              BETWEEN $1::date AND $2::date`,
      [from, to],
    );

    return {
      date: single,
      from,
      to,
      today: today_pl,
      month: month_pl,
      today_invoice_count: Number(invCount?.n || 0),
      today_expense_count: Number(expCount?.n || 0),
      today_payments: Number(payments?.today_payments || 0),
      today_payments_count: Number(payments?.payments_count || 0),
      // Variance semantics: positive = surplus, negative = deficit.
      // `today_shift_remaining` is kept for backwards compat — same value.
      today_shift_variance: Number(shift?.variance || 0),
      today_shift_remaining: Number(shift?.variance || 0),
      pending_expenses: pendingRow.pending_expenses,
      pending_amount: Number(pendingRow.pending_amount),
    };
  }

  // ─── Expense edit-request workflow (migration 094) ──────────────────
  //
  // Approved expenses can no longer be `updateExpense`d directly (the
  // method's own guard rejects them on line 455). The workflow below
  // is the only safe path to correct an already-posted expense:
  //   * `requestExpenseEdit` snapshots the editable fields and queues
  //     a pending request with a required reason.
  //   * `approveEditRequest` (the heart of the workflow) atomically
  //     voids the original JE + cashbox movement via the engine's
  //     `reversal_of` mechanism, updates the expenses row in place,
  //     and posts a fresh JE with the corrected values. Trial balance
  //     stays at 0; cashbox drift stays at 0.
  //   * `rejectEditRequest` / `cancelEditRequest` close the request
  //     without touching accounting.
  // The audit trail (requested_by, decided_by, voided/applied JE ids,
  // old/new values, reason) lives in `expense_edit_requests`.
  //
  // Description-only / employee-only / payment_method-only edits skip
  // the void+repost — the row is updated in place, audit log records
  // the change.
  // ──────────────────────────────────────────────────────────────────

  /** Editable fields the workflow accepts. Anything outside this set is
   *  rejected at DTO validation; this constant is the source of truth
   *  used by `requestExpenseEdit`, `approveEditRequest`, and the audit
   *  snapshot. */
  private readonly EDITABLE_FIELDS = [
    'category_id',
    'amount',
    'cashbox_id',
    'expense_date',
    'employee_user_id',
    'payment_method',
    'description',
  ] as const;

  /** Subset of editable fields whose change requires void + repost. */
  private readonly ACCOUNTING_FIELDS = [
    'category_id',
    'amount',
    'cashbox_id',
    'expense_date',
    'payment_method',
  ] as const;

  async requestExpenseEdit(
    expenseId: string,
    dto: { reason: string; new_values: Record<string, any> },
    userId: string,
  ) {
    const reason = (dto.reason || '').trim();
    if (reason.length < 5) {
      throw new BadRequestException('سبب التعديل مطلوب (5 أحرف على الأقل)');
    }

    const [expense] = await this.ds.query(
      `SELECT id, expense_no, category_id, amount, cashbox_id,
              expense_date, employee_user_id, payment_method, description,
              is_advance
         FROM expenses WHERE id = $1`,
      [expenseId],
    );
    if (!expense) throw new NotFoundException('expense not found');

    // Refuse a second pending request on the same expense — keeps the
    // approver's inbox unambiguous and prevents racing edits.
    const [pending] = await this.ds.query(
      `SELECT id FROM expense_edit_requests
        WHERE expense_id = $1 AND status = 'pending' LIMIT 1`,
      [expenseId],
    );
    if (pending) {
      throw new BadRequestException(
        'هناك طلب تعديل معلق بالفعل لهذا المصروف',
      );
    }

    // Strip undefined / unknown fields. Whitelist only what's editable.
    const cleanNew: Record<string, any> = {};
    for (const k of this.EDITABLE_FIELDS) {
      if ((dto.new_values ?? {})[k] !== undefined) {
        cleanNew[k] = (dto.new_values as any)[k];
      }
    }
    if (!Object.keys(cleanNew).length) {
      throw new BadRequestException('لا توجد تغييرات لتسجيلها');
    }

    // Snapshot OLD values for the same set of editable fields. Coerce
    // expense_date through ISO so the JSON snapshot is stable.
    const oldValues: Record<string, any> = {};
    for (const k of this.EDITABLE_FIELDS) {
      const v = (expense as any)[k];
      if (k === 'expense_date' && v) {
        oldValues[k] =
          typeof v === 'string' ? v : new Date(v).toISOString().slice(0, 10);
      } else if (k === 'amount') {
        oldValues[k] = Number(v ?? 0);
      } else {
        oldValues[k] = v ?? null;
      }
    }

    // Reject no-op requests (every new value matches the existing one).
    let hasDiff = false;
    for (const [k, v] of Object.entries(cleanNew)) {
      const a = String(v ?? '');
      const b = String((oldValues as any)[k] ?? '');
      if (a !== b) {
        hasDiff = true;
        break;
      }
    }
    if (!hasDiff) {
      throw new BadRequestException('القيم الجديدة مطابقة للحالية');
    }

    const [row] = await this.ds.query(
      `INSERT INTO expense_edit_requests
         (expense_id, requested_by, reason, old_values, new_values)
       VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)
       RETURNING *`,
      [
        expenseId,
        userId,
        reason,
        JSON.stringify(oldValues),
        JSON.stringify(cleanNew),
      ],
    );
    return row;
  }

  async listEditRequestsForExpense(expenseId: string) {
    return this.ds.query(
      `SELECT r.*,
              ru.full_name AS requested_by_name,
              du.full_name AS decided_by_name,
              jv.entry_no  AS voided_je_no,
              ja.entry_no  AS applied_je_no
         FROM expense_edit_requests r
         LEFT JOIN users ru             ON ru.id = r.requested_by
         LEFT JOIN users du             ON du.id = r.decided_by
         LEFT JOIN journal_entries jv   ON jv.id = r.voided_je_id
         LEFT JOIN journal_entries ja   ON ja.id = r.applied_je_id
        WHERE r.expense_id = $1
        ORDER BY r.requested_at DESC`,
      [expenseId],
    );
  }

  async editRequestsInbox() {
    return this.ds.query(
      `SELECT r.*,
              e.expense_no,
              e.amount AS current_amount,
              ru.full_name AS requested_by_name,
              c.name_ar    AS current_category_name,
              cb.name_ar   AS current_cashbox_name
         FROM expense_edit_requests r
         JOIN expenses e                ON e.id = r.expense_id
         LEFT JOIN expense_categories c ON c.id = e.category_id
         LEFT JOIN cashboxes cb         ON cb.id = e.cashbox_id
         LEFT JOIN users ru             ON ru.id = r.requested_by
        WHERE r.status = 'pending'
        ORDER BY r.requested_at ASC`,
    );
  }

  /** Aggregated edit-request stats for the analytics tab's audit
   *  KPIs. Counts requests inside the date range AND distinct expenses
   *  that have any edit. Optional `from`/`to` mirror the listing
   *  filter so the analytics card stays in lock-step with the
   *  register total. */
  async editRequestsStats(filters: { from?: string; to?: string }) {
    const conds: string[] = [];
    const ps: any[] = [];
    if (filters.from) {
      ps.push(filters.from);
      conds.push(`e.expense_date >= $${ps.length}`);
    }
    if (filters.to) {
      ps.push(filters.to);
      conds.push(`e.expense_date <= $${ps.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    const [row] = await this.ds.query(
      `SELECT
         COUNT(*) FILTER (WHERE r.status = 'pending')::int    AS pending_count,
         COUNT(*) FILTER (WHERE r.status = 'approved')::int   AS approved_count,
         COUNT(*) FILTER (WHERE r.status = 'rejected')::int   AS rejected_count,
         COUNT(*) FILTER (WHERE r.status = 'cancelled')::int  AS cancelled_count,
         COUNT(*)::int                                        AS total_count,
         COUNT(DISTINCT e.id) FILTER (WHERE r.status = 'approved')::int  AS distinct_edited_expenses,
         COUNT(DISTINCT e.id) FILTER (WHERE r.status = 'pending')::int   AS distinct_pending_expenses,
         (SELECT COUNT(*)::int FROM expenses e2 ${where ? where.replace(/e\./g, 'e2.') : ''}) AS total_expenses_in_range
         FROM expense_edit_requests r
         JOIN expenses e ON e.id = r.expense_id
       ${where}`,
      ps,
    );
    return row;
  }

  async cancelEditRequest(requestId: string, userId: string) {
    const [r] = await this.ds.query(
      `SELECT id, status, requested_by FROM expense_edit_requests WHERE id = $1`,
      [requestId],
    );
    if (!r) throw new NotFoundException('request not found');
    if (r.status !== 'pending') {
      throw new BadRequestException('لا يمكن إلغاء طلب تم البتّ فيه');
    }
    if (String(r.requested_by) !== String(userId)) {
      throw new ForbiddenException('لا يمكنك إلغاء طلب آخر');
    }
    await this.ds.query(
      `UPDATE expense_edit_requests
          SET status           = 'cancelled',
              decided_by       = $1,
              decided_at       = NOW(),
              rejection_reason = 'cancelled by requester'
        WHERE id = $2`,
      [userId, requestId],
    );
    return { ok: true };
  }

  async rejectEditRequest(
    requestId: string,
    userId: string,
    reason: string,
  ) {
    if (!reason || reason.trim().length < 3) {
      throw new BadRequestException('سبب الرفض مطلوب');
    }
    return await this.ds.transaction(async (em) => {
      const [r] = await em.query(
        `SELECT id, status FROM expense_edit_requests WHERE id = $1 FOR UPDATE`,
        [requestId],
      );
      if (!r) throw new NotFoundException('request not found');
      if (r.status !== 'pending') {
        throw new BadRequestException('تم البتّ في هذا الطلب بالفعل');
      }
      await em.query(
        `UPDATE expense_edit_requests
            SET status           = 'rejected',
                decided_by       = $1,
                decided_at       = NOW(),
                rejection_reason = $2
          WHERE id = $3`,
        [userId, reason.trim(), requestId],
      );
      return { ok: true };
    });
  }

  /**
   * Approve an edit request — see the section header above for the
   * design rationale. Atomic transaction: either every step succeeds
   * (void + update + repost + audit close) or none do.
   *
   * The engine's `reversal_of` flag is what makes the void safe:
   *   - the engine writes a balanced reversing JE
   *   - the engine flips the original entry's `is_void` to TRUE
   *   - the engine posts the matching reversing cashbox_transactions
   *   - all of the above happens inside the same DB transaction we
   *     opened here, so a later step's failure rolls everything back
   *
   * The fresh corrected JE is posted via `recordExpense` exactly the
   * way an initial expense is posted. The engine's idempotency guard
   * (financial-engine.service.ts:281-295) explicitly allows re-using
   * the same `(reference_type='expense', reference_id=expense.id)`
   * pair once the prior entry has been voided.
   */
  async approveEditRequest(requestId: string, approverId: string) {
    return await this.ds.transaction(async (em) => {
      const [r] = await em.query(
        `SELECT * FROM expense_edit_requests WHERE id = $1 FOR UPDATE`,
        [requestId],
      );
      if (!r) throw new NotFoundException('request not found');
      if (r.status !== 'pending') {
        throw new BadRequestException('تم البتّ في هذا الطلب بالفعل');
      }

      const oldV = (r.old_values as Record<string, any>) || {};
      const newV = (r.new_values as Record<string, any>) || {};

      const [expense] = await em.query(
        `SELECT * FROM expenses WHERE id = $1 FOR UPDATE`,
        [r.expense_id],
      );
      if (!expense) throw new NotFoundException('expense not found');

      const accountingChanged = this.ACCOUNTING_FIELDS.some(
        (k) =>
          k in newV &&
          String((newV as any)[k] ?? '') !== String((oldV as any)[k] ?? ''),
      );

      let voidedJeId: string | null = null;
      let appliedJeId: string | null = null;

      if (accountingChanged) {
        // Locate the live JE for this expense. There may be NONE if the
        // expense was never approved (legacy data) — in that case we
        // simply skip the void step and let the corrected JE post fresh.
        const [oldJe] = await em.query(
          `SELECT id, entry_no FROM journal_entries
            WHERE reference_type = 'expense' AND reference_id = $1
              AND is_void = FALSE
            ORDER BY created_at DESC LIMIT 1`,
          [r.expense_id],
        );

        if (oldJe) {
          // PR-DRIFT-2 (2026-04-26): void the old JE only — do NOT post
          // a separate reversal JE. The previous implementation called
          // engine.recordTransaction with BOTH reversal_of (which voids
          // the original) AND a reversal JE body (which posted +oldAmount
          // on cash 1111). The two corrections double-corrected the cash
          // account and inflated 1111 by oldAmount per edit. Direct void
          // here, then recordExpense below posts the new state cleanly.
          // Engine context = 'engine:expense_edit_void' (24 chars) so the
          // migration-068 trigger allows the write silently.
          await em.query(
            `SELECT set_config('app.engine_context', 'engine:expense_edit_void', true)`,
          );
          await em.query(
            `UPDATE journal_entries
                SET is_void     = TRUE,
                    void_reason = $1,
                    voided_by   = $2,
                    voided_at   = NOW()
              WHERE id = $3 AND is_void = FALSE`,
            [
              `طلب تعديل #${r.id} — ${r.reason}`,
              approverId,
              oldJe.id,
            ],
          );
          voidedJeId = oldJe.id;

          // PR-DRIFT-2.1 (2026-04-26): also void any active cashbox
          // transaction(s) for this expense and rebase
          // cashboxes.current_balance, otherwise recordExpense below
          // would insert a fresh CT on top of the original — leaving
          // the CT side stacked at -oldAmount + -newAmount per edit.
          // Same R2 stacking pattern PR-DRIFT-2's data fix cleaned up
          // for past edits; this prevents future ones.
          //
          // Look at the OLD cashbox (pre-edit). If the operator moved
          // the expense to a different cashbox, the new CT will land
          // on the new cashbox via recordExpense; the old cashbox's
          // CT must still be voided so the prior outflow doesn't
          // linger there.
          const oldCashboxId =
            (oldV as any).cashbox_id ?? expense.cashbox_id;
          if (oldCashboxId) {
            const voided: { amount: string; direction: string }[] =
              await em.query(
                `UPDATE cashbox_transactions
                    SET is_void     = TRUE,
                        void_reason = $1,
                        voided_by   = $2,
                        voided_at   = NOW()
                  WHERE reference_type = 'expense'
                    AND reference_id   = $3
                    AND cashbox_id     = $4
                    AND COALESCE(is_void, FALSE) = FALSE
                  RETURNING amount, direction`,
                [
                  `طلب تعديل #${r.id} — ${r.reason}`,
                  approverId,
                  r.expense_id,
                  oldCashboxId,
                ],
              );

            // Each voided 'out' adds back its amount; each voided 'in'
            // subtracts. Matches the sign convention the canonical
            // helper fn_record_cashbox_txn uses on insert.
            let voidedSignedSum = 0;
            for (const row of voided) {
              voidedSignedSum +=
                row.direction === 'in'
                  ? Number(row.amount)
                  : -Number(row.amount);
            }
            if (voidedSignedSum !== 0) {
              await em.query(
                `UPDATE cashboxes
                    SET current_balance = current_balance - $1,
                        updated_at      = NOW()
                  WHERE id = $2`,
                [voidedSignedSum, oldCashboxId],
              );
            }
          }
        }
      }

      // Apply field updates — merge new values onto the current row.
      const merged: any = { ...expense };
      for (const k of this.EDITABLE_FIELDS) {
        if (k in newV) merged[k] = (newV as any)[k];
      }
      await em.query(
        `UPDATE expenses
            SET category_id      = $1,
                amount           = $2,
                cashbox_id       = $3,
                expense_date     = $4,
                employee_user_id = $5,
                payment_method   = $6,
                description      = $7,
                updated_at       = NOW()
          WHERE id = $8`,
        [
          merged.category_id,
          merged.amount,
          merged.cashbox_id,
          merged.expense_date,
          merged.employee_user_id,
          merged.payment_method,
          merged.description,
          r.expense_id,
        ],
      );

      if (accountingChanged) {
        // Strict mapping — same gate the Daily Expenses create path
        // applies. If the new category isn't mapped, the request is
        // rejected (the user must map the COA leaf first).
        const newCategoryAccountId = await this.resolveCategoryAccountId(
          em,
          merged.category_id,
          true,
        );

        if (!this.engine) {
          throw new BadRequestException(
            'محرّك الترحيل غير مهيأ — لا يمكن تعديل المصروف',
          );
        }
        const newRes = await this.engine.recordExpense({
          expense_id: r.expense_id,
          expense_no: merged.expense_no,
          amount: Number(merged.amount),
          category_account_id: newCategoryAccountId,
          cashbox_id: merged.cashbox_id,
          payment_method: merged.payment_method,
          user_id: approverId,
          entry_date: merged.expense_date,
          em,
          description: merged.description ?? undefined,
          is_advance: merged.is_advance === true,
          employee_user_id: merged.employee_user_id ?? null,
        });
        if (!newRes.ok) {
          throw new BadRequestException(
            `فشل ترحيل المصروف بعد التعديل: ${(newRes as any).error}`,
          );
        }
        if ('entry_id' in newRes && newRes.entry_id) {
          appliedJeId = newRes.entry_id;
        }
      }

      await em.query(
        `UPDATE expense_edit_requests
            SET status        = 'approved',
                decided_by    = $1,
                decided_at    = NOW(),
                voided_je_id  = $2,
                applied_je_id = $3
          WHERE id = $4`,
        [approverId, voidedJeId, appliedJeId, requestId],
      );

      return {
        ok: true,
        accounting_corrected: accountingChanged,
        voided_je_id: voidedJeId,
        applied_je_id: appliedJeId,
      };
    });
  }

  /** Resolve a category id to its COA leaf via the existing resolver
   *  (or the category row's `account_id` column when the resolver isn't
   *  wired). Same fallback semantics as the create path. */
  private async resolveCategoryAccountId(
    em: import('typeorm').EntityManager,
    categoryId: string | null,
    strict = false,
  ): Promise<string | null> {
    if (!categoryId) {
      if (strict) {
        throw new BadRequestException(
          'هذا البند غير مربوط بحساب محاسبي. اختر الحساب أولًا.',
        );
      }
      return null;
    }
    if (this.resolver) {
      try {
        const res = await this.resolver.resolve({
          category_id: categoryId,
          em,
          strict,
        });
        return res.account_id;
      } catch (err: any) {
        if (err?.name === 'UnmappedCategoryError') {
          throw new BadRequestException(err.message);
        }
        throw err;
      }
    }
    const [row] = await em.query(
      `SELECT account_id FROM expense_categories WHERE id = $1`,
      [categoryId],
    );
    return row?.account_id ?? null;
  }
}
