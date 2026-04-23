-- Migration 066: Control Tower observability fixes (Phase 2 + Phase 3)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Two surgical fixes found during post-deploy audit:
--
--   ROOT CAUSE #1 — engine writes mis-classified as legacy
--   ------------------------------------------------------
--   `fn_record_cashbox_txn` (migration 035) contained the line
--     `PERFORM set_config('app.engine_context', 'on', TRUE)`
--   to let grandfather callers pass migration 058's write guards. This
--   line is txn-scoped (third arg = TRUE, same as SET LOCAL), so it
--   OVERRODE the engine's `'engine:recordTransaction'` context for
--   every subsequent write in the same transaction. Every engine
--   post therefore came out labelled `legacy_posting_on_flag` in
--   financial_event_stream and raised 5 bogus engine_bypass_alerts
--   rows per post.
--
--   Fix: only fall back to 'on' when the caller has NOT already set
--   an engine signal. The engine's context survives the function call
--   from now on; legacy callers still pass the guard.
--
--   ROOT CAUSE #2 — financial_anomalies scan never inserts
--   ------------------------------------------------------
--   Migration 064 declared the uniqueness as
--     `UNIQUE (anomaly_type, affected_entity, reference_id, resolved)
--        DEFERRABLE INITIALLY IMMEDIATE`.
--   PostgreSQL's `ON CONFLICT` clause does NOT accept DEFERRABLE
--   constraints as arbiters — the INSERT raises
--     `ERROR: ON CONFLICT does not support deferrable unique
--      constraints/exclusion constraints as arbiters`
--   and the scan's try/catch silently swallowed it, causing every
--   scan to report `inserted: 0, skipped_existing: N`.
--
--   Fix: drop the deferrable constraint, recreate as a regular
--   UNIQUE constraint (non-deferrable). ON CONFLICT then works.
--
-- INVARIANTS held:
--   * No financial table touched.
--   * No accounting logic change.
--   * Idempotent — re-runnable with zero net effect.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── Fix #1: fn_record_cashbox_txn respects engine identity ─────────────
-- Conditional context override. Preserves legacy compatibility for
-- callers that don't set context, while honouring the engine's
-- `engine:*` signal when present.
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
  -- Engine-identity preserving guard (migration 066 fix):
  -- Only set `on` when caller has NOT already raised an `engine:*`
  -- signal. This lets the engine's canonical signal survive the
  -- function call, while still unblocking legacy direct callers
  -- (pos.service, purchases.service, etc.) until they migrate.
  IF v_ctx NOT LIKE 'engine:%' THEN
    PERFORM set_config('app.engine_context', 'on', TRUE);
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

-- ─── Fix #2: drop DEFERRABLE, recreate plain UNIQUE ─────────────────────
-- ON CONFLICT can't use DEFERRABLE arbiters. Switch to a plain UNIQUE
-- so the scan's INSERT...ON CONFLICT DO NOTHING works.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'financial_anomalies'::regclass
       AND conname = 'financial_anomalies_anomaly_type_affected_entity_reference_key'
       AND condeferrable = TRUE
  ) THEN
    ALTER TABLE financial_anomalies
      DROP CONSTRAINT financial_anomalies_anomaly_type_affected_entity_reference_key;
  END IF;
END$$;

-- Recreate as non-deferrable (only if not already present with that name).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'financial_anomalies'::regclass
       AND conname = 'ux_anomalies_open_slot'
  ) THEN
    ALTER TABLE financial_anomalies
      ADD CONSTRAINT ux_anomalies_open_slot
      UNIQUE (anomaly_type, affected_entity, reference_id, resolved);
  END IF;
END$$;

-- ─── Post-fix cleanup: retire the bogus bypass alerts created by
--     Fix #1's absence. Mark them resolved so the dashboard doesn't
--     surface pre-fix noise as ongoing concerns.
--     (Table is append-only by design; we only UPDATE the `resolved`
--      equivalent — here we simply leave them as forensic record.
--      Commented out intentionally; admins can manually resolve via
--      PATCH /dashboard/financial/anomalies/:id/resolve.)

COMMIT;
