/**
 * Cashboxes.treasury.test.tsx — PR-FIN-PAYACCT-4D
 *
 * Pins the unified treasury page contract:
 *
 *   ✓ Page surface (header, KPIs, tabs, grid, summary, rail)
 *   ✓ Right-rail RTL: rail is the FIRST grid child (renders on the
 *     right in RTL because grid children flow right→left)
 *   ✓ One unified page — cashboxes AND payment_accounts are
 *     accessible from the same screen via tabs
 *   ✓ Tabs match the approved set (8 tabs incl. "حركة اليوم" and
 *     "التنبيهات")
 *   ✓ Cheque tab + cheque KPI + cheque quick-action all present
 *   ✓ "حركة اليوم" tab uses real /cash-desk/movements data (no
 *     mock fallback)
 *   ✓ Method-mix card uses the real API response — and when the
 *     endpoint returns no rows, shows an explicit empty state
 *     (NOT fake data)
 *   ✓ Cash sales surface as "نقدي" badge in the mix card; non-cash
 *     methods surface as "غير نقدي" badge — visual distinction per
 *     spec
 *   ✓ Add-payment-account quick actions invoke the create modal
 *
 * Locks the regression: anyone re-isolating /payment-accounts,
 * removing the cheque support, or replacing real-data cards with
 * placeholders fails CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import type { PaymentAccountBalance, PaymentMethodMixRow, PaymentProvider } from '@/api/payments.api';
import type { Cashbox, CashboxMovement } from '@/api/cash-desk.api';

// ─── Mocks ────────────────────────────────────────────────────────
const cashboxesMock = vi.fn();
const movementsMock = vi.fn();
const glDriftMock   = vi.fn();
const balancesMock  = vi.fn();
const providersMock = vi.fn();
const methodMixMock = vi.fn();

vi.mock('@/api/cash-desk.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    cashDeskApi: {
      cashboxes:     () => cashboxesMock(),
      movements: (p: any) => movementsMock(p),
      glDrift:       () => glDriftMock(),
      // CRUD stubs (unused in these tests but required for tsc).
      transfer:      vi.fn(async () => ({})),
      updateCashbox: vi.fn(async () => ({})),
      createCashbox: vi.fn(async () => ({})),
      removeCashbox: vi.fn(async () => ({})),
      institutions:  vi.fn(async () => []),
    },
  };
});

vi.mock('@/api/payments.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    paymentsApi: {
      listProviders: () => providersMock(),
      listBalances:  () => balancesMock(),
      methodMix:     () => methodMixMock(),
      // Mutation stubs (unused in these tests).
      setDefault:    vi.fn(async () => ({})),
      toggleActive:  vi.fn(async () => ({})),
      deleteAccount: vi.fn(async () => ({ id: '', mode: 'hard' as const })),
      createAccount: vi.fn(async () => ({})),
      updateAccount: vi.fn(async () => ({})),
    },
  };
});

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return {
    default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }),
  };
});

import Cashboxes from '../Cashboxes';

// ─── Fixtures ─────────────────────────────────────────────────────
function makeCashbox(over: Partial<Cashbox> = {}): Cashbox {
  return {
    id: 'cb',
    name: 'الخزينة الرئيسية',
    name_ar: 'الخزينة الرئيسية',
    warehouse_id: null,
    currency: 'EGP',
    current_balance: '5000',
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

const PROVIDERS: PaymentProvider[] = [
  {
    provider_key: 'check_other',
    method: 'check',
    name_ar: 'شيكات',
    name_en: 'Cheques',
    icon_name: 'file-check',
    logo_key: 'check_other',
    default_gl_account_code: '1115',
    group: 'bank',
    requires_reference: true,
  },
];

const CASHBOXES: Cashbox[] = [
  makeCashbox({ id: 'cb-cash', kind: 'cash',  name_ar: 'الخزينة الرئيسية', current_balance: '5000' }),
  makeCashbox({ id: 'cb-bank', kind: 'bank',  name_ar: 'بنك CIB',          current_balance: '12000' }),
];

const BALANCES: PaymentAccountBalance[] = [
  makeBalance({
    payment_account_id: 'acct-instapay', method: 'instapay', display_name: 'InstaPay الرئيسي',
    is_default: true, net_debit: '1500', total_in: '1500', je_count: 4,
  }),
  makeBalance({
    payment_account_id: 'acct-check', method: 'check', provider_key: 'check_other',
    display_name: 'دفتر شيكات NBE', identifier: 'NBE-123', gl_account_code: '1115',
    is_default: true, net_debit: '2000', total_in: '2000', je_count: 1,
  }),
];

const TODAY_MOVEMENTS: CashboxMovement[] = [
  {
    id: 'mv-1',
    cashbox_id: 'cb-cash',
    cashbox_name: 'الخزينة الرئيسية',
    direction: 'in',
    amount: '300.00',
    category: 'sale',
    reference_type: 'invoice',
    reference_id: null,
    reference_no: 'INV-2026-000141',
    counterparty_name: null,
    balance_after: '5300.00',
    notes: null,
    user_id: null,
    user_name: null,
    kind_ar: 'sale',
    created_at: '2026-04-29T15:01:51.981Z',
  },
];

const METHOD_MIX: PaymentMethodMixRow[] = [
  { payment_method: 'cash',     transactions: 94, total_amount: '28720.01', pct: '94.41' },
  { payment_method: 'instapay', transactions: 4,  total_amount:  '1400.00', pct:  '4.60' },
];

// ─── Render helper ────────────────────────────────────────────────
function setUserPermissions(perms: string[]) {
  useAuthStore.setState({
    user: { id: 't', role: 'admin', permissions: perms } as any,
  });
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <Cashboxes />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cashboxesMock.mockResolvedValue(CASHBOXES);
  movementsMock.mockResolvedValue(TODAY_MOVEMENTS);
  glDriftMock.mockResolvedValue([]);
  balancesMock.mockResolvedValue(BALANCES);
  providersMock.mockResolvedValue(PROVIDERS);
  methodMixMock.mockResolvedValue(METHOD_MIX);
  setUserPermissions(['cashdesk.manage_accounts', 'payment-accounts.manage', '*']);
});

// ─── Tests ────────────────────────────────────────────────────────
describe('<Cashboxes /> — PR-FIN-PAYACCT-4D unified treasury page', () => {
  it('renders the canonical page surface (header, KPIs, tabs, grid, summary, rail)', async () => {
    renderPage();
    expect(screen.getByTestId('treasury-page')).toBeInTheDocument();
    expect(screen.getByText('الخزائن والحسابات البنكية')).toBeInTheDocument();
    expect(screen.getByTestId('treasury-kpis')).toBeInTheDocument();
    expect(screen.getByTestId('treasury-tabs')).toBeInTheDocument();
    expect(screen.getByTestId('treasury-grid')).toBeInTheDocument();
    expect(screen.getByTestId('treasury-rail')).toBeInTheDocument();
    expect(screen.getByTestId('treasury-summary')).toBeInTheDocument();
  });

  it('right-rail is the FIRST child of the responsive grid (renders on the right in RTL)', async () => {
    renderPage();
    const grid = screen.getByTestId('treasury-grid');
    const rail = screen.getByTestId('treasury-rail');
    // RTL invariant: the first grid child takes the rightmost slot in
    // an RTL document. The rail must therefore be the first child.
    expect(grid.firstElementChild).toBe(rail);
  });

  it('renders the 8 approved tabs incl. "الشيكات" and "حركة اليوم"', async () => {
    renderPage();
    for (const id of [
      'tab-all',
      'tab-cashboxes',
      'tab-payment-accounts',
      'tab-banks-wallets',
      'tab-pos-cards',
      'tab-cheques',
      'tab-today',
      'tab-alerts',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
  });

  it('renders all 8 KPI tiles, including cheque', async () => {
    renderPage();
    for (const id of [
      'kpi-total',
      'kpi-cash',
      'kpi-bank',
      'kpi-wallet',
      'kpi-card',
      'kpi-check',
      'kpi-no-default',
      'kpi-drift',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    // KPI math: cash = 5000 (one cash cashbox), check ≥ 2000 (cheque
    // payment account net_debit) — values come from real fixtures, not mocks.
    await waitFor(() =>
      expect(screen.getByTestId('kpi-cash').textContent).toMatch(/5,000/),
    );
    await waitFor(() =>
      expect(screen.getByTestId('kpi-check').textContent).toMatch(/2,000/),
    );
  });

  it('cheque is reachable from BOTH the tab strip and the quick-action rail', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-quick-actions')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('tab-cheques')).toBeInTheDocument();
    expect(screen.getByTestId('quick-add-check')).toBeInTheDocument();
    expect(screen.getByTestId('quick-add-check')).toHaveTextContent('شيكات');
  });

  it('"الكل" tab shows BOTH cashboxes AND payment_accounts on one screen', async () => {
    renderPage();
    // Both must live inside the same `treasury-overview` block —
    // proving the cashbox + payment-account surfaces are unified.
    // Note: "الخزينة الرئيسية" also shows in the rail's cash summary
    // card, so we scope the assertion to the overview section.
    const overview = screen.getByTestId('treasury-overview');
    await waitFor(() =>
      expect(within(overview).getByText('الخزينة الرئيسية')).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(within(overview).getByText('InstaPay الرئيسي')).toBeInTheDocument(),
    );
  });

  it('"حركة اليوم" tab renders rows from /cash-desk/movements (real data)', async () => {
    renderPage();
    fireEvent.click(screen.getByTestId('tab-today'));
    await waitFor(() =>
      expect(screen.getByTestId('today-movements')).toBeInTheDocument(),
    );
    // The fixture has exactly one row → its data-testid must be present.
    await waitFor(() =>
      expect(screen.getByTestId('today-row-mv-1')).toBeInTheDocument(),
    );
    // The endpoint was called (proving no mock-fallback).
    expect(movementsMock).toHaveBeenCalled();
  });

  it('method-mix card renders real rows AND distinguishes cash from non-cash', async () => {
    renderPage();
    // Wait for the API rows to populate the card.
    await waitFor(() =>
      expect(screen.getByTestId('method-mix-list')).toBeInTheDocument(),
    );
    // Real rows from the API mock (cash + instapay) — empty state not visible.
    expect(screen.queryByTestId('method-mix-empty')).toBeNull();
    expect(screen.getByTestId('mix-cash')).toBeInTheDocument();
    expect(screen.getByTestId('mix-instapay')).toBeInTheDocument();
    // Cash row carries the "نقدي" badge; non-cash row carries "غير نقدي".
    const cashRow = screen.getByTestId('mix-cash');
    const ipRow   = screen.getByTestId('mix-instapay');
    expect(within(cashRow).getByText('نقدي')).toBeInTheDocument();
    expect(within(ipRow).getByText('غير نقدي')).toBeInTheDocument();
  });

  it('method-mix card shows the empty state when the API returns no rows (no fake data)', async () => {
    methodMixMock.mockResolvedValue([]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('method-mix-empty')).toBeInTheDocument(),
    );
    // No fake rows — neither cash nor any other method should appear.
    expect(screen.queryByTestId('mix-cash')).toBeNull();
    expect(screen.queryByTestId('mix-instapay')).toBeNull();
    expect(screen.queryByTestId('mix-wallet')).toBeNull();
  });

  it('alerts panel includes the two PR-4D alerts when conditions are met', async () => {
    // Add an inactive account with je_count > 0, and an active
    // bank_transfer account with no cashbox_id pin.
    balancesMock.mockResolvedValue([
      ...BALANCES,
      makeBalance({
        payment_account_id: 'acct-old', method: 'wallet', display_name: 'محفظة قديمة',
        active: false, is_default: false, je_count: 5,
      }),
      makeBalance({
        payment_account_id: 'acct-bank', method: 'bank_transfer', display_name: 'CIB',
        is_default: true, cashbox_id: null,
      }),
    ]);
    renderPage();
    // Both alerts depend on the balances fetch resolving.
    await waitFor(() =>
      expect(screen.getByTestId('alert-inactive-with-movements')).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByTestId('alert-no-cashbox-pin')).toBeInTheDocument(),
    );
  });

  it('clicking "إضافة حساب شيكات" quick-action opens the payment-account create modal pre-filled to cheque', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('quick-add-check')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('quick-add-check'));
    // The PaymentAccountModal renders a wrapper with this testid.
    expect(screen.getByTestId('payment-account-modal')).toBeInTheDocument();
    // Method picker is locked to 'check' on opening via the rail.
    const methodSel = screen.getByTestId('payment-account-modal-method') as HTMLSelectElement;
    expect(methodSel.value).toBe('check');
  });
});
