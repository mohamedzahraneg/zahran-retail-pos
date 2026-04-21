-- 045_standalone_returns.sql
-- -----------------------------------------------------------------------------
-- Allow returns without an original invoice (walk-in refund flow).
-- Loosens the NOT NULL on returns.original_invoice_id so we can accept a
-- direct-return where the customer lost the receipt or we're taking the
-- product back as goodwill.
--
-- Additive — existing rows are unaffected.
-- -----------------------------------------------------------------------------

ALTER TABLE returns
  ALTER COLUMN original_invoice_id DROP NOT NULL;
