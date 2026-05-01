/**
 * CashboxDriftDetailPanel.test.tsx — PR-FIN-PAYACCT-4D-REPORTS-1A
 *
 * Pins the read-only drift drilldown panel:
 *   • Header + cashbox name + read-only footer note render.
 *   • Totals render with signed money formatting and the per-ref
 *     total_drift matches the production +250.00 EGP fixture.
 *   • Coverage badges render the correct Arabic label per
 *     CT_only / JE_only / both.
 *   • Reference-type codes are rendered as Arabic labels (no raw
 *     `invoice` / `customer_payment` / `shift_variance` codes leak).
 *   • Dates flow through `formatArabicDate` — no raw JS Date or
 *     PG timestamp shapes leak.
 *   • Empty state renders "لا توجد تفاصيل فجوة لهذه الخزنة".
 *   • Defense-in-depth: the panel module imports zero mutation
 *     primitives (`useMutation`, `mutate`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cashDeskApi, type CashboxDriftDetailResponse } from '@/api/cash-desk.api';
import { CashboxDriftDetailPanel } from '../CashboxDriftDetailPanel';

vi.mock('@/api/cash-desk.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    cashDeskApi: {
      ...((actual.cashDeskApi as object) ?? {}),
      driftDetail: vi.fn(),
    },
  };
});

const CASHBOX_ID = '524646d5-7bd6-4d8d-a484-b1f562b039a4';

// Production-shaped fixture: 3 real economic gaps that sum to +250.00 EGP
// (the same set we observed via `v_cashbox_drift_per_ref` for
// الخزينة الرئيسية during the REPORTS-1 audit). The 12 self-cancelling
// label-mismatch pairs are intentionally omitted — the BE service filters
// `ABS(drift) > 0.01`, but those pairs are non-zero per ref. The FE
// fixture mirrors what the operator actually needs to see: the 3 rows
// that *drive* the +250 number.
const PROD_DRIFT_RESPONSE: CashboxDriftDetailResponse = {
  cashbox: {
    id: CASHBOX_ID,
    name: 'الخزينة الرئيسية',
    kind: 'cash',
    is_active: true,
    stored_balance: '29800.00',
    gl_net: '29550.00',
    gl_drift: '250.00',
  },
  rows: [
    {
      cashbox_id: CASHBOX_ID,
      cashbox_name: 'الخزينة الرئيسية',
      reference_type: 'invoice',
      reference_id: '61017528-7377-4691-9711-6f7f9bafe5b7',
      reference_no: 'INV-001234',
      coverage: 'both',
      ct_count: 5,
      je_line_count: 1,
      ct_signed_amount: '1050.00',
      je_signed_amount: '350.00',
      drift_amount: '700.00',
      first_seen_at: '2026-04-30T13:24:33.695Z',
      last_seen_at:  '2026-04-30T14:15:09.379Z',
      sample_entry_no: 'JE-2026-000333',
    },
    {
      cashbox_id: CASHBOX_ID,
      cashbox_name: 'الخزينة الرئيسية',
      reference_type: 'return',
      reference_id: '73824179-3e2c-458f-a3bf-3cd87f1b3381',
      reference_no: null,
      coverage: 'CT_only',
      ct_count: 1,
      je_line_count: 0,
      ct_signed_amount: '-650.00',
      je_signed_amount: '0',
      drift_amount: '-650.00',
      first_seen_at: '2026-04-28T17:02:44.893Z',
      last_seen_at:  '2026-04-28T17:02:44.893Z',
      sample_entry_no: null,
    },
    {
      cashbox_id: CASHBOX_ID,
      cashbox_name: 'الخزينة الرئيسية',
      reference_type: 'invoice',
      reference_id: '44e7effa-da2a-4e48-a409-0291edaa19ee',
      reference_no: 'INV-001230',
      coverage: 'both',
      ct_count: 4,
      je_line_count: 1,
      ct_signed_amount: '400.00',
      je_signed_amount: '200.00',
      drift_amount: '200.00',
      first_seen_at: '2026-04-28T11:24:15.389Z',
      last_seen_at:  '2026-04-28T13:23:23.017Z',
      sample_entry_no: 'JE-2026-000286',
    },
  ],
  totals: { count: 3, total_ct: '800.00', total_je: '550.00', total_drift: '250.00' },
};

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <CashboxDriftDetailPanel cashboxId={CASHBOX_ID} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('CashboxDriftDetailPanel — PR-FIN-PAYACCT-4D-REPORTS-1A', () => {
  it('calls cashDeskApi.driftDetail with the cashbox id', async () => {
    (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_DRIFT_RESPONSE);
    renderPanel();
    await waitFor(() =>
      expect(cashDeskApi.driftDetail).toHaveBeenCalledWith(CASHBOX_ID),
    );
  });

  it('renders the title, cashbox name, and the read-only footer note', async () => {
    (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_DRIFT_RESPONSE);
    renderPanel();
    expect(
      screen.getByText('تقرير فجوة الخزنة مع الأستاذ العام'),
    ).toBeInTheDocument();
    // Cashbox name appears AFTER the query resolves — wait for it.
    await waitFor(() =>
      expect(
        screen.getByTestId('cashbox-drift-detail-cashbox-name').textContent,
      ).toBe('الخزينة الرئيسية'),
    );
    const note = screen.getByTestId('cashbox-drift-detail-readonly-note');
    expect(note.textContent).toMatch(/هذه قراءة فقط/);
    expect(note.textContent).toMatch(/لا يتم إجراء أي تسوية تلقائية/);
  });

  it('renders summary cards (UX-FIX): total drift, count, real, self-cancelling', async () => {
    (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_DRIFT_RESPONSE);
    renderPanel();
    // Cards mount once the data lands — wait for the count card.
    await waitFor(() =>
      expect(
        screen.getByTestId('cashbox-drift-detail-summary-count').textContent,
      ).toMatch(/3/),
    );
    expect(
      screen.getByTestId('cashbox-drift-detail-summary-total-drift').textContent,
    ).toMatch(/\+250\.00/);
    // 3 real economic rows that sum to +250 (matches production fixture).
    expect(
      screen.getByTestId('cashbox-drift-detail-summary-real').textContent,
    ).toMatch(/3 · \+250\.00/);
    // Self-cancelling pairs: 0 in this fixture (the production split
    // shape lives in the categorize spec; here we only verify the card
    // renders the right zero state).
    expect(
      screen.getByTestId(
        'cashbox-drift-detail-summary-self-cancelling',
      ).textContent,
    ).toMatch(/0/);
  });

  it('renders the cashbox-level cross-check value (gl_drift = +250.00)', async () => {
    (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_DRIFT_RESPONSE);
    renderPanel();
    const cross = await screen.findByTestId(
      'cashbox-drift-detail-totals-gl-drift',
    );
    expect(cross.textContent).toMatch(/\+250\.00/);
  });

  it('renders one row per contributing reference with coverage badge + signed amounts', async () => {
    (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_DRIFT_RESPONSE);
    renderPanel();
    // Three rows: invoice 61017528 / return 73824179 / invoice 44e7effa.
    await screen.findByTestId(
      'cashbox-drift-detail-row-invoice-61017528-7377-4691-9711-6f7f9bafe5b7',
    );
    expect(
      screen.getByTestId(
        'cashbox-drift-detail-row-return-73824179-3e2c-458f-a3bf-3cd87f1b3381',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(
        'cashbox-drift-detail-row-invoice-44e7effa-da2a-4e48-a409-0291edaa19ee',
      ),
    ).toBeInTheDocument();
    // Drift amounts (signed) on each row.
    expect(
      screen.getByTestId(
        'cashbox-drift-detail-drift-invoice-61017528-7377-4691-9711-6f7f9bafe5b7',
      ).textContent,
    ).toMatch(/\+700\.00/);
    expect(
      screen.getByTestId(
        'cashbox-drift-detail-drift-return-73824179-3e2c-458f-a3bf-3cd87f1b3381',
      ).textContent,
    ).toMatch(/-650\.00/);
    expect(
      screen.getByTestId(
        'cashbox-drift-detail-drift-invoice-44e7effa-da2a-4e48-a409-0291edaa19ee',
      ).textContent,
    ).toMatch(/\+200\.00/);
  });

  it('renders Arabic coverage badges (CT_only / JE_only / both) — never the raw schema codes', async () => {
    (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_DRIFT_RESPONSE);
    renderPanel();
    const both = await screen.findByTestId(
      'cashbox-drift-detail-coverage-invoice-61017528-7377-4691-9711-6f7f9bafe5b7',
    );
    expect(both.textContent?.trim()).toBe('كلاهما (بفرق)');
    const ctOnly = screen.getByTestId(
      'cashbox-drift-detail-coverage-return-73824179-3e2c-458f-a3bf-3cd87f1b3381',
    );
    expect(ctOnly.textContent?.trim()).toBe('في الخزنة فقط');
  });

  it('renders Arabic reference-type labels — never the raw schema codes', async () => {
    (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_DRIFT_RESPONSE);
    renderPanel();
    // UX-FIX: rows now live inside the "real" table.
    const rowsRoot = await screen.findByTestId(
      'cashbox-drift-detail-table-real',
    );
    expect(within(rowsRoot).getAllByText(/فاتورة بيع/).length).toBeGreaterThanOrEqual(1);
    expect(within(rowsRoot).getByText(/مرتجع/)).toBeInTheDocument();
    // Raw schema codes must NOT appear inside the rows table.
    expect(rowsRoot.textContent).not.toMatch(/\binvoice\b/);
    expect(rowsRoot.textContent).not.toMatch(/\breturn\b/);
    expect(rowsRoot.textContent).not.toMatch(/\bcustomer_payment\b/);
    expect(rowsRoot.textContent).not.toMatch(/\bsupplier_payment\b/);
  });

  it('renders dates via the Arabic formatter — never raw JS Date or PG timestamp leakage', async () => {
    (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_DRIFT_RESPONSE);
    renderPanel();
    const root = await screen.findByTestId('cashbox-drift-detail-panel');
    // Raw ISO and stringified-Date shapes must be absent.
    expect(root.textContent).not.toMatch(/2026-04-30T13:24:33/);
    expect(root.textContent).not.toMatch(/2026-04-28T11:24:15/);
    expect(root.textContent).not.toMatch(/GMT\+0300/);
    expect(root.textContent).not.toMatch(/Wed Apr/);
  });

  it('renders the empty state when no drift rows are returned', async () => {
    (cashDeskApi.driftDetail as any).mockResolvedValue({
      cashbox: { ...PROD_DRIFT_RESPONSE.cashbox!, gl_drift: '0.00' },
      rows: [],
      totals: { count: 0, total_ct: '0', total_je: '0', total_drift: '0' },
    });
    renderPanel();
    expect(
      await screen.findByTestId('cashbox-drift-detail-empty'),
    ).toHaveTextContent('لا توجد تفاصيل فجوة لهذه الخزنة');
    // UX-FIX: neither group table renders when there are no rows.
    expect(screen.queryByTestId('cashbox-drift-detail-table-real')).toBeNull();
    expect(screen.queryByTestId('cashbox-drift-detail-table-self')).toBeNull();
  });

  it('close button fires the onClose callback', async () => {
    (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_DRIFT_RESPONSE);
    const onClose = vi.fn();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <CashboxDriftDetailPanel cashboxId={CASHBOX_ID} onClose={onClose} />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByTestId('cashbox-drift-detail-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * PR-FIN-PAYACCT-4D-REPORTS-1A — read-only contract pinned at the
   * source-code level. Reads the panel module's text and asserts it
   * imports zero mutation primitives. If a future edit accidentally
   * adds `useMutation` or calls `.mutate(...)`, this test fails before
   * the change can ship.
   */
  it('source code: panel imports zero mutation primitives (no useMutation, no .mutate)', () => {
    const panelPath = resolve(
      __dirname,
      '..',
      'CashboxDriftDetailPanel.tsx',
    );
    const src = readFileSync(panelPath, 'utf8');
    expect(src).not.toMatch(/\buseMutation\b/);
    // `.mutate(` would catch both `mutation.mutate(...)` and `xMutation.mutate(...)`.
    expect(src).not.toMatch(/\.mutate\(/);
  });

  // ─── PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX ───────────────────────────
  // Pin the rewritten layout: full-screen overlay, contributors block,
  // guidance block, two-table grouping, and the optional Excel/Print
  // toolbar. Production-shaped fixture below uses the real +250 split:
  //   • 3 real economic rows (sum +250).
  //   • 2 self-cancelling label-mismatch rows (same reference_id, sum 0).
  describe('PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX rewrite', () => {
    const SHIFT_REF_ID = 'accd3480-a815-4c66-914e-cbd9869765b0';
    const PROD_FIXTURE_FULL = {
      ...PROD_DRIFT_RESPONSE,
      rows: [
        ...PROD_DRIFT_RESPONSE.rows,
        // Self-cancelling pair on the same reference_id (shift +17.99
        // in CT, shift_variance -17.99 in JE → net 0 per ref_id).
        {
          cashbox_id: CASHBOX_ID,
          cashbox_name: 'الخزينة الرئيسية',
          reference_type: 'shift',
          reference_id: SHIFT_REF_ID,
          reference_no: null,
          coverage: 'CT_only' as const,
          ct_count: 1, je_line_count: 0,
          ct_signed_amount: '17.99', je_signed_amount: '0', drift_amount: '17.99',
          first_seen_at: '2026-04-26T07:16:14Z', last_seen_at: '2026-04-26T07:16:14Z',
          sample_entry_no: null,
        },
        {
          cashbox_id: CASHBOX_ID,
          cashbox_name: 'الخزينة الرئيسية',
          reference_type: 'shift_variance',
          reference_id: SHIFT_REF_ID,
          reference_no: null,
          coverage: 'JE_only' as const,
          ct_count: 0, je_line_count: 1,
          ct_signed_amount: '0', je_signed_amount: '17.99', drift_amount: '-17.99',
          first_seen_at: '2026-04-26T07:16:14Z', last_seen_at: '2026-04-26T07:16:14Z',
          sample_entry_no: 'JE-2026-000242',
        },
      ],
      totals: { count: 5, total_ct: '817.99', total_je: '567.99', total_drift: '250.00' },
    };

    it('panel mounts as a full-screen overlay (fixed inset, dim backdrop)', async () => {
      (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_FIXTURE_FULL);
      renderPanel();
      const overlay = await screen.findByTestId(
        'cashbox-drift-detail-overlay',
      );
      // The overlay sits at fixed inset-0 — full viewport.
      expect(overlay.className).toMatch(/fixed/);
      expect(overlay.className).toMatch(/inset-0/);
      // The dialog card itself.
      const dlg = within(overlay).getByTestId('cashbox-drift-detail-panel');
      expect(dlg).toHaveAttribute('role', 'dialog');
      expect(dlg).toHaveAttribute('aria-modal', 'true');
    });

    it('clicking the dim backdrop closes the modal', async () => {
      (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_FIXTURE_FULL);
      const onClose = vi.fn();
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={qc}>
          <CashboxDriftDetailPanel cashboxId={CASHBOX_ID} onClose={onClose} />
        </QueryClientProvider>,
      );
      const overlay = await screen.findByTestId(
        'cashbox-drift-detail-overlay',
      );
      // Click the backdrop directly (not the card).
      fireEvent.click(overlay);
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('renders the "ما سبب الفرق؟" contributors with the top 3 production gaps', async () => {
      (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_FIXTURE_FULL);
      renderPanel();
      const contrib = await screen.findByTestId(
        'cashbox-drift-detail-contributors',
      );
      // Three real economic gaps from the production fixture appear here.
      expect(contrib.textContent).toMatch(/INV-001234/);
      expect(contrib.textContent).toMatch(/\+700\.00/);
      expect(contrib.textContent).toMatch(/-650\.00/);
      expect(contrib.textContent).toMatch(/\+200\.00/);
      // Each contributor has its own testid.
      expect(
        within(contrib).getByTestId(
          'cashbox-drift-detail-contributor-invoice-61017528-7377-4691-9711-6f7f9bafe5b7',
        ),
      ).toBeInTheDocument();
    });

    it('renders the "ماذا أفعل؟" guidance block with the four read-only steps', async () => {
      (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_FIXTURE_FULL);
      renderPanel();
      const guide = await screen.findByTestId(
        'cashbox-drift-detail-guidance',
      );
      expect(guide.textContent).toMatch(/ماذا أفعل؟/);
      expect(guide.textContent).toMatch(/راجع الفواتير ذات الفرق أولاً/);
      expect(guide.textContent).toMatch(/لا تقم بتسوية تلقائية/);
      expect(guide.textContent).toMatch(/شاشة التسويات/);
      expect(guide.textContent).toMatch(/تصحيح مطابقة\/تصنيف/);
    });

    it('groups rows into two tables: real-economic + self-cancelling (with badges)', async () => {
      (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_FIXTURE_FULL);
      renderPanel();
      // Both group tables render.
      const realTbl = await screen.findByTestId('cashbox-drift-detail-table-real');
      const selfTbl = screen.getByTestId('cashbox-drift-detail-table-self');
      // Real table contains the 3 real economic rows.
      expect(
        within(realTbl).getByTestId(
          'cashbox-drift-detail-row-invoice-61017528-7377-4691-9711-6f7f9bafe5b7',
        ),
      ).toBeInTheDocument();
      expect(
        within(realTbl).getByTestId(
          'cashbox-drift-detail-row-return-73824179-3e2c-458f-a3bf-3cd87f1b3381',
        ),
      ).toBeInTheDocument();
      // Self table contains the shift / shift_variance pair (same ref_id).
      expect(
        within(selfTbl).getByTestId(
          `cashbox-drift-detail-row-shift-${SHIFT_REF_ID}`,
        ),
      ).toBeInTheDocument();
      expect(
        within(selfTbl).getByTestId(
          `cashbox-drift-detail-row-shift_variance-${SHIFT_REF_ID}`,
        ),
      ).toBeInTheDocument();
      // Badges: real rows say "سبب رئيسي", self rows say "يلغي نفسه".
      const realBadge = within(realTbl).getByTestId(
        'cashbox-drift-detail-row-badge-invoice-61017528-7377-4691-9711-6f7f9bafe5b7',
      );
      expect(realBadge.textContent).toMatch(/سبب رئيسي/);
      const selfBadge = within(selfTbl).getByTestId(
        `cashbox-drift-detail-row-badge-shift-${SHIFT_REF_ID}`,
      );
      expect(selfBadge.textContent).toMatch(/يلغي نفسه/);
    });

    it('does NOT render any "تسوية تلقائية" / settle / fix action button', async () => {
      (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_FIXTURE_FULL);
      renderPanel();
      await screen.findByTestId('cashbox-drift-detail-panel');
      // Action-button testids that would imply a write surface — none must exist.
      expect(screen.queryByTestId('cashbox-drift-detail-auto-settle')).toBeNull();
      expect(screen.queryByTestId('cashbox-drift-detail-fix-now')).toBeNull();
      expect(screen.queryByTestId('cashbox-drift-detail-correct')).toBeNull();
    });

    it('Excel toolbar button invokes XLSX.writeFile with the loaded rows', async () => {
      const xlsx = await import('xlsx');
      const writeSpy = vi
        .spyOn(xlsx, 'writeFile')
        .mockImplementation(() => undefined as any);
      (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_FIXTURE_FULL);
      renderPanel();
      const btn = await screen.findByTestId(
        'cashbox-drift-detail-export-excel',
      );
      await waitFor(() => expect(btn).not.toBeDisabled());
      fireEvent.click(btn);
      await waitFor(() => expect(writeSpy).toHaveBeenCalledTimes(1));
      const filename = String(writeSpy.mock.calls[0]?.[1] ?? '');
      expect(filename).toMatch(/^cashbox-drift-report-/);
      expect(filename).toMatch(/\.xlsx$/);
      writeSpy.mockRestore();
    });

    it('Print/PDF toolbar button opens a window via window.open with the report HTML', async () => {
      const fakeDoc = { write: vi.fn(), close: vi.fn() };
      const openSpy = vi
        .spyOn(window, 'open')
        .mockReturnValue({ document: fakeDoc } as any);
      (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_FIXTURE_FULL);
      renderPanel();
      const btn = await screen.findByTestId(
        'cashbox-drift-detail-print-report',
      );
      await waitFor(() => expect(btn).not.toBeDisabled());
      fireEvent.click(btn);
      await waitFor(() => expect(openSpy).toHaveBeenCalledTimes(1));
      const html = String(fakeDoc.write.mock.calls[0]?.[0] ?? '');
      // Title + cashbox name + read-only footer + a totals card.
      expect(html).toMatch(/تقرير فجوة الخزنة/);
      expect(html).toMatch(/الخزينة الرئيسية/);
      expect(html).toMatch(/ما سبب الفرق؟/);
      expect(html).toMatch(/ماذا أفعل؟/);
      expect(html).toMatch(
        /هذه قراءة فقط؛ لا يتم إجراء أي تسوية تلقائية/,
      );
      openSpy.mockRestore();
    });

    it('Excel/Print buttons are disabled when there are no rows (no blank exports)', async () => {
      (cashDeskApi.driftDetail as any).mockResolvedValue({
        cashbox: { ...PROD_DRIFT_RESPONSE.cashbox!, gl_drift: '0.00' },
        rows: [],
        totals: { count: 0, total_ct: '0', total_je: '0', total_drift: '0' },
      });
      renderPanel();
      const excel = await screen.findByTestId(
        'cashbox-drift-detail-export-excel',
      );
      const print = screen.getByTestId('cashbox-drift-detail-print-report');
      expect(excel).toBeDisabled();
      expect(print).toBeDisabled();
    });

    it('Esc key closes the modal', async () => {
      (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_FIXTURE_FULL);
      const onClose = vi.fn();
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={qc}>
          <CashboxDriftDetailPanel cashboxId={CASHBOX_ID} onClose={onClose} />
        </QueryClientProvider>,
      );
      await screen.findByTestId('cashbox-drift-detail-panel');
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
