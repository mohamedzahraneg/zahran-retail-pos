-- Migration 107b — PR-DRIFT-3D part 2: re-tag 2 mistyped settlement
--                              cashbox_transactions so they pair with
--                              their existing employee_settlement JEs.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Audit (PR-DRIFT-3D read-only) found the +501 employee_settlement
-- JE_only bucket on cashbox 524646d5 isn't a missing-CT problem at
-- all. The 2 cash-out CTs that pair with JE-2026-000223 and
-- JE-2026-000239 already exist on the target cashbox with the
-- correct amount, direction, cashbox_id, and reference_id. They're
-- just typed `reference_type = 'other'` instead of
-- `'employee_settlement'`, so v_cashbox_drift_per_ref's strict
-- (cashbox, reference_type, reference_id) join doesn't pair them.
--
-- Migration 107 added 'employee_settlement' to the entity_type enum
-- (in a separate transaction so the new value is committed before
-- it's referenced). This migration uses it.
--
-- The 2 affected rows
--
--     ct_id  amount  direction  category               ref_id (matches JE)
--     -----  ------  ---------  ---------------------  --------------------------------------
--     138     1.00   out        employee_settlement    ed0c13c8-…  → JE-2026-000223 (1.00 EGP)
--     157   500.00   out        employee_settlement    4a876335-…  → JE-2026-000239 (500.00 EGP)
--
-- Drift effect
--   · employee_settlement JE_only          +501.00 → 0      (closes bucket / PR-DRIFT-4)
--   · 2 new "employee_settlement both" rows: drift_amount = 0
--     (filtered out by the |drift|≤0.01 noise rule in the view)
--   · "other CT_only" loses these 2 rows: contribution shifts from
--     -501 to 0 in that bucket → bucket sum changes from +78.98 to
--     +579.98 (semantic accuracy improvement, not a real drift change)
--   · Total drift on الخزينة الرئيسية stays at -855.02
--
-- Strict scope
--   · ONLY cashbox_transactions.reference_type changes (one column on
--     2 rows).
--   · NO amount/direction/cashbox_id/reference_id changes.
--   · NO INSERT, NO DELETE, NO void.
--   · NO journal_entries / journal_lines edits.
--   · NO cashboxes.current_balance change.
--   · NO accounting formula changes.
--   · Engine context = migration:107_* so the migration-068 trigger
--     allows the writes silently.
--
-- Idempotent
--   The eligibility WHERE clause includes `reference_type = 'other'`
--   so a re-run finds 0 rows to update. Self-validating contract at
--   the end RAISEs EXCEPTION if any invariant is broken.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:107_pr_drift_3d_retag_settlement_cts',
  true
);

-- ─── Preconditions ───────────────────────────────────────────────────────
DO $$
DECLARE
  v_cb_balance      numeric;
  v_active_ct_sum   numeric;
  v_trial           numeric;
  v_eligible_count  int;
  v_je_223_active   int;
  v_je_239_active   int;
BEGIN
  SELECT current_balance INTO v_cb_balance FROM cashboxes
   WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END), 0)
    INTO v_active_ct_sum FROM cashbox_transactions
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void, FALSE) = FALSE;
  IF v_cb_balance <> v_active_ct_sum THEN
    RAISE EXCEPTION 'PR-DRIFT-3D pre: balance % != active CT sum %', v_cb_balance, v_active_ct_sum;
  END IF;

  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)::numeric(18,2)
    INTO v_trial FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
   WHERE je.is_posted = TRUE AND je.is_void = FALSE;
  IF v_trial <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3D pre: trial balance %, expected 0', v_trial;
  END IF;

  SELECT COUNT(*) INTO v_eligible_count FROM cashbox_transactions
   WHERE id IN (138, 157)
     AND COALESCE(is_void, FALSE) = FALSE
     AND cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND category::text = 'employee_settlement'
     AND reference_type::text = 'other'
     AND direction = 'out'
     AND amount IN (1.00, 500.00);
  IF v_eligible_count <> 2 THEN
    -- After the first run this drops to 0 (rows now type='employee_settlement');
    -- re-runs are no-ops. Only RAISE on first run failure.
    IF v_eligible_count = 0 THEN
      RAISE NOTICE 'PR-DRIFT-3D: 0 eligible rows (already-applied no-op)';
    ELSE
      RAISE EXCEPTION 'PR-DRIFT-3D pre: expected 2 eligible rows, found %', v_eligible_count;
    END IF;
  END IF;

  SELECT COUNT(*) INTO v_je_223_active
    FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
    JOIN chart_of_accounts a ON a.id = jl.account_id
   WHERE je.entry_no = 'JE-2026-000223'
     AND je.is_void = FALSE AND je.is_posted = TRUE
     AND je.reference_type::text = 'employee_settlement'
     AND a.code = '1111'
     AND jl.cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND jl.credit = 1.00;
  SELECT COUNT(*) INTO v_je_239_active
    FROM journal_entries je JOIN journal_lines jl ON jl.entry_id = je.id
    JOIN chart_of_accounts a ON a.id = jl.account_id
   WHERE je.entry_no = 'JE-2026-000239'
     AND je.is_void = FALSE AND je.is_posted = TRUE
     AND je.reference_type::text = 'employee_settlement'
     AND a.code = '1111'
     AND jl.cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND jl.credit = 500.00;
  IF v_je_223_active <> 1 OR v_je_239_active <> 1 THEN
    RAISE EXCEPTION 'PR-DRIFT-3D pre: target JEs not found (223=%, 239=%)',
      v_je_223_active, v_je_239_active;
  END IF;

  RAISE NOTICE 'PR-DRIFT-3D pre OK: balance=% eligible=% JE-223=% JE-239=%',
    v_cb_balance, v_eligible_count, v_je_223_active, v_je_239_active;
END $$;

-- ─── The actual update ───────────────────────────────────────────────────
UPDATE cashbox_transactions
   SET reference_type = 'employee_settlement'
 WHERE id IN (138, 157)
   AND reference_type::text = 'other'
   AND category::text = 'employee_settlement'
   AND COALESCE(is_void, FALSE) = FALSE
   AND cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4';

-- ─── Postconditions ──────────────────────────────────────────────────────
DO $$
DECLARE
  v_trial               numeric;
  v_cb_balance          numeric;
  v_active_ct_sum       numeric;
  v_settlement_je_only  numeric;
  v_ct_138_type         text;
  v_ct_157_type         text;
BEGIN
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)::numeric(18,2)
    INTO v_trial FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
   WHERE je.is_posted = TRUE AND je.is_void = FALSE;
  IF v_trial <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3D post: trial balance %, expected 0', v_trial;
  END IF;

  SELECT current_balance INTO v_cb_balance FROM cashboxes
   WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END), 0)
    INTO v_active_ct_sum FROM cashbox_transactions
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void, FALSE) = FALSE;
  IF v_cb_balance <> v_active_ct_sum THEN
    RAISE EXCEPTION 'PR-DRIFT-3D post: balance % != active CT sum %', v_cb_balance, v_active_ct_sum;
  END IF;

  SELECT reference_type::text INTO v_ct_138_type
    FROM cashbox_transactions WHERE id = 138;
  SELECT reference_type::text INTO v_ct_157_type
    FROM cashbox_transactions WHERE id = 157;
  IF v_ct_138_type <> 'employee_settlement' THEN
    RAISE EXCEPTION 'PR-DRIFT-3D post: CT 138 reference_type is %', v_ct_138_type;
  END IF;
  IF v_ct_157_type <> 'employee_settlement' THEN
    RAISE EXCEPTION 'PR-DRIFT-3D post: CT 157 reference_type is %', v_ct_157_type;
  END IF;

  SELECT COALESCE(SUM(drift_amount), 0)::numeric(18,2) INTO v_settlement_je_only
    FROM v_cashbox_drift_per_ref
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND reference_type = 'employee_settlement'
     AND coverage = 'JE_only';
  IF v_settlement_je_only <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3D post: employee_settlement JE_only %, expected 0',
      v_settlement_je_only;
  END IF;

  RAISE NOTICE 'PR-DRIFT-3D post OK: balance=% trial=0 settlement_JE_only=0 CT_138=% CT_157=%',
    v_cb_balance, v_ct_138_type, v_ct_157_type;
END $$;

COMMIT;
