/**
 * EditPurchaseModal.blocked.test.tsx — PR-PURCHASES-P2.3C-FIX
 *
 * Pins the new edit-modal contract after the safe-replacement flow
 * was removed:
 *
 *   1. Draft purchases still submit through `purchasesApi.edit` with
 *      a success toast that says "تم تعديل الفاتورة بنجاح".
 *   2. Received + unpaid purchases render the new blocked banner with
 *      the approved Arabic message; the save button is hidden.
 *   3. Paid / partial purchases render their existing blocked banner;
 *      save button is hidden.
 *   4. Cancelled purchases render their blocked banner; save hidden.
 *   5. No "فاتورة بديلة" / replacement copy survives anywhere in the
 *      modal markup, regardless of status.
 *   6. `purchasesApi.create` and `purchasesApi.receive` are never
 *      called from this modal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EditPurchaseModal } from '../Purchases';

// Hoisted before `vi.mock` factories so they can reference the spies.
const { editMock, getMock, payMock, purchaseCreateMock, purchaseReceiveMock, toastSuccess, toastError } =
  vi.hoisted(() => ({
    editMock: vi.fn(async (_id: string, _body: any) => ({
      edited: true,
      purchase: { id: 'd1', purchase_no: 'PO-2026-000100' },
    })),
    getMock: vi.fn(async (_id: string): Promise<any> => ({})),
    payMock: vi.fn(),
    purchaseCreateMock: vi.fn(),
    purchaseReceiveMock: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
  }));

vi.mock('react-hot-toast', () => ({
  default: { success: toastSuccess, error: toastError },
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

beforeEach(() => {
  editMock.mockClear();
  getMock.mockClear();
  payMock.mockClear();
  purchaseCreateMock.mockClear();
  purchaseReceiveMock.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
});

function withQuery(children: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

const BASE_DETAIL = {
  id: 'd1',
  purchase_no: 'PO-2026-000100',
  status: 'draft',
  paid_amount: '0.00',
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

const RECEIVED_UNPAID_DETAIL = {
  ...BASE_DETAIL,
  id: 'rcv-1',
  status: 'received',
  paid_amount: '0.00',
};

const PAID_DETAIL = {
  ...BASE_DETAIL,
  id: 'pd1',
  status: 'paid',
  paid_amount: '100.00',
};

const PARTIAL_DETAIL = {
  ...BASE_DETAIL,
  id: 'pa1',
  status: 'partial',
  paid_amount: '30.00',
};

const CANCELLED_DETAIL = {
  ...BASE_DETAIL,
  id: 'c1',
  status: 'cancelled',
};

describe('EditPurchaseModal — PR-PURCHASES-P2.3C-FIX (blocked-edit FE)', () => {
  it('1. draft: submits through purchasesApi.edit with the new success toast', async () => {
    getMock.mockResolvedValueOnce(BASE_DETAIL);
    render(withQuery(<EditPurchaseModal id="d1" onClose={() => {}} />));
    // Wait for both the submit button + the items row to render, so
    // `items.length > 0` when we click (otherwise the mutationFn
    // short-circuits with the empty-items error).
    await screen.findByText('صنف ألف');
    await waitFor(() =>
      expect(screen.getByTestId('edit-purchase-submit')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('edit-purchase-submit'));
    await waitFor(() => expect(editMock).toHaveBeenCalledTimes(1));
    expect(editMock.mock.calls[0][0]).toBe('d1');
    expect(toastSuccess).toHaveBeenCalledWith('تم تعديل الفاتورة بنجاح');
    expect(purchaseCreateMock).not.toHaveBeenCalled();
    expect(purchaseReceiveMock).not.toHaveBeenCalled();
    expect(payMock).not.toHaveBeenCalled();
  });

  it('2. received + unpaid: blocked banner shows new Arabic msg; save button hidden', async () => {
    getMock.mockResolvedValueOnce(RECEIVED_UNPAID_DETAIL);
    render(withQuery(<EditPurchaseModal id="rcv-1" onClose={() => {}} />));
    const banner = await screen.findByTestId('edit-purchase-blocked-banner');
    expect(banner.textContent).toContain(
      'تعديل الفاتورة بعد الاستلام غير متاح حاليًا',
    );
    expect(banner.textContent).toContain('مرتجع مشتريات');
    expect(screen.queryByTestId('edit-purchase-submit')).toBeNull();
    expect(editMock).not.toHaveBeenCalled();
  });

  it('3. paid: blocked banner shows partial/paid msg; save button hidden', async () => {
    getMock.mockResolvedValueOnce(PAID_DETAIL);
    render(withQuery(<EditPurchaseModal id="pd1" onClose={() => {}} />));
    const banner = await screen.findByTestId('edit-purchase-blocked-banner');
    expect(banner.textContent).toContain('مسددة جزئيًا أو كليًا');
    expect(screen.queryByTestId('edit-purchase-submit')).toBeNull();
  });

  it('4. partial: blocked banner shows partial/paid msg; save button hidden', async () => {
    getMock.mockResolvedValueOnce(PARTIAL_DETAIL);
    render(withQuery(<EditPurchaseModal id="pa1" onClose={() => {}} />));
    const banner = await screen.findByTestId('edit-purchase-blocked-banner');
    expect(banner.textContent).toContain('مسددة جزئيًا أو كليًا');
    expect(screen.queryByTestId('edit-purchase-submit')).toBeNull();
  });

  it('5. cancelled: blocked banner shows cancelled msg; save button hidden', async () => {
    getMock.mockResolvedValueOnce(CANCELLED_DETAIL);
    render(withQuery(<EditPurchaseModal id="c1" onClose={() => {}} />));
    const banner = await screen.findByTestId('edit-purchase-blocked-banner');
    expect(banner.textContent).toContain('الفاتورة ملغاة');
    expect(screen.queryByTestId('edit-purchase-submit')).toBeNull();
  });

  it('6. NO "فاتورة بديلة" / replacement copy appears in the modal markup', async () => {
    for (const detail of [
      BASE_DETAIL,
      RECEIVED_UNPAID_DETAIL,
      PAID_DETAIL,
      PARTIAL_DETAIL,
      CANCELLED_DETAIL,
    ]) {
      getMock.mockResolvedValueOnce(detail);
      const { container, unmount } = render(
        withQuery(<EditPurchaseModal id={detail.id} onClose={() => {}} />),
      );
      await waitFor(() =>
        expect(screen.getByTestId('edit-purchase-subtitle')).toBeInTheDocument(),
      );
      const text = container.textContent ?? '';
      expect(text).not.toContain('فاتورة بديلة');
      expect(text).not.toContain('إصدار فاتورة بديلة');
      expect(text).not.toContain('سيتم إلغاء الفاتورة');
      // The replacement-warning testid is gone in this PR.
      expect(
        container.querySelector(
          '[data-testid="edit-purchase-replacement-warning"]',
        ),
      ).toBeNull();
      unmount();
    }
  });

  it('7. draft save payload does NOT carry replacement fields', async () => {
    getMock.mockResolvedValueOnce(BASE_DETAIL);
    render(withQuery(<EditPurchaseModal id="d1" onClose={() => {}} />));
    await screen.findByText('صنف ألف');
    await waitFor(() =>
      expect(screen.getByTestId('edit-purchase-submit')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('edit-purchase-submit'));
    await waitFor(() => expect(editMock).toHaveBeenCalledTimes(1));
    const body = editMock.mock.calls[0][1];
    expect(body).toBeDefined();
    expect((body as any).replaces_purchase_id).toBeUndefined();
    expect((body as any).replaced_by_purchase_id).toBeUndefined();
  });
});
