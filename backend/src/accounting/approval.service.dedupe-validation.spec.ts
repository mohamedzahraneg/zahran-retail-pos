/**
 * approval.service.dedupe-validation.spec.ts
 * PR-FIX-EXPENSE-APPROVAL-RULES-DEDUPE
 *
 * Pins the new duplicate-key validation in
 * `ExpenseApprovalService.createRule` and `.updateRule`.  The
 * natural key of an active expense_approval_rules row is:
 *   (required_role, level, min_amount, COALESCE(max_amount, -1))
 * filtered by `is_active = TRUE`.  Migration 129 enforces it at the
 * DB layer via a partial unique index; this service-layer guard
 * surfaces a clean Arabic error before the SQL round-trip.
 *
 * Coverage (10 service-level cases + 5 source-grep / behavioural):
 *
 *   1. createRule rejects when the natural key matches an existing
 *      active rule.
 *   2. createRule allows the same tuple as an INACTIVE rule.
 *   3. createRule differing on `level` only is allowed.
 *   4. createRule differing on `required_role` only is allowed.
 *   5. createRule differing on `min_amount` only is allowed.
 *   6. createRule differing on `max_amount` only is allowed.
 *   7. updateRule into a duplicate active key is rejected.
 *   8. updateRule notes-only on the same row passes (key untouched).
 *   9. updateRule reactivating an inactive rule into an existing
 *      active key is rejected.
 *  10. The duplicate helper excludes `id = $5` so the row being
 *      updated does not compare against itself.
 *
 * Source-grep guards on `approval.service.ts`:
 *   · The dedupe helper SQL contains both COALESCE(max_amount, -1)
 *     normalizations and the `($5::uuid IS NULL OR id <> $5)` self-
 *     exclusion clause.
 *   · createRule / updateRule throw the Arabic copy verbatim.
 *   · No JE / CT / SM writes anywhere in the touched method bodies.
 *   · No `accounting_only` shortcut.
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ExpenseApprovalService } from './approval.service';

interface QueryCall {
  sql: string;
  params: unknown[];
}

type Route = (sql: string, params: unknown[]) => any[] | undefined;

/**
 * SQL-router fake.  Iterates the registered routes in declaration
 * order; the first regex match returns the configured rows.  Falls
 * through to an empty array for SQL the test isn't asserting on.
 */
function makeRouter(
  routes: Array<{ match: RegExp; rows: any[] | ((p: unknown[]) => any[]) }>,
) {
  const calls: QueryCall[] = [];
  const ds: any = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const route = routes.find((r) => r.match.test(sql));
      if (!route) return [];
      return typeof route.rows === 'function' ? route.rows(params) : route.rows;
    },
    transaction: async (cb: (em: any) => Promise<any>) => cb(ds),
  };
  return { ds, calls };
}

function makeService(
  routes: Array<{ match: RegExp; rows: any[] | ((p: unknown[]) => any[]) }>,
) {
  const { ds, calls } = makeRouter(routes);
  return { svc: new ExpenseApprovalService(ds), ds, calls };
}

const RULE_A = '11111111-1111-1111-1111-111111111111';
const RULE_B = '22222222-2222-2222-2222-222222222222';

const baseDto = {
  name_ar: 'مصروف متوسط (١٠ألف+)',
  required_role: 'manager',
  level: 1,
  min_amount: 10000,
  max_amount: 50000,
};

// ─── createRule ─────────────────────────────────────────────────────

describe('ExpenseApprovalService.createRule — duplicate-key validation', () => {
  it('1. rejects when the natural key matches an existing active rule', async () => {
    const { svc } = makeService([
      // Dedupe SELECT returns a hit row → duplicate found.
      {
        match: /SELECT 1 AS hit\s+FROM expense_approval_rules/,
        rows: [{ hit: 1 }],
      },
    ]);
    let caught: any;
    try {
      await svc.createRule({ ...baseDto });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.message).toBe('توجد قاعدة اعتماد نشطة بنفس الشروط');
  });

  it('2. allows the same tuple as an INACTIVE rule (dedupe SELECT scoped to is_active=TRUE)', async () => {
    const { svc, calls } = makeService([
      // No active duplicate (the inactive rule with the same tuple is
      // filtered out by `is_active = TRUE` in the helper SQL).
      { match: /SELECT 1 AS hit\s+FROM expense_approval_rules/, rows: [] },
      // INSERT path returns the new row.
      {
        match: /INSERT INTO expense_approval_rules/,
        rows: [{ id: RULE_A, ...baseDto, is_active: true }],
      },
    ]);
    const row = await svc.createRule({ ...baseDto });
    expect(row.id).toBe(RULE_A);
    // The dedupe SELECT scopes to active rules.
    const dedupeCall = calls.find((c) =>
      /SELECT 1 AS hit\s+FROM expense_approval_rules/.test(c.sql),
    );
    expect(dedupeCall!.sql).toMatch(/is_active\s*=\s*TRUE/i);
  });

  it('3. differing on `level` only is allowed', async () => {
    const { svc } = makeService([
      { match: /SELECT 1 AS hit\s+FROM expense_approval_rules/, rows: [] },
      {
        match: /INSERT INTO expense_approval_rules/,
        rows: [{ id: RULE_A }],
      },
    ]);
    await expect(
      svc.createRule({ ...baseDto, level: 2 }),
    ).resolves.toEqual({ id: RULE_A });
  });

  it('4. differing on `required_role` only is allowed', async () => {
    const { svc } = makeService([
      { match: /SELECT 1 AS hit\s+FROM expense_approval_rules/, rows: [] },
      {
        match: /INSERT INTO expense_approval_rules/,
        rows: [{ id: RULE_A }],
      },
    ]);
    await expect(
      svc.createRule({ ...baseDto, required_role: 'admin' }),
    ).resolves.toEqual({ id: RULE_A });
  });

  it('5. differing on `min_amount` only is allowed', async () => {
    const { svc } = makeService([
      { match: /SELECT 1 AS hit\s+FROM expense_approval_rules/, rows: [] },
      {
        match: /INSERT INTO expense_approval_rules/,
        rows: [{ id: RULE_A }],
      },
    ]);
    await expect(
      svc.createRule({ ...baseDto, min_amount: 5000 }),
    ).resolves.toEqual({ id: RULE_A });
  });

  it('6. differing on `max_amount` only is allowed (covers null vs number)', async () => {
    const { svc } = makeService([
      { match: /SELECT 1 AS hit\s+FROM expense_approval_rules/, rows: [] },
      {
        match: /INSERT INTO expense_approval_rules/,
        rows: [{ id: RULE_A }],
      },
    ]);
    await expect(
      svc.createRule({ ...baseDto, max_amount: null }),
    ).resolves.toEqual({ id: RULE_A });
  });

  it('createRule passes the EXACT post-DTO tuple (with max_amount null when omitted) to the dedupe helper', async () => {
    const { svc, calls } = makeService([
      { match: /SELECT 1 AS hit\s+FROM expense_approval_rules/, rows: [] },
      {
        match: /INSERT INTO expense_approval_rules/,
        rows: [{ id: RULE_A }],
      },
    ]);
    await svc.createRule({
      name_ar: 'كبير',
      required_role: 'admin',
      level: 1,
      min_amount: 50000,
      // max_amount omitted → helper must receive null
    });
    const dedupeCall = calls.find((c) =>
      /SELECT 1 AS hit\s+FROM expense_approval_rules/.test(c.sql),
    );
    expect(dedupeCall!.params).toEqual([
      'admin',
      1,
      50000,
      null,
      null, // excludeId — null on createRule
    ]);
  });
});

// ─── updateRule ─────────────────────────────────────────────────────

describe('ExpenseApprovalService.updateRule — duplicate-key validation', () => {
  it('7. rejects when changing the rule into an existing active duplicate key', async () => {
    const { svc } = makeService([
      // current row read
      {
        match: /SELECT id, required_role, level, min_amount, max_amount, is_active/,
        rows: [
          {
            id: RULE_A,
            required_role: 'manager',
            level: 1,
            min_amount: 10000,
            max_amount: 50000,
            is_active: true,
          },
        ],
      },
      // dedupe SELECT — hits because we're moving toward an existing
      // active sibling.
      { match: /SELECT 1 AS hit\s+FROM expense_approval_rules/, rows: [{ hit: 1 }] },
    ]);
    let caught: any;
    try {
      await svc.updateRule(RULE_A, { min_amount: 20000 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.message).toBe('توجد قاعدة اعتماد نشطة بنفس الشروط');
  });

  it('8. notes-only update passes — natural key untouched, dedupe helper not called', async () => {
    const { svc, calls } = makeService([
      // Only the UPDATE round-trip is needed; no current-row read,
      // no dedupe helper.
      {
        match: /UPDATE expense_approval_rules SET notes = \$1/,
        rows: [{ id: RULE_A, notes: 'updated note' }],
      },
    ]);
    const row = await svc.updateRule(RULE_A, { notes: 'updated note' });
    expect(row.id).toBe(RULE_A);
    // Dedupe helper must NOT fire.
    expect(
      calls.find((c) => /SELECT 1 AS hit\s+FROM expense_approval_rules/.test(c.sql)),
    ).toBeUndefined();
    // Current-row read is also skipped (no key column touched).
    expect(
      calls.find((c) =>
        /SELECT id, required_role, level, min_amount, max_amount, is_active/.test(c.sql),
      ),
    ).toBeUndefined();
  });

  it('9. reactivating an inactive duplicate into an existing active key is rejected', async () => {
    const { svc } = makeService([
      // current row read — inactive
      {
        match: /SELECT id, required_role, level, min_amount, max_amount, is_active/,
        rows: [
          {
            id: RULE_B,
            required_role: 'manager',
            level: 1,
            min_amount: 10000,
            max_amount: 50000,
            is_active: false,
          },
        ],
      },
      { match: /SELECT 1 AS hit\s+FROM expense_approval_rules/, rows: [{ hit: 1 }] },
    ]);
    let caught: any;
    try {
      await svc.updateRule(RULE_B, { is_active: true });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.message).toBe('توجد قاعدة اعتماد نشطة بنفس الشروط');
  });

  it('10. dedupe helper excludes the row being updated (excludeId = id)', async () => {
    const { svc, calls } = makeService([
      {
        match: /SELECT id, required_role, level, min_amount, max_amount, is_active/,
        rows: [
          {
            id: RULE_A,
            required_role: 'manager',
            level: 1,
            min_amount: 10000,
            max_amount: 50000,
            is_active: true,
          },
        ],
      },
      // dedupe returns no row → not-a-duplicate (because excludeId
      // hides the row's own data from the comparison).
      { match: /SELECT 1 AS hit\s+FROM expense_approval_rules/, rows: [] },
      {
        match: /UPDATE expense_approval_rules SET/,
        rows: [{ id: RULE_A, level: 2 }],
      },
    ]);
    await svc.updateRule(RULE_A, { level: 2 });
    const dedupeCall = calls.find((c) =>
      /SELECT 1 AS hit\s+FROM expense_approval_rules/.test(c.sql),
    );
    // params: [required_role, level, min_amount, max_amount, excludeId]
    expect(dedupeCall!.params[4]).toBe(RULE_A);
  });

  it('updateRule on a non-existent id (current-row read returns []) → 404', async () => {
    const { svc } = makeService([
      {
        match: /SELECT id, required_role, level, min_amount, max_amount, is_active/,
        rows: [],
      },
    ]);
    await expect(
      svc.updateRule('99999999-9999-9999-9999-999999999999', { level: 2 }),
    ).rejects.toThrow(NotFoundException);
  });

  it('deactivating a rule does NOT trigger the dedupe check (deactivation never collides)', async () => {
    const { svc, calls } = makeService([
      {
        match: /SELECT id, required_role, level, min_amount, max_amount, is_active/,
        rows: [
          {
            id: RULE_A,
            required_role: 'manager',
            level: 1,
            min_amount: 10000,
            max_amount: 50000,
            is_active: true,
          },
        ],
      },
      {
        match: /UPDATE expense_approval_rules SET/,
        rows: [{ id: RULE_A, is_active: false }],
      },
    ]);
    await svc.updateRule(RULE_A, { is_active: false });
    // No dedupe SELECT — `after.is_active === false` short-circuits.
    expect(
      calls.find((c) => /SELECT 1 AS hit\s+FROM expense_approval_rules/.test(c.sql)),
    ).toBeUndefined();
  });
});

// ─── Source-grep guards ─────────────────────────────────────────────

describe('ExpenseApprovalService — source contract for dedupe helper', () => {
  const SRC = readFileSync(
    resolve(__dirname, './approval.service.ts'),
    'utf-8',
  );
  // Strip JS comments so the negative-grep doesn't false-positive on
  // prose mentioning forbidden keywords inside the docstring.
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /(^|[^:])\/\/[^\n]*/g,
    '$1',
  );

  it('helper SQL contains COALESCE(max_amount, -1) on BOTH sides of the comparison', () => {
    expect(SRC).toMatch(
      /COALESCE\(max_amount,\s*'-1'::numeric\)\s*=\s*COALESCE\(\$4::numeric,\s*'-1'::numeric\)/,
    );
  });

  it('helper SQL contains the self-exclusion clause `($5::uuid IS NULL OR id <> $5)`', () => {
    expect(SRC).toMatch(
      /\(\s*\$5::uuid IS NULL OR id\s*<>\s*\$5\s*\)/,
    );
  });

  it('helper SQL is scoped to is_active = TRUE', () => {
    // Pull the helper body window.
    const idx = CODE.indexOf('async findDuplicateActiveRule');
    expect(idx).toBeGreaterThan(-1);
    const window = CODE.substring(idx, idx + 2000);
    expect(window).toMatch(/is_active\s*=\s*TRUE/i);
  });

  it('createRule and updateRule both throw the spec\'d Arabic copy on duplicate key', () => {
    expect(CODE).toMatch(
      /BadRequestException\(\s*['"]توجد قاعدة اعتماد نشطة بنفس الشروط['"]\s*\)/,
    );
  });

  it('no JE / CT / SM / accounting_only writes inside createRule or updateRule bodies', () => {
    function methodWindow(name: string): string {
      const idx = CODE.indexOf(`async ${name}(`);
      expect(idx).toBeGreaterThan(-1);
      return CODE.substring(idx, idx + 4000);
    }
    for (const name of ['createRule', 'updateRule']) {
      const body = methodWindow(name);
      expect(body).not.toMatch(/INSERT\s+INTO\s+journal_entries/i);
      expect(body).not.toMatch(/INSERT\s+INTO\s+journal_lines/i);
      expect(body).not.toMatch(/INSERT\s+INTO\s+cashbox_transactions/i);
      expect(body).not.toMatch(/INSERT\s+INTO\s+stock_movements/i);
      expect(body).not.toMatch(/UPDATE\s+stock_movements/i);
      expect(body).not.toMatch(/\baccounting_only\b/);
      expect(body).not.toMatch(/this\.engine\./);
      expect(body).not.toMatch(/recordTransaction/);
    }
  });
});
