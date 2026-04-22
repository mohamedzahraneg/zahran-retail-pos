-- Migration 055: cleanup + gap fill for 046-054
-- ---------------------------------------------------------------------------
-- Several earlier migrations had two subtle bugs that caused rows to be
-- marked "applied" in schema_migrations while parts of the DDL silently
-- failed on some Postgres versions:
--
--   (1) Ambiguous `permissions` reference inside UPDATE roles SET
--       permissions = ARRAY(... SELECT UNNEST(permissions) ...) — the
--       inner permissions could be either the column or the table.
--
--   (2) Missing cashboxes.currency column — referenced by cash-desk
--       service + fx service but never added.
--
-- This migration is fully idempotent (IF NOT EXISTS + ON CONFLICT) so
-- it can run safely on any state — fresh install, partially migrated,
-- or fully migrated.

BEGIN;

-- ── Gap 1: cashboxes.currency ───────────────────────────────────────

ALTER TABLE cashboxes
  ADD COLUMN IF NOT EXISTS currency VARCHAR(3) NOT NULL DEFAULT 'EGP';

-- ── Gap 2: financial_institutions (in case 049 partially failed) ───

CREATE TABLE IF NOT EXISTS financial_institutions (
  code            TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('bank', 'ewallet', 'check_issuer')),
  name_ar         TEXT NOT NULL,
  name_en         TEXT NOT NULL,
  short_code      TEXT,
  website_domain  TEXT,
  color_hex       TEXT,
  sort_order      INT  NOT NULL DEFAULT 100,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  is_system       BOOLEAN NOT NULL DEFAULT FALSE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fi_kind
  ON financial_institutions(kind) WHERE is_active = TRUE;

-- Seed — EG banks (idempotent)
INSERT INTO financial_institutions (code, kind, name_ar, name_en, short_code, website_domain, color_hex, sort_order, is_system) VALUES
  ('CIB',       'bank', 'البنك التجاري الدولي (CIB)',           'Commercial International Bank',       'CIB',   'cibeg.com',          '#00437c', 10, TRUE),
  ('NBE',       'bank', 'البنك الأهلي المصري',                   'National Bank of Egypt',              'NBE',   'nbe.com.eg',          '#005a9e', 20, TRUE),
  ('BM',        'bank', 'بنك مصر',                               'Banque Misr',                          'BM',    'banquemisr.com',      '#d40038', 30, TRUE),
  ('QNB',       'bank', 'QNB الأهلي',                            'QNB Alahli',                           'QNBA',  'qnbalahli.com',       '#692a54', 40, TRUE),
  ('AAIB',      'bank', 'البنك العربي الأفريقي الدولي',           'Arab African International Bank',     'AAIB',  'aaib.com',            '#0b4d83', 50, TRUE),
  ('BDC',       'bank', 'بنك القاهرة',                           'Banque du Caire',                     'BDC',   'banqueducaire.com',   '#b72126', 60, TRUE),
  ('HSBC_EG',   'bank', 'HSBC مصر',                              'HSBC Egypt',                           'HSBC',  'hsbc.com.eg',         '#db0011', 70, TRUE),
  ('ADIB_EG',   'bank', 'مصرف أبو ظبي الإسلامي (مصر)',            'ADIB Egypt',                           'ADIB',  'adib.eg',             '#005a30', 80, TRUE),
  ('FIBE',      'bank', 'بنك فيصل الإسلامي',                      'Faisal Islamic Bank of Egypt',         'FIBE',  'faisalbank.com.eg',   '#00704a', 90, TRUE),
  ('CAE',       'bank', 'كريدي أجريكول (مصر)',                   'Credit Agricole Egypt',                'CAE',   'ca-egypt.com',        '#006a4e', 100, TRUE),
  ('ENBD_EG',   'bank', 'الإمارات دبي الوطني (مصر)',              'Emirates NBD Egypt',                   'ENBD',  'emiratesnbd.eg',      '#d71920', 110, TRUE),
  ('AUB',       'bank', 'البنك العربي المتحد',                    'Ahli United Bank',                     'AUB',   'ahliunited.com',      '#005293', 120, TRUE),
  ('ALEX',      'bank', 'بنك الإسكندرية',                         'ALEXBANK',                             'ALEX',  'alexbank.com',        '#e4242d', 130, TRUE),
  ('ATTI',      'bank', 'التجاري وفا بنك (مصر)',                 'Attijariwafa Bank Egypt',              'ATTI',  'attijariwafabank.com','#d4a017', 140, TRUE),
  ('ADCB_EG',   'bank', 'أبو ظبي التجاري (مصر)',                  'ADCB Egypt',                           'ADCB',  'adcbegypt.com',       '#a31f34', 150, TRUE),
  ('EDBE',      'bank', 'بنك التنمية والصادرات',                  'Export Development Bank of Egypt',     'EDBE',  'edbe.com.eg',         '#1e4a8c', 160, TRUE),
  ('MASHREQ',   'bank', 'بنك المشرق (مصر)',                       'Mashreq Bank Egypt',                   'MASH',  'mashreqegypt.com',    '#cc0033', 170, TRUE),
  ('NBK_EG',    'bank', 'بنك الكويت الوطني (مصر)',                'NBK Egypt',                            'NBK',   'nbk.com.eg',          '#4d166d', 180, TRUE),
  ('BLOM',      'bank', 'بلوم بنك (مصر)',                         'Blom Bank Egypt',                      'BLOM',  'blombank.com.eg',     '#002a5c', 190, TRUE),
  ('SCB',       'bank', 'بنك قناة السويس',                        'Suez Canal Bank',                      'SCB',   'scbank.com.eg',       '#1a7d3e', 200, TRUE),
  ('BARAKA',    'bank', 'بنك البركة',                             'Al Baraka Bank Egypt',                 'ABEG',  'albaraka.com.eg',     '#00806b', 210, TRUE),
  ('HDB',       'bank', 'بنك التعمير والإسكان',                   'Housing & Development Bank',           'HDB',   'hdb-egy.com',         '#183a6b', 220, TRUE),
  ('SAIB',      'bank', 'المصرفية العربية الدولية (SAIB)',        'SAIB Bank',                            'SAIB',  'saib.com.eg',         '#0d5998', 230, TRUE),
  ('IDB_EG',    'bank', 'بنك التنمية الصناعية',                   'Industrial Development Bank',          'IDB',   'idbe-egypt.com',      '#2a4d69', 240, TRUE),
  ('ABE',       'bank', 'البنك الزراعي المصري',                   'Agricultural Bank of Egypt',           'ABE',   'abe.com.eg',          '#4c7c3a', 250, TRUE),
  ('EGB',       'bank', 'البنك المصري الخليجي',                   'Egyptian Gulf Bank',                   'EGB',   'egbankegypt.com',     '#c41230', 260, TRUE),
  ('POST',      'bank', 'هيئة البريد المصري',                      'Egypt Post',                           'POST',  'egyptpost.org',       '#f29100', 270, TRUE),
  ('INSTAPAY',     'ewallet', 'إنستاباي',                'InstaPay',              'IPN',    'instapay.eg',        '#df0b6c', 1010, TRUE),
  ('VODAFONE_CASH','ewallet', 'فودافون كاش',             'Vodafone Cash',         'VFC',    'vodafone.com.eg',    '#e60000', 1020, TRUE),
  ('ORANGE_CASH',  'ewallet', 'أورانج كاش',              'Orange Cash',           'ORC',    'orange.eg',          '#ff7900', 1030, TRUE),
  ('ETISALAT_CASH','ewallet', 'اتصالات كاش',             'Etisalat Cash',         'ETC',    'etisalat.eg',        '#a0d300', 1040, TRUE),
  ('WE_PAY',       'ewallet', 'WE Pay',                 'WE Pay',                'WEP',    'te.eg',              '#5c068c', 1050, TRUE),
  ('FAWRY',        'ewallet', 'فوري',                    'Fawry Pay',             'FWR',    'fawry.com',          '#ffc107', 1060, TRUE),
  ('MEEZA',        'ewallet', 'ميزة',                    'Meeza Digital Wallet',  'MZA',    'meezadigital.com',   '#004489', 1070, TRUE),
  ('VALU',         'ewallet', 'ValU',                   'ValU',                  'VAL',    'valu.com.eg',        '#0a2a4a', 1080, TRUE),
  ('PAYMOB',       'ewallet', 'باي موب',                 'PayMob',                'PYM',    'paymob.com',         '#0d9488', 1090, TRUE),
  ('BEE',          'ewallet', 'Bee',                    'Bee',                   'BEE',    'bee.com.eg',         '#f5b400', 1100, TRUE),
  ('AMAN',         'ewallet', 'أمان',                    'Aman',                  'AMN',    'aman.com.eg',        '#0076b6', 1110, TRUE),
  ('MASARY',       'ewallet', 'مصاري',                   'Masary',                'MSR',    'masaryeg.com',       '#009246', 1120, TRUE),
  ('KHALES',       'ewallet', 'خالص',                    'Khales',                'KHL',    'khales-eg.com',      '#1fa2ff', 1130, TRUE)
ON CONFLICT (code) DO UPDATE SET
  name_ar = EXCLUDED.name_ar,
  name_en = EXCLUDED.name_en,
  website_domain = EXCLUDED.website_domain,
  color_hex = EXCLUDED.color_hex,
  sort_order = EXCLUDED.sort_order,
  is_system = EXCLUDED.is_system,
  is_active = TRUE;

-- Cashboxes kind + institution_code (idempotent — 049 might have failed)
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS kind             TEXT NOT NULL DEFAULT 'cash';
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS institution_code TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS bank_branch      TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS account_number   TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS iban             TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS swift_code       TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS account_holder_name   TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS account_manager_name  TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS account_manager_phone TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS account_manager_email TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS wallet_phone      TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS wallet_owner_name TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS check_issuer_name TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS color             TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS opening_balance   NUMERIC(14,2) DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_cashbox_kind') THEN
    ALTER TABLE cashboxes
      ADD CONSTRAINT chk_cashbox_kind
      CHECK (kind IN ('cash', 'bank', 'ewallet', 'check'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_cashboxes_kind ON cashboxes(kind);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'cashboxes_institution_fk'
  ) THEN
    ALTER TABLE cashboxes
      ADD CONSTRAINT cashboxes_institution_fk
      FOREIGN KEY (institution_code)
      REFERENCES financial_institutions(code)
      ON DELETE SET NULL;
  END IF;
END$$;

-- ── Gap 3: cost_centers + budgets (052 failed on ambiguous permissions) ──

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

-- ── Gap 4: expense_approval_rules + expense_approvals (054 may have failed) ──

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS rejected_reason TEXT;

CREATE TABLE IF NOT EXISTS expense_approval_rules (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name_ar         VARCHAR(200) NOT NULL,
  min_amount      NUMERIC(14,2) NOT NULL CHECK (min_amount >= 0),
  max_amount      NUMERIC(14,2),
  required_role   VARCHAR(40) NOT NULL,
  level           INT NOT NULL CHECK (level > 0),
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

CREATE INDEX IF NOT EXISTS idx_exp_approvals_expense ON expense_approvals(expense_id);
CREATE INDEX IF NOT EXISTS idx_exp_approvals_status
  ON expense_approvals(status) WHERE status = 'pending';

-- ── Gap 5: currency_rates + FX accounts (053 may have failed) ──

CREATE TABLE IF NOT EXISTS currency_rates (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  currency      VARCHAR(3) NOT NULL,
  rate_date     DATE NOT NULL,
  rate_to_egp   NUMERIC(14, 6) NOT NULL CHECK (rate_to_egp > 0),
  source        VARCHAR(60),
  notes         TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (currency, rate_date)
);

CREATE INDEX IF NOT EXISTS idx_fx_currency_date
  ON currency_rates(currency, rate_date DESC);

-- ── Gap 6: Fixed asset schedules (051 may have failed) ──

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

-- ── Gap 7: journal_lines.customer_id/supplier_id (051 may have failed) ──

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

-- ── Gap 8: Cashbox reconciliation flags ───────────────────────────

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

-- ── Permissions seed (with fully-qualified columns, unambiguous) ──

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_name = 'permissions') THEN
    RETURN;
  END IF;

  INSERT INTO permissions (code, module, name_ar, name_en) VALUES
    ('accounts.chart.view',       'accounts', 'عرض شجرة الحسابات',       'View chart'),
    ('accounts.chart.manage',     'accounts', 'إدارة شجرة الحسابات',     'Manage chart'),
    ('accounts.journal.view',     'accounts', 'عرض القيود اليومية',       'View journal'),
    ('accounts.journal.post',     'accounts', 'ترحيل القيود',             'Post journal'),
    ('accounts.journal.void',     'accounts', 'إلغاء القيود',             'Void journal'),
    ('accounts.reconcile',        'accounts', 'تسوية بنكية',              'Bank reconciliation'),
    ('accounts.depreciation',     'accounts', 'إدارة إهلاك الأصول',       'Manage depreciation'),
    ('accounts.close_year',       'accounts', 'إقفال السنة المالية',       'Year-end closing'),
    ('accounts.budget',           'accounts', 'إدارة الموازنات',           'Manage budgets'),
    ('accounts.cost_centers',     'accounts', 'إدارة مراكز التكلفة',        'Manage cost centers'),
    ('accounts.fx',               'accounts', 'إدارة أسعار الصرف',         'Manage FX rates'),
    ('accounts.approval.manage',  'accounts', 'إدارة قواعد اعتماد المصروفات', 'Manage approval rules'),
    ('accounts.approval.decide',  'accounts', 'اتخاذ قرار اعتماد المصروفات',  'Decide on approvals'),
    ('cashdesk.manage_accounts',  'cashdesk', 'إدارة الخزائن والحسابات',    'Manage cashboxes')
  ON CONFLICT (code) DO NOTHING;

  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_name = 'role_permissions') THEN
    RETURN;
  END IF;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r, permissions p
   WHERE r.code IN ('admin', 'accountant')
     AND p.code LIKE 'accounts.%'
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r, permissions p
   WHERE r.code = 'manager'
     AND p.code IN (
       'accounts.chart.view', 'accounts.journal.view',
       'accounts.approval.decide', 'cashdesk.manage_accounts'
     )
  ON CONFLICT DO NOTHING;

  INSERT INTO role_permissions (role_id, permission_id)
  SELECT r.id, p.id FROM roles r, permissions p
   WHERE r.code IN ('admin', 'manager', 'accountant')
     AND p.code = 'cashdesk.manage_accounts'
  ON CONFLICT DO NOTHING;
END$$;

-- ── Denormalized roles.permissions[] array — unambiguously qualified ──

DO $$
DECLARE
  r RECORD;
  new_perms text[];
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'roles' AND column_name = 'permissions'
  ) THEN
    RETURN;
  END IF;

  FOR r IN SELECT id, code, permissions FROM roles
            WHERE code IN ('admin', 'accountant', 'manager')
  LOOP
    -- Build the new array: existing codes + any accounts.* / cashdesk.*
    -- that this role is entitled to via role_permissions.
    SELECT ARRAY_AGG(DISTINCT code ORDER BY code)
      INTO new_perms
      FROM (
        SELECT UNNEST(COALESCE(r.permissions, ARRAY[]::text[])) AS code
        UNION
        SELECT p.code
          FROM role_permissions rp
          JOIN permissions p ON p.id = rp.permission_id
         WHERE rp.role_id = r.id
      ) src;
    UPDATE roles SET permissions = new_perms WHERE id = r.id;
  END LOOP;
END$$;

-- ── Seed two default approval rules if none exist ───────────────────

INSERT INTO expense_approval_rules (name_ar, min_amount, max_amount, required_role, level)
SELECT v.n, v.mn, v.mx, v.role, v.lvl
  FROM (VALUES
    ('مصروف متوسط (١٠ألف+)', 10000::numeric, 50000::numeric, 'manager', 1),
    ('مصروف كبير  (٥٠ألف+)', 50000::numeric, NULL::numeric,  'admin',   1)
  ) AS v(n, mn, mx, role, lvl)
 WHERE NOT EXISTS (
   SELECT 1 FROM expense_approval_rules
    WHERE name_ar = v.n
 );

-- ── FX gain/loss accounts ──────────────────────────────────────────

DO $$
DECLARE
  v_other_rev UUID;
  v_financial UUID;
BEGIN
  SELECT id INTO v_other_rev FROM chart_of_accounts WHERE code = '42';
  SELECT id INTO v_financial FROM chart_of_accounts WHERE code = '53';

  IF v_other_rev IS NOT NULL THEN
    INSERT INTO chart_of_accounts
      (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
    VALUES
      ('423', 'أرباح جرد',       'Inventory Overage', 'revenue', 'credit', v_other_rev, TRUE, TRUE, 3, 3),
      ('424', 'أرباح فروق صرف', 'FX Gain',           'revenue', 'credit', v_other_rev, TRUE, TRUE, 3, 4)
    ON CONFLICT (code) DO NOTHING;
  END IF;

  IF v_financial IS NOT NULL THEN
    INSERT INTO chart_of_accounts
      (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
    VALUES
      ('534', 'خسائر جرد',                 'Inventory Shrinkage',  'expense', 'debit', v_financial, TRUE, TRUE, 3, 3),
      ('535', 'مصروف إهلاك الأصول الثابتة','Depreciation Expense', 'expense', 'debit', v_financial, TRUE, TRUE, 3, 4),
      ('536', 'خسائر فروق صرف',            'FX Loss',              'expense', 'debit', v_financial, TRUE, TRUE, 3, 5)
    ON CONFLICT (code) DO NOTHING;
  END IF;
END$$;

COMMIT;
