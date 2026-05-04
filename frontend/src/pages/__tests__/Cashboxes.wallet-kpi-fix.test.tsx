/**
 * Cashboxes.wallet-kpi-fix.test.tsx — PR-AUDIT-EWALLET-PAGE-KPI-FIX
 * ────────────────────────────────────────────────────────────────────
 *
 * Pins the new wallet/bank KPI + GL bucket sub-total source on
 * /cashboxes. Production fixture mirrors the 2026-05-04 audit:
 *
 *   GL 1114 (المحافظ) net = 2,340 EGP across 11 untagged JLs
 *   خزنة التحويلات .current_balance = 0 (structural)
 *                  .accounting_gl_code = '1114'
 *                  .accounting_balance = 2,340 (from the GL roll-up)
 *   Payment accounts:
 *     · InstaPay  (gl=1114, cashbox=cb-ewallet, net_debit=0)
 *     · WE Pay    (gl=1114, cashbox=cb-ewallet, net_debit=0)
 *
 * Pre-PR-AUDIT-EWALLET-PAGE-KPI-FIX the page showed the wallet KPI
 * and the GL 1114 bucket sub-total as 0 EGP because both were sourced
 * from `v_payment_account_balance.net_debit` (which can't allocate
 * untagged GL 1114 lines to either payment account). The treasury
 * card already showed 2,340 (from `accounting_balance`), so the page
 * displayed two contradicting numbers for the same wallet.
 *
 * After this PR:
 *   ✓ KPI tile "أرصدة المحافظ" reads 2,340 (from cashbox accounting_balance)
 *   ✓ Bottom GL bucket "إجمالي المحافظ الإلكترونية 1114" reads 2,340 (same)
 *   ✓ Treasury card for خزنة التحويلات still reads 2,340 (unchanged)
 *   ✓ Per-account InstaPay row still shows 0 EGP (we don't fake per-
 *     account attribution we don't have) PLUS an attribution caption
 *     pointing the operator to the structural cashbox.
 *   ✓ Per-account WE Pay row likewise.
 *
 * No BE / SQL / migration / engine / posting changes. The cashbox
 * `accounting_balance` field already exists.
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

function makeCashbox(over: Partial<Cashbox> = {}): Cashbox {
  const base: Cashbox = {
    id: 'cb-x', name: 'X', name_ar: 'X', warehouse_id: null, currency: 'EGP',
    current_balance: '0', is_active: true, kind: 'cash',
    institution_code: null, institution_name: null, institution_name_en: null,
    institution_domain: null, institution_color: null, institution_kind: null,
    bank_branch: null, account_number: null, iban: null, swift_code: null,
    account_holder_name: null, account_manager_name: null, account_manager_phone: null, account_manager_email: null,
    wallet_phone: null, wallet_owner_name: null, check_issuer_name: null, color: null,
  };
  return { ...base, ...over };
}

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

// ─── Production fixture (2026-05-04 baseline) ─────────────────────
function setProdFixture() {
  cashboxesMock.mockResolvedValue([
    makeCashbox({
      id: 'cb-cash',
      name_ar: 'الخزينة الرئيسية',
      kind: 'cash',
      current_balance: '32240.00',
    }),
    makeCashbox({
      id: 'cb-ewallet',
      name_ar: 'خزنة التحويلات',
      kind: 'ewallet',
      current_balance: '0',
      accounting_gl_code: '1114',
      accounting_balance: '2340.00',
    } as any),
  ]);
  balancesMock.mockResolvedValue([
    makeBalance({
      payment_account_id: 'pa-instapay', method: 'instapay', provider_key: 'instapay',
      display_name: 'InstaPay', identifier: '01004888879',
      gl_account_code: '1114', cashbox_id: 'cb-ewallet',
      net_debit: '0', total_in: '0', total_out: '0', je_count: 0, is_default: true,
    }),
    makeBalance({
      payment_account_id: 'pa-wepay', method: 'wallet', provider_key: 'we_pay',
      display_name: 'WE Pay', identifier: '01004888879',
      gl_account_code: '1114', cashbox_id: 'cb-ewallet',
      net_debit: '0', total_in: '0', total_out: '0', je_count: 0, is_default: true,
    }),
  ]);
}

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
  setProdFixture();
  movementsMock.mockResolvedValue([]);
  glDriftMock.mockResolvedValue([]);
  providersMock.mockResolvedValue(PROVIDERS);
  methodMixMock.mockResolvedValue(METHOD_MIX);
});

describe('Cashboxes wallet KPI — PR-AUDIT-EWALLET-PAGE-KPI-FIX (production fixture)', () => {
  it('KPI tile "أرصدة المحافظ" shows 2,340 (sourced from ewallet cashbox accounting_balance, NOT the broken per-account view)', async () => {
    renderPage();
    const tile = await screen.findByTestId('kpi-wallet-balance');
    // 2,340 from cashbox.accounting_balance — pre-fix this was 0
    // because both InstaPay and WE Pay net_debit are 0.
    await waitFor(() => {
      expect(within(tile).getByText(/2,340/)).toBeInTheDocument();
    });
    // The pre-fix bug value MUST NOT appear.
    expect(within(tile).queryByText(/^0$/)).toBeNull();
  });

  it('bank KPI also uses the cashbox accounting_balance source (symmetry)', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({ id: 'cb-cash', name_ar: 'الرئيسية', kind: 'cash', current_balance: '32240' }),
      makeCashbox({
        id: 'cb-bank', name_ar: 'حساب POS Visa', kind: 'bank', current_balance: '0',
        accounting_gl_code: '1113', accounting_balance: '4500.00',
      } as any),
    ]);
    balancesMock.mockResolvedValue([
      makeBalance({
        payment_account_id: 'pa-visa', method: 'card_visa', provider_key: 'card_visa',
        display_name: 'POS Visa', gl_account_code: '1113', cashbox_id: 'cb-bank',
        net_debit: '0', // per-account view also returns 0 for bank
      }),
    ]);
    renderPage();
    const tile = await screen.findByTestId('kpi-bank-balance');
    await waitFor(() => {
      expect(within(tile).getByText(/4,500/)).toBeInTheDocument();
    });
  });
});

describe('Cashboxes SummaryBalanceCard GL bucket sub-totals — PR-AUDIT-EWALLET-PAGE-KPI-FIX', () => {
  it('"إجمالي المحافظ الإلكترونية 1114" shows 2,340 (sourced from cashbox.accounting_balance)', async () => {
    renderPage();
    const buckets = await screen.findByTestId('summary-gl-buckets');
    // The label is preserved; only the source changed.
    expect(within(buckets).getByText(/إجمالي المحافظ الإلكترونية 1114/)).toBeInTheDocument();
    // The displayed value comes from cashbox.accounting_balance for
    // the ewallet kind, not from sum(balances.net_debit).
    expect(buckets.textContent).toMatch(/2,340/);
  });

  it('treasury card 2,340 + KPI 2,340 + GL 1114 sub-total 2,340 are mutually consistent (no contradiction)', async () => {
    renderPage();
    // Treasury card for خزنة التحويلات.
    const card = await screen.findByTestId('treasury-cashbox-card-cb-ewallet');
    expect(card.textContent).toMatch(/2,340/);
    // KPI tile.
    const kpi = screen.getByTestId('kpi-wallet-balance');
    expect(kpi.textContent).toMatch(/2,340/);
    // GL 1114 sub-total.
    const buckets = await screen.findByTestId('summary-gl-buckets');
    expect(buckets.textContent).toMatch(/2,340/);
    // Defensive: refuse the pre-fix bug value of 0 in any of the 3 surfaces
    // (the treasury card was already correct, but KPI + sub-total used to read 0).
    expect(kpi.textContent).not.toMatch(/^[^\d]*0[^\d]*$/);
  });
});

describe('Cashboxes per-account row — PR-AUDIT-EWALLET-PAGE-KPI-FIX attribution caption', () => {
  it('InstaPay row keeps its per-account 0 EGP AND adds an attribution caption pointing to خزنة التحويلات', async () => {
    renderPage();
    const row = await screen.findByTestId('payment-account-row-pa-instapay');
    // The per-account net_debit cell still reads 0 — we don't fake
    // per-account attribution we don't have.
    expect(within(row).getByTestId('payment-account-row-net-debit-pa-instapay').textContent).toMatch(/0/);
    // The attribution caption surfaces, pointing to the structural cashbox.
    const caption = within(row).getByTestId('payment-account-row-attribution-pa-instapay');
    expect(caption.textContent).toMatch(/حركات GL 1114 غير منسوبة لحساب محدد/);
    expect(caption.textContent).toMatch(/خزنة التحويلات/);
  });

  it('WE Pay row likewise carries the attribution caption', async () => {
    renderPage();
    const row = await screen.findByTestId('payment-account-row-pa-wepay');
    expect(within(row).getByTestId('payment-account-row-net-debit-pa-wepay').textContent).toMatch(/0/);
    const caption = within(row).getByTestId('payment-account-row-attribution-pa-wepay');
    expect(caption.textContent).toMatch(/حركات GL 1114 غير منسوبة لحساب محدد/);
    expect(caption.textContent).toMatch(/خزنة التحويلات/);
  });

  it('payment account with non-zero net_debit does NOT show the attribution caption (no false positive)', async () => {
    balancesMock.mockResolvedValue([
      makeBalance({
        payment_account_id: 'pa-instapay-real', method: 'instapay', provider_key: 'instapay',
        display_name: 'InstaPay مع حركات', gl_account_code: '1114',
        cashbox_id: 'cb-ewallet',
        net_debit: '500', // genuine per-account attribution
      }),
    ]);
    renderPage();
    const row = await screen.findByTestId('payment-account-row-pa-instapay-real');
    expect(within(row).getByTestId('payment-account-row-net-debit-pa-instapay-real').textContent).toMatch(/500/);
    expect(within(row).queryByTestId('payment-account-row-attribution-pa-instapay-real')).toBeNull();
  });

  it('payment account with no linked cashbox accounting balance does NOT show the caption (avoids "look at empty cashbox")', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({
        id: 'cb-ewallet-empty', name_ar: 'خزنة التحويلات', kind: 'ewallet',
        accounting_gl_code: '1114', accounting_balance: '0',
      } as any),
    ]);
    balancesMock.mockResolvedValue([
      makeBalance({
        payment_account_id: 'pa-instapay-zero', method: 'instapay', provider_key: 'instapay',
        display_name: 'InstaPay فارغ', gl_account_code: '1114',
        cashbox_id: 'cb-ewallet-empty',
        net_debit: '0',
      }),
    ]);
    renderPage();
    const row = await screen.findByTestId('payment-account-row-pa-instapay-zero');
    expect(within(row).getByTestId('payment-account-row-net-debit-pa-instapay-zero').textContent).toMatch(/0/);
    // Linked cashbox accounting_balance is 0 → no point pointing the
    // operator there. Caption must NOT render.
    expect(within(row).queryByTestId('payment-account-row-attribution-pa-instapay-zero')).toBeNull();
  });
});
