-- ============================================================================
--  ZAHRAN RETAIL SYSTEM — Master Schema
--  ---------------------------------------------------------------------------
--  Run this file once against an empty PostgreSQL 14+ database.
--  It simply includes all migrations in the correct order.
--
--  Usage (from this folder):
--      createdb zahran_retail
--      psql -d zahran_retail -f schema.sql
-- ============================================================================

\echo '== 001 Extensions & Enums =='
\i migrations/001_extensions_and_enums.sql

\echo '== 002 RBAC & Users =='
\i migrations/002_rbac_users.sql

\echo '== 003 Catalog =='
\i migrations/003_catalog.sql

\echo '== 004 Inventory =='
\i migrations/004_inventory.sql

\echo '== 005 Customers & Suppliers =='
\i migrations/005_customers_suppliers.sql

\echo '== 006 POS & Discounts =='
\i migrations/006_pos_and_discounts.sql

\echo '== 007 Reservations 🔥 =='
\i migrations/007_reservations.sql

\echo '== 008 Returns & Exchanges =='
\i migrations/008_returns_exchanges.sql

\echo '== 009 Accounting & Shifts =='
\i migrations/009_accounting_shifts.sql

\echo '== 010 Alerts, Settings, Offline Sync =='
\i migrations/010_support_alerts_settings_offline.sql

\echo '== 011 Functions & Triggers =='
\i migrations/011_functions_and_triggers.sql

\echo '== 012 Views for Reports =='
\i migrations/012_views_for_reports.sql

\echo '== 013 Seed Data =='
\i migrations/013_seed_data.sql

\echo '== 014 Cash Desk (Customer & Supplier Payments) =='
\i migrations/014_cash_desk.sql

\echo '== 015 Dashboard Views & Smart Suggestions =='
\i migrations/015_dashboard_views.sql

\echo '== Schema installed successfully ✅ =='
