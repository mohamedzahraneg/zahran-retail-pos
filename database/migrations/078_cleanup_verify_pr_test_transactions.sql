-- Migration 078 — Clean up VERIFY_PR* live verification transactions.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   During PR #77 / #78 / #79 post-deploy verifications, we posted a
--   handful of 0.01 EGP and 0.01 EGP test transactions against
--   محمد الظباطي's account with markers like "VERIFY_PR77_bonus",
--   "VERIFY_PR77_deduction", "VERIFY_PR78_payout_v2",
--   "VERIFY_PR79_trigger_bonus", "VERIFY_PR79_engine_payout". They
--   served their purpose (proving the canonical write paths work),
--   but now show up in the Payroll UI as real account activity.
--
--   This migration VOIDs those rows (not deletes — audit trail is
--   preserved), using the existing trigger cascades where possible
--   and direct engine-context SQL for the settlement rows that
--   don't cascade.
--
-- Audit target (live, as of 2026-04-24 18:15 UTC)
--
--   bonus id=7    VERIFY_PR77_bonus          0.01 EGP   مكافأة
--   bonus id=8    VERIFY_PR79_trigger_bonus  0.01 EGP   مكافأة
--   deduction id=5 VERIFY_PR77_deduction     0.01 EGP   خصم
--   settlement id=4 VERIFY_PR78_payout_v2    0.01 EGP   payout (cash out)
--   settlement id=5 VERIFY_PR79_engine_payout 0.01 EGP  payout (cash out)
--
-- Mechanism per row type
--
--   * employee_bonuses & employee_deductions:
--     UPDATE is_void=true. Migration 040's fn_mirror_{bonus,deduction}_
--     to_txn trigger DELETEs the mirrored employee_transactions row
--     on the is_void flip. That DELETE fires migration 038's
--     fn_trg_employee_txn_post which UPDATEs journal_entries SET
--     is_void=true for the matching employee_txn reference. End
--     state: source row + mirror row + JE all voided. Trial balance
--     query filters `NOT je.is_void` → GL effect unwound.
--
--   * employee_settlements:
--     migration 076 dropped the settlement mirror, so there is no
--     cascade. We handle it by (a) posting a reversing
--     cashbox_transactions row via fn_record_cashbox_txn (direction=
--     'out'), which atomically decrements cashboxes.current_balance
--     — the canonical reversal, no direct balance tinkering; then
--     (b) UPDATE journal_entries.is_void=true for the settlement JE
--     under the `engine:migration` context the migration already
--     runs with; then (c) UPDATE employee_settlements.is_void=true
--     so the Payroll UNION query hides the row.
--
-- What this migration does NOT touch
--   * FinancialEngine
--   * Accounting formulas
--   * Schema
--   * Source rows that don't carry the VERIFY_PR marker
--   * journal_entries / journal_lines / cashbox_transactions beyond
--     the explicit cleanup actions above. No DELETE anywhere.
--   * Any row on employee_settlements where notes don't match.
--
-- Rollback
--
--   Every affected source row has `is_void=true, voided_at, void_reason`
--   — set is_void=false to restore (though cascade-voided JEs would
--   need manual repost). Cashbox reversal rows are immutable but
--   another reversal (direction='in') would restore the balance.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Migration-wide engine context so the void UPDATEs on journal_entries
-- pass the fn_engine_write_allowed guard (migration 068).
SELECT set_config(
  'app.engine_context',
  'migration:078_cleanup_verify_pr_tests',
  true
);

-- ─── 1. Bonuses — cascade-void (trigger chain handles GL + mirror) ────────
UPDATE employee_bonuses
   SET is_void     = true,
       voided_at   = NOW(),
       void_reason = COALESCE(void_reason, 'VERIFY_PR test cleanup (migration 078)')
 WHERE note LIKE 'VERIFY_PR%'
   AND is_void = false;

-- ─── 2. Deductions — cascade-void ─────────────────────────────────────────
UPDATE employee_deductions
   SET is_void     = true,
       voided_at   = NOW(),
       void_reason = COALESCE(void_reason, 'VERIFY_PR test cleanup (migration 078)')
 WHERE reason LIKE 'VERIFY_PR%'
   AND is_void = false;

-- ─── 3. Settlements — explicit three-step reversal ────────────────────────
DO $$
DECLARE
  s record;
BEGIN
  FOR s IN
    SELECT id, user_id, amount, method, cashbox_id, notes,
           journal_entry_id, created_by
      FROM employee_settlements
     WHERE notes LIKE 'VERIFY_PR%'
       AND is_void = false
  LOOP
    -- (a) Reverse the cashbox movement if it actually happened.
    --     fn_record_cashbox_txn atomically inserts the row AND
    --     decrements cashboxes.current_balance — no manual balance
    --     update anywhere.
    IF s.method IN ('cash', 'bank') AND s.cashbox_id IS NOT NULL THEN
      PERFORM fn_record_cashbox_txn(
        s.cashbox_id,
        'out',
        s.amount,
        'employee_settlement_reversal',
        'other',                                            -- reference_type enum
        s.journal_entry_id,                                 -- reference_id links back to the original JE
        s.created_by,
        'VERIFY_PR test cleanup — reversing settlement id=' || s.id::text
      );
    END IF;

    -- (b) Void the original settlement JE. Engine context set at
    --     the top of the migration allows this write.
    IF s.journal_entry_id IS NOT NULL THEN
      UPDATE journal_entries
         SET is_void     = true,
             voided_at   = NOW(),
             void_reason = 'VERIFY_PR test cleanup (migration 078)'
       WHERE id = s.journal_entry_id
         AND is_void = false;
    END IF;

    -- (c) Void the settlement row so the Payroll UNION hides it.
    UPDATE employee_settlements
       SET is_void     = true,
           voided_at   = NOW(),
           void_reason = 'VERIFY_PR test cleanup (migration 078)'
     WHERE id = s.id;
  END LOOP;
END$$;

COMMIT;
