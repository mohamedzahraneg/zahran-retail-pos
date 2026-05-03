/**
 * cashbox-gl-drift.helper.ts — PR-FIN-CASHBOX-DRIFT-CANCEL-AWARE-FIX
 * ─────────────────────────────────────────────────────────────────────
 * Cancel-aware report-side normalization for the cashbox GL-drift
 * surfaces (`v_cashbox_gl_drift` and `v_cashbox_drift_per_ref`).
 *
 * Why
 * ===
 * The canonical engine reversal (`posting.reverseByReference`) leaves
 * the database in a clean state but produces THREE rows in
 * `v_cashbox_drift_per_ref` per cancelled return — none of which the
 * view can merge by itself:
 *
 *   1. (return,  <return_id>)          — original refund CT, JE voided
 *      → ct=−amount,  je=0,         drift=−amount
 *   2. (other,   <orig JE id>)         — reversal CT (reference_type
 *                                       maps to 'other' via the engine's
 *                                       `mapToEntityType('reversal')`)
 *      → ct=+amount,  je=0,         drift=+amount
 *   3. (reversal,<orig JE id>)         — reversal JE
 *      → ct=0,        je=+amount,   drift=−amount
 *
 * Sum = −amount. Cashbox-level drift inherits the same total because
 * the view aggregates over per-line GL math (which excludes the voided
 * original JE) but the stored `current_balance` reflects every
 * non-void CT (which keeps both the original refund-out AND the
 * reversal-in).
 *
 * What this helper does
 * =====================
 *  • Identifies the (cashbox, reference_type, reference_id) keys that
 *    belong to a cancelled-return cluster (one DB round trip).
 *  • Exposes:
 *      • `clusterRefSet(cashboxId)` — an in-memory `Set<string>` so the
 *        per-ref detail endpoint can drop the cluster rows in O(1).
 *      • `clusterDriftOffsetByCashbox()` — a `Map<cashbox_id, number>`
 *        with the total drift contribution from each cashbox's
 *        cluster, so the cashbox-level endpoint can subtract it from
 *        the raw `drift_amount`.
 *
 * What this helper does NOT do
 * ============================
 *  • No DML. Pure SELECT. Same TB, same `cashboxes.current_balance`.
 *  • No engine / posting / reversal-convention change. The CT/JE rows
 *    stay exactly as `posting.reverseByReference` wrote them.
 *  • No backfill of `returns.cancellation_cashbox_transaction_id`.
 *  • No DELETE / UPDATE on `cashbox_transactions`, `journal_entries`,
 *    `journal_lines`, or any view definition.
 *
 * Future cancellations land naturally in the same cluster pattern, so
 * this helper continues to work without any per-cancellation wiring.
 */
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

@Injectable()
export class CashboxGlDriftHelper {
  constructor(private readonly ds: DataSource) {}

  /**
   * Returns a Set of `${reference_type}:${reference_id}` keys that
   * belong to cancelled-return clusters in the given cashbox. The
   * caller filters per-ref drift rows by this set in O(1) on the
   * application side — no DB round trip per row.
   */
  async clusterRefSet(cashboxId: string): Promise<Set<string>> {
    const rows = await this.ds.query(
      `
      WITH cancelled_returns AS (
        SELECT id::text AS return_id
          FROM returns
         WHERE status = 'cancelled'
           AND cashbox_id::text = $1
      ),
      cancelled_jes AS (
        -- The original return JE — even if it was voided by the engine
        -- during cancellation, its row in journal_entries still exists
        -- with reference_type='return' and reference_id pointing back
        -- at the return id.
        SELECT je.id::text AS je_id, cr.return_id
          FROM cancelled_returns cr
          JOIN journal_entries je
            ON je.reference_type = 'return'
           AND je.reference_id   = cr.return_id::uuid
      )
      SELECT 'return'::text AS rt, return_id AS rid FROM cancelled_returns
      UNION ALL
      SELECT 'other'::text,    je_id FROM cancelled_jes
      UNION ALL
      SELECT 'reversal'::text, je_id FROM cancelled_jes
      `,
      [cashboxId],
    );
    return new Set(rows.map((r: any) => `${r.rt}:${r.rid}`));
  }

  /**
   * Returns a Map keyed by cashbox_id with the total drift_amount
   * contribution from cancelled-return clusters in that cashbox. The
   * cashbox-level GL-drift endpoint subtracts this offset from the
   * raw `drift_amount` so the operator sees the operationally
   * correct drift (the cancelled cluster always nets to zero in
   * reality — only the legacy per-ref grouping shows phantom drift).
   *
   * One round trip; processes every cashbox at once.
   */
  async clusterDriftOffsetByCashbox(): Promise<Map<string, number>> {
    const rows = await this.ds.query(
      `
      WITH cancelled_returns AS (
        SELECT id::text AS return_id, cashbox_id::text AS cashbox_id
          FROM returns
         WHERE status = 'cancelled'
           AND cashbox_id IS NOT NULL
      ),
      cancelled_jes AS (
        SELECT je.id::text AS je_id, cr.return_id, cr.cashbox_id
          FROM cancelled_returns cr
          JOIN journal_entries je
            ON je.reference_type = 'return'
           AND je.reference_id   = cr.return_id::uuid
      ),
      cluster_refs AS (
        SELECT cashbox_id, 'return'::text   AS reference_type, return_id::uuid AS reference_id
          FROM cancelled_returns
        UNION ALL
        SELECT cashbox_id, 'other'::text,    je_id::uuid FROM cancelled_jes
        UNION ALL
        SELECT cashbox_id, 'reversal'::text, je_id::uuid FROM cancelled_jes
      )
      SELECT pr.cashbox_id::text AS cashbox_id,
             COALESCE(SUM(pr.drift_amount), 0)::text AS offset
        FROM v_cashbox_drift_per_ref pr
        JOIN cluster_refs cr
          ON cr.cashbox_id    = pr.cashbox_id::text
         AND cr.reference_type::text = pr.reference_type::text
         AND cr.reference_id  = pr.reference_id
       GROUP BY pr.cashbox_id
      `,
    );
    return new Map(rows.map((r: any) => [r.cashbox_id, Number(r.offset)]));
  }

  /**
   * PR-FIN-DASHBOARD-DRIFT-CANCEL-AWARE — global aggregate of
   * phantom drift rows from cancelled-return clusters across ALL
   * cashboxes. Used by `FinanceDashboardService.health()` to
   * subtract these from the raw `cashbox_drift_count` and
   * `cashbox_drift_total` so the financial-health card doesn't
   * surface phantom drift the operational treasury page already
   * normalises away.
   *
   * Returns:
   *   • `rows`     — total count of v_cashbox_drift_per_ref rows
   *                  that fall inside a cancelled-return cluster.
   *                  This is what the dashboard subtracts from the
   *                  raw `drift_count`.
   *   • `absTotal` — Σ |drift_amount| of those phantom rows. This
   *                  is what the dashboard subtracts from the raw
   *                  `cashbox_drift_total` (the operator-facing
   *                  card's "إجمالي الفروق" figure).
   *
   * Important: we sum |drift_amount|, not signed drift_amount.
   * The cluster nets to zero in signed terms (that's why the
   * existing `clusterDriftOffsetByCashbox()` returns 0 per
   * cluster), but each individual row contributes a non-zero
   * absolute amount to the dashboard's "total" KPI.
   *
   * One round trip; pure SELECT — no DML.
   */
  async clusterPhantomGlobalStats(): Promise<{ rows: number; absTotal: number }> {
    const result = await this.ds.query(
      `
      WITH cancelled_returns AS (
        SELECT id::text AS return_id, cashbox_id::text AS cashbox_id
          FROM returns
         WHERE status = 'cancelled'
           AND cashbox_id IS NOT NULL
      ),
      cancelled_jes AS (
        SELECT je.id::text AS je_id, cr.return_id, cr.cashbox_id
          FROM cancelled_returns cr
          JOIN journal_entries je
            ON je.reference_type = 'return'
           AND je.reference_id   = cr.return_id::uuid
      ),
      cluster_refs AS (
        SELECT cashbox_id, 'return'::text   AS reference_type, return_id::uuid AS reference_id
          FROM cancelled_returns
        UNION ALL
        SELECT cashbox_id, 'other'::text,    je_id::uuid FROM cancelled_jes
        UNION ALL
        SELECT cashbox_id, 'reversal'::text, je_id::uuid FROM cancelled_jes
      )
      SELECT
        COUNT(*)::int                                       AS rows,
        COALESCE(SUM(ABS(pr.drift_amount)), 0)::numeric(14,2) AS abs_total
        FROM v_cashbox_drift_per_ref pr
        JOIN cluster_refs cr
          ON cr.cashbox_id    = pr.cashbox_id::text
         AND cr.reference_type::text = pr.reference_type::text
         AND cr.reference_id  = pr.reference_id
       WHERE pr.drift_amount <> 0
      `,
    );
    const r = result[0] ?? { rows: 0, abs_total: '0' };
    return { rows: Number(r.rows ?? 0), absTotal: Number(r.abs_total ?? 0) };
  }
}
