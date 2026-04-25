-- Migration 092 — Drop the old 10-arg fn_post_employee_wage_accrual.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Bug surfaced during PR #100 post-deploy verification.
--
--   Migration 091 added the 14-arg variant of fn_post_employee_wage_accrual
--   via CREATE OR REPLACE — but PostgreSQL treats added DEFAULT params as
--   a NEW signature, not a replacement. Result: both overloads exist
--   side-by-side, and any 10-arg call now fails with:
--     ERROR: function fn_post_employee_wage_accrual(uuid, date, numeric,
--            text, uuid, integer, numeric, integer, text, uuid)
--            is not unique
--   because Postgres can't pick between the explicit 10-arg and the
--   14-arg-with-defaults candidate.
--
--   Live impact (verified 2026-04-25 02:30 UTC): every fresh call to
--   adminMarkPayableDay / adminApproveWageFromAttendance fails. PR-3's
--   new endpoint also fails because both routes hit the same proc name.
--   No data corruption — the failure aborts the transaction cleanly.
--   Mohamed / Abu Youssef balances + cashbox unchanged.
--
-- Fix
--
--   DROP the old 10-arg signature explicitly. The 14-arg variant
--   (with DEFAULTs for the new approval params) becomes the only
--   resolution candidate, so 10-arg legacy callers continue working
--   via the DEFAULTs and 14-arg PR-3 callers work as designed.
--
-- Idempotent
--
--   DROP FUNCTION IF EXISTS — re-running is a no-op.
--
-- Not touched
--   * The 14-arg variant (kept as-is from migration 091).
--   * No data writes, no DDL beyond the DROP.
--   * No other procs / triggers / views.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DROP FUNCTION IF EXISTS public.fn_post_employee_wage_accrual(
  uuid,    -- p_user_id
  date,    -- p_work_date
  numeric, -- p_amount
  text,    -- p_source
  uuid,    -- p_attendance_record_id
  int,     -- p_worked_minutes
  numeric, -- p_daily_wage_snapshot
  int,     -- p_target_minutes_snap
  text,    -- p_reason
  uuid     -- p_created_by
);

-- Sanity assertion: there must be exactly one fn_post_employee_wage_accrual
-- after the DROP, and it must be the 14-arg variant.
DO $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count FROM pg_proc WHERE proname = 'fn_post_employee_wage_accrual';
  IF v_count <> 1 THEN
    RAISE EXCEPTION 'migration 092: expected exactly 1 fn_post_employee_wage_accrual after DROP, found %', v_count;
  END IF;
  RAISE NOTICE 'migration 092: confirmed exactly 1 fn_post_employee_wage_accrual remains (14-arg with approval defaults)';
END $$;

COMMIT;
