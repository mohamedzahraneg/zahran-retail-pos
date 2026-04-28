/**
 * POS.split-payment.test.tsx — PR-POS-PAY-1
 *
 * DOM-level tests for the new multi-row PaymentModal. Pin the
 * behaviors the cashier relies on:
 *
 *   1. Default state is one cash row prefilled with grand_total
 *      (legacy single-payment compat).
 *   2. "+ إضافة وسيلة دفع" appends a row.
 *   3. Removing a row works once there are 2+ rows.
 *   4. Confirm button is disabled while the validation fails and
 *      enabled once Σ payments + account selection are valid.
 *   5. On confirm, `cart.setPayments` receives a multi-element
 *      array containing every row.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PaymentModal } from '../POS';
import { useCartStore } from '@/stores/cart.store';

// Keep the modal isolated — mock the payments API so we don't
// depend on the backend or react-query refetch lifecycle.
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

const providersFixture = [
  { method: 'cash', name_ar: 'كاش', provider_key: 'cash', icon_name: '', logo_key: 'cash' },
  { method: 'instapay', name_ar: 'إنستا باي', provider_key: 'instapay', icon_name: '', logo_key: 'instapay' },
];

const accountsFixture = [
  {
    id: 'acct-instapay-1',
    method: 'instapay',
    provider_key: 'instapay',
    display_name: 'InstaPay الأهلي',
    identifier: 'ahly@instapay',
    gl_account_code: '1114',
    is_default: true,
    active: true,
    sort_order: 1,
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

function renderModal({
  grandTotal = 1000,
  onConfirm = vi.fn(),
  onClose = vi.fn(),
}: {
  grandTotal?: number;
  // PR-POS-PAY-1-HOTFIX-1 — `onConfirm` now receives the freshly-built
  // drafts list. Existing tests that pass `vi.fn()` keep working since
  // mocks accept any signature; new regression tests below assert on
  // the argument explicitly.
  onConfirm?: (...args: unknown[]) => void;
  onClose?: () => void;
} = {}) {
  // Seed a one-line cart so grandTotal is not zero when the modal
  // mounts. The cart store is global; we use setState directly.
  useCartStore.setState({
    items: [
      {
        variantId: 'v-1',
        productId: 'p-1',
        sku: 'SKU-1',
        productCode: 'PR-1',
        name: 'Test',
        color: null,
        size: null,
        qty: 1,
        unitPrice: grandTotal,
        costPrice: 0,
        discount: 0,
        notes: '',
      },
    ],
    payments: [],
    customer: null,
    salesperson: null,
    warehouse: null,
    manualDiscountType: 'value',
    manualDiscountInput: 0,
    notes: '',
    coupon: null,
    loyalty: null,
  } as any);

  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <PaymentModal
        onClose={onClose}
        onConfirm={onConfirm}
        isPending={false}
      />
    </QueryClientProvider>,
  );
}

describe('<PaymentModal /> — PR-POS-PAY-1 split payments', () => {
  beforeEach(() => {
    useCartStore.setState({ payments: [] } as any);
  });

  it('renders one default cash row prefilled with grand total', () => {
    renderModal({ grandTotal: 1000 });
    const rows = screen.getAllByTestId('payment-row');
    expect(rows).toHaveLength(1);
    const amount = screen.getByTestId('payment-row-amount-0') as HTMLInputElement;
    expect(Number(amount.value)).toBe(1000);
    // Only one row → no remove button visible.
    expect(screen.queryByTestId('payment-row-remove-0')).toBeNull();
  });

  it('clicking "+ إضافة وسيلة دفع" appends a row and exposes its amount input', () => {
    renderModal({ grandTotal: 1000 });
    fireEvent.click(screen.getByTestId('payment-add-row'));
    const rows = screen.getAllByTestId('payment-row');
    expect(rows).toHaveLength(2);
    expect(screen.getByTestId('payment-row-amount-1')).toBeInTheDocument();
    // Both rows now show a remove button.
    expect(screen.getByTestId('payment-row-remove-0')).toBeInTheDocument();
    expect(screen.getByTestId('payment-row-remove-1')).toBeInTheDocument();
  });

  it('removing a row reduces the count back to 1 and hides the remove buttons', () => {
    renderModal({ grandTotal: 1000 });
    fireEvent.click(screen.getByTestId('payment-add-row'));
    expect(screen.getAllByTestId('payment-row')).toHaveLength(2);
    fireEvent.click(screen.getByTestId('payment-row-remove-1'));
    expect(screen.getAllByTestId('payment-row')).toHaveLength(1);
    // Single row again → no remove button.
    expect(screen.queryByTestId('payment-row-remove-0')).toBeNull();
  });

  it('confirm is enabled when default cash row equals grand total', () => {
    renderModal({ grandTotal: 1000 });
    const confirm = screen.getByTestId('payment-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
  });

  it('confirm is DISABLED when a row has zero amount', () => {
    renderModal({ grandTotal: 1000 });
    const amount = screen.getByTestId('payment-row-amount-0') as HTMLInputElement;
    fireEvent.change(amount, { target: { value: '0' } });
    const confirm = screen.getByTestId('payment-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    // Validation message surfaces.
    expect(screen.getByTestId('payment-validation-error')).toBeInTheDocument();
  });

  it('summary panel updates as the cashier edits row amounts', () => {
    renderModal({ grandTotal: 1000 });
    // Default = 1000 cash → fully paid, no remaining. Strip comma
    // separators from the formatted number before matching.
    const stripCommas = (s: string | null) => (s ?? '').replace(/,/g, '');
    expect(stripCommas(screen.getByTestId('payment-summary-paid').textContent)).toMatch(
      /1000/,
    );
    // Lower the cash to 600 → remaining 400 surfaces.
    fireEvent.change(screen.getByTestId('payment-row-amount-0'), {
      target: { value: '600' },
    });
    expect(stripCommas(screen.getByTestId('payment-summary-paid').textContent)).toMatch(
      /600/,
    );
    expect(
      stripCommas(screen.getByTestId('payment-summary-remaining').textContent),
    ).toMatch(/400/);
  });

  it('confirm dispatches a multi-element array to cart.setPayments when split', async () => {
    const onConfirm = vi.fn();
    renderModal({ grandTotal: 1000, onConfirm });
    // Lower the default cash row to 600.
    fireEvent.change(screen.getByTestId('payment-row-amount-0'), {
      target: { value: '600' },
    });
    // Add a second row.
    fireEvent.click(screen.getByTestId('payment-add-row'));
    const second = screen.getByTestId('payment-row-amount-1') as HTMLInputElement;
    expect(Number(second.value)).toBe(400); // remaining-prefill default
    // Confirm.
    fireEvent.click(screen.getByTestId('payment-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const payments = useCartStore.getState().payments;
    expect(payments).toHaveLength(2);
    expect(payments.map((p) => p.amount)).toEqual([600, 400]);
    expect(payments.every((p) => p.method === 'cash')).toBe(true);
  });

  it('legacy single-payment confirm still produces a one-element array', () => {
    const onConfirm = vi.fn();
    renderModal({ grandTotal: 1000, onConfirm });
    fireEvent.click(screen.getByTestId('payment-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const payments = useCartStore.getState().payments;
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({
      method: 'cash',
      amount: 1000,
      payment_account_id: null,
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // PR-POS-PAY-1-HOTFIX-1 regression tests
  //
  // These pin the two-part stale-closure fix:
  //
  //   Fix A — `openPay()` no longer seeds `cart.payments` with a
  //           legacy single-cash row before opening the modal. The
  //           modal owns its own draft state.
  //   Fix B — Submitting the modal invokes `onConfirm(drafts)` and
  //           the parent's submit uses those drafts directly in the
  //           API payload, instead of reading the closure-captured
  //           `cart.payments` snapshot (which can be stale because
  //           Zustand's `setState` is queued behind React's render
  //           cycle).
  //
  // Invoice INV-2026-000116 was the production reproducer: the
  // cashier split 350 EGP across cash + InstaPay but the persisted
  // record was a single `cash 350` row because the parent's submit
  // closure shipped the legacy pre-fill instead of the modal's
  // freshly-built drafts.
  // ─────────────────────────────────────────────────────────────────

  it('PR-POS-PAY-1-HOTFIX-1: onConfirm receives the freshly-built drafts as its first argument (split payment)', () => {
    const onConfirm = vi.fn();
    renderModal({ grandTotal: 1000, onConfirm });
    // Cashier splits 600 cash + 400 cash (two rows).
    fireEvent.change(screen.getByTestId('payment-row-amount-0'), {
      target: { value: '600' },
    });
    fireEvent.click(screen.getByTestId('payment-add-row'));
    fireEvent.click(screen.getByTestId('payment-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    // The drafts argument is the source of truth for the API payload —
    // the parent's submit must use this, not `cart.payments`.
    const drafts = (onConfirm.mock.calls[0] as unknown[])[0] as Array<{
      method: string;
      amount: number;
      payment_account_id: string | null;
    }>;
    expect(Array.isArray(drafts)).toBe(true);
    expect(drafts).toHaveLength(2);
    expect(drafts.map((d) => d.amount)).toEqual([600, 400]);
    expect(drafts.every((d) => d.method === 'cash')).toBe(true);
  });

  it('PR-POS-PAY-1-HOTFIX-1: onConfirm drafts reflect the modal\'s current state even when cart.payments is stale', () => {
    // Reproduces the bug shape: a parent component captured an old
    // `cart.payments` snapshot (e.g. a legacy pre-fill of one cash
    // row at grandTotal). The modal builds a multi-row split. The
    // argument passed to onConfirm MUST be the modal's fresh drafts
    // — not the store's stale value — so the parent's submit can
    // pass them through to the API payload regardless of when
    // Zustand flushes through React's render cycle.
    const onConfirm = vi.fn();
    renderModal({ grandTotal: 1000, onConfirm });
    // Now plant a stale `cart.payments` value AFTER mount so it
    // does not get clobbered by `renderModal`'s own seeding. This
    // mimics what the parent's render-time closure would observe
    // if openPay() had pre-filled the store (the legacy bug).
    // Wrap in act() because the modal subscribes to the store and
    // this triggers a re-render.
    act(() => {
      useCartStore.setState({
        payments: [{ method: 'cash', amount: 1000 }],
      } as Parameters<typeof useCartStore.setState>[0]);
    });
    expect(useCartStore.getState().payments).toEqual([
      { method: 'cash', amount: 1000 },
    ]);
    // Cashier splits 350 cash + 650 cash in the modal — the modal
    // owns its own draft state, so this does NOT touch
    // cart.payments yet.
    fireEvent.change(screen.getByTestId('payment-row-amount-0'), {
      target: { value: '350' },
    });
    fireEvent.click(screen.getByTestId('payment-add-row'));
    fireEvent.click(screen.getByTestId('payment-confirm'));
    const drafts = (onConfirm.mock.calls[0] as unknown[])[0] as Array<{
      method: string;
      amount: number;
    }>;
    // The drafts handed to the parent reflect the SPLIT, not the
    // stale single-cash row a closure-captured `cart.payments`
    // would otherwise leak through.
    expect(drafts).toHaveLength(2);
    expect(drafts.reduce((s, d) => s + d.amount, 0)).toBe(1000);
  });

  it('PR-POS-PAY-1-HOTFIX-1: modal works with empty cart.payments at mount (Fix A — openPay no longer pre-fills)', () => {
    // Pre-hotfix, openPay() called `cart.setPayments([{method:'cash',
    // amount: grandTotal}])` BEFORE opening the modal. Post-hotfix,
    // openPay() leaves cart.payments untouched and the modal seeds
    // its own default row from `useState(() => [{...grandTotal}])`.
    // This test pins that the modal renders correctly — and the
    // parent's submit is reachable — when cart.payments is empty at
    // mount time, which is the new normal.
    useCartStore.setState({ payments: [] } as Parameters<
      typeof useCartStore.setState
    >[0]);
    const onConfirm = vi.fn();
    renderModal({ grandTotal: 750, onConfirm });
    // Modal still renders one default cash row prefilled with grand
    // total, sourced from its OWN useState — not from cart.payments.
    const rows = screen.getAllByTestId('payment-row');
    expect(rows).toHaveLength(1);
    const amount = screen.getByTestId('payment-row-amount-0') as HTMLInputElement;
    expect(Number(amount.value)).toBe(750);
    // Confirm is enabled — no pre-fill from openPay was needed.
    const confirm = screen.getByTestId('payment-confirm') as HTMLButtonElement;
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    // onConfirm fires with the modal-sourced default draft.
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const drafts = (onConfirm.mock.calls[0] as unknown[])[0] as Array<{
      method: string;
      amount: number;
    }>;
    expect(drafts).toEqual([
      expect.objectContaining({ method: 'cash', amount: 750 }),
    ]);
  });
});
