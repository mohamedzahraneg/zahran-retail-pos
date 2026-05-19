/**
 * products.service.cost-adjustment.spec.ts — PR-PURCHASES-P3.6A
 *
 * Pins the Smart Cost Adjustment Assistant (preview + apply):
 *   · formula correctness for all 5 adjustment types
 *   · negative-result clamping (cost cannot dip below 0)
 *   · per-row skip when |new − current| < 0.01
 *   · apply transaction footprint: one UPDATE product_variants
 *     + one INSERT variant_cost_history per changed row, all under
 *     a single batch_id
 *   · validation: reject percent > 500, reject negative value,
 *     reject batch > 500, reject empty reason
 *   · static guardrail — the P3.6A block writes ONLY to
 *     product_variants.cost_price + variant_cost_history. No journal,
 *     no cashbox, no stock, no supplier, no invoice, no purchase.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
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
  const inner = jest.fn(async (_sql: string, _params: any[] = []) => {
    return queue.length ? queue.shift() : [];
  });
  const innerCalls: QueryCall[] = [];
  const innerWrapped = jest.fn(async (sql: string, params: any[] = []) => {
    innerCalls.push({ sql, params });
    return inner(sql, params);
  });
  const outerCalls: QueryCall[] = [];
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      outerCalls.push({ sql, params });
      return queue.length ? queue.shift() : [];
    }),
    transaction: jest.fn(async (cb: any) => cb({ query: innerWrapped })),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ProductsService,
      { provide: DataSource, useValue: ds },
      { provide: getRepositoryToken(ProductEntity), useValue: {} },
      { provide: getRepositoryToken(VariantEntity), useValue: {} },
    ],
  }).compile();
  return {
    service: moduleRef.get(ProductsService),
    calls: outerCalls,
    innerCalls,
    ds,
  };
}

const VID = '11111111-1111-1111-1111-111111111111';
const VID2 = '22222222-2222-2222-2222-222222222222';
const PID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER = '99999999-9999-9999-9999-999999999999';
const BATCH = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function previewRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    variant_id: VID,
    product_id: PID,
    product_name: 'منتج تجريبي',
    sku: 'SKU-1',
    barcode: null,
    category_name: null,
    current_cost_price: '100.00',
    stock_on_hand: 10,
    ...overrides,
  };
}

describe('costAdjustmentPreview — formulas (P3.6A)', () => {
  it.each([
    ['fixed_increase', 10, 110, 10, 10],
    ['fixed_decrease', 20, 80, -20, -20],
    ['percent_increase', 10, 110, 10, 10],
    ['percent_decrease', 25, 75, -25, -25],
    ['set_exact', 150, 150, 50, 50],
  ] as const)(
    '%s of %s → new cost %s, delta %s (pct %s)',
    async (type, value, expectNew, expectDelta, expectPct) => {
      // Selected scope skips the resolve queries entirely — the rich
      // query is the FIRST ds.query call.
      const { service } = await makeService({
        responses: [[previewRow()]],
      });
      const res = await service.costAdjustmentPreview({
        scope: 'selected',
        variant_ids: [VID],
        adjustment_type: type as any,
        adjustment_value: value,
      } as any);
      expect(res.items).toHaveLength(1);
      const item = res.items[0];
      expect(item.new_cost_price).toBeCloseTo(expectNew, 2);
      expect(item.delta_amount).toBeCloseTo(expectDelta, 2);
      expect(item.delta_pct).toBeCloseTo(expectPct, 2);
    },
  );

  it('clamps negative result to 0 and surfaces a warning', async () => {
    const { service } = await makeService({
      responses: [[previewRow({ current_cost_price: '50.00' })]],
    });
    const res = await service.costAdjustmentPreview({
      scope: 'selected',
      variant_ids: [VID],
      adjustment_type: 'fixed_decrease',
      adjustment_value: 200,
    } as any);
    expect(res.items[0].new_cost_price).toBe(0);
    expect(res.items[0].warning).toMatch(/سالبة|صفر/);
  });

  it('flags the "unknown current cost" warning when current=0 and result > 0', async () => {
    const { service } = await makeService({
      responses: [[previewRow({ current_cost_price: '0.00' })]],
    });
    // set_exact with current=0 yields a positive new cost but
    // delta_pct stays null (can't divide by 0).
    const res = await service.costAdjustmentPreview({
      scope: 'selected',
      variant_ids: [VID],
      adjustment_type: 'set_exact',
      adjustment_value: 75,
    } as any);
    expect(res.items[0].new_cost_price).toBe(75);
    expect(res.items[0].delta_pct).toBeNull();
    expect(res.items[0].warning).toMatch(/التكلفة الحالية غير معروفة/);
  });

  it('marks the preview as truncated when limit < candidates', async () => {
    const { service } = await makeService({
      responses: [
        [{ n: 5 }], // _resolveCostScope COUNT
        [{ variant_id: VID }], // _resolveCostScope list
        [previewRow()], // rich rows
      ],
    });
    const res = await service.costAdjustmentPreview({
      scope: 'filtered',
      filters: { q: 'foo' },
      adjustment_type: 'percent_increase',
      adjustment_value: 5,
      limit: 1,
    } as any);
    expect(res.summary.truncated).toBe(true);
    expect(res.summary.total_candidates).toBe(5);
    expect(res.summary.returned_count).toBe(1);
    expect(res.summary.message_ar).toMatch(/تم عرض/);
  });

  it('rejects percent > 500', async () => {
    const { service } = await makeService();
    await expect(
      service.costAdjustmentPreview({
        scope: 'selected',
        variant_ids: [VID],
        adjustment_type: 'percent_increase',
        adjustment_value: 600,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects zero value for non-set_exact', async () => {
    const { service } = await makeService();
    await expect(
      service.costAdjustmentPreview({
        scope: 'selected',
        variant_ids: [VID],
        adjustment_type: 'fixed_increase',
        adjustment_value: 0,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects selected scope with empty variant_ids', async () => {
    const { service } = await makeService();
    await expect(
      service.costAdjustmentPreview({
        scope: 'selected',
        variant_ids: [],
        adjustment_type: 'fixed_increase',
        adjustment_value: 5,
      } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('costAdjustmentApply — transaction footprint (P3.6A)', () => {
  it('writes ONLY UPDATE product_variants + INSERT variant_cost_history under a single batch_id', async () => {
    const { service, innerCalls } = await makeService({
      responses: [
        [{ batch_id: BATCH }], // gen_random_uuid
        [{ id: VID, cost_price: '100.00' }], // SELECT FOR UPDATE
        [], // UPDATE product_variants
        [{ id: 'hist-1' }], // INSERT history
        [{ id: VID2, cost_price: '50.00' }],
        [],
        [{ id: 'hist-2' }],
      ],
    });
    const res = await service.costAdjustmentApply(
      {
        scope: 'selected',
        adjustment_type: 'percent_increase',
        adjustment_value: 10,
        variant_ids_to_apply: [VID, VID2],
        reason: 'تحديث قائمة الموردين',
      } as any,
      USER,
    );
    expect(res.updated).toBe(2);
    expect(res.skipped).toBe(0);
    expect(res.batch_id).toBe(BATCH);

    const sqls = innerCalls.map((c) => c.sql);
    // No forbidden write tables.
    for (const sql of sqls) {
      expect(sql).not.toMatch(/journal_entries|journal_lines/i);
      expect(sql).not.toMatch(/cashbox_transactions|cashbox_balances/i);
      expect(sql).not.toMatch(/stock_movements/i);
      expect(sql).not.toMatch(/UPDATE\s+stock\b/i);
      expect(sql).not.toMatch(/supplier_ledger|supplier_payments/i);
      expect(sql).not.toMatch(/INSERT INTO\s+purchases\b/i);
      expect(sql).not.toMatch(/UPDATE\s+purchases\b/i);
      expect(sql).not.toMatch(/invoice_items\s*SET/i);
      expect(sql).not.toMatch(/purchase_items\s*SET/i);
      expect(sql).not.toMatch(/selling_price\s*=/i);
    }
    // Allowed writes: UPDATE product_variants (cost_price only) + INSERT variant_cost_history.
    const inserts = sqls.filter((s) => /INSERT INTO/i.test(s));
    expect(inserts.length).toBe(2);
    for (const ins of inserts) {
      expect(ins).toMatch(/INSERT INTO\s+variant_cost_history/i);
    }
    // Match the actual UPDATE statements, not SELECT...FOR UPDATE.
    const updates = sqls.filter((s) =>
      /\bUPDATE\s+\w+\s+SET\b/i.test(s),
    );
    expect(updates.length).toBe(2);
    for (const upd of updates) {
      expect(upd).toMatch(/UPDATE\s+product_variants/i);
      expect(upd).toMatch(/cost_price\s*=/i);
      expect(upd).not.toMatch(/selling_price/i);
    }
    // Every history row shares the same batch_id.
    const historyParams = innerCalls
      .filter((c) => /INSERT INTO\s+variant_cost_history/i.test(c.sql))
      .map((c) => c.params);
    expect(historyParams.length).toBe(2);
    expect(historyParams[0]).toContain(BATCH);
    expect(historyParams[1]).toContain(BATCH);
  });

  it('skips a variant whose computed new cost matches current within 0.01', async () => {
    const { service, innerCalls } = await makeService({
      responses: [
        [{ batch_id: BATCH }],
        // current = 100, percent_increase 0.001 → ~100.001 → rounds to 100 → skip
        [{ id: VID, cost_price: '100.00' }],
      ],
    });
    const res = await service.costAdjustmentApply(
      {
        scope: 'selected',
        adjustment_type: 'percent_increase',
        adjustment_value: 0.001,
        variant_ids_to_apply: [VID],
        reason: 'no-op smoke',
      } as any,
      USER,
    );
    expect(res.updated).toBe(0);
    expect(res.skipped).toBe(1);
    const writeCalls = innerCalls.filter(
      (c) => /UPDATE|INSERT/i.test(c.sql) && !/SELECT/i.test(c.sql),
    );
    // Only the SELECT FOR UPDATE + batch_id select happened — no write.
    expect(writeCalls.length).toBe(0);
  });

  it('rejects when variant_ids_to_apply exceeds 500', async () => {
    const { service } = await makeService();
    const ids = Array.from(
      { length: 501 },
      (_, i) =>
        `${i.toString(16).padStart(8, '0')}-0000-0000-0000-000000000000`,
    );
    await expect(
      service.costAdjustmentApply(
        {
          scope: 'selected',
          adjustment_type: 'percent_increase',
          adjustment_value: 5,
          variant_ids_to_apply: ids,
          reason: 'big batch',
        } as any,
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects empty reason', async () => {
    const { service } = await makeService();
    await expect(
      service.costAdjustmentApply(
        {
          scope: 'selected',
          adjustment_type: 'percent_increase',
          adjustment_value: 5,
          variant_ids_to_apply: [VID],
          reason: '  ',
        } as any,
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects negative adjustment value', async () => {
    const { service } = await makeService();
    await expect(
      service.costAdjustmentApply(
        {
          scope: 'selected',
          adjustment_type: 'fixed_increase',
          adjustment_value: -5,
          variant_ids_to_apply: [VID],
          reason: 'bad value',
        } as any,
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe('STATIC GUARDRAIL — cost-adjustment write footprint (P3.6A)', () => {
  const SRC = readFileSync(
    join(__dirname, 'products.service.ts'),
    'utf8',
  );
  // The P3.6A method-block marker is unique (no need for "last match"
  // disambiguation). Slice from that marker to the next phase marker
  // or end-of-file.
  const startIdx = SRC.indexOf('PR-PURCHASES-P3.6A');
  // Find the NEXT phase marker after P3.6A to bound the slice — that
  // way future P3.6B/P3.7 work won't drag unrelated code into this
  // guardrail. PR-FIX-INVENTORY-API-FOUNDATION added two read-only
  // methods (getProduct360/getProductMatrix) to the same file; the
  // marker below stops their `stock_movements` and `INSERT INTO`
  // references (purely SELECT-side joins) from leaking into the
  // cost-adjustment write-footprint slice.
  const candidates = [
    'PR-PURCHASES-P3.6B',
    'PR-PURCHASES-P3.7',
    'PR-FIX-INVENTORY-API-FOUNDATION',
  ];
  const ends = candidates
    .map((m) => SRC.indexOf(m, startIdx + 1))
    .filter((i) => i > 0);
  const endIdx = ends.length > 0 ? Math.min(...ends) : -1;
  const slice =
    startIdx >= 0
      ? endIdx > startIdx
        ? SRC.slice(startIdx, endIdx)
        : SRC.slice(startIdx)
      : '';

  it('the new methods exist in the source', () => {
    expect(slice).toMatch(/async costAdjustmentPreview\b/);
    expect(slice).toMatch(/async costAdjustmentApply\b/);
    expect(slice).toMatch(/private _computeNewCost\b/);
    expect(slice).toMatch(/private _validateAdjustment\b/);
    expect(slice).toMatch(/private async _resolveCostScope\b/);
  });

  it('only writes to product_variants.cost_price + variant_cost_history', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    const inserts = stripped.match(/INSERT INTO\s+(\w+)/gi) || [];
    for (const ins of inserts) {
      expect(ins).toMatch(/INSERT INTO\s+variant_cost_history/i);
    }
    const updates = stripped.match(/UPDATE\s+(\w+)\s+SET/gi) || [];
    for (const upd of updates) {
      expect(upd).toMatch(/UPDATE\s+product_variants\s+SET/i);
    }
    expect(stripped).not.toMatch(/\bDELETE FROM\b/i);
    expect(stripped).not.toMatch(/\bALTER TABLE\b/i);
    expect(stripped).not.toMatch(/\bDROP TABLE\b/i);
    expect(stripped).not.toMatch(/\bCREATE (TABLE|VIEW|INDEX|TRIGGER)\b/i);
  });

  it('NEVER writes to product_variants.selling_price (P3.6A is cost-only)', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    // Cost block should not assign selling_price.
    expect(stripped).not.toMatch(/selling_price\s*=/i);
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
    expect(stripped).not.toMatch(/cashbox_balances\b/i);
    expect(stripped).not.toMatch(/stock_movements\b/i);
    expect(stripped).not.toMatch(/supplier_ledger\b/i);
    expect(stripped).not.toMatch(/supplier_payments\b/i);
    expect(stripped).not.toMatch(/purchase_extra_costs\b/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+purchases\b/i);
    expect(stripped).not.toMatch(/UPDATE\s+purchases\b/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+invoices\b/i);
    expect(stripped).not.toMatch(/UPDATE\s+invoices\b/i);
    expect(stripped).not.toMatch(/UPDATE\s+invoice_items\b/i);
    expect(stripped).not.toMatch(/UPDATE\s+purchase_items\b/i);
    // The "stock" table is read (preview joins stock for inventory_value rollup),
    // but never WRITTEN. avg_cost in particular must not be touched.
    expect(stripped).not.toMatch(/\bUPDATE\s+stock\b/i);
    expect(stripped).not.toMatch(/stock\.avg_cost/i);
    expect(stripped).not.toMatch(/avg_cost\s*=/i);
    // No price-history write either — that's the P3.5A surface.
    expect(stripped).not.toMatch(/INSERT INTO\s+variant_price_history/i);
  });
});
