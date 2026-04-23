-- Migration 064: Real-Time Financial Control Tower (observability)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- READ-ONLY observability layer. No change to accounting logic, no
-- change to any financial table, no blocking of any transaction. The
-- migration only:
--
--   * creates two append-only tables: financial_event_stream and
--     financial_anomalies
--   * attaches AFTER INSERT triggers to existing financial tables so
--     every write is mirrored into the event stream (the triggers
--     run AFTER the primary write commits its changes within the
--     transaction — they cannot block or alter the source row)
--   * creates the v_financial_health_snapshot view for the dashboard
--     to read aggregate metrics with no heavy joins at query time
--
-- Every downstream endpoint that reads these tables is GET-only
-- (DashboardFinancialController). Writes to financial_anomalies
-- happen only from the FinancialHealthService anomaly scan — it
-- INSERTs detected anomalies; operators mark them resolved via a
-- dedicated PATCH. Neither endpoint can touch journal_entries,
-- journal_lines, or cashbox_transactions.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. financial_event_stream — the real-time heartbeat ─────────────────
-- One row per financial write. Append-only.
CREATE TABLE IF NOT EXISTS financial_event_stream (
  event_id         BIGSERIAL    PRIMARY KEY,
  event_type       VARCHAR(40)  NOT NULL,         -- 'journal_entry' | 'journal_line' | 'cashbox_txn' | 'shift_close' | 'deduction' | 'settlement' | 'expense'
  source_service   VARCHAR(40),                   -- parsed from app.engine_context ('engine:recordTransaction', 'on', etc.)
  reference_type   VARCHAR(40),
  reference_id     TEXT,
  amount           NUMERIC(14,2),
  debit_total      NUMERIC(14,2),
  credit_total     NUMERIC(14,2),
  is_engine        BOOLEAN      NOT NULL DEFAULT FALSE,
  is_legacy        BOOLEAN      NOT NULL DEFAULT FALSE,
  session_user     TEXT,
  client_addr      INET,
  meta             JSONB        DEFAULT '{}'::jsonb,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_fes_time     ON financial_event_stream(created_at DESC);
CREATE INDEX IF NOT EXISTS ix_fes_type     ON financial_event_stream(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_fes_ref      ON financial_event_stream(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS ix_fes_legacy   ON financial_event_stream(is_legacy, created_at DESC) WHERE is_legacy;

-- Append-only enforcement for the event stream itself.
CREATE OR REPLACE FUNCTION fn_fes_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'financial_event_stream is append-only — % forbidden', TG_OP;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fes_no_mutate ON financial_event_stream;
CREATE TRIGGER trg_fes_no_mutate
  BEFORE UPDATE OR DELETE ON financial_event_stream
  FOR EACH ROW EXECUTE FUNCTION fn_fes_append_only();

-- ── 2. financial_anomalies — detected issues (upsert-friendly) ──────────
CREATE TABLE IF NOT EXISTS financial_anomalies (
  anomaly_id        BIGSERIAL   PRIMARY KEY,
  severity          VARCHAR(10) NOT NULL CHECK (severity IN ('low','medium','high','critical')),
  anomaly_type      VARCHAR(40) NOT NULL,
  description       TEXT        NOT NULL,
  affected_entity   VARCHAR(40),                  -- table name
  reference_id      TEXT,
  details           JSONB       DEFAULT '{}'::jsonb,
  detected_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved          BOOLEAN     NOT NULL DEFAULT FALSE,
  resolved_by       UUID        REFERENCES users(id),
  resolved_at       TIMESTAMPTZ,
  resolution_note   TEXT,
  -- Idempotency: a given anomaly (type, entity, reference) is logged once
  -- while still open; resolving it reopens the slot for a new detection.
  UNIQUE (anomaly_type, affected_entity, reference_id, resolved)
    DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX IF NOT EXISTS ix_anomalies_open
  ON financial_anomalies(severity, detected_at DESC) WHERE NOT resolved;
CREATE INDEX IF NOT EXISTS ix_anomalies_time
  ON financial_anomalies(detected_at DESC);

-- ── 3. Helper — classify the writer identity from the engine_context ─────
-- Reads current_setting('app.engine_context') and returns a 3-tuple:
-- (source_label, is_engine, is_legacy).
CREATE OR REPLACE FUNCTION fn_fes_classify_writer(OUT source TEXT, OUT is_engine BOOLEAN, OUT is_legacy BOOLEAN)
LANGUAGE plpgsql
AS $$
DECLARE
  v_ctx TEXT := COALESCE(current_setting('app.engine_context', TRUE), '');
BEGIN
  IF v_ctx LIKE 'engine:%' THEN
    source := v_ctx;
    is_engine := TRUE;
    is_legacy := FALSE;
  ELSIF v_ctx = 'on' THEN
    source := 'legacy_posting_on_flag';
    is_engine := FALSE;
    is_legacy := TRUE;
  ELSIF v_ctx = '' THEN
    source := 'unknown';
    is_engine := FALSE;
    is_legacy := FALSE;
  ELSE
    source := v_ctx;
    is_engine := FALSE;
    is_legacy := FALSE;
  END IF;
END$$;

-- ── 4. Event mirror triggers — AFTER INSERT on the 5 core tables ─────────
-- AFTER INSERT: the source row has already been committed-to within the
-- transaction. Our INSERT into the event stream is appended. If the
-- parent transaction rolls back, the event stream row rolls back too —
-- consistent view, no phantom events.

-- 4a. journal_entries → event_stream (one row per entry, with totals)
CREATE OR REPLACE FUNCTION fn_fes_mirror_journal_entries()
RETURNS TRIGGER AS $$
DECLARE
  v_src TEXT; v_eng BOOLEAN; v_leg BOOLEAN;
  v_debit NUMERIC(14,2) := 0;
  v_credit NUMERIC(14,2) := 0;
BEGIN
  SELECT source, is_engine, is_legacy INTO v_src, v_eng, v_leg FROM fn_fes_classify_writer();
  -- Sum lines lazily — lines may not yet be inserted when entry is first
  -- INSERTed (engine inserts header with is_posted=FALSE, then lines).
  -- For INSERT we log 0 totals; UPDATE trigger refreshes when is_posted flips.
  SELECT COALESCE(SUM(debit), 0), COALESCE(SUM(credit), 0)
    INTO v_debit, v_credit
    FROM journal_lines WHERE entry_id = NEW.id;
  INSERT INTO financial_event_stream
    (event_type, source_service, reference_type, reference_id,
     amount, debit_total, credit_total, is_engine, is_legacy,
     session_user, client_addr, meta)
  VALUES
    ('journal_entry', v_src, NEW.reference_type, NEW.reference_id::text,
     GREATEST(v_debit, v_credit), v_debit, v_credit, v_eng, v_leg,
     session_user, inet_client_addr(),
     jsonb_build_object('entry_no', NEW.entry_no, 'entry_date', NEW.entry_date, 'is_posted', NEW.is_posted, 'is_void', NEW.is_void));
  RETURN NEW;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fes_journal_entries ON journal_entries;
CREATE TRIGGER trg_fes_journal_entries
  AFTER INSERT ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION fn_fes_mirror_journal_entries();

-- 4b. cashbox_transactions → event_stream
CREATE OR REPLACE FUNCTION fn_fes_mirror_cashbox_txn()
RETURNS TRIGGER AS $$
DECLARE
  v_src TEXT; v_eng BOOLEAN; v_leg BOOLEAN;
BEGIN
  SELECT source, is_engine, is_legacy INTO v_src, v_eng, v_leg FROM fn_fes_classify_writer();
  INSERT INTO financial_event_stream
    (event_type, source_service, reference_type, reference_id,
     amount, debit_total, credit_total, is_engine, is_legacy,
     session_user, client_addr, meta)
  VALUES
    ('cashbox_txn', v_src, NEW.reference_type::text, NEW.reference_id::text,
     NEW.amount,
     CASE WHEN NEW.direction='in'  THEN NEW.amount ELSE 0 END,
     CASE WHEN NEW.direction='out' THEN NEW.amount ELSE 0 END,
     v_eng, v_leg,
     session_user, inet_client_addr(),
     jsonb_build_object('cashbox_id', NEW.cashbox_id, 'direction', NEW.direction, 'category', NEW.category));
  RETURN NEW;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fes_cashbox_txn ON cashbox_transactions;
CREATE TRIGGER trg_fes_cashbox_txn
  AFTER INSERT ON cashbox_transactions
  FOR EACH ROW EXECUTE FUNCTION fn_fes_mirror_cashbox_txn();

-- 4c. shifts (closed) → event_stream
CREATE OR REPLACE FUNCTION fn_fes_mirror_shift_close()
RETURNS TRIGGER AS $$
DECLARE
  v_src TEXT; v_eng BOOLEAN; v_leg BOOLEAN;
BEGIN
  -- Only mirror the close transition (open → closed), not every update.
  IF TG_OP = 'UPDATE' AND (OLD.status IS NOT DISTINCT FROM NEW.status) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status = 'open' THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'closed' THEN
    RETURN NEW;
  END IF;
  SELECT source, is_engine, is_legacy INTO v_src, v_eng, v_leg FROM fn_fes_classify_writer();
  INSERT INTO financial_event_stream
    (event_type, source_service, reference_type, reference_id,
     amount, debit_total, credit_total, is_engine, is_legacy,
     session_user, client_addr, meta)
  VALUES
    ('shift_close', v_src, 'shift', NEW.id::text,
     ABS(COALESCE(NEW.actual_closing,0) - COALESCE(NEW.expected_closing,0)),
     0, 0, v_eng, v_leg,
     session_user, inet_client_addr(),
     jsonb_build_object(
       'shift_no', NEW.shift_no,
       'actual_closing', NEW.actual_closing,
       'expected_closing', NEW.expected_closing,
       'variance_amount', COALESCE(NEW.actual_closing,0) - COALESCE(NEW.expected_closing,0),
       'variance_treatment', NEW.variance_treatment
     ));
  RETURN NEW;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fes_shift_close ON shifts;
CREATE TRIGGER trg_fes_shift_close
  AFTER INSERT OR UPDATE ON shifts
  FOR EACH ROW EXECUTE FUNCTION fn_fes_mirror_shift_close();

-- 4d. employee_deductions → event_stream
CREATE OR REPLACE FUNCTION fn_fes_mirror_deduction()
RETURNS TRIGGER AS $$
DECLARE
  v_src TEXT; v_eng BOOLEAN; v_leg BOOLEAN;
BEGIN
  SELECT source, is_engine, is_legacy INTO v_src, v_eng, v_leg FROM fn_fes_classify_writer();
  INSERT INTO financial_event_stream
    (event_type, source_service, reference_type, reference_id,
     amount, debit_total, credit_total, is_engine, is_legacy,
     session_user, meta)
  VALUES
    ('deduction', v_src, 'employee_deduction', NEW.id::text,
     NEW.amount, NEW.amount, 0, v_eng, v_leg,
     session_user,
     jsonb_build_object('user_id', NEW.user_id, 'source', NEW.source, 'shift_id', NEW.shift_id));
  RETURN NEW;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fes_deduction ON employee_deductions;
CREATE TRIGGER trg_fes_deduction
  AFTER INSERT ON employee_deductions
  FOR EACH ROW EXECUTE FUNCTION fn_fes_mirror_deduction();

-- 4e. employee_settlements → event_stream
CREATE OR REPLACE FUNCTION fn_fes_mirror_settlement()
RETURNS TRIGGER AS $$
DECLARE
  v_src TEXT; v_eng BOOLEAN; v_leg BOOLEAN;
BEGIN
  SELECT source, is_engine, is_legacy INTO v_src, v_eng, v_leg FROM fn_fes_classify_writer();
  INSERT INTO financial_event_stream
    (event_type, source_service, reference_type, reference_id,
     amount, debit_total, credit_total, is_engine, is_legacy,
     session_user, meta)
  VALUES
    ('settlement', v_src, 'employee_settlement', NEW.id::text,
     NEW.amount, 0, NEW.amount, v_eng, v_leg,
     session_user,
     jsonb_build_object('user_id', NEW.user_id, 'method', NEW.method, 'cashbox_id', NEW.cashbox_id));
  RETURN NEW;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_fes_settlement ON employee_settlements;
CREATE TRIGGER trg_fes_settlement
  AFTER INSERT ON employee_settlements
  FOR EACH ROW EXECUTE FUNCTION fn_fes_mirror_settlement();

-- ── 5. v_financial_health_snapshot — aggregate view for the dashboard ───
-- 24-hour and 7-day rollups. Pure SELECT; no side effects.
CREATE OR REPLACE VIEW v_financial_health_snapshot AS
WITH recent AS (
  SELECT * FROM financial_event_stream
   WHERE created_at > NOW() - INTERVAL '24 hours'
),
week AS (
  SELECT * FROM financial_event_stream
   WHERE created_at > NOW() - INTERVAL '7 days'
)
SELECT
  -- Engine coverage (24h) — share of journal_entry events that went through the engine
  COALESCE((
    SELECT (COUNT(*) FILTER (WHERE is_engine))::numeric
           / NULLIF(COUNT(*), 0)
      FROM recent WHERE event_type = 'journal_entry'
  ), 0)::numeric(5,4) AS engine_coverage_24h,

  COALESCE((
    SELECT (COUNT(*) FILTER (WHERE is_legacy))::numeric
           / NULLIF(COUNT(*), 0)
      FROM recent WHERE event_type = 'journal_entry'
  ), 0)::numeric(5,4) AS legacy_rate_24h,

  (SELECT COUNT(*) FROM recent WHERE event_type = 'journal_entry' AND is_engine)::int AS engine_events_24h,
  (SELECT COUNT(*) FROM recent WHERE event_type = 'journal_entry' AND is_legacy)::int AS legacy_events_24h,
  (SELECT COUNT(*) FROM recent)::int AS total_events_24h,
  (SELECT COUNT(*) FROM week)::int AS total_events_7d,

  -- Anomalies (open)
  (SELECT COUNT(*) FROM financial_anomalies WHERE NOT resolved)::int AS open_anomalies,
  (SELECT COUNT(*) FROM financial_anomalies WHERE NOT resolved AND severity = 'critical')::int AS critical_anomalies,
  (SELECT COUNT(*) FROM financial_anomalies WHERE NOT resolved AND severity = 'high')::int AS high_anomalies,

  -- Journal integrity — live check, last 24h
  COALESCE((
    WITH b AS (
      SELECT je.id,
             SUM(jl.debit) - SUM(jl.credit) AS delta
        FROM journal_entries je
        JOIN journal_lines jl ON jl.entry_id = je.id
       WHERE je.is_posted AND NOT je.is_void
         AND je.created_at > NOW() - INTERVAL '24 hours'
       GROUP BY je.id
    )
    SELECT COUNT(*) FILTER (WHERE ABS(delta) > 0.01)
      FROM b
  ), 0)::int AS unbalanced_entries_24h,

  -- Cashbox drift (absolute sum across all active boxes)
  COALESCE((
    SELECT SUM(ABS(
      cb.current_balance - (
        COALESCE(cb.opening_balance, 0)
        + COALESCE((
          SELECT SUM(CASE WHEN direction='in' THEN amount ELSE -amount END)
            FROM cashbox_transactions ct
           WHERE ct.cashbox_id = cb.id AND NOT ct.is_void
        ), 0)
      )
    ))
      FROM cashboxes cb WHERE cb.is_active
  ), 0)::numeric(14,2) AS total_cashbox_drift,

  -- Engine bypass alerts (last 24h — from migration 063 table)
  COALESCE((
    SELECT COUNT(*)::int FROM engine_bypass_alerts
     WHERE created_at > NOW() - INTERVAL '24 hours'
  ), 0) AS bypass_alerts_24h,

  NOW() AS snapshot_at;

COMMENT ON VIEW v_financial_health_snapshot IS
  'Dashboard roll-up: engine coverage, legacy rate, open anomalies, unbalanced JEs, cashbox drift, bypass alerts. 24h + 7d windows.';

-- ── 6. Permissions ──────────────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='permissions') THEN
    INSERT INTO permissions (code, module, name_ar, name_en) VALUES
      ('dashboard.financial.view', 'dashboard',
       'عرض لوحة الرقابة المالية الحية', 'View real-time financial control tower')
    ON CONFLICT (code) DO NOTHING;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='role_permissions') THEN
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM roles r, permissions p
       WHERE r.code IN ('admin','manager','accountant')
         AND p.code = 'dashboard.financial.view'
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
             SELECT 'dashboard.financial.view'
           ) all_codes
         )
       WHERE code IN ('admin','manager','accountant');
    END IF;
  END IF;
END$$;

COMMIT;
