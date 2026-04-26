-- Migration 109 — PR-DRIFT-3C: void 6 VERIFY_PR test cashbox_transactions.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   PR-DRIFT-3C audit (read-only, post-PR-DRIFT-3B) found 9 active
--   cashbox_transactions on الخزينة الرئيسية with reference_type='other'
--   summing to -100.02. Decomposition:
--
--     · 6 VERIFY_PR test rows: 99, 100, 101, 102, 139, 142
--       Net signed contribution: -0.02 EGP. Clearly tagged as test
--       cleanup ("VERIFY_PR test cleanup", "Admin void via Payroll
--       UI — reversing settlement id=N"). No matching active JE.
--       No employee_settlements row.
--
--     · 3 settlement-7 chain rows: 105, 107, 108  (NOT TOUCHED here)
--       Net signed: -100.00 (real cash payout to Abu Youssef).
--       Operator decision needed before reconciling — separate PR.
--
-- This migration voids only the 6 test rows. The settlement-7 chain
-- (CTs 105/107/108) stays active until operator confirms whether it
-- was a settlement vs advance.
--
-- The 6 affected rows
--
--     ct_id  amount  direction  category                        notes (truncated)
--     -----  ------  ---------  ------------------------------  ------------------
--     99      0.01   in         employee_settlement             تسوية من موظف 4 (cash)
--     100     0.01   in         employee_settlement             تسوية من موظف 5 (cash)
--     101     0.01   out        employee_settlement_reversal    VERIFY_PR test cleanup — reversing settlement id=4
--     102     0.01   out        employee_settlement_reversal    VERIFY_PR test cleanup — reversing settlement id=5
--     139     0.01   out        employee_settlement             تسوية من موظف 9 (cash)
--     142     0.01   out        employee_settlement_reversal    Admin void via Payroll UI — reversing settlement id=9
--
--   Net signed (in=+, out=−): +0.01 +0.01 −0.01 −0.01 −0.01 −0.01 = −0.02 EGP
--
-- Effect
--
--   · 6 cashbox_transactions get is_void=TRUE.
--   · cashboxes.current_balance for target cashbox 524646d5… increases
--     by 0.02 (currently 16,534.98 → 16,535.00) because the active CT
--     signed sum drops the −0.02 net contribution of the voided rows.
--   · Trial balance UNCHANGED (no journal_lines touched — these CTs
--     never had matching JEs).
--   · "other CT_only" bucket on الخزينة الرئيسية:
--       before: -100.02 (after PR-DRIFT-3B)
--       after:  -100.00 (only settlement-7 chain remains)
--   · Total drift on target cashbox:
--       before: -1,535.02
--       after:  -1,535.00 (−0.02 absorbed by the test-row removal)
--
-- Strict scope
--   · ONLY 6 cashbox_transactions get is_void/void_reason/voided_by/
--     voided_at + 1 cashboxes.current_balance update.
--   · NO INSERT (except 1 financial_anomalies audit row), NO DELETE.
--   · NO journal_entries / journal_lines edits (none of these CTs
--     have matching JEs to begin with).
--   · NO amount/direction/cashbox_id/reference_id changes.
--   · CTs 105, 107, 108 (settlement-7 chain) NOT touched — stay
--     active for separate operator-driven reconciliation.
--   · Engine context = migration:109_* so the migration-068 trigger
--     allows the writes silently.
--
-- Idempotent
--   The eligibility WHERE clause includes `COALESCE(is_void,FALSE)=FALSE`
--   so a re-run finds 0 rows. The cashbox.current_balance update is
--   guarded by `current_balance <> v_new_balance` so it's a no-op
--   when already correct. Self-validating contract at the end RAISEs
--   EXCEPTION if any invariant is broken.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:109_pr_drift_3c_void_verify_pr_test_cts',
  true
);

-- ─── Preconditions ───────────────────────────────────────────────────────
DO $$
DECLARE
  v_eligible_cts        int;
  v_settlement7_active  int;
  v_trial               numeric;
  v_cb_balance          numeric;
  v_active_ct_sum       numeric;
BEGIN
  -- (1) all 6 target CTs exist + active + on target cashbox + 0.01 amount
  SELECT COUNT(*) INTO v_eligible_cts FROM cashbox_transactions
   WHERE id IN (99, 100, 101, 102, 139, 142)
     AND COALESCE(is_void, FALSE) = FALSE
     AND cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND amount = 0.01
     AND reference_type::text = 'other';
  IF v_eligible_cts <> 6 THEN
    -- Re-run: 0 eligible (already voided) is a valid no-op state
    IF v_eligible_cts = 0 THEN
      RAISE NOTICE 'PR-DRIFT-3C: 0 eligible CTs (already-applied no-op)';
      RETURN;
    END IF;
    RAISE EXCEPTION 'PR-DRIFT-3C pre: expected 6 eligible CTs, found %', v_eligible_cts;
  END IF;

  -- (2) settlement-7 chain (CTs 105, 107, 108) MUST remain active and
  --     untouched after this migration. Verify they exist + are active
  --     so we don't mask a regression.
  SELECT COUNT(*) INTO v_settlement7_active FROM cashbox_transactions
   WHERE id IN (105, 107, 108)
     AND COALESCE(is_void, FALSE) = FALSE
     AND cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND amount = 100.00;
  IF v_settlement7_active <> 3 THEN
    RAISE EXCEPTION 'PR-DRIFT-3C pre: settlement-7 chain not in expected state (found %)',
      v_settlement7_active;
  END IF;

  -- (3) trial balance = 0
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)::numeric(18,2)
    INTO v_trial FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
   WHERE je.is_posted = TRUE AND je.is_void = FALSE;
  IF v_trial <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3C pre: trial balance %, expected 0', v_trial;
  END IF;

  -- (4) cashbox.current_balance == active CT signed sum
  SELECT current_balance INTO v_cb_balance FROM cashboxes
   WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END), 0)
    INTO v_active_ct_sum FROM cashbox_transactions
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void, FALSE) = FALSE;
  IF v_cb_balance <> v_active_ct_sum THEN
    RAISE EXCEPTION 'PR-DRIFT-3C pre: balance % != active CT sum %', v_cb_balance, v_active_ct_sum;
  END IF;

  RAISE NOTICE 'PR-DRIFT-3C pre OK: eligible_cts=% settlement7_active=% balance=%',
    v_eligible_cts, v_settlement7_active, v_cb_balance;
END $$;

-- ─── Step 1: void the 6 test CTs ─────────────────────────────────────────
DO $$
DECLARE v_voided int;
BEGIN
  UPDATE cashbox_transactions
     SET is_void = TRUE,
         void_reason = 'PR-DRIFT-3C — VERIFY_PR test-row cleanup. '
                    || 'Tagged as test (notes: "VERIFY_PR test cleanup" / '
                    || '"Admin void via Payroll UI"). 0.01 EGP each, no '
                    || 'matching active JE, no employee_settlements row. '
                    || 'Distorted other CT_only by -0.02. Voiding restores '
                    || 'cashbox.current_balance accordingly.',
         voided_by = '62e5482f-dac0-41e4-bda3-7f7d31f89631',  -- مدير النظام
         voided_at = NOW()
   WHERE id IN (99, 100, 101, 102, 139, 142)
     AND COALESCE(is_void, FALSE) = FALSE
     AND cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND amount = 0.01;
  GET DIAGNOSTICS v_voided = ROW_COUNT;
  RAISE NOTICE 'PR-DRIFT-3C step 1: voided % test CT(s) (expected 6 first run, 0 re-run)',
    v_voided;
END $$;

-- ─── Step 2: rebase cashboxes.current_balance from active CT signed sum ─
DO $$
DECLARE
  v_old_balance numeric;
  v_new_balance numeric;
  v_updated     int;
BEGIN
  SELECT current_balance INTO v_old_balance FROM cashboxes
   WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END), 0)::numeric(18,2)
    INTO v_new_balance FROM cashbox_transactions
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void, FALSE) = FALSE;
  UPDATE cashboxes
     SET current_balance = v_new_balance,
         updated_at      = NOW()
   WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND current_balance <> v_new_balance;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'PR-DRIFT-3C step 2: cashbox current_balance: % → % (delta % EGP, % row(s) updated)',
    v_old_balance, v_new_balance, (v_new_balance - v_old_balance), v_updated;
END $$;

-- ─── Document in financial_anomalies ─────────────────────────────────────
INSERT INTO financial_anomalies
  (severity, anomaly_type, description, affected_entity, reference_id,
   details, detected_at, resolved, resolved_at, resolution_note)
SELECT
  'low',
  'verify_pr_test_ct_cleanup',
  '6 VERIFY_PR test cashbox_transactions (99, 100, 101, 102, 139, 142) '
   || 'were left active on الخزينة الرئيسية from earlier verification '
   || 'work. Each is 0.01 EGP, has no matching JE, and no '
   || 'employee_settlements row. Net signed contribution: -0.02 EGP. '
   || 'Settlement-7 chain (CTs 105, 107, 108) deliberately NOT included '
   || 'in this cleanup — it represents a real 100 EGP payout to Abu '
   || 'Youssef and needs operator confirmation on settlement-vs-advance '
   || 'before reconciling.',
  'cashboxes',
  '524646d5-7bd6-4d8d-a484-b1f562b039a4',
  jsonb_build_object(
    'pr',                  'PR-DRIFT-3C',
    'migration',           '109_pr_drift_3c_void_verify_pr_test_cts',
    'voided_cts',          jsonb_build_array(99, 100, 101, 102, 139, 142),
    'kept_active_cts',     jsonb_build_array(105, 107, 108),
    'kept_reason',         'settlement-7 chain — real 100 EGP payout to Abu Youssef; needs operator decision (settlement vs advance) before posting missing JE',
    'cashbox_balance_delta', 0.02
  ),
  NOW(), TRUE, NOW(),
  'Resolved by migration 109 (PR-DRIFT-3C). 6 VERIFY_PR test rows '
   || 'voided; cashbox.current_balance rebased upward by 0.02 EGP. '
   || 'Trial balance unchanged. Settlement-7 chain (CTs 105/107/108) '
   || 'left active for a separate operator-driven reconciliation.'
WHERE NOT EXISTS (
  SELECT 1 FROM financial_anomalies
   WHERE anomaly_type    = 'verify_pr_test_ct_cleanup'
     AND affected_entity = 'cashboxes'
     AND reference_id    = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
);

-- ─── Postconditions ──────────────────────────────────────────────────────
DO $$
DECLARE
  v_trial             numeric;
  v_cb_balance        numeric;
  v_active_ct_sum     numeric;
  v_remaining_active  int;
  v_settlement7_state int;
  v_other_ct_only     numeric;
BEGIN
  -- Trial balance still 0
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)::numeric(18,2)
    INTO v_trial FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
   WHERE je.is_posted = TRUE AND je.is_void = FALSE;
  IF v_trial <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3C post: trial balance %, expected 0', v_trial;
  END IF;

  -- Balance == active CT sum
  SELECT current_balance INTO v_cb_balance FROM cashboxes
   WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END), 0)
    INTO v_active_ct_sum FROM cashbox_transactions
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void, FALSE) = FALSE;
  IF v_cb_balance <> v_active_ct_sum THEN
    RAISE EXCEPTION 'PR-DRIFT-3C post: balance % != active CT sum %', v_cb_balance, v_active_ct_sum;
  END IF;

  -- 6 target CTs are voided
  SELECT COUNT(*) INTO v_remaining_active FROM cashbox_transactions
   WHERE id IN (99, 100, 101, 102, 139, 142)
     AND COALESCE(is_void, FALSE) = FALSE;
  IF v_remaining_active <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3C post: % test CT(s) still active', v_remaining_active;
  END IF;

  -- Settlement-7 chain MUST remain active (not touched)
  SELECT COUNT(*) INTO v_settlement7_state FROM cashbox_transactions
   WHERE id IN (105, 107, 108)
     AND COALESCE(is_void, FALSE) = FALSE;
  IF v_settlement7_state <> 3 THEN
    RAISE EXCEPTION 'PR-DRIFT-3C post: settlement-7 chain disturbed (% active, expected 3)',
      v_settlement7_state;
  END IF;

  -- other CT_only bucket should now be -100.00 (only settlement-7 net remains)
  SELECT COALESCE(SUM(drift_amount), 0)::numeric(18,2) INTO v_other_ct_only
    FROM v_cashbox_drift_per_ref
   WHERE cashbox_id='524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND reference_type='other' AND coverage='CT_only';
  IF v_other_ct_only <> -100.00 THEN
    RAISE EXCEPTION 'PR-DRIFT-3C post: other CT_only %, expected -100.00', v_other_ct_only;
  END IF;

  RAISE NOTICE 'PR-DRIFT-3C post OK: balance=% trial=0 voided=6 settlement7_active=3 other_CT_only=-100.00',
    v_cb_balance;
END $$;

COMMIT;
