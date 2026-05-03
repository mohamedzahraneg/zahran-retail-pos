/**
 * Cashboxes.treasury-cleanup.test.tsx
 * PR-FIN-CASHBOXES-TREASURY-CLEANUP
 *
 * Pins the layout cleanup that retires maintenance/debug surfaces
 * from the daily-use treasury page and replaces the side-rail
 * quick-actions card with a header-level dropdown:
 *
 *   ✓ "إعادة بناء رصيد الخزنة" button is GONE from /cashboxes
 *     (its endpoint stays on the BE for ad-hoc diagnostic use)
 *   ✓ "معاينة تنظيف فروقات الخزنة" button is GONE
 *   ✓ "سجل تاريخي للعمليات القديمة" panel
 *     (UnattachedReconciliationPanel) is GONE
 *   ✓ Side rail (`treasury-rail`) + side-rail quick-actions card
 *     (`treasury-quick-actions`) are GONE
 *   ✓ Header-level "إجراءات سريعة" dropdown button renders + opens
 *     a menu of the 5 payment-account create shortcuts
 *   ✓ Each dropdown item triggers the same PaymentAccountModal flow
 *     as the old side-rail card
 *   ✓ Dropdown closes after item click
 *   ✓ Dropdown closes on outside click
 *   ✓ Dropdown closes on Escape
 *   ✓ <PaymentAccountAlerts/> ("تنبيهات محاسبية") renders in the
 *     main column, not in a side rail
 *   ✓ No rebuild / drift-cleanup endpoint is called by anything on
 *     the page
 *   ✓ Cashbox grid + payment-accounts table + cashbox-details modal
 *     all still work
 *
 * Locks the regression: anyone restoring the maintenance buttons,
 * the historical panel, or the side rail without a deliberate
 * decision fails CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth.store';
import type {
  PaymentAccountBalance, PaymentMethodMixRow, PaymentProvider,
} from '@/api/payments.api';
import type { Cashbox } from '@/api/cash-desk.api';
import type React from 'react';

const mocks = vi.hoisted(() => ({
  cashboxesMock:               vi.fn(),
  movementsMock:               vi.fn(),
  glDriftMock:                 vi.fn(),
  balancesMock:                vi.fn(),
  providersMock:               vi.fn(),
  methodMixMock:               vi.fn(),
  cashboxMovementsUnifiedMock: vi.fn(),
  rebuildCashboxBalanceMock:   vi.fn(async () => ({})),
  driftCleanupPreviewMock:     vi.fn(async () => ({})),
  driftCleanupExecuteMock:     vi.fn(async () => ({})),
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
      listProviders: () => mocks.providersMock(),
      listBalances:  () => mocks.balancesMock(),
      methodMix:     () => mocks.methodMixMock(),
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
} = mocks;

function makeCashbox(over: Partial<Cashbox> = {}): Cashbox {
  return {
    id: 'cb-cash', name: 'الخزينة الرئيسية', name_ar: 'الخزينة الرئيسية',
    warehouse_id: null, currency: 'EGP', current_balance: '31650', is_active: true,
    kind: 'cash',
    institution_code: null, institution_name: null, institution_name_en: null,
    institution_domain: null, institution_color: null, institution_kind: null,
    bank_branch: null, account_number: null, iban: null, swift_code: null,
    account_holder_name: null, account_manager_name: null,
    account_manager_phone: null, account_manager_email: null,
    wallet_phone: null, wallet_owner_name: null, check_issuer_name: null, color: null,
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
const METHOD_MIX: PaymentMethodMixRow[] = [];
const BALANCES: PaymentAccountBalance[] = [];

function setAdmin() {
  // Includes accounts.journal.post — the gate that historically would
  // have unlocked the rebuild + drift-cleanup buttons. They must STILL
  // be absent.
  useAuthStore.setState({
    user: { id: 't', role: 'admin', permissions: ['*', 'accounts.journal.post'] } as any,
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
  vi.clearAllMocks();
  setAdmin();
  cashboxesMock.mockResolvedValue([makeCashbox()]);
  movementsMock.mockResolvedValue([]);
  glDriftMock.mockResolvedValue([]);
  providersMock.mockResolvedValue(PROVIDERS);
  methodMixMock.mockResolvedValue(METHOD_MIX);
  balancesMock.mockResolvedValue(BALANCES);
  cashboxMovementsUnifiedMock.mockResolvedValue({
    rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
  });
});

// ───────────── Removal regressions ────────────────────────────────
describe('/cashboxes treasury cleanup — retired surfaces are GONE', () => {
  it('"إعادة بناء رصيد الخزنة" button is NOT rendered (even with accounts.journal.post)', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-cashboxes-grid')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('treasury-rebuild-main-cashbox-balance')).toBeNull();
    expect(screen.queryByText('إعادة بناء رصيد الخزنة')).toBeNull();
  });

  it('"معاينة تنظيف فروقات الخزنة" button is NOT rendered', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-cashboxes-grid')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('treasury-drift-cleanup-preview')).toBeNull();
    expect(screen.queryByText('معاينة تنظيف فروقات الخزنة')).toBeNull();
  });

  it('"سجل تاريخي للعمليات القديمة" / unattached-panel is NOT rendered', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-cashboxes-grid')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('unattached-panel')).toBeNull();
    expect(screen.queryByText('سجلّ تاريخي للعمليات القديمة')).toBeNull();
    expect(screen.queryByText('عمليات قديمة غير مرتبطة بحساب دفع')).toBeNull();
  });

  it('side rail (treasury-rail) and old quick-actions card (treasury-quick-actions) are GONE', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-cashboxes-grid')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('treasury-rail')).toBeNull();
    expect(screen.queryByTestId('treasury-quick-actions')).toBeNull();
  });

  it('no rebuild / drift-cleanup endpoint is called by anything on the page', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-cashboxes-grid')).toBeInTheDocument(),
    );
    expect(rebuildCashboxBalanceMock).not.toHaveBeenCalled();
    expect(driftCleanupPreviewMock).not.toHaveBeenCalled();
    expect(driftCleanupExecuteMock).not.toHaveBeenCalled();
  });
});

// ───────────── New header dropdown ────────────────────────────────
describe('/cashboxes treasury cleanup — header "إجراءات سريعة" dropdown', () => {
  it('renders a single dropdown button in the page header', async () => {
    renderPage();
    const btn = await screen.findByTestId('treasury-quick-actions-dropdown');
    expect(btn).toBeInTheDocument();
    expect(btn.textContent).toMatch(/إجراءات سريعة/);
    // aria-* contract for screen readers + keyboard.
    expect(btn.getAttribute('aria-haspopup')).toBe('menu');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    // Menu is closed by default.
    expect(screen.queryByTestId('treasury-quick-actions-menu')).toBeNull();
  });

  it('opens a menu with the 5 payment-account create shortcuts on click', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('treasury-quick-actions-dropdown'));
    const menu = await screen.findByTestId('treasury-quick-actions-menu');
    expect(menu.getAttribute('role')).toBe('menu');
    expect(within(menu).getByTestId('quick-add-bank').textContent).toMatch(/إضافة حساب بنكي/);
    expect(within(menu).getByTestId('quick-add-wallet').textContent).toMatch(/إضافة محفظة إلكترونية/);
    expect(within(menu).getByTestId('quick-add-instapay').textContent).toMatch(/إضافة حساب InstaPay/);
    expect(within(menu).getByTestId('quick-add-card').textContent).toMatch(/إضافة جهاز POS \/ بطاقة/);
    expect(within(menu).getByTestId('quick-add-check').textContent).toMatch(/إضافة حساب شيكات/);
    // aria-expanded flips to true while open.
    expect(screen.getByTestId('treasury-quick-actions-dropdown').getAttribute('aria-expanded')).toBe('true');
  });

  it('clicking a menu item opens the PaymentAccountModal pre-filled to that method', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('treasury-quick-actions-dropdown'));
    fireEvent.click(await screen.findByTestId('quick-add-instapay'));
    // Modal opens, method dropdown shows instapay (the create flow's
    // method dropdown is the canonical signal).
    const methodSel = await screen.findByTestId('payment-account-modal-method') as HTMLSelectElement;
    expect(methodSel.value).toBe('instapay');
  });

  it('clicking a menu item closes the dropdown', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('treasury-quick-actions-dropdown'));
    expect(screen.getByTestId('treasury-quick-actions-menu')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('quick-add-bank'));
    await waitFor(() =>
      expect(screen.queryByTestId('treasury-quick-actions-menu')).toBeNull(),
    );
  });

  it('clicking outside the dropdown closes it', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('treasury-quick-actions-dropdown'));
    expect(screen.getByTestId('treasury-quick-actions-menu')).toBeInTheDocument();
    // Mousedown on the page surface (outside the dropdown).
    fireEvent.mouseDown(screen.getByTestId('treasury-page'));
    await waitFor(() =>
      expect(screen.queryByTestId('treasury-quick-actions-menu')).toBeNull(),
    );
  });

  it('Escape key closes the dropdown', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('treasury-quick-actions-dropdown'));
    expect(screen.getByTestId('treasury-quick-actions-menu')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() =>
      expect(screen.queryByTestId('treasury-quick-actions-menu')).toBeNull(),
    );
  });

  it('renders all 5 quick-add shortcuts (regression — must keep parity with the retired side card)', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('treasury-quick-actions-dropdown'));
    expect(screen.getByTestId('quick-add-bank')).toBeInTheDocument();
    expect(screen.getByTestId('quick-add-wallet')).toBeInTheDocument();
    expect(screen.getByTestId('quick-add-instapay')).toBeInTheDocument();
    expect(screen.getByTestId('quick-add-card')).toBeInTheDocument();
    expect(screen.getByTestId('quick-add-check')).toBeInTheDocument();
  });
});

// ───────────── PaymentAccountAlerts moved to main column ──────────
describe('/cashboxes treasury cleanup — accounting alerts in main content', () => {
  it('<PaymentAccountAlerts/> ("تنبيهات محاسبية") renders inside the main treasury area', async () => {
    renderPage();
    const alerts = await screen.findByTestId('payment-account-alerts');
    expect(alerts).toBeInTheDocument();
    // Lives inside the main treasury container, NOT inside a removed
    // side rail.
    expect(screen.getByTestId('treasury-grid').contains(alerts)).toBe(true);
    expect(screen.queryByTestId('treasury-rail')).toBeNull();
  });

  it('alerts header text "تنبيهات محاسبية" is present (component itself unchanged)', async () => {
    renderPage();
    const alerts = await screen.findByTestId('payment-account-alerts');
    expect(within(alerts).getByText('تنبيهات محاسبية')).toBeInTheDocument();
  });
});

// ───────────── Preserved surfaces ─────────────────────────────────
describe('/cashboxes treasury cleanup — preserved surfaces still work', () => {
  it('cashbox grid still renders all active cashboxes', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({ id: 'cb-cash', kind: 'cash', name_ar: 'الخزينة الرئيسية' }),
      makeCashbox({ id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات', accounting_gl_code: '1114', accounting_balance: '2190.00' } as any),
    ]);
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId('treasury-cashboxes-grid')).toBeInTheDocument();
      expect(screen.getByTestId('treasury-cashbox-card-cb-cash')).toBeInTheDocument();
      expect(screen.getByTestId('treasury-cashbox-card-cb-ewallet')).toBeInTheDocument();
    });
  });

  it('refresh button is still present in the header', async () => {
    renderPage();
    expect(await screen.findByTestId('treasury-refresh')).toBeInTheDocument();
  });

  it('clicking a cashbox card still opens the cashbox-details modal', async () => {
    renderPage();
    fireEvent.click(await screen.findByTestId('treasury-cashbox-card-cb-cash'));
    await waitFor(() =>
      expect(screen.getByTestId('cashbox-details-modal')).toBeInTheDocument(),
    );
  });
});
