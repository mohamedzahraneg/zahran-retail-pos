/**
 * CashDesk.reorg.test.tsx — PR-CASH-DESK-REORG-1
 *
 * Pins the post-reorg shape of the cash-desk page:
 *
 *   ✓ deposit / opening-balance button still renders and is the
 *     ONLY action button (دفع لمورد + استلام من عميل moved).
 *   ✓ master cashbox-movements feed still renders (the "حركة الخزنة"
 *     tab + the table testid).
 *   ✓ the dedicated مقبوضات العملاء + مدفوعات الموردين tabs are
 *     gone (their lists moved to Customers / Suppliers).
 *
 * Locks the future regression: anyone re-introducing the customer or
 * supplier action buttons / tabs to the cash-desk page fails CI.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import CashDesk from '../CashDesk';

vi.mock('@/api/cash-desk.api', () => ({
  cashDeskApi: {
    cashboxes: vi.fn(async () => [
      {
        id: 'cb-1',
        name: 'الخزينة الرئيسية',
        current_balance: 5000,
        is_active: true,
      },
    ]),
    cashflowToday: vi.fn(async () => [
      {
        cashbox_id: 'cb-1',
        cashbox_name: 'الخزينة الرئيسية',
        current_balance: 5000,
        cash_in_today: 0,
        cash_out_today: 0,
      },
    ]),
    shiftVariances: vi.fn(async () => null),
    movements: vi.fn(async () => []),
    deposit: vi.fn(),
  },
}));
vi.mock('@/components/InvoiceHoverCard', () => ({
  InvoiceHoverCard: () => null,
}));
vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return {
    default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }),
  };
});

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <CashDesk />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('<CashDesk /> — PR-CASH-DESK-REORG-1 post-reorg shape', () => {
  it('renders the deposit / opening-balance button (treasury action stays)', () => {
    renderPage();
    expect(screen.getByTestId('cash-desk-deposit-button')).toBeInTheDocument();
    // Arabic label is present (matches the user-facing copy).
    expect(screen.getByText(/إيداع\/رصيد افتتاحي/)).toBeInTheDocument();
  });

  it('does NOT render the customer-receipt action button (moved to Customers)', () => {
    renderPage();
    expect(screen.queryByText('استلام من عميل')).toBeNull();
  });

  it('does NOT render the supplier-payment action button (moved to Suppliers)', () => {
    renderPage();
    expect(screen.queryByText('دفع لمورد')).toBeNull();
  });

  it('renders the master cashbox-movements feed', () => {
    renderPage();
    expect(screen.getByTestId('cash-desk-movements')).toBeInTheDocument();
    expect(screen.getByText(/حركة الخزنة/)).toBeInTheDocument();
  });

  it('does NOT render the dedicated مقبوضات العملاء / مدفوعات الموردين tabs (moved)', () => {
    renderPage();
    expect(screen.queryByText('مقبوضات العملاء')).toBeNull();
    expect(screen.queryByText('مدفوعات الموردين')).toBeNull();
  });

  it('renders only ONE tab button in the cash-desk-tabs row (movements)', () => {
    renderPage();
    const tabs = screen.getByTestId('cash-desk-tabs');
    // Each TabBtn renders a <button>; the post-reorg page should
    // have exactly one tab button inside this row.
    const tabButtons = tabs.querySelectorAll('button');
    expect(tabButtons.length).toBe(1);
  });
});
