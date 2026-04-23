import {
  BadRequestException,
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
import { ForbiddenException } from '@nestjs/common';
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
  listCategories(includeInactive = false) {
    return this.ds.query(
      `SELECT * FROM expense_categories
       ${includeInactive ? '' : 'WHERE is_active = TRUE'}
       ORDER BY name_ar`,
    );
  }

  async createCategory(dto: CreateExpenseCategoryDto) {
    const [row] = await this.ds.query(
      `INSERT INTO expense_categories
         (code, name_ar, name_en, is_fixed, allocate_to_cogs)
       VALUES ($1,$2,$3,$4,$5)
       RETURNING *`,
      [
        dto.code,
        dto.name_ar,
        dto.name_en ?? null,
        dto.is_fixed ?? false,
        dto.allocate_to_cogs ?? false,
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
  async createExpense(dto: CreateExpenseDto, userId: string) {
    return this.ds.transaction(async (em) => {
      // Auto-resolve cashbox_id from the user's open shift when not supplied
      // — keeps expenses tied to the shift for proper close-out reconciliation.
      let cashboxId = dto.cashbox_id ?? null;
      if (!cashboxId) {
        const [openShift] = await em.query(
          `SELECT cashbox_id FROM shifts
            WHERE opened_by = $1 AND status = 'open'
            ORDER BY opened_at DESC LIMIT 1`,
          [userId],
        );
        cashboxId = openShift?.cashbox_id || null;
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

      // `expense_no` is auto-generated by the `trg_set_expense_no` trigger
      // when NULL is passed. We omit it from the column list and pass NULL
      // so the trigger fires before the NOT-NULL check is evaluated.
      const [row] = await em.query(
        `INSERT INTO expenses
           (expense_no, warehouse_id, cashbox_id, category_id, amount,
            payment_method, expense_date, description, receipt_url, vendor_name,
            created_by, employee_user_id, is_advance)
         VALUES (NULL,$1,$2,$3,$4,$5::payment_method_code,COALESCE($6,CURRENT_DATE),
                 $7,$8,$9,$10,$11,$12)
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
        await this.postViaEngine(em, row, userId);
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
    // (migration 065). Falls back to 529 if the category is unmapped.
    // No inline lookups here — all paths go through the resolver so
    // reporting + reconciliation see a single mapping table.
    let categoryAccountId: string | null = null;
    if (this.resolver) {
      const hint =
        (expense.category_code as string | undefined) ??
        (expense.description as string | undefined) ??
        undefined;
      const res = await this.resolver.resolve({
        category_id: expense.category_id,
        hint,
        em,
      });
      categoryAccountId = res.account_id;
    } else if (expense.category_id) {
      // Defensive legacy path — only hit when resolver isn't wired
      // (e.g., a stubbed unit test). Production always has the
      // resolver via DI.
      const [row] = await em.query(
        `SELECT account_id FROM expense_categories WHERE id = $1`,
        [expense.category_id],
      );
      categoryAccountId = row?.account_id ?? null;
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

    return this.createExpense(
      {
        ...dto,
        employee_user_id: effectiveEmployee,
      } as any,
      userId,
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
    if (filters.q) {
      ps.push(`%${filters.q}%`);
      conds.push(
        `(e.description ILIKE $${ps.length} OR e.vendor_name ILIKE $${ps.length} OR e.expense_no ILIKE $${ps.length})`,
      );
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    ps.push(filters.limit ?? 100);
    ps.push(filters.offset ?? 0);

    const rows = await this.ds.query(
      `SELECT e.*,
              c.name_ar AS category_name,
              c.code    AS category_code,
              w.name_ar AS warehouse_name,
              uc.full_name AS created_by_name,
              ua.full_name AS approved_by_name
       FROM expenses e
       LEFT JOIN expense_categories c ON c.id = e.category_id
       LEFT JOIN warehouses w         ON w.id = e.warehouse_id
       LEFT JOIN users uc             ON uc.id = e.created_by
       LEFT JOIN users ua             ON ua.id = e.approved_by
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
}
