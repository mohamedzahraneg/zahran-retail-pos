-- Migration 105 — Full seller settings columns on users (PR-T4.6).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Extends migration 104 (which added commission_target_amount +
-- commission_after_target_rate) with the remaining columns required
-- by the full PR-T4.6 brief:
--
--     is_salesperson                       boolean        — explicit flag
--     sales_target_period                  text           — none | daily |
--                                                          weekly | monthly
--     commission_mode                      text           — general |
--                                                          after_target |
--                                                          over_target |
--                                                          general_plus_over_target
--     over_target_commission_rate          numeric(5,2)   — % applied to
--                                                          (achieved - target)
--                                                          for over_target /
--                                                          general_plus_over_target
--                                                          modes
--     commission_settings_effective_from   date           — when the current
--                                                          settings start
--                                                          applying (audit
--                                                          trail; engine
--                                                          uses today)
--
-- All columns nullable (additive). NULL on commission_mode means
-- "general" (back-compat — matches the prior flat-rate behavior).
-- NULL on sales_target_period means "none" (matches migration 104's
-- semantic of NULL commission_target_amount).
--
-- Idempotent
--   ADD COLUMN IF NOT EXISTS for each column.
--   CHECK constraints added inside DO $$ blocks that ignore the
--   "constraint already exists" duplicate-error so re-running is safe.
--
-- Strict
--   - No accounting changes
--   - No journal_entries / journal_lines / cashbox_transactions writes
--   - Trial balance unaffected
--   - migration:* engine context so the migration-068 trigger allows
--     the DDL silently
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:105_user_seller_settings_full',
  true
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_salesperson                     boolean,
  ADD COLUMN IF NOT EXISTS sales_target_period                text,
  ADD COLUMN IF NOT EXISTS commission_mode                    text,
  ADD COLUMN IF NOT EXISTS over_target_commission_rate        numeric(5, 2),
  ADD COLUMN IF NOT EXISTS commission_settings_effective_from date;

DO $$ BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_sales_target_period_check
    CHECK (sales_target_period IS NULL
           OR sales_target_period IN ('none','daily','weekly','monthly'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_commission_mode_check
    CHECK (commission_mode IS NULL
           OR commission_mode IN ('general','after_target','over_target',
                                  'general_plus_over_target'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TABLE users
    ADD CONSTRAINT users_over_target_commission_rate_check
    CHECK (over_target_commission_rate IS NULL
           OR (over_target_commission_rate >= 0
               AND over_target_commission_rate <= 100));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

COMMENT ON COLUMN users.is_salesperson IS
  'PR-T4.6 — explicit "this user is a salesperson" flag. NULL is treated '
  'as "infer from invoice_items.salesperson_id linkage" by the Overview UI.';

COMMENT ON COLUMN users.sales_target_period IS
  'PR-T4.6 — which time window the target applies to. NULL or "none" '
  'means no target system enabled.';

COMMENT ON COLUMN users.commission_mode IS
  'PR-T4.6 — which commission formula to apply. NULL is treated as "general" '
  '(flat commission_rate on all sales) for back-compat with users who '
  'were configured before this column existed.';

COMMENT ON COLUMN users.over_target_commission_rate IS
  'PR-T4.6 — % applied to (achieved - target) under over_target / '
  'general_plus_over_target modes. NULL = 0 (no boost).';

COMMENT ON COLUMN users.commission_settings_effective_from IS
  'PR-T4.6 — date the current settings became active. Audit-trail only; '
  'the engine always applies the latest settings. NULL means "applied '
  'immediately when saved (legacy / unspecified)".';

DO $$
DECLARE
  v_count int;
BEGIN
  SELECT COUNT(*) INTO v_count FROM information_schema.columns
   WHERE table_name='users'
     AND column_name IN ('is_salesperson','sales_target_period',
                         'commission_mode','over_target_commission_rate',
                         'commission_settings_effective_from');
  IF v_count <> 5 THEN
    RAISE EXCEPTION 'PR-T4.6 invariant broken: expected 5 new columns, found %', v_count;
  END IF;
  RAISE NOTICE 'PR-T4.6 migration 105 OK: 5 seller settings columns + 3 CHECK constraints present';
END $$;

COMMIT;
