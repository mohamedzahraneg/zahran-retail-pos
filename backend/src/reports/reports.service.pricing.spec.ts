/**
 * reports.service.pricing.spec.ts — PR-PURCHASES-P3.4A
 *
 * Pins the four read-only pricing reports + the static guardrail
 * that none of them ever issue INSERT/UPDATE/DELETE.
 *
 * Coverage:
 *   1. pricingHealth: computes margin/markup/status from raw rows
 *   2. pricingHealth: status enum is correct for the 5 cases
 *   3. pricingHealth: zero cost → unknown_cost; zero price → no_price
 *   4. pricingHealth: status filter narrows the result
 *   5. pricingLosses: sorted by largest loss exposure
 *   6. pricingHistory: surfaces delta_amount/delta_pct + sorts desc
 *   7. pricingLandedImpact: derives needs_review from below-cost /
 *                           below-min-margin
 *   8. STATIC GUARDRAIL — the service code uses ONLY SELECT/WITH
 *                        queries for the new methods (no
 *                        INSERT/UPDATE/DELETE/ALTER/CREATE)
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReportsService } from './reports.service';

type QueryCall = { sql: string; params: any[] };

async function makeService(responses: Array<any[]> = []) {
  const queue = [...responses];
  const calls: QueryCall[] = [];
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return queue.length ? queue.shift() : [];
    }),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      ReportsService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  return { service: moduleRef.get(ReportsService), calls };
}

// ── 5 status fixtures: ok / below_cost / below_min_margin / no_price /
//    unknown_cost. All share product_id=p1.
const FIVE_VARIANTS = [
  // ok — margin 30%, well above floor 15%
  {
    variant_id: 'v-ok', sku: 'OK', barcode: null, color: null, size: null,
    product_id: 'p1', product_name: 'منتج', product_type: 'bag',
    cost_price: '100.00', selling_price: '142.86', min_margin_pct: '15.00',
    stock_qty: 5, stock_value_at_cost: '500.00',
  },
  // below_cost — sell < cost
  {
    variant_id: 'v-bc', sku: 'BC', barcode: null, color: null, size: null,
    product_id: 'p1', product_name: 'منتج', product_type: 'bag',
    cost_price: '100.00', selling_price: '80.00', min_margin_pct: '15.00',
    stock_qty: 3, stock_value_at_cost: '300.00',
  },
  // below_min_margin — margin 9% < 15% floor
  {
    variant_id: 'v-bm', sku: 'BM', barcode: null, color: null, size: null,
    product_id: 'p1', product_name: 'منتج', product_type: 'bag',
    cost_price: '100.00', selling_price: '110.00', min_margin_pct: '15.00',
    stock_qty: 2, stock_value_at_cost: '200.00',
  },
  // no_price — price = 0
  {
    variant_id: 'v-np', sku: 'NP', barcode: null, color: null, size: null,
    product_id: 'p1', product_name: 'منتج', product_type: 'bag',
    cost_price: '100.00', selling_price: '0', min_margin_pct: '15.00',
    stock_qty: 1, stock_value_at_cost: '100.00',
  },
  // unknown_cost — cost = 0
  {
    variant_id: 'v-uc', sku: 'UC', barcode: null, color: null, size: null,
    product_id: 'p1', product_name: 'منتج', product_type: 'bag',
    cost_price: '0', selling_price: '100.00', min_margin_pct: '15.00',
    stock_qty: 4, stock_value_at_cost: '0',
  },
];

describe('ReportsService.pricingHealth — P3.4A', () => {
  it('1. computes profit / markup_pct / margin_pct from raw rows', async () => {
    const { service } = await makeService([FIVE_VARIANTS]);
    const res = await service.pricingHealth();
    const ok = res.items.find((r: any) => r.variant_id === 'v-ok')!;
    expect(ok.profit).toBeCloseTo(42.86, 1);
    expect(ok.markup_pct).toBeCloseTo(42.86, 1);
    expect(ok.margin_pct).toBeCloseTo(30, 1);
    expect(ok.stock_qty).toBe(5);
    expect(ok.stock_value_at_cost).toBe(500);
    expect(ok.potential_revenue).toBeCloseTo(714.3, 0);
    expect(ok.potential_profit).toBeCloseTo(214.3, 0);
  });

  it('2. enum status reflects below_cost / below_min_margin / no_price / unknown_cost / ok', async () => {
    const { service } = await makeService([FIVE_VARIANTS]);
    const res = await service.pricingHealth();
    const by = Object.fromEntries(res.items.map((r: any) => [r.variant_id, r.status]));
    expect(by['v-ok']).toBe('ok');
    expect(by['v-bc']).toBe('below_cost');
    expect(by['v-bm']).toBe('below_min_margin');
    expect(by['v-np']).toBe('no_price');
    expect(by['v-uc']).toBe('unknown_cost');
    // Summary counts must be honest.
    expect(res.summary.below_cost).toBe(1);
    expect(res.summary.below_min_margin).toBe(1);
    expect(res.summary.no_price).toBe(1);
    expect(res.summary.unknown_cost).toBe(1);
    expect(res.summary.ok).toBe(1);
  });

  it('3. zero cost / zero price never trigger divide-by-zero', async () => {
    const { service } = await makeService([FIVE_VARIANTS]);
    const res = await service.pricingHealth();
    const np = res.items.find((r: any) => r.variant_id === 'v-np')!;
    const uc = res.items.find((r: any) => r.variant_id === 'v-uc')!;
    expect(np.margin_pct).toBeNull(); // price 0 → margin undefined
    expect(uc.markup_pct).toBeNull(); // cost 0 → markup undefined
    // Neither row crashes; both have a sensible status.
    expect(np.status).toBe('no_price');
    expect(uc.status).toBe('unknown_cost');
  });

  it('4. status filter narrows the result list', async () => {
    const { service } = await makeService([FIVE_VARIANTS]);
    const res = await service.pricingHealth({ status: 'below_cost' });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].variant_id).toBe('v-bc');
    expect(res.summary.below_cost).toBe(1);
  });

  it('5. SQL emitted is SELECT-only (no INSERT/UPDATE/DELETE) and reads from settings for min_margin default', async () => {
    const { service, calls } = await makeService([FIVE_VARIANTS]);
    await service.pricingHealth();
    expect(calls).toHaveLength(1);
    const sql = calls[0].sql;
    expect(sql).toMatch(/^\s*WITH\b/);
    expect(sql).toMatch(/FROM product_variants pv/);
    expect(sql).toMatch(/smart_pricing\.min_margin_pct_default/);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE)\b/i);
  });
});

describe('ReportsService.pricingLosses — P3.4A', () => {
  it('6. surfaces only loss / below-min-margin and sorts by exposure', async () => {
    const { service } = await makeService([FIVE_VARIANTS]);
    const res = await service.pricingLosses();
    expect(res.items.map((r: any) => r.variant_id).sort()).toEqual(
      ['v-bc', 'v-bm'].sort(),
    );
    const bc = res.items.find((r: any) => r.variant_id === 'v-bc')!;
    // Loss exposure: stock_qty 3 × profit (-20) = -60
    expect(bc.loss_exposure).toBe(-60);
    const bm = res.items.find((r: any) => r.variant_id === 'v-bm')!;
    expect(bm.margin_gap_pct).toBeGreaterThan(0);
    expect(res.summary.below_cost).toBe(1);
    expect(res.summary.below_min_margin).toBe(1);
    // Sorted: most-negative loss_exposure first.
    expect(res.items[0].variant_id).toBe('v-bc');
  });
});

describe('ReportsService.pricingHistory — P3.4A', () => {
  it('7. surfaces delta_amount, delta_pct, joins, and sorts desc', async () => {
    const rows = [
      {
        id: 'h1', variant_id: 'v1', sku: 'X', barcode: null,
        old_selling_price: '100.00', new_selling_price: '145.00',
        delta_amount: '45.00', delta_pct: '45.00',
        source_purchase_id: null, source_purchase_no: 'PO-2026-000001',
        reason: 'test', changed_by: null, changed_by_name: null,
        changed_at: '2026-05-17T08:00:00Z',
        product_id: 'p1', product_name: 'منتج',
      },
    ];
    const { service, calls } = await makeService([rows]);
    const res = await service.pricingHistory({ from: '2026-05-01', to: '2026-05-17' });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].delta_amount).toBe('45.00');
    expect(res.items[0].product_name).toBe('منتج');
    // SQL is SELECT-only and orders desc.
    expect(calls[0].sql).toMatch(/ORDER BY vph\.changed_at DESC/);
    expect(calls[0].sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });
});

describe('ReportsService.pricingLandedImpact — P3.4A', () => {
  it('8. derives needs_review from below-cost / below-min-margin', async () => {
    const rows = [
      // healthy
      {
        variant_id: 'v1', sku: 'A', barcode: null, product_id: 'p1', product_name: 'منتج',
        selling_price: '200', current_cost_price: '100',
        base_unit_cost: '90', allocated_cost_per_unit: '10',
        landed_unit_cost: '100',
        manual_allocation: false,
        purchase_id: 'pu1', purchase_no: 'PO-1', supplier_id: 's1', supplier_name: 'مورد',
        received_at: '2026-05-10', invoice_date: '2026-05-09',
        min_margin_pct: '15.00',
      },
      // below-cost
      {
        variant_id: 'v2', sku: 'B', barcode: null, product_id: 'p1', product_name: 'منتج',
        selling_price: '50', current_cost_price: '100',
        base_unit_cost: '95', allocated_cost_per_unit: '5',
        landed_unit_cost: '100',
        manual_allocation: false,
        purchase_id: 'pu2', purchase_no: 'PO-2', supplier_id: 's1', supplier_name: 'مورد',
        received_at: '2026-05-11', invoice_date: '2026-05-10',
        min_margin_pct: '15.00',
      },
    ];
    const { service, calls } = await makeService([rows]);
    const res = await service.pricingLandedImpact();
    expect(res.items[0].needs_review).toBe(false);
    expect(res.items[1].needs_review).toBe(true);
    expect(res.items[1].needs_review_reason).toBe('below_cost');
    expect(res.summary.needs_review).toBe(1);
    // SQL is SELECT-only.
    expect(calls[0].sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it('9. needs_review_only filter narrows to flagged rows', async () => {
    const rows = [
      {
        variant_id: 'v1', sku: 'A', barcode: null, product_id: 'p1', product_name: 'منتج',
        selling_price: '200', current_cost_price: '100',
        base_unit_cost: '100', allocated_cost_per_unit: '0',
        landed_unit_cost: '100',
        manual_allocation: false,
        purchase_id: 'pu1', purchase_no: 'PO-1', supplier_id: 's1', supplier_name: 'مورد',
        received_at: '2026-05-10', invoice_date: '2026-05-09',
        min_margin_pct: '15.00',
      },
      {
        variant_id: 'v2', sku: 'B', barcode: null, product_id: 'p1', product_name: 'منتج',
        selling_price: '50', current_cost_price: '100',
        base_unit_cost: '95', allocated_cost_per_unit: '5',
        landed_unit_cost: '100',
        manual_allocation: false,
        purchase_id: 'pu2', purchase_no: 'PO-2', supplier_id: 's1', supplier_name: 'مورد',
        received_at: '2026-05-11', invoice_date: '2026-05-10',
        min_margin_pct: '15.00',
      },
    ];
    const { service } = await makeService([rows]);
    const res = await service.pricingLandedImpact({ needs_review_only: true });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].variant_id).toBe('v2');
  });
});

describe('STATIC GUARDRAIL — P3.4A reports never write', () => {
  // Read the entire reports.service.ts source and slice out the four
  // new methods. Asserts the slice contains zero INSERT/UPDATE/DELETE/
  // ALTER/DROP/CREATE statements + zero calls to write-side service
  // methods we know about.
  const SRC = readFileSync(
    join(__dirname, 'reports.service.ts'),
    'utf8',
  );
  const startIdx = SRC.indexOf('PR-PURCHASES-P3.4A');
  // From the marker to end-of-file covers all 4 new methods.
  const slice = startIdx >= 0 ? SRC.slice(startIdx) : '';

  it('the new methods exist in the source', () => {
    expect(slice.length).toBeGreaterThan(1000);
    expect(slice).toMatch(/async pricingHealth\b/);
    expect(slice).toMatch(/async pricingLosses\b/);
    expect(slice).toMatch(/async pricingHistory\b/);
    expect(slice).toMatch(/async pricingLandedImpact\b/);
  });

  it('zero mutating SQL keywords in the P3.4A code slice', () => {
    // Negative-assertion text is in comments only; strip line comments
    // first so the docstring's "never INSERT/UPDATE/DELETE" lines
    // don't false-positive.
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(stripped).not.toMatch(/\bINSERT INTO\b/i);
    expect(stripped).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(stripped).not.toMatch(/\bDELETE FROM\b/i);
    expect(stripped).not.toMatch(/\bALTER TABLE\b/i);
    expect(stripped).not.toMatch(/\bDROP TABLE\b/i);
    expect(stripped).not.toMatch(/\bCREATE (TABLE|VIEW|INDEX|TRIGGER)\b/i);
  });

  it('zero references to write-side service helpers', () => {
    expect(slice).not.toMatch(/postPurchase\b/);
    expect(slice).not.toMatch(/applyVariantPrices\b/);
    expect(slice).not.toMatch(/reverseByReference\b/);
    expect(slice).not.toMatch(/recordTransaction\b/);
    expect(slice).not.toMatch(/financialEngine/i);
    expect(slice).not.toMatch(/\.transaction\(/);
  });

  it('only the expected forbidden-table mentions are inside comments / negative assertions', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    // None of these tables should appear in the executable code lines
    // (they're allowed inside doc comments only).
    expect(stripped).not.toMatch(/journal_entries\b/i);
    expect(stripped).not.toMatch(/journal_lines\b/i);
    expect(stripped).not.toMatch(/cashbox_transactions\b/i);
    expect(stripped).not.toMatch(/stock_movements\b/i);
    expect(stripped).not.toMatch(/supplier_ledger\b/i);
    expect(stripped).not.toMatch(/purchase_extra_costs\b/i);
    // `purchase_items` IS legitimately read by pricingLandedImpact, so
    // it's allowed — but only in SELECT contexts.
    expect(stripped).toMatch(/FROM purchase_items\b/);
  });
});
