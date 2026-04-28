/**
 * Invoices.edit-split-payment.test.tsx — PR-POS-PAY-2
 *
 * DOM-level integration tests for the multi-row payment editor on
 * the invoice-edit modal. Covers the user's required scenarios:
 *
 *   1. Existing single-row invoice loads as one row.
 *   2. Existing multi-row invoice loads as N rows.
 *   3. Splitting cash 350 → cash 200 + wallet 150 produces a 2-row
 *      `payments[]` in the API payload (the INV-2026-000116-style
 *      correction case the cashier would have reached for in-product
 *      after this PR ships).
 *   4. Zero / negative row blocks save and surfaces validation.
 *   5. Non-cash without `payment_account_id` blocks save when the
 *      method has accounts catalogued.
 *   6. `edit_reason` stays required and lands in the payload.
 *   7. The `invoices.edit_request` path uses the SAME payload
 *      builder (regression net for the approval workflow).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { InvoiceEditModal } from '../Invoices';
import { useAuthStore } from '@/stores/auth.store';

/* ────────────── Mocks ────────────── */

// Mocked POS API. The signatures match `frontend/src/api/pos.api.ts`
// closely enough for the tests but stay loose so vitest's call-args
// inference (`mock.calls[N]`) returns a useful tuple type instead of
// `unknown[]`.
const editMock = vi.fn(
  async (_id: string, _body: Record<string, unknown>) => ({
    invoice: {},
    edited: true,
  }),
);
const editRequestMock = vi.fn(
  async (_id: string, _body: Record<string, unknown>) => ({
    id: 1,
    invoice_id: 'inv-1',
    status: 'pending',
  }),
);
const getMock = vi.fn(async (_id: string): Promise<Record<string, unknown>> => ({}));

vi.mock('@/api/pos.api', () => ({
  posApi: {
    get: (id: string) => getMock(id),
    edit: (id: string, body: Record<string, unknown>) => editMock(id, body),
    submitEditRequest: (id: string, body: Record<string, unknown>) =>
      editRequestMock(id, body),
    editHistory: vi.fn(async () => []),
  },
}));

const accountsFixture = [
  {
    id: 'acct-wallet-we-pay',
    method: 'wallet',
    provider_key: 'we_pay',
    display_name: 'WE Pay',
    identifier: '01004888879',
    gl_account_code: '1114',
    is_default: true,
    active: true,
    sort_order: 1,
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

const providersFixture = [
  { method: 'cash', name_ar: 'كاش', provider_key: 'cash', icon_name: '', logo_key: 'cash' },
  { method: 'wallet', name_ar: 'محفظة', provider_key: 'we_pay', icon_name: '', logo_key: 'wallet' },
];

vi.mock('@/api/payments.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    paymentsApi: {
      listProviders: vi.fn(async () => providersFixture),
      listAccounts: vi.fn(async () => accountsFixture),
    },
  };
});

vi.mock('@/api/users.api', () => ({
  usersApi: {
    list: vi.fn(async () => []),
  },
}));

vi.mock('@/api/products.api', () => ({
  productsApi: {
    list: vi.fn(async () => []),
  },
}));

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return {
    default: Object.assign(fn, {
      error: vi.fn(),
      success: vi.fn(),
    }),
  };
});

/* ────────────── Fixtures + helpers ────────────── */

function makeInvoice(overrides: Record<string, unknown> = {}) {
  return {
    id: '44e7effa-da2a-4e48-a409-0291edaa19ee',
    invoice_no: 'INV-2026-000116',
    grand_total: 350,
    paid_total: 350,
    invoice_discount: 0,
    notes: '',
    warehouse_id: 'b533200b-ec23-4cb8-a539-8c78e3679f78',
    salesperson_id: '3157e667-1d6f-4d89-97af-1166dc5a9fe7',
    customer_id: null,
    items: [
      {
        variant_id: '5a143eb7-0f24-42b3-8431-5e1c5a1a25be',
        product_name_snapshot: 'كوتش',
        sku_snapshot: '6121',
        quantity: 1,
        unit_price: 350,
        discount_amount: 0,
      },
    ],
    payments: [
      { payment_method: 'cash', amount: 350, payment_account_id: null },
    ],
    ...overrides,
  };
}

function setUserPermissions(perms: string[]) {
  // The auth store's `hasPermission` reads from `user.permissions`.
  useAuthStore.setState({
    user: {
      id: 'tester',
      role: 'cashier',
      permissions: perms,
    } as any,
  });
}

function renderEditModal(invoiceData: Record<string, unknown>) {
  getMock.mockResolvedValue(invoiceData);
  const onClose = vi.fn();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    onClose,
    ...render(
      <QueryClientProvider client={qc}>
        <InvoiceEditModal invoiceId={(invoiceData as any).id} onClose={onClose} />
      </QueryClientProvider>,
    ),
  };
}

async function waitForPaymentRows() {
  // The editor mounts after `posApi.get` resolves. Wait for at least
  // one `payment-row` testid to appear before asserting.
  await waitFor(() => {
    expect(screen.getAllByTestId('payment-row').length).toBeGreaterThan(0);
  });
}

/* ────────────── Tests ────────────── */

describe('<InvoiceEditModal /> — PR-POS-PAY-2 multi-row payments', () => {
  beforeEach(() => {
    editMock.mockClear();
    editRequestMock.mockClear();
    getMock.mockReset();
    setUserPermissions(['invoices.edit']);
  });

  it('loads an invoice with a single existing payment as one row', async () => {
    renderEditModal(makeInvoice());
    await waitForPaymentRows();
    const rows = screen.getAllByTestId('payment-row');
    expect(rows).toHaveLength(1);
    const amount = screen.getByTestId('payment-row-amount-0') as HTMLInputElement;
    expect(Number(amount.value)).toBe(350);
    // Single row → no remove button.
    expect(screen.queryByTestId('payment-row-remove-0')).toBeNull();
  });

  it('loads an invoice with multiple existing payments as N rows', async () => {
    renderEditModal(
      makeInvoice({
        payments: [
          { payment_method: 'cash', amount: 200, payment_account_id: null },
          {
            payment_method: 'wallet',
            amount: 150,
            payment_account_id: 'acct-wallet-we-pay',
            payment_account_snapshot: { display_name: 'WE Pay' },
          },
        ],
      }),
    );
    await waitForPaymentRows();
    const rows = screen.getAllByTestId('payment-row');
    expect(rows).toHaveLength(2);
    expect(
      Number(
        (screen.getByTestId('payment-row-amount-0') as HTMLInputElement).value,
      ),
    ).toBe(200);
    expect(
      Number(
        (screen.getByTestId('payment-row-amount-1') as HTMLInputElement).value,
      ),
    ).toBe(150);
  });

  it('PR-POS-PAY-2 critical case: split cash 350 → cash 200 + wallet 150 sends 2 rows to posApi.edit', async () => {
    renderEditModal(makeInvoice()); // 1 cash row, 350.
    await waitForPaymentRows();

    // Lower the cash row from 350 to 200.
    fireEvent.change(screen.getByTestId('payment-row-amount-0'), {
      target: { value: '200' },
    });
    // Add a second row → defaults to cash 150 (remaining).
    fireEvent.click(screen.getByTestId('payment-add-row'));
    expect(screen.getAllByTestId('payment-row')).toHaveLength(2);
    expect(
      Number(
        (screen.getByTestId('payment-row-amount-1') as HTMLInputElement).value,
      ),
    ).toBe(150);

    // Switch the second row's method to wallet. The method grid
    // renders one `<span>محفظة إلكترونية</span>` per visible method
    // per row, so we scope the lookup to the second row's card and
    // click the matching <button>. The editor's auto-pick chooses
    // the default-active account (WE Pay) since it's the only
    // wallet account in the fixture.
    const secondRowCard = screen.getAllByTestId('payment-row')[1];
    const walletLabelInSecondRow = Array.from(
      secondRowCard.querySelectorAll('span'),
    ).find((span) => span.textContent?.trim() === 'محفظة إلكترونية');
    expect(walletLabelInSecondRow).toBeDefined();
    fireEvent.click(walletLabelInSecondRow!.closest('button')!);

    // Type a reason (required by the edit modal).
    fireEvent.change(
      screen.getByPlaceholderText('مثال: تصحيح كمية / تعديل سعر / إلخ'),
      {
        target: {
          value:
            'تصحيح وسيلة دفع فاتورة INV-2026-000116 — الصحيح 200 كاش + 150 وي باي',
        },
      },
    );

    // Click save. The button is gated on validation.ok, which is
    // true here (cash 200 + wallet 150 = 350 grand, account auto-selected).
    fireEvent.click(screen.getByTestId('invoice-edit-save'));

    await waitFor(() => {
      expect(editMock).toHaveBeenCalledTimes(1);
    });
    const [invoiceId, payload] = editMock.mock.calls[0] as unknown as [
      string,
      {
        payments: Array<{
          payment_method: string;
          amount: number;
          payment_account_id?: string;
        }>;
        edit_reason?: string;
      },
    ];
    expect(invoiceId).toBe('44e7effa-da2a-4e48-a409-0291edaa19ee');
    expect(payload.payments).toHaveLength(2);
    expect(payload.payments[0]).toMatchObject({
      payment_method: 'cash',
      amount: 200,
    });
    expect(payload.payments[1]).toMatchObject({
      payment_method: 'wallet',
      amount: 150,
      payment_account_id: 'acct-wallet-we-pay',
    });
    expect(payload.edit_reason).toMatch(/200 كاش/);
    expect(payload.edit_reason).toMatch(/150 وي باي/);
  });

  it('blocks save when a row has zero amount (validation banner + disabled button)', async () => {
    renderEditModal(makeInvoice());
    await waitForPaymentRows();

    // Set the only row's amount to 0.
    fireEvent.change(screen.getByTestId('payment-row-amount-0'), {
      target: { value: '0' },
    });
    // Type a reason so we know payment validation is the blocker.
    fireEvent.change(
      screen.getByPlaceholderText('مثال: تصحيح كمية / تعديل سعر / إلخ'),
      { target: { value: 'تجربة' } },
    );

    expect(screen.getByTestId('payment-validation-error').textContent).toMatch(
      /المبلغ يجب أن يكون أكبر من صفر/,
    );
    const saveBtn = screen.getByTestId('invoice-edit-save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    fireEvent.click(saveBtn);
    expect(editMock).not.toHaveBeenCalled();
  });

  it('blocks save when a non-cash row has no payment_account_id but accounts exist for the method', async () => {
    // Load an invoice that already has a wallet row with a null
    // account_id — this is the closest fixture to what a real
    // cashier would face if they swapped methods on a fresh row
    // and didn't manually pick an account.
    renderEditModal(
      makeInvoice({
        payments: [
          { payment_method: 'cash', amount: 200, payment_account_id: null },
          {
            payment_method: 'wallet',
            amount: 150,
            payment_account_id: null, // no account picked
          },
        ],
      }),
    );
    await waitForPaymentRows();

    // Required reason so we isolate the payment-side block.
    fireEvent.change(
      screen.getByPlaceholderText('مثال: تصحيح كمية / تعديل سعر / إلخ'),
      { target: { value: 'تجربة' } },
    );

    // The editor's banner depends on the accounts query having
    // resolved (so `isAccountRequired('wallet')` returns true). Wait
    // for it before asserting.
    await waitFor(() => {
      expect(
        screen.getByTestId('payment-validation-error').textContent,
      ).toMatch(/تحتاج اختيار حساب الدفع/);
    });
    const saveBtn = screen.getByTestId('invoice-edit-save') as HTMLButtonElement;
    expect(saveBtn.disabled).toBe(true);
    fireEvent.click(saveBtn);
    expect(editMock).not.toHaveBeenCalled();
  });

  it('keeps edit_reason as a required field — empty reason does not save and the payment validation gate does not bypass it', async () => {
    renderEditModal(makeInvoice());
    await waitForPaymentRows();

    // Payments are valid (default 1 cash row at 350) but reason is
    // empty → save must not fire.
    const saveBtn = screen.getByTestId('invoice-edit-save') as HTMLButtonElement;
    fireEvent.click(saveBtn);
    expect(editMock).not.toHaveBeenCalled();

    // After typing a reason, save fires (and reason is in the payload).
    fireEvent.change(
      screen.getByPlaceholderText('مثال: تصحيح كمية / تعديل سعر / إلخ'),
      { target: { value: 'سبب صالح' } },
    );
    fireEvent.click(saveBtn);
    await waitFor(() => expect(editMock).toHaveBeenCalledTimes(1));
    const [, payload] = editMock.mock.calls[0] as unknown as [
      string,
      { edit_reason?: string },
    ];
    expect(payload.edit_reason).toBe('سبب صالح');
  });

  it('routes through posApi.submitEditRequest with the same multi-row payload when the user only has invoices.edit_request', async () => {
    setUserPermissions(['invoices.edit_request']); // no direct edit
    renderEditModal(makeInvoice());
    await waitForPaymentRows();

    // Split into two cash rows: 200 + 150.
    fireEvent.change(screen.getByTestId('payment-row-amount-0'), {
      target: { value: '200' },
    });
    fireEvent.click(screen.getByTestId('payment-add-row'));
    expect(
      Number(
        (screen.getByTestId('payment-row-amount-1') as HTMLInputElement).value,
      ),
    ).toBe(150);

    fireEvent.change(
      screen.getByPlaceholderText('مثال: تصحيح كمية / تعديل سعر / إلخ'),
      { target: { value: 'طلب موافقة' } },
    );
    fireEvent.click(screen.getByTestId('invoice-edit-save'));

    await waitFor(() => {
      expect(editRequestMock).toHaveBeenCalledTimes(1);
    });
    expect(editMock).not.toHaveBeenCalled();
    const [, payload] = editRequestMock.mock.calls[0] as unknown as [
      string,
      { payments: Array<{ amount: number }> },
    ];
    expect(payload.payments).toHaveLength(2);
    expect(payload.payments.map((p) => p.amount)).toEqual([200, 150]);
  });

  it('preserves invoice line content unchanged when only payments are edited', async () => {
    renderEditModal(makeInvoice());
    await waitForPaymentRows();

    // Touch only payments + reason. Lines untouched.
    fireEvent.change(screen.getByTestId('payment-row-amount-0'), {
      target: { value: '200' },
    });
    fireEvent.click(screen.getByTestId('payment-add-row'));
    fireEvent.change(
      screen.getByPlaceholderText('مثال: تصحيح كمية / تعديل سعر / إلخ'),
      { target: { value: 'تصحيح دفع فقط' } },
    );
    fireEvent.click(screen.getByTestId('invoice-edit-save'));

    await waitFor(() => expect(editMock).toHaveBeenCalledTimes(1));
    const [, payload] = editMock.mock.calls[0] as unknown as [
      string,
      { lines: Array<{ variant_id: string; qty: number; unit_price: number }> },
    ];
    expect(payload.lines).toHaveLength(1);
    expect(payload.lines[0]).toMatchObject({
      variant_id: '5a143eb7-0f24-42b3-8431-5e1c5a1a25be',
      qty: 1,
      unit_price: 350,
    });
  });
});

// Re-export `act` so the dev console doesn't complain about
// untranslated effects during teardown — the auth store mutations
// happen outside React's event loop.
void act;
