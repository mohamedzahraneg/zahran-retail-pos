-- Migration 062: drop orphan variance_decided_* columns
-- ---------------------------------------------------------------------------
-- Post-deploy audit found both `variance_decided_by`/`variance_decided_at`
-- AND `variance_approved_by`/`variance_approved_at` coexist on the shifts
-- table. Root cause: migration 061 was deployed twice (the first run
-- failed at a UUID=TEXT cast and the migration runner did not fully
-- undo the ADD COLUMN step before the backfill UPDATE aborted). The
-- hotfix re-applied 061, but by then `variance_approved_*` already
-- existed so the idempotency guard in 061 skipped the RENAME — leaving
-- `variance_decided_*` orphaned (all NULL on every row).
--
-- This migration is a surgical cleanup:
--   * DROP IF EXISTS variance_decided_by
--   * DROP IF EXISTS variance_decided_at
--
-- The engine is not touched. No code references these columns anymore.
-- Idempotent — if they're already gone this is a no-op.
-- ---------------------------------------------------------------------------

BEGIN;

ALTER TABLE shifts DROP COLUMN IF EXISTS variance_decided_by;
ALTER TABLE shifts DROP COLUMN IF EXISTS variance_decided_at;

COMMIT;
