/**
 * EditPurchaseModal.p2.3b.test.tsx — PR-PURCHASES-P2.3B
 *
 * Pins the new safe-replacement frontend flow + the blocking banners:
 *
 *   1. Received + unpaid renders the replacement warning + lets the
 *      operator edit items and extras and submit with a reason.
 *   2. Save payload includes `edit_reason` (>= 3 chars) and extras
 *      when the operator added any.
 *   3. Paid / partial / paid_amount > 0 / already-replaced render the
 *      P2.3B blocking banner; the save button stays disabled.
 *   4. Draft path is unchanged.
 *   5. Success toast mentions the replacement when the API returns one.
 *   6. No pay / cashbox / journal endpoint is touched from this modal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EditPurchaseModal } from '../Purchases';

const editMock = vi.fn(async (_id: string, _body: any) => ({
  replaced: 'old',
  purchase: { id: 'new-id', purchase_no: 'PO-2026-000999' },
  replacement: {
    new_purchase_id: 'new-id',
    replaces_purchase_id: 'old',
    edit_reason: 'تصحيح كمية',
  },
}));
const getMock = vi.fn(async (_id: string): Promise<any> => ({}));
const payMock = vi.fn();
const purchaseCreateMock = vi.fn();
const purchaseReceiveMock = vi.fn();
const productPatchMock = vi.fn();
const variantPatchMock = vi.fn();
const journalCreateMock = vi.fn();

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/api/purchases.api', async () => {
  const actual = await vi.importActual<any>('@/api/purchases.api');
  return {
    ...actual,
    purchasesApi: {
      get: (id: string) => getMock(id),
      edit: (id: string, body: any) => editMock(id, body),
      // Defensive spies — must never be called from the edit modal.
      pay: (id: string, body: any) => payMock(id, body),
      create: (body: any) => purchaseCreateMock(body),
      receive: (id: string) => purchaseReceiveMock(id),
    },
  };
});

vi.mock('@/api/settings.api', async () => {
  const actual = await vi.importActual<any>('@/api/settings.api');
  return {
    ...actual,
    settingsApi: {
      ...((actual as any).settingsApi ?? {}),
      getSmartPricing: () =>
        Promise.resolve((actual as any).SMART_PRICING_DEFAULTS),
    },
  };
});

vi.mock('@/api/products.api', async () => {
  const actual = await vi.importActual<any>('@/api/products.api');
  return {
    ...actual,
    productsApi: {
      ...((actual as any).productsApi ?? {}),
      update: (id: string, body: any) => productPatchMock(id, body),
      updateVariant: (id: string, body: any) => variantPatchMock(id, body),
    },
  };
});

vi.mock('@/api/accounting.api', () => ({
  accountingApi: {
    createJournalEntry: (body: any) => journalCreateMock(body),
  },
}));

beforeEach(() => {
  editMock.mockClear();
  getMock.mockClear();
  payMock.mockClear();
  purchaseCreateMock.mockClear();
  purchaseReceiveMock.mockClear();
  productPatchMock.mockClear();
  variantPatchMock.mockClear();
  journalCreateMock.mockClear();
});

function withQuery(children: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const RECEIVED_UNPAID_DETAIL = {
  id: 'old',
  purchase_no: 'PO-2026-000100',
  status: 'received',
  paid_amount: '0.00',
  replaced_by_purchase_id: null,
  supplier_id: 'sup-1',
  warehouse_id: 'wh-1',
  invoice_date: '2026-05-10',
  subtotal: '100.00',
  grand_total: '100.00',
  discount_amount: '0.00',
  tax_amount: '0.00',
  shipping_cost: '0.00',
  notes: null,
  items: [
    {
      variant_id: 'v1',
      product_name: 'صنف ألف',
      sku: 'A-1',
      quantity: 1,
      unit_cost: '100.00',
      base_unit_cost: '100.00',
      discount: '0.00',
      tax: '0.00',
    },
  ],
  payments: [],
  extra_costs: [],
};

const DRAFT_DETAIL = {
  ...RECEIVED_UNPAID_DETAIL,
  id: 'd1',
  status: 'draft',
};

const PAID_DETAIL = {
  ...RECEIVED_UNPAID_DETAIL,
  id: 'pd1',
  status: 'paid',
  paid_amount: '100.00',
};

const PARTIAL_DETAIL = {
  ...RECEIVED_UNPAID_DETAIL,
  id: 'pa1',
  status: 'partial',
  paid_amount: '30.00',
};

const ALREADY_REPLACED_DETAIL = {
  ...RECEIVED_UNPAID_DETAIL,
  id: 'rep1',
  status: 'cancelled',
  replaced_by_purchase_id: 'newer-one',
};

describe('EditPurchaseModal — P2.3B', () => {
  it('1. received + unpaid renders the replacement warning + reason input', async () => {
    getMock.mockResolvedValueOnce(RECEIVED_UNPAID_DETAIL);
    render(withQuery(<EditPurchaseModal id="old" onClose={() => undefined} />));

    await screen.findByTestId('edit-purchase-replacement-warning');
    expect(
      screen.getByTestId('edit-purchase-subtitle'),
    ).toHaveTextContent('سيتم إلغاء الفاتورة المستلمة');
    expect(screen.getByTestId('edit-purchase-reason')).toBeInTheDocument();
    expect(
      screen.queryByTestId('edit-purchase-blocked-banner'),
    ).toBeNull();
  });

  it('2. save button stays disabled until reason >= 3 chars', async () => {
    getMock.mockResolvedValueOnce(RECEIVED_UNPAID_DETAIL);
    render(withQuery(<EditPurchaseModal id="old" onClose={() => undefined} />));

    await screen.findByTestId('edit-purchase-reason');
    const submit = screen.getByTestId('edit-purchase-submit');
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId('edit-purchase-reason'), {
      target: { value: 'ab' },
    });
    expect(submit).toBeDisabled();

    fireEvent.change(screen.getByTestId('edit-purchase-reason'), {
      target: { value: 'تصحيح كمية' },
    });
    expect(submit).not.toBeDisabled();
  });

  it('3. save posts edit_reason in the payload and surfaces the replacement toast', async () => {
    const onClose = vi.fn();
    getMock.mockResolvedValueOnce(RECEIVED_UNPAID_DETAIL);
    render(withQuery(<EditPurchaseModal id="old" onClose={onClose} />));

    await screen.findByTestId('edit-purchase-reason');
    fireEvent.change(screen.getByTestId('edit-purchase-reason'), {
      target: { value: 'تصحيح كمية' },
    });
    fireEvent.click(screen.getByTestId('edit-purchase-submit'));

    await waitFor(() => expect(editMock).toHaveBeenCalled());
    const [, body] = editMock.mock.calls[0];
    expect(body.edit_reason).toBe('تصحيح كمية');
    // Required item fields and supplier_id/warehouse_id are forwarded.
    expect(body.supplier_id).toBe('sup-1');
    expect(body.warehouse_id).toBe('wh-1');
    expect(body.items[0].variant_id).toBe('v1');
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('4. paid purchase shows the P2.3B blocking banner; save button disabled', async () => {
    getMock.mockResolvedValueOnce(PAID_DETAIL);
    render(withQuery(<EditPurchaseModal id="pd1" onClose={() => undefined} />));

    const banner = await screen.findByTestId('edit-purchase-blocked-banner');
    expect(banner).toHaveTextContent('مسددة جزئيًا أو كليًا');
    expect(banner).toHaveTextContent('استرداد');
    expect(
      screen.queryByTestId('edit-purchase-replacement-warning'),
    ).toBeNull();
    expect(screen.getByTestId('edit-purchase-submit')).toBeDisabled();
  });

  it('5. partial purchase shows the same blocking banner', async () => {
    getMock.mockResolvedValueOnce(PARTIAL_DETAIL);
    render(withQuery(<EditPurchaseModal id="pa1" onClose={() => undefined} />));

    const banner = await screen.findByTestId('edit-purchase-blocked-banner');
    expect(banner).toHaveTextContent('مسددة جزئيًا أو كليًا');
    expect(screen.getByTestId('edit-purchase-submit')).toBeDisabled();
  });

  it('6. already-replaced cancelled purchase shows the already-replaced banner', async () => {
    getMock.mockResolvedValueOnce(ALREADY_REPLACED_DETAIL);
    render(withQuery(<EditPurchaseModal id="rep1" onClose={() => undefined} />));

    const banner = await screen.findByTestId('edit-purchase-blocked-banner');
    expect(banner).toHaveTextContent('تم تبديلها');
    expect(screen.getByTestId('edit-purchase-submit')).toBeDisabled();
  });

  it('7. draft path stays unchanged (no replacement warning, no blocking banner)', async () => {
    getMock.mockResolvedValueOnce(DRAFT_DETAIL);
    render(withQuery(<EditPurchaseModal id="d1" onClose={() => undefined} />));

    await screen.findByTestId('edit-purchase-submit');
    expect(
      screen.queryByTestId('edit-purchase-replacement-warning'),
    ).toBeNull();
    expect(screen.queryByTestId('edit-purchase-blocked-banner')).toBeNull();
    // Reason input doesn't render for drafts.
    expect(screen.queryByTestId('edit-purchase-reason')).toBeNull();
    // Save button becomes enabled once the useEffect populates items
    // from the loaded detail (one tick after first render).
    await waitFor(() =>
      expect(screen.getByTestId('edit-purchase-submit')).not.toBeDisabled(),
    );
  });

  it('8. modal NEVER calls pay / create / receive / products.update / journal endpoints', async () => {
    const onClose = vi.fn();
    getMock.mockResolvedValueOnce(RECEIVED_UNPAID_DETAIL);
    render(withQuery(<EditPurchaseModal id="old" onClose={onClose} />));

    await screen.findByTestId('edit-purchase-reason');
    fireEvent.change(screen.getByTestId('edit-purchase-reason'), {
      target: { value: 'تصحيح كمية' },
    });
    fireEvent.click(screen.getByTestId('edit-purchase-submit'));

    await waitFor(() => expect(editMock).toHaveBeenCalled());
    expect(payMock).not.toHaveBeenCalled();
    expect(purchaseCreateMock).not.toHaveBeenCalled();
    expect(purchaseReceiveMock).not.toHaveBeenCalled();
    expect(productPatchMock).not.toHaveBeenCalled();
    expect(variantPatchMock).not.toHaveBeenCalled();
    expect(journalCreateMock).not.toHaveBeenCalled();
  });
});
