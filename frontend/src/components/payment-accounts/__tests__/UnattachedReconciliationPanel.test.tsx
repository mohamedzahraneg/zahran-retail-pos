/**
 * UnattachedReconciliationPanel.test.tsx — PR-FIN-PAYACCT-4D-UX-FIX-9
 *
 * Pins the operator-facing reconciliation panel:
 *   • Cash bucket renders with explanatory message and NO action.
 *   • InstaPay bucket renders with row_count=3 / total=1050 and an
 *     action button when canManage=true.
 *   • Action requires window.confirm before firing the backfill.
 *   • dryRun is disabled on the explicit user click (request body
 *     carries dryRun: false).
 *   • Success invalidates `payment-accounts-balances` query.
 *   • canManage=false hides the action button entirely.
 *   • Empty summary → component renders nothing.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { paymentsApi, type UnattachedSummaryRow } from '@/api/payments.api';
import { UnattachedReconciliationPanel } from '../UnattachedReconciliationPanel';

vi.mock('@/api/payments.api', async () => {
  const actual = await vi.importActual<typeof import('@/api/payments.api')>(
    '@/api/payments.api',
  );
  return {
    ...actual,
    paymentsApi: {
      ...actual.paymentsApi,
      unattachedSummary: vi.fn(),
      backfillUnattached: vi.fn(),
    },
  };
});

vi.mock('react-hot-toast', () => ({
  default: { success: vi.fn(), error: vi.fn() },
}));

const CASH_BUCKET: UnattachedSummaryRow = {
  source_table: 'invoice_payments',
  payment_method: 'cash',
  row_count: 101,
  total_amount: '30305.01',
  earliest: '2026-04-20',
  latest: '2026-04-30',
  supported: false,
  status_message: 'النقدية تُسجَّل عبر الخزنة ولا تحتاج حساب دفع',
  target_account: null,
};
const INSTAPAY_BUCKET: UnattachedSummaryRow = {
  source_table: 'invoice_payments',
  payment_method: 'instapay',
  row_count: 3,
  total_amount: '1050.00',
  earliest: '2026-04-24',
  latest: '2026-04-25',
  supported: true,
  status_message: 'جاهز للربط بالحساب الافتراضي',
  target_account: {
    id: '4dbe8e84-f145-4bbb-a508-4f934bf302ca',
    display_name: 'InstaPay',
    identifier: '01004888879',
    provider_key: 'instapay',
    gl_account_code: '1114',
  },
};

function renderPanel(canManage: boolean) {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return {
    qc,
    ...render(
      <QueryClientProvider client={qc}>
        <UnattachedReconciliationPanel canManage={canManage} />
      </QueryClientProvider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('UnattachedReconciliationPanel — PR-FIN-PAYACCT-4D-UX-FIX-9', () => {
  it('renders nothing when the summary is empty (post-backfill quiescent state)', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([]);
    const { container } = renderPanel(true);
    await waitFor(() =>
      expect(paymentsApi.unattachedSummary).toHaveBeenCalled(),
    );
    // Wait for query to settle; panel should not appear.
    await waitFor(() =>
      expect(screen.queryByTestId('unattached-panel')).toBeNull(),
    );
    // Loading skeleton also gone.
    expect(screen.queryByTestId('unattached-panel-loading')).toBeNull();
    expect(container.querySelector('[data-testid^="unattached"]')).toBeNull();
  });

  it('renders the cash bucket with the explanatory status and NO action button', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([CASH_BUCKET]);
    renderPanel(true);
    const row = await screen.findByTestId(
      'unattached-row-invoice_payments-cash',
    );
    expect(row).toBeInTheDocument();
    // Status message visible.
    expect(
      within(row).getByTestId('unattached-status-invoice_payments-cash')
        .textContent,
    ).toMatch(/النقدية تُسجَّل عبر الخزنة/);
    // No action button for cash.
    expect(within(row).queryByTestId('unattached-action-cash')).toBeNull();
  });

  it('renders the InstaPay bucket with row_count=3, total=1,050.00, and an action button when canManage=true', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([INSTAPAY_BUCKET]);
    renderPanel(true);
    const row = await screen.findByTestId(
      'unattached-row-invoice_payments-instapay',
    );
    expect(row.textContent).toMatch(/3 عملية/);
    expect(row.textContent).toMatch(/1,050\.00/);
    const action = within(row).getByTestId('unattached-action-instapay');
    expect(action).toBeInTheDocument();
    expect(action.textContent).toMatch(/InstaPay/);
  });

  it('PR-FIN-PAYACCT-4D-UX-FIX-9-BUTTON-LABEL: InstaPay button text is exactly "ربط عمليات InstaPay التاريخية"', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([INSTAPAY_BUCKET]);
    renderPanel(true);
    const action = await screen.findByTestId('unattached-action-instapay');
    // Idle state must read the verbatim spec string (not the dynamic
    // target.display_name template). Confirm dialog and status row
    // continue to mention the target account elsewhere.
    expect(action.textContent?.trim()).toBe('ربط عمليات InstaPay التاريخية');
  });

  it('hides the InstaPay action button when canManage=false', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([INSTAPAY_BUCKET]);
    renderPanel(false);
    const row = await screen.findByTestId(
      'unattached-row-invoice_payments-instapay',
    );
    expect(within(row).queryByTestId('unattached-action-instapay')).toBeNull();
    // Status still visible — operators see the count even without manage perm.
    expect(row.textContent).toMatch(/3 عملية/);
  });

  it('action requires window.confirm and aborts when the operator cancels', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([INSTAPAY_BUCKET]);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPanel(true);
    const action = await screen.findByTestId('unattached-action-instapay');
    fireEvent.click(action);
    expect(confirmSpy).toHaveBeenCalled();
    expect(paymentsApi.backfillUnattached).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });

  it('action calls backfillUnattached with method=instapay + dryRun=false on confirm', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([INSTAPAY_BUCKET]);
    (paymentsApi.backfillUnattached as any).mockResolvedValue({
      method: 'instapay',
      dryRun: false,
      targetAccount: {
        id: INSTAPAY_BUCKET.target_account!.id,
        display_name: INSTAPAY_BUCKET.target_account!.display_name,
        identifier: INSTAPAY_BUCKET.target_account!.identifier,
      },
      before: { rowCount: 3, totalAmount: '1050.00' },
      after: { rowCount: 0, totalAmount: '0' },
      updatedCount: 3,
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPanel(true);
    fireEvent.click(await screen.findByTestId('unattached-action-instapay'));

    await waitFor(() =>
      expect(paymentsApi.backfillUnattached).toHaveBeenCalledTimes(1),
    );
    expect(paymentsApi.backfillUnattached).toHaveBeenCalledWith({
      method: 'instapay',
      dryRun: false,
    });
    confirmSpy.mockRestore();
  });

  it('on success invalidates payment-accounts-balances + unattached-summary queries', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([INSTAPAY_BUCKET]);
    (paymentsApi.backfillUnattached as any).mockResolvedValue({
      method: 'instapay', dryRun: false,
      targetAccount: { id: INSTAPAY_BUCKET.target_account!.id, display_name: 'InstaPay', identifier: '01004888879' },
      before: { rowCount: 3, totalAmount: '1050.00' },
      after: { rowCount: 0, totalAmount: '0' },
      updatedCount: 3,
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const { qc } = renderPanel(true);
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    fireEvent.click(await screen.findByTestId('unattached-action-instapay'));
    await waitFor(() =>
      expect(paymentsApi.backfillUnattached).toHaveBeenCalled(),
    );

    // Both query keys invalidated.
    await waitFor(() => {
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['unattached-summary'] });
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['payment-accounts-balances'] });
    });
    confirmSpy.mockRestore();
  });
});
