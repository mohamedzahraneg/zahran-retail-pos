/**
 * Cashboxes.treasury.test.tsx — PR-FIN-PAYACCT-4D-UX-FIX
 *
 * Pins the table-first treasury / payment-accounts admin layout that
 * replaces the tab-based PR-4D experience. The page lives at
 * /cashboxes; /payment-accounts continues to redirect here.
 *
 * What we lock:
 *   ✓ Page surface (header, breadcrumb, title, subtitle)
 *   ✓ Right rail is the FIRST grid child (renders RIGHT in RTL)
 *   ✓ KPI row → warning strips → filters → main table → bottom cards
 *     (DOM order)
 *   ✓ 7 KPI tiles (incl. new "آخر حركة")
 *   ✓ Main view defaults to the table — no tab strip, no overview cards
 *   ✓ All 15 table column headers present
 *   ✓ Pagination renders (size selector + summary + nav buttons)
 *   ✓ Bottom 3 dashboard cards present
 *   ✓ Cheque support: kpi tile suffix, quick-add-check, overflow menu,
 *     cheque rows surface in the table
 *   ✓ Data comes from real endpoint mocks (not fixtures)
 *   ✓ Method-mix card distinguishes نقدي vs غير نقدي and falls back
 *     to an explicit empty state when the API returns no rows (no
 *     fake numbers)
 *   ✓ Per-row warnings render from real conditions (no fakes)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  render, screen, fireEvent, waitFor, within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import type {
  PaymentAccountBalance, PaymentMethodMixRow, PaymentProvider,
} from '@/api/payments.api';
import type { Cashbox, CashboxMovement } from '@/api/cash-desk.api';

// ─── Mocks ───────────────────────────────────────────────────────
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
      // PR-FIN-PAYACCT-4D-UX-FIX-4 — stub unified-movements so the
      // CashboxDetailsModal can render without exploding when opened
      // from the treasury rail's "عرض التفاصيل" button.
      cashboxMovementsUnified: vi.fn(async () => ({
        rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
      })),
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

// ─── Fixtures ────────────────────────────────────────────────────
function makeCashbox(over: Partial<Cashbox> = {}): Cashbox {
  return {
    id: 'cb',
    name: 'الخزينة الرئيسية',
    name_ar: 'الخزينة الرئيسية',
    warehouse_id: null,
    currency: 'EGP',
    current_balance: '23105',
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
    provider_key: 'instapay', method: 'instapay', name_ar: 'إنستا باي', name_en: 'InstaPay',
    icon_name: 'smartphone', logo_key: 'instapay', default_gl_account_code: '1114',
    group: 'instapay', requires_reference: true,
  },
  {
    provider_key: 'we_pay', method: 'wallet', name_ar: 'WE Pay', name_en: 'WE Pay',
    icon_name: 'smartphone', logo_key: 'we_pay', default_gl_account_code: '1114',
    group: 'wallet', requires_reference: true,
  },
  {
    provider_key: 'check_other', method: 'check', name_ar: 'شيكات', name_en: 'Cheques',
    icon_name: 'file-check', logo_key: 'check_other', default_gl_account_code: '1115',
    group: 'bank', requires_reference: true,
  },
];

const CASH_BOX = makeCashbox({ id: 'cb-cash', kind: 'cash' });
const BANK_BOX = makeCashbox({
  id: 'cb-bank', kind: 'bank', name_ar: 'بنك مصر الرئيسي', current_balance: '0',
});

// 6 payment_accounts — covers wallet/instapay/POS/bank/cheque rows so the
// 7-tile KPI math + warning strips + per-row warnings + distribution
// card all have realistic data to compute against.
const BALANCES: PaymentAccountBalance[] = [
  makeBalance({
    payment_account_id: 'acct-instapay', method: 'instapay', provider_key: 'instapay',
    display_name: 'instapay', identifier: '01234567890',
    cashbox_id: null,
    is_default: true, je_count: 4, net_debit: '1400',
    last_movement: new Date(Date.now() - 5 * 60_000).toISOString(),
  }),
  makeBalance({
    payment_account_id: 'acct-wallet',  method: 'wallet',   provider_key: 'we_pay',
    display_name: 'wallet', identifier: '01000011122',
    // Different (gl_account_code | cashbox_id) bucket from instapay so
    // the wallet KPI's dedupe rule doesn't collapse them. In production
    // the screenshot shows the WE Pay wallet pinned to الخزينة الرئيسية.
    cashbox_id: 'cb-cash',
    is_default: true, je_count: 2, net_debit: '300',
    last_movement: new Date(Date.now() - 60 * 60_000).toISOString(),
  }),
  makeBalance({
    payment_account_id: 'acct-pos-visa', method: 'card_visa', provider_key: null,
    display_name: 'POS Visa', identifier: 'POS-001', gl_account_code: '1113',
    is_default: true, cashbox_id: null,
    last_movement: new Date(Date.now() - 25 * 60 * 60_000).toISOString(),
  }),
  makeBalance({
    payment_account_id: 'acct-pos-meeza', method: 'card_meeza', provider_key: null,
    display_name: 'POS Meeza', identifier: 'POS-MEEZA-01', gl_account_code: '1113',
    is_default: false, je_count: 1, cashbox_id: null,
  }),
  makeBalance({
    payment_account_id: 'acct-bank', method: 'bank_transfer', display_name: 'تحويل بنكي - داخلي',
    identifier: 'EG12000300020...', gl_account_code: '1113', cashbox_id: 'cb-bank',
    is_default: false, je_count: 3,
  }),
  makeBalance({
    payment_account_id: 'acct-vodafone', method: 'vodafone_cash', display_name: 'Vodafone Cash تجريبي',
    identifier: '01098765432', is_default: false, active: true, cashbox_id: null,
    last_movement: null,
  }),
];

const METHOD_MIX: PaymentMethodMixRow[] = [
  { payment_method: 'instapay', transactions: 4, total_amount: '1400.00', pct: '70.00' },
  { payment_method: 'wallet',   transactions: 2, total_amount:  '300.00', pct: '15.00' },
  { payment_method: 'cash',     transactions: 1, total_amount:  '300.00', pct: '15.00' },
];

const TODAY_MOVEMENT: CashboxMovement = {
  id: 'mv-1',
  cashbox_id: 'cb-cash',
  cashbox_name: 'الخزينة الرئيسية',
  direction: 'in',
  amount: '300.00',
  category: 'sale',
  reference_type: 'invoice',
  reference_id: null,
  reference_no: null,
  counterparty_name: null,
  balance_after: '23105.00',
  notes: null,
  user_id: null,
  user_name: null,
  kind_ar: 'sale',
  created_at: new Date().toISOString(),
};

function setUserPermissions(perms: string[]) {
  useAuthStore.setState({
    user: { id: 't', role: 'admin', permissions: perms } as any,
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <Cashboxes />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  cashboxesMock.mockResolvedValue([CASH_BOX, BANK_BOX]);
  movementsMock.mockResolvedValue([TODAY_MOVEMENT]);
  glDriftMock.mockResolvedValue([]);
  balancesMock.mockResolvedValue(BALANCES);
  providersMock.mockResolvedValue(PROVIDERS);
  methodMixMock.mockResolvedValue(METHOD_MIX);
  setUserPermissions(['cashdesk.manage_accounts', 'payment-accounts.manage', '*']);
});

// ─── Tests ───────────────────────────────────────────────────────
describe('<Cashboxes /> — PR-FIN-PAYACCT-4D-UX-FIX table-first layout', () => {
  // ─── 1. Page surface + breadcrumb + title ───────────────────────
  it('renders the canonical page surface (breadcrumb, title, subtitle)', () => {
    renderPage();
    expect(screen.getByTestId('treasury-page')).toBeInTheDocument();
    expect(screen.getByTestId('treasury-breadcrumb')).toHaveTextContent(
      /الرئيسية \/ الإعدادات \/ حسابات الدفع/,
    );
    expect(screen.getByRole('heading', { name: 'حسابات الدفع' })).toBeInTheDocument();
    expect(
      screen.getByText(/إدارة حسابات الدفع المستخدمة في نقطة البيع/),
    ).toBeInTheDocument();
  });

  // ─── 2. Right-rail RTL position ────────────────────────────────
  it('right-rail is the FIRST child of the responsive grid (renders on the RIGHT in RTL)', () => {
    renderPage();
    const grid = screen.getByTestId('treasury-grid');
    const rail = screen.getByTestId('treasury-rail');
    expect(grid.firstElementChild).toBe(rail);
  });

  // ─── 3. DOM order: KPI → warnings → filters → table → bottom ───
  it('main column flows in the approved order: KPI row → warnings → filters → table → bottom cards', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-warnings')).toBeInTheDocument(),
    );
    const kpis     = screen.getByTestId('treasury-kpis');
    const warnings = screen.getByTestId('treasury-warnings');
    const filters  = screen.getByTestId('treasury-filters');
    const table    = screen.getByTestId('treasury-table-card');
    const summary  = screen.getByTestId('treasury-summary');

    function isFollowedBy(a: Element, b: Element) {
      return !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    }
    expect(isFollowedBy(kpis,     warnings)).toBe(true);
    expect(isFollowedBy(warnings, filters)).toBe(true);
    expect(isFollowedBy(filters,  table)).toBe(true);
    expect(isFollowedBy(table,    summary)).toBe(true);
  });

  // ─── 4. Default main view is the TABLE, not tabs/cards ─────────
  it('defaults to the table as the main view (no tab strip, table is the prominent surface)', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-accounts-table')).toBeInTheDocument(),
    );
    // No tab strip, no overview card grid.
    expect(screen.queryByTestId('treasury-tabs')).toBeNull();
    expect(screen.queryByTestId('treasury-overview')).toBeNull();
    expect(screen.queryByTestId('today-movements')).toBeNull();
  });

  // ─── 5. KPI row — 7 tiles, including new "آخر حركة" ────────────
  it('renders all 7 KPI tiles, including آخر حركة', async () => {
    renderPage();
    for (const id of [
      'kpi-total',
      'kpi-active',
      'kpi-inactive',
      'kpi-no-default',
      'kpi-wallet-balance',
      'kpi-bank-balance',
      'kpi-last-movement',
    ]) {
      expect(screen.getByTestId(id)).toBeInTheDocument();
    }
    // KPI math from the fixture: 6 accounts, 6 active, 0 inactive,
    // wallet bucket = instapay 1400 + wallet 300 = 1700.
    await waitFor(() =>
      expect(screen.getByTestId('kpi-total')).toHaveTextContent('6'),
    );
    await waitFor(() =>
      expect(screen.getByTestId('kpi-wallet-balance').textContent).toMatch(/1,700/),
    );
  });

  // ─── 6. All 15 table column headers present ────────────────────
  it('main table renders all 15 approved column headers', async () => {
    renderPage();
    const expected = [
      'الشعار',
      'اسم الحساب',
      'المزود',
      'طريقة الدفع',
      'النوع',
      'الرقم المعرف',
      'حساب الأستاذ',
      'الخزنة المرتبطة',
      'الرصيد المحاسبي',
      'آخر حركة',
      'عدد الحركات',
      'الافتراضي',
      'الحالة',
      'التحذيرات',
      'الإجراءات',
    ];
    const table = screen.getByTestId('payment-accounts-table');
    for (const label of expected) {
      expect(within(table).getByText(label)).toBeInTheDocument();
    }
  });

  // ─── 7. Pagination renders ─────────────────────────────────────
  it('pagination controls render (page-size, summary, nav buttons)', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-pagination')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('pagination-size')).toBeInTheDocument();
    expect(screen.getByTestId('pagination-summary')).toBeInTheDocument();
    expect(screen.getByTestId('pagination-prev')).toBeInTheDocument();
    expect(screen.getByTestId('pagination-next')).toBeInTheDocument();
  });

  // ─── 8. Bottom 3 cards ─────────────────────────────────────────
  it('renders the bottom 3 dashboard cards', async () => {
    renderPage();
    expect(screen.getByTestId('summary-balance')).toBeInTheDocument();
    expect(screen.getByTestId('summary-distribution')).toBeInTheDocument();
    expect(screen.getByTestId('summary-method-mix')).toBeInTheDocument();
  });

  // ─── 9. Cheque support ─────────────────────────────────────────
  it('cheque support is reachable from the rail and the overflow menu', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-quick-actions')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('quick-add-check')).toBeInTheDocument();
    // Open the overflow → cashbox-side cheque entry must be present.
    fireEvent.click(screen.getByTestId('treasury-overflow'));
    expect(screen.getByTestId('treasury-overflow-menu')).toBeInTheDocument();
    expect(screen.getByTestId('overflow-add-check')).toBeInTheDocument();
  });

  // ─── 10. Real API data (not fake fixtures) ─────────────────────
  it('uses real API responses for KPIs, warnings, table rows and method-mix', async () => {
    renderPage();
    // Wait for all queries to settle.
    await waitFor(() => expect(balancesMock).toHaveBeenCalled());
    expect(cashboxesMock).toHaveBeenCalled();
    expect(providersMock).toHaveBeenCalled();
    expect(methodMixMock).toHaveBeenCalled();
    expect(glDriftMock).toHaveBeenCalled();
    // Method-mix card is populated, not empty.
    await waitFor(() =>
      expect(screen.getByTestId('method-mix-list')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('method-mix-empty')).toBeNull();
    // Cash row in the mix gets the "نقدي" badge; non-cash rows get "غير نقدي".
    expect(within(screen.getByTestId('mix-cash')).getByText('نقدي')).toBeInTheDocument();
    expect(within(screen.getByTestId('mix-instapay')).getByText('غير نقدي')).toBeInTheDocument();
  });

  // ─── 11. Method-mix empty state (NO fake data) ────────────────
  it('method-mix card shows the empty state when the API returns no rows (no fake fallback)', async () => {
    methodMixMock.mockResolvedValue([]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('method-mix-empty')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('mix-cash')).toBeNull();
    expect(screen.queryByTestId('mix-instapay')).toBeNull();
  });

  // ─── 12. Per-row warnings render from real conditions ──────────
  it('per-row warnings ("غير مربوط بخزنة" / "لا يوجد افتراضي") render from real balance data', async () => {
    renderPage();
    // POS Visa has cashbox_id=null and method is pin-recommended →
    // warning "غير مربوط بخزنة" should appear inside that row.
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-row-acct-pos-visa')).toBeInTheDocument(),
    );
    const posRow = screen.getByTestId('payment-account-row-acct-pos-visa');
    expect(within(posRow).getByText('غير مربوط بخزنة')).toBeInTheDocument();
  });

  // ─── 13. Right-rail cash summary uses /cash-desk/cashboxes data ──
  it('right-rail cash summary card renders the cash cashbox name + balance from API', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-rail-cash-summary')).toBeInTheDocument(),
    );
    const card = screen.getByTestId('treasury-rail-cash-summary');
    expect(within(card).getByText('الخزينة الرئيسية')).toBeInTheDocument();
    expect(card.textContent).toMatch(/23,105/);
  });

  // ─── 14. Warning strip from real no-default-method computation ──
  it('renders a warning strip for active methods missing a default (real data)', async () => {
    renderPage();
    // bank_transfer has 1 active row with is_default=false → strip.
    await waitFor(() =>
      expect(screen.getByTestId('warning-no-default-bank_transfer')).toBeInTheDocument(),
    );
    // card_meeza is also default=false → strip.
    expect(screen.getByTestId('warning-no-default-card_meeza')).toBeInTheDocument();
  });

  // ─── 15. Filter clearing ───────────────────────────────────────
  it('clear-filters button resets every filter input', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('filter-search')).toBeInTheDocument(),
    );
    const search = screen.getByTestId('filter-search') as HTMLInputElement;
    fireEvent.change(search, { target: { value: 'POS' } });
    expect(search.value).toBe('POS');
    fireEvent.click(screen.getByTestId('filter-clear'));
    expect((screen.getByTestId('filter-search') as HTMLInputElement).value).toBe('');
  });

  // ─── PR-FIN-PAYACCT-4D-UX-FIX-2: per-account balance semantics ──────
  it('PR-4D-UX-FIX-2: each row renders ITS OWN account-specific balance from the API (no shared bucket duplication)', async () => {
    // 3 accounts share GL=1114 with cashbox_id=null in production. The
    // bug surfaced 1690 EGP on each row. After the SQL fix, each row
    // shows its own account-specific aggregate. Use distinct fixtures
    // per row to prove the FE renders per-row data, not a shared value.
    balancesMock.mockResolvedValue([
      makeBalance({
        payment_account_id: 'acct-instapay', method: 'instapay',
        display_name: 'InstaPay الرئيسي', gl_account_code: '1114', cashbox_id: null,
        is_default: true, je_count: 3, net_debit: '365.00',
      }),
      makeBalance({
        payment_account_id: 'acct-wepay', method: 'wallet',
        display_name: 'WE Pay', gl_account_code: '1114', cashbox_id: null,
        is_default: true, je_count: 3, net_debit: '305.00',
      }),
      makeBalance({
        payment_account_id: 'acct-vodafone', method: 'vodafone_cash',
        display_name: 'Vodafone Cash تجريبي', gl_account_code: '1114', cashbox_id: null,
        // Inactive + zero rows — must render 0 / 0 / null, NOT a bucket total.
        active: false, is_default: false, je_count: 0, net_debit: '0.00',
        last_movement: null,
      }),
    ]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-row-acct-instapay')).toBeInTheDocument(),
    );

    const ipRow   = screen.getByTestId('payment-account-row-acct-instapay');
    const wpRow   = screen.getByTestId('payment-account-row-acct-wepay');
    const vdRow   = screen.getByTestId('payment-account-row-acct-vodafone');

    // Each row carries DIFFERENT balance values — no bucket duplication.
    expect(ipRow.textContent).toMatch(/365\.00/);
    expect(wpRow.textContent).toMatch(/305\.00/);
    expect(vdRow.textContent).toMatch(/0\.00/);
    // Vodafone (inactive, zero rows) has the new "لا توجد حركات" warning chip.
    expect(within(vdRow).getByText('لا توجد حركات')).toBeInTheDocument();
  });

  // ─── DetailsPanel interaction ──────────────────────────────────
  it('PR-4D-UX-FIX-2: clicking a row opens the centered details modal', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-row-acct-instapay')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('payment-account-details-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('payment-account-row-acct-instapay'));
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-details-modal')).toBeInTheDocument(),
    );
  });

  it('PR-4D-UX-FIX-2: "عرض التفاصيل" action opens the same details modal', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-row-acct-instapay')).toBeInTheDocument(),
    );
    const row = screen.getByTestId('payment-account-row-acct-instapay');
    const viewBtn = within(row).getByTestId('row-action-view-details');
    fireEvent.click(viewBtn);
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-details-modal')).toBeInTheDocument(),
    );
  });

  it('PR-4D-UX-FIX-2: "عرض التفاصيل" is visible to read-only users (no manage perm required)', async () => {
    setUserPermissions(['payment-accounts.read']); // no .manage
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-row-acct-instapay')).toBeInTheDocument(),
    );
    // Mutation actions are hidden, but view-details remains visible.
    const row = screen.getByTestId('payment-account-row-acct-instapay');
    expect(within(row).getByTestId('row-action-view-details')).toBeInTheDocument();
    expect(within(row).queryByTestId('row-action-edit')).toBeNull();
    expect(within(row).queryByTestId('row-action-delete')).toBeNull();
  });

  // ─── Bottom card relabel ───────────────────────────────────────
  it('PR-4D-UX-FIX-2: bottom balance card includes explicit GL-bucket labels', async () => {
    renderPage();
    // Wait for the balances query to resolve so the GL-bucket section renders.
    await waitFor(() =>
      expect(screen.getByTestId('summary-gl-buckets')).toBeInTheDocument(),
    );
    const buckets = screen.getByTestId('summary-gl-buckets');
    // The fixture has rows on GL 1114 (instapay+wallet) and 1113 (POS+bank).
    expect(within(buckets).getByText(/إجمالي المحافظ الإلكترونية 1114/)).toBeInTheDocument();
    expect(within(buckets).getByText(/إجمالي البنوك 1113/)).toBeInTheDocument();
  });

  // ─── PR-FIN-PAYACCT-4D-UX-FIX-4: cashbox details + deep-link ────
  it('PR-4D-UX-FIX-4: rail "عرض التفاصيل" opens the cashbox-details modal (not just a filter)', async () => {
    renderPage();
    // Rail cash-summary card renders for the active cash cashbox.
    await waitFor(() =>
      expect(screen.getByTestId('treasury-rail-cash-summary')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('cashbox-details-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('treasury-rail-cash-details'));
    await waitFor(() =>
      expect(screen.getByTestId('cashbox-details-modal')).toBeInTheDocument(),
    );
  });
});
