-- Migration 093 — Add expenses.shift_id for Daily Expenses (PR-2 of 4).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Today every expense already auto-resolves a cashbox from the
--   user's open shift (accounting.service.ts:108-117) but the SHIFT
--   itself is not recorded on the row. Other shift-aware tables
--   (invoices, customer_payments, supplier_payments,
--   employee_deductions) already have this column. Expenses had been
--   the odd one out — close-out reconciliation, daily registers, and
--   the new expense analytics (PR-3 / PR-4) all need to filter
--   "expenses for shift X".
--
-- Change
--
--   1. ADD COLUMN expenses.shift_id UUID NULL REFERENCES shifts(id)
--      ON DELETE SET NULL — soft FK so deleting a shift in dev
--      doesn't cascade-orphan the expense row.
--
--   2. CREATE INDEX ix_expenses_shift on (shift_id) for the register
--      filter and the per-shift rollup. Partial — only rows with a
--      shift link occupy index space.
--
--   3. Backfill: for historical rows where (cashbox_id, expense_date)
--      uniquely identifies a single shift, populate shift_id. Skipped
--      for rows that pre-date the shift system or that span multiple
--      open shifts on the same cashbox/date — those stay NULL,
--      which is fine.
--
-- Not touched
--   * Any GL line, journal_entry, cashbox_transaction.
--   * fn_record_cashbox_txn or its callers.
--   * FinancialEngine / accounting math.
--   * Other shift_id columns on other tables.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS shift_id uuid NULL REFERENCES public.shifts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_expenses_shift
  ON public.expenses (shift_id)
  WHERE shift_id IS NOT NULL;

COMMENT ON COLUMN public.expenses.shift_id IS
  'Open shift the expense was recorded under (PR-2 Daily Expenses series). Auto-populated by accounting.service.ts.createExpense from shifts WHERE opened_by=$user AND status=open. NULL for non-cashier expenses or pre-PR-2 history.';

-- ─── Backfill: only the unambiguous case ────────────────────────────────────
-- For each historical expense, find the single shift whose:
--   * cashbox_id matches the expense's cashbox_id
--   * window covers the expense's created_at (between opened_at and
--     COALESCE(closed_at, NOW()))
-- If exactly one match, populate shift_id. Otherwise leave NULL.

DO $$
DECLARE
  v_updated int;
BEGIN
  PERFORM set_config('app.engine_context', 'migration:093_expenses_shift_linkage', true);

  WITH candidate AS (
    SELECT e.id AS expense_id,
           (
             SELECT s.id
               FROM shifts s
              WHERE s.cashbox_id = e.cashbox_id
                AND s.opened_at <= e.created_at
                AND COALESCE(s.closed_at, NOW()) >= e.created_at
              LIMIT 2
           ) AS one_shift,
           (
             SELECT COUNT(*)::int
               FROM shifts s
              WHERE s.cashbox_id = e.cashbox_id
                AND s.opened_at <= e.created_at
                AND COALESCE(s.closed_at, NOW()) >= e.created_at
           ) AS match_count
      FROM expenses e
     WHERE e.shift_id IS NULL
       AND e.cashbox_id IS NOT NULL
  )
  UPDATE expenses e
     SET shift_id = c.one_shift
    FROM candidate c
   WHERE e.id = c.expense_id
     AND c.match_count = 1
     AND c.one_shift IS NOT NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'migration 093 backfill: % expenses linked to a unique historical shift', v_updated;
END $$;

COMMIT;
