import { types as pgTypes } from 'pg';
import { applyPgDateParserOverride } from './pg-date-parser';

/**
 * Focused tests for the PR-PHASE2-TZ-FIX pg type parser override.
 *
 * Verifies:
 *   1. After applying the override, the DATE parser returns raw
 *      `YYYY-MM-DD` strings (no JS Date construction).
 *   2. TIMESTAMP and TIMESTAMPTZ parsers are NOT modified.
 *
 * Run order note: jest may execute spec files in arbitrary order.  We
 * snapshot the pre-override parsers in beforeAll so other tests can
 * restore them if they need to (none do today).
 */
describe('pg DATE type parser override (PR-PHASE2-TZ-FIX)', () => {
  let priorTimestampParser: any;
  let priorTimestamptzParser: any;

  beforeAll(() => {
    priorTimestampParser = pgTypes.getTypeParser(pgTypes.builtins.TIMESTAMP);
    priorTimestamptzParser = pgTypes.getTypeParser(pgTypes.builtins.TIMESTAMPTZ);
    applyPgDateParserOverride();
  });

  it('returns DATE values as raw YYYY-MM-DD strings (no Date conversion)', () => {
    const parser = pgTypes.getTypeParser(pgTypes.builtins.DATE);
    expect(parser('2026-04-01')).toBe('2026-04-01');
    expect(parser('2026-12-31')).toBe('2026-12-31');
    expect(parser('1900-01-01')).toBe('1900-01-01');
  });

  it('returned DATE values do NOT contain a T time component', () => {
    const parser = pgTypes.getTypeParser(pgTypes.builtins.DATE);
    const out = parser('2026-04-01') as string;
    expect(typeof out).toBe('string');
    expect(out).not.toMatch(/T\d{2}:\d{2}/);
    expect(out).not.toMatch(/Z$/);
  });

  it('TIMESTAMP parser is NOT overridden (still returns Date)', () => {
    const parser = pgTypes.getTypeParser(pgTypes.builtins.TIMESTAMP);
    // Same identity as before our override
    expect(parser).toBe(priorTimestampParser);
    const result = parser('2026-04-01 12:34:56') as any;
    expect(result).toBeInstanceOf(Date);
  });

  it('TIMESTAMPTZ parser is NOT overridden (still returns Date)', () => {
    const parser = pgTypes.getTypeParser(pgTypes.builtins.TIMESTAMPTZ);
    expect(parser).toBe(priorTimestamptzParser);
    const result = parser('2026-04-01 12:34:56+00') as any;
    expect(result).toBeInstanceOf(Date);
  });

  it('applyPgDateParserOverride is idempotent (re-applying is safe)', () => {
    applyPgDateParserOverride();
    applyPgDateParserOverride();
    const parser = pgTypes.getTypeParser(pgTypes.builtins.DATE);
    expect(parser('2026-04-01')).toBe('2026-04-01');
  });

  it('main.ts wires the override at module load (source-grep)', () => {
    // Belt-and-suspenders: catch a future regression where someone
    // refactors main.ts and drops the side-effect import.
    const fs = require('node:fs');
    const path = require('node:path');
    const src = fs.readFileSync(
      path.resolve(__dirname, '../main.ts'),
      'utf-8',
    );
    expect(src).toMatch(/applyPgDateParserOverride\s*\(\s*\)/);
    expect(src).toMatch(/from\s+['"]\.\/database\/pg-date-parser['"]/);
  });
});
