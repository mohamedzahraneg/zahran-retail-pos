-- 032_user_permission_overrides.sql
-- Per-user permission overrides on top of the role's permissions.
--
--   effective = (role.permissions ∪ users.extra_permissions) \ users.denied_permissions
--
-- "*" in the effective set is a wildcard that passes any permission check.

ALTER TABLE users
    ADD COLUMN IF NOT EXISTS extra_permissions  text[] NOT NULL DEFAULT '{}',
    ADD COLUMN IF NOT EXISTS denied_permissions text[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN users.extra_permissions  IS 'Permissions granted in addition to the user''s role permissions.';
COMMENT ON COLUMN users.denied_permissions IS 'Permissions revoked from the user even if granted by their role.';
