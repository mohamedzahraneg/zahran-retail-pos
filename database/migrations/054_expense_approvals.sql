-- Migration 054: multi-level expense approval
-- ---------------------------------------------------------------------------
-- Introduces an `expense_approvals` workflow driven by `expense_approval_rules`.
--
-- Flow:
--   1. When an expense is created with amount >= any rule's threshold,
--      expense_approvals rows are inserted for each level.
--   2. approvers see the pending items in an inbox, approve or reject.
--   3. Once all required levels are approved, the expense is flipped to
--      is_approved = TRUE (which triggers the existing GL posting).
--   4. If any level rejects, the expense stays rejected.

BEGIN;

-- Column used by the approval service when an expense is rejected.
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS rejected_reason TEXT;

CREATE TABLE IF NOT EXISTS expense_approval_rules (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name_ar         VARCHAR(200) NOT NULL,
  min_amount      NUMERIC(14,2) NOT NULL CHECK (min_amount >= 0),
  max_amount      NUMERIC(14,2),     -- NULL = no upper bound
  required_role   VARCHAR(40) NOT NULL, -- e.g. 'manager','admin','owner'
  level           INT NOT NULL CHECK (level > 0),  -- 1,2,3…
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_approval_rules_active
  ON expense_approval_rules(is_active, min_amount) WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS expense_approvals (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  expense_id      UUID NOT NULL REFERENCES expenses(id) ON DELETE CASCADE,
  rule_id         UUID NOT NULL REFERENCES expense_approval_rules(id) ON DELETE RESTRICT,
  level           INT NOT NULL,
  required_role   VARCHAR(40) NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','approved','rejected')),
  decided_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at      TIMESTAMPTZ,
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_exp_approvals_expense
  ON expense_approvals(expense_id);
CREATE INDEX IF NOT EXISTS idx_exp_approvals_status
  ON expense_approvals(status) WHERE status = 'pending';

-- Seed a couple of sensible defaults so the system has rules out of the box.
INSERT INTO expense_approval_rules (name_ar, min_amount, max_amount, required_role, level)
VALUES
  ('مصروف متوسط (١٠ألف+)', 10000, 50000, 'manager',  1),
  ('مصروف كبير  (٥٠ألف+)', 50000, NULL,  'admin',    1)
ON CONFLICT DO NOTHING;

-- Permissions
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'permissions') THEN
    INSERT INTO permissions (code, module, name_ar, name_en) VALUES
      ('accounts.approval.manage', 'accounts', 'إدارة قواعد اعتماد المصروفات', 'Manage approval rules'),
      ('accounts.approval.decide', 'accounts', 'اتخاذ قرار اعتماد المصروفات',  'Decide on expense approvals')
    ON CONFLICT (code) DO NOTHING;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'role_permissions') THEN
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM roles r, permissions p
       WHERE (
               (r.code IN ('admin','accountant') AND p.code = 'accounts.approval.manage')
            OR (r.code IN ('admin','manager','accountant') AND p.code = 'accounts.approval.decide')
             )
      ON CONFLICT DO NOTHING;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='roles' AND column_name='permissions') THEN
      UPDATE roles r SET permissions = ARRAY(
        SELECT DISTINCT code FROM (
          SELECT UNNEST(COALESCE(r.permissions, ARRAY[]::text[])) AS code
          UNION
          SELECT 'accounts.approval.manage' WHERE r.code IN ('admin','accountant')
          UNION
          SELECT 'accounts.approval.decide' WHERE r.code IN ('admin','manager','accountant')
        ) u ORDER BY code
      ) WHERE r.code IN ('admin','accountant','manager');
    END IF;
  END IF;
END$$;

COMMIT;
