-- Migration 081 — Add users.ledger_reset_date and backfill from reset JEs.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   After PR #73 we ran per-employee GL resets by posting
--   journal_entries with `reference_type LIKE 'employee_ledger_reset_%'`.
--   The reset cutoff is currently implicit — it only lives inside the
--   entry history.
--
--   The Employee Profile is being reworked around a monthly view and
--   needs a canonical "this is where the pre-reset archive ends" marker
--   so main cards can safely exclude everything before it.
--
-- Change
--
--   1. ADD COLUMN users.ledger_reset_date DATE NULL.
--
--   2. Backfill: for every user who has at least one posted, non-void
--      journal_entry with reference_type LIKE 'employee_ledger_reset_%',
--      set ledger_reset_date to the entry_date of the earliest such
--      entry.
--
--   3. Employees without a reset entry stay NULL — the UI then falls
--      back to legacy behaviour (no pre-reset archive section).
--
-- What this migration does NOT touch
--
--   * Any journal_entries / journal_lines / employee_* row
--   * v_employee_gl_balance / v_employee_ledger definitions
--   * FinancialEngine / engine context guards
--   * Cashbox or trial-balance aggregates
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS ledger_reset_date DATE NULL;

COMMENT ON COLUMN users.ledger_reset_date IS
  'Cut-off date for the Employee Profile post-reset view. Backfilled from the earliest posted non-void journal_entry with reference_type LIKE ''employee_ledger_reset_%''. NULL = no reset has been posted for this employee and the UI falls back to showing all history as-is.';

DO $$
DECLARE
    v_updated int;
BEGIN
    PERFORM set_config('app.engine_context', 'migration:081_backfill_ledger_reset_date', true);

    WITH per_user_reset AS (
      SELECT COALESCE(jl.employee_user_id, jl.employee_id) AS user_id,
             MIN(je.entry_date)                            AS reset_date
        FROM journal_entries je
        JOIN journal_lines   jl ON jl.entry_id = je.id
       WHERE je.reference_type LIKE 'employee_ledger_reset_%'
         AND je.is_posted = TRUE
         AND je.is_void   = FALSE
         AND COALESCE(jl.employee_user_id, jl.employee_id) IS NOT NULL
       GROUP BY COALESCE(jl.employee_user_id, jl.employee_id)
    )
    UPDATE users u
       SET ledger_reset_date = per_user_reset.reset_date
      FROM per_user_reset
     WHERE u.id = per_user_reset.user_id
       AND (u.ledger_reset_date IS NULL
            OR u.ledger_reset_date <> per_user_reset.reset_date);

    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RAISE NOTICE 'migration 081 backfill: % users got ledger_reset_date set', v_updated;
END $$;

COMMIT;
