/**
 * Cashboxes.rebuild-balance-button.test.tsx
 *
 * PR-FIN-CASHBOXES-TREASURY-CLEANUP — the
 * "إعادة بناء رصيد الخزنة" button has been retired from the visible
 * UI on /cashboxes. The 9 specs that used to live here pinned the
 * button's permission gate / confirm flow / disable-while-pending
 * contract — all of that became dead code when the trigger was
 * removed. The backend endpoint
 * (`accountsApi.rebuildCashboxBalance`) is intentionally PRESERVED
 * for future ad-hoc runs from a dedicated diagnostics surface; only
 * the daily-use treasury page no longer surfaces it.
 *
 * This file is now a single regression guard so anyone restoring
 * the button to /cashboxes without a deliberate decision fails CI.
 *
 * The original specs lived at HEAD~ if a future maintainer needs to
 * resurrect them on the diagnostics surface.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import type { Cashbox } from '@/api/cash-desk.api';

const cashboxesMock = vi.fn();
const movementsMock = vi.fn();
const glDriftMock   = vi.fn();
const balancesMock  = vi.fn();
const providersMock = vi.fn();
const methodMixMock = vi.fn();
// Forbidden — must NOT be invoked by anything in /cashboxes.
const rebuildBalanceMock      = vi.fn();
const previewDriftCleanupMock = vi.fn();
const driftCleanupExecuteMock = vi.fn();

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
      rebuildCashboxBalance:   (id: string) => rebuildBalanceMock(id),
      driftCleanupPreview:     () => previewDriftCleanupMock(),
      driftCleanupExecute:     () => driftCleanupExecuteMock(),
    },
  };
});

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return { default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }) };
});

import Cashboxes from '../Cashboxes';

const MAIN_CASHBOX_ID = '524646d5-7bd6-4d8d-a484-b1f562b039a4';

function makeMainCashbox(over: Partial<Cashbox> = {}): Cashbox {
  return {
    id: MAIN_CASHBOX_ID,
    name: 'الخزينة الرئيسية', name_ar: 'الخزينة الرئيسية',
    kind: 'cash', is_active: true,
    current_balance: '32519.98', currency: 'EGP',
    warehouse_id: null, color: null,
    institution_code: null, institution_name: null, institution_name_en: null,
    institution_domain: null, institution_color: null, institution_kind: null,
    bank_branch: null, account_number: null, iban: null, swift_code: null,
    account_holder_name: null, account_manager_name: null,
    account_manager_phone: null, account_manager_email: null,
    wallet_phone: null, wallet_owner_name: null,
    check_issuer_name: null,
    ...over,
  } as any;
}

function setUserWithPermission(perm: string) {
  useAuthStore.setState({
    user: { id: 't', role: 'admin', permissions: [perm] } as any,
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

beforeEach(() => {
  vi.clearAllMocks();
  cashboxesMock.mockResolvedValue([makeMainCashbox()]);
  movementsMock.mockResolvedValue([]);
  glDriftMock.mockResolvedValue([]);
  balancesMock.mockResolvedValue([]);
  providersMock.mockResolvedValue([]);
  methodMixMock.mockResolvedValue([]);
});

describe('Cashboxes — rebuild-main-cashbox-balance is RETIRED from /cashboxes', () => {
  it('button is NOT rendered even with the highest permission', async () => {
    // Grant the gate that historically unlocked the button. The button
    // must STILL be absent from the DOM.
    setUserWithPermission('accounts.journal.post');
    renderPage();
    // Wait for the page to settle on something else that proves the
    // cashboxes load completed.
    await waitFor(() =>
      expect(screen.getByTestId('treasury-cashboxes-grid')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('treasury-rebuild-main-cashbox-balance'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText('إعادة بناء رصيد الخزنة'),
    ).not.toBeInTheDocument();
  });

  it('the page never invokes accountsApi.rebuildCashboxBalance / drift-cleanup', async () => {
    setUserWithPermission('accounts.journal.post');
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-cashboxes-grid')).toBeInTheDocument(),
    );
    expect(rebuildBalanceMock).not.toHaveBeenCalled();
    expect(previewDriftCleanupMock).not.toHaveBeenCalled();
    expect(driftCleanupExecuteMock).not.toHaveBeenCalled();
  });
});
