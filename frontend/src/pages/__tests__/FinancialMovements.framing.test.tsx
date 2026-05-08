/**
 * FinancialMovements.framing.test.tsx
 * ────────────────────────────────────────────────────────────────────
 *
 * History:
 *   · PR-FE-ACCOUNTING-FINANCIAL-MOVEMENTS-FRAMING (#327) introduced
 *     this page as a framing/planning shell.
 *   · PR-FE-ACCOUNTING-FINANCIAL-MOVEMENTS-TRACE wired it to the
 *     read-only `GET /audit/financial-movements/trace` endpoint.
 *   · PR-FE-ACCOUNTING-FINANCIAL-MOVEMENTS-LIST adds a browse-by-period
 *     panel powered by `GET /audit/financial-movements`.
 *
 * Tests pin the read-only contract for both modes:
 *   1.  Title + "قراءة فقط" badge.
 *   2.  Read-only notice present.
 *   3.  Search form has 4 inputs + a submit button.
 *   4.  Default mount auto-fires list with period=today.
 *   5.  Period tabs switch the list query.
 *   6.  Custom range applies from/to to the list query.
 *   7.  Browse list renders summary cards + rows.
 *   8.  Empty list state when no movements in the range.
 *   9.  Clicking "عرض التتبع" triggers the deep-trace useQuery.
 *  10.  After submit + mocked successful response: source / summary /
 *       flags / journal-entries / journal-lines / cashbox-txns /
 *       stock-movements panels all render.
 *  11.  Permission-denied state on 403 (deep trace).
 *  12.  Empty result on SOURCE_NOT_FOUND.
 *  13.  NO mutation surface — no `useMutation`, no `mutationFn`,
 *       no `.mutate(`, no executive-verb function calls.
 *  14.  Source-link in the result summary points to a real route.
 *  15.  List API never receives mutation params and only the read-only
 *       methods are called.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { readFileSync } from 'node:fs';
import FinancialMovements from '@/pages/FinancialMovements';

vi.mock('@/api/audit-trace.api', () => ({
  auditTraceApi: {
    trace: vi.fn(),
    list: vi.fn(),
  },
}));

import { auditTraceApi } from '@/api/audit-trace.api';

const EMPTY_LIST_RESULT = {
  period: 'today' as const,
  from: '2026-05-08',
  to: '2026-05-08',
  limit: 100,
  items: [],
  totals: {
    total: 0,
    with_journal: 0,
    with_cashbox_transaction: 0,
    with_stock_movement: 0,
    with_flags: 0,
  },
  truncated: false,
};

const SAMPLE_LIST_RESULT = {
  period: 'today' as const,
  from: '2026-05-08',
  to: '2026-05-08',
  limit: 100,
  items: [
    {
      source_type: 'invoice' as const,
      source_id: 'inv-aaaa',
      number: 'INV-2026-000010',
      date: '2026-05-08T10:00:00Z',
      party_id: 'cust-1',
      party_name: 'عميل ١',
      total: '250.00',
      status: 'paid',
      has_journal: true,
      has_cashbox_transaction: true,
      has_stock_movement: true,
      flags_count: 0,
    },
    {
      source_type: 'expense' as const,
      source_id: 'exp-bbbb',
      number: 'EXP-2026-000003',
      date: '2026-05-08T08:00:00Z',
      party_id: null,
      party_name: 'كهرباء',
      total: '40.00',
      status: 'posted',
      has_journal: true,
      has_cashbox_transaction: true,
      has_stock_movement: false,
      flags_count: 0,
    },
  ],
  totals: {
    total: 2,
    with_journal: 2,
    with_cashbox_transaction: 2,
    with_stock_movement: 1,
    with_flags: 0,
  },
  truncated: false,
};

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/audit/financial-movements']}>
        <FinancialMovements />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const HEALTHY_INVOICE_RESPONSE = {
  source: {
    type: 'invoice',
    id: 'inv-1',
    number: 'INV-2026-000001',
    date: '2026-04-30T10:00:00Z',
    user_id: 'u-1',
    user_name: 'كاشير',
    customer_id: 'c-1',
    customer_name: 'عميل تجريبي',
    supplier_id: null,
    supplier_name: null,
    total: '100.00',
    paid: '100.00',
    status: 'paid',
    warehouse_id: 'w-1',
    cashbox_id: null,
    notes: null,
  },
  journalEntries: [
    {
      id: 'je-1',
      entry_no: 'JV-2026-000001',
      entry_date: '2026-04-30',
      description: 'فاتورة مبيعات',
      reference_type: 'invoice',
      reference_id: 'inv-1',
      is_posted: true,
      is_void: false,
      void_reason: null,
      reversal_of: null,
      posted_by_name: 'كاشير',
      voided_by_name: null,
      total_debit: '100.00',
      total_credit: '100.00',
      is_balanced: true,
    },
  ],
  journalLines: [
    {
      id: 'jl-1',
      entry_id: 'je-1',
      line_no: 1,
      account_id: 'acc-1111',
      account_code: '1111',
      account_name: 'الخزينة الرئيسية',
      debit: '100.00',
      credit: '0.00',
      description: 'كاش',
      cashbox_id: 'cb-1',
      cashbox_name_ar: 'الخزينة الرئيسية',
      warehouse_id: null,
    },
    {
      id: 'jl-2',
      entry_id: 'je-1',
      line_no: 2,
      account_id: 'acc-411',
      account_code: '411',
      account_name: 'إيرادات المبيعات',
      debit: '0.00',
      credit: '100.00',
      description: 'إيراد',
      cashbox_id: null,
      cashbox_name_ar: null,
      warehouse_id: null,
    },
  ],
  cashboxTransactions: [
    {
      id: 12345,
      cashbox_id: 'cb-1',
      cashbox_name_ar: 'الخزينة الرئيسية',
      direction: 'in',
      amount: '100.00',
      category: 'sale',
      reference_type: 'invoice',
      reference_id: 'inv-1',
      balance_after: '500.00',
      notes: 'بيع',
      user_id: 'u-1',
      user_name: 'كاشير',
      created_at: '2026-04-30T10:00:00Z',
    },
  ],
  stockMovements: [
    {
      id: 22222,
      variant_id: 'v-1',
      variant_sku: 'SKU-1',
      product_name_ar: 'منتج تجريبي',
      warehouse_id: 'w-1',
      warehouse_name_ar: 'المخزن الرئيسي',
      movement_type: 'sale',
      direction: 'out',
      quantity: 1,
      unit_cost: '60.00',
      reference_type: 'invoice',
      reference_id: 'inv-1',
      notes: null,
      user_id: 'u-1',
      user_name: 'كاشير',
      created_at: '2026-04-30T10:00:00Z',
    },
  ],
  idempotency: [],
  flags: [],
  summary: {
    hasJournal: true,
    hasCashboxTransaction: true,
    hasStockMovement: true,
    journalBalanced: true,
    cashMatched: true,
    stockMatched: true,
    source_total: '100.00',
    journal_cash_total: '100.00',
    cashbox_signed_total: '100.00',
  },
};

describe('<FinancialMovements /> — read-only browse + trace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Most tests don't care about the list result — let it settle to
    // empty so the page is in a steady state.  Tests that need real
    // list data override this with `mockResolvedValueOnce`.
    (auditTraceApi.list as any).mockResolvedValue(EMPTY_LIST_RESULT);
  });

  // ─── 1. Title + read-only badge ───────────────────────────────
  it('renders the page title "تتبع حركة مالية" and the "قراءة فقط" badge', () => {
    renderPage();
    expect(
      screen.getByTestId('financial-movements-header').textContent,
    ).toMatch(/تتبع حركة مالية/);
    expect(
      screen.getByTestId('financial-movements-readonly-badge').textContent,
    ).toBe('قراءة فقط');
  });

  // ─── 2. Read-only notice ──────────────────────────────────────
  it('renders the read-only notice (no create / edit / reverse)', () => {
    renderPage();
    const notice = screen.getByTestId('financial-movements-readonly-notice');
    expect(notice.textContent).toMatch(/للمراجعة فقط/);
    expect(notice.textContent).toMatch(/لا يتم إنشاء أو تعديل أو عكس/);
    expect(notice.textContent).toMatch(/تشخيص/);
  });

  // ─── 3. Search form inputs ────────────────────────────────────
  it('renders the 4 search inputs and a submit button', () => {
    renderPage();
    expect(
      screen.getByTestId('financial-movements-reference-type'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('financial-movements-q-input'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('financial-movements-reference-id-input'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('financial-movements-idempotency-key-input'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('financial-movements-search-submit'),
    ).toBeInTheDocument();
  });

  // ─── 4. Default mount auto-fires list with period=today ──────
  it('auto-fires list query with period=today on mount', async () => {
    renderPage();
    await waitFor(() =>
      expect(auditTraceApi.list).toHaveBeenCalled(),
    );
    const firstCall = (auditTraceApi.list as any).mock.calls[0]?.[0];
    expect(firstCall?.period).toBe('today');
    // Empty hint (detail area) is still mounted — no row clicked yet.
    expect(
      screen.getByTestId('financial-movements-empty-hint'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('financial-movements-result'),
    ).toBeNull();
    // Browse panel is mounted with default today tab active.
    expect(
      screen.getByTestId('financial-movements-browse-panel'),
    ).toBeInTheDocument();
    const todayTab = screen.getByTestId(
      'financial-movements-period-today',
    ) as HTMLButtonElement;
    expect(todayTab.getAttribute('aria-selected')).toBe('true');
  });

  // ─── 4b. Period switch fires list with new period ─────────────
  it('switching period tab refires list with the new period', async () => {
    renderPage();
    await waitFor(() =>
      expect(auditTraceApi.list).toHaveBeenCalled(),
    );
    fireEvent.click(screen.getByTestId('financial-movements-period-week'));
    await waitFor(() => {
      const periods = (auditTraceApi.list as any).mock.calls.map(
        (c: any[]) => c[0]?.period,
      );
      expect(periods).toContain('week');
    });
  });

  // ─── 4c. Custom range apply ───────────────────────────────────
  it('custom range tab waits for apply, then fires list with from/to', async () => {
    renderPage();
    await waitFor(() =>
      expect(auditTraceApi.list).toHaveBeenCalled(),
    );
    const callsBefore = (auditTraceApi.list as any).mock.calls.length;
    fireEvent.click(screen.getByTestId('financial-movements-period-custom'));
    // Custom inputs visible.
    expect(
      screen.getByTestId('financial-movements-custom-from'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('financial-movements-custom-to'),
    ).toBeInTheDocument();
    // No new list call until apply is pressed.
    expect((auditTraceApi.list as any).mock.calls.length).toBe(callsBefore);

    fireEvent.change(
      screen.getByTestId('financial-movements-custom-from') as HTMLInputElement,
      { target: { value: '2026-04-01' } },
    );
    fireEvent.change(
      screen.getByTestId('financial-movements-custom-to') as HTMLInputElement,
      { target: { value: '2026-04-30' } },
    );
    fireEvent.click(screen.getByTestId('financial-movements-custom-apply'));

    await waitFor(() => {
      const last = (auditTraceApi.list as any).mock.calls.at(-1)?.[0];
      expect(last?.period).toBe('custom');
      expect(last?.from).toBe('2026-04-01');
      expect(last?.to).toBe('2026-04-30');
    });
  });

  // ─── 4d. List renders summary cards + rows ────────────────────
  it('renders summary cards and movement rows from list data', async () => {
    (auditTraceApi.list as any).mockResolvedValueOnce(SAMPLE_LIST_RESULT);
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByTestId('financial-movements-list-summary'),
      ).toBeInTheDocument(),
    );
    // Five summary cards.
    expect(
      screen.getByTestId('financial-movements-list-summary-total').textContent,
    ).toMatch(/2/);
    expect(
      screen.getByTestId('financial-movements-list-summary-with_journal')
        .textContent,
    ).toMatch(/2/);
    expect(
      screen.getByTestId('financial-movements-list-summary-with_cashbox')
        .textContent,
    ).toMatch(/2/);
    expect(
      screen.getByTestId('financial-movements-list-summary-with_stock')
        .textContent,
    ).toMatch(/1/);
    expect(
      screen.getByTestId('financial-movements-list-summary-with_flags')
        .textContent,
    ).toMatch(/0/);

    // Both rows visible.
    expect(
      screen.getByTestId('financial-movements-list-row-inv-aaaa'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('financial-movements-list-row-exp-bbbb'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('financial-movements-list-table').textContent,
    ).toMatch(/INV-2026-000010/);
  });

  // ─── 4e. Empty list state ─────────────────────────────────────
  it('renders empty list state when no movements in the period', async () => {
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByTestId('financial-movements-list-empty'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('financial-movements-list-empty').textContent,
    ).toMatch(/لا توجد حركات مالية في هذه الفترة/);
  });

  // ─── 4f. Click "عرض التتبع" loads deep trace ──────────────────
  it('clicking row trace button fires the deep-trace query', async () => {
    (auditTraceApi.list as any).mockResolvedValueOnce(SAMPLE_LIST_RESULT);
    (auditTraceApi.trace as any).mockResolvedValueOnce(HEALTHY_INVOICE_RESPONSE);
    renderPage();
    await waitFor(() =>
      expect(
        screen.getByTestId('financial-movements-list-row-inv-aaaa'),
      ).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByTestId('financial-movements-list-trace-inv-aaaa'),
    );

    await waitFor(() =>
      expect(auditTraceApi.trace).toHaveBeenCalled(),
    );
    const traceCall = (auditTraceApi.trace as any).mock.calls[0][0];
    expect(traceCall.reference_type).toBe('invoice');
    expect(traceCall.reference_id).toBe('inv-aaaa');

    await waitFor(() =>
      expect(
        screen.getByTestId('financial-movements-result'),
      ).toBeInTheDocument(),
    );
  });

  // ─── 5. Successful trace renders all panels ───────────────────
  it('renders the full trace result for a healthy invoice', async () => {
    (auditTraceApi.trace as any).mockResolvedValueOnce(HEALTHY_INVOICE_RESPONSE);
    renderPage();
    fireEvent.change(
      screen.getByTestId('financial-movements-q-input') as HTMLInputElement,
      { target: { value: 'INV-2026-000001' } },
    );
    fireEvent.click(screen.getByTestId('financial-movements-search-submit'));

    await waitFor(() =>
      expect(
        screen.getByTestId('financial-movements-result'),
      ).toBeInTheDocument(),
    );

    // Source card with the invoice number.
    expect(
      screen.getByTestId('financial-movements-source-card').textContent,
    ).toMatch(/INV-2026-000001/);
    // Summary card.
    expect(
      screen.getByTestId('financial-movements-summary-card'),
    ).toBeInTheDocument();
    // Journal entries / lines / cashbox txns / stock movements panels.
    expect(
      screen.getByTestId('financial-movements-journal-entries'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('financial-movements-journal-lines'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('financial-movements-cashbox-transactions'),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId('financial-movements-stock-movements'),
    ).toBeInTheDocument();
    // Healthy invoice → flags-empty panel, NOT a populated flags panel.
    expect(
      screen.getByTestId('financial-movements-flags-empty'),
    ).toBeInTheDocument();
  });

  // ─── 6. Permission-denied state on 403 ────────────────────────
  it('renders the permission-denied state when API returns 403', async () => {
    const err: any = new Error('Forbidden');
    err.response = { status: 403, data: { message: 'forbidden' } };
    (auditTraceApi.trace as any).mockRejectedValueOnce(err);
    renderPage();
    fireEvent.change(
      screen.getByTestId('financial-movements-q-input') as HTMLInputElement,
      { target: { value: 'INV-X' } },
    );
    fireEvent.click(screen.getByTestId('financial-movements-search-submit'));

    await waitFor(() =>
      expect(
        screen.getByTestId('financial-movements-permission-denied'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('financial-movements-permission-denied').textContent,
    ).toMatch(/audit\.view/);
  });

  // ─── 7. SOURCE_NOT_FOUND empty result ─────────────────────────
  it('renders the no-result state when the BE finds no matching source', async () => {
    (auditTraceApi.trace as any).mockResolvedValueOnce({
      source: null,
      journalEntries: [],
      journalLines: [],
      cashboxTransactions: [],
      stockMovements: [],
      idempotency: [],
      flags: [
        {
          code: 'SOURCE_NOT_FOUND',
          severity: 'warning',
          message_ar: 'لم يتم العثور على حركة مرتبطة بهذا المرجع.',
        },
      ],
      summary: {
        hasJournal: false,
        hasCashboxTransaction: false,
        hasStockMovement: false,
        journalBalanced: null,
        cashMatched: null,
        stockMatched: null,
        source_total: null,
        journal_cash_total: null,
        cashbox_signed_total: null,
      },
    });
    renderPage();
    fireEvent.change(
      screen.getByTestId('financial-movements-q-input') as HTMLInputElement,
      { target: { value: 'NOPE' } },
    );
    fireEvent.click(screen.getByTestId('financial-movements-search-submit'));

    await waitFor(() =>
      expect(
        screen.getByTestId('financial-movements-no-result'),
      ).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId('financial-movements-no-result').textContent,
    ).toMatch(/لا توجد نتيجة/);
  });

  // ─── 8/9. NO mutation surface + NO repair buttons ─────────────
  it('page source has no mutation surface, no executive-verb calls', () => {
    const src = readFileSync('src/pages/FinancialMovements.tsx', 'utf-8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    // No react-query mutation hooks.
    expect(code).not.toMatch(/\buseMutation\b/);
    expect(code).not.toMatch(/\bmutationFn\b/);
    expect(code).not.toMatch(/\.mutate\(/);

    // No FinancialEngine / engineApi / journalApi / postJournal in code.
    expect(code).not.toMatch(/\bFinancialEngine\b/);
    expect(code).not.toMatch(/\bengineApi\.\w+/);
    expect(code).not.toMatch(/\bjournalApi\.\w+/);
    expect(code).not.toMatch(/\bpostJournal\b/);

    // Executive-verb function calls forbidden.
    expect(code).not.toMatch(/\bapprove\(/);
    expect(code).not.toMatch(/\bpay\(/);
    expect(code).not.toMatch(/\breverse\(/);
    expect(code).not.toMatch(/\bvoid[A-Z]\w*\(/);
    expect(code).not.toMatch(/\bpost[A-Z]\w*\(/);
    expect(code).not.toMatch(/\brepair\(/);

    // No mutation HTTP verbs are even imported as helpers.
    expect(code).not.toMatch(/api\.post\(/);
    expect(code).not.toMatch(/api\.put\(/);
    expect(code).not.toMatch(/api\.patch\(/);
    expect(code).not.toMatch(/api\.delete\(/);
  });

  // ─── 10. Source-link in summary points to an existing route ──
  it('source-link routes to an existing operational page (invoice → /invoices)', async () => {
    (auditTraceApi.trace as any).mockResolvedValueOnce(HEALTHY_INVOICE_RESPONSE);
    renderPage();
    fireEvent.change(
      screen.getByTestId('financial-movements-q-input') as HTMLInputElement,
      { target: { value: 'INV-2026-000001' } },
    );
    fireEvent.click(screen.getByTestId('financial-movements-search-submit'));

    await waitFor(() =>
      expect(
        screen.getByTestId('financial-movements-source-link'),
      ).toBeInTheDocument(),
    );
    const link = screen.getByTestId(
      'financial-movements-source-link',
    ) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/invoices');
  });
});
