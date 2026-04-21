-- Migration 047: alerts for recurring expenses (due + upcoming)
-- ---------------------------------------------------------------------------
-- Adds a dedicated alert_type so the notifications feed can surface
-- recurring-expense events without masquerading as 'custom'. Also adds
-- a helper index used by the daily scheduler.

BEGIN;

-- Extend the alert_type enum only if the value is missing (the enum was
-- frozen at module 010 — we append idempotently).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'alert_type' AND e.enumlabel = 'recurring_expense_due'
  ) THEN
    ALTER TYPE alert_type ADD VALUE 'recurring_expense_due';
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum e
    JOIN pg_type t ON t.oid = e.enumtypid
    WHERE t.typname = 'alert_type' AND e.enumlabel = 'recurring_expense_upcoming'
  ) THEN
    ALTER TYPE alert_type ADD VALUE 'recurring_expense_upcoming';
  END IF;
END$$;

-- Helper index so the daily scheduler can quickly find due templates.
CREATE INDEX IF NOT EXISTS idx_recurring_expenses_next_run
  ON recurring_expenses(next_run_date)
  WHERE status = 'active';

COMMIT;
