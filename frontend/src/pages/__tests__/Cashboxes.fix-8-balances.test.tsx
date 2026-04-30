/**
 * Cashboxes.fix-8-balances.test.tsx — PR-FIN-PAYACCT-4D-UX-FIX-8
 *
 * Pins two production-grade behaviors on /cashboxes:
 *
 *   1. Wallet KPI tile MUST sum every wallet/instapay PA, even when
 *      multiple PAs share the same `(gl_account_code, cashbox_id)`
 *      bucket. The legacy dedup-by-(gl|cashbox) silently dropped the
 *      second PA in the production case where InstaPay (gl=1114,
 *      cashbox=null) and WE Pay (gl=1114, cashbox=null) shared the
 *      key `"1114|null"`.
 *
 *   2. Synthetic "unattached" rows (sentinel id `unattached:<method>`)
 *      from the FIX-8 backend listBalances UNION render with the
 *      "غير مرتبط" badge and have NO edit / delete / set-default /
 *      view-details actions — they aren't real payment_accounts.
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
  { provider_key: 'we_pay', method: 'wallet', name_ar: 'WE Pay', name_en: 'WE Pay',
    icon_name: 'wallet', logo_key: 'we_pay', default_gl_account_code: '1114', group: 'wallet', requires_reference: true },
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

describe('/cashboxes wallet KPI — PR-FIN-PAYACCT-4D-UX-FIX-8', () => {
  it('sums InstaPay + WE Pay even when both share the same (gl=1114, cashbox=null) bucket', async () => {
    // Production repro: two wallet/instapay accounts on the same GL
    // bucket with no cashbox link. The legacy dedup-by-(gl|cashbox)
    // collapsed them and only one was counted; the wallet KPI was
    // short by ~295 EGP. After FIX-8 the per-account sum runs straight.
    balancesMock.mockResolvedValue([
      makeBalance({
        payment_account_id: 'pa-instapay', method: 'instapay', provider_key: 'instapay',
        display_name: 'InstaPay', identifier: '01004888879',
        gl_account_code: '1114', cashbox_id: null, net_debit: '345',
      }),
      makeBalance({
        payment_account_id: 'pa-wepay', method: 'wallet', provider_key: 'we_pay',
        display_name: 'WE Pay', identifier: '01004888879',
        gl_account_code: '1114', cashbox_id: null, net_debit: '295',
      }),
    ]);
    renderPage();
    const tile = await screen.findByTestId('kpi-wallet-balance');
    // 345 + 295 = 640. The legacy bug would have shown 345 (or 295,
    // whichever PA Map iteration hit first). Either single-PA value
    // failing the assertion is the regression.
    await waitFor(() => {
      expect(within(tile).getByText(/640/)).toBeInTheDocument();
    });
  });
});

describe('/cashboxes synthetic unattached rows — PR-FIN-PAYACCT-4D-UX-FIX-8', () => {
  it('renders synthetic unattached row with "غير مرتبط" badge + no edit/delete/set-default actions', async () => {
    balancesMock.mockResolvedValue([
      makeBalance({
        payment_account_id: 'pa-real-instapay', method: 'instapay', provider_key: 'instapay',
        display_name: 'InstaPay', identifier: '01004888879',
        net_debit: '345',
      }),
      // FIX-8 synthetic row: 3 historical InstaPay invoice_payments
      // with payment_account_id IS NULL, totalling 1,050 EGP.
      makeBalance({
        payment_account_id: 'unattached:instapay', method: 'instapay', provider_key: null,
        display_name: 'غير مرتبط بحساب دفع', identifier: null,
        gl_account_code: '1114', cashbox_id: null,
        is_default: false, sort_order: -1,
        net_debit: '1050', total_in: '1050',
        is_unattached: true,
      }),
    ]);
    renderPage();
    // The synthetic row uses the unattached-specific testid.
    const row = await screen.findByTestId('payment-account-row-unattached-instapay');
    expect(row).toBeInTheDocument();
    // Badge rendered.
    expect(within(row).getByTestId('row-unattached-badge')).toBeInTheDocument();
    // Net amount visible (the 1,050 EGP).
    expect(within(row).getByText(/1,050/)).toBeInTheDocument();
    // No actionable buttons on the synthetic row.
    expect(within(row).queryByTestId('row-action-view-details')).toBeNull();
    expect(within(row).queryByTestId('row-action-edit')).toBeNull();
    expect(within(row).queryByTestId('row-action-set-default')).toBeNull();
    expect(within(row).queryByTestId('row-action-toggle-active')).toBeNull();
    expect(within(row).queryByTestId('row-action-delete')).toBeNull();
    // Inert placeholder testid present.
    expect(within(row).getByTestId('row-action-unattached')).toBeInTheDocument();

    // Sanity: the real InstaPay row above DOES have edit + view-details.
    const realRow = screen.getByTestId('payment-account-row-pa-real-instapay');
    expect(within(realRow).getByTestId('row-action-view-details')).toBeInTheDocument();
    expect(within(realRow).getByTestId('row-action-edit')).toBeInTheDocument();
  });

  it('wallet KPI INCLUDES the unattached synthetic total (operator sees the full bucket)', async () => {
    balancesMock.mockResolvedValue([
      makeBalance({
        payment_account_id: 'pa-instapay', method: 'instapay', net_debit: '345',
      }),
      makeBalance({
        payment_account_id: 'pa-wepay', method: 'wallet', net_debit: '295',
      }),
      makeBalance({
        payment_account_id: 'unattached:instapay', method: 'instapay',
        display_name: 'غير مرتبط بحساب دفع',
        is_unattached: true, sort_order: -1, net_debit: '1050',
      }),
    ]);
    renderPage();
    const tile = await screen.findByTestId('kpi-wallet-balance');
    // 345 + 295 + 1050 = 1690 — the operator sees the full wallet
    // bucket including unattached money so they know to act on it.
    await waitFor(() => {
      expect(within(tile).getByText(/1,690/)).toBeInTheDocument();
    });
  });
});
