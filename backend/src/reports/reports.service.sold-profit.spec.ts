/**
 * reports.service.sold-profit.spec.ts — PR-PURCHASES-P3.4B
 *
 * Pins the three read-only sold-profit reports + the static
 * guardrail asserting they never issue INSERT/UPDATE/DELETE and
 * never write to any non-settings table.
 *
 * Coverage:
 *   1. soldProfitSummary — totals + counts + top/worst products
 *   2. soldProfitSummary — zero-revenue returns gross_margin_pct: null
 *   3. soldProfitSummary — emitted SQL filters returns + status
 *   4. soldProfitProducts — per-variant aggregation + status enum
 *   5. soldProfitProducts — sort override
 *   6. soldProfitProducts — status filter narrows the result
 *   7. soldProfitInvoices — per-invoice aggregation + status
 *   8. soldProfitInvoices — invoice-level summary tallies
 *   9. STATIC GUARDRAIL — P3.4B code slice has zero mutating SQL,
 *                       zero references to write-side service helpers,
 *                       zero references to forbidden tables in
 *                       executable lines, only SELECTs from the
 *                       allowed source set.
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

describe('ReportsService.soldProfitSummary — P3.4B', () => {
  it('1. surfaces totals + counts + top/worst products', async () => {
    const { service, calls } = await makeService([
      // First query: totals
      [
        {
          total_revenue: '1000.00',
          total_cogs: '600.00',
          gross_profit: '400.00',
          total_qty_sold: 20,
          invoice_count: 5,
          product_count: 3,
          variant_count: 4,
        },
      ],
      // Top profit product
      [{ product_id: 'p-top', product_name: 'منتج رابح', gross_profit: '400.00' }],
      // Worst margin product
      [
        {
          product_id: 'p-worst',
          product_name: 'منتج خاسر',
          revenue: '100.00',
          cogs: '120.00',
          gross_profit: '-20.00',
          gross_margin_pct: '-20.00',
        },
      ],
    ]);
    const res = await service.soldProfitSummary({ from: '2026-05-01', to: '2026-05-17' });
    expect(res.total_revenue).toBe(1000);
    expect(res.total_cogs).toBe(600);
    expect(res.gross_profit).toBe(400);
    expect(res.gross_margin_pct).toBe(40); // 400/1000 * 100
    expect(res.markup_pct).toBeCloseTo(66.67, 1); // 400/600 * 100
    expect(res.total_qty_sold).toBe(20);
    expect(res.invoice_count).toBe(5);
    expect(res.product_count).toBe(3);
    expect(res.variant_count).toBe(4);
    expect(res.avg_profit_per_unit).toBe(20); // 400/20
    expect(res.top_profit_product?.product_name).toBe('منتج رابح');
    expect(res.worst_margin_product?.gross_margin_pct).toBe(-20);
    // SQL is SELECT-only and filters returns.
    expect(calls).toHaveLength(3);
    for (const c of calls) {
      expect(c.sql).toMatch(/WHERE/);
      expect(c.sql).toMatch(/i\.status IN \('completed','paid','partially_paid'\)/);
      expect(c.sql).toMatch(/NOT i\.is_return/);
      expect(c.sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    }
  });

  it('2. zero revenue returns gross_margin_pct: null and avg_profit_per_unit: null', async () => {
    const { service } = await makeService([
      [
        {
          total_revenue: '0',
          total_cogs: '0',
          gross_profit: '0',
          total_qty_sold: 0,
          invoice_count: 0,
          product_count: 0,
          variant_count: 0,
        },
      ],
      [],
      [],
    ]);
    const res = await service.soldProfitSummary();
    expect(res.total_revenue).toBe(0);
    expect(res.gross_margin_pct).toBeNull();
    expect(res.markup_pct).toBeNull();
    expect(res.avg_profit_per_unit).toBeNull();
    expect(res.top_profit_product).toBeNull();
    expect(res.worst_margin_product).toBeNull();
  });

  it('3. date-range filter binds from/to params', async () => {
    const { service, calls } = await makeService([[{}], [], []]);
    await service.soldProfitSummary({ from: '2026-05-01', to: '2026-05-31' });
    expect(calls[0].params).toContain('2026-05-01');
    expect(calls[0].params).toContain('2026-05-31');
    expect(calls[0].sql).toMatch(/completed_at, i\.created_at\) >= \$\d/);
  });
});

describe('ReportsService.soldProfitProducts — P3.4B', () => {
  const ROWS = [
    {
      variant_id: 'v-ok',
      product_id: 'p1',
      product_name: 'صنف رابح',
      sku: 'OK',
      barcode: null,
      color: null,
      size: null,
      qty_sold: 10,
      revenue: '1000.00',
      cogs: '600.00',
      gross_profit: '400.00',
      avg_selling_price: '100.00',
      avg_unit_cost: '60.00',
      invoice_count: 3,
      last_sold_at: '2026-05-15T10:00:00Z',
      min_margin_pct: '15.00',
    },
    {
      variant_id: 'v-loss',
      product_id: 'p2',
      product_name: 'صنف خاسر',
      sku: 'LOSS',
      barcode: null,
      color: null,
      size: null,
      qty_sold: 5,
      revenue: '200.00',
      cogs: '300.00',
      gross_profit: '-100.00',
      avg_selling_price: '40.00',
      avg_unit_cost: '60.00',
      invoice_count: 2,
      last_sold_at: '2026-05-14T10:00:00Z',
      min_margin_pct: '15.00',
    },
    {
      variant_id: 'v-lowmargin',
      product_id: 'p3',
      product_name: 'صنف هامش منخفض',
      sku: 'LM',
      barcode: null,
      color: null,
      size: null,
      qty_sold: 4,
      revenue: '400.00',
      cogs: '360.00',
      gross_profit: '40.00',
      avg_selling_price: '100.00',
      avg_unit_cost: '90.00',
      invoice_count: 1,
      last_sold_at: '2026-05-13T10:00:00Z',
      min_margin_pct: '15.00',
    },
    {
      variant_id: 'v-unknown',
      product_id: 'p4',
      product_name: 'صنف بدون تكلفة',
      sku: 'UC',
      barcode: null,
      color: null,
      size: null,
      qty_sold: 2,
      revenue: '200.00',
      cogs: '0',
      gross_profit: '200.00',
      avg_selling_price: '100.00',
      avg_unit_cost: '0.00',
      invoice_count: 1,
      last_sold_at: '2026-05-12T10:00:00Z',
      min_margin_pct: '15.00',
    },
  ];

  it('4. per-variant aggregation + status enum (ok / loss / low_margin / unknown_cost)', async () => {
    const { service } = await makeService([ROWS]);
    const res = await service.soldProfitProducts();
    const by = Object.fromEntries(
      res.items.map((r: any) => [r.variant_id, r.status]),
    );
    expect(by['v-ok']).toBe('ok');
    expect(by['v-loss']).toBe('loss');
    expect(by['v-lowmargin']).toBe('low_margin'); // 40/400 = 10% < 15%
    expect(by['v-unknown']).toBe('unknown_cost');
    expect(res.summary.loss).toBe(1);
    expect(res.summary.low_margin).toBe(1);
    expect(res.summary.unknown_cost).toBe(1);
    expect(res.summary.ok).toBe(1);
    const ok = res.items.find((r: any) => r.variant_id === 'v-ok')!;
    expect(ok.gross_margin_pct).toBe(40);
    expect(ok.markup_pct).toBeCloseTo(66.67, 1);
  });

  it('5. sort override: gross_profit_asc returns the loss item first', async () => {
    const { service } = await makeService([ROWS]);
    const res = await service.soldProfitProducts({ sort: 'gross_profit_asc' });
    expect(res.items[0].variant_id).toBe('v-loss');
  });

  it('6. status filter narrows the list', async () => {
    const { service } = await makeService([ROWS]);
    const res = await service.soldProfitProducts({ status: 'loss' });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].variant_id).toBe('v-loss');
    expect(res.summary.loss).toBe(1);
  });
});

describe('ReportsService.soldProfitInvoices — P3.4B', () => {
  const ROWS = [
    {
      invoice_id: 'inv1',
      invoice_no: 'INV-2026-0000001',
      sold_at: '2026-05-15T10:00:00Z',
      customer_id: 'c1',
      customer_name: 'عميل أ',
      status: 'completed',
      qty_sold: 3,
      item_count: 2,
      revenue: '500.00',
      cogs: '300.00',
      gross_profit: '200.00',
      min_margin_pct: '15.00',
    },
    {
      invoice_id: 'inv2',
      invoice_no: 'INV-2026-0000002',
      sold_at: '2026-05-14T10:00:00Z',
      customer_id: 'c2',
      customer_name: 'عميل ب',
      status: 'paid',
      qty_sold: 1,
      item_count: 1,
      revenue: '50.00',
      cogs: '80.00',
      gross_profit: '-30.00',
      min_margin_pct: '15.00',
    },
  ];

  it('7. per-invoice aggregation + status', async () => {
    const { service, calls } = await makeService([ROWS]);
    const res = await service.soldProfitInvoices();
    const map = Object.fromEntries(res.items.map((r: any) => [r.invoice_id, r]));
    expect(map['inv1'].gross_margin_pct).toBe(40);
    expect(map['inv1'].status).toBe('ok');
    expect(map['inv2'].status).toBe('loss');
    expect(map['inv2'].gross_profit).toBe(-30);
    expect(calls[0].sql).toMatch(/NOT i\.is_return/);
    expect(calls[0].sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
  });

  it('8. summary tallies revenue + cogs + profit + counts', async () => {
    const { service } = await makeService([ROWS]);
    const res = await service.soldProfitInvoices();
    expect(res.summary.total).toBe(2);
    expect(res.summary.revenue).toBe(550);
    expect(res.summary.cogs).toBe(380);
    expect(res.summary.gross_profit).toBe(170);
    expect(res.summary.loss).toBe(1);
  });
});

describe('STATIC GUARDRAIL — P3.4B reports never write', () => {
  const SRC = readFileSync(join(__dirname, 'reports.service.ts'), 'utf8');
  const idx = SRC.indexOf('PR-PURCHASES-P3.4B');
  const slice = idx >= 0 ? SRC.slice(idx) : '';

  it('the three P3.4B methods exist in the source', () => {
    expect(slice.length).toBeGreaterThan(1000);
    expect(slice).toMatch(/async soldProfitSummary\b/);
    expect(slice).toMatch(/async soldProfitProducts\b/);
    expect(slice).toMatch(/async soldProfitInvoices\b/);
  });

  it('zero mutating SQL keywords in P3.4B code slice', () => {
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
    // Strip comment lines so doc strings that LIST the forbidden
    // tokens (for human readers) don't false-positive. The OTHER
    // tests in this block already use this pattern; aligning here.
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(stripped).not.toMatch(/applyVariantPrices\b/);
    expect(stripped).not.toMatch(/reverseByReference\b/);
    expect(stripped).not.toMatch(/recordTransaction\b/);
    expect(stripped).not.toMatch(/postPurchase\b/);
    expect(stripped).not.toMatch(/financialEngine/i);
    expect(stripped).not.toMatch(/\.transaction\(/);
  });

  it('zero references to forbidden tables in executable lines', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(stripped).not.toMatch(/journal_entries\b/i);
    expect(stripped).not.toMatch(/journal_lines\b/i);
    expect(stripped).not.toMatch(/cashbox_transactions\b/i);
    expect(stripped).not.toMatch(/stock_movements\b/i);
    expect(stripped).not.toMatch(/supplier_ledger\b/i);
    expect(stripped).not.toMatch(/variant_price_history\b/i);
    expect(stripped).not.toMatch(/purchase_extra_costs\b/i);
    expect(stripped).not.toMatch(/purchase_items\b/i);
  });

  it('only SELECTs from invoices/invoice_items/product_variants/products/customers/settings', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    // Verify the legitimate source tables ARE present in SELECT context
    expect(stripped).toMatch(/FROM invoice_items ii\b/);
    expect(stripped).toMatch(/JOIN invoices i\b/);
    expect(stripped).toMatch(/JOIN product_variants pv\b/);
    expect(stripped).toMatch(/JOIN products p\b/);
    expect(stripped).toMatch(/LEFT JOIN customers c\b/);
    // settings is read for the min_margin default
    expect(stripped).toMatch(/FROM settings\b/);
  });

  // ────────────────────────────────────────────────────────────────
  //  HOTFIX guardrail: Postgres has no max(uuid) aggregate. Catch
  //  any future regression that wraps a UUID-shaped column in MAX().
  //  These are the columns we KNOW are UUID in our schema and
  //  appear inside the P3.4B SQL (id, product_id, variant_id,
  //  customer_id, invoice_id).
  // ────────────────────────────────────────────────────────────────
  it('HOTFIX: never wraps a UUID column in MAX(...)', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    const forbidden = [
      /MAX\(\s*id\s*\)/i,
      /MAX\(\s*product_id\s*\)/i,
      /MAX\(\s*variant_id\s*\)/i,
      /MAX\(\s*customer_id\s*\)/i,
      /MAX\(\s*invoice_id\s*\)/i,
      /MAX\(\s*user_id\s*\)/i,
      /MAX\(\s*supplier_id\s*\)/i,
    ];
    for (const re of forbidden) {
      expect(stripped).not.toMatch(re);
    }
  });
});

// ─── HOTFIX functional tests for top/worst product UUID handoff ───
// The summary endpoint's `top_profit_product` / `worst_margin_product`
// MUST surface a real `product_id` UUID. Previously the per-row
// aggregation in the products endpoint also fetched a UUID via
// MAX(product_id) which crashed at runtime. These tests fail if
// either endpoint stops returning the UUID, and stand as canaries
// for any future regression.
import { Test as Test2 } from '@nestjs/testing';
import { DataSource as DS2 } from 'typeorm';
import { ReportsService as RS2 } from './reports.service';

async function makeServ(responses: Array<any[]> = []) {
  const queue = [...responses];
  const calls: any[] = [];
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return queue.length ? queue.shift() : [];
    }),
  };
  const m = await Test2.createTestingModule({
    providers: [RS2, { provide: DS2, useValue: ds }],
  }).compile();
  return { service: m.get(RS2), calls };
}

describe('HOTFIX — UUID handoff in summary top/worst and products endpoint', () => {
  it('summary top_profit_product carries product_id (UUID) untouched by MAX', async () => {
    const PROD_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const { service } = await makeServ([
      // totals
      [
        {
          total_revenue: '100',
          total_cogs: '60',
          gross_profit: '40',
          total_qty_sold: 1,
          invoice_count: 1,
          product_count: 1,
          variant_count: 1,
        },
      ],
      // top
      [
        {
          product_id: PROD_ID,
          product_name: 'منتج',
          gross_profit: '40.00',
        },
      ],
      // worst
      [
        {
          product_id: PROD_ID,
          product_name: 'منتج',
          revenue: '100',
          cogs: '60',
          gross_profit: '40',
          gross_margin_pct: '40',
        },
      ],
    ]);
    const res = await service.soldProfitSummary();
    expect(res.top_profit_product?.product_id).toBe(PROD_ID);
    expect(res.worst_margin_product?.product_id).toBe(PROD_ID);
  });

  it('products endpoint carries UUID product_id + variant_id through GROUP BY (no MAX)', async () => {
    const VID = '11111111-1111-1111-1111-111111111111';
    const PID = '22222222-2222-2222-2222-222222222222';
    const { service, calls } = await makeServ([
      [
        {
          variant_id: VID,
          product_id: PID,
          product_name: 'منتج',
          sku: 'A',
          barcode: null,
          color: null,
          size: null,
          qty_sold: 5,
          revenue: '500',
          cogs: '300',
          gross_profit: '200',
          avg_selling_price: '100',
          avg_unit_cost: '60',
          invoice_count: 2,
          last_sold_at: '2026-05-17T10:00:00Z',
          min_margin_pct: '15',
        },
      ],
    ]);
    const res = await service.soldProfitProducts();
    expect(res.items[0].variant_id).toBe(VID);
    expect(res.items[0].product_id).toBe(PID);
    // SQL must group by both UUIDs and the metadata columns; never
    // wrap them in MAX(...)
    const sql = calls[0].sql;
    expect(sql).toMatch(
      /GROUP BY\s+variant_id,\s*product_id,\s*product_name,\s*sku,\s*barcode,\s*color,\s*size/i,
    );
    expect(sql).not.toMatch(/MAX\(\s*product_id\s*\)/i);
    expect(sql).not.toMatch(/MAX\(\s*variant_id\s*\)/i);
  });

  it('invoices endpoint carries UUID invoice_id + customer_id through GROUP BY (no MAX)', async () => {
    const INV = '33333333-3333-3333-3333-333333333333';
    const CID = '44444444-4444-4444-4444-444444444444';
    const { service, calls } = await makeServ([
      [
        {
          invoice_id: INV,
          invoice_no: 'INV-2026-0000001',
          sold_at: '2026-05-17T10:00:00Z',
          customer_id: CID,
          customer_name: 'عميل',
          status: 'completed',
          qty_sold: 3,
          item_count: 2,
          revenue: '500',
          cogs: '300',
          gross_profit: '200',
          min_margin_pct: '15',
        },
      ],
    ]);
    const res = await service.soldProfitInvoices();
    expect(res.items[0].invoice_id).toBe(INV);
    expect(res.items[0].customer_id).toBe(CID);
    const sql = calls[0].sql;
    expect(sql).toMatch(
      /GROUP BY\s+invoice_id,\s*invoice_no,\s*sold_at,\s*customer_id,\s*customer_name,\s*status/i,
    );
    expect(sql).not.toMatch(/MAX\(\s*customer_id\s*\)/i);
    expect(sql).not.toMatch(/MAX\(\s*invoice_id\s*\)/i);
  });
});
