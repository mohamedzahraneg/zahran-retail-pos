/**
 * migration-134.spec.ts — PR-PURCHASES-P3.2
 *
 * Static guardrail. Reads `database/migrations/134_variant_price_history.sql`
 * + the applyVariantPrices service code and asserts:
 *   · the audit table has the required columns and indexes
 *   · the migration does NOT touch accounting / cashbox / stock /
 *     POS tables — pricing is a non-financial event
 *   · the apply-prices code path does NOT reference posting /
 *     financial-engine / cashbox / stock / GL primitives. If anyone
 *     reintroduces them, this test fails before merge.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION = readFileSync(
  join(__dirname, '..', '..', '..', 'database', 'migrations', '134_variant_price_history.sql'),
  'utf8',
);
const SERVICE = readFileSync(
  join(__dirname, 'products.service.ts'),
  'utf8',
);
const CONTROLLER = readFileSync(
  join(__dirname, 'products.controller.ts'),
  'utf8',
);

describe('migration 134 — variant_price_history table shape', () => {
  it('creates the variant_price_history table', () => {
    expect(MIGRATION).toMatch(
      /CREATE TABLE IF NOT EXISTS variant_price_history/i,
    );
  });

  it('declares the required columns', () => {
    expect(MIGRATION).toMatch(/\bvariant_id\s+UUID NOT NULL\b/);
    expect(MIGRATION).toMatch(/\bold_selling_price\s+NUMERIC\(14,2\) NOT NULL/);
    expect(MIGRATION).toMatch(/\bnew_selling_price\s+NUMERIC\(14,2\) NOT NULL/);
    expect(MIGRATION).toMatch(/\bsource_purchase_id\s+UUID REFERENCES purchases\(id\)/);
    expect(MIGRATION).toMatch(/\bsource_purchase_no\s+VARCHAR\(50\)/);
    expect(MIGRATION).toMatch(/\breason\s+TEXT/);
    expect(MIGRATION).toMatch(/\bchanged_by\s+UUID REFERENCES users\(id\)/);
    expect(MIGRATION).toMatch(/\bchanged_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
    expect(MIGRATION).toMatch(/\bmetadata\s+JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  });

  it('creates the three indexes', () => {
    expect(MIGRATION).toMatch(
      /CREATE INDEX[\s\S]+idx_variant_price_history_variant_changed_at[\s\S]+\(variant_id, changed_at DESC\)/,
    );
    expect(MIGRATION).toMatch(
      /CREATE INDEX[\s\S]+idx_variant_price_history_source_purchase[\s\S]+\(source_purchase_id\)/,
    );
    expect(MIGRATION).toMatch(
      /CREATE INDEX[\s\S]+idx_variant_price_history_changed_by[\s\S]+\(changed_by\)/,
    );
  });

  it('does NOT touch accounting / cashbox / stock / POS tables', () => {
    expect(MIGRATION).not.toMatch(/INSERT INTO journal_entries\b/i);
    expect(MIGRATION).not.toMatch(/INSERT INTO journal_lines\b/i);
    expect(MIGRATION).not.toMatch(/INSERT INTO cashbox_transactions\b/i);
    expect(MIGRATION).not.toMatch(/INSERT INTO stock_movements\b/i);
    expect(MIGRATION).not.toMatch(/INSERT INTO supplier_ledger\b/i);
    expect(MIGRATION).not.toMatch(/ALTER TABLE\s+(journal_entries|journal_lines|cashbox_transactions|stock_movements|product_variants|purchases|purchase_items|invoices|invoice_items)\b/i);
    expect(MIGRATION).not.toMatch(/CREATE TRIGGER\b/i);
  });
});

describe('apply-prices service — pricing-only guardrail', () => {
  it('does NOT call posting.service / financial-engine / cashbox / stock primitives', () => {
    // Scope the check to the applyVariantPrices method body.
    const startIdx = SERVICE.indexOf('async applyVariantPrices');
    expect(startIdx).toBeGreaterThan(-1);
    // Look forward from the method start through the next ~6 KB which
    // safely covers the method body.
    const slice = SERVICE.slice(startIdx, startIdx + 6000);

    expect(slice).not.toMatch(/postPurchase\b/);
    expect(slice).not.toMatch(/reverseByReference\b/);
    expect(slice).not.toMatch(/recordTransaction\b/);
    expect(slice).not.toMatch(/financialEngine\b/i);
    expect(slice).not.toMatch(/cashbox/i);
    expect(slice).not.toMatch(/stock_movements/i);
    expect(slice).not.toMatch(/journal_entries|journal_lines/i);
    expect(slice).not.toMatch(/supplier_ledger\b/i);
    expect(slice).not.toMatch(/purchase_items\b/i);
    // The only allowed writes are UPDATE product_variants (selling_price)
    // and INSERT INTO variant_price_history.
    expect(slice).toMatch(/UPDATE product_variants\s+SET\s+selling_price/);
    expect(slice).toMatch(/INSERT INTO variant_price_history\b/);
    // Crucially: the method must NOT write to product_variants.cost_price.
    expect(slice).not.toMatch(/cost_price\s*=/);
  });
});

describe('apply-prices controller — permission gate', () => {
  it('decorates the route with @Permissions("products.price_change")', () => {
    const startIdx = CONTROLLER.indexOf("'variants/apply-prices'");
    expect(startIdx).toBeGreaterThan(-1);
    // Look at the ~250 chars before the route signature for decorators.
    const window = CONTROLLER.slice(Math.max(0, startIdx - 300), startIdx + 200);
    expect(window).toMatch(/@Permissions\(\s*'products\.price_change'\s*\)/);
  });
});
