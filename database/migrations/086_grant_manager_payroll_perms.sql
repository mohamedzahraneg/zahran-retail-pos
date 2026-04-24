-- Migration 086 — Register missing employee.* permissions + grant manager the
--                   create/pay perms needed for PR-1 payroll cleanup.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   PR #88 added `employee.attendance.manage` to the settings.service.ts
--   catalog (frontend surface) but never seeded it into the
--   `permissions` table. Same story for `employee.deductions.manage`
--   and `employee.bonuses.manage` — used by @Permissions() decorators
--   since the original HR module, but never registered.
--
--   Today auth resolves permissions by reading the `roles.permissions`
--   text[] column (populated at seed time), so any role seeded BEFORE
--   a new permission existed doesn't know about it. Manager is such a
--   role.
--
--   User direction (PR-1): manager needs to create employee entries
--   and mark payable days, but must still NOT be able to void. Today
--   manager lacks:
--     * employee.deductions.manage  (gates POST /payroll, /bonuses,
--                                    /deductions — audit finding)
--     * employee.attendance.manage  (gates /attendance/admin/*)
--
-- Change
--
--   1. Insert the three missing `employee.*.manage` rows into the
--      `permissions` catalog (idempotent via ON CONFLICT DO NOTHING).
--
--   2. Append the two new grants to `roles.permissions` text[] for the
--      manager role. Uses array_agg(DISTINCT …) so the operation is
--      idempotent — re-running leaves the array unchanged.
--
--   3. Mirror the grants into the `role_permissions` junction so audit
--      queries and the admin-UI view both see them.
--
-- Not touched
--   * Admin role (still has '*' wildcard + explicit junction rows).
--   * Any void permission / @Roles('admin') gate — voids stay admin-only.
--   * FinancialEngine / guards / accounting logic.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Register the missing permission codes ──────────────────────────────

INSERT INTO permissions (code, module, name_ar, name_en) VALUES
  ('employee.bonuses.manage',    'employees',
   'إضافة حوافز/مكافآت/ساعات إضافية', 'Manage employee bonuses'),
  ('employee.deductions.manage', 'employees',
   'إضافة/تعديل استقطاعات',            'Manage employee deductions'),
  ('employee.attendance.manage', 'employees',
   'إدارة حضور ويومية الموظفين',        'Manage employee attendance + wage accrual')
ON CONFLICT (code) DO NOTHING;

-- ─── 2. Grant manager the two new create/pay permissions ───────────────────
-- Append to roles.permissions text[] idempotently. `employee.ledger.view`
-- is already granted (verified in PR-1 audit) — no-op if it's missing too.

UPDATE roles
   SET permissions = (
     SELECT array_agg(DISTINCT p ORDER BY p)
       FROM unnest(
         permissions
           || ARRAY[
                'employee.deductions.manage',
                'employee.attendance.manage',
                'employee.ledger.view'
              ]::text[]
       ) AS p
   )
 WHERE code = 'manager';

-- ─── 3. Mirror into role_permissions junction for audit consistency ───────

INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM roles r, permissions p
 WHERE r.code = 'manager'
   AND p.code IN (
     'employee.deductions.manage',
     'employee.attendance.manage',
     'employee.ledger.view'
   )
ON CONFLICT DO NOTHING;

-- ─── 4. Shared `employee_advance` expense category mapped to 1123 ──────────
--
-- The new pay-wage endpoint's overpayment branch (PR-1) treats excess
-- as an advance by routing through the canonical expense path
-- (is_advance=TRUE). FinancialEngineService.recordExpense overrides the
-- DR side to 1123 Employee Receivables whenever is_advance=TRUE and
-- employee_user_id is supplied, so the category's own account_id is
-- informational — but the Daily Expenses list + filters read the
-- category name, so we want a clean, shared one rather than the
-- per-employee deactivated rows that currently live in the table.
--
-- Seed the category only if it's missing. Idempotent.

DO $$
DECLARE
    v_account_id uuid;
    v_existing   uuid;
BEGIN
    SELECT id INTO v_account_id
      FROM chart_of_accounts
     WHERE code = '1123'
     LIMIT 1;
    IF v_account_id IS NULL THEN
        RAISE NOTICE 'migration 086: COA 1123 missing — skipping advance category seed';
        RETURN;
    END IF;

    SELECT id INTO v_existing
      FROM expense_categories
     WHERE code = 'employee_advance'
     LIMIT 1;

    IF v_existing IS NULL THEN
        INSERT INTO expense_categories
            (code, name_ar, name_en, account_id, is_active)
        VALUES
            ('employee_advance', 'سلف الموظفين', 'Employee advances',
             v_account_id, TRUE);
        RAISE NOTICE 'migration 086: seeded expense_categories.employee_advance';
    ELSE
        UPDATE expense_categories
           SET account_id = v_account_id,
               is_active  = TRUE,
               name_ar    = COALESCE(NULLIF(btrim(name_ar), ''), 'سلف الموظفين')
         WHERE id = v_existing;
        RAISE NOTICE 'migration 086: refreshed expense_categories.employee_advance';
    END IF;
END $$;

COMMIT;
