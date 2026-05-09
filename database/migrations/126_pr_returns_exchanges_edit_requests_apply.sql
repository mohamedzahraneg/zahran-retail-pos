-- 126_pr_returns_exchanges_edit_requests_apply.sql
-- PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS-APPLY — Phase 2A
--
-- Adds applied_* tracking columns to `return_edit_requests` and
-- `exchange_edit_requests` so an admin-approved request can be
-- applied EXACTLY ONCE and the produced artifacts are traceable.
--
-- Hard guarantees of THIS migration:
--   · ZERO writes to existing data (no UPDATE, no DELETE, no
--     reconciliation of old rows).  Every existing approved-but-not-
--     applied row stays valid: applied_at defaults to NULL.
--   · ZERO mutations to enums, triggers, functions, or RLS.
--   · ZERO changes to financial tables (returns / return_items /
--     exchanges / exchange_items / journal_entries / journal_lines /
--     cashbox_transactions / stock_movements).
--   · status enum unchanged.  We deliberately did NOT add an
--     'applied' status — we use the existing 'approved' status with
--     a separate `applied_at` flag, so approve/reject semantics are
--     untouched.  Applied iff: status='approved' AND applied_at IS NOT NULL.
--
-- Idempotent: every column add uses IF NOT EXISTS, every constraint
-- add uses a guarded DO-block, and indexes use IF NOT EXISTS.  The
-- boot-time migration runner can replay safely.

-- ─── return_edit_requests ────────────────────────────────────────

ALTER TABLE return_edit_requests
  ADD COLUMN IF NOT EXISTS applied_at                    timestamptz,
  ADD COLUMN IF NOT EXISTS applied_by                    uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS apply_journal_entry_ids       uuid[],
  ADD COLUMN IF NOT EXISTS apply_cashbox_transaction_ids bigint[],
  ADD COLUMN IF NOT EXISTS apply_stock_movement_ids      uuid[],
  ADD COLUMN IF NOT EXISTS apply_summary                 jsonb;

DO $$
BEGIN
  -- applied_at is only valid for an already-approved request.  The
  -- service-layer FOR-UPDATE check already enforces this; the DB
  -- check is the belt-and-braces safety net.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_rer_applied_status'
  ) THEN
    ALTER TABLE return_edit_requests
      ADD CONSTRAINT chk_rer_applied_status
      CHECK (applied_at IS NULL OR status = 'approved');
  END IF;

  -- applied_at and applied_by must be set together — no half-stamped
  -- rows after a partial transaction.
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_rer_applied_pair'
  ) THEN
    ALTER TABLE return_edit_requests
      ADD CONSTRAINT chk_rer_applied_pair
      CHECK ((applied_at IS NULL) = (applied_by IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rer_applied_at ON return_edit_requests(applied_at);

-- ─── exchange_edit_requests ──────────────────────────────────────
-- Columns and constraints added here so the table is ready when
-- exchange apply lands in Phase 2B.  This PR's exchange apply
-- endpoint returns 501 Not Implemented — no rows are stamped yet,
-- but the schema must accept stamped rows from day one.

ALTER TABLE exchange_edit_requests
  ADD COLUMN IF NOT EXISTS applied_at                    timestamptz,
  ADD COLUMN IF NOT EXISTS applied_by                    uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS apply_journal_entry_ids       uuid[],
  ADD COLUMN IF NOT EXISTS apply_cashbox_transaction_ids bigint[],
  ADD COLUMN IF NOT EXISTS apply_stock_movement_ids      uuid[],
  ADD COLUMN IF NOT EXISTS apply_summary                 jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_eer_applied_status'
  ) THEN
    ALTER TABLE exchange_edit_requests
      ADD CONSTRAINT chk_eer_applied_status
      CHECK (applied_at IS NULL OR status = 'approved');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_eer_applied_pair'
  ) THEN
    ALTER TABLE exchange_edit_requests
      ADD CONSTRAINT chk_eer_applied_pair
      CHECK ((applied_at IS NULL) = (applied_by IS NULL));
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_eer_applied_at ON exchange_edit_requests(applied_at);

-- Rollback (manual, if ever needed):
--   ALTER TABLE return_edit_requests DROP CONSTRAINT IF EXISTS chk_rer_applied_status;
--   ALTER TABLE return_edit_requests DROP CONSTRAINT IF EXISTS chk_rer_applied_pair;
--   ALTER TABLE return_edit_requests
--     DROP COLUMN IF EXISTS applied_at,
--     DROP COLUMN IF EXISTS applied_by,
--     DROP COLUMN IF EXISTS apply_journal_entry_ids,
--     DROP COLUMN IF EXISTS apply_cashbox_transaction_ids,
--     DROP COLUMN IF EXISTS apply_stock_movement_ids,
--     DROP COLUMN IF EXISTS apply_summary;
--   (and the same set on exchange_edit_requests)
-- Rollback is destructive of any apply-tracking rows; do not run
-- without a separate plan.
