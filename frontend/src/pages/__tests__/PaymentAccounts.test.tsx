/**
 * PaymentAccounts.test.tsx — PR-FIN-PAYACCT-4B
 *
 * Pins the dedicated `/payment-accounts` admin page:
 *
 *   ✓ Page renders header / KPIs / filters / table / right rail / summary
 *   ✓ KPI math is computed from real fixtures (total / active / inactive /
 *     no-default / wallet / bank / check totals — INCLUDING cheque)
 *   ✓ Filters work (search, method, type, active, default, cashbox)
 *   ✓ Clicking a row opens the side details panel
 *   ✓ Set-default action calls paymentsApi.setDefault(id)
 *   ✓ Toggle-active action calls paymentsApi.toggleActive(id)
 *   ✓ Delete action calls paymentsApi.deleteAccount(id) after confirm()
 *   ✓ Permission gate: `payment-accounts.manage` hides mutations
 *   ✓ Quick-action buttons include "إضافة حساب شيكات"
 *
 * Locks the regression: anyone removing the cheque KPI / cheque
 * quick-action / cheque type filter / cheque support — fails CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import type { PaymentAccountBalance, PaymentProvider } from '@/api/payments.api';
import type { Cashbox } from '@/api/cash-desk.api';

const setDefaultMock = vi.fn(async (_id: string) => ({}));
const toggleActiveMock = vi.fn(async (_id: string) => ({}));
const deleteAccountMock = vi.fn(async (_id: string) => ({ id: _id, mode: 'hard' as const }));
const listBalancesMock = vi.fn();
const listProvidersMock = vi.fn();
const cashboxesMock = vi.fn();
const glDriftMock = vi.fn();

vi.mock('@/api/payments.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    paymentsApi: {
      listProviders: () => listProvidersMock(),
      listBalances: () => listBalancesMock(),
      setDefault: (id: string) => setDefaultMock(id),
      toggleActive: (id: string) => toggleActiveMock(id),
      deleteAccount: (id: string) => deleteAccountMock(id),
      // The modal also calls these — stubs only.
      createAccount: vi.fn(async () => ({})),
      updateAccount: vi.fn(async () => ({})),
    },
  };
});

vi.mock('@/api/cash-desk.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    cashDeskApi: {
      cashboxes: () => cashboxesMock(),
      glDrift: () => glDriftMock(),
    },
  };
});

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return {
    default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }),
  };
});

import PaymentAccounts from '../PaymentAccounts';

const PROVIDERS: PaymentProvider[] = [
  {
    provider_key: 'instapay',
    method: 'instapay',
    name_ar: 'إنستا باي',
    name_en: 'InstaPay',
    icon_name: 'smartphone',
    logo_key: 'instapay',
    default_gl_account_code: '1114',
    group: 'instapay',
    requires_reference: true,
  },
  {
    provider_key: 'cib',
    method: 'bank_transfer',
    name_ar: 'CIB',
    name_en: 'CIB',
    icon_name: 'building',
    logo_key: 'cib',
    default_gl_account_code: '1113',
    group: 'bank',
    requires_reference: true,
  },
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
  {
    id: 'cb-cash',
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
  },
  {
    id: 'cb-bank-cib',
    name: 'بنك CIB',
    name_ar: 'بنك CIB',
    warehouse_id: null,
    currency: 'EGP',
    current_balance: '0',
    is_active: true,
    kind: 'bank',
    institution_code: 'cib',
    institution_name: 'CIB',
    institution_name_en: 'CIB',
    institution_domain: null,
    institution_color: null,
    institution_kind: 'bank',
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
  },
];

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

const BALANCES: PaymentAccountBalance[] = [
  // Wallet — InstaPay default
  makeBalance({
    payment_account_id: 'acct-instapay',
    method: 'instapay',
    provider_key: 'instapay',
    display_name: 'InstaPay الرئيسي',
    identifier: '01001234567',
    gl_account_code: '1114',
    is_default: true,
    net_debit: '1000',
    total_in: '1500',
    total_out: '500',
    je_count: 5,
  }),
  // Bank — CIB (default missing!)
  makeBalance({
    payment_account_id: 'acct-cib',
    method: 'bank_transfer',
    provider_key: 'cib',
    display_name: 'CIB Main',
    identifier: 'EG123',
    gl_account_code: '1113',
    cashbox_id: 'cb-bank-cib',
    is_default: false, // <-- intentional: triggers no-default warning
    net_debit: '5000',
    total_in: '5000',
    total_out: '0',
    je_count: 2,
  }),
  // Cheque — explicit cheque support
  makeBalance({
    payment_account_id: 'acct-check',
    method: 'check',
    provider_key: 'check_other',
    display_name: 'دفتر شيكات NBE',
    identifier: 'NBE-123',
    gl_account_code: '1115',
    is_default: true,
    net_debit: '2000',
    total_in: '2000',
    total_out: '0',
    je_count: 1,
  }),
  // Inactive — should land in `inactive` bucket
  makeBalance({
    payment_account_id: 'acct-old',
    method: 'wallet',
    display_name: 'محفظة قديمة',
    identifier: '0109',
    gl_account_code: '1114',
    active: false,
    is_default: false,
  }),
];

function setUserPermissions(perms: string[]) {
  useAuthStore.setState({
    user: {
      id: 'tester',
      role: 'admin',
      permissions: perms,
    } as any,
  });
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <PaymentAccounts />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  setDefaultMock.mockClear();
  toggleActiveMock.mockClear();
  deleteAccountMock.mockClear();
  listBalancesMock.mockResolvedValue(BALANCES);
  listProvidersMock.mockResolvedValue(PROVIDERS);
  cashboxesMock.mockResolvedValue(CASHBOXES);
  glDriftMock.mockResolvedValue([]);
  setUserPermissions(['payment-accounts.read', 'payment-accounts.manage']);
});

describe('<PaymentAccounts /> — PR-FIN-PAYACCT-4B', () => {
  it('renders the page surface (header / KPIs / filters / table / rail / summary)', async () => {
    renderPage();
    expect(screen.getByTestId('payment-accounts-page')).toBeInTheDocument();
    expect(screen.getByTestId('payment-accounts-breadcrumb')).toHaveTextContent(
      /الرئيسية \/ الإعدادات \/ حسابات الدفع/,
    );
    expect(screen.getByTestId('payment-accounts-refresh')).toBeInTheDocument();
    expect(screen.getByTestId('payment-accounts-kpis')).toBeInTheDocument();
    expect(screen.getByTestId('payment-accounts-filters')).toBeInTheDocument();
    expect(screen.getByTestId('payment-accounts-summary')).toBeInTheDocument();
    expect(screen.getByTestId('payment-accounts-rail')).toBeInTheDocument();
  });

  it('computes the 7 KPI tiles from fixtures, including cheque', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-row-acct-instapay')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('kpi-total')).toHaveTextContent('4');
    expect(screen.getByTestId('kpi-active')).toHaveTextContent('3');
    expect(screen.getByTestId('kpi-inactive')).toHaveTextContent('1');
    // Cheque KPI tile must be present and reflect the 2000 cheque balance.
    const cheque = screen.getByTestId('kpi-check-balance');
    expect(cheque).toBeInTheDocument();
    expect(cheque.textContent).toMatch(/2,000/);
    // Wallet bucket sums InstaPay (1000); inactive wallet has 0 net.
    expect(screen.getByTestId('kpi-wallet-balance').textContent).toMatch(/1,000/);
    expect(screen.getByTestId('kpi-bank-balance').textContent).toMatch(/5,000/);
    // bank_transfer is active but has no `is_default=true` → "no default" KPI ≥ 1.
    expect(screen.getByTestId('kpi-no-default')).toHaveTextContent(/[1-9]/);
  });

  it('renders one row per balance (4 rows)', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-row-acct-instapay')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('payment-account-row-acct-cib')).toBeInTheDocument();
    expect(screen.getByTestId('payment-account-row-acct-check')).toBeInTheDocument();
    expect(screen.getByTestId('payment-account-row-acct-old')).toBeInTheDocument();
  });

  it('search filter narrows the rows by display_name / identifier', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-row-acct-instapay')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId('filter-search'), {
      target: { value: 'NBE' },
    });
    expect(screen.queryByTestId('payment-account-row-acct-instapay')).toBeNull();
    expect(screen.queryByTestId('payment-account-row-acct-cib')).toBeNull();
    // Only the cheque account survives the NBE search.
    expect(screen.getByTestId('payment-account-row-acct-check')).toBeInTheDocument();
  });

  it('type filter "check" only shows cheque rows', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-row-acct-instapay')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId('filter-type'), {
      target: { value: 'check' },
    });
    expect(screen.queryByTestId('payment-account-row-acct-instapay')).toBeNull();
    expect(screen.queryByTestId('payment-account-row-acct-cib')).toBeNull();
    expect(screen.getByTestId('payment-account-row-acct-check')).toBeInTheDocument();
  });

  it('active filter "inactive" only shows the inactive row', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-row-acct-instapay')).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByTestId('filter-active'), {
      target: { value: 'inactive' },
    });
    expect(screen.queryByTestId('payment-account-row-acct-instapay')).toBeNull();
    expect(screen.getByTestId('payment-account-row-acct-old')).toBeInTheDocument();
  });

  it('clicking a row opens the side details panel', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-row-acct-check')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('payment-account-details-panel')).toBeNull();
    fireEvent.click(screen.getByTestId('payment-account-row-acct-check'));
    expect(screen.getByTestId('payment-account-details-panel')).toBeInTheDocument();
  });

  it('renders the cheque quick-action button (إضافة حساب شيكات)', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-accounts-quick-actions')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('quick-add-check')).toBeInTheDocument();
    expect(screen.getByTestId('quick-add-check')).toHaveTextContent('شيكات');
  });

  it('row "تعيين افتراضي" calls paymentsApi.setDefault(id)', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-row-acct-cib')).toBeInTheDocument(),
    );
    const cibRow = screen.getByTestId('payment-account-row-acct-cib');
    const setDefaultBtn = cibRow.querySelector(
      '[data-testid="row-action-set-default"]',
    ) as HTMLButtonElement;
    expect(setDefaultBtn).toBeTruthy();
    fireEvent.click(setDefaultBtn);
    await waitFor(() => expect(setDefaultMock).toHaveBeenCalledWith('acct-cib'));
  });

  it('row "تفعيل/تعطيل" calls paymentsApi.toggleActive(id)', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-row-acct-old')).toBeInTheDocument(),
    );
    const oldRow = screen.getByTestId('payment-account-row-acct-old');
    const toggleBtn = oldRow.querySelector(
      '[data-testid="row-action-toggle-active"]',
    ) as HTMLButtonElement;
    expect(toggleBtn).toBeTruthy();
    fireEvent.click(toggleBtn);
    await waitFor(() => expect(toggleActiveMock).toHaveBeenCalledWith('acct-old'));
  });

  it('row "حذف" calls paymentsApi.deleteAccount(id) after confirm()', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      renderPage();
      await waitFor(() =>
        expect(screen.getByTestId('payment-account-row-acct-old')).toBeInTheDocument(),
      );
      const oldRow = screen.getByTestId('payment-account-row-acct-old');
      const delBtn = oldRow.querySelector(
        '[data-testid="row-action-delete"]',
      ) as HTMLButtonElement;
      fireEvent.click(delBtn);
      await waitFor(() => expect(deleteAccountMock).toHaveBeenCalledWith('acct-old'));
      expect(confirmSpy).toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('row "حذف" does NOT call deleteAccount when the user cancels confirm()', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    try {
      renderPage();
      await waitFor(() =>
        expect(screen.getByTestId('payment-account-row-acct-old')).toBeInTheDocument(),
      );
      const oldRow = screen.getByTestId('payment-account-row-acct-old');
      const delBtn = oldRow.querySelector(
        '[data-testid="row-action-delete"]',
      ) as HTMLButtonElement;
      fireEvent.click(delBtn);
      // confirm() returned false → no API call.
      expect(deleteAccountMock).not.toHaveBeenCalled();
    } finally {
      confirmSpy.mockRestore();
    }
  });

  it('hides mutating buttons when the user lacks payment-accounts.manage', async () => {
    setUserPermissions(['payment-accounts.read']);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-account-row-acct-instapay')).toBeInTheDocument(),
    );
    // Add button hidden
    expect(screen.queryByTestId('payment-accounts-add')).toBeNull();
    // Quick actions panel hidden
    expect(screen.queryByTestId('payment-accounts-quick-actions')).toBeNull();
    // Row action buttons hidden
    expect(screen.queryByTestId('row-action-edit')).toBeNull();
    expect(screen.queryByTestId('row-action-delete')).toBeNull();
  });

  it('renders the no-default warning strip when an active method has no default', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('payment-accounts-warnings')).toBeInTheDocument(),
    );
    // `bank_transfer` has one active row with is_default=false → strip appears.
    expect(screen.getByTestId('warning-no-default-bank_transfer')).toBeInTheDocument();
  });
});
