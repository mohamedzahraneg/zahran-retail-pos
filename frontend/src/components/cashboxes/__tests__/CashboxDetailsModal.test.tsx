/**
 * CashboxDetailsModal.test.tsx — PR-FIN-PAYACCT-4D-UX-FIX-4
 *
 * Pins the unified cashbox-details modal contract:
 *
 *   ✓ Renders header summary, period totals, drift section, linked
 *     accounts, smart filters, operations table.
 *   ✓ Calls cashDeskApi.cashboxMovementsUnified with the right params.
 *   ✓ Smart-range chips (today/week/month/custom) flip the filter and
 *     re-fire the query with the resolved from/to.
 *   ✓ Type filter narrows by source (cashbox_txn / invoice / customer / supplier).
 *   ✓ Empty state renders "لا توجد حركات على هذه الخزنة" when no rows.
 *   ✓ Linked-payment-accounts section appears with accounts whose
 *     cashbox_id matches; clicking opens the parent's onOpenLinkedAccount.
 *   ✓ Linked-empty state when no PA is linked to this cashbox.
 *   ✓ Pagination controls render when total > 0.
 *
 * Locks the regression: anyone removing the unified-feed plumbing or
 * regressing the smart-filter chips fails CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  Cashbox,
  CashboxMovementUnifiedRow,
  CashboxMovementsUnifiedResponse,
} from '@/api/cash-desk.api';
import type {
  PaymentAccountBalance,
  PaymentProvider,
  CashboxGlDrift,
} from '@/api/payments.api';

const movementsUnifiedMock = vi.fn();

vi.mock('@/api/cash-desk.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    cashDeskApi: {
      cashboxMovementsUnified: (cbId: string, filter: any) =>
        movementsUnifiedMock(cbId, filter),
    },
  };
});

import { CashboxDetailsModal } from '../CashboxDetailsModal';

// ── Fixtures ────────────────────────────────────────────────────
function makeCashbox(over: Partial<Cashbox> = {}): Cashbox {
  return {
    id: 'cb-cash-1',
    name: 'الخزينة الرئيسية',
    name_ar: 'الخزينة الرئيسية',
    warehouse_id: null,
    currency: 'EGP',
    current_balance: '25425',
    is_active: true,
    kind: 'cash',
    institution_code: null,
    institution_name: null,
    institution_name_en: null,
    institution_domain: null,
    institution_color: null,
    institution_kind: null,
    bank_branch: null,
    account_number: null,
    iban: null,
    swift_code: null,
    account_holder_name: null,
    account_manager_name: null,
    account_manager_phone: null,
    account_manager_email: null,
    wallet_phone: null,
    wallet_owner_name: null,
    check_issuer_name: null,
    color: null,
    ...over,
  };
}

function makeBalance(over: Partial<PaymentAccountBalance>): PaymentAccountBalance {
  return {
    payment_account_id: 'acct-x',
    method: 'instapay',
    provider_key: 'instapay',
    display_name: 'حساب',
    identifier: '0100',
    gl_account_code: '1114',
    cashbox_id: null,
    is_default: false,
    active: true,
    sort_order: 0,
    metadata: {},
    gl_name_ar: 'محافظ',
    normal_balance: 'debit',
    total_in: '0',
    total_out: '0',
    net_debit: '0',
    je_count: 0,
    last_movement: null,
    ...over,
  };
}

function makeRow(over: Partial<CashboxMovementUnifiedRow> = {}): CashboxMovementUnifiedRow {
  return {
    source: 'cashbox_txn',
    id: 'mv-1',
    direction: 'in',
    amount_in: '300.00',
    amount_out: '0.00',
    net_amount: '300.00',
    kind_ar: 'مبيعات كاش',
    reference_type: 'invoice',
    reference_id: 'inv-1',
    reference_no: 'INV-2026-000142',
    counterparty_name: null,
    payment_account_id: null,
    payment_method: null,
    balance_after: '25425.00',
    user_id: null,
    user_name: 'alzbaty',
    journal_entry_id: 'je-1',
    journal_entry_no: 'JE-2026-000320',
    occurred_at: '2026-04-29T12:18:00Z',
    notes: null,
    ...over,
  };
}

const PROVIDERS: PaymentProvider[] = [
  {
    provider_key: 'instapay', method: 'instapay', name_ar: 'إنستا باي', name_en: 'InstaPay',
    icon_name: 'smartphone', logo_key: 'instapay', default_gl_account_code: '1114',
    group: 'instapay', requires_reference: true,
  },
];

function renderModal(props: Partial<React.ComponentProps<typeof CashboxDetailsModal>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CashboxDetailsModal
        cashbox={makeCashbox()}
        allBalances={[]}
        drifts={[]}
        providers={PROVIDERS}
        onClose={vi.fn()}
        onOpenLinkedAccount={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  movementsUnifiedMock.mockReset();
});

// ── Tests ───────────────────────────────────────────────────────
describe('<CashboxDetailsModal /> — PR-FIN-PAYACCT-4D-UX-FIX-4', () => {
  it('renders the modal surface (identity, totals, flags, filters, range chips)', async () => {
    movementsUnifiedMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    } satisfies CashboxMovementsUnifiedResponse);
    renderModal();
    expect(screen.getByTestId('cashbox-details-modal')).toBeInTheDocument();
    expect(screen.getByTestId('cashbox-details-identity')).toBeInTheDocument();
    expect(screen.getByTestId('cashbox-details-totals')).toBeInTheDocument();
    expect(screen.getByTestId('cashbox-details-flags')).toBeInTheDocument();
    expect(screen.getByTestId('cashbox-details-filters')).toBeInTheDocument();
    expect(screen.getByTestId('cashbox-details-range-chips')).toBeInTheDocument();
  });

  it('queries cashDeskApi.cashboxMovementsUnified with the cashbox id and default range (month)', async () => {
    movementsUnifiedMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderModal();
    await waitFor(() => expect(movementsUnifiedMock).toHaveBeenCalled());
    const [id, filter] = movementsUnifiedMock.mock.calls[0];
    expect(id).toBe('cb-cash-1');
    // Default range is "month" — from is start of month, to is today.
    expect(filter.from).toMatch(/^\d{4}-\d{2}-01$/);
    expect(filter.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(filter.limit).toBe(20);
    expect(filter.offset).toBe(0);
  });

  it('clicking the "اليوم" chip narrows from/to to today', async () => {
    movementsUnifiedMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderModal();
    await waitFor(() => expect(movementsUnifiedMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('cashbox-range-today'));
    await waitFor(() => {
      const last = movementsUnifiedMock.mock.calls[movementsUnifiedMock.mock.calls.length - 1];
      expect(last[1].from).toBe(last[1].to); // today's from === today's to
    });
  });

  it('clicking the "هذا الأسبوع" chip uses Saturday-start week semantics', async () => {
    movementsUnifiedMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderModal();
    await waitFor(() => expect(movementsUnifiedMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('cashbox-range-week'));
    await waitFor(() => {
      const last = movementsUnifiedMock.mock.calls[movementsUnifiedMock.mock.calls.length - 1];
      // The "from" must be a Saturday in the current week, "to" is today.
      expect(last[1].from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      const fromDate = new Date(last[1].from);
      // 6 = Saturday in JS (Sunday=0).
      expect(fromDate.getDay()).toBe(6);
    });
  });

  it('switching to "مخصص" reveals the from/to date inputs', async () => {
    movementsUnifiedMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderModal();
    await waitFor(() => expect(movementsUnifiedMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('cashbox-range-custom'));
    expect(screen.getByTestId('cashbox-details-custom-range')).toBeInTheDocument();
    expect(screen.getByTestId('cashbox-details-custom-from')).toBeInTheDocument();
    expect(screen.getByTestId('cashbox-details-custom-to')).toBeInTheDocument();
  });

  it('changing the type filter re-queries with the source value', async () => {
    movementsUnifiedMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderModal();
    await waitFor(() => expect(movementsUnifiedMock).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('cashbox-details-filter-type'), {
      target: { value: 'customer_payment' },
    });
    await waitFor(() => {
      const last = movementsUnifiedMock.mock.calls[movementsUnifiedMock.mock.calls.length - 1];
      expect(last[1].type).toBe('customer_payment');
    });
  });

  it('renders the empty-state when the API returns no rows', async () => {
    movementsUnifiedMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderModal();
    await waitFor(() =>
      expect(screen.getByTestId('cashbox-details-empty')).toBeInTheDocument(),
    );
    expect(screen.getByText('لا توجد حركات على هذه الخزنة')).toBeInTheDocument();
  });

  it('renders unified rows from the API mock (cashbox_txn + linked-account flows)', async () => {
    movementsUnifiedMock.mockResolvedValue({
      rows: [
        makeRow({ id: 'mv-cash', source: 'cashbox_txn', kind_ar: 'مبيعات كاش', reference_no: 'INV-A' }),
        makeRow({
          id: 'mv-cp', source: 'customer_payment',
          amount_in: '500.00', net_amount: '500.00',
          kind_ar: 'مقبوضة عميل', reference_no: 'CR-001',
          payment_account_id: 'acct-instapay-1', payment_method: 'instapay',
          balance_after: null,
        }),
      ],
      total: 2,
      totals: { in: '800.00', out: '0.00', net: '800.00', count: 2 },
    });
    renderModal();
    await waitFor(() =>
      expect(screen.getByTestId('cashbox-details-operations-table')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('cashbox-details-row-cashbox_txn-mv-cash')).toBeInTheDocument();
    expect(screen.getByTestId('cashbox-details-row-customer_payment-mv-cp')).toBeInTheDocument();
    // Period totals reflect the API.
    expect(screen.getByTestId('cashbox-totals-in').textContent).toMatch(/800/);
    expect(screen.getByTestId('cashbox-totals-count').textContent).toMatch(/2/);
  });

  it('linked-payment-accounts section: renders only accounts whose cashbox_id === current.id', async () => {
    movementsUnifiedMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    const linked = makeBalance({
      payment_account_id: 'acct-instapay',
      display_name: 'InstaPay الرئيسي',
      cashbox_id: 'cb-cash-1', // matches the rendered cashbox
      method: 'instapay',
    });
    const orphan = makeBalance({
      payment_account_id: 'acct-other',
      display_name: 'حساب آخر',
      cashbox_id: 'cb-other', // different cashbox
    });
    renderModal({ allBalances: [linked, orphan] });
    expect(screen.getByTestId('cashbox-details-linked-list')).toBeInTheDocument();
    expect(screen.getByTestId('cashbox-linked-account-acct-instapay')).toBeInTheDocument();
    expect(screen.queryByTestId('cashbox-linked-account-acct-other')).toBeNull();
  });

  it('linked-empty state when no PA is linked to this cashbox', async () => {
    movementsUnifiedMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderModal({ allBalances: [makeBalance({ cashbox_id: 'cb-other' })] });
    expect(screen.getByTestId('cashbox-details-linked-empty')).toBeInTheDocument();
    expect(screen.getByText(/لا توجد حسابات دفع مربوطة بهذه الخزنة/)).toBeInTheDocument();
  });

  it('clicking a linked account fires onOpenLinkedAccount with the row', async () => {
    movementsUnifiedMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    const onOpenLinkedAccount = vi.fn();
    const linked = makeBalance({
      payment_account_id: 'acct-instapay',
      display_name: 'InstaPay',
      cashbox_id: 'cb-cash-1',
    });
    renderModal({ allBalances: [linked], onOpenLinkedAccount });
    fireEvent.click(screen.getByTestId('cashbox-linked-account-acct-instapay'));
    expect(onOpenLinkedAccount).toHaveBeenCalledTimes(1);
    expect(onOpenLinkedAccount.mock.calls[0][0].payment_account_id).toBe('acct-instapay');
  });

  it('renders pagination controls when total > 0', async () => {
    movementsUnifiedMock.mockResolvedValue({
      rows: [makeRow()],
      total: 50,
      totals: { in: '300.00', out: '0.00', net: '300.00', count: 50 },
    });
    renderModal();
    await waitFor(() =>
      expect(screen.getByTestId('cashbox-details-pagination')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('cashbox-details-pagination-size')).toBeInTheDocument();
    expect(screen.getByTestId('cashbox-details-pagination-next')).toBeInTheDocument();
  });

  it('drift section surfaces a fjuwa banner when |drift_amount| > 0.01', async () => {
    movementsUnifiedMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    const drift: CashboxGlDrift = {
      cashbox_id: 'cb-cash-1', cashbox_name: 'الخزينة الرئيسية',
      kind: 'cash', is_active: true,
      stored_balance: '25425.00', gl_total_dr: '25875.00', gl_total_cr: '0.00',
      gl_net: '25875.00', drift_amount: '-450.00',
    };
    renderModal({ drifts: [drift] });
    expect(screen.getByTestId('cashbox-details-drift')).toBeInTheDocument();
    expect(screen.getByText(/فجوة مع الأستاذ العام/)).toBeInTheDocument();
  });
});
