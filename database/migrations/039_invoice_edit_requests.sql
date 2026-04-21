-- 039_invoice_edit_requests.sql
-- -----------------------------------------------------------------------------
-- Approval workflow for invoice edits.
--
-- Users who can open the edit modal but don't hold invoices.edit submit a
-- pending request here with the full proposed payload. A system admin (or
-- anyone with invoices.edit_approve) approves or rejects; approval actually
-- applies the edit through the same editInvoice path and writes a row into
-- invoice_edit_history.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS invoice_edit_requests (
  id                 BIGSERIAL PRIMARY KEY,
  invoice_id         UUID        NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  requested_by       UUID        NOT NULL REFERENCES users(id),
  requested_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason             TEXT,
  proposed_changes   JSONB       NOT NULL,
  status             VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by         UUID        REFERENCES users(id),
  decided_at         TIMESTAMPTZ,
  decision_reason    TEXT,
  history_id         BIGINT      REFERENCES invoice_edit_history(id)
);

CREATE INDEX IF NOT EXISTS ix_iedit_req_invoice
  ON invoice_edit_requests(invoice_id, requested_at DESC);

CREATE INDEX IF NOT EXISTS ix_iedit_req_status
  ON invoice_edit_requests(status, requested_at DESC)
  WHERE status = 'pending';
