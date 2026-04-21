-- 042_shift_close_approval.sql
-- -----------------------------------------------------------------------------
-- Adds a "request close → admin approves" flow for cashier shifts.
-- The shift_status enum grows a `pending_close` value; the shifts table
-- tracks who requested the close, when, optional notes and cash amount,
-- and the final decision (approver, timestamp, rejection reason).
--
-- All additive — nothing in the existing close path is removed, so any
-- user with shifts.close_approve keeps the ability to finalize a shift
-- in one step.
-- -----------------------------------------------------------------------------

ALTER TYPE shift_status ADD VALUE IF NOT EXISTS 'pending_close';

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS close_requested_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS close_requested_by     UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS close_requested_notes  TEXT,
  ADD COLUMN IF NOT EXISTS close_requested_amount NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS close_approved_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS close_approved_by      UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS close_rejection_reason TEXT;
