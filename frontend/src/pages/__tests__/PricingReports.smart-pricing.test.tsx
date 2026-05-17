/**
 * PricingReports.smart-pricing.test.tsx — PR-PURCHASES-P3.5A
 *
 * Frontend coverage for the Smart Bulk Pricing Assistant flow.
 * These tests focus on the pricing-only guarantees of P3.5A:
 *
 *   1. Trigger button is present on each applicable tab (health,
 *      losses, landed, sold-profit/products) and NOT on history or
 *      sold-profit/invoices.
 *   2. Selecting rows feeds variant_ids into the modal scope picker.
 *   3. The cost-adjustment note is shown prominently and the modal
 *      never renders any cost-edit UI.
 *   4. Strategy → preview → apply happy path posts the expected
 *      payload to /products/variants/smart-pricing/{preview,apply}.
 *   5. All-scope apply is BLOCKED without the exact Arabic phrase.
 *   6. NEVER calls applyVariantPrices (the P3.2 endpoint), and never
 *      calls any purchases / POS / accounting endpoint.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PricingReports from '../PricingReports';

// Spies for every relevant endpoint.
const healthMock = vi.fn();
const lossesMock = vi.fn();
const historyMock = vi.fn();
const landedMock = vi.fn();
const soldSummaryMock = vi.fn();
const soldProductsMock = vi.fn();
const soldInvoicesMock = vi.fn();

// Smart-pricing spies — preview returns a single "increase" row so the
// apply step has something to do.
const smartPreviewMock = vi.fn();
const smartApplyMock = vi.fn();

// Defensive spies: the smart-pricing flow must NEVER touch any of
// these endpoints. Each is a write that would step outside the
// pricing-only contract.
const applyPricesMock = vi.fn();      // /products/variants/apply-prices
const productPatchMock = vi.fn();     // /products/:id (cost edits live here)
const variantPatchMock = vi.fn();     // /products/variants/:id (cost edits)
const purchaseCreateMock = vi.fn();
const purchasePatchMock = vi.fn();
const posCreateMock = vi.fn();
const journalCreateMock = vi.fn();

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

vi.mock('@/api/products.api', async () => {
  const actual = await vi.importActual<any>('@/api/products.api');
  return {
    ...actual,
    productsApi: {
      ...((actual as any).productsApi ?? {}),
      smartPricingPreview: (body: any) => smartPreviewMock(body),
      smartPricingApply: (body: any) => smartApplyMock(body),
      applyVariantPrices: (body: any) => applyPricesMock(body),
      update: (id: string, body: any) => productPatchMock(id, body),
      updateVariant: (id: string, body: any) => variantPatchMock(id, body),
    },
  };
});

// Belt-and-suspenders: spy on every shared purchases / POS / journal
// surface that exists in the API namespace. Any of these being called
// from inside this page would break the pricing-only contract.
vi.mock('@/api/purchases.api', () => ({
  purchasesApi: {
    create: (body: any) => purchaseCreateMock(body),
    update: (id: string, body: any) => purchasePatchMock(id, body),
  },
}));
vi.mock('@/api/pos.api', () => ({
  posApi: {
    createSale: (body: any) => posCreateMock(body),
  },
}));
vi.mock('@/api/accounting.api', () => ({
  accountingApi: {
    createJournalEntry: (body: any) => journalCreateMock(body),
  },
}));

const HEALTH_ROWS = [
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
];

const PREVIEW_RESPONSE = {
  strategy: 'balanced',
  scope_type: 'selected',
  settings: {
    competitive_markup_pct: 30,
    recommended_margin_pct: 35,
    high_margin_pct: 45,
    wholesale_markup_pct: 20,
    min_margin_pct_default: 15,
    rounding_step: 1,
    rounding_mode: 'nearest',
  },
  summary: { total: 1, increase: 1, decrease: 0, keep: 0, review: 0 },
  items: [
    {
      variant_id: 'v-bc',
      product_id: 'p2',
      product_name: 'صنف خاسر',
      sku: 'BC-1',
      barcode: null,
      color: null,
      size: null,
      current_cost: 100,
      current_price: 80,
      stock_qty: 3,
      qty_sold: 0,
      invoice_count: 0,
      last_sold_at: null,
      current_margin_pct: -25,
      current_markup_pct: -20,
      min_margin_pct: 15,
      recommendation: 'increase',
      suggested_selling_price: 135,
      expected_profit_delta_per_unit: 55,
      final_margin_pct: 25.93,
      final_markup_pct: 35,
      reason_ar: 'رفع السعر للوصول إلى الهامش الموصى به',
      warnings: [],
      skipped_reason: null,
    },
  ],
};

beforeEach(() => {
  healthMock.mockReset();
  lossesMock.mockReset();
  historyMock.mockReset();
  landedMock.mockReset();
  soldSummaryMock.mockReset();
  soldProductsMock.mockReset();
  soldInvoicesMock.mockReset();
  smartPreviewMock.mockReset();
  smartApplyMock.mockReset();
  applyPricesMock.mockReset();
  productPatchMock.mockReset();
  variantPatchMock.mockReset();
  purchaseCreateMock.mockReset();
  purchasePatchMock.mockReset();
  posCreateMock.mockReset();
  journalCreateMock.mockReset();

  healthMock.mockResolvedValue({
    summary: {
      total_variants: 2,
      below_cost: 1,
      below_min_margin: 0,
      no_price: 0,
      unknown_cost: 0,
      ok: 1,
      stock_value_at_cost: 800,
      potential_revenue: 965,
      potential_profit: 165,
    },
    items: HEALTH_ROWS,
  });
  lossesMock.mockResolvedValue({
    summary: { below_cost: 1, below_min_margin: 0, total_loss_exposure: -60 },
    items: [{ ...HEALTH_ROWS[1], loss_exposure: -60, margin_gap_pct: null }],
  });
  historyMock.mockResolvedValue({
    summary: { total: 0, last_change: null },
    items: [],
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
    top_profit_product: null,
    worst_margin_product: null,
  });
  soldProductsMock.mockResolvedValue({
    summary: { total: 1, loss: 0, low_margin: 0, unknown_cost: 0, ok: 1 },
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
    ],
  });
  soldInvoicesMock.mockResolvedValue({
    summary: {
      total: 0,
      revenue: 0,
      cogs: 0,
      gross_profit: 0,
      loss: 0,
      low_margin: 0,
    },
    items: [],
  });
  smartPreviewMock.mockResolvedValue(PREVIEW_RESPONSE);
  smartApplyMock.mockResolvedValue({
    strategy: 'balanced',
    scope_type: 'selected',
    updated: 1,
    skipped: 0,
    items: [
      {
        variant_id: 'v-bc',
        old_selling_price: 80,
        new_selling_price: 135,
        recommendation: 'increase',
        history_id: 'h-1',
      },
    ],
  });
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

async function openAssistantOnHealth() {
  renderPage();
  await screen.findByTestId('pricing-health-row-v-bc');
  // Tick the loss row, then open the assistant.
  fireEvent.click(screen.getByTestId('pricing-row-select-v-bc'));
  fireEvent.click(screen.getByTestId('open-smart-pricing-health'));
  await screen.findByTestId('smart-pricing-modal');
}

describe('PricingReports — P3.5A smart pricing trigger surface', () => {
  it('1. shows trigger on every applicable tab (health/losses/landed/sold-profit products)', async () => {
    renderPage();
    await screen.findByTestId('pricing-health-row-v-bc');
    expect(
      screen.getByTestId('open-smart-pricing-health'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pricing-reports-tab-losses'));
    await screen.findByTestId('pricing-loss-row-v-bc');
    expect(
      screen.getByTestId('open-smart-pricing-losses'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pricing-reports-tab-landed'));
    await screen.findByTestId('pricing-landed-row-v-bc');
    expect(
      screen.getByTestId('open-smart-pricing-landed'),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('pricing-reports-tab-sold-profit'));
    await screen.findByTestId('sold-profit-product-row-v-ok');
    expect(
      screen.getByTestId('open-smart-pricing-sold-profit'),
    ).toBeInTheDocument();
  });

  it('2. does NOT render the trigger on history tab or sold-profit invoices view', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('pricing-reports-tab-history'));
    await waitFor(() => expect(historyMock).toHaveBeenCalled());
    expect(
      screen.queryByTestId('open-smart-pricing-history'),
    ).toBeNull();

    fireEvent.click(screen.getByTestId('pricing-reports-tab-sold-profit'));
    await screen.findByTestId('sold-profit-product-row-v-ok');
    fireEvent.change(screen.getByTestId('sold-profit-view-toggle'), {
      target: { value: 'invoices' },
    });
    await waitFor(() => expect(soldInvoicesMock).toHaveBeenCalled());
    // The trigger is rendered ONLY in products view; once we flip to
    // invoices it disappears.
    expect(
      screen.queryByTestId('open-smart-pricing-sold-profit'),
    ).toBeNull();
  });

  it('3. row selection on health tab counts up the trigger badge', async () => {
    renderPage();
    await screen.findByTestId('pricing-health-row-v-bc');
    const trigger = screen.getByTestId('open-smart-pricing-health');
    expect(trigger).not.toHaveTextContent(/^\d+$/);
    fireEvent.click(screen.getByTestId('pricing-row-select-v-bc'));
    fireEvent.click(screen.getByTestId('pricing-row-select-v-ok'));
    await waitFor(() =>
      expect(
        screen.getByTestId('open-smart-pricing-health'),
      ).toHaveTextContent('2'),
    );
  });
});

describe('PricingReports — P3.5A modal flow', () => {
  it('4. opens with the cost-adjustment note prominently displayed', async () => {
    await openAssistantOnHealth();
    expect(
      screen.getByTestId('smart-pricing-cost-note'),
    ).toHaveTextContent('تعديل التكلفة');
    // Defensive: there must be NO cost input field anywhere in the
    // modal — cost adjustment is deferred to P3.5B.
    const modal = screen.getByTestId('smart-pricing-modal');
    expect(within(modal).queryByLabelText(/التكلفة الجديدة/)).toBeNull();
    expect(within(modal).queryByPlaceholderText(/تكلفة/)).toBeNull();
  });

  it('5. completes scope → strategy → preview → apply with the expected payload', async () => {
    await openAssistantOnHealth();
    // Step 1 — scope: "selected" is auto-chosen since v-bc is checked.
    fireEvent.click(screen.getByTestId('smart-pricing-next-strategy'));
    // Step 2 — strategy: pick balanced explicitly.
    fireEvent.click(screen.getByTestId('smart-pricing-strategy-balanced'));
    fireEvent.click(screen.getByTestId('smart-pricing-generate-preview'));
    await waitFor(() => expect(smartPreviewMock).toHaveBeenCalled());
    expect(smartPreviewMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        strategy: 'balanced',
        scope: expect.objectContaining({
          type: 'selected',
          variant_ids: ['v-bc'],
        }),
      }),
    );
    // Step 3 — preview rendered, row is applicable, go to apply.
    await screen.findByTestId('smart-pricing-step-preview');
    expect(
      screen.getByTestId('smart-pricing-row-v-bc'),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('smart-pricing-go-apply'));
    // Step 4 — fill reason and apply.
    fireEvent.change(screen.getByTestId('smart-pricing-reason'), {
      target: { value: 'إعادة تسعير' },
    });
    fireEvent.click(screen.getByTestId('smart-pricing-apply'));
    await waitFor(() => expect(smartApplyMock).toHaveBeenCalled());
    expect(smartApplyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        strategy: 'balanced',
        reason: 'إعادة تسعير',
        scope: expect.objectContaining({
          type: 'selected',
          variant_ids: ['v-bc'],
        }),
        variant_ids_to_apply: ['v-bc'],
      }),
    );
  });

  it('6. all-scope apply is BLOCKED without the exact Arabic confirmation phrase', async () => {
    renderPage();
    await screen.findByTestId('pricing-health-row-v-bc');
    // Open without selecting anything → "all" is the only meaningful
    // default scope.
    fireEvent.click(screen.getByTestId('open-smart-pricing-health'));
    await screen.findByTestId('smart-pricing-modal');
    fireEvent.click(screen.getByTestId('smart-pricing-scope-all'));
    fireEvent.click(screen.getByTestId('smart-pricing-next-strategy'));
    fireEvent.click(screen.getByTestId('smart-pricing-generate-preview'));
    await screen.findByTestId('smart-pricing-step-preview');
    fireEvent.click(screen.getByTestId('smart-pricing-go-apply'));
    expect(
      screen.getByTestId('smart-pricing-confirm-all-block'),
    ).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('smart-pricing-reason'), {
      target: { value: 'إعادة تسعير' },
    });
    // Wrong text → must NOT fire apply.
    fireEvent.change(screen.getByTestId('smart-pricing-confirm-all-input'), {
      target: { value: 'موافق' },
    });
    fireEvent.click(screen.getByTestId('smart-pricing-apply'));
    await new Promise((r) => setTimeout(r, 20));
    expect(smartApplyMock).not.toHaveBeenCalled();
    // Right text → fires.
    fireEvent.change(screen.getByTestId('smart-pricing-confirm-all-input'), {
      target: { value: 'تأكيد تعديل كل الأصناف' },
    });
    fireEvent.click(screen.getByTestId('smart-pricing-apply'));
    await waitFor(() => expect(smartApplyMock).toHaveBeenCalled());
    expect(smartApplyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        confirm_all: 'تأكيد تعديل كل الأصناف',
        scope: expect.objectContaining({ type: 'all' }),
      }),
    );
  });
});

describe('PricingReports — P3.5A pricing-only contract', () => {
  it('7. NEVER calls applyVariantPrices from the smart-pricing flow', async () => {
    await openAssistantOnHealth();
    fireEvent.click(screen.getByTestId('smart-pricing-next-strategy'));
    fireEvent.click(screen.getByTestId('smart-pricing-generate-preview'));
    await screen.findByTestId('smart-pricing-step-preview');
    fireEvent.click(screen.getByTestId('smart-pricing-go-apply'));
    fireEvent.change(screen.getByTestId('smart-pricing-reason'), {
      target: { value: 'إعادة تسعير' },
    });
    fireEvent.click(screen.getByTestId('smart-pricing-apply'));
    await waitFor(() => expect(smartApplyMock).toHaveBeenCalled());
    expect(applyPricesMock).not.toHaveBeenCalled();
  });

  it('8. NEVER triggers a product / variant PATCH (cost-edit endpoints)', async () => {
    await openAssistantOnHealth();
    fireEvent.click(screen.getByTestId('smart-pricing-next-strategy'));
    fireEvent.click(screen.getByTestId('smart-pricing-generate-preview'));
    await screen.findByTestId('smart-pricing-step-preview');
    fireEvent.click(screen.getByTestId('smart-pricing-go-apply'));
    fireEvent.change(screen.getByTestId('smart-pricing-reason'), {
      target: { value: 'إعادة تسعير' },
    });
    fireEvent.click(screen.getByTestId('smart-pricing-apply'));
    await waitFor(() => expect(smartApplyMock).toHaveBeenCalled());
    expect(productPatchMock).not.toHaveBeenCalled();
    expect(variantPatchMock).not.toHaveBeenCalled();
  });

  it('9. NEVER calls any purchases / POS / accounting endpoint', async () => {
    await openAssistantOnHealth();
    fireEvent.click(screen.getByTestId('smart-pricing-next-strategy'));
    fireEvent.click(screen.getByTestId('smart-pricing-generate-preview'));
    await screen.findByTestId('smart-pricing-step-preview');
    fireEvent.click(screen.getByTestId('smart-pricing-go-apply'));
    fireEvent.change(screen.getByTestId('smart-pricing-reason'), {
      target: { value: 'إعادة تسعير' },
    });
    fireEvent.click(screen.getByTestId('smart-pricing-apply'));
    await waitFor(() => expect(smartApplyMock).toHaveBeenCalled());
    expect(purchaseCreateMock).not.toHaveBeenCalled();
    expect(purchasePatchMock).not.toHaveBeenCalled();
    expect(posCreateMock).not.toHaveBeenCalled();
    expect(journalCreateMock).not.toHaveBeenCalled();
  });
});
