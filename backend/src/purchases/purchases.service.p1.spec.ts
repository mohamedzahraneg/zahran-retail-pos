/**
 * purchases.service.p1.spec.ts — PR-PURCHASES-P1
 * ────────────────────────────────────────────────────────────────────
 *
 * Pins the contract of the two new read-only helpers used by the
 * Purchase Invoice screen:
 *
 *   1. supplierContext(supplierId) — wraps the existing suppliers
 *      table + purchases aggregates into a single payload tailored
 *      for the supplier-context card. Includes balance direction
 *      (له / علينا / صفر), purchase_count / purchases_total /
 *      paid_total / unpaid_total, and the most-recent purchase with
 *      a derived "interaction" label (cash / partial / credit).
 *
 *   2. productSearch({ q, warehouse_id, limit }) — variant-level
 *      search with exact-match priority. Rows whose barcode / sku /
 *      product.sku_root exactly equal the query rank above fuzzy
 *      name/color/size matches and carry exact_match=true. Each row
 *      also carries available_stock (for the supplied warehouse) and
 *      the variant's last purchase price + supplier (LATERAL join).
 *
 * The DataSource is stubbed so we can assert on the SQL strings the
 * service emits and the shape of the returned payload without a real
 * Postgres.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { PurchasesService } from './purchases.service';

type QueryCall = { sql: string; params: any[] };

interface MakeServiceOpts {
  responses?: Array<any[]>;
}

async function makeService(opts: MakeServiceOpts = {}) {
  const queries: QueryCall[] = [];
  const queue = [...(opts.responses ?? [])];
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      if (queue.length === 0) return [];
      return queue.shift();
    }),
    manager: { query: jest.fn() },
    transaction: jest.fn(async (cb: any) => cb({ query: jest.fn() })),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      PurchasesService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  const service = moduleRef.get(PurchasesService);
  return { service, ds, queries };
}

const SUPPLIER_ID = '11111111-1111-1111-1111-111111111111';
const WAREHOUSE_ID = '22222222-2222-2222-2222-222222222222';
const VARIANT_ID = '33333333-3333-3333-3333-333333333333';
const PRODUCT_ID = '44444444-4444-4444-4444-444444444444';

describe('PurchasesService.supplierContext — PR-PURCHASES-P1', () => {
  function supplierRow(overrides: Record<string, any> = {}) {
    return {
      id: SUPPLIER_ID,
      code: 'SUP-001',
      name: 'مورد تجريبي',
      supplier_type: 'credit',
      current_balance: '1500.00',
      credit_limit: '5000.00',
      payment_terms_days: 30,
      payment_day_of_week: null,
      opening_balance: '0.00',
      ...overrides,
    };
  }

  function aggRow(overrides: Record<string, any> = {}) {
    return {
      purchase_count: 5,
      purchases_total: '12000.00',
      paid_total: '10500.00',
      unpaid_total: '1500.00',
      ...overrides,
    };
  }

  function lastPurchaseRow(overrides: Record<string, any> = {}) {
    return {
      id: 'pur-1',
      purchase_no: 'PO-2026-000005',
      invoice_date: '2026-05-10',
      grand_total: '500.00',
      paid_amount: '400.00',
      remaining: '100.00',
      status: 'partial',
      ...overrides,
    };
  }

  it('returns supplier identity, stats, and last-purchase block with derived "partial" interaction', async () => {
    const { service, queries } = await makeService({
      responses: [[supplierRow()], [aggRow()], [lastPurchaseRow()]],
    });

    const out = await service.supplierContext(SUPPLIER_ID);
    expect(out.supplier).toMatchObject({
      id: SUPPLIER_ID,
      code: 'SUP-001',
      name: 'مورد تجريبي',
      current_balance: 1500,
      balance_direction: 'owed_to_supplier',
      credit_limit: 5000,
    });
    expect(out.stats).toEqual({
      purchase_count: 5,
      purchases_total: 12000,
      paid_total: 10500,
      unpaid_total: 1500,
    });
    expect(out.last_purchase).toMatchObject({
      purchase_no: 'PO-2026-000005',
      interaction: 'partial',
      remaining: 100,
    });
    // 3 read-only SELECTs, no writes.
    expect(queries).toHaveLength(3);
    for (const q of queries) {
      expect(q.sql).toMatch(/^\s*SELECT/i);
    }
  });

  it('derives interaction="cash" when remaining is effectively zero', async () => {
    const { service } = await makeService({
      responses: [
        [supplierRow()],
        [aggRow()],
        [lastPurchaseRow({ paid_amount: '500.00', remaining: '0.00', status: 'paid' })],
      ],
    });
    const out = await service.supplierContext(SUPPLIER_ID);
    expect(out.last_purchase?.interaction).toBe('cash');
  });

  it('derives interaction="credit" when nothing has been paid yet', async () => {
    const { service } = await makeService({
      responses: [
        [supplierRow()],
        [aggRow()],
        [lastPurchaseRow({ paid_amount: '0.00', remaining: '500.00', status: 'received' })],
      ],
    });
    const out = await service.supplierContext(SUPPLIER_ID);
    expect(out.last_purchase?.interaction).toBe('credit');
  });

  it('returns balance_direction="credit_to_us" for negative balances', async () => {
    const { service } = await makeService({
      responses: [
        [supplierRow({ current_balance: '-250.00' })],
        [aggRow()],
        [lastPurchaseRow()],
      ],
    });
    const out = await service.supplierContext(SUPPLIER_ID);
    expect(out.supplier.balance_direction).toBe('credit_to_us');
    expect(out.supplier.current_balance).toBe(-250);
  });

  it('returns balance_direction="zero" for a zero balance', async () => {
    const { service } = await makeService({
      responses: [
        [supplierRow({ current_balance: '0.00' })],
        [aggRow()],
        [],
      ],
    });
    const out = await service.supplierContext(SUPPLIER_ID);
    expect(out.supplier.balance_direction).toBe('zero');
    expect(out.last_purchase).toBeNull();
  });

  it('throws NotFoundException when the supplier id does not exist', async () => {
    const { service } = await makeService({ responses: [[]] });
    await expect(service.supplierContext(SUPPLIER_ID)).rejects.toThrow(
      NotFoundException,
    );
  });

  it('issues read-only SELECTs — never INSERT/UPDATE/DELETE', async () => {
    const { service, queries } = await makeService({
      responses: [[supplierRow()], [aggRow()], [lastPurchaseRow()]],
    });
    await service.supplierContext(SUPPLIER_ID);
    const allSql = queries.map((q) => q.sql).join('\n');
    expect(allSql).not.toMatch(/\bINSERT\b/i);
    expect(allSql).not.toMatch(/\bUPDATE\b/i);
    expect(allSql).not.toMatch(/\bDELETE\b/i);
    expect(allSql).not.toMatch(/\bMERGE\b/i);
  });
});

describe('PurchasesService.productSearch — PR-PURCHASES-P1', () => {
  function rankedRow(overrides: Record<string, any> = {}) {
    // Column names match the SQL aliases (last_supplier_name /
    // last_supplier_id) — see the LATERAL join in productSearch.
    return {
      variant_id: VARIANT_ID,
      sku: 'SKU-1',
      barcode: '6291234567890',
      color: 'أحمر',
      size: '42',
      cost_price: '120.00',
      selling_price: '180.00',
      variant_image_url: null,
      product_id: PRODUCT_ID,
      sku_root: 'P-001',
      name_ar: 'حذاء جلد',
      name_en: 'Leather Shoe',
      primary_image_url: null,
      base_price: '180.00',
      rank_score: 1,
      available_stock: 7,
      last_purchase_price: '115.00',
      last_purchase_at: '2026-04-01',
      last_supplier_name: 'مورد تجريبي',
      last_supplier_id: SUPPLIER_ID,
      ...overrides,
    };
  }

  it('returns empty results for an empty query without hitting the DB', async () => {
    const { service, queries } = await makeService();
    const out = await service.productSearch({ q: '' });
    expect(out).toEqual({ query: '', results: [] });
    expect(queries).toHaveLength(0);
  });

  it('marks exact barcode / sku / sku_root matches with exact_match=true', async () => {
    const { service } = await makeService({
      responses: [
        [
          rankedRow({ rank_score: 1 }),
          rankedRow({
            variant_id: 'v-2',
            sku: 'SKU-2',
            barcode: '6299999999999',
            rank_score: 4,
          }),
        ],
      ],
    });
    const out = await service.productSearch({
      q: '6291234567890',
      warehouse_id: WAREHOUSE_ID,
      limit: 10,
    });
    expect(out.query).toBe('6291234567890');
    expect(out.results).toHaveLength(2);
    expect(out.results[0]).toMatchObject({
      variant_id: VARIANT_ID,
      exact_match: true,
      rank_score: 1,
      available_stock: 7,
      last_purchase_price: 115,
      last_supplier_name: 'مورد تجريبي',
    });
    expect(out.results[1].exact_match).toBe(false);
    expect(out.results[1].rank_score).toBe(4);
  });

  it('passes the warehouse_id parameter through to the stock LEFT JOIN', async () => {
    const { service, queries } = await makeService({
      responses: [[rankedRow()]],
    });
    await service.productSearch({
      q: 'حذاء',
      warehouse_id: WAREHOUSE_ID,
    });
    expect(queries).toHaveLength(1);
    expect(queries[0].params).toContain(WAREHOUSE_ID);
    expect(queries[0].sql).toMatch(/LEFT JOIN\s+stock\s+s/i);
    expect(queries[0].sql).toMatch(/warehouse_id\s*=\s*\$4/i);
  });

  it('passes a null warehouse_id when the caller omits it (stock still LEFT JOINed)', async () => {
    const { service, queries } = await makeService({
      responses: [[rankedRow()]],
    });
    await service.productSearch({ q: 'كحلي' });
    expect(queries[0].params[3]).toBeNull();
  });

  it('clamps limit to [1, 100]', async () => {
    const { service, queries } = await makeService({
      responses: [[rankedRow()]],
    });
    await service.productSearch({ q: 'حذاء', limit: 999 });
    expect(queries[0].params[2]).toBe(100);

    const fresh = await makeService({ responses: [[rankedRow()]] });
    await fresh.service.productSearch({ q: 'حذاء', limit: 0 });
    expect(fresh.queries[0].params[2]).toBe(1);
  });

  it('SQL is pure SELECT (no INSERT/UPDATE/DELETE)', async () => {
    const { service, queries } = await makeService({
      responses: [[rankedRow()]],
    });
    await service.productSearch({ q: 'بحث' });
    const sql = queries[0].sql;
    expect(sql).toMatch(/^\s*WITH\b/i); // CTE
    expect(sql).not.toMatch(/\bINSERT\b/i);
    expect(sql).not.toMatch(/\bUPDATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\b/i);
  });

  it('ranking SQL prefers exact barcode → sku → sku_root → fuzzy', async () => {
    const { service, queries } = await makeService({
      responses: [[rankedRow()]],
    });
    await service.productSearch({ q: 'X' });
    const sql = queries[0].sql;
    // Order is enforced by the CASE ranks below the WITH CTE
    expect(sql).toMatch(/WHEN\s+LOWER\(v\.barcode\)\s*=\s*LOWER\(\$1\)\s+THEN\s+1/i);
    expect(sql).toMatch(/WHEN\s+LOWER\(v\.sku\)\s*=\s*LOWER\(\$1\)\s+THEN\s+2/i);
    expect(sql).toMatch(/WHEN\s+LOWER\(p\.sku_root\)\s*=\s*LOWER\(\$1\)\s+THEN\s+3/i);
    expect(sql).toMatch(/ORDER BY\s+rank_score/i);
  });

  it('exposes last_purchase_price / last_supplier from a LATERAL join (idempotent on no history)', async () => {
    const { service } = await makeService({
      responses: [
        [
          rankedRow({
            last_purchase_price: null,
            last_purchase_at: null,
            last_supplier_name: null,
            last_supplier_id: null,
          }),
        ],
      ],
    });
    const out = await service.productSearch({ q: 'حذاء' });
    expect(out.results[0]).toMatchObject({
      last_purchase_price: null,
      last_purchase_at: null,
      last_supplier_name: null,
      last_supplier_id: null,
    });
  });
});
