-- Migration 090 — Wage approval metadata on employee_payable_days.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Today (PR #88 + #89), `employee_payable_days.amount_accrued` is
--   always equal to `daily_wage_snapshot` — Option A "full-day rule".
--   PR-3 introduces explicit approval metadata so admin can approve
--   the calculated (hours-based) amount, the full daily wage, or a
--   custom amount, and so the audit trail captures who/when/why.
--
--   This is purely metadata: the single GL amount is still
--   `amount_accrued`, and `fn_post_employee_wage_accrual` continues
--   to post DR 521 / CR 213 of that value. No accounting math change.
--
-- Schema additions (all NULLable + DEFAULT-friendly so existing rows
-- and existing callers stay valid):
--
--   * calculated_amount  numeric(14,2)
--       What an attendance-based formula would have produced for the
--       day:  daily_wage × min(worked_min / target_min, 1)
--       For admin_manual rows where there's no attendance, equals
--       daily_wage_snapshot.
--
--   * override_type      text NOT NULL DEFAULT 'full_day'
--       'calculated'   → approved == calculated (no override)
--       'full_day'     → approved == daily_wage_snapshot (today's
--                        canonical behaviour)
--       'custom_amount'→ approved set explicitly by admin
--
--   * approval_reason    text
--       Required when override_type='custom_amount' AND
--       amount_accrued <> calculated_amount.
--
--   * approved_by        uuid REFERENCES users(id)
--       Who approved. Defaults to created_by on backfill.
--
--   * approved_at        timestamptz
--       When approved. Defaults to created_at on backfill.
--
-- Backfill
--
--   Every existing live row goes from "implicit Option A approval"
--   to "explicit full_day approval" — same end state, just labelled
--   so audits can tell. Approved-by/at copied from created-by/at.
--   calculated_amount = amount_accrued (Option A: calc == approved).
--
-- Strict
--
--   * No accounting math change.
--   * `amount_accrued` is and remains the single GL source.
--   * No new triggers; no new procs (those land in migration 091).
--   * No new permissions (existing employee.attendance.manage gates
--     the override flow at the controller layer).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.employee_payable_days
  ADD COLUMN IF NOT EXISTS calculated_amount numeric(14,2) NULL,
  ADD COLUMN IF NOT EXISTS override_type     text NOT NULL DEFAULT 'full_day'
                            CHECK (override_type IN ('calculated','full_day','custom_amount')),
  ADD COLUMN IF NOT EXISTS approval_reason   text NULL,
  ADD COLUMN IF NOT EXISTS approved_by       uuid NULL REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approved_at       timestamptz NULL;

-- Approval reason is mandatory when admin overrides to a custom value
-- that doesn't match the attendance-calculated number. CHECK kept loose
-- — calculated_amount can be NULL in legacy rows, in which case the
-- guard short-circuits and reason isn't forced.
ALTER TABLE public.employee_payable_days
  DROP CONSTRAINT IF EXISTS chk_payable_day_custom_override_reason;

ALTER TABLE public.employee_payable_days
  ADD CONSTRAINT chk_payable_day_custom_override_reason
    CHECK (
      override_type <> 'custom_amount'
      OR calculated_amount IS NULL
      OR amount_accrued = calculated_amount
      OR (approval_reason IS NOT NULL AND length(btrim(approval_reason)) > 0)
    );

COMMENT ON COLUMN public.employee_payable_days.calculated_amount IS
  'Attendance-based formula result: daily_wage × min(worked_min/target_min, 1). For admin_manual rows without attendance, equals daily_wage_snapshot.';
COMMENT ON COLUMN public.employee_payable_days.override_type IS
  '''calculated'' = approved equals calculated. ''full_day'' = approved equals daily_wage_snapshot (default; today''s canonical Option A). ''custom_amount'' = approved set explicitly by admin (requires approval_reason when ≠ calculated).';
COMMENT ON COLUMN public.employee_payable_days.approval_reason IS
  'Free-text reason captured when admin chooses an approved amount that diverges from the calculated amount.';

-- Backfill — every existing live row treated as an explicit full_day
-- approval. Idempotent (only fills NULLs).
DO $$
DECLARE
  v_updated int;
BEGIN
  PERFORM set_config('app.engine_context', 'migration:090_wage_approval_metadata', true);

  UPDATE employee_payable_days
     SET calculated_amount = COALESCE(calculated_amount, amount_accrued),
         approved_by       = COALESCE(approved_by, created_by),
         approved_at       = COALESCE(approved_at, created_at)
   WHERE calculated_amount IS NULL
      OR approved_by       IS NULL
      OR approved_at       IS NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'migration 090 backfill: % payable_day rows enriched with approval metadata', v_updated;
END $$;

COMMIT;
