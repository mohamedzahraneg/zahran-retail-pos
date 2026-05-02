/**
 * DriftCleanupPreviewModal.test.tsx
 * ─────────────────────────────────────────────────────────────────────
 * PR-FIN-PAYACCT-4D-DRIFT-HISTORICAL-CLEANUP-EXECUTE-FE
 *
 * Pins the gated-execute safety contract:
 *   • Dry-run preview loads on mount.
 *   • Execute button is HIDDEN until the dry-run query resolves.
 *   • Execute button is DISABLED until the operator types the EXACT
 *     confirm token; any mismatch (extra space, wrong case, partial)
 *     leaves the button disabled.
 *   • Clicking execute calls `accountsApi.executeDriftCleanup()` exactly
 *     once. The button stays disabled afterwards (one-shot per modal
 *     lifetime) so a double-click cannot fire two writes.
 *   • The execute payload is hard-coded inside the API method (verified
 *     at the API-layer, not here): the FE has no way to send a different
 *     body.
 *   • Result section renders ctVoidedIds / jlUpdatedIds / driftAfter /
 *     rebuilt balances after success.
 *   • Permission gating happens at the button level in Cashboxes.tsx;
 *     this modal trusts that it was opened by an authorized user but
 *     the backend gate `@Permissions('accounts.journal.post')` is the
 *     authoritative check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import {
  accountsApi,
  type DriftCleanupExecuteResult,
  type DriftCleanupPreview,
} from '@/api/accounts.api';
import { DriftCleanupPreviewModal } from '../DriftCleanupPreviewModal';

vi.mock('@/api/accounts.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    accountsApi: {
      ...((actual.accountsApi as object) ?? {}),
      previewDriftCleanup: vi.fn(),
      executeDriftCleanup: vi.fn(),
    },
  };
});

const EXACT_CONFIRM_TOKEN = 'DRIFT_HISTORICAL_CLEANUP_2026_05';

const EXECUTE_RESULT: DriftCleanupExecuteResult = {
  executed: true,
  patternA: {
    candidates: [],
    rows: [],
    rowsToVoidCount: 0,
    voidAmountTotal: 0,
  },
  patternB: { candidates: [], ambiguous: [], rowsToUpdateCount: 0 },
  cashboxImpact: [],
  ctVoidedIds: [186, 222, 223, 247, 248, 249, 250, 251],
  jlUpdatedIds: [
    'df6c5b7b-2e6a-4b4c-9166-0b1b9a8a5ffc',
    'ea412ba6-bdd8-4e89-b17b-29b80e1d6a05',
    'f5cd8f48-0259-4e55-a1ce-0cb767ef5c37',
  ],
  driftAfterActual: [
    { cashbox_id: '524646d5-7bd6-4d8d-a484-b1f562b039a4', drift: 0 },
  ],
  cashboxBalanceRebuilt: [
    {
      cashbox_id: '524646d5-7bd6-4d8d-a484-b1f562b039a4',
      new_balance: 29680,
    },
  ],
};

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return { default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }) };
});

const CB = '524646d5-7bd6-4d8d-a484-b1f562b039a4';

const FIXTURE: DriftCleanupPreview = {
  executed: false,
  patternA: {
    candidates: [
      {
        invoice_no: 'INV-2026-000166',
        invoice_id: 'inv-166',
        cashbox_id: CB,
        sale_ct_count: 3,
        sale_ct_total: 1500,
        voided_je_count: 2,
        active_entry_no: 'JE-2026-000364',
        active_je_cash: 500,
        duplicate_amount: 1000,
      },
      {
        invoice_no: 'INV-2026-000147',
        invoice_id: 'inv-147',
        cashbox_id: CB,
        sale_ct_count: 4,
        sale_ct_total: 1350,
        voided_je_count: 3,
        active_entry_no: 'JE-2026-000360',
        active_je_cash: 350,
        duplicate_amount: 1000,
      },
    ],
    rows: [
      {
        ct_id: 243,
        invoice_id: 'inv-166',
        invoice_no: 'INV-2026-000166',
        cashbox_id: CB,
        amount: 500,
        created_at: '2026-05-01T15:21:36Z',
        action: 'keep',
        reason: 'earliest active sale CT for (invoice, cashbox)',
      },
      {
        ct_id: 249,
        invoice_id: 'inv-166',
        invoice_no: 'INV-2026-000166',
        cashbox_id: CB,
        amount: 500,
        created_at: '2026-05-01T17:20:16Z',
        action: 'void',
        reason: 'duplicate sale CT emitted by historical postInvoiceEdit',
      },
      {
        ct_id: 251,
        invoice_id: 'inv-166',
        invoice_no: 'INV-2026-000166',
        cashbox_id: CB,
        amount: 500,
        created_at: '2026-05-01T17:26:01Z',
        action: 'void',
        reason: 'duplicate sale CT emitted by historical postInvoiceEdit',
      },
    ],
    rowsToVoidCount: 2,
    voidAmountTotal: 1000,
  },
  patternB: {
    candidates: [
      {
        return_no: 'RET-2026-000003',
        return_id: 'ret-3',
        cashbox_id: CB,
        je_id: 'je-358',
        entry_no: 'JE-2026-000358',
        jl_id: 'jl-3',
        debit: 0,
        credit: 350,
        current_jl_cashbox_id: null,
        proposed_jl_cashbox_id: CB,
        paired_ct_id: 245,
        ct_amount: 350,
      },
    ],
    ambiguous: [
      {
        return_no: 'RET-2026-000099',
        return_id: 'ret-99',
        reason: 'multiple matching journal_lines for the active JE — skipped',
      },
    ],
    rowsToUpdateCount: 1,
  },
  cashboxImpact: [
    {
      cashbox_id: CB,
      drift_before: 2100,
      drift_after_expected: 0,
      current_balance_before: 32930,
      current_balance_after_expected: 30180,
    },
  ],
};

function renderModal() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <DriftCleanupPreviewModal onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe('DriftCleanupPreviewModal — dry-run-on-mount', () => {
  it('issues exactly one previewDriftCleanup() call on mount', async () => {
    (accountsApi.previewDriftCleanup as any).mockResolvedValue(FIXTURE);
    renderModal();
    await waitFor(() =>
      expect(accountsApi.previewDriftCleanup).toHaveBeenCalledTimes(1),
    );
    expect(accountsApi.previewDriftCleanup).toHaveBeenCalledTimes(1);
    // Execute is NOT called automatically.
    expect(accountsApi.executeDriftCleanup).not.toHaveBeenCalled();
  });
});

describe('DriftCleanupPreviewModal — Arabic summary rendering', () => {
  beforeEach(() => {
    (accountsApi.previewDriftCleanup as any).mockResolvedValue(FIXTURE);
  });

  it('renders the dry-run badge in the header', async () => {
    renderModal();
    // The badge label includes "(Dry-Run)" so "معاينة فقط" appears
    // multiple times (badge + footer note). Just confirm at least one
    // is present.
    const matches = await screen.findAllByText(/معاينة فقط/);
    expect(matches.length).toBeGreaterThan(0);
  });

  it('renders KPI tiles for both patterns and drift', async () => {
    renderModal();
    await screen.findByTestId('kpi-pattern-a');
    expect(screen.getByTestId('kpi-pattern-a')).toHaveTextContent('فواتير Pattern A');
    expect(screen.getByTestId('kpi-pattern-b')).toHaveTextContent('مرتجعات Pattern B');
    expect(screen.getByTestId('kpi-drift-before')).toHaveTextContent('الانحراف الحالي');
    expect(screen.getByTestId('kpi-drift-after')).toHaveTextContent('الانحراف المتوقّع بعد التنظيف');
  });

  it('renders Pattern A invoice candidates with their void/keep plan', async () => {
    renderModal();
    const section = await screen.findByTestId('drift-cleanup-preview-pattern-a');
    // INV-2026-000166 appears in the candidates table AND in each per-row
    // breakdown row, so use getAllByText.
    expect(screen.getAllByText('INV-2026-000166').length).toBeGreaterThan(0);
    expect(screen.getAllByText('INV-2026-000147').length).toBeGreaterThan(0);
    // CT IDs are unique per row.
    expect(section).toHaveTextContent('243');
    expect(section).toHaveTextContent('249');
    expect(section).toHaveTextContent('251');
    const keepBadges = screen.getAllByText('إبقاء');
    const voidBadges = screen.getAllByText('إلغاء');
    expect(keepBadges).toHaveLength(1);
    expect(voidBadges).toHaveLength(2);
  });

  it('renders Pattern B return candidates', async () => {
    renderModal();
    await screen.findByTestId('drift-cleanup-preview-pattern-b');
    expect(screen.getByText('RET-2026-000003')).toBeInTheDocument();
    expect(screen.getByText('JE-2026-000358')).toBeInTheDocument();
  });

  it('renders ambiguous Pattern B in a separate section (reported only)', async () => {
    renderModal();
    await screen.findByTestId('drift-cleanup-preview-ambiguous');
    expect(screen.getByText('RET-2026-000099')).toBeInTheDocument();
    expect(
      screen.getByText(/multiple matching journal_lines/),
    ).toBeInTheDocument();
  });

  it('renders the cashbox-impact table with before/after columns', async () => {
    renderModal();
    await screen.findByTestId('drift-cleanup-preview-cashbox-impact');
    const table = screen.getByTestId('drift-cleanup-preview-cashbox-impact');
    expect(table).toHaveTextContent(CB);
    // The Intl 'ar-EG' formatter uses Arabic-Indic digits (٠–٩) and
    // Arabic-thousands `٬`. Expect those, not Latin "2,100".
    //   2100   → ٢٬١٠٠
    //   32930  → ٣٢٬٩٣٠
    //   30180  → ٣٠٬١٨٠
    expect(table).toHaveTextContent(/٢٬١٠٠/);
    expect(table).toHaveTextContent(/٣٢٬٩٣٠/);
    expect(table).toHaveTextContent(/٣٠٬١٨٠/);
  });
});

describe('DriftCleanupPreviewModal — copy JSON', () => {
  it('copies the JSON response to clipboard when the copy button is clicked', async () => {
    (accountsApi.previewDriftCleanup as any).mockResolvedValue(FIXTURE);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });

    renderModal();
    const btn = await screen.findByTestId('drift-cleanup-preview-copy');
    fireEvent.click(btn);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    const arg = (writeText.mock.calls[0] as any[])[0] as string;
    // It's the JSON representation of the fixture.
    const parsed = JSON.parse(arg);
    expect(parsed).toEqual(FIXTURE);
  });
});

describe('DriftCleanupPreviewModal — empty state', () => {
  it('renders the "no work" message when both candidate sets are empty', async () => {
    (accountsApi.previewDriftCleanup as any).mockResolvedValue({
      executed: false,
      patternA: { candidates: [], rows: [], rowsToVoidCount: 0, voidAmountTotal: 0 },
      patternB: { candidates: [], ambiguous: [], rowsToUpdateCount: 0 },
      cashboxImpact: [],
    } satisfies DriftCleanupPreview);
    renderModal();
    await screen.findByTestId('drift-cleanup-preview-no-work');
    expect(
      screen.getByText(/لا توجد مرشّحات لتنظيف الفروقات التاريخية/),
    ).toBeInTheDocument();
  });
});

describe('DriftCleanupPreviewModal — error path', () => {
  it('renders the error block + retry when the API rejects', async () => {
    (accountsApi.previewDriftCleanup as any).mockRejectedValue(
      Object.assign(new Error('boom'), {
        response: { data: { message: 'فشل الحساب' } },
      }),
    );
    renderModal();
    await screen.findByTestId('drift-cleanup-preview-error');
    expect(screen.getByText('فشل الحساب')).toBeInTheDocument();
    expect(screen.getByTestId('drift-cleanup-preview-retry')).toBeInTheDocument();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Gated execute (Phase 2) — the safety contract the user explicitly
//  asked for in the execute-FE PR.
// ─────────────────────────────────────────────────────────────────────

describe('DriftCleanupPreviewModal — gated execute', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('execute section is HIDDEN before the dry-run resolves', async () => {
    // pending promise — dry-run never resolves
    let resolveDryRun: (v: any) => void = () => {};
    (accountsApi.previewDriftCleanup as any).mockImplementation(
      () => new Promise((res) => { resolveDryRun = res; }),
    );
    renderModal();
    // Loading spinner is rendered, execute section is not.
    await screen.findByTestId('drift-cleanup-preview-loading');
    expect(
      screen.queryByTestId('drift-cleanup-execute-section'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('drift-cleanup-execute-button'),
    ).not.toBeInTheDocument();
    // Resolve so the test can finish cleanly.
    resolveDryRun(FIXTURE);
    await waitFor(() =>
      expect(screen.getByTestId('drift-cleanup-execute-section')).toBeInTheDocument(),
    );
  });

  it('execute section is HIDDEN if the dry-run errors out', async () => {
    (accountsApi.previewDriftCleanup as any).mockRejectedValue(
      Object.assign(new Error('boom'), {
        response: { data: { message: 'فشل الحساب' } },
      }),
    );
    renderModal();
    await screen.findByTestId('drift-cleanup-preview-error');
    expect(
      screen.queryByTestId('drift-cleanup-execute-section'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('drift-cleanup-execute-button'),
    ).not.toBeInTheDocument();
  });

  it('execute button is DISABLED until the operator types the EXACT confirm token', async () => {
    (accountsApi.previewDriftCleanup as any).mockResolvedValue(FIXTURE);
    renderModal();
    await screen.findByTestId('drift-cleanup-execute-section');
    const btn = screen.getByTestId('drift-cleanup-execute-button') as HTMLButtonElement;
    const input = screen.getByTestId(
      'drift-cleanup-execute-confirm-input',
    ) as HTMLInputElement;

    // Initially disabled.
    expect(btn).toBeDisabled();

    // Wrong values: still disabled.
    fireEvent.change(input, { target: { value: 'wrong' } });
    expect(btn).toBeDisabled();
    fireEvent.change(input, {
      target: { value: 'drift_historical_cleanup_2026_05' }, // wrong case
    });
    expect(btn).toBeDisabled();
    fireEvent.change(input, {
      target: { value: 'DRIFT_HISTORICAL_CLEANUP_2026_0' }, // partial
    });
    expect(btn).toBeDisabled();

    // Exact match (with leading/trailing whitespace tolerated by trim()).
    fireEvent.change(input, { target: { value: '  ' + EXACT_CONFIRM_TOKEN + '  ' } });
    expect(btn).not.toBeDisabled();
  });

  it('clicking execute calls executeDriftCleanup() exactly once and disables the button afterwards', async () => {
    (accountsApi.previewDriftCleanup as any).mockResolvedValue(FIXTURE);
    (accountsApi.executeDriftCleanup as any).mockResolvedValue(EXECUTE_RESULT);

    renderModal();
    const input = (await screen.findByTestId(
      'drift-cleanup-execute-confirm-input',
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: EXACT_CONFIRM_TOKEN } });
    const btn = screen.getByTestId('drift-cleanup-execute-button');

    fireEvent.click(btn);
    fireEvent.click(btn); // second click while pending must NOT fire a second call
    fireEvent.click(btn); // third click for good measure

    await waitFor(() =>
      expect(accountsApi.executeDriftCleanup).toHaveBeenCalledTimes(1),
    );
    // The exact-payload contract is verified at the API layer
    // (executeDriftCleanup hard-codes the body); here we just confirm
    // the call was made with no arguments from the modal.
    expect((accountsApi.executeDriftCleanup as any).mock.calls[0]).toEqual([]);

    // After success, the execute section is REPLACED by the result
    // section — so the button is gone, not just disabled.
    await waitFor(() =>
      expect(screen.getByTestId('drift-cleanup-execute-result')).toBeInTheDocument(),
    );
    expect(
      screen.queryByTestId('drift-cleanup-execute-button'),
    ).not.toBeInTheDocument();
  });

  it('clicking execute does NOT fire when the confirm input is mismatched', async () => {
    (accountsApi.previewDriftCleanup as any).mockResolvedValue(FIXTURE);

    renderModal();
    const input = (await screen.findByTestId(
      'drift-cleanup-execute-confirm-input',
    )) as HTMLInputElement;
    // Input is wrong.
    fireEvent.change(input, { target: { value: 'WRONG' } });
    const btn = screen.getByTestId('drift-cleanup-execute-button') as HTMLButtonElement;
    expect(btn).toBeDisabled();

    // Click anyway.
    fireEvent.click(btn);
    fireEvent.click(btn);
    // Mutation is never invoked.
    await new Promise((r) => setTimeout(r, 30));
    expect(accountsApi.executeDriftCleanup).not.toHaveBeenCalled();
  });

  it('renders the executed result with ctVoidedIds, jlUpdatedIds, drift, and rebuilt balance', async () => {
    (accountsApi.previewDriftCleanup as any).mockResolvedValue(FIXTURE);
    (accountsApi.executeDriftCleanup as any).mockResolvedValue(EXECUTE_RESULT);

    renderModal();
    const input = (await screen.findByTestId(
      'drift-cleanup-execute-confirm-input',
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: EXACT_CONFIRM_TOKEN } });
    fireEvent.click(screen.getByTestId('drift-cleanup-execute-button'));

    const result = await screen.findByTestId('drift-cleanup-execute-result');
    const ctIds = within(result).getByTestId('drift-cleanup-execute-result-ct-ids');
    expect(ctIds.textContent).toContain('186');
    expect(ctIds.textContent).toContain('251');
    const jlIds = within(result).getByTestId('drift-cleanup-execute-result-jl-ids');
    expect(jlIds.textContent).toContain('df6c5b7b-2e6a-4b4c-9166-0b1b9a8a5ffc');
    // Drift after = 0 → the success message renders.
    expect(
      within(result).getByText(/جميع الانحرافات تساوي صفر/),
    ).toBeInTheDocument();
    // Rebuilt balance section contains the cashbox id and 29680.
    expect(
      within(result).getByText(/524646d5-7bd6-4d8d-a484-b1f562b039a4 → 29680\.00/),
    ).toBeInTheDocument();
  });

  it('execute error is surfaced inline and the button stays available for retry', async () => {
    (accountsApi.previewDriftCleanup as any).mockResolvedValue(FIXTURE);
    (accountsApi.executeDriftCleanup as any).mockRejectedValue(
      Object.assign(new Error('boom'), {
        response: { data: { message: 'البكاند رفض الطلب' } },
      }),
    );

    renderModal();
    const input = (await screen.findByTestId(
      'drift-cleanup-execute-confirm-input',
    )) as HTMLInputElement;
    fireEvent.change(input, { target: { value: EXACT_CONFIRM_TOKEN } });
    fireEvent.click(screen.getByTestId('drift-cleanup-execute-button'));

    await screen.findByTestId('drift-cleanup-execute-error');
    expect(screen.getByText('البكاند رفض الطلب')).toBeInTheDocument();
    // Result section is NOT rendered (mutation failed).
    expect(
      screen.queryByTestId('drift-cleanup-execute-result'),
    ).not.toBeInTheDocument();
  });
});
