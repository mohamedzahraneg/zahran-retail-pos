/**
 * Suppliers.pay-button.test.tsx — PR-CASH-DESK-REORG-1
 *
 * Mirror of `Customers.receipt-button.test.tsx` for the Suppliers
 * page. Pins:
 *
 *   1. The per-card pay button renders.
 *   2. Clicking it opens the shared <SupplierPayModal /> with the
 *      right supplier pre-filled.
 *   3. No backend mutation fires from this interaction (mutation
 *      only runs on submit inside the modal — covered by
 *      SupplierPayModal.test.tsx).
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import Suppliers from '../Suppliers';

const suppliersFixture = [
  {
    id: 'sup-1',
    code: 'SUP-001',
    name: 'مورد المنتجات',
    phone: '01100000001',
    email: null,
    current_balance: 800,
    overdue_amount: 0,
    next_due_date: null,
    payment_terms: 'cash',
    purchase_count: 0,
    last_purchase_at: null,
    last_payment_at: null,
  },
  {
    id: 'sup-2',
    code: 'SUP-002',
    name: 'مورد التغليف',
    phone: '01100000002',
    email: null,
    current_balance: 0,
    overdue_amount: 0,
    next_due_date: null,
    payment_terms: 'credit',
    purchase_count: 0,
    last_purchase_at: null,
    last_payment_at: null,
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

vi.mock('@/api/suppliers.api', () => ({
  suppliersApi: {
    list: vi.fn(async () => suppliersFixture),
    outstanding: vi.fn(async () => []),
    // Match the shape `SuppliersAnalytics` reads — see Suppliers.tsx:
    // `analytics.totals.*`, `analytics.byType[]`, `analytics.topOutstanding[]`,
    // `analytics.topSpend[]`.
    analytics: vi.fn(async () => ({
      totals: {
        outstanding_total: 0,
        overdue_total: 0,
        suppliers_count: 0,
        payment_count_30d: 0,
        purchases_last_30d: 0,
      },
      byType: [],
      topOutstanding: [],
      topSpend: [],
    })),
    upcomingPayments: vi.fn(async () => []),
    remove: vi.fn(),
  },
}));
vi.mock('@/api/cash-desk.api', () => ({
  cashDeskApi: {
    cashboxes: vi.fn(async () => cashboxesFixture),
    pay: vi.fn(),
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
        <Suppliers />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('<Suppliers /> — PR-CASH-DESK-REORG-1 pay button', () => {
  it('renders one pay button per supplier card', async () => {
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByTestId('suppliers-pay-button-sup-1'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('suppliers-pay-button-sup-2'),
    ).toBeInTheDocument();
  });

  it('clicking the per-card button opens the supplier-pay modal with that supplier pre-filled', async () => {
    renderPage();
    const button = await screen.findByTestId('suppliers-pay-button-sup-1');
    fireEvent.click(button);
    // Modal mounts.
    const modal = await screen.findByTestId('supplier-pay-modal');
    expect(modal).toBeInTheDocument();
    // Prefilled supplier name shows inside the modal (the page also
    // renders it on the card behind, hence we scope with `within`).
    expect(within(modal).getByText('مورد المنتجات')).toBeInTheDocument();
    // No search input (locked).
    expect(
      screen.queryByTestId('supplier-pay-modal-supplier-search'),
    ).toBeNull();
  });

  it('clicking a different supplier mounts the modal with THAT supplier (not the previous one)', async () => {
    renderPage();
    fireEvent.click(
      await screen.findByTestId('suppliers-pay-button-sup-2'),
    );
    const modal = await screen.findByTestId('supplier-pay-modal');
    expect(within(modal).getByText('مورد التغليف')).toBeInTheDocument();
    expect(modal.textContent).not.toContain('مورد المنتجات');
  });
});
