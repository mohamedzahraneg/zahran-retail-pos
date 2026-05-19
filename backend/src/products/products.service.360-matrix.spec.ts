/**
 * products.service.360-matrix.spec.ts — PR-FIX-INVENTORY-API-FOUNDATION
 *
 * Pins the response shape for the two product-detail read-only
 * endpoints:
 *   GET /products/:id/360
 *   GET /products/:id/matrix
 *
 * Both methods emit SELECTs only — the test verifies no write
 * statement is captured. DataSource is stubbed; no Postgres.
 */
import { ProductsService } from './products.service';

type QueryCall = { sql: string; params: any[] };

interface Route {
  match: RegExp;
  rows: any[];
}

function makeDs(routes: Route[]) {
  const calls: QueryCall[] = [];
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const r = routes.find((x) => x.match.test(sql));
      return r ? r.rows : [];
    }),
  };
  return { ds, calls };
}

// ProductsService constructor is (repo, variants, ds). The 360 and
// matrix methods only touch `this.ds`, so we can pass null for the
// two TypeORM repositories. Direct instantiation skips the
// @InjectRepository plumbing we don't need here.
function makeSvcDirect(ds: any): ProductsService {
  return new (ProductsService as any)(null, null, ds);
}

const PROD_ID = '11111111-1111-1111-1111-111111111111';

describe('ProductsService.getProduct360 — read-only shape', () => {
  it('returns null when the product does not exist', async () => {
    const { ds } = makeDs([
      // Base info query → no row → null return.
      { match: /FROM products p\s*\n[\s\S]*WHERE p\.id = \$1::uuid/, rows: [] },
    ]);
    const svc = makeSvcDirect(ds);
    const res = await svc.getProduct360(PROD_ID);
    expect(res).toBeNull();
  });

  it('returns the full 360 payload with normalized numeric totals', async () => {
    const product = {
      id: PROD_ID, sku_prefix: 'BAG', name_ar: 'حقيبة', name_en: 'Bag',
      product_type: 'bag', target_audience: 'women',
      category_id: 'c1', category_name: 'Bags',
      brand_id: 'b1', brand_name: 'Acme',
      base_cost: 50, base_price: 100, suggested_price: 110,
      min_margin_pct: 15, track_inventory: true, is_active: true,
      created_at: '2026-01-01', updated_at: '2026-05-01', deleted_at: null,
    };
    const variants = [
      {
        variant_id: 'v1', sku: 'BAG-RED-M', barcode: '111',
        color_id: 'c1', color_name: 'Red', hex_code: '#f00',
        size_id: 's1', size_label: 'M', size_sort: 1,
        cost_price: 50, selling_price: 100,
        weight_grams: 400, is_active: true,
        total_qty: '5', total_reserved: '0', total_available: '5',
      },
    ];

    const { ds, calls } = makeDs([
      // ORDER MATTERS — the regex router picks the FIRST match per
      // query. More specific patterns must come before generic ones
      // (the totals CTE also contains `FROM product_variants` AND
      // `LEFT JOIN stock`, so the variants-list regex would steal it
      // unless the totals route is matched first).
      // 0. base product
      { match: /FROM products p\s*\n[\s\S]*WHERE p\.id = \$1::uuid/, rows: [product] },
      // 1. totals roll-up CTE — most specific, listed first
      {
        match: /WITH t AS \(/,
        rows: [
          {
            total_qty: '5', total_available: '5',
            total_cost_value: '250', total_sale_value: '500',
            sold_qty_30d: '3', sold_revenue_30d: '300',
            sold_cost_30d: '150', returned_qty_30d: '1',
          },
        ],
      },
      // 2. variants list (has `LEFT JOIN colors c` which the totals CTE doesn't)
      {
        match: /LEFT JOIN colors c[\s\S]+LEFT JOIN stock s/,
        rows: variants.map((v: any) => ({
          ...v,
          group_ids: ['g1'],
          group_names_ar: ['حقائب'],
          group_names_en: ['Bags'],
          group_colors: ['#0af'],
        })),
      },
      // 3. distinct product_groups for the whole product
      {
        match: /SELECT DISTINCT pg\.id::text\s+AS group_id[\s\S]+ORDER BY pg\.name_ar/,
        rows: [
          { group_id: 'g1', name_ar: 'حقائب', name_en: 'Bags', color: '#0af' },
        ],
      },
      // 4. stock by warehouse (inner JOIN stock, not LEFT JOIN)
      { match: /JOIN stock s\s+ON s\.variant_id = pv\.id[\s\S]+JOIN warehouses w/, rows: [] },
      // 5. recent movements
      { match: /FROM stock_movements sm[\s\S]+WHERE pv\.product_id/, rows: [] },
      // 6. recent invoice items
      { match: /FROM invoice_items ii[\s\S]+WHERE pv\.product_id/, rows: [] },
      // 7. recent purchase items
      { match: /FROM purchase_items pi/, rows: [] },
      // 8. price history
      { match: /FROM variant_price_history vph/, rows: [] },
      // 9. cost history
      { match: /FROM variant_cost_history vch/, rows: [] },
    ]);

    const svc = makeSvcDirect(ds);
    const res = await svc.getProduct360(PROD_ID);

    expect(res).not.toBeNull();
    expect(res!.product).toMatchObject({ id: PROD_ID, name_ar: 'حقيبة' });
    expect(res!.variants).toHaveLength(1);
    expect(res!.variants[0].total_qty).toBe(5);
    expect(res!.variants[0].total_available).toBe(5);

    // PR-FIX-INVENTORY-API-PRODUCT-GROUPS — each variant carries its
    // own groups arrays AND the top-level response surfaces a
    // de-duplicated list of all groups across the variants.
    expect(res!.variants[0].group_ids).toEqual(['g1']);
    expect(res!.variants[0].group_names_ar).toEqual(['حقائب']);
    expect((res as any).product_groups).toHaveLength(1);
    expect((res as any).product_groups[0]).toMatchObject({
      group_id: 'g1',
      name_ar: 'حقائب',
    });

    // Totals are normalized to numbers + gross_profit derived.
    expect(res!.totals.total_qty).toBe(5);
    expect(res!.totals.total_cost_value).toBeCloseTo(250);
    expect(res!.totals.total_sale_value).toBeCloseTo(500);
    expect(res!.totals.sold_qty_30d).toBe(3);
    expect(res!.totals.returned_qty_30d).toBe(1);
    expect(res!.totals.gross_profit_30d).toBeCloseTo(150); // 300-150

    // All five auxiliary collections present (empty arrays here).
    expect(Array.isArray(res!.stock_by_warehouse)).toBe(true);
    expect(Array.isArray(res!.recent_movements)).toBe(true);
    expect(Array.isArray(res!.recent_invoice_items)).toBe(true);
    expect(Array.isArray(res!.recent_purchase_items)).toBe(true);
    expect(Array.isArray(res!.price_history)).toBe(true);
    expect(Array.isArray(res!.cost_history)).toBe(true);

    // Every captured SQL is a SELECT.
    for (const c of calls) {
      expect(c.sql.trim().toUpperCase().startsWith('SELECT')
        || c.sql.trim().toUpperCase().startsWith('WITH')).toBe(true);
    }
  });
});

describe('ProductsService.getProductMatrix — read-only shape', () => {
  it('returns null when the product does not exist', async () => {
    const { ds } = makeDs([
      { match: /FROM products\s*\n[\s\S]*WHERE id = \$1::uuid/, rows: [] },
    ]);
    const svc = makeSvcDirect(ds);
    const res = await svc.getProductMatrix(PROD_ID);
    expect(res).toBeNull();
  });

  it('returns { product, colors, sizes, cells[] } with each cell carrying per_warehouse breakdown', async () => {
    const product = {
      id: PROD_ID, sku_prefix: 'BAG', name_ar: 'حقيبة', name_en: 'Bag',
    };
    const colors = [
      { id: 'c1', name_ar: 'أحمر', name_en: 'Red', hex_code: '#f00' },
    ];
    const sizes = [
      { id: 's1', size_label: 'M', size_system: 'EU', sort_order: 1 },
    ];
    const cells = [
      {
        variant_id: 'v1', color_id: 'c1', size_id: 's1',
        sku: 'BAG-RED-M', barcode: '111',
        cost_price: 50, selling_price: 100, is_active: true,
        total_qty: '5', available_qty: '5',
        per_warehouse: [
          { warehouse_id: 'w1', warehouse_name: 'Main',
            quantity_on_hand: 5, quantity_reserved: 0, available_quantity: 5 },
        ],
        // PR-FIX-INVENTORY-API-PRODUCT-GROUPS — matrix cell groups.
        // The variant belongs to TWO groups; the assertion below
        // confirms the cell still appears exactly once (no row
        // multiplication from the LATERAL aggregation).
        group_ids: ['g1', 'g2'],
        group_names_ar: ['حقائب', 'منتجات صيف'],
        group_names_en: ['Bags', null],
        group_colors: ['#0af', null],
      },
    ];

    const { ds, calls } = makeDs([
      { match: /FROM products\s*\n[\s\S]*WHERE id = \$1::uuid/, rows: [product] },
      { match: /FROM product_variants pv[\s\S]+JOIN colors c/, rows: colors },
      { match: /FROM product_variants pv[\s\S]+JOIN sizes sz/, rows: sizes },
      { match: /FROM product_variants pv\s+LEFT JOIN stock s/, rows: cells },
    ]);

    const svc = makeSvcDirect(ds);
    const res = await svc.getProductMatrix(PROD_ID);

    expect(res).not.toBeNull();
    expect(res!.product.id).toBe(PROD_ID);
    expect(res!.colors).toHaveLength(1);
    expect(res!.sizes).toHaveLength(1);
    expect(res!.cells).toHaveLength(1);
    // Numeric coercion.
    expect(res!.cells[0].total_qty).toBe(5);
    expect(res!.cells[0].available_qty).toBe(5);
    // per_warehouse passthrough.
    expect(res!.cells[0].per_warehouse).toHaveLength(1);
    expect(res!.cells[0].per_warehouse[0].warehouse_id).toBe('w1');
    // PR-FIX-INVENTORY-API-PRODUCT-GROUPS — group arrays present.
    expect((res!.cells[0] as any).group_ids).toEqual(['g1', 'g2']);
    expect((res!.cells[0] as any).group_names_ar).toEqual([
      'حقائب',
      'منتجات صيف',
    ]);
    // Even though the variant belongs to two groups, the cell is
    // ONE row — no multiplication.
    expect(res!.cells.filter((c: any) => c.variant_id === 'v1')).toHaveLength(1);

    // No writes.
    for (const c of calls) {
      expect(c.sql.trim().toUpperCase().startsWith('SELECT')).toBe(true);
    }
  });
});
