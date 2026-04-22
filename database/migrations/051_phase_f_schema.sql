-- Migration 051: Phase F foundations
-- ---------------------------------------------------------------------------
-- Adds the schema pieces that Phase F's code hooks need:
--
--   1) journal_lines.customer_id / supplier_id
--      Lets the GL carry party identity on receivable/payable postings,
--      so كشف حساب لعميل/مورد can be rebuilt straight from the journal.
--
--   2) New system accounts
--      534 خسائر جرد        (shrinkage expense)
--      423 أرباح جرد         (inventory overage revenue)
--      324 أرباح محتجزة سابقة(retained earnings counterpart used by the
--                              year-end closing entry)
--
--   3) cashbox_transactions.reconciled flags
--      Bank reconciliation ticks which transactions are matched against
--      a physical statement.
--
--   4) fixed_asset_schedules
--      Lightweight schedule so the depreciation cron can run. Each row
--      links a fixed-asset COA account to its cost / useful life /
--      salvage / last-posted month.
--
-- Everything idempotent — safe to re-run.

BEGIN;

-- ── (1) customer/supplier on journal_lines ──────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='journal_lines' AND column_name='customer_id') THEN
    ALTER TABLE journal_lines
      ADD COLUMN customer_id UUID REFERENCES customers(id) ON DELETE SET NULL;
    CREATE INDEX idx_jl_customer ON journal_lines(customer_id) WHERE customer_id IS NOT NULL;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='journal_lines' AND column_name='supplier_id') THEN
    ALTER TABLE journal_lines
      ADD COLUMN supplier_id UUID REFERENCES suppliers(id) ON DELETE SET NULL;
    CREATE INDEX idx_jl_supplier ON journal_lines(supplier_id) WHERE supplier_id IS NOT NULL;
  END IF;
END$$;

-- ── (2) New accounts ────────────────────────────────────────────────

DO $$
DECLARE
  v_other_rev UUID;
  v_financial UUID;
  v_equity    UUID;
BEGIN
  SELECT id INTO v_other_rev FROM chart_of_accounts WHERE code = '42';
  SELECT id INTO v_financial FROM chart_of_accounts WHERE code = '53';
  SELECT id INTO v_equity    FROM chart_of_accounts WHERE code = '3';

  IF v_other_rev IS NOT NULL THEN
    INSERT INTO chart_of_accounts
      (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
    VALUES
      ('423', 'أرباح جرد', 'Inventory Overage', 'revenue', 'credit', v_other_rev, TRUE, TRUE, 3, 3)
    ON CONFLICT (code) DO NOTHING;
  END IF;

  IF v_financial IS NOT NULL THEN
    INSERT INTO chart_of_accounts
      (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
    VALUES
      ('534', 'خسائر جرد', 'Inventory Shrinkage', 'expense', 'debit', v_financial, TRUE, TRUE, 3, 3),
      ('535', 'مصروف إهلاك الأصول الثابتة', 'Depreciation Expense', 'expense', 'debit', v_financial, TRUE, TRUE, 3, 4)
    ON CONFLICT (code) DO NOTHING;
  END IF;
END$$;

-- ── (3) Reconciliation flags ────────────────────────────────────────

ALTER TABLE cashbox_transactions
  ADD COLUMN IF NOT EXISTS is_reconciled BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE cashbox_transactions
  ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;
ALTER TABLE cashbox_transactions
  ADD COLUMN IF NOT EXISTS reconciled_by UUID REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE cashbox_transactions
  ADD COLUMN IF NOT EXISTS statement_reference VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_ct_reconciled
  ON cashbox_transactions(cashbox_id, is_reconciled)
  WHERE is_reconciled = FALSE;

-- ── (4) Fixed asset schedules ───────────────────────────────────────

CREATE TABLE IF NOT EXISTS fixed_asset_schedules (
  id             UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id     UUID NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  name_ar        TEXT NOT NULL,
  cost           NUMERIC(14,2) NOT NULL CHECK (cost > 0),
  salvage_value  NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (salvage_value >= 0),
  useful_life_months INT NOT NULL CHECK (useful_life_months > 0),
  start_date     DATE NOT NULL,
  last_posted_month DATE,
  accum_dep_account_id UUID REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  notes          TEXT,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fa_active
  ON fixed_asset_schedules(is_active, last_posted_month);

COMMENT ON TABLE fixed_asset_schedules IS
  'يومي الإهلاك الشهري — تدخل التكلفة وقيمة الخردة والعمر الإنتاجي، والنظام يرحّل قسطًا شهريًا تلقائيًا.';

-- ── Permissions (reconciliation + fixed assets + closing) ───────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'permissions') THEN
    INSERT INTO permissions (code, module, name_ar, name_en) VALUES
      ('accounts.reconcile',     'accounts', 'تسوية بنكية',              'Bank reconciliation'),
      ('accounts.depreciation',  'accounts', 'إدارة إهلاك الأصول',       'Manage depreciation'),
      ('accounts.close_year',    'accounts', 'إقفال السنة المالية',      'Year-end closing')
    ON CONFLICT (code) DO NOTHING;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'role_permissions') THEN
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM roles r, permissions p
       WHERE r.code IN ('admin', 'accountant')
         AND p.code IN ('accounts.reconcile','accounts.depreciation','accounts.close_year')
      ON CONFLICT DO NOTHING;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='roles' AND column_name='permissions') THEN
      UPDATE roles SET permissions = ARRAY(
        SELECT DISTINCT code FROM (
          SELECT UNNEST(COALESCE(permissions, ARRAY[]::text[])) AS code
          UNION
          SELECT p.code FROM permissions p
           WHERE p.code IN ('accounts.reconcile','accounts.depreciation','accounts.close_year')
             AND roles.code IN ('admin','accountant')
        ) u ORDER BY code
      ) WHERE code IN ('admin','accountant');
    END IF;
  END IF;
END$$;

COMMIT;
