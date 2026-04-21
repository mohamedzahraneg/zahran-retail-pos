-- 044_supplier_payment_schedule.sql
-- -----------------------------------------------------------------------------
-- Weekly payment plan per supplier:
--   payment_day_of_week         0..6 (Sun..Sat) — null = no schedule
--   payment_installment_amount  EGP per scheduled payment
--   last_payment_reminder_at    so the UI can dedupe alerts per day
-- Additive only.
-- -----------------------------------------------------------------------------

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS payment_day_of_week        SMALLINT,
  ADD COLUMN IF NOT EXISTS payment_installment_amount NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS last_payment_reminder_at   TIMESTAMPTZ;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'suppliers_dow_chk'
  ) THEN
    ALTER TABLE suppliers ADD CONSTRAINT suppliers_dow_chk
      CHECK (payment_day_of_week IS NULL OR
             payment_day_of_week BETWEEN 0 AND 6);
  END IF;
END $$;
