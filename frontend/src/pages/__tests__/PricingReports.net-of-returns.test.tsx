/**
 * PricingReports.net-of-returns.test.tsx — P3.4D
 *
 * Pins the Gross / Net toggle and the two new net endpoints in the
 * "الربح الفعلي" tab:
 *
 *   N1. Default mode is Gross; existing gross UI renders.
 *   N2. Switching to Net hides Gross-only tiles, mounts net summary
 *       tiles, and calls reportsApi.soldProfitNetSummary +
 *       soldProfitNetProducts with the active filters.
 *   N3. Net mode renders the new attribution notice ("refunded_at" /
 *       December-attribution Arabic copy).
 *   N4. Net products table renders the 15 spec columns including the
 *       qty_sold / qty_returned / qty_net trio.
 *   N5. Net export buttons fire with the correct slug.
 *   N6. Switching back to Gross restores the gross UI and stops
 *       hitting net endpoints.
 *   N7. The export flow never calls applyVariantPrices or any
 *       mutating helper.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PricingReports from '../PricingReports';

const exportMock = vi.fn();
const healthMock = vi.fn();
const lossesMock = vi.fn();
const historyMock = vi.fn();
const landedMock = vi.fn();
const soldSummaryMock = vi.fn();
const soldProductsMock = vi.fn();
const soldInvoicesMock = vi.fn();
const netSummaryMock = vi.fn();
const netProductsMock = vi.fn();
const applyPricesMock = vi.fn();

const toastError = vi.fn();
vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: (...a: any[]) => toastError(...a) },
}));

vi.mock('@/api/reports.api', async () => {
  const actual = await vi.importActual<any>('@/api/reports.api');
  return {
    ...actual,
    reportsApi: {
      pricingHealth: (p: any) => healthMock(p),
      pricingLosses: (p: any) => lossesMock(p),
      pricingHistory: (p: any) => historyMock(p),
      pricingLandedImpact: (p: any) => landedMock(p),
      soldProfitSummary: (p: any) => soldSummaryMock(p),
      soldProfitProducts: (p: any) => soldProductsMock(p),
      soldProfitInvoices: (p: any) => soldInvoicesMock(p),
      soldProfitNetSummary: (p: any) => netSummaryMock(p),
      soldProfitNetProducts: (p: any) => netProductsMock(p),
      export: (slug: string, format: any, params: any) =>
        exportMock(slug, format, params),
    },
  };
});

vi.mock('@/api/products.api', async () => {
  const actual = await vi.importActual<any>('@/api/products.api');
  return {
    ...actual,
    productsApi: {
      ...((actual as any).productsApi ?? {}),
      applyVariantPrices: (b: any) => applyPricesMock(b),
    },
  };
});

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  for (const m of [
    exportMock,
    healthMock,
    lossesMock,
    historyMock,
    landedMock,
    soldSummaryMock,
    soldProductsMock,
    soldInvoicesMock,
    netSummaryMock,
    netProductsMock,
    applyPricesMock,
    toastError,
  ]) {
    m.mockReset();
  }
  exportMock.mockResolvedValue(undefined);
  healthMock.mockResolvedValue({
    items: [],
    summary: {
      total_variants: 0,
      below_cost: 0,
      below_min_margin: 0,
      no_price: 0,
      unknown_cost: 0,
      ok: 0,
      stock_value_at_cost: 0,
      potential_revenue: 0,
      potential_profit: 0,
    },
  });
  lossesMock.mockResolvedValue({
    items: [],
    summary: { below_cost: 0, below_min_margin: 0, total_loss_exposure: 0 },
  });
  historyMock.mockResolvedValue({
    items: [],
    summary: { total: 0, last_change: null },
  });
  landedMock.mockResolvedValue({
    items: [],
    summary: { total: 0, needs_review: 0 },
  });
  soldSummaryMock.mockResolvedValue({
    from: '2026-05-01',
    to: '2026-05-31',
    total_revenue: 1000,
    total_cogs: 600,
    gross_profit: 400,
    gross_margin_pct: 40,
    invoice_count: 5,
    total_qty_sold: 20,
  });
  soldProductsMock.mockResolvedValue({
    items: [],
    summary: { total: 0, loss: 0, low_margin: 0, unknown_cost: 0, ok: 0 },
  });
  soldInvoicesMock.mockResolvedValue({
    items: [],
    summary: {
      total: 0,
      revenue: 0,
      cogs: 0,
      gross_profit: 0,
      loss: 0,
      low_margin: 0,
    },
  });
  netSummaryMock.mockResolvedValue({
    from: '2026-05-01',
    to: '2026-05-31',
    gross_revenue: 1000,
    gross_cogs: 600,
    gross_profit: 400,
    qty_sold: 20,
    invoice_count: 5,
    returns_revenue: 200,
    returns_cogs: 120,
    returns_profit_reversal: 80,
    qty_returned: 3,
    return_count: 2,
    net_revenue: 800,
    net_cogs: 480,
    net_profit: 320,
    net_margin_pct: 40,
    net_markup_pct: 66.67,
  });
  netProductsMock.mockResolvedValue({
    from: '2026-05-01',
    to: '2026-05-31',
    summary: {
      total: 1,
      net_revenue: 800,
      net_cogs: 480,
      net_profit: 320,
      loss: 0,
      low_margin: 0,
      unknown: 0,
      ok: 1,
    },
    items: [
      {
        variant_id: 'v-1',
        product_id: 'p-1',
        product_name: 'منتج تجريبي',
        sku: 'SKU-1',
        barcode: null,
        color: 'أحمر',
        size: '42',
        qty_sold: 10,
        qty_returned: 2,
        qty_net: 8,
        sales_revenue: 1000,
        returns_revenue: 200,
        net_revenue: 800,
        sales_cogs: 600,
        returns_cogs: 120,
        net_cogs: 480,
        invoice_count: 5,
        return_count: 2,
        last_sold_at: '2026-05-10T10:00:00Z',
        last_returned_at: '2026-05-20T10:00:00Z',
        net_profit: 320,
        net_margin_pct: 40,
        net_markup_pct: 66.67,
        min_margin_pct: 15,
        status: 'ok',
      },
    ],
  });
});

describe('PricingReports — P3.4D Net-of-Returns', () => {
  async function openSoldProfitTab() {
    render(wrap(<PricingReports />));
    await waitFor(() => expect(healthMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('pricing-reports-tab-sold-profit'));
    await screen.findByTestId('sold-profit-mode-toggle');
  }

  it('N1. default mode is Gross; gross summary renders and net is not queried', async () => {
    await openSoldProfitTab();
    expect(
      screen.getByTestId('sold-profit-mode-gross'),
    ).toHaveAttribute('aria-selected', 'true');
    expect(
      screen.getByTestId('sold-profit-mode-net'),
    ).toHaveAttribute('aria-selected', 'false');
    expect(screen.getByTestId('sold-profit-returns-notice')).toBeInTheDocument();
    await waitFor(() => expect(soldSummaryMock).toHaveBeenCalled());
    // Net endpoints are NOT called while mode=gross.
    expect(netSummaryMock).not.toHaveBeenCalled();
    expect(netProductsMock).not.toHaveBeenCalled();
  });

  it('N2. switching to Net mounts net summary tiles + fires net endpoints with current filters', async () => {
    await openSoldProfitTab();
    fireEvent.change(screen.getByTestId('sold-profit-from'), {
      target: { value: '2026-05-01' },
    });
    fireEvent.change(screen.getByTestId('sold-profit-to'), {
      target: { value: '2026-05-31' },
    });
    fireEvent.click(screen.getByTestId('sold-profit-mode-net'));
    await waitFor(() => expect(netSummaryMock).toHaveBeenCalled());
    expect(netSummaryMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-05-01', to: '2026-05-31' }),
    );
    await waitFor(() => expect(netProductsMock).toHaveBeenCalled());
    expect(netProductsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({ from: '2026-05-01', to: '2026-05-31', limit: 1000 }),
    );
    // Net summary block + tiles render.
    expect(screen.getByTestId('sold-profit-net-summary')).toBeInTheDocument();
  });

  it('N3. Net mode renders the refunded_at attribution notice in Arabic', async () => {
    await openSoldProfitTab();
    fireEvent.click(screen.getByTestId('sold-profit-mode-net'));
    await screen.findByTestId('sold-profit-net-notice');
    expect(screen.getByTestId('sold-profit-net-notice')).toHaveTextContent(
      'يتم نسب المرتجعات إلى تاريخ ردّ المبلغ',
    );
    // Gross-only disclaimer is hidden in Net mode.
    expect(screen.queryByTestId('sold-profit-returns-notice')).toBeNull();
  });

  it('N4. Net products table renders qty_sold / qty_returned / qty_net + net columns', async () => {
    await openSoldProfitTab();
    fireEvent.click(screen.getByTestId('sold-profit-mode-net'));
    await screen.findByTestId('sold-profit-net-row-v-1');
    const row = screen.getByTestId('sold-profit-net-row-v-1');
    expect(row).toHaveTextContent('منتج تجريبي');
    expect(row).toHaveTextContent('SKU-1');
    // qty_sold + qty_returned + qty_net rendered.
    expect(row.textContent).toMatch(/10/);
    expect(row.textContent).toMatch(/2/);
    expect(row.textContent).toMatch(/8/);
    // Net columns rendered (320 net_profit).
    expect(row.textContent).toMatch(/320/);
  });

  it('N5. Net summary + Net products export buttons fire correct slugs', async () => {
    await openSoldProfitTab();
    fireEvent.click(screen.getByTestId('sold-profit-mode-net'));
    await screen.findByTestId('pricing-export-xlsx-sold-profit-net-summary');
    fireEvent.click(screen.getByTestId('pricing-export-xlsx-sold-profit-net-summary'));
    await waitFor(() => expect(exportMock).toHaveBeenCalled());
    expect(exportMock).toHaveBeenLastCalledWith(
      'pricing/sold-profit/net-summary',
      'xlsx',
      expect.any(Object),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId('pricing-export-xlsx-sold-profit-net-summary'),
      ).toHaveTextContent('تصدير Excel'),
    );
    fireEvent.click(screen.getByTestId('pricing-export-pdf-sold-profit-net-products'));
    await waitFor(() => expect(exportMock).toHaveBeenCalledTimes(2));
    expect(exportMock).toHaveBeenLastCalledWith(
      'pricing/sold-profit/net-products',
      'pdf',
      expect.objectContaining({ limit: 1000 }),
    );
  });

  it('N6. switching back to Gross restores gross UI and stops hitting net endpoints', async () => {
    await openSoldProfitTab();
    fireEvent.click(screen.getByTestId('sold-profit-mode-net'));
    await waitFor(() => expect(netSummaryMock).toHaveBeenCalled());
    netSummaryMock.mockClear();
    netProductsMock.mockClear();
    fireEvent.click(screen.getByTestId('sold-profit-mode-gross'));
    await waitFor(() =>
      expect(screen.queryByTestId('sold-profit-net-summary')).toBeNull(),
    );
    // After switching back, gross summary is still cached and net
    // endpoints don't get re-invoked.
    expect(netSummaryMock).not.toHaveBeenCalled();
    expect(netProductsMock).not.toHaveBeenCalled();
  });

  it('N7. export flow never calls applyVariantPrices or any mutating helper', async () => {
    await openSoldProfitTab();
    fireEvent.click(screen.getByTestId('sold-profit-mode-net'));
    await screen.findByTestId('pricing-export-xlsx-sold-profit-net-summary');
    fireEvent.click(screen.getByTestId('pricing-export-xlsx-sold-profit-net-summary'));
    await waitFor(() => expect(exportMock).toHaveBeenCalled());
    expect(applyPricesMock).not.toHaveBeenCalled();
  });
});
