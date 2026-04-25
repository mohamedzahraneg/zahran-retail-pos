-- Migration 089 — Resolve the 6 bypass alerts emitted by migration 088.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Migration 088 (PR #95 / #96) corrected Abu Youssef's wrong
--   settlement direction. Its writes were:
--     * UPDATE journal_entries SET is_void=true (the original wrong JE)
--     * INSERT journal_entries (the new corrective JE)
--     * INSERT journal_lines × 2 (the new JE's two legs)
--     * UPDATE journal_entries SET is_posted=true (the post step)
--     * 2× fn_record_cashbox_txn (reversal + real payout)
--
--   The two cashbox helper calls re-set `app.engine_context` internally
--   to `service:cashbox_fn_fallback` (its default behaviour), which
--   means every write inside their atomic blocks landed with that
--   context — including the INSERT/UPDATE on journal_entries and
--   journal_lines that fn_record_cashbox_txn does NOT do directly,
--   plus the cashbox_transactions INSERTs themselves.
--
--   Migration 068's enforcement trigger logged 6 rows in
--   engine_bypass_alerts (ids 45–50) with context_value
--   'service:cashbox_fn_fallback'. The weekly drift check pairs each
--   alert with a resolved financial_anomalies row via NOT EXISTS on
--   (affected_entity, reference_id). Without paired rows the check
--   FAILs with `unresolved last 7 days = 6`.
--
--   This is the same residual pattern migrations 072 and 079 cleaned
--   up after migrations 040 and 078 respectively. We do the same here.
--
-- Scope
--
--   * 6 paired financial_anomalies rows, one per alert id (45–50).
--   * Each row references the exact (affected_entity, reference_id)
--     so the drift check's twin lookup matches.
--   * Severity 'low'; resolved=true; resolution_note links migration
--     088 + the alert id.
--
-- Not touched
--   * No accounting / GL / cashbox row touched.
--   * No DDL.
--   * No new permission, no new function.
--   * Other unresolved alerts (if any from unrelated activity) are
--     left for separate cleanup.
--
-- Expected
--   * weekly drift check transitions FAIL→PASS.
--   * trial balance / cashbox drift unchanged (this migration writes
--     nothing to journal_entries or cashbox_transactions).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Pin to migration context so the financial_anomalies INSERT itself
-- doesn't trip a guard (the table is engine-write-allowed under
-- migration:* prefixes).
SELECT set_config(
  'app.engine_context',
  'migration:089_resolve_mig_088_bypass_alerts',
  true
);

-- For each of the 6 alerts (45–50) emitted by migration 088, insert
-- a paired resolved row so the drift check's NOT EXISTS clause
-- matches. Idempotent via NOT EXISTS — re-running the migration is
-- a no-op.

INSERT INTO financial_anomalies
  (severity, anomaly_type, description, affected_entity, reference_id,
   details, detected_at, resolved, resolved_at, resolution_note)
SELECT 'low'::text,
       'legacy_bypass_journal_entry'::text,
       format(
         'Controlled cleanup from migration 088 — bypass alert id=%s on %s (%s on record %s, context %s).',
         a.id,
         a.table_name,
         CASE a.operation WHEN 'I' THEN 'INSERT' WHEN 'U' THEN 'UPDATE' WHEN 'D' THEN 'DELETE' ELSE a.operation END,
         a.record_id,
         a.context_value
       ),
       a.table_name,
       a.record_id::text,
       jsonb_build_object(
         'migration', '089_resolve_mig_088_bypass_alerts',
         'paired_alert_id', a.id,
         'origin_migration', '088_hotfix_settlement_direction',
         'context_value', a.context_value,
         'operation', a.operation
       ),
       a.created_at,
       TRUE,
       NOW(),
       'Resolved by migration 089 — paired cleanup for migration 088 settlement-direction fix. fn_record_cashbox_txn internally sets context=service:cashbox_fn_fallback, which migration 068 logs as a bypass; this is intentional + sanctioned (same pattern migration 079 used after 078).'
  FROM engine_bypass_alerts a
 WHERE a.id BETWEEN 45 AND 50
   AND NOT EXISTS (
     SELECT 1 FROM financial_anomalies fa
      WHERE fa.affected_entity = a.table_name
        AND fa.reference_id   = a.record_id::text
        AND fa.resolved       = TRUE
   );

COMMIT;
