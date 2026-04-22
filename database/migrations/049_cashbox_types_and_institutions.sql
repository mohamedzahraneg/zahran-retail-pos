-- Migration 049: cashbox types + financial institutions reference
-- ---------------------------------------------------------------------------
-- Phase B of the accounting overhaul.
--
-- Extends the cashboxes table so it can represent:
--   cash     — physical drawer (default; existing rows)
--   bank     — a bank account with branch / account number / manager
--   ewallet  — a mobile wallet (Vodafone Cash, InstaPay, Fawry, …)
--   check    — checks-under-collection "drawer"
--
-- Also introduces `financial_institutions`: a small reference list of
-- Egyptian banks and e-wallets that the UI picks from when creating a
-- bank / wallet cashbox. Logos are sourced from Clearbit by the
-- frontend using the `website_domain` column so we don't ship binary
-- assets in the repo.

BEGIN;

-- ── Extend cashboxes with kind + conditional fields ───────────────────

ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS kind             TEXT NOT NULL DEFAULT 'cash';
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS institution_code  TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS bank_branch       TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS account_number    TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS iban              TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS swift_code        TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS account_holder_name  TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS account_manager_name TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS account_manager_phone TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS account_manager_email TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS wallet_phone      TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS wallet_owner_name TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS check_issuer_name TEXT;
ALTER TABLE cashboxes ADD COLUMN IF NOT EXISTS color             TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_cashbox_kind'
  ) THEN
    ALTER TABLE cashboxes
      ADD CONSTRAINT chk_cashbox_kind
      CHECK (kind IN ('cash', 'bank', 'ewallet', 'check'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_cashboxes_kind ON cashboxes(kind);

-- ── Financial institutions reference table ────────────────────────────

CREATE TABLE IF NOT EXISTS financial_institutions (
  code            TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('bank', 'ewallet', 'check_issuer')),
  name_ar         TEXT NOT NULL,
  name_en         TEXT NOT NULL,
  short_code      TEXT,          -- 3-letter SWIFT / abbreviation
  website_domain  TEXT,          -- feeds the Clearbit logo URL
  color_hex       TEXT,          -- brand color for fallback chips
  sort_order      INT  NOT NULL DEFAULT 100,
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  is_system       BOOLEAN NOT NULL DEFAULT FALSE,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_fi_kind ON financial_institutions(kind) WHERE is_active = TRUE;

-- Soft FK so cashboxes can reference institution_code for bank/wallet rows.
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

-- ── Seed Egyptian banks ──────────────────────────────────────────────

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
  ('POST',      'bank', 'هيئة البريد المصري',                      'Egypt Post',                           'POST',  'egyptpost.org',       '#f29100', 270, TRUE)
ON CONFLICT (code) DO UPDATE SET
  name_ar = EXCLUDED.name_ar,
  name_en = EXCLUDED.name_en,
  website_domain = EXCLUDED.website_domain,
  color_hex = EXCLUDED.color_hex,
  sort_order = EXCLUDED.sort_order,
  is_system = EXCLUDED.is_system;

-- ── Seed Egyptian e-wallets ──────────────────────────────────────────

INSERT INTO financial_institutions (code, kind, name_ar, name_en, short_code, website_domain, color_hex, sort_order, is_system) VALUES
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
  is_system = EXCLUDED.is_system;

-- ── Permissions seed ──────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'permissions') THEN
    INSERT INTO permissions (code, module, name_ar, name_en) VALUES
      ('cashdesk.manage_accounts', 'cashdesk', 'إدارة الخزائن والحسابات', 'Manage cashboxes & bank accounts')
    ON CONFLICT (code) DO NOTHING;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'role_permissions') THEN
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM roles r, permissions p
       WHERE r.code IN ('admin', 'accountant', 'manager')
         AND p.code = 'cashdesk.manage_accounts'
      ON CONFLICT DO NOTHING;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'roles' AND column_name = 'permissions'
    ) THEN
      -- Use a loop so every reference is fully qualified (no ambiguous
      -- `permissions` between the roles column and the permissions table).
      DECLARE
        r RECORD;
      BEGIN
        FOR r IN SELECT id, permissions FROM roles
                  WHERE code IN ('admin', 'accountant', 'manager')
        LOOP
          UPDATE roles
             SET permissions = ARRAY(
               SELECT DISTINCT code FROM (
                 SELECT UNNEST(COALESCE(r.permissions, ARRAY[]::text[])) AS code
                 UNION
                 SELECT 'cashdesk.manage_accounts'
               ) u ORDER BY code
             )
           WHERE id = r.id;
        END LOOP;
      END;
    END IF;
  END IF;
END$$;

COMMIT;
