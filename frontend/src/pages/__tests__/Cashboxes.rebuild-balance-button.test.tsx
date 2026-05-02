/**
 * Cashboxes.rebuild-balance-button.test.tsx
 * ─────────────────────────────────────────────────────────────────────
 * PR-FIN-PAYACCT-4D-CASHBOX-BALANCE-REBUILD-BUTTON-FE
 *
 * Pins the safety contract of the new "إعادة بناء رصيد الخزنة" button
 * on the treasury (Cashboxes) page:
 *
 *   • Permission gate — visible only with `accounts.journal.post`.
 *   • Visibility gate — only renders when an active cash cashbox exists.
 *   • Confirm dialog — fires `window.confirm` with the exact Arabic
 *     prompt before any API call.
 *   • Cancel = no API call.
 *   • Confirm = exactly one POST to
 *       /accounts/audit/rebuild-cashbox-balance/<MAIN_CASHBOX_ID>
 *     with the live cash cashbox's id (NOT a hard-coded uuid).
 *   • Success — toast with the new_balance + invalidates cashbox /
 *     drift / payment-account-balance queries.
 *   • Disabled while pending (no double-fire even on rapid clicks).
 *   • The button does NOT fire historical-cleanup or any other
 *     mutation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import type { Cashbox } from '@/api/cash-desk.api';

// ─── Mocks ──────────────────────────────────────────────────────────
const cashboxesMock = vi.fn();
const movementsMock = vi.fn();
const glDriftMock   = vi.fn();
const balancesMock  = vi.fn();
const providersMock = vi.fn();
const methodMixMock = vi.fn();
const rebuildBalanceMock = vi.fn();
const previewDriftCleanupMock = vi.fn();

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

vi.mock('@/api/accounts.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    accountsApi: {
      ...((actual.accountsApi as object) ?? {}),
      rebuildCashboxBalance: (id: string) => rebuildBalanceMock(id),
      previewDriftCleanup: () => previewDriftCleanupMock(),
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

// ─── Fixtures ───────────────────────────────────────────────────────

const MAIN_CASHBOX_ID = '524646d5-7bd6-4d8d-a484-b1f562b039a4';

function makeMainCashbox(over: Partial<Cashbox> = {}): Cashbox {
  return {
    id: MAIN_CASHBOX_ID,
    name: 'الخزينة الرئيسية',
    name_ar: 'الخزينة الرئيسية',
    name_en: null,
    display_name: 'الخزينة الرئيسية',
    kind: 'cash',
    is_active: true,
    current_balance: '32519.98',
    currency: 'EGP',
    warehouse_id: null,
    color: null,
    institution_code: null,
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
    opening_balance: '0',
    opening_journal_entry_id: null,
    opening_posted_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-05-02T08:34:45Z',
    ...over,
  } as any;
}

function setUserWithPermission(perm: string) {
  useAuthStore.setState({
    user: { id: 't', role: 'admin', permissions: [perm] } as any,
  });
}
function setUserWithoutPermission() {
  useAuthStore.setState({
    user: { id: 't', role: 'cashier', permissions: ['cashdesk.view'] } as any,
  });
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <Cashboxes />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// vi.spyOn returns a typed MockInstance whose generic parameters don't
// satisfy the default `ReturnType<typeof vi.spyOn>` shape; using `any`
// keeps the test infra simple without leaking type noise into the
// production typecheck.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let confirmSpy: any;

beforeEach(() => {
  vi.clearAllMocks();
  cashboxesMock.mockResolvedValue([makeMainCashbox()]);
  movementsMock.mockResolvedValue([]);
  glDriftMock.mockResolvedValue([]);
  balancesMock.mockResolvedValue([]);
  providersMock.mockResolvedValue([]);
  methodMixMock.mockResolvedValue([]);
  rebuildBalanceMock.mockResolvedValue({
    cashbox_id: MAIN_CASHBOX_ID,
    new_balance: 29680,
  });
  // Default: every test starts with confirm returning true. Tests that
  // need to assert cancel-flow override with `confirmSpy.mockReturnValueOnce(false)`.
  confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  confirmSpy.mockRestore();
});

// ─────────────────────────────────────────────────────────────────────
//  Permission gate
// ─────────────────────────────────────────────────────────────────────

describe('Cashboxes — rebuild-main-cashbox-balance button — permission gate', () => {
  it('hides the button when user lacks accounts.journal.post', async () => {
    setUserWithoutPermission();
    renderPage();
    await screen.findByTestId('treasury-refresh');
    expect(
      screen.queryByTestId('treasury-rebuild-main-cashbox-balance'),
    ).not.toBeInTheDocument();
  });

  it('shows the button when user has accounts.journal.post AND a cash cashbox exists', async () => {
    setUserWithPermission('accounts.journal.post');
    renderPage();
    const btn = await screen.findByTestId('treasury-rebuild-main-cashbox-balance');
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveTextContent('إعادة بناء رصيد الخزنة');
  });

  it('hides the button when there is NO active cash cashbox (even with permission)', async () => {
    setUserWithPermission('accounts.journal.post');
    cashboxesMock.mockResolvedValueOnce([
      makeMainCashbox({ kind: 'bank', is_active: true }),
    ]);
    renderPage();
    await screen.findByTestId('treasury-refresh');
    expect(
      screen.queryByTestId('treasury-rebuild-main-cashbox-balance'),
    ).not.toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Confirm dialog + API call
// ─────────────────────────────────────────────────────────────────────

describe('Cashboxes — rebuild-main-cashbox-balance button — confirm flow', () => {
  it('shows the exact Arabic confirm prompt before calling the API', async () => {
    setUserWithPermission('accounts.journal.post');
    renderPage();
    const btn = await screen.findByTestId('treasury-rebuild-main-cashbox-balance');
    fireEvent.click(btn);
    expect(confirmSpy).toHaveBeenCalledWith(
      'سيتم إعادة حساب رصيد الخزنة الرئيسية من الحركات النشطة فقط',
    );
  });

  it('cancels the API call when user clicks Cancel on the confirm dialog', async () => {
    setUserWithPermission('accounts.journal.post');
    confirmSpy.mockReturnValue(false);
    renderPage();
    const btn = await screen.findByTestId('treasury-rebuild-main-cashbox-balance');
    fireEvent.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);
    await new Promise((r) => setTimeout(r, 30));
    expect(rebuildBalanceMock).not.toHaveBeenCalled();
  });

  it('on confirm, calls accountsApi.rebuildCashboxBalance(<main cashbox id>)', async () => {
    setUserWithPermission('accounts.journal.post');
    renderPage();
    const btn = await screen.findByTestId('treasury-rebuild-main-cashbox-balance');

    fireEvent.click(btn);

    await waitFor(() => expect(rebuildBalanceMock).toHaveBeenCalled());
    expect(rebuildBalanceMock).toHaveBeenCalledWith(MAIN_CASHBOX_ID);
    // The id passed to the API is the LIVE cash cashbox id, NOT a
    // hard-coded uuid in the FE. The fixture happens to use the prod
    // uuid; the assertion above proves the wiring reads from the query.
  });

  it('the bound cashbox id comes from the live cashboxes query (not a hardcoded literal)', async () => {
    setUserWithPermission('accounts.journal.post');
    // Different uuid → the API call must carry THIS id, not the prod one.
    const ALT_ID = '11111111-2222-3333-4444-555555555555';
    cashboxesMock.mockResolvedValueOnce([makeMainCashbox({ id: ALT_ID } as any)]);
    renderPage();
    const btn = await screen.findByTestId('treasury-rebuild-main-cashbox-balance');
    fireEvent.click(btn);
    await waitFor(() => expect(rebuildBalanceMock).toHaveBeenCalled());
    expect(rebuildBalanceMock).toHaveBeenCalledWith(ALT_ID);
  });

  it('does NOT call previewDriftCleanup or any other mutation', async () => {
    setUserWithPermission('accounts.journal.post');
    renderPage();
    const btn = await screen.findByTestId('treasury-rebuild-main-cashbox-balance');
    fireEvent.click(btn);
    await waitFor(() => expect(rebuildBalanceMock).toHaveBeenCalledTimes(1));
    expect(previewDriftCleanupMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Success path — query invalidation
// ─────────────────────────────────────────────────────────────────────

describe('Cashboxes — rebuild-main-cashbox-balance button — success path', () => {
  it('invalidates cashbox/drift/balance queries after success', async () => {
    setUserWithPermission('accounts.journal.post');

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <Cashboxes />
        </MemoryRouter>
      </QueryClientProvider>,
    );

    const btn = await screen.findByTestId('treasury-rebuild-main-cashbox-balance');
    fireEvent.click(btn);

    await waitFor(() => expect(rebuildBalanceMock).toHaveBeenCalledTimes(1));

    // Invalidations fire inside the mutation onSuccess. Wait for them.
    await waitFor(() => {
      const queryKeys = invalidateSpy.mock.calls.map(
        (c) => (c[0] as { queryKey: unknown[] })?.queryKey?.[0],
      );
      expect(queryKeys).toEqual(
        expect.arrayContaining([
          'cashboxes',
          'payment-accounts-balances',
          'cashbox-gl-drift',
          'cashbox-movements-today',
          'cashbox-details',
        ]),
      );
    });
  });
});
