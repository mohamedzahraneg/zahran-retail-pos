/**
 * products.service.smart-pricing.spec.ts — PR-PURCHASES-P3.5A
 *
 * Pins the Smart Bulk Pricing Assistant (preview + apply) recommendation
 * engine, the apply transaction footprint, and the static guardrail that
 * the new code only writes to product_variants.selling_price +
 * variant_price_history.
 *
 * Cost adjustment is explicitly DEFERRED to P3.5B — these tests assert
 * that nothing in P3.5A touches product_variants.cost_price.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ProductsService } from './products.service';
import { ProductEntity } from './entities/product.entity';
import { VariantEntity } from './entities/variant.entity';

type QueryCall = { sql: string; params: any[] };

interface MakeOpts { responses?: Array<any[]>; }

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
  return { service: moduleRef.get(ProductsService), calls, ds };
}

const VID = '11111111-1111-1111-1111-111111111111';
const VID2 = '22222222-2222-2222-2222-222222222222';
const PID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER = '99999999-9999-9999-9999-999999999999';

// Settings rows — single source of truth for thresholds. The engine
// loads them inside _smartPricingComputeRecommendations.
const SETTINGS_ROWS = [
  { key: 'smart_pricing.recommended_margin_pct', value: 30 },
  { key: 'smart_pricing.high_margin_pct', value: 40 },
  { key: 'smart_pricing.min_margin_pct_default', value: 15 },
  { key: 'smart_pricing.rounding_step', value: 5 },
  { key: 'smart_pricing.rounding_mode', value: 'nearest' },
];

function richRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    variant_id: VID,
    product_id: PID,
    product_name: 'منتج تجريبي',
    sku: 'SKU-1',
    barcode: null,
    color: null,
    size: null,
    cost_price: '100.00',
    selling_price: '150.00',
    min_margin_pct: '15.00',
    stock_qty: 10,
    qty_sold: 5,
    invoice_count: 3,
    last_sold_at: '2026-05-10T12:00:00Z',
    ...overrides,
  };
}

describe('smartPricingPreview — recommendation engine (P3.5A)', () => {
  it('1. selected scope: single variant goes through the engine', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,           // settings
        [richRow()],             // rich rows
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
    });
    expect(res.scope_type).toBe('selected');
    expect(res.strategy).toBe('balanced');
    expect(res.items).toHaveLength(1);
    expect(res.items[0].variant_id).toBe(VID);
  });

  it('2. single scope rejects multiple ids', async () => {
    const { service } = await makeService({ responses: [SETTINGS_ROWS] });
    await expect(
      service.smartPricingPreview({
        scope: { type: 'single', variant_ids: [VID, VID2] },
        strategy: 'balanced',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('3. below cost → recommendation = increase, lifts to ≥ min_margin', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [richRow({ cost_price: '100', selling_price: '80' })], // selling < cost
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
    });
    const r = res.items[0];
    expect(r.recommendation).toBe('increase');
    expect(r.suggested_selling_price).toBeGreaterThanOrEqual(118); // 100/(1-0.15)=117.65 → round 5 → 120
    expect(r.warnings).toContain('below_cost_at_current');
  });

  it('4. below min_margin → recommendation = increase', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,
        // cost 100, sell 110 → margin = 9.09% < 15
        [richRow({ cost_price: '100', selling_price: '110' })],
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
    });
    const r = res.items[0];
    expect(r.recommendation).toBe('increase');
    expect(r.suggested_selling_price).toBeGreaterThan(110);
  });

  it('5. high stock + slow moving + margin headroom → recommendation = decrease', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,
        // cost 100, sell 200 → margin 50%. stock 100, invoice_count 1.
        [
          richRow({
            cost_price: '100',
            selling_price: '200',
            stock_qty: 100,
            invoice_count: 1,
          }),
        ],
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
    });
    const r = res.items[0];
    expect(r.recommendation).toBe('decrease');
    expect(r.suggested_selling_price).toBeLessThan(200);
    expect(r.warnings).toEqual(
      expect.arrayContaining(['high_stock', 'slow_moving']),
    );
  });

  it('6. strong seller + balanced + margin < recommended → small increase', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,
        // cost 100, sell 130 → margin 23% < 30 (recommended)
        // invoice_count 10 → strong seller
        [
          richRow({
            cost_price: '100',
            selling_price: '130',
            stock_qty: 10,
            invoice_count: 10,
          }),
        ],
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
    });
    const r = res.items[0];
    expect(r.recommendation).toBe('increase');
    // 130 * 1.03 = 133.9 → rounded to 135 (nearest 5)
    expect(r.suggested_selling_price).toBe(135);
  });

  it('7. strong seller + conservative → keep', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [
          richRow({
            cost_price: '100',
            selling_price: '130',
            stock_qty: 10,
            invoice_count: 10,
          }),
        ],
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'conservative',
    });
    expect(res.items[0].recommendation).toBe('keep');
  });

  it('8. missing cost → recommendation = review, no suggested price', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [richRow({ cost_price: '0', selling_price: '100' })],
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
    });
    const r = res.items[0];
    expect(r.recommendation).toBe('review');
    expect(r.suggested_selling_price).toBeNull();
    expect(r.warnings).toContain('missing_cost');
    expect(r.skipped_reason).toBe('cost_or_price_missing');
  });

  it('9. clearance strategy uses bigger trim on high stock + slow', async () => {
    const { service: srvBalanced } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [
          richRow({
            cost_price: '100',
            selling_price: '200',
            stock_qty: 100,
            invoice_count: 1,
          }),
        ],
      ],
    });
    const balanced = await srvBalanced.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
    });

    const { service: srvClearance } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [
          richRow({
            cost_price: '100',
            selling_price: '200',
            stock_qty: 100,
            invoice_count: 1,
          }),
        ],
      ],
    });
    const clearance = await srvClearance.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'clearance',
    });
    expect(clearance.items[0].suggested_selling_price!).toBeLessThan(
      balanced.items[0].suggested_selling_price!,
    );
  });

  it('10. rounding respects smart_pricing.rounding_step', async () => {
    const customSettings = SETTINGS_ROWS.map((r) =>
      r.key === 'smart_pricing.rounding_step' ? { ...r, value: 10 } : r,
    );
    const { service } = await makeService({
      responses: [
        customSettings,
        [
          richRow({
            cost_price: '100',
            selling_price: '110',
          }),
        ],
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
    });
    // Suggested price should be a multiple of 10.
    expect(res.items[0].suggested_selling_price! % 10).toBe(0);
  });
});

describe('smartPricingApply — transaction footprint (P3.5A)', () => {
  it('11. apply scope=all requires the exact confirm phrase', async () => {
    const { service } = await makeService();
    await expect(
      service.smartPricingApply(
        {
          scope: { type: 'all' },
          strategy: 'balanced',
          reason: 'test',
          confirm_all: 'wrong',
        },
        USER,
      ),
    ).rejects.toMatchObject({
      message:
        'تأكيد تعديل كل الأصناف مطلوب لتطبيق التعديل على كل الأصناف',
    });
  });

  it('12. apply writes ONLY product_variants.selling_price + variant_price_history', async () => {
    const { service, calls } = await makeService({
      responses: [
        SETTINGS_ROWS, // _loadSmartPricingThresholds
        [richRow({ cost_price: '100', selling_price: '110' })], // rich rows
        [{ id: VID, selling_price: '110.00' }], // SELECT current inside txn
        [],                                       // UPDATE
        [{ id: 'hist-1' }],                       // INSERT history
      ],
    });
    const res = await service.smartPricingApply(
      {
        scope: { type: 'selected', variant_ids: [VID] },
        strategy: 'balanced',
        reason: 'unit test',
      },
      USER,
    );
    expect(res.updated).toBe(1);
    const writes = calls.filter((c) =>
      /\b(INSERT|UPDATE|DELETE)\b/i.test(c.sql),
    );
    for (const w of writes) {
      // Allowed writes only.
      expect(w.sql).toMatch(
        /UPDATE product_variants\s+SET\s+selling_price|INSERT INTO variant_price_history/i,
      );
    }
    // NEVER writes to cost_price.
    const allSql = calls.map((c) => c.sql).join('\n');
    expect(allSql).not.toMatch(/cost_price\s*=/i);
  });

  it('13. apply audit metadata captures strategy / recommendation / warnings / scope_type', async () => {
    const { service, calls } = await makeService({
      responses: [
        SETTINGS_ROWS,
        // Cost 100, sell 80 → below cost → increase. After rounding
        // landed at e.g. 120.
        [richRow({ cost_price: '100', selling_price: '80' })],
        [{ id: VID, selling_price: '80.00' }],
        [],
        [{ id: 'hist-1' }],
      ],
    });
    await service.smartPricingApply(
      {
        scope: { type: 'selected', variant_ids: [VID] },
        strategy: 'aggressive',
        reason: 'test audit',
      },
      USER,
    );
    const histInsert = calls.find((c) =>
      /INSERT INTO variant_price_history\b/.test(c.sql),
    )!;
    // metadata is the 6th param ($6) in the INSERT.
    const meta = histInsert.params[5];
    expect(meta).toMatchObject({
      source: 'smart_bulk_pricing',
      strategy: 'aggressive',
      recommendation: 'increase',
      scope_type: 'selected',
    });
    expect(Array.isArray(meta.warnings)).toBe(true);
  });

  it('14. apply skips keep / review rows even when variant_ids_to_apply not provided', async () => {
    const { service, calls } = await makeService({
      responses: [
        SETTINGS_ROWS,
        // First row: keep (price already appropriate)
        // Second row: review (cost 0)
        [
          richRow({
            cost_price: '100',
            selling_price: '150',
            stock_qty: 5,
            invoice_count: 10,
          }), // strong seller + balanced + margin >= recommended → keep
          {
            ...richRow({ variant_id: VID2, cost_price: '0', selling_price: '100' }),
          },
        ],
      ],
    });
    const res = await service.smartPricingApply(
      {
        scope: { type: 'selected', variant_ids: [VID, VID2] },
        strategy: 'balanced',
        reason: 'skip test',
      },
      USER,
    );
    expect(res.updated).toBe(0);
    expect(res.skipped).toBe(2);
    expect(
      calls.filter((c) => /UPDATE product_variants\b/.test(c.sql)),
    ).toHaveLength(0);
    expect(
      calls.filter((c) => /INSERT INTO variant_price_history\b/.test(c.sql)),
    ).toHaveLength(0);
  });

  it('15. apply variant_ids_to_apply narrows the apply set', async () => {
    const { service, calls } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [
          richRow({ cost_price: '100', selling_price: '110' }),
          {
            ...richRow({ variant_id: VID2, cost_price: '100', selling_price: '105' }),
          },
        ],
        // SELECT + UPDATE + INSERT for ONE variant only
        [{ id: VID, selling_price: '110.00' }],
        [],
        [{ id: 'hist-1' }],
      ],
    });
    const res = await service.smartPricingApply(
      {
        scope: { type: 'selected', variant_ids: [VID, VID2] },
        strategy: 'balanced',
        reason: 'narrow apply',
        variant_ids_to_apply: [VID],
      },
      USER,
    );
    expect(res.updated).toBe(1);
    // Only one UPDATE + one INSERT history.
    expect(
      calls.filter((c) => /UPDATE product_variants\b/.test(c.sql)),
    ).toHaveLength(1);
    expect(
      calls.filter((c) => /INSERT INTO variant_price_history\b/.test(c.sql)),
    ).toHaveLength(1);
  });

  it('16. apply rejects when reason is missing or too short', async () => {
    const { service } = await makeService();
    await expect(
      service.smartPricingApply(
        {
          scope: { type: 'selected', variant_ids: [VID] },
          strategy: 'balanced',
          reason: '',
        },
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('17. apply with scope=all + correct confirm_all proceeds', async () => {
    const { service, ds } = await makeService({
      responses: [
        // _resolveScope for scope=all
        [{ variant_id: VID }],
        // settings
        SETTINGS_ROWS,
        // rich rows — return one that wants increase
        [richRow({ cost_price: '100', selling_price: '80' })],
        // SELECT current
        [{ id: VID, selling_price: '80.00' }],
        [], // UPDATE
        [{ id: 'hist-1' }],
      ],
    });
    const res = await service.smartPricingApply(
      {
        scope: { type: 'all' },
        strategy: 'balanced',
        reason: 'all apply',
        confirm_all: 'تأكيد تعديل كل الأصناف',
      },
      USER,
    );
    expect(res.updated).toBe(1);
    expect(ds.transaction).toHaveBeenCalledTimes(1);
  });

  it('18. missing variant inside txn rolls back via NotFoundException', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [richRow({ cost_price: '100', selling_price: '80' })],
        [], // SELECT current returns nothing → NotFound
      ],
    });
    await expect(
      service.smartPricingApply(
        {
          scope: { type: 'selected', variant_ids: [VID] },
          strategy: 'balanced',
          reason: 'missing variant',
        },
        USER,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('STATIC GUARDRAIL — smart pricing assistant write footprint', () => {
  const SRC = readFileSync(
    join(__dirname, 'products.service.ts'),
    'utf8',
  );
  // Anchor on the method-block marker (the second occurrence — the
  // first is in the type-imports block at the top of the file).
  const allIdxs: number[] = [];
  let lastIdx = SRC.indexOf('PR-PURCHASES-P3.5A');
  while (lastIdx !== -1) {
    allIdxs.push(lastIdx);
    lastIdx = SRC.indexOf('PR-PURCHASES-P3.5A', lastIdx + 1);
  }
  // Use the LAST marker (engine block) to start the slice, so we
  // skip pre-existing methods like `remove()` and `applyVariantPrices()`
  // that may legitimately reference forbidden tables in their own
  // (unrelated) read-side guards.
  const startIdx = allIdxs[allIdxs.length - 1] ?? -1;
  const slice = startIdx >= 0 ? SRC.slice(startIdx) : '';

  it('the new methods exist in the source', () => {
    expect(slice).toMatch(/async smartPricingPreview\b/);
    expect(slice).toMatch(/async smartPricingApply\b/);
    expect(slice).toMatch(/private async _smartPricingComputeRecommendations\b/);
  });

  it('only writes to product_variants.selling_price + variant_price_history', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    const inserts = stripped.match(/INSERT INTO\s+(\w+)/gi) || [];
    for (const ins of inserts) {
      expect(ins).toMatch(/INSERT INTO variant_price_history/i);
    }
    const updates = stripped.match(/UPDATE\s+(\w+)\s+SET/gi) || [];
    for (const upd of updates) {
      // The captured match preserves SQL whitespace (incl. newlines).
      expect(upd).toMatch(/UPDATE\s+product_variants\s+SET/i);
    }
    expect(stripped).not.toMatch(/\bDELETE FROM\b/i);
    expect(stripped).not.toMatch(/\bALTER TABLE\b/i);
    expect(stripped).not.toMatch(/\bDROP TABLE\b/i);
    expect(stripped).not.toMatch(/\bCREATE (TABLE|VIEW|INDEX|TRIGGER)\b/i);
  });

  it('NEVER writes to product_variants.cost_price (P3.5A is pricing-only)', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    // Allowed: reading cost_price in SELECT.
    expect(stripped).not.toMatch(/cost_price\s*=/i);
  });

  it('zero references to write-side service helpers / forbidden tables', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(stripped).not.toMatch(/postPurchase\b/);
    expect(stripped).not.toMatch(/reverseByReference\b/);
    expect(stripped).not.toMatch(/recordTransaction\b/);
    expect(stripped).not.toMatch(/financialEngine/i);
    expect(stripped).not.toMatch(/journal_entries\b/i);
    expect(stripped).not.toMatch(/journal_lines\b/i);
    expect(stripped).not.toMatch(/cashbox_transactions\b/i);
    expect(stripped).not.toMatch(/stock_movements\b/i);
    expect(stripped).not.toMatch(/supplier_ledger\b/i);
    expect(stripped).not.toMatch(/purchase_extra_costs\b/i);
    // purchase_items intentionally allowed if absent — but here we
    // don't read it inside P3.5A.
    expect(stripped).not.toMatch(/INSERT INTO purchases\b/i);
    expect(stripped).not.toMatch(/UPDATE purchases\b/i);
    expect(stripped).not.toMatch(/INSERT INTO invoices\b/i);
  });
});
