-- Migration 103 — PR-DRIFT-2: clean up expense-edit double-correction.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Audit on 2026-04-26 (PR-DRIFT-1, view v_cashbox_drift_per_ref)
--   surfaced a +7,289.98 EGP coverage drift on الخزينة الرئيسية. Two of
--   the seven drift buckets sum to -1,360 EGP from the same root cause:
--
--     (a) `expense both` bucket: -680 EGP — cashbox_transactions stacked
--         a fresh outflow row on every expense edit instead of voiding
--         the prior CT.
--     (b) `expense_edit_reversal` JE_only bucket: -680 EGP — the
--         expense-edit handler called engine.recordTransaction with
--         BOTH `reversal_of: oldJe.id` (which voids the original) AND
--         a reversal JE body (which posts +oldAmount to cash 1111).
--         The two corrections double-corrected the cash account.
--
--   Operator decision (2026-04-26, مدير النظام) on the 3 affected
--   expenses: B/B/B — the cash did NOT physically leave the box for
--   the over-counted CTs. Both the stale CTs AND the reversal JEs are
--   accounting artifacts that need cleanup. The 680 EGP is
--   physically still in the drawer and must be restored to
--   cashboxes.current_balance.
--
-- Affected rows
--
--   5 stale cashbox_transactions to void (total signed: -680 EGP):
--     ct_id 52  — EXP-2026-000016  amount  3.00 (initial pre-edit snapshot)
--     ct_id 117 — EXP-2026-000016  amount 10.00 (post 3→10 edit snapshot)
--     ct_id 121 — EXP-2026-000016  amount 17.00 (duplicate of CT 119,
--                                                created 1 second later)
--     ct_id 150 — EXP-2026-000026  amount 500.00 (pre 500→1 edit snapshot)
--     ct_id 151 — EXP-2026-000027  amount 150.00 (pre 150→1 edit snapshot)
--
--   5 reversal journal_entries to void (each balanced; trial balance
--   stays 0):
--     JE-2026-000202 — EXP-2026-000016  +3   on 1111
--     JE-2026-000204 — EXP-2026-000016  +10  on 1111
--     JE-2026-000206 — EXP-2026-000016  +17  on 1111
--     JE-2026-000234 — EXP-2026-000027  +150 on 1111
--     JE-2026-000236 — EXP-2026-000026  +500 on 1111
--
--   Surviving CTs (each matches the post-edit GL state):
--     ct_id 119 = -17 EGP for EXP-2026-000016 (final amount 17)
--     ct_id 155 = -1  EGP for EXP-2026-000026 (final amount 1)
--     ct_id 153 = -1  EGP for EXP-2026-000027 (final amount 1)
--
--   Surviving JEs (each matches the post-edit cash state):
--     JE-2026-000207 = -17 EGP for EXP-2026-000016
--     JE-2026-000237 = -1  EGP for EXP-2026-000026
--     JE-2026-000235 = -1  EGP for EXP-2026-000027
--
-- Effect on cashboxes.current_balance
--
--     before: 16,384.98
--     +680.00 (recovers the phantom outflows)
--     after:  17,064.98  ← matches active CT signed sum
--
-- Effect on v_cashbox_drift_per_ref
--
--     `expense both`               -680 → 0       ✓
--     `expense_edit_reversal` JE_only -680 → row gone (JEs voided)  ✓
--     R2 contribution to total drift: -1,360 → 0
--     Total drift: +7,289.98 → +8,649.98 (the negative buckets close;
--                                          remaining positives unchanged
--                                          for PR-DRIFT-3 / PR-DRIFT-4
--                                          to address separately)
--
-- Engine guard (separate file, ships with this PR)
--
--   backend/src/accounting/accounting.service.ts:approveEditRequest
--   replaces the engine.recordTransaction({reversal_of, gl_lines,
--   cash_movements}) call with a direct void of the old JE. The new
--   expense JE still posts via engine.recordExpense afterwards. Pattern
--   is now "void + repost only" — never both reversal AND void on the
--   same edit.
--
-- Idempotent
--
--   · Each UPDATE is guarded (`AND is_void = FALSE` / `current_balance
--     <> v_new_balance`). Re-running is a no-op + RAISE NOTICE only.
--   · financial_anomalies INSERT is guarded by NOT EXISTS on the
--     anomaly_type/reference_id natural key.
--   · Self-validating contract assertion at the end RAISEs if any
--     invariant is broken.
--
-- Strict
--
--   · ONLY the 5 listed CTs and 5 listed JEs are touched.
--   · NO journal_lines edits.
--   · NO row deletes (audit trail preserved via is_void).
--   · NO change to JE-2026-000207 / 000237 / 000235 (the surviving
--     post-edit JEs).
--   · NO change to CT 119 / 155 / 153 (the surviving post-edit CTs).
--   · Trial balance must remain 0 (asserted at end).
--   · Cashbox current_balance must equal active CT signed sum
--     (asserted at end).
--   · Engine context = 'migration:103_*' so the guard trigger allows
--     the writes silently (no engine_bypass_alerts row created).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:103_pr_drift_2_expense_edit_double_correction_cleanup',
  true
);

-- ─── 1. Void the 5 stale cashbox_transactions ────────────────────────────
DO $$
DECLARE
  v_voided int;
BEGIN
  UPDATE cashbox_transactions
     SET is_void     = TRUE,
         void_reason = 'PR-DRIFT-2 — operator decision B/B/B (cash did not '
                    || 'physically leave the box) — stale snapshot CT from '
                    || 'expense-edit double-correction artifact. Surviving '
                    || 'CT for the same expense matches the post-edit amount.',
         voided_by   = '62e5482f-dac0-41e4-bda3-7f7d31f89631',  -- مدير النظام
         voided_at   = NOW()
   WHERE id IN (52, 117, 121, 150, 151)
     AND COALESCE(is_void, FALSE) = FALSE;

  GET DIAGNOSTICS v_voided = ROW_COUNT;
  RAISE NOTICE 'PR-DRIFT-2 step 1: voided % stale CT(s) (expected: 5 first run, 0 re-run)', v_voided;
END $$;

-- ─── 2. Void the 5 reversal journal_entries ──────────────────────────────
DO $$
DECLARE
  v_voided int;
BEGIN
  UPDATE journal_entries
     SET is_void     = TRUE,
         void_reason = 'PR-DRIFT-2 — operator decision B/B/B — reversal JE was '
                    || 'a double-correction. The original expense JE was '
                    || 'already voided via reversal_of in the same call, so '
                    || 'this reversal cash leg was redundant and inflated cash '
                    || 'account 1111 by oldAmount. Surviving expense JE for '
                    || 'the same expense matches the post-edit amount.',
         voided_by   = '62e5482f-dac0-41e4-bda3-7f7d31f89631',  -- مدير النظام
         voided_at   = NOW()
   WHERE entry_no IN (
           'JE-2026-000202',
           'JE-2026-000204',
           'JE-2026-000206',
           'JE-2026-000234',
           'JE-2026-000236'
         )
     AND reference_type::text = 'expense_edit_reversal'
     AND COALESCE(is_void, FALSE) = FALSE;

  GET DIAGNOSTICS v_voided = ROW_COUNT;
  RAISE NOTICE 'PR-DRIFT-2 step 2: voided % reversal JE(s) (expected: 5 first run, 0 re-run)', v_voided;
END $$;

-- ─── 3. Recompute cashboxes.current_balance from active CTs ──────────────
DO $$
DECLARE
  v_old_balance numeric;
  v_new_balance numeric;
  v_updated     int;
BEGIN
  SELECT current_balance INTO v_old_balance
    FROM cashboxes
   WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4';

  SELECT COALESCE(SUM(CASE WHEN direction = 'in'  THEN amount
                           WHEN direction = 'out' THEN -amount
                           ELSE 0 END), 0)::numeric(18, 2)
    INTO v_new_balance
    FROM cashbox_transactions
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void, FALSE) = FALSE;

  UPDATE cashboxes
     SET current_balance = v_new_balance,
         updated_at      = NOW()
   WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND current_balance <> v_new_balance;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'PR-DRIFT-2 step 3: cashbox current_balance: % → % (delta % EGP, % row(s) updated)',
    v_old_balance, v_new_balance, (v_new_balance - v_old_balance), v_updated;
END $$;

-- ─── 4. Document the correction in financial_anomalies ───────────────────
INSERT INTO financial_anomalies
  (severity, anomaly_type, description, affected_entity, reference_id,
   details, detected_at, resolved, resolved_at, resolution_note)
SELECT
  'high',
  'expense_edit_double_correction',
  'Expense-edit handler called engine.recordTransaction with reversal_of '
   || '(voids the original) AND a reversal JE body (posts +oldAmount on '
   || 'cash 1111). The two corrections double-corrected the cash account, '
   || 'inflating account 1111 by 680 EGP via 5 reversal JEs across '
   || 'EXP-2026-000016 / 000026 / 000027. Stale CTs (52, 117, 121, 150, '
   || '151) totaled -680 EGP of phantom withdrawals never physically '
   || 'taken from the box. Operator (مدير النظام) confirmed B/B/B on '
   || '2026-04-26: cash did not physically move for the over-counted rows.',
  'cashboxes',
  '524646d5-7bd6-4d8d-a484-b1f562b039a4',
  jsonb_build_object(
    'pr',                 'PR-DRIFT-2',
    'migration',          '103_pr_drift_2_expense_edit_double_correction_cleanup',
    'operator_decision',  'B/B/B',
    'voided_cts',         jsonb_build_array(52, 117, 121, 150, 151),
    'voided_jes',         jsonb_build_array(
                            'JE-2026-000202', 'JE-2026-000204', 'JE-2026-000206',
                            'JE-2026-000234', 'JE-2026-000236'),
    'expenses_affected',  jsonb_build_array(
                            'EXP-2026-000016', 'EXP-2026-000026', 'EXP-2026-000027'),
    'cash_recovered_to_box',  680.00,
    'balance_before',         16384.98,
    'balance_after',          17064.98,
    'audit_view',             'v_cashbox_drift_per_ref',
    'audit_pr',               'PR-DRIFT-1 (#137)'
  ),
  NOW(),
  TRUE,
  NOW(),
  'Resolved by migration 103 (PR-DRIFT-2). 5 stale CTs voided, 5 reversal '
   || 'JEs voided, cashbox.current_balance updated 16,384.98 → 17,064.98. '
   || 'Trial balance stays 0 (each reversal JE was self-balanced). Engine '
   || 'guard added in accounting.service.ts:approveEditRequest to use '
   || 'void+repost only (no reversal JE) — prevents recurrence.'
WHERE NOT EXISTS (
  SELECT 1 FROM financial_anomalies
   WHERE anomaly_type    = 'expense_edit_double_correction'
     AND affected_entity = 'cashboxes'
     AND reference_id    = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
);

-- ─── 5. Self-validating contract assertion ───────────────────────────────
DO $$
DECLARE
  v_active_ct_sum   numeric;
  v_balance         numeric;
  v_trial           numeric;
  v_active_reversals int;
  v_active_stale_cts int;
  v_view_drift      numeric;
BEGIN
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END), 0)
    INTO v_active_ct_sum
    FROM cashbox_transactions
   WHERE cashbox_id='524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void, FALSE) = FALSE;

  SELECT current_balance INTO v_balance
    FROM cashboxes WHERE id='524646d5-7bd6-4d8d-a484-b1f562b039a4';

  IF v_active_ct_sum <> v_balance THEN
    RAISE EXCEPTION 'PR-DRIFT-2 invariant broken: active CT sum % != current_balance %',
      v_active_ct_sum, v_balance;
  END IF;

  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)::numeric(18, 2)
    INTO v_trial
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
   WHERE je.is_posted = TRUE AND je.is_void = FALSE;

  IF v_trial <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-2 invariant broken: trial balance is %, expected 0', v_trial;
  END IF;

  SELECT COUNT(*) INTO v_active_reversals
    FROM journal_entries
   WHERE entry_no IN ('JE-2026-000202','JE-2026-000204','JE-2026-000206',
                      'JE-2026-000234','JE-2026-000236')
     AND COALESCE(is_void, FALSE) = FALSE;

  IF v_active_reversals > 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-2 invariant broken: % reversal JE(s) still active', v_active_reversals;
  END IF;

  SELECT COUNT(*) INTO v_active_stale_cts
    FROM cashbox_transactions
   WHERE id IN (52, 117, 121, 150, 151)
     AND COALESCE(is_void, FALSE) = FALSE;

  IF v_active_stale_cts > 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-2 invariant broken: % stale CT(s) still active', v_active_stale_cts;
  END IF;

  -- Best-effort: confirm the R2 buckets are closed in the observability view.
  SELECT COALESCE(SUM(drift_amount), 0)::numeric(18, 2)
    INTO v_view_drift
    FROM v_cashbox_drift_per_ref
   WHERE cashbox_id='524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND reference_type IN ('expense', 'expense_edit_reversal');

  IF v_view_drift <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-2 invariant broken: R2 buckets sum to %, expected 0', v_view_drift;
  END IF;

  RAISE NOTICE 'PR-DRIFT-2 invariants OK: ct_sum=balance=%, trial=0, R2 buckets=0',
    v_balance;
END $$;

COMMIT;
