-- Migration 085 — Hotfix: fn_void_employee_wage_accrual must NOT post a reversal JE.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Bug surfaced during PR #88 post-deploy verification
--
--   The original migration 083 version of fn_void_employee_wage_accrual
--   did two things on void:
--     1. Marked the original accrual JE `is_void = TRUE`.
--     2. Posted a *separate* reversal JE (DR 213 / CR 521).
--
--   v_employee_gl_balance (migration 079) already filters out voided
--   JEs via FILTER (WHERE … AND je.is_void = FALSE). So step 2 lands
--   on top of a balance that has already been corrected by step 1 —
--   double-applying the reversal. Net effect per void: the employee's
--   GL balance drifts by +2× the accrual amount in the wrong direction.
--
--   Observed live (alzbaty, 2026-04-24):
--     baseline v_employee_gl_balance             = 890.00
--     after accrual 250 EGP + void (buggy path) = 1140.00
--     expected after void                        = 890.00
--     drift                                      = +250 (bug)
--
--   Trial balance stayed 0 (each JE is internally balanced) and the
--   weekly drift check kept passing (no engine-context bypass), which
--   is why this slipped past PR #88's own checks — the drift lives at
--   the per-employee granularity, not at the ledger-wide level.
--
-- Fix
--
--   Redefine fn_void_employee_wage_accrual so the void path only:
--     * marks the original JE `is_void = TRUE`
--     * marks the payable_day row `is_void = TRUE` with reason/at/by
--   No offsetting JE is posted — the view already excludes the original.
--
--   Same pattern bonuses / deductions use today (they flip
--   employee_bonuses.is_void / employee_deductions.is_void plus the
--   JE row; no separate reversal JE).
--
-- Cleanup
--
--   One stray JE needs to be cleaned up: JE-2026-000188 was created by
--   the verification test using the buggy path. We void it under a
--   `migration:*` context so migration 068's guard accepts the UPDATE,
--   and record a resolved financial_anomalies row so the weekly drift
--   check's bypass twin-lookup counts it as triaged (same pattern as
--   migrations 072 + 079).
--
--   After this cleanup alzbaty's v_employee_gl_balance returns to
--   890.00 and the table has no other rows from the buggy void path.
--
-- Not touched
--
--   * fn_post_employee_wage_accrual (accrual path is correct)
--   * employee_payable_days schema (constraints + partial index unchanged)
--   * v_employee_gl_balance definition (its void filter is correct)
--   * FinancialEngine, cashbox, trial-balance aggregates
--   * Any unrelated journal_entries / journal_lines row
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Redefine fn_void_employee_wage_accrual — no reversal JE ──────────
CREATE OR REPLACE FUNCTION public.fn_void_employee_wage_accrual(
    p_payable_day_id uuid,
    p_reason         text,
    p_voided_by      uuid
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
    d employee_payable_days%ROWTYPE;
BEGIN
    IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
        RAISE EXCEPTION 'void_wage_accrual: reason is required';
    END IF;
    IF p_voided_by IS NULL THEN
        RAISE EXCEPTION 'void_wage_accrual: voided_by is required';
    END IF;

    SELECT * INTO d FROM employee_payable_days
     WHERE id = p_payable_day_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'void_wage_accrual: payable_day % not found', p_payable_day_id;
    END IF;
    IF d.is_void THEN
        RETURN d.id; -- already voided → idempotent no-op
    END IF;
    IF d.journal_entry_id IS NULL THEN
        RAISE EXCEPTION 'void_wage_accrual: payable_day % has no JE to reverse', d.id;
    END IF;

    -- Engine context so migration 068's guard accepts the UPDATE on
    -- journal_entries. Canonical prefix (PR #85 pattern).
    PERFORM set_config('app.engine_context', 'engine:admin_void_wage_accrual', true);

    -- Mark the original JE voided. v_employee_gl_balance filters these
    -- out, so the employee's GL position returns to what it was before
    -- the accrual — no offsetting JE needed.
    UPDATE journal_entries
       SET is_void = TRUE
     WHERE id = d.journal_entry_id
       AND is_void = FALSE;

    UPDATE employee_payable_days
       SET is_void     = TRUE,
           void_reason = p_reason,
           voided_at   = NOW(),
           voided_by   = p_voided_by
     WHERE id = d.id;

    RETURN d.id;
END;
$$;

COMMENT ON FUNCTION public.fn_void_employee_wage_accrual(uuid, text, uuid) IS
  'Admin-only reversal for a wage accrual. Marks the original JE is_void=TRUE and flips the payable_day row to is_void=TRUE with reason/at/by. Does NOT post a separate reversal JE — v_employee_gl_balance already excludes voided JEs, so a reversal would double-correct. Idempotent. Reason is mandatory.';

-- ─── 2. Clean up the PR #88 verification-test residue ────────────────────
-- JE-2026-000188 was the buggy reversal JE created during post-deploy
-- verification. Its reference_id is the same payable_day_id that
-- already has is_void=TRUE (flipped by the buggy void path). We simply
-- mark this JE voided so v_employee_gl_balance drops it.
--
-- We use a DO block so we can pick the target JE by reference_type +
-- reference_id (robust against a possible entry-no sequence rewrite)
-- and set the engine context via set_config from within the same
-- transaction. If the row isn't found (e.g. this migration is re-run
-- after manual cleanup), the block is a no-op.

DO $$
DECLARE
    v_je_id       uuid;
    v_payable_id  uuid := '14c2874f-3858-4937-9787-fc8bf94a89cd'::uuid;
    v_employee    uuid := '3157e667-1d6f-4d89-97af-1166dc5a9fe7'::uuid;
    v_bal_after   numeric;
BEGIN
    PERFORM set_config('app.engine_context', 'migration:085_void_accrual_hotfix', true);

    SELECT id INTO v_je_id
      FROM journal_entries
     WHERE reference_type = 'employee_wage_accrual_void'
       AND reference_id   = v_payable_id
       AND is_void        = FALSE
     LIMIT 1;

    IF v_je_id IS NOT NULL THEN
        UPDATE journal_entries
           SET is_void = TRUE
         WHERE id = v_je_id;
        RAISE NOTICE 'migration 085 cleanup: voided stray reversal JE % for payable_day %',
                     v_je_id, v_payable_id;

        -- Resolved financial_anomalies row so the drift check's twin
        -- lookup counts this cleanup as triaged (same pattern as
        -- migrations 072 + 079).
        INSERT INTO financial_anomalies
          (severity, anomaly_type, description, affected_entity, reference_id,
           details, detected_at, resolved, resolved_at, resolution_note)
        VALUES
          ('low', 'legacy_bypass_journal_entry',
           'Controlled cleanup from migration 085 — voided buggy reversal JE created during PR #88 post-deploy verification (fn_void_employee_wage_accrual previously double-applied the correction).',
           'journal_entries', v_je_id::text,
           jsonb_build_object(
             'migration', '085_hotfix_void_wage_accrual_no_reversal_je',
             'intent', 'void',
             'payable_day_id', v_payable_id,
             'employee_user_id', v_employee,
             'original_amount', 250.00
           ),
           NOW(), TRUE, NOW(),
           'Intentional cleanup — migration 085 hotfix: void fn must not post a separate reversal JE; v_employee_gl_balance already excludes voided entries.');
    ELSE
        RAISE NOTICE 'migration 085 cleanup: no stray reversal JE found for payable_day % (already cleaned or never existed)',
                     v_payable_id;
    END IF;

    -- Sanity: alzbaty's balance should now be 890.00 (pre-test baseline)
    SELECT balance INTO v_bal_after
      FROM v_employee_gl_balance
     WHERE employee_user_id = v_employee;
    RAISE NOTICE 'migration 085 cleanup: alzbaty v_employee_gl_balance after cleanup = %', v_bal_after;
END $$;

COMMIT;
