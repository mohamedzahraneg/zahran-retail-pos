-- 125_pr_returns_exchanges_edit_requests.sql
-- PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS — Phase 1
--
-- Adds two new request tables: `return_edit_requests` and
-- `exchange_edit_requests`.  Mirrors the existing
-- `invoice_edit_requests` shape from PR-INV-EDIT-WORKFLOW.
--
-- Hard guarantees of THIS migration:
--   · ZERO writes to existing data (returns / return_items /
--     exchanges / exchange_items / journal_entries / journal_lines /
--     cashbox_transactions / stock_movements).
--   · ZERO mutations to enums, triggers, or functions.
--   · ZERO RLS / permission changes.  Application-layer permissions
--     gate the new endpoints (returns.view + roles).
--
-- Idempotent: every CREATE uses IF NOT EXISTS so the boot-time
-- migration runner can replay safely.  Constraint names are
-- deterministic so a re-run with a partially-applied migration
-- doesn't error on duplicate constraint names.

-- ─── return_edit_requests ────────────────────────────────────────

CREATE TABLE IF NOT EXISTS return_edit_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  return_id            uuid NOT NULL REFERENCES returns(id),
  return_no            varchar,
  requested_action     varchar NOT NULL,
  requested_payload    jsonb NOT NULL,
  before_snapshot      jsonb NOT NULL,
  after_preview        jsonb,
  reason_text          text NOT NULL,
  status               varchar NOT NULL DEFAULT 'pending',
  requested_by         uuid NOT NULL REFERENCES users(id),
  requested_at         timestamptz NOT NULL DEFAULT now(),
  reviewed_by          uuid REFERENCES users(id),
  reviewed_at          timestamptz,
  review_notes         text,
  idempotency_key      varchar,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_rer_status'
  ) THEN
    ALTER TABLE return_edit_requests
      ADD CONSTRAINT chk_rer_status
      CHECK (status IN ('pending','approved','rejected','cancelled'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_rer_requested_action'
  ) THEN
    ALTER TABLE return_edit_requests
      ADD CONSTRAINT chk_rer_requested_action
      CHECK (requested_action IN (
        'update_header','update_item','remove_item','replace_item',
        'price_change','quantity_change','reason_change'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_rer_reason_min_length'
  ) THEN
    ALTER TABLE return_edit_requests
      ADD CONSTRAINT chk_rer_reason_min_length
      CHECK (char_length(reason_text) >= 5);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_rer_payload_object'
  ) THEN
    ALTER TABLE return_edit_requests
      ADD CONSTRAINT chk_rer_payload_object
      CHECK (jsonb_typeof(requested_payload) = 'object'
         AND jsonb_typeof(before_snapshot) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rer_return_id     ON return_edit_requests(return_id);
CREATE INDEX IF NOT EXISTS idx_rer_status        ON return_edit_requests(status);
CREATE INDEX IF NOT EXISTS idx_rer_requested_by  ON return_edit_requests(requested_by);
CREATE INDEX IF NOT EXISTS idx_rer_reviewed_by   ON return_edit_requests(reviewed_by);
CREATE INDEX IF NOT EXISTS idx_rer_requested_at  ON return_edit_requests(requested_at DESC);

-- ─── exchange_edit_requests ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS exchange_edit_requests (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  exchange_id          uuid NOT NULL REFERENCES exchanges(id),
  exchange_no          varchar,
  requested_action     varchar NOT NULL,
  requested_payload    jsonb NOT NULL,
  before_snapshot      jsonb NOT NULL,
  after_preview        jsonb,
  reason_text          text NOT NULL,
  status               varchar NOT NULL DEFAULT 'pending',
  requested_by         uuid NOT NULL REFERENCES users(id),
  requested_at         timestamptz NOT NULL DEFAULT now(),
  reviewed_by          uuid REFERENCES users(id),
  reviewed_at          timestamptz,
  review_notes         text,
  idempotency_key      varchar,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_eer_status'
  ) THEN
    ALTER TABLE exchange_edit_requests
      ADD CONSTRAINT chk_eer_status
      CHECK (status IN ('pending','approved','rejected','cancelled'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_eer_requested_action'
  ) THEN
    ALTER TABLE exchange_edit_requests
      ADD CONSTRAINT chk_eer_requested_action
      CHECK (requested_action IN (
        'update_header','update_item','remove_item','replace_item',
        'price_change','quantity_change','reason_change'
      ));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_eer_reason_min_length'
  ) THEN
    ALTER TABLE exchange_edit_requests
      ADD CONSTRAINT chk_eer_reason_min_length
      CHECK (char_length(reason_text) >= 5);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_eer_payload_object'
  ) THEN
    ALTER TABLE exchange_edit_requests
      ADD CONSTRAINT chk_eer_payload_object
      CHECK (jsonb_typeof(requested_payload) = 'object'
         AND jsonb_typeof(before_snapshot) = 'object');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_eer_exchange_id   ON exchange_edit_requests(exchange_id);
CREATE INDEX IF NOT EXISTS idx_eer_status        ON exchange_edit_requests(status);
CREATE INDEX IF NOT EXISTS idx_eer_requested_by  ON exchange_edit_requests(requested_by);
CREATE INDEX IF NOT EXISTS idx_eer_reviewed_by   ON exchange_edit_requests(reviewed_by);
CREATE INDEX IF NOT EXISTS idx_eer_requested_at  ON exchange_edit_requests(requested_at DESC);

-- Rollback (manual, if ever needed):
--   DROP TABLE IF EXISTS return_edit_requests;
--   DROP TABLE IF EXISTS exchange_edit_requests;
-- These tables hold operational data only; rollback is destructive
-- but does not affect any other table.
