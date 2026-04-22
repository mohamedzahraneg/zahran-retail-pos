-- Migration 053: currency rates + FX gain/loss accounts
-- ---------------------------------------------------------------------------
-- Adds a daily FX rate table and two GL accounts so monthly revaluation
-- of foreign-currency cashboxes can post gain / loss automatically.

BEGIN;

CREATE TABLE IF NOT EXISTS currency_rates (
  id            UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  currency      VARCHAR(3) NOT NULL,
  rate_date     DATE NOT NULL,
  rate_to_egp   NUMERIC(14, 6) NOT NULL CHECK (rate_to_egp > 0),
  source        VARCHAR(60),       -- e.g. 'CBE', 'manual', 'bank X'
  notes         TEXT,
  created_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (currency, rate_date)
);

CREATE INDEX IF NOT EXISTS idx_fx_currency_date
  ON currency_rates(currency, rate_date DESC);

-- ── FX gain / loss accounts ──────────────────────────────────────────

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
      ('424', 'أرباح فروق صرف', 'FX Gain', 'revenue', 'credit', v_other_rev, TRUE, TRUE, 3, 4)
    ON CONFLICT (code) DO NOTHING;
  END IF;
  IF v_financial IS NOT NULL THEN
    INSERT INTO chart_of_accounts
      (code, name_ar, name_en, account_type, normal_balance, parent_id, is_leaf, is_system, level, sort_order)
    VALUES
      ('536', 'خسائر فروق صرف', 'FX Loss', 'expense', 'debit', v_financial, TRUE, TRUE, 3, 5)
    ON CONFLICT (code) DO NOTHING;
  END IF;
END$$;

-- ── Permissions ─────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'permissions') THEN
    INSERT INTO permissions (code, module, name_ar, name_en) VALUES
      ('accounts.fx', 'accounts', 'إدارة أسعار الصرف', 'Manage FX rates')
    ON CONFLICT (code) DO NOTHING;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'role_permissions') THEN
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM roles r, permissions p
       WHERE r.code IN ('admin', 'accountant')
         AND p.code = 'accounts.fx'
      ON CONFLICT DO NOTHING;
    END IF;

    IF EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_name='roles' AND column_name='permissions') THEN
      UPDATE roles SET permissions = ARRAY(
        SELECT DISTINCT code FROM (
          SELECT UNNEST(COALESCE(permissions, ARRAY[]::text[])) AS code
          UNION
          SELECT 'accounts.fx' WHERE roles.code IN ('admin','accountant')
        ) u ORDER BY code
      ) WHERE code IN ('admin','accountant');
    END IF;
  END IF;
END$$;

COMMIT;
