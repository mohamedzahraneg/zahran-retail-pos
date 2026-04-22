-- Migration 059: fix the NULL-trap in fn_is_engine_context()
-- ---------------------------------------------------------------------------
-- CRITICAL BUG: migration 058's guard function was:
--
--   CREATE FUNCTION fn_is_engine_context() RETURNS BOOLEAN AS $$
--     BEGIN
--       RETURN current_setting('app.engine_context', TRUE) = 'on';
--     END;
--   $$;
--
-- `current_setting(name, missing_ok := TRUE)` returns NULL when the
-- setting isn't set. `NULL = 'on'` evaluates to NULL (not FALSE), so
-- the function returns NULL instead of FALSE. Then in the guard:
--
--   IF NOT fn_is_engine_context() THEN
--     RAISE EXCEPTION ...
--
-- `NOT NULL` is NULL, and IF NULL is treated as FALSE → the RAISE
-- never fires → every manual INSERT/UPDATE succeeds. The guards were
-- installed correctly but the function short-circuited them all.
--
-- Proof: a direct `INSERT INTO journal_entries ...` from psql after
-- migration 058 succeeded. That row now has to be scrubbed (bottom of
-- this file) and the function fixed.
--
-- Fix: wrap the comparison in COALESCE(..., FALSE) so a missing GUC
-- definitively returns FALSE, and add `STRICT` isn't right here since
-- we DO want to handle NULL — COALESCE is the correct tool.
--
-- Idempotent. Safe on any DB state.

BEGIN;

-- ───────────────────────────────────────────────────────────────────
-- Fixed function: COALESCE the comparison so a missing setting
-- definitively returns FALSE.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_is_engine_context()
  RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN COALESCE(current_setting('app.engine_context', TRUE) = 'on', FALSE);
END;
$$;

-- ───────────────────────────────────────────────────────────────────
-- Scrub any rogue rows that slipped through while the guard was
-- effectively disabled (any journal_entries row with reference_type
-- IS NULL and entry_no starting with 'ACID-' or 'TEST-' — these are
-- manual pokes, not real business data).
-- ───────────────────────────────────────────────────────────────────
DO $$
BEGIN
  -- Raise the engine flag so the (now-working) guard lets us delete.
  PERFORM set_config('app.engine_context', 'on', TRUE);

  DELETE FROM journal_lines
   WHERE entry_id IN (
     SELECT id FROM journal_entries
      WHERE entry_no LIKE 'ACID-%' OR entry_no LIKE 'TEST-%'
   );
  DELETE FROM journal_entries
   WHERE entry_no LIKE 'ACID-%' OR entry_no LIKE 'TEST-%';
END $$;

COMMIT;
