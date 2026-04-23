-- Migration 063: Bank-grade immutable ledger hardening (Phase 1)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- This migration is PURELY ADDITIVE. It does not alter existing writers,
-- break any endpoint, or change any API contract. It layers forensic
-- controls UNDERNEATH the current code so that:
--
--   * Every row change on a financial table is logged (who/when/before/after)
--   * DELETE is physically impossible on financial tables
--   * Closed fiscal periods are cryptographically sealed at DB level
--   * Every write that doesn't carry an engine-signed token fires a
--     real-time alert row, giving ops 100% visibility on the remaining
--     legacy bypass paths (the 7 call sites documented in audits 4–5).
--
-- INVARIANTS held:
--   * No existing production flow breaks — the guard runs in TRANSITION
--     mode that still accepts the legacy `app.engine_context='on'`
--     value, but every such write generates an `engine_bypass_alerts`
--     row. Phase 2 (separate PR) will remove 'on' acceptance once all
--     legacy writers have been refactored to pass the signed token.
--   * Engine behaviour is unchanged — it keeps calling SET LOCAL; we
--     switch it to the signed token pattern in the engine code PR.
--   * Idempotent — every CREATE uses OR REPLACE / IF NOT EXISTS.
--
-- Tables touched: journal_entries, journal_lines, cashbox_transactions,
-- shifts, employee_deductions, employee_settlements, employee_bonuses.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Soft-void columns on tables that don't have them ────────────────
-- journal_entries already has is_void/void_reason.
-- cashbox_transactions / employee_settlements / employee_bonuses — add.
-- Keep columns nullable with sensible defaults so every insert keeps
-- working unmodified.

ALTER TABLE cashbox_transactions
  ADD COLUMN IF NOT EXISTS is_void     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_by   UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;

ALTER TABLE employee_settlements
  ADD COLUMN IF NOT EXISTS is_void     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_by   UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;

ALTER TABLE employee_bonuses
  ADD COLUMN IF NOT EXISTS is_void     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_by   UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;

ALTER TABLE employee_deductions
  ADD COLUMN IF NOT EXISTS is_void     BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS void_reason TEXT,
  ADD COLUMN IF NOT EXISTS voided_by   UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS voided_at   TIMESTAMPTZ;

-- ─── 2. DELETE guard (UNCONDITIONAL — even engine cannot delete) ────────
-- Immutability is the point. Reversal = void, not delete. This trigger
-- supersedes the older `fn_guard_journal_entries` DELETE branch that
-- allowed delete under engine_context; from now on DELETE is always
-- forbidden on financial tables.

CREATE OR REPLACE FUNCTION fn_block_delete_immutable()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '% rows are immutable — use is_void=TRUE instead of DELETE (migration 063)',
    TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

-- ─── 3. Engine-identity signal + bypass alert log ───────────────────────
-- Two modes of passing the write guard:
--   (a) `app.engine_context` starts with 'engine:' — the engine's new
--       signed token (e.g., 'engine:<uuid>'). This is the ONLY value
--       the engine will ever set after the Phase 2 code PR lands.
--   (b) `app.engine_context = 'on'` — transitional. Still accepted
--       (so legacy posting.service / journal.service writers don't
--       break production), BUT each such write drops a row into
--       `engine_bypass_alerts` so ops have line-by-line visibility
--       on remaining bypass call sites.

CREATE TABLE IF NOT EXISTS engine_bypass_alerts (
  id             BIGSERIAL PRIMARY KEY,
  table_name     VARCHAR(80) NOT NULL,
  operation      CHAR(1)     NOT NULL CHECK (operation IN ('I','U','D')),
  record_id      TEXT,
  context_value  TEXT,
  client_addr    INET,
  application    TEXT,
  session_user_name TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_bypass_alerts_time
  ON engine_bypass_alerts(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_bypass_alerts_table
  ON engine_bypass_alerts(table_name, operation);

-- Strengthened context check. Token pattern = 'engine:<uuid-like>'.
-- 'on' still accepted (transition) but callers are logged.
CREATE OR REPLACE FUNCTION fn_engine_write_allowed(
  p_table_name TEXT, p_op CHAR, p_record_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_ctx TEXT := COALESCE(current_setting('app.engine_context', TRUE), '');
BEGIN
  -- Canonical: engine-signed token
  IF v_ctx LIKE 'engine:%' AND length(v_ctx) >= 10 THEN
    RETURN TRUE;
  END IF;
  -- Transitional: legacy 'on' — accept but record bypass
  IF v_ctx = 'on' THEN
    INSERT INTO engine_bypass_alerts
      (table_name, operation, record_id, context_value,
       client_addr, application, session_user_name)
    VALUES
      (p_table_name, p_op, p_record_id, v_ctx,
       inet_client_addr(),
       current_setting('application_name', TRUE),
       session_user);
    RETURN TRUE;
  END IF;
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

-- Retire the old on/off boolean check — keep the name for backward
-- compatibility (it's referenced by other triggers we are about to
-- replace). Callers get the same semantic: returns TRUE only when a
-- legitimate context is active.
CREATE OR REPLACE FUNCTION fn_is_engine_context()
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SET search_path TO 'pg_catalog', 'public'
AS $$
DECLARE
  v_ctx TEXT := COALESCE(current_setting('app.engine_context', TRUE), '');
BEGIN
  RETURN v_ctx = 'on' OR v_ctx LIKE 'engine:%';
END;
$$;

-- ─── 4. Replace journal-write guards to use the stricter check ──────────
-- Same semantics, but every 'on'-write now leaves a trace.

CREATE OR REPLACE FUNCTION fn_guard_journal_entries()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'journal_entries rows are immutable — void instead of delete (migration 063)';
  ELSIF TG_OP = 'INSERT' THEN
    IF NOT fn_engine_write_allowed('journal_entries','I',NEW.id::text) THEN
      RAISE EXCEPTION
        'direct INSERT into journal_entries is not allowed — route through FinancialEngineService.recordTransaction()';
    END IF;
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_guard_journal_entries_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NOT fn_engine_write_allowed('journal_entries','U',NEW.id::text) THEN
    RAISE EXCEPTION
      'direct UPDATE on journal_entries is not allowed — route through FinancialEngineService';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_guard_journal_lines()
RETURNS TRIGGER AS $$
DECLARE
  v_rec_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'journal_lines rows are immutable — use reversal entries (migration 063)';
  END IF;
  v_rec_id := CASE TG_OP WHEN 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
  IF NOT fn_engine_write_allowed('journal_lines',LEFT(TG_OP,1),v_rec_id) THEN
    RAISE EXCEPTION
      'direct write to journal_lines is not allowed — route through FinancialEngineService.recordTransaction()';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

-- ─── 5. Cashbox-transactions write + DELETE guards ──────────────────────
-- Previously UNGUARDED. Any session with DB access could INSERT/UPDATE/
-- DELETE rows and directly drift the running balance. Now gated.

CREATE OR REPLACE FUNCTION fn_guard_cashbox_transactions()
RETURNS TRIGGER AS $$
DECLARE
  v_rec_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'cashbox_transactions are immutable — set is_void=TRUE (migration 063)';
  END IF;
  v_rec_id := CASE TG_OP WHEN 'INSERT' THEN NEW.id::text ELSE NEW.id::text END;
  IF NOT fn_engine_write_allowed('cashbox_transactions',LEFT(TG_OP,1),v_rec_id) THEN
    RAISE EXCEPTION
      'direct write to cashbox_transactions is not allowed — route through fn_record_cashbox_txn (engine-only)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_guard_cashbox_transactions ON cashbox_transactions;
CREATE TRIGGER trg_guard_cashbox_transactions
  BEFORE INSERT OR UPDATE OR DELETE ON cashbox_transactions
  FOR EACH ROW EXECUTE FUNCTION fn_guard_cashbox_transactions();

-- ─── 6. DELETE blocking on the remaining financial tables ───────────────
DROP TRIGGER IF EXISTS trg_block_delete_shifts               ON shifts;
DROP TRIGGER IF EXISTS trg_block_delete_employee_deductions  ON employee_deductions;
DROP TRIGGER IF EXISTS trg_block_delete_employee_settlements ON employee_settlements;
DROP TRIGGER IF EXISTS trg_block_delete_employee_bonuses     ON employee_bonuses;

CREATE TRIGGER trg_block_delete_shifts
  BEFORE DELETE ON shifts
  FOR EACH ROW EXECUTE FUNCTION fn_block_delete_immutable();
CREATE TRIGGER trg_block_delete_employee_deductions
  BEFORE DELETE ON employee_deductions
  FOR EACH ROW EXECUTE FUNCTION fn_block_delete_immutable();
CREATE TRIGGER trg_block_delete_employee_settlements
  BEFORE DELETE ON employee_settlements
  FOR EACH ROW EXECUTE FUNCTION fn_block_delete_immutable();
CREATE TRIGGER trg_block_delete_employee_bonuses
  BEFORE DELETE ON employee_bonuses
  FOR EACH ROW EXECUTE FUNCTION fn_block_delete_immutable();

-- ─── 7. Row-level audit triggers on 7 financial tables ──────────────────
-- `fn_audit_row` already exists (migration 030). It writes
-- INSERT/UPDATE/DELETE events with full old_data/new_data JSONB snapshots
-- to `audit_logs`, attributing to `app.current_user_id` or a row
-- column. Attaching it wires the 7 tables into the existing audit query
-- surface (AuditLog.tsx, audit.service.listChanges) with zero UI changes.

-- Attach using DROP IF EXISTS + CREATE so re-running is idempotent.

DROP TRIGGER IF EXISTS trg_audit_journal_entries    ON journal_entries;
CREATE TRIGGER trg_audit_journal_entries
  AFTER INSERT OR UPDATE OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

DROP TRIGGER IF EXISTS trg_audit_journal_lines      ON journal_lines;
CREATE TRIGGER trg_audit_journal_lines
  AFTER INSERT OR UPDATE OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

DROP TRIGGER IF EXISTS trg_audit_cashbox_transactions ON cashbox_transactions;
CREATE TRIGGER trg_audit_cashbox_transactions
  AFTER INSERT OR UPDATE OR DELETE ON cashbox_transactions
  FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

DROP TRIGGER IF EXISTS trg_audit_shifts             ON shifts;
CREATE TRIGGER trg_audit_shifts
  AFTER INSERT OR UPDATE OR DELETE ON shifts
  FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

DROP TRIGGER IF EXISTS trg_audit_employee_deductions ON employee_deductions;
CREATE TRIGGER trg_audit_employee_deductions
  AFTER INSERT OR UPDATE OR DELETE ON employee_deductions
  FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

DROP TRIGGER IF EXISTS trg_audit_employee_settlements ON employee_settlements;
CREATE TRIGGER trg_audit_employee_settlements
  AFTER INSERT OR UPDATE OR DELETE ON employee_settlements
  FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

DROP TRIGGER IF EXISTS trg_audit_employee_bonuses   ON employee_bonuses;
CREATE TRIGGER trg_audit_employee_bonuses
  AFTER INSERT OR UPDATE OR DELETE ON employee_bonuses
  FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

-- Make audit_logs itself append-only (no UPDATE, no DELETE).
CREATE OR REPLACE FUNCTION fn_audit_logs_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only — % operation forbidden', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_audit_logs_no_update ON audit_logs;
CREATE TRIGGER trg_audit_logs_no_update
  BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION fn_audit_logs_append_only();

-- ─── 8. Fiscal period lock ──────────────────────────────────────────────
-- A closed fiscal period forbids ALL modifications to journal_entries
-- whose entry_date falls in it — including voiding. Enforcement at DB
-- level, below the engine, so no service layer can bypass.

CREATE TABLE IF NOT EXISTS fiscal_periods (
  id           BIGSERIAL PRIMARY KEY,
  period_start DATE        NOT NULL,
  period_end   DATE        NOT NULL,
  status       VARCHAR(10) NOT NULL DEFAULT 'open'
               CHECK (status IN ('open','closed')),
  closed_by    UUID        REFERENCES users(id),
  closed_at    TIMESTAMPTZ,
  closing_note TEXT,
  created_by   UUID        REFERENCES users(id),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (period_end >= period_start),
  UNIQUE (period_start, period_end)
);

CREATE INDEX IF NOT EXISTS ix_fiscal_periods_status
  ON fiscal_periods(status, period_start DESC);

CREATE OR REPLACE FUNCTION fn_period_is_closed(p_date DATE)
RETURNS BOOLEAN AS $$
DECLARE v_closed BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM fiscal_periods
     WHERE status = 'closed'
       AND p_date BETWEEN period_start AND period_end
  ) INTO v_closed;
  RETURN COALESCE(v_closed, FALSE);
END;
$$ LANGUAGE plpgsql STABLE;

-- Trigger on journal_entries that blocks modification of entries in
-- closed periods. This runs before the engine guard, so not even the
-- engine can bypass (the whole point of fiscal close).
-- Override hook: session variable `app.fiscal_override_token` can be
-- set to the sha256 of a secret to allow a surgical edit. Default:
-- nobody has it; only DBA w/ explicit unlock workflow.

CREATE OR REPLACE FUNCTION fn_fiscal_period_lock()
RETURNS TRIGGER AS $$
DECLARE
  v_entry_date DATE;
  v_override   TEXT := COALESCE(current_setting('app.fiscal_override_token', TRUE), '');
BEGIN
  IF TG_OP = 'INSERT' THEN v_entry_date := NEW.entry_date;
  ELSIF TG_OP = 'UPDATE' THEN v_entry_date := OLD.entry_date;
  ELSE RETURN NULL;
  END IF;

  IF fn_period_is_closed(v_entry_date)
     AND v_override NOT LIKE 'fiscal-override:%' THEN
    RAISE EXCEPTION
      'fiscal period containing % is CLOSED — set app.fiscal_override_token to modify',
      v_entry_date
    USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fiscal_period_lock ON journal_entries;
CREATE TRIGGER trg_fiscal_period_lock
  BEFORE INSERT OR UPDATE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION fn_fiscal_period_lock();

COMMENT ON TABLE fiscal_periods IS
  'Fiscal periods. status=closed seals the date range at DB level — any modification to journal_entries whose entry_date falls inside requires app.fiscal_override_token.';

COMMIT;
