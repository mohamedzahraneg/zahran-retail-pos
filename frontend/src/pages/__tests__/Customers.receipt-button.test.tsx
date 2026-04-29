/**
 * Customers.receipt-button.test.tsx — PR-CASH-DESK-REORG-1
 *
 * Pins the Customers-page entry point that replaces the old
 * cash-desk-side "استلام من عميل" button. When the operator clicks
 * the per-card receive button, the page must:
 *
 *   1. Render the receipt-modal testid wrapper.
 *   2. Mount it with the right customer pre-filled (no search input).
 *   3. NOT fire any backend write (the mutation only fires on submit
 *      inside the modal — covered by ReceiptModal.test.tsx).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Customers from '../Customers';

const customersFixture = [
  {
    id: 'cust-1',
    code: 'CUS-001',
    full_name: 'أحمد محمود',
    phone: '01000000001',
    email: null,
    loyalty_tier: 'bronze',
    loyalty_points: 0,
    current_balance: 100,
    created_at: '2026-04-01T00:00:00Z',
  },
  {
    id: 'cust-2',
    code: 'CUS-002',
    full_name: 'سارة علي',
    phone: '01000000002',
    email: null,
    loyalty_tier: 'gold',
    loyalty_points: 50,
    current_balance: 0,
    created_at: '2026-04-02T00:00:00Z',
  },
];

const cashboxesFixture = [
  {
    id: 'cb-1',
    name: 'الخزينة الرئيسية',
    current_balance: 5000,
    is_active: true,
  },
];

vi.mock('@/api/customers.api', () => ({
  customersApi: {
    list: vi.fn(async () => ({ data: customersFixture })),
    create: vi.fn(),
    unpaidInvoices: vi.fn(async () => []),
  },
}));
vi.mock('@/api/cash-desk.api', () => ({
  cashDeskApi: {
    cashboxes: vi.fn(async () => cashboxesFixture),
    receive: vi.fn(),
  },
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
        <Customers />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('<Customers /> — PR-CASH-DESK-REORG-1 receipt button', () => {
  it('renders one receipt button per customer card', async () => {
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByTestId('customers-receipt-button-cust-1'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('customers-receipt-button-cust-2'),
    ).toBeInTheDocument();
  });

  it('clicking the per-card button opens the receipt modal with that customer pre-filled', async () => {
    renderPage();
    const button = await screen.findByTestId('customers-receipt-button-cust-1');
    fireEvent.click(button);
    // Modal mounts.
    const modal = await screen.findByTestId('receipt-modal');
    expect(modal).toBeInTheDocument();
    // Prefilled customer name shows inside the modal (the page also
    // renders it on the card behind, hence we scope with `within`).
    expect(within(modal).getByText('أحمد محمود')).toBeInTheDocument();
    // No search input (locked).
    expect(screen.queryByTestId('receipt-modal-customer-search')).toBeNull();
  });

  it('clicking a different customer mounts the modal with THAT customer (not the previous one)', async () => {
    renderPage();
    fireEvent.click(
      await screen.findByTestId('customers-receipt-button-cust-2'),
    );
    const modal = await screen.findByTestId('receipt-modal');
    // Scope the second-customer-name assertion to inside the modal —
    // the page-level card still has the same name visible.
    expect(within(modal).getByText('سارة علي')).toBeInTheDocument();
    // The OTHER customer's name must NOT appear inside the modal.
    expect(modal.textContent).not.toContain('أحمد محمود');
  });
});
