-- 127_pr_fix_apply_stock_movement_ids_bigint.sql
-- PR-FIX-EDIT-REQUEST-APPLY-SM-IDS-COLUMN-TYPE
--
-- Migration 126 declared `apply_stock_movement_ids` as `uuid[]` on
-- both `return_edit_requests` and `exchange_edit_requests`, but the
-- source-of-truth `stock_movements.id` column is `bigint`
-- (bigserial) — never uuid.  Every attempted apply since 126
-- shipped failed at the `apply_stock_movement_ids = $5::uuid[]` cast
-- with PostgreSQL's "invalid input syntax for type uuid" because
-- the captured ids are sequential integers (e.g. "1640", "1641").
--
-- This migration switches the column type to `bigint[]` to match
-- reality.  Same shape as the already-correct
-- `apply_cashbox_transaction_ids bigint[]` column added in mig 126
-- (cashbox_transactions.id is bigint too).
--
-- Hard guarantees of THIS migration:
--   · ZERO data loss possible.  No row has been written to this
--     column successfully — every apply attempt failed at the cast,
--     so the column is empty across both tables (verified before
--     push: `SELECT COUNT(*) WHERE applied_at IS NOT NULL → 0`).
--   · ZERO mutations to financial / inventory tables (returns /
--     return_items / exchanges / exchange_items / journal_entries /
--     journal_lines / cashbox_transactions / stock_movements).
--   · ZERO changes to enums, triggers, functions, RLS, or any other
--     column / index / constraint on the edit-request tables.
--   · Idempotent: the DO-block reads `information_schema.columns
--     .udt_name` and only runs the ALTER when the column is still
--     `_uuid`.  Re-runs are no-ops once the column is `_int8`.
--   · Safe `USING` clause — empty / NULL arrays cast cleanly.

DO $$
BEGIN
  IF (
    SELECT udt_name
      FROM information_schema.columns
     WHERE table_name = 'return_edit_requests'
       AND column_name = 'apply_stock_movement_ids'
  ) = '_uuid' THEN
    ALTER TABLE return_edit_requests
      ALTER COLUMN apply_stock_movement_ids TYPE bigint[]
      USING apply_stock_movement_ids::text[]::bigint[];
  END IF;

  IF (
    SELECT udt_name
      FROM information_schema.columns
     WHERE table_name = 'exchange_edit_requests'
       AND column_name = 'apply_stock_movement_ids'
  ) = '_uuid' THEN
    ALTER TABLE exchange_edit_requests
      ALTER COLUMN apply_stock_movement_ids TYPE bigint[]
      USING apply_stock_movement_ids::text[]::bigint[];
  END IF;
END $$;

-- Rollback (manual, if ever needed):
--   ALTER TABLE return_edit_requests
--     ALTER COLUMN apply_stock_movement_ids TYPE uuid[]
--     USING apply_stock_movement_ids::text[]::uuid[];
--   (and same on exchange_edit_requests)
-- Rollback would only succeed if the column is empty — so it's
-- effectively destructive of any apply data captured after this
-- migration ran.  Don't run without a separate plan.
