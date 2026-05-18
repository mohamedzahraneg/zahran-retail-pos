/**
 * migration-141.spec.ts — PR-PURCHASES-P2.4A-FIX-ENUM-2
 *
 * Static guardrail for migration 141. Pins:
 *   · single additive ALTER TYPE entity_type ADD VALUE IF NOT EXISTS
 *     'purchase_return' (same shape as migration 107's
 *     'employee_settlement' addition)
 *   · the migration only touches the `entity_type` enum — no DDL on
 *     tables, columns, constraints, indexes, triggers, functions, or
 *     other enums
 *   · the migration is non-destructive (no DROP / DELETE / TRUNCATE /
 *     ALTER COLUMN / RENAME)
 *   · no POS / sales-returns / pricing / provisioning references
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
    '141_entity_type_purchase_return.sql',
  ),
  'utf8',
);

// Strip SQL line comments before scanning negative patterns so the
// header comments (which legitimately describe what we DON'T do)
// can't trigger false positives.
const SQL = RAW.split('\n')
  .filter((l) => !/^\s*--/.test(l))
  .join('\n');

describe('migration 141 — entity_type += purchase_return', () => {
  it('adds the new enum value via the additive ADD VALUE IF NOT EXISTS pattern', () => {
    expect(SQL).toMatch(
      /ALTER\s+TYPE\s+entity_type\s+ADD\s+VALUE\s+IF\s+NOT\s+EXISTS\s+'purchase_return'/i,
    );
  });

  it('touches ONLY the entity_type enum — no other ALTER TYPE / CREATE TYPE', () => {
    const altered = SQL.match(/ALTER\s+TYPE\s+(\w+)/gi) ?? [];
    expect(altered).toHaveLength(1);
    expect(altered[0]).toMatch(/ALTER\s+TYPE\s+entity_type/i);
    expect(SQL).not.toMatch(/CREATE\s+TYPE\b/i);
  });

  it('is non-destructive — no DDL on tables / columns / constraints / indexes / triggers / functions', () => {
    expect(SQL).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX|TYPE|FUNCTION|TRIGGER)\b/i);
    expect(SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(SQL).not.toMatch(/\bTRUNCATE\b/i);
    expect(SQL).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(SQL).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(SQL).not.toMatch(/\bCREATE\s+(TRIGGER|INDEX|FUNCTION)\b/i);
    expect(SQL).not.toMatch(/\bRENAME\b/i);
    expect(SQL).not.toMatch(/\bSET\s+NOT\s+NULL\b/i);
  });

  it('does not mutate any rows (no UPDATE / INSERT)', () => {
    expect(SQL).not.toMatch(/^\s*UPDATE\s+/im);
    expect(SQL).not.toMatch(/^\s*INSERT\s+INTO\s+/im);
  });

  it('does not reference POS / sales-returns / pricing / provisioning tables', () => {
    expect(SQL).not.toMatch(/\bpos_/i);
    expect(SQL).not.toMatch(/\binvoice_items\b|\binvoices\b/i);
    expect(SQL).not.toMatch(/FROM\s+returns\b/i);
    expect(SQL).not.toMatch(/\bprice_lists\b/i);
    expect(SQL).not.toMatch(/\bprovisioning\b/i);
  });

  it('only the single approved enum value is added', () => {
    const addedValues =
      SQL.match(/ADD\s+VALUE\s+IF\s+NOT\s+EXISTS\s+'([^']+)'/gi) ?? [];
    expect(addedValues).toHaveLength(1);
    expect(addedValues[0]).toMatch(/'purchase_return'/);
  });
});
