-- Migration 106 — PR-DRIFT-3A: tag cashbox_id on legacy invoice/return
--                                cash journal_lines that were posted
--                                to account 1111 without a cashbox_id.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Audit (PR-DRIFT-3 read-only) found the +9,345.00 "invoice CT_only"
-- bucket and the -250.00 "return CT_only" bucket on cashbox 524646d5
-- are NOT missing-JE problems. The journal_entries are posted, the
-- amounts on account 1111 are correct, and the trial balance is
-- balanced. The drift is purely a *cashbox_id tag* artifact: the cash
-- legs were created with `cashbox_id = NULL`, so
-- v_cashbox_drift_per_ref's strict (cashbox, ref) join doesn't see
-- them.
--
-- This migration sets `journal_lines.cashbox_id = '524646d5-…'` on
-- exactly the legacy lines whose cashbox attribution is unambiguous.
-- Eligibility (all conditions must hold for a row to be touched):
--
--   1. journal_lines.cashbox_id IS NULL
--   2. account = 1111 (الخزينة الرئيسية)
--   3. parent JE is is_posted=TRUE AND is_void=FALSE
--   4. JE.reference_type IN ('invoice','return')
--   5. JE.reference_id IS NOT NULL
--   6. There is at least one ACTIVE cashbox_transactions row on the
--      target cashbox '524646d5-7bd6-4d8d-a484-b1f562b039a4' for the
--      same (reference_type, reference_id) — proves the cash actually
--      moved through THIS cashbox
--
-- Strict scope
--   · ONLY journal_lines.cashbox_id is changed (one column on N rows).
--   · NO debit/credit/account/reference fields touched.
--   · NO INSERT, NO DELETE, NO void.
--   · NO change to cashboxes.current_balance.
--   · NO change to cashbox_transactions.
--   · Trial balance unaffected (tag column doesn't enter the trial sum).
--
-- Idempotent
--   The eligibility WHERE clause includes `cashbox_id IS NULL` so a
--   re-run finds 0 rows to update (already-tagged rows fall out).
--   Self-validating contract at the end RAISEs EXCEPTION if any
--   invariant is broken — transaction rolls back atomically.
--
-- Live audit (2026-04-26): 35 rows expected
--   · 34 invoice cash legs (each from a different invoice; INV-000016
--     has 2 CTs but only 1 JE cash line)
--   · 1 return cash leg (RET-2026-000001 / JE-2026-000222 — added by
--     migration 097's mirror, but the original JE was untagged)
--   · Combined signed sum being tagged: +9,755 (invoice) + -250
--     (return) = +9,505
--
-- Drift effect
--   · invoice CT_only +9,345.00 → ~0 (33 of 34 invoices fully close;
--     INV-000016 moves to "invoice both" -410 because it has an
--     edit-reversal CT pair — joins the operator-review queue from
--     PR-DRIFT-3E)
--   · return CT_only -250.00 → 0 (closes)
--   · Total drift on الخزينة الرئيسية: +8,649.98 → ~ -705 (positive
--     unresolved buckets remain net of -1,025 invoice both + +501
--     employee_settlement JE_only + +78.98 other CT_only - 250 already
--     closed)
--
-- Strict
--   · Engine context = migration:106_* so the migration-068 trigger
--     allows the writes silently (no engine_bypass_alerts row).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:106_pr_drift_3a_tag_cashbox_on_legacy_cash_lines',
  true
);

-- ─── Preconditions ───────────────────────────────────────────────────────
DO $$
DECLARE
  v_cb_balance      numeric;
  v_active_ct_sum   numeric;
  v_trial           numeric;
  v_target_count    int;
  v_invoice_count   int;
  v_return_count    int;
BEGIN
  -- (1) target cashbox exists
  IF NOT EXISTS (SELECT 1 FROM cashboxes
                  WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4') THEN
    RAISE EXCEPTION 'PR-DRIFT-3A: target cashbox missing';
  END IF;

  -- (2) cashbox.current_balance == active CT signed sum
  SELECT current_balance INTO v_cb_balance FROM cashboxes
   WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END), 0)
    INTO v_active_ct_sum FROM cashbox_transactions
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void, FALSE) = FALSE;
  IF v_cb_balance <> v_active_ct_sum THEN
    RAISE EXCEPTION 'PR-DRIFT-3A precondition: current_balance % != active CT sum %',
      v_cb_balance, v_active_ct_sum;
  END IF;

  -- (3) trial balance = 0
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)::numeric(18,2)
    INTO v_trial
    FROM journal_lines jl JOIN journal_entries je ON je.id = jl.entry_id
   WHERE je.is_posted = TRUE AND je.is_void = FALSE;
  IF v_trial <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3A precondition: trial balance %, expected 0', v_trial;
  END IF;

  -- (4) target row count
  SELECT COUNT(*) INTO v_target_count
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN chart_of_accounts a ON a.id = jl.account_id
   WHERE a.code = '1111'
     AND jl.cashbox_id IS NULL
     AND je.is_posted = TRUE AND je.is_void = FALSE
     AND je.reference_type::text IN ('invoice','return')
     AND je.reference_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM cashbox_transactions ct
        WHERE ct.cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
          AND ct.reference_type::text = je.reference_type::text
          AND ct.reference_id = je.reference_id
          AND COALESCE(ct.is_void, FALSE) = FALSE
     );

  SELECT COUNT(*) FILTER (WHERE je.reference_type::text='invoice'),
         COUNT(*) FILTER (WHERE je.reference_type::text='return')
    INTO v_invoice_count, v_return_count
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN chart_of_accounts a ON a.id = jl.account_id
   WHERE a.code = '1111'
     AND jl.cashbox_id IS NULL
     AND je.is_posted = TRUE AND je.is_void = FALSE
     AND je.reference_type::text IN ('invoice','return')
     AND je.reference_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM cashbox_transactions ct
        WHERE ct.cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
          AND ct.reference_type::text = je.reference_type::text
          AND ct.reference_id = je.reference_id
          AND COALESCE(ct.is_void, FALSE) = FALSE
     );

  RAISE NOTICE 'PR-DRIFT-3A precondition OK: balance=% trial=0 target_count=% (invoice=%, return=%)',
    v_cb_balance, v_target_count, v_invoice_count, v_return_count;
END $$;

-- ─── The actual update ───────────────────────────────────────────────────
DO $$
DECLARE
  v_updated int;
BEGIN
  UPDATE journal_lines jl
     SET cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
   WHERE jl.cashbox_id IS NULL
     AND jl.account_id = (SELECT id FROM chart_of_accounts WHERE code='1111')
     AND EXISTS (
       SELECT 1 FROM journal_entries je
        WHERE je.id = jl.entry_id
          AND je.is_posted = TRUE
          AND je.is_void = FALSE
          AND je.reference_type::text IN ('invoice','return')
          AND je.reference_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM cashbox_transactions ct
             WHERE ct.cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
               AND ct.reference_type::text = je.reference_type::text
               AND ct.reference_id = je.reference_id
               AND COALESCE(ct.is_void, FALSE) = FALSE
          )
     );
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'PR-DRIFT-3A: tagged % cash journal_lines (expected: ~35 first run, 0 re-run)',
    v_updated;
END $$;

-- ─── Postconditions ──────────────────────────────────────────────────────
DO $$
DECLARE
  v_trial          numeric;
  v_cb_balance     numeric;
  v_active_ct_sum  numeric;
  v_remaining_null int;
  v_invoice_ct_only_after numeric;
  v_return_ct_only_after  numeric;
BEGIN
  -- Trial balance still 0
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)::numeric(18,2)
    INTO v_trial FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
   WHERE je.is_posted = TRUE AND je.is_void = FALSE;
  IF v_trial <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3A postcondition: trial balance %, expected 0', v_trial;
  END IF;

  -- Cashbox balance unchanged + still equal to active CT sum
  SELECT current_balance INTO v_cb_balance FROM cashboxes
   WHERE id = '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END), 0)
    INTO v_active_ct_sum FROM cashbox_transactions
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void, FALSE) = FALSE;
  IF v_cb_balance <> v_active_ct_sum THEN
    RAISE EXCEPTION 'PR-DRIFT-3A postcondition: balance % != active CT sum %',
      v_cb_balance, v_active_ct_sum;
  END IF;

  -- No remaining eligible NULL-cashbox lines (idempotency check)
  SELECT COUNT(*) INTO v_remaining_null
    FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
    JOIN chart_of_accounts a ON a.id = jl.account_id
   WHERE a.code = '1111'
     AND jl.cashbox_id IS NULL
     AND je.is_posted = TRUE AND je.is_void = FALSE
     AND je.reference_type::text IN ('invoice','return')
     AND je.reference_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM cashbox_transactions ct
        WHERE ct.cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
          AND ct.reference_type::text = je.reference_type::text
          AND ct.reference_id = je.reference_id
          AND COALESCE(ct.is_void, FALSE) = FALSE
     );
  IF v_remaining_null <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3A postcondition: % eligible rows remain untagged', v_remaining_null;
  END IF;

  -- Drift view: target buckets reduced as expected
  SELECT COALESCE(SUM(drift_amount), 0)::numeric(18,2) INTO v_invoice_ct_only_after
    FROM v_cashbox_drift_per_ref
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND reference_type = 'invoice' AND coverage = 'CT_only';

  SELECT COALESCE(SUM(drift_amount), 0)::numeric(18,2) INTO v_return_ct_only_after
    FROM v_cashbox_drift_per_ref
   WHERE cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND reference_type = 'return' AND coverage = 'CT_only';

  IF v_return_ct_only_after <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3A postcondition: return CT_only %, expected 0',
      v_return_ct_only_after;
  END IF;

  RAISE NOTICE 'PR-DRIFT-3A postconditions OK: balance=%, trial=0, invoice_CT_only=%, return_CT_only=%',
    v_cb_balance, v_invoice_ct_only_after, v_return_ct_only_after;
END $$;

COMMIT;
