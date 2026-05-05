/**
 * Cashboxes.treasury-grid.test.tsx — PR-FIN-CASHBOXES-TREASURY-GRID
 *
 * Pins the new responsive cashbox grid that replaces the single
 * cash-only summary tile. The grid:
 *   ✓ renders a card for every active cashbox (any kind)
 *   ✓ a freshly-created cashbox in the API response shows up
 *     automatically — no hardcoded id/name in the page
 *   ✓ cash cards render the explicit "رصيد تشغيلي من حركات الخزنة"
 *     label (PR-AUDIT-LABELS-CASH-VS-GL — Sprint 2 / PR-4) and the
 *     stored `current_balance`
 *   ✓ ewallet/bank/check cards render "رصيد محاسبي من الأستاذ العام"
 *     and the GL-derived `accounting_balance` with the "محاسبي" pill
 *   ✓ inactive cashboxes are excluded
 *   ✓ sort: cash first, then ewallet/bank/check, then name_ar
 *   ✓ clicking the card body OR the "عرض التفاصيل" button opens the
 *     same `cashbox-details-modal` for that cashbox id
 *   ✓ no rebuild / no drift-cleanup endpoint is touched by the grid
 *   ✓ empty state when no active cashboxes exist
 *
 * Locks the regression: anyone reverting to the cash-only tile or
 * hardcoding ids fails CI.
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

// vi.hoisted lifts these spies above the vi.mock factories so the
// factory closures can capture them at evaluation time (vi.mock is
// hoisted to the top of the file).
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
  // Forbidden in this PR — must NOT be invoked by anything in the grid.
  rebuildCashboxBalanceMock:   vi.fn(async () => ({})),
  driftCleanupPreviewMock:     vi.fn(async () => ({})),
  driftCleanupExecuteMock:     vi.fn(async () => ({})),
}));

vi.mock('@/api/cash-desk.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    cashDeskApi: {
      cashboxes:     () => mocks.cashboxesMock(),
      movements: (p: any) => mocks.movementsMock(p),
      glDrift:       () => mocks.glDriftMock(),
      cashboxMovementsUnified: (p: any) => mocks.cashboxMovementsUnifiedMock(p),
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
      // Sanctioned drawer-rebuild path — pinned to NOT be invoked by
      // the grid. The grid is read-only display.
      rebuildCashboxBalance:   mocks.rebuildCashboxBalanceMock,
      driftCleanupPreview:     mocks.driftCleanupPreviewMock,
      driftCleanupExecute:     mocks.driftCleanupExecuteMock,
    },
  };
});

// Local aliases so the test bodies stay readable.
const {
  cashboxesMock, movementsMock, glDriftMock, balancesMock, providersMock,
  methodMixMock, cashboxMovementsUnifiedMock, transferMock, updateCashboxMock,
  createCashboxMock, removeCashboxMock, rebuildCashboxBalanceMock,
  driftCleanupPreviewMock, driftCleanupExecuteMock,
} = mocks;

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return { default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }) };
});

import Cashboxes from '../Cashboxes';

// ─── Fixtures ────────────────────────────────────────────────────
function makeCashbox(over: Partial<Cashbox> = {}): Cashbox {
  return {
    id: 'cb',
    name: 'X',
    name_ar: 'X',
    warehouse_id: null,
    currency: 'EGP',
    current_balance: '0',
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

const PROVIDERS: PaymentProvider[] = [
  {
    provider_key: 'instapay', method: 'instapay', name_ar: 'إنستا باي', name_en: 'InstaPay',
    icon_name: 'smartphone', logo_key: 'instapay', default_gl_account_code: '1114',
    group: 'instapay', requires_reference: true,
  },
];
const METHOD_MIX: PaymentMethodMixRow[] = [];

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
});

describe('/cashboxes treasury grid — PR-FIN-CASHBOXES-TREASURY-GRID', () => {
  it('renders a card for every active cashbox (cash + ewallet + bank + check)', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({ id: 'cb-cash', kind: 'cash', name_ar: 'الخزينة الرئيسية', current_balance: '31650' }),
      makeCashbox({ id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات', current_balance: '0', accounting_gl_code: '1114', accounting_balance: '2190.00' }),
      makeCashbox({ id: 'cb-bank', kind: 'bank', name_ar: 'حساب POS Visa', current_balance: '0', accounting_gl_code: '1113', accounting_balance: '4500.00' }),
      makeCashbox({ id: 'cb-check', kind: 'check', name_ar: 'الشيكات الواردة', current_balance: '0', accounting_gl_code: '1115', accounting_balance: '750.00' }),
    ]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-cashboxes-grid')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('treasury-cashbox-card-cb-cash')).toBeInTheDocument();
    expect(screen.getByTestId('treasury-cashbox-card-cb-ewallet')).toBeInTheDocument();
    expect(screen.getByTestId('treasury-cashbox-card-cb-bank')).toBeInTheDocument();
    expect(screen.getByTestId('treasury-cashbox-card-cb-check')).toBeInTheDocument();
  });

  it('cash card renders explicit "رصيد تشغيلي من حركات الخزنة" label + current_balance (PR-AUDIT-LABELS-CASH-VS-GL)', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({ id: 'cb-cash', kind: 'cash', name_ar: 'الخزينة الرئيسية', current_balance: '31650' }),
    ]);
    renderPage();
    const card = await screen.findByTestId('treasury-cashbox-card-cb-cash');
    expect(within(card).getByTestId('treasury-cashbox-card-balance-label-cb-cash').textContent).toBe('رصيد تشغيلي من حركات الخزنة');
    // Old terse label must be gone now that the source is in the label itself.
    expect(within(card).getByTestId('treasury-cashbox-card-balance-label-cb-cash').textContent).not.toBe('رصيد الخزنة');
    expect(card.textContent).toMatch(/31,650/);
    expect(within(card).getByText('نقدي')).toBeInTheDocument();
    expect(within(card).getByText('الخزينة الرئيسية')).toBeInTheDocument();
    // Cash MUST NOT carry the GL-derived "محاسبي" pill — its
    // current_balance IS the canonical figure.
    expect(within(card).queryByText('محاسبي')).toBeNull();
  });

  // PR-AUDIT-LABELS-CASH-VS-GL — explicit hover hint clarifies that
  // the cash card's headline is the operational running total, not a
  // GL-derived figure. The structural caption used on non-cash cards
  // (see ewallet test below) MUST NOT appear on cash cards.
  it('cash card balance label has tooltip "رصيد تشغيلي من حركات الخزنة" — and NO structural caption (PR-AUDIT-LABELS-CASH-VS-GL)', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({ id: 'cb-cash', kind: 'cash', name_ar: 'الخزينة الرئيسية', current_balance: '31650' }),
    ]);
    renderPage();
    const card = await screen.findByTestId('treasury-cashbox-card-cb-cash');
    const labelEl = within(card).getByTestId('treasury-cashbox-card-balance-label-cb-cash');
    const tooltip = labelEl.getAttribute('title') ?? '';
    expect(tooltip).toMatch(/رصيد تشغيلي من حركات الخزنة/);
    expect(tooltip).toMatch(/current_balance/);
    // Cash cards must NOT carry the structural caption — that's only
    // for non-cash kinds where the stored current_balance is structural-zero.
    expect(within(card).queryByTestId('treasury-cashbox-card-structural-caption-cb-cash')).toBeNull();
  });

  it('ewallet card renders explicit "رصيد محاسبي من الأستاذ العام" label + accounting_balance + "محاسبي" pill (PR-AUDIT-LABELS-CASH-VS-GL)', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({
        id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات',
        current_balance: '0',
        accounting_gl_code: '1114', accounting_balance: '2190.00',
      }),
    ]);
    renderPage();
    const card = await screen.findByTestId('treasury-cashbox-card-cb-ewallet');
    expect(within(card).getByTestId('treasury-cashbox-card-balance-label-cb-ewallet').textContent).toBe('رصيد محاسبي من الأستاذ العام');
    expect(within(card).getByTestId('treasury-cashbox-card-balance-label-cb-ewallet').textContent).not.toBe('الرصيد المحاسبي');
    expect(card.textContent).toMatch(/2,190\.00/);
    expect(within(card).getByText('محفظة إلكترونية')).toBeInTheDocument();
    expect(within(card).getByText('محاسبي')).toBeInTheDocument();
    // Must NOT show the misleading stored 0 as the headline.
    expect(card.textContent).not.toMatch(/^.{0,20}0\.00\sج\.م/);
  });

  // PR-AUDIT-LABELS-CASH-VS-GL — the structural caption tells the
  // operator why an ewallet "خزنة التحويلات" can show stored 0 EGP
  // while the dashboard's "إجمالي المحافظ" shows non-zero. Names the
  // GL code explicitly so future GL additions are easy to verify.
  it('ewallet card carries the structural caption "خزنة هيكلية — الرصيد المحاسبي في GL 1114" (PR-AUDIT-LABELS-CASH-VS-GL)', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({
        id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات',
        current_balance: '0',
        accounting_gl_code: '1114', accounting_balance: '2190.00',
      }),
    ]);
    renderPage();
    const card = await screen.findByTestId('treasury-cashbox-card-cb-ewallet');
    const caption = within(card).getByTestId('treasury-cashbox-card-structural-caption-cb-ewallet');
    expect(caption.textContent).toMatch(/خزنة هيكلية/);
    expect(caption.textContent).toMatch(/الرصيد المحاسبي/);
    expect(caption.textContent).toMatch(/GL 1114/);
  });

  it('bank card uses GL 1113 + "رصيد محاسبي من الأستاذ العام" label (PR-AUDIT-LABELS-CASH-VS-GL)', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({
        id: 'cb-bank', kind: 'bank', name_ar: 'حساب POS Visa',
        current_balance: '0',
        accounting_gl_code: '1113', accounting_balance: '4500.00',
      }),
    ]);
    renderPage();
    const card = await screen.findByTestId('treasury-cashbox-card-cb-bank');
    expect(within(card).getByTestId('treasury-cashbox-card-balance-label-cb-bank').textContent).toBe('رصيد محاسبي من الأستاذ العام');
    expect(within(card).getByTestId('treasury-cashbox-card-balance-label-cb-bank').textContent).not.toBe('الرصيد المحاسبي');
    expect(card.textContent).toMatch(/4,500\.00/);
    expect(within(card).getByText('بنكي')).toBeInTheDocument();
  });

  it('inactive cashboxes are excluded from the grid', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({ id: 'cb-cash', kind: 'cash', name_ar: 'الخزينة الرئيسية', current_balance: '100', is_active: true }),
      makeCashbox({ id: 'cb-old',  kind: 'ewallet', name_ar: 'خزنة قديمة', accounting_balance: '0', accounting_gl_code: '1114', is_active: false }),
    ]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-cashbox-card-cb-cash')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('treasury-cashbox-card-cb-old')).toBeNull();
  });

  it('sort: cash first, then ewallet/bank/check; within kind by name_ar', async () => {
    // Intentionally jumbled API order.
    cashboxesMock.mockResolvedValue([
      makeCashbox({ id: 'cb-bank',    kind: 'bank',    name_ar: 'بنك CIB',           accounting_gl_code: '1113', accounting_balance: '0' }),
      makeCashbox({ id: 'cb-check',   kind: 'check',   name_ar: 'شيكات',             accounting_gl_code: '1115', accounting_balance: '0' }),
      makeCashbox({ id: 'cb-cash-2',  kind: 'cash',    name_ar: 'الفرع الجديد',       current_balance: '0' }),
      makeCashbox({ id: 'cb-cash-1',  kind: 'cash',    name_ar: 'الخزينة الرئيسية',   current_balance: '100' }),
      makeCashbox({ id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات',     accounting_gl_code: '1114', accounting_balance: '0' }),
    ]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-cashboxes-grid')).toBeInTheDocument(),
    );
    const grid = screen.getByTestId('treasury-cashboxes-grid');
    const ids = Array.from(grid.querySelectorAll('[data-testid^="treasury-cashbox-card-"]'))
      // Only the outer card divs (filter out inner balance-label,
      // details buttons, and the PR-AUDIT-LABELS-CASH-VS-GL
      // structural-caption row that lives inside non-cash cards).
      .filter((el) => /^treasury-cashbox-card-(?!details-|balance-label-|structural-caption-)/.test(el.getAttribute('data-testid') ?? ''))
      .map((el) => el.getAttribute('data-testid'));
    // cash kind first (sorted by name_ar Arabic), then ewallet, then bank, then check.
    expect(ids).toEqual([
      'treasury-cashbox-card-cb-cash-1', // الخزينة الرئيسية
      'treasury-cashbox-card-cb-cash-2', // الفرع الجديد
      'treasury-cashbox-card-cb-ewallet',
      'treasury-cashbox-card-cb-bank',
      'treasury-cashbox-card-cb-check',
    ]);
  });

  it('a freshly-created cashbox in the API response shows up automatically (no hardcoded id/name)', async () => {
    // Brand-new cashbox the page has never seen — picked a random uuid
    // and a name that doesn't match any existing fixture.
    cashboxesMock.mockResolvedValue([
      makeCashbox({ id: 'cb-cash', kind: 'cash', name_ar: 'الخزينة الرئيسية', current_balance: '0' }),
      makeCashbox({
        id: 'newly-created-uuid-xyz',
        kind: 'ewallet',
        name_ar: 'خزنة Vodafone Cash جديدة',
        current_balance: '0',
        accounting_gl_code: '1114',
        accounting_balance: '0',
      }),
    ]);
    renderPage();
    const newCard = await screen.findByTestId('treasury-cashbox-card-newly-created-uuid-xyz');
    expect(newCard).toBeInTheDocument();
    expect(within(newCard).getByText('خزنة Vodafone Cash جديدة')).toBeInTheDocument();
    expect(within(newCard).getByText('محفظة إلكترونية')).toBeInTheDocument();
  });

  it('clicking the card body opens the cashbox-details modal for that cashbox id', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({ id: 'cb-cash',    kind: 'cash',    name_ar: 'الخزينة الرئيسية', current_balance: '100' }),
      makeCashbox({ id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات',   accounting_gl_code: '1114', accounting_balance: '2190.00' }),
    ]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-cashbox-card-cb-ewallet')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('cashbox-details-modal')).toBeNull();
    fireEvent.click(screen.getByTestId('treasury-cashbox-card-cb-ewallet'));
    const modal = await screen.findByTestId('cashbox-details-modal');
    // Modal is opened for the ewallet cashbox — its name appears.
    expect(modal.textContent).toContain('خزنة التحويلات');
  });

  it('clicking "عرض التفاصيل" inside a card opens the modal for that cashbox id', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({ id: 'cb-cash',    kind: 'cash',    name_ar: 'الخزينة الرئيسية', current_balance: '100' }),
      makeCashbox({ id: 'cb-bank',    kind: 'bank',    name_ar: 'حساب POS Visa',     accounting_gl_code: '1113', accounting_balance: '0' }),
    ]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-cashbox-card-details-cb-bank')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('treasury-cashbox-card-details-cb-bank'));
    const modal = await screen.findByTestId('cashbox-details-modal');
    expect(modal.textContent).toContain('حساب POS Visa');
  });

  it('grid never invokes rebuild / drift-cleanup endpoints (read-only display)', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({ id: 'cb-cash',    kind: 'cash',    name_ar: 'الخزينة الرئيسية', current_balance: '100' }),
      makeCashbox({ id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات',   accounting_gl_code: '1114', accounting_balance: '2190.00' }),
    ]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-cashboxes-grid')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId('treasury-cashbox-card-cb-ewallet'));
    await screen.findByTestId('cashbox-details-modal');
    expect(rebuildCashboxBalanceMock).not.toHaveBeenCalled();
    expect(driftCleanupPreviewMock).not.toHaveBeenCalled();
    expect(driftCleanupExecuteMock).not.toHaveBeenCalled();
    expect(transferMock).not.toHaveBeenCalled();
    expect(updateCashboxMock).not.toHaveBeenCalled();
    expect(createCashboxMock).not.toHaveBeenCalled();
    expect(removeCashboxMock).not.toHaveBeenCalled();
  });

  it('empty state when there are no active cashboxes', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({ id: 'cb-old', kind: 'cash', name_ar: 'خزنة قديمة', is_active: false }),
    ]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-cashboxes-empty')).toBeInTheDocument(),
    );
    expect(screen.getByText(/لا توجد خزائن نشطة/)).toBeInTheDocument();
    expect(screen.queryByTestId('treasury-cashboxes-grid')).toBeNull();
  });

  it('grid uses the same query keys as the page (no extra fetches)', async () => {
    cashboxesMock.mockResolvedValue([
      makeCashbox({ id: 'cb-cash', kind: 'cash', name_ar: 'الخزينة الرئيسية', current_balance: '100' }),
      makeCashbox({ id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات', accounting_gl_code: '1114', accounting_balance: '2190.00' }),
    ]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('treasury-cashboxes-grid')).toBeInTheDocument(),
    );
    // The page already calls cashDeskApi.cashboxes() once. The grid is
    // a pure consumer of that array — must NOT trigger another call.
    expect(cashboxesMock).toHaveBeenCalledTimes(1);
  });
});
