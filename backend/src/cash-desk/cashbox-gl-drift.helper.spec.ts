/**
 * cashbox-gl-drift.helper.spec.ts — PR-FIN-CASHBOX-DRIFT-CANCEL-AWARE-FIX
 * ─────────────────────────────────────────────────────────────────────
 * Pins the helper's SQL contract for cancellation-cluster identification
 * + the integration shape (filter / offset / sequential enrichment) on
 * the cash-desk service consumers.
 *
 * No Postgres needed — the helper is exercised against a stubbed
 * DataSource and the consumer behavior is verified via source-grep.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { CashboxGlDriftHelper } from './cashbox-gl-drift.helper';

type QueryCall = { sql: string; params: any[] };

function makeFakeDs(rowsByCall: any[][] = []) {
  const calls: QueryCall[] = [];
  let idx = 0;
  const ds: any = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return rowsByCall[idx++] ?? [];
    },
  };
  return { ds, calls };
}

async function buildHelper(ds: any) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      CashboxGlDriftHelper,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  return moduleRef.get(CashboxGlDriftHelper);
}

describe('CashboxGlDriftHelper.clusterRefSet — SQL shape', () => {
  it('queries cancelled returns scoped to the given cashbox + bridges to original return JEs', async () => {
    const { ds, calls } = makeFakeDs([[]]);
    const helper = await buildHelper(ds);
    await helper.clusterRefSet('cb-1');

    expect(calls).toHaveLength(1);
    const sql = calls[0].sql;
    expect(sql).toMatch(/cancelled_returns AS/);
    expect(sql).toMatch(
      /FROM returns[\s\S]+status\s*=\s*'cancelled'[\s\S]+cashbox_id::text\s*=\s*\$1/,
    );
    // Bridge: cancelled return → original JE id (reference_type='return',
    // reference_id=<return_id>). The original JE may be voided post-
    // cancellation; we don't filter on is_void because it's the
    // identity that matters, not the row's active state.
    expect(sql).toMatch(
      /cancelled_jes AS[\s\S]+je\.reference_type\s*=\s*'return'[\s\S]+je\.reference_id\s*=\s*cr\.return_id::uuid/,
    );
    // The cluster expands to three (reference_type, reference_id) keys:
    //   ('return',  return_id)        — original CT row
    //   ('other',   orig JE id)       — reversal CT row (engine maps
    //                                   reference_type 'reversal' → 'other')
    //   ('reversal',orig JE id)       — reversal JE row
    expect(sql).toMatch(/'return'::text\s+AS rt[\s\S]+return_id\s+AS rid/);
    expect(sql).toMatch(/'other'::text[\s\S]+je_id/);
    expect(sql).toMatch(/'reversal'::text[\s\S]+je_id/);
    expect(calls[0].params).toEqual(['cb-1']);
  });

  it('returns a set keyed by `${reference_type}:${reference_id}` for O(1) row filtering', async () => {
    const { ds } = makeFakeDs([
      [
        { rt: 'return', rid: 'ret-3-id' },
        { rt: 'other', rid: 'orig-je-id' },
        { rt: 'reversal', rid: 'orig-je-id' },
      ],
    ]);
    const helper = await buildHelper(ds);
    const set = await helper.clusterRefSet('cb-1');
    expect(set.size).toBe(3);
    expect(set.has('return:ret-3-id')).toBe(true);
    expect(set.has('other:orig-je-id')).toBe(true);
    expect(set.has('reversal:orig-je-id')).toBe(true);
    // Negative — non-cluster keys do not match.
    expect(set.has('invoice:some-other-id')).toBe(false);
  });

  it('returns an empty set when the cashbox has no cancelled returns', async () => {
    const { ds } = makeFakeDs([[]]);
    const helper = await buildHelper(ds);
    const set = await helper.clusterRefSet('cb-no-cancellations');
    expect(set.size).toBe(0);
  });
});

describe('CashboxGlDriftHelper.clusterDriftOffsetByCashbox — SQL shape', () => {
  it('joins per-ref view to cancellation cluster keys + sums drift_amount per cashbox', async () => {
    const { ds, calls } = makeFakeDs([[]]);
    const helper = await buildHelper(ds);
    await helper.clusterDriftOffsetByCashbox();

    expect(calls).toHaveLength(1);
    const sql = calls[0].sql;
    expect(sql).toMatch(/cancelled_returns AS[\s\S]+cashbox_id IS NOT NULL/);
    expect(sql).toMatch(/cluster_refs AS/);
    expect(sql).toMatch(
      /FROM v_cashbox_drift_per_ref[\s\S]+JOIN cluster_refs/,
    );
    expect(sql).toMatch(/SUM\(pr\.drift_amount\)/);
    expect(sql).toMatch(/GROUP BY pr\.cashbox_id/);
  });

  it('returns a Map<cashbox_id, number> with the cluster drift offset', async () => {
    const { ds } = makeFakeDs([
      [
        { cashbox_id: 'cb-with-cancel', offset: '-350.00' },
        { cashbox_id: 'cb-other-cancel', offset: '-150.00' },
      ],
    ]);
    const helper = await buildHelper(ds);
    const map = await helper.clusterDriftOffsetByCashbox();
    expect(map.size).toBe(2);
    expect(map.get('cb-with-cancel')).toBe(-350);
    expect(map.get('cb-other-cancel')).toBe(-150);
    // Cashboxes without cancelled returns are absent — not zero.
    expect(map.has('cb-no-cancel')).toBe(false);
  });

  it('returns empty Map when no cancelled returns exist anywhere', async () => {
    const { ds } = makeFakeDs([[]]);
    const helper = await buildHelper(ds);
    const map = await helper.clusterDriftOffsetByCashbox();
    expect(map.size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Source-grep on cash-desk.service.ts to pin the consumer behavior.
//  These are defense-in-depth assertions that the EMAXCONNSESSION
//  pattern (unbounded Promise.all over enrichDriftRow) cannot return.
// ─────────────────────────────────────────────────────────────────────

describe('CashDeskService — drift consumer wiring', () => {
  const SRC = readFileSync(
    resolve(__dirname, './cash-desk.service.ts'),
    'utf8',
  );

  function getDriftDetailBody(): string {
    const start = SRC.indexOf('async getDriftDetail(');
    expect(start).toBeGreaterThan(-1);
    // End at the next async method boundary so the slice is exactly
    // this method body (a 6000-char window happened to overlap with
    // `enrichDriftRow` earlier and matched its internal Promise.all).
    const next = SRC.indexOf('  async ', start + 1);
    return SRC.substring(start, next > -1 ? next : start + 8500);
  }

  it('getDriftDetail uses sequential for-of enrichment (NOT Promise.all over enrichDriftRow)', () => {
    const body = getDriftDetailBody();
    expect(body).toMatch(/for\s+\(const\s+r\s+of\s+filteredRows\)/);
    expect(body).toMatch(/await\s+this\.enrichDriftRow/);
    // The unbounded fan-out pattern that exhausted the pg pool must
    // be gone. We match the ACTUAL old code shape
    // (`Promise.all(rows.map(...enrichDriftRow...))`) — not just the
    // function name in any comment — because a documenting comment
    // about the historical bug is still valid.
    expect(body).not.toMatch(/Promise\.all\(\s*[a-zA-Z_]+\.map\(/);
  });

  it('getDriftDetail filters per-ref rows through the helper cluster set BEFORE enrichment', () => {
    const body = getDriftDetailBody();
    expect(body).toMatch(/this\.driftHelper[\s\S]+clusterRefSet\(cashboxId\)/);
    expect(body).toMatch(
      /clusterKeys\.has\(`\$\{r\.reference_type\}:\$\{r\.reference_id\}`\)/,
    );
  });

  it('getDriftDetail recomputes totals AND header gl_drift after dropping cluster rows', () => {
    const body = getDriftDetailBody();
    expect(body).toMatch(/total_drift:[\s\S]+clusterOffset/);
    expect(body).toMatch(/gl_drift:[\s\S]+clusterOffset/);
  });

  it('getGlDrift subtracts the per-cashbox cluster offset before returning rows', () => {
    const start = SRC.indexOf('async getGlDrift()');
    const body = SRC.substring(start, start + 2000);
    expect(body).toMatch(/clusterDriftOffsetByCashbox/);
    expect(body).toMatch(/Number\(r\.drift_amount\)\s*-\s*offset/);
    expect(body).toMatch(/_drift_raw/);
    expect(body).toMatch(/_cancelled_cluster_offset/);
  });

  it('helper is wired via DI as @Optional, so existing test fixtures without the helper still construct cleanly', () => {
    expect(SRC).toMatch(
      /@Optional\(\)\s*private\s+readonly\s+driftHelper\?:\s*CashboxGlDriftHelper/,
    );
  });

  it('no DELETE / no UPDATE on production tables in either drift method (read-only contract preserved)', () => {
    const win =
      SRC.substring(SRC.indexOf('async getGlDrift()'), SRC.length).slice(
        0,
        12000,
      );
    expect(win).not.toMatch(/^\s*DELETE\s/im);
    expect(win).not.toMatch(/^\s*UPDATE\s/im);
    // No engine-context manipulation either — pure SELECT path.
    expect(win).not.toMatch(/fn_record_cashbox_txn/);
    expect(win).not.toMatch(/SET LOCAL/);
  });
});
