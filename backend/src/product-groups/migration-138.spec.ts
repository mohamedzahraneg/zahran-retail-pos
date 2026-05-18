/**
 * migration-138.spec.ts — PR-P9.1a
 *
 * Static guardrail for migration 138 (manual product groups).
 * Pins the additive, no-backfill, no-trigger contract.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    'database',
    'migrations',
    '138_product_groups.sql',
  ),
  'utf8',
);

// Strip SQL line comments before forbidden-keyword scans so the
// header prose ("no drop / no alter") doesn't false-positive.
const SQL = RAW.split('\n')
  .filter((l) => !/^\s*--/.test(l))
  .join('\n');

describe('migration 138 — product_groups + product_group_variants', () => {
  it('creates product_groups with the approved columns + defaults', () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS\s+product_groups\b/);
    expect(SQL).toMatch(/id\s+UUID\s+PRIMARY KEY\s+DEFAULT\s+gen_random_uuid\(\)/);
    expect(SQL).toMatch(/name_ar\s+VARCHAR\(120\)\s+NOT NULL/);
    expect(SQL).toMatch(/name_en\s+VARCHAR\(120\)\s+NULL/);
    expect(SQL).toMatch(/description\s+TEXT\s+NULL/);
    expect(SQL).toMatch(/color\s+VARCHAR\(20\)\s+NULL/);
    expect(SQL).toMatch(/is_active\s+BOOLEAN\s+NOT NULL\s+DEFAULT\s+TRUE/);
    expect(SQL).toMatch(
      /created_by\s+UUID\s+NULL\s+REFERENCES\s+users\(id\)\s+ON DELETE SET NULL/,
    );
    expect(SQL).toMatch(/created_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT\s+NOW\(\)/);
    expect(SQL).toMatch(/updated_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT\s+NOW\(\)/);
  });

  it('enforces the name_ar not-blank CHECK constraint', () => {
    expect(SQL).toMatch(
      /CONSTRAINT\s+product_groups_name_ar_not_blank\s+CHECK\s*\(\s*length\(btrim\(name_ar\)\)\s*>\s*0\s*\)/,
    );
  });

  it('creates partial index on is_active', () => {
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+idx_product_groups_active[\s\S]*?WHERE\s+is_active\s*=\s*TRUE/,
    );
  });

  it('creates product_group_variants with composite PK + cascade FKs', () => {
    expect(SQL).toMatch(
      /CREATE TABLE IF NOT EXISTS\s+product_group_variants\b/,
    );
    expect(SQL).toMatch(
      /group_id\s+UUID\s+NOT NULL\s+REFERENCES\s+product_groups\(id\)\s+ON DELETE CASCADE/,
    );
    expect(SQL).toMatch(
      /variant_id\s+UUID\s+NOT NULL\s+REFERENCES\s+product_variants\(id\)\s+ON DELETE CASCADE/,
    );
    expect(SQL).toMatch(
      /added_by\s+UUID\s+NULL\s+REFERENCES\s+users\(id\)\s+ON DELETE SET NULL/,
    );
    expect(SQL).toMatch(/added_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT\s+NOW\(\)/);
    expect(SQL).toMatch(/PRIMARY KEY\s*\(\s*group_id\s*,\s*variant_id\s*\)/);
  });

  it('creates the reverse-lookup index on variant_id', () => {
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+idx_product_group_variants_variant\s+ON\s+product_group_variants\(variant_id\)/,
    );
  });

  it('is purely additive — no drop / alter / destructive action', () => {
    expect(SQL).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i);
    expect(SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(SQL).not.toMatch(/\bTRUNCATE\b/i);
    expect(SQL).not.toMatch(/SET NOT NULL/i);
    expect(SQL).not.toMatch(/ALTER COLUMN/i);
    expect(SQL).not.toMatch(/RENAME COLUMN/i);
    expect(SQL).not.toMatch(/\bALTER TABLE\b/i);
  });

  it('does NOT backfill data', () => {
    expect(SQL).not.toMatch(/^\s*UPDATE\s+/im);
    expect(SQL).not.toMatch(/^\s*INSERT INTO\s+/im);
  });

  it('does NOT introduce triggers / functions / views', () => {
    expect(SQL).not.toMatch(/CREATE\s+TRIGGER/i);
    expect(SQL).not.toMatch(/CREATE\s+OR\s+REPLACE\s+TRIGGER/i);
    expect(SQL).not.toMatch(/CREATE\s+FUNCTION/i);
    expect(SQL).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
    expect(SQL).not.toMatch(/CREATE\s+VIEW/i);
    expect(SQL).not.toMatch(/CREATE\s+OR\s+REPLACE\s+VIEW/i);
  });

  it('does NOT touch any other table than the two new ones', () => {
    const tables = SQL.match(/CREATE\s+TABLE[^;]*?(?:IF NOT EXISTS\s+)?(\w+)/gi) || [];
    for (const t of tables) {
      expect(t).toMatch(/(product_groups|product_group_variants)/i);
    }
    const indexes = SQL.match(/CREATE\s+INDEX[^;]*?ON\s+(\w+)/gi) || [];
    for (const idx of indexes) {
      expect(idx).toMatch(/ON\s+(product_groups|product_group_variants)\b/i);
    }
  });
});
