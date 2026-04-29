/**
 * PaymentAccountDetailsPanel.test.tsx — PR-FIN-PAYACCT-4D-UX-FIX-2
 *
 * Pins the centered details modal contract:
 *
 *   ✓ Renders identity fields, per-account totals, and warnings
 *   ✓ Action buttons honor the `payment-accounts.manage` gate
 *   ✓ Calls GET /payment-accounts/:id/movements with the right params
 *   ✓ Empty-operations state shows "لا توجد حركات على هذا الحساب"
 *   ✓ Filter changes (from/to/type/q) re-trigger the query
 *   ✓ Pagination size selector + nav buttons render when total > 0
 *
 * Locks the regression: anyone removing per-account semantics or
 * regressing the empty state to fake rows fails CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  PaymentAccountBalance,
  PaymentAccountMovementsResponse,
  PaymentAccountMovementRow,
  PaymentProvider,
} from '@/api/payments.api';
import type { Cashbox } from '@/api/cash-desk.api';

const movementsMock = vi.fn();

vi.mock('@/api/payments.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    paymentsApi: {
      movements: (id: string, filter: any) => movementsMock(id, filter),
    },
  };
});

import { PaymentAccountDetailsPanel } from '../PaymentAccountDetailsPanel';

// ── Fixtures ─────────────────────────────────────────────────────
function makeAccount(over: Partial<PaymentAccountBalance> = {}): PaymentAccountBalance {
  return {
    payment_account_id: 'acct-1',
    method: 'instapay',
    provider_key: 'instapay',
    display_name: 'InstaPay',
    identifier: '01000000000',
    gl_account_code: '1114',
    cashbox_id: null,
    is_default: true,
    active: true,
    sort_order: 0,
    metadata: {},
    gl_name_ar: 'المحافظ الإلكترونية',
    normal_balance: 'debit',
    total_in: '365.00',
    total_out: '0.00',
    net_debit: '365.00',
    je_count: 3,
    last_movement: '2026-04-29',
    ...over,
  };
}

const PROVIDER: PaymentProvider = {
  provider_key: 'instapay', method: 'instapay', name_ar: 'إنستا باي', name_en: 'InstaPay',
  icon_name: 'smartphone', logo_key: 'instapay', default_gl_account_code: '1114',
  group: 'instapay', requires_reference: true,
};

function makeRow(over: Partial<PaymentAccountMovementRow> = {}): PaymentAccountMovementRow {
  return {
    id: 'op-1',
    operation_type: 'invoice_payment',
    operation_type_ar: 'بيع',
    reference_id: 'inv-1',
    reference_no: 'INV-2026-000142',
    payment_account_id: 'acct-1',
    payment_method: 'instapay',
    amount_in: '300.00',
    amount_out: '0.00',
    net_amount: '300.00',
    counterparty_id: null,
    counterparty_name: 'محمد العميل',
    user_id: null,
    user_name: 'alzbaty',
    journal_entry_id: 'je-1',
    journal_entry_no: 'JE-2026-000320',
    occurred_at: '2026-04-29T12:18:00Z',
    notes: null,
    ...over,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof PaymentAccountDetailsPanel>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PaymentAccountDetailsPanel
        account={makeAccount()}
        provider={PROVIDER}
        cashbox={null}
        warnings={[]}
        canManage={true}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onSetDefault={vi.fn()}
        onToggleActive={vi.fn()}
        onDelete={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  movementsMock.mockReset();
});

// ── Tests ────────────────────────────────────────────────────────
describe('<PaymentAccountDetailsPanel /> — PR-FIN-PAYACCT-4D-UX-FIX-2', () => {
  it('renders the modal surface (identity, totals, filters, operations slot)', async () => {
    movementsMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    } satisfies PaymentAccountMovementsResponse);
    renderPanel();
    expect(screen.getByTestId('payment-account-details-modal')).toBeInTheDocument();
    expect(screen.getByTestId('details-identity')).toBeInTheDocument();
    expect(screen.getByTestId('details-totals')).toBeInTheDocument();
    expect(screen.getByTestId('details-filters')).toBeInTheDocument();
    expect(screen.getByTestId('details-actions')).toBeInTheDocument();
  });

  it('shows account-specific totals from the supplied account (NOT the shared bucket)', async () => {
    movementsMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderPanel({
      account: makeAccount({
        display_name: 'InstaPay', total_in: '365.00', total_out: '0.00',
        net_debit: '365.00', je_count: 3,
      }),
    });
    const totals = screen.getByTestId('details-totals');
    expect(within(totals).getByTestId('totals-in').textContent).toMatch(/365\.00/);
    expect(within(totals).getByTestId('totals-net').textContent).toMatch(/365\.00/);
    expect(within(totals).getByTestId('totals-count').textContent).toMatch(/3/);
  });

  it('Vodafone Cash with no account-specific rows shows zero totals (no shared bucket leak)', async () => {
    movementsMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderPanel({
      account: makeAccount({
        payment_account_id: 'acct-vodafone',
        display_name: 'Vodafone Cash تجريبي',
        method: 'vodafone_cash',
        is_default: false,
        active: false,
        total_in: '0.00',
        total_out: '0.00',
        net_debit: '0.00',
        je_count: 0,
        last_movement: null,
      }),
    });
    const totals = screen.getByTestId('details-totals');
    expect(within(totals).getByTestId('totals-net').textContent).toMatch(/0\.00/);
    expect(within(totals).getByTestId('totals-count').textContent).toMatch(/0/);
    // The empty-operations state renders.
    await waitFor(() =>
      expect(screen.getByTestId('details-empty')).toBeInTheDocument(),
    );
    expect(screen.getByText('لا توجد حركات على هذا الحساب')).toBeInTheDocument();
  });

  it('hides action buttons when canManage is false', async () => {
    movementsMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderPanel({ canManage: false });
    expect(screen.queryByTestId('details-actions')).toBeNull();
    expect(screen.queryByTestId('details-action-edit')).toBeNull();
    expect(screen.queryByTestId('details-action-set-default')).toBeNull();
    expect(screen.queryByTestId('details-action-toggle-active')).toBeNull();
    expect(screen.queryByTestId('details-action-delete')).toBeNull();
  });

  it('renders supplied warnings inside the panel', async () => {
    movementsMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderPanel({ warnings: ['غير مربوط بخزنة', 'لا توجد حركات'] });
    const w = screen.getByTestId('details-warnings');
    expect(within(w).getByText('غير مربوط بخزنة')).toBeInTheDocument();
    expect(within(w).getByText('لا توجد حركات')).toBeInTheDocument();
  });

  it('queries paymentsApi.movements with the account id and default filter shape', async () => {
    movementsMock.mockResolvedValue({
      rows: [makeRow()],
      total: 1,
      totals: { in: '300.00', out: '0.00', net: '300.00', count: 1 },
    });
    renderPanel();
    await waitFor(() => expect(movementsMock).toHaveBeenCalled());
    const [id, filter] = movementsMock.mock.calls[0];
    expect(id).toBe('acct-1');
    expect(filter.from).toBeUndefined();
    expect(filter.to).toBeUndefined();
    expect(filter.type).toBeUndefined();
    expect(filter.q).toBeUndefined();
    expect(filter.limit).toBe(20);
    expect(filter.offset).toBe(0);
  });

  it('renders the operations row for a real API response', async () => {
    movementsMock.mockResolvedValue({
      rows: [makeRow({ id: 'op-99', reference_no: 'INV-2026-000142' })],
      total: 1,
      totals: { in: '300.00', out: '0.00', net: '300.00', count: 1 },
    });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId('details-operations-table')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('details-row-op-99')).toBeInTheDocument();
    expect(screen.getByText('INV-2026-000142')).toBeInTheDocument();
    // Type filter = "بيع" badge appears in the operations table cell.
    expect(screen.getAllByText('بيع').length).toBeGreaterThan(0);
  });

  it('changing the type filter re-queries paymentsApi.movements with that type', async () => {
    movementsMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderPanel();
    await waitFor(() => expect(movementsMock).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('details-filter-type'), {
      target: { value: 'customer_payment' },
    });
    await waitFor(() => {
      const last = movementsMock.mock.calls[movementsMock.mock.calls.length - 1];
      expect(last[1].type).toBe('customer_payment');
    });
  });

  it('changing the q filter re-queries with the search term', async () => {
    movementsMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderPanel();
    await waitFor(() => expect(movementsMock).toHaveBeenCalled());
    fireEvent.change(screen.getByTestId('details-filter-q'), {
      target: { value: 'INV-2026' },
    });
    await waitFor(() => {
      const last = movementsMock.mock.calls[movementsMock.mock.calls.length - 1];
      expect(last[1].q).toBe('INV-2026');
    });
  });

  it('renders pagination controls when total > 0', async () => {
    movementsMock.mockResolvedValue({
      rows: [makeRow(), makeRow({ id: 'op-2' })],
      total: 25,
      totals: { in: '300.00', out: '0.00', net: '300.00', count: 25 },
    });
    renderPanel();
    await waitFor(() =>
      expect(screen.getByTestId('details-pagination')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('details-pagination-summary')).toHaveTextContent(/25/);
    expect(screen.getByTestId('details-pagination-next')).toBeInTheDocument();
  });

  it('clicking action buttons triggers the parent callbacks', async () => {
    movementsMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    const onEdit = vi.fn();
    const onSetDefault = vi.fn();
    const onToggleActive = vi.fn();
    const onDelete = vi.fn();
    renderPanel({ onEdit, onSetDefault, onToggleActive, onDelete });
    fireEvent.click(screen.getByTestId('details-action-edit'));
    fireEvent.click(screen.getByTestId('details-action-toggle-active'));
    fireEvent.click(screen.getByTestId('details-action-delete'));
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(onToggleActive).toHaveBeenCalledTimes(1);
    expect(onDelete).toHaveBeenCalledTimes(1);
    // set-default is disabled when account is already default → no call.
    fireEvent.click(screen.getByTestId('details-action-set-default'));
    expect(onSetDefault).not.toHaveBeenCalled();
  });

  // ─── PR-FIN-PAYACCT-4D-UX-FIX-4: smart-range chips ─────────────
  it('PR-4D-UX-FIX-4: renders the 4 smart-range chips above the date inputs', async () => {
    movementsMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderPanel();
    expect(screen.getByTestId('details-range-chips')).toBeInTheDocument();
    expect(screen.getByTestId('details-range-today')).toBeInTheDocument();
    expect(screen.getByTestId('details-range-week')).toBeInTheDocument();
    expect(screen.getByTestId('details-range-month')).toBeInTheDocument();
    expect(screen.getByTestId('details-range-custom')).toBeInTheDocument();
  });

  it('PR-4D-UX-FIX-4: clicking "اليوم" applies a from=to=today range and re-fires the query', async () => {
    movementsMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderPanel();
    await waitFor(() => expect(movementsMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('details-range-today'));
    await waitFor(() => {
      const last = movementsMock.mock.calls[movementsMock.mock.calls.length - 1];
      expect(last[1].from).toBe(last[1].to);
    });
  });

  it('PR-4D-UX-FIX-4: "هذا الأسبوع" snaps from to a Saturday', async () => {
    movementsMock.mockResolvedValue({
      rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    renderPanel();
    await waitFor(() => expect(movementsMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('details-range-week'));
    await waitFor(() => {
      const last = movementsMock.mock.calls[movementsMock.mock.calls.length - 1];
      expect(last[1].from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      // 6 = Saturday in JS (Sunday=0).
      expect(new Date(last[1].from).getDay()).toBe(6);
    });
  });
});
