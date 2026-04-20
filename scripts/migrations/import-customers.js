#!/usr/bin/env node
/**
 * Bulk-import customers from a CSV file.
 *
 * Usage:
 *   node import-customers.js ./old_customers.csv [--dry-run] [--upsert]
 *       [--chunk-commit=500] [--source=LegacyPOS]
 *
 * Expected columns (case-insensitive; underscores = spaces):
 *   full_name (required), phone, alt_phone, email, national_id,
 *   birth_date, gender, address_line, city, governorate,
 *   loyalty_points, loyalty_tier, total_spent, is_vip, notes
 */
const {
  parseCsv,
  args,
  getClient,
  progress,
  parseBool,
  parseNum,
  parseDate,
  normalizePhoneEG,
} = require('./_lib');

async function main() {
  const { flags, positional } = args();
  const filePath = positional[0];
  if (!filePath) {
    console.error('Usage: import-customers.js <path.csv> [--dry-run] [--upsert]');
    process.exit(1);
  }

  const { rows } = parseCsv(filePath);
  console.log(`Loaded ${rows.length} rows from ${filePath}`);

  const errors = [];
  const cleaned = rows
    .map((r, i) => {
      const idx = i + 2; // +2: header is row 1, data starts row 2
      if (!r.full_name) {
        errors.push(`Row ${idx}: missing full_name`);
        return null;
      }
      return {
        _row: idx,
        full_name: r.full_name.trim(),
        phone: normalizePhoneEG(r.phone),
        alt_phone: normalizePhoneEG(r.alt_phone),
        email: r.email ? r.email.toLowerCase().trim() : null,
        national_id: r.national_id || null,
        birth_date: parseDate(r.birth_date),
        gender: r.gender ? r.gender.toLowerCase() : null,
        address_line: r.address_line || null,
        city: r.city || null,
        governorate: r.governorate || null,
        loyalty_points: parseNum(r.loyalty_points) ?? 0,
        loyalty_tier: r.loyalty_tier || 'bronze',
        total_spent: parseNum(r.total_spent) ?? 0,
        is_vip: parseBool(r.is_vip) ?? false,
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
  const upsert = flags.upsert !== false && flags.upsert !== 'false';
  const source = flags.source || 'csv_import';
  const chunkCommit = Number(flags['chunk-commit']) || 0;

  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  try {
    if (chunkCommit === 0) await client.query('BEGIN');

    for (let i = 0; i < cleaned.length; i++) {
      const d = cleaned[i];
      if (chunkCommit > 0 && i % chunkCommit === 0) {
        if (i > 0) await client.query('COMMIT');
        await client.query('BEGIN');
      }

      let existingId = null;
      if (d.phone) {
        const r = await client.query(
          `SELECT id FROM customers WHERE phone = $1 LIMIT 1`,
          [d.phone],
        );
        if (r.rows[0]) existingId = r.rows[0].id;
      }
      if (!existingId && d.email) {
        const r = await client.query(
          `SELECT id FROM customers WHERE email = $1 LIMIT 1`,
          [d.email],
        );
        if (r.rows[0]) existingId = r.rows[0].id;
      }
      if (!existingId && d.national_id) {
        const r = await client.query(
          `SELECT id FROM customers WHERE national_id = $1 LIMIT 1`,
          [d.national_id],
        );
        if (r.rows[0]) existingId = r.rows[0].id;
      }

      if (existingId && !upsert) {
        skipped++;
        continue;
      }

      if (existingId) {
        await client.query(
          `UPDATE customers SET
             full_name = COALESCE($2, full_name),
             alt_phone = COALESCE($3, alt_phone),
             email = COALESCE($4, email),
             birth_date = COALESCE($5, birth_date),
             gender = COALESCE($6, gender),
             address_line = COALESCE($7, address_line),
             city = COALESCE($8, city),
             governorate = COALESCE($9, governorate),
             loyalty_points = COALESCE($10, loyalty_points),
             loyalty_tier = COALESCE($11, loyalty_tier),
             total_spent = COALESCE($12, total_spent),
             is_vip = COALESCE($13, is_vip),
             notes = COALESCE($14, notes),
             metadata = metadata || jsonb_build_object('imported_at', NOW()::text, 'source', $15::text),
             updated_at = NOW()
           WHERE id = $1`,
          [
            existingId,
            d.full_name,
            d.alt_phone,
            d.email,
            d.birth_date,
            d.gender,
            d.address_line,
            d.city,
            d.governorate,
            d.loyalty_points,
            d.loyalty_tier,
            d.total_spent,
            d.is_vip,
            d.notes,
            source,
          ],
        );
        updated++;
      } else {
        const nextnum = await client.query(
          `SELECT COALESCE(MAX(CAST(SUBSTRING(customer_no FROM 5) AS INT)), 0) + 1 AS n
             FROM customers WHERE customer_no LIKE 'CUS-%'`,
        );
        const customerNo = `CUS-${String(nextnum.rows[0].n).padStart(6, '0')}`;
        await client.query(
          `INSERT INTO customers
             (customer_no, full_name, phone, alt_phone, email, national_id,
              birth_date, gender, address_line, city, governorate,
              loyalty_points, loyalty_tier, total_spent, is_vip, notes, metadata)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,
                   jsonb_build_object('imported_at', NOW()::text, 'source', $17::text))`,
          [
            customerNo,
            d.full_name,
            d.phone,
            d.alt_phone,
            d.email,
            d.national_id,
            d.birth_date,
            d.gender,
            d.address_line,
            d.city,
            d.governorate,
            d.loyalty_points,
            d.loyalty_tier,
            d.total_spent,
            d.is_vip,
            d.notes,
            source,
          ],
        );
        inserted++;
      }

      progress(i + 1, cleaned.length, 'customers');
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
