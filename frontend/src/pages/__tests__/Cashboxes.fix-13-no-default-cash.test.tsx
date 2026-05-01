/**
 * Cashboxes.fix-13-no-default-cash.test.tsx — PR-FIN-PAYACCT-4D-UX-FIX-13
 *
 * Pins the contract that `cash` is exempt from the "no default
 * payment_account" warning strip and the matching KPI tile on the
 * unified treasury page (/cashboxes).
 *
 * Production background:
 *   The FIX-9 backend listBalances feed injects a synthetic row for
 *   methods that have historical `invoice_payments` with
 *   `payment_account_id IS NULL`. For cash this row carries
 *   `active=true, is_default=false, is_unattached=true`. Pre-FIX-13
 *   the page picked it up and rendered the misleading amber strip
 *     "طريقة كاش لا يوجد لها حساب افتراضي نشط"
 *   even though cash is intentionally cashbox-driven (no
 *   payment_account is created or expected — design decision in
 *   FIX-9). FIX-13 silences the warning and the KPI for cash, while
 *   keeping the warning loud for any other method (instapay,
 *   wallets, bank_transfer, cards, checks).
 *
 * Three behaviors pinned:
 *   1. The synthetic unattached cash bucket alone renders NO
 *      `warning-no-default-cash` and the `kpi-no-default` tile shows 0.
 *   2. A non-cash method without a default still renders its
 *      `warning-no-default-<method>` strip (regression guard).
 *   3. Cash + non-cash mixed: cash silent, instapay still loud.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import type { PaymentAccountBalance, PaymentMethodMixRow, PaymentProvider } from '@/api/payments.api';
import type { Cashbox } from '@/api/cash-desk.api';

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
      cashboxes:               () => cashboxesMock(),
      movements:        (p: any) => movementsMock(p),
      glDrift:                 () => glDriftMock(),
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
      listProviders:       () => providersMock(),
      listBalances:        () => balancesMock(),
      methodMix:           () => methodMixMock(),
      unattachedSummary:   vi.fn(async () => []),
      backfillUnattached:  vi.fn(async () => ({})),
      setDefault:          vi.fn(async () => ({})),
      toggleActive:        vi.fn(async () => ({})),
      deleteAccount:       vi.fn(async () => ({ id: '', mode: 'hard' as const })),
      createAccount:       vi.fn(async () => ({})),
      updateAccount:       vi.fn(async () => ({})),
    },
  };
});

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return { default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }) };
});

import Cashboxes from '../Cashboxes';

function makeBalance(over: Partial<PaymentAccountBalance> = {}): PaymentAccountBalance {
  return {
    payment_account_id: 'pa-x',
    method: 'instapay',
    provider_key: 'instapay',
    display_name: 'X',
    identifier: null,
    gl_account_code: '1114',
    cashbox_id: null,
    is_default: false,
    active: true,
    sort_order: 0,
    metadata: {},
    gl_name_ar: null,
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
  { provider_key: 'instapay', method: 'instapay', name_ar: 'إنستا باي', name_en: 'InstaPay',
    icon_name: 'wallet', logo_key: 'instapay', default_gl_account_code: '1114', group: 'instapay', requires_reference: true },
];
const METHOD_MIX: PaymentMethodMixRow[] = [];
const CASH_BOX: Cashbox = {
  id: 'cb-cash', name: 'الرئيسية', name_ar: 'الرئيسية', warehouse_id: null, currency: 'EGP',
  current_balance: '0', is_active: true, kind: 'cash',
  institution_code: null, institution_name: null, institution_name_en: null,
  institution_domain: null, institution_color: null, institution_kind: null,
  bank_branch: null, account_number: null, iban: null, swift_code: null,
  account_holder_name: null, account_manager_name: null, account_manager_phone: null, account_manager_email: null,
  wallet_phone: null, wallet_owner_name: null, check_issuer_name: null, color: null,
};

function setAdmin() {
  useAuthStore.setState({ user: { id: 't', role: 'admin', permissions: ['*'] } as any });
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
  vi.clearAllMocks();
  setAdmin();
  cashboxesMock.mockResolvedValue([CASH_BOX]);
  movementsMock.mockResolvedValue([]);
  glDriftMock.mockResolvedValue([]);
  providersMock.mockResolvedValue(PROVIDERS);
  methodMixMock.mockResolvedValue(METHOD_MIX);
});

describe('/cashboxes — PR-FIN-PAYACCT-4D-UX-FIX-13 cash exemption from no-default warning', () => {
  it('synthetic unattached cash bucket alone renders NO warning-no-default-cash and kpi-no-default = 0', async () => {
    // Production-shaped fixture: only the FIX-9 synthetic unattached
    // cash row is present (active=true, is_default=false). Pre-FIX-13
    // this would have triggered both the amber strip and incremented
    // the kpi-no-default tile by 1.
    balancesMock.mockResolvedValue([
      makeBalance({
        payment_account_id: 'unattached:cash',
        method: 'cash',
        provider_key: null,
        display_name: 'غير مرتبط بحساب دفع',
        identifier: null,
        gl_account_code: '1110',
        cashbox_id: null,
        is_default: false,
        sort_order: -1,
        net_debit: '35865.01',
        total_in: '35865.01',
        is_unattached: true,
      }),
    ]);
    renderPage();
    // Wait for the page to settle (KPI tile mounts after balances resolve).
    const kpi = await screen.findByTestId('kpi-no-default');
    // KPI tile reads "0" — cash is excluded from the count.
    await waitFor(() => {
      expect(within(kpi).getByText('0')).toBeInTheDocument();
    });
    // Warning strip for cash is silent.
    expect(screen.queryByTestId('warning-no-default-cash')).toBeNull();
  });

  it('non-cash method without a default still triggers warning-no-default-<method> (regression guard)', async () => {
    // Two active InstaPay accounts, neither is default. This is the
    // genuine "missing default" condition that the warning is meant
    // to surface. It must still fire post-FIX-13.
    balancesMock.mockResolvedValue([
      makeBalance({
        payment_account_id: 'pa-ip-1', method: 'instapay',
        display_name: 'InstaPay A', is_default: false,
      }),
      makeBalance({
        payment_account_id: 'pa-ip-2', method: 'instapay',
        display_name: 'InstaPay B', is_default: false,
      }),
    ]);
    renderPage();
    const warning = await screen.findByTestId('warning-no-default-instapay');
    expect(warning).toBeInTheDocument();
    expect(warning.textContent).toMatch(/لا يوجد لها حساب افتراضي/);
  });

  it('cash + non-cash mixed: cash strip silent, instapay strip still loud', async () => {
    balancesMock.mockResolvedValue([
      // Synthetic unattached cash — should be silent post-FIX-13.
      makeBalance({
        payment_account_id: 'unattached:cash', method: 'cash', provider_key: null,
        display_name: 'غير مرتبط بحساب دفع', is_default: false, is_unattached: true,
        net_debit: '35865.01',
      }),
      // Real InstaPay account, active, no default — must still fire.
      makeBalance({
        payment_account_id: 'pa-ip', method: 'instapay',
        display_name: 'InstaPay', is_default: false,
      }),
    ]);
    renderPage();
    // InstaPay warning still rendered.
    const warning = await screen.findByTestId('warning-no-default-instapay');
    expect(warning).toBeInTheDocument();
    // Cash warning never rendered.
    expect(screen.queryByTestId('warning-no-default-cash')).toBeNull();
  });
});
