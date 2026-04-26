-- Migration 104 — Seller commission target columns on users (PR-T4.6).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Adds two NULLABLE columns to public.users so the new "تعديل الملف"
-- modal can configure per-salesperson target rules:
--
--     commission_target_amount   numeric(18,2)  null  — target sales for the
--         period (currently interpreted as the same period the Overview
--         dashboard renders — typically the Cairo month). NULL means
--         "no target system enabled" — matches the prior behavior where
--         every salesperson uses commission_rate flat.
--
--     commission_after_target_rate  numeric(5,2)  null  — boosted rate
--         applied to sales ABOVE the target. NULL or 0 means "use the
--         base commission_rate above the target as well" (no boost).
--
-- Why on `users` (not a separate table)?
--
--   The existing commission system stores `users.commission_rate` (%).
--   The two new columns are 1:1 with the user, never historical (the
--   operator changes the target → it applies forward), and never
--   shared across salespeople. Keeping them on users avoids an extra
--   join in every commission query.
--
-- Idempotent
--
--   Both columns use ADD COLUMN IF NOT EXISTS; re-running the migration
--   is a no-op + RAISE NOTICE only.
--
-- Strict
--
--   - No accounting changes
--   - No journal_entries / journal_lines / cashbox_transactions writes
--   - Trial balance unaffected
--   - Existing commission_rate column untouched
--   - Engine context = migration:104_* so the migration-068 trigger
--     allows the DDL silently
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:104_user_commission_target_columns',
  true
);

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS commission_target_amount      numeric(18, 2),
  ADD COLUMN IF NOT EXISTS commission_after_target_rate  numeric(5, 2);

COMMENT ON COLUMN users.commission_target_amount IS
  'PR-T4.6 — target sales for the configured commission period. NULL means '
  'no target system enabled (flat commission_rate applies to all sales).';

COMMENT ON COLUMN users.commission_after_target_rate IS
  'PR-T4.6 — boosted commission % applied to sales ABOVE the target. NULL '
  'or 0 means use commission_rate above the target as well (no boost).';

DO $$
DECLARE
  v_target_added int;
  v_after_added  int;
BEGIN
  SELECT COUNT(*) INTO v_target_added FROM information_schema.columns
   WHERE table_name='users' AND column_name='commission_target_amount';
  SELECT COUNT(*) INTO v_after_added  FROM information_schema.columns
   WHERE table_name='users' AND column_name='commission_after_target_rate';

  IF v_target_added <> 1 OR v_after_added <> 1 THEN
    RAISE EXCEPTION 'PR-T4.6 invariant broken: expected both columns present';
  END IF;
  RAISE NOTICE 'PR-T4.6 migration 104 OK: commission_target_amount + commission_after_target_rate present';
END $$;

COMMIT;
