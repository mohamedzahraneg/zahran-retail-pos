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
-- Idempotency: PostgreSQL does NOT support `CREATE TRIGGER IF NOT
-- EXISTS` (the `IF NOT EXISTS` clause is supported on
-- CREATE TABLE/INDEX/TYPE but not on CREATE TRIGGER — confirmed
-- against PG 17 in production).  Use the `DROP TRIGGER IF EXISTS …;
-- CREATE TRIGGER …` idiom that is already the convention in this
-- codebase (see e.g. 011_functions_and_triggers.sql for the original
-- attachment of fn_audit_row to other tables).  Re-running this
-- migration is a safe no-op.

DROP TRIGGER IF EXISTS trg_audit_returns ON returns;
CREATE TRIGGER trg_audit_returns
AFTER INSERT OR UPDATE OR DELETE ON returns
FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

DROP TRIGGER IF EXISTS trg_audit_return_items ON return_items;
CREATE TRIGGER trg_audit_return_items
AFTER INSERT OR UPDATE OR DELETE ON return_items
FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

DROP TRIGGER IF EXISTS trg_audit_exchanges ON exchanges;
CREATE TRIGGER trg_audit_exchanges
AFTER INSERT OR UPDATE OR DELETE ON exchanges
FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

DROP TRIGGER IF EXISTS trg_audit_exchange_items ON exchange_items;
CREATE TRIGGER trg_audit_exchange_items
AFTER INSERT OR UPDATE OR DELETE ON exchange_items
FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

-- Rollback (manual, if ever needed):
--   DROP TRIGGER IF EXISTS trg_audit_returns        ON returns;
--   DROP TRIGGER IF EXISTS trg_audit_return_items   ON return_items;
--   DROP TRIGGER IF EXISTS trg_audit_exchanges      ON exchanges;
--   DROP TRIGGER IF EXISTS trg_audit_exchange_items ON exchange_items;
-- Existing audit_logs rows from this trigger are append-only and
-- need not be deleted on rollback.
