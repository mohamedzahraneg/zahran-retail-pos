-- Migration 111 — PR-DRIFT-3E: invoice-edit GL reconciliation for the
--                              5 invoices flagged in the PR-DRIFT-3E audit.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   The PR-DRIFT-3E audit found 5 invoices on الخزينة الرئيسية where
--   the invoice was edited (item / price / payment-method change) but
--   the engine reversed the cashbox CT without updating the matching
--   journal entry. Net cashbox-bucket drift = -1,435 EGP (−410 −300
--   −395 +25 −355).
--
--   Operator decisions (2026-04-26):
--
--     INV-2026-000016 (410): Decision A — cash really entered, edit was
--       item-only. Void the stale edit-reversal CT (id=23). Keep JE-110.
--
--     INV-2026-000069 (300): Decision A — payment is now InstaPay. Void
--       JE-166 (cash). Repost as InstaPay JE (DR 1114 / CR 411 + COGS).
--
--     INV-2026-000071 (395): Decision A — payment is now InstaPay. Void
--       JE-178 (cash). Repost as InstaPay JE.
--
--     INV-2026-000088 (250, was 225): Decision A — price uplifted to 250
--       cash. Void JE-217 (225). Repost as cash JE for 250 (COGS unchanged
--       148.50 because product / cost did not change).
--
--     INV-2026-000098 (355): Decision A — payment is now InstaPay. Void
--       JE-230. Repost as InstaPay JE.
--
-- Effect
--
--   · 4 JEs voided (JE-2026-000166 / 000178 / 000217 / 000230).
--   · 4 fresh JEs posted with corrected payment-method routing.
--   · 1 stale edit-reversal CT voided (CT 23 on INV-016).
--   · cashboxes.current_balance rebases UP by 410 (CT 23 was an OUT 410;
--     voiding it removes -410 from the active CT signed sum, so the sum
--     INCREASES by +410 → balance moves from 16,615 → 17,025).
--   · trial balance UNCHANGED (every void+repost pair is balanced).
--   · invoice/both bucket on الخزينة الرئيسية: −1,435 → 0.
--   · Total drift on الخزينة الرئيسية: −1,435 → 0 (only ±10.99 shift
--     noise remains, net 0).
--
-- Account routing
--
--   InstaPay GL account is **1114 المحافظ الإلكترونية** (E-Wallets) per
--   the existing `cashboxAccountId` fallback map (ewallet → 1114 in
--   posting.service.ts). NO new account code is invented.
--
--   For INV-088 the cashbox account is resolved through the cashbox
--   link on chart_of_accounts (a7e9457c… is bound to 524646d5… per
--   PR-DRIFT-3F migration 106) — same as the original JE-217 used.
--
-- Strict scope
--
--   · Touches ONLY the 5 listed invoices.
--   · UPDATE on cashbox_transactions: 1 row (CT 23 void).
--   · UPDATE on journal_entries: 4 rows voided + 4 rows posted (after
--     INSERT-as-draft per fn_je_no_insert_posted guard).
--   · INSERT on journal_entries: 4 new entries.
--   · INSERT on journal_lines: 16 new lines (4 entries × 4 lines).
--   · UPDATE on cashboxes.current_balance: 1 row (16,615 → 17,025).
--   · INSERT on financial_anomalies: 1 row.
--   · NO touch on invoices, invoice_items, invoice_payments,
--     stock_movements, employee_payable_days, or any CT outside CT 23.
--   · Engine context = migration:111_pr_drift_3e_inv_edit (short to
--     satisfy financial_event_stream.source_service varchar(40)).
--
-- Idempotent
--
--   Marker: CT 23.is_void. First run: FALSE → TRUE. Re-run: marker is
--   already TRUE → preconditions short-circuit, all later steps no-op.
--   Each void/insert is also WHERE-guarded individually.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:111_pr_drift_3e_inv_edit',
  true
);

-- ─── Preconditions ───────────────────────────────────────────────────────
DO $$
DECLARE
  v_ct_23_void       boolean;
  v_je_166_active    int;
  v_je_178_active    int;
  v_je_217_active    int;
  v_je_230_active    int;
  v_je_110_active    int;
  v_ct_23_eligible   int;
  v_trial            numeric;
  v_cb_balance       numeric;
  v_active_ct_sum    numeric;
  v_invoice_both     int;
BEGIN
  -- Idempotency marker
  SELECT COALESCE(is_void,FALSE) INTO v_ct_23_void
    FROM cashbox_transactions WHERE id = 23;
  IF v_ct_23_void THEN
    RAISE NOTICE 'PR-DRIFT-3E: CT 23 already voided (re-run no-op)';
    RETURN;
  END IF;

  -- The 4 stale JEs must be active+posted for void
  SELECT COUNT(*) INTO v_je_166_active FROM journal_entries
   WHERE entry_no='JE-2026-000166' AND is_void=FALSE AND is_posted=TRUE
     AND reference_type::text='invoice';
  SELECT COUNT(*) INTO v_je_178_active FROM journal_entries
   WHERE entry_no='JE-2026-000178' AND is_void=FALSE AND is_posted=TRUE
     AND reference_type::text='invoice';
  SELECT COUNT(*) INTO v_je_217_active FROM journal_entries
   WHERE entry_no='JE-2026-000217' AND is_void=FALSE AND is_posted=TRUE
     AND reference_type::text='invoice';
  SELECT COUNT(*) INTO v_je_230_active FROM journal_entries
   WHERE entry_no='JE-2026-000230' AND is_void=FALSE AND is_posted=TRUE
     AND reference_type::text='invoice';
  IF v_je_166_active <> 1 OR v_je_178_active <> 1
     OR v_je_217_active <> 1 OR v_je_230_active <> 1 THEN
    RAISE EXCEPTION 'PR-DRIFT-3E pre: stale JEs not in expected state '
      '(166=%, 178=%, 217=%, 230=%)',
      v_je_166_active, v_je_178_active, v_je_217_active, v_je_230_active;
  END IF;

  -- JE-110 (INV-016) must remain active — operator says cash really
  -- entered, so we do NOT void it.
  SELECT COUNT(*) INTO v_je_110_active FROM journal_entries
   WHERE entry_no='JE-2026-000110' AND is_void=FALSE AND is_posted=TRUE
     AND reference_type::text='invoice';
  IF v_je_110_active <> 1 THEN
    RAISE EXCEPTION 'PR-DRIFT-3E pre: JE-110 not active (count=%)', v_je_110_active;
  END IF;

  -- CT 23 must be the stale OUT 410 reversal on INV-016
  SELECT COUNT(*) INTO v_ct_23_eligible FROM cashbox_transactions
   WHERE id = 23
     AND COALESCE(is_void,FALSE) = FALSE
     AND cashbox_id = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND direction = 'out' AND amount = 410.00
     AND reference_type::text = 'invoice'
     AND reference_id = '1db52041-e067-4ad1-8c91-fe4d6247203f';
  IF v_ct_23_eligible <> 1 THEN
    RAISE EXCEPTION 'PR-DRIFT-3E pre: CT 23 not in expected state (count=%)',
      v_ct_23_eligible;
  END IF;

  -- Trial balance = 0
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)::numeric(18,2)
    INTO v_trial FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
   WHERE je.is_posted = TRUE AND je.is_void = FALSE;
  IF v_trial <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3E pre: trial balance %', v_trial;
  END IF;

  -- Balance == active CT sum
  SELECT current_balance INTO v_cb_balance FROM cashboxes
   WHERE id='524646d5-7bd6-4d8d-a484-b1f562b039a4';
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0)
    INTO v_active_ct_sum FROM cashbox_transactions
   WHERE cashbox_id='524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void,FALSE)=FALSE;
  IF v_cb_balance <> v_active_ct_sum THEN
    RAISE EXCEPTION 'PR-DRIFT-3E pre: balance % != ct sum %',
      v_cb_balance, v_active_ct_sum;
  END IF;

  -- invoice/both bucket should currently be exactly the 5 expected rows
  SELECT COUNT(*) INTO v_invoice_both FROM v_cashbox_drift_per_ref
   WHERE cashbox_id='524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND reference_type='invoice' AND coverage='both';
  IF v_invoice_both <> 5 THEN
    RAISE EXCEPTION 'PR-DRIFT-3E pre: invoice/both row count %, expected 5',
      v_invoice_both;
  END IF;

  RAISE NOTICE 'PR-DRIFT-3E pre OK: balance=% trial=0 invoice_both_rows=%',
    v_cb_balance, v_invoice_both;
END $$;

-- ─── Step 1 — INV-016: void only the stale edit-reversal CT (CT 23) ──────
DO $$
DECLARE v_voided int;
BEGIN
  UPDATE cashbox_transactions
     SET is_void = TRUE,
         void_reason = 'PR-DRIFT-3E (decision A) — INV-2026-000016 edit was '
                    || 'item/category-only (price + payment method '
                    || 'unchanged at cash 410). Engine emitted this '
                    || 'reversal CT but cash never physically left the '
                    || 'drawer. JE-2026-000110 (cash 410) remains active '
                    || 'and is the correct GL representation.',
         voided_by = '62e5482f-dac0-41e4-bda3-7f7d31f89631',
         voided_at = NOW()
   WHERE id = 23
     AND COALESCE(is_void,FALSE) = FALSE
     AND reference_id = '1db52041-e067-4ad1-8c91-fe4d6247203f';
  GET DIAGNOSTICS v_voided = ROW_COUNT;
  RAISE NOTICE 'PR-DRIFT-3E step 1 (INV-016): voided % CT(s)', v_voided;
END $$;

-- ─── Step 2 — Void the 4 stale invoice JEs (069/071/217/230) ─────────────
DO $$
DECLARE v_voided int;
BEGIN
  UPDATE journal_entries
     SET is_void = TRUE,
         voided_by = '62e5482f-dac0-41e4-bda3-7f7d31f89631',
         voided_at = NOW(),
         void_reason = 'PR-DRIFT-3E (decision A) — stale invoice JE: invoice '
                    || 'was edited (payment method or price changed) and '
                    || 'the engine updated the cashbox CT but never '
                    || 'updated this JE. Replaced by a fresh corrected '
                    || 'JE in the same migration.'
   WHERE entry_no IN ('JE-2026-000166','JE-2026-000178',
                      'JE-2026-000217','JE-2026-000230')
     AND is_void = FALSE
     AND is_posted = TRUE
     AND reference_type::text = 'invoice';
  GET DIAGNOSTICS v_voided = ROW_COUNT;
  RAISE NOTICE 'PR-DRIFT-3E step 2: voided % JE(s)', v_voided;
END $$;

-- ─── Step 3 — Repost 4 corrected JEs ─────────────────────────────────────
-- Pattern per JE: insert as draft → insert lines → UPDATE is_posted=TRUE.
-- (Required by fn_je_no_insert_posted guard.)
DO $$
DECLARE
  v_admin       uuid := '62e5482f-dac0-41e4-bda3-7f7d31f89631';
  v_target_cb   uuid := '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  v_acc_1111    uuid := 'a7e9457c-b863-488c-9f67-38c5598df0d1';
  v_acc_1114    uuid := 'cc8ee897-185c-4523-983e-f39420c2b7e0';  -- E-Wallets / InstaPay
  v_acc_411     uuid := (SELECT id FROM chart_of_accounts WHERE code='411');
  v_acc_51      uuid := (SELECT id FROM chart_of_accounts WHERE code='51');
  v_acc_1131    uuid := (SELECT id FROM chart_of_accounts WHERE code='1131');
  v_existing    int;
  v_je_id       uuid;
  v_entry_no    varchar;

  -- per-invoice constants
  v_inv_069     uuid := '4a404583-1e37-496b-9608-dcd321eb5b67';
  v_inv_071     uuid := '4df64c87-933c-415f-9120-36be3d956d12';
  v_inv_088     uuid := '3921d4d5-2695-4e61-a5d2-07b2621d6d72';
  v_inv_098     uuid := '249ebbb0-aeb6-45cf-82f1-6b4cae416c6f';
BEGIN
  IF v_acc_411 IS NULL OR v_acc_51 IS NULL OR v_acc_1131 IS NULL THEN
    RAISE EXCEPTION 'PR-DRIFT-3E step 3: missing core account ids '
      '(411=%, 51=%, 1131=%)', v_acc_411, v_acc_51, v_acc_1131;
  END IF;

  -- ─── INV-2026-000069 — InstaPay 300 ─────────────────────────────────
  SELECT COUNT(*) INTO v_existing FROM journal_entries
   WHERE reference_id = v_inv_069 AND is_void = FALSE;
  IF v_existing = 0 THEN
    v_entry_no := 'JE-2026-' || lpad(nextval('seq_journal_entry_no')::text, 6, '0');
    INSERT INTO journal_entries
      (entry_no, entry_date, description, reference_type, reference_id,
       is_posted, is_void, created_by)
    VALUES
      (v_entry_no, '2026-04-24',
       'قيد فاتورة مبيعات INV-2026-000069 (PR-DRIFT-3E — تصحيح إلى انستا باي)',
       'invoice', v_inv_069, FALSE, FALSE, v_admin)
    RETURNING id INTO v_je_id;

    INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, description, cashbox_id)
    VALUES
      (v_je_id, 1, v_acc_1114, 300.00, 0.00,
       'دفع انستاباي - INV-2026-000069', NULL),
      (v_je_id, 2, v_acc_411,  0.00, 300.00,
       'إيراد INV-2026-000069', NULL),
      (v_je_id, 3, v_acc_51,   171.00, 0.00,
       'تكلفة INV-2026-000069', NULL),
      (v_je_id, 4, v_acc_1131, 0.00, 171.00,
       'خصم مخزون INV-2026-000069', NULL);

    UPDATE journal_entries SET is_posted=TRUE, posted_by=v_admin, posted_at=NOW()
     WHERE id = v_je_id;
    RAISE NOTICE 'PR-DRIFT-3E step 3 (INV-069): posted % (InstaPay 300)', v_entry_no;
  END IF;

  -- ─── INV-2026-000071 — InstaPay 395 ─────────────────────────────────
  SELECT COUNT(*) INTO v_existing FROM journal_entries
   WHERE reference_id = v_inv_071 AND is_void = FALSE;
  IF v_existing = 0 THEN
    v_entry_no := 'JE-2026-' || lpad(nextval('seq_journal_entry_no')::text, 6, '0');
    INSERT INTO journal_entries
      (entry_no, entry_date, description, reference_type, reference_id,
       is_posted, is_void, created_by)
    VALUES
      (v_entry_no, '2026-04-24',
       'قيد فاتورة مبيعات INV-2026-000071 (PR-DRIFT-3E — تصحيح إلى انستا باي)',
       'invoice', v_inv_071, FALSE, FALSE, v_admin)
    RETURNING id INTO v_je_id;

    INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, description, cashbox_id)
    VALUES
      (v_je_id, 1, v_acc_1114, 395.00, 0.00,
       'دفع انستاباي - INV-2026-000071', NULL),
      (v_je_id, 2, v_acc_411,  0.00, 395.00,
       'إيراد INV-2026-000071', NULL),
      (v_je_id, 3, v_acc_51,   234.00, 0.00,
       'تكلفة INV-2026-000071', NULL),
      (v_je_id, 4, v_acc_1131, 0.00, 234.00,
       'خصم مخزون INV-2026-000071', NULL);

    UPDATE journal_entries SET is_posted=TRUE, posted_by=v_admin, posted_at=NOW()
     WHERE id = v_je_id;
    RAISE NOTICE 'PR-DRIFT-3E step 3 (INV-071): posted % (InstaPay 395)', v_entry_no;
  END IF;

  -- ─── INV-2026-000088 — Cash 250 (was 225, COGS unchanged 148.50) ────
  SELECT COUNT(*) INTO v_existing FROM journal_entries
   WHERE reference_id = v_inv_088 AND is_void = FALSE;
  IF v_existing = 0 THEN
    v_entry_no := 'JE-2026-' || lpad(nextval('seq_journal_entry_no')::text, 6, '0');
    INSERT INTO journal_entries
      (entry_no, entry_date, description, reference_type, reference_id,
       is_posted, is_void, created_by)
    VALUES
      (v_entry_no, '2026-04-25',
       'قيد فاتورة مبيعات INV-2026-000088 (PR-DRIFT-3E — تصحيح السعر إلى 250 كاش)',
       'invoice', v_inv_088, FALSE, FALSE, v_admin)
    RETURNING id INTO v_je_id;

    INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, description, cashbox_id)
    VALUES
      (v_je_id, 1, v_acc_1111, 250.00, 0.00,
       'كاش - INV-2026-000088 (السعر بعد التعديل 250)', v_target_cb),
      (v_je_id, 2, v_acc_411,  0.00, 250.00,
       'إيراد INV-2026-000088', NULL),
      (v_je_id, 3, v_acc_51,   148.50, 0.00,
       'تكلفة INV-2026-000088', NULL),
      (v_je_id, 4, v_acc_1131, 0.00, 148.50,
       'خصم مخزون INV-2026-000088', NULL);

    UPDATE journal_entries SET is_posted=TRUE, posted_by=v_admin, posted_at=NOW()
     WHERE id = v_je_id;
    RAISE NOTICE 'PR-DRIFT-3E step 3 (INV-088): posted % (Cash 250)', v_entry_no;
  END IF;

  -- ─── INV-2026-000098 — InstaPay 355 ─────────────────────────────────
  SELECT COUNT(*) INTO v_existing FROM journal_entries
   WHERE reference_id = v_inv_098 AND is_void = FALSE;
  IF v_existing = 0 THEN
    v_entry_no := 'JE-2026-' || lpad(nextval('seq_journal_entry_no')::text, 6, '0');
    INSERT INTO journal_entries
      (entry_no, entry_date, description, reference_type, reference_id,
       is_posted, is_void, created_by)
    VALUES
      (v_entry_no, '2026-04-25',
       'قيد فاتورة مبيعات INV-2026-000098 (PR-DRIFT-3E — تصحيح إلى انستا باي)',
       'invoice', v_inv_098, FALSE, FALSE, v_admin)
    RETURNING id INTO v_je_id;

    INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, description, cashbox_id)
    VALUES
      (v_je_id, 1, v_acc_1114, 355.00, 0.00,
       'دفع انستاباي - INV-2026-000098', NULL),
      (v_je_id, 2, v_acc_411,  0.00, 355.00,
       'إيراد INV-2026-000098', NULL),
      (v_je_id, 3, v_acc_51,   207.00, 0.00,
       'تكلفة INV-2026-000098', NULL),
      (v_je_id, 4, v_acc_1131, 0.00, 207.00,
       'خصم مخزون INV-2026-000098', NULL);

    UPDATE journal_entries SET is_posted=TRUE, posted_by=v_admin, posted_at=NOW()
     WHERE id = v_je_id;
    RAISE NOTICE 'PR-DRIFT-3E step 3 (INV-098): posted % (InstaPay 355)', v_entry_no;
  END IF;
END $$;

-- ─── Step 4 — Rebase cashboxes.current_balance to match new CT signed sum ─
DO $$
DECLARE
  v_old_balance numeric;
  v_new_balance numeric;
  v_updated     int;
BEGIN
  SELECT current_balance INTO v_old_balance FROM cashboxes
   WHERE id='524646d5-7bd6-4d8d-a484-b1f562b039a4';
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0)::numeric(18,2)
    INTO v_new_balance FROM cashbox_transactions
   WHERE cashbox_id='524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void,FALSE)=FALSE;
  UPDATE cashboxes
     SET current_balance = v_new_balance,
         updated_at = NOW()
   WHERE id='524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND current_balance <> v_new_balance;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'PR-DRIFT-3E step 4: cashbox balance % → % (delta % EGP, % row(s) updated)',
    v_old_balance, v_new_balance, (v_new_balance - v_old_balance), v_updated;
END $$;

-- ─── Step 5 — financial_anomalies row ────────────────────────────────────
INSERT INTO financial_anomalies
  (severity, anomaly_type, description, affected_entity, reference_id,
   details, detected_at, resolved, resolved_at, resolution_note)
SELECT
  'high',
  'invoice_edit_je_drift',
  '5 invoices on الخزينة الرئيسية carried -1,435 EGP of cashbox-bucket '
   || 'drift caused by an engine bug in editInvoice (pos.service.ts): '
   || 'the cashbox CT got reversed/replayed but the matching journal '
   || 'entry was never updated. Per operator decisions A/A/A/A/A: '
   || 'INV-016 keeps its cash JE (CT 23 reversal voided); '
   || 'INV-069/071/098 reposted as InstaPay (1114); '
   || 'INV-088 reposted as cash 250 (price uplifted from 225). '
   || 'Cashbox balance rebases UP by 410 EGP (CT 23 was OUT 410).',
  'cashboxes',
  '524646d5-7bd6-4d8d-a484-b1f562b039a4',
  jsonb_build_object(
    'pr',                'PR-DRIFT-3E',
    'migration',         '111_pr_drift_3e_invoice_edit_reconciliation',
    'voided_jes',        jsonb_build_array(
                            'JE-2026-000166','JE-2026-000178',
                            'JE-2026-000217','JE-2026-000230'),
    'voided_cts',        jsonb_build_array(23),
    'kept_jes',          jsonb_build_array('JE-2026-000110'),
    'invoices',          jsonb_build_array(
                            'INV-2026-000016','INV-2026-000069',
                            'INV-2026-000071','INV-2026-000088',
                            'INV-2026-000098'),
    'cash_balance_delta', 410.00,
    'instapay_account',   '1114 المحافظ الإلكترونية',
    'cash_account',       '1111 الخزينة الرئيسية (نقدي)',
    'related_pr',         'PR-DRIFT-3F (#147) — cashbox tagging guard'
  ),
  NOW(), TRUE, NOW(),
  'Resolved by migration 111 (PR-DRIFT-3E). 4 stale invoice JEs voided '
   || '+ 4 corrected JEs posted (3 InstaPay on 1114, 1 cash uplift on '
   || '1111). 1 stale edit-reversal CT (id=23 on INV-016) voided. '
   || 'cashboxes.current_balance rebased 16,615 → 17,025 (+410 EGP). '
   || 'Trial balance unchanged. invoice/both bucket closes from -1,435 '
   || 'to 0. Total drift on الخزينة الرئيسية: -1,435 → 0 (only ±10.99 '
   || 'shift noise remains, net 0). Backend prevention: editInvoice now '
   || 'voids+reposts the GL via postInvoiceEdit and skips CT '
   || 'reverse/replay when cash effect is unchanged.'
WHERE NOT EXISTS (
  SELECT 1 FROM financial_anomalies
   WHERE anomaly_type    = 'invoice_edit_je_drift'
     AND affected_entity = 'cashboxes'
     AND reference_id    = '524646d5-7bd6-4d8d-a484-b1f562b039a4'
);

-- ─── Postconditions ──────────────────────────────────────────────────────
DO $$
DECLARE
  v_trial             numeric;
  v_cb_balance        numeric;
  v_active_ct_sum     numeric;
  v_invoice_both_sum  numeric;
  v_invoice_both_rows int;
  v_je_166_void       boolean;
  v_je_178_void       boolean;
  v_je_217_void       boolean;
  v_je_230_void       boolean;
  v_je_110_active     int;
  v_ct_23_void        boolean;
  v_inv_069_je_cash   numeric;
  v_inv_071_je_cash   numeric;
  v_inv_088_je_cash   numeric;
  v_inv_098_je_cash   numeric;
  v_inv_069_inst      numeric;
  v_inv_071_inst      numeric;
  v_inv_098_inst      numeric;
  v_inv_088_je_total  numeric;
BEGIN
  -- (a) trial balance still 0
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)::numeric(18,2)
    INTO v_trial FROM journal_lines jl
    JOIN journal_entries je ON je.id = jl.entry_id
   WHERE je.is_posted=TRUE AND je.is_void=FALSE;
  IF v_trial <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3E post: trial balance %', v_trial;
  END IF;

  -- (b) balance == active CT sum (rebased)
  SELECT current_balance INTO v_cb_balance FROM cashboxes
   WHERE id='524646d5-7bd6-4d8d-a484-b1f562b039a4';
  SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0)
    INTO v_active_ct_sum FROM cashbox_transactions
   WHERE cashbox_id='524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND COALESCE(is_void,FALSE)=FALSE;
  IF v_cb_balance <> v_active_ct_sum THEN
    RAISE EXCEPTION 'PR-DRIFT-3E post: balance % != ct sum %',
      v_cb_balance, v_active_ct_sum;
  END IF;

  -- (c) the 4 target JEs are voided, JE-110 still active
  SELECT is_void INTO v_je_166_void FROM journal_entries WHERE entry_no='JE-2026-000166';
  SELECT is_void INTO v_je_178_void FROM journal_entries WHERE entry_no='JE-2026-000178';
  SELECT is_void INTO v_je_217_void FROM journal_entries WHERE entry_no='JE-2026-000217';
  SELECT is_void INTO v_je_230_void FROM journal_entries WHERE entry_no='JE-2026-000230';
  IF NOT v_je_166_void THEN RAISE EXCEPTION 'PR-DRIFT-3E post: JE-166 not voided'; END IF;
  IF NOT v_je_178_void THEN RAISE EXCEPTION 'PR-DRIFT-3E post: JE-178 not voided'; END IF;
  IF NOT v_je_217_void THEN RAISE EXCEPTION 'PR-DRIFT-3E post: JE-217 not voided'; END IF;
  IF NOT v_je_230_void THEN RAISE EXCEPTION 'PR-DRIFT-3E post: JE-230 not voided'; END IF;
  SELECT COUNT(*) INTO v_je_110_active FROM journal_entries
   WHERE entry_no='JE-2026-000110' AND is_void=FALSE AND is_posted=TRUE;
  IF v_je_110_active <> 1 THEN RAISE EXCEPTION 'PR-DRIFT-3E post: JE-110 not active'; END IF;

  -- (d) CT 23 voided
  SELECT is_void INTO v_ct_23_void FROM cashbox_transactions WHERE id=23;
  IF NOT v_ct_23_void THEN RAISE EXCEPTION 'PR-DRIFT-3E post: CT 23 not voided'; END IF;

  -- (e) INV-069/071/098: no cash leg in active JE, instapay 1114 = expected
  SELECT COALESCE(SUM(jl.debit-jl.credit),0)::numeric(18,2) INTO v_inv_069_je_cash
    FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
    JOIN chart_of_accounts a ON a.id=jl.account_id
   WHERE je.reference_id='4a404583-1e37-496b-9608-dcd321eb5b67'
     AND je.is_void=FALSE AND a.code='1111';
  SELECT COALESCE(SUM(jl.debit-jl.credit),0)::numeric(18,2) INTO v_inv_069_inst
    FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
    JOIN chart_of_accounts a ON a.id=jl.account_id
   WHERE je.reference_id='4a404583-1e37-496b-9608-dcd321eb5b67'
     AND je.is_void=FALSE AND a.code='1114';
  IF v_inv_069_je_cash <> 0 OR v_inv_069_inst <> 300 THEN
    RAISE EXCEPTION 'PR-DRIFT-3E post: INV-069 cash=% instapay=% (expected 0 / 300)',
      v_inv_069_je_cash, v_inv_069_inst;
  END IF;

  SELECT COALESCE(SUM(jl.debit-jl.credit),0)::numeric(18,2) INTO v_inv_071_je_cash
    FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
    JOIN chart_of_accounts a ON a.id=jl.account_id
   WHERE je.reference_id='4df64c87-933c-415f-9120-36be3d956d12'
     AND je.is_void=FALSE AND a.code='1111';
  SELECT COALESCE(SUM(jl.debit-jl.credit),0)::numeric(18,2) INTO v_inv_071_inst
    FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
    JOIN chart_of_accounts a ON a.id=jl.account_id
   WHERE je.reference_id='4df64c87-933c-415f-9120-36be3d956d12'
     AND je.is_void=FALSE AND a.code='1114';
  IF v_inv_071_je_cash <> 0 OR v_inv_071_inst <> 395 THEN
    RAISE EXCEPTION 'PR-DRIFT-3E post: INV-071 cash=% instapay=% (expected 0 / 395)',
      v_inv_071_je_cash, v_inv_071_inst;
  END IF;

  SELECT COALESCE(SUM(jl.debit-jl.credit),0)::numeric(18,2) INTO v_inv_098_je_cash
    FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
    JOIN chart_of_accounts a ON a.id=jl.account_id
   WHERE je.reference_id='249ebbb0-aeb6-45cf-82f1-6b4cae416c6f'
     AND je.is_void=FALSE AND a.code='1111';
  SELECT COALESCE(SUM(jl.debit-jl.credit),0)::numeric(18,2) INTO v_inv_098_inst
    FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
    JOIN chart_of_accounts a ON a.id=jl.account_id
   WHERE je.reference_id='249ebbb0-aeb6-45cf-82f1-6b4cae416c6f'
     AND je.is_void=FALSE AND a.code='1114';
  IF v_inv_098_je_cash <> 0 OR v_inv_098_inst <> 355 THEN
    RAISE EXCEPTION 'PR-DRIFT-3E post: INV-098 cash=% instapay=% (expected 0 / 355)',
      v_inv_098_je_cash, v_inv_098_inst;
  END IF;

  -- (f) INV-088: cash leg now 250
  SELECT COALESCE(SUM(jl.debit-jl.credit),0)::numeric(18,2) INTO v_inv_088_je_cash
    FROM journal_entries je JOIN journal_lines jl ON jl.entry_id=je.id
    JOIN chart_of_accounts a ON a.id=jl.account_id
   WHERE je.reference_id='3921d4d5-2695-4e61-a5d2-07b2621d6d72'
     AND je.is_void=FALSE AND a.code='1111';
  IF v_inv_088_je_cash <> 250 THEN
    RAISE EXCEPTION 'PR-DRIFT-3E post: INV-088 cash leg %, expected 250',
      v_inv_088_je_cash;
  END IF;

  -- (g) invoice/both drift bucket on target cashbox = 0
  SELECT COALESCE(SUM(drift_amount),0)::numeric(18,2),
         COUNT(*)
    INTO v_invoice_both_sum, v_invoice_both_rows
    FROM v_cashbox_drift_per_ref
   WHERE cashbox_id='524646d5-7bd6-4d8d-a484-b1f562b039a4'
     AND reference_type='invoice' AND coverage='both';
  IF v_invoice_both_sum <> 0 THEN
    RAISE EXCEPTION 'PR-DRIFT-3E post: invoice/both drift sum %, expected 0',
      v_invoice_both_sum;
  END IF;

  RAISE NOTICE 'PR-DRIFT-3E post OK: balance=% trial=0 invoice_both_sum=% (rows=%)',
    v_cb_balance, v_invoice_both_sum, v_invoice_both_rows;
END $$;

COMMIT;
