/**
 * CashSourceSelector.test.tsx — PR-EMP-ADVANCE-PAY-1
 *
 * Pins the UX-trap fix that was the proximate cause of the
 * mis-attributed advance EXP-2026-000031: clicking the "من خزنة
 * مباشرة" toggle when no cashbox is yet selected USED to fall back
 * to `mode='unset'` (which hid the cashbox dropdown entirely),
 * forcing the operator to first pick a shift to seed `cashbox_id`
 * and then flip back — exactly the path that linked the advance to
 * a shift. Now the toggle flips to `mode='direct_cashbox'`
 * IMMEDIATELY and the cashbox dropdown appears on the first click.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { CashSourceSelector, type CashSource } from '../CashSourceSelector';

vi.mock('@/api/shifts.api', () => ({
  shiftsApi: {
    list: vi.fn(async () => []),
  },
}));
vi.mock('@/api/cash-desk.api', () => ({
  cashDeskApi: {
    cashboxes: vi.fn(async () => [
      { id: 'cb-1', name_ar: 'الخزينة الرئيسية' },
      { id: 'cb-2', name_ar: 'خزنة فرعية' },
    ]),
  },
}));
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: (selector: any) => selector({ user: { id: 'u-1' } }),
}));

function renderSelector(initial: CashSource = {
  mode: 'unset',
  shift_id: null,
  cashbox_id: null,
}) {
  const onChange = vi.fn();
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={qc}>
      <CashSourceSelector value={initial} onChange={onChange} />
    </QueryClientProvider>,
  );
  return { ...utils, onChange };
}

describe('<CashSourceSelector /> — PR-EMP-ADVANCE-PAY-1 UX trap fix', () => {
  it('clicking "من خزنة مباشرة" with no cashbox preselected emits mode=direct_cashbox + cashbox_id=null (instead of falling back to unset)', () => {
    const { onChange } = renderSelector();
    fireEvent.click(screen.getByText(/من خزنة مباشرة/));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as CashSource;
    expect(next.mode).toBe('direct_cashbox');
    expect(next.cashbox_id).toBeNull();
    expect(next.shift_id).toBeNull();
  });

  it('renders the cashbox dropdown immediately after the toggle is clicked (no need to pick a shift first)', async () => {
    // Re-render with the post-toggle value so we can inspect the
    // dropdown — vitest's RTL doesn't propagate the controlled
    // change through onChange without a wrapping stateful parent.
    renderSelector({ mode: 'direct_cashbox', shift_id: null, cashbox_id: null });
    // The dropdown is the first <select> in the DOM under the
    // "اختر الخزنة" label.
    const cashboxLabel = screen.getByText(/اختر الخزنة/);
    expect(cashboxLabel).toBeInTheDocument();
    // The placeholder option is selected (because cashbox_id is null).
    const dropdown = cashboxLabel.parentElement!.querySelector('select') as HTMLSelectElement;
    expect(dropdown).toBeTruthy();
    expect(dropdown.value).toBe('');
    // Both fixture cashboxes are listed (after the cashboxes query resolves).
    await waitFor(() => {
      expect(screen.getByText('الخزينة الرئيسية')).toBeInTheDocument();
    });
    expect(screen.getByText('خزنة فرعية')).toBeInTheDocument();
  });

  it('preserves a previously-selected cashbox when toggling back to direct_cashbox from open_shift', () => {
    // Operator was on open_shift with cashbox seeded from the shift.
    // Toggling to direct_cashbox keeps the cashbox so they don't lose
    // context — only the mode changes, shift_id is cleared.
    const { onChange } = renderSelector({
      mode: 'open_shift',
      shift_id: 's-1',
      cashbox_id: 'cb-1',
    });
    fireEvent.click(screen.getByText(/من خزنة مباشرة/));
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as CashSource;
    expect(next.mode).toBe('direct_cashbox');
    expect(next.cashbox_id).toBe('cb-1');
    expect(next.shift_id).toBeNull();
  });

  it('picking a cashbox in direct_cashbox mode emits the chosen cashbox_id', async () => {
    const { onChange } = renderSelector({
      mode: 'direct_cashbox',
      shift_id: null,
      cashbox_id: null,
    });
    const select = screen.getByText(/اختر الخزنة/).parentElement!.querySelector(
      'select',
    ) as HTMLSelectElement;
    // Wait for the cashboxes query to resolve so the <option> values
    // are mounted and the change event resolves to a real cashbox.
    await waitFor(() => {
      expect(select.querySelectorAll('option').length).toBeGreaterThan(1);
    });
    fireEvent.change(select, { target: { value: 'cb-2' } });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = onChange.mock.calls[0][0] as CashSource;
    expect(next.mode).toBe('direct_cashbox');
    expect(next.cashbox_id).toBe('cb-2');
    expect(next.shift_id).toBeNull();
  });
});
