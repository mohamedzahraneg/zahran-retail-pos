/**
 * inventory-reports.service.spec.ts — PR-INVENTORY-REPORTS
 *
 * Pins the read-only contract + filter behaviour of the four new
 * inventory-report queries. Branch + group filters always use
 * EXISTS (never a JOIN that could multiply rows). Everything is
 * pure SELECT.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { InventoryReportsService } from './inventory-reports.service';

type QueryCall = { sql: string; params: any[] };

function makeRouter(routes: Array<{ match: RegExp; rows: any[] }>) {
  const calls: QueryCall[] = [];
  const handler = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    const r = routes.find((x) => x.match.test(sql));
    return r ? r.rows : [];
  });
  return { calls, handler };
}

async function build(handler: jest.Mock) {
  const ds: any = { query: handler };
  const mod = await Test.createTestingModule({
    providers: [
      InventoryReportsService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  return mod.get(InventoryReportsService);
}

const BRANCH = '11111111-1111-1111-1111-111111111111';
const WAREHOUSE = '22222222-2222-2222-2222-222222222222';
const GROUP = '33333333-3333-3333-3333-333333333333';
const CATEGORY = '44444444-4444-4444-4444-444444444444';

describe('InventoryReportsService — read-only contract', () => {
  it('every query emitted across all four reports is a SELECT', async () => {
    const { handler, calls } = makeRouter([
      { match: /SELECT[\s\S]+total_qty/, rows: [{ total_qty: 0 }] },
      { match: /./, rows: [] },
    ]);
    const svc = await build(handler);
    await svc.valuation();
    await svc.lowStock();
    await svc.deadStock();
    await svc.profitability();

    const write = /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i;
    for (const c of calls) {
      expect(c.sql).not.toMatch(write);
    }
  });
});

describe('InventoryReportsService.valuation', () => {
  it('passes branch_id, warehouse_id, group_id, category_id, brand_id + search through to WHERE', async () => {
    const { handler, calls } = makeRouter([
      { match: /SELECT[\s\S]+total_qty/, rows: [{ total_qty: 0 }] },
      { match: /./, rows: [] },
    ]);
    const svc = await build(handler);
    await svc.valuation({
      branch_id: BRANCH,
      warehouse_id: WAREHOUSE,
      group_id: GROUP,
      category_id: CATEGORY,
      brand_id: '55555555-5555-5555-5555-555555555555',
      search: 'حقيبة',
    });
    const itemsQuery = calls.find((c) => /LIMIT 1000/.test(c.sql));
    expect(itemsQuery).toBeDefined();
    expect(itemsQuery!.sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM warehouse_branches wb[\s\S]+wb\.warehouse_id\s*=\s*s\.warehouse_id/i,
    );
    expect(itemsQuery!.sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM product_group_variants pgv[\s\S]+pgv\.variant_id\s*=\s*pv\.id/i,
    );
    expect(itemsQuery!.sql).toMatch(/p\.category_id\s*=\s*\$/);
    expect(itemsQuery!.sql).toMatch(/p\.brand_id\s*=\s*\$/);
    expect(itemsQuery!.sql).toMatch(/s\.warehouse_id\s*=\s*\$/);
    expect(itemsQuery!.params).toContain(BRANCH);
    expect(itemsQuery!.params).toContain(GROUP);
    expect(itemsQuery!.params).toContain(CATEGORY);
    expect(itemsQuery!.params).toContain('%حقيبة%');
    // No row-multiplying JOIN to warehouse_branches / product_group_variants.
    expect(itemsQuery!.sql).not.toMatch(
      /JOIN\s+warehouse_branches\s+wb\s+ON/i,
    );
    expect(itemsQuery!.sql).not.toMatch(
      /JOIN\s+product_group_variants\s+pgv\s+ON/i,
    );
  });

  it('derives potential_margin as total_sale_value − total_cost_value', async () => {
    const { handler } = makeRouter([
      {
        match: /SELECT[\s\S]+total_qty/,
        rows: [
          {
            total_qty: '10',
            total_available: '8',
            total_cost_value: '500.00',
            total_sale_value: '750.00',
          },
        ],
      },
      { match: /./, rows: [] },
    ]);
    const svc = await build(handler);
    const res = await svc.valuation();
    expect(res.totals.total_qty).toBe(10);
    expect(res.totals.total_cost_value).toBeCloseTo(500);
    expect(res.totals.total_sale_value).toBeCloseTo(750);
    expect(res.totals.potential_margin).toBeCloseTo(250);
  });
});

describe('InventoryReportsService.lowStock', () => {
  it('emits the (reorder_point breach OR out) predicate and forwards branch + group via EXISTS', async () => {
    const { handler, calls } = makeRouter([{ match: /./, rows: [] }]);
    const svc = await build(handler);
    await svc.lowStock({ branch_id: BRANCH, group_id: GROUP });
    const q = calls.find((c) => /shortage_kind/i.test(c.sql));
    expect(q).toBeDefined();
    expect(q!.sql).toMatch(/s\.reorder_point\s*>\s*0/);
    expect(q!.sql).toMatch(/s\.quantity_on_hand\s*<=\s*0/);
    expect(q!.sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM warehouse_branches wb/i,
    );
    expect(q!.sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM product_group_variants pgv/i,
    );
    expect(q!.params).toContain(BRANCH);
    expect(q!.params).toContain(GROUP);
  });

  it('totals split rows into low/out + sum units_short', async () => {
    const rows = [
      { shortage_kind: 'low', units_short: 3 },
      { shortage_kind: 'low', units_short: 1 },
      { shortage_kind: 'out', units_short: 0 },
    ];
    const { handler } = makeRouter([
      { match: /shortage_kind/i, rows },
    ]);
    const svc = await build(handler);
    const res = await svc.lowStock();
    expect(res.totals.low_count).toBe(2);
    expect(res.totals.out_count).toBe(1);
    expect(res.totals.total_units_short).toBe(4);
  });
});

describe('InventoryReportsService.deadStock', () => {
  it('clamps days to [1..365] and threads it as the first $1::int param', async () => {
    const { handler, calls } = makeRouter([{ match: /./, rows: [] }]);
    const svc = await build(handler);
    await svc.deadStock({ days: 9999 });
    const q = calls.find((c) => /quantity_on_hand\s*>\s*0/.test(c.sql));
    expect(q).toBeDefined();
    expect(q!.params[0]).toBe(365); // clamped
    expect(q!.sql).toMatch(/\$1::int \* INTERVAL '1 day'/);
  });

  it('uses NOT EXISTS against invoice_items for the "no sale in N days" predicate', async () => {
    const { handler, calls } = makeRouter([{ match: /./, rows: [] }]);
    const svc = await build(handler);
    await svc.deadStock({ branch_id: BRANCH });
    const q = calls.find((c) => /quantity_on_hand\s*>\s*0/.test(c.sql));
    expect(q!.sql).toMatch(/NOT EXISTS\s*\(\s*SELECT 1/i);
    expect(q!.sql).toMatch(/FROM invoice_items ii/);
    expect(q!.sql).toMatch(/inv\.voided_at IS NULL/);
    expect(q!.sql).toMatch(/inv\.is_return = FALSE/);
    // Branch scope still EXISTS-based.
    expect(q!.sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM warehouse_branches wb/i,
    );
  });
});

describe('InventoryReportsService.profitability', () => {
  it('groups by product, splits sold vs returned via FILTER, computes margin% in JS', async () => {
    const rows = [
      {
        product_id: 'p1',
        product_name: 'A',
        sku_prefix: 'A',
        sold_qty: 10,
        returned_qty: 1,
        net_qty: 9,
        sales_total: '1000.00',
        cogs_total: '700.00',
        gross_profit: '300.00',
      },
      {
        product_id: 'p2',
        product_name: 'B',
        sku_prefix: 'B',
        sold_qty: 5,
        returned_qty: 0,
        net_qty: 5,
        sales_total: '500.00',
        cogs_total: '450.00',
        gross_profit: '50.00',
      },
    ];
    const { handler, calls } = makeRouter([
      { match: /GROUP BY p\.id/, rows },
    ]);
    const svc = await build(handler);
    const res = await svc.profitability({
      branch_id: BRANCH,
      group_id: GROUP,
      date_from: '2026-01-01',
      date_to: '2026-12-31',
    });
    expect(res.items).toHaveLength(2);
    expect(res.items[0].margin_pct).toBe(30); // 300 / 1000
    expect(res.items[1].margin_pct).toBe(10); // 50  / 500
    expect(res.totals.sales_total).toBeCloseTo(1500);
    expect(res.totals.gross_profit).toBeCloseTo(350);
    expect(res.totals.margin_pct).toBeCloseTo(23.33, 1);

    const q = calls.find((c) => /GROUP BY p\.id/i.test(c.sql));
    expect(q!.sql).toMatch(/FILTER \(WHERE inv\.is_return = FALSE\)/);
    expect(q!.sql).toMatch(/FILTER \(WHERE inv\.is_return = TRUE\)/);
    expect(q!.sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM warehouse_branches wb/i,
    );
    expect(q!.sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM product_group_variants pgv/i,
    );
    expect(q!.params).toContain('2026-01-01');
  });
});

describe('InventoryReportsService — static guardrail (no writes)', () => {
  const SRC = readFileSync(
    join(__dirname, 'inventory-reports.service.ts'),
    'utf8',
  );
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

  it('zero INSERT / UPDATE / DELETE / TRUNCATE statements', () => {
    expect(code).not.toMatch(/\bINSERT INTO\b/i);
    expect(code).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(code).not.toMatch(/\bDELETE FROM\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('does not reach into the financial engine helpers', () => {
    expect(code).not.toMatch(/postPurchase\b/);
    expect(code).not.toMatch(/postSupplierPayment\b/);
    expect(code).not.toMatch(/postInvoiceEdit\b/);
    expect(code).not.toMatch(/reverseByReference\b/);
    expect(code).not.toMatch(/recordTransaction\b/);
    expect(code).not.toMatch(/fn_adjust_stock/);
  });
});
