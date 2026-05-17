/**
 * PricingReports.cost-adjustment.test.tsx — PR-PURCHASES-P3.6A
 *
 * Frontend coverage for the Smart Cost Adjustment Assistant flow.
 *
 *   1. Trigger button is rendered on the Health tab next to the smart
 *      pricing button.
 *   2. Reference-only note is shown prominently and acknowledged at
 *      apply time.
 *   3. Config → preview → confirmation → apply happy path posts the
 *      expected payload to
 *      /products/variants/cost-adjustments/{preview,apply}.
 *   4. Apply is blocked without the explicit acknowledgement checkbox.
 *   5. Apply is blocked without a reason.
 *   6. NEVER calls smartPricingApply, applyVariantPrices,
 *      productPatch/variantPatch, purchases.create, posApi.createSale,
 *      or accounting.createJournalEntry — cost adjustment is
 *      strictly cost-reference-only.
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

const costPreviewMock = vi.fn();
const costApplyMock = vi.fn();

// Defensive spies — none of these should be called from inside the
// cost-adjustment flow.
const smartPreviewMock = vi.fn();
const smartApplyMock = vi.fn();
const applyPricesMock = vi.fn();
const productPatchMock = vi.fn();
const variantPatchMock = vi.fn();
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
      costAdjustmentPreview: (body: any) => costPreviewMock(body),
      costAdjustmentApply: (body: any) => costApplyMock(body),
      update: (id: string, body: any) => productPatchMock(id, body),
      updateVariant: (id: string, body: any) => variantPatchMock(id, body),
    },
  };
});

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
    variant_id: 'v-a',
    product_id: 'p1',
    product_name: 'الصنف ألف',
    product_type: 'bag',
    sku: 'A-1',
    barcode: null,
    color: 'أحمر',
    size: null,
    cost_price: 100,
    selling_price: 150,
    profit: 50,
    markup_pct: 50,
    margin_pct: 33,
    min_margin_pct: 15,
    status: 'ok',
    stock_qty: 5,
    stock_value_at_cost: 500,
    potential_revenue: 750,
    potential_profit: 250,
  },
  {
    variant_id: 'v-b',
    product_id: 'p2',
    product_name: 'الصنف باء',
    product_type: 'shoe',
    sku: 'B-1',
    barcode: null,
    color: null,
    size: null,
    cost_price: 200,
    selling_price: 260,
    profit: 60,
    markup_pct: 30,
    margin_pct: 23,
    min_margin_pct: 15,
    status: 'ok',
    stock_qty: 3,
    stock_value_at_cost: 600,
    potential_revenue: 780,
    potential_profit: 180,
  },
];

const PREVIEW_RESPONSE = {
  items: [
    {
      variant_id: 'v-a',
      product_id: 'p1',
      product_name: 'الصنف ألف',
      sku: 'A-1',
      barcode: null,
      category_name: null,
      current_cost_price: 100,
      new_cost_price: 110,
      delta_amount: 10,
      delta_pct: 10,
      stock_on_hand: 5,
      inventory_value_before: 500,
      inventory_value_after_reference_only: 550,
      warning: null,
    },
  ],
  summary: {
    total_candidates: 1,
    returned_count: 1,
    truncated: false,
    avg_delta_pct: 10,
    total_inventory_value_before: 500,
    total_inventory_value_after_reference_only: 550,
    message_ar: null,
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
  costPreviewMock.mockReset();
  costApplyMock.mockReset();
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
      below_cost: 0,
      below_min_margin: 0,
      no_price: 0,
      unknown_cost: 0,
      ok: 2,
      stock_value_at_cost: 1100,
      potential_revenue: 1530,
      potential_profit: 430,
    },
    items: HEALTH_ROWS,
  });
  lossesMock.mockResolvedValue({
    summary: { below_cost: 0, below_min_margin: 0, total_loss_exposure: 0 },
    items: [],
  });
  historyMock.mockResolvedValue({
    summary: { total: 0, last_change: null },
    items: [],
  });
  landedMock.mockResolvedValue({
    summary: { total: 0, needs_review: 0 },
    items: [],
  });
  soldSummaryMock.mockResolvedValue({
    from: '2026-05-01',
    to: '2026-05-17',
    total_revenue: 0,
    total_cogs: 0,
    gross_profit: 0,
    gross_margin_pct: 0,
    markup_pct: 0,
    total_qty_sold: 0,
    invoice_count: 0,
    product_count: 0,
    variant_count: 0,
    avg_profit_per_unit: 0,
    top_profit_product: null,
    worst_margin_product: null,
  });
  soldProductsMock.mockResolvedValue({
    summary: { total: 0, loss: 0, low_margin: 0, unknown_cost: 0, ok: 0 },
    items: [],
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

  costPreviewMock.mockResolvedValue(PREVIEW_RESPONSE);
  costApplyMock.mockResolvedValue({
    updated: 1,
    skipped: 0,
    batch_id: 'batch-xyz',
    items: [
      {
        variant_id: 'v-a',
        old_cost_price: 100,
        new_cost_price: 110,
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
  await screen.findByTestId('pricing-health-row-v-a');
  // Tick v-a then open the cost-adjustment assistant.
  fireEvent.click(screen.getByTestId('pricing-row-select-v-a'));
  fireEvent.click(screen.getByTestId('open-cost-adjust-health'));
  await screen.findByTestId('cost-adjust-modal');
}

describe('PricingReports — P3.6A cost-adjustment trigger', () => {
  it('1. renders the cost-adjustment trigger on the Health tab', async () => {
    renderPage();
    await screen.findByTestId('pricing-health-row-v-a');
    expect(screen.getByTestId('open-cost-adjust-health')).toBeInTheDocument();
  });

  it('2. selection count is reflected on the trigger badge', async () => {
    renderPage();
    await screen.findByTestId('pricing-health-row-v-a');
    fireEvent.click(screen.getByTestId('pricing-row-select-v-a'));
    fireEvent.click(screen.getByTestId('pricing-row-select-v-b'));
    await waitFor(() =>
      expect(screen.getByTestId('open-cost-adjust-health')).toHaveTextContent(
        '2',
      ),
    );
  });
});

describe('PricingReports — P3.6A cost-adjustment modal flow', () => {
  it('3. opens with the reference-only note prominently displayed', async () => {
    await openAssistantOnHealth();
    expect(screen.getByTestId('cost-adjust-ref-only-note')).toHaveTextContent(
      'تكلفة مرجعية',
    );
  });

  it('4. config → preview happy path posts the expected payload', async () => {
    await openAssistantOnHealth();
    // Adjustment type defaults to percent_increase; type a value.
    fireEvent.change(screen.getByTestId('cost-adjust-value'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByTestId('cost-adjust-run-preview'));
    await waitFor(() => expect(costPreviewMock).toHaveBeenCalled());
    expect(costPreviewMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scope: 'selected',
        adjustment_type: 'percent_increase',
        adjustment_value: 10,
        variant_ids: ['v-a'],
      }),
    );
    await screen.findByTestId('cost-adjust-step-preview');
  });

  it('5. apply happy path requires reason + acknowledgement and posts apply', async () => {
    await openAssistantOnHealth();
    fireEvent.change(screen.getByTestId('cost-adjust-value'), {
      target: { value: '10' },
    });
    fireEvent.click(screen.getByTestId('cost-adjust-run-preview'));
    await waitFor(() => expect(costPreviewMock).toHaveBeenCalled());

    fireEvent.click(screen.getByTestId('cost-adjust-go-apply'));
    await screen.findByTestId('cost-adjust-step-apply');

    const confirmBtn = screen.getByTestId('cost-adjust-confirm-apply');
    // Acknowledgement + reason are both gated.
    expect(confirmBtn).toBeDisabled();

    fireEvent.change(screen.getByTestId('cost-adjust-reason'), {
      target: { value: 'تحديث قائمة المورد لشهر مايو' },
    });
    expect(confirmBtn).toBeDisabled(); // still need the ack box

    fireEvent.click(screen.getByTestId('cost-adjust-ack'));
    expect(confirmBtn).not.toBeDisabled();

    fireEvent.click(confirmBtn);
    await waitFor(() => expect(costApplyMock).toHaveBeenCalled());
    expect(costApplyMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        scope: 'selected',
        adjustment_type: 'percent_increase',
        adjustment_value: 10,
        reason: 'تحديث قائمة المورد لشهر مايو',
        variant_ids_to_apply: ['v-a'],
      }),
    );

    // Belt-and-suspenders: cost flow MUST NEVER touch any of these.
    expect(smartPreviewMock).not.toHaveBeenCalled();
    expect(smartApplyMock).not.toHaveBeenCalled();
    expect(applyPricesMock).not.toHaveBeenCalled();
    expect(productPatchMock).not.toHaveBeenCalled();
    expect(variantPatchMock).not.toHaveBeenCalled();
    expect(purchaseCreateMock).not.toHaveBeenCalled();
    expect(purchasePatchMock).not.toHaveBeenCalled();
    expect(posCreateMock).not.toHaveBeenCalled();
    expect(journalCreateMock).not.toHaveBeenCalled();
  });

  it('6. preview rejects percent > 500 client-side without calling the server', async () => {
    await openAssistantOnHealth();
    fireEvent.change(screen.getByTestId('cost-adjust-value'), {
      target: { value: '600' },
    });
    // Button stays disabled — the client-side validity guard blocks it.
    expect(screen.getByTestId('cost-adjust-run-preview')).toBeDisabled();
    expect(costPreviewMock).not.toHaveBeenCalled();
  });
});
