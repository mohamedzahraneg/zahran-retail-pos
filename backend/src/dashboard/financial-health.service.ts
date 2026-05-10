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
/**
 * PR-FIX-WATCHTOWER-SCANNER-NOISE — engine bypass contexts that we
 * KNOW are intentional, audited operations.  When a bypass alert
 * carries one of these contexts, the bypass row stays in
 * `engine_bypass_alerts` (audit-of-record is preserved) but the
 * Watchtower no longer surfaces it as a HIGH-severity operator
 * anomaly.
 *
 * The whitelist is intentionally narrow:
 *   · `service:cash-recon-cleanup` — the production cash-recon
 *     executor (PR #262, the historical 1,745 EGP gap cleanup).
 *   · `service:VERIFY_PR`          — explicit verify-pr cleanup
 *     scripts that set this context.
 *
 * Adding a new entry here means: "this context is reviewed and
 * approved as a safe bypass — do not page the operator".  Anything
 * else still fires a HIGH anomaly.
 */
export const BENIGN_BYPASS_CONTEXTS: ReadonlyArray<string> = [
  'service:cash-recon-cleanup',
  'service:VERIFY_PR',
];

/**
 * Pattern that, if found in the affected row's notes / description,
 * also marks the bypass as benign.  This catches cases where the
 * cleanup script forgot to set an explicit engine context but tagged
 * the row's notes column with a recognisable marker (the actual
 * shape of the four April-24 anomalies on production).
 */
export const BENIGN_BYPASS_NOTES_PATTERNS: ReadonlyArray<RegExp> = [
  /VERIFY_PR/i,
];

/**
 * Decide whether a bypass-alert candidate is benign.  Defence in
 * depth: the rule SQL also filters on `context_value NOT IN (...)`
 * and a NOT-EXISTS check against the affected row's notes, but we
 * do the same check in TS so unit tests can drive the filter
 * without spinning up a real Postgres.
 *
 * `candidate.details.context`           — set by the SQL's
 *                                         `jsonb_build_object('context', ...)`
 * `candidate.details.affected_notes`    — set by the SQL's LEFT JOIN
 *                                         to the affected row's
 *                                         notes / description
 */
export function isBenignBypass(candidate: any): boolean {
  const ctx = candidate?.details?.context;
  if (typeof ctx === 'string' && BENIGN_BYPASS_CONTEXTS.includes(ctx)) {
    return true;
  }
  const notes = candidate?.details?.affected_notes;
  if (typeof notes === 'string') {
    if (BENIGN_BYPASS_NOTES_PATTERNS.some((re) => re.test(notes))) {
      return true;
    }
  }
  return false;
}

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
              session_user_name, meta, created_at
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
      //
      // PR-FIX-WATCHTOWER-SCANNER-NOISE — two layers of suppression
      // for known-good intentional bypasses.  The bypass alert ROW
      // stays in `engine_bypass_alerts` regardless (audit-of-record),
      // we just don't promote benign bypasses into operator-facing
      // HIGH anomalies on the Watchtower:
      //
      //   (a) `context_value NOT IN (...)` — fast SQL-side whitelist
      //       for explicitly-tagged service contexts.
      //   (b) `NOT EXISTS` against the affected row's notes /
      //       description — catches scripts whose engine_context was
      //       set to something generic but whose notes carry a
      //       recognisable cleanup marker (e.g. the four April-24
      //       VERIFY_PR rows on production).
      //
      // We also expose `affected_notes` in the details JSON so the
      // TS-side `isBenignBypass()` defence-in-depth filter (in the
      // candidate loop below) can re-check after fetch.  If a future
      // schema change drops one of these columns, the scan still
      // works — `to_regclass`-style guards are not added because
      // the trigger that populates these is older than the scan.
      {
        sev: 'high',
        type: 'legacy_bypass_journal_entry',
        sql: `SELECT a.table_name AS affected_entity,
                     a.record_id AS reference_id,
                     jsonb_build_object(
                       'context',        a.context_value,
                       'session_user',   a.session_user_name,
                       'client_addr',    a.client_addr,
                       'affected_notes', COALESCE(
                         (SELECT ct.notes
                            FROM cashbox_transactions ct
                           WHERE a.table_name = 'cashbox_transactions'
                             AND ct.id::text = a.record_id::text),
                         (SELECT je.description
                            FROM journal_entries je
                           WHERE a.table_name = 'journal_entries'
                             AND je.id::text = a.record_id::text),
                         NULL
                       )
                     ) AS details,
                     'Legacy writer bypassed engine — ' || a.table_name || ' ' || a.operation AS description
                FROM engine_bypass_alerts a
               WHERE a.created_at > NOW() - INTERVAL '${h} hours'
                 AND a.context_value NOT IN (
                       'service:cash-recon-cleanup',
                       'service:VERIFY_PR'
                     )
                 AND NOT (
                       a.table_name = 'cashbox_transactions'
                       AND EXISTS (
                         SELECT 1 FROM cashbox_transactions ct
                          WHERE ct.id::text = a.record_id::text
                            AND ct.notes ILIKE '%VERIFY_PR%'
                       )
                     )
                 AND NOT (
                       a.table_name IN ('journal_entries', 'journal_lines')
                       AND EXISTS (
                         SELECT 1 FROM journal_entries je
                          WHERE (je.id::text = a.record_id::text
                                 OR je.id::text IN (
                                    SELECT jl.entry_id::text
                                      FROM journal_lines jl
                                     WHERE jl.id::text = a.record_id::text
                                 ))
                            AND je.description ILIKE '%VERIFY_PR%'
                       )
                     )`,
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
      //
      // PR-FIX-WATCHTOWER-SCANNER-NOISE — skip shifts whose variance
      // was already addressed during close.  Three signals mean
      // "operator handled it":
      //   · variance_treatment IS NOT NULL    — operator picked one of
      //                                         the treatments at close
      //   · variance_journal_entry_id IS NOT NULL — the variance was
      //                                              posted as a JE
      //                                              (deduction or
      //                                              accept-cash-loss)
      //   · variance_approved_at IS NOT NULL  — explicit operator
      //                                         approval timestamp
      // Any one of these means the operator already saw + acted on
      // the variance; we shouldn't re-page them as a fresh anomaly.
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
                 AND variance_treatment        IS NULL
                 AND variance_journal_entry_id IS NULL
                 AND variance_approved_at      IS NULL
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
      // 7. Repeated shortages per employee (migration 069 intelligence)
      {
        sev: 'high',
        type: 'repeated_shortage_employee',
        sql: `SELECT 'users' AS affected_entity,
                     user_id::text AS reference_id,
                     jsonb_build_object(
                       'shortage_count_30d', shortage_count_30d,
                       'shortage_total_30d', shortage_total_30d,
                       'risk_score', risk_score
                     ) AS details,
                     'Repeated shortages: ' || full_name ||
                       ' — ' || shortage_count_30d::text || ' in 30d (' ||
                       shortage_total_30d::text || ' EGP)' AS description
                FROM v_employee_risk_score
               WHERE shortage_count_30d >= 2
                 AND risk_score >= 40`,
      },
      // 8. Low-accuracy shifts (variance > 5% of expected closing)
      //
      // PR-FIX-WATCHTOWER-SCANNER-NOISE — same treatment-aware guard
      // as rule 5, applied via NOT EXISTS against `shifts` so we don't
      // need to modify the v_shift_accuracy_score view.
      {
        sev: 'medium',
        type: 'low_accuracy_shift',
        sql: `SELECT 'shifts' AS affected_entity,
                     v.shift_id::text AS reference_id,
                     jsonb_build_object(
                       'shift_no', v.shift_no,
                       'accuracy_pct', v.accuracy_pct,
                       'variance_amount', v.variance_amount,
                       'expected_closing', v.expected_closing
                     ) AS details,
                     'Low accuracy shift ' || v.shift_no ||
                       ' — accuracy ' || v.accuracy_pct::text || '%' AS description
                FROM v_shift_accuracy_score v
               WHERE v.accuracy_level = 'low'
                 AND v.closed_at > NOW() - INTERVAL '${h} hours'
                 AND NOT EXISTS (
                   SELECT 1 FROM shifts s
                    WHERE s.id = v.shift_id
                      AND (
                        s.variance_treatment        IS NOT NULL
                        OR s.variance_journal_entry_id IS NOT NULL
                        OR s.variance_approved_at      IS NOT NULL
                      )
                 )`,
      },
    ];

    let inserted = 0;
    let skipped = 0;
    let riskFlagsCreated = 0;
    let lockdownRecommended = false;
    for (const rule of rules) {
      let candidates: any[] = [];
      try {
        candidates = await this.ds.query(rule.sql);
      } catch {
        continue; // tolerate missing tables on older deployments
      }
      for (const c of candidates) {
        // PR-FIX-WATCHTOWER-SCANNER-NOISE — defence-in-depth: even if
        // the rule SQL forgets to add the whitelist clause (or a new
        // rule introduces another bypass surface), the post-fetch
        // filter below stops a known-benign legacy bypass from being
        // promoted into an operator anomaly.  The rule SQL also
        // filters; this is the safety net.
        if (rule.type === 'legacy_bypass_journal_entry' && isBenignBypass(c)) {
          skipped++;
          continue;
        }
        try {
          // Suppress re-detection when a resolved=TRUE anomaly already
          // exists for the same (anomaly_type, affected_entity,
          // reference_id). Otherwise the scanner re-creates a fresh
          // resolved=FALSE row on every tick (the ux_anomalies_open_slot
          // UNIQUE constraint lets resolved=TRUE and resolved=FALSE
          // coexist per ref → once the open one is resolved, the slot
          // re-opens for a duplicate). Migration 072 cleans the
          // existing duplicates; this guard stops them from recurring.
          const res = await this.ds.query(
            `WITH guard AS (
               SELECT 1 FROM financial_anomalies
                WHERE anomaly_type   = $2
                  AND affected_entity = $4
                  AND reference_id   = $5
                  AND resolved       = TRUE
             )
             INSERT INTO financial_anomalies
               (severity, anomaly_type, description, affected_entity, reference_id, details)
             SELECT $1, $2, $3, $4, $5, $6::jsonb
              WHERE NOT EXISTS (SELECT 1 FROM guard)
             ON CONFLICT (anomaly_type, affected_entity, reference_id, resolved) DO NOTHING
             RETURNING anomaly_id`,
            [rule.sev, rule.type, c.description, c.affected_entity, c.reference_id, JSON.stringify(c.details ?? {})],
          );
          if (res.length > 0) {
            inserted++;
            // PHASE 3 hook — if this anomaly is a legacy-bypass and
            // the bypass alert row names a session_user that matches
            // an active employee, insert a HIGH-risk flag. No auto-
            // deduction from payroll (dangerous); the admin reviews
            // the flag on the employee profile and decides manually.
            if (rule.type === 'legacy_bypass_journal_entry') {
              try {
                const sessionUser =
                  (c.details?.session_user as string | undefined) ?? null;
                if (sessionUser) {
                  const [u] = await this.ds.query(
                    `SELECT id FROM users
                      WHERE username = $1 AND is_active = TRUE
                      LIMIT 1`,
                    [sessionUser],
                  );
                  if (u?.id) {
                    await this.ds.query(
                      `INSERT INTO employee_risk_flags
                         (user_id, risk_level, reason, anomaly_id, details)
                       VALUES ($1, 'high', $2, $3, $4::jsonb)`,
                      [
                        u.id,
                        `تجاوز FinancialEngine — كتابة مباشرة خارج المحرك (${c.affected_entity})`,
                        res[0].anomaly_id,
                        JSON.stringify({ source_anomaly: c }),
                      ],
                    );
                    riskFlagsCreated++;
                  }
                }
              } catch {
                // best-effort — a failure here does not negate the
                // underlying anomaly insertion
              }
            }
          } else {
            skipped++;
          }
        } catch {
          skipped++;
        }
      }
    }

    // PHASE 4 — if the unresolved CRITICAL anomaly count exceeds the
    // threshold, emit a `system_lockdown_recommended` anomaly. DOES NOT
    // auto-activate lockdown — the admin must explicitly toggle via
    // /dashboard/financial/lockdown.
    try {
      const [{ n: critCount }] = await this.ds.query(
        `SELECT COUNT(*)::int AS n FROM financial_anomalies
          WHERE NOT resolved AND severity = 'critical'`,
      );
      const THRESHOLD = 3;
      if (Number(critCount) >= THRESHOLD) {
        await this.ds.query(
          `INSERT INTO financial_anomalies
             (severity, anomaly_type, description, affected_entity, reference_id, details)
           VALUES ('critical', 'system_lockdown_recommended',
                   'شذوذات حرجة متعددة — يُنصح بتفعيل قفل النظام يدوياً',
                   'system_controls', 'threshold-breach',
                   $1::jsonb)
           ON CONFLICT (anomaly_type, affected_entity, reference_id, resolved) DO NOTHING`,
          [JSON.stringify({ critical_count: critCount, threshold: THRESHOLD })],
        );
        lockdownRecommended = true;
      }
    } catch {}

    return {
      scanned_hours: h,
      inserted,
      skipped_existing: skipped,
      risk_flags_created: riskFlagsCreated,
      lockdown_recommended: lockdownRecommended,
    };
  }

  // ═════════════════════════════════════════════════════════════════════
  //   Lockdown + risk flag operator surface
  // ═════════════════════════════════════════════════════════════════════

  async lockdownStatus() {
    const [row] = await this.ds.query(
      `SELECT financial_lockdown, locked_by, locked_at, lock_reason,
              last_changed_at
         FROM system_controls WHERE id = 1`,
    );
    return row ?? {
      financial_lockdown: false,
      locked_by: null,
      locked_at: null,
      lock_reason: null,
    };
  }

  async toggleLockdown(
    on: boolean,
    userId: string,
    reason?: string,
  ) {
    const [row] = await this.ds.query(
      `UPDATE system_controls SET
         financial_lockdown = $1::boolean,
         locked_by          = CASE WHEN $1 THEN $2::uuid ELSE NULL END,
         locked_at          = CASE WHEN $1 THEN NOW()    ELSE NULL END,
         lock_reason        = CASE WHEN $1 THEN $3       ELSE NULL END,
         last_changed_at    = NOW()
       WHERE id = 1
       RETURNING *`,
      [on, userId, reason ?? null],
    );
    return row;
  }

  async riskFlags(params: { resolved?: boolean; limit?: number } = {}) {
    const cap = Math.min(Math.max(Number(params.limit) || 100, 1), 500);
    const where: string[] = [];
    if (params.resolved === true) where.push('resolved = TRUE');
    if (params.resolved === false) where.push('NOT resolved');
    const clause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    return this.ds.query(
      `SELECT f.id, f.user_id, u.username, u.full_name,
              f.risk_level, f.reason, f.anomaly_id, f.details,
              f.flagged_at, f.resolved, f.resolved_at, f.resolution
         FROM employee_risk_flags f
         LEFT JOIN users u ON u.id = f.user_id
         ${clause}
         ORDER BY f.flagged_at DESC
         LIMIT ${cap}`,
    );
  }

  // ═════════════════════════════════════════════════════════════════════
  //   Intelligence layer (migration 069) — read-only dashboard feeds.
  //   Each reads a materialized view; zero side effects.
  // ═════════════════════════════════════════════════════════════════════

  /** Live cash position per cashbox (stored vs computed + drift). */
  cashPosition() {
    return this.ds.query(
      `SELECT * FROM v_cash_position ORDER BY name_ar`,
    );
  }

  /** Last 30 days revenue vs expense rollup for the P&L sparkline. */
  dailyPnl(days = 30) {
    const d = Math.min(Math.max(Number(days) || 30, 1), 90);
    return this.ds.query(
      `SELECT * FROM v_daily_pnl WHERE day >= CURRENT_DATE - ($1::int || ' days')::interval ORDER BY day DESC`,
      [d],
    );
  }

  /** Per-employee risk rollup — shortage count, outstanding, risk_score. */
  employeeRiskScores(params: { min_score?: number; limit?: number } = {}) {
    const cap = Math.min(Math.max(Number(params.limit) || 50, 1), 500);
    const min = Math.max(0, Number(params.min_score) || 0);
    return this.ds.query(
      `SELECT * FROM v_employee_risk_score
        WHERE risk_score >= $1
          AND (shortage_count_30d > 0 OR outstanding_balance > 0)
        ORDER BY risk_score DESC, outstanding_balance DESC
        LIMIT ${cap}`,
      [min],
    );
  }

  /** Shifts with accuracy ratings (post-close). */
  shiftAccuracy(params: { limit?: number; level?: 'high' | 'medium' | 'low' } = {}) {
    const cap = Math.min(Math.max(Number(params.limit) || 50, 1), 500);
    const conds: string[] = [];
    const args: any[] = [];
    if (params.level) {
      args.push(params.level);
      conds.push(`accuracy_level = $${args.length}`);
    }
    const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
    return this.ds.query(
      `SELECT * FROM v_shift_accuracy_score ${where}
        ORDER BY closed_at DESC
        LIMIT ${cap}`,
      args,
    );
  }

  async resolveRiskFlag(id: number, userId: string, resolution?: string) {
    if (!id) throw new BadRequestException('id required');
    const [row] = await this.ds.query(
      `UPDATE employee_risk_flags
          SET resolved = TRUE, resolved_by = $2, resolved_at = NOW(),
              resolution = $3
        WHERE id = $1 AND NOT resolved
        RETURNING *`,
      [id, userId, resolution ?? null],
    );
    if (!row) throw new BadRequestException('risk flag not found or already resolved');
    return row;
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
