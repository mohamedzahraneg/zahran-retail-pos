/**
 * Returns.ux-1e-table-modal-cancel.test.tsx
 * ─────────────────────────────────────────────────────────────────────
 * PR-FIN-RETURNS-UX-1E — pins the new full-width table + details modal
 * + smart filters + admin cancel UI:
 *
 *   1. Layout: full-width table replaces the master-detail grid.
 *      Side details panel is gone; details live in a centered modal.
 *   2. Smart filters: search always visible · 7 quick chips ·
 *      "فلاتر" advanced popover · "ترتيب" dropdown · active-filter
 *      chips with one-click removal · "مسح الفلاتر" reset.
 *   3. Cancel UI: visible only for admin + returns.cancel + status
 *      approved/refunded; requires reason + typed token; submit
 *      disabled until both valid; rapid double-click guarded; success
 *      invalidates queries and toasts.
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
import { MemoryRouter } from 'react-router-dom';

import type {
  ReturnDetails,
  ReturnListItem,
} from '@/api/returns.api';
import { useAuthStore } from '@/stores/auth.store';

// ─── mocks ──────────────────────────────────────────────────────────

const listMock = vi.fn();
const getMock = vi.fn();
const listExchangesMock = vi.fn();
const cancelMock = vi.fn();

vi.mock('@/api/returns.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    returnsApi: {
      ...((actual as any).returnsApi ?? {}),
      list: (p: any) => listMock(p),
      get: (id: string) => getMock(id),
      lookupInvoice: vi.fn(),
      createReturn: vi.fn(),
      approve: vi.fn(),
      refund: vi.fn(),
      reject: vi.fn(),
      exchange: vi.fn(),
      listExchanges: (p: any) => listExchangesMock(p),
      getExchange: vi.fn(),
      cancelReturn: (id: string, payload: any) => cancelMock(id, payload),
    },
  };
});

vi.mock('@/api/products.api', () => ({
  productsApi: { searchVariants: vi.fn(async () => []) },
}));

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return {
    default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }),
  };
});
import toast from 'react-hot-toast';
const toastSuccess = (toast as any).success as ReturnType<typeof vi.fn>;
const toastError = (toast as any).error as ReturnType<typeof vi.fn>;

import Returns from '../Returns';

// ─── fixtures ───────────────────────────────────────────────────────

function row(over: Partial<ReturnListItem> = {}): ReturnListItem {
  return {
    id: 'r1',
    return_no: 'RET-2026-000001',
    status: 'refunded',
    reason: 'wrong_size',
    total_refund: '250',
    restocking_fee: '0',
    net_refund: '250',
    refund_method: 'cash',
    requested_at: '2026-04-25T17:00:14Z',
    approved_at: '2026-04-25T17:00:39Z',
    refunded_at: '2026-04-25T17:00:54Z',
    rejected_at: null,
    created_at: '2026-04-25T17:00:14Z',
    updated_at: '2026-04-25T17:00:54Z',
    original_invoice_id: 'inv-1',
    invoice_no: 'INV-2026-000123',
    customer_id: null,
    customer_name: 'عميل نقدي',
    customer_phone: null,
    items_count: 1,
    units_count: 1,
    cashbox_id: '524646d5-7bd6-4d8d-a484-b1f562b039a4',
    cashbox_name: 'الخزينة الرئيسية',
    requested_by: 'u1',
    requested_by_name: 'محمود زهران',
    approved_by: 'u1',
    approved_by_name: 'محمود زهران',
    refunded_by: 'u1',
    refunded_by_name: 'محمود زهران',
    journal_entry_id: 'je-1',
    journal_entry_no: 'JE-2026-000358',
    journal_entry_posted_at: '2026-04-25T17:00:54Z',
    refund_cashbox_transaction_id: 245,
    has_unlinked_cash_leg: false,
    accounting_status: 'matched',
    inventory_status: 'restored',
    match_status: 'matched',
    restock_eligible_items: 1,
    ...over,
  };
}

function detail(over: Partial<ReturnDetails> = {}): ReturnDetails {
  const base = row(over);
  return {
    ...base,
    requested_by_name: base.requested_by_name ?? null,
    approved_by_name: base.approved_by_name ?? null,
    refunded_by_name: base.refunded_by_name ?? null,
    reason_details: null,
    notes: '',
    warehouse_id: 'w1',
    warehouse_name: 'المخزن الرئيسي',
    invoice_date: '2026-04-25T16:00:00Z',
    items: [
      {
        id: 'ri-1',
        original_invoice_item_id: 'oii-1',
        variant_id: 'v-1',
        product_name: 'قميص',
        sku: 'SH-001',
        color: 'أزرق',
        size: 'L',
        quantity: 1,
        unit_price: '250',
        refund_amount: '250',
        condition: 'resellable',
        back_to_stock: true,
        notes: null,
      },
    ],
    ...over,
  };
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Returns />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

/** Set up a logged-in admin with `returns.cancel`. */
function loginAdmin() {
  useAuthStore.setState({
    accessToken: 'fake',
    refreshToken: 'fake',
    user: {
      id: 'u-admin',
      username: 'admin',
      full_name: 'Admin',
      role: 'admin',
      permissions: ['*'],
    } as any,
    isHydrated: true,
  });
}

/** Set up a logged-in cashier WITHOUT returns.cancel. */
function loginCashier() {
  useAuthStore.setState({
    accessToken: 'fake',
    refreshToken: 'fake',
    user: {
      id: 'u-cashier',
      username: 'cashier',
      full_name: 'Cashier',
      role: 'cashier',
      permissions: ['returns.view', 'returns.create'],
    } as any,
    isHydrated: true,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  toastSuccess.mockClear();
  toastError.mockClear();
  cancelMock.mockReset();
  listMock.mockResolvedValue([row()]);
  getMock.mockResolvedValue(detail());
  listExchangesMock.mockResolvedValue([]);
  // Default: no auth — tests that need a user log in explicitly.
  useAuthStore.setState({
    accessToken: null,
    refreshToken: null,
    user: null,
  } as any);
});

// ─────────────────────────────────────────────────────────────────────
//  1. Layout — full-width table replaces master-detail
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 1E: full-width table layout', () => {
  it('renders the full-width data table', async () => {
    renderPage();
    await screen.findByTestId('returns-data-table');
    // The 13 column headers are present.
    for (const h of [
      'رقم العملية',
      'النوع',
      'الحالة',
      'الفاتورة الأصلية',
      'العميل',
      'المبلغ',
      'طريقة الرد / فرق الاستبدال',
      'المنفذ',
      'التاريخ والوقت',
      'المخزون',
      'المحاسبة',
      'المطابقة',
      'إجراءات',
    ]) {
      expect(screen.getByText(h)).toBeInTheDocument();
    }
  });

  it('does NOT render the prior side details panel or its empty state', async () => {
    renderPage();
    await screen.findByTestId('returns-data-table');
    expect(screen.queryByTestId('returns-details-pane')).toBeNull();
    expect(screen.queryByText('اختر عملية لعرض التفاصيل')).toBeNull();
  });

  it('clicking a row opens the centered details modal', async () => {
    renderPage();
    const r = await screen.findByTestId('returns-row-r1');
    fireEvent.click(r);
    await screen.findByTestId('returns-details-modal');
  });

  it('clicking the "عرض" button opens the modal without selecting via row click', async () => {
    renderPage();
    const view = await screen.findByTestId('returns-row-view-r1');
    fireEvent.click(view);
    await screen.findByTestId('returns-details-modal');
  });

  it('row shows operator name + DD/MM/YYYY HH:mm:ss + no raw ISO/GMT', async () => {
    renderPage();
    const r = await screen.findByTestId('returns-row-r1');
    expect(r.textContent).toContain('محمود زهران');
    expect(r.textContent).toMatch(/[\d٠-٩]{2}\/[\d٠-٩]{2}\/[\d٠-٩]{4}/);
    expect(r.textContent).not.toMatch(/T\d{2}:\d{2}:\d{2}/);
    expect(r.textContent).not.toMatch(/GMT|UTC/i);
  });

  it('missing operator name → غير معروف fallback', async () => {
    listMock.mockResolvedValueOnce([
      row({
        id: 'rno',
        return_no: 'RET-2026-NO-OP',
        requested_by_name: null,
        approved_by_name: null,
        refunded_by_name: null,
      }),
    ]);
    renderPage();
    const r = await screen.findByTestId('returns-row-rno');
    expect(r.textContent).toContain('غير معروف');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  2. Smart filters
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 1E: smart filter bar', () => {
  it('renders search + 7 quick chips + advanced toggle + sort', async () => {
    renderPage();
    expect(
      await screen.findByTestId('returns-smart-filters'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('returns-filter-search')).toBeInTheDocument();
    expect(
      screen.getByTestId('returns-filter-quick-chips'),
    ).toBeInTheDocument();
    for (const id of [
      'all',
      'today',
      'week',
      'month',
      'needs_review',
      'refunded',
      'pending',
    ]) {
      expect(
        screen.getByTestId(`returns-quick-chip-${id}`),
      ).toBeInTheDocument();
    }
    expect(
      screen.getByTestId('returns-filter-advanced-toggle'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('returns-filter-sort')).toBeInTheDocument();
  });

  it('advanced popover toggles open/closed and exposes the filter selects', async () => {
    renderPage();
    expect(
      screen.queryByTestId('returns-filter-advanced-popover'),
    ).toBeNull();
    fireEvent.click(
      await screen.findByTestId('returns-filter-advanced-toggle'),
    );
    await screen.findByTestId('returns-filter-advanced-popover');
    expect(
      screen.getByTestId('returns-filter-refund-method'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('returns-filter-accounting'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('returns-filter-status')).toBeInTheDocument();
    // Toggling closes again.
    fireEvent.click(screen.getByTestId('returns-filter-advanced-toggle'));
    await waitFor(() =>
      expect(
        screen.queryByTestId('returns-filter-advanced-popover'),
      ).toBeNull(),
    );
  });

  it('typing search → active-filter chip appears + removable', async () => {
    renderPage();
    const search = await screen.findByTestId('returns-filter-search');
    fireEvent.change(search, { target: { value: 'INV-X' } });
    const chip = await screen.findByTestId('returns-active-chip-q');
    expect(chip.textContent).toContain('INV-X');
    fireEvent.click(within(chip).getByRole('button'));
    await waitFor(() =>
      expect(
        screen.queryByTestId('returns-active-chip-q'),
      ).toBeNull(),
    );
  });

  it('"مسح الفلاتر" resets every active filter', async () => {
    renderPage();
    fireEvent.change(
      await screen.findByTestId('returns-filter-search'),
      { target: { value: 'XYZ' } },
    );
    fireEvent.click(screen.getByTestId('returns-quick-chip-today'));
    await screen.findByTestId('returns-active-chip-q');
    fireEvent.click(screen.getByTestId('returns-clear-filters'));
    await waitFor(() => {
      expect(
        screen.queryByTestId('returns-active-chip-q'),
      ).toBeNull();
      expect(
        screen.queryByTestId('returns-active-chip-date'),
      ).toBeNull();
    });
  });

  it('initial load sends NO date_from/date_to', async () => {
    renderPage();
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    const params = listMock.mock.calls[0][0];
    expect(params).not.toHaveProperty('date_from');
    expect(params).not.toHaveProperty('date_to');
  });

  it('sort dropdown changes sort key', async () => {
    renderPage();
    const sort = await screen.findByTestId('returns-filter-sort');
    fireEvent.change(sort, { target: { value: 'amount_high' } });
    expect((sort as HTMLSelectElement).value).toBe('amount_high');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  3. Admin cancel UI — visibility gating
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 1E: cancel UI visibility', () => {
  it('hidden when no user is logged in', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    await screen.findByTestId('returns-details-modal');
    expect(screen.queryByTestId('returns-action-cancel')).toBeNull();
  });

  it('hidden for cashier (no admin role, no returns.cancel)', async () => {
    loginCashier();
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    await screen.findByTestId('returns-details-modal');
    expect(screen.queryByTestId('returns-action-cancel')).toBeNull();
  });

  it('hidden for admin when status is pending', async () => {
    loginAdmin();
    listMock.mockResolvedValueOnce([row({ status: 'pending' })]);
    getMock.mockResolvedValueOnce(detail({ status: 'pending' }));
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    await screen.findByTestId('returns-details-modal');
    expect(screen.queryByTestId('returns-action-cancel')).toBeNull();
  });

  it('hidden for admin when status is rejected', async () => {
    loginAdmin();
    listMock.mockResolvedValueOnce([row({ status: 'rejected' })]);
    getMock.mockResolvedValueOnce(detail({ status: 'rejected' }));
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    await screen.findByTestId('returns-details-modal');
    expect(screen.queryByTestId('returns-action-cancel')).toBeNull();
  });

  it('hidden for admin when status is already cancelled', async () => {
    loginAdmin();
    listMock.mockResolvedValueOnce([row({ status: 'cancelled' })]);
    getMock.mockResolvedValueOnce(detail({ status: 'cancelled' }));
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    await screen.findByTestId('returns-details-modal');
    expect(screen.queryByTestId('returns-action-cancel')).toBeNull();
  });

  it('visible for admin + returns.cancel + approved status', async () => {
    loginAdmin();
    listMock.mockResolvedValueOnce([row({ status: 'approved' })]);
    getMock.mockResolvedValueOnce(detail({ status: 'approved' }));
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    expect(
      await screen.findByTestId('returns-action-cancel'),
    ).toBeInTheDocument();
  });

  it('visible for admin + returns.cancel + refunded status', async () => {
    loginAdmin();
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    expect(
      await screen.findByTestId('returns-action-cancel'),
    ).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  4. Admin cancel UI — confirmation flow
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 1E: cancel confirmation flow', () => {
  it('opens the cancel modal when admin clicks the cancel button', async () => {
    loginAdmin();
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    fireEvent.click(await screen.findByTestId('returns-action-cancel'));
    await screen.findByTestId('returns-cancel-modal');
    // Spec'd warning text.
    expect(
      screen.getByText(/سيتم إنشاء أثر عكسي، ولن يتم حذف المرتجع الأصلي/),
    ).toBeInTheDocument();
  });

  it('submit button is disabled until both reason and exact confirm token are provided', async () => {
    loginAdmin();
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    fireEvent.click(await screen.findByTestId('returns-action-cancel'));
    const submit = (await screen.findByTestId(
      'returns-cancel-submit',
    )) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // Reason only → still disabled.
    fireEvent.change(screen.getByTestId('returns-cancel-reason'), {
      target: { value: 'wrong customer' },
    });
    expect(submit.disabled).toBe(true);

    // Wrong token → still disabled.
    fireEvent.change(screen.getByTestId('returns-cancel-confirm'), {
      target: { value: 'CANCEL_RETURN_WRONG' },
    });
    expect(submit.disabled).toBe(true);

    // Exact token → enabled.
    fireEvent.change(screen.getByTestId('returns-cancel-confirm'), {
      target: { value: 'CANCEL_RETURN_RET-2026-000001' },
    });
    expect(submit.disabled).toBe(false);
  });

  it('wrong confirm token does NOT call returnsApi.cancelReturn', async () => {
    loginAdmin();
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    fireEvent.click(await screen.findByTestId('returns-action-cancel'));
    fireEvent.change(
      await screen.findByTestId('returns-cancel-reason'),
      { target: { value: 'oops' } },
    );
    fireEvent.change(screen.getByTestId('returns-cancel-confirm'), {
      target: { value: 'CANCEL_RETURN_WRONG' },
    });
    fireEvent.click(screen.getByTestId('returns-cancel-submit'));
    await waitFor(() => {
      // No async fire — assert it stayed silent.
      expect(cancelMock).not.toHaveBeenCalled();
    });
  });

  it('correct token + reason → calls returnsApi.cancelReturn(id, payload) once + toast', async () => {
    loginAdmin();
    cancelMock.mockResolvedValue({ ...detail(), status: 'cancelled' });
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    fireEvent.click(await screen.findByTestId('returns-action-cancel'));
    fireEvent.change(
      await screen.findByTestId('returns-cancel-reason'),
      { target: { value: 'wrong customer' } },
    );
    fireEvent.change(screen.getByTestId('returns-cancel-confirm'), {
      target: { value: 'CANCEL_RETURN_RET-2026-000001' },
    });
    fireEvent.click(screen.getByTestId('returns-cancel-submit'));

    await waitFor(() => expect(cancelMock).toHaveBeenCalled());
    expect(cancelMock).toHaveBeenCalledTimes(1);
    expect(cancelMock).toHaveBeenCalledWith('r1', {
      reason: 'wrong customer',
      confirm: 'CANCEL_RETURN_RET-2026-000001',
    });
    await waitFor(() => expect(toastSuccess).toHaveBeenCalled());
  });

  it('rapid double-click only calls the API once', async () => {
    loginAdmin();
    let resolveCancel: (v: any) => void = () => {};
    cancelMock.mockReturnValue(
      new Promise((resolve) => {
        resolveCancel = resolve;
      }),
    );
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    fireEvent.click(await screen.findByTestId('returns-action-cancel'));
    fireEvent.change(
      await screen.findByTestId('returns-cancel-reason'),
      { target: { value: 'dup-test' } },
    );
    fireEvent.change(screen.getByTestId('returns-cancel-confirm'), {
      target: { value: 'CANCEL_RETURN_RET-2026-000001' },
    });
    const btn = screen.getByTestId('returns-cancel-submit');
    fireEvent.click(btn);
    // Wait for the first call to register before issuing the rapid
    // follow-ups; React-Query schedules the mutation function on a
    // microtask so an immediate second `fireEvent.click` would race
    // against the first.
    await waitFor(() => expect(cancelMock).toHaveBeenCalledTimes(1));
    fireEvent.click(btn); // rapid second click while pending
    fireEvent.click(btn);
    // Disabled state should keep the count at 1.
    expect(cancelMock).toHaveBeenCalledTimes(1);
    resolveCancel({ ...detail(), status: 'cancelled' });
  });

  it('on error → toast.error fires, no toast.success', async () => {
    loginAdmin();
    cancelMock.mockRejectedValueOnce({
      response: {
        status: 400,
        data: { message: 'إلغاء مرتجع غير نقدي يحتاج ربط حساب دفع' },
      },
    });
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    fireEvent.click(await screen.findByTestId('returns-action-cancel'));
    fireEvent.change(
      await screen.findByTestId('returns-cancel-reason'),
      { target: { value: 'attempt' } },
    );
    fireEvent.change(screen.getByTestId('returns-cancel-confirm'), {
      target: { value: 'CANCEL_RETURN_RET-2026-000001' },
    });
    fireEvent.click(screen.getByTestId('returns-cancel-submit'));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(toastSuccess).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  5. Safety — no stray actions added
// ─────────────────────────────────────────────────────────────────────

describe('Returns — Phase 1E: safety', () => {
  it('does NOT add any cleanup / rebuild / settlement action button', async () => {
    loginAdmin();
    renderPage();
    fireEvent.click(await screen.findByTestId('returns-row-r1'));
    await screen.findByTestId('returns-details-modal');
    for (const t of [
      /تنظيف/, // cleanup
      /إعادة بناء/, // rebuild
      /تسوية/, // settlement
      /إصلاح المحاسبة/, // fix accounting
    ]) {
      expect(screen.queryByText(t)).toBeNull();
    }
  });

  it('preserves create return / create exchange entry-point buttons', async () => {
    renderPage();
    expect(
      await screen.findByTestId('returns-action-new-return'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('returns-action-new-exchange'),
    ).toBeInTheDocument();
  });
});
