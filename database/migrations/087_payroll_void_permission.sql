-- Migration 087 — Replace role-based payroll void gate with a permission.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   `DELETE /payroll/:id` (PayrollController) is currently gated by
--   @Roles('admin') in the backend, and the frontend's "Void" button
--   inside Payroll.tsx checks `user?.role === 'admin'` (line 66).
--
--   This is the only employee-facing action in the codebase still
--   gated by literal role-name. Every other admin-restricted action
--   uses @Permissions(...) so admin's wildcard '*' satisfies it and
--   manager / accountant can be granted explicitly when business
--   rules permit.
--
--   Per the user's PR-1 direction:
--     * payroll.void must be a real permission code in the catalog
--     * granted to admin only
--     * NOT granted to manager (manager already has create/pay perms
--       via migration 086 but voids stay admin-only by policy)
--
-- Change
--
--   1. INSERT permission code 'payroll.void' (idempotent).
--   2. Append to admin's roles.permissions text[] — admin already has
--      '*' wildcard so this is a no-op for runtime auth, but it makes
--      the catalog explicit for audit queries.
--   3. Grant via role_permissions junction (admin only).
--
-- Not touched
--   * Manager / cashier / accountant grants (untouched).
--   * Backend @Roles('admin') decorator on DELETE — switched to
--     @Permissions('payroll.void') in code, not in this migration.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

INSERT INTO permissions (code, module, name_ar, name_en) VALUES
  ('payroll.void', 'employees',
   'إلغاء حركة رواتب (للأدمن فقط)', 'Void payroll transaction (admin only)')
ON CONFLICT (code) DO NOTHING;

-- Admin: append to roles.permissions text[] (idempotent via DISTINCT).
UPDATE roles
   SET permissions = (
     SELECT array_agg(DISTINCT p ORDER BY p)
       FROM unnest(permissions || ARRAY['payroll.void']::text[]) AS p
   )
 WHERE code = 'admin';

-- Junction: explicit grant for admin only. Manager / cashier / etc
-- intentionally excluded — voids remain admin-only per policy.
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.code = 'admin'
   AND p.code = 'payroll.void'
ON CONFLICT DO NOTHING;

COMMIT;
