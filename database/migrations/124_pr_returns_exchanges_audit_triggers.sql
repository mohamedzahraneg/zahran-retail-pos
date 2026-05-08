-- 124_pr_returns_exchanges_audit_triggers.sql
-- PR-FIN-RETURNS-EXCHANGES-AUDIT-TRIGGERS
--
-- Adds row-level audit_logs coverage for `returns`, `return_items`,
-- `exchanges`, and `exchange_items`.  These four tables are the only
-- financial-document tables NOT covered by the existing
-- `trg_audit_*` family (68 triggers across 24 tables already exist).
-- Without this migration, edits to returns/exchanges are invisible to
-- the audit query path — which is the precondition for the upcoming
-- admin-edit feature.
--
-- Reuses the existing trigger function `public.fn_audit_row()`
-- introduced in 011_functions_and_triggers.sql and refined in
-- 030_audit_user_fallback.sql.  Same row-diff JSONB shape as
-- journal_entries / invoices / cashbox_transactions etc.
--
-- ZERO behavior change to writes.  The triggers are AFTER triggers,
-- so they cannot block a write — they observe and record.
--
-- Idempotency: each `CREATE TRIGGER` uses `IF NOT EXISTS` so a re-run
-- is a no-op.

CREATE TRIGGER IF NOT EXISTS trg_audit_returns
  AFTER INSERT OR UPDATE OR DELETE ON returns
  FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

CREATE TRIGGER IF NOT EXISTS trg_audit_return_items
  AFTER INSERT OR UPDATE OR DELETE ON return_items
  FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

CREATE TRIGGER IF NOT EXISTS trg_audit_exchanges
  AFTER INSERT OR UPDATE OR DELETE ON exchanges
  FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

CREATE TRIGGER IF NOT EXISTS trg_audit_exchange_items
  AFTER INSERT OR UPDATE OR DELETE ON exchange_items
  FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

-- Rollback (manual, if ever needed):
--   DROP TRIGGER IF EXISTS trg_audit_returns        ON returns;
--   DROP TRIGGER IF EXISTS trg_audit_return_items   ON return_items;
--   DROP TRIGGER IF EXISTS trg_audit_exchanges      ON exchanges;
--   DROP TRIGGER IF EXISTS trg_audit_exchange_items ON exchange_items;
-- Existing audit_logs rows from this trigger are append-only and
-- need not be deleted on rollback.
