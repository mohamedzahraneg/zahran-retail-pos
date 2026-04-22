-- Migration 052: cost centers + budgets
-- ---------------------------------------------------------------------------
-- Phase G bits: lightweight cost-center tagging on journal lines so
-- analytics can slice by branch/department, and a basic budget table
-- for future "budget vs actual" reports.

BEGIN;

-- ── Cost centers ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS cost_centers (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  code        VARCHAR(20) NOT NULL UNIQUE,
  name_ar     VARCHAR(200) NOT NULL,
  name_en     VARCHAR(200),
  parent_id   UUID REFERENCES cost_centers(id) ON DELETE RESTRICT,
  warehouse_id UUID REFERENCES warehouses(id) ON DELETE SET NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='journal_lines' AND column_name='cost_center_id') THEN
    ALTER TABLE journal_lines
      ADD COLUMN cost_center_id UUID REFERENCES cost_centers(id) ON DELETE SET NULL;
    CREATE INDEX idx_jl_cost_center ON journal_lines(cost_center_id) WHERE cost_center_id IS NOT NULL;
  END IF;
END$$;

-- ── Budgets ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS budgets (
  id           UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name_ar      VARCHAR(200) NOT NULL,
  fiscal_year  INT NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS budget_lines (
  id          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  budget_id   UUID NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
  account_id  UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  month       INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  amount      NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (amount >= 0),
  UNIQUE (budget_id, account_id, month)
);

CREATE INDEX IF NOT EXISTS idx_budget_lines_account ON budget_lines(account_id);

-- ── Permissions ─────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'permissions') THEN
    INSERT INTO permissions (code, module, name_ar, name_en) VALUES
      ('accounts.budget',        'accounts', 'إدارة الموازنات',       'Manage budgets'),
      ('accounts.cost_centers',  'accounts', 'إدارة مراكز التكلفة',   'Manage cost centers')
    ON CONFLICT (code) DO NOTHING;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'role_permissions') THEN
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM roles r, permissions p
       WHERE r.code IN ('admin', 'accountant')
         AND p.code IN ('accounts.budget','accounts.cost_centers')
      ON CONFLICT DO NOTHING;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='roles' AND column_name='permissions') THEN
      UPDATE roles SET permissions = ARRAY(
        SELECT DISTINCT code FROM (
          SELECT UNNEST(COALESCE(permissions, ARRAY[]::text[])) AS code
          UNION
          SELECT p.code FROM permissions p
           WHERE p.code IN ('accounts.budget','accounts.cost_centers')
             AND roles.code IN ('admin','accountant')
        ) u ORDER BY code
      ) WHERE code IN ('admin','accountant');
    END IF;
  END IF;
END$$;

COMMIT;
