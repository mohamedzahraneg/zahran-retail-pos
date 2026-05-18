/**
 * PricingReports.group-filter.test.tsx — PR-P9.1b
 *
 * Pins the new "المجموعة" dropdown wiring across PricingReports tabs:
 *
 *   1. The dropdown renders on the Health / Losses / Landed / Sold-
 *      Profit (products) / Fair-Price tabs.
 *   2. Selecting a group re-fires the underlying report API with
 *      `group_id`.
 *   3. Selecting a group does NOT call any apply / mutation endpoint.
 *   4. Export buttons forward `group_id` in their params.
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

const productGroupsListMock = vi.fn();

// Defensive mutation spies — must remain at zero throughout.
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

vi.mock('@/api/productGroups.api', () => ({
  productGroupsApi: {
    list: (p: any) => productGroupsListMock(p),
  },
}));

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
  posApi: { createSale: (b: any) => posCreateMock(b) },
}));
vi.mock('@/api/accounting.api', () => ({
  accountingApi: {
    createJournalEntry: (b: any) => journalCreateMock(b),
  },
}));

const GROUPS = [
  {
    id: 'g1',
    name_ar: 'مجموعة الصيف',
    name_en: null,
    description: null,
    color: null,
    is_active: true,
    created_at: '',
    updated_at: '',
    member_count: 3,
  },
];

beforeEach(() => {
  for (const m of [
    healthMock,
    lossesMock,
    historyMock,
    landedMock,
    soldSummaryMock,
    soldProductsMock,
    soldInvoicesMock,
    fairPriceMock,
    exportMock,
    productGroupsListMock,
    smartPreviewMock,
    smartApplyMock,
    costPreviewMock,
    costApplyMock,
    applyPricesMock,
    productPatchMock,
    variantPatchMock,
    purchaseCreateMock,
    purchasePatchMock,
    purchasePayMock,
    posCreateMock,
    journalCreateMock,
  ]) {
    m.mockReset();
  }
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
  fairPriceMock.mockResolvedValue({
    items: [],
    summary: {
      from: '',
      to: '',
      allocation_basis: 'revenue_share',
      overhead_source: 'actual_expenses',
      target_margin_pct: 30,
      overhead_total: 0,
      units_total: 0,
      revenue_total: 0,
      total_candidates: 0,
      returned_count: 0,
      truncated: false,
      variants_below_fair: 0,
      current_gap_total: 0,
      average_overhead_per_unit: 0,
      message_ar: null,
      advisory: '',
    },
  });
  productGroupsListMock.mockResolvedValue(GROUPS);
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

describe('PricingReports — P9.1b group filter', () => {
  async function awaitGroupsLoaded(testIdSuffix: string) {
    const dd = await screen.findByTestId(
      `pricing-group-filter-${testIdSuffix}`,
    );
    // The <option value="g1"> only appears after productGroupsApi.list
    // resolves. Wait for it explicitly so the change event doesn't
    // snap back to '' (empty default).
    await waitFor(() => {
      const opts = (dd as HTMLSelectElement).querySelectorAll('option');
      expect(opts.length).toBeGreaterThan(1);
    });
    return dd as HTMLSelectElement;
  }

  it('1. Health tab renders the group dropdown and forwards group_id', async () => {
    renderPage();
    const dd = await awaitGroupsLoaded('health');
    expect(dd).toBeInTheDocument();
    fireEvent.change(dd, { target: { value: 'g1' } });
    await waitFor(() => {
      const last = healthMock.mock.calls.at(-1)?.[0];
      expect(last?.group_id).toBe('g1');
    });
    // No mutation calls.
    expect(smartApplyMock).not.toHaveBeenCalled();
    expect(costApplyMock).not.toHaveBeenCalled();
    expect(applyPricesMock).not.toHaveBeenCalled();
  });

  it('2. Health tab export forwards group_id', async () => {
    renderPage();
    const dd = await awaitGroupsLoaded('health');
    fireEvent.change(dd, { target: { value: 'g1' } });
    await waitFor(() => {
      const last = healthMock.mock.calls.at(-1)?.[0];
      expect(last?.group_id).toBe('g1');
    });
    fireEvent.click(screen.getByTestId('pricing-export-xlsx-health'));
    await waitFor(() => expect(exportMock).toHaveBeenCalled());
    const [slug, fmt, params] = exportMock.mock.calls.at(-1)!;
    expect(slug).toBe('pricing/health');
    expect(fmt).toBe('xlsx');
    expect(params.group_id).toBe('g1');
  });

  it('3. Losses tab forwards group_id to pricingLosses', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pricing-reports-tab-losses'));
    const dd = await awaitGroupsLoaded('losses');
    fireEvent.change(dd, { target: { value: 'g1' } });
    await waitFor(() => {
      const last = lossesMock.mock.calls.at(-1)?.[0];
      expect(last?.group_id).toBe('g1');
    });
  });

  it('4. Landed-impact tab forwards group_id', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pricing-reports-tab-landed'));
    const dd = await awaitGroupsLoaded('landed');
    fireEvent.change(dd, { target: { value: 'g1' } });
    await waitFor(() => {
      const last = landedMock.mock.calls.at(-1)?.[0];
      expect(last?.group_id).toBe('g1');
    });
  });

  it('5. Sold-profit (products) forwards group_id', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pricing-reports-tab-sold-profit'));
    const dd = await awaitGroupsLoaded('sold-profit');
    fireEvent.change(dd, { target: { value: 'g1' } });
    await waitFor(() => {
      const last = soldProductsMock.mock.calls.at(-1)?.[0];
      expect(last?.group_id).toBe('g1');
    });
  });

  it('6. Fair-Price tab forwards group_id', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pricing-reports-tab-fair-price'));
    const dd = await awaitGroupsLoaded('fair-price');
    fireEvent.change(dd, { target: { value: 'g1' } });
    await waitFor(() => {
      const last = fairPriceMock.mock.calls.at(-1)?.[0];
      expect(last?.group_id).toBe('g1');
    });
  });

  it('7. defensive: selecting a group never fires an apply / mutation endpoint', async () => {
    renderPage();
    const dd = await awaitGroupsLoaded('health');
    fireEvent.change(dd, { target: { value: 'g1' } });
    await waitFor(() => {
      const last = healthMock.mock.calls.at(-1)?.[0];
      expect(last?.group_id).toBe('g1');
    });
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
