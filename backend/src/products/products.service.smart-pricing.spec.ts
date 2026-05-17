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

// P3.5A.1 — Manual Bulk Sale Price Adjustment tests. The manual mode
// bypasses the strategy engine and applies a flat operation/value to
// every previewed row. Same `SmartPricingItem` shape, same write
// footprint (selling_price + variant_price_history). Cost adjustment
// stays deferred to P3.5B.
describe('smartPricingPreview — manual mode (P3.5A.1)', () => {
  it('M1. increase_percent: lifts current price by N% and marks increase', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [richRow({ cost_price: '100', selling_price: '100' })],
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
      mode: 'manual',
      manual_adjustment: { operation: 'increase_percent', value: 10 },
    });
    expect(res.mode).toBe('manual');
    const r = res.items[0];
    expect(r.recommendation).toBe('increase');
    expect(r.suggested_selling_price).toBe(110);
    expect(r.reason_ar).toContain('زيادة يدوية بنسبة 10');
  });

  it('M2. decrease_percent: trims current price by N% and marks decrease', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [richRow({ cost_price: '50', selling_price: '200' })],
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
      mode: 'manual',
      manual_adjustment: { operation: 'decrease_percent', value: 20 },
    });
    const r = res.items[0];
    expect(r.recommendation).toBe('decrease');
    expect(r.suggested_selling_price).toBe(160);
    expect(r.reason_ar).toContain('تخفيض يدوي بنسبة 20');
  });

  it('M3. increase_amount: adds a flat amount to the current price', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [richRow({ cost_price: '100', selling_price: '150' })],
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
      mode: 'manual',
      manual_adjustment: { operation: 'increase_amount', value: 25 },
    });
    expect(res.items[0].suggested_selling_price).toBe(175);
    expect(res.items[0].recommendation).toBe('increase');
    expect(res.items[0].reason_ar).toContain('زيادة يدوية بقيمة 25');
  });

  it('M4. decrease_amount: subtracts a flat amount from the current price', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [richRow({ cost_price: '50', selling_price: '200' })],
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
      mode: 'manual',
      manual_adjustment: { operation: 'decrease_amount', value: 30 },
    });
    expect(res.items[0].suggested_selling_price).toBe(170);
    expect(res.items[0].recommendation).toBe('decrease');
  });

  it('M5. set_price: assigns the value verbatim', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [richRow({ cost_price: '100', selling_price: '120' })],
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
      mode: 'manual',
      manual_adjustment: { operation: 'set_price', value: 150 },
    });
    expect(res.items[0].suggested_selling_price).toBe(150);
    expect(res.items[0].recommendation).toBe('increase');
    expect(res.items[0].reason_ar).toContain('تعيين سعر بيع ثابت 150');
  });

  it('M6. invalid resulting price (≤ 0) → review with skipped_reason', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [richRow({ cost_price: '50', selling_price: '20' })],
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
      mode: 'manual',
      manual_adjustment: { operation: 'decrease_amount', value: 25 },
    });
    expect(res.items[0].recommendation).toBe('review');
    expect(res.items[0].suggested_selling_price).toBeNull();
    expect(res.items[0].skipped_reason).toBe('manual_price_non_positive');
  });

  it('M7. below cost after change adds below_cost_after_change warning', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [richRow({ cost_price: '100', selling_price: '150' })],
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
      mode: 'manual',
      manual_adjustment: { operation: 'set_price', value: 80 },
    });
    expect(res.items[0].recommendation).toBe('decrease');
    expect(res.items[0].warnings).toContain('below_cost_after_change');
  });

  it('M8. unchanged price (set_price equals current) → keep', async () => {
    const { service } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [richRow({ cost_price: '100', selling_price: '150' })],
      ],
    });
    const res = await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
      mode: 'manual',
      manual_adjustment: { operation: 'set_price', value: 150 },
    });
    expect(res.items[0].recommendation).toBe('keep');
  });

  it('M9. percent > 500 is rejected at preview', async () => {
    const { service } = await makeService();
    await expect(
      service.smartPricingPreview({
        scope: { type: 'selected', variant_ids: [VID] },
        strategy: 'balanced',
        mode: 'manual',
        manual_adjustment: { operation: 'increase_percent', value: 600 },
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('M10. manual mode without manual_adjustment is rejected', async () => {
    const { service } = await makeService();
    await expect(
      service.smartPricingPreview({
        scope: { type: 'selected', variant_ids: [VID] },
        strategy: 'balanced',
        mode: 'manual',
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('smartPricingApply — manual mode (P3.5A.1)', () => {
  it('M11. apply manual reruns server preview and writes audit with mode/operation/value', async () => {
    const { service, calls } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [richRow({ cost_price: '100', selling_price: '100' })],
        [{ id: VID, selling_price: '100.00' }], // SELECT inside txn
        [], // UPDATE
        [{ id: 'hist-1' }], // INSERT history
      ],
    });
    const res = await service.smartPricingApply(
      {
        scope: { type: 'selected', variant_ids: [VID] },
        strategy: 'balanced',
        mode: 'manual',
        manual_adjustment: { operation: 'increase_percent', value: 10 },
        reason: 'إعادة تسعير يدوية',
      },
      USER,
    );
    expect(res.updated).toBe(1);
    expect(res.mode).toBe('manual');
    const updateCall = calls.find((c) =>
      /UPDATE product_variants\s+SET\s+selling_price/i.test(c.sql),
    )!;
    // Server-side computed price = 100 * 1.10 = 110 — NOT something the
    // client supplied.
    expect(updateCall.params[1]).toBe(110);

    const histInsert = calls.find((c) =>
      /INSERT INTO variant_price_history\b/.test(c.sql),
    )!;
    const meta = histInsert.params[5];
    expect(meta).toMatchObject({
      source: 'smart_bulk_pricing',
      mode: 'manual',
      operation: 'increase_percent',
      value: 10,
      strategy: null,
      recommendation: 'increase',
      scope_type: 'selected',
    });
  });

  it('M12. apply manual respects variant_ids_to_apply filter', async () => {
    const { service, calls } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [
          richRow({ cost_price: '100', selling_price: '100' }),
          richRow({ variant_id: VID2, cost_price: '100', selling_price: '100' }),
        ],
        [{ id: VID, selling_price: '100.00' }],
        [],
        [{ id: 'hist-1' }],
      ],
    });
    const res = await service.smartPricingApply(
      {
        scope: { type: 'selected', variant_ids: [VID, VID2] },
        strategy: 'balanced',
        mode: 'manual',
        manual_adjustment: { operation: 'increase_amount', value: 10 },
        variant_ids_to_apply: [VID],
        reason: 'narrowed manual',
      },
      USER,
    );
    expect(res.updated).toBe(1);
    expect(
      calls.filter((c) => /UPDATE product_variants\b/.test(c.sql)),
    ).toHaveLength(1);
  });

  it('M13. apply scope=all still requires the exact confirm phrase (manual or smart)', async () => {
    const { service } = await makeService();
    await expect(
      service.smartPricingApply(
        {
          scope: { type: 'all' },
          strategy: 'balanced',
          mode: 'manual',
          manual_adjustment: { operation: 'increase_percent', value: 5 },
          reason: 'all manual',
          confirm_all: 'wrong',
        },
        USER,
      ),
    ).rejects.toMatchObject({
      message:
        'تأكيد تعديل كل الأصناف مطلوب لتطبيق التعديل على كل الأصناف',
    });
  });

  it('M14. manual review/keep rows are skipped (no UPDATE, no INSERT)', async () => {
    const { service, calls } = await makeService({
      responses: [
        SETTINGS_ROWS,
        // set_price == current → keep (no write expected)
        [richRow({ cost_price: '100', selling_price: '150' })],
      ],
    });
    const res = await service.smartPricingApply(
      {
        scope: { type: 'selected', variant_ids: [VID] },
        strategy: 'balanced',
        mode: 'manual',
        manual_adjustment: { operation: 'set_price', value: 150 },
        reason: 'keep manual',
      },
      USER,
    );
    expect(res.updated).toBe(0);
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    expect(
      calls.filter((c) => /UPDATE product_variants\b/.test(c.sql)),
    ).toHaveLength(0);
    expect(
      calls.filter((c) => /INSERT INTO variant_price_history\b/.test(c.sql)),
    ).toHaveLength(0);
  });

  it('M15. manual mode WITHOUT manual_adjustment is rejected at apply', async () => {
    const { service } = await makeService();
    await expect(
      service.smartPricingApply(
        {
          scope: { type: 'selected', variant_ids: [VID] },
          strategy: 'balanced',
          mode: 'manual',
          reason: 'missing adjustment',
        } as any,
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// HOTFIX (post-fd30cee) — Regression block for the "could not determine
// data type of parameter $2" bug. The original main rich-data query
// reused a `$1..$N` placeholder string in three IN clauses while the
// params array carried `[...variantIds, ...variantIds, default]`, so
// the second batch of variant_ids ($N+1..$2N) was bound but never
// referenced in SQL and PostgreSQL aborted at bind-time.
//
// These tests pin:
//   · every $-placeholder in the main rich-query has a corresponding
//     param and every passed param is referenced
//   · the main rich-query uses `ANY($1::uuid[])` (explicit cast) and
//     `$2::numeric` for the min-margin fallback
//   · the filtered-scope SQL casts q → text and supplier_id → uuid
//   · preview works for every scope shape (single / selected /
//     filtered / all) with no SQL-bind error
describe('smartPricingPreview — SQL bind shape (HOTFIX regression)', () => {
  // Helper: extract the SQL of the second call (= main rich-data query).
  // Order of calls for selected/single scope:
  //   0 — settings
  //   1 — main rich-data query
  // For filtered/all scope:
  //   0 — settings
  //   1 — scope-resolution query
  //   2 — main rich-data query
  function placeholdersIn(sql: string): number[] {
    return Array.from(
      new Set(
        (sql.match(/\$(\d+)/g) ?? []).map((m) => Number(m.slice(1))),
      ),
    ).sort((a, b) => a - b);
  }

  it('R1. selected (1 variant): main query uses ANY($1::uuid[]) + $2::numeric, params length = 2', async () => {
    const { service, calls } = await makeService({
      responses: [SETTINGS_ROWS, [richRow()]],
    });
    await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
    });
    expect(calls).toHaveLength(2);
    const main = calls[1];
    expect(main.sql).toMatch(/ANY\(\$1::uuid\[\]\)/);
    // Three references to the variant-id array: stock_sum, sales_90d,
    // and the outer WHERE.
    const occurrences = main.sql.match(/ANY\(\$1::uuid\[\]\)/g) ?? [];
    expect(occurrences.length).toBe(3);
    expect(main.sql).toMatch(/\$2::numeric/);
    // Params: [uuid[], defaultMargin] — exactly two.
    expect(main.params).toHaveLength(2);
    expect(Array.isArray(main.params[0])).toBe(true);
    expect(main.params[0]).toEqual([VID]);
    expect(typeof main.params[1]).toBe('number');
  });

  it('R2. selected (multi): array param carries all ids, still only 2 bind slots', async () => {
    const { service, calls } = await makeService({
      responses: [SETTINGS_ROWS, [richRow(), richRow({ variant_id: VID2 })]],
    });
    await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID, VID2] },
      strategy: 'balanced',
    });
    const main = calls[1];
    expect(main.params).toHaveLength(2);
    expect(main.params[0]).toEqual([VID, VID2]);
  });

  it('R3. single scope: rich query bind shape is identical to selected', async () => {
    const { service, calls } = await makeService({
      responses: [SETTINGS_ROWS, [richRow()]],
    });
    await service.smartPricingPreview({
      scope: { type: 'single', variant_ids: [VID] },
      strategy: 'balanced',
    });
    const main = calls[1];
    expect(main.sql).toMatch(/ANY\(\$1::uuid\[\]\)/);
    expect(main.sql).toMatch(/\$2::numeric/);
    expect(main.params).toHaveLength(2);
  });

  it('R4. filtered scope (q + only_in_stock): scope SQL uses ::text cast + stock join', async () => {
    const { service, calls } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [{ variant_id: VID }],            // scope resolution
        [richRow()],                       // rich rows
      ],
    });
    await service.smartPricingPreview({
      scope: {
        type: 'filtered',
        filters: { q: 'حذاء', only_in_stock: true },
      },
      strategy: 'balanced',
    });
    const scopeSql = calls[1].sql;
    expect(scopeSql).toMatch(/ILIKE \$\d+::text/);
    expect(scopeSql).toMatch(/JOIN stock st ON st.variant_id = pv.id/);
    expect(scopeSql).toMatch(/st\.quantity_on_hand > 0/);
    // Rich-data query (3rd call) still has the same fixed bind shape.
    const main = calls[2];
    expect(main.sql).toMatch(/ANY\(\$1::uuid\[\]\)/);
    expect(main.sql).toMatch(/\$2::numeric/);
    expect(main.params).toHaveLength(2);
  });

  it('R5. filtered scope (supplier_id): SQL casts supplier filter to ::uuid', async () => {
    const supplier = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const { service, calls } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [{ variant_id: VID }],
        [richRow()],
      ],
    });
    await service.smartPricingPreview({
      scope: {
        type: 'filtered',
        filters: { supplier_id: supplier },
      },
      strategy: 'balanced',
    });
    const scopeSql = calls[1].sql;
    expect(scopeSql).toMatch(/pu_s\.supplier_id = \$\d+::uuid/);
    expect(calls[1].params).toContain(supplier);
  });

  it('R6. all scope (no filters): scope SQL has zero params, rich query keeps fixed bind shape', async () => {
    const { service, calls } = await makeService({
      responses: [
        SETTINGS_ROWS,
        [{ variant_id: VID }],
        [richRow()],
      ],
    });
    await service.smartPricingPreview({
      scope: { type: 'all' },
      strategy: 'balanced',
    });
    expect(calls[1].params).toEqual([]);
    // No bound placeholders in the all-scope resolution.
    expect(placeholdersIn(calls[1].sql)).toEqual([]);
    const main = calls[2];
    expect(main.sql).toMatch(/ANY\(\$1::uuid\[\]\)/);
    expect(main.params).toHaveLength(2);
  });

  it('R7. dangling-param regression: every $N in the main query has a param and vice versa', async () => {
    const { service, calls } = await makeService({
      responses: [SETTINGS_ROWS, [richRow()]],
    });
    await service.smartPricingPreview({
      scope: { type: 'selected', variant_ids: [VID] },
      strategy: 'balanced',
    });
    const main = calls[1];
    const refs = placeholdersIn(main.sql);
    // No gaps and no out-of-range references.
    expect(refs[0]).toBe(1);
    expect(refs[refs.length - 1]).toBe(main.params.length);
    // Sequence is exactly 1..N (no holes).
    refs.forEach((n, i) => expect(n).toBe(i + 1));
  });

  it('R8. static regex: main rich-query source contains ANY($1::uuid[]) and $2::numeric (no $3+)', () => {
    const SRC = readFileSync(
      join(__dirname, 'products.service.ts'),
      'utf8',
    );
    // Grab the literal template inside _smartPricingComputeRecommendations.
    const start = SRC.indexOf('_smartPricingComputeRecommendations');
    expect(start).toBeGreaterThan(-1);
    const blockEnd = SRC.indexOf('private async _resolveScope', start);
    const block = SRC.slice(start, blockEnd > -1 ? blockEnd : start + 6000);
    expect(block).toMatch(/ANY\(\$1::uuid\[\]\)/);
    expect(block).toMatch(/\$2::numeric/);
    // No $3, $4, … in the main query template — only $1 + $2 are used.
    expect(block).not.toMatch(/\$3\b/);
    expect(block).not.toMatch(/\$4\b/);
    expect(block).not.toMatch(/variantIds\.length \* 2/);
    // No IS NULL with a raw $-placeholder (defensive).
    expect(block).not.toMatch(/\$\d+\s+IS NULL/i);
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
