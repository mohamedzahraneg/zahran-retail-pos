/**
 * reports.service.group-filter.spec.ts — PR-P9.1b
 *
 * Pins that the five report methods that gained a `group_id` filter
 * inject the SELECT-only JOIN into `product_group_variants` and bind
 * the id as a param. Mirrors the smart-pricing / cost-adjustment
 * filter coverage in products.service.group-filter.spec.ts.
 *
 * Pure read-side filter — STATIC GUARDRAIL block at the bottom
 * asserts no new INSERT/UPDATE/DELETE near the group_id injection
 * sites.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReportsService } from './reports.service';

type QueryCall = { sql: string; params: any[] };

interface MakeOpts {
  responses?: Array<any[]>;
}

async function makeService(opts: MakeOpts = {}) {
  const queue = [...(opts.responses ?? [])];
  const calls: QueryCall[] = [];
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return queue.length ? queue.shift() : [];
    }),
    transaction: jest.fn(async (cb: any) => cb({ query: ds.query })),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ReportsService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  return { service: moduleRef.get(ReportsService), calls };
}

const GROUP_ID = '11111111-1111-1111-1111-111111111111';

function expectsGroupJoin(sql: string, params: any[]) {
  expect(sql).toMatch(
    /JOIN\s+product_group_variants\s+pgv\s+ON\s+pgv\.variant_id\s*=\s*pv\.id\s+AND\s+pgv\.group_id\s*=\s*\$\d+::uuid/i,
  );
  expect(params.includes(GROUP_ID)).toBe(true);
}

describe('Reports — group_id filter (P9.1b)', () => {
  it('pricingHealth: SQL contains the group join when group_id set', async () => {
    const { service, calls } = await makeService({ responses: [[]] });
    await service.pricingHealth({ group_id: GROUP_ID });
    const q = calls[0];
    expectsGroupJoin(q.sql, q.params);
  });

  it('pricingHealth: NO group join when group_id absent', async () => {
    const { service, calls } = await makeService({ responses: [[]] });
    await service.pricingHealth({});
    expect(calls[0].sql).not.toMatch(/product_group_variants/);
  });

  it('pricingLosses: forwards group_id into pricingHealth chain', async () => {
    const { service, calls } = await makeService({ responses: [[]] });
    await service.pricingLosses({ group_id: GROUP_ID });
    const q = calls[0];
    expectsGroupJoin(q.sql, q.params);
  });

  it('pricingLandedImpact: SQL contains the group join when group_id set', async () => {
    const { service, calls } = await makeService({ responses: [[]] });
    await service.pricingLandedImpact({ group_id: GROUP_ID });
    const q = calls[0];
    expectsGroupJoin(q.sql, q.params);
  });

  it('pricingLandedImpact: NO group join when group_id absent', async () => {
    const { service, calls } = await makeService({ responses: [[]] });
    await service.pricingLandedImpact({});
    expect(calls[0].sql).not.toMatch(/product_group_variants/);
  });

  it('soldProfitProducts: SQL contains the group join when group_id set', async () => {
    const { service, calls } = await makeService({ responses: [[]] });
    await service.soldProfitProducts({ group_id: GROUP_ID });
    const q = calls[0];
    expectsGroupJoin(q.sql, q.params);
  });

  it('soldProfitProducts: NO group join when group_id absent', async () => {
    const { service, calls } = await makeService({ responses: [[]] });
    await service.soldProfitProducts({});
    expect(calls[0].sql).not.toMatch(/product_group_variants/);
  });

  it('fairPrice: rows query contains the group join when group_id set', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ value: '30' }],         // settings
        [{ s: '100' }],            // overhead total
        [],                        // rows
        [{ n: 0 }],                // count
      ],
    });
    await service.fairPrice({ group_id: GROUP_ID, allocation_basis: 'revenue_share' });
    // Find the rows-query call (the one selecting pv.id AS variant_id ...).
    const rowsCall = calls.find((c) =>
      /pv\.id\s+AS\s+variant_id[\s\S]*ORDER BY revenue_in_period/i.test(c.sql),
    );
    expect(rowsCall).toBeDefined();
    expectsGroupJoin(rowsCall!.sql, rowsCall!.params);
  });

  it('fairPrice: NO group join when group_id absent', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ value: '30' }],
        [{ s: '0' }],
        [],
        [{ n: 0 }],
      ],
    });
    await service.fairPrice({});
    const rowsCall = calls.find((c) =>
      /pv\.id\s+AS\s+variant_id[\s\S]*ORDER BY revenue_in_period/i.test(c.sql),
    );
    expect(rowsCall).toBeDefined();
    expect(rowsCall!.sql).not.toMatch(/product_group_variants/);
  });
});

describe('STATIC GUARDRAIL — reports group_id filter write footprint', () => {
  const SRC = readFileSync(
    join(__dirname, 'reports.service.ts'),
    'utf8',
  );

  it('every `if (filters.group_id)` site only adds a SELECT-only join', () => {
    const re = /if\s*\(\s*filters\.group_id\s*\)/g;
    const hits: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(SRC)) !== null) hits.push(m.index);
    // 4 distinct injection sites: pricingHealth, pricingLandedImpact,
    // soldProfitProducts, fairPrice. (pricingLosses forwards to
    // pricingHealth and so has no injection of its own.)
    expect(hits.length).toBeGreaterThanOrEqual(4);
    for (const idx of hits) {
      const slice = SRC.slice(
        Math.max(0, idx - 400),
        Math.min(SRC.length, idx + 400),
      );
      expect(slice).toMatch(/product_group_variants/);
      expect(slice).not.toMatch(/INSERT INTO/i);
      expect(slice).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
      expect(slice).not.toMatch(/\bDELETE FROM\b/i);
      expect(slice).not.toMatch(/\bselling_price\s*=/i);
      expect(slice).not.toMatch(/\bcost_price\s*=/i);
      expect(slice).not.toMatch(/journal_entries|journal_lines/i);
      expect(slice).not.toMatch(/cashbox_transactions|cashbox_balances/i);
      expect(slice).not.toMatch(/stock_movements/i);
      expect(slice).not.toMatch(/supplier_ledger|supplier_payments/i);
      expect(slice).not.toMatch(
        /postPurchase|recordTransaction|financialEngine|reverseByReference/,
      );
    }
  });
});
