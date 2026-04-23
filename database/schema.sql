-- ============================================================================
--  ZAHRAN RETAIL SYSTEM — Master Schema
--  ---------------------------------------------------------------------------
--  Run this file once against an empty PostgreSQL 14+ database.
--  It simply includes all migrations in the correct order.
--
--  Usage (any cwd works — `\ir` resolves paths relative to THIS file):
--      createdb zahran_retail
--      psql -d zahran_retail -f database/schema.sql
--
--  Do NOT use `\i` here — that resolves relative to the current working
--  directory and breaks in CI. `\ir` ("include relative") is the
--  correct psql directive for a portable schema script.
-- ============================================================================

\echo '== 001 Extensions & Enums =='
\ir migrations/001_extensions_and_enums.sql

\echo '== 002 RBAC & Users =='
\ir migrations/002_rbac_users.sql

\echo '== 003 Catalog =='
\ir migrations/003_catalog.sql

\echo '== 004 Inventory =='
\ir migrations/004_inventory.sql

\echo '== 005 Customers & Suppliers =='
\ir migrations/005_customers_suppliers.sql

\echo '== 006 POS & Discounts =='
\ir migrations/006_pos_and_discounts.sql

\echo '== 007 Reservations =='
\ir migrations/007_reservations.sql

\echo '== 008 Returns & Exchanges =='
\ir migrations/008_returns_exchanges.sql

\echo '== 009 Accounting & Shifts =='
\ir migrations/009_accounting_shifts.sql

\echo '== 010 Alerts, Settings, Offline Sync =='
\ir migrations/010_support_alerts_settings_offline.sql

\echo '== 011 Functions & Triggers =='
\ir migrations/011_functions_and_triggers.sql

\echo '== 012 Views for Reports =='
\ir migrations/012_views_for_reports.sql

\echo '== 013 Seed Data =='
\ir migrations/013_seed_data.sql

\echo '== 014 Cash Desk (Customer & Supplier Payments) =='
\ir migrations/014_cash_desk.sql

\echo '== 015 Dashboard Views & Smart Suggestions =='
\ir migrations/015_dashboard_views.sql

\echo '== 016 Realistic Seed =='
\ir migrations/016_realistic_seed.sql

\echo '== 017 Notifications =='
\ir migrations/017_notifications.sql

\echo '== 018 Recurring Expenses =='
\ir migrations/018_recurring_expenses.sql

\echo '== 019 Customer Groups Pricing =='
\ir migrations/019_customer_groups_pricing.sql

\echo '== 020 Returns Analytics =='
\ir migrations/020_returns_analytics.sql

\echo '== 021 VAT Support =='
\ir migrations/021_vat_support.sql

\echo '== 022 Loyalty Earn On Insert =='
\ir migrations/022_loyalty_earn_on_insert.sql

\echo '== 023 Purchase Returns =='
\ir migrations/023_purchase_returns.sql

\echo '== 024 Advanced Reports =='
\ir migrations/024_advanced_reports.sql

\echo '== 025 Users Branch ID =='
\ir migrations/025_users_branch_id.sql

\echo '== 026 Roles Permissions Array =='
\ir migrations/026_roles_permissions_array.sql

\echo '== 027 Entity Compat =='
\ir migrations/027_entity_compat.sql

\echo '== 028 Schema Sync =='
\ir migrations/028_schema_sync.sql

\echo '== 029 Final Sync =='
\ir migrations/029_final_sync.sql

\echo '== 030 Audit User Fallback =='
\ir migrations/030_audit_user_fallback.sql

\echo '== 031 Attendance =='
\ir migrations/031_attendance.sql

\echo '== 032 User Permission Overrides =='
\ir migrations/032_user_permission_overrides.sql

\echo '== 033 Void Invoice & Edit =='
\ir migrations/033_void_invoice_and_edit.sql

\echo '== 034 Auto SKU Generator =='
\ir migrations/034_auto_sku_generator.sql

\echo '== 035 Cashbox Txn Fn =='
\ir migrations/035_cashbox_txn_fn.sql

\echo '== 036 Low Stock Alert Names =='
\ir migrations/036_low_stock_alert_names.sql

\echo '== 037 Fix Revenue 30d View =='
\ir migrations/037_fix_revenue_30d_view.sql

\echo '== 038 Invoice Edit In Place =='
\ir migrations/038_invoice_edit_in_place.sql

\echo '== 039 Invoice Edit Requests =='
\ir migrations/039_invoice_edit_requests.sql

\echo '== 040 Employee Module =='
\ir migrations/040_employee_module.sql

\echo '== 041 Employee Shift Times =='
\ir migrations/041_employee_shift_times.sql

\echo '== 042 Shift Close Approval =='
\ir migrations/042_shift_close_approval.sql

\echo '== 043 Supplier Enhancements =='
\ir migrations/043_supplier_enhancements.sql

\echo '== 044 Supplier Payment Schedule =='
\ir migrations/044_supplier_payment_schedule.sql

\echo '== 045 Standalone Returns =='
\ir migrations/045_standalone_returns.sql

\echo '== 046 Cashbox Movements =='
\ir migrations/046_cashbox_movements.sql

\echo '== 047 Recurring Expense Alerts =='
\ir migrations/047_recurring_expense_alerts.sql

\echo '== 048 Chart of Accounts =='
\ir migrations/048_chart_of_accounts.sql

\echo '== 049 Cashbox Types & Institutions =='
\ir migrations/049_cashbox_types_and_institutions.sql

\echo '== 050 Auto Posting Wiring =='
\ir migrations/050_auto_posting_wiring.sql

\echo '== 051 Phase F Schema =='
\ir migrations/051_phase_f_schema.sql

\echo '== 052 Cost Center & Budget =='
\ir migrations/052_cost_center_budget.sql

\echo '== 053 FX Rates =='
\ir migrations/053_fx_rates.sql

\echo '== 054 Expense Approvals =='
\ir migrations/054_expense_approvals.sql

\echo '== 055 Cleanup & Gap Fill =='
\ir migrations/055_cleanup_and_gap_fill.sql

\echo '== 056 Auto Accounts Repair =='
\ir migrations/056_auto_accounts_repair.sql

\echo '== 057 Financial Event Log =='
\ir migrations/057_financial_event_log.sql

\echo '== 058 Engine Write Guards =='
\ir migrations/058_engine_write_guards.sql

\echo '== 059 Fix engine-context NULL trap =='
\ir migrations/059_fix_engine_context_null_trap.sql

\echo '== 060 Shift variance treatment + employee ledger =='
\ir migrations/060_shift_variance_treatment.sql

\echo '== 061 Shift variance spec alignment (approved_*, variance_amount/type) =='
\ir migrations/061_shift_variance_spec_alignment.sql

\echo '== 062 Drop orphan variance_decided_* columns =='
\ir migrations/062_drop_orphan_variance_decided_columns.sql

\echo '== 063 Bank-grade immutable ledger (audit + DELETE block + fiscal lock + bypass alerts) =='
\ir migrations/063_bank_grade_immutable_ledger.sql

\echo '== 064 Financial control tower (event stream + anomalies + health view) =='
\ir migrations/064_financial_control_tower.sql

\echo '== 065 Cost system unification (resolver + reconciliation + unified ledger view) =='
\ir migrations/065_cost_system_unification.sql

\echo '== 066 Control tower observability fixes (engine-preserving cashbox + non-deferrable anomaly UNIQUE) =='
\ir migrations/066_control_tower_fixes.sql

\echo '== 067 Drop leftover DEFERRABLE anomaly unique constraint (066 name guess miss) =='
\ir migrations/067_drop_deferrable_anomaly_unique.sql

\echo '== 068 Financial integrity enforcement (strict guard + lockdown + risk flags) =='
\ir migrations/068_financial_integrity_enforcement.sql

\echo '== Schema installed successfully ✅ =='
