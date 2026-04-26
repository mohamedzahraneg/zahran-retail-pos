-- Migration 108 — PR-DRIFT-3B: void 5 stale expense_edit_reversal
--                              cashbox_transactions paired with JEs
--                              already voided by PR-DRIFT-2 (mig 103).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   PR-DRIFT-2 audit (2026-04-26) identified the expense-edit
--   double-correction pattern on الخزينة الرئيسية. Operator decision
--   was B/B/B for the 3 affected expenses (EXP-2026-000016/000026/
--   000027) — cash did NOT physically return to the drawer when the
--   expenses were edited down.
--
--   Migration 103 (PR-DRIFT-2) voided:
--     · 5 stale outflow CTs (52, 117, 121, 150, 151)  — fake outflows
--     · 5 reversal JEs (JE-202/204/206/234/236)        — phantom debits
--
--   The matching INFLOW CTs (116, 118, 120, 152, 154 — the
--   "عكس مصروف" reversal-side CTs) were inadvertently NOT voided in
--   migration 103. They still credit +680 EGP to the active CT signed
--   sum and to the cashbox.current_balance, even though the cash
--   never physically returned. This migration finishes the cleanup.
--
-- Affected rows (all 5 currently active, paired JEs all voided)
--
--     ct_id  amount  direction  category               paired JE (already voided)
--     -----  ------  ---------  ---------------------  --------------------------
--     116      3.00  in         expense_edit_reversal  JE-2026-000202
--     118     10.00  in         expense_edit_reversal  JE-2026-000204
--     120     17.00  in         expense_edit_reversal  JE-2026-000206
--     152    150.00  in         expense_edit_reversal  JE-2026-000234
--     154    500.00  in         expense_edit_reversal  JE-2026-000236
--
--   Sum of in-direction amounts being voided: +680.00
--
-- Effect
--
--   · 5 cashbox_transactions get is_void=TRUE.
--   · cashboxes.current_balance for target cashbox 524646d5… reduces
--     by 680.00 (currently 17,214.98 → 16,534.98 after migration)
--     because the active CT signed sum drops by 680.
--   · Trial balance UNCHANGED (no journal_lines touched).
--   · "other CT_only" bucket on الخزينة الرئيسية:
--       before: +579.98 (after PR-DRIFT-3D)
--       after:  -100.02 (the 5 CTs leave; net contribution −680)
--   · Total drift on target cashbox:
--       before: -855.02
--       after:  -1,535.02 (more negative — correct, the system was
--                          previously overstating cashbox.balance by
--                          680 EGP that never physically existed)
--
-- Strict scope
--   · ONLY cashbox_transactions.is_void / void_reason / voided_by /
--     voided_at + cashboxes.current_balance change.
--   · NO INSERT, NO DELETE.
--   · NO journal_entries / journal_lines edits (their JE pairs are
--     already voided by migration 103).
--   · NO amount/direction/cashbox_id/reference_id changes.
--   · Engine context = migration:108_* so the migration-068 trigger
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
  'migration:108_pr_drift_3b_void_stale_expense_edit_reversal_cts',
  true
);

-- ─── Preconditions ───────────────────────────────────────────────────────
DO $$
DECLARE
  v_eligible_cts        int;
  v_paired_je_voided    int;
  v_trial               numeric;
  v_cb_balance          numeric;
  v_active_ct_sum       numeric;
BEGIN
  -- (1) all 5 CTs exist, active, on target cashbox, with correct shape
  SELECT COUNT(*) INTO v_eligible_cts FROM cashbox_transactions
   WHERE id IN (116, 118, 120, 152, 154)
     AND COALESCE(is_void, FALSE) = FALSE
     AND cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND category::text = 'expense_edit_reversal'
     AND direction = 'in'
     AND amount IN (3.00, 10.00, 17.00, 150.00, 500.00);
  IF v_eligible_cts <> 5 THEN
    -- Re-run case: 0 eligible (already voided) is a valid no-op state
    IF v_eligible_cts = 0 THEN
      RAISE NOTICE 'PR-DRIFT-3B: 0 eligible CTs (already-applied no-op)';
      -- Skip rest of preconditions and the update
      RETURN;
    END IF;
    RAISE EXCEPTION 'PR-DRIFT-3B pre: expected 5 eligible CTs, found %', v_eligible_cts;
  END IF;

  -- (2) all 5 paired reversal JEs are already voided
  SELECT COUNT(*) INTO v_paired_je_voided FROM journal_entries je
   WHERE je.entry_no IN (
     'JE-2026-000202','JE-2026-000204','JE-2026-000206',
     'JE-2026-000234','JE-2026-000236')
     AND je.reference_type::text = 'expense_edit_reversal'
     AND je.is_void = TRUE;
  IF v_paired_je_voided <> 5 THEN
    RAISE EXCEPTION 'PR-DRIFT-3B pre: expected 5 voided paired JEs, found %', v_paired_je_voided;
  END IF;

  -- (3) trial balance = 0
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)::numeric(18,2)
    INTO v_trial FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
   WHERE je.is_posted = TRUE AND je.is_void = FALSE;
  IF v_trial <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3B pre: trial balance %, expected 0', v_trial;
  END IF;

  -- (4) cashbox.current_balance == active CT signed sum (consistency)
  SELECT current_balance INTO v_cb_balance FROM cashboxes
   WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END), 0)
    INTO v_active_ct_sum FROM cashbox_transactions
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void, FALSE) = FALSE;
  IF v_cb_balance <> v_active_ct_sum THEN
    RAISE EXCEPTION 'PR-DRIFT-3B pre: balance % != active CT sum %', v_cb_balance, v_active_ct_sum;
  END IF;

  RAISE NOTICE 'PR-DRIFT-3B pre OK: eligible_cts=% paired_je_voided=% balance=%',
    v_eligible_cts, v_paired_je_voided, v_cb_balance;
END $$;

-- ─── Step 1: void the 5 stale reversal CTs ───────────────────────────────
DO $$
DECLARE v_voided int;
BEGIN
  UPDATE cashbox_transactions
     SET is_void = TRUE,
         void_reason = 'PR-DRIFT-3B — operator decision B/B/B (cash did not '
                    || 'physically return to the drawer) — stale '
                    || 'expense_edit_reversal CT inflow paired with already-'
                    || 'voided JE (PR-DRIFT-2 migration 103). The reversal JE '
                    || 'was the phantom-debit half of the double-correction; '
                    || 'this CT is the phantom-inflow half. Both should have '
                    || 'been voided together; this migration completes the '
                    || 'cleanup.',
         voided_by = '62e5482f-dac0-41e4-bda3-7f7d31f89631',  -- مدير النظام
         voided_at = NOW()
   WHERE id IN (116, 118, 120, 152, 154)
     AND COALESCE(is_void, FALSE) = FALSE
     AND cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND category::text = 'expense_edit_reversal';
  GET DIAGNOSTICS v_voided = ROW_COUNT;
  RAISE NOTICE 'PR-DRIFT-3B step 1: voided % stale CT(s) (expected 5 first run, 0 re-run)',
    v_voided;
END $$;

-- ─── Step 2: rebase cashboxes.current_balance to match new active CT sum ─
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
  RAISE NOTICE 'PR-DRIFT-3B step 2: cashbox current_balance: % → % (delta % EGP, % row(s) updated)',
    v_old_balance, v_new_balance, (v_new_balance - v_old_balance), v_updated;
END $$;

-- ─── Document in financial_anomalies ─────────────────────────────────────
INSERT INTO financial_anomalies
  (severity, anomaly_type, description, affected_entity, reference_id,
   details, detected_at, resolved, resolved_at, resolution_note)
SELECT
  'high',
  'expense_edit_reversal_stale_ct_cleanup',
  '5 stale expense_edit_reversal CTs (116, 118, 120, 152, 154) totaling '
   || '+680 EGP of phantom inflows on الخزينة الرئيسية were left active '
   || 'when PR-DRIFT-2 migration 103 voided their paired reversal JEs '
   || '(JE-202/204/206/234/236). Per operator decision B/B/B (cash did '
   || 'not physically return), these CTs should have been voided together '
   || 'with the JEs. This migration completes that cleanup and rebases '
   || 'cashboxes.current_balance accordingly.',
  'cashboxes',
  '524646d5-7bd6-4d8d-a484-b1f562b039a4',
  jsonb_build_object(
    'pr',                'PR-DRIFT-3B',
    'migration',         '108_pr_drift_3b_void_stale_expense_edit_reversal_cts',
    'operator_decision', 'B/B/B (from PR-DRIFT-2)',
    'voided_cts',        jsonb_build_array(116, 118, 120, 152, 154),
    'paired_voided_jes', jsonb_build_array(
                           'JE-2026-000202','JE-2026-000204','JE-2026-000206',
                           'JE-2026-000234','JE-2026-000236'),
    'cash_removed_from_balance', 680.00,
    'related_pr',        'PR-DRIFT-2 (#138, migration 103)'
  ),
  NOW(), TRUE, NOW(),
  'Resolved by migration 108 (PR-DRIFT-3B). 5 stale expense_edit_reversal '
   || 'CTs voided; cashbox.current_balance rebased downward by 680 EGP to '
   || 'match the new active CT signed sum. Trial balance unchanged. The '
   || 'paired reversal JEs (JE-202/204/206/234/236) remain voided from '
   || 'PR-DRIFT-2. Future expense edits use the engine guard added in '
   || 'PR-DRIFT-2 + PR-DRIFT-2.1 to prevent recurrence.'
WHERE NOT EXISTS (
  SELECT 1 FROM financial_anomalies
   WHERE anomaly_type    = 'expense_edit_reversal_stale_ct_cleanup'
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
  v_other_ct_only_inv numeric;
BEGIN
  -- Trial balance still 0
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)::numeric(18,2)
    INTO v_trial FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
   WHERE je.is_posted = TRUE AND je.is_void = FALSE;
  IF v_trial <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3B post: trial balance %, expected 0', v_trial;
  END IF;

  -- Balance == active CT sum
  SELECT current_balance INTO v_cb_balance FROM cashboxes
   WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END), 0)
    INTO v_active_ct_sum FROM cashbox_transactions
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void, FALSE) = FALSE;
  IF v_cb_balance <> v_active_ct_sum THEN
    RAISE EXCEPTION 'PR-DRIFT-3B post: balance % != active CT sum %', v_cb_balance, v_active_ct_sum;
  END IF;

  -- 5 target CTs are voided
  SELECT COUNT(*) INTO v_remaining_active FROM cashbox_transactions
   WHERE id IN (116, 118, 120, 152, 154)
     AND COALESCE(is_void, FALSE) = FALSE;
  IF v_remaining_active <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3B post: % target CT(s) still active', v_remaining_active;
  END IF;

  -- The 5 CTs no longer contribute to the drift view (they're voided
  -- so the view's `WHERE COALESCE(ct.is_void, FALSE) = FALSE` excludes them)
  SELECT COUNT(*) INTO v_other_ct_only_inv FROM v_cashbox_drift_per_ref
   WHERE cashbox_id='524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND reference_id IN (
       'a1e30fcc-ac7e-4770-b447-a0409f8838d7',
       '138a23e4-83ab-4f85-8a9f-8010ec2008ef',
       '6a2b9f14-19bf-4a13-bdaa-90ab158be6d6',
       '0a1598a7-59cd-4957-b453-1c49d2458f29',
       'f73f7251-22a2-4a28-9c9a-3d70eb019b6e');
  IF v_other_ct_only_inv <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3B post: % drift rows still reference these CTs',
      v_other_ct_only_inv;
  END IF;

  RAISE NOTICE 'PR-DRIFT-3B post OK: balance=% trial=0 voided=5 drift_rows_for_5_refs=0',
    v_cb_balance;
END $$;

COMMIT;
