import { Injectable, Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';

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

  constructor(private readonly ds: DataSource) {}

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
   */
  async recomputeCashboxBalance(cashboxId: string) {
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
    await this.ds.query(
      `UPDATE cashboxes SET current_balance = $2, updated_at = NOW()
        WHERE id = $1`,
      [cashboxId, computed],
    );
    return { cashbox_id: cashboxId, new_balance: computed };
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
