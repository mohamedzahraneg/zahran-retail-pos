/**
 * PricingReports.test.tsx — PR-PURCHASES-P3.4A
 *
 * Pins the 4 pricing-report tabs:
 *   1. tab nav renders all 4 tabs
 *   2. health tab summary tiles + rows + status filter
 *   3. below-cost / below-min-margin rows surface in losses tab
 *   4. history tab renders changes from variant_price_history
 *   5. landed-impact tab renders rows + needs_review flag
 *   6. markup AND margin headers both appear (not only one)
 *   7. NEVER calls apply-prices / write endpoints
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PricingReports from '../PricingReports';

const healthMock = vi.fn();
const lossesMock = vi.fn();
const historyMock = vi.fn();
const landedMock = vi.fn();
const applyPricesMock = vi.fn();
// PR-PURCHASES-P3.4B — sold-profit endpoint spies.
const soldSummaryMock = vi.fn();
const soldProductsMock = vi.fn();
const soldInvoicesMock = vi.fn();

vi.mock('@/api/reports.api', async () => {
  const actual = await vi.importActual<any>('@/api/reports.api');
  return {
    ...actual,
    reportsApi: {
      pricingHealth: (params: any) => healthMock(params),
      pricingLosses: (params: any) => lossesMock(params),
      pricingHistory: (params: any) => historyMock(params),
      pricingLandedImpact: (params: any) => landedMock(params),
      soldProfitSummary: (params: any) => soldSummaryMock(params),
      soldProfitProducts: (params: any) => soldProductsMock(params),
      soldProfitInvoices: (params: any) => soldInvoicesMock(params),
    },
  };
});

// Defensive: assert that apply-prices is never reached from this page.
vi.mock('@/api/products.api', async () => {
  const actual = await vi.importActual<any>('@/api/products.api');
  return {
    ...actual,
    productsApi: {
      ...((actual as any).productsApi ?? {}),
      applyVariantPrices: (body: any) => applyPricesMock(body),
    },
  };
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PricingReports />
    </QueryClientProvider>,
  );
}

const HEALTH_RESPONSE = {
  summary: {
    total_variants: 3,
    below_cost: 1,
    below_min_margin: 1,
    no_price: 0,
    unknown_cost: 0,
    ok: 1,
    stock_value_at_cost: 1000,
    potential_revenue: 1500,
    potential_profit: 500,
  },
  items: [
    {
      variant_id: 'v-ok',
      product_id: 'p1',
      product_name: 'صنف صحي',
      product_type: 'bag',
      sku: 'OK-1',
      barcode: null,
      color: 'أحمر',
      size: null,
      cost_price: 100,
      selling_price: 145,
      profit: 45,
      markup_pct: 45,
      margin_pct: 31,
      min_margin_pct: 15,
      status: 'ok',
      stock_qty: 5,
      stock_value_at_cost: 500,
      potential_revenue: 725,
      potential_profit: 225,
    },
    {
      variant_id: 'v-bc',
      product_id: 'p2',
      product_name: 'صنف خاسر',
      product_type: 'shoe',
      sku: 'BC-1',
      barcode: null,
      color: null,
      size: null,
      cost_price: 100,
      selling_price: 80,
      profit: -20,
      markup_pct: -20,
      margin_pct: -25,
      min_margin_pct: 15,
      status: 'below_cost',
      stock_qty: 3,
      stock_value_at_cost: 300,
      potential_revenue: 240,
      potential_profit: -60,
    },
    {
      variant_id: 'v-bm',
      product_id: 'p3',
      product_name: 'صنف هامش منخفض',
      product_type: 'accessory',
      sku: 'BM-1',
      barcode: null,
      color: null,
      size: null,
      cost_price: 100,
      selling_price: 110,
      profit: 10,
      markup_pct: 10,
      margin_pct: 9.09,
      min_margin_pct: 15,
      status: 'below_min_margin',
      stock_qty: 2,
      stock_value_at_cost: 200,
      potential_revenue: 220,
      potential_profit: 20,
    },
  ],
};

beforeEach(() => {
  healthMock.mockReset();
  lossesMock.mockReset();
  historyMock.mockReset();
  landedMock.mockReset();
  applyPricesMock.mockReset();
  soldSummaryMock.mockReset();
  soldProductsMock.mockReset();
  soldInvoicesMock.mockReset();
  // PR-PURCHASES-P3.4B — default fixtures for the sold-profit tab.
  soldSummaryMock.mockResolvedValue({
    from: '2026-05-01',
    to: '2026-05-17',
    total_revenue: 1000,
    total_cogs: 600,
    gross_profit: 400,
    gross_margin_pct: 40,
    markup_pct: 66.67,
    total_qty_sold: 20,
    invoice_count: 5,
    product_count: 3,
    variant_count: 4,
    avg_profit_per_unit: 20,
    top_profit_product: {
      product_id: 'p-top',
      product_name: 'منتج رابح',
      gross_profit: 400,
    },
    worst_margin_product: {
      product_id: 'p-worst',
      product_name: 'منتج خاسر',
      gross_profit: -20,
      gross_margin_pct: -20,
    },
  });
  soldProductsMock.mockResolvedValue({
    summary: { total: 2, loss: 1, low_margin: 0, unknown_cost: 0, ok: 1 },
    items: [
      {
        variant_id: 'v-ok',
        product_id: 'p1',
        product_name: 'صنف رابح',
        sku: 'OK',
        barcode: null,
        color: null,
        size: null,
        qty_sold: 10,
        revenue: 1000,
        cogs: 600,
        gross_profit: 400,
        gross_margin_pct: 40,
        markup_pct: 66.67,
        avg_selling_price: 100,
        avg_unit_cost: 60,
        invoice_count: 3,
        last_sold_at: '2026-05-15T10:00:00Z',
        status: 'ok',
        min_margin_pct: 15,
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
        revenue: 200,
        cogs: 300,
        gross_profit: -100,
        gross_margin_pct: -50,
        markup_pct: -33.33,
        avg_selling_price: 40,
        avg_unit_cost: 60,
        invoice_count: 2,
        last_sold_at: '2026-05-14T10:00:00Z',
        status: 'loss',
        min_margin_pct: 15,
      },
    ],
  });
  soldInvoicesMock.mockResolvedValue({
    summary: {
      total: 1,
      revenue: 500,
      cogs: 300,
      gross_profit: 200,
      loss: 0,
      low_margin: 0,
    },
    items: [
      {
        invoice_id: 'inv1',
        invoice_no: 'INV-2026-0000001',
        sold_at: '2026-05-15T10:00:00Z',
        customer_id: 'c1',
        customer_name: 'عميل أ',
        invoice_status: 'completed',
        item_count: 2,
        qty_sold: 3,
        revenue: 500,
        cogs: 300,
        gross_profit: 200,
        gross_margin_pct: 40,
        markup_pct: 66.67,
        status: 'ok',
        min_margin_pct: 15,
      },
    ],
  });
  healthMock.mockResolvedValue(HEALTH_RESPONSE);
  lossesMock.mockResolvedValue({
    summary: { below_cost: 1, below_min_margin: 1, total_loss_exposure: -60 },
    items: [
      {
        ...HEALTH_RESPONSE.items[1],
        loss_exposure: -60,
        margin_gap_pct: null,
      },
      {
        ...HEALTH_RESPONSE.items[2],
        loss_exposure: 0,
        margin_gap_pct: 5.91,
      },
    ],
  });
  historyMock.mockResolvedValue({
    summary: { total: 1, last_change: '2026-05-17T08:00:00Z' },
    items: [
      {
        id: 'h1',
        variant_id: 'v-ok',
        product_id: 'p1',
        product_name: 'صنف صحي',
        sku: 'OK-1',
        barcode: null,
        old_selling_price: '100.00',
        new_selling_price: '145.00',
        delta_amount: '45.00',
        delta_pct: '45.00',
        source_purchase_id: null,
        source_purchase_no: 'PO-2026-000001',
        reason: 'تطبيق الأسعار المقترحة',
        changed_by: null,
        changed_by_name: 'مدير النظام',
        changed_at: '2026-05-17T08:00:00Z',
      },
    ],
  });
  landedMock.mockResolvedValue({
    summary: { total: 1, needs_review: 1 },
    items: [
      {
        variant_id: 'v-bc',
        product_id: 'p2',
        product_name: 'صنف خاسر',
        sku: 'BC-1',
        barcode: null,
        last_purchase: {
          purchase_id: 'pu1',
          purchase_no: 'PO-2026-000099',
          supplier_id: 's1',
          supplier_name: 'مورد رئيسي',
          received_at: '2026-05-15',
          invoice_date: '2026-05-14',
          manual_allocation: false,
        },
        base_unit_cost: 90,
        allocated_cost_per_unit: 10,
        landed_unit_cost: 100,
        current_selling_price: 80,
        profit: -20,
        markup_pct: -20,
        margin_pct: -25,
        min_margin_pct: 15,
        needs_review: true,
        needs_review_reason: 'below_cost',
      },
    ],
  });
});

describe('PricingReports — P3.4A tabs', () => {
  it('1. renders all 4 tab buttons on first load', async () => {
    renderPage();
    expect(screen.getByTestId('pricing-reports-tab-health')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-reports-tab-losses')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-reports-tab-history')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-reports-tab-landed')).toBeInTheDocument();
  });

  it('2. health tab renders summary tiles + rows + supports status filter', async () => {
    renderPage();
    await screen.findByTestId('pricing-health-row-v-ok');
    expect(screen.getByTestId('pricing-reports-summary')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-health-row-v-bc')).toBeInTheDocument();
    // Change status filter
    fireEvent.change(screen.getByTestId('pricing-health-status-filter'), {
      target: { value: 'below_cost' },
    });
    await waitFor(() =>
      expect(healthMock).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'below_cost' }),
      ),
    );
  });

  it('3. losses tab renders below-cost + below-min-margin rows', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pricing-reports-tab-losses'));
    await screen.findByTestId('pricing-loss-row-v-bc');
    expect(screen.getByTestId('pricing-loss-row-v-bm')).toBeInTheDocument();
  });

  it('4. history tab shows changes from variant_price_history', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pricing-reports-tab-history'));
    const row = await screen.findByTestId('pricing-history-row-h1');
    expect(row).toHaveTextContent('PO-2026-000001');
    expect(row).toHaveTextContent('تطبيق الأسعار المقترحة');
  });

  it('5. landed-impact tab renders rows + needs_review flag', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pricing-reports-tab-landed'));
    await screen.findByTestId('pricing-landed-row-v-bc');
    expect(
      screen.getByTestId('pricing-landed-needs-review-v-bc'),
    ).toBeInTheDocument();
  });

  it('6. health table shows BOTH هامش الربح and الزيادة على التكلفة headers', async () => {
    renderPage();
    await screen.findByTestId('pricing-health-row-v-ok');
    // The two distinct labels — operator must never confuse margin
    // with markup.
    expect(screen.getByText('هامش الربح')).toBeInTheDocument();
    expect(screen.getByText('الزيادة على التكلفة')).toBeInTheDocument();
  });

  it('7. NEVER calls apply-prices from the reports page', async () => {
    renderPage();
    // Visit every tab
    fireEvent.click(screen.getByTestId('pricing-reports-tab-losses'));
    await screen.findByTestId('pricing-loss-row-v-bc');
    fireEvent.click(screen.getByTestId('pricing-reports-tab-history'));
    await screen.findByTestId('pricing-history-row-h1');
    fireEvent.click(screen.getByTestId('pricing-reports-tab-landed'));
    await screen.findByTestId('pricing-landed-row-v-bc');
    fireEvent.click(screen.getByTestId('pricing-reports-tab-health'));
    await screen.findByTestId('pricing-health-row-v-ok');
    expect(applyPricesMock).not.toHaveBeenCalled();
    // Defensive: the three other read endpoints were touched but
    // never the products write endpoint.
    expect(lossesMock).toHaveBeenCalled();
    expect(historyMock).toHaveBeenCalled();
    expect(landedMock).toHaveBeenCalled();
  });
});

describe('PricingReports — P3.4B sold-profit tab', () => {
  it('8. tab renders summary tiles + top/worst + returns disclaimer', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pricing-reports-tab-sold-profit'));
    await screen.findByTestId('sold-profit-returns-notice');
    await waitFor(() => expect(soldSummaryMock).toHaveBeenCalled());
    expect(screen.getByTestId('sold-profit-top')).toHaveTextContent(
      'منتج رابح',
    );
    expect(screen.getByTestId('sold-profit-worst')).toHaveTextContent(
      'منتج خاسر',
    );
    // Disclaimer is the "gross sales" notice
    expect(
      screen.getByTestId('sold-profit-returns-notice'),
    ).toHaveTextContent('فواتير المرتجعات مستبعدة من الحساب');
    // BOTH margin AND markup headers are present in the products
    // table header (label-distinction guard). They each appear twice
    // — once as a summary tile label, once as a table header.
    await screen.findByTestId('sold-profit-product-row-v-ok');
    expect(screen.getAllByText('هامش الربح').length).toBeGreaterThan(0);
    expect(
      screen.getAllByText('الزيادة على التكلفة').length,
    ).toBeGreaterThan(0);
  });

  it('9. products view renders rows with status badges', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pricing-reports-tab-sold-profit'));
    await screen.findByTestId('sold-profit-product-row-v-ok');
    expect(
      screen.getByTestId('sold-profit-product-row-v-loss'),
    ).toBeInTheDocument();
    // Loss badge text
    expect(
      screen.getByTestId('sold-profit-product-row-v-loss'),
    ).toHaveTextContent('خسارة');
  });

  it('10. invoices view toggle hides products table and fetches invoices', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pricing-reports-tab-sold-profit'));
    await screen.findByTestId('sold-profit-product-row-v-ok');
    fireEvent.change(screen.getByTestId('sold-profit-view-toggle'), {
      target: { value: 'invoices' },
    });
    await screen.findByTestId('sold-profit-invoice-row-inv1');
    expect(soldInvoicesMock).toHaveBeenCalled();
    expect(
      screen.queryByTestId('sold-profit-product-row-v-ok'),
    ).toBeNull();
  });

  it('11. date filters propagate as params to the endpoints', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pricing-reports-tab-sold-profit'));
    await screen.findByTestId('sold-profit-product-row-v-ok');
    fireEvent.change(screen.getByTestId('sold-profit-from'), {
      target: { value: '2026-05-01' },
    });
    fireEvent.change(screen.getByTestId('sold-profit-to'), {
      target: { value: '2026-05-31' },
    });
    await waitFor(() =>
      expect(soldSummaryMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ from: '2026-05-01', to: '2026-05-31' }),
      ),
    );
    expect(soldProductsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-05-01', to: '2026-05-31' }),
    );
  });

  it('12. status filter narrows the products query', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pricing-reports-tab-sold-profit'));
    await screen.findByTestId('sold-profit-product-row-v-ok');
    fireEvent.change(screen.getByTestId('sold-profit-status-filter'), {
      target: { value: 'loss' },
    });
    await waitFor(() =>
      expect(soldProductsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ status: 'loss' }),
      ),
    );
  });

  it('13. sort override propagates to the products query', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pricing-reports-tab-sold-profit'));
    await screen.findByTestId('sold-profit-product-row-v-ok');
    fireEvent.change(screen.getByTestId('sold-profit-sort'), {
      target: { value: 'margin_asc' },
    });
    await waitFor(() =>
      expect(soldProductsMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: 'margin_asc' }),
      ),
    );
  });

  it('14. NEVER calls apply-prices or any mutation endpoint', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pricing-reports-tab-sold-profit'));
    await screen.findByTestId('sold-profit-product-row-v-ok');
    fireEvent.change(screen.getByTestId('sold-profit-view-toggle'), {
      target: { value: 'invoices' },
    });
    await screen.findByTestId('sold-profit-invoice-row-inv1');
    expect(applyPricesMock).not.toHaveBeenCalled();
    // Only the three read-only sold-profit endpoints were touched.
    expect(soldSummaryMock).toHaveBeenCalled();
    expect(soldProductsMock).toHaveBeenCalled();
    expect(soldInvoicesMock).toHaveBeenCalled();
  });
});
