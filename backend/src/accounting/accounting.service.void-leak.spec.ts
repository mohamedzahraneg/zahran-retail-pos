/**
 * accounting.service.void-leak.spec.ts — PR-AUDIT-VOID-LEAK
 * ────────────────────────────────────────────────────────────────────
 *
 * Pins the `is_void = FALSE` filter on every `cashbox_transactions`
 * aggregation in `AccountingService` reports. Before this PR, both
 * `cashflow()` (per-category buckets) and `trialBalance()` (per-cashbox
 * period_in/out + opening_in/out) summed raw CT amounts without the
 * void filter — voided cancellations / reversals leaked into every
 * total. The same bug class was diagnosed earlier on the analytics
 * "السيولة" tile (see analytics.service.spec.ts comment header for
 * the +2,839 EGP phantom liquidity incident).
 *
 * This spec pins the SQL shape so the regression cannot reappear:
 *
 *   1. `cashflow()` byCat SQL contains `t.is_void = FALSE` in WHERE.
 *   2. `trialBalance()` joins `cashbox_transactions` with the void
 *      filter in the LEFT JOIN's ON clause (NOT in WHERE) so cashboxes
 *      with zero active CTs still appear in the result with 0/0/0/0.
 *   3. Both report SQLs are pure SELECT (no DML).
 *   4. The JE-based trial balance formula in other reports is not
 *      touched by this PR — these specs cover only the CT-based
 *      `trialBalance(dto)` per-cashbox cash report.
 *
 * The DataSource is stubbed so we can assert SQL strings without a
 * real Postgres. The trigger / constraint behavior of the DB layer
 * is covered separately by financial-engine.guards.spec.ts.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AccountingService } from './accounting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

type QueryCall = { sql: string; params: any[] };

async function makeService() {
  const dsCalls: QueryCall[] = [];
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      dsCalls.push({ sql, params });
      // The 2 SUT methods only need empty-result shapes back.
      return [];
    }),
    transaction: jest.fn(async (cb: any) => cb(ds)),
  };
  const engine: any = {
    recordExpense: jest.fn(),
    recordTransaction: jest.fn(),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      AccountingService,
      { provide: DataSource, useValue: ds },
      { provide: FinancialEngineService, useValue: engine },
    ],
  }).compile();
  const service = moduleRef.get(AccountingService);
  return { service, dsCalls };
}

describe('AccountingService.cashflow — PR-AUDIT-VOID-LEAK', () => {
  it('byCat SQL filters voided CTs (t.is_void = FALSE)', async () => {
    const { service, dsCalls } = await makeService();
    await service.cashflow({ from: '2026-04-01', to: '2026-05-03' } as any);
    const sqls = dsCalls.map((c) => c.sql);
    const byCat = sqls.find(
      (s) => /FROM\s+cashbox_transactions\s+t/.test(s) && /GROUP BY\s+t\.category, t\.direction/.test(s),
    )!;
    expect(byCat).toBeDefined();
    expect(byCat).toMatch(/t\.is_void\s*=\s*FALSE/);
  });

  it('byCat SQL is pure SELECT — no INSERT/UPDATE/DELETE/MERGE', async () => {
    const { service, dsCalls } = await makeService();
    await service.cashflow({ from: '2026-04-01', to: '2026-05-03' } as any);
    const byCat = dsCalls.find(
      (c) => /FROM\s+cashbox_transactions\s+t/.test(c.sql) && /GROUP BY/.test(c.sql),
    )!;
    expect(byCat.sql).toMatch(/^\s*SELECT/i);
    expect(byCat.sql).not.toMatch(/\bINSERT\b/i);
    expect(byCat.sql).not.toMatch(/\bUPDATE\b/i);
    expect(byCat.sql).not.toMatch(/\bDELETE\b/i);
    expect(byCat.sql).not.toMatch(/\bMERGE\b/i);
  });

  it('byCat SQL date filter remains in place — the void filter is ADDITIVE, not a replacement', async () => {
    const { service, dsCalls } = await makeService();
    await service.cashflow({ from: '2026-04-01', to: '2026-05-03' } as any);
    const byCat = dsCalls.find(
      (c) => /FROM\s+cashbox_transactions\s+t/.test(c.sql) && /GROUP BY/.test(c.sql),
    )!;
    expect(byCat.sql).toMatch(/t\.created_at::date BETWEEN/);
    expect(byCat.params).toEqual(expect.arrayContaining(['2026-04-01', '2026-05-03']));
  });

  it('warehouse_id filter still composes with the void filter', async () => {
    const { service, dsCalls } = await makeService();
    await service.cashflow({
      from: '2026-04-01', to: '2026-05-03',
      warehouse_id: '11111111-2222-3333-4444-555555555555',
    } as any);
    const byCat = dsCalls.find(
      (c) => /FROM\s+cashbox_transactions\s+t/.test(c.sql) && /GROUP BY/.test(c.sql),
    )!;
    expect(byCat.sql).toMatch(/t\.is_void\s*=\s*FALSE/);
    expect(byCat.sql).toMatch(/cb\.warehouse_id\s*=\s*\$3/);
    expect(byCat.params).toEqual([
      '2026-04-01',
      '2026-05-03',
      '11111111-2222-3333-4444-555555555555',
    ]);
  });
});

describe('AccountingService.trialBalance — PR-AUDIT-VOID-LEAK', () => {
  it('LEFT JOIN cashbox_transactions filters voided CTs in the ON clause (not WHERE)', async () => {
    const { service, dsCalls } = await makeService();
    await service.trialBalance({ from: '2026-04-01', to: '2026-05-03' } as any);
    const tb = dsCalls.find((c) => /period_in/.test(c.sql) && /opening_out/.test(c.sql))!;
    expect(tb).toBeDefined();
    // Void filter MUST be on the join's ON clause so cashboxes with zero
    // active CTs still appear (0/0/0/0). If it migrates to WHERE, the
    // LEFT JOIN behaves like INNER and silently drops them.
    expect(tb.sql).toMatch(
      /LEFT JOIN cashbox_transactions t\s+ON\s+t\.cashbox_id\s*=\s*cb\.id\s+AND\s+t\.is_void\s*=\s*FALSE/,
    );
  });

  it('cashboxes with zero active CTs still appear (LEFT JOIN preserved)', async () => {
    const { service, dsCalls } = await makeService();
    await service.trialBalance({ from: '2026-04-01', to: '2026-05-03' } as any);
    const tb = dsCalls.find((c) => /period_in/.test(c.sql) && /opening_out/.test(c.sql))!;
    // Defensive: refuse the broken pattern that would drop zero-active cashboxes.
    expect(tb.sql).not.toMatch(/INNER JOIN cashbox_transactions/);
    expect(tb.sql).not.toMatch(/JOIN cashbox_transactions t\s+ON\s+t\.cashbox_id\s*=\s*cb\.id\s+WHERE/);
    // is_void must NOT appear in the outer WHERE (where only cb.is_active lives).
    expect(tb.sql).toMatch(/WHERE\s+cb\.is_active\s*=\s*TRUE/);
    expect(tb.sql).not.toMatch(/WHERE[\s\S]*t\.is_void/);
  });

  it('the four CT aggregates (period_in/out, opening_in/out) all execute over the void-filtered join', async () => {
    const { service, dsCalls } = await makeService();
    await service.trialBalance({ from: '2026-04-01', to: '2026-05-03' } as any);
    const tb = dsCalls.find((c) => /period_in/.test(c.sql) && /opening_out/.test(c.sql))!;
    expect(tb.sql).toMatch(/AS period_in/);
    expect(tb.sql).toMatch(/AS period_out/);
    expect(tb.sql).toMatch(/AS opening_in/);
    expect(tb.sql).toMatch(/AS opening_out/);
    // Single occurrence of the void-filtered join — every aggregate
    // shares the same source.
    const onClauseMatches = tb.sql.match(
      /LEFT JOIN cashbox_transactions t\s+ON\s+t\.cashbox_id\s*=\s*cb\.id\s+AND\s+t\.is_void\s*=\s*FALSE/g,
    );
    expect(onClauseMatches?.length).toBe(1);
  });

  it('cb.current_balance is reported verbatim — the void filter does NOT touch the stored balance column', async () => {
    const { service, dsCalls } = await makeService();
    await service.trialBalance({ from: '2026-04-01', to: '2026-05-03' } as any);
    const tb = dsCalls.find((c) => /period_in/.test(c.sql) && /opening_out/.test(c.sql))!;
    expect(tb.sql).toMatch(/cb\.current_balance::numeric\s+AS current_balance/);
    // Stored balance is already void-aware via the engine's recompute
    // path; this PR doesn't second-guess it.
  });

  it('SQL is pure SELECT', async () => {
    const { service, dsCalls } = await makeService();
    await service.trialBalance({ from: '2026-04-01', to: '2026-05-03' } as any);
    const tb = dsCalls.find((c) => /period_in/.test(c.sql))!;
    expect(tb.sql).toMatch(/^\s*SELECT/i);
    expect(tb.sql).not.toMatch(/\bINSERT\b/i);
    expect(tb.sql).not.toMatch(/\bUPDATE\b/i);
    expect(tb.sql).not.toMatch(/\bDELETE\b/i);
    expect(tb.sql).not.toMatch(/\bMERGE\b/i);
  });

  it('warehouse_id filter still composes with the void-filtered join', async () => {
    const { service, dsCalls } = await makeService();
    await service.trialBalance({
      from: '2026-04-01', to: '2026-05-03',
      warehouse_id: '11111111-2222-3333-4444-555555555555',
    } as any);
    const tb = dsCalls.find((c) => /period_in/.test(c.sql))!;
    expect(tb.sql).toMatch(/t\.is_void\s*=\s*FALSE/);
    expect(tb.sql).toMatch(/cb\.warehouse_id\s*=\s*\$3/);
  });
});

describe('PR-AUDIT-VOID-LEAK — scope guarantees (defensive)', () => {
  it('source-shape: accounting.service.ts has no remaining unfiltered CT aggregations in cashflow / trialBalance methods', async () => {
    // This is a code-shape guard. We re-read the SUT file and assert
    // that the two report methods we fixed both contain the filter.
    // generalLedger() intentionally lists ALL rows (including voided)
    // for audit display, so it is excluded from this guard.
    const fs = await import('fs');
    const path = await import('path');
    const src = fs.readFileSync(
      path.resolve(__dirname, 'accounting.service.ts'),
      'utf8',
    );
    const cashflowStart = src.indexOf('async cashflow(');
    const cashflowEnd   = src.indexOf('async trialBalance(', cashflowStart);
    const tbStart       = cashflowEnd;
    const tbEnd         = src.indexOf('async generalLedger(', tbStart);
    expect(cashflowStart).toBeGreaterThan(-1);
    expect(tbStart).toBeGreaterThan(-1);
    expect(tbEnd).toBeGreaterThan(-1);

    const cashflowBody = src.slice(cashflowStart, cashflowEnd);
    const tbBody       = src.slice(tbStart, tbEnd);

    expect(cashflowBody).toMatch(/cashbox_transactions/);
    expect(cashflowBody).toMatch(/is_void\s*=\s*FALSE/);
    expect(tbBody).toMatch(/cashbox_transactions/);
    expect(tbBody).toMatch(/is_void\s*=\s*FALSE/);
  });
});
