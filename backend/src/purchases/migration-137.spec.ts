/**
 * migration-137.spec.ts — PR-PURCHASES-P2.3B
 *
 * Static guardrail for migration 137 (purchase edit audit metadata).
 * Pins the additive, nullable, no-backfill contract so a future hand
 * accidentally adding a NOT NULL constraint or a backfill UPDATE
 * fails CI before reaching the DB.
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
    '137_purchase_edit_audit.sql',
  ),
  'utf8',
);

// Strip SQL comments (`-- …` lines) before scanning for destructive
// keywords; the header block prose mentions "no drop / alter" which
// the regex would otherwise flag as a false positive.
const SQL = RAW.split('\n')
  .filter((l) => !/^\s*--/.test(l))
  .join('\n');

describe('migration 137 — purchases edit audit metadata', () => {
  it('adds the three nullable columns via ADD COLUMN IF NOT EXISTS', () => {
    expect(SQL).toMatch(
      /ADD COLUMN IF NOT EXISTS\s+replaces_purchase_id\s+UUID\s+NULL/i,
    );
    expect(SQL).toMatch(
      /ADD COLUMN IF NOT EXISTS\s+replaced_by_purchase_id\s+UUID\s+NULL/i,
    );
    expect(SQL).toMatch(
      /ADD COLUMN IF NOT EXISTS\s+edit_reason\s+TEXT\s+NULL/i,
    );
  });

  it('adds self-referential FKs with ON DELETE SET NULL', () => {
    expect(SQL).toMatch(
      /ADD CONSTRAINT\s+purchases_replaces_fk[\s\S]*?REFERENCES purchases\(id\) ON DELETE SET NULL/,
    );
    expect(SQL).toMatch(
      /ADD CONSTRAINT\s+purchases_replaced_by_fk[\s\S]*?REFERENCES purchases\(id\) ON DELETE SET NULL/,
    );
  });

  it('creates two partial indexes (only rows in the edit chain)', () => {
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+idx_purchases_replaces[\s\S]*?WHERE replaces_purchase_id IS NOT NULL/,
    );
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS\s+idx_purchases_replaced_by[\s\S]*?WHERE replaced_by_purchase_id IS NOT NULL/,
    );
  });

  it('is purely additive — no drop / alter / destructive action', () => {
    expect(SQL).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i);
    // `DELETE FROM` is the destructive statement; FK `ON DELETE SET
    // NULL` is referential action and stays allowed.
    expect(SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(SQL).not.toMatch(/\bTRUNCATE\b/i);
    // No ALTER ... SET NOT NULL, no ALTER ... TYPE, no column rename.
    expect(SQL).not.toMatch(/SET NOT NULL/i);
    expect(SQL).not.toMatch(/ALTER COLUMN/i);
    expect(SQL).not.toMatch(/RENAME COLUMN/i);
  });

  it('does NOT backfill data', () => {
    // The migration must NOT include any UPDATE statement on
    // existing rows. Pre-P2.3B purchases keep all three columns NULL.
    expect(SQL).not.toMatch(/^\s*UPDATE\s+/im);
  });

  it('does NOT introduce triggers or functions', () => {
    expect(SQL).not.toMatch(/CREATE\s+TRIGGER/i);
    expect(SQL).not.toMatch(/CREATE\s+OR\s+REPLACE\s+TRIGGER/i);
    expect(SQL).not.toMatch(/CREATE\s+FUNCTION/i);
    expect(SQL).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
  });

  it('does NOT touch any other table than purchases', () => {
    // Tighten the radius: the only DDL targets here are `purchases`
    // and the two partial indexes on it. No stray ALTER on stock,
    // supplier_ledger, journal_entries, etc.
    const alters = SQL.match(/ALTER\s+TABLE\s+(\w+)/gi) || [];
    for (const a of alters) {
      expect(a).toMatch(/ALTER\s+TABLE\s+purchases\b/i);
    }
    const indexes = SQL.match(/CREATE\s+INDEX[^;]*?ON\s+(\w+)/gi) || [];
    for (const idx of indexes) {
      expect(idx).toMatch(/ON\s+purchases\b/i);
    }
  });
});
