#!/usr/bin/env node
/**
 * Bulk product import from CSV.
 *
 * Each row = one variant (color+size). Products are deduped by sku_root.
 *
 * Columns:
 *   product_name (required), category, type, color, size,
 *   cost_price, selling_price, quantity,
 *   sku, barcode, brand, target_audience, warehouse_code
 *
 * Usage:
 *   node import-products.js ./catalog.csv --warehouse=ZHR-01 [--dry-run]
 */
const {
  parseCsv,
  args,
  getClient,
  progress,
  parseNum,
} = require('./_lib');

const TYPES = ['shoe', 'bag', 'accessory'];

function buildSku(d) {
  const base = String(d.product_name || 'P')
    .replace(/[^A-Za-z0-9\u0600-\u06FF]/g, '')
    .slice(0, 6)
    .toUpperCase() || 'PROD';
  const t = String(d.type || 'X').slice(0, 1).toUpperCase();
  const rand = Math.floor(Math.random() * 10000).toString().padStart(4, '0');
  return `${base}-${t}-${rand}`;
}

async function main() {
  const { flags, positional } = args();
  const filePath = positional[0];
  if (!filePath) {
    console.error('Usage: import-products.js <path.csv> --warehouse=<code> [--dry-run]');
    process.exit(1);
  }

  const defaultWh = flags.warehouse || 'ZHR-01';

  const { rows } = parseCsv(filePath);
  console.log(`Loaded ${rows.length} rows from ${filePath}`);

  const errors = [];
  const cleaned = rows
    .map((r, i) => {
      const idx = i + 2;
      const errs = [];
      if (!r.product_name) errs.push('product_name required');
      if (!r.color) errs.push('color required');
      const type = String(r.type || '').toLowerCase();
      if (!TYPES.includes(type)) errs.push(`type must be one of ${TYPES.join('/')}`);
      if (type === 'shoe' && !r.size) errs.push('size required for shoes');
      const cost = parseNum(r.cost_price);
      const sell = parseNum(r.selling_price);
      const qty = parseNum(r.quantity);
      if (cost == null || cost < 0) errs.push('cost_price invalid');
      if (sell == null || sell < 0) errs.push('selling_price invalid');
      if (qty == null || qty < 0) errs.push('quantity invalid');
      if (errs.length) {
        errors.push(`Row ${idx}: ${errs.join('; ')}`);
        return null;
      }
      return {
        _row: idx,
        product_name: r.product_name.trim(),
        category: r.category || null,
        type,
        color: r.color.trim(),
        size: r.size || null,
        cost_price: cost,
        selling_price: sell,
        quantity: qty,
        sku_root: r.sku || null,
        barcode: r.barcode || null,
        brand: r.brand || null,
        target_audience: (r.target_audience || 'women').toLowerCase(),
        warehouse_code: r.warehouse_code || defaultWh,
      };
    })
    .filter(Boolean);

  if (errors.length) {
    console.error('\nValidation errors:');
    for (const e of errors) console.error(' -', e);
    if (!flags['ignore-errors']) process.exit(2);
  }

  console.log(`${cleaned.length} rows passed validation`);

  if (flags['dry-run']) {
    console.log('[dry-run] not touching database. Exiting.');
    return;
  }

  const client = await getClient();
  let inserted = 0;
  const whCache = new Map();

  async function wh(code) {
    if (whCache.has(code)) return whCache.get(code);
    const r = await client.query(
      `SELECT id FROM warehouses WHERE code = $1 LIMIT 1`,
      [code],
    );
    if (!r.rows[0]) throw new Error(`Warehouse not found: ${code}`);
    whCache.set(code, r.rows[0].id);
    return r.rows[0].id;
  }

  try {
    await client.query('BEGIN');

    for (let i = 0; i < cleaned.length; i++) {
      const d = cleaned[i];
      const skuRoot = (d.sku_root || buildSku(d)).slice(0, 60);
      const whId = await wh(d.warehouse_code);

      // upsert product
      const exist = await client.query(
        `SELECT id FROM products WHERE sku_root = $1 LIMIT 1`,
        [skuRoot],
      );
      let productId = exist.rows[0]?.id;
      if (!productId) {
        const p = await client.query(
          `INSERT INTO products
             (sku_root, name, type, category_name, base_price, brand,
              target_audience, is_active)
           VALUES ($1,$2,$3,$4,$5,$6,$7,true) RETURNING id`,
          [
            skuRoot,
            d.product_name,
            d.type,
            d.category,
            d.selling_price,
            d.brand,
            d.target_audience,
          ],
        );
        productId = p.rows[0].id;
      }

      // variant
      const variantSku = `${skuRoot}-${d.color}-${d.size || 'N'}`.slice(0, 60);
      const v = await client.query(
        `INSERT INTO product_variants
           (product_id, sku, barcode, color, size,
            cost_price, price_override, is_active)
         VALUES ($1,$2,$3,$4,$5,$6,$7,true)
         ON CONFLICT (sku) DO UPDATE
           SET cost_price = EXCLUDED.cost_price,
               price_override = EXCLUDED.price_override
         RETURNING id`,
        [
          productId,
          variantSku,
          d.barcode,
          d.color,
          d.size,
          d.cost_price,
          d.selling_price,
        ],
      );

      // stock
      await client.query(
        `INSERT INTO stock (variant_id, warehouse_id, quantity, quantity_reserved)
         VALUES ($1,$2,$3,0)
         ON CONFLICT (variant_id, warehouse_id)
           DO UPDATE SET quantity = stock.quantity + EXCLUDED.quantity`,
        [v.rows[0].id, whId, d.quantity],
      );

      inserted++;
      progress(i + 1, cleaned.length, 'products');
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nFATAL:', err.message);
    process.exit(3);
  } finally {
    await client.end();
  }

  console.log(`\n✅ Done — processed: ${inserted} variants`);
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
