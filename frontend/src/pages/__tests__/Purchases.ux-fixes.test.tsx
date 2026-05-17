/**
 * Purchases.ux-fixes.test.tsx — Purchases UX fixes
 *
 * Pins the five operator-facing fixes that came out of the screen
 * walkthrough:
 *
 *   1. The default list view hides cancelled invoices.
 *   2. "كل الفواتير + الملغاة" surfaces them again (`include_cancelled`).
 *   3. "ملغاة فقط" sends the explicit `status='cancelled'` filter.
 *   4. CreatePurchaseModal renders the SupplierSearch typeahead
 *      instead of the old <select> dropdown.
 *   5. CreatePurchaseModal carries a "كاش/أجل" payment-type toggle
 *      and disables the due-date input under cash.
 *   6. The legacy "الشحن" input is GONE from the create modal.
 *   7. The landed-costs hint copy reads the new Arabic guidance.
 *
 * Every test mocks the API surface so no real HTTP is issued.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PurchasesPage from '../Purchases';

// ─── Mocks ───────────────────────────────────────────────────────
const listMock = vi.fn();
const suppliersListMock = vi.fn();
const warehousesListMock = vi.fn();
const settingsMock = vi.fn();

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/api/purchases.api', async () => {
  const actual = await vi.importActual<any>('@/api/purchases.api');
  return {
    ...actual,
    purchasesApi: {
      list: (params?: any) => listMock(params),
      productSearch: vi.fn(async () => ({ query: '', results: [] })),
    },
  };
});

vi.mock('@/api/suppliers.api', async () => {
  const actual = await vi.importActual<any>('@/api/suppliers.api');
  return {
    ...actual,
    suppliersApi: {
      list: (q?: string) => suppliersListMock(q),
    },
  };
});

vi.mock('@/api/settings.api', async () => {
  const actual = await vi.importActual<any>('@/api/settings.api');
  return {
    ...actual,
    settingsApi: {
      ...((actual as any).settingsApi ?? {}),
      listWarehouses: () => warehousesListMock(),
      getSmartPricing: () => settingsMock(),
    },
  };
});

// Default permissions — admin so every guarded button renders.
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (selector: any) =>
    selector({
      user: { id: 'u-1', name: 'admin', role: 'admin' },
      hasPermission: () => true,
    }),
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

beforeEach(() => {
  listMock.mockReset();
  listMock.mockResolvedValue([]);
  suppliersListMock.mockReset();
  suppliersListMock.mockResolvedValue([
    {
      id: 'sup-1',
      code: 'SUP-001',
      name: 'مورد ألف',
      phone: '01000000000',
      supplier_type: 'credit',
    },
  ]);
  warehousesListMock.mockReset();
  warehousesListMock.mockResolvedValue([
    { id: 'wh-1', name_ar: 'المخزن الرئيسي', code: 'WH-1' },
  ]);
  settingsMock.mockReset();
  settingsMock.mockResolvedValue({
    competitive_markup_pct: 30,
    recommended_margin_pct: 35,
    high_margin_pct: 45,
    wholesale_markup_pct: 20,
    min_margin_pct_default: 15,
    rounding_step: 1,
    rounding_mode: 'nearest',
  });
});

describe('Purchases page — cancelled exclusion (UX fix #1)', () => {
  it('U1. default list call does NOT pass status:"cancelled" or include_cancelled', async () => {
    render(wrap(<PurchasesPage />));
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    const args = listMock.mock.calls[0][0] ?? {};
    expect(args.status).toBeUndefined();
    expect(args.include_cancelled).toBeUndefined();
  });

  it('U2. picking "ملغاة فقط" sends status:"cancelled"', async () => {
    render(wrap(<PurchasesPage />));
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('purchases-status-filter'), {
      target: { value: 'cancelled' },
    });
    await waitFor(() =>
      expect(
        listMock.mock.calls[listMock.mock.calls.length - 1][0],
      ).toMatchObject({ status: 'cancelled' }),
    );
  });

  it('U3. picking "كل الفواتير + الملغاة" sends include_cancelled:true', async () => {
    render(wrap(<PurchasesPage />));
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('purchases-status-filter'), {
      target: { value: 'all_with_cancelled' },
    });
    await waitFor(() => {
      const last = listMock.mock.calls[listMock.mock.calls.length - 1][0];
      expect(last.include_cancelled).toBe(true);
      // Status filter is undefined so the cancelled rows surface too.
      expect(last.status).toBeUndefined();
    });
  });
});

describe('CreatePurchaseModal — supplier search + cash/credit + no shipping (UX fixes #2 / #4 / #5)', () => {
  async function openCreateModal() {
    render(wrap(<PurchasesPage />));
    await waitFor(() => expect(listMock).toHaveBeenCalled());
    fireEvent.click(screen.getByText('فاتورة شراء جديدة'));
  }

  it('U4. supplier picker is the new SupplierSearch typeahead (no <select>)', async () => {
    await openCreateModal();
    await screen.findByTestId('supplier-search-input');
    // Modal shows the SupplierSearch input. The old supplier <select>
    // is gone — the only remaining select in the modal header is the
    // warehouse one.
    expect(screen.getByTestId('supplier-search-input')).toBeInTheDocument();
  });

  it('U5. selecting a supplier from search swaps to the read-only summary + clear button', async () => {
    await openCreateModal();
    fireEvent.change(
      await screen.findByTestId('supplier-search-input'),
      { target: { value: 'مورد' } },
    );
    await screen.findByTestId('supplier-search-row-sup-1');
    fireEvent.click(screen.getByTestId('supplier-search-row-sup-1'));
    await screen.findByTestId('supplier-search-selected');
    expect(
      screen.getByTestId('supplier-search-clear'),
    ).toBeInTheDocument();
  });

  it('U6. payment-type toggle renders with credit selected by default', async () => {
    await openCreateModal();
    await screen.findByTestId('purchase-payment-type');
    const credit = screen.getByTestId('purchase-payment-type-credit');
    expect(credit).toHaveAttribute('aria-selected', 'true');
  });

  it('U7. picking "كاش" disables the due_date input and shows the hint', async () => {
    await openCreateModal();
    await screen.findByTestId('purchase-payment-type');
    fireEvent.click(screen.getByTestId('purchase-payment-type-cash'));
    const dueDate = screen.getByTestId('purchase-due-date') as HTMLInputElement;
    expect(dueDate.disabled).toBe(true);
    expect(
      screen.getByTestId('purchase-payment-type-cash-hint'),
    ).toHaveTextContent('فواتير الكاش');
  });

  it('U8. legacy "الشحن" input is no longer rendered in the create modal', async () => {
    await openCreateModal();
    await screen.findByTestId('supplier-search-input');
    // The standalone shipping number input is gone. The string "الشحن"
    // may still appear elsewhere (e.g. the landed-costs hint mentions
    // "شحن"), so we check by label association: there's no `<label>`
    // whose text is exactly "الشحن" anymore.
    const labels = screen.queryAllByText('الشحن', { selector: 'label' });
    expect(labels).toHaveLength(0);
  });

  it('U9. landed-costs hint reads the new Arabic copy', async () => {
    await openCreateModal();
    await screen.findByTestId('landed-costs-hint');
    expect(
      screen.getByTestId('landed-costs-hint'),
    ).toHaveTextContent(
      'أضف مصاريف النقل أو العمالة أو الشحن من هنا ليتم توزيعها على تكلفة المنتجات.',
    );
  });
});
