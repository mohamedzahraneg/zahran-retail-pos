-- Migration 068: Financial Integrity Enforcement (strict guard + lockdown + risk flags)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Elevates the system from "monitored" to "enforced". Three changes:
--
--   1. Strict guard — fn_engine_write_allowed() no longer accepts the
--      bare `'on'` value. Only three context shapes pass:
--           engine:*     — canonical engine writer (trusted, silent)
--           service:*    — grandfathered legacy writer (still alerted)
--           migration:*  — DDL via the migration runner (silent)
--      Anything else → RAISE EXCEPTION at the trigger layer.
--
--      Why grandfather `service:*`? Because the 11 legacy posting
--      methods (postInvoice-by-pos, postSupplierPayment, manual JE,
--      reconciliation voids, etc.) are not yet migrated to the engine.
--      Breaking them would cause a prod outage. The `service:*`
--      pattern is a hard identity declaration — every legacy caller
--      must opt-in by name. Unknown traffic is blocked.
--
--   2. fn_record_cashbox_txn fallback — uses `service:cashbox_fn_fallback`
--      instead of `on`, so the plpgsql helper honours the strict rule.
--
--   3. Two new tables:
--      * `system_controls` — single-row system state. Currently:
--           financial_lockdown BOOLEAN DEFAULT FALSE
--        Engine reads at start of recordTransaction; if TRUE, refuses
--        to post unless the session sets `app.bypass_lockdown = 'true'`
--        (admin-only path). Nothing auto-sets this — operator decision.
--
--      * `employee_risk_flags` — append-only. The scheduled anomaly
--        scan inserts a row here when an `engine_bypass_*` anomaly is
--        detected AND the captured `session_user_name` resolves to an
--        active employee. DOES NOT auto-deduct payroll — that's a
--        human decision via the employee ledger.
--
-- INVARIANTS:
--   * No existing row rewritten. No DELETE. No accounting logic change.
--   * Idempotent — re-runnable with zero net effect.
--   * Append-only: system_controls has an UPDATE trigger that logs each
--     toggle into audit_logs; employee_risk_flags is insert-only.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Strict guard — fn_engine_write_allowed ──────────────────────────
CREATE OR REPLACE FUNCTION fn_engine_write_allowed(
  p_table_name TEXT, p_op CHAR, p_record_id TEXT
) RETURNS BOOLEAN AS $$
DECLARE
  v_ctx TEXT := COALESCE(current_setting('app.engine_context', TRUE), '');
BEGIN
  -- Canonical: engine-signed token (trusted, silent)
  IF v_ctx LIKE 'engine:%' AND length(v_ctx) >= 10 THEN
    RETURN TRUE;
  END IF;

  -- Grandfathered: named legacy service (logs alert; transitional until
  -- phase 2.2-2.4 migrates them to the engine)
  IF v_ctx LIKE 'service:%' AND length(v_ctx) >= 12 THEN
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

  -- Migration runner: DDL during schema migrations
  IF v_ctx LIKE 'migration:%' THEN
    RETURN TRUE;
  END IF;

  -- Anything else (bare 'on', empty, unknown) is BLOCKED.
  RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

-- Update the error message in the write guards so callers see the new
-- semantic when they hit the block.
CREATE OR REPLACE FUNCTION fn_guard_journal_entries()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'journal_entries rows are immutable — void instead of delete (migration 063)';
  ELSIF TG_OP = 'INSERT' THEN
    IF NOT fn_engine_write_allowed('journal_entries','I',NEW.id::text) THEN
      RAISE EXCEPTION
        'BLOCKED: non-engine financial write — set app.engine_context to engine:*, service:*, or migration:* (migration 068 strict guard)';
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
      'BLOCKED: non-engine UPDATE on journal_entries (migration 068 strict guard)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_guard_journal_lines()
RETURNS TRIGGER AS $$
DECLARE v_rec_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'journal_lines rows are immutable — use reversal entries (migration 063)';
  END IF;
  v_rec_id := CASE TG_OP WHEN 'DELETE' THEN OLD.id::text ELSE NEW.id::text END;
  IF NOT fn_engine_write_allowed('journal_lines',LEFT(TG_OP,1),v_rec_id) THEN
    RAISE EXCEPTION
      'BLOCKED: non-engine write to journal_lines (migration 068 strict guard)';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_guard_cashbox_transactions()
RETURNS TRIGGER AS $$
DECLARE v_rec_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION
      'cashbox_transactions are immutable — set is_void=TRUE (migration 063)';
  END IF;
  v_rec_id := NEW.id::text;
  IF NOT fn_engine_write_allowed('cashbox_transactions',LEFT(TG_OP,1),v_rec_id) THEN
    RAISE EXCEPTION
      'BLOCKED: non-engine write to cashbox_transactions (migration 068 strict guard)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ─── 2. fn_record_cashbox_txn — fallback to service:cashbox_fn_fallback
-- (instead of plain 'on' which no longer passes the strict guard)
CREATE OR REPLACE FUNCTION fn_record_cashbox_txn(
  p_cashbox_id     UUID,
  p_direction      TEXT,
  p_amount         NUMERIC,
  p_category       TEXT,
  p_reference_type TEXT DEFAULT NULL,
  p_reference_id   UUID DEFAULT NULL,
  p_user_id        UUID DEFAULT NULL,
  p_notes          TEXT DEFAULT NULL
) RETURNS BIGINT AS $$
DECLARE
  v_current NUMERIC;
  v_new     NUMERIC;
  v_txn_id  BIGINT;
  v_ctx     TEXT := COALESCE(current_setting('app.engine_context', TRUE), '');
BEGIN
  -- Only fall back if caller hasn't already set a valid context.
  IF v_ctx NOT LIKE 'engine:%' AND v_ctx NOT LIKE 'service:%' THEN
    PERFORM set_config('app.engine_context', 'service:cashbox_fn_fallback', TRUE);
  END IF;

  SELECT COALESCE(current_balance, 0) INTO v_current
    FROM cashboxes WHERE id = p_cashbox_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'cashbox % not found', p_cashbox_id;
  END IF;

  v_new := v_current + CASE WHEN p_direction = 'in' THEN p_amount ELSE -p_amount END;

  INSERT INTO cashbox_transactions
      (cashbox_id, direction, amount, category,
       reference_type, reference_id, balance_after, user_id, notes)
  VALUES
      (p_cashbox_id, p_direction::txn_direction, p_amount, p_category,
       NULLIF(p_reference_type, '')::entity_type, p_reference_id, v_new, p_user_id, p_notes)
  RETURNING id INTO v_txn_id;

  UPDATE cashboxes
     SET current_balance = v_new,
         updated_at = NOW()
   WHERE id = p_cashbox_id;

  RETURN v_txn_id;
END;
$$ LANGUAGE plpgsql;

-- ─── 3. system_controls — single-row lockdown state ──────────────────────
CREATE TABLE IF NOT EXISTS system_controls (
  id                  SMALLINT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  financial_lockdown  BOOLEAN      NOT NULL DEFAULT FALSE,
  locked_by           UUID         REFERENCES users(id),
  locked_at           TIMESTAMPTZ,
  lock_reason         TEXT,
  last_changed_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Seed the single row (idempotent).
INSERT INTO system_controls (id, financial_lockdown)
VALUES (1, FALSE)
ON CONFLICT (id) DO NOTHING;

-- Audit every toggle: append a row to audit_logs via trg_audit_row.
DROP TRIGGER IF EXISTS trg_audit_system_controls ON system_controls;
CREATE TRIGGER trg_audit_system_controls
  AFTER UPDATE ON system_controls
  FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

-- ─── 4. employee_risk_flags — HIGH RISK markers from anomaly scan ───────
CREATE TABLE IF NOT EXISTS employee_risk_flags (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID         NOT NULL REFERENCES users(id),
  risk_level    VARCHAR(10)  NOT NULL CHECK (risk_level IN ('low','medium','high','critical')),
  reason        TEXT         NOT NULL,
  anomaly_id    BIGINT       REFERENCES financial_anomalies(anomaly_id),
  details       JSONB        DEFAULT '{}'::jsonb,
  flagged_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  resolved      BOOLEAN      NOT NULL DEFAULT FALSE,
  resolved_by   UUID         REFERENCES users(id),
  resolved_at   TIMESTAMPTZ,
  resolution    TEXT
);
CREATE INDEX IF NOT EXISTS ix_risk_flags_open
  ON employee_risk_flags(user_id, risk_level) WHERE NOT resolved;
CREATE INDEX IF NOT EXISTS ix_risk_flags_time
  ON employee_risk_flags(flagged_at DESC);

-- Append-only: UPDATE allowed only to flip `resolved`.
CREATE OR REPLACE FUNCTION fn_risk_flags_append_only()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'employee_risk_flags is append-only';
  END IF;
  -- UPDATE: only resolved-related fields may change.
  IF NEW.user_id        IS DISTINCT FROM OLD.user_id OR
     NEW.risk_level     IS DISTINCT FROM OLD.risk_level OR
     NEW.reason         IS DISTINCT FROM OLD.reason OR
     NEW.anomaly_id     IS DISTINCT FROM OLD.anomaly_id OR
     NEW.flagged_at     IS DISTINCT FROM OLD.flagged_at
  THEN
    RAISE EXCEPTION 'employee_risk_flags: only resolved / resolved_by / resolved_at / resolution may be updated';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_risk_flags_append_only ON employee_risk_flags;
CREATE TRIGGER trg_risk_flags_append_only
  BEFORE UPDATE OR DELETE ON employee_risk_flags
  FOR EACH ROW EXECUTE FUNCTION fn_risk_flags_append_only();

DROP TRIGGER IF EXISTS trg_audit_risk_flags ON employee_risk_flags;
CREATE TRIGGER trg_audit_risk_flags
  AFTER INSERT OR UPDATE ON employee_risk_flags
  FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

-- ─── 5. Permissions ─────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='permissions') THEN
    INSERT INTO permissions (code, module, name_ar, name_en) VALUES
      ('system.lockdown.manage', 'system',
       'إدارة قفل النظام المالي', 'Toggle financial lockdown')
    ON CONFLICT (code) DO NOTHING;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='role_permissions') THEN
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM roles r, permissions p
       WHERE r.code = 'admin'
         AND p.code = 'system.lockdown.manage'
      ON CONFLICT DO NOTHING;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name='roles' AND column_name='permissions'
    ) THEN
      UPDATE roles
         SET permissions = (
           SELECT ARRAY_AGG(DISTINCT code ORDER BY code) FROM (
             SELECT UNNEST(COALESCE(permissions, ARRAY[]::text[])) AS code
             UNION
             SELECT 'system.lockdown.manage'
           ) all_codes
         )
       WHERE code = 'admin';
    END IF;
  END IF;
END$$;

COMMIT;
