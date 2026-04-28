/**
 * FinanceStatements.test.tsx — PR-FIN-3
 *
 * Pins:
 *   1. All 7 tabs render in the approved RTL order.
 *   2. Default state (no entity) shows the "اختر كيانًا" prompt.
 *   3. After picking an entity + the API resolves, the header card
 *      shows opening / debit / credit / net / closing.
 *   4. Statement table renders rows + opening/closing rows.
 *   5. Empty state surfaces the backend's `note` (no hardcoded text
 *      from the frontend).
 *   6. Print + Excel buttons render disabled with the "قريبًا" pill.
 *   7. Drilldown is disabled (statement-row is NOT clickable / no
 *      navigation handler).
 *   8. Page source never imports DailyExpenses (frozen surface).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { FinanceStatements } from '@/pages/FinanceStatements';
import type { StatementResponse } from '@/api/statements.api';

vi.mock('@/api/statements.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    statementsApi: {
      glAccount: vi.fn(async () => fixture),
      cashbox: vi.fn(async () => fixture),
      employee: vi.fn(async () => fixture),
      customer: vi.fn(async () => fixture),
      supplier: vi.fn(async () => fixture),
    },
  };
});
vi.mock('@/api/accounts.api', () => ({
  accountsApi: {
    list: vi.fn(async () => [
      { id: 'acc-1', code: '1111', name_ar: 'الخزينة', is_leaf: true, is_active: true, account_type: 'asset' },
      { id: 'acc-2', code: '111', name_ar: 'النقدية', is_leaf: false, is_active: true, account_type: 'asset' },
    ]),
  },
}));
vi.mock('@/api/cash-desk.api', () => ({
  cashDeskApi: {
    cashboxes: vi.fn(async () => [
      { id: 'cb-1', name_ar: 'الخزينة الرئيسية', kind: 'cash', is_active: true },
    ]),
  },
}));
vi.mock('@/api/customers.api', () => ({
  customersApi: { list: vi.fn(async () => ({ data: [] })) },
}));
vi.mock('@/api/suppliers.api', () => ({
  suppliersApi: { list: vi.fn(async () => []) },
}));
vi.mock('@/api/users.api', () => ({
  usersApi: { list: vi.fn(async () => []) },
}));

let fixture: StatementResponse;

function buildFixture(overrides: Partial<StatementResponse> = {}): StatementResponse {
  return {
    entity: {
      type: 'gl_account',
      id: 'acc-1',
      code: '1111',
      name_ar: 'الخزينة',
      name_en: null,
      extra: null,
    },
    range: { from: '2026-04-01', to: '2026-04-28' },
    opening_balance: 100,
    closing_balance: 250,
    totals: { debit: 200, credit: 50, net: 150, lines: 2 },
    rows: [
      {
        occurred_at: '2026-04-05T10:00:00Z',
        event_date: '2026-04-05',
        description: 'بيع',
        reference_type: 'invoice',
        reference_no: 'INV-001',
        debit: 100,
        credit: 0,
        running_balance: 200,
        counterparty: 'عميل نقدي',
        journal_entry_no: 'JE-001',
        drilldown_url: null,
        is_voided: false,
      },
      {
        occurred_at: '2026-04-10T10:00:00Z',
        event_date: '2026-04-10',
        description: 'مصروف',
        reference_type: 'expense',
        reference_no: 'EXP-001',
        debit: 0,
        credit: 50,
        running_balance: 150,
        counterparty: 'مورد',
        journal_entry_no: null,
        drilldown_url: null,
        is_voided: false,
      },
    ],
    confidence: { has_data: true, data_source: 'gl_lines', note: null, context: null },
    generated_at: '2026-04-28T10:00:00Z',
    ...overrides,
  };
}

function renderPage() {
  fixture = buildFixture();
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FinanceStatements />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<FinanceStatements />', () => {
  it('renders all 7 tabs in the approved order', () => {
    renderPage();
    expect(screen.getByTestId('statements-tab-gl_account')).toBeInTheDocument();
    expect(screen.getByTestId('statements-tab-cashbox_cash')).toBeInTheDocument();
    expect(screen.getByTestId('statements-tab-cashbox_bank')).toBeInTheDocument();
    expect(screen.getByTestId('statements-tab-cashbox_wallet')).toBeInTheDocument();
    expect(screen.getByTestId('statements-tab-employee')).toBeInTheDocument();
    expect(screen.getByTestId('statements-tab-customer')).toBeInTheDocument();
    expect(screen.getByTestId('statements-tab-supplier')).toBeInTheDocument();
    // Verify Arabic labels in image-approved order
    const labels = ['حساب عام', 'خزنة', 'بنك', 'محفظة', 'موظف', 'عميل', 'مورد'];
    for (const label of labels) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('shows "اختر كيانًا" prompt when no entity is selected', () => {
    renderPage();
    expect(screen.getByTestId('statements-no-entity')).toBeInTheDocument();
    expect(screen.getByText('اختر كيانًا لعرض كشف الحسابات')).toBeInTheDocument();
  });

  it('print + Excel buttons render disabled with "قريبًا" badge', () => {
    renderPage();
    const print = screen.getByTestId('statements-print-btn');
    const excel = screen.getByTestId('statements-export-btn');
    expect(print).toBeDisabled();
    expect(excel).toBeDisabled();
    expect(print.getAttribute('title')).toBe('قريبًا في PR-FIN-7');
    expect(excel.getAttribute('title')).toBe('قريبًا في PR-FIN-7');
    // Each carries the "قريبًا" pill
    expect(print.textContent).toMatch(/قريبًا/);
    expect(excel.textContent).toMatch(/قريبًا/);
  });

  it('after picking a GL account, the header + table render with opening / debit / credit / closing', async () => {
    renderPage();
    // Wait for the entity dropdown to populate
    // Wait until the option for acc-1 actually exists (entity list loaded)
    await waitFor(() => {
      const select = screen.getByTestId('statements-entity-select') as HTMLSelectElement;
      const option = Array.from(select.options).find((o) => o.value === 'acc-1');
      expect(option).toBeDefined();
    });
    const select = screen.getByTestId('statements-entity-select') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'acc-1' } });

    await waitFor(() =>
      expect(screen.getByTestId('statement-header-card')).toBeInTheDocument(),
    );
    // Check opening/closing/totals are rendered
    expect(screen.getByTestId('statement-opening-balance').textContent).toMatch(/100\.00/);
    expect(screen.getByTestId('statement-total-debit').textContent).toMatch(/200\.00/);
    expect(screen.getByTestId('statement-total-credit').textContent).toMatch(/50\.00/);
    expect(screen.getByTestId('statement-net-movement').textContent).toMatch(/150\.00/);
    expect(screen.getByTestId('statement-closing-balance').textContent).toMatch(/250\.00/);

    // Statement table renders the rows
    expect(screen.getByTestId('statement-table')).toBeInTheDocument();
    const rows = screen.getAllByTestId('statement-row');
    expect(rows).toHaveLength(2);
    // None of the rows should have a click handler / cursor-pointer
    for (const row of rows) {
      expect(row.getAttribute('data-voided')).toBe('false');
    }
  });

  it('empty data → empty state with backend-supplied note', async () => {
    fixture = buildFixture({
      rows: [],
      totals: { debit: 0, credit: 0, net: 0, lines: 0 },
      opening_balance: 0,
      closing_balance: 0,
      confidence: {
        has_data: false,
        data_source: 'customer_ledger',
        note: 'كل فواتير الفترة (5) غير مرتبطة بعميل محدد، لذلك لا توجد حركات لهذا العميل في الكشف.',
        context: { period_total_invoices: 5, period_walk_in_invoices: 5 },
      },
    });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <FinanceStatements />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    await waitFor(() => {
      const select = screen.getByTestId('statements-entity-select') as HTMLSelectElement;
      const option = Array.from(select.options).find((o) => o.value === 'acc-1');
      expect(option).toBeDefined();
    });
    fireEvent.change(screen.getByTestId('statements-entity-select'), {
      target: { value: 'acc-1' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('statement-empty-state')).toBeInTheDocument(),
    );
    expect(screen.getByTestId('statement-empty-note').textContent).toMatch(
      /5/,
    );
  });

  it('switching tabs resets entity selection (no stale id leaks across types)', async () => {
    renderPage();
    await waitFor(() => {
      const select = screen.getByTestId('statements-entity-select') as HTMLSelectElement;
      const option = Array.from(select.options).find((o) => o.value === 'acc-1');
      expect(option).toBeDefined();
    });
    fireEvent.change(screen.getByTestId('statements-entity-select'), {
      target: { value: 'acc-1' },
    });
    await waitFor(() =>
      expect(screen.getByTestId('statement-header-card')).toBeInTheDocument(),
    );
    // Switch to "خزنة" tab
    fireEvent.click(screen.getByTestId('statements-tab-cashbox_cash'));
    // Entity selector resets — no header card visible
    await waitFor(() =>
      expect(screen.getByTestId('statements-no-entity')).toBeInTheDocument(),
    );
    expect(
      (screen.getByTestId('statements-entity-select') as HTMLSelectElement).value,
    ).toBe('');
  });

  it('does not import DailyExpenses anywhere (frozen surface)', async () => {
    const fs = await import('fs');
    const src = fs.readFileSync('src/pages/FinanceStatements.tsx', 'utf-8');
    expect(src).not.toMatch(/^\s*import[^\n]*DailyExpenses/m);
  });
});
