/**
 * CashboxDetailsModal.treasury-fixes.test.tsx
 * PR-FIN-CASHBOXES-TREASURY-GRID-FIXES
 *
 * Pins the Fix 2 + Fix 4 contracts inside the cashbox details modal:
 *
 *   FIX 2 — header balance routes through `displayCashboxBalance`
 *   ✓ ewallet header shows "الرصيد المحاسبي · 2,190.00" (NOT 0.00)
 *   ✓ ewallet header keeps the stored value as a clearly-labeled
 *     "الرصيد التشغيلي المخزن" secondary row (auditable, but never
 *     mistaken for the headline)
 *   ✓ cash header keeps "رصيد الخزنة · current_balance" (no
 *     secondary stored row)
 *   ✓ drift panel relabels stored_balance row to
 *     "الرصيد التشغيلي المخزن" for non-cash, "رصيد الخزنة" for cash
 *
 *   FIX 4 — period totals + linked-account totals + default range
 *   ✓ period totals header is "إجماليات الفترة المختارة" (not
 *     "إجماليات الفترة")
 *   ✓ linked-account totals panel renders the all-time sum of
 *     `net_debit` across linked PAs, date-independent
 *   ✓ default range for non-cash cashboxes is "الكل" (so historical
 *     wallet movements are visible by default), cash stays "هذا الشهر"
 *   ✓ "الكل" chip exists and re-fires the query without `from`/`to`
 *
 * Locks the regression: anyone reverting the modal to print the
 * stored 0.00 as the wallet balance, or hiding historical wallet
 * movements behind a default month filter, fails CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  Cashbox,
  CashboxMovementsUnifiedResponse,
} from '@/api/cash-desk.api';
import type {
  PaymentAccountBalance,
  PaymentProvider,
  CashboxGlDrift,
} from '@/api/payments.api';
import type React from 'react';

const movementsUnifiedMock = vi.fn();

vi.mock('@/api/cash-desk.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    cashDeskApi: {
      cashboxMovementsUnified: (cbId: string, filter: any) =>
        movementsUnifiedMock(cbId, filter),
    },
  };
});

import { CashboxDetailsModal } from '../CashboxDetailsModal';

function makeCashbox(over: Partial<Cashbox> = {}): Cashbox {
  return {
    id: 'cb-x',
    name: 'X', name_ar: 'X',
    warehouse_id: null, currency: 'EGP',
    current_balance: '0',
    is_active: true, kind: 'cash',
    institution_code: null, institution_name: null, institution_name_en: null,
    institution_domain: null, institution_color: null, institution_kind: null,
    bank_branch: null, account_number: null, iban: null, swift_code: null,
    account_holder_name: null, account_manager_name: null,
    account_manager_phone: null, account_manager_email: null,
    wallet_phone: null, wallet_owner_name: null,
    check_issuer_name: null, color: null,
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

function renderModal(props: Partial<React.ComponentProps<typeof CashboxDetailsModal>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <CashboxDetailsModal
        cashbox={makeCashbox()}
        allBalances={[]}
        drifts={[]}
        providers={PROVIDERS}
        onClose={vi.fn()}
        onOpenLinkedAccount={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  movementsUnifiedMock.mockReset();
  movementsUnifiedMock.mockResolvedValue({
    rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
  } satisfies CashboxMovementsUnifiedResponse);
});

// ───────── Fix 2 — header balance + drift relabel ─────────────────
describe('<CashboxDetailsModal /> Fix 2 — header balance via helper', () => {
  it('ewallet header renders "الرصيد المحاسبي · 2,190.00" (NOT the stored 0.00 as headline)', async () => {
    renderModal({
      cashbox: makeCashbox({
        id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات',
        current_balance: '0',
        accounting_gl_code: '1114', accounting_balance: '2190.00',
      } as any),
    });
    const identity = screen.getByTestId('cashbox-details-identity');
    expect(within(identity).getByText('الرصيد المحاسبي')).toBeInTheDocument();
    const main = within(identity).getByTestId('cashbox-details-main-balance');
    expect(main.textContent).toMatch(/2,190\.00/);
    // The headline must NOT be 0 — that's the bug we fixed.
    expect(main.textContent).not.toMatch(/^0\.00\s+ج\.م/);
    expect(main.textContent).not.toMatch(/^\s*0\.00/);
  });

  it('ewallet header preserves the stored value as a labeled secondary "الرصيد التشغيلي المخزن"', async () => {
    renderModal({
      cashbox: makeCashbox({
        id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات',
        current_balance: '0',
        accounting_gl_code: '1114', accounting_balance: '2190.00',
      } as any),
    });
    const identity = screen.getByTestId('cashbox-details-identity');
    expect(within(identity).getByText('الرصيد التشغيلي المخزن')).toBeInTheDocument();
    const stored = within(identity).getByTestId('cashbox-details-stored-balance');
    expect(stored.textContent).toMatch(/0\.00/);
    // Old "الرصيد الحالي" label is gone for non-cash.
    expect(within(identity).queryByText('الرصيد الحالي')).toBeNull();
  });

  it('cash header keeps "رصيد الخزنة · current_balance" (no secondary stored row)', async () => {
    renderModal({
      cashbox: makeCashbox({
        id: 'cb-cash', kind: 'cash', name_ar: 'الخزينة الرئيسية',
        current_balance: '31650',
      }),
    });
    const identity = screen.getByTestId('cashbox-details-identity');
    expect(within(identity).getByText('رصيد الخزنة')).toBeInTheDocument();
    const main = within(identity).getByTestId('cashbox-details-main-balance');
    expect(main.textContent).toMatch(/31,650\.00/);
    // No accounting label, no secondary stored row for cash.
    expect(within(identity).queryByText('الرصيد المحاسبي')).toBeNull();
    expect(within(identity).queryByTestId('cashbox-details-stored-balance')).toBeNull();
  });

  it('bank header uses "الرصيد المحاسبي" (not "الرصيد الحالي")', async () => {
    renderModal({
      cashbox: makeCashbox({
        id: 'cb-bank', kind: 'bank', name_ar: 'حساب POS Visa',
        current_balance: '0',
        accounting_gl_code: '1113', accounting_balance: '4500.00',
      } as any),
    });
    const identity = screen.getByTestId('cashbox-details-identity');
    expect(within(identity).getByText('الرصيد المحاسبي')).toBeInTheDocument();
    expect(within(identity).getByTestId('cashbox-details-main-balance').textContent).toMatch(/4,500\.00/);
  });

  it('drift panel: stored_balance row labeled "الرصيد التشغيلي المخزن" for non-cash', async () => {
    const drift: CashboxGlDrift = {
      cashbox_id: 'cb-ewallet',
      cashbox_name: 'خزنة التحويلات',
      stored_balance: '0',
      gl_net: '2190.00',
      drift_amount: '-2190.00',
    } as any;
    renderModal({
      cashbox: makeCashbox({ id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات' }),
      drifts: [drift],
    });
    const driftPanel = screen.getByTestId('cashbox-details-drift');
    expect(within(driftPanel).getByText('الرصيد التشغيلي المخزن')).toBeInTheDocument();
    expect(within(driftPanel).queryByText('رصيد الخزنة')).toBeNull();
  });

  it('drift panel: stored_balance row labeled "رصيد الخزنة" for cash', async () => {
    const drift: CashboxGlDrift = {
      cashbox_id: 'cb-cash',
      cashbox_name: 'الخزينة الرئيسية',
      stored_balance: '31650',
      gl_net: '31650',
      drift_amount: '0',
    } as any;
    renderModal({
      cashbox: makeCashbox({ id: 'cb-cash', kind: 'cash', name_ar: 'الخزينة الرئيسية' }),
      drifts: [drift],
    });
    const driftPanel = screen.getByTestId('cashbox-details-drift');
    expect(within(driftPanel).getByText('رصيد الخزنة')).toBeInTheDocument();
    expect(within(driftPanel).queryByText('الرصيد التشغيلي المخزن')).toBeNull();
  });
});

// ───────── Fix 4 — totals labels + linked totals + default range ──
describe('<CashboxDetailsModal /> Fix 4 — period totals + linked totals + default range', () => {
  it('period totals header is "إجماليات الفترة المختارة" (clarifies date-scoping)', async () => {
    renderModal();
    const totals = screen.getByTestId('cashbox-details-totals');
    expect(within(totals).getByText('إجماليات الفترة المختارة')).toBeInTheDocument();
    // Pre-fix label gone.
    expect(within(totals).queryByText(/^إجماليات الفترة$/)).toBeNull();
  });

  it('period totals carries an explicit hint that they depend on the active filter', async () => {
    renderModal();
    expect(screen.getByTestId('cashbox-totals-period-hint').textContent).toMatch(/الفترة الزمنية المختارة/);
  });

  it('linked-account totals panel sums net_debit across linked PAs (date-independent)', async () => {
    // Production fixture-shape: InstaPay (1,895) + WE Pay (295) =
    // 2,190 EGP — the figure the operator expected to see for the
    // wallet cashbox.
    const balances: PaymentAccountBalance[] = [
      makeBalance({
        payment_account_id: 'pa-instapay', display_name: 'InstaPay',
        method: 'instapay', cashbox_id: 'cb-ewallet', net_debit: '1895.00',
      }),
      makeBalance({
        payment_account_id: 'pa-we', display_name: 'WE Pay', provider_key: 'we_pay',
        method: 'wallet', cashbox_id: 'cb-ewallet', net_debit: '295.00',
      }),
      // A linked PA on a DIFFERENT cashbox — must NOT contribute.
      makeBalance({
        payment_account_id: 'pa-other', display_name: 'OtherCb wallet',
        method: 'instapay', cashbox_id: 'cb-other', net_debit: '999.00',
      }),
    ];
    renderModal({
      cashbox: makeCashbox({ id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات' }),
      allBalances: balances,
    });
    const totals = screen.getByTestId('cashbox-details-linked-totals');
    expect(totals).toBeInTheDocument();
    expect(totals.textContent).toMatch(/إجماليات الحسابات المرتبطة/);
    expect(totals.textContent).toMatch(/مستقل عن الفترة الزمنية/);
    const amount = screen.getByTestId('cashbox-details-linked-totals-amount');
    expect(amount.textContent).toMatch(/2,190\.00/);
    // Must NOT include the unrelated cashbox's PA.
    expect(amount.textContent).not.toMatch(/3,189/);
  });

  it('linked-totals panel does NOT render when there are no linked PAs (empty-state path)', async () => {
    renderModal({
      cashbox: makeCashbox({ id: 'cb-orphan', kind: 'ewallet' }),
      allBalances: [],
    });
    expect(screen.queryByTestId('cashbox-details-linked-totals')).toBeNull();
    expect(screen.getByTestId('cashbox-details-linked-empty')).toBeInTheDocument();
  });

  it('default range for non-cash cashboxes is "الكل" — historical movements visible immediately', async () => {
    renderModal({
      cashbox: makeCashbox({ id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات' }),
    });
    // First call to the API must NOT carry from/to (no date filter).
    await waitFor(() => expect(movementsUnifiedMock).toHaveBeenCalled());
    const [, firstFilter] = movementsUnifiedMock.mock.calls[0];
    expect(firstFilter.from).toBeUndefined();
    expect(firstFilter.to).toBeUndefined();
    // The "الكل" chip is rendered AND active.
    expect(screen.getByTestId('cashbox-range-all')).toBeInTheDocument();
  });

  it('default range for cash cashboxes stays "هذا الشهر" (unchanged)', async () => {
    renderModal({
      cashbox: makeCashbox({ id: 'cb-cash', kind: 'cash', name_ar: 'الخزينة الرئيسية' }),
    });
    await waitFor(() => expect(movementsUnifiedMock).toHaveBeenCalled());
    const [, firstFilter] = movementsUnifiedMock.mock.calls[0];
    // Month range fills both from/to.
    expect(firstFilter.from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(firstFilter.to).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('clicking "الكل" chip from any other range re-fires the query without from/to', async () => {
    renderModal({
      cashbox: makeCashbox({ id: 'cb-cash', kind: 'cash' }), // starts on month
    });
    await waitFor(() => expect(movementsUnifiedMock).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId('cashbox-range-all'));
    await waitFor(() => {
      const last = movementsUnifiedMock.mock.calls[movementsUnifiedMock.mock.calls.length - 1];
      expect(last[1].from).toBeUndefined();
      expect(last[1].to).toBeUndefined();
    });
  });

  it('"الكل" chip shows the Arabic label "الكل" in the chip row', async () => {
    renderModal({ cashbox: makeCashbox({ kind: 'cash' }) });
    expect(screen.getByTestId('cashbox-range-all').textContent).toMatch(/الكل/);
  });
});

// ───── PR-AUDIT-EWALLET-GL-ONLY-UX (Sprint 2 / PR-5) ─────
//
// Pin a small reconciliation indicator inside the linked-payment-
// accounts panel: when the cashbox is non-cash (ewallet/bank/check),
// compare the linked-PA `net_debit` total to the GL-derived
// `accounting_balance` and surface either:
//   · "متطابق مع رصيد الأستاذ (GL ####)" (emerald) when |gap| ≤ 0.01
//   · "فرق X EGP عن رصيد الأستاذ (GL ####)" (amber) otherwise
// FE-only. No formula change. Both numbers come from already-shipped
// API fields (`Cashbox.accounting_balance` + `PaymentAccountBalance.
// net_debit`). Cash cashboxes never show this indicator (they don't
// have a GL accounting balance — their stored figure IS canonical).
describe('<CashboxDetailsModal /> PR-AUDIT-EWALLET-GL-ONLY-UX — linked-PA vs GL reconciliation indicator', () => {
  it('ewallet with linked-PA total = accounting_balance → "متطابق مع رصيد الأستاذ (GL 1114)" emerald', async () => {
    // Reconciled case: 1,895 + 295 = 2,190 = accounting_balance.
    renderModal({
      cashbox: makeCashbox({
        id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات',
        current_balance: '0',
        accounting_gl_code: '1114', accounting_balance: '2190.00',
      } as any),
      allBalances: [
        makeBalance({
          payment_account_id: 'pa-instapay', display_name: 'InstaPay',
          method: 'instapay', cashbox_id: 'cb-ewallet', net_debit: '1895.00',
        }),
        makeBalance({
          payment_account_id: 'pa-we', display_name: 'WE Pay', provider_key: 'we_pay',
          method: 'wallet', cashbox_id: 'cb-ewallet', net_debit: '295.00',
        }),
      ],
    });
    const recon = screen.getByTestId('cashbox-details-linked-recon');
    expect(recon).toBeInTheDocument();
    expect(recon.className).toMatch(/emerald/);
    expect(
      screen.getByTestId('cashbox-details-linked-recon-status').textContent,
    ).toMatch(/متطابق مع رصيد الأستاذ \(GL 1114\)/);
    // Detail row shows both totals so the operator can audit the math.
    const detail = screen.getByTestId('cashbox-details-linked-recon-detail');
    expect(detail.textContent).toMatch(/المرتبط/);
    expect(detail.textContent).toMatch(/2,190\.00/);
    expect(detail.textContent).toMatch(/الأستاذ/);
  });

  it('ewallet with linked-PA total ≠ accounting_balance → "فرق X EGP عن رصيد الأستاذ (GL 1114)" amber', async () => {
    // Unreconciled case from the production audit (read-only):
    // خزنة التحويلات GL 1114 = 2,840 EGP but only 1,000 linked → gap +1,840.
    renderModal({
      cashbox: makeCashbox({
        id: 'cb-ewallet', kind: 'ewallet', name_ar: 'خزنة التحويلات',
        current_balance: '0',
        accounting_gl_code: '1114', accounting_balance: '2840.00',
      } as any),
      allBalances: [
        makeBalance({
          payment_account_id: 'pa-instapay', display_name: 'InstaPay',
          method: 'instapay', cashbox_id: 'cb-ewallet', net_debit: '1000.00',
        }),
      ],
    });
    const recon = screen.getByTestId('cashbox-details-linked-recon');
    expect(recon).toBeInTheDocument();
    expect(recon.className).toMatch(/amber/);
    expect(
      screen.getByTestId('cashbox-details-linked-recon-status').textContent,
    ).toMatch(/فرق 1,840\.00 ج\.م عن رصيد الأستاذ \(GL 1114\)/);
    // No "متطابق" wording when there's a real gap.
    expect(
      screen.getByTestId('cashbox-details-linked-recon-status').textContent,
    ).not.toMatch(/متطابق/);
  });

  it('bank cashbox carries the same indicator with GL 1113', async () => {
    renderModal({
      cashbox: makeCashbox({
        id: 'cb-bank', kind: 'bank', name_ar: 'حساب POS Visa',
        current_balance: '0',
        accounting_gl_code: '1113', accounting_balance: '4500.00',
      } as any),
      allBalances: [
        makeBalance({
          payment_account_id: 'pa-bank', display_name: 'Bank PA',
          method: 'card_visa', gl_account_code: '1113', cashbox_id: 'cb-bank', net_debit: '4500.00',
        } as any),
      ],
    });
    expect(screen.getByTestId('cashbox-details-linked-recon')).toBeInTheDocument();
    expect(
      screen.getByTestId('cashbox-details-linked-recon-status').textContent,
    ).toMatch(/متطابق مع رصيد الأستاذ \(GL 1113\)/);
  });

  it('cash cashbox does NOT render the indicator (no GL accounting balance to reconcile against)', async () => {
    renderModal({
      cashbox: makeCashbox({
        id: 'cb-cash', kind: 'cash', name_ar: 'الخزينة الرئيسية',
        current_balance: '34640',
      }),
      // Cash cashboxes don't normally carry linked PAs, but pin the
      // contract anyway: even if they did, the indicator must not
      // render — the displayCashboxBalance.kind for cash is 'cash',
      // not 'accounting', so there's no GL net to compare to.
      allBalances: [
        makeBalance({
          payment_account_id: 'pa-x', display_name: 'X',
          method: 'instapay', cashbox_id: 'cb-cash', net_debit: '100.00',
        }),
      ],
    });
    expect(screen.queryByTestId('cashbox-details-linked-recon')).toBeNull();
  });

  it('non-cash cashbox with NO linked PAs renders neither the totals row nor the recon indicator', async () => {
    renderModal({
      cashbox: makeCashbox({
        id: 'cb-orphan', kind: 'ewallet',
        accounting_gl_code: '1114', accounting_balance: '500.00',
      } as any),
      allBalances: [],
    });
    expect(screen.queryByTestId('cashbox-details-linked-totals')).toBeNull();
    expect(screen.queryByTestId('cashbox-details-linked-recon')).toBeNull();
    expect(screen.getByTestId('cashbox-details-linked-empty')).toBeInTheDocument();
  });
});
