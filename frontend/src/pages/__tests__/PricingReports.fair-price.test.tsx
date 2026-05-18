/**
 * PricingReports.fair-price.test.tsx — PR-P8.1
 *
 * Pins the Fair Price tab UX:
 *   1. Tab renders with the advisory banner prominently displayed.
 *   2. Changing allocation basis re-fires pricingFairPrice with the new
 *      param.
 *   3. Changing overhead source re-fires with the new param.
 *   4. Target-margin input change re-fires with `target_margin_pct`.
 *   5. Truncation warning surfaces when `summary.truncated` is true.
 *   6. Export buttons fire `reportsApi.export('pricing/fair-price', …)`
 *      for both xlsx and pdf.
 *   7. The tab NEVER calls any mutation endpoint
 *      (applyVariantPrices / smartPricingApply / costAdjustmentApply /
 *      purchases create/edit/pay / POS sale).
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
const soldSummaryMock = vi.fn();
const soldProductsMock = vi.fn();
const soldInvoicesMock = vi.fn();
const fairPriceMock = vi.fn();
const exportMock = vi.fn();

// Defensive mutation spies — must stay at zero.
const smartPreviewMock = vi.fn();
const smartApplyMock = vi.fn();
const costPreviewMock = vi.fn();
const costApplyMock = vi.fn();
const applyPricesMock = vi.fn();
const productPatchMock = vi.fn();
const variantPatchMock = vi.fn();
const purchaseCreateMock = vi.fn();
const purchasePatchMock = vi.fn();
const purchasePayMock = vi.fn();
const posCreateMock = vi.fn();
const journalCreateMock = vi.fn();

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
      pricingFairPrice: (p: any) => fairPriceMock(p),
      export: (slug: string, fmt: any, params: any) =>
        exportMock(slug, fmt, params),
    },
  };
});

vi.mock('@/api/products.api', async () => {
  const actual = await vi.importActual<any>('@/api/products.api');
  return {
    ...actual,
    productsApi: {
      ...((actual as any).productsApi ?? {}),
      smartPricingPreview: (b: any) => smartPreviewMock(b),
      smartPricingApply: (b: any) => smartApplyMock(b),
      costAdjustmentPreview: (b: any) => costPreviewMock(b),
      costAdjustmentApply: (b: any) => costApplyMock(b),
      applyVariantPrices: (b: any) => applyPricesMock(b),
      update: (id: string, b: any) => productPatchMock(id, b),
      updateVariant: (id: string, b: any) => variantPatchMock(id, b),
    },
  };
});

vi.mock('@/api/purchases.api', () => ({
  purchasesApi: {
    create: (b: any) => purchaseCreateMock(b),
    edit: (id: string, b: any) => purchasePatchMock(id, b),
    pay: (id: string, b: any) => purchasePayMock(id, b),
  },
}));

vi.mock('@/api/pos.api', () => ({
  posApi: {
    createSale: (b: any) => posCreateMock(b),
  },
}));

vi.mock('@/api/accounting.api', () => ({
  accountingApi: {
    createJournalEntry: (b: any) => journalCreateMock(b),
  },
}));

const ROW_A = {
  variant_id: 'v-a',
  product_id: 'p1',
  product_name: 'صنف ألف',
  sku: 'A-1',
  barcode: null,
  category_name: null,
  current_cost_price: 50,
  current_selling_price: 100,
  units_sold_in_period: 10,
  revenue_in_period: 1000,
  stock_on_hand: 5,
  allocation_weight: 0.6,
  overhead_share: 300,
  overhead_per_unit: 30,
  break_even_price: 80,
  fair_price: 114.29,
  gap_to_fair: 14.29,
  gap_to_fair_pct: 14.29,
  current_margin_pct: 50,
  margin_after_overhead_pct: 20,
  warning: null,
};

const FAIR_RESPONSE = {
  items: [ROW_A],
  summary: {
    from: '2026-04-18',
    to: '2026-05-18',
    allocation_basis: 'revenue_share',
    overhead_source: 'actual_expenses',
    target_margin_pct: 30,
    overhead_total: 500,
    units_total: 10,
    revenue_total: 1000,
    total_candidates: 1,
    returned_count: 1,
    truncated: false,
    variants_below_fair: 1,
    current_gap_total: 14.29,
    average_overhead_per_unit: 30,
    message_ar: null,
    advisory:
      'تقرير استرشادي فقط — لا يقوم بأي تعديل تلقائي على الأسعار، ولا يحرّك مخزون أو خزنة أو قيود محاسبية.',
  },
};

const TRUNCATED_RESPONSE = {
  ...FAIR_RESPONSE,
  summary: {
    ...FAIR_RESPONSE.summary,
    truncated: true,
    total_candidates: 5,
    returned_count: 1,
    message_ar: 'تم عرض أول 1 صنف فقط من 5. ضيّق الفلتر أو زد الحد.',
  },
};

beforeEach(() => {
  healthMock.mockReset();
  lossesMock.mockReset();
  historyMock.mockReset();
  landedMock.mockReset();
  soldSummaryMock.mockReset();
  soldProductsMock.mockReset();
  soldInvoicesMock.mockReset();
  fairPriceMock.mockReset();
  exportMock.mockReset();
  smartPreviewMock.mockReset();
  smartApplyMock.mockReset();
  costPreviewMock.mockReset();
  costApplyMock.mockReset();
  applyPricesMock.mockReset();
  productPatchMock.mockReset();
  variantPatchMock.mockReset();
  purchaseCreateMock.mockReset();
  purchasePatchMock.mockReset();
  purchasePayMock.mockReset();
  posCreateMock.mockReset();
  journalCreateMock.mockReset();

  // Defaults for non-fair-price reports — minimal shapes are enough.
  const EMPTY = {
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
    items: [],
  };
  healthMock.mockResolvedValue(EMPTY);
  lossesMock.mockResolvedValue({ summary: {}, items: [] });
  historyMock.mockResolvedValue({ summary: { total: 0 }, items: [] });
  landedMock.mockResolvedValue({ summary: { total: 0 }, items: [] });
  soldSummaryMock.mockResolvedValue({});
  soldProductsMock.mockResolvedValue({ summary: {}, items: [] });
  soldInvoicesMock.mockResolvedValue({ summary: {}, items: [] });
  fairPriceMock.mockResolvedValue(FAIR_RESPONSE);
  exportMock.mockResolvedValue(undefined);
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

async function openFairPriceTab() {
  renderPage();
  fireEvent.click(screen.getByTestId('pricing-reports-tab-fair-price'));
  await screen.findByTestId('fair-price-tab');
  await waitFor(() => expect(fairPriceMock).toHaveBeenCalled());
}

describe('PricingReports — P8.1 Fair Price tab', () => {
  it('1. renders with advisory banner', async () => {
    await openFairPriceTab();
    expect(screen.getByTestId('fair-price-advisory')).toHaveTextContent(
      'تقرير استرشادي فقط',
    );
    expect(screen.getByTestId('fair-price-advisory')).toHaveTextContent(
      'لا يقوم بأي تعديل تلقائي',
    );
    // Row rendered for our fixture.
    expect(screen.getByTestId('fair-price-row-v-a')).toBeInTheDocument();
  });

  it('2. changing allocation basis re-fires the API with the new param', async () => {
    await openFairPriceTab();
    const firstCalls = fairPriceMock.mock.calls.length;
    fireEvent.change(screen.getByTestId('fair-price-basis'), {
      target: { value: 'units_share' },
    });
    await waitFor(() =>
      expect(fairPriceMock.mock.calls.length).toBeGreaterThan(firstCalls),
    );
    const lastCall = fairPriceMock.mock.calls.at(-1)?.[0];
    expect(lastCall.allocation_basis).toBe('units_share');
  });

  it('3. changing overhead source re-fires the API with the new param', async () => {
    await openFairPriceTab();
    const firstCalls = fairPriceMock.mock.calls.length;
    fireEvent.change(screen.getByTestId('fair-price-source'), {
      target: { value: 'recurring_monthly_equivalent' },
    });
    await waitFor(() =>
      expect(fairPriceMock.mock.calls.length).toBeGreaterThan(firstCalls),
    );
    const lastCall = fairPriceMock.mock.calls.at(-1)?.[0];
    expect(lastCall.overhead_source).toBe('recurring_monthly_equivalent');
  });

  it('4. target-margin input change re-fires with target_margin_pct', async () => {
    await openFairPriceTab();
    fireEvent.change(screen.getByTestId('fair-price-target-margin'), {
      target: { value: '40' },
    });
    await waitFor(() => {
      const lastCall = fairPriceMock.mock.calls.at(-1)?.[0];
      expect(lastCall.target_margin_pct).toBe(40);
    });
  });

  it('5. truncation warning surfaces when summary.truncated=true', async () => {
    fairPriceMock.mockResolvedValueOnce(TRUNCATED_RESPONSE);
    await openFairPriceTab();
    await screen.findByTestId('fair-price-truncated');
    expect(screen.getByTestId('fair-price-truncated')).toHaveTextContent(
      'تم عرض',
    );
  });

  it('6. export buttons call reportsApi.export with the fair-price slug', async () => {
    await openFairPriceTab();
    fireEvent.click(screen.getByTestId('pricing-export-xlsx-fair-price'));
    await waitFor(() =>
      expect(exportMock).toHaveBeenCalledWith(
        'pricing/fair-price',
        'xlsx',
        expect.any(Object),
      ),
    );
    fireEvent.click(screen.getByTestId('pricing-export-pdf-fair-price'));
    await waitFor(() =>
      expect(exportMock).toHaveBeenCalledWith(
        'pricing/fair-price',
        'pdf',
        expect.any(Object),
      ),
    );
  });

  it('7. never calls any mutation endpoint', async () => {
    await openFairPriceTab();
    // Exercise inputs.
    fireEvent.change(screen.getByTestId('fair-price-basis'), {
      target: { value: 'flat_per_sku' },
    });
    fireEvent.change(screen.getByTestId('fair-price-target-margin'), {
      target: { value: '40' },
    });
    fireEvent.change(screen.getByTestId('fair-price-search'), {
      target: { value: 'A-1' },
    });
    await waitFor(() => expect(fairPriceMock.mock.calls.length).toBeGreaterThan(1));
    // Defensive spies must remain at zero.
    expect(smartPreviewMock).not.toHaveBeenCalled();
    expect(smartApplyMock).not.toHaveBeenCalled();
    expect(costPreviewMock).not.toHaveBeenCalled();
    expect(costApplyMock).not.toHaveBeenCalled();
    expect(applyPricesMock).not.toHaveBeenCalled();
    expect(productPatchMock).not.toHaveBeenCalled();
    expect(variantPatchMock).not.toHaveBeenCalled();
    expect(purchaseCreateMock).not.toHaveBeenCalled();
    expect(purchasePatchMock).not.toHaveBeenCalled();
    expect(purchasePayMock).not.toHaveBeenCalled();
    expect(posCreateMock).not.toHaveBeenCalled();
    expect(journalCreateMock).not.toHaveBeenCalled();
  });
});
