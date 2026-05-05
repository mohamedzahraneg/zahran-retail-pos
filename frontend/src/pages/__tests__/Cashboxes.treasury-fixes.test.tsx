/**
 * Cashboxes.treasury-fixes.test.tsx
 * PR-FIN-CASHBOXES-TREASURY-GRID-FIXES
 *
 * Page-level pins for the user-reported issues:
 *
 *   FIX 1 — when the cash-desk endpoint ships `accounting_balance`,
 *   the ewallet treasury card displays it (NOT the misleading 0
 *   from `current_balance`). Cash card unchanged.
 *
 *   FIX 3 — clicking a linked PA from inside CashboxDetailsModal
 *   closes the cashbox modal first, then opens the
 *   PaymentAccountDetailsPanel — so the operator sees the wallet
 *   details immediately instead of buried behind another modal.
 *
 *   No-DB-mutation pin: rebuild + drift-cleanup endpoints are NEVER
 *   invoked from any of these flows.
 *
 * Locks the regression: anyone reverting the treasury card to
 * `current_balance` for non-cash, or stacking both modals at the
 * same z-index, fails CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import type {
  PaymentAccountBalance, PaymentMethodMixRow, PaymentProvider,
} from '@/api/payments.api';
import type { Cashbox } from '@/api/cash-desk.api';

const mocks = vi.hoisted(() => ({
  cashboxesMock:               vi.fn(),
  movementsMock:               vi.fn(),
  glDriftMock:                 vi.fn(),
  balancesMock:                vi.fn(),
  providersMock:               vi.fn(),
  methodMixMock:               vi.fn(),
  cashboxMovementsUnifiedMock: vi.fn(),
  transferMock:                vi.fn(async () => ({})),
  updateCashboxMock:           vi.fn(async () => ({})),
  createCashboxMock:           vi.fn(async () => ({})),
  removeCashboxMock:           vi.fn(async () => ({})),
  institutionsMock:            vi.fn(async () => []),
  rebuildCashboxBalanceMock:   vi.fn(async () => ({})),
  driftCleanupPreviewMock:     vi.fn(async () => ({})),
  driftCleanupExecuteMock:     vi.fn(async () => ({})),
  movementsForAcctMock:        vi.fn(),
}));

vi.mock('@/api/cash-desk.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    cashDeskApi: {
      cashboxes:               () => mocks.cashboxesMock(),
      movements:        (p: any) => mocks.movementsMock(p),
      glDrift:                 () => mocks.glDriftMock(),
      cashboxMovementsUnified: (id: string, p: any) => mocks.cashboxMovementsUnifiedMock(id, p),
      transfer:                mocks.transferMock,
      updateCashbox:           mocks.updateCashboxMock,
      createCashbox:           mocks.createCashboxMock,
      removeCashbox:           mocks.removeCashboxMock,
      institutions:            mocks.institutionsMock,
    },
  };
});

vi.mock('@/api/payments.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    paymentsApi: {
      listProviders: () => mocks.providersMock(),
      listBalances:  () => mocks.balancesMock(),
      methodMix:     () => mocks.methodMixMock(),
      movements:     (id: string, f: any) => mocks.movementsForAcctMock(id, f),
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
      ...((actual as any).accountsApi ?? {}),
      rebuildCashboxBalance:   mocks.rebuildCashboxBalanceMock,
      driftCleanupPreview:     mocks.driftCleanupPreviewMock,
      driftCleanupExecute:     mocks.driftCleanupExecuteMock,
    },
  };
});

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return { default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }) };
});

import Cashboxes from '../Cashboxes';

const {
  cashboxesMock, movementsMock, glDriftMock, balancesMock, providersMock,
  methodMixMock, cashboxMovementsUnifiedMock,
  rebuildCashboxBalanceMock, driftCleanupPreviewMock, driftCleanupExecuteMock,
  movementsForAcctMock,
} = mocks;

function makeCashbox(over: Partial<Cashbox> = {}): Cashbox {
  return {
    id: 'cb-x', name: 'X', name_ar: 'X', warehouse_id: null, currency: 'EGP',
    current_balance: '0', is_active: true, kind: 'cash',
    institution_code: null, institution_name: null, institution_name_en: null,
    institution_domain: null, institution_color: null, institution_kind: null,
    bank_branch: null, account_number: null, iban: null, swift_code: null,
    account_holder_name: null, account_manager_name: null,
    account_manager_phone: null, account_manager_email: null,
    wallet_phone: null, wallet_owner_name: null, check_issuer_name: null, color: null,
    ...over,
  };
}

function makeBalance(over: Partial<PaymentAccountBalance>): PaymentAccountBalance {
  return {
    payment_account_id: 'pa-x',
    method: 'instapay', provider_key: 'instapay',
    display_name: 'X', identifier: '0100',
    gl_account_code: '1114', cashbox_id: null,
    is_default: false, active: true, sort_order: 0, metadata: {},
    gl_name_ar: 'محافظ', normal_balance: 'debit',
    total_in: '0', total_out: '0', net_debit: '0', je_count: 0, last_movement: null,
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
];
const METHOD_MIX: PaymentMethodMixRow[] = [];

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
  movementsMock.mockResolvedValue([]);
  glDriftMock.mockResolvedValue([]);
  providersMock.mockResolvedValue(PROVIDERS);
  methodMixMock.mockResolvedValue(METHOD_MIX);
  balancesMock.mockResolvedValue([]);
  cashboxMovementsUnifiedMock.mockResolvedValue({
    rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
  });
  movementsForAcctMock.mockResolvedValue({
    rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
  });
});

// ───────── Fix 1 — treasury card uses cash-desk endpoint's accounting_balance ─────────
describe('/cashboxes treasury card — Fix 1: ewallet receives accounting_balance', () => {
  it('ewallet card shows "رصيد محاسبي من الأستاذ العام" 2,190.00 (not stored 0) when cash-desk ships accounting_balance (PR-AUDIT-LABELS-CASH-VS-GL)', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({
        id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات',
        current_balance: '0',
        accounting_gl_code: '1114', accounting_balance: '2190.00',
      } as any),
    ]);
    renderPage();
    const card = await screen.findByTestId('treasury-cashbox-card-cb-ewallet');
    expect(within(card).getByTestId('treasury-cashbox-card-balance-label-cb-ewallet').textContent)
      .toBe('رصيد محاسبي من الأستاذ العام');
    expect(card.textContent).toMatch(/2,190\.00/);
    expect(within(card).getByText('محاسبي')).toBeInTheDocument();
  });

  it('cash card shows "رصيد تشغيلي من حركات الخزنة" + current_balance, no "محاسبي" pill (PR-AUDIT-LABELS-CASH-VS-GL)', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({
        id: 'cb-cash', kind: 'cash', name_ar: 'الخزينة الرئيسية',
        current_balance: '31650',
        accounting_gl_code: null, accounting_balance: null,
      } as any),
    ]);
    renderPage();
    const card = await screen.findByTestId('treasury-cashbox-card-cb-cash');
    expect(within(card).getByTestId('treasury-cashbox-card-balance-label-cb-cash').textContent)
      .toBe('رصيد تشغيلي من حركات الخزنة');
    expect(card.textContent).toMatch(/31,650\.00/);
    expect(within(card).queryByText('محاسبي')).toBeNull();
  });

  it('ewallet card with accounting_balance:null still degrades to current_balance (no crash)', async () => {
    // Pre-deploy / older BE that hasn't shipped accounting columns yet —
    // FE helper falls back gracefully; card label keeps the accounting
    // phrasing (because cashbox.kind is 'ewallet'), and the amount is
    // the stored 0 figure. No crash, no "محاسبي" pill (helper returned
    // kind='cash' fallback for missing accounting columns).
    cashboxesMock.mockResolvedValue([
      makeCashbox({
        id: 'cb-old', kind: 'ewallet', name_ar: 'خزنة قديمة',
        current_balance: '0',
        accounting_gl_code: null, accounting_balance: null,
      } as any),
    ]);
    renderPage();
    const card = await screen.findByTestId('treasury-cashbox-card-cb-old');
    expect(card).toBeInTheDocument();
    expect(within(card).getByTestId('treasury-cashbox-card-balance-label-cb-old').textContent)
      .toBe('رصيد محاسبي من الأستاذ العام');
    expect(within(card).queryByText('محاسبي')).toBeNull();
  });
});

// ───────── Fix 3 — clicking linked PA closes cashbox modal, opens account modal in front ─────────
describe('/cashboxes Fix 3 — linked PA opens in front (cashbox modal closes first)', () => {
  it('clicking a linked PA inside CashboxDetailsModal closes the cashbox modal AND opens the account modal', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({
        id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات',
        accounting_gl_code: '1114', accounting_balance: '2190.00',
      } as any),
    ]);
    balancesMock.mockResolvedValue([
      makeBalance({
        payment_account_id: 'pa-instapay', display_name: 'InstaPay',
        method: 'instapay', cashbox_id: 'cb-ewallet', net_debit: '1895.00',
      }),
      makeBalance({
        payment_account_id: 'pa-we', display_name: 'WE Pay', provider_key: 'we_pay',
        method: 'wallet', cashbox_id: 'cb-ewallet', net_debit: '295.00',
      }),
    ]);
    renderPage();

    // 1. Open the cashbox details modal from the treasury card.
    fireEvent.click(await screen.findByTestId('treasury-cashbox-card-cb-ewallet'));
    await waitFor(() =>
      expect(screen.getByTestId('cashbox-details-modal')).toBeInTheDocument(),
    );
    // The account modal must NOT be open yet.
    expect(screen.queryByTestId('payment-account-details-modal')).toBeNull();

    // 2. Click the linked InstaPay row.
    const instapayRow = await screen.findByTestId('cashbox-linked-account-pa-instapay');
    fireEvent.click(instapayRow);

    // 3. Cashbox modal CLOSES (the regression bug was: it stayed open
    //    on top of the new modal, hiding it).
    await waitFor(() =>
      expect(screen.queryByTestId('cashbox-details-modal')).toBeNull(),
    );
    // 4. PaymentAccountDetailsPanel opens for that PA id (visible).
    const acctModal = await screen.findByTestId('payment-account-details-modal');
    expect(acctModal).toBeInTheDocument();
    expect(acctModal.textContent).toMatch(/InstaPay/);
  });

  it('clicking WE Pay does the same — the close-then-open contract is per-PA', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({
        id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات',
        accounting_gl_code: '1114', accounting_balance: '2190.00',
      } as any),
    ]);
    balancesMock.mockResolvedValue([
      makeBalance({
        payment_account_id: 'pa-we', display_name: 'WE Pay', provider_key: 'we_pay',
        method: 'wallet', cashbox_id: 'cb-ewallet', net_debit: '295.00',
      }),
    ]);
    renderPage();
    fireEvent.click(await screen.findByTestId('treasury-cashbox-card-cb-ewallet'));
    await screen.findByTestId('cashbox-details-modal');
    fireEvent.click(await screen.findByTestId('cashbox-linked-account-pa-we'));
    await waitFor(() =>
      expect(screen.queryByTestId('cashbox-details-modal')).toBeNull(),
    );
    const acctModal = await screen.findByTestId('payment-account-details-modal');
    expect(acctModal.textContent).toMatch(/WE Pay/);
  });
});

// ───────── Safety — no rebuild / drift-cleanup / DB mutations from any flow above ─────────
describe('/cashboxes Fix 1+3 safety — no DB mutation endpoints called', () => {
  it('opening the cashbox modal + clicking a linked PA never invokes rebuild / drift-cleanup', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({
        id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات',
        accounting_gl_code: '1114', accounting_balance: '2190.00',
      } as any),
    ]);
    balancesMock.mockResolvedValue([
      makeBalance({
        payment_account_id: 'pa-instapay', display_name: 'InstaPay',
        method: 'instapay', cashbox_id: 'cb-ewallet', net_debit: '1895.00',
      }),
    ]);
    renderPage();
    fireEvent.click(await screen.findByTestId('treasury-cashbox-card-cb-ewallet'));
    await screen.findByTestId('cashbox-details-modal');
    fireEvent.click(await screen.findByTestId('cashbox-linked-account-pa-instapay'));
    await screen.findByTestId('payment-account-details-modal');
    expect(rebuildCashboxBalanceMock).not.toHaveBeenCalled();
    expect(driftCleanupPreviewMock).not.toHaveBeenCalled();
    expect(driftCleanupExecuteMock).not.toHaveBeenCalled();
  });
});
