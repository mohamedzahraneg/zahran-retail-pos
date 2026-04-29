/**
 * PaymentAccountPicker.test.tsx — PR-FIN-PAYACCT-4C
 *
 * Pins the shared picker behavior used by:
 *   • POS SplitPaymentsEditor (variant="dark")
 *   • Customer ReceiptModal     (variant="light")
 *   • Supplier SupplierPayModal (variant="light")
 *
 * The picker is presentation-only; the parent owns the `selected`
 * state. These tests assert: (a) blocked banner when no active
 * accounts, (b) row rendering + click → onSelect, (c) auto-default
 * helper picks the right account for each method, and (d) the
 * needs-manual-pick hint when multiple accounts and none selected.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  PaymentAccountPicker,
  autoSelectAccountForMethod,
  visibleMethodsFor,
} from '../PaymentAccountPicker';
import type { PaymentAccount, PaymentProvider } from '@/api/payments.api';

const PROVIDERS: PaymentProvider[] = [
  {
    provider_key: 'instapay',
    method: 'instapay',
    name_ar: 'إنستا باي',
    name_en: 'InstaPay',
    icon_name: 'smartphone',
    logo_key: 'instapay',
    default_gl_account_code: '1114',
    group: 'instapay',
    requires_reference: true,
  },
  {
    provider_key: 'we_pay',
    method: 'wallet',
    name_ar: 'WE Pay',
    name_en: 'WE Pay',
    icon_name: 'smartphone',
    logo_key: 'we_pay',
    default_gl_account_code: '1114',
    group: 'wallet',
    requires_reference: true,
  },
];

const ACCOUNTS: PaymentAccount[] = [
  {
    id: 'pa-instapay-1',
    method: 'instapay',
    provider_key: 'instapay',
    display_name: 'InstaPay Main',
    identifier: '0100…',
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
  },
  {
    id: 'pa-instapay-2',
    method: 'instapay',
    provider_key: 'instapay',
    display_name: 'InstaPay Secondary',
    identifier: '0102…',
    gl_account_code: '1114',
    cashbox_id: null,
    is_default: false,
    active: true,
    sort_order: 1,
    metadata: {},
    created_at: '',
    updated_at: '',
    created_by: null,
    updated_by: null,
  },
  {
    id: 'pa-wallet-1',
    method: 'wallet',
    provider_key: 'we_pay',
    display_name: 'WE Pay',
    identifier: null,
    gl_account_code: '1114',
    cashbox_id: null,
    is_default: true,
    active: true,
    sort_order: 0,
    metadata: { logo_data_url: 'data:image/png;base64,abc' },
    created_at: '',
    updated_at: '',
    created_by: null,
    updated_by: null,
  },
];

describe('autoSelectAccountForMethod — PR-FIN-PAYACCT-4C', () => {
  it('cash → returns null/null (cash never uses a payment_account)', () => {
    const out = autoSelectAccountForMethod('cash', ACCOUNTS);
    expect(out.id).toBeNull();
    expect(out.display_name).toBeNull();
  });

  it('prefers is_default account when multiple candidates', () => {
    const out = autoSelectAccountForMethod('instapay', ACCOUNTS);
    expect(out.id).toBe('pa-instapay-1'); // is_default=true
    expect(out.display_name).toBe('InstaPay Main');
  });

  it('returns the unique candidate when only 1 active account exists', () => {
    const out = autoSelectAccountForMethod('wallet', ACCOUNTS);
    expect(out.id).toBe('pa-wallet-1');
  });

  it('returns null when 0 candidates', () => {
    const out = autoSelectAccountForMethod('card_visa', ACCOUNTS);
    expect(out.id).toBeNull();
  });

  it('skips inactive accounts even when is_default=true', () => {
    const out = autoSelectAccountForMethod('instapay', [
      { ...ACCOUNTS[0], active: false }, // default but inactive
      ACCOUNTS[1], // active, not default
    ]);
    expect(out.id).toBe('pa-instapay-2');
  });
});

describe('visibleMethodsFor — PR-FIN-PAYACCT-4C', () => {
  it('always includes cash', () => {
    expect(visibleMethodsFor([])).toContain('cash');
  });

  it('includes a non-cash method only when an active account exists', () => {
    const visible = visibleMethodsFor(ACCOUNTS);
    expect(visible).toContain('instapay');
    expect(visible).toContain('wallet');
    expect(visible).not.toContain('card_visa'); // no card_visa account
    expect(visible).not.toContain('bank_transfer');
  });

  it('omits methods whose only account is inactive', () => {
    const visible = visibleMethodsFor([
      { ...ACCOUNTS[0], active: false },
    ] as PaymentAccount[]);
    expect(visible).not.toContain('instapay');
  });
});

describe('<PaymentAccountPicker /> — PR-FIN-PAYACCT-4C', () => {
  function renderPicker(props: Partial<Parameters<typeof PaymentAccountPicker>[0]> = {}) {
    const onSelect = vi.fn();
    const utils = render(
      <PaymentAccountPicker
        method="instapay"
        providers={PROVIDERS}
        accounts={ACCOUNTS.filter((a) => a.method === 'instapay' && a.active)}
        selected={null}
        blocked={false}
        needsManualPick={false}
        onSelect={onSelect}
        {...props}
      />,
    );
    return { ...utils, onSelect };
  }

  it('renders a row per active account with display_name + identifier', () => {
    renderPicker();
    expect(screen.getByText('InstaPay Main')).toBeInTheDocument();
    expect(screen.getByText('InstaPay Secondary')).toBeInTheDocument();
    // The default account gets the افتراضي badge
    expect(screen.getByText('افتراضي')).toBeInTheDocument();
  });

  it('renders the blocked banner when blocked=true (no row buttons)', () => {
    renderPicker({ blocked: true, accounts: [] });
    expect(screen.getByTestId('payment-account-blocked')).toBeInTheDocument();
    expect(screen.getByTestId('payment-account-blocked').textContent).toMatch(
      /لا يوجد حساب مفعل/,
    );
    // No row buttons render in the blocked state.
    expect(screen.queryByTestId(/^payment-account-row-/)).toBeNull();
  });

  it('clicking a row fires onSelect with id + account', () => {
    const { onSelect } = renderPicker();
    const row = screen.getByTestId('payment-account-row-pa-instapay-2');
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith(
      'pa-instapay-2',
      expect.objectContaining({ id: 'pa-instapay-2', display_name: 'InstaPay Secondary' }),
    );
  });

  it('renders the needs-manual-pick hint when needsManualPick=true', () => {
    renderPicker({ needsManualPick: true });
    expect(screen.getByTestId('payment-account-needs-pick')).toBeInTheDocument();
    expect(
      screen.getByTestId('payment-account-needs-pick').textContent,
    ).toMatch(/اختر حساب التحصيل/);
  });

  it('label override is honored (supplier-side uses "حساب الدفع")', () => {
    renderPicker({ label: 'حساب الدفع' });
    expect(screen.getByText('حساب الدفع')).toBeInTheDocument();
  });

  it('selected row gets the selected styling (visible via the data attribute)', () => {
    renderPicker({ selected: 'pa-instapay-1' });
    const selectedRow = screen.getByTestId('payment-account-row-pa-instapay-1');
    // The selected styling applies a "ring-2" or similar class — just
    // assert the className includes the selected variant token.
    expect(selectedRow.className).toMatch(/ring-2|brand-50|emerald/);
  });
});
