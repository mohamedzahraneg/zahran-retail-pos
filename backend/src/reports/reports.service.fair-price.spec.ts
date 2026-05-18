/**
 * reports.service.fair-price.spec.ts — PR-P8.1
 *
 * Pins the Fair Price Report:
 *   · Allocation bases (revenue_share / units_share /
 *     stock_value_share / flat_per_sku) compute the per-variant share
 *     correctly.
 *   · Overhead sources (actual_expenses, recurring_monthly_equivalent
 *     including custom_days) compute the right total.
 *   · Period filter applies to BOTH overhead and sales aggregates.
 *   · Edge cases: zero overhead, zero sales (warning + floor=1),
 *     zero cost (warning).
 *   · Validation: target margin bounds, basis/source whitelists.
 *   · Truncation metadata correct when result > limit.
 *
 * STATIC GUARDRAIL — the fairPrice() method block contains:
 *   · zero INSERT / UPDATE / DELETE statements
 *   · zero `selling_price =` / `cost_price =` writes
 *   · zero references to journal_entries / journal_lines /
 *     cashbox_transactions / cashbox_balances / stock_movements /
 *     supplier_ledger / supplier_payments
 *   · zero references to postPurchase / recordTransaction /
 *     financialEngine / posting.service
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
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
  return { service: moduleRef.get(ReportsService), calls, ds };
}

const V1 = '11111111-1111-1111-1111-111111111111';
const V2 = '22222222-2222-2222-2222-222222222222';
const P1 = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const P2 = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

function variantRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    variant_id: V1,
    product_id: P1,
    product_name: 'منتج ألف',
    sku: 'A-1',
    barcode: null,
    category_name: null,
    current_cost_price: '50.00',
    current_selling_price: '100.00',
    units_sold_in_period: 10,
    revenue_in_period: '1000.00',
    stock_on_hand: 5,
    ...overrides,
  };
}

/** Queue shape for happy path:
 *   1. settings lookup (recommended_margin_pct)              → 1 row
 *   2. overhead SUM(expenses.amount)                          → 1 row
 *   3. variant rows (DISTINCT pv + sales + stock CTEs)        → N rows
 *   4. total_candidates SELECT COUNT(*) (separate query)      → 1 row
 */

describe('ReportsService.fairPrice — allocation bases (P8.1)', () => {
  const TWO_VARIANTS = [
    variantRow({
      variant_id: V1,
      product_id: P1,
      product_name: 'منتج ألف',
      sku: 'A-1',
      current_cost_price: '50.00',
      current_selling_price: '100.00',
      units_sold_in_period: 30,
      revenue_in_period: '3000.00',
      stock_on_hand: 10,
    }),
    variantRow({
      variant_id: V2,
      product_id: P2,
      product_name: 'منتج باء',
      sku: 'B-1',
      current_cost_price: '80.00',
      current_selling_price: '150.00',
      units_sold_in_period: 10,
      revenue_in_period: '1500.00',
      stock_on_hand: 5,
    }),
  ];

  it('revenue_share splits overhead by revenue ratio (3000:1500 → 0.667:0.333)', async () => {
    const { service } = await makeService({
      responses: [
        [{ value: '30' }],            // settings recommended_margin_pct
        [{ s: '900' }],               // overhead = 900 EGP
        TWO_VARIANTS,                 // variant rows
        [{ n: 2 }],                   // count
      ],
    });
    const res = await service.fairPrice({
      allocation_basis: 'revenue_share',
      from: '2026-05-01',
      to: '2026-05-31',
    });
    expect(res.items).toHaveLength(2);
    expect(res.items[0].allocation_weight).toBeCloseTo(0.6667, 3);
    expect(res.items[1].allocation_weight).toBeCloseTo(0.3333, 3);
    // overhead_share = 900 × 2/3 = 600 ; per-unit = 600/30 = 20
    expect(res.items[0].overhead_share).toBeCloseTo(600, 2);
    expect(res.items[0].overhead_per_unit).toBeCloseTo(20, 2);
    expect(res.items[1].overhead_share).toBeCloseTo(300, 2);
    expect(res.items[1].overhead_per_unit).toBeCloseTo(30, 2);
  });

  it('units_share splits overhead by units sold (30:10 → 0.75:0.25)', async () => {
    const { service } = await makeService({
      responses: [
        [{ value: '30' }],
        [{ s: '400' }],
        TWO_VARIANTS,
        [{ n: 2 }],
      ],
    });
    const res = await service.fairPrice({ allocation_basis: 'units_share' });
    expect(res.items[0].allocation_weight).toBeCloseTo(0.75, 3);
    expect(res.items[1].allocation_weight).toBeCloseTo(0.25, 3);
    expect(res.items[0].overhead_share).toBeCloseTo(300, 2);
    expect(res.items[1].overhead_share).toBeCloseTo(100, 2);
  });

  it('stock_value_share splits overhead by stock × cost (500:400 → 5/9:4/9)', async () => {
    const { service } = await makeService({
      responses: [
        [{ value: '30' }],
        [{ s: '900' }],
        TWO_VARIANTS,
        [{ n: 2 }],
      ],
    });
    const res = await service.fairPrice({
      allocation_basis: 'stock_value_share',
    });
    expect(res.items[0].allocation_weight).toBeCloseTo(500 / 900, 3);
    expect(res.items[1].allocation_weight).toBeCloseTo(400 / 900, 3);
    expect(res.items[0].overhead_share).toBeCloseTo(500, 2);
    expect(res.items[1].overhead_share).toBeCloseTo(400, 2);
  });

  it('flat_per_sku splits overhead equally (0.5:0.5)', async () => {
    const { service } = await makeService({
      responses: [
        [{ value: '30' }],
        [{ s: '400' }],
        TWO_VARIANTS,
        [{ n: 2 }],
      ],
    });
    const res = await service.fairPrice({ allocation_basis: 'flat_per_sku' });
    expect(res.items[0].allocation_weight).toBeCloseTo(0.5, 3);
    expect(res.items[1].allocation_weight).toBeCloseTo(0.5, 3);
    expect(res.items[0].overhead_share).toBeCloseTo(200, 2);
    expect(res.items[1].overhead_share).toBeCloseTo(200, 2);
  });
});

describe('ReportsService.fairPrice — overhead source (P8.1)', () => {
  it('actual_expenses sums expenses.amount in period (queried in $1..$2)', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ value: '30' }],
        [{ s: '750' }],
        [variantRow()],
        [{ n: 1 }],
      ],
    });
    await service.fairPrice({
      overhead_source: 'actual_expenses',
      from: '2026-05-01',
      to: '2026-05-31',
    });
    const expensesCall = calls.find((c) =>
      /FROM expenses[\s\S]*WHERE expense_date >= \$1::date/.test(c.sql),
    );
    expect(expensesCall).toBeDefined();
    expect(expensesCall!.params).toEqual(['2026-05-01', '2026-05-31']);
  });

  it('recurring_monthly_equivalent scales each active template by its cycle', async () => {
    const { service } = await makeService({
      responses: [
        [{ value: '30' }],
        [{ days: 30 }], // period length
        [
          { amount: '300.00', frequency: 'monthly', custom_interval_days: null },
          { amount: '7.00', frequency: 'daily', custom_interval_days: null },
          { amount: '600.00', frequency: 'custom_days', custom_interval_days: 60 },
        ],
        [variantRow()],
        [{ n: 1 }],
      ],
    });
    const res = await service.fairPrice({
      overhead_source: 'recurring_monthly_equivalent',
    });
    // 30-day period:
    //   monthly 300 × 30/30 = 300
    //   daily 7     × 30/1  = 210
    //   custom 600  × 30/60 = 300
    // Total = 810
    expect(res.summary.overhead_total).toBeCloseTo(810, 2);
  });

  it('recurring_monthly_equivalent skips custom_days with non-positive interval', async () => {
    const { service } = await makeService({
      responses: [
        [{ value: '30' }],
        [{ days: 30 }],
        [
          { amount: '50.00', frequency: 'monthly', custom_interval_days: null },
          { amount: '999.00', frequency: 'custom_days', custom_interval_days: 0 },
          { amount: '999.00', frequency: 'custom_days', custom_interval_days: null },
        ],
        [variantRow()],
        [{ n: 1 }],
      ],
    });
    const res = await service.fairPrice({
      overhead_source: 'recurring_monthly_equivalent',
    });
    // Only the monthly 50 survives.
    expect(res.summary.overhead_total).toBeCloseTo(50, 2);
  });
});

describe('ReportsService.fairPrice — formula edge cases (P8.1)', () => {
  it('zero overhead → fair_price = cost_price / (1 - margin/100)', async () => {
    const { service } = await makeService({
      responses: [
        [{ value: '30' }],
        [{ s: '0' }],
        [variantRow({ current_cost_price: '70.00' })],
        [{ n: 1 }],
      ],
    });
    const res = await service.fairPrice({});
    expect(res.items[0].overhead_per_unit).toBe(0);
    expect(res.items[0].break_even_price).toBe(70);
    // 70 / (1 - 0.30) = 100
    expect(res.items[0].fair_price).toBeCloseTo(100, 2);
  });

  it('zero sales → expected_units floors to 1, warning=no_sales_in_period', async () => {
    const { service } = await makeService({
      responses: [
        [{ value: '30' }],
        [{ s: '50' }],
        [
          variantRow({
            units_sold_in_period: 0,
            revenue_in_period: '0.00',
          }),
        ],
        [{ n: 1 }],
      ],
    });
    const res = await service.fairPrice({ allocation_basis: 'flat_per_sku' });
    // total_basis (flat_per_sku, 1 row) = 1 → weight = 1 → overhead_share = 50
    // floor expected_units = 1 → overhead_per_unit = 50
    expect(res.items[0].overhead_per_unit).toBe(50);
    expect(res.items[0].warning).toBe('no_sales_in_period');
  });

  it('zero cost → warning=cost_zero', async () => {
    const { service } = await makeService({
      responses: [
        [{ value: '30' }],
        [{ s: '0' }],
        [variantRow({ current_cost_price: '0.00' })],
        [{ n: 1 }],
      ],
    });
    const res = await service.fairPrice({});
    expect(res.items[0].warning).toBe('cost_zero');
  });

  it('no_stock warning fires only for stock_value_share basis', async () => {
    const baseRow = variantRow({ stock_on_hand: 0 });
    const { service: a } = await makeService({
      responses: [
        [{ value: '30' }],
        [{ s: '100' }],
        [baseRow],
        [{ n: 1 }],
      ],
    });
    const resStock = await a.fairPrice({
      allocation_basis: 'stock_value_share',
    });
    expect(resStock.items[0].warning).toBe('no_stock');

    const { service: b } = await makeService({
      responses: [
        [{ value: '30' }],
        [{ s: '100' }],
        [baseRow],
        [{ n: 1 }],
      ],
    });
    const resRev = await b.fairPrice({
      allocation_basis: 'revenue_share',
    });
    // stock=0 but basis=revenue_share → don't surface no_stock
    expect(resRev.items[0].warning).not.toBe('no_stock');
  });
});

describe('ReportsService.fairPrice — validation + truncation (P8.1)', () => {
  it('rejects target_margin_pct < 0', async () => {
    const { service } = await makeService({});
    await expect(
      service.fairPrice({ target_margin_pct: -1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects target_margin_pct >= 95', async () => {
    const { service } = await makeService({});
    await expect(
      service.fairPrice({ target_margin_pct: 95 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    const { service: s2 } = await makeService({});
    await expect(
      s2.fairPrice({ target_margin_pct: 99 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects invalid allocation_basis', async () => {
    const { service } = await makeService({});
    await expect(
      service.fairPrice({ allocation_basis: 'bogus' as any }),
    ).rejects.toMatchObject({ message: 'طريقة التوزيع غير صالحة' });
  });

  it('rejects invalid overhead_source', async () => {
    const { service } = await makeService({});
    await expect(
      service.fairPrice({ overhead_source: 'magic' as any }),
    ).rejects.toMatchObject({
      message: 'مصدر التكاليف التشغيلية غير صالح',
    });
  });

  it('falls back to 30 when settings lookup throws', async () => {
    const ds: any = {
      query: jest.fn(async (sql: string) => {
        if (/FROM settings/.test(sql)) throw new Error('no settings table');
        if (/FROM expenses/.test(sql)) return [{ s: '0' }];
        if (/COUNT\(DISTINCT pv.id\)/.test(sql)) return [{ n: 1 }];
        return [variantRow({ current_cost_price: '70.00' })];
      }),
      transaction: jest.fn(),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReportsService,
        { provide: DataSource, useValue: ds },
      ],
    }).compile();
    const service = moduleRef.get(ReportsService);
    const res = await service.fairPrice({});
    expect(res.summary.target_margin_pct).toBe(30);
    expect(res.items[0].fair_price).toBeCloseTo(100, 2);
  });

  it('truncates when rows > limit and reports truncation metadata', async () => {
    const ROWS = Array.from({ length: 5 }, (_, i) =>
      variantRow({
        variant_id: `${i}1111111-1111-1111-1111-111111111111`,
        sku: `SKU-${i}`,
      }),
    );
    const { service } = await makeService({
      responses: [
        [{ value: '30' }],
        [{ s: '100' }],
        ROWS,         // 5 rows returned (limit=2 → query asked for 3, mock returns all 5)
        [{ n: 5 }],
      ],
    });
    const res = await service.fairPrice({ limit: 2 });
    expect(res.summary.returned_count).toBe(2);
    expect(res.summary.truncated).toBe(true);
    expect(res.summary.message_ar).toMatch(/تم عرض/);
  });

  it('summary carries period + source + basis + target_margin + advisory', async () => {
    const { service } = await makeService({
      responses: [
        [{ value: '25' }],
        [{ s: '100' }],
        [variantRow()],
        [{ n: 1 }],
      ],
    });
    const res = await service.fairPrice({
      from: '2026-05-01',
      to: '2026-05-31',
      allocation_basis: 'units_share',
      overhead_source: 'actual_expenses',
    });
    expect(res.summary.from).toBe('2026-05-01');
    expect(res.summary.to).toBe('2026-05-31');
    expect(res.summary.allocation_basis).toBe('units_share');
    expect(res.summary.overhead_source).toBe('actual_expenses');
    expect(res.summary.target_margin_pct).toBe(25);
    expect(res.summary.advisory).toMatch(/تقرير استرشادي فقط/);
  });
});

describe('STATIC GUARDRAIL — fair-price write footprint (P8.1)', () => {
  const SRC = readFileSync(join(__dirname, 'reports.service.ts'), 'utf8');
  const startMatch = SRC.match(/PR-P8\.1 — Fair Price Report/);
  const endMatch = SRC.match(/^}\s*$/m);
  const startIdx = startMatch?.index ?? -1;
  const endIdx = endMatch?.index ?? -1;
  const slice =
    startIdx >= 0 && endIdx > startIdx ? SRC.slice(startIdx, endIdx) : '';

  it('the fairPrice() block exists', () => {
    expect(slice.length).toBeGreaterThan(500);
    expect(slice).toMatch(/async fairPrice\b/);
  });

  it('zero INSERT / UPDATE / DELETE statements in the block', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(stripped).not.toMatch(/\bINSERT INTO\b/i);
    expect(stripped).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(stripped).not.toMatch(/\bDELETE FROM\b/i);
    expect(stripped).not.toMatch(/\bALTER TABLE\b/i);
    expect(stripped).not.toMatch(/\bDROP TABLE\b/i);
  });

  it('no `selling_price =` / `cost_price =` writes', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    // Word-boundary anchors keep the regex from matching the local JS
    // identifiers `current_selling_price` / `current_cost_price` which
    // are pure READS (Number(r.current_selling_price)).
    expect(stripped).not.toMatch(/\bselling_price\s*=/i);
    expect(stripped).not.toMatch(/\bcost_price\s*=/i);
  });

  it('no journal / cashbox / stock / supplier ledger references', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(stripped).not.toMatch(/journal_entries\b/i);
    expect(stripped).not.toMatch(/journal_lines\b/i);
    expect(stripped).not.toMatch(/cashbox_transactions\b/i);
    expect(stripped).not.toMatch(/cashbox_balances\b/i);
    expect(stripped).not.toMatch(/stock_movements\b/i);
    expect(stripped).not.toMatch(/supplier_ledger\b/i);
    expect(stripped).not.toMatch(/supplier_payments\b/i);
    expect(stripped).not.toMatch(/supplier_payment_allocations\b/i);
  });

  it('no forbidden helper / engine references', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(stripped).not.toMatch(/postPurchase\b/);
    expect(stripped).not.toMatch(/postSupplierPayment\b/);
    expect(stripped).not.toMatch(/postInvoiceEdit\b/);
    expect(stripped).not.toMatch(/reverseByReference\b/);
    expect(stripped).not.toMatch(/recordTransaction\b/);
    expect(stripped).not.toMatch(/financialEngine/i);
    expect(stripped).not.toMatch(/posting\.service\b/);
    expect(stripped).not.toMatch(/fn_void_purchase\b/);
    expect(stripped).not.toMatch(/fn_record_cashbox_txn\b/);
  });
});
