-- Migration 050: wiring for the auto-posting service
-- ---------------------------------------------------------------------------
-- Phase C of the accounting overhaul. Nothing in this migration changes
-- existing data — it only adds optional FK columns that let the posting
-- service resolve the right GL account for each event:
--
--   expense_categories.account_id  →  which expense account (521..529, 531…)
--                                      a category posts against.
--
-- Also best-effort maps the default seed categories (الإيجار، الرواتب،
-- …) to their natural COA accounts so existing installations get
-- sensible behaviour on day one.

BEGIN;

-- ── expense_categories → account_id ──────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
             WHERE table_name = 'expense_categories')
     AND NOT EXISTS (SELECT 1 FROM information_schema.columns
                      WHERE table_name = 'expense_categories'
                        AND column_name = 'account_id') THEN
    ALTER TABLE expense_categories
      ADD COLUMN account_id UUID REFERENCES chart_of_accounts(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_expense_categories_account
      ON expense_categories(account_id);
  END IF;
END$$;

-- Best-effort: map well-known Arabic category names to COA accounts.
-- Only updates rows where account_id is still NULL so re-running is safe.

DO $$
DECLARE
  v_rent       UUID;
  v_salaries   UUID;
  v_utilities  UUID;
  v_telecom    UUID;
  v_shipping   UUID;
  v_marketing  UUID;
  v_maintain   UUID;
  v_supplies   UUID;
  v_misc       UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_name = 'expense_categories') THEN
    RETURN;
  END IF;

  SELECT id INTO v_rent       FROM chart_of_accounts WHERE code = '522' LIMIT 1;
  SELECT id INTO v_salaries   FROM chart_of_accounts WHERE code = '521' LIMIT 1;
  SELECT id INTO v_utilities  FROM chart_of_accounts WHERE code = '523' LIMIT 1;
  SELECT id INTO v_telecom    FROM chart_of_accounts WHERE code = '524' LIMIT 1;
  SELECT id INTO v_shipping   FROM chart_of_accounts WHERE code = '525' LIMIT 1;
  SELECT id INTO v_marketing  FROM chart_of_accounts WHERE code = '526' LIMIT 1;
  SELECT id INTO v_maintain   FROM chart_of_accounts WHERE code = '527' LIMIT 1;
  SELECT id INTO v_supplies   FROM chart_of_accounts WHERE code = '528' LIMIT 1;
  SELECT id INTO v_misc       FROM chart_of_accounts WHERE code = '529' LIMIT 1;

  UPDATE expense_categories SET account_id = v_rent
    WHERE account_id IS NULL AND (name_ar ILIKE '%إيجار%' OR name_en ILIKE '%rent%');
  UPDATE expense_categories SET account_id = v_salaries
    WHERE account_id IS NULL AND (name_ar ILIKE '%رات%' OR name_ar ILIKE '%أجور%' OR name_en ILIKE '%salar%');
  UPDATE expense_categories SET account_id = v_utilities
    WHERE account_id IS NULL AND (name_ar ILIKE '%كهرب%' OR name_ar ILIKE '%مياه%' OR name_ar ILIKE '%مرافق%' OR name_en ILIKE '%utilit%' OR name_en ILIKE '%electric%' OR name_en ILIKE '%water%');
  UPDATE expense_categories SET account_id = v_telecom
    WHERE account_id IS NULL AND (name_ar ILIKE '%اتصال%' OR name_ar ILIKE '%إنترنت%' OR name_en ILIKE '%telec%' OR name_en ILIKE '%internet%');
  UPDATE expense_categories SET account_id = v_shipping
    WHERE account_id IS NULL AND (name_ar ILIKE '%شحن%' OR name_ar ILIKE '%توصيل%' OR name_en ILIKE '%ship%' OR name_en ILIKE '%deliver%');
  UPDATE expense_categories SET account_id = v_marketing
    WHERE account_id IS NULL AND (name_ar ILIKE '%إعلان%' OR name_ar ILIKE '%تسويق%' OR name_en ILIKE '%market%' OR name_en ILIKE '%advert%');
  UPDATE expense_categories SET account_id = v_maintain
    WHERE account_id IS NULL AND (name_ar ILIKE '%صيان%' OR name_en ILIKE '%maint%');
  UPDATE expense_categories SET account_id = v_supplies
    WHERE account_id IS NULL AND (name_ar ILIKE '%مستلز%' OR name_ar ILIKE '%أدوات%' OR name_en ILIKE '%suppl%');

  -- Fallback → miscellaneous
  UPDATE expense_categories SET account_id = v_misc
    WHERE account_id IS NULL;
END$$;

-- ── ensure chart_of_accounts has the well-known codes the posting service
-- uses. Seeded rows from migration 048 should already have them; we
-- double-check and add the few optional codes here to make the
-- posting service resilient on a partially-migrated DB.

DO $$
BEGIN
  -- Tax payable — 214 already seeded.
  -- Customer deposits (عربون) — 212 already seeded.
  -- If any code is missing, we DO NOT create it silently (would risk
  -- orphan accounts); migration 048 owns the full seed.
  NULL;
END$$;

COMMIT;
