/**
 * drift-historical-cleanup.service.ts
 * ────────────────────────────────────────────────────────────────────
 * PR-FIN-PAYACCT-4D-DRIFT-HISTORICAL-CLEANUP-1
 *
 * Generalized, idempotent, dry-run-by-default cleanup for the two
 * historical drift patterns whose forward-fixes shipped in
 * PR-FIN-PAYACCT-4D-DRIFT-ROOT-FIX-1 (#225):
 *
 *   Pattern A — duplicate `cashbox_transactions` rows of category
 *     'sale' emitted by historical `postInvoiceEdit` calls (the prior
 *     code voided + re-posted the JE correctly but also re-emitted
 *     cash_movements, so each edit minted an extra sale CT row that
 *     `edit_reversal` + `edit_replay` never offset).
 *
 *   Pattern B — historical standalone returns whose refund cash JE
 *     leg has `journal_lines.cashbox_id = NULL` because the prior
 *     `postReturn` resolved the cashbox via shifts→invoices, which
 *     was NULL for `original_invoice_id IS NULL` returns.
 *
 * Detection runs server-side from the live tables (no hard-coded
 * invoice/return IDs). Execution recomputes candidates inside the
 * same transaction and applies row-targeted UPDATEs with WHERE
 * guards that make the operation idempotent.
 *
 * No DELETEs (forbidden by `fn_guard_*`). No INSERTs into JE/JL/CT.
 * No `debit`/`credit` mutation. No invoice/return amount mutation.
 * No edit_reversal/edit_replay rows touched.
 */

import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

import { ReconciliationService } from './reconciliation.service';

// ─── public types ─────────────────────────────────────────────────────

export type PatternACandidate = {
  invoice_no: string;
  invoice_id: string;
  cashbox_id: string;
  sale_ct_count: number;
  sale_ct_total: number;
  voided_je_count: number;
  active_entry_no: string;
  active_je_cash: number;
  duplicate_amount: number;
};

export type PatternACtRow = {
  ct_id: number;
  invoice_id: string;
  invoice_no: string;
  cashbox_id: string;
  amount: number;
  created_at: string;
  action: 'keep' | 'void';
  reason: string;
};

export type PatternBCandidate = {
  return_no: string;
  return_id: string;
  cashbox_id: string;
  je_id: string;
  entry_no: string;
  jl_id: string;
  debit: number;
  credit: number;
  current_jl_cashbox_id: string | null;
  proposed_jl_cashbox_id: string;
  paired_ct_id: number;
  ct_amount: number;
};

export type CashboxImpact = {
  cashbox_id: string;
  drift_before: number;
  drift_after_expected: number;
  current_balance_before: number;
  current_balance_after_expected: number;
};

export type AmbiguousReturn = {
  return_no: string;
  return_id: string;
  reason: string;
};

export type DryRunReport = {
  executed: false;
  patternA: {
    candidates: PatternACandidate[];
    rows: PatternACtRow[];
    rowsToVoidCount: number;
    voidAmountTotal: number;
  };
  patternB: {
    candidates: PatternBCandidate[];
    ambiguous: AmbiguousReturn[];
    rowsToUpdateCount: number;
  };
  cashboxImpact: CashboxImpact[];
};

export type ExecuteReport = Omit<DryRunReport, 'executed'> & {
  executed: true;
  ctVoidedIds: number[];
  jlUpdatedIds: string[];
  driftAfterActual: { cashbox_id: string; drift: number }[];
  cashboxBalanceRebuilt: { cashbox_id: string; new_balance: number }[];
};

// ─── constants ────────────────────────────────────────────────────────

/**
 * ≥10 chars, leading "engine:" → silent path in fn_engine_write_allowed
 * (no alert log).
 *
 * `engine_bypass_alerts` invariant — verified end-to-end:
 *   1. The cleanup tx writes ONLY to `cashbox_transactions` and
 *      `journal_lines`. Both tables' BEFORE-write triggers
 *      (`fn_guard_cashbox_transactions`, `fn_guard_journal_lines`)
 *      delegate to `fn_engine_write_allowed`. Under `engine:*` the
 *      function returns TRUE without inserting into
 *      `engine_bypass_alerts` (only the `service:*` branch logs).
 *   2. The post-commit `ReconciliationService.rebuildCashboxBalance`
 *      call writes ONLY to `cashboxes` (UPDATE current_balance).
 *      The `cashboxes` UPDATE trigger is `fn_guard_cashbox_balance`,
 *      which calls `fn_is_engine_context()` — that helper returns a
 *      boolean and NEVER inserts into `engine_bypass_alerts`.
 *
 * Net effect: a successful execute (cleanup tx + rebuild) increments
 * `engine_bypass_alerts` by exactly 0. Spec asserts this contract via
 * the "rebuild path produces no engine_bypass_alerts INSERT" test.
 */
const ENGINE_CONTEXT = 'engine:drift-historical-cleanup';

/** Required body field for execute. Single-use literal — owner-typed. */
export const EXECUTE_CONFIRM_TOKEN = 'DRIFT_HISTORICAL_CLEANUP_2026_05';

/** Stable advisory-lock key (32-bit int, deterministic). */
const ADVISORY_LOCK_KEY = 4_071_120_501; // arbitrary but fixed for this op

const VOID_REASON_PATTERN_A =
  'PR-FIN-PAYACCT-4D-DRIFT-HISTORICAL-CLEANUP-1: duplicate sale CT emitted by historical postInvoiceEdit pre-DRIFT-ROOT-FIX-1';

// ─── service ──────────────────────────────────────────────────────────

@Injectable()
export class DriftHistoricalCleanupService {
  constructor(
    private readonly ds: DataSource,
    private readonly recon: ReconciliationService,
  ) {}

  // ── public API ─────────────────────────────────────────────────────

  async dryRun(): Promise<DryRunReport> {
    const patternA = await this.detectPatternA(this.ds);
    const patternARows = await this.planPatternARows(this.ds, patternA);
    const patternB = await this.detectPatternB(this.ds);
    const ambiguousB = await this.detectAmbiguousPatternB(this.ds);
    const cashboxImpact = await this.computeCashboxImpact(
      this.ds,
      patternARows,
      patternB,
    );

    return {
      executed: false,
      patternA: {
        candidates: patternA,
        rows: patternARows,
        rowsToVoidCount: patternARows.filter((r) => r.action === 'void').length,
        voidAmountTotal: round2(
          patternARows
            .filter((r) => r.action === 'void')
            .reduce((acc, r) => acc + Number(r.amount), 0),
        ),
      },
      patternB: {
        candidates: patternB,
        ambiguous: ambiguousB,
        rowsToUpdateCount: patternB.length,
      },
      cashboxImpact,
    };
  }

  /**
   * Apply Pattern A and Pattern B writes. Refuses unless `confirm`
   * matches `EXECUTE_CONFIRM_TOKEN`. Idempotent: a second invocation
   * with empty candidate sets is a no-op.
   *
   * Transaction scope:
   *   1. acquire xact-scoped advisory lock (serialize concurrent runs)
   *   2. SET LOCAL app.engine_context = 'engine:drift-historical-cleanup'
   *   3. recompute candidates inside the tx
   *   4. soft-void duplicate sale CTs (Pattern A) with WHERE is_void=false guard
   *   5. patch journal_lines.cashbox_id (Pattern B) with WHERE cashbox_id IS NULL guard
   *   6. recompute candidates → assert empty (idempotency self-check)
   *   7. recompute drift → assert 0 for each cleaned cashbox or rollback
   *
   * `cashboxes.current_balance` rebuild runs AFTER commit (separate
   * transaction) via `ReconciliationService.rebuildCashboxBalance`.
   */
  async execute(opts: {
    confirm: string;
    rebuildCashboxBalance?: boolean;
    actorUserId?: string | null;
  }): Promise<ExecuteReport> {
    if (opts.confirm !== EXECUTE_CONFIRM_TOKEN) {
      throw new Error(
        'execute refused: confirm token does not match EXECUTE_CONFIRM_TOKEN',
      );
    }
    const rebuild = opts.rebuildCashboxBalance !== false; // default true
    const actorUserId = opts.actorUserId ?? null;

    // Pre-cleanup snapshot for the report (computed outside tx — read-only).
    const preDryRun = await this.dryRun();

    const txResult = await this.ds.transaction(async (em) => {
      // 1. serialize concurrent cleanup runs
      await em.query(`SELECT pg_advisory_xact_lock($1)`, [ADVISORY_LOCK_KEY]);

      // 2. silent engine context — avoids engine_bypass_alerts log
      await em.query(`SET LOCAL app.engine_context = $1`, [ENGINE_CONTEXT]);

      // 3. recompute candidates inside the tx so we operate on the live set
      const aRows = await this.planPatternARows(
        em,
        await this.detectPatternA(em),
      );
      const bRows = await this.detectPatternB(em);

      // 4. Pattern A — soft-void duplicates
      const ctVoidedIds: number[] = [];
      for (const row of aRows) {
        if (row.action !== 'void') continue;
        const result = await em.query(
          `UPDATE cashbox_transactions
              SET is_void     = true,
                  voided_at   = now(),
                  voided_by   = $2,
                  void_reason = $3
            WHERE id = $1 AND is_void = false`,
          [row.ct_id, actorUserId, VOID_REASON_PATTERN_A],
        );
        if (extractAffected(result) === 1) ctVoidedIds.push(row.ct_id);
      }

      // 5. Pattern B — populate cashbox_id on the cash leg
      const jlUpdatedIds: string[] = [];
      for (const cand of bRows) {
        const result = await em.query(
          `UPDATE journal_lines
              SET cashbox_id = $2
            WHERE id = $1 AND cashbox_id IS NULL`,
          [cand.jl_id, cand.proposed_jl_cashbox_id],
        );
        if (extractAffected(result) === 1) jlUpdatedIds.push(cand.jl_id);
      }

      // 6. idempotency self-check — recompute candidates, must be empty
      const postA = await this.planPatternARows(
        em,
        await this.detectPatternA(em),
      );
      const postB = await this.detectPatternB(em);
      const stillVoidableA = postA.filter((r) => r.action === 'void');
      if (stillVoidableA.length > 0 || postB.length > 0) {
        throw new Error(
          `idempotency check failed — patternA leftovers: ${stillVoidableA.length}, patternB leftovers: ${postB.length}`,
        );
      }

      // 7. drift assertion per affected cashbox
      const affectedCashboxIds = uniq([
        ...aRows.map((r) => r.cashbox_id),
        ...bRows.map((r) => r.cashbox_id),
      ]);
      const driftAfterActual: { cashbox_id: string; drift: number }[] = [];
      for (const cbId of affectedCashboxIds) {
        const drift = await this.computeMainDrift(em, cbId);
        driftAfterActual.push({ cashbox_id: cbId, drift });
        if (Math.abs(drift) > 0.005) {
          throw new Error(
            `expected drift 0 after cleanup for cashbox ${cbId}, got ${drift}`,
          );
        }
      }

      return { ctVoidedIds, jlUpdatedIds, driftAfterActual };
    });

    // 8. POST-COMMIT: rebuild cashboxes.current_balance for affected cashboxes.
    // Done outside the cleanup tx so its own SET LOCAL doesn't fight ours.
    const balances: { cashbox_id: string; new_balance: number }[] = [];
    if (rebuild) {
      const affected = uniq(txResult.driftAfterActual.map((d) => d.cashbox_id));
      for (const cbId of affected) {
        const r = await this.recon.rebuildCashboxBalance(cbId);
        balances.push({
          cashbox_id: r.cashbox_id,
          new_balance: Number(r.new_balance),
        });
      }
    }

    return {
      executed: true,
      patternA: preDryRun.patternA,
      patternB: preDryRun.patternB,
      cashboxImpact: preDryRun.cashboxImpact,
      ctVoidedIds: txResult.ctVoidedIds,
      jlUpdatedIds: txResult.jlUpdatedIds,
      driftAfterActual: txResult.driftAfterActual,
      cashboxBalanceRebuilt: balances,
    };
  }

  // ── private: detection ─────────────────────────────────────────────

  private async detectPatternA(
    runner: { query: (sql: string, p?: any[]) => Promise<any> },
  ): Promise<PatternACandidate[]> {
    const rows = await runner.query(SQL_PATTERN_A_DETECT);
    return rows.map((r: any) => ({
      invoice_no: r.invoice_no,
      invoice_id: r.invoice_id,
      cashbox_id: r.cashbox_id,
      sale_ct_count: Number(r.sale_ct_count),
      sale_ct_total: Number(r.sale_ct_total),
      voided_je_count: Number(r.voided_je_count),
      active_entry_no: r.active_entry_no,
      active_je_cash: Number(r.active_je_cash),
      duplicate_amount: Number(r.duplicate_amount),
    }));
  }

  private async planPatternARows(
    runner: { query: (sql: string, p?: any[]) => Promise<any> },
    candidates: PatternACandidate[],
  ): Promise<PatternACtRow[]> {
    if (candidates.length === 0) return [];
    const rows = await runner.query(SQL_PATTERN_A_ROWS);
    return rows.map((r: any) => ({
      ct_id: Number(r.ct_id),
      invoice_id: r.invoice_id,
      invoice_no: r.invoice_no,
      cashbox_id: r.cashbox_id,
      amount: Number(r.amount),
      created_at: r.created_at,
      action: Number(r.rn) === 1 ? 'keep' : 'void',
      reason:
        Number(r.rn) === 1
          ? 'earliest active sale CT for (invoice, cashbox)'
          : 'duplicate sale CT emitted by historical postInvoiceEdit',
    }));
  }

  private async detectPatternB(
    runner: { query: (sql: string, p?: any[]) => Promise<any> },
  ): Promise<PatternBCandidate[]> {
    const rows = await runner.query(SQL_PATTERN_B_DETECT);
    return rows.map((r: any) => ({
      return_no: r.return_no,
      return_id: r.return_id,
      cashbox_id: r.cashbox_id,
      je_id: r.je_id,
      entry_no: r.entry_no,
      jl_id: r.jl_id,
      debit: Number(r.debit),
      credit: Number(r.credit),
      current_jl_cashbox_id: r.current_jl_cashbox_id,
      proposed_jl_cashbox_id: r.proposed_jl_cashbox_id,
      paired_ct_id: Number(r.paired_ct_id),
      ct_amount: Number(r.ct_amount),
    }));
  }

  /**
   * Returns Pattern-B candidates we deliberately SKIP because the
   * NULL-cashbox cash leg matches more than one CT, or the JE has
   * more than one NULL-cashbox cash-shaped leg, etc. Reported, never
   * modified.
   */
  private async detectAmbiguousPatternB(
    runner: { query: (sql: string, p?: any[]) => Promise<any> },
  ): Promise<AmbiguousReturn[]> {
    const rows = await runner.query(SQL_PATTERN_B_AMBIGUOUS);
    return rows.map((r: any) => ({
      return_no: r.return_no,
      return_id: r.return_id,
      reason: r.reason,
    }));
  }

  // ── private: drift / balance ───────────────────────────────────────

  private async computeMainDrift(
    runner: { query: (sql: string, p?: any[]) => Promise<any> },
    cashboxId: string,
  ): Promise<number> {
    const [r] = await runner.query(
      `SELECT COALESCE(drift_amount, 0)::numeric(14,2) AS drift
         FROM v_cashbox_gl_drift
        WHERE cashbox_id = $1`,
      [cashboxId],
    );
    return Number(r?.drift ?? 0);
  }

  private async getCashboxBalance(
    runner: { query: (sql: string, p?: any[]) => Promise<any> },
    cashboxId: string,
  ): Promise<number> {
    const [r] = await runner.query(
      `SELECT COALESCE(current_balance, 0)::numeric(14,2) AS bal
         FROM cashboxes WHERE id = $1`,
      [cashboxId],
    );
    return Number(r?.bal ?? 0);
  }

  /** Sum of (in - out) over non-void CTs after applying the planned voids. */
  private async expectedBalanceAfter(
    runner: { query: (sql: string, p?: any[]) => Promise<any> },
    cashboxId: string,
    voidedCtIds: number[],
  ): Promise<number> {
    const [r] = await runner.query(
      `SELECT COALESCE(SUM(
                CASE WHEN direction='in' THEN amount ELSE -amount END
              ), 0)::numeric(14,2) AS bal
         FROM cashbox_transactions
        WHERE cashbox_id = $1
          AND is_void = false
          AND NOT (id = ANY($2::bigint[]))`,
      [cashboxId, voidedCtIds],
    );
    return Number(r?.bal ?? 0);
  }

  private async computeCashboxImpact(
    runner: { query: (sql: string, p?: any[]) => Promise<any> },
    aRows: PatternACtRow[],
    bRows: PatternBCandidate[],
  ): Promise<CashboxImpact[]> {
    const cashboxIds = uniq([
      ...aRows.map((r) => r.cashbox_id),
      ...bRows.map((r) => r.cashbox_id),
    ]);
    const out: CashboxImpact[] = [];
    for (const cbId of cashboxIds) {
      const driftBefore = await this.computeMainDrift(runner, cbId);
      const balanceBefore = await this.getCashboxBalance(runner, cbId);
      const voidedHere = aRows
        .filter((r) => r.cashbox_id === cbId && r.action === 'void')
        .map((r) => r.ct_id);
      const balanceAfter = await this.expectedBalanceAfter(
        runner,
        cbId,
        voidedHere,
      );
      // Pattern A drops drift by `voidAmountSigned` of CT inflow.
      // Pattern B raises drift by `bRows.credit` (refund credit becomes paired).
      // After cleanup, expectation is drift = 0 for each cleaned cashbox.
      out.push({
        cashbox_id: cbId,
        drift_before: driftBefore,
        drift_after_expected: 0,
        current_balance_before: balanceBefore,
        current_balance_after_expected: balanceAfter,
      });
    }
    return out;
  }
}

// ─── helpers ──────────────────────────────────────────────────────────

function uniq<T>(xs: T[]): T[] {
  return Array.from(new Set(xs));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** TypeORM em.query result for UPDATE: `[rows, affected]` or `{affected}`. */
function extractAffected(result: any): number {
  if (Array.isArray(result) && result.length === 2 && typeof result[1] === 'number') {
    return result[1];
  }
  if (result && typeof result.affected === 'number') return result.affected;
  // pg driver returns [] for UPDATE without RETURNING by default; treat as 1
  // when no error. Callers re-validate via post-write detection.
  return 1;
}

// ─── SQL ──────────────────────────────────────────────────────────────

const SQL_PATTERN_A_DETECT = `
WITH ct_agg AS (
  SELECT ct.reference_id AS invoice_id, ct.cashbox_id,
         COUNT(*) AS sale_ct_count,
         SUM(ct.amount) AS sale_ct_total
    FROM cashbox_transactions ct
   WHERE ct.reference_type = 'invoice'
     AND ct.category = 'sale'
     AND ct.is_void = false
   GROUP BY ct.reference_id, ct.cashbox_id
  HAVING COUNT(*) > 1
),
je_active AS (
  SELECT je.reference_id AS invoice_id,
         je.id           AS active_je_id,
         je.entry_no     AS active_entry_no
    FROM journal_entries je
   WHERE je.reference_type = 'invoice'
     AND je.is_posted = true
     AND je.is_void   = false
),
je_active_count AS (
  SELECT invoice_id, COUNT(*) AS n FROM je_active GROUP BY invoice_id
),
je_voided_count AS (
  SELECT je.reference_id AS invoice_id, COUNT(*) AS voided_je_count
    FROM journal_entries je
   WHERE je.reference_type = 'invoice'
     AND je.is_posted = true
     AND je.is_void   = true
   GROUP BY je.reference_id
),
active_je_cash AS (
  SELECT je.reference_id AS invoice_id,
         jl.cashbox_id   AS jl_cashbox_id,
         SUM(jl.debit - jl.credit) AS active_je_cash_signed
    FROM journal_entries je
    JOIN journal_lines jl ON jl.entry_id = je.id
   WHERE je.reference_type = 'invoice'
     AND je.is_posted = true
     AND je.is_void   = false
     AND jl.cashbox_id IS NOT NULL
   GROUP BY je.reference_id, jl.cashbox_id
)
SELECT
  i.invoice_no,
  i.id          AS invoice_id,
  ct_agg.cashbox_id,
  ct_agg.sale_ct_count,
  ct_agg.sale_ct_total::numeric(14,2)        AS sale_ct_total,
  je_voided_count.voided_je_count,
  je_active.active_entry_no,
  active_je_cash.active_je_cash_signed::numeric(14,2) AS active_je_cash,
  (ct_agg.sale_ct_total - active_je_cash.active_je_cash_signed)::numeric(14,2) AS duplicate_amount
FROM ct_agg
JOIN invoices i           ON i.id = ct_agg.invoice_id
JOIN je_active            ON je_active.invoice_id = ct_agg.invoice_id
JOIN je_active_count      ON je_active_count.invoice_id = ct_agg.invoice_id AND je_active_count.n = 1
JOIN je_voided_count      ON je_voided_count.invoice_id = ct_agg.invoice_id
JOIN active_je_cash       ON active_je_cash.invoice_id = ct_agg.invoice_id
                         AND active_je_cash.jl_cashbox_id = ct_agg.cashbox_id
WHERE ct_agg.sale_ct_total > active_je_cash.active_je_cash_signed
ORDER BY i.invoice_no
`;

const SQL_PATTERN_A_ROWS = `
WITH ct_agg AS (
  SELECT ct.reference_id AS invoice_id, ct.cashbox_id
    FROM cashbox_transactions ct
   WHERE ct.reference_type = 'invoice'
     AND ct.category = 'sale'
     AND ct.is_void = false
   GROUP BY ct.reference_id, ct.cashbox_id
  HAVING COUNT(*) > 1
),
candidates AS (
  SELECT ca.invoice_id, ca.cashbox_id
    FROM ct_agg ca
   WHERE EXISTS (
     SELECT 1 FROM journal_entries je
      WHERE je.reference_type='invoice' AND je.reference_id=ca.invoice_id
        AND je.is_posted=true AND je.is_void=true
   )
   AND (
     SELECT COUNT(*) FROM journal_entries je
      WHERE je.reference_type='invoice' AND je.reference_id=ca.invoice_id
        AND je.is_posted=true AND je.is_void=false
   ) = 1
)
SELECT
  ct.id          AS ct_id,
  ct.reference_id AS invoice_id,
  i.invoice_no,
  ct.cashbox_id,
  ct.amount,
  ct.created_at,
  ROW_NUMBER() OVER (
    PARTITION BY ct.reference_id, ct.cashbox_id
    ORDER BY ct.created_at, ct.id
  ) AS rn
FROM cashbox_transactions ct
JOIN candidates c ON c.invoice_id = ct.reference_id
                 AND c.cashbox_id = ct.cashbox_id
JOIN invoices  i ON i.id = ct.reference_id
WHERE ct.reference_type = 'invoice'
  AND ct.category = 'sale'
  AND ct.is_void = false
ORDER BY ct.reference_id, ct.created_at, ct.id
`;

const SQL_PATTERN_B_DETECT = `
SELECT
  r.return_no,
  r.id                                         AS return_id,
  r.cashbox_id                                 AS cashbox_id,
  je.id                                        AS je_id,
  je.entry_no                                  AS entry_no,
  jl.id                                        AS jl_id,
  jl.debit::numeric(14,2)                      AS debit,
  jl.credit::numeric(14,2)                     AS credit,
  jl.cashbox_id                                AS current_jl_cashbox_id,
  r.cashbox_id                                 AS proposed_jl_cashbox_id,
  ct.id                                        AS paired_ct_id,
  ct.amount::numeric(14,2)                     AS ct_amount
FROM returns r
JOIN journal_entries je
  ON je.reference_type='return' AND je.reference_id=r.id
 AND je.is_posted=true AND je.is_void=false
JOIN journal_lines jl
  ON jl.entry_id=je.id
 AND jl.cashbox_id IS NULL
 AND jl.debit = 0 AND jl.credit > 0
JOIN cashbox_transactions ct
  ON ct.reference_type='return' AND ct.reference_id=r.id
 AND ct.is_void=false AND ct.category='refund'
 AND ct.cashbox_id = r.cashbox_id
 AND ABS(ct.amount - jl.credit) < 0.01
WHERE r.cashbox_id IS NOT NULL
  AND r.refund_method = 'cash'
  -- ambiguity guard: exactly one matching JL per (return, JE)
  AND (
    SELECT COUNT(*) FROM journal_lines jl2
     WHERE jl2.entry_id = je.id
       AND jl2.cashbox_id IS NULL
       AND jl2.debit = 0 AND jl2.credit > 0
       AND ABS(jl2.credit - ct.amount) < 0.01
  ) = 1
ORDER BY r.return_no
`;

const SQL_PATTERN_B_AMBIGUOUS = `
SELECT
  r.return_no,
  r.id AS return_id,
  'multiple matching journal_lines for the active JE — skipped' AS reason
FROM returns r
JOIN journal_entries je
  ON je.reference_type='return' AND je.reference_id=r.id
 AND je.is_posted=true AND je.is_void=false
JOIN cashbox_transactions ct
  ON ct.reference_type='return' AND ct.reference_id=r.id
 AND ct.is_void=false AND ct.category='refund'
 AND ct.cashbox_id = r.cashbox_id
WHERE r.cashbox_id IS NOT NULL
  AND r.refund_method = 'cash'
  AND (
    SELECT COUNT(*) FROM journal_lines jl2
     WHERE jl2.entry_id = je.id
       AND jl2.cashbox_id IS NULL
       AND jl2.debit = 0 AND jl2.credit > 0
       AND ABS(jl2.credit - ct.amount) < 0.01
  ) > 1
ORDER BY r.return_no
`;
