-- 038_invoice_edit_in_place.sql
-- -----------------------------------------------------------------------------
-- Keep invoices editable in place while retaining the full audit trail.
--
-- The previous "edit" flow voided the original invoice and created a new one
-- with a different invoice_no. Operationally that's fine but customers and
-- auditors expected the invoice number to stay stable across edits, with a
-- running history of what changed.
--
-- This migration:
--   1. Adds an `invoice_edit_history` table that captures a JSONB snapshot of
--      the invoice + items + payments BEFORE each change, plus the editor and
--      reason.
--   2. Adds `edit_count` and `last_edited_at` columns on `invoices` so we can
--      surface a badge in the UI without scanning the history table.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invoice_edit_history (
  id               BIGSERIAL PRIMARY KEY,
  invoice_id       UUID        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  edited_by        UUID        REFERENCES users(id),
  edited_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason           TEXT,
  -- Full snapshot of the invoice row + items[] + payments[] prior to the edit.
  before_snapshot  JSONB       NOT NULL,
  -- Summary of the new values (grand_total, items count, ...) for quick UI.
  after_summary    JSONB
);

CREATE INDEX IF NOT EXISTS ix_invoice_edit_history_invoice
  ON invoice_edit_history(invoice_id, edited_at DESC);

ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS edit_count     INT         NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS last_edited_at TIMESTAMPTZ;
