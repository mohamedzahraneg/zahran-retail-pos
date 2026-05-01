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

  // ─── PR-FIN-PAYACCT-4D-UX-FIX-15 ──────────────────────────────────
  // Pin the redesigned accounting reconciliation card:
  //   • full Arabic labels ("رصيد الخزنة", "رصيد الأستاذ العام", "الفرق")
  //     on their own rows — never the broken inline "مخزن: ... · أستاذ:".
  //   • |drift| ≤ 0.01 → calm green "لا توجد فروقات محاسبية".
  //   • |drift| > 0.01 → rose warning, money formatted, sign preserved.
  //   • read-only footer: "هذه قراءة فقط؛ لا يتم إجراء أي تسوية تلقائية."
  //   • component remains read-only (no extra mutation hooks).
  describe('PR-FIN-PAYACCT-4D-UX-FIX-15 accounting reconciliation card', () => {
    const PROD_DRIFT: CashboxGlDrift = {
      cashbox_id: 'cb-cash-1', cashbox_name: 'الخزينة الرئيسية',
      kind: 'cash', is_active: true,
      stored_balance: '29800.00',
      gl_total_dr: '36043.00', gl_total_cr: '6493.00', gl_net: '29550.00',
      drift_amount: '250.00',
    };

    it('renders the three labelled rows on their own lines (stored / GL / difference)', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
      });
      renderModal({ drifts: [PROD_DRIFT] });
      const card = await screen.findByTestId('cashbox-details-drift');
      expect(within(card).getByText(/رصيد الخزنة/)).toBeInTheDocument();
      expect(within(card).getByText(/رصيد الأستاذ العام/)).toBeInTheDocument();
      expect(within(card).getByText(/الفرق/)).toBeInTheDocument();
    });

    it('renders each money value next to its label (29,800 / 29,550 / +250)', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
      });
      renderModal({ drifts: [PROD_DRIFT] });
      const stored = await screen.findByTestId('cashbox-details-drift-stored');
      const gl     = screen.getByTestId('cashbox-details-drift-gl');
      const amount = screen.getByTestId('cashbox-details-drift-amount');
      expect(stored.textContent).toMatch(/29,800\.00/);
      expect(gl.textContent).toMatch(/29,550\.00/);
      expect(amount.textContent).toMatch(/\+250\.00/);
    });

    it('does NOT render the broken inline "مخزن: ... · أستاذ: ..." line', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
      });
      renderModal({ drifts: [PROD_DRIFT] });
      const card = await screen.findByTestId('cashbox-details-drift');
      // The legacy text was: "مخزن: 29,800.00 ج.م · أستاذ: 29,550.00 ج.م".
      // Both the lone "مخزن" stem AND the inline "·" separator must be absent.
      expect(card.textContent).not.toMatch(/مخزن[:\s]/);
      expect(card.textContent).not.toMatch(/·/);
      // And "أستاذ" must only appear inside the full label "رصيد الأستاذ العام".
      expect(card.textContent).not.toMatch(/^أستاذ:/m);
    });

    it('renders the read-only footer note (no auto-correction)', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
      });
      renderModal({ drifts: [PROD_DRIFT] });
      const note = await screen.findByTestId('cashbox-details-drift-readonly-note');
      expect(note.textContent).toMatch(/هذه قراءة فقط/);
      expect(note.textContent).toMatch(/لا يتم إجراء أي تسوية تلقائية/);
    });

    it('renders the rose warning header when |drift| > 0.01', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
      });
      renderModal({ drifts: [PROD_DRIFT] });
      const card = await screen.findByTestId('cashbox-details-drift');
      const header = screen.getByTestId('cashbox-details-drift-header');
      expect(header.textContent).toMatch(/فجوة مع الأستاذ العام/);
      expect(card.className).toMatch(/rose/);
      expect(card.className).not.toMatch(/emerald/);
    });

    it('renders the calm "لا توجد فروقات محاسبية" header when |drift| ≤ 0.01', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
      });
      const matched: CashboxGlDrift = {
        ...PROD_DRIFT,
        stored_balance: '29550.00',
        gl_net: '29550.00',
        drift_amount: '0.00',
      };
      renderModal({ drifts: [matched] });
      const card = await screen.findByTestId('cashbox-details-drift');
      const header = screen.getByTestId('cashbox-details-drift-header');
      expect(header.textContent).toMatch(/لا توجد فروقات محاسبية/);
      expect(card.className).toMatch(/emerald/);
      expect(card.className).not.toMatch(/rose/);
      // Read-only footer still present.
      expect(
        within(card).getByTestId('cashbox-details-drift-readonly-note'),
      ).toBeInTheDocument();
    });

    it('preserves the sign — negative drifts render with a leading "-" not "+"', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
      });
      const negDrift: CashboxGlDrift = { ...PROD_DRIFT, drift_amount: '-450.00' };
      renderModal({ drifts: [negDrift] });
      const amount = await screen.findByTestId('cashbox-details-drift-amount');
      expect(amount.textContent).toMatch(/-450\.00/);
      expect(amount.textContent).not.toMatch(/\+/);
    });

    it('still falls back to the neutral "no drift data available" line when no drift row matches', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
      });
      renderModal({ drifts: [] });
      // Card is gone; calm explanatory line shown instead.
      expect(screen.queryByTestId('cashbox-details-drift')).toBeNull();
      expect(screen.getByText(/لا توجد بيانات فروق متاحة لهذه الخزنة/)).toBeInTheDocument();
    });
  });

  // ─── PR-FIN-PAYACCT-4D-REPORTS-1A ─────────────────────────────────
  // Pin the wiring of the drilldown button into the drift card:
  //   • "عرض تقرير الفجوة" button renders ONLY when there's a real gap.
  //   • Clicking it mounts the drilldown panel beneath the card.
  //   • The matched-state card never shows the button.
  describe('PR-FIN-PAYACCT-4D-REPORTS-1A drift drilldown button', () => {
    const PROD_DRIFT: CashboxGlDrift = {
      cashbox_id: 'cb-cash-1', cashbox_name: 'الخزينة الرئيسية',
      kind: 'cash', is_active: true,
      stored_balance: '29800.00',
      gl_total_dr: '36043.00', gl_total_cr: '6493.00', gl_net: '29550.00',
      drift_amount: '250.00',
    };

    it('renders the "عرض تقرير الفجوة" button when |drift| > 0.01', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
      });
      renderModal({ drifts: [PROD_DRIFT] });
      const btn = await screen.findByTestId('cashbox-details-drift-show-report');
      expect(btn.textContent?.trim()).toBe('عرض تقرير الفجوة');
    });

    it('does NOT render the button when |drift| ≤ 0.01 (matched state)', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
      });
      const matched: CashboxGlDrift = {
        ...PROD_DRIFT,
        stored_balance: '29550.00',
        gl_net: '29550.00',
        drift_amount: '0.00',
      };
      renderModal({ drifts: [matched] });
      // Card present (matched green state) — but no drilldown button.
      await screen.findByTestId('cashbox-details-drift');
      expect(
        screen.queryByTestId('cashbox-details-drift-show-report'),
      ).toBeNull();
    });

    it('does NOT render the button when there is no drift data at all', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
      });
      renderModal({ drifts: [] });
      expect(
        screen.queryByTestId('cashbox-details-drift-show-report'),
      ).toBeNull();
    });
  });

  // ─── PR-FIN-PAYACCT-4D-REPORTS-1B ─────────────────────────────────
  // Pin the report toolbar (Excel + Print/PDF), the sortable column
  // headers, and the operator-spec datetime format with seconds.
  describe('PR-FIN-PAYACCT-4D-REPORTS-1B report toolbar + sort + datetime', () => {
    /**
     * Two production-shaped rows so we can verify ASC/DESC by amount
     * AND see the exact `DD/MM/YYYY HH:mm:ss` format land in the table.
     */
    const ROW_OLDER = makeRow({
      id: 'mv-100', amount_in: '100.00', net_amount: '100.00',
      reference_no: 'INV-A', counterparty_name: 'علي', user_name: 'احمد',
      occurred_at: '2026-04-29T08:15:00Z',
    });
    const ROW_NEWER = makeRow({
      id: 'mv-200', amount_in: '900.00', net_amount: '900.00',
      reference_no: 'INV-B', counterparty_name: 'باسل', user_name: 'بسمة',
      occurred_at: '2026-04-30T17:45:30Z',
    });

    it('toolbar renders with Excel + Print/PDF buttons disabled when there are no rows', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
      });
      renderModal();
      // Wait for the empty-state message — it only renders after the
      // query settles (so `isLoading=false`).
      const emptyMsg = await screen.findByTestId(
        'cashbox-details-export-empty-msg',
      );
      expect(emptyMsg).toHaveTextContent('لا توجد حركات للتصدير');
      const toolbar = screen.getByTestId('cashbox-details-report-toolbar');
      expect(
        within(toolbar).getByTestId('cashbox-details-export-excel'),
      ).toBeDisabled();
      expect(
        within(toolbar).getByTestId('cashbox-details-print-report'),
      ).toBeDisabled();
    });

    it('toolbar buttons enable as soon as rows arrive', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [ROW_OLDER, ROW_NEWER], total: 2,
        totals: { in: '1000.00', out: '0', net: '1000.00', count: 2 },
      });
      renderModal();
      const excel = await screen.findByTestId('cashbox-details-export-excel');
      const print = screen.getByTestId('cashbox-details-print-report');
      // Wait for query to resolve and re-render with `disabled={false}`.
      await waitFor(() => expect(excel).not.toBeDisabled());
      expect(print).not.toBeDisabled();
      expect(
        screen.queryByTestId('cashbox-details-export-empty-msg'),
      ).toBeNull();
    });

    it('datetime column renders DD/MM/YYYY HH:mm:ss with seconds (no GMT / no raw ISO)', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [ROW_OLDER], total: 1,
        totals: { in: '100.00', out: '0', net: '100.00', count: 1 },
      });
      renderModal();
      const row = await screen.findByTestId(
        'cashbox-details-row-cashbox_txn-mv-100',
      );
      // The first cell (date) carries the compact format.
      expect(row.textContent).toMatch(/\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}/);
      // No ISO-style or GMT leakage anywhere in the row.
      expect(row.textContent).not.toMatch(/2026-04-29T/);
      expect(row.textContent).not.toMatch(/GMT/);
      expect(row.textContent).not.toMatch(/Wed Apr/);
    });

    it('default sort is occurred_at DESC (newest first)', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [ROW_OLDER, ROW_NEWER], total: 2,
        totals: { in: '1000.00', out: '0', net: '1000.00', count: 2 },
      });
      renderModal();
      // Wait for the table to render.
      const tbl = await screen.findByTestId('cashbox-details-operations-table');
      const renderedRows = within(tbl).getAllByTestId(
        /cashbox-details-row-cashbox_txn-/,
      );
      // Newer row (mv-200, 2026-04-30) before older (mv-100, 2026-04-29).
      expect(renderedRows[0]).toHaveAttribute(
        'data-testid',
        'cashbox-details-row-cashbox_txn-mv-200',
      );
      expect(renderedRows[1]).toHaveAttribute(
        'data-testid',
        'cashbox-details-row-cashbox_txn-mv-100',
      );
    });

    it('clicking the date header toggles to ASC (oldest first)', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [ROW_OLDER, ROW_NEWER], total: 2,
        totals: { in: '1000.00', out: '0', net: '1000.00', count: 2 },
      });
      renderModal();
      const sortBtn = await screen.findByTestId(
        'cashbox-details-sort-btn-occurred_at',
      );
      // First click on the active column toggles to ASC.
      fireEvent.click(sortBtn);
      const tbl = screen.getByTestId('cashbox-details-operations-table');
      const renderedRows = within(tbl).getAllByTestId(
        /cashbox-details-row-cashbox_txn-/,
      );
      expect(renderedRows[0]).toHaveAttribute(
        'data-testid',
        'cashbox-details-row-cashbox_txn-mv-100',
      );
      expect(renderedRows[1]).toHaveAttribute(
        'data-testid',
        'cashbox-details-row-cashbox_txn-mv-200',
      );
      // aria-sort reflects the active state.
      const th = screen.getByTestId('cashbox-details-sort-th-occurred_at');
      expect(within(th).getByRole('button')).toHaveAttribute(
        'aria-sort',
        'ascending',
      );
    });

    it('clicking the amount_in header switches sort to that column (DESC default for numerics)', async () => {
      movementsUnifiedMock.mockResolvedValue({
        rows: [ROW_OLDER, ROW_NEWER], total: 2,
        totals: { in: '1000.00', out: '0', net: '1000.00', count: 2 },
      });
      renderModal();
      const sortBtn = await screen.findByTestId(
        'cashbox-details-sort-btn-amount_in',
      );
      fireEvent.click(sortBtn);
      const tbl = screen.getByTestId('cashbox-details-operations-table');
      const renderedRows = within(tbl).getAllByTestId(
        /cashbox-details-row-cashbox_txn-/,
      );
      // 900 (mv-200) before 100 (mv-100) — DESC default for amount.
      expect(renderedRows[0]).toHaveAttribute(
        'data-testid',
        'cashbox-details-row-cashbox_txn-mv-200',
      );
      expect(renderedRows[1]).toHaveAttribute(
        'data-testid',
        'cashbox-details-row-cashbox_txn-mv-100',
      );
    });

    it('Excel button click invokes XLSX.writeFile (via lib/exportExcel) with the loaded rows', async () => {
      // Spy on XLSX.writeFile to verify the export pipeline ran without
      // actually writing a file in the test environment.
      const xlsx = await import('xlsx');
      const writeSpy = vi
        .spyOn(xlsx, 'writeFile')
        .mockImplementation(() => undefined as any);

      movementsUnifiedMock.mockResolvedValue({
        rows: [ROW_OLDER, ROW_NEWER], total: 2,
        totals: { in: '1000.00', out: '0', net: '1000.00', count: 2 },
      });
      renderModal();
      const btn = await screen.findByTestId('cashbox-details-export-excel');
      // Wait for the query to resolve and re-render the button as enabled.
      await waitFor(() => expect(btn).not.toBeDisabled());
      fireEvent.click(btn);

      await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
      // Filename arg ends with .xlsx and starts with the cashbox slug.
      const filename = writeSpy.mock.calls[0]?.[1];
      expect(typeof filename).toBe('string');
      expect(String(filename)).toMatch(/^cashbox-report-/);
      expect(String(filename)).toMatch(/\.xlsx$/);

      writeSpy.mockRestore();
    });

    it('Print/PDF button click opens a new window via window.open (printReport flow)', async () => {
      const fakeDoc = { write: vi.fn(), close: vi.fn() };
      const openSpy = vi
        .spyOn(window, 'open')
        .mockReturnValue({ document: fakeDoc } as any);

      movementsUnifiedMock.mockResolvedValue({
        rows: [ROW_OLDER, ROW_NEWER], total: 2,
        totals: { in: '1000.00', out: '0', net: '1000.00', count: 2 },
      });
      renderModal();
      const btn = await screen.findByTestId('cashbox-details-print-report');
      await waitFor(() => expect(btn).not.toBeDisabled());
      fireEvent.click(btn);

      await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
      // The popup got the report HTML written into it.
      expect(fakeDoc.write).toHaveBeenCalledTimes(1);
      const html = String(fakeDoc.write.mock.calls[0]?.[0] ?? '');
      // Title + cashbox name + read-only footer + a totals header.
      expect(html).toMatch(/تقرير حركات الخزنة/);
      expect(html).toMatch(/الخزينة الرئيسية/);
      expect(html).toMatch(/إجمالي الداخل/);
      expect(html).toMatch(
        /هذا التقرير للقراءة فقط ولا يُجري أي تعديل على البيانات/,
      );

      openSpy.mockRestore();
    });

    it('clicking Excel/Print when there are no rows is a no-op (buttons disabled)', async () => {
      const xlsx = await import('xlsx');
      const writeSpy = vi
        .spyOn(xlsx, 'writeFile')
        .mockImplementation(() => undefined as any);
      const openSpy = vi.spyOn(window, 'open');

      movementsUnifiedMock.mockResolvedValue({
        rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
      });
      renderModal();
      const excel = await screen.findByTestId('cashbox-details-export-excel');
      const print = screen.getByTestId('cashbox-details-print-report');
      // The buttons are `disabled` so click events don't propagate to
      // the handlers — but in case of a future regression, no export
      // call should happen either way.
      fireEvent.click(excel);
      fireEvent.click(print);
      expect(writeSpy).not.toHaveBeenCalled();
      expect(openSpy).not.toHaveBeenCalled();

      writeSpy.mockRestore();
      openSpy.mockRestore();
    });
  });
});
