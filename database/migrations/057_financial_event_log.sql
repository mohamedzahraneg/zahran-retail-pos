-- Migration 057: financial_event_log — audit trail for every engine call
-- ---------------------------------------------------------------------------
-- FinancialEngineService (backend/src/chart-of-accounts/financial-engine.service.ts)
-- is now the single primitive through which every money mutation flows.
-- This migration creates the write-once audit log it emits a row into on
-- every successful recordTransaction() call.
--
-- Purpose:
--   1. Independent audit trail — journal_entries is the source of truth
--      for the GL; this table records "who/what called the engine",
--      including the transaction kind (sale / expense / supplier_payment
--      / shift_variance / opening_balance / ...), the source reference,
--      and the amount. Lets support reconstruct "what was the sequence
--      of engine calls on 2026-04-22" without digging through GL lines.
--
--   2. Idempotency verification — the engine guards against replays via
--      journal_entries (reference_type, reference_id) but this extra
--      layer lets ops confirm that exactly one engine call produced
--      each live entry. A mismatch between rows here and live GL entries
--      is a reconciliation signal.
--
--   3. Regret-free performance — if writing this row ever becomes a
--      bottleneck we can truncate/partition without affecting the GL.
--      The engine wraps the INSERT in a try/catch so an older DB without
--      this table keeps working.
--
-- Non-destructive, idempotent. Safe to run on any DB state.

BEGIN;

CREATE TABLE IF NOT EXISTS financial_event_log (
  id              BIGSERIAL PRIMARY KEY,
  event_kind      TEXT NOT NULL,
  reference_type  TEXT NOT NULL,
  reference_id    UUID NOT NULL,
  entry_id        UUID REFERENCES journal_entries(id) ON DELETE SET NULL,
  amount          NUMERIC(14, 2) NOT NULL,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fel_reference
  ON financial_event_log (reference_type, reference_id);

CREATE INDEX IF NOT EXISTS idx_fel_entry
  ON financial_event_log (entry_id);

CREATE INDEX IF NOT EXISTS idx_fel_kind_time
  ON financial_event_log (event_kind, created_at DESC);

-- Read-only once written — no updates, no deletes. Enforced by a trigger
-- rather than a permission so the constraint travels with the table.
CREATE OR REPLACE FUNCTION fn_fel_append_only()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'financial_event_log is append-only (tried %)', TG_OP;
END;
$$;

DROP TRIGGER IF EXISTS trg_fel_no_update ON financial_event_log;
CREATE TRIGGER trg_fel_no_update
  BEFORE UPDATE OR DELETE ON financial_event_log
  FOR EACH ROW EXECUTE FUNCTION fn_fel_append_only();

COMMENT ON TABLE financial_event_log IS
  'Append-only audit of every FinancialEngineService.recordTransaction() call. One row per successful engine invocation. Read-only after insert.';

COMMIT;
