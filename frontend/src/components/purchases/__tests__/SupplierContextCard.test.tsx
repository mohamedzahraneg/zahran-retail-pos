/**
 * SupplierContextCard.test.tsx — PR-PURCHASES-P1
 *
 * Pins the supplier-context card's data contract + rendering:
 *  - Shows supplier code + name + balance badge with the right
 *    direction label (له / علينا / صفر).
 *  - Renders last-purchase line with the derived interaction tag
 *    (cash / partial / credit).
 *  - Renders fallback "لا توجد فواتير سابقة" when last_purchase is null.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SupplierContextCard } from '../SupplierContextCard';

const supplierContextFixture = {
  supplier: {
    id: 'sup-1',
    code: 'SUP-001',
    name: 'مورد تجريبي',
    supplier_type: 'credit' as const,
    current_balance: 1500,
    balance_direction: 'owed_to_supplier' as const,
    credit_limit: 5000,
    payment_terms_days: 30,
  },
  stats: {
    purchase_count: 5,
    purchases_total: 12000,
    paid_total: 10500,
    unpaid_total: 1500,
  },
  last_purchase: {
    id: 'pur-1',
    purchase_no: 'PO-2026-000005',
    invoice_date: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10),
    grand_total: 500,
    paid_amount: 400,
    remaining: 100,
    status: 'partial' as const,
    interaction: 'partial' as const,
  },
};

vi.mock('@/api/purchases.api', () => ({
  purchasesApi: {
    supplierContext: vi.fn(),
  },
}));

import { purchasesApi } from '@/api/purchases.api';

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe('SupplierContextCard', () => {
  it('renders code, name, "له" balance badge, last purchase, interaction tag, and stats', async () => {
    (purchasesApi.supplierContext as any).mockResolvedValueOnce(
      supplierContextFixture,
    );
    render(wrap(<SupplierContextCard supplierId="sup-1" />));

    await waitFor(() =>
      expect(screen.getByTestId('supplier-context-card')).toBeInTheDocument(),
    );

    expect(screen.getByText('#SUP-001')).toBeInTheDocument();
    expect(screen.getByText('مورد تجريبي')).toBeInTheDocument();
    expect(screen.getByTestId('supplier-balance-badge')).toHaveTextContent(
      /^له/,
    );
    expect(screen.getByText('PO-2026-000005')).toBeInTheDocument();
    expect(screen.getByTestId('supplier-last-interaction')).toHaveTextContent(
      'سداد جزئي',
    );
    expect(screen.getByText(/عدد الفواتير:/)).toBeInTheDocument();
    expect(screen.getByText('5')).toBeInTheDocument();
  });

  it('renders "علينا" badge when balance is negative', async () => {
    (purchasesApi.supplierContext as any).mockResolvedValueOnce({
      ...supplierContextFixture,
      supplier: {
        ...supplierContextFixture.supplier,
        current_balance: -250,
        balance_direction: 'credit_to_us' as const,
      },
    });
    render(wrap(<SupplierContextCard supplierId="sup-2" />));

    await waitFor(() =>
      expect(screen.getByTestId('supplier-balance-badge')).toHaveTextContent(
        /^علينا/,
      ),
    );
  });

  it('renders fallback when there is no last_purchase', async () => {
    (purchasesApi.supplierContext as any).mockResolvedValueOnce({
      ...supplierContextFixture,
      last_purchase: null,
    });
    render(wrap(<SupplierContextCard supplierId="sup-3" />));

    await waitFor(() =>
      expect(
        screen.getByText('لا توجد فواتير سابقة لهذا المورد.'),
      ).toBeInTheDocument(),
    );
  });
});
