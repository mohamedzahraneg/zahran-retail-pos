-- =============================================================================
-- 026_roles_permissions_array.sql
-- Backend RoleEntity expects a `permissions TEXT[]` column directly on roles,
-- denormalized from the role_permissions junction. Add + backfill.
-- =============================================================================

ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS name_ar VARCHAR(150),
  ADD COLUMN IF NOT EXISTS name_en VARCHAR(150);

-- Backfill name_ar / name_en from existing name column if present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'roles' AND column_name = 'name'
  ) THEN
    UPDATE roles SET name_ar = COALESCE(name_ar, name) WHERE name_ar IS NULL;
    UPDATE roles SET name_en = COALESCE(name_en, name) WHERE name_en IS NULL;
  END IF;
END $$;

-- Ensure name_ar is never null (required by entity).
UPDATE roles SET name_ar = COALESCE(name_ar, code, 'role') WHERE name_ar IS NULL;
ALTER TABLE roles ALTER COLUMN name_ar SET NOT NULL;

-- Backfill permissions array from role_permissions junction table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_name = 'role_permissions'
  ) THEN
    UPDATE roles r
       SET permissions = sub.perms
      FROM (
        SELECT rp.role_id, array_agg(p.code) AS perms
          FROM role_permissions rp
          JOIN permissions p ON p.id = rp.permission_id
         GROUP BY rp.role_id
      ) sub
     WHERE r.id = sub.role_id;
  END IF;
END $$;

-- Give admin role wildcard permission so login works out-of-the-box.
UPDATE roles
   SET permissions = ARRAY['*']
 WHERE code IN ('admin', 'super_admin')
   AND (permissions IS NULL OR array_length(permissions, 1) IS NULL);
