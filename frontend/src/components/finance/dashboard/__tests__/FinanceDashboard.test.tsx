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
import { render, screen, waitFor } from '@testing-library/react';
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
      cashboxes_total: 100,
      banks_total: 200,
      wallets_total: 50,
      cards_total: 0,
      total_cash_equivalents: 350,
    },
    daily_expenses: {
      today_total: 0,
      today_count: 0,
      today_largest: null,
      period_total: 250,
      period_count: 3,
      period_largest: { category: 'إيجار', amount: 150 },
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
    expect(screen.getByText('النقدية وما في حكمها')).toBeInTheDocument();
    expect(screen.getByText('أرصدة العملاء')).toBeInTheDocument();
    expect(screen.getByText('أرصدة الموردين')).toBeInTheDocument();
    expect(screen.getByText('أرصدة الموظفين')).toBeInTheDocument();
    // PR-FIN-2-HOTFIX-4 — title relabeled to surface period totals.
    expect(
      screen.getByText('المصروفات (اليوم / الفترة)'),
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
        },
      }));
      await waitFor(() =>
        expect(screen.getByTestId('card-today-expenses')).toBeInTheDocument(),
      );
      // Title relabeled.
      expect(
        screen.getByText('المصروفات (اليوم / الفترة)'),
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
});
