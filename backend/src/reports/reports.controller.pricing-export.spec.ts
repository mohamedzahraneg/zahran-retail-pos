/**
 * reports.controller.pricing-export.spec.ts — P3.4C
 *
 * Pins the new xlsx/pdf export behaviour for the seven pricing
 * endpoints under `/api/v1/reports/pricing/...`:
 *
 *   · JSON path is unchanged — bare GET (no `format` param) returns
 *     the same `{ items, summary }` shape the existing UI consumes.
 *   · `format=xlsx|pdf` re-runs the SAME service method (no new
 *     formula, no duplicate query) and funnels rows through the
 *     existing `toXlsx/toPdf` helpers via the `respond()` private.
 *   · Each export endpoint relabels its row to Arabic-keyed columns
 *     matching the spec table.
 *   · The controller never emits an INSERT/UPDATE/DELETE/ALTER/DROP/
 *     CREATE for these endpoints (export is SELECT-only by design).
 *   · No reference to applyVariantPrices, cashbox, journal, stock
 *     mutations, or purchase mutations leaks into the pricing-export
 *     controller block.
 */

import { Test } from '@nestjs/testing';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ReportsController } from './reports.controller';
import { ReportsService } from './reports.service';

function makeSvcSpy(): {
  svc: any;
  toXlsx: jest.Mock;
  toPdf: jest.Mock;
} {
  const toXlsx = jest.fn(
    async (rows: any[], sheetName = 'Report') =>
      Buffer.from(JSON.stringify({ rows, sheetName }) as any),
  );
  const toPdf = jest.fn(
    async (title: string, rows: any[], meta?: any) =>
      Buffer.from(JSON.stringify({ title, rows, meta }) as any),
  );
  const svc: any = {
    pricingHealth: jest.fn(),
    pricingLosses: jest.fn(),
    pricingHistory: jest.fn(),
    pricingLandedImpact: jest.fn(),
    soldProfitSummary: jest.fn(),
    soldProfitProducts: jest.fn(),
    soldProfitInvoices: jest.fn(),
    toXlsx,
    toPdf,
  };
  return { svc, toXlsx, toPdf };
}

function makeRes() {
  const headers: Record<string, string> = {};
  const sent: { buf?: Buffer } = {};
  const res: any = {
    setHeader: (k: string, v: string) => (headers[k] = v),
    send: (buf: Buffer) => {
      sent.buf = buf;
      return res;
    },
  };
  return { res, headers, sent };
}

async function build(svc: any) {
  const moduleRef = await Test.createTestingModule({
    controllers: [ReportsController],
    providers: [{ provide: ReportsService, useValue: svc }],
  }).compile();
  return moduleRef.get(ReportsController);
}

const HEALTH_RAW = {
  variant_id: 'v-1',
  product_id: 'p-1',
  product_name: 'منتج تجريبي',
  sku: 'SKU-1',
  barcode: '6291234567890',
  selling_price: 150,
  cost_price: 100,
  profit: 50,
  margin_pct: 33.33,
  markup_pct: 50,
  min_margin_pct: 15,
  status: 'ok',
  stock_qty: 5,
};

const LOSS_RAW = {
  variant_id: 'v-1',
  product_name: 'منتج خاسر',
  sku: 'SKU-LOSS',
  selling_price: 80,
  cost_price: 100,
  status: 'below_cost',
  loss_exposure: -60,
  margin_gap_pct: null,
  stock_qty: 3,
};

const HISTORY_RAW = {
  id: 'h-1',
  variant_id: 'v-1',
  product_name: 'منتج',
  sku: 'SKU-1',
  old_selling_price: 100,
  new_selling_price: 145,
  delta_amount: 45,
  delta_pct: 45,
  source_purchase_no: 'PO-2026-000001',
  reason: 'مراجعة دورية',
  changed_by_name: 'مدير النظام',
  changed_at: '2026-05-17T10:00:00Z',
};

const LANDED_RAW = {
  variant_id: 'v-1',
  product_name: 'منتج',
  sku: 'SKU-1',
  last_purchase: {
    purchase_no: 'PO-2026-000099',
    supplier_name: 'مورد رئيسي',
  },
  base_unit_cost: 90,
  allocated_cost_per_unit: 10,
  landed_unit_cost: 100,
  current_selling_price: 130,
  margin_pct: 23.08,
  markup_pct: 30,
  needs_review: true,
  needs_review_reason: 'below_min_margin',
};

const SUMMARY_RAW = {
  from: '2026-05-01',
  to: '2026-05-17',
  total_revenue: 1000,
  total_cogs: 600,
  gross_profit: 400,
  gross_margin_pct: 40,
  invoice_count: 5,
  total_qty_sold: 20,
};

const SOLD_PRODUCT_RAW = {
  variant_id: 'v-1',
  product_name: 'منتج',
  sku: 'SKU-1',
  qty_sold: 10,
  invoice_count: 3,
  revenue: 1000,
  cogs: 600,
  gross_profit: 400,
  gross_margin_pct: 40,
  markup_pct: 66.67,
  avg_selling_price: 100,
  avg_unit_cost: 60,
  status: 'ok',
  last_sold_at: '2026-05-15T10:00:00Z',
};

const SOLD_INVOICE_RAW = {
  invoice_id: 'inv-1',
  invoice_no: 'INV-2026-0000001',
  customer_name: 'عميل أ',
  sold_at: '2026-05-15T10:00:00Z',
  item_count: 2,
  qty_sold: 3,
  revenue: 500,
  cogs: 300,
  gross_profit: 200,
  gross_margin_pct: 40,
  status: 'ok',
};

describe('ReportsController pricing export — P3.4C', () => {
  it('1. pricing/health JSON path is unchanged (no format)', async () => {
    const { svc, toXlsx, toPdf } = makeSvcSpy();
    svc.pricingHealth.mockResolvedValue({
      items: [HEALTH_RAW],
      summary: { total_variants: 1 },
    });
    const ctl = await build(svc);
    const r = await ctl.pricingHealth(
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(r).toMatchObject({ items: [HEALTH_RAW], summary: { total_variants: 1 } });
    expect(toXlsx).not.toHaveBeenCalled();
    expect(toPdf).not.toHaveBeenCalled();
  });

  it('2. pricing/health xlsx → Arabic-keyed rows via toXlsx', async () => {
    const { svc, toXlsx } = makeSvcSpy();
    svc.pricingHealth.mockResolvedValue({ items: [HEALTH_RAW], summary: {} });
    const ctl = await build(svc);
    const { res, headers } = makeRes();
    await ctl.pricingHealth(
      undefined,
      undefined,
      undefined,
      undefined,
      'xlsx',
      res,
    );
    expect(toXlsx).toHaveBeenCalledTimes(1);
    const rows = toXlsx.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      'المنتج': 'منتج تجريبي',
      'SKU': 'SKU-1',
      'الباركود': '6291234567890',
      'سعر البيع': 150,
      'التكلفة': 100,
      'الربح المتوقع': 50,
      'هامش الربح %': 33.33,
      'الزيادة على التكلفة %': 50,
      'الحد الأدنى للهامش %': 15,
      'الحالة': 'ok',
      'المخزون': 5,
    });
    expect(headers['Content-Type']).toMatch(/spreadsheetml\.sheet/);
    expect(headers['Content-Disposition']).toMatch(
      /pricing-health-\d+\.xlsx/,
    );
  });

  it('3. pricing/losses xlsx → Arabic columns + loss_exposure', async () => {
    const { svc, toXlsx } = makeSvcSpy();
    svc.pricingLosses.mockResolvedValue({ items: [LOSS_RAW], summary: {} });
    const ctl = await build(svc);
    const { res } = makeRes();
    await ctl.pricingLosses(undefined, undefined, 'xlsx', res);
    const rows = toXlsx.mock.calls[0][0];
    expect(rows[0]).toMatchObject({
      'المنتج': 'منتج خاسر',
      'الخسارة المحتملة': -60,
      'فجوة الهامش %': '',
      'المخزون': 3,
    });
  });

  it('4. pricing/history pdf → meta carries from/to date range', async () => {
    const { svc, toPdf } = makeSvcSpy();
    svc.pricingHistory.mockResolvedValue({
      items: [HISTORY_RAW],
      summary: { total: 1 },
    });
    const ctl = await build(svc);
    const { res } = makeRes();
    await ctl.pricingHistory(
      undefined,
      '2026-05-01',
      '2026-05-17',
      undefined,
      'pdf',
      res,
    );
    expect(toPdf).toHaveBeenCalledTimes(1);
    expect(toPdf.mock.calls[0][0]).toBe('تاريخ تغيير الأسعار');
    expect(toPdf.mock.calls[0][2]).toMatchObject({
      from: '2026-05-01',
      to: '2026-05-17',
    });
    expect(toPdf.mock.calls[0][1][0]).toMatchObject({
      'السعر القديم': 100,
      'السعر الجديد': 145,
      'الفرق': 45,
      'مصدر التغيير / فاتورة الشراء': 'PO-2026-000001',
      'المستخدم': 'مدير النظام',
    });
  });

  it('5. pricing/landed-impact xlsx → nested last_purchase fields flatten correctly', async () => {
    const { svc, toXlsx } = makeSvcSpy();
    svc.pricingLandedImpact.mockResolvedValue({
      items: [LANDED_RAW],
      summary: {},
    });
    const ctl = await build(svc);
    const { res } = makeRes();
    await ctl.pricingLandedImpact(undefined, undefined, undefined, 'xlsx', res);
    const rows = toXlsx.mock.calls[0][0];
    expect(rows[0]).toMatchObject({
      'المنتج': 'منتج',
      'المورد': 'مورد رئيسي',
      'آخر فاتورة شراء': 'PO-2026-000099',
      'تكلفة الشراء الأساسية': 90,
      'المصاريف المحملة': 10,
      'التكلفة النهائية': 100,
      'سعر البيع الحالي': 130,
      'يحتاج مراجعة؟': 'نعم',
      'سبب المراجعة': 'below_min_margin',
    });
  });

  it('6. sold-profit/summary xlsx → one-row sheet + gross-only disclaimer', async () => {
    const { svc, toXlsx } = makeSvcSpy();
    svc.soldProfitSummary.mockResolvedValue(SUMMARY_RAW);
    const ctl = await build(svc);
    const { res } = makeRes();
    await ctl.soldProfitSummary('2026-05-01', '2026-05-17', 'xlsx', res);
    const rows = toXlsx.mock.calls[0][0];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      'من': '2026-05-01',
      'إلى': '2026-05-17',
      'إجمالي المبيعات': 1000,
      'تكلفة البضاعة المباعة': 600,
      'مجمل الربح': 400,
      'هامش الربح %': 40,
      'عدد الفواتير': 5,
      'عدد القطع المباعة': 20,
    });
    // Gross-only disclaimer preserved per spec.
    expect(rows[0]['ملاحظة']).toMatch(/إجمالي المبيعات Gross/);
    expect(rows[0]['ملاحظة']).toMatch(/فواتير المرتجعات مستبعدة/);
  });

  it('7. sold-profit/products xlsx → preserves filters meta + Arabic columns', async () => {
    const { svc, toXlsx } = makeSvcSpy();
    svc.soldProfitProducts.mockResolvedValue({
      items: [SOLD_PRODUCT_RAW],
      summary: {},
    });
    const ctl = await build(svc);
    const { res } = makeRes();
    await ctl.soldProfitProducts(
      'TestQ',
      '2026-05-01',
      '2026-05-17',
      'ok',
      '500',
      'gross_profit_desc',
      'xlsx',
      res,
    );
    expect(svc.soldProfitProducts).toHaveBeenCalledWith({
      q: 'TestQ',
      from: '2026-05-01',
      to: '2026-05-17',
      status: 'ok',
      limit: 500,
      sort: 'gross_profit_desc',
    });
    const rows = toXlsx.mock.calls[0][0];
    expect(rows[0]).toMatchObject({
      'المنتج': 'منتج',
      'الكمية المباعة': 10,
      'إجمالي المبيعات': 1000,
      'تكلفة البضاعة المباعة': 600,
      'مجمل الربح': 400,
      'متوسط سعر البيع': 100,
      'متوسط التكلفة': 60,
    });
  });

  it('8. sold-profit/invoices pdf → Arabic columns + status', async () => {
    const { svc, toPdf } = makeSvcSpy();
    svc.soldProfitInvoices.mockResolvedValue({
      items: [SOLD_INVOICE_RAW],
      summary: {},
    });
    const ctl = await build(svc);
    const { res } = makeRes();
    await ctl.soldProfitInvoices(
      undefined,
      '2026-05-01',
      '2026-05-17',
      undefined,
      undefined,
      'pdf',
      res,
    );
    const rows = toPdf.mock.calls[0][1];
    expect(rows[0]).toMatchObject({
      'رقم الفاتورة': 'INV-2026-0000001',
      'العميل': 'عميل أ',
      'إجمالي المبيعات': 500,
      'الحالة': 'ok',
    });
  });

  it('9. pricing/health JSON path with format=json is still object shape (not array)', async () => {
    const { svc, toXlsx } = makeSvcSpy();
    svc.pricingHealth.mockResolvedValue({ items: [HEALTH_RAW], summary: {} });
    const ctl = await build(svc);
    const r = await ctl.pricingHealth(
      undefined,
      undefined,
      undefined,
      undefined,
      'json',
      undefined,
    );
    expect((r as any).items).toBeDefined();
    expect(toXlsx).not.toHaveBeenCalled();
  });
});

describe('ReportsController pricing export — STATIC GUARDRAILS', () => {
  const SRC = readFileSync(
    join(__dirname, 'reports.controller.ts'),
    'utf8',
  );

  it('10. pricing-export controller block contains no INSERT/UPDATE/DELETE/ALTER/DROP/CREATE', () => {
    const start = SRC.indexOf("'pricing/health'");
    expect(start).toBeGreaterThan(-1);
    const end = SRC.indexOf('// ── Helper ────', start);
    expect(end).toBeGreaterThan(start);
    const block = SRC.slice(start, end);
    // The mapper helpers live above the class, but we still don't
    // expect any write SQL inside the controller methods.
    expect(block).not.toMatch(/\bINSERT\b/i);
    expect(block).not.toMatch(/\bUPDATE\b/i);
    expect(block).not.toMatch(/\bDELETE\b/i);
    expect(block).not.toMatch(/\bALTER\b/i);
    expect(block).not.toMatch(/\bDROP\b/i);
    expect(block).not.toMatch(/\bCREATE\b/i);
  });

  it('11. pricing-export controller block has zero references to forbidden write surfaces', () => {
    const start = SRC.indexOf("'pricing/health'");
    const end = SRC.indexOf('// ── Helper ────', start);
    const block = SRC.slice(start, end);
    expect(block).not.toMatch(/applyVariantPrices/);
    expect(block).not.toMatch(/cashbox/i);
    expect(block).not.toMatch(/journal_entries|journal_lines/i);
    expect(block).not.toMatch(/stock_movements/i);
    expect(block).not.toMatch(/supplier_payments/i);
    expect(block).not.toMatch(/purchase_items|UPDATE purchases/i);
  });
});
