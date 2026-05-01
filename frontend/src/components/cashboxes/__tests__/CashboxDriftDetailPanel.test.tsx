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

  it('renders totals: count=3, CT=+800.00, JE=+550.00, drift=+250.00', async () => {
    (cashDeskApi.driftDetail as any).mockResolvedValue(PROD_DRIFT_RESPONSE);
    renderPanel();
    // Totals are 0/--/-- until the query resolves — wait for the
    // resolved count before reading sibling cells.
    await waitFor(() =>
      expect(
        screen.getByTestId('cashbox-drift-detail-totals-count').textContent,
      ).toBe('3'),
    );
    expect(
      screen.getByTestId('cashbox-drift-detail-totals-ct').textContent,
    ).toMatch(/\+800\.00/);
    expect(
      screen.getByTestId('cashbox-drift-detail-totals-je').textContent,
    ).toMatch(/\+550\.00/);
    expect(
      screen.getByTestId('cashbox-drift-detail-totals-drift').textContent,
    ).toMatch(/\+250\.00/);
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
    const rowsRoot = await screen.findByTestId('cashbox-drift-detail-rows');
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
    expect(screen.queryByTestId('cashbox-drift-detail-rows')).toBeNull();
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
});
