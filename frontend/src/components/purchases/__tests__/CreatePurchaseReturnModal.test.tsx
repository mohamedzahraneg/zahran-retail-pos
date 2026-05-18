/**
 * CreatePurchaseReturnModal.test.tsx — PR-P2.4A
 *
 * Pins the modal's settlement-type UX + qty enforcement + payload
 * shape sent to the BE. Mocks the API helpers so no network or
 * Postgres is involved.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CreatePurchaseReturnModal } from '../CreatePurchaseReturnModal';

vi.mock('@/api/purchaseReturns.api', () => ({
  purchaseReturnsApi: {
    returnableItems: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('@/api/cash-desk.api', () => ({
  cashDeskApi: {
    cashboxes: vi.fn(),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
  __esModule: true,
}));

import { purchaseReturnsApi } from '@/api/purchaseReturns.api';
import { cashDeskApi } from '@/api/cash-desk.api';

const PURCHASE_ID = '44444444-4444-4444-4444-444444444444';

function returnableFixture() {
  return {
    purchase: {
      id: PURCHASE_ID,
      purchase_no: 'P-2026-0001',
      supplier_id: 'sup-1',
      warehouse_id: 'wh-1',
      status: 'received',
    },
    items: [
      {
        purchase_item_id: 'pi-1',
        variant_id: 'v-1',
        sku: 'SKU-1',
        barcode: null,
        product_id: 'p-1',
        product_name: 'حذاء رياضي',
        color_name: 'أحمر',
        size_label: '42',
        received: '5',
        unit_cost: '100',
        already_returned: '1',
        returnable: '4',
      },
      {
        purchase_item_id: 'pi-2',
        variant_id: 'v-2',
        sku: 'SKU-2',
        barcode: null,
        product_id: 'p-2',
        product_name: 'حذاء كاجوال',
        color_name: 'أسود',
        size_label: '41',
        received: '3',
        unit_cost: '50',
        already_returned: '3',
        returnable: '0',
      },
    ],
  };
}

function cashboxesFixture() {
  return [
    {
      id: 'cb-cash',
      name: 'Main Cash',
      name_ar: 'الخزنة الرئيسية',
      kind: 'cash',
      is_active: true,
      currency: 'EGP',
      current_balance: '1000',
    },
    {
      id: 'cb-bank',
      name: 'Bank Account',
      name_ar: 'حساب بنكي',
      kind: 'bank',
      is_active: true,
      currency: 'EGP',
      current_balance: '0',
    },
    {
      id: 'cb-inactive',
      name: 'Old',
      name_ar: 'خزنة قديمة',
      kind: 'cash',
      is_active: false,
      currency: 'EGP',
      current_balance: '0',
    },
  ];
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

async function renderModal() {
  (purchaseReturnsApi.returnableItems as any).mockResolvedValue(
    returnableFixture(),
  );
  (cashDeskApi.cashboxes as any).mockResolvedValue(cashboxesFixture());
  render(
    wrap(
      <CreatePurchaseReturnModal
        purchaseId={PURCHASE_ID}
        onClose={() => {}}
      />,
    ),
  );
  // Wait for the returnable items to actually render (the query resolves
  // after the modal mounts, so the qty inputs only appear once the data
  // arrives).
  await waitFor(() =>
    expect(screen.getByTestId('qty-pi-1')).toBeInTheDocument(),
  );
}

describe('CreatePurchaseReturnModal', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders returnable lines and disables the zero-returnable input', async () => {
    await renderModal();
    const qty1 = screen.getByTestId('qty-pi-1') as HTMLInputElement;
    const qty2 = screen.getByTestId('qty-pi-2') as HTMLInputElement;
    expect(qty1).toBeInTheDocument();
    expect(qty1.disabled).toBe(false);
    expect(qty2).toBeInTheDocument();
    expect(qty2.disabled).toBe(true);
  });

  it('caps quantity at returnable when the operator exceeds it', async () => {
    await renderModal();
    const qty = screen.getByTestId('qty-pi-1') as HTMLInputElement;
    fireEvent.change(qty, { target: { value: '10' } });
    // Capped at 4 (returnable).
    expect(qty.value).toBe('4');
  });

  it('submit blocked until reason length >= 3 and qty > 0', async () => {
    await renderModal();
    const submit = screen.getByTestId('submit-purchase-return') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('qty-pi-1'), {
      target: { value: '2' },
    });
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByTestId('reason-input'), {
      target: { value: 'بضاعة معيبة' },
    });
    expect(submit.disabled).toBe(false);
  });

  it('cash_refund: filters cashboxes to kind=cash, blocks submit until cashbox picked', async () => {
    await renderModal();
    fireEvent.change(screen.getByTestId('qty-pi-1'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByTestId('reason-input'), {
      target: { value: 'بضاعة معيبة' },
    });
    fireEvent.click(screen.getByTestId('settlement-cash_refund'));
    await waitFor(() =>
      expect(screen.getByTestId('cashbox-select')).toBeInTheDocument(),
    );
    // Wait for the cashbox query to resolve + the cash option to render.
    await waitFor(() => {
      const sel = screen.getByTestId('cashbox-select') as HTMLSelectElement;
      expect(Array.from(sel.options).map((o) => o.value)).toContain('cb-cash');
    });
    const select = screen.getByTestId('cashbox-select') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['', 'cb-cash']);
    const submit = screen.getByTestId('submit-purchase-return') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(select, { target: { value: 'cb-cash' } });
    expect(submit.disabled).toBe(false);
  });

  it('bank_refund: filters cashboxes to non-cash kinds', async () => {
    await renderModal();
    fireEvent.click(screen.getByTestId('settlement-bank_refund'));
    await waitFor(() =>
      expect(screen.getByTestId('cashbox-select')).toBeInTheDocument(),
    );
    // Wait until the cashbox query has resolved + the option is rendered.
    await waitFor(() => {
      const select = screen.getByTestId('cashbox-select') as HTMLSelectElement;
      expect(Array.from(select.options).map((o) => o.value)).toContain('cb-bank');
    });
    const select = screen.getByTestId('cashbox-select') as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(['', 'cb-bank']);
  });

  it('submits payload with refund_amount === total for cash_refund', async () => {
    (purchaseReturnsApi.create as any).mockResolvedValue({ id: 'pr-1' });
    await renderModal();
    fireEvent.change(screen.getByTestId('qty-pi-1'), {
      target: { value: '2' },
    });
    fireEvent.change(screen.getByTestId('reason-input'), {
      target: { value: 'بضاعة معيبة' },
    });
    fireEvent.click(screen.getByTestId('settlement-cash_refund'));
    await waitFor(() =>
      expect(screen.getByTestId('cashbox-select')).toBeInTheDocument(),
    );
    await waitFor(() => {
      const sel = screen.getByTestId('cashbox-select') as HTMLSelectElement;
      expect(Array.from(sel.options).map((o) => o.value)).toContain('cb-cash');
    });
    fireEvent.change(screen.getByTestId('cashbox-select'), {
      target: { value: 'cb-cash' },
    });
    fireEvent.click(screen.getByTestId('submit-purchase-return'));
    await waitFor(() =>
      expect(purchaseReturnsApi.create).toHaveBeenCalledTimes(1),
    );
    const payload = (purchaseReturnsApi.create as any).mock.calls[0][0];
    expect(payload.purchase_id).toBe(PURCHASE_ID);
    expect(payload.settlement_type).toBe('cash_refund');
    expect(payload.cashbox_id).toBe('cb-cash');
    expect(payload.refund_amount).toBe(200); // 2 * 100
    expect(payload.items).toEqual([
      {
        variant_id: 'v-1',
        purchase_item_id: 'pi-1',
        quantity: 2,
        unit_cost: 100,
      },
    ]);
    expect(payload.reason).toBe('بضاعة معيبة');
  });

  it('supplier_credit submits without cashbox_id or refund_amount', async () => {
    (purchaseReturnsApi.create as any).mockResolvedValue({ id: 'pr-1' });
    await renderModal();
    fireEvent.change(screen.getByTestId('qty-pi-1'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByTestId('reason-input'), {
      target: { value: 'بضاعة معيبة' },
    });
    fireEvent.click(screen.getByTestId('submit-purchase-return'));
    await waitFor(() =>
      expect(purchaseReturnsApi.create).toHaveBeenCalledTimes(1),
    );
    const payload = (purchaseReturnsApi.create as any).mock.calls[0][0];
    expect(payload.settlement_type).toBe('supplier_credit');
    expect(payload.cashbox_id).toBeUndefined();
    expect(payload.refund_amount).toBeUndefined();
  });

  it('no_settlement submits as stock-only return (no cashbox, no refund)', async () => {
    (purchaseReturnsApi.create as any).mockResolvedValue({ id: 'pr-1' });
    await renderModal();
    fireEvent.change(screen.getByTestId('qty-pi-1'), {
      target: { value: '1' },
    });
    fireEvent.change(screen.getByTestId('reason-input'), {
      target: { value: 'بضاعة معيبة' },
    });
    fireEvent.click(screen.getByTestId('settlement-no_settlement'));
    fireEvent.click(screen.getByTestId('submit-purchase-return'));
    await waitFor(() =>
      expect(purchaseReturnsApi.create).toHaveBeenCalledTimes(1),
    );
    const payload = (purchaseReturnsApi.create as any).mock.calls[0][0];
    expect(payload.settlement_type).toBe('no_settlement');
    expect(payload.cashbox_id).toBeUndefined();
    expect(payload.refund_amount).toBeUndefined();
  });
});
