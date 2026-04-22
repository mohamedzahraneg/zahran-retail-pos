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
    return this.ds.query(`
      SELECT
        cb.id, cb.name_ar, cb.kind, cb.currency, cb.is_active,
        cb.current_balance::numeric(14,2)  AS stored_balance,
        COALESCE((
          SELECT SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END)
            FROM cashbox_transactions WHERE cashbox_id = cb.id
        ), 0)::numeric(14,2) AS computed_balance,
        COALESCE((
          SELECT SUM(jl.debit - jl.credit)
            FROM journal_lines jl
            JOIN journal_entries je ON je.id = jl.entry_id
            JOIN chart_of_accounts a ON a.id = jl.account_id
           WHERE a.cashbox_id = cb.id
             AND je.is_posted = TRUE AND je.is_void = FALSE
        ), 0)::numeric(14,2) AS gl_balance,
        (SELECT a.id FROM chart_of_accounts a
          WHERE a.cashbox_id = cb.id AND a.is_active = TRUE LIMIT 1) AS gl_account_id,
        (SELECT a.code FROM chart_of_accounts a
          WHERE a.cashbox_id = cb.id AND a.is_active = TRUE LIMIT 1) AS gl_account_code
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
