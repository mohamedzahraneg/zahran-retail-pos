/**
 * migration-130.spec.ts — PR-FIX-CASHBOX-DRIFT-VIEWS-REVERSAL-AWARE
 *
 * Static-content (file-on-disk) assertions for migration 130.  The
 * full apply-on-fresh-DB test runs in CI's PostgreSQL job; this BE-
 * jest companion locks the DDL contract so a code-review regression
 * fails immediately:
 *
 *   1. Migration file exists at the documented numbered slot.
 *   2. Both views are replaced via CREATE OR REPLACE VIEW.
 *   3. Each view's je-side predicate is reversal-aware:
 *        je.is_void = FALSE
 *        OR EXISTS (SELECT 1 FROM journal_entries r
 *                    WHERE r.reversal_of = je.id
 *                      AND r.is_posted = TRUE
 *                      AND r.is_void = FALSE)
 *   4. CT side filter is unchanged (only the JE side is reversal-aware).
 *   5. Self-validation block guards against missing views and
 *      missing reversal_of predicate.
 *   6. NO destructive DDL — DROP TABLE / TRUNCATE / DELETE FROM blocked.
 *   7. NO migration-time financial writes — INSERT / UPDATE on
 *      journal_entries / journal_lines / cashbox_transactions /
 *      stock_movements / cashboxes blocked.
 *   8. NO `accounting_only` shortcut.
 *   9. PR marker present in header for traceability.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('migration 130 — cashbox-drift views become reversal-aware', () => {
  const SQL = readFileSync(
    resolve(
      __dirname,
      '../../../database/migrations/130_v_cashbox_drift_views_reversal_aware.sql',
    ),
    'utf8',
  );

  // SQL line-comments stripped so negative-greps don't false-positive
  // on prose mentioning a forbidden keyword.
  const CODE = SQL.replace(/--[^\n]*/g, '');

  it('1. file exists and is non-trivial', () => {
    expect(SQL.length).toBeGreaterThan(1000);
    expect(SQL).toContain('PR-FIX-CASHBOX-DRIFT-VIEWS-REVERSAL-AWARE');
  });

  it('2. CREATE OR REPLACE VIEW v_cashbox_gl_drift', () => {
    expect(CODE).toMatch(/CREATE OR REPLACE VIEW\s+v_cashbox_gl_drift\b/i);
  });

  it('2. CREATE OR REPLACE VIEW v_cashbox_drift_per_ref', () => {
    expect(CODE).toMatch(
      /CREATE OR REPLACE VIEW\s+v_cashbox_drift_per_ref\b/i,
    );
  });

  it('3. reversal-aware EXISTS predicate present', () => {
    // The exact predicate shape, with whitespace-tolerant matching.
    expect(CODE).toMatch(
      /EXISTS\s*\(\s*SELECT\s+1\s+FROM\s+journal_entries\s+r/i,
    );
    expect(CODE).toMatch(/r\.reversal_of\s*=\s*je\.id/i);
    expect(CODE).toMatch(/r\.is_posted\s*=\s*TRUE/i);
    expect(CODE).toMatch(/r\.is_void\s*=\s*FALSE/i);
  });

  it('3. EXISTS predicate appears in BOTH view bodies (gl_drift + drift_per_ref)', () => {
    // Slice the file at each CREATE OR REPLACE VIEW boundary so we can
    // assert each view's body contains the predicate independently.
    const idxGl = CODE.search(/CREATE OR REPLACE VIEW\s+v_cashbox_gl_drift\b/i);
    const idxRef = CODE.search(
      /CREATE OR REPLACE VIEW\s+v_cashbox_drift_per_ref\b/i,
    );
    const idxValidate = CODE.search(/DO\s*\$\$/i);
    expect(idxGl).toBeGreaterThanOrEqual(0);
    expect(idxRef).toBeGreaterThan(idxGl);
    expect(idxValidate).toBeGreaterThan(idxRef);

    const glBody = CODE.slice(idxGl, idxRef);
    const refBody = CODE.slice(idxRef, idxValidate);

    expect(glBody).toMatch(/r\.reversal_of\s*=\s*je\.id/i);
    expect(glBody).toMatch(/r\.is_posted\s*=\s*TRUE/i);
    expect(glBody).toMatch(/r\.is_void\s*=\s*FALSE/i);

    expect(refBody).toMatch(/r\.reversal_of\s*=\s*je\.id/i);
    expect(refBody).toMatch(/r\.is_posted\s*=\s*TRUE/i);
    expect(refBody).toMatch(/r\.is_void\s*=\s*FALSE/i);
  });

  it('4. CT-side filter is unchanged (`is_void` filter on cashbox_transactions stays simple)', () => {
    // The CT-side filter in v_cashbox_drift_per_ref is unchanged from
    // mig 102: `COALESCE(ct.is_void, FALSE) = FALSE`.  No reversal_of
    // predicate on the CT side — CTs are emitted live (never voided)
    // by the engine's reverse-and-replay flow, so they pair correctly
    // by direction inversion alone.
    expect(CODE).toMatch(
      /COALESCE\(ct\.is_void,\s*FALSE\)\s*=\s*FALSE/i,
    );
    // Belt-and-braces — the `r.reversal_of` predicate must NOT appear
    // attached to ct.* anywhere.
    expect(CODE).not.toMatch(/r\.reversal_of\s*=\s*ct\./i);
  });

  it('5. self-validation DO $$ block guards both views and the predicate', () => {
    expect(CODE).toMatch(/DO\s*\$\$/i);
    expect(CODE).toMatch(/v_cashbox_gl_drift\b[\s\S]+RAISE EXCEPTION/);
    expect(CODE).toMatch(/v_cashbox_drift_per_ref\b[\s\S]+RAISE EXCEPTION/);
    // The DO block also asserts each view's pg_views.definition LIKE
    // '%reversal_of%'.
    expect(CODE).toMatch(
      /pg_views[\s\S]+v_cashbox_gl_drift[\s\S]+reversal_of/,
    );
    expect(CODE).toMatch(
      /pg_views[\s\S]+v_cashbox_drift_per_ref[\s\S]+reversal_of/,
    );
  });

  it('6. no destructive DDL — DROP TABLE / TRUNCATE / DELETE FROM blocked', () => {
    expect(CODE).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(CODE).not.toMatch(/\bDROP\s+INDEX\b/i);
    expect(CODE).not.toMatch(/\bDROP\s+TYPE\b/i);
    expect(CODE).not.toMatch(/\bDROP\s+SCHEMA\b/i);
    expect(CODE).not.toMatch(/\bTRUNCATE\b/i);
    expect(CODE).not.toMatch(/\bDELETE\s+FROM\b/i);
  });

  it('7. no migration-time financial writes — JE / JL / CT / SM / cashboxes blocked', () => {
    // No INSERT / UPDATE against the financial-state tables.  The
    // migration is `CREATE OR REPLACE VIEW` only.
    expect(CODE).not.toMatch(/INSERT\s+INTO\s+journal_entries\b/i);
    expect(CODE).not.toMatch(/INSERT\s+INTO\s+journal_lines\b/i);
    expect(CODE).not.toMatch(/INSERT\s+INTO\s+cashbox_transactions\b/i);
    expect(CODE).not.toMatch(/INSERT\s+INTO\s+stock_movements\b/i);
    expect(CODE).not.toMatch(/INSERT\s+INTO\s+cashboxes\b/i);

    expect(CODE).not.toMatch(/UPDATE\s+journal_entries\b/i);
    expect(CODE).not.toMatch(/UPDATE\s+journal_lines\b/i);
    expect(CODE).not.toMatch(/UPDATE\s+cashbox_transactions\b/i);
    expect(CODE).not.toMatch(/UPDATE\s+stock_movements\b/i);
    expect(CODE).not.toMatch(/UPDATE\s+cashboxes\b/i);
  });

  it('8. no `accounting_only` shortcut in executable SQL', () => {
    // After comment stripping, the executable body must contain zero
    // references to the bypass flag.
    expect(CODE).not.toMatch(/\baccounting_only\b/);
  });

  it('9. PR marker + companion artefact pointers documented in the header', () => {
    expect(SQL).toContain('PR-FIX-CASHBOX-DRIFT-VIEWS-REVERSAL-AWARE');
    expect(SQL).toContain('migration-130.spec.ts');
    expect(SQL).toContain('v-cashbox-drift-reversal-aware.spec.ts');
  });

  it('10. idempotent — CREATE OR REPLACE on both views (re-apply safe)', () => {
    // CREATE OR REPLACE VIEW is idempotent by definition; assert both
    // appear and there is no `CREATE VIEW` without `OR REPLACE`.
    const replaceMatches = CODE.match(/CREATE OR REPLACE VIEW/gi) ?? [];
    expect(replaceMatches.length).toBe(2);
    // No bare `CREATE VIEW` statement (would error on re-apply).
    expect(CODE).not.toMatch(/\bCREATE\s+VIEW\s+(?!OR REPLACE)/i);
  });
});
