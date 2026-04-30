/**
 * PaymentAccountModal.test.tsx — PR-FIN-PAYACCT-4B
 *
 * Pins the create / edit modal behavior:
 *
 *   ✓ method dropdown lists 10 admin-relevant methods including 'check'
 *   ✓ method dropdown is disabled in edit mode
 *   ✓ the identifier label changes per method (IBAN / Terminal ID /
 *     رقم الهاتف / رقم دفتر الشيكات / …)
 *   ✓ the cashbox dropdown is filtered by the kind the method maps to
 *     (cash → 'cash', bank_transfer → 'bank', wallet → 'ewallet',
 *     check → 'check')
 *   ✓ create submit POSTs the right payload
 *   ✓ edit submit PATCHes the right payload
 *   ✓ Arabic validation: missing display_name shows toast and does
 *     NOT call the API
 *
 * Locks the regression: anyone trimming the cheque flow or the
 * cashbox-kind filter fails CI.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PaymentAccountModal } from '../PaymentAccountModal';
import type {
  PaymentAccount,
  PaymentProvider,
} from '@/api/payments.api';
import type { Cashbox } from '@/api/cash-desk.api';

const createAccountMock = vi.fn(async (_body: any) => ({}));
const updateAccountMock = vi.fn(async (_id: string, _body: any) => ({}));

vi.mock('@/api/payments.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    paymentsApi: {
      createAccount: (body: any) => createAccountMock(body),
      updateAccount: (id: string, body: any) => updateAccountMock(id, body),
    },
  };
});

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return {
    default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }),
  };
});

// We import the mocked toast to inspect calls (vi.mock is hoisted).
import toast from 'react-hot-toast';
import type React from 'react';

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
    provider_key: 'cib',
    method: 'bank_transfer',
    name_ar: 'CIB',
    name_en: 'CIB',
    icon_name: 'building',
    logo_key: 'cib',
    default_gl_account_code: '1113',
    group: 'bank',
    requires_reference: true,
  },
  {
    provider_key: 'check_other',
    method: 'check',
    name_ar: 'شيكات',
    name_en: 'Cheques',
    icon_name: 'file-check',
    logo_key: 'check_other',
    default_gl_account_code: '1115',
    group: 'bank',
    requires_reference: true,
  },
];

const CASHBOXES: Cashbox[] = [
  {
    id: 'cb-cash',
    name: 'الخزينة الرئيسية',
    name_ar: 'الخزينة الرئيسية',
    warehouse_id: null,
    currency: 'EGP',
    current_balance: '5000',
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
  },
  {
    id: 'cb-bank',
    name: 'بنك CIB',
    name_ar: 'بنك CIB',
    warehouse_id: null,
    currency: 'EGP',
    current_balance: '0',
    is_active: true,
    kind: 'bank',
    institution_code: 'cib',
    institution_name: 'CIB',
    institution_name_en: 'CIB',
    institution_domain: null,
    institution_color: null,
    institution_kind: 'bank',
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
  },
  {
    id: 'cb-ewallet',
    name: 'محفظة WE',
    name_ar: 'محفظة WE',
    warehouse_id: null,
    currency: 'EGP',
    current_balance: '0',
    is_active: true,
    kind: 'ewallet',
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
  },
  {
    id: 'cb-check',
    name: 'دفتر الشيكات',
    name_ar: 'دفتر الشيكات',
    warehouse_id: null,
    currency: 'EGP',
    current_balance: '0',
    is_active: true,
    kind: 'check',
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
  },
];

function renderModal(props: Partial<React.ComponentProps<typeof PaymentAccountModal>> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <PaymentAccountModal
        mode="create"
        providers={PROVIDERS}
        cashboxes={CASHBOXES}
        onClose={vi.fn()}
        {...props}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  createAccountMock.mockClear();
  updateAccountMock.mockClear();
  vi.mocked(toast.error).mockClear();
  vi.mocked(toast.success).mockClear();
});

describe('<PaymentAccountModal /> — PR-FIN-PAYACCT-4B', () => {
  it('renders the method dropdown with 10 admin methods including check', () => {
    renderModal();
    const sel = screen.getByTestId('payment-account-modal-method') as HTMLSelectElement;
    expect(sel.options.length).toBe(10);
    const values = Array.from(sel.options).map((o) => o.value);
    expect(values).toContain('cash');
    expect(values).toContain('check');
    expect(values).toContain('instapay');
    expect(values).toContain('wallet');
    expect(values).toContain('bank_transfer');
    expect(values).toContain('card_visa');
    expect(values).not.toContain('credit');
    expect(values).not.toContain('other');
  });

  it('disables the method dropdown in edit mode', () => {
    const account: PaymentAccount = {
      id: 'acct-edit',
      method: 'instapay',
      provider_key: 'instapay',
      display_name: 'InstaPay Existing',
      identifier: '01000000000',
      gl_account_code: '1114',
      cashbox_id: null,
      is_default: true,
      active: true,
      sort_order: 1,
      metadata: {},
      created_at: '',
      updated_at: '',
      created_by: null,
      updated_by: null,
    };
    renderModal({ mode: 'edit', account });
    const sel = screen.getByTestId('payment-account-modal-method') as HTMLSelectElement;
    expect(sel.disabled).toBe(true);
  });

  it('changes the identifier label per method', () => {
    renderModal({ prefilledMethod: 'instapay' });
    expect(
      screen.getByText(/رقم الهاتف \/ Handle/),
    ).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('payment-account-modal-method'), {
      target: { value: 'bank_transfer' },
    });
    expect(screen.getByText(/IBAN \/ رقم الحساب/)).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('payment-account-modal-method'), {
      target: { value: 'card_visa' },
    });
    expect(screen.getByText(/Terminal ID/)).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('payment-account-modal-method'), {
      target: { value: 'check' },
    });
    expect(
      screen.getByText(/رقم دفتر الشيكات \/ البنك/),
    ).toBeInTheDocument();
  });

  it('filters the cashbox dropdown by the method group', () => {
    renderModal({ prefilledMethod: 'bank_transfer' });
    const sel = screen.getByTestId('payment-account-modal-cashbox') as HTMLSelectElement;
    const values = Array.from(sel.options).map((o) => o.value);
    // Only the empty option + the one bank cashbox should be present.
    expect(values).toEqual(['', 'cb-bank']);

    fireEvent.change(screen.getByTestId('payment-account-modal-method'), {
      target: { value: 'check' },
    });
    const sel2 = screen.getByTestId('payment-account-modal-cashbox') as HTMLSelectElement;
    const values2 = Array.from(sel2.options).map((o) => o.value);
    expect(values2).toEqual(['', 'cb-check']);

    fireEvent.change(screen.getByTestId('payment-account-modal-method'), {
      target: { value: 'wallet' },
    });
    const sel3 = screen.getByTestId('payment-account-modal-cashbox') as HTMLSelectElement;
    const values3 = Array.from(sel3.options).map((o) => o.value);
    expect(values3).toEqual(['', 'cb-ewallet']);
  });

  it('blocks save when display_name is empty (Arabic toast, no API call)', () => {
    renderModal({ prefilledMethod: 'wallet' });
    fireEvent.click(screen.getByTestId('payment-account-modal-submit'));
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining('اسم الحساب'));
    expect(createAccountMock).not.toHaveBeenCalled();
  });

  it('POSTs the right payload on create submit', async () => {
    renderModal({ prefilledMethod: 'check' });
    fireEvent.change(screen.getByTestId('payment-account-modal-display-name'), {
      target: { value: 'دفتر شيكات NBE' },
    });
    fireEvent.change(screen.getByTestId('payment-account-modal-identifier'), {
      target: { value: 'NBE-123' },
    });
    fireEvent.change(screen.getByTestId('payment-account-modal-cashbox'), {
      target: { value: 'cb-check' },
    });
    fireEvent.click(screen.getByTestId('payment-account-modal-submit'));

    await waitFor(() => {
      expect(createAccountMock).toHaveBeenCalledTimes(1);
    });
    const body = createAccountMock.mock.calls[0][0];
    expect(body.method).toBe('check');
    expect(body.display_name).toBe('دفتر شيكات NBE');
    expect(body.identifier).toBe('NBE-123');
    expect(body.gl_account_code).toBe('1115');
    expect(body.active).toBe(true);
  });

  it('PATCHes the right payload on edit submit (method is locked)', async () => {
    const account: PaymentAccount = {
      id: 'acct-edit',
      method: 'instapay',
      provider_key: 'instapay',
      display_name: 'InstaPay Old',
      identifier: '01000000000',
      gl_account_code: '1114',
      cashbox_id: null,
      is_default: true,
      active: true,
      sort_order: 1,
      metadata: {},
      created_at: '',
      updated_at: '',
      created_by: null,
      updated_by: null,
    };
    renderModal({ mode: 'edit', account });

    fireEvent.change(screen.getByTestId('payment-account-modal-display-name'), {
      target: { value: 'InstaPay New' },
    });
    fireEvent.click(screen.getByTestId('payment-account-modal-submit'));

    await waitFor(() => {
      expect(updateAccountMock).toHaveBeenCalledTimes(1);
    });
    const [id, body] = updateAccountMock.mock.calls[0];
    expect(id).toBe('acct-edit');
    expect(body.display_name).toBe('InstaPay New');
    // method is intentionally NOT in the PATCH payload — it cannot change.
    expect(body.method).toBeUndefined();
    expect(createAccountMock).not.toHaveBeenCalled();
  });

  // ─── PR-FIN-PAYACCT-4D-UX-FIX-2: cashbox dropdown ─────────────
  it('PR-4D-UX-FIX-2: shows the empty-state when no compatible cashbox exists', () => {
    // No bank-kind cashbox in the fixture — bank_transfer method has none.
    const cashboxesNoneBank: typeof CASHBOXES = CASHBOXES.filter((cb) => cb.kind !== 'bank');
    renderModal({
      prefilledMethod: 'bank_transfer',
      cashboxes: cashboxesNoneBank,
    });
    expect(screen.getByTestId('payment-account-modal-cashbox-empty')).toBeInTheDocument();
    expect(
      screen.getByText(/لا توجد خزنة مناسبة لهذا النوع/),
    ).toBeInTheDocument();
  });

  it('PR-4D-UX-FIX-2: empty-state action calls onCreateCashbox with the right kind + method', () => {
    const onCreateCashbox = vi.fn();
    const cashboxesNoneBank: typeof CASHBOXES = CASHBOXES.filter((cb) => cb.kind !== 'bank');
    renderModal({
      prefilledMethod: 'bank_transfer',
      cashboxes: cashboxesNoneBank,
      onCreateCashbox,
    });
    fireEvent.click(screen.getByTestId('payment-account-modal-cashbox-create'));
    // PR-4D-UX-FIX-4: callback now also receives the current method so
    // the parent can pre-fill a method-specific suggested name.
    expect(onCreateCashbox).toHaveBeenCalledWith('bank', 'bank_transfer');
  });

  it('PR-4D-UX-FIX-2: create payload includes cashbox_id (null when not linked)', async () => {
    renderModal({ prefilledMethod: 'wallet' });
    // Set required fields. Since cashbox auto-selects (one matching ewallet), the
    // payload's cashbox_id should reflect that.
    fireEvent.change(screen.getByTestId('payment-account-modal-display-name'), {
      target: { value: 'My Wallet' },
    });
    fireEvent.click(screen.getByTestId('payment-account-modal-submit'));
    await waitFor(() => expect(createAccountMock).toHaveBeenCalledTimes(1));
    const body = createAccountMock.mock.calls[0][0];
    // cashbox_id is on the payload (not undefined) — value is the auto-picked
    // ewallet cashbox id from the fixture.
    expect(Object.prototype.hasOwnProperty.call(body, 'cashbox_id')).toBe(true);
    expect(body.cashbox_id).toBe('cb-ewallet');
  });

  it('PR-4D-UX-FIX-2: clearing the cashbox sends cashbox_id: null', async () => {
    renderModal({ prefilledMethod: 'wallet' });
    fireEvent.change(screen.getByTestId('payment-account-modal-display-name'), {
      target: { value: 'My Wallet' },
    });
    // Auto-pick selected cb-ewallet. Operator manually clears to "— بدون ربط —".
    fireEvent.change(screen.getByTestId('payment-account-modal-cashbox'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByTestId('payment-account-modal-submit'));
    await waitFor(() => expect(createAccountMock).toHaveBeenCalledTimes(1));
    const body = createAccountMock.mock.calls[0][0];
    expect(body.cashbox_id).toBeNull();
  });

  it('PR-4D-UX-FIX-2: edit payload includes cashbox_id (preserves the pin)', async () => {
    const account: PaymentAccount = {
      id: 'acct-edit',
      method: 'bank_transfer',
      provider_key: null,
      display_name: 'Bank Account',
      identifier: 'EG12',
      gl_account_code: '1113',
      cashbox_id: 'cb-bank',
      is_default: true,
      active: true,
      sort_order: 1,
      metadata: {},
      created_at: '', updated_at: '',
      created_by: null, updated_by: null,
    };
    renderModal({ mode: 'edit', account });
    fireEvent.click(screen.getByTestId('payment-account-modal-submit'));
    await waitFor(() => expect(updateAccountMock).toHaveBeenCalledTimes(1));
    const [, body] = updateAccountMock.mock.calls[0];
    expect(body.cashbox_id).toBe('cb-bank');
  });

  it('PR-4D-UX-FIX-2: edit mode keeps an inactive linked cashbox visible in the dropdown', () => {
    // Mark cb-bank as inactive in the fixtures.
    const cashboxesInactiveBank = CASHBOXES.map((cb) =>
      cb.id === 'cb-bank' ? { ...cb, is_active: false } : cb,
    );
    const account: PaymentAccount = {
      id: 'acct-edit', method: 'bank_transfer', provider_key: null,
      display_name: 'Bank Account', identifier: 'EG12', gl_account_code: '1113',
      cashbox_id: 'cb-bank', is_default: true, active: true, sort_order: 1,
      metadata: {}, created_at: '', updated_at: '', created_by: null, updated_by: null,
    };
    renderModal({ mode: 'edit', account, cashboxes: cashboxesInactiveBank });
    const sel = screen.getByTestId('payment-account-modal-cashbox') as HTMLSelectElement;
    const option = Array.from(sel.options).find((o) => o.value === 'cb-bank');
    expect(option).toBeDefined();
    expect(option!.textContent).toMatch(/غير نشطة/);
  });

  it('PR-4D-UX-FIX-2: bank method shows only bank cashboxes (kind compatibility)', () => {
    renderModal({ prefilledMethod: 'bank_transfer' });
    const sel = screen.getByTestId('payment-account-modal-cashbox') as HTMLSelectElement;
    const values = Array.from(sel.options).map((o) => o.value);
    expect(values).toEqual(['', 'cb-bank']);
  });

  /* PR-FIN-PAYACCT-4D-UX-FIX-8 — defensive cashbox_id sanitization
   * ------------------------------------------------------------------
   * Production threw `invalid input syntax for type uuid: "undefined"`
   * on the payment_accounts UPDATE path. The PaymentAccountModal sends
   * `cashbox_id` on every save; the new mutationFn sanitizes via
   * `uuidOrNull` so the literal strings `"undefined"` / `"null"` /
   * whitespace can never reach the backend even if upstream form
   * state corrupts. */
  it('PR-FIN-PAYACCT-4D-UX-FIX-8: create payload — cashbox_id sentinel never reaches the wire', async () => {
    // Wallet method with the auto-selected cashbox manually cleared
    // so cashboxId state is null. Then assert the payload sends null,
    // never the literal string "undefined" / "null".
    renderModal({ prefilledMethod: 'wallet' });
    fireEvent.change(screen.getByTestId('payment-account-modal-display-name'), {
      target: { value: 'My Wallet' },
    });
    fireEvent.change(screen.getByTestId('payment-account-modal-cashbox'), {
      target: { value: '' },
    });
    fireEvent.click(screen.getByTestId('payment-account-modal-submit'));
    await waitFor(() => expect(createAccountMock).toHaveBeenCalledTimes(1));
    const body = createAccountMock.mock.calls[0][0];
    expect(body.cashbox_id).toBeNull();
    // No payload value anywhere can be the literal sentinel.
    for (const v of Object.values(body)) {
      expect(v).not.toBe('undefined');
      expect(v).not.toBe('null');
    }
  });

  it('PR-FIN-PAYACCT-4D-UX-FIX-8: edit payload — cashbox_id sentinel never reaches the wire', async () => {
    const account: PaymentAccount = {
      id: 'acct-fix8',
      method: 'wallet',
      provider_key: 'we_pay',
      display_name: 'WE Pay',
      identifier: '0100',
      gl_account_code: '1114',
      cashbox_id: null,
      is_default: false,
      active: true,
      sort_order: 0,
      metadata: {},
      created_at: '', updated_at: '',
      created_by: null, updated_by: null,
    };
    renderModal({ mode: 'edit', account });
    // Save without changing anything — cashboxId stays null.
    fireEvent.click(screen.getByTestId('payment-account-modal-submit'));
    await waitFor(() => expect(updateAccountMock).toHaveBeenCalledTimes(1));
    const [, body] = updateAccountMock.mock.calls[0];
    expect(body.cashbox_id).toBeNull();
    for (const v of Object.values(body)) {
      expect(v).not.toBe('undefined');
      expect(v).not.toBe('null');
    }
  });
});
