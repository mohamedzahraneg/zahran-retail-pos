-- Migration 088 — Hotfix: settlement direction was inverted for cash/bank.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Bug surfaced during PR-1 / PR-2 follow-up audit on Abu Youssef.
--
--   EmployeesService.recordSettlement (cash/bank branch) posted:
--     DR cashbox / CR 1123  +  cashbox 'in'
--   The actual usage of every real caller (pay-wage payable settle,
--   pay-wage bonus settle, POST /payroll type='payout', the settlement
--   modal) is "company pays employee" — which needs:
--     DR 213 / CR cashbox  +  cashbox 'out'
--
--   The wrong direction surfaced as Abu Youssef's GL going from
--   −1150 → −1250 after a 100 EGP cash payout (expected −1050).
--   Trial balance stayed 0 (each JE is internally balanced) and the
--   weekly drift check kept passing — the drift is per-employee +
--   per-cashbox, not ledger-wide, which is why earlier checks missed.
--
--   The code fix lands in a paired commit on this branch
--   (employees.service.ts) — flips cash/bank legs and the cashbox
--   direction. payroll_deduction and other branches stay unchanged.
--
-- Live state we're correcting (verified 2026-04-25)
--
--   employee_settlements id=7  (Abu Youssef — username 'abo')
--     amount=100, method=cash, cashbox_id=524646d5-…b039a4
--     journal_entry_id = d695de62-…0212  (JE-2026-000193)
--     cashbox_transactions id=105: direction='in', +100 (WRONG)
--   GL: -1250  →  expected -1050
--   Cashbox 524646d5: 10204.00  →  expected 10004.00
--
-- The 2 historic 0.01 settlements (#4, #5) had the same bug shape but
-- were already cleaned up by migration 078: their JEs are voided and
-- their cashbox rows are netted to zero by reversal rows #101/#102.
-- They're left alone — no action required.
--
-- Strategy
--
--   1. Run under engine context `migration:088_settlement_direction_fix`
--      so the void UPDATE on journal_entries passes migration 068's
--      enforcement trigger.
--
--   2. UPDATE journal_entries SET is_void=true for JE-000193 (the
--      wrong settlement JE). Trial-balance is unaffected because
--      v_employee_gl_balance and other aggregates already filter
--      `is_void = FALSE`.
--
--   3. Reverse the wrong cashbox movement via fn_record_cashbox_txn —
--      the canonical helper that atomically inserts a row AND updates
--      cashboxes.current_balance. Same pattern migration 078 used.
--      Direction='out', category='employee_settlement_direction_fix'.
--      Net cashbox effect: 10204 → 10104 (back to pre-bug state).
--
--   4. Post a NEW corrective JE (DR 213 / CR 1111) for Abu Youssef
--      with reference_type='employee_settlement' and a deterministic
--      reference_id derived from the settlement id. Engine context
--      already set above.
--
--   5. Post a NEW cashbox row via fn_record_cashbox_txn('out', 100)
--      tied to the new JE. Net cashbox effect: 10104 → 10004 (the
--      real payout to Abu Youssef finally reflected correctly).
--
--   6. Update employee_settlements.journal_entry_id to point to the
--      new JE so downstream audits reconcile.
--
-- Expected end state
--
--   * v_employee_gl_balance for Abu Youssef = -1050 ✅
--   * v_employee_gl_balance for Mohamed El-Zebaty = unchanged (his
--     previous 100 went through the advance branch, not this code
--     path, and is correct)
--   * cashbox 524646d5 current_balance = 10004.00 ✅
--   * Trial balance = 0
--   * Each affected JE is internally balanced (DR = CR)
--   * Audit trail preserved — no DELETEs, only is_void flags + new
--     corrective rows
--
-- Not touched
--   * fn_record_cashbox_txn / cashbox triggers
--   * payroll_deduction / other settlement branches
--   * Mohamed's data (he never went through cash/bank settlement)
--   * Settlements #4, #5 (already cleaned up by migration 078)
--   * 1123 advance path / fn_post_employee_advance / wage accrual
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:088_settlement_direction_fix',
  true
);

DO $$
DECLARE
  -- Pinned settlement we're fixing.
  v_settlement_id   bigint := 7;
  v_user_id         uuid   := '3800f38b-cdb9-4347-bf83-2ffc215efd1f';   -- abo / Abu Youssef
  v_amount          numeric(14,2) := 100.00;
  v_cashbox_id      uuid   := '524646d5-7bd6-4d8d-a484-b1f562b039a4';
  v_old_je_id       uuid   := 'd695de62-635d-4b79-9c02-c348619b0212';   -- JE-2026-000193
  v_created_by      uuid;

  -- New JE / line vars
  v_dr_acct         uuid;
  v_cr_acct         uuid;
  v_new_je_id       uuid;
  v_new_entry_no    text;
  v_year            int := EXTRACT(YEAR FROM CURRENT_DATE)::int;
  v_max             int;
  v_new_ref_id      uuid;
  v_desc            text := 'تصحيح اتجاه التسوية رقم 7 — صرف نقدي لصالح الموظف ابو يوسف (DR 213 / CR 1111)';
  v_reversal_desc   text := 'تصحيح اتجاه التسوية رقم 7 — عكس إدخال الخزنة الخاطئ (in 100 → out 100)';
BEGIN
  -- Sanity: only run if the wrong JE is still active. Idempotent.
  IF NOT EXISTS (
    SELECT 1 FROM journal_entries
     WHERE id = v_old_je_id AND is_void = FALSE
  ) THEN
    RAISE NOTICE 'migration 088: JE-2026-000193 already voided — skipping (already corrected)';
    RETURN;
  END IF;

  -- Fetch the original creator for audit consistency on the new rows.
  SELECT created_by INTO v_created_by
    FROM employee_settlements WHERE id = v_settlement_id;
  IF v_created_by IS NULL THEN
    RAISE EXCEPTION 'migration 088: cannot resolve created_by for settlement %', v_settlement_id;
  END IF;

  -- ── Step 1: void the wrong settlement JE ────────────────────────────────
  UPDATE journal_entries
     SET is_void     = TRUE,
         voided_at   = NOW(),
         void_reason = 'migration 088 — wrong settlement direction (was DR cashbox / CR 1123, should be DR 213 / CR cashbox)'
   WHERE id = v_old_je_id;

  -- ── Step 2: reverse the wrong cashbox 'in' via canonical helper ─────────
  PERFORM fn_record_cashbox_txn(
    v_cashbox_id,
    'out',
    v_amount,
    'employee_settlement_direction_fix',
    'other'::entity_type,
    v_old_je_id,
    v_created_by,
    v_reversal_desc
  );

  -- ── Step 3: build + post the new corrective JE ──────────────────────────
  v_dr_acct := fn_account_id('213');
  v_cr_acct := fn_account_id('1111');
  IF v_dr_acct IS NULL OR v_cr_acct IS NULL THEN
    RAISE EXCEPTION 'migration 088: COA 213/1111 missing';
  END IF;

  SELECT COALESCE(MAX(SUBSTRING(entry_no FROM 'JE-[0-9]+-([0-9]+)')::int), 0)
    INTO v_max FROM journal_entries WHERE entry_no LIKE 'JE-' || v_year || '-%';
  v_new_entry_no := 'JE-' || v_year || '-' || lpad((v_max + 1)::text, 6, '0');

  v_new_ref_id := uuid_generate_v5(
    uuid_ns_oid(),
    'employee_settlement_direction_fix:' || v_settlement_id::text
  );

  INSERT INTO journal_entries
    (entry_no, entry_date, description, reference_type, reference_id,
     is_posted, created_by, created_at)
  VALUES (v_new_entry_no, CURRENT_DATE, v_desc,
          'employee_settlement', v_new_ref_id,
          FALSE, v_created_by, NOW())
  RETURNING id INTO v_new_je_id;

  INSERT INTO journal_lines
    (entry_id, line_no, account_id, debit, credit, description,
     employee_id, employee_user_id)
  VALUES
    (v_new_je_id, 1, v_dr_acct, v_amount, 0, v_desc,
     v_user_id, v_user_id),
    (v_new_je_id, 2, v_cr_acct, 0, v_amount, v_desc,
     NULL, NULL);

  UPDATE journal_entries
     SET is_posted = TRUE, posted_by = v_created_by, posted_at = NOW()
   WHERE id = v_new_je_id;

  -- ── Step 4: post the real cashbox 'out' tied to the new JE ──────────────
  PERFORM fn_record_cashbox_txn(
    v_cashbox_id,
    'out',
    v_amount,
    'employee_settlement',
    'other'::entity_type,
    v_new_je_id,
    v_created_by,
    'صرف فعلي للموظف ابو يوسف — تسوية رقم 7 (تصحيح اتجاه)'
  );

  -- ── Step 5: rewire employee_settlements to the new JE ────────────────────
  UPDATE employee_settlements
     SET journal_entry_id = v_new_je_id
   WHERE id = v_settlement_id;

  RAISE NOTICE 'migration 088 cleanup: voided JE % ; posted new JE % ; cashbox 524646d5 corrected by -200',
               v_old_je_id, v_new_je_id;
END $$;

-- ── Resolved financial_anomalies for the bypass twin-lookup ─────────────
-- The void UPDATE on journal_entries + the new INSERT may surface as
-- bypass alerts depending on the live guard config. Insert paired
-- resolved rows so the drift check counts them as triaged (same
-- pattern as migrations 072 / 079 / 085).
INSERT INTO financial_anomalies
  (severity, anomaly_type, description, affected_entity, reference_id,
   details, detected_at, resolved, resolved_at, resolution_note)
VALUES
  ('low', 'legacy_bypass_journal_entry',
   'Controlled cleanup from migration 088 — voided wrong-direction settlement JE for Abu Youssef (id=7).',
   'journal_entries', 'd695de62-635d-4b79-9c02-c348619b0212',
   jsonb_build_object(
     'migration', '088_hotfix_settlement_direction',
     'intent', 'void',
     'settlement_id', 7,
     'reason', 'recordSettlement cash/bank posted DR cashbox/CR 1123; canonical is DR 213/CR cashbox'
   ),
   NOW(), TRUE, NOW(),
   'Intentional cleanup — migration 088 corrects settlement direction; new JE posted in the same migration.'),
  ('low', 'legacy_bypass_journal_entry',
   'Controlled cleanup from migration 088 — corrective settlement JE posted for Abu Youssef (id=7).',
   'journal_entries', '00000000-0000-0000-0000-000000000088',
   jsonb_build_object(
     'migration', '088_hotfix_settlement_direction',
     'intent', 'post_corrective',
     'settlement_id', 7,
     'gl_lines', 'DR 213 / CR 1111'
   ),
   NOW(), TRUE, NOW(),
   'Intentional corrective post — pairs with the void above. Net cashbox effect −200 (undo wrong +100, post real −100).');

COMMIT;
