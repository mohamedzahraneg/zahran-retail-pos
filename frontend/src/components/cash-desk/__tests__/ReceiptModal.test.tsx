/**
 * ReceiptModal.test.tsx — PR-CASH-DESK-REORG-1
 *
 * Pins the payload-shape contract of the lifted-from-CashDesk
 * `ReceiptModal`. Mocks `cashDeskApi.receive` and asserts the exact
 * arguments fired on submit. The audit confirmed the backend writes
 * a balanced JE + customer_ledger + cashbox_transaction (cash only)
 * — the test here is the FE-side guard that the payload arriving at
 * the backend is exactly what the audit assumed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ReceiptModal } from '../ReceiptModal';
import type { Customer } from '@/api/customers.api';
import type { Cashbox } from '@/api/cash-desk.api';

const receiveMock = vi.fn(async (_body: Record<string, unknown>) => ({}));

// Full synthetic mocks — no `importOriginal` because the vi.mock
// factory runs at hoist time before the path-alias resolver is up,
// so `await importOriginal()` of `@/...` paths fails with
// `ERR_MODULE_NOT_FOUND`.
vi.mock('@/api/cash-desk.api', () => ({
  cashDeskApi: {
    receive: (body: Record<string, unknown>) => receiveMock(body),
    pay: vi.fn(),
    cashboxes: vi.fn(async () => []),
    cashflowToday: vi.fn(async () => []),
    shiftVariances: vi.fn(async () => null),
    movements: vi.fn(async () => []),
    listCustomerPayments: vi.fn(async () => []),
    listSupplierPayments: vi.fn(async () => []),
    deposit: vi.fn(),
  },
}));
vi.mock('@/api/customers.api', () => ({
  customersApi: {
    list: vi.fn(async () => ({ data: [] })),
    unpaidInvoices: vi.fn(async () => []),
  },
}));
vi.mock('@/components/InvoiceHoverCard', () => ({
  InvoiceHoverCard: () => null,
}));
const toastErrorMock = vi.fn();
const toastSuccessMock = vi.fn();
vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return {
    default: Object.assign(fn, {
      error: (msg: string) => toastErrorMock(msg),
      success: (msg: string) => toastSuccessMock(msg),
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

const customer: Customer = {
  id: 'cust-1',
  code: 'CUS-001',
  full_name: 'عميل اختبار',
  phone: '01000000000',
  email: null,
  loyalty_tier: 'bronze',
  loyalty_points: 0,
  current_balance: 250,
} as unknown as Customer;

function renderModal(props: Partial<Parameters<typeof ReceiptModal>[0]> = {}) {
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <ReceiptModal
        cashboxes={cashboxes}
        prefilledCustomer={customer}
        onClose={onClose}
        onSuccess={onSuccess}
        {...props}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onClose, onSuccess };
}

beforeEach(() => {
  receiveMock.mockClear();
  toastErrorMock.mockClear();
  toastSuccessMock.mockClear();
});

describe('<ReceiptModal /> — PR-CASH-DESK-REORG-1', () => {
  it('renders inside the testid wrapper + shows the prefilled customer name (no search input)', () => {
    renderModal();
    expect(screen.getByTestId('receipt-modal')).toBeInTheDocument();
    // Prefilled customer is shown read-only.
    expect(screen.getByText('عميل اختبار')).toBeInTheDocument();
    // The customer-search input must NOT render when prefilled.
    expect(screen.queryByTestId('receipt-modal-customer-search')).toBeNull();
  });

  it('submit fires cashDeskApi.receive with the canonical payload shape (kind=refund skips allocations)', async () => {
    renderModal();
    // Switch to refund FIRST so the allocation-validation guard
    // doesn't trip on the empty allocations state. The kind buttons
    // re-style themselves (`bg-brand-600` when selected) — we look
    // for that class to confirm the click landed.
    const refundButton = screen.getByRole('button', { name: 'استرجاع' });
    fireEvent.click(refundButton);
    // Wait one tick for React to commit the setKind state update
    // before we fill the rest of the form.
    await new Promise((r) => setTimeout(r, 0));
    expect(refundButton.className).toContain('bg-brand-600');

    // Then fill amount.
    fireEvent.change(screen.getByTestId('receipt-modal-amount'), {
      target: { value: '50' },
    });
    fireEvent.click(screen.getByTestId('receipt-modal-submit'));

    // React-Query schedules `mutationFn` as a microtask, so the mock
    // is NOT called synchronously after `fireEvent.click`. Wait for
    // the mock to be called (or for an error toast as a diagnostic).
    await waitFor(() => {
      if (
        receiveMock.mock.calls.length === 0 &&
        toastErrorMock.mock.calls.length > 0
      ) {
        throw new Error(
          `Submit guard tripped: ${JSON.stringify(toastErrorMock.mock.calls)}`,
        );
      }
      expect(receiveMock).toHaveBeenCalledTimes(1);
    });
    const payload = receiveMock.mock.calls[0][0];
    expect(payload).toMatchObject({
      customer_id: 'cust-1',
      cashbox_id: 'cb-1',
      payment_method: 'cash',
      amount: 50,
      kind: 'refund',
    });
    expect(payload.allocations).toBeUndefined();
  });

  it('refuses submit with no amount (mutation not called)', () => {
    renderModal();
    fireEvent.click(screen.getByTestId('receipt-modal-submit'));
    expect(receiveMock).not.toHaveBeenCalled();
  });

  it('without prefilledCustomer the search input renders', () => {
    renderModal({ prefilledCustomer: null });
    expect(screen.getByTestId('receipt-modal-customer-search')).toBeInTheDocument();
  });

  it('cancel button calls onClose without firing the mutation', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByTestId('receipt-modal-cancel'));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(receiveMock).not.toHaveBeenCalled();
  });
});
