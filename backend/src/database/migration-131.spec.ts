/**
 * migration-131.spec.ts — PR-FIX-CASHBOX-DRIFT-VIEWS-SUCCESSOR-GUARD
 *
 * Static-content (file-on-disk) assertions for migration 131.  This
 * tightens migration 130's reversal-aware predicate by adding a
 * successor guard, so cancel-only patterns (voided original + live
 * reversal but NO live replacement on the same business doc — e.g.
 * RET-2026-000003) stay excluded from the projection.  Pin the DDL
 * contract so a code-review regression fails immediately:
 *
 *   1. Migration file exists at the documented numbered slot.
 *   2. Both views are replaced via CREATE OR REPLACE VIEW.
 *   3. Each view's je-side predicate has both branches:
 *        (a) reversal-aware: r.reversal_of = je.id, r.is_posted=TRUE,
 *            r.is_void=FALSE.
 *        (b) successor guard: r2.reference_type = je.reference_type,
 *            r2.reference_id = je.reference_id, r2.id <> je.id,
 *            r2.is_posted=TRUE, r2.is_void=FALSE, r2.reversal_of IS NULL.
 *      The two EXISTS clauses are AND-combined.
 *   4. CT side filter is unchanged (only the JE side gets the new
 *      predicate).
 *   5. Self-validation block guards against missing views, missing
 *      reversal_of predicate, AND missing successor-guard fragment
 *      (`reversal_of IS NULL`).
 *   6. NO destructive DDL.
 *   7. NO migration-time financial writes — JE / JL / CT / SM /
 *      cashboxes blocked.
 *   8. NO `accounting_only`.
 *   9. PR marker present in header.
 *  10. Idempotent — CREATE OR REPLACE on both views.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('migration 131 — cashbox-drift views: successor guard', () => {
  const SQL = readFileSync(
    resolve(
      __dirname,
      '../../../database/migrations/131_v_cashbox_drift_views_successor_guard.sql',
    ),
    'utf8',
  );

  const CODE = SQL.replace(/--[^\n]*/g, '');

  it('1. file exists and is non-trivial', () => {
    expect(SQL.length).toBeGreaterThan(1000);
    expect(SQL).toContain('PR-FIX-CASHBOX-DRIFT-VIEWS-SUCCESSOR-GUARD');
  });

  it('2. CREATE OR REPLACE VIEW for both views', () => {
    expect(CODE).toMatch(/CREATE OR REPLACE VIEW\s+v_cashbox_gl_drift\b/i);
    expect(CODE).toMatch(
      /CREATE OR REPLACE VIEW\s+v_cashbox_drift_per_ref\b/i,
    );
  });

  it('3a. reversal-aware predicate present (r.reversal_of = je.id, r.is_posted=TRUE, r.is_void=FALSE)', () => {
    expect(CODE).toMatch(/r\.reversal_of\s*=\s*je\.id/i);
    expect(CODE).toMatch(/r\.is_posted\s*=\s*TRUE/i);
    expect(CODE).toMatch(/r\.is_void\s*=\s*FALSE/i);
  });

  it('3b. successor guard present (r2.reference_type, r2.reference_id, r2.id <> je.id, r2.reversal_of IS NULL)', () => {
    expect(CODE).toMatch(
      /r2\.reference_type\s*=\s*je\.reference_type/i,
    );
    expect(CODE).toMatch(/r2\.reference_id\s*=\s*je\.reference_id/i);
    expect(CODE).toMatch(/r2\.id\s*<>\s*je\.id/i);
    expect(CODE).toMatch(/r2\.is_posted\s*=\s*TRUE/i);
    expect(CODE).toMatch(/r2\.is_void\s*=\s*FALSE/i);
    expect(CODE).toMatch(/r2\.reversal_of\s+IS\s+NULL/i);
  });

  it('3c. the two EXISTS clauses are AND-combined within each view body', () => {
    // Slice each view's body and assert both EXISTS predicates appear,
    // joined by AND.
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

    // Both branches present in each view body.
    for (const [name, body] of [
      ['v_cashbox_gl_drift', glBody],
      ['v_cashbox_drift_per_ref', refBody],
    ] as const) {
      expect(body).toMatch(/r\.reversal_of\s*=\s*je\.id/i);
      expect(body).toMatch(/r2\.reference_type\s*=\s*je\.reference_type/i);
      expect(body).toMatch(/r2\.reversal_of\s+IS\s+NULL/i);
      // The two EXISTS clauses are AND-combined.  Pull a window around
      // the first EXISTS and assert AND EXISTS appears within the next
      // ~600 chars (the full nested predicate).
      const firstExists = body.search(/EXISTS\s*\(/i);
      expect(firstExists).toBeGreaterThanOrEqual(0);
      const window = body.slice(firstExists, firstExists + 800);
      expect(window).toMatch(/AND\s+EXISTS\s*\(/i);
      // sanity: the window contains the successor guard's reversal_of
      // IS NULL fragment.
      expect(window).toMatch(/reversal_of\s+IS\s+NULL/i);
      void name;
    }
  });

  it('4. CT-side filter is unchanged (the new predicate is JE-side only)', () => {
    expect(CODE).toMatch(/COALESCE\(ct\.is_void,\s*FALSE\)\s*=\s*FALSE/i);
    expect(CODE).not.toMatch(/r\.reversal_of\s*=\s*ct\./i);
    expect(CODE).not.toMatch(/r2\.reference_type\s*=\s*ct\./i);
  });

  it('5. self-validation DO $$ block guards both views, predicate, and successor guard', () => {
    expect(CODE).toMatch(/DO\s*\$\$/i);
    expect(CODE).toMatch(/v_cashbox_gl_drift\b[\s\S]+RAISE EXCEPTION/);
    expect(CODE).toMatch(/v_cashbox_drift_per_ref\b[\s\S]+RAISE EXCEPTION/);
    // pg_views.definition LIKE '%reversal_of%' assertion (from mig 130, kept).
    expect(CODE).toMatch(
      /pg_views[\s\S]+v_cashbox_gl_drift[\s\S]+reversal_of/,
    );
    expect(CODE).toMatch(
      /pg_views[\s\S]+v_cashbox_drift_per_ref[\s\S]+reversal_of/,
    );
    // Successor-guard fragment assertion — `reversal_of IS NULL` only
    // appears in the new predicate, never in mig 130's view body.
    expect(CODE).toMatch(/definition\s+ILIKE\s+'%reversal_of IS NULL%'/i);
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
    expect(CODE).not.toMatch(/\baccounting_only\b/);
  });

  it('9. PR marker + companion artefact pointers documented in the header', () => {
    expect(SQL).toContain('PR-FIX-CASHBOX-DRIFT-VIEWS-SUCCESSOR-GUARD');
    expect(SQL).toContain('migration-131.spec.ts');
    expect(SQL).toContain('v-cashbox-drift-reversal-aware.spec.ts');
  });

  it('10. idempotent — CREATE OR REPLACE on both views (re-apply safe)', () => {
    const replaceMatches = CODE.match(/CREATE OR REPLACE VIEW/gi) ?? [];
    expect(replaceMatches.length).toBe(2);
    expect(CODE).not.toMatch(/\bCREATE\s+VIEW\s+(?!OR REPLACE)/i);
  });
});
