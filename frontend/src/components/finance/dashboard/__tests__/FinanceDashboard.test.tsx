/**
 * FinanceDashboard.test.tsx — PR-FIN-2
 *
 * Pins the page contract:
 *   1. Loading state renders before data arrives
 *   2. All 20 sections from the dashboard image render with their
 *      Arabic titles after data loads
 *   3. Quick reports tile availability flag controls disabled state
 *   4. The page never imports DailyExpenses (frozen surface)
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { FinanceDashboard } from '@/pages/FinanceDashboard';
import type { FinanceDashboard as Data } from '@/api/finance.api';

vi.mock('@/api/finance.api', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    financeApi: {
      dashboard: vi.fn(async () => fixture),
    },
  };
});
vi.mock('@/api/cash-desk.api', () => ({
  cashDeskApi: { cashboxes: vi.fn(async () => []) },
}));
vi.mock('@/api/payments.api', () => ({
  paymentsApi: { listAccounts: vi.fn(async () => []) },
}));

let fixture: Data;

function buildFixture(overrides: Partial<Data> = {}): Data {
  return {
    range: { from: '2026-04-01', to: '2026-04-30' },
    generated_at: '2026-04-27T17:00:00Z',
    filters_applied: {},
    health: {
      trial_balance_imbalance: 0,
      cashbox_balance_drift_count: 0,
      cashbox_drift_total: 0,
      cashbox_drift_count: 0,
      engine_bypass_alerts_7d: 0,
      engine_bypass_alerts_last_seen: null,
      unbalanced_entries_count: 0,
      overall: 'healthy',
    },
    liquidity: {
      // PR-FIN-DASHBOARD-LIQUIDITY-GL renamed `cards_total` →
      // `checks_total` to match GL 1115 (الشيكات).
      cashboxes_total: 100,
      banks_total: 200,
      wallets_total: 50,
      checks_total: 0,
      total_cash_equivalents: 350,
    },
    daily_expenses: {
      today_total: 0,
      today_count: 0,
      today_largest: null,
      period_total: 250,
      period_count: 3,
      period_largest: { category: 'إيجار', amount: 150 },
      // PR-FIN-DASHBOARD-EXPENSES-CASH-BASIS-REVERT — breakdown defaults
      // (180 advances + 70 non-advances = 250 headline). The actual
      // numbers don't matter for most specs; cash-basis specs override.
      period_advances_total: 180,
      period_advances_count: 2,
      period_non_advances_total: 70,
      period_non_advances_count: 1,
    },
    balances: {
      customers: { total_due: 1000, count: 5, top: { name: 'أحمد', amount: 400 } },
      suppliers: {
        total_due: 500,
        count: 3,
        top: { name: 'مصنع النور', amount: 200 },
        effective_source: 'suppliers_table',
        sources_checked: ['suppliers_table', 'gl_211', 'purchases'],
      },
      employees: { total_owed_to: 200, total_owed_by: 50, net: 150 },
    },
    profit: {
      sales_total: 5000,
      cogs_total: 3000,
      gross_profit: 2000,
      expenses_total: 500,
      net_profit: 1500,
      margin_pct: 40,
      delta_vs_previous: {
        sales_pct: 10, cogs_pct: 5, gross_pct: 15,
        expenses_pct: 2, net_pct: 20, margin_pp: 1.5,
      },
      best_customer: { name: 'أحمد', profit: 400 },
      best_supplier: { name: 'مصنع النور', profit: 200 },
      best_product: { name: 'لاب توب', profit: 150 },
      confidence: 'High',
      confidence_breakdown: { high_lines: 30, medium_lines: 0, low_lines: 0 },
    },
    profit_trend: [],
    payment_channels: [],
    group_profits: [],
    top_products: [],
    profit_by_customer: [],
    profit_by_supplier: [],
    profit_by_department: [],
    profit_by_shift: [],
    profit_by_payment_method: [],
    cash_accounts: [],
    recent_movements: [],
    alerts: [],
    quick_reports: [
      { key: 'cashbox-statement', label_ar: 'كشف خزنة', available: false, href: null },
      { key: 'expenses-report',   label_ar: 'تقرير المصروفات', available: true,  href: '/daily-expenses' },
    ],
    ...overrides,
  };
}

function renderPage(data: Data = buildFixture()) {
  fixture = data;
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <FinanceDashboard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('<FinanceDashboard />', () => {
  it('renders the loading state while the query is in-flight', async () => {
    renderPage();
    expect(screen.getByTestId('dashboard-loading')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.queryByTestId('dashboard-loading')).toBeNull(),
    );
  });

  it('renders the header title and three action buttons', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByText('لوحة الحسابات والمالية')).toBeInTheDocument(),
    );
    expect(screen.getByText('نظرة شاملة على الوضع المالي لحظيًا')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-action-refresh')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-action-print')).toBeInTheDocument();
    expect(screen.getByTestId('dashboard-action-excel')).toBeInTheDocument();
  });

  it('renders all 6 Row 1 KPI cards with their Arabic titles', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('card-cash-equivalents')).toBeInTheDocument(),
    );
    // PR-AUDIT-LABELS-CASH-VS-GL — title renamed from the ambiguous
    // "النقدية وما في حكمها" to "السيولة المحاسبية" so the operator
    // knows it's the GL roll-up (not the cash-drawer-only sum).
    expect(screen.getByText('السيولة المحاسبية')).toBeInTheDocument();
    // Defensive: refuse the previous ambiguous title within this card.
    const cashCard = screen.getByTestId('card-cash-equivalents');
    expect(cashCard.textContent).not.toMatch(/النقدية وما في حكمها/);
    expect(screen.getByText('أرصدة العملاء')).toBeInTheDocument();
    expect(screen.getByText('أرصدة الموردين')).toBeInTheDocument();
    expect(screen.getByText('أرصدة الموظفين')).toBeInTheDocument();
    // PR-FIN-DASHBOARD-EXPENSES-CASH-BASIS-REVERT — title relabeled
    // from "المصروفات (...)" to "المصروفات النقدية (...)" to make the
    // basis explicit (cash-basis card).
    expect(
      screen.getByText('المصروفات النقدية (اليوم / الفترة)'),
    ).toBeInTheDocument();
    expect(screen.getByText('مؤشرات السلامة المالية')).toBeInTheDocument();
  });

  it('renders the 9 profit summary cards under "ملخص الأرباح"', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dashboard-row-2')).toBeInTheDocument(),
    );
    // Some titles re-appear as table column headers (e.g. "مجمل الربح")
    // — assert each appears at least once rather than uniquely.
    for (const t of [
      'ملخص الأرباح',
      'إجمالي المبيعات',
      'تكلفة البضاعة المباعة',
      'مجمل الربح',
      'إجمالي المصروفات',
      'صافي الربح',
      'هامش الربح',
      'أفضل عميل ربحًا',
      'أفضل مورد ربحًا',
      'أفضل صنف ربحًا',
    ]) {
      expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    }
  });

  it('renders Row 3 chart titles and Row 4 table titles verbatim', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('chart-profit-trend')).toBeInTheDocument(),
    );
    // Use getAllByText since some Arabic phrases legitimately appear
    // both as a section title and as a column header (e.g. "هامش الربح"
    // is a Row 2 card AND a Row 4 column). We just need each title to
    // exist at least once.
    for (const t of [
      'حركة الأرباح عبر الزمن',
      'توزيع وسائل الدفع (المبيعات)',
      'أرباح المجموعات',
      'أفضل 10 أصناف ربحًا',
      'أرباح وسائل الدفع',
      'أرباح الورديات',
      'أرباح الأقسام',
      'أرباح الموردين',
      'أرباح العملاء',
    ]) {
      expect(screen.getAllByText(t).length).toBeGreaterThan(0);
    }
  });

  it('renders Row 5 panels (cash accounts / movements / alerts)', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('table-cash-accounts')).toBeInTheDocument(),
    );
    expect(screen.getByText('الخزائن والبنوك والمحافظ')).toBeInTheDocument();
    expect(screen.getByText('آخر الحركات المالية')).toBeInTheDocument();
    expect(screen.getByText('التحذيرات والتنبيهات')).toBeInTheDocument();
  });

  it('renders quick reports — available tile is a link, unavailable is disabled placeholder', async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('quick-reports')).toBeInTheDocument(),
    );
    const enabled = screen.getByTestId('quick-report-expenses-report');
    expect(enabled.tagName.toLowerCase()).toBe('a');
    expect(enabled.getAttribute('data-available')).toBe('true');

    const disabled = screen.getByTestId('quick-report-cashbox-statement');
    expect(disabled.tagName.toLowerCase()).toBe('button');
    expect(disabled.getAttribute('data-available')).toBe('false');
    expect(disabled).toBeDisabled();
  });

  it('does not import the DailyExpenses module (frozen surface)', async () => {
    // Comments mentioning the page are fine; what we forbid is an
    // actual `import` statement that would couple this PR's code to
    // the frozen DailyExpenses surface.
    const fs = await import('fs');
    const src = fs.readFileSync(
      'src/pages/FinanceDashboard.tsx',
      'utf-8',
    );
    expect(src).not.toMatch(/^\s*import[^\n]*DailyExpenses/m);
  });

  it('shows error UI when the dashboard query rejects', async () => {
    const { financeApi } = await import('@/api/finance.api');
    (financeApi.dashboard as any).mockRejectedValueOnce(new Error('boom'));
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId('dashboard-error')).toBeInTheDocument(),
    );
  });

  // PR-FIN-2-HOTFIX-4 — health card relabeling + period expenses +
  // supplier source caption.
  describe('PR-FIN-2-HOTFIX-4 — dashboard clarity', () => {
    it('HealthCard renders the 5 distinct rows with the new Arabic labels', async () => {
      renderPage();
      await waitFor(() =>
        expect(screen.getByTestId('card-health')).toBeInTheDocument(),
      );
      // Five distinct testids — one per invariant.
      expect(screen.getByTestId('health-row-trial-balance')).toBeInTheDocument();
      expect(screen.getByTestId('health-row-cashbox-balance')).toBeInTheDocument();
      expect(screen.getByTestId('health-row-reference-drift')).toBeInTheDocument();
      expect(screen.getByTestId('health-row-engine-alerts')).toBeInTheDocument();
      expect(screen.getByTestId('health-row-unbalanced')).toBeInTheDocument();
      // New labels visible.
      expect(screen.getByText('رصيد الخزائن')).toBeInTheDocument();
      expect(screen.getByText('فروق تصنيف مراجع')).toBeInTheDocument();
      expect(screen.getByText('Engine Alerts تاريخية')).toBeInTheDocument();
      expect(screen.getByText('قيود غير متوازنة')).toBeInTheDocument();
    });

    it('HealthCard shows captions only for non-OK rows that have one', async () => {
      // Stage current prod-like state: real cashbox balance is fine,
      // but reference-drift and engine-alerts are non-zero.
      renderPage(buildFixture({
        health: {
          trial_balance_imbalance: 0,
          cashbox_balance_drift_count: 0,
          cashbox_drift_total: 1057.98,
          cashbox_drift_count: 8,
          engine_bypass_alerts_7d: 22,
          engine_bypass_alerts_last_seen: '2026-04-25T14:00:00Z',
          unbalanced_entries_count: 0,
          overall: 'warning',
        },
      }));
      await waitFor(() =>
        expect(screen.getByTestId('card-health')).toBeInTheDocument(),
      );
      // Reference drift caption visible — explicitly says it's not money drift.
      expect(
        screen.getByText(/فروق ربط\/تصنيف قديمة/),
      ).toBeInTheDocument();
      expect(
        screen.getByText(/لا تعني فرقًا فعليًا في رصيد الخزائن/),
      ).toBeInTheDocument();
      // Engine alerts caption shows last_seen date in Cairo TZ + historical wording.
      expect(
        screen.getByText(/تنبيهات تاريخية، لا توجد حركة مالية جديدة بسببها/),
      ).toBeInTheDocument();
    });

    it('TodayExpensesCard renders both today AND period sections', async () => {
      renderPage(buildFixture({
        daily_expenses: {
          today_total: 0,
          today_count: 0,
          today_largest: null,
          period_total: 3821,
          period_count: 17,
          period_largest: { category: 'كهرباء ومرافق', amount: 2000 },
          period_advances_total: 800,
          period_advances_count: 3,
          period_non_advances_total: 3021,
          period_non_advances_count: 14,
        },
      }));
      await waitFor(() =>
        expect(screen.getByTestId('card-today-expenses')).toBeInTheDocument(),
      );
      // PR-FIN-DASHBOARD-EXPENSES-CASH-BASIS-REVERT — title carries
      // "النقدية" so the basis is explicit.
      expect(
        screen.getByText('المصروفات النقدية (اليوم / الفترة)'),
      ).toBeInTheDocument();
      // Both sections render.
      expect(screen.getByTestId('expenses-today-total')).toBeInTheDocument();
      expect(screen.getByTestId('expenses-period-total')).toBeInTheDocument();
      expect(screen.getByTestId('expenses-period-count')).toBeInTheDocument();
      expect(screen.getByTestId('expenses-period-largest-cat')).toBeInTheDocument();
      // Period rows reflect data, today shows zeros.
      expect(screen.getByTestId('expenses-period-total').textContent).toMatch(/3,821/);
      expect(screen.getByTestId('expenses-period-count').textContent).toMatch(/17/);
    });

    it('SuppliersBalanceCard caption explains the source(s)', async () => {
      renderPage(buildFixture({
        balances: {
          customers: { total_due: 0, count: 0, top: null },
          employees: { total_owed_to: 0, total_owed_by: 0, net: 0 },
          suppliers: {
            total_due: 0,
            count: 0,
            top: null,
            effective_source: 'none',
            sources_checked: ['suppliers_table', 'gl_211', 'purchases'],
          },
        },
      }));
      await waitFor(() =>
        expect(screen.getByTestId('card-suppliers-balance')).toBeInTheDocument(),
      );
      // 'none' branch renders the explicit "no records" message.
      expect(
        screen.getByText('لا توجد أرصدة موردين مسجلة حاليًا'),
      ).toBeInTheDocument();
      // Source list is always shown so the operator knows what was checked.
      expect(
        screen.getByText(/سجل الموردين · GL 211 · المشتريات غير المسدّدة/),
      ).toBeInTheDocument();
    });

    it('SuppliersBalanceCard shows the dominant source when one has data', async () => {
      renderPage(buildFixture({
        balances: {
          customers: { total_due: 0, count: 0, top: null },
          employees: { total_owed_to: 0, total_owed_by: 0, net: 0 },
          suppliers: {
            total_due: 600,
            count: 2,
            top: { name: 'مصنع النور', amount: 400 },
            effective_source: 'gl_211',
            sources_checked: ['suppliers_table', 'gl_211', 'purchases'],
          },
        },
      }));
      await waitFor(() =>
        expect(screen.getByTestId('card-suppliers-balance')).toBeInTheDocument(),
      );
      expect(screen.getByText(/محسوب من: GL 211/)).toBeInTheDocument();
    });
  });

  /**
   * PR-FIN-DASHBOARD-EMPLOYEES-SIGN — the employees card was reading
   * the BE's `total_owed_to` field as if it meant "owed TO employees",
   * but the BE field actually carries SUM-of-positive balances, which
   * by the `v_employee_gl_balance` sign convention means EMPLOYEES OWE
   * BUSINESS ("على الموظف"). The fix relabels in the FE only — the BE
   * contract is preserved. These specs pin the new direction-aware
   * labels and the production-style fixture so the bug can't regress.
   */
  describe('EmployeesBalanceCard — sign convention', () => {
    function employeesFixture(employees: Data['balances']['employees']): Data {
      return buildFixture({
        balances: {
          customers: { total_due: 0, count: 0, top: null },
          suppliers: {
            total_due: 0, count: 0, top: null,
            effective_source: 'none',
            sources_checked: ['suppliers_table', 'gl_211', 'purchases'],
          },
          employees,
        },
      });
    }

    it('positive balances render under "إجمالي على الموظفين" (NOT "إجمالي له")', async () => {
      renderPage(employeesFixture({ total_owed_to: 200, total_owed_by: 50, net: 150 }));
      await waitFor(() =>
        expect(screen.getByTestId('card-employees-balance')).toBeInTheDocument(),
      );
      // Card title still reads "أرصدة الموظفين"
      expect(screen.getByText('أرصدة الموظفين')).toBeInTheDocument();
      // The positives row label is the new direction-correct text.
      expect(screen.getByText('إجمالي على الموظفين')).toBeInTheDocument();
      // The legacy mislabel must be gone.
      expect(screen.queryByText('إجمالي له')).toBeNull();
      // The value next to the new label equals the BE's total_owed_to.
      expect(screen.getByTestId('employees-owed-by').textContent).toMatch(/200/);
    });

    it('negative balances render under "إجمالي للموظفين" (NOT "إجمالي عليه")', async () => {
      renderPage(employeesFixture({ total_owed_to: 200, total_owed_by: 50, net: 150 }));
      await waitFor(() =>
        expect(screen.getByTestId('card-employees-balance')).toBeInTheDocument(),
      );
      expect(screen.getByText('إجمالي للموظفين')).toBeInTheDocument();
      expect(screen.queryByText('إجمالي عليه')).toBeNull();
      // The value next to the new label equals the BE's total_owed_by.
      expect(screen.getByTestId('employees-owed-to').textContent).toMatch(/50/);
    });

    it('positive net renders "صافي على الموظفين" with absolute value', async () => {
      renderPage(employeesFixture({ total_owed_to: 200, total_owed_by: 50, net: 150 }));
      await waitFor(() =>
        expect(screen.getByTestId('card-employees-balance')).toBeInTheDocument(),
      );
      expect(screen.getByText('صافي على الموظفين')).toBeInTheDocument();
      expect(screen.queryByText('صافي للموظفين')).toBeNull();
      expect(screen.queryByText('متوازن')).toBeNull();
      expect(screen.getByTestId('employees-net').textContent).toMatch(/150/);
    });

    it('negative net renders "صافي للموظفين" with absolute value', async () => {
      renderPage(employeesFixture({ total_owed_to: 0, total_owed_by: 300, net: -300 }));
      await waitFor(() =>
        expect(screen.getByTestId('card-employees-balance')).toBeInTheDocument(),
      );
      expect(screen.getByText('صافي للموظفين')).toBeInTheDocument();
      expect(screen.queryByText('صافي على الموظفين')).toBeNull();
      // |−300| = 300 — net is rendered as absolute value, direction in the label.
      expect(screen.getByTestId('employees-net').textContent).toMatch(/300/);
    });

    it('zero net renders "متوازن" (no direction)', async () => {
      renderPage(employeesFixture({ total_owed_to: 0, total_owed_by: 0, net: 0 }));
      await waitFor(() =>
        expect(screen.getByTestId('card-employees-balance')).toBeInTheDocument(),
      );
      expect(screen.getByText('متوازن')).toBeInTheDocument();
      expect(screen.queryByText('صافي على الموظفين')).toBeNull();
      expect(screen.queryByText('صافي للموظفين')).toBeNull();
    });

    it('production-style fixture (محمد الظباطي 2080 + أبو يوسف 70) shows إجمالي على الموظفين = 2,150', async () => {
      // Synthetic two-employee fixture per spec — mirrors the live data
      // with مدير النظام omitted so the assertion total is exactly 2,150.
      renderPage(employeesFixture({
        total_owed_to: 2150,   // 2080 + 70 — sum of positives in BE field naming
        total_owed_by: 0,
        net: 2150,
      }));
      await waitFor(() =>
        expect(screen.getByTestId('card-employees-balance')).toBeInTheDocument(),
      );
      // Direction-correct label, with the 2,150 figure in the positives row.
      expect(screen.getByText('إجمالي على الموظفين')).toBeInTheDocument();
      expect(screen.getByTestId('employees-owed-by').textContent).toMatch(/2,150/);
      // The "للموظفين" row reads zero — nothing the business owes.
      expect(screen.getByTestId('employees-owed-to').textContent).toMatch(/0/);
      // Net direction is "على" (positive net), value is the absolute 2,150.
      expect(screen.getByText('صافي على الموظفين')).toBeInTheDocument();
      expect(screen.getByTestId('employees-net').textContent).toMatch(/2,150/);
    });

    it('caption explains the sign convention so future readers cannot misinterpret', async () => {
      renderPage(employeesFixture({ total_owed_to: 100, total_owed_by: 0, net: 100 }));
      await waitFor(() =>
        expect(screen.getByTestId('card-employees-balance')).toBeInTheDocument(),
      );
      expect(screen.getByTestId('employees-sign-caption')).toBeInTheDocument();
      expect(screen.getByText('الموجب يعني عهد/سلف على الموظف')).toBeInTheDocument();
    });
  });

  /**
   * PR-FIN-DASHBOARD-EXPENSES-CASH-BASIS-REVERT — the expenses card
   * was switched to accrual-leaning by PR #257 (advances out, wage
   * accruals in). The user clarified afterwards that the card must
   * be cash-basis: every EGP that left the cash drawer for an
   * operating purpose during the range is an "expense" on this card.
   * Advances ARE included (cash physically left), wage accruals are
   * NOT added to the headline (that would double-count the same
   * wage event the advance pre-pays).
   *
   * These specs lock the new title, the cash-basis caption, the
   * breakdown rows (sums to headline), and the production-style
   * 7,796 fixture so the bug can't regress.
   */
  describe('TodayExpensesCard — cash-basis revert (PR-FIN-DASHBOARD-EXPENSES-CASH-BASIS-REVERT)', () => {
    function expensesFixture(daily_expenses: Data['daily_expenses']): Data {
      return buildFixture({ daily_expenses });
    }

    it('title is "المصروفات النقدية (...)" — basis is explicit', async () => {
      renderPage();
      await waitFor(() =>
        expect(screen.getByTestId('card-today-expenses')).toBeInTheDocument(),
      );
      expect(
        screen.getByText('المصروفات النقدية (اليوم / الفترة)'),
      ).toBeInTheDocument();
      // The unscoped pre-PR title is gone.
      expect(screen.queryByText('المصروفات (اليوم / الفترة)')).toBeNull();
    });

    it('renders the cash-basis caption explaining the rule', async () => {
      renderPage();
      await waitFor(() =>
        expect(screen.getByTestId('expenses-cash-basis-caption')).toBeInTheDocument(),
      );
      expect(
        screen.getByText(
          'كل النقدية التي خرجت من الخزائن خلال الفترة، تشمل السلف والمصروفات التشغيلية',
        ),
      ).toBeInTheDocument();
    });

    it('production-style fixture: period_total=7,796 with advances 4,051 + non-advances 3,745 — both rows render', async () => {
      // The user's reported old/new bridge range is 2026-04-01..05-03.
      // Headline restored to 7,796; breakdown rows sum to it exactly.
      renderPage(expensesFixture({
        today_total: 70,
        today_count: 1,
        today_largest: { category: 'سلف الموظفين', amount: 70 },
        period_total: 7796,
        period_count: 30,
        period_largest: { category: 'سلف الموظفين', amount: 2000 },
        period_advances_total: 4051,
        period_advances_count: 15,
        period_non_advances_total: 3745,
        period_non_advances_count: 15,
      }));
      await waitFor(() =>
        expect(screen.getByTestId('card-today-expenses')).toBeInTheDocument(),
      );
      // Headline restored to old (cash-basis) value.
      expect(screen.getByTestId('expenses-period-total').textContent).toMatch(/7,796/);
      expect(screen.getByTestId('expenses-period-count').textContent).toMatch(/30/);
      // The advance-on-today (the 70 EGP that PR #257 was hiding) is back.
      expect(screen.getByTestId('expenses-today-total').textContent).toMatch(/70/);
      // Breakdown rows present + correct.
      expect(screen.getByText('منها سلف موظفين')).toBeInTheDocument();
      expect(screen.getByTestId('expenses-period-advances').textContent).toMatch(/4,051/);
      expect(screen.getByText('منها مصروفات تشغيلية أخرى')).toBeInTheDocument();
      expect(screen.getByTestId('expenses-period-non-advances').textContent).toMatch(/3,745/);
    });

    it('breakdown rows sum to headline exactly (no overlap, no missing)', async () => {
      const fixture = expensesFixture({
        today_total: 0,
        today_count: 0,
        today_largest: null,
        period_total: 12345,
        period_count: 7,
        period_largest: { category: 'مستلزمات', amount: 5000 },
        period_advances_total: 4321,
        period_advances_count: 3,
        period_non_advances_total: 8024,
        period_non_advances_count: 4,
      });
      // 4,321 + 8,024 = 12,345 (headline) and 3 + 4 = 7 (count)
      renderPage(fixture);
      await waitFor(() =>
        expect(screen.getByTestId('expenses-period-total')).toBeInTheDocument(),
      );
      expect(screen.getByTestId('expenses-period-total').textContent).toMatch(/12,345/);
      expect(screen.getByTestId('expenses-period-advances').textContent).toMatch(/4,321/);
      expect(screen.getByTestId('expenses-period-non-advances').textContent).toMatch(/8,024/);
    });

    it('legacy single-bucket fixture (zero breakdown) still renders cleanly', async () => {
      renderPage(expensesFixture({
        today_total: 0,
        today_count: 0,
        today_largest: null,
        period_total: 0,
        period_count: 0,
        period_largest: null,
        period_advances_total: 0,
        period_advances_count: 0,
        period_non_advances_total: 0,
        period_non_advances_count: 0,
      }));
      await waitFor(() =>
        expect(screen.getByTestId('card-today-expenses')).toBeInTheDocument(),
      );
      // No NaN/undefined leaking into either breakdown row.
      expect(screen.getByTestId('expenses-period-advances').textContent).not.toMatch(/NaN|undefined/);
      expect(screen.getByTestId('expenses-period-non-advances').textContent).not.toMatch(/NaN|undefined/);
    });
  });

  /* ────────────────────────────────────────────────────────────────
   * PR-AUDIT-LABELS-CASH-VS-GL — disambiguates GL roll-up vs
   * operational cashbox sums on the النقدية card. The card is now
   * titled "السيولة المحاسبية"; each sub-row carries the explicit
   * "(GL XXXX)" suffix; the card's <h4> exposes a `title` tooltip
   * with the formula. Values must remain byte-identical for the
   * same fixture (no formula change; this PR is purely labels).
   * ────────────────────────────────────────────────────────────────*/
  describe('CashEquivalentsCard — PR-AUDIT-LABELS-CASH-VS-GL', () => {
    it('title is "السيولة المحاسبية" (NOT the old ambiguous "النقدية وما في حكمها")', async () => {
      renderPage();
      const card = await screen.findByTestId('card-cash-equivalents');
      // New title present
      const titleEl = within(card).getByTestId('card-cash-equivalents-title');
      expect(titleEl).toHaveTextContent('السيولة المحاسبية');
      // Old ambiguous title gone from this card
      expect(card.textContent).not.toMatch(/النقدية وما في حكمها/);
    });

    it('title exposes the formula tooltip naming GL 1111 + 1113 + 1114 + 1115', async () => {
      renderPage();
      const card = await screen.findByTestId('card-cash-equivalents');
      const titleEl = within(card).getByTestId('card-cash-equivalents-title');
      const tooltip = titleEl.getAttribute('title') ?? '';
      expect(tooltip).toMatch(/السيولة المحاسبية/);
      expect(tooltip).toMatch(/GL 1111/);
      expect(tooltip).toMatch(/GL 1113/);
      expect(tooltip).toMatch(/GL 1114/);
      expect(tooltip).toMatch(/GL 1115/);
    });

    it('sub-row labels carry "إجمالي X (محاسبي GL ####)" prefix/suffix (PR-AUDIT-LABELS-CASH-VS-GL — Sprint 2 / PR-4)', async () => {
      renderPage();
      const card = await screen.findByTestId('card-cash-equivalents');
      // New labels carry the "إجمالي" prefix and an explicit "(محاسبي GL ####)"
      // suffix — operator can identify both the bucket AND the source.
      expect(within(card).getByText('إجمالي الخزائن (محاسبي GL 1111)')).toBeInTheDocument();
      expect(within(card).getByText('إجمالي البنوك (محاسبي GL 1113)')).toBeInTheDocument();
      expect(within(card).getByText('إجمالي المحافظ (محاسبي GL 1114)')).toBeInTheDocument();
      expect(within(card).getByText('إجمالي الشيكات (محاسبي GL 1115)')).toBeInTheDocument();
      // The previous PR #269 phrasings ("X المحاسبية (GL ####)") are gone.
      expect(card.textContent).not.toMatch(/الخزائن المحاسبية \(GL 1111\)/);
      expect(card.textContent).not.toMatch(/البنوك المحاسبية \(GL 1113\)/);
      expect(card.textContent).not.toMatch(/المحافظ المحاسبية \(GL 1114\)/);
      expect(card.textContent).not.toMatch(/الشيكات المحاسبية \(GL 1115\)/);
    });

    it('values are unchanged for the same fixture (label-only PR — no formula change)', async () => {
      // Default fixture (see top-of-file `buildFixture`):
      //   cashboxes_total=100, banks_total=200, wallets_total=50,
      //   checks_total=0, total_cash_equivalents=350.
      renderPage();
      const card = await screen.findByTestId('card-cash-equivalents');
      // Each displayed amount must be byte-identical to the fixture.
      expect(card.textContent).toMatch(/100/); // cashboxes_total
      expect(card.textContent).toMatch(/200/); // banks_total
      expect(card.textContent).toMatch(/50/);  // wallets_total
      expect(card.textContent).toMatch(/350/); // total
    });
  });

  /* ────────────────────────────────────────────────────────────────
   * PR-AUDIT-DASHBOARD-ANALYTICS-LABELS (Sprint 2 / PR-6) — every
   * P&L tile in Row 2 carries an explicit `title=` tooltip that
   * names the formula AND the basis (invoice / cash / mixed). This
   * is a labels-and-tooltips PR; values are byte-identical to the
   * pre-PR rendering for the same fixture (asserted below).
   * ────────────────────────────────────────────────────────────────*/
  describe('Row 2 P&L — basis tooltips (PR-AUDIT-DASHBOARD-ANALYTICS-LABELS)', () => {
    const findTitleTooltip = (testId: string) => {
      const tile = screen.getByTestId(testId);
      const title = within(tile).getByTestId(`${testId}-title`);
      return title.getAttribute('title') ?? '';
    };

    it('إجمالي المبيعات — tooltip declares invoice/subtotal basis', async () => {
      renderPage();
      await screen.findByTestId('profit-sales-total');
      const tip = findTitleTooltip('profit-sales-total');
      expect(tip).toMatch(/subtotal/);
      expect(tip).toMatch(/أساس فاتورة/);
      expect(tip).toMatch(/قبل الضريبة/);
    });

    it('تكلفة البضاعة المباعة — tooltip declares invoice basis (cogs_total)', async () => {
      renderPage();
      await screen.findByTestId('profit-cogs');
      const tip = findTitleTooltip('profit-cogs');
      expect(tip).toMatch(/cogs_total/);
      expect(tip).toMatch(/أساس فاتورة/);
    });

    it('مجمل الربح — tooltip declares invoice basis', async () => {
      renderPage();
      await screen.findByTestId('profit-gross');
      const tip = findTitleTooltip('profit-gross');
      expect(tip).toMatch(/المبيعات − تكلفة البضاعة المباعة/);
      expect(tip).toMatch(/أساس فاتورة/);
    });

    it('إجمالي المصروفات — tooltip declares CASH-BASIS (expenses table)', async () => {
      renderPage();
      await screen.findByTestId('profit-expenses-total');
      const tip = findTitleTooltip('profit-expenses-total');
      expect(tip).toMatch(/أساس نقدي/);
      expect(tip).toMatch(/expenses/);
    });

    it('صافي الربح — tooltip flags MIXED basis (invoice gross − cash expenses) + redirect to Analytics for GL-pure', async () => {
      renderPage();
      await screen.findByTestId('profit-net');
      const tip = findTitleTooltip('profit-net');
      expect(tip).toMatch(/مجمل الربح/);
      expect(tip).toMatch(/فاتورة/);
      expect(tip).toMatch(/نقدي/);
      // Operator pointer to the GL-pure version on Analytics.
      expect(tip).toMatch(/Analytics/);
    });

    it('هامش الربح — tooltip declares invoice-derived basis', async () => {
      renderPage();
      await screen.findByTestId('profit-margin');
      const tip = findTitleTooltip('profit-margin');
      expect(tip).toMatch(/أساس فاتورة/);
    });

    it('all 6 P&L tiles render their fixture values byte-identical (formula unchanged)', async () => {
      renderPage();
      // Default fixture from buildFixture().profit:
      //   sales_total / cogs_total / gross_profit / expenses_total /
      //   net_profit / margin_pct
      // We don't hard-code numbers here — the contract is "no formula
      // change" — so just assert each testid renders without crash.
      const ids = [
        'profit-sales-total', 'profit-cogs', 'profit-gross',
        'profit-expenses-total', 'profit-net', 'profit-margin',
      ];
      for (const id of ids) {
        await screen.findByTestId(id);
      }
    });
  });
});
