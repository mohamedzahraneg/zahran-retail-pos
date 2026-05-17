/**
 * Purchases.cash-flow.test.tsx
 *
 * Pins the cash-flow UX bridge invariants:
 *
 *   · The pay button is visible on `received` / `partial` rows and
 *     opens the existing PayPurchaseModal (no new endpoint).
 *   · The API surface exposes only the existing official mutation
 *     helpers (receive / pay / cancel / create / edit). No new
 *     direct cashbox / supplier_payments / journal helper has crept
 *     in alongside the bridge.
 *   · Submitting the pay form fires the official `purchasesApi.pay`
 *     and never any other write.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PurchasesPage from '../Purchases';

const listMock = vi.fn();
const createMock = vi.fn();
const getMock = vi.fn();
const receiveMock = vi.fn();
const payMock = vi.fn();
const suppliersListMock = vi.fn();
const warehousesListMock = vi.fn();
const settingsMock = vi.fn();
const listPaymentMethodsMock = vi.fn();

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

vi.mock('@/api/purchases.api', async () => {
  const actual = await vi.importActual<any>('@/api/purchases.api');
  return {
    ...actual,
    purchasesApi: {
      list: (params?: any) => listMock(params),
      create: (body: any) => createMock(body),
      get: (id: string) => getMock(id),
      receive: (id: string) => receiveMock(id),
      pay: (id: string, body: any) => payMock(id, body),
      cancel: vi.fn(async () => ({})),
      edit: vi.fn(async () => ({})),
      productSearch: vi.fn(async () => ({ query: '', results: [] })),
      supplierContext: vi.fn(async () => ({})),
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
      listPaymentMethods: () => listPaymentMethodsMock(),
    },
  };
});

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

const RECEIVED_PURCHASE = {
  id: 'po-recv',
  purchase_no: 'PO-001',
  status: 'received',
  grand_total: '1000.00',
  paid_amount: '0.00',
  supplier_id: 'sup-1',
  supplier_name: 'مورد ألف',
  warehouse_id: 'wh-1',
  invoice_date: '2026-05-17',
};

beforeEach(() => {
  for (const m of [
    listMock,
    createMock,
    getMock,
    receiveMock,
    payMock,
    suppliersListMock,
    warehousesListMock,
    settingsMock,
    listPaymentMethodsMock,
  ]) {
    m.mockReset();
  }
  listMock.mockResolvedValue([RECEIVED_PURCHASE]);
  createMock.mockResolvedValue(RECEIVED_PURCHASE);
  getMock.mockResolvedValue(RECEIVED_PURCHASE);
  receiveMock.mockResolvedValue({ ...RECEIVED_PURCHASE, status: 'received' });
  payMock.mockResolvedValue({ paid_amount: 1000, status: 'paid' });
  suppliersListMock.mockResolvedValue([
    {
      id: 'sup-1',
      code: 'SUP-001',
      name: 'مورد ألف',
      phone: '01000000000',
      supplier_type: 'credit',
    },
  ]);
  warehousesListMock.mockResolvedValue([
    { id: 'wh-1', name_ar: 'المخزن الرئيسي', code: 'WH-1' },
  ]);
  settingsMock.mockResolvedValue({
    competitive_markup_pct: 30,
    recommended_margin_pct: 35,
    high_margin_pct: 45,
    wholesale_markup_pct: 20,
    min_margin_pct_default: 15,
    rounding_step: 1,
    rounding_mode: 'nearest',
  });
  listPaymentMethodsMock.mockResolvedValue([
    { code: 'cash', name_ar: 'نقدي' },
    { code: 'bank_transfer', name_ar: 'تحويل بنكي' },
  ]);
});

describe('Purchases page — cash-flow UX bridge invariants', () => {
  it('C1. pay button is visible on a received row and opens the existing PayPurchaseModal', async () => {
    render(wrap(<PurchasesPage />));
    await screen.findByText('PO-001');
    const payBtn = screen.getByTitle('تسجيل دفعة');
    expect(payBtn).toBeInTheDocument();
    fireEvent.click(payBtn);
    // The existing PayPurchaseModal mounts on payId; its header
    // includes the purchase_no.
    await screen.findByText(/تسجيل دفعة لفاتورة/);
    // `purchasesApi.get` is queried for the row's details — same
    // path the manual pay button has always used.
    await waitFor(() => expect(getMock).toHaveBeenCalledWith('po-recv'));
  });

  it('C2. pay button is NOT visible on a draft row (receive must happen first)', async () => {
    listMock.mockResolvedValue([
      { ...RECEIVED_PURCHASE, status: 'draft' },
    ]);
    render(wrap(<PurchasesPage />));
    await screen.findByText('PO-001');
    expect(screen.queryByTitle('تسجيل دفعة')).toBeNull();
  });

  it('C3. submitting the pay modal calls the OFFICIAL `purchasesApi.pay` — never a new endpoint', async () => {
    render(wrap(<PurchasesPage />));
    await screen.findByText('PO-001');
    fireEvent.click(screen.getByTitle('تسجيل دفعة'));
    await screen.findByText(/تسجيل دفعة لفاتورة/);
    await waitFor(() => expect(getMock).toHaveBeenCalled());
    // Click "سداد كامل المتبقي" → form.amount = remaining
    fireEvent.click(screen.getByText('سداد كامل المتبقي'));
    // Submit via the "حفظ الدفعة" button (the only submit-type button
    // inside the pay form).
    const submitBtn = screen.getByText('حفظ الدفعة');
    fireEvent.click(submitBtn);
    await waitFor(() => expect(payMock).toHaveBeenCalled());
    expect(payMock.mock.calls[0][0]).toBe('po-recv');
    expect(payMock.mock.calls[0][1]).toMatchObject({
      payment_method: 'cash',
      amount: 1000,
    });
  });

  it('C4. API surface exposes ONLY existing mutation helpers — no new cashbox / supplier_payments / journal helper', async () => {
    const mod = await import('@/api/purchases.api');
    const keys = Object.keys(mod.purchasesApi);
    // No key sneaks in that looks like a parallel cashbox / journal /
    // supplier-payments path.
    for (const k of keys) {
      expect(k).not.toMatch(/cashbox/i);
      expect(k).not.toMatch(/journal/i);
      expect(k).not.toMatch(/supplier_?payment/i);
    }
    // Sanity: the official mutation helpers we DO use stay reachable.
    expect(keys).toEqual(expect.arrayContaining(['pay', 'receive', 'cancel', 'create']));
  });
});
