/**
 * SupplierPayModal.test.tsx — PR-CASH-DESK-REORG-1
 *
 * Pins the payload-shape contract of the lifted-from-CashDesk
 * `SupplierPayModal`. Mocks `cashDeskApi.pay` and asserts the exact
 * arguments fired on submit. Mirrors `ReceiptModal.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SupplierPayModal } from '../SupplierPayModal';
import type { Supplier } from '@/api/suppliers.api';
import type { Cashbox } from '@/api/cash-desk.api';

const payMock = vi.fn(async (_body: Record<string, unknown>) => ({}));

// Full synthetic mocks — vi.mock runs at hoist-time before the
// path-alias resolver is up, so `importOriginal` on `@/...` fails.
vi.mock('@/api/cash-desk.api', () => ({
  cashDeskApi: {
    pay: (body: Record<string, unknown>) => payMock(body),
    receive: vi.fn(),
    cashboxes: vi.fn(async () => []),
    cashflowToday: vi.fn(async () => []),
    shiftVariances: vi.fn(async () => null),
    movements: vi.fn(async () => []),
    listCustomerPayments: vi.fn(async () => []),
    listSupplierPayments: vi.fn(async () => []),
    deposit: vi.fn(),
  },
}));
vi.mock('@/api/suppliers.api', () => ({
  suppliersApi: {
    list: vi.fn(async () => []),
  },
}));
const listProvidersMock = vi.fn<[], Promise<unknown[]>>(async () => []);
const listAccountsMock = vi.fn<[], Promise<unknown[]>>(async () => []);
vi.mock('@/api/payments.api', async () => {
  const actual = await vi.importActual<typeof import('@/api/payments.api')>(
    '@/api/payments.api',
  );
  return {
    ...actual,
    paymentsApi: {
      listProviders: () => listProvidersMock(),
      listAccounts: () => listAccountsMock(),
    },
  };
});
const toastErrorMock = vi.fn();
vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return {
    default: Object.assign(fn, {
      error: (m: string) => toastErrorMock(m),
      success: vi.fn(),
    }),
  };
});

const cashboxes: Cashbox[] = [
  {
    id: 'cb-1',
    name: 'الخزينة الرئيسية',
    current_balance: 1000,
    is_active: true,
  } as unknown as Cashbox,
];

const supplier: Supplier = {
  id: 'sup-1',
  code: 'SUP-001',
  name: 'مورد اختبار',
  phone: '01100000000',
  email: null,
  current_balance: 800,
} as unknown as Supplier;

function renderModal(
  props: Partial<Parameters<typeof SupplierPayModal>[0]> = {},
) {
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <SupplierPayModal
        cashboxes={cashboxes}
        prefilledSupplier={supplier}
        onClose={onClose}
        onSuccess={onSuccess}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onClose, onSuccess };
}

beforeEach(() => {
  payMock.mockClear();
});

describe('<SupplierPayModal /> — PR-CASH-DESK-REORG-1', () => {
  it('renders inside the testid wrapper + shows the prefilled supplier name (no search input)', () => {
    renderModal();
    expect(screen.getByTestId('supplier-pay-modal')).toBeInTheDocument();
    expect(screen.getByText('مورد اختبار')).toBeInTheDocument();
    expect(
      screen.queryByTestId('supplier-pay-modal-supplier-search'),
    ).toBeNull();
  });

  it('submit fires cashDeskApi.pay with the canonical payload shape', async () => {
    renderModal();
    fireEvent.change(screen.getByTestId('supplier-pay-modal-amount'), {
      target: { value: '120' },
    });
    fireEvent.click(screen.getByTestId('supplier-pay-modal-submit'));
    // React-Query schedules `mutationFn` as a microtask, so the mock
    // is NOT called synchronously after `fireEvent.click`.
    await waitFor(() => {
      expect(payMock).toHaveBeenCalledTimes(1);
    });
    const payload = payMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      supplier_id: 'sup-1',
      cashbox_id: 'cb-1',
      payment_method: 'cash', // default
      amount: 120,
    });
  });

  it('refuses submit with no amount (mutation not called)', () => {
    renderModal();
    fireEvent.click(screen.getByTestId('supplier-pay-modal-submit'));
    expect(payMock).not.toHaveBeenCalled();
  });

  it('without prefilledSupplier the search input renders', () => {
    renderModal({ prefilledSupplier: null });
    expect(
      screen.getByTestId('supplier-pay-modal-supplier-search'),
    ).toBeInTheDocument();
  });

  it('cancel button calls onClose without firing the mutation', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByTestId('supplier-pay-modal-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(payMock).not.toHaveBeenCalled();
  });
});

/* PR-FIN-PAYACCT-4C — payment_account picker + non-cash submit (mirror) */
describe('<SupplierPayModal /> — PR-FIN-PAYACCT-4C payment_account_id', () => {
  beforeEach(() => {
    payMock.mockClear();
    toastErrorMock.mockClear();
    listProvidersMock.mockReset();
    listAccountsMock.mockReset();
    listProvidersMock.mockResolvedValue([]);
    listAccountsMock.mockResolvedValue([]);
  });

  it('non-cash with active accounts → auto-defaults + submit carries payment_account_id', async () => {
    listAccountsMock.mockResolvedValue([
      {
        id: 'pa-w',
        method: 'wallet',
        provider_key: 'we_pay',
        display_name: 'WE Pay',
        identifier: null,
        gl_account_code: '1114',
        cashbox_id: null,
        is_default: true,
        active: true,
        sort_order: 0,
        metadata: {},
        created_at: '',
        updated_at: '',
        created_by: null,
        updated_by: null,
      },
    ]);
    renderModal();
    const select = (await screen.findByTestId(
      'supplier-pay-modal-method',
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(select.options).some((o) => o.value === 'wallet')).toBe(true);
    });
    fireEvent.change(select, { target: { value: 'wallet' } });
    await screen.findByTestId('payment-account-picker');
    fireEvent.change(screen.getByTestId('supplier-pay-modal-amount'), {
      target: { value: '120' },
    });
    fireEvent.click(screen.getByTestId('supplier-pay-modal-submit'));
    await waitFor(() => expect(payMock).toHaveBeenCalledTimes(1));
    const payload = payMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.payment_method).toBe('wallet');
    expect(payload.payment_account_id).toBe('pa-w');
  });

  it('non-cash multiple accounts none picked → submit blocked with Arabic toast', async () => {
    listAccountsMock.mockResolvedValue([
      {
        id: 'pa-w-1',
        method: 'wallet',
        provider_key: 'we_pay',
        display_name: 'WE Pay 1',
        identifier: null,
        gl_account_code: '1114',
        cashbox_id: null,
        is_default: false,
        active: true,
        sort_order: 0,
        metadata: {},
        created_at: '',
        updated_at: '',
        created_by: null,
        updated_by: null,
      },
      {
        id: 'pa-w-2',
        method: 'wallet',
        provider_key: 'we_pay',
        display_name: 'WE Pay 2',
        identifier: null,
        gl_account_code: '1114',
        cashbox_id: null,
        is_default: false,
        active: true,
        sort_order: 1,
        metadata: {},
        created_at: '',
        updated_at: '',
        created_by: null,
        updated_by: null,
      },
    ]);
    renderModal();
    const select = (await screen.findByTestId(
      'supplier-pay-modal-method',
    )) as HTMLSelectElement;
    await waitFor(() => {
      expect(Array.from(select.options).some((o) => o.value === 'wallet')).toBe(true);
    });
    fireEvent.change(select, { target: { value: 'wallet' } });
    await screen.findByTestId('payment-account-picker');
    fireEvent.change(screen.getByTestId('supplier-pay-modal-amount'), {
      target: { value: '120' },
    });
    fireEvent.click(screen.getByTestId('supplier-pay-modal-submit'));
    await waitFor(() => expect(toastErrorMock).toHaveBeenCalled());
    expect(toastErrorMock.mock.calls.some((c) => /اختر حساب الدفع/.test(c[0]))).toBe(
      true,
    );
    expect(payMock).not.toHaveBeenCalled();
  });

  it('cash submit → payment_account_id is null', async () => {
    listAccountsMock.mockResolvedValue([]);
    renderModal();
    await screen.findByTestId('supplier-pay-modal-method');
    fireEvent.change(screen.getByTestId('supplier-pay-modal-amount'), {
      target: { value: '120' },
    });
    fireEvent.click(screen.getByTestId('supplier-pay-modal-submit'));
    await waitFor(() => expect(payMock).toHaveBeenCalledTimes(1));
    const payload = payMock.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.payment_method).toBe('cash');
    expect(payload.payment_account_id).toBeNull();
  });
});
