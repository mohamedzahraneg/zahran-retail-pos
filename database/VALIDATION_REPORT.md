# Validation Report — Zahran Retail System Database

**Date:** 2026-04-19
**Schema version:** 1.0.0

## Environment limitations
The sandbox where this schema was authored did **not** have network or root
access to install PostgreSQL, so a live `psql -f schema.sql` dry-run could not
be performed here. Instead, the following offline validations were executed:

| Check                                         | Status |
|-----------------------------------------------|:------:|
| Parenthesis balance across all 15 migrations  |   ✅   |
| Statement count per file (sanity check)       |   ✅   |
| Foreign-key target tables exist in load order |   ✅   |
| Circular FK resolution via `ALTER TABLE`      |   ✅   |
| ENUM values referenced only after creation    |   ✅   |
| Trigger attach order (tables → functions)     |   ✅   |
| `ON CONFLICT` targets match UNIQUE indexes    |   ✅   |
| PostgreSQL version features (14+) compliance  |   ✅   |

### Deferred foreign keys (resolved via `ALTER TABLE`)
- `users.default_warehouse_id → warehouses(id)`  *(added in 004)*
- `invoices.coupon_id → coupons(id)`             *(added in 006)*
- `invoices.reservation_id → reservations(id)`   *(added in 007)*
- `invoices.shift_id → shifts(id)`               *(added in 009)*

## Load order
`schema.sql` uses `\i` to include migrations in this exact order:
001 → 002 → 003 → 004 → 005 → 006 → 007 → 008 → 009 → 010 → 011 → 012 → 013 → 014 → 015.

A single-file variant `schema_combined.sql` is also provided for environments
that cannot resolve `\i` (e.g., some managed DBaaS consoles).

## Final dry-run recommendation
Before promoting to production run:

```bash
createdb zahran_retail_test
psql -v ON_ERROR_STOP=1 -d zahran_retail_test -f schema.sql
# Expect: NOTICE/CREATE output for every module, ends with:
# == Schema installed successfully ✅ ==
dropdb zahran_retail_test
```

## File inventory
| File | Lines | Purpose |
|------|------:|---------|
| `migrations/001_extensions_and_enums.sql`              | 106 | Extensions + all ENUMs |
| `migrations/002_rbac_users.sql`                        | 113 | Roles/permissions/users/audit |
| `migrations/003_catalog.sql`                           | 139 | Products, colors, sizes, variants (SKU) |
| `migrations/004_inventory.sql`                         | 157 | Warehouses, stock ledger, transfers, adjustments |
| `migrations/005_customers_suppliers.sql`               | 154 | Customers, loyalty, suppliers, purchases |
| `migrations/006_pos_and_discounts.sql`                 | 194 | Invoices, payments, discounts, coupons |
| `migrations/007_reservations.sql` 🔥                   | 111 | Reservations + partial payments (flagship) |
| `migrations/008_returns_exchanges.sql`                 |  92 | Returns and exchanges |
| `migrations/009_accounting_shifts.sql`                 | 122 | Cashbox, expenses, shifts, commissions |
| `migrations/010_support_alerts_settings_offline.sql`   | 163 | Alerts, imports, settings, **offline sync queue** |
| `migrations/011_functions_and_triggers.sql`            | 544 | Doc-no sequences, stock triggers, audit triggers |
| `migrations/012_views_for_reports.sql`                 | 245 | Reporting views (profit, sales, reservations…) |
| `migrations/013_seed_data.sql`                         | 255 | Roles, permissions, admin, categories, colors, sizes, settings |
| `migrations/014_cash_desk.sql` 💰                      | 419 | Customer & supplier payments, allocations, ledger views |
| `migrations/015_dashboard_views.sql` 📊                | 407 | Dashboard KPI views + smart reorder/loss suggestions |
| **Total**                                              | **3 221** | |
