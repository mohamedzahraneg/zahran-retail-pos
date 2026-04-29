import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  CreateCustomerPaymentDto,
  CreateSupplierPaymentDto,
} from './dto/payment.dto';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

export type CashboxKind = 'cash' | 'bank' | 'ewallet' | 'check';

export interface CreateCashboxDto {
  name_ar: string;
  warehouse_id?: string;
  kind: CashboxKind;
  currency?: string;
  opening_balance?: number;
  color?: string;
  // Bank fields
  institution_code?: string;
  bank_branch?: string;
  account_number?: string;
  iban?: string;
  swift_code?: string;
  account_holder_name?: string;
  account_manager_name?: string;
  account_manager_phone?: string;
  account_manager_email?: string;
  // Wallet
  wallet_phone?: string;
  wallet_owner_name?: string;
  // Check
  check_issuer_name?: string;
  notes?: string;
}

export interface UpdateCashboxDto extends Partial<CreateCashboxDto> {
  is_active?: boolean;
}

@Injectable()
export class CashDeskService {
  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly posting?: AccountingPostingService,
    @Optional() private readonly engine?: FinancialEngineService,
  ) {}

  /**
   * Give every new cashbox its own GL sub-account under the matching
   * parent (cash → 111, bank → 1113's parent, etc.) and link the
   * cashbox_id column so the posting service's explicit-link lookup
   * resolves to it. Idempotent: if an account with the same cashbox_id
   * already exists, we skip.
   *
   * PR-FIN-PAYACCT-1: takes a query runner (transaction's EntityManager
   * or the bare DataSource) so the GL sub-account write joins the same
   * atomic envelope as the cashbox INSERT + the engine-backed opening
   * movement. Real DB errors now propagate (no more silent swallow):
   * the user spec is "if any step fails, rollback the whole transaction."
   * Only the "COA not seeded" early-return is preserved (graceful for
   * fresh installs without a seeded chart of accounts).
   */
  private async linkOrCreateGLSubAccount(
    q: { query: (sql: string, params?: any[]) => Promise<any[]> },
    cashbox: any,
    userId: string,
  ): Promise<void> {
    const [existing] = await q.query(
      `SELECT id FROM chart_of_accounts WHERE cashbox_id = $1 LIMIT 1`,
      [cashbox.id],
    );
    if (existing) return;

    // Parent code per kind
    const parentCode: Record<string, string> = {
      cash: '111',
      bank: '111',
      ewallet: '111',
      check: '111',
    };
    const [parent] = await q.query(
      `SELECT id, code FROM chart_of_accounts WHERE code = $1 LIMIT 1`,
      [parentCode[cashbox.kind] || '111'],
    );
    if (!parent) return; // COA not seeded yet — graceful no-op for fresh installs.

    // Find the next available code under the parent.
    const [{ next_seq }] = await q.query(
      `SELECT COALESCE(MAX(SUBSTRING(code FROM '[0-9]+$')::int), 0) + 1 AS next_seq
         FROM chart_of_accounts WHERE parent_id = $1`,
      [parent.id],
    );
    const newCode = `${parent.code}${String(next_seq).padStart(2, '0')}`;

    await q.query(
      `
      INSERT INTO chart_of_accounts
        (code, name_ar, name_en, account_type, normal_balance, parent_id,
         is_leaf, is_system, level, cashbox_id, created_by, description)
      VALUES ($1, $2, $3, 'asset'::account_type, 'debit'::normal_balance,
              $4, TRUE, FALSE, 4, $5, $6, 'تم الإنشاء تلقائيًا مع الخزنة')
      ON CONFLICT (code) DO NOTHING
      `,
      [
        newCode,
        cashbox.name_ar,
        cashbox.name_ar,
        parent.id,
        cashbox.id,
        userId,
      ],
    );
  }

  /** Look up the warehouse_id for a cashbox (NOT NULL on both payment tables). */
  private async warehouseForCashbox(
    em: { query: (sql: string, params?: any[]) => Promise<any[]> },
    cashboxId: string,
  ) {
    const [row] = await em.query(
      `SELECT warehouse_id FROM cashboxes WHERE id = $1`,
      [cashboxId],
    );
    if (!row) throw new Error(`cashbox ${cashboxId} not found`);
    return row.warehouse_id as string;
  }

  /**
   * Receive a customer payment.
   *
   * PR-FIN-PAYACCT-2 — atomic posting hardening.
   *
   * The flow lives inside `ds.transaction((em) => …)`, so the payment
   * INSERT, the trigger writes (`fn_customer_payment_apply` updates
   * cashboxes / cashbox_transactions / customers / customer_ledger),
   * the allocation INSERTs and the GL post all share one transaction.
   *
   * Pre-merge contract was: `posting.postInvoicePayment(...).catch(() =>
   * undefined)` — but `posting.service.safe()` already turns every
   * exception into a `{error}` return, and the caller never inspected
   * the result. Net effect: a customer payment whose JE failed (COA not
   * seeded, lockdown, engine error, …) would still commit the payment
   * row + cashbox + ledger writes, leaving an orphan with no GL leg.
   *
   * Production has zero orphans today (audit verified) because there
   * are zero historical customer_payments. The hardening lands before
   * the new Customers-page button gets real production usage.
   *
   * New contract:
   *   • posting MUST be wired (`this.posting` non-null) — else throw.
   *   • posting result `null`            → throw (COA missing or other
   *                                        guard hit). Whole tx rolls
   *                                        back — payment + trigger
   *                                        writes never commit.
   *   • posting result `{error}`         → throw (carry the underlying
   *                                        message into the Arabic
   *                                        BadRequestException).
   *   • posting result `{skipped:true}`  → success — idempotent replay
   *                                        of an already-posted JE; the
   *                                        engine's idempotency guard
   *                                        already caught the duplicate.
   *   • posting result `{entry_id}`      → success.
   *
   * Idempotency on FE retry: the engine's
   * `(reference_type, reference_id)` guard short-circuits at the SELECT
   * inside `safe()` (posting.service.ts:1215) → returns `{skipped:true}`
   * → caller treats as success. No double-post. No double-cashbox-update
   * (the trigger does not run because the customer_payments INSERT was
   * the one that fired it the first time; this call's INSERT carries a
   * different id and a different payment_no, so it is by definition not
   * a real retry of the same row).
   *
   * Note on the trigger: `fn_customer_payment_apply` writes a legacy
   * `cashbox_transactions.reference_type='other'` row and sets
   * `app.engine_context = 'on'` — both are documented gaps in the
   * PR-FIN-PAYACCT-2 audit report (legacy mirror trigger). Out of scope
   * for this PR; the hardening here is solely about the JE post.
   */
  async receiveFromCustomer(dto: CreateCustomerPaymentDto, userId: string) {
    // Capture into a local so TS narrowing carries across the `em` closure
    // (`this.posting` is `@Optional()` so the type is `… | undefined`).
    const posting = this.posting;
    if (!posting) {
      throw new BadRequestException(
        'خدمة الترحيل المحاسبي غير متاحة — لا يمكن تسجيل المقبوضة',
      );
    }
    return this.ds.transaction(async (em) => {
      const [{ seq }] = await em.query(
        `SELECT nextval('seq_customer_payment_no') AS seq`,
      );
      const paymentNo = `CR-${String(seq).padStart(6, '0')}`;
      const warehouseId = await this.warehouseForCashbox(em, dto.cashbox_id);

      const [payment] = await em.query(
        `
        INSERT INTO customer_payments
          (payment_no, customer_id, cashbox_id, warehouse_id,
           payment_method, amount, kind,
           reference_number, notes, received_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        RETURNING *
        `,
        [
          paymentNo,
          dto.customer_id,
          dto.cashbox_id,
          warehouseId,
          dto.payment_method,
          dto.amount,
          dto.kind ?? 'invoice_settlement',
          dto.reference ?? null,
          dto.notes ?? null,
          userId,
        ],
      );

      if (dto.allocations?.length) {
        for (const a of dto.allocations) {
          await em.query(
            `INSERT INTO customer_payment_allocations (payment_id, invoice_id, amount)
             VALUES ($1,$2,$3)`,
            [payment.id, a.invoice_id, a.amount],
          );
        }
      }

      // Auto-post the receipt to GL within the same transaction.
      // PR-FIN-PAYACCT-2: posting MUST complete or the whole tx
      // rolls back — no committed payment row without a JE.
      const post = await posting.postInvoicePayment(
        payment.id,
        userId,
        em,
      );
      if (post == null) {
        throw new BadRequestException(
          'فشل ترحيل المقبوضة محاسبياً — تأكد من إعداد الحسابات (1111/1121/212)',
        );
      }
      if ((post as { error?: string }).error) {
        throw new BadRequestException(
          `فشل ترحيل المقبوضة محاسبياً: ${(post as { error: string }).error}`,
        );
      }
      // {skipped:true} or {entry_id} → success path. Fall through.
      return payment;
    });
  }

  /**
   * Pay a supplier.
   *
   * PR-FIN-PAYACCT-2 — mirror of `receiveFromCustomer`. See that method's
   * docblock for the full atomic-posting contract; the only difference
   * here is the GL recipe (DR 211 suppliers / CR cashbox-GL) handled
   * inside `posting.postSupplierPayment`.
   */
  async payToSupplier(dto: CreateSupplierPaymentDto, userId: string) {
    // Capture into a local — see receiveFromCustomer for rationale.
    const posting = this.posting;
    if (!posting) {
      throw new BadRequestException(
        'خدمة الترحيل المحاسبي غير متاحة — لا يمكن تسجيل الدفعة',
      );
    }
    return this.ds.transaction(async (em) => {
      const [{ seq }] = await em.query(
        `SELECT nextval('seq_supplier_payment_no') AS seq`,
      );
      const paymentNo = `CP-${String(seq).padStart(6, '0')}`;
      const warehouseId = await this.warehouseForCashbox(em, dto.cashbox_id);

      const [payment] = await em.query(
        `
        INSERT INTO supplier_payments
          (payment_no, supplier_id, cashbox_id, warehouse_id,
           payment_method, amount,
           reference_number, notes, paid_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
        RETURNING *
        `,
        [
          paymentNo,
          dto.supplier_id,
          dto.cashbox_id,
          warehouseId,
          dto.payment_method,
          dto.amount,
          dto.reference ?? null,
          dto.notes ?? null,
          userId,
        ],
      );

      if (dto.allocations?.length) {
        for (const a of dto.allocations) {
          await em.query(
            `INSERT INTO supplier_payment_allocations (payment_id, purchase_id, amount)
             VALUES ($1,$2,$3)`,
            [payment.id, a.invoice_id, a.amount],
          );
        }
      }

      // PR-FIN-PAYACCT-2: posting MUST complete or the whole tx
      // rolls back — no committed payment row without a JE.
      const post = await posting.postSupplierPayment(
        payment.id,
        userId,
        em,
      );
      if (post == null) {
        throw new BadRequestException(
          'فشل ترحيل الدفعة محاسبياً — تأكد من إعداد الحسابات (1111/211)',
        );
      }
      if ((post as { error?: string }).error) {
        throw new BadRequestException(
          `فشل ترحيل الدفعة محاسبياً: ${(post as { error: string }).error}`,
        );
      }
      // {skipped:true} or {entry_id} → success path. Fall through.
      return payment;
    });
  }

  async voidCustomerPayment(id: string, userId: string, reason: string) {
    await this.ds.query(
      `UPDATE customer_payments SET is_void = true, void_reason = $2, voided_by = $3, voided_at = now()
       WHERE id = $1`,
      [id, reason, userId],
    );
    // Reverse the GL entry so receivables and cash balance rebound.
    await this.posting
      ?.reverseByReference('customer_payment', id, reason, userId)
      .catch(() => undefined);
    return { voided: true };
  }

  async voidSupplierPayment(id: string, userId: string, reason: string) {
    const [p] = await this.ds.query(
      `SELECT id, is_void FROM supplier_payments WHERE id = $1`,
      [id],
    );
    if (!p) throw new NotFoundException('الدفعة غير موجودة');
    if (p.is_void) throw new BadRequestException('الدفعة ملغاة بالفعل');
    await this.ds.query(
      `UPDATE supplier_payments
          SET is_void = true, void_reason = $2, voided_by = $3, voided_at = now()
        WHERE id = $1`,
      [id, reason, userId],
    );
    await this.posting
      ?.reverseByReference('supplier_payment', id, reason, userId)
      .catch(() => undefined);
    return { voided: true };
  }

  listCustomerPayments(customerId?: string) {
    return customerId
      ? this.ds.query(
          `SELECT * FROM customer_payments WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 200`,
          [customerId],
        )
      : this.ds.query(
          `SELECT * FROM customer_payments ORDER BY created_at DESC LIMIT 200`,
        );
  }

  listSupplierPayments(supplierId?: string) {
    return supplierId
      ? this.ds.query(
          `SELECT * FROM supplier_payments WHERE supplier_id = $1 ORDER BY created_at DESC LIMIT 200`,
          [supplierId],
        )
      : this.ds.query(
          `SELECT * FROM supplier_payments ORDER BY created_at DESC LIMIT 200`,
        );
  }

  async listCashboxes(includeInactive = false) {
    // Migration 049 added cashboxes.kind + financial_institutions. If
    // it hasn't run yet on this DB, fall back to a simple query so
    // the UI doesn't 500.
    const [m049] = await this.ds.query(
      `SELECT
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='cashboxes' AND column_name='kind') AS has_kind,
         EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_name='financial_institutions') AS has_fi`,
    );
    if (m049?.has_kind && m049?.has_fi) {
      return this.ds.query(
        `
        SELECT cb.*, cb.name_ar AS name,
               fi.name_ar        AS institution_name,
               fi.name_en        AS institution_name_en,
               fi.website_domain AS institution_domain,
               fi.color_hex      AS institution_color,
               fi.kind           AS institution_kind
          FROM cashboxes cb
          LEFT JOIN financial_institutions fi ON fi.code = cb.institution_code
         ${includeInactive ? '' : 'WHERE cb.is_active = true'}
         ORDER BY cb.kind, cb.name_ar
        `,
      );
    }
    // Fallback — pre-migration schema.
    return this.ds.query(
      `SELECT cb.*, cb.name_ar AS name,
              'cash' AS kind,
              NULL AS institution_name,
              NULL AS institution_name_en,
              NULL AS institution_domain,
              NULL AS institution_color,
              NULL AS institution_kind
         FROM cashboxes cb
        ${includeInactive ? '' : 'WHERE cb.is_active = true'}
        ORDER BY cb.name_ar`,
    );
  }

  /** Full list of bank / wallet presets — powers the picker in the UI. */
  async listInstitutions(kind?: 'bank' | 'ewallet' | 'check_issuer') {
    // Gracefully degrade if migration 049 hasn't run.
    const [exists] = await this.ds.query(
      `SELECT EXISTS (SELECT 1 FROM information_schema.tables
        WHERE table_name='financial_institutions') AS present`,
    );
    if (!exists?.present) return [];

    const conds: string[] = ['is_active = true'];
    const args: any[] = [];
    if (kind) {
      args.push(kind);
      conds.push(`kind = $${args.length}`);
    }
    return this.ds.query(
      `SELECT * FROM financial_institutions
        WHERE ${conds.join(' AND ')}
        ORDER BY sort_order, name_ar`,
      args,
    );
  }

  /**
   * Create a cashbox + (optionally) post its opening balance as a real
   * engine-backed event.
   *
   * PR-FIN-PAYACCT-1 — Option B.1 semantics (the "no double-count" fix):
   *
   *   Pre-merge contract was broken: the legacy INSERT set both
   *   `cashboxes.current_balance` and `cashboxes.opening_balance` to
   *   the user-supplied opening figure with NO offsetting JE and NO
   *   `cashbox_transactions` row. Production never tripped the bug
   *   (no row had `opening_balance > 0`) but every future bank or
   *   wallet creation would have created money out of thin air and
   *   broken the cashbox-vs-GL invariant.
   *
   *   New flow:
   *
   *     ds.transaction((em) => {
   *       1. INSERT cashboxes with current_balance=0, opening_balance=0
   *          regardless of input. The column is intentionally unused for
   *          cashboxes created by this flow — the value lives in the CT
   *          ledger and the GL, not in a denormalised stored field.
   *       2. linkOrCreateGLSubAccount(em) — give the cashbox its own
   *          chart_of_accounts row so postings don't pool across boxes.
   *       3. If dto.opening_balance > 0:
   *            engine.recordTransaction({
   *              kind: 'opening_balance',
   *              reference_type: 'cashbox_opening',
   *              reference_id: cashbox.id,
   *              gl_lines: [DR cashbox-GL, CR 31 (capital)],
   *              cash_movements: [{cashbox_id, dir:'in', amount,
   *                                 category:'opening'}],
   *              user_id, em,
   *            })
   *            The engine writes JE + JL + (via fn_record_cashbox_txn)
   *            cashbox_transactions row + UPDATE cashboxes.current_balance
   *            from 0 to amount. SINGLE writer of current_balance.
   *       4. Backfill the trace columns:
   *            UPDATE cashboxes SET opening_journal_entry_id = je_id,
   *                                  opening_posted_at = NOW()
   *            (Allowed under the cashbox-balance guard because
   *             current_balance is unchanged in this UPDATE.)
   *       5. Commit. Any failure between 1–4 rolls back the whole tx.
   *     })
   *
   * Idempotency & no-double-count proof:
   *   • Engine.recordTransaction guards on (reference_type, reference_id)
   *     = ('cashbox_opening', cashbox.id) — replay returns
   *     {ok:true, skipped:true}, no duplicate JE, no duplicate CT.
   *   • Migration 119 promotes that guard to a partial unique index.
   *   • current_balance is mutated solely by `fn_record_cashbox_txn`.
   *     Step 1 leaves it at 0; only step 3 lifts it. Sum of CT rows ==
   *     opening amount == GL 1111/1113/1114/1115 net debit.
   *   • v_cash_position.computed = opening_balance(0) + Σct(opening) =
   *     opening. drift = stored(opening) − opening = 0. ✅
   *
   * @param dto    create payload — `dto.opening_balance` is the user's
   *               funding amount (NOT stored verbatim into the column).
   * @param userId actor — threaded through to JE.created_by / posted_by
   *               and chart_of_accounts.created_by. Falls back to
   *               'system' (literal kept for backward compat with
   *               internal callers without an HTTP context).
   */
  async createCashbox(dto: CreateCashboxDto, userId: string | null = null) {
    if (!dto.name_ar?.trim())
      throw new BadRequestException('اسم الخزنة مطلوب');
    if (!['cash', 'bank', 'ewallet', 'check'].includes(dto.kind)) {
      throw new BadRequestException('نوع الخزنة غير صحيح');
    }
    // Bank requires an institution; wallet too.
    if (
      (dto.kind === 'bank' || dto.kind === 'ewallet') &&
      !dto.institution_code
    ) {
      throw new BadRequestException('يجب اختيار البنك / المحفظة');
    }

    const opening = Number(dto.opening_balance || 0);
    if (opening < 0) {
      throw new BadRequestException('الرصيد الافتتاحي لا يمكن أن يكون سالبًا');
    }
    if (opening > 0 && !this.engine) {
      throw new BadRequestException(
        'لا يمكن إنشاء خزنة برصيد افتتاحي بدون المحرك المحاسبي',
      );
    }

    // Fall back to a valid warehouse if none given (cashboxes NOT NULL).
    let warehouseId = dto.warehouse_id ?? null;
    if (!warehouseId) {
      const [w] = await this.ds.query(
        `SELECT id FROM warehouses WHERE is_active = TRUE ORDER BY created_at LIMIT 1`,
      );
      warehouseId = w?.id ?? null;
    }
    if (!warehouseId) {
      throw new BadRequestException('لا يوجد مخزن نشط لربط الخزنة به');
    }

    const actorId = userId ?? 'system';

    return this.ds.transaction(async (em) => {
      // Step 1 — INSERT with current_balance=0, opening_balance=0
      // regardless of `opening`. The amount lives in the CT/JE ledger
      // (Option B.1 in the PR-FIN-PAYACCT-1 audit).
      const [row] = await em.query(
        `
        INSERT INTO cashboxes
          (name_ar, warehouse_id, currency, kind, institution_code,
           bank_branch, account_number, iban, swift_code,
           account_holder_name, account_manager_name, account_manager_phone,
           account_manager_email, wallet_phone, wallet_owner_name,
           check_issuer_name, color, current_balance, opening_balance,
           is_active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,0,0,TRUE)
        RETURNING *
        `,
        [
          dto.name_ar.trim(),
          warehouseId,
          dto.currency ?? 'EGP',
          dto.kind,
          dto.institution_code ?? null,
          dto.bank_branch ?? null,
          dto.account_number ?? null,
          dto.iban ?? null,
          dto.swift_code ?? null,
          dto.account_holder_name ?? null,
          dto.account_manager_name ?? null,
          dto.account_manager_phone ?? null,
          dto.account_manager_email ?? null,
          dto.wallet_phone ?? null,
          dto.wallet_owner_name ?? null,
          dto.check_issuer_name ?? null,
          dto.color ?? null,
        ],
      );

      // Step 2 — GL sub-account. Errors propagate → rolls back step 1.
      await this.linkOrCreateGLSubAccount(em, row, actorId);

      // Step 3 — Engine-backed opening movement (only when opening > 0).
      if (opening > 0) {
        const result = await this.engine!.recordTransaction({
          kind: 'opening_balance',
          reference_type: 'cashbox_opening',
          reference_id: row.id,
          description: `رصيد افتتاحي - ${row.name_ar}`,
          gl_lines: [
            {
              resolve_from_cashbox_id: row.id,
              debit: opening,
              cashbox_id: row.id,
            },
            { account_code: '31', credit: opening },
          ],
          cash_movements: [
            {
              cashbox_id: row.id,
              direction: 'in',
              amount: opening,
              category: 'opening',
              notes: `رصيد افتتاحي - ${row.name_ar}`,
            },
          ],
          user_id: userId,
          em,
        });
        if (!result.ok) {
          throw new BadRequestException(
            `فشل تسجيل الرصيد الافتتاحي: ${result.error}`,
          );
        }
        // Step 4 — Backfill trace columns. Allowed under
        // trg_guard_cashbox_balance (current_balance is unchanged in
        // this UPDATE — only the trace columns move).
        await em.query(
          `UPDATE cashboxes
              SET opening_journal_entry_id = $2,
                  opening_posted_at = NOW(),
                  updated_at = NOW()
            WHERE id = $1`,
          [row.id, result.entry_id],
        );
        // Re-read so the caller sees the populated trace columns +
        // the engine-driven current_balance (= opening) instead of
        // the row we returned at step 1 (which was current_balance=0).
        const [refreshed] = await em.query(
          `SELECT * FROM cashboxes WHERE id = $1`,
          [row.id],
        );
        return refreshed;
      }

      return row;
    });
  }

  async updateCashbox(id: string, dto: UpdateCashboxDto) {
    const [exists] = await this.ds.query(
      `SELECT id, kind FROM cashboxes WHERE id = $1`,
      [id],
    );
    if (!exists) throw new NotFoundException('الخزنة غير موجودة');

    const sets: string[] = [];
    const args: any[] = [];
    const push = (col: string, val: any) => {
      args.push(val);
      sets.push(`${col} = $${args.length}`);
    };
    if (dto.name_ar !== undefined) push('name_ar', dto.name_ar);
    if (dto.kind !== undefined) push('kind', dto.kind);
    if (dto.warehouse_id !== undefined) push('warehouse_id', dto.warehouse_id);
    if (dto.currency !== undefined) push('currency', dto.currency);
    if (dto.institution_code !== undefined)
      push('institution_code', dto.institution_code);
    if (dto.bank_branch !== undefined) push('bank_branch', dto.bank_branch);
    if (dto.account_number !== undefined)
      push('account_number', dto.account_number);
    if (dto.iban !== undefined) push('iban', dto.iban);
    if (dto.swift_code !== undefined) push('swift_code', dto.swift_code);
    if (dto.account_holder_name !== undefined)
      push('account_holder_name', dto.account_holder_name);
    if (dto.account_manager_name !== undefined)
      push('account_manager_name', dto.account_manager_name);
    if (dto.account_manager_phone !== undefined)
      push('account_manager_phone', dto.account_manager_phone);
    if (dto.account_manager_email !== undefined)
      push('account_manager_email', dto.account_manager_email);
    if (dto.wallet_phone !== undefined) push('wallet_phone', dto.wallet_phone);
    if (dto.wallet_owner_name !== undefined)
      push('wallet_owner_name', dto.wallet_owner_name);
    if (dto.check_issuer_name !== undefined)
      push('check_issuer_name', dto.check_issuer_name);
    if (dto.color !== undefined) push('color', dto.color);
    if (dto.is_active !== undefined) push('is_active', dto.is_active);

    if (!sets.length) return exists;

    sets.push(`updated_at = NOW()`);
    args.push(id);
    const [row] = await this.ds.query(
      `UPDATE cashboxes SET ${sets.join(', ')} WHERE id = $${args.length} RETURNING *`,
      args,
    );
    return row;
  }

  /**
   * Move cash between two cashboxes. Creates two cashbox_transactions
   * (one out, one in), updates both balances, and emits a single linked
   * journal entry: DR destination-cash, CR source-cash.
   */
  async transferBetweenCashboxes(
    dto: {
      from_cashbox_id: string;
      to_cashbox_id: string;
      amount: number;
      notes?: string;
    },
    userId: string,
  ) {
    if (dto.from_cashbox_id === dto.to_cashbox_id) {
      throw new BadRequestException('لا يمكن التحويل بين نفس الخزنة');
    }
    const amount = Number(dto.amount);
    if (!(amount > 0)) {
      throw new BadRequestException('المبلغ يجب أن يكون أكبر من صفر');
    }

    return this.ds.transaction(async (em) => {
      // Lock both rows so concurrent transfers don't double-spend.
      const [from] = await em.query(
        `SELECT id, current_balance, name_ar FROM cashboxes
          WHERE id = $1 FOR UPDATE`,
        [dto.from_cashbox_id],
      );
      const [to] = await em.query(
        `SELECT id, current_balance, name_ar FROM cashboxes
          WHERE id = $1 FOR UPDATE`,
        [dto.to_cashbox_id],
      );
      if (!from) throw new NotFoundException('الخزنة المرسلة غير موجودة');
      if (!to) throw new NotFoundException('الخزنة المستقبلة غير موجودة');
      if (Number(from.current_balance) < amount) {
        throw new BadRequestException(
          `رصيد الخزنة "${from.name_ar}" غير كافٍ (${from.current_balance})`,
        );
      }

      const note = dto.notes || `تحويل من ${from.name_ar} إلى ${to.name_ar}`;

      // Generate a transfer id up-front so the engine's idempotency
      // key is stable (a retry of the same HTTP request won't create
      // two transfers).
      const [{ transfer_id }] = await em.query(
        `SELECT gen_random_uuid() AS transfer_id`,
      );

      // ━━━ Unified engine path ━━━
      // The engine writes BOTH cashbox_transactions legs (via
      // fn_record_cashbox_txn — atomic balance update) AND the single
      // GL entry (DR dest · CR src). No direct UPDATE of
      // cashboxes.current_balance anywhere.
      if (!this.engine) {
        throw new Error('FinancialEngineService not wired');
      }
      const res = await this.engine.recordCashboxTransfer({
        transfer_id,
        from_cashbox_id: dto.from_cashbox_id,
        to_cashbox_id: dto.to_cashbox_id,
        amount,
        user_id: userId,
        notes: note,
        em,
      });
      if (!res.ok) {
        throw new BadRequestException(`فشل التحويل: ${res.error}`);
      }

      // Read the new balances back from the source of truth (the txn
      // log aggregated into cashboxes.current_balance by
      // fn_record_cashbox_txn).
      const [fromAfter] = await em.query(
        `SELECT current_balance FROM cashboxes WHERE id = $1`,
        [dto.from_cashbox_id],
      );
      const [toAfter] = await em.query(
        `SELECT current_balance FROM cashboxes WHERE id = $1`,
        [dto.to_cashbox_id],
      );
      const newFromBal = Number(fromAfter?.current_balance || 0);
      const newToBal = Number(toAfter?.current_balance || 0);

      return {
        transferred: true,
        amount,
        from_balance: newFromBal,
        to_balance: newToBal,
        transfer_id,
      };
    });
  }

  // ── Bank reconciliation ─────────────────────────────────────────────

  /**
   * List cashbox transactions in a date range with reconciliation status.
   * UI lines them up against a bank statement so the user can tick off
   * each match. Supports filters: cashbox_id, from, to, status.
   */
  async listReconciliation(params: {
    cashbox_id: string;
    from?: string;
    to?: string;
    status?: 'all' | 'reconciled' | 'open';
  }) {
    const conds: string[] = ['cashbox_id = $1'];
    const args: any[] = [params.cashbox_id];
    if (params.from) {
      args.push(params.from);
      conds.push(
        `(created_at AT TIME ZONE 'Africa/Cairo')::date >= $${args.length}::date`,
      );
    }
    if (params.to) {
      args.push(params.to);
      conds.push(
        `(created_at AT TIME ZONE 'Africa/Cairo')::date <= $${args.length}::date`,
      );
    }
    if (params.status === 'reconciled') {
      conds.push(`is_reconciled = TRUE`);
    } else if (params.status === 'open') {
      conds.push(`is_reconciled = FALSE`);
    }
    const rows = await this.ds.query(
      `
      SELECT id, cashbox_id, direction, amount, category, balance_after,
             notes, created_at, is_reconciled, reconciled_at,
             statement_reference
        FROM cashbox_transactions
       WHERE ${conds.join(' AND ')}
       ORDER BY created_at ASC
      `,
      args,
    );

    const summary = rows.reduce(
      (acc: any, r: any) => {
        const amt = Number(r.amount || 0);
        if (r.direction === 'in') acc.system_in += amt;
        else acc.system_out += amt;
        if (r.is_reconciled) {
          if (r.direction === 'in') acc.reconciled_in += amt;
          else acc.reconciled_out += amt;
        }
        return acc;
      },
      {
        system_in: 0,
        system_out: 0,
        reconciled_in: 0,
        reconciled_out: 0,
      },
    );
    summary.unreconciled_in = summary.system_in - summary.reconciled_in;
    summary.unreconciled_out = summary.system_out - summary.reconciled_out;
    return { rows, summary };
  }

  /**
   * Auto-match a parsed bank statement to cashbox transactions.
   *
   * Input is a plain array — the frontend parses any CSV shape into
   * `{ date, amount, direction, reference? }` and sends here. We match
   * each statement line to exactly one open cashbox transaction if:
   *   - same direction
   *   - same absolute amount (±1 piaster)
   *   - within ±2 days of the statement date
   * and mark the matched txns reconciled in a single pass. Conflicts
   * (multiple candidates) are reported instead of being auto-matched.
   */
  async autoMatchStatement(
    cashboxId: string,
    statementLines: Array<{
      date: string;
      amount: number;
      direction: 'in' | 'out';
      reference?: string;
    }>,
    userId: string,
  ) {
    if (!cashboxId) throw new BadRequestException('cashbox_id مطلوب');
    if (!Array.isArray(statementLines) || !statementLines.length) {
      return { matched: 0, ambiguous: 0, unmatched: 0, results: [] };
    }
    const results: Array<{
      statement_line: any;
      matched_id: string | null;
      status: 'matched' | 'ambiguous' | 'unmatched';
      candidates?: number;
    }> = [];

    for (const line of statementLines) {
      const amt = Number(line.amount);
      if (!amt || !line.date || !line.direction) {
        results.push({ statement_line: line, matched_id: null, status: 'unmatched' });
        continue;
      }
      const candidates = await this.ds.query(
        `
        SELECT id FROM cashbox_transactions
         WHERE cashbox_id = $1
           AND is_reconciled = FALSE
           AND direction = $2::txn_direction
           AND ABS(amount - $3::numeric) < 0.01
           AND ABS(EXTRACT(EPOCH FROM
                 ((created_at AT TIME ZONE 'Africa/Cairo')::date - $4::date))) <= 2 * 86400
         LIMIT 5
        `,
        [cashboxId, line.direction, amt, line.date],
      );
      if (candidates.length === 1) {
        await this.ds.query(
          `UPDATE cashbox_transactions
              SET is_reconciled = TRUE, reconciled_at = NOW(),
                  reconciled_by = $2, statement_reference = $3
            WHERE id = $1`,
          [candidates[0].id, userId, line.reference ?? null],
        );
        results.push({
          statement_line: line,
          matched_id: candidates[0].id,
          status: 'matched',
        });
      } else if (candidates.length > 1) {
        results.push({
          statement_line: line,
          matched_id: null,
          status: 'ambiguous',
          candidates: candidates.length,
        });
      } else {
        results.push({
          statement_line: line,
          matched_id: null,
          status: 'unmatched',
        });
      }
    }

    return {
      matched: results.filter((r) => r.status === 'matched').length,
      ambiguous: results.filter((r) => r.status === 'ambiguous').length,
      unmatched: results.filter((r) => r.status === 'unmatched').length,
      results,
    };
  }

  async markReconciled(
    txnIds: string[],
    reference: string | null,
    userId: string,
  ) {
    if (!txnIds?.length) return { updated: 0 };
    await this.ds.query(
      `UPDATE cashbox_transactions
          SET is_reconciled = TRUE, reconciled_at = NOW(),
              reconciled_by = $2, statement_reference = COALESCE($3, statement_reference)
        WHERE id = ANY($1::uuid[])`,
      [txnIds, userId, reference],
    );
    return { updated: txnIds.length };
  }

  async unmarkReconciled(txnIds: string[]) {
    if (!txnIds?.length) return { updated: 0 };
    await this.ds.query(
      `UPDATE cashbox_transactions
          SET is_reconciled = FALSE, reconciled_at = NULL, reconciled_by = NULL
        WHERE id = ANY($1::uuid[])`,
      [txnIds],
    );
    return { updated: txnIds.length };
  }

  async removeCashbox(id: string) {
    // Safe-delete: require no open shifts & no movements.
    const [{ txn_count }] = await this.ds.query(
      `SELECT COUNT(*)::int AS txn_count FROM cashbox_transactions WHERE cashbox_id = $1`,
      [id],
    );
    if (txn_count > 0) {
      // Soft deactivate instead of destructive delete.
      await this.ds.query(
        `UPDATE cashboxes SET is_active = FALSE, updated_at = NOW() WHERE id = $1`,
        [id],
      );
      return { soft_deleted: true, reason: 'has_movements' };
    }
    const [{ open_shifts }] = await this.ds.query(
      `SELECT COUNT(*)::int AS open_shifts FROM shifts WHERE cashbox_id = $1 AND status IN ('open','pending_close')`,
      [id],
    );
    if (open_shifts > 0) {
      throw new BadRequestException('لا يمكن حذف خزنة عليها وردية مفتوحة');
    }
    await this.ds.query(`DELETE FROM cashboxes WHERE id = $1`, [id]);
    return { deleted: true };
  }

  /**
   * Today's in/out per cashbox, computed inline so the old
   * `v_dashboard_cashflow_today` view (which only returned
   * `cash_in_today`/`cash_out_today`) can't silently zero the KPIs out
   * on legacy DBs. Exposes both new and legacy column names.
   */
  cashflowToday() {
    // "خارج اليوم" / outflows_total must show ONLY real operational cash
    // that actually left the business (expenses, supplier payments,
    // payroll payout, real withdrawals, refunds). The following
    // categories are NOT operational and were inflating the KPI:
    //   • edit_reversal   — accounting reversal of a prior cash-in; no
    //                       money physically left (a customer sale was
    //                       corrected, nothing was paid out).
    //   • reversal_*      — mirror pattern produced by
    //                       posting.reverseByReference (Phase 2.5);
    //                       undoes a previous movement, not a new one.
    //   • transfer_out    — internal movement between own cashboxes;
    //                       net-zero across the treasury.
    //   • shift_variance  — already surfaced in the "فوارق الورديات"
    //                       tile and represents a physical shortage
    //                       that left the drawer *before* this row
    //                       was posted; counting it here would double-
    //                       report the same event.
    //
    // The IN side is NOT touched in this change. cash_in_today / inflows_total
    // continue to include every direction='in' row today; refining them
    // symmetrically (to drop edit_replay, reversal_*_in, transfer_in,
    // shift_variance surplus) is a separate decision.
    return this.ds.query(`
      SELECT
        cb.id                                  AS cashbox_id,
        cb.name_ar                             AS cashbox_name,
        cb.current_balance,
        COALESCE(SUM(ct.amount) FILTER (
          WHERE ct.direction = 'in'
            AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
        ), 0)::numeric(14,2)                   AS cash_in_today,
        COALESCE(SUM(ct.amount) FILTER (
          WHERE ct.direction = 'out'
            AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
            AND ct.category <> 'edit_reversal'
            AND ct.category NOT LIKE E'reversal\\_%' ESCAPE '\\'
            AND ct.category <> 'transfer_out'
            AND ct.category <> 'shift_variance'
        ), 0)::numeric(14,2)                   AS cash_out_today,
        COALESCE(SUM(ct.amount) FILTER (
          WHERE ct.direction = 'in'
            AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
        ), 0)::numeric(14,2)                   AS inflows_total,
        COALESCE(SUM(ct.amount) FILTER (
          WHERE ct.direction = 'out'
            AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
            AND ct.category <> 'edit_reversal'
            AND ct.category NOT LIKE E'reversal\\_%' ESCAPE '\\'
            AND ct.category <> 'transfer_out'
            AND ct.category <> 'shift_variance'
        ), 0)::numeric(14,2)                   AS outflows_total,
        COUNT(*) FILTER (
          WHERE DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
        )::int                                 AS transactions_today
      FROM cashboxes cb
      LEFT JOIN cashbox_transactions ct ON ct.cashbox_id = cb.id
      WHERE cb.is_active = TRUE
      GROUP BY cb.id, cb.name_ar, cb.current_balance
      ORDER BY cb.name_ar
    `);
  }

  /**
   * Net/gross shift variance totals across every closed shift.
   * Powers the "فوارق الورديات" tile next to the cashbox KPIs.
   *
   * Computed inline (not from a view) so the endpoint keeps working on
   * DBs where migration 046 hasn't been applied yet.
   */
  async shiftVariances() {
    const [row] = await this.ds.query(`
      SELECT
        COALESCE(SUM(actual_closing - expected_closing), 0)::numeric(14,2) AS net_variance,
        COALESCE(SUM(GREATEST(actual_closing - expected_closing, 0)), 0)::numeric(14,2) AS total_surplus,
        COALESCE(SUM(GREATEST(expected_closing - actual_closing, 0)), 0)::numeric(14,2) AS total_deficit,
        COUNT(*) FILTER (WHERE actual_closing - expected_closing > 0.01)::int AS surplus_count,
        COUNT(*) FILTER (WHERE expected_closing - actual_closing > 0.01)::int AS deficit_count,
        COUNT(*) FILTER (WHERE ABS(actual_closing - expected_closing) <= 0.01)::int AS matched_count
      FROM shifts
      WHERE status = 'closed'
        AND actual_closing IS NOT NULL
    `);
    return (
      row || {
        net_variance: 0,
        total_surplus: 0,
        total_deficit: 0,
        surplus_count: 0,
        deficit_count: 0,
        matched_count: 0,
      }
    );
  }

  /**
   * Unified cashbox movement feed — every inflow and outflow with an
   * Arabic label and the source document's reference number. Supports
   * optional cashbox, date range, direction and limit filters so the
   * UI can paginate without extra queries.
   */
  movements(params: {
    cashbox_id?: string;
    from?: string;
    to?: string;
    direction?: 'in' | 'out';
    category?: string;
    limit?: number;
    offset?: number;
  }) {
    const conds: string[] = [];
    const args: any[] = [];
    if (params.cashbox_id) {
      args.push(params.cashbox_id);
      conds.push(`cashbox_id = $${args.length}`);
    }
    if (params.direction === 'in' || params.direction === 'out') {
      args.push(params.direction);
      conds.push(`direction = $${args.length}`);
    }
    if (params.category) {
      args.push(params.category);
      conds.push(`category = $${args.length}`);
    }
    if (params.from) {
      args.push(params.from);
      conds.push(
        `(created_at AT TIME ZONE 'Africa/Cairo')::date >= $${args.length}::date`,
      );
    }
    if (params.to) {
      args.push(params.to);
      conds.push(
        `(created_at AT TIME ZONE 'Africa/Cairo')::date <= $${args.length}::date`,
      );
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    args.push(Math.min(Number(params.limit ?? 200), 1000));
    args.push(Math.max(Number(params.offset ?? 0), 0));

    // Inline query — equivalent to v_cashbox_movements but works even
    // on DBs where migration 046 hasn't been applied yet. The view
    // stays around as a convenience for direct SQL consumers.
    const whereOnT = where
      ? where.replace(/cashbox_id/g, 't.cashbox_id')
             .replace(/direction/g, 't.direction')
             .replace(/category/g, 't.category')
             .replace(/created_at/g, 't.created_at')
      : '';
    return this.ds.query(
      `
      SELECT
        t.id, t.cashbox_id, cb.name_ar AS cashbox_name,
        t.direction::text AS direction,
        t.amount::numeric(14,2) AS amount,
        t.category::text AS category,
        t.reference_type::text AS reference_type,
        t.reference_id,
        t.balance_after::numeric(14,2) AS balance_after,
        t.notes, t.user_id, u.full_name AS user_name, t.created_at,
        CASE t.category
          WHEN 'customer_receipt' THEN 'قبض من عميل'
          WHEN 'supplier_payment' THEN 'صرف لمورد'
          WHEN 'expense'          THEN 'مصروف'
          WHEN 'invoice_cash'     THEN 'مبيعات كاش'
          WHEN 'invoice_refund'   THEN 'مرتجع'
          WHEN 'opening_balance'  THEN 'رصيد افتتاحي'
          WHEN 'owner_topup'      THEN 'تمويل من المالك'
          WHEN 'bank_deposit'     THEN 'إيداع بنكي'
          WHEN 'manual_deposit'   THEN 'إيداع يدوي'
          WHEN 'manual_withdraw'  THEN 'سحب يدوي'
          WHEN 'adjustment'       THEN 'تسوية'
          WHEN 'payment'          THEN 'دفعة'
          WHEN 'receipt'          THEN 'سند قبض'
          WHEN 'purchase'         THEN 'شراء'
          ELSE COALESCE(t.category, 'أخرى')
        END AS kind_ar,
        COALESCE(
          (SELECT i.invoice_no FROM invoices i WHERE i.id = t.reference_id),
          (SELECT e.expense_no FROM expenses e WHERE e.id = t.reference_id),
          (SELECT cp.payment_no FROM customer_payments cp WHERE cp.id = t.reference_id),
          (SELECT sp.payment_no FROM supplier_payments sp WHERE sp.id = t.reference_id),
          (SELECT p.purchase_no FROM purchases p WHERE p.id = t.reference_id)
        ) AS reference_no,
        COALESCE(
          (SELECT c.full_name FROM customers c
             JOIN customer_payments cp ON cp.customer_id = c.id
            WHERE cp.id = t.reference_id),
          (SELECT s.name FROM suppliers s
             JOIN supplier_payments sp ON sp.supplier_id = s.id
            WHERE sp.id = t.reference_id),
          (SELECT s.name FROM suppliers s
             JOIN purchases p ON p.supplier_id = s.id
            WHERE p.id = t.reference_id)
        ) AS counterparty_name
      FROM cashbox_transactions t
      LEFT JOIN cashboxes cb ON cb.id = t.cashbox_id
      LEFT JOIN users     u  ON u.id  = t.user_id
      ${whereOnT}
      ORDER BY t.created_at DESC
      LIMIT $${args.length - 1} OFFSET $${args.length}
      `,
      args,
    );
  }

  /**
   * Manually deposit or withdraw cash from a cashbox. Used for opening
   * balances, owner top-ups, bank deposits, etc. Accepts an optional
   * `txn_date` so backdated adjustments can be recorded (e.g. "this was
   * yesterday's opening float"). The balance update still happens now —
   * only the transaction timestamp is backdated, which is what reports
   * and cashflow views read.
   */
  async deposit(
    dto: {
      cashbox_id: string;
      direction: 'in' | 'out';
      amount: number;
      category?: string;
      notes?: string;
      txn_date?: string; // YYYY-MM-DD
    },
    userId: string,
  ) {
    if (!dto.amount || Number(dto.amount) <= 0) {
      throw new Error('amount must be positive');
    }
    if (dto.direction !== 'in' && dto.direction !== 'out') {
      throw new Error('direction must be in or out');
    }
    return this.ds.transaction(async (em) => {
      const [box] = await em.query(
        `SELECT current_balance FROM cashboxes WHERE id = $1 FOR UPDATE`,
        [dto.cashbox_id],
      );
      if (!box) throw new Error('cashbox not found');

      if (!this.engine) {
        throw new Error('FinancialEngineService not wired');
      }
      // Generate a ref id so the engine's idempotency key is stable
      // for this specific adjustment.
      const [{ ref_id }] = await em.query(
        `SELECT gen_random_uuid() AS ref_id`,
      );
      const res = await this.engine.recordManualAdjustment({
        reference_id: ref_id,
        cashbox_id: dto.cashbox_id,
        direction: dto.direction,
        amount: Number(dto.amount),
        user_id: userId,
        entry_date: dto.txn_date,
        notes: dto.notes,
        em,
      });
      if (!res.ok) {
        throw new BadRequestException(`فشل الإيداع/السحب: ${res.error}`);
      }

      const [after] = await em.query(
        `SELECT current_balance FROM cashboxes WHERE id = $1`,
        [dto.cashbox_id],
      );
      const newBalance = Number(after?.current_balance || 0);
      return {
        id: ref_id,
        cashbox_id: dto.cashbox_id,
        direction: dto.direction,
        amount: Number(dto.amount),
        new_balance: newBalance,
      };
    });
  }
}
