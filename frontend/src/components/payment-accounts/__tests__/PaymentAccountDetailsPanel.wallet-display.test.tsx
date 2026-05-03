/**
 * PaymentAccountDetailsPanel.wallet-display.test.tsx
 * PR-FIN-PAYMENTS-WALLET-DISPLAY-BALANCE
 *
 * Pins two new display contracts on the per-account details modal:
 *
 *   1. Adds an explicit "رصيد حساب الدفع" SummaryRow alongside the
 *      existing "صافي الحركة" so the operator sees the per-payment-
 *      account balance as a balance, not just a flow delta.
 *
 *   2. The "الخزنة المرتبطة" row labels the cashbox as "(محاسبي/GL)"
 *      when the cashbox is non-cash — so the operator never confuses
 *      the wallet-cashbox's GL aggregate with a per-drawer figure.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type {
  PaymentAccountBalance, PaymentAccountMovementsResponse, PaymentProvider,
} from '@/api/payments.api';
import type { Cashbox } from '@/api/cash-desk.api';
import type React from 'react';

const movementsMock = vi.fn();

vi.mock('@/api/payments.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    paymentsApi: {
      movements: (id: string, filter: any) => movementsMock(id, filter),
    },
  };
});

import { PaymentAccountDetailsPanel } from '../PaymentAccountDetailsPanel';

function makeAccount(over: Partial<PaymentAccountBalance> = {}): PaymentAccountBalance {
  return {
    payment_account_id: 'acct-1',
    method: 'instapay',
    provider_key: 'instapay',
    display_name: 'InstaPay',
    identifier: '01000000000',
    gl_account_code: '1114',
    cashbox_id: 'cb-ewallet',
    is_default: true,
    active: true,
    sort_order: 0,
    metadata: {},
    gl_name_ar: 'المحافظ الإلكترونية',
    normal_balance: 'debit',
    total_in: '2200.00',
    total_out: '10.00',
    net_debit: '2190.00',
    je_count: 7,
    last_movement: '2026-04-29',
    ...over,
  };
}

const PROVIDER: PaymentProvider = {
  provider_key: 'instapay', method: 'instapay',
  name_ar: 'إنستا باي', name_en: 'InstaPay',
  icon_name: 'smartphone', logo_key: 'instapay',
  default_gl_account_code: '1114', group: 'instapay', requires_reference: true,
};

function makeCashbox(over: Partial<Cashbox> = {}): Cashbox {
  return {
    id: 'cb-ewallet', name: 'خزنة التحويلات', name_ar: 'خزنة التحويلات',
    warehouse_id: null, currency: 'EGP', current_balance: '0',
    is_active: true, kind: 'ewallet',
    institution_code: null, institution_name: null, institution_name_en: null,
    institution_domain: null, institution_color: null, institution_kind: null,
    bank_branch: null, account_number: null, iban: null, swift_code: null,
    account_holder_name: null, account_manager_name: null,
    account_manager_phone: null, account_manager_email: null,
    wallet_phone: null, wallet_owner_name: null, check_issuer_name: null, color: null,
    ...over,
  };
}

function renderPanel(props: Partial<React.ComponentProps<typeof PaymentAccountDetailsPanel>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PaymentAccountDetailsPanel
        account={makeAccount()}
        provider={PROVIDER}
        cashbox={makeCashbox()}
        warnings={[]}
        canManage={true}
        onClose={vi.fn()}
        onEdit={vi.fn()}
        onSetDefault={vi.fn()}
        onToggleActive={vi.fn()}
        onDelete={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  movementsMock.mockReset();
  movementsMock.mockResolvedValue({
    rows: [], total: 0, totals: { in: '0', out: '0', net: '0', count: 0 },
  } satisfies PaymentAccountMovementsResponse);
});

describe('<PaymentAccountDetailsPanel /> — PR-FIN-PAYMENTS-WALLET-DISPLAY-BALANCE', () => {
  it('renders an explicit "رصيد حساب الدفع" SummaryRow with the account net_debit', () => {
    renderPanel();
    const row = screen.getByTestId('totals-payment-account-balance');
    expect(row).toBeInTheDocument();
    expect(row.textContent).toMatch(/رصيد حساب الدفع/);
    // 2,190.00 from net_debit fixture (formatted EGP).
    expect(row.textContent).toMatch(/2,190\.00/);
  });

  it('"رصيد حساب الدفع" sits inside the totals block, alongside the existing rows', () => {
    renderPanel();
    const totals = screen.getByTestId('details-totals');
    expect(within(totals).getByTestId('totals-in')).toBeInTheDocument();
    expect(within(totals).getByTestId('totals-out')).toBeInTheDocument();
    expect(within(totals).getByTestId('totals-payment-account-balance')).toBeInTheDocument();
    expect(within(totals).getByTestId('totals-net')).toBeInTheDocument();
    expect(within(totals).getByTestId('totals-count')).toBeInTheDocument();
  });

  it('linked ewallet cashbox is labeled "(محاسبي/GL)" — never as a per-drawer cash figure', () => {
    renderPanel({ cashbox: makeCashbox({ kind: 'ewallet', name_ar: 'خزنة التحويلات' }) });
    const identity = screen.getByTestId('details-identity');
    expect(identity.textContent).toMatch(/خزنة التحويلات/);
    expect(identity.textContent).toMatch(/\(محاسبي\/GL\)/);
  });

  it('linked CASH cashbox is NOT labeled "(محاسبي/GL)" — current_balance IS canonical', () => {
    renderPanel({
      cashbox: makeCashbox({
        id: 'cb-cash', kind: 'cash', name_ar: 'الخزينة الرئيسية',
        current_balance: '5000',
      }),
    });
    const identity = screen.getByTestId('details-identity');
    expect(identity.textContent).toMatch(/الخزينة الرئيسية/);
    expect(identity.textContent).not.toMatch(/محاسبي\/GL/);
  });

  it('bank cashbox is labeled "(محاسبي/GL)" (kind=bank → GL 1113)', () => {
    renderPanel({
      cashbox: makeCashbox({
        id: 'cb-bank', kind: 'bank', name_ar: 'حساب POS Visa',
        accounting_gl_code: '1113', accounting_balance: '0' as any,
      }),
    });
    const identity = screen.getByTestId('details-identity');
    expect(identity.textContent).toMatch(/حساب POS Visa/);
    expect(identity.textContent).toMatch(/\(محاسبي\/GL\)/);
  });

  it('renders correctly when no cashbox is linked (— غير مربوط —)', async () => {
    renderPanel({ cashbox: null });
    const identity = screen.getByTestId('details-identity');
    expect(identity.textContent).toMatch(/غير مربوط/);
    expect(identity.textContent).not.toMatch(/محاسبي\/GL/);
    // The new SummaryRow is account-level — it must still render.
    await waitFor(() =>
      expect(screen.getByTestId('totals-payment-account-balance')).toBeInTheDocument(),
    );
  });
});
