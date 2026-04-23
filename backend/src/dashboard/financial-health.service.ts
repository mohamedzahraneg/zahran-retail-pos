import { BadRequestException, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';

/**
 * Real-time Financial Control Tower — read-only observability over the
 * accounting pipeline. Never writes to any financial table. The only
 * mutations are:
 *   * INSERT into `financial_anomalies` during scan() (new detections)
 *   * UPDATE `financial_anomalies.resolved` when an operator clears one
 *
 * Data sources:
 *   * `v_financial_health_snapshot` — aggregate rollup (24h + 7d)
 *   * `financial_event_stream`       — per-write mirror populated by
 *                                      migration 064's AFTER INSERT triggers
 *   * `engine_bypass_alerts`         — per-legacy-write alert from migration 063
 *   * Live queries against journal_entries / journal_lines /
 *     cashboxes / shifts for integrity & drift checks
 */
@Injectable()
export class FinancialHealthService {
  constructor(private readonly ds: DataSource) {}

  // ─── Scoring model ──────────────────────────────────────────────────
  /**
   *   score = 100
   *         − (legacy_bypass_rate * 40)      0–40 penalty
   *         − (drift_score * 30)             0–30 penalty
   *         − (anomaly_score * 20)           0–20 penalty
   *         − (unbalanced_journal_penalty*10) 0–10 penalty
   * Clamped 0–100. Classification:
   *   90–100 EXCELLENT, 75–89 GOOD, 50–74 WARNING, <50 CRITICAL
   */
  private classify(score: number): 'EXCELLENT' | 'GOOD' | 'WARNING' | 'CRITICAL' {
    if (score >= 90) return 'EXCELLENT';
    if (score >= 75) return 'GOOD';
    if (score >= 50) return 'WARNING';
    return 'CRITICAL';
  }

  async health() {
    const [s] = await this.ds.query(
      `SELECT * FROM v_financial_health_snapshot`,
    );

    const legacyRate = Number(s?.legacy_rate_24h || 0); // 0..1
    const drift = Number(s?.total_cashbox_drift || 0);
    const unbalanced = Number(s?.unbalanced_entries_24h || 0);
    const criticalAnom = Number(s?.critical_anomalies || 0);
    const highAnom = Number(s?.high_anomalies || 0);
    const openAnom = Number(s?.open_anomalies || 0);
    const total24h = Number(s?.total_events_24h || 0);
    const bypassAlerts24h = Number(s?.bypass_alerts_24h || 0);

    // Normalise each sub-score to [0,1] then weight.
    const legacyPenalty = Math.min(1, legacyRate) * 40;
    //   drift > 100 EGP is already alarming; saturate at 1000
    const driftScore = Math.min(1, drift / 1000);
    const driftPenalty = driftScore * 30;
    //   anomalies: critical counts 4×, high 2×, others 1×
    const anomScoreRaw = criticalAnom * 4 + highAnom * 2 + Math.max(0, openAnom - criticalAnom - highAnom);
    const anomalyScore = Math.min(1, anomScoreRaw / 10);
    const anomalyPenalty = anomalyScore * 20;
    const unbalancedPenalty = Math.min(1, unbalanced) * 10;

    const raw = 100 - legacyPenalty - driftPenalty - anomalyPenalty - unbalancedPenalty;
    const score = Math.max(0, Math.min(100, Math.round(raw * 100) / 100));

    // Engine coverage expressed in percent for the tile
    const engineCoveragePct = Math.round(Number(s?.engine_coverage_24h || 0) * 10000) / 100;
    const legacyRatePct = Math.round(legacyRate * 10000) / 100;

    return {
      health_score: score,
      classification: this.classify(score),
      engine_coverage: {
        pct_24h: engineCoveragePct,
        engine_events_24h: Number(s?.engine_events_24h || 0),
        legacy_events_24h: Number(s?.legacy_events_24h || 0),
        total_events_24h: total24h,
        total_events_7d: Number(s?.total_events_7d || 0),
      },
      legacy_activity: {
        rate_24h_pct: legacyRatePct,
        bypass_alerts_24h: bypassAlerts24h,
      },
      journal_integrity: {
        unbalanced_entries_24h: unbalanced,
      },
      drift_status: {
        total_cashbox_drift: drift,
        tolerable: drift < 1,
      },
      anomalies: {
        open_total: openAnom,
        critical: criticalAnom,
        high: highAnom,
      },
      penalties: {
        legacy: Math.round(legacyPenalty * 100) / 100,
        drift: Math.round(driftPenalty * 100) / 100,
        anomaly: Math.round(anomalyPenalty * 100) / 100,
        unbalanced: Math.round(unbalancedPenalty * 100) / 100,
      },
      snapshot_at: s?.snapshot_at,
    };
  }

  /** Last N financial events from the event stream. Read-only. */
  async liveStream(limit = 100) {
    const cap = Math.min(Math.max(Number(limit) || 100, 1), 500);
    return this.ds.query(
      `SELECT event_id, event_type, source_service, reference_type, reference_id,
              amount, debit_total, credit_total, is_engine, is_legacy,
              session_user, meta, created_at
         FROM financial_event_stream
        ORDER BY event_id DESC
        LIMIT ${cap}`,
    );
  }

  /** Active anomalies grouped by severity. */
  async anomalies() {
    const rows = await this.ds.query(
      `SELECT anomaly_id, severity, anomaly_type, description, affected_entity,
              reference_id, details, detected_at, resolved, resolved_at
         FROM financial_anomalies
        WHERE NOT resolved
        ORDER BY
          CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
          detected_at DESC
        LIMIT 500`,
    );
    const grouped: Record<string, any[]> = {
      critical: [], high: [], medium: [], low: [],
    };
    for (const r of rows) grouped[r.severity]?.push(r);
    return {
      total_open: rows.length,
      by_severity: grouped,
    };
  }

  /**
   * Migration 2.1–2.4 compliance — shows per-reference_type the
   * engine vs legacy split over the last 7 days. Each method that
   * Phase 2 migrates should trend toward 100% engine.
   */
  async migrationStatus() {
    const rows = await this.ds.query(
      `SELECT reference_type,
              COUNT(*)::int                        AS total,
              COUNT(*) FILTER (WHERE is_engine)::int AS engine,
              COUNT(*) FILTER (WHERE is_legacy)::int AS legacy
         FROM financial_event_stream
        WHERE event_type = 'journal_entry'
          AND created_at > NOW() - INTERVAL '7 days'
          AND reference_type IS NOT NULL
        GROUP BY reference_type
        ORDER BY 2 DESC`,
    );

    // Phase map (per user's phase 2.1–2.4 plan)
    const phaseMap: Record<string, { phase: string; method: string }> = {
      invoice:             { phase: '2.1',  method: 'postInvoice' },
      expense:             { phase: '1',    method: 'postExpense → engine.recordExpense' },
      shift_variance:      { phase: '1',    method: 'postShiftClose → engine.recordShiftVariance' },
      employee_settlement: { phase: '1',    method: 'engine.recordTransaction (settlement)' },
      purchase:            { phase: '2.2',  method: 'postPurchase (pending)' },
      supplier_payment:    { phase: '2.2',  method: 'postSupplierPayment (pending)' },
      return:              { phase: '2.3',  method: 'postReturn (pending)' },
      depreciation:        { phase: '2.3',  method: 'postMonthlyDepreciation (pending)' },
      invoice_payment:     { phase: '2.3',  method: 'postInvoicePayment (pending)' },
      manual:              { phase: '2.4',  method: 'JournalService.create (pending)' },
    };

    const byType = rows.map((r: any) => {
      const meta = phaseMap[r.reference_type] ?? { phase: '?', method: '?' };
      const enginePct = r.total > 0 ? Math.round((r.engine / r.total) * 10000) / 100 : 0;
      return {
        reference_type: r.reference_type,
        total_7d: Number(r.total),
        engine_count: Number(r.engine),
        legacy_count: Number(r.legacy),
        engine_pct: enginePct,
        migrated: enginePct >= 99.5,
        phase: meta.phase,
        method: meta.method,
      };
    });

    const completedPhases = new Set(
      byType.filter((b: any) => b.migrated).map((b: any) => b.phase),
    );

    return {
      by_reference_type: byType,
      phases: {
        '1':   { label: 'Expense + shift_variance + settlement', complete: completedPhases.has('1') },
        '2.1': { label: 'POS sale (postInvoice)',                complete: completedPhases.has('2.1') },
        '2.2': { label: 'Purchases + supplier payments',         complete: completedPhases.has('2.2') },
        '2.3': { label: 'Returns + depreciation + payments',     complete: completedPhases.has('2.3') },
        '2.4': { label: 'Manual JE + reconciliation voids',      complete: completedPhases.has('2.4') },
      },
      overall_engine_coverage_7d: (() => {
        const tot = byType.reduce((s: number, r: any) => s + r.total_7d, 0);
        const eng = byType.reduce((s: number, r: any) => s + r.engine_count, 0);
        return tot > 0 ? Math.round((eng / tot) * 10000) / 100 : 0;
      })(),
    };
  }

  // ═════════════════════════════════════════════════════════════════════
  //   Anomaly scan — rule-based detection over the last N hours.
  //   Running it INSERTs new anomaly rows (idempotent on
  //   (type, entity, ref, resolved=FALSE) via the unique constraint).
  //   Detection rules below each return a list of candidate rows.
  // ═════════════════════════════════════════════════════════════════════
  async scan(hoursBack = 24) {
    const h = Math.min(Math.max(Number(hoursBack) || 24, 1), 168);

    const rules: Array<{ sev: 'low'|'medium'|'high'|'critical'; type: string; sql: string; params?: any[] }> = [
      // 1. Direct legacy journal insert bypass (engine_bypass_alerts from mig 063)
      {
        sev: 'high',
        type: 'legacy_bypass_journal_entry',
        sql: `SELECT table_name AS affected_entity, record_id AS reference_id,
                     jsonb_build_object('context', context_value,
                                        'session_user', session_user_name,
                                        'client_addr', client_addr) AS details,
                     'Legacy writer bypassed engine — ' || table_name || ' ' || operation AS description
                FROM engine_bypass_alerts
               WHERE created_at > NOW() - INTERVAL '${h} hours'`,
      },
      // 2. Unbalanced journal entry (shouldn't happen — DB trigger blocks, but scan anyway)
      {
        sev: 'critical',
        type: 'unbalanced_journal_entry',
        sql: `WITH b AS (
                SELECT je.id, je.entry_no, SUM(jl.debit)-SUM(jl.credit) AS delta
                  FROM journal_entries je
                  JOIN journal_lines  jl ON jl.entry_id = je.id
                 WHERE je.is_posted AND NOT je.is_void
                   AND je.created_at > NOW() - INTERVAL '${h} hours'
                 GROUP BY 1,2
              )
              SELECT 'journal_entries' AS affected_entity,
                     id::text AS reference_id,
                     jsonb_build_object('entry_no', entry_no, 'delta', delta) AS details,
                     'Unbalanced JE ' || entry_no || ' — Dr-Cr=' || delta::text AS description
                FROM b WHERE ABS(delta) > 0.01`,
      },
      // 3. Cashbox drift (actual balance diverges from computed txn sum)
      {
        sev: 'high',
        type: 'cashbox_drift',
        sql: `SELECT 'cashboxes' AS affected_entity,
                     cb.id::text AS reference_id,
                     jsonb_build_object(
                       'name', cb.name_ar,
                       'stored', cb.current_balance,
                       'computed', COALESCE(cb.opening_balance,0) + COALESCE((
                          SELECT SUM(CASE WHEN direction='in' THEN amount ELSE -amount END)
                            FROM cashbox_transactions ct
                           WHERE ct.cashbox_id = cb.id AND NOT ct.is_void
                        ),0)
                     ) AS details,
                     'Cashbox drift: ' || cb.name_ar AS description
                FROM cashboxes cb
               WHERE cb.is_active
                 AND ABS(cb.current_balance - (
                       COALESCE(cb.opening_balance,0) + COALESCE((
                         SELECT SUM(CASE WHEN direction='in' THEN amount ELSE -amount END)
                           FROM cashbox_transactions ct
                          WHERE ct.cashbox_id = cb.id AND NOT ct.is_void
                       ),0)
                     )) > 0.01`,
      },
      // 4. Suspicious repeated voids (>= 3 voids on the same ref in 24h)
      {
        sev: 'medium',
        type: 'repeated_voids',
        sql: `SELECT 'journal_entries' AS affected_entity,
                     reference_id::text,
                     jsonb_build_object('void_count', COUNT(*), 'reference_type', reference_type) AS details,
                     'Repeated voids on ' || reference_type || '/' || reference_id || ' (' || COUNT(*)::text || 'x)' AS description
                FROM journal_entries
               WHERE is_void = TRUE
                 AND created_at > NOW() - INTERVAL '${h} hours'
               GROUP BY reference_type, reference_id
              HAVING COUNT(*) >= 3`,
      },
      // 5. Abnormal shift variance spike (>5% of expected OR > 1000 EGP abs)
      {
        sev: 'medium',
        type: 'shift_variance_spike',
        sql: `SELECT 'shifts' AS affected_entity,
                     id::text AS reference_id,
                     jsonb_build_object(
                       'shift_no', shift_no,
                       'expected', expected_closing,
                       'actual',   actual_closing,
                       'variance', COALESCE(actual_closing,0) - COALESCE(expected_closing,0)
                     ) AS details,
                     'Large variance on ' || shift_no || ': ' ||
                       (COALESCE(actual_closing,0) - COALESCE(expected_closing,0))::text AS description
                FROM shifts
               WHERE status='closed'
                 AND closed_at > NOW() - INTERVAL '${h} hours'
                 AND (
                   ABS(COALESCE(actual_closing,0) - COALESCE(expected_closing,0)) > 1000
                   OR (COALESCE(expected_closing,0) > 0 AND
                       ABS(COALESCE(actual_closing,0) - COALESCE(expected_closing,0))
                         / NULLIF(COALESCE(expected_closing,0),0) > 0.05)
                 )`,
      },
      // 6. Orphan cashbox_transactions (no reference)
      {
        sev: 'low',
        type: 'orphan_cashbox_txn',
        sql: `SELECT 'cashbox_transactions' AS affected_entity,
                     id::text AS reference_id,
                     jsonb_build_object('direction', direction, 'amount', amount, 'category', category) AS details,
                     'Orphan cashbox txn — no reference_type/id' AS description
                FROM cashbox_transactions
               WHERE (reference_type IS NULL OR reference_id IS NULL)
                 AND created_at > NOW() - INTERVAL '${h} hours'`,
      },
    ];

    let inserted = 0;
    let skipped = 0;
    for (const rule of rules) {
      let candidates: any[] = [];
      try {
        candidates = await this.ds.query(rule.sql);
      } catch {
        continue; // tolerate missing tables on older deployments
      }
      for (const c of candidates) {
        try {
          const res = await this.ds.query(
            `INSERT INTO financial_anomalies
               (severity, anomaly_type, description, affected_entity, reference_id, details)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT (anomaly_type, affected_entity, reference_id, resolved) DO NOTHING
             RETURNING anomaly_id`,
            [rule.sev, rule.type, c.description, c.affected_entity, c.reference_id, JSON.stringify(c.details ?? {})],
          );
          if (res.length > 0) inserted++;
          else skipped++;
        } catch {
          skipped++;
        }
      }
    }
    return { scanned_hours: h, inserted, skipped_existing: skipped };
  }

  /** Operator-only: mark an anomaly resolved. */
  async resolve(id: number, userId: string, note?: string) {
    if (!id) throw new BadRequestException('id required');
    const [row] = await this.ds.query(
      `UPDATE financial_anomalies
          SET resolved = TRUE, resolved_by = $2, resolved_at = NOW(),
              resolution_note = $3
        WHERE anomaly_id = $1 AND NOT resolved
        RETURNING *`,
      [id, userId, note ?? null],
    );
    if (!row) throw new BadRequestException('anomaly not found or already resolved');
    return row;
  }
}
