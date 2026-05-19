/**
 * inventory.service.spec.ts — PR-FIX-INVENTORY-API-FOUNDATION
 *
 * Pins the read-only inventory API contract. Every assertion here
 * either:
 *   1. Verifies the service returns the shape the controller depends
 *      on (so the UI can render without round-trips),
 *   2. Confirms filters/pagination flow into the emitted SQL, OR
 *   3. Proves no write happens — every captured query is a SELECT.
 *
 * No real DB. DataSource.query is stubbed with a regex router so we
 * can assert SQL fragments without booting Postgres.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { InventoryService } from './inventory.service';

type QueryCall = { sql: string; params: any[] };

function makeService(routes: Array<{ match: RegExp; rows: any[] }>) {
  const calls: QueryCall[] = [];
  const ds = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const r = routes.find((x) => x.match.test(sql));
      return r ? r.rows : [];
    }),
  };
  return { ds, calls };
}

async function build(ds: any): Promise<InventoryService> {
  const mod = await Test.createTestingModule({
    providers: [
      InventoryService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  return mod.get(InventoryService);
}

describe('InventoryService — read-only contract', () => {
  it('every query emitted is a SELECT (no INSERT/UPDATE/DELETE/TRUNCATE)', async () => {
    const { ds, calls } = makeService([
      { match: /COUNT\(\*\)/, rows: [{ total: 0 }] },
      { match: /./, rows: [] },
    ]);
    const svc = await build(ds);

    await svc.getDashboard();
    await svc.getBalances({});
    await svc.getMovements({});

    const writePattern = /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i;
    for (const c of calls) {
      expect(c.sql).not.toMatch(writePattern);
    }
  });
});

describe('InventoryService.getDashboard', () => {
  it('returns totals + top_low_stock + recent_movements + top_groups_* with normalized numeric types', async () => {
    const { ds } = makeService([
      // ORDER MATTERS — more specific patterns first so they don't
      // get stolen by the generic regex that follows.
      // Totals row (1st query) — must NOT match the LIMIT/ORDER queries below.
      {
        match: /total_products[\s\S]+total_variants[\s\S]+low_stock_groups_count/,
        rows: [
          {
            total_products: '12',
            total_variants: '45',
            total_stock_qty: '617',
            total_available_qty: '600',
            total_stock_cost_value: '12345.50',
            total_stock_sale_value: '23456.75',
            low_stock_count: '3',
            out_of_stock_count: '5',
            warehouses_count: '4',
            movements_today_count: '7',
            low_stock_groups_count: '2',
          },
        ],
      },
      // Top low-stock query
      {
        match: /reorder_point > 0[\s\S]+quantity_on_hand <= s\.reorder_point/,
        rows: [
          {
            variant_id: 'v1',
            product_id: 'p1',
            product_name: 'Bag A',
            sku: 'BAG-RED-M',
            color_name: 'Red',
            size_label: 'M',
            warehouse_id: 'w1',
            warehouse_name: 'Main',
            quantity_on_hand: '2',
            reorder_point: '10',
          },
        ],
      },
      // Top groups by stock value (LATERAL JOIN through pgv)
      {
        match: /FROM product_groups g[\s\S]+JOIN product_group_variants pgv[\s\S]+stock_value/,
        rows: [
          {
            group_id: 'g1',
            name_ar: 'حقائب',
            name_en: 'Bags',
            color: '#0af',
            stock_qty: '20',
            stock_value: '1500.00',
          },
        ],
      },
      // Top groups by sales 30d
      {
        match: /FROM product_groups g[\s\S]+JOIN invoice_items ii[\s\S]+revenue_30d/,
        rows: [
          {
            group_id: 'g1',
            name_ar: 'حقائب',
            color: '#0af',
            revenue_30d: '750.00',
            qty_30d: '5',
          },
        ],
      },
      // Recent movements query
      {
        match: /FROM stock_movements sm/,
        rows: [
          {
            id: '99',
            created_at: '2026-05-19T10:00:00Z',
            movement_type: 'sale',
            direction: 'out',
            quantity: '1',
            variant_id: 'v1',
            product_name: 'Bag A',
            sku: 'BAG-RED-M',
            warehouse_name: 'Main',
            source_module: 'pos',
            source_action: 'create_invoice',
          },
        ],
      },
    ]);
    const svc = await build(ds);
    const res = await svc.getDashboard();

    // Totals are numbers, not strings.
    expect(res.totals.total_products).toBe(12);
    expect(res.totals.total_variants).toBe(45);
    expect(res.totals.total_stock_qty).toBe(617);
    expect(res.totals.total_available_qty).toBe(600);
    expect(res.totals.total_stock_cost_value).toBeCloseTo(12345.5);
    expect(res.totals.total_stock_sale_value).toBeCloseTo(23456.75);
    expect(res.totals.low_stock_count).toBe(3);
    expect(res.totals.out_of_stock_count).toBe(5);
    expect(res.totals.warehouses_count).toBe(4);
    expect(res.totals.movements_today_count).toBe(7);
    expect(res.totals.low_stock_groups_count).toBe(2);

    expect(res.top_low_stock).toHaveLength(1);
    expect(res.top_low_stock[0].quantity_on_hand).toBe(2);
    expect(res.top_low_stock[0].reorder_point).toBe(10);

    expect(res.recent_movements).toHaveLength(1);
    expect(res.recent_movements[0].quantity).toBe(1);

    // PR-FIX-INVENTORY-API-PRODUCT-GROUPS — top groups arrays.
    expect(res.top_groups_by_stock_value).toHaveLength(1);
    expect(res.top_groups_by_stock_value[0]).toMatchObject({
      group_id: 'g1',
      name_ar: 'حقائب',
      color: '#0af',
    });
    expect(res.top_groups_by_stock_value[0].stock_value).toBeCloseTo(1500);
    expect(res.top_groups_by_stock_value[0].stock_qty).toBe(20);

    expect(res.top_groups_by_sales_30d).toHaveLength(1);
    expect(res.top_groups_by_sales_30d[0]).toMatchObject({
      group_id: 'g1',
      name_ar: 'حقائب',
    });
    expect(res.top_groups_by_sales_30d[0].revenue_30d).toBeCloseTo(750);
    expect(res.top_groups_by_sales_30d[0].qty_30d).toBe(5);
  });

  it('returns zero-filled totals when the DB has no inventory yet', async () => {
    const { ds } = makeService([{ match: /./, rows: [] }]);
    const svc = await build(ds);
    const res = await svc.getDashboard();
    expect(res.totals.total_products).toBe(0);
    expect(res.totals.total_stock_qty).toBe(0);
    expect(res.totals.low_stock_groups_count).toBe(0);
    expect(res.top_low_stock).toEqual([]);
    expect(res.recent_movements).toEqual([]);
    expect(res.top_groups_by_stock_value).toEqual([]);
    expect(res.top_groups_by_sales_30d).toEqual([]);
  });

  it('totals query includes the low_stock_groups_count sub-select', async () => {
    const { ds, calls } = makeService([{ match: /./, rows: [] }]);
    const svc = await build(ds);
    await svc.getDashboard();
    const totalsCall = calls.find((c) => /total_products/.test(c.sql));
    expect(totalsCall).toBeDefined();
    expect(totalsCall!.sql).toMatch(/COUNT\(DISTINCT g\.id\)/);
    expect(totalsCall!.sql).toMatch(/FROM product_groups g/);
    expect(totalsCall!.sql).toMatch(/AS low_stock_groups_count/);
  });
});

describe('InventoryService.getBalances — filtering + pagination', () => {
  function totalsRouter(items: any[]) {
    return [
      { match: /SELECT COUNT\(\*\)::int AS total/, rows: [{ total: items.length }] },
      { match: /FROM stock s\s*\n[\s\S]+JOIN product_variants pv/, rows: items },
    ];
  }

  it('passes search/warehouse_id/category_id/brand_id filters into params + ILIKE', async () => {
    const { ds, calls } = makeService(totalsRouter([]));
    const svc = await build(ds);
    await svc.getBalances({
      search: 'red',
      warehouse_id: '11111111-1111-1111-1111-111111111111',
      category_id: '22222222-2222-2222-2222-222222222222',
      brand_id: '33333333-3333-3333-3333-333333333333',
    });
    // The count query and the page query both carry the same filter
    // expressions. We assert on the page query.
    const pageCall = calls.find((c) => /LIMIT \$/.test(c.sql));
    expect(pageCall).toBeDefined();
    expect(pageCall!.sql).toContain('s.warehouse_id = $');
    expect(pageCall!.sql).toContain('p.category_id = $');
    expect(pageCall!.sql).toContain('p.brand_id = $');
    expect(pageCall!.sql).toContain('ILIKE');
    expect(pageCall!.params).toContain('11111111-1111-1111-1111-111111111111');
    expect(pageCall!.params).toContain('22222222-2222-2222-2222-222222222222');
    expect(pageCall!.params).toContain('33333333-3333-3333-3333-333333333333');
    expect(pageCall!.params).toContain('%red%');
  });

  it('low_stock=true adds the reorder-threshold predicate', async () => {
    const { ds, calls } = makeService(totalsRouter([]));
    const svc = await build(ds);
    await svc.getBalances({ low_stock: true });
    const pageCall = calls.find((c) => /LIMIT \$/.test(c.sql));
    expect(pageCall!.sql).toMatch(/s\.reorder_point\s*>\s*0/);
    expect(pageCall!.sql).toMatch(/s\.quantity_on_hand\s*<=\s*s\.reorder_point/);
  });

  it('out_of_stock=true adds the quantity_on_hand<=0 predicate', async () => {
    const { ds, calls } = makeService(totalsRouter([]));
    const svc = await build(ds);
    await svc.getBalances({ out_of_stock: true });
    const pageCall = calls.find((c) => /LIMIT \$/.test(c.sql));
    expect(pageCall!.sql).toMatch(/s\.quantity_on_hand\s*<=\s*0/);
  });

  it('clamps limit to 200 and pages by limit*page', async () => {
    const { ds, calls } = makeService(totalsRouter([]));
    const svc = await build(ds);
    await svc.getBalances({ page: 3, limit: 999 });
    const pageCall = calls.find((c) => /LIMIT \$/.test(c.sql));
    // Last two params are limit then offset.
    expect(pageCall!.params[pageCall!.params.length - 2]).toBe(200); // limit clamped
    expect(pageCall!.params[pageCall!.params.length - 1]).toBe(400); // (3-1)*200
  });

  // ──────────────────────────────────────────────────────────────
  // PR-FIX-INVENTORY-API-PRODUCT-GROUPS — group_id filter uses
  // EXISTS so a variant in multiple groups still produces ONE row.
  // ──────────────────────────────────────────────────────────────
  it('group_id filter goes through an EXISTS sub-query against product_group_variants', async () => {
    const { ds, calls } = makeService(totalsRouter([]));
    const svc = await build(ds);
    await svc.getBalances({
      group_id: '44444444-4444-4444-4444-444444444444',
    });
    const pageCall = calls.find((c) => /LIMIT \$/.test(c.sql));
    // EXISTS keeps the row count at 1 per (variant, warehouse).
    expect(pageCall!.sql).toMatch(/EXISTS\s*\(/);
    expect(pageCall!.sql).toMatch(/FROM product_group_variants pgv/);
    expect(pageCall!.sql).toMatch(/pgv\.variant_id\s*=\s*pv\.id/);
    expect(pageCall!.sql).toMatch(/pgv\.group_id\s*=\s*\$/);
    expect(pageCall!.params).toContain('44444444-4444-4444-4444-444444444444');
    // Must NOT join product_group_variants directly (that would
    // multiply rows when the variant belongs to multiple groups).
    expect(pageCall!.sql).not.toMatch(/JOIN product_group_variants pgv\s+ON/);
  });

  it('items query attaches groups via LATERAL with parallel arrays', async () => {
    const { ds, calls } = makeService(totalsRouter([]));
    const svc = await build(ds);
    await svc.getBalances({});
    const pageCall = calls.find((c) => /LIMIT \$/.test(c.sql));
    expect(pageCall!.sql).toMatch(/LEFT JOIN LATERAL/);
    expect(pageCall!.sql).toMatch(/array_agg\(pg\.id::text/);
    expect(pageCall!.sql).toMatch(/array_agg\(pg\.name_ar/);
    expect(pageCall!.sql).toMatch(/array_agg\(pg\.name_en/);
    expect(pageCall!.sql).toMatch(/array_agg\(pg\.color/);
    expect(pageCall!.sql).toMatch(/pg\.is_active\s*=\s*TRUE/);
  });

  it('returned row exposes group_ids/group_names_ar/group_names_en/group_colors arrays', async () => {
    const sampleRow = {
      product_id: 'p1', product_name: 'Bag A', sku_prefix: 'BAG',
      variant_id: 'v1', sku: 'BAG-RED-M', barcode: '12345',
      cost_price: 50, selling_price: 100,
      color_id: 'c1', color_name: 'Red',
      size_id: 's1', size_label: 'M',
      warehouse_id: 'w1', warehouse_name: 'Main',
      quantity_on_hand: 5, quantity_reserved: 0, available_quantity: 5,
      reorder_point: 0, avg_cost: 0,
      stock_cost_value: 250, stock_sale_value: 500,
      last_movement_at: '2026-05-18T00:00:00Z',
      group_ids: ['g1', 'g2'],
      group_names_ar: ['حقائب', 'منتجات صيف'],
      group_names_en: ['Bags', null],
      group_colors: ['#0af', null],
    };
    const { ds } = makeService([
      { match: /SELECT COUNT\(\*\)::int AS total/, rows: [{ total: 1 }] },
      { match: /FROM stock s[\s\S]+JOIN product_variants pv/, rows: [sampleRow] },
    ]);
    const svc = await build(ds);
    const res = await svc.getBalances({});
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      variant_id: 'v1',
      group_ids: ['g1', 'g2'],
      group_names_ar: ['حقائب', 'منتجات صيف'],
    });
    // Each row appears exactly once even though the variant belongs
    // to TWO groups — proves no row multiplication.
    expect(res.items.filter((r: any) => r.variant_id === 'v1')).toHaveLength(1);
    expect(res.total).toBe(1);
  });

  it('returns { items, total, page, limit } with total from the COUNT query', async () => {
    const sampleRow = {
      product_id: 'p1', product_name: 'Bag A', sku_prefix: 'BAG',
      variant_id: 'v1', sku: 'BAG-RED-M', barcode: '12345',
      cost_price: 50, selling_price: 100,
      color_id: 'c1', color_name: 'Red',
      size_id: 's1', size_label: 'M',
      warehouse_id: 'w1', warehouse_name: 'Main',
      quantity_on_hand: 5, quantity_reserved: 0, available_quantity: 5,
      reorder_point: 0, avg_cost: 0,
      stock_cost_value: 250, stock_sale_value: 500,
      last_movement_at: '2026-05-18T00:00:00Z',
    };
    const { ds } = makeService([
      { match: /SELECT COUNT\(\*\)::int AS total/, rows: [{ total: 42 }] },
      { match: /FROM stock s[\s\S]+JOIN product_variants pv/, rows: [sampleRow] },
    ]);
    const svc = await build(ds);
    const res = await svc.getBalances({ page: 2, limit: 10 });
    expect(res.total).toBe(42);
    expect(res.page).toBe(2);
    expect(res.limit).toBe(10);
    expect(res.items).toHaveLength(1);
    expect(res.items[0]).toMatchObject({
      product_id: 'p1',
      variant_id: 'v1',
      warehouse_id: 'w1',
      available_quantity: 5,
    });
  });
});

describe('InventoryService.getMovements — filtering + pagination', () => {
  function totalsRouter() {
    return [
      { match: /SELECT COUNT\(\*\)::int AS total/, rows: [{ total: 0 }] },
      { match: /FROM stock_movements sm[\s\S]+JOIN product_variants/, rows: [] },
    ];
  }

  it('passes variant_id / product_id / warehouse_id filters into params', async () => {
    const { ds, calls } = makeService(totalsRouter());
    const svc = await build(ds);
    await svc.getMovements({
      variant_id: '11111111-1111-1111-1111-111111111111',
      product_id: '22222222-2222-2222-2222-222222222222',
      warehouse_id: '33333333-3333-3333-3333-333333333333',
    });
    const pageCall = calls.find((c) => /LIMIT \$/.test(c.sql));
    expect(pageCall!.sql).toContain('sm.variant_id = $');
    expect(pageCall!.sql).toContain('pv.product_id = $');
    expect(pageCall!.sql).toContain('sm.warehouse_id = $');
  });

  it('passes movement_type / direction / reference_type into params', async () => {
    const { ds, calls } = makeService(totalsRouter());
    const svc = await build(ds);
    await svc.getMovements({
      movement_type: 'sale',
      direction: 'out',
      reference_type: 'invoice',
    });
    const pageCall = calls.find((c) => /LIMIT \$/.test(c.sql));
    expect(pageCall!.sql).toContain('sm.movement_type::text = $');
    expect(pageCall!.sql).toContain('sm.direction::text = $');
    expect(pageCall!.sql).toContain('sm.reference_type::text = $');
    expect(pageCall!.params).toContain('sale');
    expect(pageCall!.params).toContain('out');
    expect(pageCall!.params).toContain('invoice');
  });

  it('passes date_from / date_to as a bounded range', async () => {
    const { ds, calls } = makeService(totalsRouter());
    const svc = await build(ds);
    await svc.getMovements({ date_from: '2026-05-01', date_to: '2026-05-19' });
    const pageCall = calls.find((c) => /LIMIT \$/.test(c.sql));
    expect(pageCall!.sql).toMatch(/sm\.created_at\s*>=/);
    expect(pageCall!.sql).toMatch(/INTERVAL\s+'1 day'/);
  });

  it('clamps limit to 500 and pages by limit*page', async () => {
    const { ds, calls } = makeService(totalsRouter());
    const svc = await build(ds);
    await svc.getMovements({ page: 4, limit: 9999 });
    const pageCall = calls.find((c) => /LIMIT \$/.test(c.sql));
    expect(pageCall!.params[pageCall!.params.length - 2]).toBe(500);
    expect(pageCall!.params[pageCall!.params.length - 1]).toBe(1500);
  });

  // PR-FIX-INVENTORY-API-PRODUCT-GROUPS — group_id filter on the
  // movements endpoint uses the same EXISTS shape as balances so a
  // variant in N groups still contributes its movements only ONCE.
  it('group_id filter uses EXISTS against product_group_variants (no row multiplication)', async () => {
    const { ds, calls } = makeService(totalsRouter());
    const svc = await build(ds);
    await svc.getMovements({
      group_id: '44444444-4444-4444-4444-444444444444',
    });
    const pageCall = calls.find((c) => /LIMIT \$/.test(c.sql));
    expect(pageCall!.sql).toMatch(/EXISTS\s*\(/);
    expect(pageCall!.sql).toMatch(/FROM product_group_variants pgv/);
    expect(pageCall!.sql).toMatch(/pgv\.variant_id\s*=\s*sm\.variant_id/);
    expect(pageCall!.sql).toMatch(/pgv\.group_id\s*=\s*\$/);
    expect(pageCall!.params).toContain('44444444-4444-4444-4444-444444444444');
    expect(pageCall!.sql).not.toMatch(/JOIN product_group_variants pgv\s+ON/);
  });
});

// ──────────────────────────────────────────────────────────────────
// PR-BRANCHES-INVENTORY-FILTERS — branch_id scope on all three reads
// ──────────────────────────────────────────────────────────────────
const BRANCH = '55555555-5555-5555-5555-555555555555';

describe('InventoryService — branch_id filter (EXISTS over warehouse_branches)', () => {
  it('balances: branch_id adds EXISTS sub-query against warehouse_branches keyed on s.warehouse_id', async () => {
    const { ds, calls } = makeService([
      { match: /SELECT COUNT\(\*\)::int AS total/, rows: [{ total: 0 }] },
      { match: /FROM stock s[\s\S]+JOIN product_variants pv/, rows: [] },
    ]);
    const svc = await build(ds);
    await svc.getBalances({ branch_id: BRANCH });

    const pageCall = calls.find((c) => /LIMIT \$/.test(c.sql));
    expect(pageCall).toBeDefined();
    // Branch scope uses EXISTS — never a JOIN that could multiply rows.
    expect(pageCall!.sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM warehouse_branches wb/i,
    );
    expect(pageCall!.sql).toMatch(/wb\.warehouse_id\s*=\s*s\.warehouse_id/);
    expect(pageCall!.sql).toMatch(/wb\.branch_id\s*=\s*\$/);
    expect(pageCall!.params).toContain(BRANCH);
    // No bare JOIN onto warehouse_branches anywhere.
    expect(pageCall!.sql).not.toMatch(
      /JOIN\s+warehouse_branches\s+wb\s+ON/i,
    );
  });

  it('balances: branch_id + warehouse_id apply together (intersection)', async () => {
    const { ds, calls } = makeService([
      { match: /SELECT COUNT\(\*\)::int AS total/, rows: [{ total: 0 }] },
      { match: /FROM stock s[\s\S]+JOIN product_variants pv/, rows: [] },
    ]);
    const svc = await build(ds);
    await svc.getBalances({
      warehouse_id: '11111111-1111-1111-1111-111111111111',
      branch_id: BRANCH,
    });
    const pageCall = calls.find((c) => /LIMIT \$/.test(c.sql));
    // Both predicates are in the WHERE.
    expect(pageCall!.sql).toMatch(/s\.warehouse_id\s*=\s*\$/);
    expect(pageCall!.sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM warehouse_branches wb/i,
    );
    expect(pageCall!.params).toContain(
      '11111111-1111-1111-1111-111111111111',
    );
    expect(pageCall!.params).toContain(BRANCH);
  });

  it('movements: branch_id adds EXISTS sub-query keyed on sm.warehouse_id', async () => {
    const { ds, calls } = makeService([
      { match: /SELECT COUNT\(\*\)::int AS total/, rows: [{ total: 0 }] },
      { match: /FROM stock_movements sm[\s\S]+JOIN product_variants/, rows: [] },
    ]);
    const svc = await build(ds);
    await svc.getMovements({ branch_id: BRANCH });

    const pageCall = calls.find((c) => /LIMIT \$/.test(c.sql));
    expect(pageCall!.sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM warehouse_branches wb/i,
    );
    expect(pageCall!.sql).toMatch(/wb\.warehouse_id\s*=\s*sm\.warehouse_id/);
    expect(pageCall!.sql).toMatch(/wb\.branch_id\s*=\s*\$/);
    expect(pageCall!.params).toContain(BRANCH);
    expect(pageCall!.sql).not.toMatch(
      /JOIN\s+warehouse_branches\s+wb\s+ON/i,
    );
  });

  it('dashboard: branch_id scopes every KPI / list query via warehouse_branches EXISTS', async () => {
    const { ds, calls } = makeService([{ match: /./, rows: [] }]);
    const svc = await build(ds);
    await svc.getDashboard({ branch_id: BRANCH });

    // Every dashboard query that touches a warehouse-scoped table
    // must carry the branch predicate. The Service splits the
    // dashboard into 5 round-trips (totals + top_low_stock +
    // top_groups_by_stock_value + top_groups_by_sales_30d +
    // recent_movements) — so we expect AT LEAST 5 captured calls
    // and EVERY one to bind the branch_id and reference
    // warehouse_branches.
    expect(calls.length).toBeGreaterThanOrEqual(5);
    for (const c of calls) {
      expect(c.params).toContain(BRANCH);
      expect(c.sql).toMatch(/warehouse_branches\s+wb/i);
      expect(c.sql).toMatch(/EXISTS\s*\(/);
    }
  });

  it('dashboard: no branch_id → no warehouse_branches reference + no extra params', async () => {
    const { ds, calls } = makeService([{ match: /./, rows: [] }]);
    const svc = await build(ds);
    await svc.getDashboard();
    for (const c of calls) {
      expect(c.params).toEqual([]);
      expect(c.sql).not.toMatch(/warehouse_branches/i);
    }
  });

  it('branch_id filter never emits an INSERT / UPDATE / DELETE statement', async () => {
    const { ds, calls } = makeService([
      { match: /SELECT COUNT\(\*\)::int AS total/, rows: [{ total: 0 }] },
      { match: /./, rows: [] },
    ]);
    const svc = await build(ds);
    await svc.getDashboard({ branch_id: BRANCH });
    await svc.getBalances({ branch_id: BRANCH });
    await svc.getMovements({ branch_id: BRANCH });

    const writePattern = /^\s*(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i;
    for (const c of calls) {
      expect(c.sql).not.toMatch(writePattern);
    }
  });
});
