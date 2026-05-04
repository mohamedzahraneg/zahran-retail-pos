/**
 * gl-codes-forward-prevention.spec.ts — PR-AUDIT-LIQUID-CODES-CONST
 *
 * Walks every executable .ts file under backend/src and refuses any
 * NEW occurrence of the four liquid GL code literals (`'1111'`,
 * `'1113'`, `'1114'`, `'1115'`) inside TS code (i.e. outside SQL
 * strings, comments, and the canonical constants file itself).
 *
 * Goal: when a future contributor introduces a new BE module that
 * needs a liquid code, the spec fails their CI immediately and
 * forces them to import from gl-codes.constants.ts instead of
 * sprinkling a new literal.
 *
 * Allowlist (sites the audit deliberately deferred):
 *   · cash-desk.service.ts          — SQL CASE on cb.kind, deferred
 *   · settings/settings.service.ts  — SQL CASE on cb.kind, deferred
 *   · payments/payments.service.ts  — SQL CASE in unattached_balances CTE
 *   · chart-of-accounts/cash-recon-execute/cash-recon-execute.ts
 *                                  — one-off historical maintenance
 *   · chart-of-accounts/gl-codes.constants.ts
 *                                  — canonical source itself
 *   · *.spec.ts / *.test.ts         — test fixtures / mock data are
 *                                    intentionally allowed to use
 *                                    literals for clarity
 *   · payments/dto/payment-account.dto.ts
 *                                  — OpenAPI `example: '1114'` in
 *                                    Swagger decorator (doc-only)
 *   · employees/employees.controller.ts
 *                                  — '1114' in inline comment
 *   · chart-of-accounts/posting.service.ts
 *                                  — '1114' in inline comment about
 *                                    historic behavior
 */

import { readdirSync, readFileSync, statSync } from 'fs';
import { resolve, relative } from 'path';

const REPO_BACKEND_SRC = resolve(__dirname, '..');

const ALLOWED_FILES: ReadonlySet<string> = new Set([
  'chart-of-accounts/gl-codes.constants.ts',
  'cash-desk/cash-desk.service.ts',
  'settings/settings.service.ts',
  'payments/payments.service.ts',
  'payments/dto/payment-account.dto.ts',
  'employees/employees.controller.ts',
  'chart-of-accounts/posting.service.ts',
  'chart-of-accounts/cash-recon-execute/cash-recon-execute.ts',
]);

function* walkTs(dir: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walkTs(full);
    } else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts') && !entry.endsWith('.test.ts')) {
      yield full;
    }
  }
}

/**
 * Strip block comments + line comments + every kind of string literal
 * (single, double, template) so prose and SQL embeds don't trigger
 * false positives. What's left is the executable TS surface where a
 * liquid-code literal really would be a regression.
 */
function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/(\s)\/\/.*$/gm, '$1')
    .replace(/`[\s\S]*?`/g, '``')
    .replace(/'[^'\n]*'/g, "''")
    .replace(/"[^"\n]*"/g, '""');
}

describe('PR-AUDIT-LIQUID-CODES-CONST — forward-prevention', () => {
  it('zero NEW liquid-code literals (1111/1113/1114/1115) in executable TS code outside the allowlist', () => {
    const offenders: Array<{ file: string; line: number; text: string }> = [];

    for (const full of walkTs(REPO_BACKEND_SRC)) {
      const rel = relative(REPO_BACKEND_SRC, full).replace(/\\/g, '/');
      if (ALLOWED_FILES.has(rel)) continue;

      const src = readFileSync(full, 'utf8');
      const code = stripCommentsAndStrings(src);
      const lines = code.split('\n');
      for (let i = 0; i < lines.length; i++) {
        // After stripping strings + comments, a literal like '1114'
        // can only survive if it was OUTSIDE any string — which means
        // it's a number-like literal in code (highly unusual). The
        // pattern below catches both bare 4-digit-codes AND the
        // common shape "WHEN '1114'" / "code: '1114'" if string-strip
        // somehow misses them due to escaped quotes.
        const m = lines[i].match(/(?:^|[^\d])(1111|1113|1114|1115)(?!\d)/);
        if (m) {
          offenders.push({ file: rel, line: i + 1, text: lines[i].trim() });
        }
      }
    }

    if (offenders.length > 0) {
      const detail = offenders.map((o) => `  · ${o.file}:${o.line}  ${o.text}`).join('\n');
      throw new Error(
        `Found ${offenders.length} NEW liquid-code literal(s) in executable TS ` +
          `code outside the allowlist. Import from ` +
          `'../chart-of-accounts/gl-codes.constants' instead (GL_CASH / ` +
          `GL_BANK / GL_WALLET / GL_CHECKS / LIQUID_GL_CODES / ` +
          `LIQUID_CODES_SQL_LIST / CASHBOX_KIND_TO_GL_CODE):\n${detail}`,
      );
    }
    expect(offenders).toEqual([]);
  });
});
