/**
 * PaymentAccountModal.wallet-display.test.tsx
 * PR-FIN-PAYMENTS-WALLET-DISPLAY-BALANCE
 *
 * Pins the cashbox dropdown contract for the "wallet 0.00 looked like
 * the wallet was empty" bug. Before this PR, when the operator picked
 * the wallet method and looked at "الخزنة المرتبطة (اختياري)", the
 * ewallet option showed "(محفظة · 0.00 ج.م)" — because the stored
 * cashboxes.current_balance is 0 for non-cash kinds (those payments
 * never write CTs). After the PR, the ewallet option must show the
 * GL-derived figure with a "(محاسبي)" suffix so the dropdown can
 * never imply the wallet drawer is empty.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type React from 'react';
import { PaymentAccountModal } from '../PaymentAccountModal';
import type { PaymentProvider } from '@/api/payments.api';
import type { Cashbox } from '@/api/cash-desk.api';

vi.mock('@/api/payments.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    paymentsApi: {
      createAccount: vi.fn(async () => ({})),
      updateAccount: vi.fn(async () => ({})),
    },
  };
});

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return {
    default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }),
  };
});

const PROVIDERS: PaymentProvider[] = [
  {
    provider_key: 'instapay', method: 'instapay',
    name_ar: 'إنستا باي', name_en: 'InstaPay',
    icon_name: 'smartphone', logo_key: 'instapay',
    default_gl_account_code: '1114', group: 'instapay', requires_reference: true,
  },
];

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

const CASH_BOX = makeCashbox({
  id: 'cb-cash', name_ar: 'الخزينة الرئيسية', kind: 'cash',
  current_balance: '5000.00',
});

// Production fixture-shape: خزنة التحويلات stores 0 EGP because non-cash
// payments don't write CTs. The new accounting_balance carries the real
// GL 1114 net (~2,190 EGP from the wallet/instapay invoice payments).
const EWALLET_BOX = makeCashbox({
  id: 'cb-ewallet', name_ar: 'خزنة التحويلات', kind: 'ewallet',
  current_balance: '0',
  accounting_balance: '2190.00',
  accounting_gl_code: '1114',
} as any);

// Edge case: BE shipped accounting_balance but the row has no GL link
// (the CASE expression in settings.service.ts shouldn't produce this in
// production, but the helper guards against it). Triggers kind='unlinked'
// — accounting_balance set + glCode null.
const EWALLET_BOX_UNLINKED = makeCashbox({
  id: 'cb-ewallet-unlinked', name_ar: 'خزنة محفظة بلا حساب', kind: 'ewallet',
  current_balance: '0',
  accounting_balance: '0',
  accounting_gl_code: null,
} as any);

function renderModal(props: Partial<React.ComponentProps<typeof PaymentAccountModal>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PaymentAccountModal
        mode="create"
        providers={PROVIDERS}
        cashboxes={[CASH_BOX, EWALLET_BOX, EWALLET_BOX_UNLINKED]}
        prefilledMethod="instapay"
        onClose={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('<PaymentAccountModal /> cashbox dropdown — PR-FIN-PAYMENTS-WALLET-DISPLAY-BALANCE', () => {
  it('ewallet option spells out "الرصيد المحاسبي: <amount>" (full sentence, not bare "(محاسبي)")', () => {
    // The instapay method maps to ewallet kind, so the dropdown is
    // populated with ewallet cashboxes only.
    renderModal();
    const select = screen.getByTestId('payment-account-modal-cashbox') as HTMLSelectElement;
    const ewalletOption = Array.from(select.options).find((o) => o.value === 'cb-ewallet');
    expect(ewalletOption).toBeDefined();
    // EXPLICIT label sentence, not just a "(محاسبي)" suffix.
    expect(ewalletOption!.textContent).toMatch(/الرصيد المحاسبي:\s*2,190\.00\s*ج\.م/);
    // Must NOT regress to bare "(محاسبي)" suffix or to "0.00 ج.م" headline.
    expect(ewalletOption!.textContent).not.toMatch(/\(محاسبي\)/);
    expect(ewalletOption!.textContent).not.toMatch(/·\s*0\.00\s*ج\.م/);
  });

  it('ewallet option without a GL link spells out "الرصيد المحاسبي" + "غير مربوط بحساب محاسبي"', () => {
    renderModal();
    const select = screen.getByTestId('payment-account-modal-cashbox') as HTMLSelectElement;
    const opt = Array.from(select.options).find((o) => o.value === 'cb-ewallet-unlinked');
    expect(opt).toBeDefined();
    // The label still names the *intended* balance kind (operator can
    // act on the warning) and the warning is appended.
    expect(opt!.textContent).toMatch(/الرصيد المحاسبي:/);
    expect(opt!.textContent).toMatch(/غير مربوط بحساب محاسبي/);
  });

  it('cash option spells out "رصيد الخزنة: <amount>" — never the accounting label', async () => {
    // Switching to method=cash filters the dropdown to cash kind only.
    renderModal({ prefilledMethod: undefined });
    fireEvent.change(screen.getByTestId('payment-account-modal-method'), {
      target: { value: 'cash' },
    });
    const select = screen.getByTestId('payment-account-modal-cashbox') as HTMLSelectElement;
    const cashOption = Array.from(select.options).find((o) => o.value === 'cb-cash');
    expect(cashOption).toBeDefined();
    expect(cashOption!.textContent).toMatch(/رصيد الخزنة:\s*5,000\.00\s*ج\.م/);
    // Cash MUST NOT carry the accounting label (would imply GL
    // semantics on a drawer figure that's already canonical).
    expect(cashOption!.textContent).not.toMatch(/الرصيد المحاسبي/);
    expect(cashOption!.textContent).not.toMatch(/\(محاسبي\)/);
    expect(cashOption!.textContent).not.toMatch(/غير مربوط بحساب محاسبي/);
  });
});
