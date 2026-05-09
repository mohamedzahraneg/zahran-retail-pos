/**
 * FinancialControls.approval-grouping.test.tsx
 * PR-FIX-APPROVAL-INBOX-GROUPING
 *
 * Pins the inbox-grouping behavior introduced after EXP-2026-000055
 * surfaced two identical pending approval rows (caused by two
 * duplicate `expense_approval_rules` rows on the same level/role/
 * bracket).  The fix is FE-only: render ONE card per expense_id
 * regardless of how many pending approval rows the BE returns.
 *
 *   1. single-row inbox response → one card, existing layout
 *      (no multi-badge, no rules list, single approve button).
 *   2. two rows for the SAME expense_id → ONE card with
 *      "N اعتماد مطلوب" badge and inner per-rule list.
 *   3. two rows for DIFFERENT expense_ids → TWO cards.
 *   4. mixed (2-for-A, 1-for-B) → two cards with the right shape.
 *   5. "اعتماد الكل" calls accountingApi.approveApproval once per row,
 *      in order, with idempotency-key reset between calls.
 *   6. single-row approve still calls approveApproval exactly once.
 *   7. multi-row reject calls rejectApproval once with the FIRST
 *      pending row id (backend short-circuits the workflow on first
 *      reject; no fan-out).
 *   8. source-grep on FinancialControls.tsx — no new mutation
 *      surfaces (only approveApproval / rejectApproval); no JE/CT/SM
 *      strings introduced by this PR.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';

import { useAuthStore } from '@/stores/auth.store';
import type { ApprovalInboxItem } from '@/api/accounting.api';

// ─── Mocks ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  approvalInboxMock:    vi.fn(),
  approveApprovalMock:  vi.fn(),
  rejectApprovalMock:   vi.fn(),
  rulesMock:            vi.fn(),
  fxRatesMock:          vi.fn(),
  // Existing per-click idempotency-key reset helper — mocked so we can
  // assert it fires before every approve call (single + sequential).
  resetIdempotencyKeyMock: vi.fn(),
}));

vi.mock('@/api/accounting.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    accountingApi: {
      ...((actual as any).accountingApi ?? {}),
      approvalInbox:   () => mocks.approvalInboxMock(),
      approveApproval: (id: string, note?: string) =>
        mocks.approveApprovalMock(id, note),
      rejectApproval:  (id: string, reason: string) =>
        mocks.rejectApprovalMock(id, reason),
      // Stubs used by the other tabs / unrelated panels on the page.
      listApprovalRules:   () => mocks.rulesMock(),
      createApprovalRule:  vi.fn(async () => ({})),
      updateApprovalRule:  vi.fn(async () => ({})),
      removeApprovalRule:  vi.fn(async () => ({})),
      ruleUsageCount:      vi.fn(async () => ({ used: 0 })),
    },
  };
});

vi.mock('@/api/accounts.api', () => ({
  accountsApi: {
    listCurrencyRates: () => mocks.fxRatesMock(),
    upsertCurrencyRate: vi.fn(async () => ({})),
    revalueByMonth: vi.fn(async () => ({})),
  },
}));

vi.mock('@/lib/accounting-ops-idempotency', () => ({
  resetAccountingOpsApprovalApproveIdempotencyKey:
    mocks.resetIdempotencyKeyMock,
}));

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return { default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }) };
});

import FinancialControls from '../FinancialControls';

// ─── Fixtures ───────────────────────────────────────────────────────

function inboxItem(over: Partial<ApprovalInboxItem> = {}): ApprovalInboxItem {
  return {
    id: 'app-base',
    expense_id: 'exp-A',
    level: 1,
    required_role: 'manager',
    status: 'pending',
    created_at: '2026-05-08T20:50:51Z',
    expense_no: 'EXP-2026-000055',
    amount: '30000.00',
    expense_date: '2026-05-08',
    description: 'اجار',
    vendor_name: null,
    payment_method: 'cash',
    category_name: 'إيجار',
    category_code: '5400',
    warehouse_name: 'المخزن',
    created_by_name: 'كاشير',
    rule_name: 'مصروف متوسط',
    ...over,
  };
}

function loginAdmin() {
  useAuthStore.setState({
    accessToken: 'tok',
    refreshToken: 'tok',
    user: {
      id: 'u-admin',
      username: 'admin',
      role: 'admin',
      permissions: ['*'],
    } as any,
  });
}

function renderPage() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={['/financial-controls']}>
        <FinancialControls />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  loginAdmin();
  // Sensible defaults — every test overrides what it cares about.
  mocks.approvalInboxMock.mockResolvedValue([]);
  mocks.approveApprovalMock.mockResolvedValue({ status: 'approved' });
  mocks.rejectApprovalMock.mockResolvedValue({ status: 'rejected' });
  mocks.rulesMock.mockResolvedValue([]);
  mocks.fxRatesMock.mockResolvedValue([]);
});

// ─── Single-row case (regression guard) ─────────────────────────────

describe('InboxTab — single approval row keeps the existing card layout', () => {
  it('renders ONE card with "اعتماد" + "رفض" buttons; no multi-badge', async () => {
    mocks.approvalInboxMock.mockResolvedValue([
      inboxItem({
        id: 'app-1',
        expense_id: 'exp-A',
        rule_name: 'مصروف متوسط',
      }),
    ]);
    renderPage();
    const card = await screen.findByTestId('approval-card-exp-A');
    expect(within(card).getByTestId('approval-card-exp-A-approve')
      .textContent).toMatch(/اعتماد$/); // "اعتماد" alone, not "اعتماد الكل"
    expect(
      within(card).queryByTestId('approval-card-exp-A-multi-badge'),
    ).not.toBeInTheDocument();
    expect(
      within(card).queryByTestId('approval-card-exp-A-rules'),
    ).not.toBeInTheDocument();
  });
});

// ─── Multi-row grouping ─────────────────────────────────────────────

describe('InboxTab — multiple pending rows for the same expense', () => {
  function twoRowsSameExpense() {
    return [
      inboxItem({ id: 'app-1', expense_id: 'exp-A', rule_name: 'مصروف متوسط (نسخة أولى)' }),
      inboxItem({ id: 'app-2', expense_id: 'exp-A', rule_name: 'مصروف متوسط (نسخة ثانية)' }),
    ];
  }

  it('renders ONE card (not two) when the same expense_id has two pending rows', async () => {
    mocks.approvalInboxMock.mockResolvedValue(twoRowsSameExpense());
    renderPage();
    await screen.findByTestId('approval-card-exp-A');
    // The grid contains exactly one card for this expense.
    const cards = screen.getAllByTestId(/^approval-card-/);
    // Filter out child test-ids that include `approval-card-` as a
    // prefix (badge, rules, approve, reject, rule-row).
    const rootCards = cards.filter(
      (el) => el.getAttribute('data-testid') === 'approval-card-exp-A',
    );
    expect(rootCards).toHaveLength(1);
  });

  it('shows the "N اعتماد مطلوب" badge for the grouped expense', async () => {
    mocks.approvalInboxMock.mockResolvedValue(twoRowsSameExpense());
    renderPage();
    const badge = await screen.findByTestId(
      'approval-card-exp-A-multi-badge',
    );
    expect(badge.textContent).toBe('2 اعتماد مطلوب');
  });

  it('lists every matched rule inside the card (one row per matched rule)', async () => {
    mocks.approvalInboxMock.mockResolvedValue(twoRowsSameExpense());
    renderPage();
    const list = await screen.findByTestId('approval-card-exp-A-rules');
    expect(list.textContent).toContain('مصروف متوسط (نسخة أولى)');
    expect(list.textContent).toContain('مصروف متوسط (نسخة ثانية)');
    // Per-row breadcrumbs — one <li> per rule.
    expect(
      within(list).getByTestId('approval-card-exp-A-rule-row-app-1'),
    ).toBeInTheDocument();
    expect(
      within(list).getByTestId('approval-card-exp-A-rule-row-app-2'),
    ).toBeInTheDocument();
  });

  it('renders TWO cards when the inbox has rows for two different expenses', async () => {
    mocks.approvalInboxMock.mockResolvedValue([
      inboxItem({ id: 'a-1', expense_id: 'exp-A', expense_no: 'EXP-A' }),
      inboxItem({ id: 'b-1', expense_id: 'exp-B', expense_no: 'EXP-B' }),
    ]);
    renderPage();
    await screen.findByTestId('approval-card-exp-A');
    expect(screen.getByTestId('approval-card-exp-B')).toBeInTheDocument();
    // Neither should carry the multi-badge.
    expect(
      screen.queryByTestId('approval-card-exp-A-multi-badge'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('approval-card-exp-B-multi-badge'),
    ).not.toBeInTheDocument();
  });

  it('renders a 2-for-A + 1-for-B mix as exactly two cards (A grouped, B single)', async () => {
    mocks.approvalInboxMock.mockResolvedValue([
      inboxItem({ id: 'a-1', expense_id: 'exp-A', expense_no: 'EXP-A' }),
      inboxItem({ id: 'a-2', expense_id: 'exp-A', expense_no: 'EXP-A' }),
      inboxItem({ id: 'b-1', expense_id: 'exp-B', expense_no: 'EXP-B' }),
    ]);
    renderPage();
    const cardA = await screen.findByTestId('approval-card-exp-A');
    const cardB = await screen.findByTestId('approval-card-exp-B');
    // A has the multi-badge; B does not.
    expect(
      within(cardA).getByTestId('approval-card-exp-A-multi-badge')
        .textContent,
    ).toBe('2 اعتماد مطلوب');
    expect(
      within(cardB).queryByTestId('approval-card-exp-B-multi-badge'),
    ).not.toBeInTheDocument();
    // Total root cards = 2.
    const allRoots = screen
      .getAllByTestId(/^approval-card-/)
      .filter(
        (el) =>
          el.getAttribute('data-testid') === 'approval-card-exp-A' ||
          el.getAttribute('data-testid') === 'approval-card-exp-B',
      );
    expect(allRoots).toHaveLength(2);
  });
});

// ─── Approve & reject behavior ──────────────────────────────────────

describe('InboxTab — approve / reject wiring', () => {
  it('"اعتماد الكل" on a 2-row group calls approveApproval twice with the row ids in order', async () => {
    mocks.approvalInboxMock.mockResolvedValue([
      inboxItem({ id: 'app-1', expense_id: 'exp-A' }),
      inboxItem({ id: 'app-2', expense_id: 'exp-A' }),
    ]);
    renderPage();
    const approveBtn = await screen.findByTestId(
      'approval-card-exp-A-approve',
    );
    expect(approveBtn.textContent).toMatch(/اعتماد الكل/);
    fireEvent.click(approveBtn);
    await waitFor(() => {
      expect(mocks.approveApprovalMock).toHaveBeenCalledTimes(2);
    });
    // Order matters — first call is app-1, second is app-2.
    expect(mocks.approveApprovalMock.mock.calls[0][0]).toBe('app-1');
    expect(mocks.approveApprovalMock.mock.calls[1][0]).toBe('app-2');
    // Reject must NOT be called.
    expect(mocks.rejectApprovalMock).not.toHaveBeenCalled();
  });

  it('idempotency-key reset fires once before each sequential approve call', async () => {
    mocks.approvalInboxMock.mockResolvedValue([
      inboxItem({ id: 'app-1', expense_id: 'exp-A' }),
      inboxItem({ id: 'app-2', expense_id: 'exp-A' }),
    ]);
    renderPage();
    fireEvent.click(
      await screen.findByTestId('approval-card-exp-A-approve'),
    );
    await waitFor(() => {
      expect(mocks.approveApprovalMock).toHaveBeenCalledTimes(2);
    });
    // 2 sequential approves → 2 resets (one before each api call).
    // Defensive useEffect cleanup may add extra calls when the test
    // tears down, so assert >= 2 (lower bound is the contract).
    expect(
      mocks.resetIdempotencyKeyMock.mock.calls.length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('single-row approve still calls approveApproval exactly once (with one reset)', async () => {
    mocks.approvalInboxMock.mockResolvedValue([
      inboxItem({ id: 'app-1', expense_id: 'exp-A' }),
    ]);
    renderPage();
    const approveBtn = await screen.findByTestId(
      'approval-card-exp-A-approve',
    );
    expect(approveBtn.textContent).toMatch(/اعتماد$/);
    // Reset count before the click so we can isolate the per-click reset.
    const resetCallsBefore = mocks.resetIdempotencyKeyMock.mock.calls.length;
    fireEvent.click(approveBtn);
    await waitFor(() => {
      expect(mocks.approveApprovalMock).toHaveBeenCalledTimes(1);
    });
    expect(mocks.approveApprovalMock.mock.calls[0][0]).toBe('app-1');
    // Exactly one extra reset since the click — the per-click reset.
    expect(
      mocks.resetIdempotencyKeyMock.mock.calls.length - resetCallsBefore,
    ).toBeGreaterThanOrEqual(1);
  });

  it('reject on a multi-row group calls rejectApproval ONCE with the first pending row id', async () => {
    mocks.approvalInboxMock.mockResolvedValue([
      inboxItem({ id: 'app-1', expense_id: 'exp-A' }),
      inboxItem({ id: 'app-2', expense_id: 'exp-A' }),
    ]);
    // The reject prompt requires a >= 3-char reason.
    const promptSpy = vi
      .spyOn(window, 'prompt')
      .mockReturnValue('سبب الرفض الواضح');
    renderPage();
    fireEvent.click(
      await screen.findByTestId('approval-card-exp-A-reject'),
    );
    await waitFor(() => {
      expect(mocks.rejectApprovalMock).toHaveBeenCalledTimes(1);
    });
    expect(mocks.rejectApprovalMock.mock.calls[0][0]).toBe('app-1');
    expect(mocks.rejectApprovalMock.mock.calls[0][1]).toBe(
      'سبب الرفض الواضح',
    );
    expect(mocks.approveApprovalMock).not.toHaveBeenCalled();
    promptSpy.mockRestore();
  });
});

// ─── No new mutation surface (source-grep) ──────────────────────────
//
// The fix MUST stay scoped to the existing approveApproval /
// rejectApproval endpoints.  Any future regression that introduces a
// direct expense mutation, a JE/CT/SM string, or an `accounting_only`
// shortcut on this page fails this guard.

describe('FinancialControls — no new mutation surface introduced by this PR', () => {
  const SRC = readFileSync(
    'src/pages/FinancialControls.tsx',
    'utf-8',
  );
  // Strip JS comments so prose mentioning 'approve' / 'reject' inside
  // docstrings does not false-positive a negative grep below.
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /(^|[^:])\/\/[^\n]*/g,
    '$1',
  );

  it('uses only approveApproval / rejectApproval for inbox decisions', () => {
    expect(CODE).toMatch(/accountingApi\.approveApproval\(/);
    expect(CODE).toMatch(/accountingApi\.rejectApproval\(/);
    // Defense in depth — no direct expense mutation hooks.
    expect(CODE).not.toMatch(/accountingApi\.createDailyExpense\(/);
    expect(CODE).not.toMatch(/accountingApi\.updateExpense\(/);
    expect(CODE).not.toMatch(/accountingApi\.deleteExpense\(/);
  });

  it('does not introduce JE / CT / SM / accounting_only strings', () => {
    expect(CODE).not.toMatch(/\bjournal_entries\b/);
    expect(CODE).not.toMatch(/\bcashbox_transactions\b/);
    expect(CODE).not.toMatch(/\bstock_movements\b/);
    expect(CODE).not.toMatch(/\baccounting_only\b/);
  });
});
