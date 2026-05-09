/**
 * migration-128.spec.ts — PR-FIX-SHIFTS-OPENING-BALANCE-ADJUST
 *
 * Static-content (file-on-disk) assertions for migration 128. The
 * full apply-on-fresh-DB test runs in CI's PostgreSQL job; this
 * BE-jest companion locks the DDL contract:
 *
 *   1. Migration file exists at the documented numbered slot.
 *   2. CREATE TABLE shift_opening_balance_adjustments with the
 *      complete column set + types.
 *   3. CHECK (new_opening_balance >= 0).
 *   4. CHECK (length(trim(reason)) >= 5).
 *   5. FK to users(id) on adjusted_by.
 *   6. FK to shifts(id) on shift_id with ON DELETE CASCADE.
 *   7. Two indexes (by shift+adjusted_at desc, by adjusted_at desc).
 *   8. Permission seed `shifts.opening_balance.adjust` + module='shifts'.
 *   9. Admin and manager grants via roles.permissions[] array column.
 *  10. Cashier intentionally NOT granted (catalog grant blocks it; the
 *      only mention of 'cashier' would be in a positive grant block).
 *  11. NO destructive DDL — DROP / TRUNCATE / DELETE FROM blocked.
 *  12. NO migration-time accounting writes — INSERT INTO journal_entries /
 *      cashbox_transactions / stock_movements blocked.
 *  13. Idempotent re-apply: CREATE TABLE IF NOT EXISTS, CREATE INDEX
 *      IF NOT EXISTS, ON CONFLICT DO NOTHING.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('migration 128 — shift_opening_balance_adjustments schema', () => {
  const SQL = readFileSync(
    resolve(
      __dirname,
      '../../../database/migrations/128_shift_opening_balance_adjustments.sql',
    ),
    'utf8',
  );

  it('1. file exists and is read', () => {
    expect(SQL.length).toBeGreaterThan(500);
    expect(SQL).toContain('PR-FIX-SHIFTS-OPENING-BALANCE-ADJUST');
  });

  it('2. CREATE TABLE shift_opening_balance_adjustments declares every column', () => {
    expect(SQL).toMatch(
      /CREATE TABLE IF NOT EXISTS public\.shift_opening_balance_adjustments/,
    );
    // Column types — pinned so a future drift surfaces immediately.
    expect(SQL).toMatch(/id\s+UUID\s+PRIMARY KEY/);
    expect(SQL).toMatch(/shift_id\s+UUID\s+NOT NULL/);
    expect(SQL).toMatch(/old_opening_balance\s+NUMERIC\(14,2\)\s+NOT NULL/);
    expect(SQL).toMatch(/new_opening_balance\s+NUMERIC\(14,2\)\s+NOT NULL/);
    expect(SQL).toMatch(/old_expected_closing\s+NUMERIC\(14,2\)/);
    expect(SQL).toMatch(/new_expected_closing\s+NUMERIC\(14,2\)/);
    expect(SQL).toMatch(/shift_status_at_adjust\s+VARCHAR\(20\)\s+NOT NULL/);
    expect(SQL).toMatch(/has_movements_at_adjust\s+BOOLEAN\s+NOT NULL/);
    expect(SQL).toMatch(/reason\s+TEXT\s+NOT NULL/);
    expect(SQL).toMatch(/notes\s+TEXT/);
    expect(SQL).toMatch(/adjusted_by\s+UUID\s+NOT NULL/);
    expect(SQL).toMatch(/adjusted_at\s+TIMESTAMPTZ\s+NOT NULL\s+DEFAULT NOW\(\)/);
  });

  it('3. CHECK new_opening_balance >= 0', () => {
    expect(SQL).toMatch(/CHECK\s*\(\s*new_opening_balance\s*>=\s*0\s*\)/);
  });

  it('4. CHECK length(trim(reason)) >= 5', () => {
    expect(SQL).toMatch(/CHECK\s*\(\s*length\(trim\(reason\)\)\s*>=\s*5\s*\)/);
  });

  it('5. FK on adjusted_by references users(id)', () => {
    expect(SQL).toMatch(/adjusted_by\s+UUID\s+NOT NULL\s+REFERENCES public\.users\(id\)/);
  });

  it('6. FK on shift_id references shifts(id) ON DELETE CASCADE', () => {
    expect(SQL).toMatch(
      /shift_id\s+UUID\s+NOT NULL\s+REFERENCES public\.shifts\(id\)\s+ON DELETE CASCADE/,
    );
  });

  it('7. creates the two expected indexes', () => {
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS ix_shift_opening_balance_adjustments_shift[\s\S]+\(shift_id, adjusted_at DESC\)/,
    );
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS ix_shift_opening_balance_adjustments_when[\s\S]+\(adjusted_at DESC\)/,
    );
  });

  it('8. seeds permission shifts.opening_balance.adjust under module=shifts', () => {
    expect(SQL).toMatch(
      /INSERT INTO public\.permissions[\s\S]+'shifts\.opening_balance\.adjust',\s*'shifts'/,
    );
    // Arabic + English names per the brief.
    expect(SQL).toContain('تعديل الرصيد الافتتاحي للوردية');
    expect(SQL).toContain('Adjust shift opening balance');
    // Idempotent on re-apply.
    expect(SQL).toMatch(/ON CONFLICT \(code\)\s+DO NOTHING/);
  });

  it("9. grants the permission to admin and manager (roles.permissions[] + role_permissions)", () => {
    // The legacy roles.permissions[] update — admin row.
    expect(SQL).toMatch(
      /UPDATE public\.roles[\s\S]+ARRAY\['shifts\.opening_balance\.adjust'\]::text\[\][\s\S]+WHERE code = 'admin'/,
    );
    // Manager row.
    expect(SQL).toMatch(
      /UPDATE public\.roles[\s\S]+ARRAY\['shifts\.opening_balance\.adjust'\]::text\[\][\s\S]+WHERE code = 'manager'/,
    );
    // Junction-table grant for both roles.
    expect(SQL).toMatch(
      /INSERT INTO public\.role_permissions[\s\S]+r\.code IN \('admin',\s*'manager'\)[\s\S]+p\.code = 'shifts\.opening_balance\.adjust'/,
    );
    expect(SQL).toMatch(/ON CONFLICT DO NOTHING/);
  });

  it("10. cashier is NOT granted the permission anywhere in the migration", () => {
    // No direct grant to cashier role in either UPDATE form or the
    // junction-table INSERT.
    expect(SQL).not.toMatch(
      /UPDATE public\.roles[\s\S]+'shifts\.opening_balance\.adjust'[\s\S]+WHERE code = 'cashier'/,
    );
    expect(SQL).not.toMatch(
      /r\.code IN \([^)]*'cashier'[^)]*\)[\s\S]+'shifts\.opening_balance\.adjust'/,
    );
  });

  it('11. no destructive DDL — DROP / TRUNCATE / DELETE FROM blocked', () => {
    // Strip SQL line-comments (`-- …`) so the negative grep does not
    // false-positive on prose mentioning the forbidden keyword.
    const code = SQL.replace(/--[^\n]*/g, '');
    expect(code).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(code).not.toMatch(/\bDROP\s+INDEX\b/i);
    expect(code).not.toMatch(/\bDROP\s+TYPE\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('12. no migration-time accounting writes — JE / CT / SM blocked', () => {
    const code = SQL.replace(/--[^\n]*/g, '');
    expect(code).not.toMatch(/INSERT\s+INTO\s+journal_entries/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+journal_lines/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+cashbox_transactions/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+stock_movements/i);
    // Defensive — the migration must not run any FinancialEngine
    // call (it can't, but the negative pin guards against future
    // accidental refactors that try to invoke a function).
    expect(code).not.toMatch(/financial_engine|recordTransaction|accounting_only/i);
  });

  it('13. idempotent re-apply — IF NOT EXISTS / ON CONFLICT DO NOTHING', () => {
    expect(SQL).toMatch(/CREATE TABLE IF NOT EXISTS/);
    expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS\s+ix_shift_opening_balance_adjustments_shift/);
    expect(SQL).toMatch(/CREATE INDEX IF NOT EXISTS\s+ix_shift_opening_balance_adjustments_when/);
    // Permission seed.
    expect(SQL).toMatch(/ON CONFLICT \(code\) DO NOTHING/);
    // Junction-table grant.
    expect(SQL).toMatch(/ON CONFLICT DO NOTHING/);
  });
});
