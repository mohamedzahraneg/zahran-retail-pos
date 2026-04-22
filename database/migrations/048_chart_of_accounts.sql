-- Migration 048: Chart of Accounts + double-entry Journal
-- =========================================================================
-- Phase A of the accounting overhaul.
--
-- Adds three tables:
--   chart_of_accounts   — hierarchical account tree (assets / liabilities /
--                         equity / revenue / expenses)
--   journal_entries     — one row per accounting event (sale, expense,
--                         payment, manual adjustment, …)
--   journal_lines       — the debit/credit lines that make up each entry.
--                         A CHECK constraint forces every line to be
--                         strictly debit XOR credit; a trigger enforces
--                         that every posted entry is balanced (Σdebit =
--                         Σcredit).
--
-- Also adds a v_account_balances view so the UI can read balances without
-- aggregating thousands of lines on every page load.
--
-- Nothing in this migration auto-posts yet — Phase C will wire invoices,
-- expenses, payments, etc. into journal_entries automatically. Phase A
-- delivers the foundation and manual entry support.
-- =========================================================================

BEGIN;

-- ── Types ──────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'account_type') THEN
    CREATE TYPE account_type AS ENUM (
      'asset', 'liability', 'equity', 'revenue', 'expense'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'normal_balance') THEN
    CREATE TYPE normal_balance AS ENUM ('debit', 'credit');
  END IF;
END$$;

-- ── chart_of_accounts ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS chart_of_accounts (
  id             UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  code           VARCHAR(20)    NOT NULL UNIQUE,
  name_ar        VARCHAR(200)   NOT NULL,
  name_en        VARCHAR(200),
  account_type   account_type   NOT NULL,
  normal_balance normal_balance NOT NULL,
  parent_id      UUID           REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  is_leaf        BOOLEAN        NOT NULL DEFAULT TRUE,
  is_system      BOOLEAN        NOT NULL DEFAULT FALSE,  -- system accounts can't be deleted
  is_active      BOOLEAN        NOT NULL DEFAULT TRUE,
  description    TEXT,
  level          INT            NOT NULL DEFAULT 1,
  sort_order     INT            NOT NULL DEFAULT 0,
  cashbox_id     UUID           REFERENCES cashboxes(id) ON DELETE SET NULL, -- optional FK
  created_by     UUID           REFERENCES users(id),
  created_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ    NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coa_parent ON chart_of_accounts(parent_id);
CREATE INDEX IF NOT EXISTS idx_coa_type   ON chart_of_accounts(account_type);
CREATE INDEX IF NOT EXISTS idx_coa_active ON chart_of_accounts(is_active);

-- When a parent gets a child we flip is_leaf = FALSE so callers know they
-- can't post directly against it.
CREATE OR REPLACE FUNCTION fn_coa_mark_parent_not_leaf()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    UPDATE chart_of_accounts SET is_leaf = FALSE WHERE id = NEW.parent_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_coa_parent_not_leaf ON chart_of_accounts;
CREATE TRIGGER trg_coa_parent_not_leaf
AFTER INSERT OR UPDATE OF parent_id ON chart_of_accounts
FOR EACH ROW EXECUTE FUNCTION fn_coa_mark_parent_not_leaf();

-- ── journal_entries ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS journal_entries (
  id              UUID          PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_no        VARCHAR(30)   NOT NULL UNIQUE,
  entry_date      DATE          NOT NULL,
  description     TEXT,
  reference_type  VARCHAR(40),                  -- invoice, expense, payment, manual, …
  reference_id    UUID,
  is_posted       BOOLEAN       NOT NULL DEFAULT FALSE,
  is_void         BOOLEAN       NOT NULL DEFAULT FALSE,
  void_reason     TEXT,
  reversal_of     UUID          REFERENCES journal_entries(id),  -- if this entry reverses another
  posted_by       UUID          REFERENCES users(id),
  posted_at       TIMESTAMPTZ,
  voided_by       UUID          REFERENCES users(id),
  voided_at       TIMESTAMPTZ,
  created_by      UUID          REFERENCES users(id),
  created_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_je_date   ON journal_entries(entry_date);
CREATE INDEX IF NOT EXISTS idx_je_ref    ON journal_entries(reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_je_posted ON journal_entries(is_posted) WHERE is_posted = TRUE;
CREATE INDEX IF NOT EXISTS idx_je_void   ON journal_entries(is_void);

CREATE SEQUENCE IF NOT EXISTS seq_journal_entry_no START 1;

-- ── journal_lines ─────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS journal_lines (
  id           UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  entry_id     UUID         NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  line_no      INT          NOT NULL,
  account_id   UUID         NOT NULL REFERENCES chart_of_accounts(id) ON DELETE RESTRICT,
  debit        NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit  >= 0),
  credit       NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  description  TEXT,
  cashbox_id   UUID         REFERENCES cashboxes(id),
  warehouse_id UUID         REFERENCES warehouses(id),
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_debit_xor_credit
    CHECK (
      (debit > 0 AND credit = 0)
      OR (credit > 0 AND debit = 0)
    )
);

CREATE INDEX IF NOT EXISTS idx_jl_entry   ON journal_lines(entry_id);
CREATE INDEX IF NOT EXISTS idx_jl_account ON journal_lines(account_id);

-- Enforce "every posted entry balances" when the entry is flagged posted.
CREATE OR REPLACE FUNCTION fn_je_enforce_balance()
RETURNS TRIGGER AS $$
DECLARE
  total_d NUMERIC(14,2);
  total_c NUMERIC(14,2);
BEGIN
  IF NEW.is_posted = TRUE THEN
    SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0)
      INTO total_d, total_c
      FROM journal_lines
     WHERE entry_id = NEW.id;
    IF ABS(total_d - total_c) > 0.01 THEN
      RAISE EXCEPTION 'قيد غير متوازن: إجمالي المدين % لا يساوي إجمالي الدائن %',
        total_d, total_c;
    END IF;
    IF total_d = 0 THEN
      RAISE EXCEPTION 'لا يمكن ترحيل قيد بدون سطور';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_je_enforce_balance ON journal_entries;
CREATE TRIGGER trg_je_enforce_balance
BEFORE UPDATE OF is_posted ON journal_entries
FOR EACH ROW
WHEN (NEW.is_posted = TRUE AND (OLD.is_posted IS DISTINCT FROM NEW.is_posted))
EXECUTE FUNCTION fn_je_enforce_balance();

-- ── View: account balances ────────────────────────────────────────────

DROP VIEW IF EXISTS v_account_balances CASCADE;
CREATE VIEW v_account_balances AS
SELECT
  a.id             AS account_id,
  a.code,
  a.name_ar,
  a.name_en,
  a.account_type,
  a.normal_balance,
  a.parent_id,
  a.is_leaf,
  a.is_active,
  COALESCE(SUM(jl.debit),  0)::numeric(14,2) AS total_debit,
  COALESCE(SUM(jl.credit), 0)::numeric(14,2) AS total_credit,
  CASE a.normal_balance
    WHEN 'debit'  THEN COALESCE(SUM(jl.debit),  0) - COALESCE(SUM(jl.credit), 0)
    ELSE              COALESCE(SUM(jl.credit), 0) - COALESCE(SUM(jl.debit),  0)
  END::numeric(14,2) AS balance
FROM chart_of_accounts a
LEFT JOIN journal_lines   jl ON jl.account_id = a.id
LEFT JOIN journal_entries je ON je.id = jl.entry_id
  AND je.is_posted = TRUE
  AND je.is_void   = FALSE
GROUP BY a.id, a.code, a.name_ar, a.name_en, a.account_type,
         a.normal_balance, a.parent_id, a.is_leaf, a.is_active;

COMMENT ON VIEW v_account_balances IS
  'Posted, non-void balance per account. Powers the chart-of-accounts tree and the trial balance.';

-- ── Permissions seed ──────────────────────────────────────────────────
-- Add the new permission slugs so admins/accountants get them via the
-- existing role/permission machinery. `*` wildcard on admins keeps
-- working automatically.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_name = 'permissions') THEN
    INSERT INTO permissions (code, module, name_ar, name_en) VALUES
      ('accounts.chart.view',   'accounts', 'عرض شجرة الحسابات',     'View chart of accounts'),
      ('accounts.chart.manage', 'accounts', 'إدارة شجرة الحسابات',   'Manage chart of accounts'),
      ('accounts.journal.view', 'accounts', 'عرض القيود اليومية',    'View journal entries'),
      ('accounts.journal.post', 'accounts', 'ترحيل القيود',           'Post journal entries'),
      ('accounts.journal.void', 'accounts', 'إلغاء القيود',           'Void journal entries')
    ON CONFLICT (code) DO NOTHING;

    -- Grant to admin + accountant via the existing role_permissions junction.
    IF EXISTS (SELECT 1 FROM information_schema.tables
               WHERE table_name = 'role_permissions') THEN
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id
        FROM roles r, permissions p
       WHERE r.code IN ('admin', 'accountant', 'manager')
         AND p.code LIKE 'accounts.%'
      ON CONFLICT DO NOTHING;
    END IF;

    -- Mirror to the denormalized roles.permissions[] array (migration 026).
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'roles' AND column_name = 'permissions'
    ) THEN
      UPDATE roles
         SET permissions = (
           SELECT ARRAY_AGG(DISTINCT code ORDER BY code)
             FROM (
               SELECT UNNEST(COALESCE(permissions, ARRAY[]::text[])) AS code
               UNION
               SELECT p.code FROM permissions p
                WHERE p.code LIKE 'accounts.%'
             ) all_codes
         )
       WHERE code IN ('admin', 'accountant', 'manager');
    END IF;
  END IF;
END$$;

-- ── Seed a sensible default Chart of Accounts (Egyptian retail) ──────
-- Only seed when the table is empty, so re-running the migration doesn't
-- duplicate rows.

DO $$
DECLARE
  v_count INT;
  v_assets UUID;
  v_current_assets UUID;
  v_cash UUID;
  v_bank UUID;
  v_receivables UUID;
  v_inventory UUID;
  v_fixed_assets UUID;
  v_liabilities UUID;
  v_current_liab UUID;
  v_equity UUID;
  v_revenue UUID;
  v_sales UUID;
  v_other_revenue UUID;
  v_expenses UUID;
  v_cogs UUID;
  v_operating UUID;
  v_financial UUID;
BEGIN
  SELECT COUNT(*) INTO v_count FROM chart_of_accounts;
  IF v_count > 0 THEN
    RETURN;
  END IF;

  -- Level 1 — top-level categories
  INSERT INTO chart_of_accounts (code, name_ar, name_en, account_type, normal_balance, is_leaf, is_system, level)
  VALUES
    ('1', 'الأصول',         'Assets',      'asset',     'debit',  FALSE, TRUE, 1),
    ('2', 'الخصوم',         'Liabilities', 'liability', 'credit', FALSE, TRUE, 1),
    ('3', 'حقوق الملكية',    'Equity',      'equity',    'credit', FALSE, TRUE, 1),
    ('4', 'الإيرادات',       'Revenue',     'revenue',   'credit', FALSE, TRUE, 1),
    ('5', 'المصروفات',       'Expenses',    'expense',   'debit',  FALSE, TRUE, 1);

  SELECT id INTO v_assets       FROM chart_of_accounts WHERE code = '1';
  SELECT id INTO v_liabilities  FROM chart_of_accounts WHERE code = '2';
  SELECT id INTO v_equity       FROM chart_of_accounts WHERE code = '3';
  SELECT id INTO v_revenue      FROM chart_of_accounts WHERE code = '4';
  SELECT id INTO v_expenses     FROM chart_of_accounts WHERE code = '5';

  -- Level 2 — under Assets (1)
  INSERT INTO chart_of_accounts (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
  VALUES
    ('11', 'الأصول المتداولة',   'Current Assets', 'asset', 'debit', v_assets, FALSE, TRUE, 2, 1),
    ('12', 'الأصول الثابتة',     'Fixed Assets',   'asset', 'debit', v_assets, FALSE, TRUE, 2, 2);

  SELECT id INTO v_current_assets FROM chart_of_accounts WHERE code = '11';
  SELECT id INTO v_fixed_assets   FROM chart_of_accounts WHERE code = '12';

  -- Level 3 — under Current Assets (11)
  INSERT INTO chart_of_accounts (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
  VALUES
    ('111', 'النقدية وما في حكمها', 'Cash and Equivalents', 'asset', 'debit', v_current_assets, FALSE, TRUE, 3, 1),
    ('112', 'العملاء والمدينون',    'Receivables',          'asset', 'debit', v_current_assets, FALSE, TRUE, 3, 2),
    ('113', 'المخزون',              'Inventory',            'asset', 'debit', v_current_assets, FALSE, TRUE, 3, 3);

  SELECT id INTO v_cash        FROM chart_of_accounts WHERE code = '111';
  SELECT id INTO v_receivables FROM chart_of_accounts WHERE code = '112';
  SELECT id INTO v_inventory   FROM chart_of_accounts WHERE code = '113';

  -- Level 4 — under Cash (111): one account per cashbox type
  INSERT INTO chart_of_accounts (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
  VALUES
    ('1111', 'الخزينة الرئيسية (نقدي)', 'Main Cashbox',     'asset', 'debit', v_cash, TRUE, TRUE, 4, 1),
    ('1112', 'الخزائن الفرعية',         'Sub Cashboxes',    'asset', 'debit', v_cash, TRUE, TRUE, 4, 2),
    ('1113', 'الحسابات البنكية',        'Bank Accounts',    'asset', 'debit', v_cash, TRUE, TRUE, 4, 3),
    ('1114', 'المحافظ الإلكترونية',     'E-Wallets',        'asset', 'debit', v_cash, TRUE, TRUE, 4, 4),
    ('1115', 'الشيكات تحت التحصيل',     'Checks Pending',   'asset', 'debit', v_cash, TRUE, TRUE, 4, 5);

  -- Level 4 — receivables
  INSERT INTO chart_of_accounts (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
  VALUES
    ('1121', 'ذمم العملاء',              'Customer Receivables', 'asset', 'debit', v_receivables, TRUE, TRUE, 4, 1),
    ('1122', 'دفعات مقدمة للموردين',     'Supplier Advances',    'asset', 'debit', v_receivables, TRUE, TRUE, 4, 2);

  -- Level 4 — inventory
  INSERT INTO chart_of_accounts (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
  VALUES
    ('1131', 'بضاعة برسم البيع',  'Merchandise',         'asset', 'debit', v_inventory, TRUE, TRUE, 4, 1),
    ('1132', 'بضاعة في الطريق',   'Inventory in Transit','asset', 'debit', v_inventory, TRUE, TRUE, 4, 2);

  -- Level 3 — under Fixed Assets (12)
  INSERT INTO chart_of_accounts (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
  VALUES
    ('121', 'معدات وأجهزة',  'Equipment',        'asset', 'debit', v_fixed_assets, TRUE, TRUE, 3, 1),
    ('122', 'أثاث وتجهيزات', 'Furniture',        'asset', 'debit', v_fixed_assets, TRUE, TRUE, 3, 2),
    ('123', 'مجمع الإهلاك',  'Accumulated Depr.', 'asset', 'credit', v_fixed_assets, TRUE, TRUE, 3, 3);

  -- Level 2 — Liabilities (2)
  INSERT INTO chart_of_accounts (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
  VALUES
    ('21', 'الخصوم المتداولة', 'Current Liabilities', 'liability', 'credit', v_liabilities, FALSE, TRUE, 2, 1);

  SELECT id INTO v_current_liab FROM chart_of_accounts WHERE code = '21';

  INSERT INTO chart_of_accounts (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
  VALUES
    ('211', 'الموردون والدائنون',         'Suppliers & Payables', 'liability', 'credit', v_current_liab, TRUE, TRUE, 3, 1),
    ('212', 'دفعات مقدمة من العملاء',     'Customer Deposits',    'liability', 'credit', v_current_liab, TRUE, TRUE, 3, 2),
    ('213', 'مستحقات الموظفين',           'Employee Payables',    'liability', 'credit', v_current_liab, TRUE, TRUE, 3, 3),
    ('214', 'ضرائب مستحقة',               'Tax Payable',          'liability', 'credit', v_current_liab, TRUE, TRUE, 3, 4);

  -- Level 2 — Equity (3)
  INSERT INTO chart_of_accounts (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
  VALUES
    ('31', 'رأس المال',        'Capital',          'equity', 'credit', v_equity, TRUE, TRUE, 2, 1),
    ('32', 'الأرباح المحتجزة', 'Retained Earnings','equity', 'credit', v_equity, TRUE, TRUE, 2, 2);

  -- Level 2 — Revenue (4)
  INSERT INTO chart_of_accounts (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
  VALUES
    ('41', 'إيرادات المبيعات',   'Sales Revenue',   'revenue', 'credit', v_revenue, FALSE, TRUE, 2, 1),
    ('42', 'إيرادات أخرى',       'Other Revenue',   'revenue', 'credit', v_revenue, FALSE, TRUE, 2, 2),
    ('49', 'مرتدات المبيعات',    'Sales Returns',   'revenue', 'debit',  v_revenue, TRUE,  TRUE, 2, 9);

  SELECT id INTO v_sales         FROM chart_of_accounts WHERE code = '41';
  SELECT id INTO v_other_revenue FROM chart_of_accounts WHERE code = '42';

  INSERT INTO chart_of_accounts (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
  VALUES
    ('411', 'مبيعات السلع',     'Merchandise Sales', 'revenue', 'credit', v_sales, TRUE, TRUE, 3, 1),
    ('412', 'مبيعات خدمات',     'Service Sales',     'revenue', 'credit', v_sales, TRUE, TRUE, 3, 2),
    ('421', 'فروق ورديات (زيادة)','Shift Surplus',   'revenue', 'credit', v_other_revenue, TRUE, TRUE, 3, 1),
    ('422', 'إيرادات متنوعة',   'Misc Revenue',      'revenue', 'credit', v_other_revenue, TRUE, TRUE, 3, 2);

  -- Level 2 — Expenses (5)
  INSERT INTO chart_of_accounts (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
  VALUES
    ('51', 'تكلفة البضاعة المباعة', 'COGS',              'expense', 'debit', v_expenses, TRUE,  TRUE, 2, 1),
    ('52', 'المصروفات التشغيلية',   'Operating Expenses','expense', 'debit', v_expenses, FALSE, TRUE, 2, 2),
    ('53', 'مصروفات مالية',         'Financial Expenses','expense', 'debit', v_expenses, FALSE, TRUE, 2, 3);

  SELECT id INTO v_cogs      FROM chart_of_accounts WHERE code = '51';
  SELECT id INTO v_operating FROM chart_of_accounts WHERE code = '52';
  SELECT id INTO v_financial FROM chart_of_accounts WHERE code = '53';

  -- Operating sub-accounts — one per common category
  INSERT INTO chart_of_accounts (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
  VALUES
    ('521', 'رواتب وأجور',        'Salaries',      'expense', 'debit', v_operating, TRUE, TRUE, 3, 1),
    ('522', 'إيجار',              'Rent',          'expense', 'debit', v_operating, TRUE, TRUE, 3, 2),
    ('523', 'كهرباء ومياه',       'Utilities',     'expense', 'debit', v_operating, TRUE, TRUE, 3, 3),
    ('524', 'اتصالات وإنترنت',    'Telecom',       'expense', 'debit', v_operating, TRUE, TRUE, 3, 4),
    ('525', 'شحن وتوصيل',          'Shipping',      'expense', 'debit', v_operating, TRUE, TRUE, 3, 5),
    ('526', 'إعلانات وتسويق',     'Marketing',     'expense', 'debit', v_operating, TRUE, TRUE, 3, 6),
    ('527', 'صيانة',              'Maintenance',   'expense', 'debit', v_operating, TRUE, TRUE, 3, 7),
    ('528', 'مستلزمات مكتبية',    'Office Supplies','expense', 'debit', v_operating, TRUE, TRUE, 3, 8),
    ('529', 'مصروفات متفرقة',     'Misc Expenses', 'expense', 'debit', v_operating, TRUE, TRUE, 3, 9),
    ('531', 'فروق ورديات (عجز)',  'Shift Deficit', 'expense', 'debit', v_financial, TRUE, TRUE, 3, 1),
    ('532', 'عمولات وفوائد بنكية','Bank Charges',  'expense', 'debit', v_financial, TRUE, TRUE, 3, 2);
END$$;

COMMIT;
