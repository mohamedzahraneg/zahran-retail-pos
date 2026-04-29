/**
 * PaymentAccountAlerts.test.tsx — PR-FIN-PAYACCT-4B
 *
 * Pins the right-rail "تنبيهات محاسبية" panel behavior. All warnings
 * are computed from real data (no hardcoded strings):
 *
 *   ✓ Drift alert per cashbox where |drift_amount| > 0.01
 *   ✓ "No default per method" when an active method has no
 *     `is_default=true` row
 *   ✓ Stale-account banner when balances have movements > 30 days old
 *   ✓ All-clear banner when nothing to flag
 *
 * Locks the regression: replacing computed alerts with hardcoded copy
 * fails CI.
 */
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { PaymentAccountAlerts } from '../PaymentAccountAlerts';
import type {
  PaymentAccount,
  PaymentAccountBalance,
  CashboxGlDrift,
} from '@/api/payments.api';

function makeAccount(over: Partial<PaymentAccount> = {}): PaymentAccount {
  return {
    id: 'acct-1',
    method: 'instapay',
    provider_key: 'instapay',
    display_name: 'InstaPay Main',
    identifier: '0100',
    gl_account_code: '1114',
    cashbox_id: null,
    is_default: true,
    active: true,
    sort_order: 0,
    metadata: {},
    created_at: '',
    updated_at: '',
    created_by: null,
    updated_by: null,
    ...over,
  };
}

function makeBalance(
  over: Partial<PaymentAccountBalance> = {},
): PaymentAccountBalance {
  return {
    payment_account_id: 'acct-1',
    method: 'instapay',
    provider_key: 'instapay',
    display_name: 'InstaPay Main',
    identifier: '0100',
    gl_account_code: '1114',
    cashbox_id: null,
    is_default: true,
    active: true,
    sort_order: 0,
    metadata: {},
    gl_name_ar: 'محافظ',
    normal_balance: 'debit',
    total_in: '0',
    total_out: '0',
    net_debit: '0',
    je_count: 0,
    last_movement: null,
    ...over,
  };
}

describe('<PaymentAccountAlerts /> — PR-FIN-PAYACCT-4B', () => {
  it('renders the all-clear banner when there are no alerts', () => {
    render(
      <PaymentAccountAlerts
        accounts={[makeAccount({ is_default: true, cashbox_id: 'cb-x' })]}
        balances={[
          makeBalance({
            is_default: true,
            last_movement: null,
            cashbox_id: 'cb-x', // PR-4D: pinned, so no-cashbox-pin won't fire.
          }),
        ]}
        drifts={[]}
      />,
    );
    expect(screen.getByTestId('alert-all-clear')).toBeInTheDocument();
    expect(screen.getByText(/جميع الخزائن متطابقة/)).toBeInTheDocument();
  });

  it('renders one drift alert per cashbox above the 0.01 threshold', () => {
    const drifts: CashboxGlDrift[] = [
      {
        cashbox_id: 'cb-1',
        cashbox_name: 'الخزينة الرئيسية',
        kind: 'cash',
        is_active: true,
        stored_balance: '5000',
        gl_total_dr: '5000',
        gl_total_cr: '0',
        gl_net: '5005',
        drift_amount: '5',
      },
      {
        cashbox_id: 'cb-2',
        cashbox_name: 'بنك CIB',
        kind: 'bank',
        is_active: true,
        stored_balance: '0',
        gl_total_dr: '0',
        gl_total_cr: '0',
        gl_net: '0',
        drift_amount: '0',
      },
    ];
    render(
      <PaymentAccountAlerts
        accounts={[makeAccount({ is_default: true })]}
        balances={[makeBalance({ is_default: true })]}
        drifts={drifts}
      />,
    );
    // Only cb-1 (drift > 0.01) shows up; cb-2 (drift == 0) is skipped.
    expect(screen.getByTestId('alert-drift-cb-1')).toBeInTheDocument();
    expect(screen.queryByTestId('alert-drift-cb-2')).toBeNull();
    // No all-clear banner when at least one alert renders.
    expect(screen.queryByTestId('alert-all-clear')).toBeNull();
  });

  it('renders a no-default warning per method that has actives but no default', () => {
    const accounts: PaymentAccount[] = [
      makeAccount({ id: 'acct-w-1', method: 'wallet', is_default: false }),
      makeAccount({ id: 'acct-w-2', method: 'wallet', is_default: false }),
      // bank_transfer has a default — should NOT trigger the warning
      makeAccount({ id: 'acct-b-1', method: 'bank_transfer', is_default: true }),
    ];
    render(
      <PaymentAccountAlerts
        accounts={accounts}
        balances={accounts.map((a) =>
          makeBalance({
            payment_account_id: a.id,
            method: a.method,
            is_default: a.is_default,
          }),
        )}
        drifts={[]}
      />,
    );
    expect(screen.getByTestId('alert-no-default-wallet')).toBeInTheDocument();
    expect(screen.queryByTestId('alert-no-default-bank_transfer')).toBeNull();
  });

  it('renders a stale-accounts banner when an active balance has not moved in 30+ days', () => {
    // 35 days ago
    const stale = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    // 5 days ago
    const fresh = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    render(
      <PaymentAccountAlerts
        accounts={[
          makeAccount({ id: 'a1', is_default: true }),
          makeAccount({ id: 'a2', method: 'cash', is_default: true }),
        ]}
        balances={[
          makeBalance({
            payment_account_id: 'a1',
            is_default: true,
            last_movement: stale,
          }),
          makeBalance({
            payment_account_id: 'a2',
            method: 'cash',
            is_default: true,
            last_movement: fresh,
          }),
        ]}
        drifts={[]}
      />,
    );
    const banner = screen.getByTestId('alert-stale-accounts');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('1');
  });

  it('skips inactive accounts when computing the stale-accounts banner', () => {
    const stale = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    render(
      <PaymentAccountAlerts
        accounts={[makeAccount({ active: false, is_default: true })]}
        balances={[
          makeBalance({
            active: false,
            is_default: true,
            last_movement: stale,
          }),
        ]}
        drifts={[]}
      />,
    );
    expect(screen.queryByTestId('alert-stale-accounts')).toBeNull();
    expect(screen.getByTestId('alert-all-clear')).toBeInTheDocument();
  });

  it('does NOT render the no-default warning when the only account for a method is inactive', () => {
    // Only one account; inactive — so the method has 0 active rows and
    // therefore no "missing default" problem.
    render(
      <PaymentAccountAlerts
        accounts={[makeAccount({ active: false, is_default: false })]}
        balances={[makeBalance({ active: false, is_default: false })]}
        drifts={[]}
      />,
    );
    expect(screen.queryByTestId('alert-no-default-instapay')).toBeNull();
    expect(screen.getByTestId('alert-all-clear')).toBeInTheDocument();
  });

  // ─── PR-FIN-PAYACCT-4D: two new alert types ─────────────────────
  it('PR-4D: surfaces "inactive accounts with movements" when an inactive account has je_count > 0', () => {
    render(
      <PaymentAccountAlerts
        accounts={[
          // Active default — keeps the no-default + drift checks clean.
          makeAccount({ id: 'a-active', is_default: true }),
          // Inactive account with historical movements — should fire.
          makeAccount({
            id: 'a-old',
            method: 'wallet',
            active: false,
            is_default: false,
          }),
        ]}
        balances={[
          makeBalance({
            payment_account_id: 'a-active',
            is_default: true,
          }),
          makeBalance({
            payment_account_id: 'a-old',
            method: 'wallet',
            active: false,
            is_default: false,
            je_count: 7,
          }),
        ]}
        drifts={[]}
      />,
    );
    const banner = screen.getByTestId('alert-inactive-with-movements');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('1');
    // All-clear must NOT render when this alert fires.
    expect(screen.queryByTestId('alert-all-clear')).toBeNull();
  });

  it('PR-4D: does NOT fire "inactive-with-movements" when the inactive account has je_count = 0', () => {
    render(
      <PaymentAccountAlerts
        accounts={[
          makeAccount({ id: 'a-active', is_default: true }),
          makeAccount({
            id: 'a-old',
            method: 'wallet',
            active: false,
            is_default: false,
          }),
        ]}
        balances={[
          makeBalance({
            payment_account_id: 'a-active',
            is_default: true,
          }),
          // je_count = 0 (default) → not surfaced.
          makeBalance({
            payment_account_id: 'a-old',
            method: 'wallet',
            active: false,
            is_default: false,
          }),
        ]}
        drifts={[]}
      />,
    );
    expect(screen.queryByTestId('alert-inactive-with-movements')).toBeNull();
  });

  it('PR-4D: surfaces "no cashbox pin" for active accounts on pin-recommended methods', () => {
    // Active bank_transfer account with no cashbox_id pin → should fire.
    render(
      <PaymentAccountAlerts
        accounts={[
          makeAccount({
            id: 'a-bank',
            method: 'bank_transfer',
            is_default: true,
            cashbox_id: null,
          }),
        ]}
        balances={[
          makeBalance({
            payment_account_id: 'a-bank',
            method: 'bank_transfer',
            is_default: true,
            cashbox_id: null,
          }),
        ]}
        drifts={[]}
      />,
    );
    const banner = screen.getByTestId('alert-no-cashbox-pin');
    expect(banner).toBeInTheDocument();
    expect(banner).toHaveTextContent('1');
  });

  it('PR-4D: does NOT fire "no-cashbox-pin" for accounts that already have a cashbox_id', () => {
    render(
      <PaymentAccountAlerts
        accounts={[
          makeAccount({
            id: 'a-bank',
            method: 'bank_transfer',
            is_default: true,
            cashbox_id: 'cb-bank',
          }),
        ]}
        balances={[
          makeBalance({
            payment_account_id: 'a-bank',
            method: 'bank_transfer',
            is_default: true,
            cashbox_id: 'cb-bank',
          }),
        ]}
        drifts={[]}
      />,
    );
    expect(screen.queryByTestId('alert-no-cashbox-pin')).toBeNull();
    expect(screen.getByTestId('alert-all-clear')).toBeInTheDocument();
  });
});
