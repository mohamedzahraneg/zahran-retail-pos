/**
 * migration-129.spec.ts — PR-FIX-EXPENSE-APPROVAL-RULES-DEDUPE
 *
 * Static-content (file-on-disk) assertions for migration 129.  The
 * full apply-on-fresh-DB test runs in CI's PostgreSQL job; this BE-
 * jest companion locks the DDL contract so a code-review regression
 * fails immediately:
 *
 *   1. Migration file exists at the documented numbered slot.
 *   2. Soft-deactivate UPDATE keys off row_number() OVER (PARTITION BY
 *      required_role, level, min_amount, COALESCE(max_amount, -1)
 *      ORDER BY created_at, id).
 *   3. UPDATE only sets is_active=FALSE + notes marker + updated_at;
 *      it does NOT touch expense_approvals / expenses / cashbox_*.
 *   4. Notes marker `[migration-129]` is appended.
 *   5. Partial unique index `uq_expense_approval_rules_active_natural_key`
 *      is created with `WHERE is_active = TRUE`.
 *   6. Index expression uses COALESCE(max_amount, -1) normalization.
 *   7. CREATE UNIQUE INDEX IF NOT EXISTS — idempotent.
 *   8. NO destructive DDL — DROP / TRUNCATE / DELETE FROM blocked.
 *   9. NO migration-time financial writes — INSERT INTO journal_entries /
 *      journal_lines / cashbox_transactions / stock_movements blocked.
 *  10. NO touch on expense_approvals / expenses (negative grep — the
 *      cleanup is purely metadata on the rules table).
 *  11. NO `accounting_only` shortcut.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('migration 129 — expense_approval_rules dedupe + uniqueness', () => {
  const SQL = readFileSync(
    resolve(
      __dirname,
      '../../../database/migrations/129_expense_approval_rules_dedupe_and_uniqueness.sql',
    ),
    'utf8',
  );

  it('1. file exists and is read', () => {
    expect(SQL.length).toBeGreaterThan(500);
    expect(SQL).toContain('PR-FIX-EXPENSE-APPROVAL-RULES-DEDUPE');
  });

  it('2. soft-deactivate UPDATE uses row_number() OVER (PARTITION BY natural key ORDER BY created_at, id)', () => {
    expect(SQL).toMatch(
      /row_number\(\)\s+OVER\s*\(\s*PARTITION BY\s+required_role,\s*level,\s*min_amount,\s*COALESCE\(max_amount,\s*'-1'::numeric\)\s+ORDER BY\s+created_at,\s*id\s*\)/i,
    );
    // UPDATE … FROM duplicates d … WHERE d.rn > 1 keeps the oldest row.
    expect(SQL).toMatch(/d\.rn\s*>\s*1/);
  });

  it('3. UPDATE only sets is_active, notes, updated_at — nothing else', () => {
    // Pull the SET clause window.
    const m = SQL.match(/UPDATE public\.expense_approval_rules[\s\S]+?WHERE/);
    expect(m).toBeTruthy();
    const setClause = m![0];
    expect(setClause).toMatch(/SET\s+is_active\s*=\s*FALSE/i);
    expect(setClause).toMatch(/notes\s*=/);
    expect(setClause).toMatch(/updated_at\s*=\s*NOW\(\)/i);
    // Negative grep — must NOT touch the bracket / role / level keys.
    expect(setClause).not.toMatch(/SET[\s\S]+min_amount\s*=/i);
    expect(setClause).not.toMatch(/SET[\s\S]+max_amount\s*=/i);
    expect(setClause).not.toMatch(/SET[\s\S]+required_role\s*=/i);
    expect(setClause).not.toMatch(/SET[\s\S]+level\s*=/i);
  });

  it('4. notes marker `[migration-129] deactivated as duplicate (kept oldest in group)` is appended', () => {
    expect(SQL).toContain(
      '[migration-129] deactivated as duplicate (kept oldest in group)',
    );
    // Append, not overwrite — uses `COALESCE(r.notes || E'\\n', '')`.
    expect(SQL).toMatch(/COALESCE\(r\.notes\s*\|\|\s*E'\\n',\s*''\)\s*\|\|/);
  });

  it('5. partial unique index uq_expense_approval_rules_active_natural_key WHERE is_active = TRUE', () => {
    expect(SQL).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS\s+uq_expense_approval_rules_active_natural_key/i,
    );
    expect(SQL).toMatch(/WHERE\s+is_active\s*=\s*TRUE/i);
  });

  it('6. index expression normalizes max_amount via COALESCE(max_amount, -1)', () => {
    // The INDEX column list must include COALESCE(max_amount, '-1'::numeric).
    expect(SQL).toMatch(
      /ON public\.expense_approval_rules[\s\S]+COALESCE\(max_amount,\s*'-1'::numeric\)[\s\S]+WHERE\s+is_active/i,
    );
    // Same four columns appear in the same order in the index key.
    expect(SQL).toMatch(
      /ON public\.expense_approval_rules\s*\(\s*required_role,\s*level,\s*min_amount,\s*COALESCE\(max_amount,/i,
    );
  });

  it('7. CREATE UNIQUE INDEX IF NOT EXISTS — idempotent on re-apply', () => {
    // Both the UPDATE step (row_number() WHERE rn > 1 returns no rows on
    // re-apply) and the CREATE INDEX step are idempotent.
    expect(SQL).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS/i);
  });

  it('8. no destructive DDL — DROP / TRUNCATE / DELETE FROM blocked', () => {
    // Strip SQL line-comments (`-- …`) so the negative grep does not
    // false-positive on prose mentioning the forbidden keyword.
    const code = SQL.replace(/--[^\n]*/g, '');
    expect(code).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(code).not.toMatch(/\bDROP\s+INDEX\b/i);
    expect(code).not.toMatch(/\bDROP\s+TYPE\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('9. no migration-time financial writes — JE / JL / CT / SM blocked', () => {
    const code = SQL.replace(/--[^\n]*/g, '');
    expect(code).not.toMatch(/INSERT\s+INTO\s+journal_entries/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+journal_lines/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+cashbox_transactions/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+stock_movements/i);
  });

  it('10. does NOT touch expense_approvals / expenses', () => {
    const code = SQL.replace(/--[^\n]*/g, '');
    // No write-side DML against either table.
    expect(code).not.toMatch(/UPDATE\s+(public\.)?expense_approvals\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+(public\.)?expense_approvals\b/i);
    expect(code).not.toMatch(/DELETE\s+FROM\s+(public\.)?expense_approvals\b/i);
    expect(code).not.toMatch(/UPDATE\s+(public\.)?expenses\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+(public\.)?expenses\b/i);
    expect(code).not.toMatch(/DELETE\s+FROM\s+(public\.)?expenses\b/i);
  });

  it('11. no `accounting_only` shortcut in executable SQL (comments allowed for explanatory prose)', () => {
    // Strip SQL line-comments so the negative grep doesn't false-
    // positive on the migration's own header text mentioning the
    // forbidden token (e.g. "No accounting_only branch.").  After
    // stripping, the executable body must contain zero references.
    const code = SQL.replace(/--[^\n]*/g, '');
    expect(code).not.toMatch(/\baccounting_only\b/);
  });
});
