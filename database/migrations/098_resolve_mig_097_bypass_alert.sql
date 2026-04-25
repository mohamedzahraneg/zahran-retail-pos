-- Migration 098 — Mark migration 097's residual bypass-alert anomaly resolved.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Migration 097 (PR #121) inserted the missing cashbox_transactions
--   mirror for refund RET-2026-000001 by calling the canonical helper
--   `fn_record_cashbox_txn`. That helper internally re-sets
--   app.engine_context to 'service:cashbox_fn_fallback' for the writes
--   it performs, so migration 068's enforcement trigger logged exactly
--   one new bypass alert:
--
--     engine_bypass_alerts.id = 51
--       table_name    = cashbox_transactions
--       record_id     = '146'         (the new CT row)
--       context_value = service:cashbox_fn_fallback
--       created_at    = 2026-04-25 19:36:55.736845+00
--
--   The auto-detector pipeline then inserted the matching
--   `financial_anomalies` row (anomaly_id=2410) with resolved=false.
--   The weekly-drift check #8 pairs each alert with a resolved=true
--   anomaly row, so anomaly_id=2410 unresolved → check #8 FAIL.
--
--   This is the same residual pattern migrations 072 / 079 / 089
--   cleaned up after 040 / 078 / 088. It is intentional and
--   sanctioned: the migration's helper call IS the canonical engine
--   path; the bypass log just doesn't know to distinguish that
--   `migration:*` outer context wraps `service:cashbox_fn_fallback`
--   inner context.
--
-- Fix
--
--   UPDATE the existing anomaly row (anomaly_id=2410) from
--   resolved=false → resolved=true with a resolution note that points
--   at PR #121 / migration 097. Same UPDATE pattern migration 089 used.
--
--   The unique index `ux_anomalies_open_slot` on
--   (anomaly_type, affected_entity, reference_id, resolved) permits
--   the false→true flip because (…, false) and (…, true) occupy
--   different slots — no INSERT collision.
--
-- Idempotent
--
--   UPDATE has no effect on already-resolved rows (WHERE resolved=FALSE
--   guard). Re-running the migration is a no-op + RAISE NOTICE only.
--
-- Strict
--
--   · NO journal_entries created or modified
--   · NO journal_lines created or modified
--   · NO cashbox_transactions created or modified
--   · NO change to cashboxes.current_balance
--   · NO change to RET-2026-000001 / JE-2026-000222 / CT id=146 itself
--   · ONLY UPDATE of one financial_anomalies row's resolved/resolved_at/resolution_note
--
-- Not touched
--
--   Other unresolved bypass anomalies from unrelated app traffic
--   (the 7 prior alerts on 2026-04-24/25 with the same
--   `service:cashbox_fn_fallback` context) are out of scope and left
--   for a separate cleanup decision.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:098_resolve_mig_097_bypass_alert',
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
           'Resolved by migration 098 — paired cleanup for migration 097 '
           || '(PR #121 reconcile RET-2026-000001 cashbox mirror). '
           || 'fn_record_cashbox_txn internally sets context='
           || 'service:cashbox_fn_fallback, which migration 068 logs as '
           || 'a bypass; this is intentional + sanctioned (same pattern '
           || 'migrations 072 / 079 / 089 used after 040 / 078 / 088).')
   WHERE anomaly_type    = 'legacy_bypass_journal_entry'
     AND resolved        = FALSE
     AND affected_entity = 'cashbox_transactions'
     AND reference_id    = '146';

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'migration 098: % anomaly row(s) flipped to resolved=true', v_updated;
END $$;

COMMIT;
