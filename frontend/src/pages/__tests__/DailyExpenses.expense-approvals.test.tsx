/**
 * DailyExpenses.expense-approvals.test.tsx
 * PR-FIX-EXPENSE-APPROVALS-DISCOVERABILITY
 *
 * Pins the new approval-discoverability surfaces on /daily-expenses:
 *
 *   1. Top alert "اعتمادات مصروفات معلقة" — renders only when the
 *      user has `accounts.approval.decide` AND the approval inbox
 *      returns pending rows.  Links to /financial-controls.
 *
 *   2. Row caption — for genuinely-pending rows (is_approved=false +
 *      not je_is_void):
 *      · users WITH the permission see "عرض الاعتمادات →" linking
 *        to /financial-controls.
 *      · users WITHOUT the permission see the static caption
 *        "بانتظار موافقة مدير" (no clickable affordance).
 *
 *   3. Approved rows + voided-JE rows render NO caption (regression
 *      guard so we don't pollute non-pending rows).
 *
 *   4. The page MUST NOT introduce any approve/reject mutation calls.
 *      The fix is a discoverability surface only — the actual
 *      approve/reject lives on /financial-controls (covered by its
 *      own tests) and the existing edit-request modal flow.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';

import { useAuthStore } from '@/stores/auth.store';
import type { Expense, ApprovalInboxItem } from '@/api/accounting.api';

// ─── Mocks ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  listExpensesMock:     vi.fn(),
  approvalInboxMock:    vi.fn(),
  editRequestsInboxMock: vi.fn(),
  categoriesMock:       vi.fn(),
  profitAndLossMock:    vi.fn(),
  cashboxesMock:        vi.fn(),
  usersMock:            vi.fn(),
  shiftsListMock:       vi.fn(),
  shiftsCurrentMock:    vi.fn(),
  accountsListMock:     vi.fn(),
  approveApprovalMock:  vi.fn(),
  rejectApprovalMock:   vi.fn(),
}));

vi.mock('@/api/accounting.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    accountingApi: {
      ...((actual as any).accountingApi ?? {}),
      listExpenses:        (p: any) => mocks.listExpensesMock(p),
      approvalInbox:       () => mocks.approvalInboxMock(),
      editRequestsInbox:   () => mocks.editRequestsInboxMock(),
      categories:          () => mocks.categoriesMock(),
      profitAndLoss:       (p: any) => mocks.profitAndLossMock(p),
      approveApproval:     mocks.approveApprovalMock,
      rejectApproval:      mocks.rejectApprovalMock,
      // Stubs for any side-channel call the page might make.
      createDailyExpense:    vi.fn(async () => ({})),
      updateExpense:         vi.fn(async () => ({})),
      submitEditRequest:     vi.fn(async () => ({})),
      decideEditRequest:     vi.fn(async () => ({})),
      listEditRequests:      vi.fn(async () => []),
      listExpenseApprovals:  vi.fn(async () => []),
    },
  };
});

vi.mock('@/api/cash-desk.api', () => ({
  cashDeskApi: { cashboxes: () => mocks.cashboxesMock() },
}));
vi.mock('@/api/users.api', () => ({
  usersApi: { pickable: () => mocks.usersMock() },
}));
vi.mock('@/api/shifts.api', () => ({
  shiftsApi: {
    list: () => mocks.shiftsListMock(),
    current: () => mocks.shiftsCurrentMock(),
  },
}));
vi.mock('@/api/accounts.api', () => ({
  accountsApi: { list: () => mocks.accountsListMock() },
}));

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return { default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }) };
});

// Heavy children — render lightweight stubs so the test surface stays
// focused on the alert + row caption.
vi.mock('@/pages/ExpensesAnalyticsPremiumTab', () => ({
  default: () => <div data-testid="analytics-stub" />,
}));
vi.mock('@/components/CashSourceSelector', () => ({
  CashSourceSelector: () => <div data-testid="cash-source-stub" />,
}));

// Export tooling — used by export buttons we don't exercise in this test.
vi.mock('@/lib/exportExcel', () => ({
  exportToExcel: vi.fn(),
  printReport: vi.fn(),
}));

import DailyExpenses from '../DailyExpenses';

// ─── Fixtures ───────────────────────────────────────────────────────

function expenseRow(over: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-base',
    expense_no: 'EXP-2026-000001',
    warehouse_id: 'w-1',
    warehouse_name: 'المخزن',
    cashbox_id: 'cb-1',
    cashbox_name: 'الخزينة الرئيسية',
    category_id: 'cat-1',
    category_name: 'إيجار',
    category_code: '5400',
    amount: 1000,
    payment_method: 'cash',
    expense_date: '2026-05-08',
    description: null,
    receipt_url: null,
    vendor_name: null,
    is_approved: false,
    approved_by: null,
    created_by: 'u-1',
    created_at: '2026-05-08T20:50:51Z',
    shift_id: 'sh-1',
    shift_no: 'SHF-2026-00020',
    je_entry_no: null,
    je_is_void: null,
    has_pending_edit_request: false,
    approved_edit_count: 0,
    rejected_edit_count: 0,
    edit_request_count: 0,
    last_edit_status: null,
    ...over,
  };
}

function inboxItem(over: Partial<ApprovalInboxItem> = {}): ApprovalInboxItem {
  return {
    id: 'app-1',
    expense_id: 'exp-base',
    level: 1,
    required_role: 'manager',
    status: 'pending',
    created_at: '2026-05-08T20:50:51Z',
    expense_no: 'EXP-2026-000001',
    amount: 1000,
    expense_date: '2026-05-08',
    description: null,
    vendor_name: null,
    payment_method: 'cash',
    category_name: 'إيجار',
    category_code: '5400',
    warehouse_name: 'المخزن',
    created_by_name: 'كاشير',
    rule_name: null,
    ...(over as any),
  } as ApprovalInboxItem;
}

function loginWith(permissions: string[]) {
  useAuthStore.setState({
    accessToken: 'tok',
    refreshToken: 'tok',
    user: {
      id: 'u-tester',
      username: 'tester',
      role: permissions.includes('*') ? 'admin' : 'manager',
      permissions,
    } as any,
  });
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/daily-expenses']}>
        <DailyExpenses />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// listExpenses returns an envelope { items, total_amount } —
// helper to keep test fixtures readable.
function listing(rows: Expense[] = []) {
  return {
    items: rows,
    total_amount: rows.reduce((s, r) => s + r.amount, 0),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  // Sensible defaults — every test overrides what it cares about.
  mocks.listExpensesMock.mockResolvedValue(listing([]));
  mocks.approvalInboxMock.mockResolvedValue([]);
  mocks.editRequestsInboxMock.mockResolvedValue([]);
  mocks.categoriesMock.mockResolvedValue([]);
  mocks.profitAndLossMock.mockResolvedValue({
    range: { from: '', to: '' },
    warehouse_id: null,
    revenue: 0, discounts: 0, invoice_count: 0, returns: 0,
    net_revenue: 0, cogs: 0, allocated_expenses: 0,
    gross_profit: 0, operating_expenses: 0, total_expenses: 0,
  });
  mocks.cashboxesMock.mockResolvedValue([]);
  mocks.usersMock.mockResolvedValue([]);
  mocks.shiftsListMock.mockResolvedValue([]);
  mocks.shiftsCurrentMock.mockResolvedValue(null);
  mocks.accountsListMock.mockResolvedValue([]);
});

// ─── 1. Top alert ───────────────────────────────────────────────────

describe('DailyExpenses — pending-approvals top alert', () => {
  it('renders the alert when user has accounts.approval.decide AND inbox has pending rows', async () => {
    loginWith(['expenses.daily.create', 'accounts.approval.decide']);
    mocks.approvalInboxMock.mockResolvedValue([inboxItem(), inboxItem({ id: 'app-2' })]);
    renderPage();
    const alert = await screen.findByTestId('expense-approvals-alert');
    expect(alert.textContent).toContain('اعتمادات مصروفات معلقة');
    expect(
      screen.getByTestId('expense-approvals-alert-count').textContent,
    ).toBe('2');
    const cta = screen.getByTestId(
      'expense-approvals-alert-cta',
    ) as HTMLAnchorElement;
    expect(cta.getAttribute('href')).toBe('/financial-controls');
    expect(cta.textContent).toContain('عرض الاعتمادات');
  });

  it('hides the alert when user lacks accounts.approval.decide (even if BE has rows)', async () => {
    loginWith(['expenses.daily.create']);
    mocks.approvalInboxMock.mockResolvedValue([inboxItem()]);
    renderPage();
    // Wait long enough for any async render to settle, then assert
    // absence of the alert.
    await waitFor(() => {
      expect(mocks.listExpensesMock).toHaveBeenCalled();
    });
    expect(
      screen.queryByTestId('expense-approvals-alert'),
    ).not.toBeInTheDocument();
    // The approval inbox query must not even fire when permission
    // is missing (defensive: don't probe a 403 endpoint).
    expect(mocks.approvalInboxMock).not.toHaveBeenCalled();
  });

  it('hides the alert when permission is granted but inbox is empty', async () => {
    loginWith(['expenses.daily.create', 'accounts.approval.decide']);
    mocks.approvalInboxMock.mockResolvedValue([]);
    renderPage();
    await waitFor(() => {
      expect(mocks.approvalInboxMock).toHaveBeenCalled();
    });
    expect(
      screen.queryByTestId('expense-approvals-alert'),
    ).not.toBeInTheDocument();
  });
});

// ─── 2. Row-level caption ───────────────────────────────────────────

describe('DailyExpenses — pending-row caption', () => {
  it('shows "عرض الاعتمادات →" link on a pending row when user has the permission', async () => {
    loginWith(['expenses.daily.create', 'accounts.approval.decide']);
    const row = expenseRow({
      id: 'exp-pending-with-perm',
      is_approved: false,
      je_is_void: false,
    });
    mocks.listExpensesMock.mockResolvedValue(listing([row]));
    renderPage();
    const link = (await screen.findByTestId(
      `expense-row-${row.id}-approvals-link`,
    )) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/financial-controls');
    expect(link.textContent).toMatch(/عرض الاعتمادات/);
  });

  it('shows "بانتظار موافقة مدير" caption on a pending row when user lacks the permission', async () => {
    loginWith(['expenses.daily.create']);
    const row = expenseRow({
      id: 'exp-pending-no-perm',
      is_approved: false,
      je_is_void: false,
    });
    mocks.listExpensesMock.mockResolvedValue(listing([row]));
    renderPage();
    const span = await screen.findByTestId(
      `expense-row-${row.id}-awaiting-approval`,
    );
    expect(span.textContent).toBe('بانتظار موافقة مدير');
    expect(span.tagName.toLowerCase()).toBe('span');
    // Must NOT contain a clickable link variant.
    expect(
      screen.queryByTestId(`expense-row-${row.id}-approvals-link`),
    ).not.toBeInTheDocument();
  });

  it('does NOT render the caption on an approved row (regression guard)', async () => {
    loginWith(['expenses.daily.create', 'accounts.approval.decide']);
    const row = expenseRow({
      id: 'exp-approved',
      is_approved: true,
      je_is_void: false,
    });
    mocks.listExpensesMock.mockResolvedValue(listing([row]));
    renderPage();
    await waitFor(() => {
      expect(mocks.listExpensesMock).toHaveBeenCalled();
    });
    expect(
      screen.queryByTestId(`expense-row-${row.id}-approvals-link`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`expense-row-${row.id}-awaiting-approval`),
    ).not.toBeInTheDocument();
  });

  it('does NOT render the caption on a voided-JE row (regression guard)', async () => {
    loginWith(['expenses.daily.create', 'accounts.approval.decide']);
    const row = expenseRow({
      id: 'exp-voided',
      is_approved: false,
      je_is_void: true,
    });
    mocks.listExpensesMock.mockResolvedValue(listing([row]));
    renderPage();
    await waitFor(() => {
      expect(mocks.listExpensesMock).toHaveBeenCalled();
    });
    expect(
      screen.queryByTestId(`expense-row-${row.id}-approvals-link`),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId(`expense-row-${row.id}-awaiting-approval`),
    ).not.toBeInTheDocument();
  });

  it('shows the link variant for admin (wildcard permission)', async () => {
    loginWith(['*']);
    const row = expenseRow({
      id: 'exp-admin-pending',
      is_approved: false,
      je_is_void: false,
    });
    mocks.listExpensesMock.mockResolvedValue(listing([row]));
    renderPage();
    const link = (await screen.findByTestId(
      `expense-row-${row.id}-approvals-link`,
    )) as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe('/financial-controls');
  });
});

// ─── 3. No-mutation contract ────────────────────────────────────────
//
// PR-FIX-EXPENSE-APPROVALS-DISCOVERABILITY is purely a navigation /
// labelling fix.  The page must NOT introduce any new approve/reject
// mutation surface — that workflow lives on /financial-controls and
// is already tested there.  Any future regression that adds a direct
// approve/reject button on this page fails this guard.

describe('DailyExpenses — no new approve/reject surface (source-grep)', () => {
  const SRC = readFileSync(
    'src/pages/DailyExpenses.tsx',
    'utf-8',
  );
  // Strip JS comments so the negative-grep doesn't false-positive
  // on prose mentioning "approve" or "reject" inside docstrings.
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /(^|[^:])\/\/[^\n]*/g,
    '$1',
  );

  it('does not call accountingApi.approveApproval or rejectApproval anywhere on this page', () => {
    expect(CODE).not.toMatch(/accountingApi\.approveApproval\(/);
    expect(CODE).not.toMatch(/accountingApi\.rejectApproval\(/);
  });

  it('does not contain any JE / CT / SM mutation strings introduced by this PR', () => {
    expect(CODE).not.toMatch(/\bjournal_entries\b/);
    expect(CODE).not.toMatch(/\bcashbox_transactions\b/);
    expect(CODE).not.toMatch(/\bstock_movements\b/);
    expect(CODE).not.toMatch(/\baccounting_only\b/);
  });
});
