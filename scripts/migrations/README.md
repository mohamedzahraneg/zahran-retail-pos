# Data Migration Scripts

Headless CLI utilities for bulk-migrating data from legacy POS systems into Zahran.

These scripts complement the Excel Import page in the admin UI — use the UI
for interactive, one-off imports (with dry-run validation). Use these CLI
scripts for scheduled jobs, multi-gigabyte files, or direct CSV pipes.

## Connection

All scripts read `DATABASE_URL` from the environment:

```bash
export DATABASE_URL="postgres://zahran:zahran@localhost:5432/zahran"
```

Or point `PGHOST / PGPORT / PGUSER / PGPASSWORD / PGDATABASE` at your cluster.

## Scripts

| Script              | Input format             | Purpose                                       |
| ------------------- | ------------------------ | --------------------------------------------- |
| `import-customers.js` | CSV with header row    | Bulk-import customer base                     |
| `import-suppliers.js` | CSV with header row    | Bulk-import suppliers                         |
| `import-products.js`  | CSV with header row    | Bulk-import products + variants + stock       |
| `opening-stock.js`    | CSV with header row    | Snap on-hand quantities to target values      |
| `export-legacy-pos.js`| — (connects to MySQL)  | Pull data out of a legacy MySQL POS → CSVs    |

## Usage

```bash
# Dry-run first (highly recommended)
node scripts/migrations/import-customers.js ./old_customers.csv --dry-run

# Real run
node scripts/migrations/import-customers.js ./old_customers.csv --upsert

# Opening stock (requires SKUs to exist already)
node scripts/migrations/opening-stock.js ./stocktake_2026_01_01.csv

# Legacy MySQL extractor (produces CSVs next to itself)
LEGACY_DB="mysql://root:pass@localhost:3306/oldpos" \
  node scripts/migrations/export-legacy-pos.js
```

## CSV expectations

* UTF-8 encoding. BOM is tolerated.
* Header row is required. Column order doesn't matter.
* Booleans: `true`/`false`, `1`/`0`, `yes`/`no`, `نعم`/`لا`.
* Dates: ISO 8601 (`2026-04-19`) or Unix-friendly (`2026/04/19`).
* Phones: any digits; non-digits stripped. Egypt numbers auto-normalized.

## Safety

Every script runs inside a single Postgres transaction by default — if any
row fails fatally, the whole batch rolls back. Use `--chunk-commit` for
very large files when you want partial progress preserved on error.

Full audit trail:
* Customer inserts are tagged with `metadata.imported_at` + `metadata.source`.
* Opening-stock writes a row in `stock_adjustments` with `reason='opening_balance'`.
* Supplier opening balances write a row in `supplier_ledger` with reference
  `opening_balance`.
