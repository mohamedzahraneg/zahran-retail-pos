/**
 * FinancialControls.duplicate-rules.test.tsx
 * PR-FIX-EXPENSE-APPROVAL-RULES-DEDUPE
 *
 * Pins the new "قاعدة مكررة" chip in `<RulesTab>` of the
 * FinancialControls page.  After migration 129 deactivates current
 * duplicates and the partial unique index blocks future ones, the
 * chip stays as a defence-in-depth signal: any future legacy import
 * or admin script that re-introduces a duplicate active rule before
 * the BE validation rejects it will surface visibly.
 *
 *   1. Two active rules sharing the natural key →
 *      both rows render the rose `قاعدة مكررة` chip.
 *   2. Two active rules with DIFFERENT keys →
 *      neither row renders the chip.
 *   3. Active + inactive rule sharing the natural key →
 *      neither row renders the chip (inactive rules don't count).
 *   4. Three rules: two active duplicates + one unique →
 *      duplicates render the chip; the unique row does not.
 *   5. `max_amount = null` (open-ended bracket) → two rules with the
 *      same role/level/min and both null max are flagged as duplicates.
 *   6. Source-grep — `<RulesTab>` introduces no new mutation surfaces
 *      (no approveExpense / rejectExpense / approveApproval / JE / CT
 *      / SM strings).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';

import { useAuthStore } from '@/stores/auth.store';
import type { ApprovalRule } from '@/api/accounting.api';

// ─── Mocks ──────────────────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  approvalInboxMock:    vi.fn(),
  rulesMock:            vi.fn(),
  fxRatesMock:          vi.fn(),
  approveApprovalMock:  vi.fn(),
  rejectApprovalMock:   vi.fn(),
}));

vi.mock('@/api/accounting.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    accountingApi: {
      ...((actual as any).accountingApi ?? {}),
      approvalInbox:        () => mocks.approvalInboxMock(),
      approveApproval:      mocks.approveApprovalMock,
      rejectApproval:       mocks.rejectApprovalMock,
      listApprovalRules:    () => mocks.rulesMock(),
      createApprovalRule:   vi.fn(async () => ({})),
      updateApprovalRule:   vi.fn(async () => ({})),
      removeApprovalRule:   vi.fn(async () => ({})),
      ruleUsageCount:       vi.fn(async () => ({ used: 0 })),
    },
  };
});

vi.mock('@/api/accounts.api', () => ({
  accountsApi: {
    listCurrencyRates:  () => mocks.fxRatesMock(),
    upsertCurrencyRate: vi.fn(async () => ({})),
    revalueByMonth:     vi.fn(async () => ({})),
  },
}));

vi.mock('@/lib/accounting-ops-idempotency', () => ({
  resetAccountingOpsApprovalApproveIdempotencyKey: vi.fn(),
}));

vi.mock('react-hot-toast', () => {
  const fn = vi.fn();
  return { default: Object.assign(fn, { error: vi.fn(), success: vi.fn() }) };
});

import FinancialControls from '../FinancialControls';

// ─── Fixtures ───────────────────────────────────────────────────────

function rule(over: Partial<ApprovalRule> = {}): ApprovalRule {
  return {
    id: 'rule-base',
    name_ar: 'مصروف متوسط',
    min_amount: '10000',
    max_amount: '50000',
    required_role: 'manager',
    level: 1,
    is_active: true,
    notes: null,
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
  mocks.approvalInboxMock.mockResolvedValue([]);
  mocks.rulesMock.mockResolvedValue([]);
  mocks.fxRatesMock.mockResolvedValue([]);
});

// Helper — switch from the default inbox tab to the rules tab.
async function gotoRulesTab() {
  // The rules tab is one of three tabs at the top of FinancialControls;
  // its label is "قواعد الاعتماد".
  const tab = await screen.findByText('قواعد الاعتماد');
  tab.click();
}

// ─── 1. Active duplicates flagged ───────────────────────────────────

describe('RulesTab — قاعدة مكررة chip on active duplicates', () => {
  it('renders the chip on BOTH rows when two active rules share the natural key', async () => {
    mocks.rulesMock.mockResolvedValue([
      rule({
        id: 'r-a',
        name_ar: 'مصروف متوسط (نسخة أولى)',
        required_role: 'manager',
        level: 1,
        min_amount: '10000',
        max_amount: '50000',
        is_active: true,
      }),
      rule({
        id: 'r-b',
        name_ar: 'مصروف متوسط (نسخة ثانية)',
        required_role: 'manager',
        level: 1,
        min_amount: '10000',
        max_amount: '50000',
        is_active: true,
      }),
    ]);
    renderPage();
    await gotoRulesTab();
    await waitFor(() => expect(mocks.rulesMock).toHaveBeenCalled());
    const chipA = await screen.findByTestId('approval-rule-r-a-duplicate-badge');
    const chipB = await screen.findByTestId('approval-rule-r-b-duplicate-badge');
    expect(chipA.textContent).toBe('قاعدة مكررة');
    expect(chipB.textContent).toBe('قاعدة مكررة');
  });

  it('flags duplicates with open-ended max_amount (null brackets)', async () => {
    mocks.rulesMock.mockResolvedValue([
      rule({
        id: 'r-admin-1',
        name_ar: 'مصروف كبير (نسخة أولى)',
        required_role: 'admin',
        level: 1,
        min_amount: '50000',
        max_amount: null,
        is_active: true,
      }),
      rule({
        id: 'r-admin-2',
        name_ar: 'مصروف كبير (نسخة ثانية)',
        required_role: 'admin',
        level: 1,
        min_amount: '50000',
        max_amount: null,
        is_active: true,
      }),
    ]);
    renderPage();
    await gotoRulesTab();
    await waitFor(() => expect(mocks.rulesMock).toHaveBeenCalled());
    expect(
      await screen.findByTestId('approval-rule-r-admin-1-duplicate-badge'),
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId('approval-rule-r-admin-2-duplicate-badge'),
    ).toBeInTheDocument();
  });
});

// ─── 2. Distinct keys → no chip ─────────────────────────────────────

describe('RulesTab — distinct rules do NOT trigger the chip', () => {
  it('two active rules with different brackets render no duplicate chip', async () => {
    mocks.rulesMock.mockResolvedValue([
      rule({
        id: 'r-mid',
        required_role: 'manager',
        level: 1,
        min_amount: '10000',
        max_amount: '50000',
        is_active: true,
      }),
      rule({
        id: 'r-big',
        name_ar: 'مصروف كبير',
        required_role: 'admin',
        level: 1,
        min_amount: '50000',
        max_amount: null,
        is_active: true,
      }),
    ]);
    renderPage();
    await gotoRulesTab();
    await waitFor(() => expect(mocks.rulesMock).toHaveBeenCalled());
    // Both rows should render…
    await screen.findByTestId('approval-rule-row-r-mid');
    await screen.findByTestId('approval-rule-row-r-big');
    // …with NO duplicate chip on either.
    expect(
      screen.queryByTestId('approval-rule-r-mid-duplicate-badge'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('approval-rule-r-big-duplicate-badge'),
    ).not.toBeInTheDocument();
  });
});

// ─── 3. Active + inactive same key → no chip ─────────────────────────

describe('RulesTab — inactive duplicates do NOT trigger the chip', () => {
  it('an active + inactive rule sharing the natural key flags neither', async () => {
    mocks.rulesMock.mockResolvedValue([
      rule({
        id: 'r-active',
        required_role: 'manager',
        level: 1,
        min_amount: '10000',
        max_amount: '50000',
        is_active: true,
      }),
      rule({
        id: 'r-inactive',
        required_role: 'manager',
        level: 1,
        min_amount: '10000',
        max_amount: '50000',
        is_active: false,
      }),
    ]);
    renderPage();
    await gotoRulesTab();
    await waitFor(() => expect(mocks.rulesMock).toHaveBeenCalled());
    await screen.findByTestId('approval-rule-row-r-active');
    await screen.findByTestId('approval-rule-row-r-inactive');
    expect(
      screen.queryByTestId('approval-rule-r-active-duplicate-badge'),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByTestId('approval-rule-r-inactive-duplicate-badge'),
    ).not.toBeInTheDocument();
  });
});

// ─── 4. Mixed (2 dups + 1 unique) ───────────────────────────────────

describe('RulesTab — mixed catalog only flags the duplicates', () => {
  it('two duplicates + one unique → chip on the dups, not on the unique', async () => {
    mocks.rulesMock.mockResolvedValue([
      rule({
        id: 'r-dup-1',
        name_ar: 'مصروف متوسط (نسخة أولى)',
        required_role: 'manager',
        level: 1,
        min_amount: '10000',
        max_amount: '50000',
        is_active: true,
      }),
      rule({
        id: 'r-dup-2',
        name_ar: 'مصروف متوسط (نسخة ثانية)',
        required_role: 'manager',
        level: 1,
        min_amount: '10000',
        max_amount: '50000',
        is_active: true,
      }),
      rule({
        id: 'r-unique',
        name_ar: 'مصروف صغير',
        required_role: 'manager',
        level: 1,
        min_amount: '0',
        max_amount: '10000',
        is_active: true,
      }),
    ]);
    renderPage();
    await gotoRulesTab();
    await waitFor(() => expect(mocks.rulesMock).toHaveBeenCalled());
    expect(
      await screen.findByTestId('approval-rule-r-dup-1-duplicate-badge'),
    ).toBeInTheDocument();
    expect(
      await screen.findByTestId('approval-rule-r-dup-2-duplicate-badge'),
    ).toBeInTheDocument();
    expect(
      screen.queryByTestId('approval-rule-r-unique-duplicate-badge'),
    ).not.toBeInTheDocument();
  });
});

// ─── 5. Source-grep — no new mutation surface ───────────────────────

describe('FinancialControls — RulesTab introduces no financial mutation surface', () => {
  const SRC = readFileSync(
    'src/pages/FinancialControls.tsx',
    'utf-8',
  );
  // Strip JS comments so the negative-grep doesn't false-positive on
  // prose mentioning the forbidden keywords inside docstrings.
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /(^|[^:])\/\/[^\n]*/g,
    '$1',
  );

  it('does not introduce JE / CT / SM / accounting_only strings', () => {
    expect(CODE).not.toMatch(/\bjournal_entries\b/);
    expect(CODE).not.toMatch(/\bcashbox_transactions\b/);
    expect(CODE).not.toMatch(/\bstock_movements\b/);
    expect(CODE).not.toMatch(/\baccounting_only\b/);
  });

  it('the existing approveApproval / rejectApproval / list+create+update+remove rule API surface is preserved', () => {
    expect(CODE).toMatch(/accountingApi\.approveApproval\(/);
    expect(CODE).toMatch(/accountingApi\.rejectApproval\(/);
    expect(CODE).toMatch(/accountingApi\.listApprovalRules\(/);
    expect(CODE).toMatch(/accountingApi\.removeApprovalRule\(/);
    // No accidental scope creep into expense-level mutations.
    expect(CODE).not.toMatch(/accountingApi\.approveExpense\(/);
    expect(CODE).not.toMatch(/accountingApi\.rejectExpense\(/);
    expect(CODE).not.toMatch(/accountingApi\.deleteExpense\(/);
  });
});
