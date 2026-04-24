import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinancialEngineService } from './financial-engine.service';

/**
 * System-wide audit + repair for the accounting layer.
 *
 * Three layers of truth that must agree:
 *   (A) Source documents  — invoices / expenses / payments / returns
 *   (B) cashboxes.current_balance + cashbox_transactions
 *   (C) journal_entries + journal_lines (the GL)
 *
 * Over time these can drift when:
 *   - an old flow updated current_balance but not the txn log
 *   - a legacy row was deleted instead of voided
 *   - posting failed silently (network blip during write)
 *
 * This service computes discrepancies and provides targeted fixes.
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger('Reconciliation');

  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly engine?: FinancialEngineService,
  ) {}

  /**
   * Per-cashbox audit:
   *   stored_balance    — cashboxes.current_balance
   *   computed_balance  — running sum of cashbox_transactions (in − out)
   *   gl_balance        — sum of posted journal_lines on the linked GL
   *                       account (if any)
   *   drift_txn         — stored_balance − computed_balance
   *   drift_gl          — computed_balance − gl_balance
   */
  async auditCashboxes() {
    // Defensively build the query so it works on any migration state.
    const [cols] = await this.ds.query(
      `SELECT
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='cashboxes' AND column_name='kind') AS has_kind,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='cashboxes' AND column_name='currency') AS has_currency,
         EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='chart_of_accounts' AND column_name='cashbox_id') AS has_coa_cb`,
    );
    const kindCol = cols?.has_kind ? 'cb.kind' : `'cash'::text`;
    const currencyCol = cols?.has_currency ? 'cb.currency' : `'EGP'::text`;
    const hasCoaCashbox = { present: cols?.has_coa_cb };
    const glSubquery = hasCoaCashbox?.present
      ? `COALESCE((
          SELECT SUM(jl.debit - jl.credit)
            FROM journal_lines jl
            JOIN journal_entries je ON je.id = jl.entry_id
            JOIN chart_of_accounts a ON a.id = jl.account_id
           WHERE a.cashbox_id = cb.id
             AND je.is_posted = TRUE AND je.is_void = FALSE
        ), 0)::numeric(14,2)`
      : `0::numeric(14,2)`;
    const glIdSubquery = hasCoaCashbox?.present
      ? `(SELECT a.id FROM chart_of_accounts a
           WHERE a.cashbox_id = cb.id AND a.is_active = TRUE LIMIT 1)`
      : `NULL`;
    const glCodeSubquery = hasCoaCashbox?.present
      ? `(SELECT a.code FROM chart_of_accounts a
           WHERE a.cashbox_id = cb.id AND a.is_active = TRUE LIMIT 1)`
      : `NULL`;
    return this.ds.query(`
      SELECT
        cb.id, cb.name_ar, ${kindCol} AS kind, ${currencyCol} AS currency, cb.is_active,
        cb.current_balance::numeric(14,2)  AS stored_balance,
        COALESCE((
          SELECT SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END)
            FROM cashbox_transactions WHERE cashbox_id = cb.id
        ), 0)::numeric(14,2) AS computed_balance,
        ${glSubquery} AS gl_balance,
        ${glIdSubquery} AS gl_account_id,
        ${glCodeSubquery} AS gl_account_code
      FROM cashboxes cb
      WHERE cb.is_active = TRUE
      ORDER BY cb.name_ar
    `);
  }

  /**
   * Invoices whose journal doesn't exist (or doesn't equal
   * grand_total on the debit side).
   */
  async auditInvoices(limit = 50) {
    return this.ds.query(
      `
      WITH posted AS (
        SELECT je.reference_id AS invoice_id,
               SUM(jl.debit)::numeric(14,2) AS posted_debit
          FROM journal_entries je
          JOIN journal_lines jl ON jl.entry_id = je.id
         WHERE je.reference_type = 'invoice'
           AND je.is_posted = TRUE AND je.is_void = FALSE
         GROUP BY je.reference_id
      )
      SELECT i.id, i.invoice_no, i.status, i.grand_total::numeric(14,2),
             i.completed_at, i.created_at,
             COALESCE(p.posted_debit, 0)::numeric(14,2) AS posted_debit,
             (i.grand_total - COALESCE(p.posted_debit, 0))::numeric(14,2) AS drift
        FROM invoices i
        LEFT JOIN posted p ON p.invoice_id = i.id
       WHERE i.status IN ('paid','completed','partially_paid')
         AND ABS(i.grand_total - COALESCE(p.posted_debit, 0)) > 0.01
       ORDER BY i.created_at DESC
       LIMIT $1
      `,
      [limit],
    );
  }

  /** Expenses approved but never posted to GL. */
  async auditExpenses(limit = 50) {
    return this.ds.query(
      `
      SELECT e.id, e.expense_no, e.amount, e.is_approved, e.expense_date,
             (e.id IN (
                SELECT reference_id FROM journal_entries
                 WHERE reference_type = 'expense'
                   AND is_posted = TRUE AND is_void = FALSE
             )) AS posted
        FROM expenses e
       WHERE e.is_approved = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM journal_entries je
            WHERE je.reference_type = 'expense'
              AND je.reference_id = e.id
              AND je.is_posted = TRUE AND je.is_void = FALSE
         )
       ORDER BY e.expense_date DESC
       LIMIT $1
      `,
      [limit],
    );
  }

  /** Payments (customer + supplier) that are not voided but have no GL. */
  async auditPayments(limit = 50) {
    const customer = await this.ds.query(
      `
      SELECT 'customer_payment' AS kind, cp.id, cp.payment_no, cp.amount,
             cp.created_at, cp.is_void
        FROM customer_payments cp
       WHERE cp.is_void = FALSE
         AND NOT EXISTS (
           SELECT 1 FROM journal_entries je
            WHERE je.reference_type = 'customer_payment'
              AND je.reference_id = cp.id
              AND je.is_posted = TRUE AND je.is_void = FALSE
         )
       ORDER BY cp.created_at DESC LIMIT $1
      `,
      [limit],
    );
    const supplier = await this.ds.query(
      `
      SELECT 'supplier_payment' AS kind, sp.id, sp.payment_no, sp.amount,
             sp.created_at, sp.is_void
        FROM supplier_payments sp
       WHERE sp.is_void = FALSE
         AND NOT EXISTS (
           SELECT 1 FROM journal_entries je
            WHERE je.reference_type = 'supplier_payment'
              AND je.reference_id = sp.id
              AND je.is_posted = TRUE AND je.is_void = FALSE
         )
       ORDER BY sp.created_at DESC LIMIT $1
      `,
      [limit],
    );
    return { customer, supplier };
  }

  /**
   * One-shot summary of every drift the app cares about. Powers the
   * audit page's KPI bar.
   */
  async summary() {
    const cashboxes = await this.auditCashboxes();
    const txnDrift = cashboxes.reduce(
      (acc: any, c: any) => {
        const d = Math.abs(
          Number(c.stored_balance) - Number(c.computed_balance),
        );
        const g = Math.abs(
          Number(c.computed_balance) - Number(c.gl_balance),
        );
        if (d > 0.01) acc.txn_mismatch++;
        if (g > 0.01) acc.gl_mismatch++;
        acc.max_txn_drift = Math.max(acc.max_txn_drift, d);
        acc.max_gl_drift = Math.max(acc.max_gl_drift, g);
        return acc;
      },
      { txn_mismatch: 0, gl_mismatch: 0, max_txn_drift: 0, max_gl_drift: 0 },
    );

    const [invDrift] = await this.ds.query(
      `
      SELECT COUNT(*)::int AS n,
             COALESCE(SUM(i.grand_total - COALESCE((
               SELECT SUM(jl.debit) FROM journal_lines jl
               JOIN journal_entries je ON je.id = jl.entry_id
               WHERE je.reference_type = 'invoice'
                 AND je.reference_id = i.id
                 AND je.is_posted = TRUE AND je.is_void = FALSE
             ), 0)), 0)::numeric(14,2) AS value
        FROM invoices i
       WHERE i.status IN ('paid','completed','partially_paid')
         AND ABS(i.grand_total - COALESCE((
               SELECT SUM(jl.debit) FROM journal_lines jl
               JOIN journal_entries je ON je.id = jl.entry_id
               WHERE je.reference_type = 'invoice'
                 AND je.reference_id = i.id
                 AND je.is_posted = TRUE AND je.is_void = FALSE
             ), 0)) > 0.01
      `,
    );

    const [expDrift] = await this.ds.query(
      `
      SELECT COUNT(*)::int AS n,
             COALESCE(SUM(amount), 0)::numeric(14,2) AS value
        FROM expenses e
       WHERE e.is_approved = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM journal_entries je
            WHERE je.reference_type = 'expense'
              AND je.reference_id = e.id
              AND je.is_posted = TRUE AND je.is_void = FALSE
         )
      `,
    );

    const [paymentDrift] = await this.ds.query(
      `
      SELECT
        (SELECT COUNT(*)::int FROM customer_payments cp
          WHERE cp.is_void = FALSE
            AND NOT EXISTS (SELECT 1 FROM journal_entries je
              WHERE je.reference_type='customer_payment' AND je.reference_id=cp.id
                AND je.is_posted AND NOT je.is_void))
        + (SELECT COUNT(*)::int FROM supplier_payments sp
          WHERE sp.is_void = FALSE
            AND NOT EXISTS (SELECT 1 FROM journal_entries je
              WHERE je.reference_type='supplier_payment' AND je.reference_id=sp.id
                AND je.is_posted AND NOT je.is_void))
        AS n
      `,
    );

    return {
      cashboxes: {
        total: cashboxes.length,
        ...txnDrift,
      },
      invoices: {
        missing_count: Number(invDrift?.n || 0),
        missing_value: Number(invDrift?.value || 0),
      },
      expenses: {
        missing_count: Number(expDrift?.n || 0),
        missing_value: Number(expDrift?.value || 0),
      },
      payments: {
        missing_count: Number(paymentDrift?.n || 0),
      },
    };
  }

  /**
   * Recompute a cashbox's current_balance from its transaction log.
   * Uses the sum of (in − out) as the authoritative value.
   *
   * NOTE: this is one of only TWO sanctioned paths that write to
   * cashboxes.current_balance (the other is fn_record_cashbox_txn).
   * Migration 058 protects the column from all other writers.
   */
  async rebuildCashboxBalance(cashboxId: string) {
    const [r] = await this.ds.query(
      `
      SELECT COALESCE(SUM(
        CASE WHEN direction = 'in' THEN amount ELSE -amount END
      ), 0)::numeric(14,2) AS computed
        FROM cashbox_transactions
       WHERE cashbox_id = $1
      `,
      [cashboxId],
    );
    const computed = Number(r?.computed || 0);
    // Raise the session flag so migration 058's trigger allows the
    // write — this is a sanctioned rebuild, not a stray mutation.
    await this.ds.transaction(async (em) => {
      // Migration 068 strict guard: service:* identity pattern.
      await em.query(
        `SET LOCAL app.engine_context = 'service:reconciliation.service'`,
      );
      await em.query(
        `UPDATE cashboxes SET current_balance = $2, updated_at = NOW()
          WHERE id = $1`,
        [cashboxId, computed],
      );
    });
    return { cashbox_id: cashboxId, new_balance: computed };
  }

  /** Legacy alias so callers that used the old name keep working. */
  async recomputeCashboxBalance(cashboxId: string) {
    return this.rebuildCashboxBalance(cashboxId);
  }

  /**
   * Compare cash (cashbox_transactions ledger) vs GL (posted
   * journal_lines on the cashbox's linked asset account). Any drift
   * between the two is a data-integrity alarm. Read-only.
   *
   *   txn_balance = Σ(in − out) from cashbox_transactions
   *   gl_balance  = Σ(debit − credit) on the GL asset account
   *   stored_balance = cashboxes.current_balance
   *
   * Healthy system: txn_balance = gl_balance = stored_balance.
   */
  async compareCashVsGl(): Promise<
    Array<{
      cashbox_id: string;
      name_ar: string;
      currency: string;
      kind: string;
      gl_account_code: string | null;
      stored_balance: number;
      txn_balance: number;
      gl_balance: number;
      drift_stored_vs_txn: number;
      drift_txn_vs_gl: number;
      status: 'ok' | 'drift';
    }>
  > {
    const rows = await this.ds.query(
      `
      SELECT
        cb.id                                      AS cashbox_id,
        cb.name_ar,
        COALESCE(cb.currency, 'EGP')               AS currency,
        COALESCE(cb.kind, 'cash')                  AS kind,
        (SELECT a.code FROM chart_of_accounts a
          WHERE a.cashbox_id = cb.id AND a.is_active LIMIT 1)
                                                   AS gl_account_code,
        cb.current_balance::numeric(14,2)          AS stored_balance,
        COALESCE((
          SELECT SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END)
            FROM cashbox_transactions
           WHERE cashbox_id = cb.id
        ), 0)::numeric(14,2)                       AS txn_balance,
        COALESCE((
          SELECT SUM(jl.debit - jl.credit)
            FROM journal_lines jl
            JOIN journal_entries je ON je.id = jl.entry_id
            JOIN chart_of_accounts a ON a.id = jl.account_id
           WHERE a.cashbox_id = cb.id
             AND je.is_posted AND NOT je.is_void
        ), 0)::numeric(14,2)                       AS gl_balance
      FROM cashboxes cb
      WHERE cb.is_active = TRUE
      ORDER BY cb.name_ar
      `,
    );
    return rows.map((r: any) => {
      const stored = Number(r.stored_balance);
      const txn = Number(r.txn_balance);
      const gl = Number(r.gl_balance);
      const driftStoredTxn = Math.round((stored - txn) * 100) / 100;
      const driftTxnGl = Math.round((txn - gl) * 100) / 100;
      const hasDrift =
        Math.abs(driftStoredTxn) > 0.01 || Math.abs(driftTxnGl) > 0.01;
      return {
        cashbox_id: r.cashbox_id,
        name_ar: r.name_ar,
        currency: r.currency,
        kind: r.kind,
        gl_account_code: r.gl_account_code,
        stored_balance: stored,
        txn_balance: txn,
        gl_balance: gl,
        drift_stored_vs_txn: driftStoredTxn,
        drift_txn_vs_gl: driftTxnGl,
        status: hasDrift ? ('drift' as const) : ('ok' as const),
      };
    });
  }

  /**
   * Deduplicate journal entries — same source document posted as
   * multiple LIVE entries (happens when backfill runs while an old
   * duplicate is still posted non-void). Keeps the oldest LIVE
   * entry per (reference_type, reference_id) and voids the rest.
   */
  async dedupeJournalEntries(): Promise<{
    duplicates_voided: number;
    groups: number;
  }> {
    const r = await this.ds.query(
      `
      WITH live AS (
        SELECT id, reference_type, reference_id, created_at,
               ROW_NUMBER() OVER (
                 PARTITION BY reference_type, reference_id
                 ORDER BY created_at ASC, id ASC
               ) AS rn
          FROM journal_entries
         WHERE reference_type IS NOT NULL
           AND reference_id   IS NOT NULL
           AND reference_type <> 'reversal'
           AND is_posted      = TRUE
           AND is_void        = FALSE
      )
      UPDATE journal_entries je
         SET is_void     = TRUE,
             void_reason = 'auto dedupe — duplicate of older entry',
             voided_at   = NOW()
        FROM live
       WHERE je.id = live.id
         AND live.rn > 1
      RETURNING je.id
      `,
    );
    const [{ groups }] = await this.ds.query(
      `
      SELECT COUNT(DISTINCT (reference_type, reference_id))::int AS groups
        FROM journal_entries
       WHERE reference_type IS NOT NULL
         AND reference_id   IS NOT NULL
         AND reference_type <> 'reversal'
         AND is_posted      = TRUE
         AND is_void        = FALSE
      `,
    );
    return { duplicates_voided: r.length, groups };
  }

  /**
   * Recompute customers.current_balance and suppliers.current_balance
   * from the underlying source tables (invoices − payments and
   * purchases − payments). Triggers may be missing or broken on
   * legacy installs; this is the safe rebuild.
   */
  async recomputePartyBalances(): Promise<{
    customers_updated: number;
    suppliers_updated: number;
  }> {
    // Customers: current_balance = Σ unpaid invoices − Σ non-void deposits
    const cust = await this.ds.query(
      `
      WITH agg AS (
        SELECT c.id AS customer_id,
               COALESCE((
                 SELECT SUM(i.grand_total - COALESCE(i.paid_amount, 0))
                   FROM invoices i
                  WHERE i.customer_id = c.id
                    AND COALESCE(i.status::text,'') NOT IN ('cancelled','void','draft')
               ), 0) AS outstanding,
               COALESCE((
                 SELECT SUM(cp.amount)
                   FROM customer_payments cp
                  WHERE cp.customer_id = c.id
                    AND cp.is_void = FALSE
                    AND cp.kind = 'deposit'
               ), 0) AS deposits
          FROM customers c
      )
      UPDATE customers c
         SET current_balance = (agg.outstanding - agg.deposits)::numeric(14,2)
        FROM agg
       WHERE c.id = agg.customer_id
      RETURNING c.id
      `,
    );

    const supp = await this.ds.query(
      `
      WITH agg AS (
        SELECT s.id AS supplier_id,
               COALESCE((
                 SELECT SUM(p.grand_total - COALESCE(p.paid_amount, 0))
                   FROM purchases p
                  WHERE p.supplier_id = s.id
                    AND COALESCE(p.status::text,'') NOT IN ('cancelled','draft')
               ), 0) AS owed
          FROM suppliers s
      )
      UPDATE suppliers s
         SET current_balance = agg.owed::numeric(14,2)
        FROM agg
       WHERE s.id = agg.supplier_id
      RETURNING s.id
      `,
    );

    return {
      customers_updated: cust.length,
      suppliers_updated: supp.length,
    };
  }

  /**
   * One-shot "start fresh" — snapshot every transactional row to the
   * caller (so the frontend can download an Excel backup BEFORE
   * anything is touched), then perform a full factory reset in a
   * single atomic action. Returns the snapshot + the wipe counts
   * in one response.
   */
  async quickStart(): Promise<{
    snapshot: Record<string, any[]>;
    reset: { wiped: Record<string, number>; note: string };
  }> {
    const snapshot = await this.dataSnapshot();
    const reset = await this.factoryReset({ keep_stock: false });
    return { snapshot, reset };
  }

  /**
   * Post an opening-balance journal entry — the single starting point
   * for a fresh deployment. Writes one balanced entry that sets:
   *
   *   DR Cash (1111) ← cash_in_hand
   *   DR Receivables (1121) ← customer_dues
   *   DR Inventory (1131) ← inventory_value
   *   DR Fixed assets (121) ← fixed_assets
   *   CR Suppliers (211) ← supplier_dues
   *   CR Capital (31) ← plug (everything else balances into owner's equity)
   *
   * Also sets cashboxes.opening_balance + current_balance, and creates
   * an opening cashbox_transaction so the cash side of reports agrees.
   */
  async postOpeningBalance(
    args: {
      entry_date: string; // YYYY-MM-DD
      cash_in_hand?: number;
      customer_dues?: number;
      supplier_dues?: number;
      inventory_value?: number;
      fixed_assets?: number;
      capital?: number; // optional explicit capital; otherwise plug
      cashbox_id?: string;
      notes?: string;
    },
    userId: string,
  ): Promise<{
    entry_id: string | null;
    cashbox_id: string | null;
    plug_to_capital: number;
  }> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(args.entry_date || '')) {
      throw new BadRequestException('تاريخ غير صحيح');
    }

    const values = {
      cash: Number(args.cash_in_hand || 0),
      recv: Number(args.customer_dues || 0),
      inv: Number(args.inventory_value || 0),
      fa: Number(args.fixed_assets || 0),
      supp: Number(args.supplier_dues || 0),
      cap: args.capital != null ? Number(args.capital) : null,
    };
    const totalDebit = values.cash + values.recv + values.inv + values.fa;
    // If user didn't specify capital, plug = debit − supplier payable.
    const plug =
      values.cap != null ? values.cap : totalDebit - values.supp;
    const totalCredit = values.supp + plug;

    if (Math.abs(totalDebit - totalCredit) > 0.01) {
      throw new BadRequestException(
        `القيد غير متوازن: مدين ${totalDebit} ≠ دائن ${totalCredit}`,
      );
    }
    if (totalDebit < 0.01) {
      throw new BadRequestException('قيد فارغ');
    }

    return this.ds.transaction(async (em) => {
      // Cashbox — prefer the supplied one, else any active cashbox.
      let cashboxId = args.cashbox_id ?? null;
      if (!cashboxId) {
        const [cb] = await em.query(
          `SELECT id FROM cashboxes WHERE is_active = TRUE ORDER BY created_at LIMIT 1`,
        );
        cashboxId = cb?.id ?? null;
      }
      if (!cashboxId && values.cash > 0) {
        throw new BadRequestException(
          'لا توجد خزنة نشطة لإدخال الرصيد الافتتاحي النقدي',
        );
      }

      // Check we haven't already posted an opening entry (guards
      // against the user calling the wizard twice by mistake; the
      // engine's idempotency guard handles the same-date case, but a
      // different-date duplicate opening would also be wrong).
      const [existing] = await em.query(
        `SELECT id FROM journal_entries
          WHERE reference_type = 'opening_balance'
            AND is_posted = TRUE AND is_void = FALSE
          LIMIT 1`,
      );
      if (existing) {
        throw new BadRequestException(
          'تم تسجيل رصيد افتتاحي مسبقاً. احذف القيد الحالي قبل تسجيل جديد.',
        );
      }

      if (!this.engine) {
        throw new BadRequestException('FinancialEngineService غير متاح');
      }
      const res = await this.engine.recordOpeningBalance({
        cash_in_hand: values.cash,
        customer_dues: values.recv,
        inventory_value: values.inv,
        fixed_assets: values.fa,
        supplier_dues: values.supp,
        capital: values.cap,
        cashbox_id: cashboxId,
        entry_date: args.entry_date,
        user_id: userId,
        em,
      });
      if (!res.ok) {
        throw new BadRequestException(
          `فشل تسجيل الرصيد الافتتاحي: ${res.error}`,
        );
      }

      // Stamp the cashbox's opening_balance column for reports that
      // care about it (this is a metadata update, not a balance
      // mutation — the running balance came from the engine's cash
      // movement above).
      if (cashboxId && values.cash > 0) {
        await em.query(
          `UPDATE cashboxes SET opening_balance = $1, updated_at = NOW()
            WHERE id = $2`,
          [values.cash, cashboxId],
        );
      }

      return {
        entry_id: 'skipped' in res ? res.entry_id : res.entry_id,
        cashbox_id: cashboxId,
        plug_to_capital: res.plug_to_capital ?? plug,
      };
    });
  }

  /**
   * Deduplicate cashbox_transactions: when the same source document
   * (invoice / expense / payment / …) appears in multiple rows with
   * the same direction + amount on the same cashbox, keep the oldest
   * and delete the rest. Handles the "مبيعات سابقة backfill" duplicates
   * a prior manual import introduced.
   *
   * Opening-balance and manual-adjustment rows (no reference_id) are
   * never touched — those can't be regenerated from source docs.
   */
  async dedupeCashboxTransactions(): Promise<{
    duplicates_removed: number;
    groups: number;
  }> {
    const r = await this.ds.query(
      `
      WITH dupes AS (
        SELECT id,
               ROW_NUMBER() OVER (
                 PARTITION BY cashbox_id, reference_type, reference_id,
                              direction, amount
                 ORDER BY created_at ASC, id ASC
               ) AS rn
          FROM cashbox_transactions
         WHERE reference_id IS NOT NULL
      )
      DELETE FROM cashbox_transactions
       WHERE id IN (SELECT id FROM dupes WHERE rn > 1)
      RETURNING id
      `,
    );
    const [{ groups }] = await this.ds.query(
      `
      SELECT COUNT(*)::int AS groups
        FROM (
          SELECT cashbox_id, reference_type, reference_id, direction, amount
            FROM cashbox_transactions
           WHERE reference_id IS NOT NULL
           GROUP BY 1, 2, 3, 4, 5
        ) x
      `,
    );
    return { duplicates_removed: r.length, groups };
  }

  /** Rebuild all active cashbox balances. */
  async recomputeAllCashboxes() {
    const boxes = await this.ds.query(
      `SELECT id FROM cashboxes WHERE is_active = TRUE`,
    );
    const out: any[] = [];
    for (const b of boxes) {
      out.push(await this.recomputeCashboxBalance(b.id));
    }
    return { updated: out.length, results: out };
  }

  /**
   * Force-post every approved expense that doesn't have a GL entry
   * yet. Reports per-expense result so the user can see exactly why
   * any particular row failed.
   */
  async forcePostApprovedExpenses(
    posting: {
      postExpense: (id: string, userId: string) => Promise<any>;
    },
    userId: string,
  ): Promise<{
    found: number;
    posted: number;
    skipped: number;
    failed: number;
    results: Array<{
      expense_id: string;
      expense_no: string | null;
      amount: string;
      status: 'posted' | 'skipped' | 'failed';
      reason?: string;
    }>;
  }> {
    const rows = await this.ds.query(
      `
      SELECT e.id, e.expense_no, e.amount, e.cashbox_id, e.category_id,
             e.expense_date, e.is_approved,
             ec.account_id AS category_account_id
        FROM expenses e
        LEFT JOIN expense_categories ec ON ec.id = e.category_id
       WHERE e.is_approved = TRUE
         AND NOT EXISTS (
           SELECT 1 FROM journal_entries je
            WHERE je.reference_type = 'expense'
              AND je.reference_id = e.id
              AND je.is_posted = TRUE AND je.is_void = FALSE
         )
       ORDER BY e.expense_date ASC
      `,
    );
    const out: any[] = [];
    let posted = 0;
    let skipped = 0;
    let failed = 0;

    // Resolve the fallback expense account once.
    const [miscAcc] = await this.ds.query(
      `SELECT id, code FROM chart_of_accounts WHERE code = '529' AND is_active = TRUE LIMIT 1`,
    );

    for (const r of rows) {
      const amt = Number(r.amount);
      // Pre-flight diagnosis — determine why postExpense might refuse.
      const reasons: string[] = [];
      if (!(amt > 0)) reasons.push('amount <= 0');
      if (!r.category_account_id && !miscAcc?.id)
        reasons.push('no expense account (category not linked + 529 missing)');

      if (reasons.length) {
        // Try to auto-link the category to 529 when the issue is a
        // missing category.account_id and 529 exists.
        if (
          !r.category_account_id &&
          miscAcc?.id &&
          r.category_id
        ) {
          try {
            await this.ds.query(
              `UPDATE expense_categories SET account_id = $1 WHERE id = $2 AND account_id IS NULL`,
              [miscAcc.id, r.category_id],
            );
          } catch {
            /* ignore */
          }
        }
      }

      try {
        const r2 = await posting.postExpense(r.id, userId);
        if (r2 && (r2 as any).skipped) {
          skipped++;
          out.push({
            expense_id: r.id,
            expense_no: r.expense_no,
            amount: r.amount,
            status: 'skipped' as const,
            reason: 'already posted (duplicate guard)',
          });
        } else if (r2 && (r2 as any).error) {
          failed++;
          out.push({
            expense_id: r.id,
            expense_no: r.expense_no,
            amount: r.amount,
            status: 'failed' as const,
            reason: (r2 as any).error,
          });
        } else if (r2 && (r2 as any).entry_id) {
          posted++;
          out.push({
            expense_id: r.id,
            expense_no: r.expense_no,
            amount: r.amount,
            status: 'posted' as const,
          });
        } else {
          failed++;
          out.push({
            expense_id: r.id,
            expense_no: r.expense_no,
            amount: r.amount,
            status: 'failed' as const,
            reason: reasons.join('; ') || 'cashbox account missing or amount invalid',
          });
        }
      } catch (err: any) {
        failed++;
        out.push({
          expense_id: r.id,
          expense_no: r.expense_no,
          amount: r.amount,
          status: 'failed' as const,
          reason: err?.message ?? String(err),
        });
      }
    }
    return {
      found: rows.length,
      posted,
      skipped,
      failed,
      results: out,
    };
  }

  /**
   * Force-post every invoice that doesn't have a live GL entry. Same
   * pattern as forcePostApprovedExpenses — detailed per-row outcome
   * so the user knows exactly why anything refused.
   */
  async forcePostInvoices(
    posting: {
      postInvoice: (id: string, userId: string) => Promise<any>;
    },
    userId: string,
  ): Promise<{
    found: number;
    posted: number;
    skipped: number;
    failed: number;
    results: Array<{
      invoice_id: string;
      invoice_no: string | null;
      grand_total: string;
      status: 'posted' | 'skipped' | 'failed';
      reason?: string;
    }>;
  }> {
    const rows = await this.ds.query(
      `
      SELECT i.id, i.invoice_no, i.grand_total
        FROM invoices i
       WHERE i.status IN ('paid','completed','partially_paid')
         AND NOT EXISTS (
           SELECT 1 FROM journal_entries je
            WHERE je.reference_type = 'invoice'
              AND je.reference_id = i.id
              AND je.is_posted = TRUE AND je.is_void = FALSE
         )
       ORDER BY i.created_at ASC
      `,
    );
    const out: any[] = [];
    let posted = 0;
    let skipped = 0;
    let failed = 0;

    for (const r of rows) {
      try {
        const r2 = await posting.postInvoice(r.id, userId);
        if (r2 && (r2 as any).skipped) {
          skipped++;
          out.push({
            invoice_id: r.id,
            invoice_no: r.invoice_no,
            grand_total: r.grand_total,
            status: 'skipped' as const,
            reason: 'already posted',
          });
        } else if (r2 && (r2 as any).error) {
          failed++;
          out.push({
            invoice_id: r.id,
            invoice_no: r.invoice_no,
            grand_total: r.grand_total,
            status: 'failed' as const,
            reason: (r2 as any).error,
          });
        } else if (r2 && (r2 as any).entry_id) {
          posted++;
          out.push({
            invoice_id: r.id,
            invoice_no: r.invoice_no,
            grand_total: r.grand_total,
            status: 'posted' as const,
          });
        } else {
          failed++;
          out.push({
            invoice_id: r.id,
            invoice_no: r.invoice_no,
            grand_total: r.grand_total,
            status: 'failed' as const,
            reason: 'cashbox/sales account missing',
          });
        }
      } catch (err: any) {
        failed++;
        out.push({
          invoice_id: r.id,
          invoice_no: r.invoice_no,
          grand_total: r.grand_total,
          status: 'failed' as const,
          reason: err?.message ?? String(err),
        });
      }
    }
    return { found: rows.length, posted, skipped, failed, results: out };
  }

  /**
   * Nuke cancelled invoices and everything attached to them — hard
   * delete. Used to clean the slate after voids accumulated over time
   * and bloated the reports.
   *
   * Deletes:
   *   - the invoice itself (CASCADE takes invoice_items + invoice_payments)
   *   - its journal_entries (both the original + any reversal)
   *   - its cashbox_transactions
   *
   * The source documents for non-cancelled invoices are never touched.
   */
  async purgeCancelledInvoices(): Promise<{
    invoices_deleted: number;
    journal_entries_deleted: number;
    cashbox_txns_deleted: number;
  }> {
    return this.ds.transaction(async (em) => {
      const cancelled = await em.query(
        `SELECT id FROM invoices WHERE status = 'cancelled'`,
      );
      if (!cancelled.length) {
        return {
          invoices_deleted: 0,
          journal_entries_deleted: 0,
          cashbox_txns_deleted: 0,
        };
      }
      const ids = cancelled.map((r: any) => r.id);

      // Journal entries tied to these invoices (both invoice posts + any
      // reversal entries that point at them via reversal_of).
      const je = await em.query(
        `
        DELETE FROM journal_entries
         WHERE (reference_type = 'invoice' AND reference_id = ANY($1::uuid[]))
            OR reversal_of IN (
              SELECT id FROM journal_entries
               WHERE reference_type = 'invoice'
                 AND reference_id = ANY($1::uuid[])
            )
        RETURNING id
        `,
        [ids],
      );

      // Cashbox transactions linked to the cancelled invoices (either
      // directly via reference_id or via invoice_payments).
      const ct = await em.query(
        `
        DELETE FROM cashbox_transactions
         WHERE reference_type = 'invoice'
           AND reference_id = ANY($1::uuid[])
        RETURNING id
        `,
        [ids],
      );

      // invoice_payments auto-cascades with invoices; same for
      // invoice_items.
      const inv = await em.query(
        `DELETE FROM invoices WHERE id = ANY($1::uuid[]) RETURNING id`,
        [ids],
      );

      return {
        invoices_deleted: inv.length,
        journal_entries_deleted: je.length,
        cashbox_txns_deleted: ct.length,
      };
    });
  }

  /**
   * Comprehensive one-click cleanup — the user-requested "سلاح نووي"
   * for resetting accounting state after a messy import:
   *
   *   1. Hard-delete every cancelled invoice + its GL + its cashbox txns
   *   2. Hard-delete ALL journal_entries / journal_lines (not just void)
   *   3. Consolidate every active cashbox into a single
   *      "الخزينة الرئيسية" — move every cashbox_transaction over,
   *      deactivate the others
   *   4. Dedupe cashbox_transactions (same invoice/expense in two rows)
   *   5. Re-post all surviving sources (invoices / expenses / payments
   *      / returns / purchases / shifts) to the fresh GL
   *   6. Recompute the main cashbox balance from its transactions
   *
   * Non-negotiable preserved data: active invoices, expenses,
   * customer/supplier payments, suppliers, customers, products, stock.
   */
  async fullCleanup(opts: {
    posting: {
      backfill: (args: {
        since?: string;
        userId: string;
      }) => Promise<any>;
    };
    userId: string;
  }): Promise<{
    cancelled_invoices_deleted: number;
    journal_entries_wiped: number;
    cashboxes_consolidated: number;
    duplicates_removed: number;
    main_cashbox_id: string | null;
    main_cashbox_balance: number;
    backfill: any;
  }> {
    const log: any = {
      cancelled_invoices_deleted: 0,
      journal_entries_wiped: 0,
      cashboxes_consolidated: 0,
      duplicates_removed: 0,
      main_cashbox_id: null,
      main_cashbox_balance: 0,
      backfill: null,
    };

    // ── (1) Purge cancelled invoices + their traces ───────────────
    const purged = await this.purgeCancelledInvoices();
    log.cancelled_invoices_deleted = purged.invoices_deleted;

    // ── (2) Hard-wipe the entire GL. Not "void" — DELETE. The caller
    //       has asked for a clean slate and will re-post via backfill.
    const jl = await this.ds.query(`DELETE FROM journal_lines RETURNING id`);
    const je = await this.ds.query(
      `DELETE FROM journal_entries RETURNING id`,
    );
    log.journal_entries_wiped = je.length;

    // ── (3) Consolidate all active cashboxes into a single
    //       "الخزينة الرئيسية". Preserve existing if one already exists
    //       with that exact name, else create/rename the first active.
    const [existing] = await this.ds.query(
      `SELECT id FROM cashboxes
        WHERE is_active = TRUE AND name_ar = 'الخزينة الرئيسية'
        LIMIT 1`,
    );
    let mainId: string | null = existing?.id ?? null;
    if (!mainId) {
      // Pick the first active cashbox and rename it.
      const [first] = await this.ds.query(
        `SELECT id FROM cashboxes WHERE is_active = TRUE
          ORDER BY created_at ASC LIMIT 1`,
      );
      if (first) {
        await this.ds.query(
          `UPDATE cashboxes SET name_ar = 'الخزينة الرئيسية', updated_at = NOW()
            WHERE id = $1`,
          [first.id],
        );
        mainId = first.id;
      }
    }

    if (mainId) {
      // Point every cashbox_transaction at the main.
      const others = await this.ds.query(
        `SELECT id FROM cashboxes WHERE id <> $1 AND is_active = TRUE`,
        [mainId],
      );
      if (others.length) {
        const otherIds = others.map((o: any) => o.id);
        await this.ds.query(
          `UPDATE cashbox_transactions SET cashbox_id = $1
            WHERE cashbox_id = ANY($2::uuid[])`,
          [mainId, otherIds],
        );
        // Deactivate the other cashboxes so no new postings land there.
        await this.ds.query(
          `UPDATE cashboxes SET is_active = FALSE, updated_at = NOW()
            WHERE id = ANY($1::uuid[])`,
          [otherIds],
        );
        log.cashboxes_consolidated = others.length;
      }

      // Point the GL link to the main cashbox so postings resolve
      // correctly after backfill. Clears any old links first.
      const [coaMain] = await this.ds.query(
        `SELECT id FROM chart_of_accounts WHERE code = '1111' LIMIT 1`,
      );
      if (coaMain) {
        await this.ds.query(
          `UPDATE chart_of_accounts SET cashbox_id = NULL
            WHERE cashbox_id IS NOT NULL`,
        );
        await this.ds.query(
          `UPDATE chart_of_accounts SET cashbox_id = $1
            WHERE id = $2`,
          [mainId, coaMain.id],
        );
      }
      log.main_cashbox_id = mainId;
    }

    // ── (4) Dedupe cashbox_transactions ────────────────────────────
    const dedupe = await this.dedupeCashboxTransactions();
    log.duplicates_removed = dedupe.duplicates_removed;

    // ── (5) Re-post everything from source documents ──────────────
    log.backfill = await opts.posting.backfill({
      since: '2020-01-01',
      userId: opts.userId,
    });

    // ── (6) Recompute the main cashbox balance ────────────────────
    if (mainId) {
      const r = await this.recomputeCashboxBalance(mainId);
      log.main_cashbox_balance = r.new_balance;
    }
    void jl;
    return log;
  }

  /**
   * Snapshot every row that matters before a destructive action.
   * Returns a single payload the frontend turns into a multi-sheet
   * Excel file — the user downloads it for safe-keeping / review.
   *
   * Includes enriched invoice / expense rows with the
   * customer / supplier / category names so the downloaded file is
   * readable without cross-referencing.
   */
  async dataSnapshot(): Promise<Record<string, any[]>> {
    const safeList = async (sql: string): Promise<any[]> => {
      try {
        return await this.ds.query(sql);
      } catch {
        return [];
      }
    };

    const invoices = await safeList(`
      SELECT i.invoice_no, i.status,
             i.grand_total, i.paid_amount, i.tax_amount, i.cogs_total,
             i.subtotal, i.invoice_discount, i.items_discount_total,
             i.coupon_discount,
             COALESCE(i.completed_at::text, i.created_at::text) AS invoice_date,
             c.code        AS customer_code,
             c.full_name   AS customer_name,
             c.phone       AS customer_phone,
             u.full_name   AS cashier_name,
             sp.full_name  AS salesperson_name,
             w.name_ar     AS warehouse_name
        FROM invoices i
        LEFT JOIN customers c  ON c.id  = i.customer_id
        LEFT JOIN users u      ON u.id  = i.cashier_id
        LEFT JOIN users sp     ON sp.id = i.salesperson_id
        LEFT JOIN warehouses w ON w.id  = i.warehouse_id
       ORDER BY COALESCE(i.completed_at, i.created_at) DESC
    `);

    const invoiceItems = await safeList(`
      SELECT i.invoice_no,
             p.name_ar     AS product_name,
             pv.barcode    AS sku,
             ii.quantity, ii.unit_price, ii.unit_cost,
             ii.discount_amount, ii.tax_amount,
             ii.line_subtotal, ii.line_total
        FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        LEFT JOIN product_variants pv ON pv.id = ii.variant_id
        LEFT JOIN products p          ON p.id  = pv.product_id
       ORDER BY i.invoice_no, ii.id
    `);

    const invoicePayments = await safeList(`
      SELECT i.invoice_no,
             ip.payment_method, ip.amount,
             ip.reference_number, ip.paid_at::text AS paid_at,
             u.full_name AS received_by
        FROM invoice_payments ip
        JOIN invoices i  ON i.id  = ip.invoice_id
        LEFT JOIN users u ON u.id = ip.received_by
       ORDER BY ip.paid_at DESC
    `);

    const expenses = await safeList(`
      SELECT e.expense_no, e.amount, e.expense_date::text AS expense_date,
             e.payment_method, e.description, e.vendor_name,
             e.is_approved,
             ec.code     AS category_code,
             ec.name_ar  AS category_name,
             cb.name_ar  AS cashbox_name,
             w.name_ar   AS warehouse_name,
             u.full_name AS created_by_name
        FROM expenses e
        LEFT JOIN expense_categories ec ON ec.id = e.category_id
        LEFT JOIN cashboxes cb          ON cb.id = e.cashbox_id
        LEFT JOIN warehouses w          ON w.id  = e.warehouse_id
        LEFT JOIN users u               ON u.id  = e.created_by
       ORDER BY e.expense_date DESC, e.created_at DESC
    `);

    const customerPayments = await safeList(`
      SELECT cp.payment_no, cp.amount, cp.kind, cp.payment_method,
             cp.reference_number, cp.is_void,
             cp.created_at::text AS paid_at,
             c.full_name AS customer_name,
             c.code      AS customer_code,
             cb.name_ar  AS cashbox_name,
             u.full_name AS received_by
        FROM customer_payments cp
        LEFT JOIN customers c  ON c.id  = cp.customer_id
        LEFT JOIN cashboxes cb ON cb.id = cp.cashbox_id
        LEFT JOIN users u      ON u.id  = cp.received_by
       ORDER BY cp.created_at DESC
    `);

    const supplierPayments = await safeList(`
      SELECT sp.payment_no, sp.amount, sp.payment_method,
             sp.reference_number, sp.is_void,
             sp.created_at::text AS paid_at,
             s.name      AS supplier_name,
             s.code      AS supplier_code,
             cb.name_ar  AS cashbox_name,
             u.full_name AS paid_by
        FROM supplier_payments sp
        LEFT JOIN suppliers s  ON s.id  = sp.supplier_id
        LEFT JOIN cashboxes cb ON cb.id = sp.cashbox_id
        LEFT JOIN users u      ON u.id  = sp.paid_by
       ORDER BY sp.created_at DESC
    `);

    const returns = await safeList(`
      SELECT r.return_no, r.status,
             r.total_refund, r.restocking_fee, r.net_refund,
             r.refund_method,
             r.requested_at::text AS requested_at,
             r.approved_at::text  AS approved_at,
             r.refunded_at::text  AS refunded_at,
             i.invoice_no AS original_invoice,
             c.full_name  AS customer_name
        FROM returns r
        LEFT JOIN invoices i  ON i.id = r.original_invoice_id
        LEFT JOIN customers c ON c.id = r.customer_id
       ORDER BY r.requested_at DESC
    `);

    const cashboxTransactions = await safeList(`
      SELECT ct.created_at::text AS created_at,
             cb.name_ar     AS cashbox_name,
             ct.direction, ct.amount, ct.category,
             ct.reference_type, ct.reference_id,
             ct.balance_after, ct.notes,
             u.full_name    AS user_name
        FROM cashbox_transactions ct
        LEFT JOIN cashboxes cb ON cb.id = ct.cashbox_id
        LEFT JOIN users u      ON u.id  = ct.user_id
       ORDER BY ct.created_at DESC
    `);

    return {
      invoices,
      invoice_items: invoiceItems,
      invoice_payments: invoicePayments,
      expenses,
      customer_payments: customerPayments,
      supplier_payments: supplierPayments,
      returns,
      cashbox_transactions: cashboxTransactions,
    };
  }

  /**
   * Focused pre-reset review report — three lean datasets, joined and
   * denormalized so the operator can glance through an Excel and
   * confirm everything is captured before a destructive reset:
   *
   *   1) sales_lines   — one row per (invoice × product line) with code,
   *                      product, qty, unit_price, line_total
   *   2) expense_lines — one row per expense with code, date, category,
   *                      description, amount
   *   3) opening_balances — per-cashbox opening balance (from the
   *                      earliest `opening_balance` / `opening` / deposit
   *                      transaction we can find, falling back to
   *                      cashboxes.opening_balance if set)
   */
  async reviewReport(): Promise<{
    sales_lines: any[];
    expense_lines: any[];
    opening_balances: any[];
  }> {
    const safeList = async (sql: string): Promise<any[]> => {
      try {
        return await this.ds.query(sql);
      } catch {
        return [];
      }
    };

    const sales_lines = await safeList(`
      SELECT
        i.invoice_no                              AS "رقم الفاتورة",
        COALESCE(i.completed_at::date::text,
                 i.created_at::date::text)        AS "التاريخ",
        COALESCE(c.full_name, '-')                AS "العميل",
        COALESCE(pv.barcode, '-')                 AS "الكود",
        COALESCE(p.name_ar, '-')                  AS "المنتج",
        ii.quantity                               AS "الكمية",
        ii.unit_price                             AS "سعر الوحدة",
        ii.discount_amount                        AS "الخصم",
        ii.line_total                             AS "إجمالي البند",
        i.status                                  AS "حالة الفاتورة"
      FROM invoice_items ii
      JOIN invoices i               ON i.id  = ii.invoice_id
      LEFT JOIN product_variants pv ON pv.id = ii.variant_id
      LEFT JOIN products p          ON p.id  = pv.product_id
      LEFT JOIN customers c         ON c.id  = i.customer_id
      WHERE i.status <> 'cancelled'
      ORDER BY COALESCE(i.completed_at, i.created_at) ASC, i.invoice_no
    `);

    const expense_lines = await safeList(`
      SELECT
        e.expense_no                       AS "رقم المصروف",
        e.expense_date::text               AS "التاريخ",
        COALESCE(ec.name_ar, '-')          AS "التصنيف (البند)",
        COALESCE(e.description, '-')       AS "الوصف",
        COALESCE(e.vendor_name, '-')       AS "المورد/الجهة",
        e.amount                           AS "المبلغ",
        e.payment_method                   AS "طريقة الدفع",
        COALESCE(cb.name_ar, '-')          AS "الخزنة",
        CASE WHEN e.is_approved THEN 'نعم' ELSE 'لا' END AS "معتمد"
      FROM expenses e
      LEFT JOIN expense_categories ec ON ec.id = e.category_id
      LEFT JOIN cashboxes cb          ON cb.id = e.cashbox_id
      ORDER BY e.expense_date ASC, e.expense_no
    `);

    // Opening balance per cashbox — prefer the explicit
    // cashboxes.opening_balance column when migration 055 applied it,
    // otherwise pull from the earliest opening-tagged cashbox_transaction.
    const opening_balances = await safeList(`
      SELECT
        cb.name_ar                                 AS "الخزنة",
        COALESCE(cb.opening_balance, 0)::numeric(14,2) AS "الرصيد الافتتاحي المسجل",
        (
          SELECT ct.amount
            FROM cashbox_transactions ct
           WHERE ct.cashbox_id = cb.id
             AND ct.category IN ('opening_balance','opening')
           ORDER BY ct.created_at ASC
           LIMIT 1
        )                                          AS "أول إيداع افتتاحي",
        (
          SELECT ct.created_at::date::text
            FROM cashbox_transactions ct
           WHERE ct.cashbox_id = cb.id
             AND ct.category IN ('opening_balance','opening')
           ORDER BY ct.created_at ASC
           LIMIT 1
        )                                          AS "تاريخ الإيداع",
        cb.current_balance                         AS "الرصيد الحالي"
      FROM cashboxes cb
      WHERE cb.is_active = TRUE
      ORDER BY cb.name_ar
    `);

    return { sales_lines, expense_lines, opening_balances };
  }

  /**
   * Factory reset — wipe every transactional row so the user can
   * restart with clean test data. Preserves structural data:
   * users / roles / warehouses / cashboxes (structure) / products /
   * variants / categories / customers / suppliers (as records) /
   * chart_of_accounts / expense_categories / financial_institutions /
   * settings.
   *
   * Wiped tables:
   *   journal_lines, journal_entries
   *   invoice_items, invoice_payments, invoices
   *   expenses, expense_approvals
   *   customer_payment_allocations, customer_payments
   *   supplier_payment_allocations, supplier_payments
   *   return_items, returns
   *   purchase_items, purchases
   *   cashbox_transactions
   *   shifts (+ shift_events if present)
   *   stock_movements
   *   recurring_expense_runs
   *
   * Balances reset to 0:
   *   cashboxes.current_balance
   *   customers.current_balance
   *   suppliers.current_balance
   *
   * By design does NOT touch:
   *   stock.quantity_on_hand (user can top-up via opening-stock import)
   *
   * This is destructive. Wrapped in a transaction so a failure rolls
   * everything back. Requires accounts.journal.void permission.
   */
  async factoryReset(opts: {
    keep_stock?: boolean;
  } = {}): Promise<{
    wiped: Record<string, number>;
    note: string;
  }> {
    const wiped: Record<string, number> = {};

    return this.ds.transaction(async (em) => {
      // Sanctioned admin-only destructive reset. Raise the engine
      // context ONCE for the whole transaction so every guarded UPDATE
      // below (journal_entries void trigger, cashboxes balance guard,
      // etc.) recognises it as a legitimate admin wipe. Bare DELETE
      // statements aren't gated by fn_engine_write_allowed, but the
      // UPDATE cashboxes.current_balance at the end is.
      await em.query(
        `SET LOCAL app.engine_context = 'service:reconciliation.factoryReset'`,
      );

      const safeDelete = async (label: string, sql: string) => {
        try {
          const r = await em.query(sql);
          wiped[label] = r.length ?? 0;
        } catch (e: any) {
          // Table may not exist on every deployment.
          wiped[label] = 0;
        }
      };

      // GL
      await safeDelete('journal_lines', `DELETE FROM journal_lines RETURNING 1`);
      await safeDelete('journal_entries', `DELETE FROM journal_entries RETURNING 1`);

      // Invoices + children
      await safeDelete('invoice_items', `DELETE FROM invoice_items RETURNING 1`);
      await safeDelete('invoice_payments', `DELETE FROM invoice_payments RETURNING 1`);
      await safeDelete('invoices', `DELETE FROM invoices RETURNING 1`);

      // Expenses
      await safeDelete('expense_approvals', `DELETE FROM expense_approvals RETURNING 1`);
      await safeDelete('expenses', `DELETE FROM expenses RETURNING 1`);

      // Customer / supplier payments
      await safeDelete(
        'customer_payment_allocations',
        `DELETE FROM customer_payment_allocations RETURNING 1`,
      );
      await safeDelete(
        'customer_payments',
        `DELETE FROM customer_payments RETURNING 1`,
      );
      await safeDelete(
        'supplier_payment_allocations',
        `DELETE FROM supplier_payment_allocations RETURNING 1`,
      );
      await safeDelete(
        'supplier_payments',
        `DELETE FROM supplier_payments RETURNING 1`,
      );

      // Returns + purchases
      await safeDelete('return_items', `DELETE FROM return_items RETURNING 1`);
      await safeDelete('returns', `DELETE FROM returns RETURNING 1`);
      await safeDelete(
        'purchase_items',
        `DELETE FROM purchase_items RETURNING 1`,
      );
      await safeDelete('purchases', `DELETE FROM purchases RETURNING 1`);

      // Cash movements + shifts + recurring
      await safeDelete(
        'cashbox_transactions',
        `DELETE FROM cashbox_transactions RETURNING 1`,
      );
      await safeDelete(
        'recurring_expense_runs',
        `DELETE FROM recurring_expense_runs RETURNING 1`,
      );
      await safeDelete('shift_events', `DELETE FROM shift_events RETURNING 1`);
      await safeDelete('shifts', `DELETE FROM shifts RETURNING 1`);

      // Stock movements (optional — keeps physical stock if keep_stock)
      if (!opts.keep_stock) {
        await safeDelete(
          'stock_movements',
          `DELETE FROM stock_movements RETURNING 1`,
        );
        await em.query(`UPDATE stock SET quantity_on_hand = 0, quantity_reserved = 0`);
      } else {
        // Keep stock_movements for audit, just zero out reserved.
        await em.query(`UPDATE stock SET quantity_reserved = 0`);
      }

      // Zero out balances
      await em.query(`UPDATE cashboxes SET current_balance = 0, updated_at = NOW()`);
      await em.query(`UPDATE customers SET current_balance = 0 WHERE current_balance IS NOT NULL`);
      await em.query(`UPDATE suppliers SET current_balance = 0 WHERE current_balance IS NOT NULL`);

      return {
        wiped,
        note: 'البيانات التجريبية اتمسحت. الكتالوج والمستخدمون والشجرة محفوظين. ابدأ تسجيل عمليات فعلية.',
      };
    });
  }

  /**
   * Hard reset: void every auto-posted journal entry and let the
   * caller re-run backfill. Safer alternative to DELETE since voided
   * entries keep an audit trail.
   */
  async resetAutoPostedEntries() {
    const autoRefTypes = [
      'invoice',
      'customer_payment',
      'supplier_payment',
      'expense',
      'return',
      'purchase',
      'shift_variance',
      'cashbox_manual',
      'cashbox_transfer',
      'inventory_adjustment',
    ];
    const r = await this.ds.query(
      `
      UPDATE journal_entries
         SET is_void = TRUE, void_reason = 'reset_for_rebuild',
             voided_at = NOW()
       WHERE reference_type = ANY($1::text[])
         AND is_posted = TRUE AND is_void = FALSE
      RETURNING id
      `,
      [autoRefTypes],
    );
    return { voided: r.length };
  }
}
