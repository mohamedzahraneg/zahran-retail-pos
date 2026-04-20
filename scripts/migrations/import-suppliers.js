#!/usr/bin/env node
/**
 * Bulk-import suppliers from a CSV.
 *
 * Opening balances (current_balance > 0) are recorded as supplier_ledger
 * entries with reason='opening_balance', so the account statement is
 * correct from day one.
 *
 * Usage:
 *   node import-suppliers.js ./suppliers.csv [--dry-run] [--upsert]
 */
const {
  parseCsv,
  args,
  getClient,
  progress,
  parseBool,
  parseNum,
} = require('./_lib');

async function main() {
  const { flags, positional } = args();
  const filePath = positional[0];
  if (!filePath) {
    console.error('Usage: import-suppliers.js <path.csv> [--dry-run] [--upsert]');
    process.exit(1);
  }

  const { rows } = parseCsv(filePath);
  console.log(`Loaded ${rows.length} rows from ${filePath}`);

  const cleaned = [];
  const errors = [];
  rows.forEach((r, i) => {
    const idx = i + 2;
    if (!r.name) {
      errors.push(`Row ${idx}: missing name`);
      return;
    }
    cleaned.push({
      _row: idx,
      name: r.name.trim(),
      contact_person: r.contact_person || null,
      phone: r.phone || null,
      alt_phone: r.alt_phone || null,
      email: r.email || null,
      address: r.address || null,
      tax_number: r.tax_number || null,
      payment_terms_days: parseNum(r.payment_terms_days) ?? 0,
      credit_limit: parseNum(r.credit_limit) ?? 0,
      current_balance: parseNum(r.current_balance) ?? 0,
      is_active: parseBool(r.is_active) ?? true,
      notes: r.notes || null,
    });
  });

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
  const upsert = flags.upsert !== false && flags.upsert !== 'false';

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  try {
    await client.query('BEGIN');
    for (let i = 0; i < cleaned.length; i++) {
      const d = cleaned[i];
      const existing = await client.query(
        `SELECT id FROM suppliers WHERE LOWER(name) = LOWER($1) LIMIT 1`,
        [d.name],
      );
      if (existing.rows[0] && !upsert) {
        skipped++;
        continue;
      }

      let supplierId;
      if (existing.rows[0]) {
        supplierId = existing.rows[0].id;
        await client.query(
          `UPDATE suppliers SET
             contact_person = COALESCE($2, contact_person),
             phone = COALESCE($3, phone),
             alt_phone = COALESCE($4, alt_phone),
             email = COALESCE($5, email),
             address = COALESCE($6, address),
             tax_number = COALESCE($7, tax_number),
             payment_terms_days = COALESCE($8, payment_terms_days),
             credit_limit = COALESCE($9, credit_limit),
             current_balance = COALESCE($10, current_balance),
             is_active = COALESCE($11, is_active),
             notes = COALESCE($12, notes),
             updated_at = NOW()
           WHERE id = $1`,
          [
            supplierId,
            d.contact_person,
            d.phone,
            d.alt_phone,
            d.email,
            d.address,
            d.tax_number,
            d.payment_terms_days,
            d.credit_limit,
            d.current_balance,
            d.is_active,
            d.notes,
          ],
        );
        updated++;
      } else {
        const next = await client.query(
          `SELECT COALESCE(MAX(CAST(SUBSTRING(supplier_no FROM 5) AS INT)), 0) + 1 AS n
             FROM suppliers WHERE supplier_no LIKE 'SUP-%'`,
        );
        const supplierNo = `SUP-${String(next.rows[0].n).padStart(6, '0')}`;
        const ins = await client.query(
          `INSERT INTO suppliers
             (supplier_no, name, contact_person, phone, alt_phone, email,
              address, tax_number, payment_terms_days, credit_limit,
              current_balance, is_active, notes)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
           RETURNING id`,
          [
            supplierNo,
            d.name,
            d.contact_person,
            d.phone,
            d.alt_phone,
            d.email,
            d.address,
            d.tax_number,
            d.payment_terms_days,
            d.credit_limit,
            d.current_balance,
            d.is_active,
            d.notes,
          ],
        );
        supplierId = ins.rows[0].id;
        inserted++;

        // Opening-balance ledger entry
        if (d.current_balance && d.current_balance !== 0) {
          await client.query(
            `INSERT INTO supplier_ledger
               (supplier_id, entry_date, direction, amount,
                reference_type, balance_after, notes)
             VALUES ($1, CURRENT_DATE, 'in', $2, NULL, $3, 'Opening balance from migration')`,
            [supplierId, Math.abs(d.current_balance), d.current_balance],
          );
        }
      }

      progress(i + 1, cleaned.length, 'suppliers');
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('\nFATAL:', err.message);
    process.exit(3);
  } finally {
    await client.end();
  }

  console.log(
    `\n✅ Done — inserted: ${inserted}, updated: ${updated}, skipped: ${skipped}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(99);
});
