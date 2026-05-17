/**
 * PricingReports.export.test.tsx — P3.4C
 *
 * Pins the export buttons on /pricing-reports:
 *
 *   1. Each of the 5 tabs renders both Excel + PDF buttons with
 *      stable test-ids.
 *   2. Clicking a button calls the existing reportsApi.export helper
 *      with the correct slug + format + filters of the active tab.
 *   3. The loading-state copy is the Arabic "جاري تجهيز الملف..."
 *      while the export promise is in flight; on failure an Arabic
 *      toast fires.
 *   4. Export NEVER calls applyVariantPrices, purchasesApi, or any
 *      mutating helper.
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
const applyPricesMock = vi.fn();
const purchaseCreateMock = vi.fn();

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

vi.mock('@/api/purchases.api', () => ({
  purchasesApi: {
    create: (b: any) => purchaseCreateMock(b),
  },
}));

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
    applyPricesMock,
    purchaseCreateMock,
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
    to: '2026-05-17',
    total_revenue: 0,
    total_cogs: 0,
    gross_profit: 0,
    gross_margin_pct: 0,
    invoice_count: 0,
    total_qty_sold: 0,
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
});

describe('PricingReports — P3.4C export buttons', () => {
  it('E1. health tab renders Excel + PDF export buttons', async () => {
    render(wrap(<PricingReports />));
    await waitFor(() => expect(healthMock).toHaveBeenCalled());
    expect(
      screen.getByTestId('pricing-export-xlsx-health'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('pricing-export-pdf-health'),
    ).toBeInTheDocument();
  });

  it('E2. health Excel button calls reportsApi.export with the right slug + format + filters', async () => {
    render(wrap(<PricingReports />));
    await waitFor(() => expect(healthMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('pricing-export-xlsx-health'));
    await waitFor(() => expect(exportMock).toHaveBeenCalled());
    expect(exportMock).toHaveBeenLastCalledWith(
      'pricing/health',
      'xlsx',
      expect.objectContaining({ limit: 1000 }),
    );
  });

  it('E3. losses PDF button calls export with pricing/losses + pdf', async () => {
    render(wrap(<PricingReports />));
    fireEvent.click(screen.getByTestId('pricing-reports-tab-losses'));
    await waitFor(() => expect(lossesMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('pricing-export-pdf-losses'));
    await waitFor(() => expect(exportMock).toHaveBeenCalled());
    expect(exportMock).toHaveBeenLastCalledWith(
      'pricing/losses',
      'pdf',
      expect.any(Object),
    );
  });

  it('E4. history export passes the from/to filters', async () => {
    render(wrap(<PricingReports />));
    fireEvent.click(screen.getByTestId('pricing-reports-tab-history'));
    await waitFor(() => expect(historyMock).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('pricing-history-from'), {
      target: { value: '2026-05-01' },
    });
    fireEvent.change(screen.getByTestId('pricing-history-to'), {
      target: { value: '2026-05-17' },
    });
    fireEvent.click(screen.getByTestId('pricing-export-xlsx-history'));
    await waitFor(() => expect(exportMock).toHaveBeenCalled());
    expect(exportMock).toHaveBeenLastCalledWith(
      'pricing/history',
      'xlsx',
      expect.objectContaining({
        from: '2026-05-01',
        to: '2026-05-17',
        limit: 500,
      }),
    );
  });

  it('E5. landed-impact export carries needs_review_only when checked', async () => {
    render(wrap(<PricingReports />));
    fireEvent.click(screen.getByTestId('pricing-reports-tab-landed'));
    await waitFor(() => expect(landedMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('pricing-landed-needs-review-only'));
    fireEvent.click(screen.getByTestId('pricing-export-pdf-landed'));
    await waitFor(() => expect(exportMock).toHaveBeenCalled());
    expect(exportMock).toHaveBeenLastCalledWith(
      'pricing/landed-impact',
      'pdf',
      expect.objectContaining({ needs_review_only: true }),
    );
  });

  it('E6. sold-profit products export carries sort + date filters', async () => {
    render(wrap(<PricingReports />));
    fireEvent.click(screen.getByTestId('pricing-reports-tab-sold-profit'));
    await waitFor(() => expect(soldProductsMock).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('sold-profit-from'), {
      target: { value: '2026-05-01' },
    });
    fireEvent.change(screen.getByTestId('sold-profit-to'), {
      target: { value: '2026-05-17' },
    });
    fireEvent.change(screen.getByTestId('sold-profit-sort'), {
      target: { value: 'margin_asc' },
    });
    fireEvent.click(
      screen.getByTestId('pricing-export-xlsx-sold-profit-products'),
    );
    await waitFor(() => expect(exportMock).toHaveBeenCalled());
    expect(exportMock).toHaveBeenLastCalledWith(
      'pricing/sold-profit/products',
      'xlsx',
      expect.objectContaining({
        from: '2026-05-01',
        to: '2026-05-17',
        sort: 'margin_asc',
        limit: 1000,
      }),
    );
  });

  it('E7. sold-profit summary export is reachable from the sold-profit tab', async () => {
    render(wrap(<PricingReports />));
    fireEvent.click(screen.getByTestId('pricing-reports-tab-sold-profit'));
    await waitFor(() => expect(soldSummaryMock).toHaveBeenCalled());
    fireEvent.click(
      screen.getByTestId('pricing-export-pdf-sold-profit-summary'),
    );
    await waitFor(() => expect(exportMock).toHaveBeenCalled());
    expect(exportMock).toHaveBeenLastCalledWith(
      'pricing/sold-profit/summary',
      'pdf',
      expect.any(Object),
    );
  });

  it('E8. sold-profit invoices export appears when switching the view', async () => {
    render(wrap(<PricingReports />));
    fireEvent.click(screen.getByTestId('pricing-reports-tab-sold-profit'));
    await waitFor(() => expect(soldSummaryMock).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('sold-profit-view-toggle'), {
      target: { value: 'invoices' },
    });
    await waitFor(() => expect(soldInvoicesMock).toHaveBeenCalled());
    fireEvent.click(
      screen.getByTestId('pricing-export-xlsx-sold-profit-invoices'),
    );
    await waitFor(() => expect(exportMock).toHaveBeenCalled());
    expect(exportMock).toHaveBeenLastCalledWith(
      'pricing/sold-profit/invoices',
      'xlsx',
      expect.any(Object),
    );
  });

  it('E9. failed export fires the Arabic error toast', async () => {
    exportMock.mockRejectedValueOnce(new Error('boom'));
    render(wrap(<PricingReports />));
    await waitFor(() => expect(healthMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('pricing-export-xlsx-health'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastError.mock.calls[0][0]).toBe(
      'تعذر تصدير التقرير. حاول مرة أخرى.',
    );
  });

  it('E10. while in-flight the button shows "جاري تجهيز الملف..."', async () => {
    // Hold the export promise open so we can observe the loading copy.
    let resolveExport: ((v?: any) => void) = () => {};
    exportMock.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveExport = () => resolve();
        }),
    );
    render(wrap(<PricingReports />));
    await waitFor(() => expect(healthMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('pricing-export-xlsx-health'));
    await waitFor(() =>
      expect(
        screen.getByTestId('pricing-export-xlsx-health'),
      ).toHaveTextContent('جاري تجهيز الملف...'),
    );
    // Resolve the pending export → loading copy clears.
    resolveExport();
    await waitFor(() =>
      expect(
        screen.getByTestId('pricing-export-xlsx-health'),
      ).toHaveTextContent('تصدير Excel'),
    );
  });

  it('E11. export does NOT trigger any mutating helper (apply-prices / purchases.create)', async () => {
    render(wrap(<PricingReports />));
    await waitFor(() => expect(healthMock).toHaveBeenCalled());
    // First export fires + resolves before the second click; the
    // component disables both buttons while one is in flight.
    fireEvent.click(screen.getByTestId('pricing-export-xlsx-health'));
    await waitFor(() => expect(exportMock).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId('pricing-export-pdf-health'));
    await waitFor(() => expect(exportMock).toHaveBeenCalledTimes(2));
    expect(applyPricesMock).not.toHaveBeenCalled();
    expect(purchaseCreateMock).not.toHaveBeenCalled();
  });
});
