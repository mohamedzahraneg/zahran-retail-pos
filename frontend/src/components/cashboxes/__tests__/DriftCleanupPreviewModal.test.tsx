/**
 * DriftCleanupPreviewModal.test.tsx
 * ─────────────────────────────────────────────────────────────────────
 * PR-FIN-PAYACCT-4D-DRIFT-HISTORICAL-CLEANUP-1
 *
 * Pins the safety contract of the operator-only DRY-RUN preview UI:
 *   • The component issues exactly one network call:
 *     `accountsApi.previewDriftCleanup()` — which itself POSTs
 *     `{dryRun: true}` (verified at the API-layer, not here).
 *   • The component module imports zero mutation primitives —
 *     `useMutation`, `mutate` — so it cannot trigger writes.
 *   • Renders the Arabic summary cards with KPIs from the response.
 *   • Renders Pattern A invoice rows + per-row keep/void plan.
 *   • Renders Pattern B return rows.
 *   • Renders ambiguous-skipped rows in their own section.
 *   • "نسخ JSON" button copies the response via navigator.clipboard.
 *   • The component never references `dryRun: false` or any confirm
 *     token literal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { accountsApi, type DriftCleanupPreview } from '@/api/accounts.api';
import { DriftCleanupPreviewModal } from '../DriftCleanupPreviewModal';

vi.mock('@/api/accounts.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    accountsApi: {
      ...((actual.accountsApi as object) ?? {}),
      previewDriftCleanup: vi.fn(),
    },
  };
});

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

describe('DriftCleanupPreviewModal — safety contract', () => {
  it('component module imports zero mutation primitives (no useMutation/mutate)', () => {
    const src = readFileSync(
      resolve(__dirname, '../DriftCleanupPreviewModal.tsx'),
      'utf8',
    );
    // The whole point of this dry-run modal is that it cannot write.
    // If you find yourself wanting to add a write here, stop and use the
    // backend endpoint directly with confirm token from a trusted session.
    expect(src).not.toMatch(/\buseMutation\b/);
    expect(src).not.toMatch(/\bmutate\b/);
    // No execute path: the literal `dryRun: false` must NEVER appear.
    expect(src).not.toMatch(/dryRun\s*:\s*false/);
    // No confirm token in FE.
    expect(src).not.toMatch(/DRIFT_HISTORICAL_CLEANUP_2026_05/);
    expect(src).not.toMatch(/EXECUTE_CONFIRM_TOKEN/);
  });

  it('issues exactly one previewDriftCleanup() call (the dry-run)', async () => {
    (accountsApi.previewDriftCleanup as any).mockResolvedValue(FIXTURE);
    renderModal();
    await waitFor(() =>
      expect(accountsApi.previewDriftCleanup).toHaveBeenCalledTimes(1),
    );
    // No second call is made on render.
    expect(accountsApi.previewDriftCleanup).toHaveBeenCalledTimes(1);
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
