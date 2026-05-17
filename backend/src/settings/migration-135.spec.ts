/**
 * migration-135.spec.ts — PR-PURCHASES-P3.3
 *
 * Static guardrail. Reads `database/migrations/135_seed_smart_pricing_settings.sql`
 * and asserts:
 *   · seeds the 9 expected keys
 *   · is idempotent (`ON CONFLICT (key) DO NOTHING`)
 *   · does NOT alter schema, create triggers, or touch any other table
 *   · the only INSERT is into `settings` with group_name='smart_pricing'
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATION_RAW = readFileSync(
  join(__dirname, '..', '..', '..', 'database', 'migrations', '135_seed_smart_pricing_settings.sql'),
  'utf8',
);
// Strip `--` line comments so the negative assertions don't trip on
// the "WHAT THIS DOES NOT DO" header block, which deliberately
// mentions tables this migration must NOT touch.
const MIGRATION = MIGRATION_RAW.split('\n')
  .map((line) => line.replace(/--.*$/, ''))
  .join('\n');

describe('migration 135 — smart_pricing seed shape', () => {
  it('seeds the nine expected keys', () => {
    for (const key of [
      'smart_pricing.competitive_markup_pct',
      'smart_pricing.recommended_margin_pct',
      'smart_pricing.high_margin_pct',
      'smart_pricing.wholesale_markup_pct',
      'smart_pricing.min_margin_pct_default',
      'smart_pricing.rounding_step',
      'smart_pricing.rounding_mode',
      'smart_pricing.show_wholesale_card',
      'smart_pricing.show_high_margin_card',
    ]) {
      expect(MIGRATION).toContain(`'${key}'`);
    }
  });

  it('is idempotent (ON CONFLICT DO NOTHING)', () => {
    expect(MIGRATION).toMatch(/ON CONFLICT \(key\) DO NOTHING/i);
  });

  it('only writes to the existing settings table', () => {
    const insertMatches = MIGRATION.match(/INSERT INTO\s+(\w+)/gi) || [];
    expect(insertMatches.length).toBeGreaterThan(0);
    for (const m of insertMatches) {
      expect(m).toMatch(/INSERT INTO\s+settings\b/i);
    }
  });

  it('does NOT alter schema, create triggers, or touch product/accounting/cashbox/stock tables', () => {
    expect(MIGRATION).not.toMatch(/CREATE TABLE\b/i);
    expect(MIGRATION).not.toMatch(/ALTER TABLE\b/i);
    expect(MIGRATION).not.toMatch(/DROP TABLE\b/i);
    expect(MIGRATION).not.toMatch(/CREATE TRIGGER\b/i);
    expect(MIGRATION).not.toMatch(/CREATE INDEX\b/i);
    expect(MIGRATION).not.toMatch(/product_variants/i);
    expect(MIGRATION).not.toMatch(/variant_price_history/i);
    expect(MIGRATION).not.toMatch(/journal_entries|journal_lines/i);
    expect(MIGRATION).not.toMatch(/cashbox_transactions/i);
    expect(MIGRATION).not.toMatch(/stock_movements/i);
    expect(MIGRATION).not.toMatch(/purchase_items|purchase_extra_costs/i);
    expect(MIGRATION).not.toMatch(/supplier_ledger/i);
  });

  it('every INSERT row is in group_name=smart_pricing', () => {
    const values = MIGRATION.match(/'smart_pricing'/gi) || [];
    expect(values.length).toBeGreaterThanOrEqual(9);
  });
});
