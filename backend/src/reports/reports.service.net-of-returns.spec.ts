/**
 * reports.service.net-of-returns.spec.ts — P3.4D
 *
 * Pins the two new net-of-returns service methods + the SQL bind shape:
 *
 *   1. soldProfitNetSummary aggregates sales side + returns side and
 *      computes net_revenue / net_cogs / net_profit / net_margin_pct /
 *      net_markup_pct correctly.
 *   2. The sales side query uses NOT i.is_return AND status IN (...);
 *      period predicate uses COALESCE(completed_at, created_at).
 *   3. The returns side query uses r.status = 'refunded' AND
 *      r.cancelled_at IS NULL; period predicate uses r.refunded_at.
 *   4. Returns are attributed to refunded_at — a return-only period
 *      (no sales) still surfaces a row.
 *   5. soldProfitNetProducts builds a single CTE that joins sales +
 *      returns by variant via FULL OUTER JOIN and emits the qty_sold /
 *      qty_returned / qty_net + sales/returns/net revenue + cogs
 *      columns.
 *   6. Status enum: loss / low_margin / unknown / ok per spec.
 *   7. The static-source guardrail asserts no INSERT/UPDATE/DELETE/
 *      ALTER/DROP/CREATE in the net block + zero forbidden write refs.
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

describe('ReportsService.soldProfitNetSummary — P3.4D', () => {
  it('1. sales only in period → net equals gross', async () => {
    const { service } = await makeService([
      [{ revenue: '1000.00', cogs: '600.00', qty_sold: 10, invoice_count: 5 }],
      [{ revenue: '0.00', cogs: '0.00', qty_returned: 0, return_count: 0 }],
    ]);
    const res = await service.soldProfitNetSummary({
      from: '2026-05-01',
      to: '2026-05-31',
    });
    expect(res.gross_revenue).toBe(1000);
    expect(res.gross_cogs).toBe(600);
    expect(res.gross_profit).toBe(400);
    expect(res.returns_revenue).toBe(0);
    expect(res.returns_cogs).toBe(0);
    expect(res.returns_profit_reversal).toBe(0);
    expect(res.net_revenue).toBe(1000);
    expect(res.net_cogs).toBe(600);
    expect(res.net_profit).toBe(400);
    expect(res.net_margin_pct).toBe(40);
    expect(res.net_markup_pct).toBeCloseTo(66.67, 1);
  });

  it('2. returns only in period (no sales) → negative net surfaces', async () => {
    const { service } = await makeService([
      [{ revenue: '0.00', cogs: '0.00', qty_sold: 0, invoice_count: 0 }],
      [
        {
          revenue: '500.00',
          cogs: '300.00',
          qty_returned: 5,
          return_count: 2,
        },
      ],
    ]);
    const res = await service.soldProfitNetSummary({});
    expect(res.gross_revenue).toBe(0);
    expect(res.returns_revenue).toBe(500);
    expect(res.returns_cogs).toBe(300);
    expect(res.returns_profit_reversal).toBe(200);
    expect(res.net_revenue).toBe(-500);
    expect(res.net_cogs).toBe(-300);
    expect(res.net_profit).toBe(-200);
    // Negative net_revenue → margin / markup go null.
    expect(res.net_margin_pct).toBeNull();
    expect(res.net_markup_pct).toBeNull();
  });

  it('3. partial returns reduce the net correctly', async () => {
    const { service } = await makeService([
      [
        {
          revenue: '1000.00',
          cogs: '600.00',
          qty_sold: 10,
          invoice_count: 5,
        },
      ],
      [
        {
          revenue: '200.00',
          cogs: '120.00',
          qty_returned: 2,
          return_count: 1,
        },
      ],
    ]);
    const res = await service.soldProfitNetSummary({});
    expect(res.net_revenue).toBe(800);
    expect(res.net_cogs).toBe(480);
    expect(res.net_profit).toBe(320);
    expect(res.net_margin_pct).toBe(40);
  });

  const ZERO_SALES = [{ revenue: '0', cogs: '0', qty_sold: 0, invoice_count: 0 }];
  const ZERO_RETURNS = [
    { revenue: '0', cogs: '0', qty_returned: 0, return_count: 0 },
  ];

  it('4. sales query filters use NOT i.is_return + status IN (...) + completed_at/created_at', async () => {
    const { service, calls } = await makeService([ZERO_SALES, ZERO_RETURNS]);
    await service.soldProfitNetSummary({
      from: '2026-05-01',
      to: '2026-05-17',
    });
    const salesSql = calls[0].sql;
    expect(salesSql).toMatch(/i\.status IN \('completed','paid','partially_paid'\)/);
    expect(salesSql).toMatch(/NOT i\.is_return/);
    expect(salesSql).toMatch(/COALESCE\(i\.completed_at, i\.created_at\)/);
    expect(calls[0].params).toEqual(['2026-05-01', '2026-05-17']);
  });

  it('5. returns query filters use r.status=refunded + cancelled_at IS NULL + r.refunded_at', async () => {
    const { service, calls } = await makeService([ZERO_SALES, ZERO_RETURNS]);
    await service.soldProfitNetSummary({
      from: '2026-05-01',
      to: '2026-05-17',
    });
    const returnsSql = calls[1].sql;
    expect(returnsSql).toMatch(/r\.status = 'refunded'/);
    expect(returnsSql).toMatch(/r\.cancelled_at IS NULL/);
    expect(returnsSql).toMatch(/r\.refunded_at >= \$1::timestamptz/);
    expect(returnsSql).toMatch(/r\.refunded_at < \(\$2/);
    expect(returnsSql).toMatch(/JOIN returns r/);
    expect(returnsSql).toMatch(/LEFT JOIN invoice_items ii ON ii\.id = ri\.original_invoice_item_id/);
    expect(calls[1].params).toEqual(['2026-05-01', '2026-05-17']);
  });

  it('6. returns query reads quantity * unit_cost via the ORIGINAL invoice_item — not return_items (which lacks unit_cost)', async () => {
    const { service, calls } = await makeService([ZERO_SALES, ZERO_RETURNS]);
    await service.soldProfitNetSummary({});
    const sql = calls[1].sql;
    expect(sql).toMatch(/SUM\(ri\.quantity \* COALESCE\(ii\.unit_cost, 0\)\)/);
    // Returned revenue uses the system's refund_amount (authoritative
    // per-line refund the customer actually received).
    expect(sql).toMatch(/SUM\(ri\.refund_amount\)/);
  });
});

describe('ReportsService.soldProfitNetProducts — P3.4D', () => {
  it('7. emits a FULL OUTER JOIN combining sales + returns by variant', async () => {
    const { service, calls } = await makeService([[]]);
    await service.soldProfitNetProducts({
      from: '2026-05-01',
      to: '2026-05-17',
    });
    const sql = calls[0].sql;
    expect(sql).toMatch(/WITH sales AS/);
    expect(sql).toMatch(/returns AS/);
    expect(sql).toMatch(/FULL OUTER JOIN returns/);
    expect(sql).toMatch(/COALESCE\(sales\.variant_id, returns\.variant_id\)/);
  });

  it('8. enriches rows with net_profit + net_margin_pct + status', async () => {
    const { service } = await makeService([
      [
        {
          variant_id: 'v-1',
          product_id: 'p-1',
          product_name: 'منتج 1',
          sku: 'SKU-1',
          barcode: null,
          color: null,
          size: null,
          qty_sold: 10,
          qty_returned: 2,
          qty_net: 8,
          sales_revenue: '1000.00',
          returns_revenue: '200.00',
          net_revenue: '800.00',
          sales_cogs: '600.00',
          returns_cogs: '120.00',
          net_cogs: '480.00',
          invoice_count: 3,
          return_count: 1,
          last_sold_at: '2026-05-10T10:00:00Z',
          last_returned_at: '2026-05-15T10:00:00Z',
          min_margin_pct: '15.00',
        },
      ],
    ]);
    const res = await service.soldProfitNetProducts({});
    const r = res.items[0];
    expect(r.net_revenue).toBe(800);
    expect(r.net_cogs).toBe(480);
    expect(r.net_profit).toBe(320);
    expect(r.net_margin_pct).toBe(40);
    expect(r.net_markup_pct).toBeCloseTo(66.67, 1);
    expect(r.status).toBe('ok');
  });

  it('9. status=loss when net_profit < 0', async () => {
    const { service } = await makeService([
      [
        {
          variant_id: 'v-1',
          product_id: 'p-1',
          product_name: 'منتج خاسر',
          sku: 'SKU-LOSS',
          qty_sold: 5,
          qty_returned: 5,
          qty_net: 0,
          sales_revenue: '500.00',
          returns_revenue: '600.00',
          net_revenue: '-100.00',
          sales_cogs: '300.00',
          returns_cogs: '300.00',
          net_cogs: '0.00',
          min_margin_pct: '15.00',
        },
      ],
    ]);
    const res = await service.soldProfitNetProducts({});
    expect(res.items[0].status).toBe('loss');
    expect(res.items[0].net_profit).toBe(-100);
  });

  it('10. status=low_margin when net_margin_pct < min_margin_pct_default', async () => {
    const { service } = await makeService([
      [
        {
          variant_id: 'v-1',
          product_id: 'p-1',
          product_name: 'هامش منخفض',
          sku: 'SKU-LM',
          qty_sold: 10,
          qty_returned: 0,
          qty_net: 10,
          sales_revenue: '1000.00',
          returns_revenue: '0.00',
          net_revenue: '1000.00',
          sales_cogs: '900.00',
          returns_cogs: '0.00',
          net_cogs: '900.00',
          // net_profit=100, margin=10% < min_margin_pct=15
          min_margin_pct: '15.00',
        },
      ],
    ]);
    const res = await service.soldProfitNetProducts({});
    expect(res.items[0].status).toBe('low_margin');
  });

  it('11. status=unknown when both net_revenue ≤ 0 and net_cogs ≤ 0', async () => {
    const { service } = await makeService([
      [
        {
          variant_id: 'v-1',
          product_id: 'p-1',
          product_name: 'مرتجع كامل',
          sku: 'SKU-RET',
          qty_sold: 0,
          qty_returned: 5,
          qty_net: -5,
          sales_revenue: '0.00',
          returns_revenue: '0.00',
          net_revenue: '0.00',
          sales_cogs: '0.00',
          returns_cogs: '0.00',
          net_cogs: '0.00',
          min_margin_pct: '15.00',
        },
      ],
    ]);
    const res = await service.soldProfitNetProducts({});
    expect(res.items[0].status).toBe('unknown');
  });

  it('12. status filter narrows the result client-side', async () => {
    const { service } = await makeService([
      [
        {
          variant_id: 'v-1',
          product_id: 'p-1',
          product_name: 'A',
          sku: 'A',
          qty_sold: 10,
          qty_returned: 0,
          qty_net: 10,
          sales_revenue: '1000',
          returns_revenue: '0',
          net_revenue: '1000',
          sales_cogs: '600',
          returns_cogs: '0',
          net_cogs: '600',
          min_margin_pct: '15',
        },
        {
          variant_id: 'v-2',
          product_id: 'p-2',
          product_name: 'B',
          sku: 'B',
          qty_sold: 0,
          qty_returned: 5,
          qty_net: -5,
          sales_revenue: '0',
          returns_revenue: '500',
          net_revenue: '-500',
          sales_cogs: '0',
          returns_cogs: '300',
          net_cogs: '-300',
          min_margin_pct: '15',
        },
      ],
    ]);
    const res = await service.soldProfitNetProducts({ status: 'loss' });
    expect(res.items).toHaveLength(1);
    expect(res.items[0].sku).toBe('B');
  });

  it('13. the products query carries q filter for both sales and returns CTEs', async () => {
    const { service, calls } = await makeService([[]]);
    await service.soldProfitNetProducts({ q: 'محذية' });
    const sql = calls[0].sql;
    // q is applied on both sides (different table aliases p/pv vs p2/pv2).
    expect(sql).toMatch(/p\.name_ar ILIKE \$/);
    expect(sql).toMatch(/p2\.name_ar ILIKE \$/);
    expect(calls[0].params).toEqual(['%محذية%', '%محذية%']);
  });

  it('14. limit clamps to [1, 5000]', async () => {
    const { service, calls } = await makeService([[]]);
    await service.soldProfitNetProducts({ limit: 99999 });
    expect(calls[0].sql).toMatch(/LIMIT 5000/);
  });
});

describe('ReportsService NET reports — STATIC GUARDRAILS', () => {
  const SRC = readFileSync(
    join(__dirname, 'reports.service.ts'),
    'utf8',
  );

  function netBlock(): string {
    const start = SRC.indexOf('P3.4D — Net-of-returns sold-profit');
    expect(start).toBeGreaterThan(-1);
    return SRC.slice(start);
  }

  it('15. net block contains zero INSERT/UPDATE/DELETE/ALTER/DROP/CREATE', () => {
    const block = netBlock();
    // Strip comment lines (//, /* */, * ) so write-keyword counts come
    // from actual SQL only.
    const stripped = block
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(stripped).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(stripped).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(stripped).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(stripped).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(stripped).not.toMatch(/\bCREATE\s+(TABLE|VIEW|INDEX|TRIGGER)\b/i);
    // UPDATE — only forbidden if it's a SQL UPDATE statement (not the
    // word in a comment / JS variable). The block code uses only
    // SELECT.
    expect(stripped).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
  });

  it('16. net block has zero references to forbidden write surfaces (excluding comment lines)', () => {
    // Strip JS line/block-comment lines so we don't false-positive on
    // documentation that LISTS the forbidden tokens (this very file
    // does that to explain the policy).
    const stripped = netBlock()
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');
    expect(stripped).not.toMatch(/applyVariantPrices/);
    expect(stripped).not.toMatch(/cashbox_transactions/i);
    expect(stripped).not.toMatch(/journal_entries|journal_lines/i);
    expect(stripped).not.toMatch(/stock_movements/i);
    expect(stripped).not.toMatch(/supplier_payments/i);
    expect(stripped).not.toMatch(/purchase_items/i);
    expect(stripped).not.toMatch(/UPDATE purchases/i);
    expect(stripped).not.toMatch(/postSupplierPayment/);
    expect(stripped).not.toMatch(/postPurchase/);
    expect(stripped).not.toMatch(/recordTransaction/);
    expect(stripped).not.toMatch(/financialEngine/i);
  });
});
