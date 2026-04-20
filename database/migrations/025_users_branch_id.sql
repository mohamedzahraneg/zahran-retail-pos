-- =============================================================================
-- 025_users_branch_id.sql
-- Adds `branch_id` column to `users` that the backend UserEntity expects.
-- Aliases it to default_warehouse_id for backward compatibility.
-- =============================================================================

-- 1) Add the new column if missing.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES warehouses(id) ON DELETE SET NULL;

-- 2) Backfill from existing default_warehouse_id if present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'default_warehouse_id'
  ) THEN
    UPDATE users
       SET branch_id = default_warehouse_id
     WHERE branch_id IS NULL
       AND default_warehouse_id IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_branch ON users(branch_id);
