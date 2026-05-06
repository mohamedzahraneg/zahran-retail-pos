/**
 * migration-123.spec.ts — PR-FIX-EXPENSES-DB-CHECK-CASH-REQUIRES-CASHBOX
 * ────────────────────────────────────────────────────────────────────
 *
 * Pins the static contract of migration 123 — the DB-level
 * defense-in-depth half of the PR #304 (PR-FIX-EXPENSES-APP-LEVEL-
 * CASHBOX-GUARD) work. The application-layer `assertExpenseInvariants`
 * helper still throws `BadRequestException` first; this DB CHECK is
 * the second wall: even if a future bug bypasses the helper, the
 * database refuses the row.
 *
 * What the spec asserts (file-on-disk only — no Postgres needed):
 *
 *   1. File exists at the expected numbered slot.
 *   2. Constraint name is exactly `expenses_cash_requires_cashbox_chk`.
 *   3. Predicate semantics match the JS guard:
 *      `lower(coalesce(payment_method::text,'cash')) <> 'cash'
 *       OR cashbox_id IS NOT NULL`.
 *   4. Idempotent — guarded by an `IF NOT EXISTS … pg_constraint` lookup.
 *   5. Direct validated CHECK (no NOT VALID + VALIDATE two-step) per
 *      the chosen approach (small table, zero violators on precheck).
 *   6. Zero DML — no UPDATE, no DELETE, no INSERT, no backfill.
 *   7. Self-validates with a DO $verify$ block that asserts the
 *      constraint is present on the expenses table after the ALTER.
 *
 * The full apply-on-fresh-DB test runs in the CI's
 * Database (PostgreSQL 15) job (see `.github/workflows/ci.yml`); this
 * file-level spec is the BE-jest companion that catches regressions in
 * code review without spinning up Postgres.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATIONS_DIR = resolve(__dirname, '../../../database/migrations');
const FILENAME = '123_pr_fix_expenses_db_check_cash_requires_cashbox.sql';
const FULL_PATH = resolve(MIGRATIONS_DIR, FILENAME);

describe('migration 123 — PR-FIX-EXPENSES-DB-CHECK-CASH-REQUIRES-CASHBOX', () => {
  const SQL = readFileSync(FULL_PATH, 'utf8');

  it('1. file exists in database/migrations/', () => {
    const files = readdirSync(MIGRATIONS_DIR);
    expect(files).toContain(FILENAME);
    expect(SQL.length).toBeGreaterThan(500);
    expect(SQL).toContain('PR-FIX-EXPENSES-DB-CHECK-CASH-REQUIRES-CASHBOX');
  });

  it('2. constraint name is exactly expenses_cash_requires_cashbox_chk', () => {
    expect(SQL).toMatch(
      /ADD CONSTRAINT expenses_cash_requires_cashbox_chk/,
    );
    expect(SQL).toMatch(/conname = 'expenses_cash_requires_cashbox_chk'/);
  });

  it('3. predicate uses lower(coalesce(payment_method::text,\'cash\')) — matches PR #304 JS semantics', () => {
    // The exact predicate shape — text cast on the enum, lower() to
    // mirror `(payment_method ?? "cash").toLowerCase()` from
    // assertExpenseInvariants.
    expect(SQL).toMatch(
      /lower\(coalesce\(payment_method::text,\s*'cash'\)\)\s*<>\s*'cash'/,
    );
    expect(SQL).toMatch(/OR cashbox_id IS NOT NULL/);
    // Sanity: the constraint must contain ALTER TABLE expenses
    expect(SQL).toMatch(/ALTER TABLE expenses\s+ADD CONSTRAINT/);
  });

  it('4. is idempotent — guarded by pg_constraint exists check', () => {
    // The ALTER lives inside a DO block that first checks for an
    // existing constraint with the same name. Re-applying the
    // migration on a partially-applied DB must be a no-op.
    expect(SQL).toMatch(
      /IF NOT EXISTS \(\s*SELECT 1\s+FROM pg_constraint\s+WHERE conname = 'expenses_cash_requires_cashbox_chk'/,
    );
  });

  it('5. uses direct validated CHECK (NOT the NOT VALID + VALIDATE two-step)', () => {
    // Direct one-step is appropriate here — table is small (34 rows
    // at precheck) and precheck showed 0 violators. The two-step is
    // reserved for large tables; using it here would just add a
    // transient NOT-VALID window with no benefit.
    //
    // The regex below matches actual SQL statements only — i.e.
    // a CHECK clause physically followed by `NOT VALID` (which is
    // how PG appends the marker), or a standalone
    // `VALIDATE CONSTRAINT name` statement. The migration's prose
    // header DOES mention these terms in the explanatory section;
    // we don't care about that.
    expect(SQL).not.toMatch(/CHECK\s*\([\s\S]*?\)\s*NOT\s+VALID/i);
    expect(SQL).not.toMatch(/ALTER\s+TABLE[\s\S]*?VALIDATE\s+CONSTRAINT/i);
  });

  it('6. zero DML — no UPDATE / DELETE / INSERT / backfill on production tables', () => {
    // Expenses, journal_entries, cashbox_transactions, journal_lines,
    // stock_movements, cashboxes — none of these may be touched at the
    // row level. The migration is pure DDL.
    expect(SQL).not.toMatch(/^\s*UPDATE\s+expenses\b/im);
    expect(SQL).not.toMatch(/^\s*DELETE\s+FROM\s+expenses\b/im);
    expect(SQL).not.toMatch(
      /\bINSERT\s+INTO\s+(expenses|journal_entries|journal_lines|cashbox_transactions|stock_movements|cashboxes)\b/i,
    );
    expect(SQL).not.toMatch(
      /\bUPDATE\s+(journal_entries|journal_lines|cashbox_transactions|stock_movements|cashboxes)\b/i,
    );
    expect(SQL).not.toMatch(
      /\bDELETE\s+FROM\s+(journal_entries|journal_lines|cashbox_transactions|stock_movements|cashboxes)\b/i,
    );
    // No backfill keyword in any inline comment either — defensive
    // against a future contributor accidentally re-introducing one.
    expect(SQL).not.toMatch(/\bbackfill\s*=/i);
  });

  it('7. self-validates with a DO $verify$ block that asserts the constraint is present', () => {
    expect(SQL).toMatch(/DO \$verify\$[\s\S]+\$verify\$;/);
    expect(SQL).toMatch(
      /expenses_cash_requires_cashbox_chk constraint missing on expenses/,
    );
    // The verify block must look up pg_constraint joined to pg_class
    // so it confirms the constraint is bound to the `expenses` table
    // specifically, not just present somewhere in the catalog.
    expect(SQL).toMatch(/pg_constraint c[\s\S]+pg_class t[\s\S]+t\.oid = c\.conrelid/);
    expect(SQL).toMatch(/t\.relname = 'expenses'/);
    expect(SQL).toMatch(/c\.contype = 'c'/);
  });

  it('8. does NOT add a shift_id rule (out of scope per PR-10B spec)', () => {
    // Defensive: future-proof against a refactor that tries to
    // piggyback a shift_id constraint onto the same migration.
    // The regex below matches `shift_id` INSIDE a CHECK predicate
    // (between `CHECK (` and the matching `)`) — narrower than the
    // greedy `/CHECK[\s\S]+shift_id/` which would also catch the
    // header prose "No `shift_id` rule (out of scope ...)" that
    // explicitly documents this constraint's non-goal.
    expect(SQL).not.toMatch(/shift_id\s+IS\s+NOT\s+NULL/i);
    expect(SQL).not.toMatch(/CHECK\s*\([^)]*shift_id/i);
  });

  it('9. does NOT touch any other constraint (no DROP, no rename, no relax)', () => {
    expect(SQL).not.toMatch(/\bDROP\s+CONSTRAINT\b/i);
    expect(SQL).not.toMatch(/\bRENAME\s+CONSTRAINT\b/i);
    expect(SQL).not.toMatch(/\bALTER\s+CONSTRAINT\b/i);
  });

  it('10. references PR #304 — explicit cross-link to the app-level guard', () => {
    expect(SQL).toMatch(/PR #304|PR-FIX-EXPENSES-APP-LEVEL-CASHBOX-GUARD/);
    expect(SQL).toMatch(/assertExpenseInvariants/);
  });
});
