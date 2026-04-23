import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { CostAccountResolver } from './cost-account-resolver.service';

/**
 * CostReconciliationService — daily (or on-demand) check that the
 * expense subsystem is internally consistent. READ-ONLY over the
 * financial tables. Writes only to `cost_reconciliation_reports`
 * (append-only log of recon runs).
 *
 * Runs 5 checks over a date window:
 *
 *   A. engine vs legacy split — how many of today's expenses went
 *      through `engine.recordExpense` vs any legacy path. After phase
 *      1 migrations this should be 100% engine; any drift is
 *      surfaced as `mismatch_amount`.
 *
 *   B. duplicate detection — same (category_id, amount, expense_date,
 *      cashbox_id) seen twice within an hour. The engine's
 *      idempotency guard on (reference_type, reference_id) already
 *      blocks exact re-posts; this catches "human double-submits"
 *      that create two distinct expense rows.
 *
 *   C. orphan detection — expense rows with `is_approved=TRUE` that
 *      have no matching live JE. Each such row is unposted revenue
 *      recognition that reports would miss.
 *
 *   D. posting drift — expense.amount ≠ journal_line.debit on the
 *      5xx leg. Would indicate a data corruption / manual edit.
 *
 *   E. category mapping coverage — any active expense_category
 *      missing its `account_id`. Migration 065 CHECK blocks this
 *      for new rows; this catch surfaces legacy drift.
 */
@Injectable()
export class CostReconciliationService {
  constructor(
    private readonly ds: DataSource,
    private readonly resolver: CostAccountResolver,
  ) {}

  /**
   * Run a reconciliation pass for `reportDate` (YYYY-MM-DD).
   * Defaults to today (Cairo tz).
   * Writes a new row to `cost_reconciliation_reports` and returns it.
   */
  async run(opts: { reportDate?: string; runType?: 'daily' | 'adhoc' | 'hourly' | 'backfill'; generatedBy?: string } = {}) {
    const reportDate = opts.reportDate ?? this.todayCairo();
    const runType = opts.runType ?? 'adhoc';

    // ── A. engine vs legacy split for expense JEs posted on reportDate ──
    const [split] = await this.ds.query(
      `SELECT
         COUNT(*)                                                   AS total_je,
         COUNT(*) FILTER (WHERE fes.is_engine)                     AS engine_je,
         COUNT(*) FILTER (WHERE fes.is_legacy)                     AS legacy_je,
         COALESCE(SUM(fes.amount) FILTER (WHERE fes.is_engine), 0)::numeric(14,2) AS engine_amount,
         COALESCE(SUM(fes.amount) FILTER (WHERE fes.is_legacy), 0)::numeric(14,2) AS legacy_amount
       FROM financial_event_stream fes
       JOIN journal_entries je ON je.id::text = ANY (
         SELECT je2.id::text FROM journal_entries je2
          WHERE je2.reference_type='expense'
            AND je2.is_posted AND NOT je2.is_void
            AND je2.entry_date = $1::date
       )
       WHERE fes.event_type = 'journal_entry'
         AND fes.reference_type = 'expense'`,
      [reportDate],
    );
    // Fallback when FES hasn't captured rows yet (migration 064 only
    // mirrors forward; pre-migration JEs show up as legacy).
    if (Number(split?.total_je || 0) === 0) {
      const [fallback] = await this.ds.query(
        `SELECT COUNT(*) AS total_je,
                0::int AS engine_je,
                COUNT(*)::int AS legacy_je,
                0::numeric(14,2) AS engine_amount,
                COALESCE(SUM(jl.debit), 0)::numeric(14,2) AS legacy_amount
           FROM journal_entries je
           JOIN journal_lines  jl ON jl.entry_id = je.id
           JOIN chart_of_accounts a ON a.id = jl.account_id
          WHERE je.reference_type='expense'
            AND je.is_posted AND NOT je.is_void
            AND je.entry_date = $1::date
            AND jl.debit > 0 AND a.account_type='expense'`,
        [reportDate],
      );
      if (fallback) Object.assign(split, fallback);
    }

    // ── B. duplicate detection (same category/amount/date/cashbox within 1h)
    const dups = await this.ds.query(
      `WITH buckets AS (
         SELECT category_id, amount, expense_date, cashbox_id,
                date_trunc('hour', created_at) AS bucket,
                COUNT(*) AS n, array_agg(id::text) AS ids
           FROM expenses
          WHERE expense_date = $1::date
          GROUP BY 1,2,3,4,5
         HAVING COUNT(*) > 1
       )
       SELECT * FROM buckets`,
      [reportDate],
    );
    const duplicateCount = dups.length;

    // ── C. orphan expenses (approved, no live JE)
    const [orphans] = await this.ds.query(
      `SELECT COUNT(*) AS n
         FROM expenses e
        WHERE e.expense_date = $1::date
          AND e.is_approved = TRUE
          AND NOT EXISTS (
            SELECT 1 FROM journal_entries je
             WHERE je.reference_type = 'expense'
               AND je.reference_id   = e.id
               AND je.is_posted AND NOT je.is_void
          )`,
      [reportDate],
    );

    // ── D. posting drift (amount vs debit)
    const driftRows = await this.ds.query(
      `SELECT e.id::text AS expense_id, e.expense_no, e.amount,
              COALESCE(posted.dr, 0) AS posted_amount,
              e.amount - COALESCE(posted.dr, 0) AS drift
         FROM expenses e
         LEFT JOIN LATERAL (
           SELECT SUM(jl.debit) AS dr
             FROM journal_entries je
             JOIN journal_lines  jl ON jl.entry_id = je.id
             JOIN chart_of_accounts a ON a.id = jl.account_id
            WHERE je.reference_type='expense'
              AND je.reference_id = e.id
              AND je.is_posted AND NOT je.is_void
              AND a.account_type='expense'
              AND jl.debit > 0
         ) posted ON TRUE
        WHERE e.expense_date = $1::date
          AND ABS(e.amount - COALESCE(posted.dr, 0)) > 0.01
          AND e.is_approved = TRUE`,
      [reportDate],
    );

    // ── E. unlinked active categories
    const [unlinked] = await this.ds.query(
      `SELECT COUNT(*) AS n
         FROM expense_categories
        WHERE is_active = TRUE AND account_id IS NULL`,
    );

    const mismatchAmount =
      Math.abs(Number(split?.engine_amount || 0) + Number(split?.legacy_amount || 0)
               - driftRows.reduce((s: number, r: any) => s + Number(r.posted_amount), 0));

    // Write the report row
    const [row] = await this.ds.query(
      `INSERT INTO cost_reconciliation_reports
         (report_date, run_type, total_expenses_count,
          total_expense_engine, total_expense_legacy,
          mismatch_amount, duplicate_detected_count,
          orphan_count, unlinked_category_count,
          generated_by, details)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)
       RETURNING *`,
      [
        reportDate,
        runType,
        Number(split?.total_je || 0),
        Number(split?.engine_amount || 0),
        Number(split?.legacy_amount || 0),
        Math.round(mismatchAmount * 100) / 100,
        duplicateCount,
        Number(orphans?.n || 0),
        Number(unlinked?.n || 0),
        opts.generatedBy ?? null,
        JSON.stringify({
          duplicate_buckets: dups,
          drift_rows: driftRows,
          mapping_snapshot: await this.resolver.listMappings(),
        }),
      ],
    );
    return row;
  }

  /** Last N reports, newest first. */
  listHistory(limit = 30) {
    const cap = Math.min(Math.max(Number(limit) || 30, 1), 365);
    return this.ds.query(
      `SELECT id, report_date, run_type, total_expenses_count,
              total_expense_engine, total_expense_legacy,
              mismatch_amount, duplicate_detected_count,
              orphan_count, unlinked_category_count,
              generated_by, created_at
         FROM cost_reconciliation_reports
        ORDER BY report_date DESC, id DESC
        LIMIT ${cap}`,
    );
  }

  /** One report with full `details`. */
  async get(id: number) {
    const [row] = await this.ds.query(
      `SELECT * FROM cost_reconciliation_reports WHERE id = $1`,
      [id],
    );
    return row ?? null;
  }

  /** Dashboard unified ledger read-through. */
  unifiedLedger(params: { from?: string; to?: string; limit?: number } = {}) {
    const where: string[] = [];
    const args: any[] = [];
    if (params.from) { args.push(params.from); where.push(`expense_date >= $${args.length}::date`); }
    if (params.to)   { args.push(params.to);   where.push(`expense_date <= $${args.length}::date`); }
    const cap = Math.min(Math.max(Number(params.limit) || 200, 1), 1000);
    return this.ds.query(
      `SELECT * FROM v_cost_unified_ledger
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY expense_date DESC, expense_no DESC
        LIMIT ${cap}`,
      args,
    );
  }

  private todayCairo(): string {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
  }
}
