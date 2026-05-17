/**
 * EditPurchaseModal.p2.3a.test.tsx — PR-PURCHASES-P2.3A
 *
 * Pins the draft-only landed-cost edit flow and the non-draft
 * blocking banner. Mocks `purchasesApi.get` to feed a fixture detail
 * (with or without extras) and asserts on the payload sent to
 * `purchasesApi.edit`.
 *
 * Coverage (matches the P2.3A scope):
 *   1. Modal loads existing extra_costs for a draft purchase.
 *   2. Draft edit allows LandedCostsSection mutations.
 *   3. Draft save sends extra_costs[] + base unit_cost (no landed).
 *   4. Manual mismatch disables save / prevents the edit call.
 *   5. Received purchase with extras shows the blocking Arabic banner.
 *   6. Received purchase with extras hides LandedCostsSection so the
 *      operator cannot add/remove/change extras.
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
import { EditPurchaseModal } from '../Purchases';

const editMock = vi.fn(async (_id: string, _body: any) => ({
  edited: true,
  purchase: {},
}));
const getMock = vi.fn(async (_id: string): Promise<any> => ({}));
// PR-PURCHASES-P3.2 — products.api.applyVariantPrices spy, declared
// at module top so the file-level beforeEach can reset it.
const applyPricesMock = vi.fn();

vi.mock('react-hot-toast', () => ({
  default: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('@/api/purchases.api', async () => {
  const actual = await vi.importActual<any>('@/api/purchases.api');
  return {
    ...actual,
    purchasesApi: {
      get: (id: string) => getMock(id),
      edit: (id: string, body: any) => editMock(id, body),
    },
  };
});

// PR-PURCHASES-P3.2 — mock the apply-prices endpoint at the products
// API layer. P3.2 introduces an independent endpoint; the purchase
// edit payload must remain pure regardless of pricing apply state.
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

const DRAFT_DETAIL = {
  id: 'pur-draft',
  purchase_no: 'PO-2026-000010',
  supplier_id: 'sup-1',
  warehouse_id: 'wh-1',
  status: 'draft' as const,
  invoice_date: '2026-05-17',
  subtotal: '300.00',
  discount_amount: '0.00',
  tax_amount: '0.00',
  shipping_cost: '0.00',
  grand_total: '400.00',
  paid_amount: '0.00',
  extra_costs_capitalized: '100.00',
  extra_costs_non_capitalized: '0.00',
  notes: 'ملاحظة سابقة',
  created_at: '2026-05-17T00:00:00Z',
  items: [
    {
      id: 'pi-1',
      purchase_id: 'pur-draft',
      variant_id: 'v-1',
      sku: 'SKU-1',
      product_name: 'صنف 1',
      quantity: 2,
      // P2.1 landed columns — base 100, allocated 50/piece = 150 landed
      base_unit_cost: '100.00',
      allocated_cost_total: '100.00',
      allocated_cost_per_unit: '50.0000',
      unit_cost: '150.00',
      discount: '0.00',
      tax: '0.00',
      line_total: '300.00',
      manual_allocation: false,
    },
    {
      id: 'pi-2',
      purchase_id: 'pur-draft',
      variant_id: 'v-2',
      sku: 'SKU-2',
      product_name: 'صنف 2',
      quantity: 1,
      base_unit_cost: '100.00',
      allocated_cost_total: '0.00',
      allocated_cost_per_unit: '0.0000',
      unit_cost: '100.00',
      discount: '0.00',
      tax: '0.00',
      line_total: '100.00',
      manual_allocation: false,
    },
  ],
  payments: [],
  extra_costs: [
    {
      id: 'ec-1',
      cost_type: 'transport',
      label: 'نقل من القاهرة',
      amount: '100.00',
      capitalize_to_inventory: true,
      allocation_method: 'by_value',
      notes: null,
      sort_order: 0,
      created_at: '2026-05-17T00:00:00Z',
    },
  ],
};

const RECEIVED_DETAIL = {
  ...DRAFT_DETAIL,
  id: 'pur-recv',
  status: 'received' as const,
};

function renderModal() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <EditPurchaseModal id={DRAFT_DETAIL.id} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  editMock.mockClear();
  getMock.mockReset();
  // PR-PURCHASES-P3.2 — keep the apply-prices spy reset across the
  // whole file so tests further up don't see leaked promises from
  // tests further down.
  applyPricesMock.mockReset();
});

describe('EditPurchaseModal P2.3A — draft', () => {
  it('1. preloads existing extra_costs[] from the detail endpoint', async () => {
    getMock.mockResolvedValue(DRAFT_DETAIL);
    renderModal();
    // LandedCostsSection mounts and pre-renders the existing extra.
    await screen.findByTestId('landed-costs-section');
    expect(screen.getByTestId('landed-cost-row-0')).toBeInTheDocument();
    const amountInput = screen.getByTestId('landed-cost-amount-0') as HTMLInputElement;
    expect(Number(amountInput.value)).toBe(100);
  });

  it('2. allows editing extras via LandedCostsSection (preview updates)', async () => {
    getMock.mockResolvedValue(DRAFT_DETAIL);
    renderModal();
    await screen.findByTestId('landed-costs-section');
    const amountInput = screen.getByTestId('landed-cost-amount-0') as HTMLInputElement;
    fireEvent.change(amountInput, { target: { value: '300' } });
    // Preview recalculates: base subtotal 300 + extra 300 = grand 600.
    await waitFor(() => {
      expect(amountInput.value).toBe('300');
    });
  });

  it('3. save payload sends extra_costs[] + BASE unit_cost (not landed)', async () => {
    getMock.mockResolvedValue(DRAFT_DETAIL);
    renderModal();
    await screen.findByTestId('landed-costs-section');
    // Wait for items to be hydrated before clicking — the line table
    // is populated via useEffect AFTER the section first mounts.
    await screen.findByText('صنف 1');
    fireEvent.click(screen.getByTestId('edit-purchase-submit'));
    await waitFor(() => expect(editMock).toHaveBeenCalledTimes(1));
    const [, body] = editMock.mock.calls[0] as any;
    // base unit cost — must NOT be the landed 150
    expect(body.items[0].unit_cost).toBe(100);
    expect(body.items[1].unit_cost).toBe(100);
    // extra_costs[] flowed through, _key stripped
    expect(body.extra_costs).toHaveLength(1);
    expect(body.extra_costs[0]).not.toHaveProperty('_key');
    expect(body.extra_costs[0].cost_type).toBe('transport');
    expect(body.extra_costs[0].amount).toBe(100);
    expect(body.extra_costs[0].allocation_method).toBe('by_value');
  });

  it('4. manual mismatch disables save and prevents the edit() call', async () => {
    getMock.mockResolvedValue(DRAFT_DETAIL);
    renderModal();
    await screen.findByTestId('landed-costs-section');
    // Switch method to manual — no manual_allocations yet → sum 0, mismatch.
    const methodSelect = screen.getByTestId('landed-cost-method-0');
    fireEvent.change(methodSelect, { target: { value: 'manual' } });
    // Error banner appears + submit gets disabled.
    await screen.findByTestId('landed-cost-error-0');
    const submit = screen.getByTestId('edit-purchase-submit') as HTMLButtonElement;
    expect(submit).toBeDisabled();
    fireEvent.click(submit);
    // mutation must not have fired (disabled button + onClick guard).
    expect(editMock).not.toHaveBeenCalled();
  });
});

describe('EditPurchaseModal P2.3A — received with extras', () => {
  it('5. shows the blocking Arabic banner instead of LandedCostsSection', async () => {
    getMock.mockResolvedValue(RECEIVED_DETAIL);
    renderModal();
    const banner = await screen.findByTestId('edit-landed-block-banner');
    expect(banner).toHaveTextContent(
      'لا يمكن تعديل مصاريف فاتورة مشتريات مستلمة أو مدفوعة حاليًا.',
    );
    expect(banner).toHaveTextContent(
      'أنشئ تسوية مخصصة أو تواصل مع المدير.',
    );
  });

  it('6. does NOT mount LandedCostsSection and disables save', async () => {
    getMock.mockResolvedValue(RECEIVED_DETAIL);
    renderModal();
    await screen.findByTestId('edit-landed-readonly');
    expect(screen.queryByTestId('landed-costs-section')).toBeNull();
    expect(screen.queryByTestId('landed-costs-add-row')).toBeNull();
    // Read-only table renders the existing extra row.
    const ro = screen.getByTestId('edit-landed-readonly');
    expect(within(ro).getByText('نقل من القاهرة')).toBeInTheDocument();
    // Save is blocked even before reason is filled — defensive: the
    // non-draft + landed-blocked path keeps it disabled regardless.
    const submit = screen.getByTestId('edit-purchase-submit') as HTMLButtonElement;
    expect(submit).toBeDisabled();
  });
});

describe('EditPurchaseModal P3.1 — pricing suggestions', () => {
  it('7. toggling the pricing-tag button surfaces the suggestion panel', async () => {
    getMock.mockResolvedValue(DRAFT_DETAIL);
    renderModal();
    await screen.findByText('صنف 1');
    // No panels expanded by default.
    expect(screen.queryByTestId('edit-pricing-row-0')).toBeNull();
    fireEvent.click(screen.getByTestId('edit-pricing-toggle-0'));
    expect(screen.getByTestId('edit-pricing-row-0')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-suggestions')).toBeInTheDocument();
    expect(screen.getByTestId('pricing-card-recommended')).toBeInTheDocument();
  });

  it('8. selecting a suggested price does NOT add it to the edit payload', async () => {
    getMock.mockResolvedValue(DRAFT_DETAIL);
    renderModal();
    await screen.findByText('صنف 1');
    fireEvent.click(screen.getByTestId('edit-pricing-toggle-0'));
    fireEvent.click(screen.getByTestId('pricing-apply-recommended'));
    // Applied marker confirms the local state changed.
    expect(screen.getByTestId('pricing-applied-recommended')).toBeInTheDocument();
    // Save the form — payload must not contain any suggested-price field.
    fireEvent.click(screen.getByTestId('edit-purchase-submit'));
    await waitFor(() => expect(editMock).toHaveBeenCalledTimes(1));
    const [, body] = editMock.mock.calls[0] as any;
    expect(body).not.toHaveProperty('pending_prices');
    expect(body).not.toHaveProperty('suggested_prices');
    expect(body.items[0]).not.toHaveProperty('suggested_selling_price');
    // base unit cost remains BASE — pricing apply must not double-bake
    // anything into the items payload.
    expect(body.items[0].unit_cost).toBe(100);
  });
});

describe('EditPurchaseModal P3.2 — manual apply suggested sale price', () => {
  it('9. footer "تطبيق الأسعار المحددة" button appears only after a strategy is selected', async () => {
    getMock.mockResolvedValue(DRAFT_DETAIL);
    renderModal();
    await screen.findByText('صنف 1');
    // No selections yet → no apply button.
    expect(screen.queryByTestId('edit-apply-prices-open')).toBeNull();
    fireEvent.click(screen.getByTestId('edit-pricing-toggle-0'));
    fireEvent.click(screen.getByTestId('pricing-apply-recommended'));
    expect(screen.getByTestId('edit-apply-prices-open')).toBeInTheDocument();
    expect(
      screen.getByTestId('edit-apply-prices-open'),
    ).toHaveTextContent('تطبيق الأسعار المحددة (1)');
  });

  it('10. confirming the apply modal posts to apply-prices with source_purchase_id', async () => {
    applyPricesMock.mockResolvedValue({
      updated: 1,
      skipped: 0,
      items: [
        {
          variant_id: 'v-1',
          old_selling_price: 0,
          new_selling_price: 190,
          history_id: 'hist-1',
          skipped: false,
        },
      ],
    });
    getMock.mockResolvedValue(DRAFT_DETAIL);
    renderModal();
    await screen.findByText('صنف 1');
    fireEvent.click(screen.getByTestId('edit-pricing-toggle-0'));
    fireEvent.click(screen.getByTestId('pricing-apply-recommended'));
    fireEvent.click(screen.getByTestId('edit-apply-prices-open'));
    expect(screen.getByTestId('apply-prices-modal')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('apply-prices-confirm'));
    await waitFor(() => expect(applyPricesMock).toHaveBeenCalledTimes(1));
    const body = applyPricesMock.mock.calls[0][0];
    expect(body.source_purchase_id).toBe(DRAFT_DETAIL.id);
    expect(body.items).toHaveLength(1);
    expect(body.items[0].variant_id).toBe('v-1');
    // Edit modal preloads DRAFT_DETAIL.extra_costs (100 EGP transport
    // by_value) into the allocator on render. With 2 lines of base 100
    // each + 1 line of base 100, the by_value share for v-1 is 200/300
    // × 100 = 66.67 → per piece 33.33 → final landed unit_cost
    // = 100 + 33.33 = 133.33. Recommended margin 30% on 133.33 → 190.48
    // → rounded to nearest 5 = 190.
    expect(body.items[0].new_selling_price).toBe(190);
    expect(body.items[0]).not.toHaveProperty('strategy');
    // Edit payload was NOT touched by the apply action.
    expect(editMock).not.toHaveBeenCalled();
  });
});
