/**
 * analytics.service.spec.ts — PR-FIN-ANALYTICS-LIQUIDITY-GL
 *
 * Pins the new `cash_on_hand` derivation in `smartIndicators()`.
 * The previous formula `Σ direction-signed amount` over raw
 * `cashbox_transactions` had three bugs that all surfaced together
 * on the production "السيولة" tile:
 *
 *   1. NO `is_void` filter → voided cancellation/reversal CT rows
 *      inflated the total (+2,839.98 EGP on the production snapshot).
 *   2. NO non-cash kinds → wallet/bank/check liquidity invisible
 *      (خزنة التحويلات holds GL 1114 = 2,190 EGP that the old
 *      formula missed).
 *   3. CT system can drift from GL → reporting any of (current_balance
 *      / CT-sum / GL net) as "the cash balance" contradicts the
 *      other two answers.
 *
 * The new formula sums GL liquid-asset codes (1111+1113+1114+1115)
 * over posted-non-void journal entries — same source of truth the
 * Income Statement, Trial Balance and the treasury cards use.
 *
 * The DataSource is stubbed so we can assert SQL strings + the
 * computed shape without touching Postgres.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AccountingAnalyticsService } from './analytics.service';

type QueryCall = { sql: string; params: any[] };

function makeFakeDataSource(
  responder: (sql: string, params: any[]) => any[] | Promise<any[]>,
) {
  const dsCalls: QueryCall[] = [];
  const ds: any = {
    query: async (sql: string, params: any[] = []) => {
      dsCalls.push({ sql, params });
      return responder(sql, params);
    },
    transaction: async (cb: (em: any) => Promise<any>) => cb(ds),
  };
  return { ds, dsCalls };
}

async function makeService(
  responder: (sql: string, params: any[]) => any[] | Promise<any[]>,
) {
  const { ds, dsCalls } = makeFakeDataSource(responder);
  const moduleRef = await Test.createTestingModule({
    providers: [
      AccountingAnalyticsService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  const service = moduleRef.get(AccountingAnalyticsService);
  return { service, dsCalls };
}

/**
 * Default responder shape: returns the query-shape's expected row
 * for every fragment of `smartIndicators()`. Tests can override
 * specific fragments by composing on top.
 */
function defaultResponder(over: Record<string, any> = {}) {
  return (sql: string) => {
    if (/FROM invoices/.test(sql) && /SUM\(grand_total/.test(sql))
      return [over.rev ?? { revenue: '0', cogs: '0', invoice_count: 0, avg_ticket: '0' }];
    if (/account_type = 'expense'/.test(sql))
      return [over.exp ?? { expenses: '0' }];
    if (/FROM returns/.test(sql))
      return [over.ret ?? { return_count: 0, return_value: '0' }];
    if (/FROM stock /.test(sql))
      return [over.inv ?? { inventory_value: '0' }];
    if (/FROM invoices/.test(sql) && /receivables/.test(sql))
      return [over.recv ?? { receivables: '0' }];
    if (/FROM purchases/.test(sql))
      return [over.pay ?? { payables: '0' }];
    // The cash_on_hand query — pinned shape for this PR.
    if (/AS cash_on_hand/.test(sql))
      return [over.cash ?? { cash_on_hand: '0' }];
    return [];
  };
}

describe('AccountingAnalyticsService.smartIndicators — cash_on_hand (PR-FIN-ANALYTICS-LIQUIDITY-GL)', () => {
  it('cash_on_hand SQL: pure SELECT — no INSERT/UPDATE/DELETE', async () => {
    const { service, dsCalls } = await makeService(defaultResponder());
    await service.smartIndicators({ from: '2026-01-01', to: '2026-05-03' });
    const cashSql = dsCalls.find((c) => /AS cash_on_hand/.test(c.sql))!;
    expect(cashSql).toBeDefined();
    expect(cashSql.sql).toMatch(/^\s*SELECT/i);
    expect(cashSql.sql).not.toMatch(/\bINSERT\b/i);
    expect(cashSql.sql).not.toMatch(/\bUPDATE\b/i);
    expect(cashSql.sql).not.toMatch(/\bDELETE\b/i);
    expect(cashSql.sql).not.toMatch(/\bMERGE\b/i);
  });

  it('cash_on_hand SQL: sums journal_lines, NOT raw cashbox_transactions', async () => {
    const { service, dsCalls } = await makeService(defaultResponder());
    await service.smartIndicators({ from: '2026-01-01', to: '2026-05-03' });
    const cashSql = dsCalls.find((c) => /AS cash_on_hand/.test(c.sql))!;
    expect(cashSql.sql).toMatch(/FROM\s+journal_lines/);
    expect(cashSql.sql).toMatch(/SUM\(jl\.debit\s*-\s*jl\.credit\)/);
    // The retired formula is GONE from the cash_on_hand SQL.
    expect(cashSql.sql).not.toMatch(/FROM\s+cashbox_transactions/);
    expect(cashSql.sql).not.toMatch(/direction\s*=\s*'in'/);
  });

  it('cash_on_hand SQL: filters to GL liquid-asset codes 1111/1113/1114/1115 only', async () => {
    const { service, dsCalls } = await makeService(defaultResponder());
    await service.smartIndicators({ from: '2026-01-01', to: '2026-05-03' });
    const cashSql = dsCalls.find((c) => /AS cash_on_hand/.test(c.sql))!;
    expect(cashSql.sql).toMatch(/coa\.code\s+IN\s*\(\s*'1111'\s*,\s*'1113'\s*,\s*'1114'\s*,\s*'1115'\s*\)/);
  });

  it('cash_on_hand SQL: only posted, non-void journal entries (matches every other GL-derived KPI)', async () => {
    const { service, dsCalls } = await makeService(defaultResponder());
    await service.smartIndicators({ from: '2026-01-01', to: '2026-05-03' });
    const cashSql = dsCalls.find((c) => /AS cash_on_hand/.test(c.sql))!;
    expect(cashSql.sql).toMatch(/je\.is_posted\s*=\s*TRUE/);
    expect(cashSql.sql).toMatch(/je\.is_void\s*=\s*FALSE/);
  });

  it('cash_on_hand SQL: joins chart_of_accounts (the canonical source of truth for GL codes)', async () => {
    const { service, dsCalls } = await makeService(defaultResponder());
    await service.smartIndicators({ from: '2026-01-01', to: '2026-05-03' });
    const cashSql = dsCalls.find((c) => /AS cash_on_hand/.test(c.sql))!;
    expect(cashSql.sql).toMatch(/JOIN\s+journal_entries\s+je\s+ON\s+je\.id\s*=\s*jl\.entry_id/);
    expect(cashSql.sql).toMatch(/JOIN\s+chart_of_accounts\s+coa\s+ON\s+coa\.id\s*=\s*jl\.account_id/);
  });

  it('end-to-end: returns BE-shaped result with cash_on_hand from GL liquid-assets fixture', async () => {
    // Production snapshot: GL 1111 = 29,660.00, GL 1114 = 2,190.00,
    // GL 1113/1115 = 0 → total liquid assets = 31,850.00.
    const { service } = await makeService(
      defaultResponder({ cash: { cash_on_hand: '31850.00' } }),
    );
    const out = await service.smartIndicators({ from: '2026-01-01', to: '2026-05-03' });
    expect(out.cash_on_hand).toBe(31850);
  });

  it('end-to-end: cash_runway_days uses the corrected liquidity numerator', async () => {
    // Same liquidity (31,850) and the prod YTD expenses snapshot
    // (36,132.13 over 123 days = daily_burn 293.76).
    const { service } = await makeService(
      defaultResponder({
        cash: { cash_on_hand: '31850.00' },
        exp:  { expenses:    '36132.13' },
      }),
    );
    const out = await service.smartIndicators({ from: '2026-01-01', to: '2026-05-03' });
    expect(out.cash_on_hand).toBe(31850);
    expect(out.daily_burn).toBeCloseTo(293.76, 2);
    // 31,850 / 293.76 ≈ 108.42 → rounds to 108
    expect(out.cash_runway_days).toBe(108);
    // Sanity: NOT the pre-fix 117 (which came from the inflated 34,244.98).
    expect(out.cash_runway_days).not.toBe(117);
  });

  it('end-to-end: cash_on_hand=0 + daily_burn=0 → cash_runway_days = 9999 (no division by zero)', async () => {
    const { service } = await makeService(defaultResponder());
    const out = await service.smartIndicators({ from: '2026-05-03', to: '2026-05-03' });
    expect(out.cash_on_hand).toBe(0);
    expect(out.daily_burn).toBe(0);
    expect(out.cash_runway_days).toBe(9999);
  });

  it('end-to-end: cash_on_hand fixture passes through verbatim — no implicit add-on from CTs', async () => {
    // If the GL says 31,850 the result must say 31,850 — no quietly
    // adding a separate CT-sum on top, no double-counting from
    // payment-account aggregations, no cashbox stored balance fallback.
    const { service, dsCalls } = await makeService(
      defaultResponder({ cash: { cash_on_hand: '31850.00' } }),
    );
    const out = await service.smartIndicators({ from: '2026-01-01', to: '2026-05-03' });
    expect(out.cash_on_hand).toBe(31850);
    // Only ONE cash_on_hand SQL fragment is emitted per request.
    expect(dsCalls.filter((c) => /AS cash_on_hand/.test(c.sql))).toHaveLength(1);
    // And it does NOT touch cashbox_transactions or cashboxes.
    const cashSql = dsCalls.find((c) => /AS cash_on_hand/.test(c.sql))!;
    expect(cashSql.sql).not.toMatch(/cashbox_transactions/);
    expect(cashSql.sql).not.toMatch(/FROM\s+cashboxes\b/);
  });
});
