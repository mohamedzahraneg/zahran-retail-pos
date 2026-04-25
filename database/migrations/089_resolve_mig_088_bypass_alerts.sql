-- Migration 089 — Mark migration 088's residual bypass-alert anomalies resolved.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Migration 088 (PR #95/#96) corrected Abu Youssef's wrong settlement
--   direction. Its 2× fn_record_cashbox_txn calls internally re-set
--   app.engine_context to 'service:cashbox_fn_fallback' — every write
--   inside those atomic blocks landed under that context and migration
--   068's enforcement trigger logged 6 rows in engine_bypass_alerts
--   (ids 45–50). Same residual pattern migrations 072/079 cleaned up
--   after 040/078.
--
--   The auto-detector pipeline ALREADY inserted matching
--   `financial_anomalies` rows (anomaly_type='legacy_bypass_journal_entry')
--   for those alerts — but with `resolved=false`. The drift check
--   pairs each alert with a `resolved=true` row, so the unresolved
--   anomalies cause the FAIL.
--
--   First attempt at this migration tried to INSERT new resolved rows
--   alongside the existing unresolved ones — but financial_anomalies
--   has a UNIQUE INDEX `ux_anomalies_open_slot` on
--   (anomaly_type, affected_entity, reference_id, resolved), so the
--   INSERT collided with the existing unresolved rows and failed.
--
-- Fix
--
--   UPDATE the 5 existing `resolved=false` rows to `resolved=true`
--   for the migration-088 bypass record_ids. The unique index
--   permits a flip from false→true because (…, false) and (…, true)
--   occupy different slots.
--
--   Affected record_ids (from engine_bypass_alerts ids 45–50):
--     cashbox_transactions  107  (alert 45)
--     journal_entries       887ea7c4-…  (alerts 46 INSERT + 49 UPDATE)
--     journal_lines         d37b9f9b-…  (alert 47)
--     journal_lines         7ff6d8f4-…  (alert 48)
--     cashbox_transactions  108  (alert 50)
--
--   = 5 distinct (affected_entity, reference_id) keys. UPDATE matches
--   exactly those 5 rows.
--
--   The 2 RESOLVED rows that migration 088 inserted directly
--   (`d695de62-…` original-JE-void target + `00000000-…088` placeholder)
--   are left alone — already correct + matching for the drift check.
--
-- Idempotent
--
--   The UPDATE has no effect on already-resolved rows. Re-running the
--   migration is a no-op.
--
-- Not touched
--
--   * No INSERT, no DELETE — only an UPDATE that flips resolved.
--   * No GL writes, no cashbox writes, no DDL, no permission changes.
--   * Other unresolved anomalies from unrelated activity are left for
--     separate cleanup.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:089_resolve_mig_088_bypass_alerts',
  true
);

DO $$
DECLARE
  v_updated int;
BEGIN
  UPDATE financial_anomalies
     SET resolved        = TRUE,
         resolved_at     = NOW(),
         resolution_note = COALESCE(resolution_note,
           'Resolved by migration 089 — paired cleanup for migration 088 settlement-direction fix. fn_record_cashbox_txn internally sets context=service:cashbox_fn_fallback, which migration 068 logs as a bypass; this is intentional + sanctioned (same pattern migration 079 used after migration 078).')
   WHERE anomaly_type    = 'legacy_bypass_journal_entry'
     AND resolved        = FALSE
     AND (affected_entity, reference_id) IN (
       ('cashbox_transactions', '107'),
       ('cashbox_transactions', '108'),
       ('journal_entries',      '887ea7c4-baf9-4e1b-9376-88cfbb46cb33'),
       ('journal_lines',        'd37b9f9b-af05-4f3c-988f-436e0d6cbb1b'),
       ('journal_lines',        '7ff6d8f4-f526-4525-a2c5-e747c719d94b')
     );

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'migration 089: % anomaly row(s) flipped to resolved=true', v_updated;
END $$;

COMMIT;
