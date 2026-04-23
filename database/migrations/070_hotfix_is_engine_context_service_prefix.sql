-- Migration 070 — HOTFIX: POS-blocking regression from migration 068
-- ═══════════════════════════════════════════════════════════════════════════
--
-- PRODUCTION INCIDENT: POS sales were blocked with
--   ERROR: direct UPDATE of cashboxes.current_balance is not allowed —
--          use fn_record_cashbox_txn or ReconciliationService.rebuildCashboxBalance
--
-- Root cause:
--   * `fn_guard_cashbox_balance` (migration 058) checks
--     `fn_is_engine_context()` before allowing `UPDATE cashboxes
--     SET current_balance = ...`.
--   * `fn_is_engine_context()` historically accepted only `'on'` or
--     `engine:%`.
--   * Migration 068 tightened `fn_record_cashbox_txn` to set the
--     context to `'service:cashbox_fn_fallback'` instead of the
--     legacy `'on'`.
--   * `fn_is_engine_context()` was NOT updated to know about
--     `service:*` / `migration:*`.
--   * When a POS sale called `fn_record_cashbox_txn` with no prior
--     context, the function set `service:cashbox_fn_fallback`,
--     INSERTed the cashbox row (passed the `fn_engine_write_allowed`
--     guard introduced by 063/068), but then failed at the UPDATE
--     step because `fn_guard_cashbox_balance` relied on the older,
--     narrower helper.
--
-- Fix: bring `fn_is_engine_context()` in line with the strict-guard
-- patterns used by `fn_engine_write_allowed` (migration 068). Accepts:
--   * `engine:*`  (canonical)
--   * `service:*` (grandfathered named legacy)
--   * `migration:*` (migration runner / DDL)
--   * `'on'`      (legacy fallback retained until Phase 2.4 retires it)
--
-- Already hot-patched on prod via direct `CREATE OR REPLACE`. This
-- migration makes the fix durable so the next deploy / fresh install
-- starts from the correct state.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE FUNCTION fn_is_engine_context()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_ctx TEXT := COALESCE(current_setting('app.engine_context', TRUE), '');
BEGIN
  RETURN v_ctx LIKE 'engine:%'
      OR v_ctx LIKE 'service:%'
      OR v_ctx LIKE 'migration:%'
      OR v_ctx = 'on';
END;
$$;

COMMIT;
