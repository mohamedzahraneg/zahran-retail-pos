/**
 * products.service.group-filter.spec.ts — PR-P9.1b
 *
 * Pins that the smart-pricing AND cost-adjustment scope resolvers
 * honor the new `group_id` filter:
 *
 *   · When `filters.group_id` is present, the SQL gains a
 *     `JOIN product_group_variants pgv ON pgv.variant_id = pv.id
 *      AND pgv.group_id = $N::uuid` clause.
 *   · The id is bound as the last param.
 *   · When `filters.group_id` is absent, the SQL is unchanged
 *     (no spurious join, no extra bind).
 *
 * STATIC GUARDRAIL: the scope-resolver code adds the join but
 * introduces no INSERT/UPDATE/DELETE, no apply call, no cashbox/
 * journal/stock/supplier touch.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProductsService } from './products.service';
import { ProductEntity } from './entities/product.entity';
import { VariantEntity } from './entities/variant.entity';

type QueryCall = { sql: string; params: any[] };

interface MakeOpts {
  responses?: Array<any[]>;
}

async function makeService(opts: MakeOpts = {}) {
  const queue = [...(opts.responses ?? [])];
  const calls: QueryCall[] = [];
  const inner = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    return queue.length ? queue.shift() : [];
  });
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return queue.length ? queue.shift() : [];
    }),
    transaction: jest.fn(async (cb: any) => cb({ query: inner })),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProductsService,
      { provide: DataSource, useValue: ds },
      { provide: getRepositoryToken(ProductEntity), useValue: {} },
      { provide: getRepositoryToken(VariantEntity), useValue: {} },
    ],
  }).compile();
  return { service: moduleRef.get(ProductsService), calls };
}

const GROUP_ID = '11111111-1111-1111-1111-111111111111';
const VID = '22222222-2222-2222-2222-222222222222';

const SETTINGS_ROWS = [
  { key: 'smart_pricing.recommended_margin_pct', value: 30 },
  { key: 'smart_pricing.high_margin_pct', value: 40 },
  { key: 'smart_pricing.min_margin_pct_default', value: 15 },
  { key: 'smart_pricing.rounding_step', value: 5 },
  { key: 'smart_pricing.rounding_mode', value: 'nearest' },
];

describe('Smart-pricing — group_id filter (P9.1b)', () => {
  it('preview filtered scope: scope SQL contains the group join + binds group_id', async () => {
    const { service, calls } = await makeService({
      responses: [
        SETTINGS_ROWS,                               // settings (engine prelude)
        [{ n: 1 }],                                  // scope COUNT
        [{ variant_id: VID }],                       // scope id list
        [],                                          // rich rows (empty fine)
      ],
    });
    await service.smartPricingPreview({
      scope: {
        type: 'filtered',
        filters: { only_in_stock: false, group_id: GROUP_ID } as any,
      },
      strategy: 'balanced',
      limit: 10,
    } as any);
    // The scope COUNT query is whatever call references
    // `product_variants pv` with the FROM clause shape we generated.
    const scopeQ = calls.find(
      (c) =>
        /COUNT\(DISTINCT pv\.id\)/i.test(c.sql)
        && /product_group_variants/.test(c.sql),
    );
    expect(scopeQ).toBeDefined();
    expect(scopeQ!.sql).toMatch(
      /JOIN\s+product_group_variants\s+pgv\s+ON\s+pgv\.variant_id\s*=\s*pv\.id\s+AND\s+pgv\.group_id\s*=\s*\$\d+::uuid/i,
    );
    expect(scopeQ!.params[scopeQ!.params.length - 1]).toBe(GROUP_ID);
  });

  it('preview filtered scope WITHOUT group_id: scope SQL has no group join', async () => {
    const { service, calls } = await makeService({
      responses: [SETTINGS_ROWS, [{ n: 0 }], [], []],
    });
    await service.smartPricingPreview({
      scope: { type: 'filtered', filters: {} },
      strategy: 'balanced',
      limit: 10,
    } as any);
    const scopeQ = calls.find((c) =>
      /COUNT\(DISTINCT pv\.id\)/i.test(c.sql),
    );
    expect(scopeQ).toBeDefined();
    expect(scopeQ!.sql).not.toMatch(/product_group_variants/);
  });
});

describe('Cost-adjustment — group_id filter (P9.1b)', () => {
  it('preview filtered scope: SQL contains the group join + binds group_id', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ n: 1 }],                                  // COUNT
        [{ variant_id: VID }],                       // id list
        [],                                          // rich rows
      ],
    });
    await service.costAdjustmentPreview({
      scope: 'filtered',
      adjustment_type: 'percent_increase',
      adjustment_value: 5,
      filters: { group_id: GROUP_ID } as any,
    } as any);
    const scopeQ = calls[0];
    expect(scopeQ.sql).toMatch(
      /JOIN\s+product_group_variants\s+pgv\s+ON\s+pgv\.variant_id\s*=\s*pv\.id\s+AND\s+pgv\.group_id\s*=\s*\$\d+::uuid/i,
    );
    expect(scopeQ.params[scopeQ.params.length - 1]).toBe(GROUP_ID);
  });

  it('preview filtered scope WITHOUT group_id: SQL has no group join', async () => {
    const { service, calls } = await makeService({
      responses: [[{ n: 0 }], [], []],
    });
    await service.costAdjustmentPreview({
      scope: 'filtered',
      adjustment_type: 'percent_increase',
      adjustment_value: 5,
      filters: {} as any,
    } as any);
    expect(calls[0].sql).not.toMatch(/product_group_variants/);
  });
});

describe('STATIC GUARDRAIL — group-filter resolver write footprint', () => {
  const SRC = readFileSync(
    join(__dirname, 'products.service.ts'),
    'utf8',
  );

  it('only ADDS a SELECT-side JOIN — no INSERT/UPDATE/DELETE introduced near the group_id sites', () => {
    // Find every occurrence of "if (f.group_id)" — the join injection
    // sites. For each, verify the surrounding ±400 chars contain no
    // write keywords.
    const re = /if\s*\(\s*f\.group_id\s*\)/g;
    const hits: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(SRC)) !== null) hits.push(m.index);
    expect(hits.length).toBeGreaterThanOrEqual(2); // smart + cost
    for (const idx of hits) {
      const slice = SRC.slice(
        Math.max(0, idx - 400),
        Math.min(SRC.length, idx + 400),
      );
      expect(slice).not.toMatch(/INSERT INTO/i);
      expect(slice).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
      expect(slice).not.toMatch(/\bDELETE FROM\b/i);
      expect(slice).not.toMatch(/journal_entries|journal_lines/i);
      expect(slice).not.toMatch(/cashbox_transactions|cashbox_balances/i);
      expect(slice).not.toMatch(/stock_movements/i);
      expect(slice).not.toMatch(/supplier_ledger|supplier_payments/i);
      expect(slice).not.toMatch(/postPurchase|recordTransaction|financialEngine/);
    }
  });

  it('group join uses the product_group_variants table', () => {
    const re = /if\s*\(\s*f\.group_id\s*\)/g;
    let m: RegExpExecArray | null;
    let count = 0;
    while ((m = re.exec(SRC)) !== null) {
      const slice = SRC.slice(m.index, m.index + 400);
      expect(slice).toMatch(/product_group_variants/);
      expect(slice).toMatch(/pgv\.variant_id\s*=\s*pv\.id/);
      expect(slice).toMatch(/pgv\.group_id\s*=\s*\$\$\{?\w+\}?::uuid|\$\$\{params\.length\}::uuid/);
      count += 1;
    }
    expect(count).toBeGreaterThanOrEqual(2);
  });
});
