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
    // PR-FIN-PAYACCT-4D-UX-FIX-14 — FE renders a canonical Arabic
    // sentence for cash regardless of what the BE sent in
    // `status_message`. Match either spelling so this test stays
    // resilient if the FE constant ever changes wording.
    expect(
      within(row).getByTestId('unattached-status-invoice_payments-cash')
        .textContent,
    ).toMatch(/النقدية تُسجَّل عبر الخزائن|النقدية تُسجَّل عبر الخزنة/);
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

  /**
   * PR-FIN-PAYACCT-4D-UX-FIX-11 — never raise a "success" toast when
   * the BE response says nothing moved. Earlier code did `toast.success`
   * unconditionally on any 2xx, which masked a server-side rollback bug
   * (the audit INSERT used the wrong column name; PG rolled back the
   * UPDATE; FE still cheerfully said "تم ربط 0 عملية..."). The three
   * branches below pin the new contract.
   */
  it('PR-FIN-PAYACCT-4D-UX-FIX-11: dryRun=true response shows a WARNING, not success, and does not invalidate queries', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([INSTAPAY_BUCKET]);
    (paymentsApi.backfillUnattached as any).mockResolvedValue({
      method: 'instapay',
      dryRun: true, // ← dryRun branch
      targetAccount: { id: INSTAPAY_BUCKET.target_account!.id, display_name: 'InstaPay', identifier: '01004888879' },
      before: { rowCount: 3, totalAmount: '1050.00' },
      after: { rowCount: 3, totalAmount: '1050.00' },
      updatedCount: 0,
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const toastModule = await import('react-hot-toast');
    const toastSuccessSpy = vi.spyOn(toastModule.default, 'success');

    const { qc } = renderPanel(true);
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    fireEvent.click(await screen.findByTestId('unattached-action-instapay'));
    await waitFor(() =>
      expect(paymentsApi.backfillUnattached).toHaveBeenCalled(),
    );

    // No success toast on a dryRun response.
    await waitFor(() => expect(toastSuccessSpy).not.toHaveBeenCalled());
    // Query cache must not be invalidated either — there's nothing to refetch.
    expect(invalidateSpy).not.toHaveBeenCalled();

    confirmSpy.mockRestore();
  });

  it('PR-FIN-PAYACCT-4D-UX-FIX-11: dryRun=false + updatedCount=0 shows a WARNING, not success', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([INSTAPAY_BUCKET]);
    (paymentsApi.backfillUnattached as any).mockResolvedValue({
      method: 'instapay',
      dryRun: false,
      targetAccount: { id: INSTAPAY_BUCKET.target_account!.id, display_name: 'InstaPay', identifier: '01004888879' },
      before: { rowCount: 3, totalAmount: '1050.00' },
      after: { rowCount: 3, totalAmount: '1050.00' }, // ← unchanged
      updatedCount: 0,                                // ← zero
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const toastModule = await import('react-hot-toast');
    const toastSuccessSpy = vi.spyOn(toastModule.default, 'success');

    renderPanel(true);
    fireEvent.click(await screen.findByTestId('unattached-action-instapay'));
    await waitFor(() =>
      expect(paymentsApi.backfillUnattached).toHaveBeenCalled(),
    );
    await waitFor(() => expect(toastSuccessSpy).not.toHaveBeenCalled());
    confirmSpy.mockRestore();
  });

  it('PR-FIN-PAYACCT-4D-UX-FIX-11: dryRun=false + updatedCount>0 shows the real success toast', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([INSTAPAY_BUCKET]);
    (paymentsApi.backfillUnattached as any).mockResolvedValue({
      method: 'instapay',
      dryRun: false,
      targetAccount: { id: INSTAPAY_BUCKET.target_account!.id, display_name: 'InstaPay', identifier: '01004888879' },
      before: { rowCount: 3, totalAmount: '1050.00' },
      after: { rowCount: 0, totalAmount: '0' },
      updatedCount: 3, // ← real success
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const toastModule = await import('react-hot-toast');
    const toastSuccessSpy = vi.spyOn(toastModule.default, 'success');

    renderPanel(true);
    fireEvent.click(await screen.findByTestId('unattached-action-instapay'));
    await waitFor(() =>
      expect(paymentsApi.backfillUnattached).toHaveBeenCalled(),
    );
    await waitFor(() => expect(toastSuccessSpy).toHaveBeenCalledTimes(1));
    expect(toastSuccessSpy).toHaveBeenCalledWith(
      expect.stringMatching(/تم ربط 3 عملية/),
    );
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

  // ─── PR-FIN-PAYACCT-4D-UX-FIX-14 ──────────────────────────────────
  // Pin the operator-friendly UI cleanup for cash unattached rows:
  //   • info-level icon + container (not amber/warning).
  //   • canonical Arabic message + title.
  //   • formatted Arabic date range (no raw JS Date or PG timestamp).
  //   • Arabic source-table badge ("فواتير البيع" not "invoice_payments").
  //   • no backfill button rendered for cash (defense in depth even
  //     if the BE flips `supported` to TRUE).

  it('PR-FIN-PAYACCT-4D-UX-FIX-14: cash row renders the canonical Arabic message + title', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([CASH_BUCKET]);
    renderPanel(true);
    const row = await screen.findByTestId(
      'unattached-row-invoice_payments-cash',
    );
    expect(row.textContent).toMatch(/عمليات نقدية مسجلة عبر الخزنة/);
    expect(row.textContent).toMatch(/النقدية تُسجَّل عبر الخزائن ولا تحتاج حساب دفع/);
  });

  it('PR-FIN-PAYACCT-4D-UX-FIX-14: cash row uses the info-style icon, not the warning icon', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([CASH_BUCKET]);
    renderPanel(true);
    const row = await screen.findByTestId(
      'unattached-row-invoice_payments-cash',
    );
    // Info icon present, warning icon absent.
    expect(
      within(row).getByTestId('unattached-row-icon-info-invoice_payments-cash'),
    ).toBeInTheDocument();
    expect(
      within(row).queryByTestId('unattached-row-icon-warn-invoice_payments-cash'),
    ).toBeNull();
  });

  it('PR-FIN-PAYACCT-4D-UX-FIX-14: cash-only summary drops the amber container styling', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([CASH_BUCKET]);
    renderPanel(true);
    const panel = await screen.findByTestId('unattached-panel');
    // Amber tone is gone when nothing is actionable.
    expect(panel.className).not.toMatch(/amber/);
    // Slate tone is on so the box reads as informational.
    expect(panel.className).toMatch(/slate/);
  });

  it('PR-FIN-PAYACCT-4D-UX-FIX-14: any actionable bucket re-introduces the amber container', async () => {
    // Cash + InstaPay together — InstaPay is actionable, so the panel
    // surfaces amber (operator action needed somewhere).
    (paymentsApi.unattachedSummary as any).mockResolvedValue([
      CASH_BUCKET,
      INSTAPAY_BUCKET,
    ]);
    renderPanel(true);
    const panel = await screen.findByTestId('unattached-panel');
    expect(panel.className).toMatch(/amber/);
  });

  it('PR-FIN-PAYACCT-4D-UX-FIX-14: source-table column renders the Arabic label, not the raw schema name', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([CASH_BUCKET]);
    renderPanel(true);
    const row = await screen.findByTestId(
      'unattached-row-invoice_payments-cash',
    );
    const badge = within(row).getByTestId(
      'unattached-source-badge-invoice_payments-cash',
    );
    expect(badge.textContent?.trim()).toBe('فواتير البيع');
    // Raw schema name MUST NOT appear anywhere in the row.
    expect(row.textContent).not.toMatch(/invoice_payments/);
    expect(row.textContent).not.toMatch(/customer_payments/);
    expect(row.textContent).not.toMatch(/supplier_payments/);
  });

  it('PR-FIN-PAYACCT-4D-UX-FIX-14: customer_payments + supplier_payments source labels render in Arabic too', async () => {
    // Build a synthetic non-cash bucket variant per source table; we
    // care about the label, not the action button.
    (paymentsApi.unattachedSummary as any).mockResolvedValue([
      { ...CASH_BUCKET, source_table: 'customer_payments' },
      { ...CASH_BUCKET, source_table: 'supplier_payments' },
    ]);
    renderPanel(true);
    const cust = await screen.findByTestId(
      'unattached-source-badge-customer_payments-cash',
    );
    expect(cust.textContent?.trim()).toBe('قبض العملاء');
    const supp = screen.getByTestId(
      'unattached-source-badge-supplier_payments-cash',
    );
    expect(supp.textContent?.trim()).toBe('مدفوعات الموردين');
  });

  it('PR-FIN-PAYACCT-4D-UX-FIX-14: date range is formatted in Arabic — never the raw JS Date string', async () => {
    // Production driver: BE serialised `MIN(created_at)` via
    // `String(b.earliest)` and produced "Wed Apr 29 2026 00:00:00
    // GMT+0300 ...". The FE must render an Arabic date and never
    // leak that JS-ese into the operator UI.
    (paymentsApi.unattachedSummary as any).mockResolvedValue([
      {
        ...CASH_BUCKET,
        earliest: 'Wed Apr 29 2026 00:00:00 GMT+0300 (Eastern European Summer Time)',
        latest:   'Fri May 01 2026 00:00:00 GMT+0300 (Eastern European Summer Time)',
      },
    ]);
    renderPanel(true);
    const row = await screen.findByTestId(
      'unattached-row-invoice_payments-cash',
    );
    // Raw JS-ese must NOT appear.
    expect(row.textContent).not.toMatch(/GMT\+0300/);
    expect(row.textContent).not.toMatch(/Wed Apr/);
    // Arabic-formatted range must appear.
    const dr = within(row).getByTestId(
      'unattached-date-range-invoice_payments-cash',
    );
    // `Intl.DateTimeFormat('ar-EG', …)` includes the keyword "من ... إلى ...".
    expect(dr.textContent).toMatch(/من /);
    expect(dr.textContent).toMatch(/ إلى /);
  });

  it('PR-FIN-PAYACCT-4D-UX-FIX-14: ISO-8601 input also formats as Arabic without leaking the raw timestamp', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([
      {
        ...CASH_BUCKET,
        earliest: '2026-04-20T13:06:42.082Z',
        latest:   '2026-04-30T19:39:27.728Z',
      },
    ]);
    renderPanel(true);
    const row = await screen.findByTestId(
      'unattached-row-invoice_payments-cash',
    );
    expect(row.textContent).not.toMatch(/2026-04-20T/);
    expect(row.textContent).not.toMatch(/13:06:42/);
    const dr = within(row).getByTestId(
      'unattached-date-range-invoice_payments-cash',
    );
    expect(dr.textContent).toMatch(/من /);
    expect(dr.textContent).toMatch(/ إلى /);
  });

  it('PR-FIN-PAYACCT-4D-UX-FIX-14: cash never renders a backfill button even if BE flips `supported` to TRUE', async () => {
    // Defense in depth: even an accidental BE schema change can't
    // expose a backfill action for cash from this panel.
    (paymentsApi.unattachedSummary as any).mockResolvedValue([
      {
        ...CASH_BUCKET,
        supported: true,                                        // ← misbehaving BE
        target_account: { ...INSTAPAY_BUCKET.target_account! }, // ← misbehaving BE
      },
    ]);
    renderPanel(true);
    const row = await screen.findByTestId(
      'unattached-row-invoice_payments-cash',
    );
    expect(within(row).queryByTestId('unattached-action-cash')).toBeNull();
  });

  it('PR-FIN-PAYACCT-4D-UX-FIX-14: InstaPay path is unchanged — button text + click flow still work', async () => {
    (paymentsApi.unattachedSummary as any).mockResolvedValue([INSTAPAY_BUCKET]);
    (paymentsApi.backfillUnattached as any).mockResolvedValue({
      method: 'instapay', dryRun: false,
      targetAccount: { id: INSTAPAY_BUCKET.target_account!.id, display_name: 'InstaPay', identifier: '01004888879' },
      before: { rowCount: 3, totalAmount: '1050.00' },
      after: { rowCount: 0, totalAmount: '0' },
      updatedCount: 3,
    });
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPanel(true);
    const action = await screen.findByTestId('unattached-action-instapay');
    expect(action.textContent?.trim()).toBe('ربط عمليات InstaPay التاريخية');
    fireEvent.click(action);
    await waitFor(() =>
      expect(paymentsApi.backfillUnattached).toHaveBeenCalledWith({
        method: 'instapay',
        dryRun: false,
      }),
    );
    confirmSpy.mockRestore();
  });
});
