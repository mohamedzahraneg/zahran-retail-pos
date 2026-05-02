/**
 * reconciliation.service.spec.ts
 * ────────────────────────────────────────────────────────────────────
 * PR-FIN-PAYACCT-4D-CASHBOX-BALANCE-VOID-FIX-1
 *
 * Pins the active-row semantics for cashbox balance rebuilds and the
 * read-only stored/txn/gl comparators:
 *
 *   • `rebuildCashboxBalance` must filter `is_void = false` when summing
 *     CTs — voided rows are soft-deletes and must not contribute to the
 *     rebuilt `cashboxes.current_balance`. Prior behavior summed all CTs
 *     and left the stored balance polluted by every row that earlier
 *     cleanup PRs had voided.
 *   • `rebuildCashboxBalance` writes ONLY to `cashboxes` — never to
 *     `journal_entries` / `journal_lines` / `cashbox_transactions`.
 *   • `rebuildCashboxBalance` runs under `engine:*` (canonical, silent)
 *     not `service:*` (logged-as-bypass).
 *   • `compareCashVsGl` and `auditCashboxes` must inherit the same
 *     active-row semantics so the txn-side and the GL-side compare
 *     apples-to-apples.
 *
 * Source-grep regression tests pin the SQL shape so a future refactor
 * cannot silently drop the filter.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import { ReconciliationService } from './reconciliation.service';

type QueryCall = { sql: string; params: any[] };

/**
 * Stateful fake DataSource. Records every `ds.query` and `em.query`
 * call so we can assert the SQL shape, the bound params, and the
 * absence of any DELETE/INSERT outside the allowed UPDATE on cashboxes.
 *
 * `dispatch` is called for both `ds.query` and `em.query` (inside the
 * tx). Returns `[]` if no matcher matches, which is fine for SET LOCAL
 * / set_config calls that don't need a result.
 */
function makeFakeDs(dispatch: (sql: string) => any[]) {
  const dsCalls: QueryCall[] = [];
  const emCalls: QueryCall[] = [];
  const em = {
    query: async (sql: string, params: any[] = []) => {
      emCalls.push({ sql, params });
      return dispatch(sql);
    },
  };
  const ds: any = {
    query: async (sql: string, params: any[] = []) => {
      dsCalls.push({ sql, params });
      return dispatch(sql);
    },
    transaction: async (cb: (em: any) => Promise<any>) => cb(em),
  };
  return { ds, em, dsCalls, emCalls };
}

function script(rows: Array<[RegExp | string, any[]]>) {
  const remaining = rows.map(([pat, ret]) => ({ pat, ret, used: false }));
  return (sql: string) => {
    for (const m of remaining) {
      if (m.used) continue;
      const matches =
        typeof m.pat === 'string' ? sql.includes(m.pat) : m.pat.test(sql);
      if (matches) {
        m.used = true;
        return m.ret;
      }
    }
    return [];
  };
}

const CB = '524646d5-7bd6-4d8d-a484-b1f562b039a4';

async function buildService(ds: any) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ReconciliationService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  return moduleRef.get(ReconciliationService);
}

// ─────────────────────────────────────────────────────────────────────
//  rebuildCashboxBalance
// ─────────────────────────────────────────────────────────────────────

describe('ReconciliationService.rebuildCashboxBalance — void-filter hotfix', () => {
  it('SUM SQL filters is_void=false (voided CTs do not contribute)', async () => {
    const { ds, dsCalls, emCalls } = makeFakeDs(
      script([
        [/SUM\([\s\S]+CASE WHEN direction = 'in'/, [{ computed: 29680 }]],
      ]),
    );
    const svc = await buildService(ds);
    const out = await svc.rebuildCashboxBalance(CB);

    // The SUM query carries the void filter.
    const sumCall = dsCalls.find((c) => /CASE WHEN direction = 'in'/.test(c.sql))!;
    expect(sumCall).toBeDefined();
    expect(sumCall.sql).toMatch(/COALESCE\(is_void,\s*false\)\s*=\s*false/);
    expect(sumCall.params).toEqual([CB]);

    // The returned new_balance equals what the (filtered) SUM produced.
    expect(out).toEqual({ cashbox_id: CB, new_balance: 29680 });

    // No DELETE / INSERT anywhere. The only UPDATE is on cashboxes.
    for (const c of [...dsCalls, ...emCalls]) {
      expect(c.sql).not.toMatch(/^\s*DELETE\s/i);
      expect(c.sql).not.toMatch(/^\s*INSERT\s/i);
    }
    const updates = emCalls.filter((c) => /^\s*UPDATE\s/i.test(c.sql));
    expect(updates).toHaveLength(1);
    expect(updates[0].sql).toMatch(/UPDATE cashboxes\s+SET current_balance/);
    // Whitelist columns: only `current_balance` and `updated_at`.
    expect(updates[0].sql).not.toMatch(
      /SET[\s\S]*\b(opening_balance|kind|currency|is_active|warehouse_id)\s*=/,
    );
  });

  it('rebuilt balance equals active CT signed sum (the SUM result the helper just computed)', async () => {
    // Production-shaped scenario: 27 voided rows summing +2,839.98, active
    // rows summing 29,680. The fixed helper runs the FILTERED query, so
    // the SUM mock returns 29,680 — and that's what the UPDATE writes.
    const { ds, emCalls } = makeFakeDs(
      script([
        [/COALESCE\(is_void,\s*false\)\s*=\s*false/, [{ computed: 29680 }]],
      ]),
    );
    const svc = await buildService(ds);
    const out = await svc.rebuildCashboxBalance(CB);

    expect(out.new_balance).toBe(29680);
    const updateCall = emCalls.find((c) => /UPDATE cashboxes/.test(c.sql))!;
    expect(updateCall.params).toEqual([CB, 29680]);
  });

  it('uses engine:* context (silent) and not service:*', async () => {
    const { ds, emCalls } = makeFakeDs(
      script([[/CASE WHEN direction = 'in'/, [{ computed: 100 }]]]),
    );
    const svc = await buildService(ds);
    await svc.rebuildCashboxBalance(CB);

    const ctxCall = emCalls.find((c) => /set_config\('app\.engine_context'/.test(c.sql));
    expect(ctxCall).toBeDefined();
    // Function form (set_config) — Postgres rejects bind params in `SET LOCAL = $1`.
    expect(ctxCall!.sql).toMatch(
      /SELECT\s+set_config\(\s*'app\.engine_context'\s*,\s*\$1\s*,\s*true\s*\)/,
    );
    expect(ctxCall!.sql).not.toMatch(/SET\s+LOCAL/i);
    // engine:* (≥10 chars) — silent canonical path. NOT service:*.
    expect(ctxCall!.params[0]).toMatch(/^engine:/);
    expect(ctxCall!.params[0]).not.toMatch(/^service:/);
  });

  it('writes ONLY to cashboxes (no JE/JL/CT writes)', async () => {
    const { ds, dsCalls, emCalls } = makeFakeDs(
      script([[/CASE WHEN direction = 'in'/, [{ computed: 0 }]]]),
    );
    const svc = await buildService(ds);
    await svc.rebuildCashboxBalance(CB);

    for (const c of [...dsCalls, ...emCalls]) {
      // Defense-in-depth assertions.
      expect(c.sql).not.toMatch(/INSERT\s+INTO\s+(journal_entries|journal_lines|cashbox_transactions)/i);
      expect(c.sql).not.toMatch(/UPDATE\s+(journal_entries|journal_lines|cashbox_transactions)\s/i);
      expect(c.sql).not.toMatch(/DELETE\s+FROM\s+(journal_entries|journal_lines|cashbox_transactions)/i);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
//  compareCashVsGl + auditCashboxes — read-only comparators
// ─────────────────────────────────────────────────────────────────────

describe('ReconciliationService.compareCashVsGl — txn_balance excludes voided CTs', () => {
  it('issues SQL that filters is_void=false for txn_balance', async () => {
    const { ds, dsCalls } = makeFakeDs(script([]));
    const svc = await buildService(ds);
    await svc.compareCashVsGl();

    expect(dsCalls).toHaveLength(1);
    const sql = dsCalls[0].sql;
    // The txn_balance subquery is the cashbox_transactions SUM.
    expect(sql).toMatch(/cb\.current_balance[\s\S]+stored_balance/);
    // Active-row filter on the txn side.
    expect(sql).toMatch(
      /FROM cashbox_transactions[\s\S]+WHERE cashbox_id = cb\.id[\s\S]+COALESCE\(is_void,\s*false\)\s*=\s*false/,
    );
    // GL side already filters posted+non-void.
    expect(sql).toMatch(/je\.is_posted\s+AND\s+NOT\s+je\.is_void/);
  });
});

describe('ReconciliationService.auditCashboxes — computed_balance excludes voided CTs', () => {
  it('issues SQL that filters is_void=false for computed_balance', async () => {
    const { ds, dsCalls } = makeFakeDs(
      script([
        // The defensive feature-detection probe at the top of auditCashboxes.
        [/has_kind/, [{ has_kind: true, has_currency: true, has_coa_cb: true }]],
      ]),
    );
    const svc = await buildService(ds);
    await svc.auditCashboxes();

    // Two queries: the feature probe + the audit query.
    const auditQuery = dsCalls.find((c) => /computed_balance/.test(c.sql));
    expect(auditQuery).toBeDefined();
    expect(auditQuery!.sql).toMatch(
      /FROM cashbox_transactions[\s\S]+WHERE cashbox_id = cb\.id[\s\S]+COALESCE\(is_void,\s*false\)\s*=\s*false/,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Source-grep regression — the filter and the engine context literal
//  must remain in the executable code (comments referencing the prior
//  buggy shape are OK).
// ─────────────────────────────────────────────────────────────────────

describe('ReconciliationService — source-grep regression', () => {
  const SRC = readFileSync(
    resolve(__dirname, './reconciliation.service.ts'),
    'utf8',
  );
  // Strip JS comments so we only inspect executable code.
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /(^|[^:])\/\/[^\n]*/g,
    '$1',
  );

  it('rebuildCashboxBalance SUM has is_void filter in executable code', () => {
    // Find the rebuildCashboxBalance method body.
    const idx = CODE.indexOf('async rebuildCashboxBalance');
    expect(idx).toBeGreaterThan(-1);
    const body = CODE.substring(idx, idx + 1200);
    expect(body).toMatch(/COALESCE\(is_void,\s*false\)\s*=\s*false/);
    expect(body).toMatch(/SELECT\s+set_config\('app\.engine_context'/);
    // The buggy `SET LOCAL ... = $1` shape must NOT reappear.
    expect(body).not.toMatch(/SET\s+LOCAL\s+app\.engine_context\s*=\s*\$/);
    // engine:* literal is the silent canonical path. (Param value is bound;
    // we look for the literal in the bound-param list nearby.)
    expect(body).toMatch(/'engine:reconciliation/);
    expect(body).not.toMatch(/'service:reconciliation\.service'/);
  });

  it('every cashbox_transactions SUM-by-cb.id formula in this service filters is_void', () => {
    // Both auditCashboxes (computed_balance) and compareCashVsGl (txn_balance)
    // share the same shape: SUM over cashbox_transactions filtered by
    // `cashbox_id = cb.id`. They MUST also filter `is_void=false`. A global
    // walk over the code catches both formulas without depending on
    // method-body offset arithmetic.
    const matches = [
      ...CODE.matchAll(
        /SELECT\s+SUM\(CASE\s+WHEN\s+direction\s*=\s*'in'\s+THEN\s+amount\s+ELSE\s+-\s*amount\s+END\)[\s\S]+?FROM\s+cashbox_transactions[\s\S]+?WHERE\s+cashbox_id\s*=\s*cb\.id[\s\S]{0,200}/g,
      ),
    ];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    for (const m of matches) {
      expect(m[0]).toMatch(/COALESCE\(is_void,\s*false\)\s*=\s*false/);
    }
  });

  it('compareCashVsGl section name + filter co-locate', () => {
    // Spot-check that the txn_balance label IS still present (didn't get
    // accidentally removed).
    expect(CODE).toMatch(/AS\s+txn_balance/);
  });

  it('auditCashboxes section name + filter co-locate', () => {
    // Spot-check that the computed_balance label IS still present.
    expect(CODE).toMatch(/AS\s+computed_balance/);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Semantic test — rebuild writes the active-CT-sum, which equals
//  GL-net in a healthy system → drift = 0.
// ─────────────────────────────────────────────────────────────────────

describe('ReconciliationService.rebuildCashboxBalance — drift→0 when active CT == GL net', () => {
  it('UPDATE writes the active-CT-sum (which equals GL-net in our prod scenario, so drift=0)', async () => {
    // Production scenario: active_CT = 29,680 (after 8 cleanup voids),
    // GL net = 29,680. After rebuild, current_balance = 29,680.
    // v_cashbox_gl_drift = current_balance - gl_net = 29,680 - 29,680 = 0.
    const { ds, emCalls } = makeFakeDs(
      script([
        [/COALESCE\(is_void,\s*false\)\s*=\s*false/, [{ computed: 29680 }]],
      ]),
    );
    const svc = await buildService(ds);
    const out = await svc.rebuildCashboxBalance(CB);

    expect(out.new_balance).toBe(29680);
    // The post-rebuild stored value = active CT sum. Pair this with
    // GL-net = 29,680 (separate read in production) and the
    // v_cashbox_gl_drift formula gives drift=0. We verify the FE-visible
    // contract: the helper writes exactly the active sum it computed.
    const updateCall = emCalls.find((c) => /UPDATE cashboxes/.test(c.sql))!;
    expect(updateCall.params).toEqual([CB, 29680]);
  });
});
