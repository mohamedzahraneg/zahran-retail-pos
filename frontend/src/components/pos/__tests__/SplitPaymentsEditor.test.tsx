/**
 * SplitPaymentsEditor.test.tsx — PR-POS-PAY-2
 *
 * Isolated DOM tests for the shared multi-row split-payment editor.
 * The editor is the single source of truth for the picker UI used by
 * both `PaymentModal` (POS new-invoice flow) and `InvoiceEditModal`
 * (invoice-edit flow). These tests pin the contract so future
 * refactors can't silently break either consumer:
 *
 *   1. Mounts with the rows passed by the parent (controlled).
 *   2. `+ إضافة وسيلة دفع` calls `onChange` with the new row appended.
 *   3. Removing a row works only when there are 2+ rows; the remove
 *      button is hidden when there is only one row.
 *   4. Editing the amount input emits an updated row through
 *      `onChange`.
 *   5. The validation banner surfaces the helper's reason string for
 *      a zero-amount row.
 *   6. The light variant renders the editor without crashing (smoke
 *      test for the invoice-edit consumer's theme).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SplitPaymentsEditor } from '../SplitPaymentsEditor';
import type { SplitPaymentRow } from '@/lib/posSplitPayment';

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
  { method: 'wallet', name_ar: 'محفظة', provider_key: 'we_pay', icon_name: '', logo_key: 'wallet' },
];
const accountsFixture = [
  {
    id: 'acct-wallet-1',
    method: 'wallet',
    provider_key: 'we_pay',
    display_name: 'WE Pay',
    identifier: '01000000000',
    gl_account_code: '1114',
    is_default: true,
    active: true,
    sort_order: 1,
    metadata: {},
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  },
];

function renderEditor(
  rows: SplitPaymentRow[],
  opts?: { grandTotal?: number; variant?: 'dark' | 'light'; hideGrandTotalBanner?: boolean },
) {
  const onChange = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <SplitPaymentsEditor
        rows={rows}
        onChange={onChange}
        grandTotal={opts?.grandTotal ?? 1000}
        variant={opts?.variant ?? 'dark'}
        hideGrandTotalBanner={opts?.hideGrandTotalBanner}
      />
    </QueryClientProvider>,
  );
  return { ...utils, onChange };
}

const rowCash = (amount: number, uid = 'r1'): SplitPaymentRow => ({
  uid,
  method: 'cash',
  amount,
  payment_account_id: null,
});

describe('<SplitPaymentsEditor /> — PR-POS-PAY-2', () => {
  it('renders one cash row when given one row (controlled, no internal state)', () => {
    renderEditor([rowCash(1000)]);
    const rows = screen.getAllByTestId('payment-row');
    expect(rows).toHaveLength(1);
    const amount = screen.getByTestId('payment-row-amount-0') as HTMLInputElement;
    expect(Number(amount.value)).toBe(1000);
    // Single-row → no remove button.
    expect(screen.queryByTestId('payment-row-remove-0')).toBeNull();
  });

  it('renders multiple rows in order when the parent passes more than one', () => {
    renderEditor([
      { uid: 'r1', method: 'cash', amount: 600, payment_account_id: null },
      { uid: 'r2', method: 'cash', amount: 400, payment_account_id: null },
    ]);
    const rows = screen.getAllByTestId('payment-row');
    expect(rows).toHaveLength(2);
    expect(
      Number((screen.getByTestId('payment-row-amount-0') as HTMLInputElement).value),
    ).toBe(600);
    expect(
      Number((screen.getByTestId('payment-row-amount-1') as HTMLInputElement).value),
    ).toBe(400);
    // Two rows → both have remove buttons.
    expect(screen.getByTestId('payment-row-remove-0')).toBeInTheDocument();
    expect(screen.getByTestId('payment-row-remove-1')).toBeInTheDocument();
  });

  it('clicking + إضافة وسيلة دفع emits a new rows array via onChange', () => {
    const { onChange } = renderEditor([rowCash(1000)], { grandTotal: 1000 });
    fireEvent.click(screen.getByTestId('payment-add-row'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as SplitPaymentRow[];
    expect(next).toHaveLength(2);
    // The original row is preserved verbatim, new row defaults to
    // remaining=0 (already fully paid in this fixture).
    expect(next[0]).toMatchObject({ uid: 'r1', method: 'cash', amount: 1000 });
    expect(next[1]).toMatchObject({ method: 'cash', amount: 0 });
  });

  it('removing a row only fires onChange when 2+ rows exist; hidden for single row', () => {
    // 2 rows → remove visible + functional
    const twoRows: SplitPaymentRow[] = [
      { uid: 'r1', method: 'cash', amount: 600, payment_account_id: null },
      { uid: 'r2', method: 'cash', amount: 400, payment_account_id: null },
    ];
    const { onChange, unmount } = renderEditor(twoRows);
    fireEvent.click(screen.getByTestId('payment-row-remove-1'));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as SplitPaymentRow[];
    expect(next).toHaveLength(1);
    expect(next[0].uid).toBe('r1');
    unmount();
    // 1 row → no remove button to click.
    const single = renderEditor([rowCash(1000)]);
    expect(screen.queryByTestId('payment-row-remove-0')).toBeNull();
    expect(single.onChange).not.toHaveBeenCalled();
  });

  it('editing the amount input emits the patched row through onChange', () => {
    const { onChange } = renderEditor([rowCash(1000)]);
    fireEvent.change(screen.getByTestId('payment-row-amount-0'), {
      target: { value: '750' },
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as SplitPaymentRow[];
    expect(next[0]).toMatchObject({ method: 'cash', amount: 750 });
  });

  it('renders the validation banner when the helper reports an error (zero-amount row)', () => {
    renderEditor([rowCash(0)], { grandTotal: 1000 });
    const banner = screen.getByTestId('payment-validation-error');
    expect(banner).toBeInTheDocument();
    expect(banner.textContent).toMatch(/المبلغ يجب أن يكون أكبر من صفر/);
  });

  it('renders the summary panel showing total paid + remaining when partial', () => {
    renderEditor([rowCash(600)], { grandTotal: 1000 });
    const stripCommas = (s: string | null) => (s ?? '').replace(/,/g, '');
    expect(
      stripCommas(screen.getByTestId('payment-summary-paid').textContent),
    ).toMatch(/600/);
    expect(
      stripCommas(screen.getByTestId('payment-summary-remaining').textContent),
    ).toMatch(/400/);
  });

  it('hides the grand-total banner when hideGrandTotalBanner is set (edit-modal mode)', () => {
    renderEditor([rowCash(1000)], { hideGrandTotalBanner: true });
    // The label "الإجمالي المطلوب" is part of the banner only.
    expect(screen.queryByText('الإجمالي المطلوب')).toBeNull();
    // But the summary panel still shows "إجمالي الفاتورة" inside it.
    expect(screen.getByText('إجمالي الفاتورة')).toBeInTheDocument();
  });

  it('renders without crashing in light variant (invoice-edit consumer smoke test)', () => {
    renderEditor([rowCash(1000)], { variant: 'light' });
    expect(screen.getByTestId('split-payments-editor')).toBeInTheDocument();
    expect(screen.getByTestId('payment-row')).toBeInTheDocument();
    // The light theme uses different class tokens but keeps the same
    // semantic markup; existing tests use testids, not class names.
  });
});
