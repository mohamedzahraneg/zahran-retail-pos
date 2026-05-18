/**
 * PurchaseReturns.test.tsx — PR-P2.4A
 *
 * Smoke tests for the list page: status tabs filter, row cancel
 * confirmation, settlement-type chip label.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import PurchaseReturns from '../PurchaseReturns';

vi.mock('@/api/purchaseReturns.api', () => ({
  purchaseReturnsApi: {
    list: vi.fn(),
    cancel: vi.fn(),
  },
}));

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
  __esModule: true,
}));

import { purchaseReturnsApi } from '@/api/purchaseReturns.api';

function listFixture() {
  return [
    {
      id: 'pr-1',
      return_no: 'PR-2026-0001',
      return_date: '2026-05-16',
      supplier_id: 'sup-1',
      supplier_name: 'مورد ١',
      warehouse_id: 'wh-1',
      warehouse_name: 'المخزن الرئيسي',
      total_amount: '500',
      status: 'posted' as const,
      reason: 'بضاعة معيبة',
      settlement_type: 'supplier_credit' as const,
      refund_amount: null,
      cashbox_id: null,
      posted_at: '2026-05-16T10:00:00Z',
      cancelled_at: null,
      items_count: 2,
    },
    {
      id: 'pr-2',
      return_no: 'PR-2026-0002',
      return_date: '2026-05-15',
      supplier_id: 'sup-2',
      supplier_name: 'مورد ٢',
      warehouse_id: 'wh-1',
      warehouse_name: 'المخزن الرئيسي',
      total_amount: '300',
      status: 'cancelled' as const,
      reason: 'تم الإلغاء',
      settlement_type: 'cash_refund' as const,
      refund_amount: '300',
      cashbox_id: 'cb-1',
      posted_at: '2026-05-15T10:00:00Z',
      cancelled_at: '2026-05-15T12:00:00Z',
      items_count: 1,
    },
  ];
}

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return <QueryClientProvider client={qc}>{ui}</QueryClientProvider>;
}

describe('PurchaseReturns page', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('renders both returns with their settlement-type chips', async () => {
    (purchaseReturnsApi.list as any).mockResolvedValue(listFixture());
    render(wrap(<PurchaseReturns />));
    await waitFor(() =>
      expect(screen.getByText('PR-2026-0001')).toBeInTheDocument(),
    );
    expect(screen.getByText('PR-2026-0002')).toBeInTheDocument();
    expect(screen.getByText('رصيد دائن للمورد')).toBeInTheDocument();
    expect(screen.getByText('استرداد نقدي')).toBeInTheDocument();
  });

  it('shows cancel button only on posted rows', async () => {
    (purchaseReturnsApi.list as any).mockResolvedValue(listFixture());
    render(wrap(<PurchaseReturns />));
    await waitFor(() =>
      expect(screen.getByText('PR-2026-0001')).toBeInTheDocument(),
    );
    const cancelButtons = screen.getAllByRole('button', { name: 'إلغاء' });
    // Only the posted row gets a cancel button (the cancelled row is "—").
    expect(cancelButtons).toHaveLength(1);
  });

  it('calls cancel API after operator confirms', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    (purchaseReturnsApi.list as any).mockResolvedValue(listFixture());
    (purchaseReturnsApi.cancel as any).mockResolvedValue({
      cancelled: true,
      id: 'pr-1',
    });
    render(wrap(<PurchaseReturns />));
    await waitFor(() =>
      expect(screen.getByText('PR-2026-0001')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    await waitFor(() =>
      expect(purchaseReturnsApi.cancel).toHaveBeenCalledWith('pr-1'),
    );
    confirmSpy.mockRestore();
  });

  it('does NOT call cancel API when operator declines the confirm prompt', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    (purchaseReturnsApi.list as any).mockResolvedValue(listFixture());
    render(wrap(<PurchaseReturns />));
    await waitFor(() =>
      expect(screen.getByText('PR-2026-0001')).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'إلغاء' }));
    expect(purchaseReturnsApi.cancel).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
