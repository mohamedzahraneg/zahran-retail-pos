#!/usr/bin/env node
/**
 * Extract data from a legacy MySQL POS and write CSVs that can be fed
 * directly into the import-*.js scripts or the admin Import UI.
 *
 * Env:
 *   LEGACY_DB=mysql://user:pass@host:3306/dbname
 *
 * The exact table/column mapping varies by legacy vendor; this script
 * exposes a CONFIG object at the top that is easy to customize per
 * migration. The default mapping targets a typical "tailor-made" Access-
 * or MySQL-based POS found in Egyptian shops.
 *
 * Usage:
 *   LEGACY_DB="mysql://root:pass@localhost:3306/oldpos" \
 *     node export-legacy-pos.js [--out=./exports]
 *
 * Output:
 *   ./exports/customers.csv
 *   ./exports/suppliers.csv
 *   ./exports/products.csv
 *   ./exports/opening_stock.csv
 */
const fs = require('fs');
const path = require('path');
const { args } = require('./_lib');

const CONFIG = {
  customers: {
    table: 'customers',
    // map legacy column → Zahran column
    map: {
      name: 'full_name',
      mobile: 'phone',
      alt_mobile: 'alt_phone',
      email: 'email',
      nat_id: 'national_id',
      dob: 'birth_date',
      sex: 'gender',
      addr: 'address_line',
      city: 'city',
      gov: 'governorate',
      points: 'loyalty_points',
      total: 'total_spent',
      vip: 'is_vip',
      notes: 'notes',
    },
  },
  suppliers: {
    table: 'suppliers',
    map: {
      name: 'name',
      contact: 'contact_person',
      phone: 'phone',
      email: 'email',
      address: 'address',
      tax_no: 'tax_number',
      terms: 'payment_terms_days',
      limit: 'credit_limit',
      balance: 'current_balance',
      active: 'is_active',
    },
  },
  products: {
    // Legacy systems often store one row per variant (color+size) already.
    table: 'products',
    map: {
      name: 'product_name',
      category: 'category',
      type: 'type',
      color: 'color',
      size: 'size',
      cost: 'cost_price',
      price: 'selling_price',
      qty: 'quantity',
      sku: 'sku',
      barcode: 'barcode',
      brand: 'brand',
    },
  },
  opening_stock: {
    // Direct pull of what's on the shelves now.
    query: `
      SELECT p.sku AS sku,
             'ZHR-01' AS warehouse_code,
             COALESCE(p.qty, 0) AS quantity,
             p.cost AS cost_price
      FROM products p
      WHERE p.qty > 0
    `,
  },
};

function toCsv(rows) {
  if (rows.length === 0) return '';
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const lines = [headers.join(',')];
  for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
  return lines.join('\n') + '\n';
}

async function main() {
  const { flags } = args();
  const outDir = flags.out || './exports';
  fs.mkdirSync(outDir, { recursive: true });

  if (!process.env.LEGACY_DB) {
    console.error('LEGACY_DB env var not set. Example:');
    console.error('  LEGACY_DB="mysql://root:pass@localhost:3306/oldpos"');
    process.exit(1);
  }

  let mysql;
  try {
    mysql = require('mysql2/promise');
  } catch {
    console.error('Please install: npm i mysql2');
    process.exit(1);
  }

  const conn = await mysql.createConnection(process.env.LEGACY_DB);

  async function exportEntity(name, def) {
    console.log(`→ Exporting ${name}…`);
    let rows;
    if (def.query) {
      [rows] = await conn.execute(def.query);
    } else {
      const cols = Object.keys(def.map);
      const [raw] = await conn.execute(`SELECT ${cols.join(', ')} FROM ${def.table}`);
      rows = raw.map((r) => {
        const out = {};
        for (const [src, dst] of Object.entries(def.map)) out[dst] = r[src];
        return out;
      });
    }
    const outPath = path.join(outDir, `${name}.csv`);
    fs.writeFileSync(outPath, toCsv(rows));
    console.log(`  ${rows.length} rows → ${outPath}`);
  }

  try {
    for (const [name, def] of Object.entries(CONFIG)) {
      try {
        await exportEntity(name, def);
      } catch (err) {
        console.warn(`  ✗ ${name} failed: ${err.message}`);
      }
    }
  } finally {
    await conn.end();
  }

  console.log('\n✅ Done. Feed the CSVs into:');
  console.log('  node import-customers.js ' + outDir + '/customers.csv');
  console.log('  node import-suppliers.js ' + outDir + '/suppliers.csv');
  console.log('  node import-products.js  ' + outDir + '/products.csv --warehouse=ZHR-01');
  console.log('  node opening-stock.js    ' + outDir + '/opening_stock.csv');
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
