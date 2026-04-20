#!/usr/bin/env node
/**
 * Apply opening stock balances from a CSV.
 *
 * Each row SNAPS the stock quantity of (sku, warehouse_code) to the given
 * value — the delta is recorded in stock_adjustments with reason
 * 'opening_balance' for audit.
 *
 * Columns:
 *   sku (required), warehouse_code (required), quantity (required, ≥0),
 *   cost_price (optional: updates variant cost),
 *   notes
 *
 * Usage:
 *   node opening-stock.js ./stock_2026_01_01.csv [--dry-run]
 */
const { parseCsv, args, getClient, progress, parseNum } = require('./_lib');

async function main() {
  const { flags, positional } = args();
  const filePath = positional[0];
  if (!filePath) {
    console.error('Usage: opening-stock.js <path.csv> [--dry-run]');
    process.exit(1);
  }

  const { rows } = parseCsv(filePath);
  console.log(`Loaded ${rows.length} rows from ${filePath}`);

  const errors = [];
  const cleaned = rows
    .map((r, i) => {
      const idx = i + 2;
      const errs = [];
      if (!r.sku) errs.push('sku required');
      if (!r.warehouse_code) errs.push('warehouse_code required');
      const qty = parseNum(r.quantity);
      if (qty == null || qty < 0) errs.push('quantity invalid');
      if (errs.length) {
        errors.push(`Row ${idx}: ${errs.join('; ')}`);
        return null;
      }
      return {
        _row: idx,
        sku: r.sku.trim(),
        warehouse_code: r.warehouse_code.trim(),
        quantity: qty,
        cost_price: parseNum(r.cost_price),
        notes: r.notes || null,
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
  let applied = 0;
  let skipped = 0;

  try {
    await client.query('BEGIN');

    for (let i = 0; i < cleaned.length; i++) {
      const d = cleaned[i];
      const v = await client.query(
        `SELECT id FROM product_variants WHERE sku = $1 LIMIT 1`,
        [d.sku],
      );
      if (!v.rows[0]) {
        console.warn(`\n⚠ Row ${d._row}: SKU not found: ${d.sku}`);
        skipped++;
        continue;
      }
      const w = await client.query(
        `SELECT id FROM warehouses WHERE code = $1 LIMIT 1`,
        [d.warehouse_code],
      );
      if (!w.rows[0]) {
        console.warn(`\n⚠ Row ${d._row}: Warehouse not found: ${d.warehouse_code}`);
        skipped++;
        continue;
      }

      const cur = await client.query(
        `SELECT quantity FROM stock WHERE variant_id = $1 AND warehouse_id = $2`,
        [v.rows[0].id, w.rows[0].id],
      );
      const currentQty = Number(cur.rows[0]?.quantity || 0);
      const delta = d.quantity - currentQty;

      await client.query(
        `INSERT INTO stock (variant_id, warehouse_id, quantity, quantity_reserved)
         VALUES ($1,$2,$3,0)
         ON CONFLICT (variant_id, warehouse_id)
           DO UPDATE SET quantity = EXCLUDED.quantity`,
        [v.rows[0].id, w.rows[0].id, d.quantity],
      );

      if (d.cost_price != null) {
        await client.query(
          `UPDATE product_variants SET cost_price = $2 WHERE id = $1`,
          [v.rows[0].id, d.cost_price],
        );
      }

      try {
        await client.query(
          `INSERT INTO stock_adjustments
             (variant_id, warehouse_id, quantity_before, quantity_after,
              delta, reason, notes)
           VALUES ($1,$2,$3,$4,$5,'opening_balance',$6)`,
          [v.rows[0].id, w.rows[0].id, currentQty, d.quantity, delta, d.notes || 'Opening balance'],
        );
      } catch {
        // stock_adjustments table may not exist in minimal schemas
      }

      applied++;
      progress(i + 1, cleaned.length, 'stock');
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nFATAL:', err.message);
    process.exit(3);
  } finally {
    await client.end();
  }

  console.log(`\n✅ Done — applied: ${applied}, skipped: ${skipped}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
