-- Migration 110 — PR-DRIFT-3G: settlement-7 reconciliation for Abu Youssef.
--                              Void direction-fix noise (CT 105 + CT 107),
--                              re-tag the real payout (CT 108), insert the
--                              missing employee_settlement JE that pairs
--                              with it.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   PR-DRIFT-3 audit on الخزينة الرئيسية surfaced a 3-row "other CT_only"
--   bucket totalling -100 EGP that traces to the settlement-7 chain for
--   Abu Youssef:
--
--     ct_id  amount  direction  category                          ref_type
--     -----  ------  ---------  --------------------------------  --------
--     105     100.00 in         employee_settlement               other
--     107     100.00 out        employee_settlement_direction_fix other
--     108     100.00 out        employee_settlement               other
--
--   Operator decision (2026-04-26):
--
--     "Abu Youssef had an approved daily wage of 270 EGP. He received
--      100 EGP from that daily wage. Correct classification: employee
--      settlement / صرف مستحقات من اليومية. Not an advance."
--
--   So:
--     · CT 105 was the wrong-direction original entry.
--     · CT 107 was the direction-fix that reversed CT 105.
--     · CT 108 is the real cash payout to Abu Youssef. It has no JE pair.
--
--   This PR voids CT 105 + CT 107 (cancel each other → net 0 cashbox
--   effect), re-tags CT 108 from 'other' to 'employee_settlement' so the
--   view can pair it, and inserts the missing balanced JE
--     DR 213 مستحقات الموظفين 100  /  CR 1111 الخزينة الرئيسية 100
--   tagged with employee_user_id = Abu Youssef and reference_id = CT 108's
--   ref_id (887ea7c4-baf9-4e1b-9376-88cfbb46cb33).
--
-- Effect
--
--   · cashboxes.current_balance UNCHANGED: voiding 105 (in -100) and 107
--     (out +100) nets to 0; the new JE writes no CT.
--   · trial balance UNCHANGED (new JE is balanced 100/100).
--   · Abu Youssef 213 net credit drops by 100 (1,445 → 1,345) — reflects
--     that he received 100 of his accrued payable.
--   · Drift view buckets on الخزينة الرئيسية:
--       - "other CT_only"            : -100.00 (3 rows) → 0    (3 rows leave)
--       - "employee_settlement both" : +1 row, drift = 0 (filtered by
--                                       view's |drift|≤0.01 noise rule)
--     Total cashbox drift moves from -1,535.02 to -1,435.02.
--
-- Strict scope
--
--   · ONLY: void 105+107 (4 cols: is_void/void_reason/voided_by/voided_at),
--           UPDATE CT 108.reference_type from 'other' → 'employee_settlement',
--           INSERT 1 journal_entries row + 2 journal_lines rows,
--           INSERT 1 financial_anomalies row.
--   · NO new cashbox_transactions, NO deletes anywhere.
--   · NO change to CT 108's amount/direction/cashbox_id/reference_id.
--   · NO touch on invoice rows, wage accrual JE-2026-000238 (270 EGP),
--     employee_payable_days, or any other settlement chain.
--   · NO change to cashboxes.current_balance (net effect = 0, asserted).
--   · Engine context = migration:110_* so the migration-068 trigger
--     allows the writes silently.
--   · 'employee_settlement' enum value already added by PR-DRIFT-3D
--     (migration 107). This migration uses it in a single transaction.
--
-- Idempotent
--
--   Marker: CT 108.reference_type. First run: 'other' → 'employee_settlement'.
--   Re-run: marker is already 'employee_settlement' → preconditions short-
--   circuit with a NOTICE, all later steps are no-ops (UPDATEs guarded by
--   reference_type='other', INSERT JE guarded by NOT EXISTS on ref_id,
--   INSERT anomaly guarded by NOT EXISTS on (type, entity, ref_id)).
--   Self-validating contract at the end RAISEs EXCEPTION on any broken
--   invariant.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:110_pr_drift_3g_settle7',
  true
);

-- ─── Preconditions ───────────────────────────────────────────────────────
DO $$
DECLARE
  v_ct_108_reftype  text;
  v_ct_105_ok       int;
  v_ct_107_ok       int;
  v_ct_108_ok       int;
  v_existing_je     int;
  v_trial           numeric;
  v_cb_balance      numeric;
  v_active_ct_sum   numeric;
  v_payable_credit  numeric;
BEGIN
  -- Idempotency short-circuit: if CT 108 already retagged, treat as no-op
  SELECT reference_type::text INTO v_ct_108_reftype
    FROM cashbox_transactions WHERE id = 108;
  IF v_ct_108_reftype = 'employee_settlement' THEN
    RAISE NOTICE 'PR-DRIFT-3G: CT 108 already retagged (re-run no-op)';
    RETURN;
  END IF;

  -- (1) The 3 settlement-7 CTs exist with the expected shape
  SELECT COUNT(*) INTO v_ct_105_ok FROM cashbox_transactions
   WHERE id = 105
     AND COALESCE(is_void,FALSE) = FALSE
     AND cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND direction = 'in'
     AND amount = 100.00
     AND category::text = 'employee_settlement'
     AND reference_type::text = 'other';
  SELECT COUNT(*) INTO v_ct_107_ok FROM cashbox_transactions
   WHERE id = 107
     AND COALESCE(is_void,FALSE) = FALSE
     AND cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND direction = 'out'
     AND amount = 100.00
     AND category::text = 'employee_settlement_direction_fix'
     AND reference_type::text = 'other';
  SELECT COUNT(*) INTO v_ct_108_ok FROM cashbox_transactions
   WHERE id = 108
     AND COALESCE(is_void,FALSE) = FALSE
     AND cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND direction = 'out'
     AND amount = 100.00
     AND category::text = 'employee_settlement'
     AND reference_type::text = 'other'
     AND reference_id = '887ea7c4-baf9-4e1b-9376-88cfbb46cb33';
  IF v_ct_105_ok <> 1 OR v_ct_107_ok <> 1 OR v_ct_108_ok <> 1 THEN
    RAISE EXCEPTION 'PR-DRIFT-3G pre: settlement-7 CTs not in expected state '
      '(105_ok=%, 107_ok=%, 108_ok=%)', v_ct_105_ok, v_ct_107_ok, v_ct_108_ok;
  END IF;

  -- (2) No existing JE for CT 108's ref_id (we are inserting the missing JE)
  SELECT COUNT(*) INTO v_existing_je FROM journal_entries
   WHERE reference_id = '887ea7c4-baf9-4e1b-9376-88cfbb46cb33';
  IF v_existing_je <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3G pre: % JE(s) already reference 887ea7c4...',
      v_existing_je;
  END IF;

  -- (3) trial balance = 0
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)::numeric(18,2)
    INTO v_trial FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
   WHERE je.is_posted = TRUE AND je.is_void = FALSE;
  IF v_trial <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3G pre: trial balance %, expected 0', v_trial;
  END IF;

  -- (4) cashboxes.current_balance == active CT signed sum
  SELECT current_balance INTO v_cb_balance FROM cashboxes
   WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0)
    INTO v_active_ct_sum FROM cashbox_transactions
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void,FALSE) = FALSE;
  IF v_cb_balance <> v_active_ct_sum THEN
    RAISE EXCEPTION 'PR-DRIFT-3G pre: balance % != active CT sum %',
      v_cb_balance, v_active_ct_sum;
  END IF;

  -- (5) Abu Youssef has at least 100 of payable credit on 213
  --     (we are debiting 100 against his accrued payable)
  SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0)::numeric(18,2)
    INTO v_payable_credit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN chart_of_accounts a ON a.id = jl.account_id
   WHERE a.code = '213'
     AND jl.employee_user_id = '3800f38b-cdb9-4347-bf83-2ffc215efd1f'
     AND je.is_posted = TRUE AND je.is_void = FALSE;
  IF v_payable_credit < 100.00 THEN
    RAISE EXCEPTION 'PR-DRIFT-3G pre: Abu Youssef payable credit on 213 is % '
      '(< 100) — refusing to debit beyond accrued amount', v_payable_credit;
  END IF;

  RAISE NOTICE 'PR-DRIFT-3G pre OK: balance=% trial=0 abu_youssef_213_credit=%',
    v_cb_balance, v_payable_credit;
END $$;

-- ─── Step 1: void CT 105 + CT 107 (direction-fix noise) ──────────────────
DO $$
DECLARE v_voided int;
BEGIN
  UPDATE cashbox_transactions
     SET is_void = TRUE,
         void_reason = 'PR-DRIFT-3G — direction-fix noise from settlement-7 '
                    || 'chain. CT 105 was wrong-direction original entry '
                    || '(in 100); CT 107 was the direction-fix that reversed '
                    || 'it (out 100). Both net to 0 cashbox effect; voiding '
                    || 'cleans the audit trail. CT 108 (real cash payout to '
                    || 'Abu Youssef) remains active and is now paired with '
                    || 'the new employee_settlement JE inserted by this '
                    || 'migration.',
         voided_by = '62e5482f-dac0-41e4-bda3-7f7d31f89631',  -- مدير النظام
         voided_at = NOW()
   WHERE id IN (105, 107)
     AND COALESCE(is_void,FALSE) = FALSE
     AND cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND reference_type::text = 'other';
  GET DIAGNOSTICS v_voided = ROW_COUNT;
  RAISE NOTICE 'PR-DRIFT-3G step 1: voided % CT(s) (expected 2 first run, 0 re-run)',
    v_voided;
END $$;

-- ─── Step 2: re-tag CT 108 from 'other' to 'employee_settlement' ─────────
DO $$
DECLARE v_retagged int;
BEGIN
  UPDATE cashbox_transactions
     SET reference_type = 'employee_settlement'
   WHERE id = 108
     AND reference_type::text = 'other'
     AND category::text = 'employee_settlement'
     AND COALESCE(is_void,FALSE) = FALSE
     AND cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  GET DIAGNOSTICS v_retagged = ROW_COUNT;
  RAISE NOTICE 'PR-DRIFT-3G step 2: retagged % CT(s) (expected 1 first run, 0 re-run)',
    v_retagged;
END $$;

-- ─── Step 3: insert the missing balanced JE (DR 213 100 / CR 1111 100) ───
DO $$
DECLARE
  v_existing      int;
  v_je_id         uuid;
  v_entry_no      varchar;
  v_acc_213       uuid := '98f6a61d-0c8f-46ef-af75-59293b5fd618';
  v_acc_1111      uuid := 'a7e9457c-b863-488c-9f67-38c5598df0d1';
  v_abu_youssef   uuid := '3800f38b-cdb9-4347-bf83-2ffc215efd1f';
  v_target_cb     uuid := '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  v_ct_108_ref    uuid := '887ea7c4-baf9-4e1b-9376-88cfbb46cb33';
  v_admin         uuid := '62e5482f-dac0-41e4-bda3-7f7d31f89631';
BEGIN
  SELECT COUNT(*) INTO v_existing FROM journal_entries
   WHERE reference_id = v_ct_108_ref;
  IF v_existing > 0 THEN
    RAISE NOTICE 'PR-DRIFT-3G step 3: JE for ref 887ea7c4 already exists (no-op)';
    RETURN;
  END IF;

  v_entry_no := 'JE-2026-' || lpad(nextval('seq_journal_entry_no')::text, 6, '0');

  -- Insert as DRAFT (is_posted=FALSE) per fn_je_no_insert_posted guard;
  -- post via UPDATE after lines are written so the balance trigger validates.
  INSERT INTO journal_entries
    (entry_no, entry_date, description, reference_type, reference_id,
     is_posted, is_void, created_by)
  VALUES
    (v_entry_no, '2026-04-26',
     'تسوية يومية - صرف 100 من 270 - ابو يوسف (PR-DRIFT-3G settlement-7)',
     'employee_settlement', v_ct_108_ref,
     FALSE, FALSE, v_admin)
  RETURNING id INTO v_je_id;

  -- 213 line carries BOTH employee_id (regression guard 039c) and
  -- employee_user_id (v_employee_balances_gl + the post-condition match the
  -- user-id column). Wage accrual JE-2026-000238 uses the same convention.
  INSERT INTO journal_lines
    (entry_id, line_no, account_id, debit, credit, description,
     employee_id, employee_user_id, cashbox_id)
  VALUES
    (v_je_id, 1, v_acc_213, 100.00, 0.00,
     'مستحقات الموظف - ابو يوسف - تسوية جزئية 100/270',
     v_abu_youssef, v_abu_youssef, NULL),
    (v_je_id, 2, v_acc_1111, 0.00, 100.00,
     'صرف نقدي من الخزينة الرئيسية - تسوية ابو يوسف',
     NULL, NULL, v_target_cb);

  UPDATE journal_entries
     SET is_posted = TRUE,
         posted_by = v_admin,
         posted_at = NOW()
   WHERE id = v_je_id;

  RAISE NOTICE 'PR-DRIFT-3G step 3: inserted + posted JE % (id=%) DR 213 100 / CR 1111 100',
    v_entry_no, v_je_id;
END $$;

-- ─── Step 4: assert cashbox.current_balance unchanged (net effect = 0) ───
DO $$
DECLARE
  v_cb_balance     numeric;
  v_active_ct_sum  numeric;
BEGIN
  SELECT current_balance INTO v_cb_balance FROM cashboxes
   WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0)::numeric(18,2)
    INTO v_active_ct_sum FROM cashbox_transactions
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void,FALSE) = FALSE;
  IF v_cb_balance <> v_active_ct_sum THEN
    RAISE EXCEPTION 'PR-DRIFT-3G step 4: balance % != active CT sum % '
      '(net void effect was supposed to be 0)', v_cb_balance, v_active_ct_sum;
  END IF;
  RAISE NOTICE 'PR-DRIFT-3G step 4: balance % == active CT sum % (unchanged ✓)',
    v_cb_balance, v_active_ct_sum;
END $$;

-- ─── Step 5: document in financial_anomalies ─────────────────────────────
INSERT INTO financial_anomalies
  (severity, anomaly_type, description, affected_entity, reference_id,
   details, detected_at, resolved, resolved_at, resolution_note)
SELECT
  'medium',
  'settlement7_reconciliation',
  'Settlement-7 chain on الخزينة الرئيسية for Abu Youssef had 3 active '
   || 'CTs (105 in 100, 107 out 100, 108 out 100) with no matching JE on '
   || 'the 100 EGP payout. Per operator decision (2026-04-26): Abu Youssef '
   || 'received 100 of his approved 270 daily wage as employee_settlement '
   || '(NOT an advance). PR-DRIFT-3G voids the direction-fix noise (CT 105 '
   || '+ CT 107, net 0), re-tags CT 108 to employee_settlement, and inserts '
   || 'the missing balanced JE (DR 213 100 / CR 1111 100) tagged with '
   || 'employee_user_id = Abu Youssef.',
  'cashboxes',
  '524646d5-7bd6-4d8d-a484-b1f562b039a4',
  jsonb_build_object(
    'pr',                'PR-DRIFT-3G',
    'migration',         '110_pr_drift_3g_settlement7_reconciliation',
    'operator_decision', 'employee_settlement (NOT advance) — 100 of 270 daily wage',
    'employee_user_id',  '3800f38b-cdb9-4347-bf83-2ffc215efd1f',
    'employee_name_ar',  'ابو يوسف',
    'voided_cts',        jsonb_build_array(105, 107),
    'retagged_ct',       108,
    'new_je_reference_id','887ea7c4-baf9-4e1b-9376-88cfbb46cb33',
    'cash_balance_delta', 0.00,
    'related_pr',        'PR-DRIFT-3D (#148, migration 107) — added employee_settlement enum value'
  ),
  NOW(), TRUE, NOW(),
  'Resolved by migration 110 (PR-DRIFT-3G). 2 direction-fix CTs voided '
   || '(net 0 cashbox effect), CT 108 retagged from other to '
   || 'employee_settlement, balanced JE inserted (DR 213 100 / CR 1111 100). '
   || 'Trial balance unchanged. cashboxes.current_balance unchanged. '
   || 'Abu Youssef payable on 213 reduced from 1,445 to 1,345 (he received '
   || '100 of accrued amount). other CT_only bucket on الخزينة الرئيسية '
   || 'closes from -100 to 0; total cashbox drift moves from -1,535.02 to '
   || '-1,435.02 (remaining: 5 invoice/both rows pending PR-DRIFT-3E).'
WHERE NOT EXISTS (
  SELECT 1 FROM financial_anomalies
   WHERE anomaly_type    = 'settlement7_reconciliation'
     AND affected_entity = 'cashboxes'
     AND reference_id    = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
);

-- ─── Postconditions ──────────────────────────────────────────────────────
DO $$
DECLARE
  v_trial               numeric;
  v_cb_balance          numeric;
  v_active_ct_sum       numeric;
  v_ct_105_void         boolean;
  v_ct_107_void         boolean;
  v_ct_108_reftype      text;
  v_new_je              int;
  v_new_je_balanced     int;
  v_settlement_je_only  numeric;
  v_settlement_both     numeric;
  v_other_ct_only_sum   numeric;
  v_payable_credit      numeric;
BEGIN
  -- (a) trial balance still 0
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)::numeric(18,2)
    INTO v_trial FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
   WHERE je.is_posted = TRUE AND je.is_void = FALSE;
  IF v_trial <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3G post: trial balance %, expected 0', v_trial;
  END IF;

  -- (b) cashbox balance == active CT sum (still / unchanged)
  SELECT current_balance INTO v_cb_balance FROM cashboxes
   WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0)
    INTO v_active_ct_sum FROM cashbox_transactions
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void,FALSE) = FALSE;
  IF v_cb_balance <> v_active_ct_sum THEN
    RAISE EXCEPTION 'PR-DRIFT-3G post: balance % != active CT sum %',
      v_cb_balance, v_active_ct_sum;
  END IF;

  -- (c) CT 105 + CT 107 voided, CT 108 retagged
  SELECT COALESCE(is_void,FALSE) INTO v_ct_105_void FROM cashbox_transactions WHERE id = 105;
  SELECT COALESCE(is_void,FALSE) INTO v_ct_107_void FROM cashbox_transactions WHERE id = 107;
  SELECT reference_type::text     INTO v_ct_108_reftype FROM cashbox_transactions WHERE id = 108;
  IF NOT v_ct_105_void THEN RAISE EXCEPTION 'PR-DRIFT-3G post: CT 105 not voided'; END IF;
  IF NOT v_ct_107_void THEN RAISE EXCEPTION 'PR-DRIFT-3G post: CT 107 not voided'; END IF;
  IF v_ct_108_reftype <> 'employee_settlement' THEN
    RAISE EXCEPTION 'PR-DRIFT-3G post: CT 108 reference_type is % (expected employee_settlement)',
      v_ct_108_reftype;
  END IF;

  -- (d) New JE exists, posted, not void, with the right shape
  SELECT COUNT(*) INTO v_new_je
    FROM journal_entries
   WHERE reference_id = '887ea7c4-baf9-4e1b-9376-88cfbb46cb33'
     AND reference_type::text = 'employee_settlement'
     AND is_posted = TRUE AND is_void = FALSE;
  IF v_new_je <> 1 THEN
    RAISE EXCEPTION 'PR-DRIFT-3G post: expected 1 new JE for ref 887ea7c4..., found %',
      v_new_je;
  END IF;

  SELECT COUNT(*) INTO v_new_je_balanced
    FROM journal_entries je
    JOIN journal_lines   jl ON jl.entry_id = je.id
    JOIN chart_of_accounts a ON a.id = jl.account_id
   WHERE je.reference_id = '887ea7c4-baf9-4e1b-9376-88cfbb46cb33'
     AND je.is_void = FALSE
     AND ((a.code = '213'  AND jl.debit  = 100.00 AND jl.credit = 0
                              AND jl.employee_user_id = '3800f38b-cdb9-4347-bf83-2ffc215efd1f')
       OR (a.code = '1111' AND jl.credit = 100.00 AND jl.debit  = 0
                              AND jl.cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'));
  IF v_new_je_balanced <> 2 THEN
    RAISE EXCEPTION 'PR-DRIFT-3G post: new JE lines not in expected shape (matched %, expected 2)',
      v_new_je_balanced;
  END IF;

  -- (e) employee_settlement JE_only on target cashbox = 0
  SELECT COALESCE(SUM(drift_amount),0)::numeric(18,2) INTO v_settlement_je_only
    FROM v_cashbox_drift_per_ref
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND reference_type = 'employee_settlement'
     AND coverage = 'JE_only';
  IF v_settlement_je_only <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3G post: employee_settlement JE_only %, expected 0',
      v_settlement_je_only;
  END IF;

  -- (f) employee_settlement "both" row for ref 887ea7c4... has drift = 0
  --     (the view filters |drift|≤0.01 noise so it may not appear at all,
  --      which is fine — we just assert no NON-zero drift exists for it)
  SELECT COALESCE(SUM(drift_amount),0)::numeric(18,2) INTO v_settlement_both
    FROM v_cashbox_drift_per_ref
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND reference_type = 'employee_settlement'
     AND reference_id::text = '887ea7c4-baf9-4e1b-9376-88cfbb46cb33';
  IF v_settlement_both <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3G post: settlement-7 paired drift = %, expected 0',
      v_settlement_both;
  END IF;

  -- (g) other CT_only bucket: the 3 settlement-7 rows are gone (105/107
  --     voided, 108 retagged). Whatever remains is unrelated to this PR.
  SELECT COUNT(*) INTO v_other_ct_only_sum
    FROM v_cashbox_drift_per_ref
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND reference_type = 'other'
     AND coverage = 'CT_only'
     AND reference_id::text IN (
           '39be2e31-36ed-525c-825d-48827112e5d6',  -- CT 105 (now voided)
           'd695de62-635d-4b79-9c02-c348619b0212',  -- CT 107 (now voided)
           '887ea7c4-baf9-4e1b-9376-88cfbb46cb33'); -- CT 108 (now retagged)
  IF v_other_ct_only_sum <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3G post: % settlement-7 ref(s) still in other CT_only bucket',
      v_other_ct_only_sum;
  END IF;

  -- (h) Abu Youssef payable on 213 reduced by 100 (1,445 → 1,345)
  SELECT COALESCE(SUM(jl.credit) - SUM(jl.debit), 0)::numeric(18,2)
    INTO v_payable_credit
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN chart_of_accounts a ON a.id = jl.account_id
   WHERE a.code = '213'
     AND jl.employee_user_id = '3800f38b-cdb9-4347-bf83-2ffc215efd1f'
     AND je.is_posted = TRUE AND je.is_void = FALSE;
  IF v_payable_credit <> 1345.00 THEN
    RAISE EXCEPTION 'PR-DRIFT-3G post: Abu Youssef 213 credit is %, expected 1345.00',
      v_payable_credit;
  END IF;

  RAISE NOTICE 'PR-DRIFT-3G post OK: balance=% trial=0 settlement_JE_only=0 '
            || 'settlement7_paired_drift=0 other_CT_only_settlement7_rows=0 '
            || 'abu_youssef_213_credit=%',
    v_cb_balance, v_payable_credit;
END $$;

COMMIT;
