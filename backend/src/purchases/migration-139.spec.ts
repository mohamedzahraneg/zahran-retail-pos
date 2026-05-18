/**
 * migration-139.spec.ts — PR-P2.4A
 *
 * Static guardrail for migration 139 (purchase-returns settlement
 * metadata). Pins the additive-only contract.
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
    '139_purchase_returns_settlement.sql',
  ),
  'utf8',
);

// Strip line comments before forbidden-keyword scans.
const SQL = RAW.split('\n')
  .filter((l) => !/^\s*--/.test(l))
  .join('\n');

describe('migration 139 — purchase-returns settlement', () => {
  it('adds settlement_type with the approved enum + supplier_credit default', () => {
    expect(SQL).toMatch(
      /ADD COLUMN IF NOT EXISTS\s+settlement_type\s+VARCHAR\(20\)\s+NOT NULL\s+DEFAULT\s+'supplier_credit'/,
    );
    expect(SQL).toMatch(
      /CHECK\s*\(settlement_type IN\s*\(\s*'supplier_credit'\s*,\s*'cash_refund'\s*,\s*'bank_refund'\s*,\s*'no_settlement'\s*\)\)/,
    );
  });

  it('adds refund_amount + cashbox_id + posted_* + cancelled_* (all nullable)', () => {
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS\s+refund_amount\s+NUMERIC\(14,2\)\s+NULL/);
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS\s+cashbox_id\s+UUID\s+NULL/);
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS\s+posted_at\s+TIMESTAMPTZ\s+NULL/);
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS\s+posted_by\s+UUID\s+NULL/);
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS\s+cancelled_at\s+TIMESTAMPTZ\s+NULL/);
    expect(SQL).toMatch(/ADD COLUMN IF NOT EXISTS\s+cancelled_by\s+UUID\s+NULL/);
  });

  it('FKs use ON DELETE SET NULL on cashbox + users', () => {
    expect(SQL).toMatch(
      /purchase_returns_cashbox_fk[\s\S]*?REFERENCES\s+cashboxes\(id\)\s+ON DELETE SET NULL/,
    );
    expect(SQL).toMatch(
      /purchase_returns_posted_by_fk[\s\S]*?REFERENCES\s+users\(id\)\s+ON DELETE SET NULL/,
    );
    expect(SQL).toMatch(
      /purchase_returns_cancelled_by_fk[\s\S]*?REFERENCES\s+users\(id\)\s+ON DELETE SET NULL/,
    );
  });

  it('enforces the settlement-consistency CHECK constraint', () => {
    expect(SQL).toMatch(
      /purchase_returns_settlement_consistency[\s\S]*?CHECK[\s\S]*?settlement_type IN \('supplier_credit','no_settlement'\)[\s\S]*?cashbox_id IS NULL AND refund_amount IS NULL/,
    );
    expect(SQL).toMatch(
      /settlement_type IN \('cash_refund','bank_refund'\)[\s\S]*?cashbox_id IS NOT NULL[\s\S]*?refund_amount IS NOT NULL[\s\S]*?refund_amount >= 0/,
    );
  });

  it('adds purchase_item_id on purchase_return_items (nullable, ON DELETE SET NULL)', () => {
    expect(SQL).toMatch(
      /ALTER TABLE\s+purchase_return_items[\s\S]*?ADD COLUMN IF NOT EXISTS\s+purchase_item_id\s+UUID\s+NULL/,
    );
    expect(SQL).toMatch(
      /purchase_return_items_purchase_item_fk[\s\S]*?REFERENCES\s+purchase_items\(id\)\s+ON DELETE SET NULL/,
    );
  });

  it('creates partial indexes', () => {
    expect(SQL).toMatch(
      /idx_purchase_return_items_purchase_item[\s\S]*?WHERE\s+purchase_item_id IS NOT NULL/,
    );
    expect(SQL).toMatch(
      /idx_purchase_returns_cashbox[\s\S]*?WHERE\s+cashbox_id IS NOT NULL/,
    );
    expect(SQL).toMatch(
      /idx_purchase_returns_posted[\s\S]*?WHERE\s+posted_at IS NOT NULL/,
    );
  });

  it('is purely additive — no destructive DDL', () => {
    expect(SQL).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i);
    expect(SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(SQL).not.toMatch(/\bTRUNCATE\b/i);
    expect(SQL).not.toMatch(/SET NOT NULL/i);
    expect(SQL).not.toMatch(/ALTER COLUMN/i);
    expect(SQL).not.toMatch(/RENAME COLUMN/i);
  });

  it('does NOT backfill rows or create triggers / functions / views', () => {
    expect(SQL).not.toMatch(/^\s*UPDATE\s+/im);
    expect(SQL).not.toMatch(/^\s*INSERT INTO\s+/im);
    expect(SQL).not.toMatch(/CREATE\s+TRIGGER/i);
    expect(SQL).not.toMatch(/CREATE\s+FUNCTION/i);
    expect(SQL).not.toMatch(/CREATE\s+OR\s+REPLACE\s+(TRIGGER|FUNCTION|VIEW)/i);
  });

  it('only targets purchase_returns + purchase_return_items', () => {
    const alters = SQL.match(/ALTER\s+TABLE\s+(\w+)/gi) || [];
    for (const a of alters) {
      expect(a).toMatch(/ALTER\s+TABLE\s+(purchase_returns|purchase_return_items)\b/i);
    }
  });
});
