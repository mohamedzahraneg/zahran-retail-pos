/**
 * migration-110-retire.spec.ts — PR-AUDIT-MIGRATION-110-RETIRE
 * ────────────────────────────────────────────────────────────────────
 *
 * Pins the contract for migration 110's supersession:
 *
 *   1. The file still exists in `database/migrations/` (do not delete it
 *      — the runner needs it to record the schema_migrations row, and
 *      future readers may reference its header for context).
 *   2. The file is now a no-op: contains the SUPERSEDED marker + the
 *      single DO block with one RAISE NOTICE; no UPDATE / INSERT /
 *      schema-mutating statements.
 *   3. The original `RAISE NOTICE 'foo' || 'bar'` syntax error pattern
 *      is gone from migration 110 specifically.
 *   4. **Forward-prevention:** scan EVERY .sql migration in the dir and
 *      assert NONE contain `RAISE NOTICE '...' || '...'` — the same
 *      class of bug must not slip into a new migration in the future.
 *
 * Read-only specs — no DataSource, no Postgres, just file inspection.
 */

import { readFileSync, readdirSync } from 'fs';
import { resolve } from 'path';

const MIGRATIONS_DIR = resolve(__dirname, '../../../database/migrations');
const MIGRATION_110_FILENAME = '110_pr_drift_3g_settlement7_reconciliation.sql';
const MIGRATION_110_PATH = resolve(MIGRATIONS_DIR, MIGRATION_110_FILENAME);

describe('migration 110 — retired (PR-AUDIT-MIGRATION-110-RETIRE)', () => {
  it('file still exists in database/migrations/', () => {
    const files = readdirSync(MIGRATIONS_DIR);
    expect(files).toContain(MIGRATION_110_FILENAME);
  });

  it('file body contains the SUPERSEDED marker so future readers know its status', () => {
    const src = readFileSync(MIGRATION_110_PATH, 'utf8');
    expect(src).toMatch(/SUPERSEDED/);
    expect(src).toMatch(/PR-AUDIT-MIGRATION-110-RETIRE/);
    // Pointer to the original SQL preserved in git history
    expect(src).toMatch(/git show e7d340e/);
  });

  it('file body documents WHY the original failed (RAISE NOTICE with || format)', () => {
    const src = readFileSync(MIGRATION_110_PATH, 'utf8');
    expect(src).toMatch(/syntax error at or near "\|\|"/);
    // Documents the specific PostgreSQL constraint (allow line wraps).
    expect(src).toMatch(/RAISE statement requires the format to be a SINGLE string/i);
  });

  it('file body is a NO-OP: only DO blocks, no UPDATE/INSERT/DELETE/ALTER/DROP/CREATE on real tables', () => {
    const src = readFileSync(MIGRATION_110_PATH, 'utf8');
    // Strip line comments + block comments so the prose explanation
    // doesn't trigger the keyword-in-comment false-positive.
    const code = src
      .replace(/^\s*--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/'[^'\n]*'/g, "''");
    // No DML / DDL keywords in executable code.
    expect(code).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(code).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(code).not.toMatch(/\bDROP\s+(TABLE|SCHEMA|VIEW|FUNCTION)\b/i);
    expect(code).not.toMatch(/\bCREATE\s+(TABLE|VIEW|FUNCTION|INDEX|TYPE)\b/i);
  });

  it('executable body contains exactly one DO block with one RAISE NOTICE (comments stripped)', () => {
    const src = readFileSync(MIGRATION_110_PATH, 'utf8');
    // Strip line comments so prose `-- RAISE NOTICE ...` examples in
    // the header documentation don't get counted as executable.
    const code = src.replace(/^\s*--.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    const doBlocks = code.match(/DO\s+\$\$/g) ?? [];
    expect(doBlocks.length).toBe(1);
    const noticeMatches = code.match(/RAISE\s+NOTICE\s+'/gi) ?? [];
    expect(noticeMatches.length).toBe(1);
  });

  it("the broken RAISE NOTICE 'foo' || 'bar' pattern is gone from migration 110", () => {
    const src = readFileSync(MIGRATION_110_PATH, 'utf8');
    // Strip block comments + line comments so the documentation example
    // (which legitimately quotes the broken pattern) doesn't trip the check.
    const code = src
      .replace(/^\s*--.*$/gm, '')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    // The broken pattern: RAISE NOTICE followed by a quoted string then ||
    // (with optional whitespace / newlines in between).
    expect(code).not.toMatch(/RAISE\s+NOTICE\s+'[^']*'\s*\|\|/i);
  });
});

describe("forward-prevention: no other migration may reuse the broken RAISE NOTICE 'foo' || 'bar' pattern", () => {
  // This is the defensive guard the original PR-DRIFT-3G author would have
  // benefited from. Every .sql migration in the dir is scanned (with line
  // comments + block comments stripped so legit prose never trips it).
  const offenders: Array<{ file: string; lineNo: number; line: string }> = [];

  beforeAll(() => {
    const files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
    for (const file of files) {
      const src = readFileSync(resolve(MIGRATIONS_DIR, file), 'utf8');
      const code = src
        .replace(/^\s*--.*$/gm, '')
        .replace(/\/\*[\s\S]*?\*\//g, '');
      // Look for `RAISE NOTICE 'string' ||` — the format-position concat
      // that PostgreSQL rejects.
      const matches = code.matchAll(/RAISE\s+NOTICE\s+'[^']*'\s*\|\|/gi);
      for (const m of matches) {
        const upToMatch = code.slice(0, m.index);
        const lineNo = upToMatch.split('\n').length;
        const line = code.split('\n')[lineNo - 1]?.trim() ?? '';
        offenders.push({ file, lineNo, line });
      }
    }
  });

  it("zero migrations in database/migrations/ contain RAISE NOTICE 'foo' || 'bar'", () => {
    if (offenders.length > 0) {
      const detail = offenders
        .map((o) => `  · ${o.file}:${o.lineNo}: ${o.line}`)
        .join('\n');
      throw new Error(
        `Found ${offenders.length} migration(s) with the broken pattern ` +
          `RAISE NOTICE 'foo' || 'bar' (PostgreSQL rejects it with ` +
          `'syntax error at or near "||"'):\n${detail}\n` +
          `Fix: collapse the format string to a single literal, or use ` +
          `format() for runtime composition.`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
