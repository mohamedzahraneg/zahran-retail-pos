/**
 * EmployeeOverviewTab — PR-T4.3 (full dashboard rewrite)
 * ─────────────────────────────────────────────────────────────────────
 *
 * Replaces the compact PR-T4.1 overview with the full sales/performance
 * dashboard from `employee_overview_sales_performance_design.html`:
 * large KPI cards, derived performance gauge, daily-sales chart, top
 * invoices, period comparison, commission box. All sales numbers come
 * from /commissions/{summary,detail} (the only canonical employee→
 * sales linkage in the backend — `invoice_items.salesperson_id`).
 *
 * Real-data sources (no new endpoints, no migrations):
 *   · /employees/:id/dashboard → attendance.month, wage, gl, salary
 *   · /commissions/summary?from&to (current + previous month) →
 *     eligible_sales, invoices_count, commission_rate, commission_amount
 *     per user, scoped to the selected employee via .find(user_id == id)
 *   · /commissions/:id/detail?from&to → per-invoice rows (used for
 *     top invoices + daily sales chart aggregation)
 *
 * Documented missing fields (no API exposes them — never faked):
 *   · Collection ratio (paid_amount vs eligible_total) — invoice
 *     payment data isn't on /commissions/detail; would need a
 *     dedicated /invoices?cashier_id endpoint
 *   · Sales by category (donut) — same: needs invoice_items roll-up
 *   · Department / branch / direct manager (header meta) — not on
 *     /employees/:id/dashboard
 *   · Performance score formula — no API. We derive a transparent
 *     score (see PerformanceGauge below) and label it
 *     "مؤشر أداء تقديري" so users understand it's a heuristic.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Receipt,
  CalendarCheck,
  Banknote,
  Wallet,
  TrendingUp,
  Percent,
  TrendingDown,
  Calculator,
  Building2,
  Calendar,
  PieChart,
  Award,
  Star,
} from 'lucide-react';
import { TeamRow, employeesApi } from '@/api/employees.api';
import {
  commissionsApi,
  CommissionDetailRow,
  CommissionCategoryBreakdownRow,
} from '@/api/commissions.api';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const fmtHours = (minutes: number) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}س ${String(m).padStart(2, '0')}د`;
};

const fmtDate = (iso?: string | null) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
};

interface PeriodBounds {
  from: string;
  to: string;
}

type PeriodMode = 'daily' | 'weekly' | 'monthly' | 'custom';

/** YYYY-MM-DD for "today" anchored in Cairo. */
function cairoTodayParts() {
  const today = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(today);
  return {
    y: parseInt(parts.find((p) => p.type === 'year')!.value, 10),
    m: parseInt(parts.find((p) => p.type === 'month')!.value, 10),
    d: parseInt(parts.find((p) => p.type === 'day')!.value, 10),
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
const ymd = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;

/** Produce {from, to} for a given period mode anchored on today (Cairo). */
function periodBoundsFor(
  mode: PeriodMode,
  custom?: { from: string; to: string },
): PeriodBounds {
  const { y, m, d } = cairoTodayParts();
  const today = ymd(y, m, d);
  if (mode === 'daily') return { from: today, to: today };
  if (mode === 'weekly') {
    // last 7 days inclusive
    const ms = new Date(`${today}T00:00:00Z`).getTime() - 6 * 86400_000;
    const from = new Date(ms);
    return {
      from: ymd(from.getUTCFullYear(), from.getUTCMonth() + 1, from.getUTCDate()),
      to: today,
    };
  }
  if (mode === 'monthly') return { from: ymd(y, m, 1), to: today };
  if (mode === 'custom' && custom) return custom;
  return { from: ymd(y, m, 1), to: today };
}

/** Previous period of the same length (for delta KPIs). */
function previousPeriodBoundsFor(current: PeriodBounds): PeriodBounds {
  const fromMs = new Date(`${current.from}T00:00:00Z`).getTime();
  const toMs = new Date(`${current.to}T00:00:00Z`).getTime();
  const len = (toMs - fromMs) / 86400_000 + 1;
  const prevToMs = fromMs - 86400_000;
  const prevFromMs = prevToMs - (len - 1) * 86400_000;
  const f = new Date(prevFromMs);
  const t = new Date(prevToMs);
  return {
    from: ymd(f.getUTCFullYear(), f.getUTCMonth() + 1, f.getUTCDate()),
    to: ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()),
  };
}

/* ─────────────────────────────────────────────────────────────────
 * Top-level component — full dashboard layout
 * ───────────────────────────────────────────────────────────────── */

/**
 * PR-ESS-2A — `mode='self'` is used by the /me self-service profile to
 * reuse this overview read-only. All admin mutation surfaces in this
 * tab live in the Team workspace HEADER (above the tabs in Team.tsx),
 * not inside this component, so there's nothing inline to gate. The
 * only behavioural difference in self mode is data sourcing:
 *   · commissions detail uses /me/detail (no `accounting.view` gate)
 *   · category breakdown + seller settings are hidden — they require
 *     `accounting.view` and a self-service /me equivalent isn't worth
 *     adding for the small marginal value (the donut + target widgets
 *     are admin-grade signals; the employee's headline KPIs are still
 *     visible from the dashboard endpoint).
 */
export function EmployeeOverviewTab({
  employee,
  mode = 'admin',
}: {
  employee: TeamRow;
  mode?: 'admin' | 'self';
}) {
  const userId = employee.id;
  const isSelf = mode === 'self';

  // PR-T4.5 — period filter (يومي / أسبوعي / شهري / مخصص). Default:
  // monthly to match the prior fixed-month behavior. All sales panels
  // re-derive from this single period state.
  const [periodMode, setPeriodMode] = useState<PeriodMode>('monthly');
  const [custom, setCustom] = useState<PeriodBounds>(() =>
    periodBoundsFor('monthly'),
  );
  const period = useMemo(
    () => periodBoundsFor(periodMode, custom),
    [periodMode, custom],
  );
  const prevPeriod = useMemo(() => previousPeriodBoundsFor(period), [period]);

  const { data: dash } = useQuery({
    queryKey: ['employee-user-dashboard', userId, isSelf],
    queryFn: () =>
      isSelf
        ? employeesApi.dashboard()
        : employeesApi.userDashboard(userId),
  });

  // PR-T4.4 — sales data is driven by the per-invoice detail endpoint
  // (returns rows for ANY salesperson regardless of commission_rate).
  // PR-T4.5 — paid_total / grand_total now also returned for the
  // collection KPIs, and a separate categoryBreakdown query feeds the
  // donut panel.
  // PR-ESS-2A — in self mode we use /commissions/me/detail (gated by
  // employee.dashboard.view) instead of /commissions/:userId/detail
  // (gated by accounting.view).
  const { data: detail = [] } = useQuery({
    queryKey: ['commissions-detail', userId, period.from, period.to, isSelf],
    queryFn: () =>
      isSelf
        ? commissionsApi.myDetail(period.from, period.to)
        : commissionsApi.detail(userId, period.from, period.to),
  });
  const { data: prevDetail = [] } = useQuery({
    queryKey: [
      'commissions-detail',
      userId,
      prevPeriod.from,
      prevPeriod.to,
      isSelf,
    ],
    queryFn: () =>
      isSelf
        ? commissionsApi.myDetail(prevPeriod.from, prevPeriod.to)
        : commissionsApi.detail(userId, prevPeriod.from, prevPeriod.to),
  });
  // categoryBreakdown + sellerSettings stay admin-only. In self mode
  // we skip the queries entirely (the donut + target widgets render
  // empty — see SalesPanels for the empty-state).
  const { data: categoryBreakdown = [] } = useQuery({
    queryKey: ['commissions-category-breakdown', userId, period.from, period.to],
    queryFn: () =>
      commissionsApi.categoryBreakdown(userId, period.from, period.to),
    enabled: !isSelf,
  });
  // PR-T4.6 — seller settings drive the target widgets. Independent of
  // the period filter (target is a per-user config, not a per-period
  // metric); only the achievement KPI re-derives when the period
  // changes.
  const { data: sellerSettings } = useQuery({
    queryKey: ['commissions-seller-settings', userId],
    queryFn: () => commissionsApi.getSellerSettings(userId),
    enabled: !isSelf,
  });

  const detailRows = detail as CommissionDetailRow[];
  const prevDetailRows = prevDetail as CommissionDetailRow[];
  const isSalesperson = detailRows.length > 0 || prevDetailRows.length > 0;

  const eligibleSales = useMemo(
    () => detailRows.reduce((s, r) => s + Number(r.eligible_total || 0), 0),
    [detailRows],
  );
  const prevEligibleSales = useMemo(
    () => prevDetailRows.reduce((s, r) => s + Number(r.eligible_total || 0), 0),
    [prevDetailRows],
  );
  const invoicesCount = detailRows.length;
  const prevInvoicesCount = prevDetailRows.length;
  // Per-row commission_rate is duplicated across rows of the same
  // user; pick the first non-empty value (will be the user's current
  // rate as of the query). Falls back to 0.
  const commissionRate = Number(detailRows[0]?.commission_rate ?? 0);
  const commissionAmount = useMemo(
    () => detailRows.reduce((s, r) => s + Number(r.commission || 0), 0),
    [detailRows],
  );
  const prevCommissionAmount = useMemo(
    () => prevDetailRows.reduce((s, r) => s + Number(r.commission || 0), 0),
    [prevDetailRows],
  );
  const avgInvoice = invoicesCount > 0 ? eligibleSales / invoicesCount : 0;
  const prevAvgInvoice = prevInvoicesCount > 0 ? prevEligibleSales / prevInvoicesCount : 0;

  // PR-T4.5 — collection KPIs (تحصيلات / نسبة التحصيل). Source: the
  // detail rows now carry inv.paid_total + inv.grand_total.
  // collectionsAvailable = at least one invoice in the window has a
  // paid_total > 0 (otherwise we render "غير متاح" rather than a
  // misleading 0).
  const collectionsTotal = useMemo(
    () => detailRows.reduce((s, r) => s + Number(r.paid_total || 0), 0),
    [detailRows],
  );
  const grandTotal = useMemo(
    () => detailRows.reduce((s, r) => s + Number(r.grand_total || 0), 0),
    [detailRows],
  );
  const collectionsAvailable = detailRows.some(
    (r) => Number(r.paid_total || 0) > 0,
  );
  const collectionRatio =
    collectionsAvailable && grandTotal > 0
      ? (collectionsTotal / grandTotal) * 100
      : null;
  const prevCollectionsTotal = useMemo(
    () => prevDetailRows.reduce((s, r) => s + Number(r.paid_total || 0), 0),
    [prevDetailRows],
  );

  // PR-T4.6 — target system. The settings now carry an explicit
  // `sales_target_period` (none/daily/weekly/monthly) + `commission_mode`
  // (general / after_target / over_target / general_plus_over_target).
  // When the period the user selected on the Overview matches the target
  // period, the comparison is exact. When they don't match (e.g. user
  // configured a monthly target but is viewing daily), the panel still
  // shows the configured target but labels the comparison as "تقديري"
  // since proportional scaling would be misleading.
  const targetAmount = sellerSettings?.sales_target_amount
    ? Number(sellerSettings.sales_target_amount)
    : null;
  const targetPeriod = sellerSettings?.sales_target_period ?? 'none';
  const afterTargetRate =
    sellerSettings?.commission_after_target_rate != null
      ? Number(sellerSettings.commission_after_target_rate)
      : null;
  const overTargetRate =
    sellerSettings?.over_target_commission_rate != null
      ? Number(sellerSettings.over_target_commission_rate)
      : null;
  const commissionMode = sellerSettings?.commission_mode ?? 'general';
  const targetEnabled =
    targetPeriod !== 'none' && targetAmount !== null && targetAmount > 0;

  // Period match: 'monthly' filter aligns with monthly target, etc.
  // 'custom' never matches — flagged as تقديري.
  const periodMatch =
    !targetEnabled
      ? null
      : periodMode === 'custom'
        ? 'custom'
        : periodMode === targetPeriod
          ? 'exact'
          : 'mismatch';

  const achievementPct =
    targetEnabled && targetAmount! > 0
      ? Math.min((eligibleSales / targetAmount!) * 100, 999)
      : null;
  const remainingToTarget =
    targetEnabled ? Math.max(targetAmount! - eligibleSales, 0) : 0;
  const overTargetSales =
    targetEnabled ? Math.max(eligibleSales - targetAmount!, 0) : 0;

  // Commission estimate by mode. All four modes operate on
  // (eligibleSales, targetAmount, baseRate, afterRate, overRate).
  const estimatedCommission = useMemo(() => {
    if (commissionRate <= 0) return 0;
    const t = targetAmount ?? 0;
    const reached = targetEnabled && eligibleSales >= t;
    const above = Math.max(eligibleSales - t, 0);
    switch (commissionMode) {
      case 'after_target':
        if (!reached) return 0;
        return (eligibleSales * (afterTargetRate ?? commissionRate)) / 100;
      case 'over_target':
        if (!targetEnabled || above === 0) return 0;
        return (above * (overTargetRate ?? 0)) / 100;
      case 'general_plus_over_target': {
        let c = (eligibleSales * commissionRate) / 100;
        if (targetEnabled && above > 0) {
          c += (above * (overTargetRate ?? 0)) / 100;
        }
        return c;
      }
      case 'general':
      default:
        return (eligibleSales * commissionRate) / 100;
    }
  }, [
    commissionMode,
    commissionRate,
    targetEnabled,
    targetAmount,
    eligibleSales,
    afterTargetRate,
    overTargetRate,
  ]);

  const categoryRows = categoryBreakdown as CommissionCategoryBreakdownRow[];
  const categoryRowsValid = categoryRows.filter(
    (r) => r.category_id !== null && Number(r.total) > 0,
  );
  const categoryUnclassified = categoryRows
    .filter((r) => r.category_id === null)
    .reduce((s, r) => s + Number(r.total || 0), 0);
  const categoryClassifiedTotal = categoryRowsValid.reduce(
    (s, r) => s + Number(r.total || 0),
    0,
  );

  const monthDays = dash?.attendance?.month?.days ?? 0;
  const monthMinutes = dash?.attendance?.month?.minutes ?? 0;
  const accrualInMonth = Number(dash?.wage?.accrual_in_month || 0);
  const paidInMonth = Number(dash?.wage?.paid_in_month || 0);
  const advancesMonth = Number(dash?.salary?.advances_month || 0);
  const liveGl = Number(dash?.gl?.live_snapshot ?? 0);

  // Top 5 invoices by eligible total.
  const topInvoices = useMemo(
    () =>
      [...(detail as CommissionDetailRow[])]
        .sort((a, b) => Number(b.eligible_total) - Number(a.eligible_total))
        .slice(0, 5),
    [detail],
  );

  // Daily sales aggregation for the chart — group commissionsApi.detail
  // rows by completed_at date, sum eligible_total per day.
  const dailySales = useMemo(() => {
    const m = new Map<string, number>();
    for (const r of detail as CommissionDetailRow[]) {
      const d = (r.completed_at || '').slice(0, 10);
      if (!d) continue;
      m.set(d, (m.get(d) || 0) + Number(r.eligible_total || 0));
    }
    return [...m.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, amount]) => ({ date, amount }));
  }, [detail]);

  // Derived performance score — transparent heuristic, clearly labeled
  // "تقديري" so users know it's not authoritative. No DB write.
  const performance = useMemo(() => {
    // Targets (rough industry defaults — admin can override later
    // when a real performance API exists).
    const targetWorkDays = 22;
    const targetSales = 50000;
    const targetInvoices = 30;

    const attendanceRatio = Math.min(monthDays / targetWorkDays, 1);
    const salesRatio = isSalesperson ? Math.min(eligibleSales / targetSales, 1) : 0;
    const invoiceRatio = isSalesperson ? Math.min(invoicesCount / targetInvoices, 1) : 0;

    let score: number;
    let parts: string[] = [];
    if (isSalesperson) {
      // Salespeople: 40% attendance + 30% sales + 30% invoice count
      score = Math.round(
        (attendanceRatio * 0.4 + salesRatio * 0.3 + invoiceRatio * 0.3) * 100,
      );
      parts = [
        `حضور ${Math.round(attendanceRatio * 100)}%`,
        `مبيعات ${Math.round(salesRatio * 100)}%`,
        `فواتير ${Math.round(invoiceRatio * 100)}%`,
      ];
    } else {
      // Non-salespeople: pure attendance.
      score = Math.round(attendanceRatio * 100);
      parts = [`حضور ${Math.round(attendanceRatio * 100)}%`];
    }

    let label: string;
    let tone: 'green' | 'amber' | 'rose';
    if (score >= 80) { label = 'ممتاز'; tone = 'green'; }
    else if (score >= 60) { label = 'جيد'; tone = 'amber'; }
    else { label = 'يحتاج تحسين'; tone = 'rose'; }

    // Star rating — score / 20 = stars (out of 5)
    const stars = Math.round((score / 100) * 5);

    return { score, label, tone, stars, formula: parts.join(' · ') };
  }, [monthDays, eligibleSales, invoicesCount, isSalesperson]);

  return (
    <div className="space-y-6">
      {/* Identity info (avatar / name / role / balance / actions)
          lives on the parent EmployeeProfilePanel header in Team.tsx.
          The Overview tab starts directly with the period chip + KPI
          cards. The duplicate ProfileHeroCard was removed in PR-T4.4
          and its definition deleted in PR-T6 cleanup. */}
      <PeriodHeader
        from={period.from}
        to={period.to}
        mode={periodMode}
        onModeChange={setPeriodMode}
        custom={custom}
        onCustomChange={setCustom}
      />

      {/* MAIN KPI ROW — sales focus when salesperson, else payroll focus.
          PR-T4.5 — sales row matches the reference design: 5 cards in
          green/blue/orange/purple/rose tones (sales / invoices / avg /
          collected / collection ratio). Commission moves to its own
          dedicated panel below since it's logically a percentage-of-
          sales rollup, not a sales KPI itself. */}
      {isSalesperson ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          <BigKpi
            tone="green"
            icon={<TrendingUp size={26} />}
            label="إجمالي المبيعات"
            value={EGP(eligibleSales)}
            sub={
              prevEligibleSales > 0
                ? changeLabel(eligibleSales - prevEligibleSales, true)
                : 'لا بيانات للفترة السابقة'
            }
          />
          <BigKpi
            tone="blue"
            icon={<Receipt size={26} />}
            label="عدد فواتير المبيعات"
            value={`${invoicesCount.toLocaleString('en-US')} فاتورة`}
            sub={
              prevInvoicesCount > 0
                ? changeLabel(invoicesCount - prevInvoicesCount, false)
                : 'لا بيانات للفترة السابقة'
            }
          />
          <BigKpi
            tone="orange"
            icon={<Calculator size={26} />}
            label="متوسط قيمة الفاتورة"
            value={EGP(avgInvoice)}
            sub={
              prevAvgInvoice > 0
                ? changeLabel(avgInvoice - prevAvgInvoice, true)
                : 'لا بيانات للفترة السابقة'
            }
          />
          <BigKpi
            tone="purple"
            icon={<Wallet size={26} />}
            label="تحصيلات نقدية"
            value={collectionsAvailable ? EGP(collectionsTotal) : 'غير متاح'}
            sub={
              !collectionsAvailable
                ? 'لا بيانات تحصيل في الفترة'
                : prevCollectionsTotal > 0
                  ? changeLabel(collectionsTotal - prevCollectionsTotal, true)
                  : 'من إجمالي قيمة الفاتورة'
            }
          />
          <BigKpi
            tone="rose"
            icon={<Percent size={26} />}
            label="نسبة التحصيل"
            value={
              collectionRatio !== null
                ? `${collectionRatio.toFixed(1)}%`
                : 'غير متاح'
            }
            sub={
              collectionRatio !== null
                ? 'من إجمالي المبيعات'
                : 'لا بيانات تحصيل في الفترة'
            }
          />
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4">
          <BigKpi
            tone="green"
            icon={<CalendarCheck size={26} />}
            label="أيام العمل (الشهر)"
            value={monthDays.toString()}
            sub="أيام مسجّل بها حضور"
          />
          <BigKpi
            tone="blue"
            icon={<Banknote size={26} />}
            label="مستحقات معتمدة"
            value={EGP(accrualInMonth)}
            sub="من اعتماد اليوميات"
          />
          <BigKpi
            tone="orange"
            icon={<Wallet size={26} />}
            label="مصروف فعليًا"
            value={EGP(paidInMonth)}
            sub="مجموع التسويات النقدية"
          />
          <BigKpi
            tone="purple"
            icon={<TrendingDown size={26} />}
            label="سلف الشهر"
            value={EGP(advancesMonth)}
            sub="ذمم على الموظف"
          />
          <BigKpi
            tone={liveGl < -0.01 ? 'green' : liveGl > 0.01 ? 'rose' : 'slate'}
            icon={<Receipt size={26} />}
            label="الرصيد النهائي"
            value={EGP(Math.abs(liveGl))}
            sub={
              liveGl < -0.01
                ? 'مستحق له'
                : liveGl > 0.01
                  ? 'مدين للشركة'
                  : 'متوازن'
            }
          />
        </div>
      )}

      {/* PR-T4.6 — Target panel (only when the operator enabled the
          target system in EditProfile). Sits between the KPI row and
          the analytics grid for prominent placement; cells follow the
          same soft-card rhythm as the KPI row above. */}
      {isSalesperson && (
        <TargetPanel
          enabled={targetEnabled}
          period={targetPeriod}
          mode={commissionMode}
          periodMatch={periodMatch}
          target={targetAmount ?? 0}
          achieved={eligibleSales}
          achievementPct={achievementPct}
          remaining={remainingToTarget}
          overTarget={overTargetSales}
          baseRate={commissionRate}
          afterTargetRate={afterTargetRate}
          overTargetRate={overTargetRate}
          estimatedCommission={estimatedCommission}
        />
      )}

      {/* PR-T4.5 — analytics grid: gauge + star rating + category
          donut + daily sales chart. Layout matches the reference:
          two narrow panels (gauge + stars), then category donut, then
          a wider daily-sales chart on the right. */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        <PerformanceGaugePanel performance={performance} />
        <StarRatingPanel performance={performance} />
        <CategoryDistributionPanel
          rows={categoryRowsValid}
          unclassifiedTotal={categoryUnclassified}
          classifiedTotal={categoryClassifiedTotal}
        />
        <DailySalesPanel
          isSalesperson={isSalesperson}
          dailySales={dailySales}
        />
      </div>

      {/* Commission box (focused) + Top invoices + Period comparison */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <CommissionPanel
          isSalesperson={isSalesperson}
          commissionRate={commissionRate}
          commissionAmount={commissionAmount}
          eligibleSales={eligibleSales}
        />
        <TopInvoicesPanel
          isSalesperson={isSalesperson}
          rows={topInvoices}
        />
        <PeriodComparisonPanel
          monthDays={monthDays}
          monthMinutes={monthMinutes}
          accrualInMonth={accrualInMonth}
          paidInMonth={paidInMonth}
          isSalesperson={isSalesperson}
          eligibleSales={eligibleSales}
          prevEligibleSales={prevEligibleSales}
          invoicesCount={invoicesCount}
          prevInvoicesCount={prevInvoicesCount}
          avgInvoice={avgInvoice}
          prevAvgInvoice={prevAvgInvoice}
          commissionAmount={commissionAmount}
          prevCommissionAmount={prevCommissionAmount}
        />
      </div>

      {/* Tasks + requests + missing-data note */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <SmallPanel
          title={`مهام مفتوحة (${dash?.tasks?.length ?? 0})`}
          subtitle="من /employees/:id/dashboard"
        >
          {!dash?.tasks?.length ? (
            <EmptyText>لا مهام مفتوحة.</EmptyText>
          ) : (
            <ul className="px-5 py-2 divide-y divide-slate-100 text-sm">
              {dash.tasks.map((t) => (
                <li key={t.id} className="py-2 flex items-center justify-between gap-2">
                  <span className="font-bold text-slate-700">{t.title}</span>
                  <span className="chip text-[10px] bg-slate-50 border-slate-200 text-slate-600">
                    {t.status === 'pending'
                      ? 'لم يستلم'
                      : t.status === 'acknowledged'
                        ? 'مستلمة'
                        : t.status === 'completed'
                          ? 'مكتملة'
                          : t.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SmallPanel>
        <SmallPanel
          title={`طلبات معلّقة (${dash?.requests?.length ?? 0})`}
          subtitle="القرار من تبويب الموافقات والتعديلات"
        >
          {!dash?.requests?.length ? (
            <EmptyText>لا توجد طلبات.</EmptyText>
          ) : (
            <ul className="px-5 py-2 divide-y divide-slate-100 text-sm">
              {dash.requests.map((r) => (
                <li key={r.id} className="py-2 flex items-center justify-between gap-2">
                  <span>
                    <span className="font-bold text-slate-700">{r.kind}</span>
                    {r.amount != null && ` — ${EGP(r.amount)}`}
                  </span>
                  <span className="text-[11px] text-slate-400">
                    {fmtDate(r.created_at)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </SmallPanel>
        <SmallPanel
          title="مؤشرات في الانتظار"
          subtitle="حقول لم يُكشف عنها API بعد — لم تُختلق."
        >
          <ul className="px-5 py-3 divide-y divide-slate-100 text-xs text-slate-500">
            <li className="py-2 flex items-center gap-2">
              <Building2 size={12} className="text-slate-400" />
              القسم / الفرع / المدير المباشر
            </li>
          </ul>
        </SmallPanel>
      </div>

      <FooterMeta from={period.from} to={period.to} />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Sub-components
 * ───────────────────────────────────────────────────────────────── */

function PeriodHeader({
  from,
  to,
  mode,
  onModeChange,
  custom,
  onCustomChange,
}: {
  from: string;
  to: string;
  mode: PeriodMode;
  onModeChange: (m: PeriodMode) => void;
  custom: PeriodBounds;
  onCustomChange: (b: PeriodBounds) => void;
}) {
  const modeOptions: { value: PeriodMode; label: string }[] = [
    { value: 'daily', label: 'يومي' },
    { value: 'weekly', label: 'أسبوعي' },
    { value: 'monthly', label: 'شهري' },
    { value: 'custom', label: 'مخصص' },
  ];
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h2 className="text-2xl font-black text-slate-800">نظرة عامة على الموظف</h2>
        <p className="text-sm text-slate-500 mt-0.5">
          أداء، مبيعات، حضور، وحركات حسابية ضمن الفترة المحددة.
        </p>
      </div>
      <div className="flex items-center gap-2 flex-wrap">
        <div className="inline-flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-4 py-2 text-sm font-bold text-slate-700">
          <Calendar size={14} className="text-slate-400" />
          {fmtDate(from)} — {fmtDate(to)}
        </div>
        <div className="inline-flex bg-white border border-slate-200 rounded-xl p-1 text-xs font-bold">
          {modeOptions.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => onModeChange(o.value)}
              className={`px-3 py-1.5 rounded-lg transition ${
                mode === o.value
                  ? 'bg-violet-600 text-white'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              {o.label}
            </button>
          ))}
        </div>
        {mode === 'custom' && (
          <div className="inline-flex items-center gap-2 bg-white border border-slate-200 rounded-xl px-3 py-1.5 text-xs font-bold text-slate-700">
            <input
              type="date"
              value={custom.from}
              max={custom.to}
              onChange={(e) =>
                onCustomChange({ from: e.target.value, to: custom.to })
              }
              className="bg-transparent outline-none cursor-pointer"
            />
            <span className="text-slate-400">إلى</span>
            <input
              type="date"
              value={custom.to}
              min={custom.from}
              onChange={(e) =>
                onCustomChange({ from: custom.from, to: e.target.value })
              }
              className="bg-transparent outline-none cursor-pointer"
            />
          </div>
        )}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * CategoryDistributionPanel — donut + legend.
 *
 * Real categories assigned to invoice-item products via
 * /commissions/:id/category-breakdown. When no products in the
 * window have category_id set, the panel renders an honest empty
 * state ("توزيع المبيعات حسب الفئة غير متاح — يحتاج تصنيف
 * المنتجات") and surfaces the unclassified total so the operator
 * sees how much volume is awaiting classification. No fake
 * categories.
 * ───────────────────────────────────────────────────────────────── */
function CategoryDistributionPanel({
  rows,
  unclassifiedTotal,
  classifiedTotal,
}: {
  rows: CommissionCategoryBreakdownRow[];
  unclassifiedTotal: number;
  classifiedTotal: number;
}) {
  const palette = [
    '#7c3aed', // violet-600
    '#3b82f6', // blue-500
    '#10b981', // emerald-500
    '#f59e0b', // amber-500
    '#ef4444', // red-500
    '#ec4899', // pink-500
    '#06b6d4', // cyan-500
    '#84cc16', // lime-500
  ];
  const segments = useMemo(() => {
    if (classifiedTotal <= 0) return [];
    let acc = 0;
    return rows.map((r, i) => {
      const value = Number(r.total || 0);
      const pct = value / classifiedTotal;
      const seg = {
        color: palette[i % palette.length],
        label: r.category_name,
        value,
        pct,
        start: acc,
        end: acc + pct,
      };
      acc += pct;
      return seg;
    });
  }, [rows, classifiedTotal]);

  // Build a conic-gradient string from segments. Each segment occupies
  // (pct * 360deg) of the donut.
  const gradient =
    segments.length > 0
      ? `conic-gradient(${segments
          .map(
            (s) =>
              `${s.color} ${(s.start * 360).toFixed(2)}deg ${(s.end * 360).toFixed(2)}deg`,
          )
          .join(', ')})`
      : 'conic-gradient(#e2e8f0 0deg 360deg)';

  return (
    <Panel
      title="توزيع المبيعات حسب الفئة"
      subtitle={
        classifiedTotal > 0
          ? `${rows.length} فئة نشطة`
          : 'غير متاح — يحتاج تصنيف المنتجات'
      }
    >
      {classifiedTotal === 0 ? (
        <div className="px-5 pb-5 pt-2">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center">
            <PieChart size={32} className="text-slate-300 mx-auto" />
            <div className="text-sm font-black text-slate-600 mt-2">
              توزيع المبيعات حسب الفئة غير متاح
            </div>
            <div className="text-xs text-slate-500 mt-2 leading-relaxed">
              منتجات الفواتير في هذه الفترة ليس لها تصنيف
              (<code>products.category_id IS NULL</code>). بمجرد تحديد
              تصنيف لكل منتج من إعدادات المخزون، ستظهر النسب هنا تلقائيًا.
            </div>
            {unclassifiedTotal > 0 && (
              <div className="text-xs font-bold text-slate-700 mt-3">
                إجمالي مبيعات بدون تصنيف:{' '}
                <span className="text-slate-900">{EGP(unclassifiedTotal)}</span>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="px-5 pb-5 pt-2 flex items-center gap-4">
          <div className="relative w-[140px] h-[140px] shrink-0">
            <div
              className="w-full h-full rounded-full"
              style={{ background: gradient }}
            />
            <div className="absolute inset-[18%] bg-white rounded-full flex flex-col items-center justify-center text-center">
              <div className="text-[10px] text-slate-400">إجمالي</div>
              <div className="text-[14px] font-black text-slate-800 tabular-nums leading-tight mt-0.5">
                {EGP(classifiedTotal)}
              </div>
            </div>
          </div>
          <ul className="flex-1 min-w-0 space-y-2 text-xs">
            {segments.map((s) => (
              <li
                key={s.label}
                className="flex items-center gap-2 text-slate-700"
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ background: s.color }}
                />
                <span className="font-bold flex-1 truncate">{s.label}</span>
                <span className="text-slate-500 tabular-nums">
                  {(s.pct * 100).toFixed(0)}%
                </span>
                <span className="font-bold text-slate-800 tabular-nums">
                  {EGP(s.value)}
                </span>
              </li>
            ))}
            {unclassifiedTotal > 0 && (
              <li className="text-[10px] text-amber-700 bg-amber-50 border border-amber-200 rounded px-2 py-1 mt-2">
                + {EGP(unclassifiedTotal)} مبيعات بدون تصنيف منتج
              </li>
            )}
          </ul>
        </div>
      )}
    </Panel>
  );
}


function BigKpi({
  tone, icon, label, value, sub,
}: {
  tone: 'green' | 'blue' | 'orange' | 'purple' | 'rose' | 'slate';
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  const map: Record<string, { fg: string; tile: string }> = {
    green:  { fg: 'text-emerald-700', tile: 'bg-emerald-100' },
    blue:   { fg: 'text-blue-700',    tile: 'bg-blue-100' },
    orange: { fg: 'text-amber-700',   tile: 'bg-amber-100' },
    purple: { fg: 'text-violet-700',  tile: 'bg-violet-100' },
    rose:   { fg: 'text-rose-700',    tile: 'bg-rose-100' },
    slate:  { fg: 'text-slate-600',   tile: 'bg-slate-100' },
  };
  const t = map[tone];
  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-sm p-5 flex items-center justify-between gap-4 min-h-[140px]">
      <div className="min-w-0 flex-1">
        <div className="text-sm font-black text-slate-500">{label}</div>
        <div className={`text-[26px] font-black mt-2 tabular-nums leading-none ${t.fg}`}>
          {value}
        </div>
        {sub && (
          <div className="text-[12px] text-slate-400 mt-2 leading-snug">{sub}</div>
        )}
      </div>
      <div className={`shrink-0 w-14 h-14 rounded-2xl ${t.tile} ${t.fg} flex items-center justify-center`}>
        {icon}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * TargetPanel — sales target tracking (PR-T4.6, full spec)
 *
 * Renders 6 cells when the operator has enabled a target system on
 * the user's seller settings: التارجت / المحقق / نسبة التحقيق /
 * المتبقي / أوفر تارجت / العمولة التقديرية. Period-aware:
 *   periodMatch === 'exact'    — target window matches Overview filter
 *   periodMatch === 'mismatch' — different windows; figures shown as
 *                                configured, with a "تقديري" hint
 *   periodMatch === 'custom'   — user picked custom range; same hint
 * Honest empty state when no target system enabled.
 * ───────────────────────────────────────────────────────────────── */
type TargetPeriod = 'none' | 'daily' | 'weekly' | 'monthly';
type CommissionMode =
  | 'general'
  | 'after_target'
  | 'over_target'
  | 'general_plus_over_target';
const periodLabel: Record<TargetPeriod, string> = {
  none: 'بدون تارجت',
  daily: 'يومي',
  weekly: 'أسبوعي',
  monthly: 'شهري',
};
const modeLabel: Record<CommissionMode, string> = {
  general: 'نسبة عامة من كل المبيعات',
  after_target: 'نسبة بعد تحقيق التارجت',
  over_target: 'نسبة على الأوفر تارجت',
  general_plus_over_target: 'نسبة عامة + إضافية على الأوفر',
};

function TargetPanel({
  enabled,
  period,
  mode,
  periodMatch,
  target,
  achieved,
  achievementPct,
  remaining,
  overTarget,
  baseRate,
  afterTargetRate,
  overTargetRate,
  estimatedCommission,
}: {
  enabled: boolean;
  period: TargetPeriod;
  mode: CommissionMode;
  periodMatch: 'exact' | 'mismatch' | 'custom' | null;
  target: number;
  achieved: number;
  achievementPct: number | null;
  remaining: number;
  overTarget: number;
  baseRate: number;
  afterTargetRate: number | null;
  overTargetRate: number | null;
  estimatedCommission: number;
}) {
  if (!enabled) {
    return (
      <Panel
        title="تارجت المبيعات"
        subtitle="غير مفعّل — يمكن ضبطه من زر تعديل الملف"
      >
        <div className="px-5 pb-5 pt-2">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-center">
            <div className="text-sm font-black text-slate-600">
              بدون تارجت
            </div>
            <div className="text-xs text-slate-500 mt-2 leading-relaxed">
              من رأس صفحة الموظف → تعديل الملف → إعدادات البائع، يمكن
              تفعيل التارجت (يومي / أسبوعي / شهري) وتحديد نوع العمولة
              ونسبتها. عند التفعيل، ستظهر هنا نسبة التحقيق والمتبقي
              وأوفر التارجت والعمولة التقديرية.
            </div>
          </div>
        </div>
      </Panel>
    );
  }

  const onTrackTone =
    achievementPct === null
      ? 'slate'
      : achievementPct >= 100
        ? 'green'
        : achievementPct >= 70
          ? 'amber'
          : 'rose';
  const barWidth =
    achievementPct === null ? 0 : Math.min(achievementPct, 100);
  const targetReached = (achievementPct ?? 0) >= 100;
  const isApprox = periodMatch === 'mismatch' || periodMatch === 'custom';

  // Commission subtitle reflects the formula picked.
  const commissionFormulaText =
    baseRate <= 0
      ? 'يلزم تحديد نسبة عمولة'
      : mode === 'general'
        ? `${baseRate}% × المبيعات`
        : mode === 'after_target'
          ? `${(afterTargetRate ?? baseRate)}% × المبيعات (إذا تحقق التارجت)`
          : mode === 'over_target'
            ? `${(overTargetRate ?? 0)}% × (المبيعات − التارجت)`
            : `${baseRate}% × المبيعات + ${(overTargetRate ?? 0)}% × أوفر`;

  return (
    <Panel
      title={`تارجت المبيعات (${periodLabel[period]})`}
      subtitle={
        targetReached
          ? `تم تحقيق التارجت — أوفر ${EGP(overTarget)}`
          : `${(achievementPct ?? 0).toFixed(0)}% من التارجت · ${modeLabel[mode]}`
      }
    >
      <div className="p-5 space-y-4">
        {isApprox && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] font-bold text-amber-900">
            تنويه تقديري: التارجت مضبوط على نظام {periodLabel[period]}،
            لكن الفترة المختارة في النظرة العامة{' '}
            {periodMatch === 'custom' ? 'مخصصة' : 'مختلفة'}. النسبة
            والمتبقي يقارَنان بالتارجت كما هو، وقد لا يعكسان الإطار
            الزمني الفعلي للتارجت.
          </div>
        )}
        <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
          <TargetCell
            label={`التارجت (${periodLabel[period]})`}
            value={EGP(target)}
            tone="slate"
          />
          <TargetCell label="المحقق" value={EGP(achieved)} tone="blue" />
          <TargetCell
            label="نسبة التحقيق"
            value={
              achievementPct !== null ? `${achievementPct.toFixed(1)}%` : '—'
            }
            tone={onTrackTone}
            sub={
              targetReached
                ? 'تم تحقيق التارجت'
                : isApprox
                  ? 'تقديري'
                  : undefined
            }
          />
          <TargetCell
            label="المتبقي للتارجت"
            value={remaining > 0 ? EGP(remaining) : '—'}
            tone={remaining > 0 ? 'amber' : 'slate'}
            sub={remaining === 0 ? 'تم تحقيق التارجت' : undefined}
          />
          <TargetCell
            label="أوفر التارجت"
            value={overTarget > 0 ? EGP(overTarget) : '—'}
            tone={overTarget > 0 ? 'green' : 'slate'}
            sub={overTarget > 0 ? 'فوق التارجت' : undefined}
          />
          <TargetCell
            label="العمولة التقديرية"
            value={baseRate > 0 ? EGP(estimatedCommission) : '—'}
            tone="purple"
            sub={commissionFormulaText}
          />
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between text-[11px] font-bold text-slate-500">
            <span>تقدّم التحقيق</span>
            <span className="tabular-nums">{barWidth.toFixed(0)} / 100</span>
          </div>
          <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
            <div
              className={`h-full transition-all ${
                onTrackTone === 'green'
                  ? 'bg-emerald-500'
                  : onTrackTone === 'amber'
                    ? 'bg-amber-500'
                    : 'bg-rose-500'
              }`}
              style={{ width: `${barWidth}%` }}
            />
          </div>
        </div>
      </div>
    </Panel>
  );
}

function TargetCell({
  label,
  value,
  tone,
  sub,
}: {
  label: string;
  value: string;
  tone: 'green' | 'blue' | 'amber' | 'rose' | 'purple' | 'slate';
  sub?: string;
}) {
  const map: Record<string, { fg: string; tile: string }> = {
    green:  { fg: 'text-emerald-700', tile: 'bg-emerald-50 border-emerald-200' },
    blue:   { fg: 'text-blue-700',    tile: 'bg-blue-50 border-blue-200' },
    amber:  { fg: 'text-amber-700',   tile: 'bg-amber-50 border-amber-200' },
    rose:   { fg: 'text-rose-700',    tile: 'bg-rose-50 border-rose-200' },
    purple: { fg: 'text-violet-700',  tile: 'bg-violet-50 border-violet-200' },
    slate:  { fg: 'text-slate-700',   tile: 'bg-slate-50 border-slate-200' },
  };
  const t = map[tone];
  return (
    <div className={`rounded-xl border p-3 ${t.tile}`}>
      <div className="text-[11px] font-bold text-slate-500">{label}</div>
      <div className={`text-base font-black mt-1 tabular-nums ${t.fg}`}>
        {value}
      </div>
      {sub && (
        <div className="text-[10px] text-slate-500 mt-1 leading-snug">{sub}</div>
      )}
    </div>
  );
}

function PerformanceGaugePanel({ performance }: { performance: any }) {
  // Needle rotation: -90deg = empty (left), 0 = mid, 90deg = full.
  // Start from -90 + (score / 100) * 180.
  const angle = -90 + (performance.score / 100) * 180;
  const toneText: Record<string, string> = {
    green: 'text-emerald-700',
    amber: 'text-amber-700',
    rose:  'text-rose-700',
  };
  return (
    <Panel title="مستوى الأداء" subtitle="مؤشر تقديري — ليس ثابت محاسبيًا">
      <div className="px-5 pb-5 pt-2 flex flex-col items-center">
        <div className="relative w-[200px] h-[110px]">
          <div
            className="absolute inset-0 rounded-t-full"
            style={{
              background:
                'conic-gradient(from 270deg, #ef4444 0deg, #f59e0b 60deg, #22c55e 130deg, #e2e8f0 180deg, #e2e8f0 360deg)',
              clipPath: 'polygon(0 0, 100% 0, 100% 100%, 0 100%)',
            }}
          />
          <div className="absolute inset-x-6 bottom-[-2px] h-[78px] bg-white rounded-t-full" />
          <div
            className="absolute right-1/2 top-[100px] w-[80px] h-[5px] bg-slate-700 rounded-full origin-right transition-transform"
            style={{ transform: `rotate(${-angle}deg)` }}
          />
          <div className="absolute right-1/2 top-[97px] translate-x-1/2 w-3 h-3 bg-slate-700 rounded-full" />
        </div>
        <div className={`mt-2 text-2xl font-black ${toneText[performance.tone]}`}>
          {performance.label}
        </div>
        <div className="text-base font-black text-slate-700 mt-1 tabular-nums">
          {performance.score}/100
        </div>
        <div className="text-[11px] text-slate-400 mt-2 text-center leading-relaxed max-w-[260px]">
          {performance.formula}
        </div>
      </div>
    </Panel>
  );
}

function StarRatingPanel({ performance }: { performance: any }) {
  return (
    <Panel title="تقييم الأداء" subtitle="مؤشر تقديري · 5 نجوم = 100%">
      <div className="p-5 flex flex-col items-center">
        <div className="text-[42px] tracking-[6px] text-amber-500 select-none">
          {Array(5).fill(0).map((_, i) =>
            i < performance.stars ? '★' : '☆',
          ).join('')}
        </div>
        <div className="text-2xl font-black text-slate-800 mt-2 tabular-nums">
          {(performance.score / 20).toFixed(1)} من 5
        </div>
        <div className="text-[11px] text-slate-400 mt-3 leading-relaxed text-center">
          محسوب من نفس مكونات مستوى الأداء.
        </div>
      </div>
    </Panel>
  );
}

function DailySalesPanel({
  isSalesperson, dailySales,
}: {
  isSalesperson: boolean;
  dailySales: { date: string; amount: number }[];
}) {
  const max = Math.max(1, ...dailySales.map((d) => d.amount));
  return (
    <Panel
      title="المبيعات اليومية"
      subtitle={
        isSalesperson
          ? `${dailySales.length} يوم نشط`
          : 'الموظف غير مرتبط بمبيعات.'
      }
    >
      {!isSalesperson ? (
        <SalespersonEmptyState />
      ) : dailySales.length === 0 ? (
        <EmptyText>لا فواتير في هذا الشهر.</EmptyText>
      ) : (
        <div className="px-5 pb-5 pt-2">
          <div className="h-[180px] flex items-end gap-1 border-b border-slate-200">
            {dailySales.map((d) => {
              const h = (d.amount / max) * 100;
              return (
                <div
                  key={d.date}
                  className="flex-1 min-w-[8px] bg-violet-200 hover:bg-violet-400 rounded-t transition relative group"
                  style={{ height: `${h}%` }}
                  title={`${d.date}: ${EGP(d.amount)}`}
                >
                  <div className="absolute -top-7 left-1/2 -translate-x-1/2 opacity-0 group-hover:opacity-100 bg-slate-800 text-white text-[10px] px-2 py-1 rounded whitespace-nowrap pointer-events-none transition">
                    {EGP(d.amount)}
                  </div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center justify-between text-[10px] text-slate-400 mt-2 tabular-nums">
            <span>{fmtDate(dailySales[0].date)}</span>
            <span>{fmtDate(dailySales[dailySales.length - 1].date)}</span>
          </div>
        </div>
      )}
    </Panel>
  );
}

function CommissionPanel({
  isSalesperson, commissionRate, commissionAmount, eligibleSales,
}: {
  isSalesperson: boolean;
  commissionRate: number;
  commissionAmount: number;
  eligibleSales: number;
}) {
  const hasRate = commissionRate > 0;
  return (
    <Panel
      title="نسبة الموظف من المبيعات"
      subtitle={
        !isSalesperson
          ? 'الموظف غير مرتبط بمبيعات.'
          : hasRate
            ? `بمعدل ${commissionRate}%`
            : 'لا توجد نسبة عمولة محددة'
      }
    >
      {!isSalesperson ? (
        <SalespersonEmptyState />
      ) : !hasRate ? (
        <div className="px-5 pb-5 pt-2">
          <div className="rounded-2xl border border-amber-200 bg-amber-50 p-4 text-center">
            <div className="text-base font-black text-amber-900">
              لا توجد نسبة عمولة محددة لهذا الموظف
            </div>
            <div className="text-xs text-amber-900/70 mt-2 leading-relaxed">
              الموظف لديه فواتير مبيعات بقيمة{' '}
              <span className="font-bold">{EGP(eligibleSales)}</span> ولكن
              معدل العمولة (commission_rate) = 0%. يمكن تحديد نسبة من شاشة
              العمولات (PATCH /commissions/:id/rate) ثم سيظهر مبلغ العمولة
              تلقائيًا هنا.
            </div>
          </div>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-xl border border-slate-200 p-3 text-center">
              <div className="text-[11px] text-slate-500">إجمالي مبيعات الفترة</div>
              <div className="text-lg font-black text-slate-700 mt-1 tabular-nums">
                {EGP(eligibleSales)}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 p-3 text-center">
              <div className="text-[11px] text-slate-500">عمولة محسوبة</div>
              <div className="text-lg font-black text-slate-400 mt-1">—</div>
            </div>
          </div>
        </div>
      ) : (
        <div className="px-5 pb-5 pt-2">
          <div className="text-center text-5xl font-black text-emerald-700 tabular-nums">
            {commissionRate}%
          </div>
          <div className="text-center text-xs text-slate-500 mt-1">
            نسبة العمولة من القيمة المؤهلة
          </div>
          <div className="rounded-2xl bg-gradient-to-b from-white to-emerald-50 border border-emerald-100 p-5 mt-4 text-center">
            <div className="text-xs text-slate-500">إجمالي العمولة المستحقة</div>
            <div className="text-3xl font-black text-emerald-700 mt-2 tabular-nums">
              {EGP(commissionAmount)}
            </div>
            <div className="text-[11px] text-slate-500 mt-3">
              من إجمالي مؤهل {EGP(eligibleSales)}
            </div>
          </div>
          <div className="mt-4 text-[11px] text-slate-400 leading-relaxed text-center">
            * تتبع مدفوعات العمولة سيُضاف عند توفر API لربط الدفعات
            بالعمولة المستحقة.
          </div>
        </div>
      )}
    </Panel>
  );
}

function TopInvoicesPanel({
  isSalesperson, rows,
}: {
  isSalesperson: boolean;
  rows: CommissionDetailRow[];
}) {
  return (
    <Panel
      title="أعلى فواتير المبيعات"
      subtitle={isSalesperson ? `أعلى ${rows.length} فواتير قيمة` : ''}
    >
      {!isSalesperson ? (
        <SalespersonEmptyState />
      ) : rows.length === 0 ? (
        <EmptyText>لا فواتير في هذا الشهر.</EmptyText>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <Th>#</Th>
                <Th>رقم الفاتورة</Th>
                <Th>التاريخ</Th>
                <Th>العميل</Th>
                <Th>المبلغ</Th>
                <Th>عمولة</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((inv, i) => (
                <tr key={inv.invoice_id} className="border-t border-slate-100">
                  <Td className="font-mono">{i + 1}</Td>
                  <Td className="font-mono text-[11px]">{inv.invoice_no}</Td>
                  <Td className="font-mono tabular-nums">{fmtDate(inv.completed_at)}</Td>
                  <Td>{inv.customer_name || '—'}</Td>
                  <Td className="font-mono tabular-nums font-bold">
                    {EGP(inv.eligible_total)}
                  </Td>
                  <Td className="font-mono tabular-nums text-emerald-700">
                    {EGP(inv.commission)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}

function PeriodComparisonPanel(props: {
  monthDays: number;
  monthMinutes: number;
  accrualInMonth: number;
  paidInMonth: number;
  isSalesperson: boolean;
  eligibleSales: number;
  prevEligibleSales: number;
  invoicesCount: number;
  prevInvoicesCount: number;
  avgInvoice: number;
  prevAvgInvoice: number;
  commissionAmount: number;
  prevCommissionAmount: number;
}) {
  return (
    <Panel
      title="ملخص مقارن"
      subtitle="الشهر الحالي مقابل السابق"
    >
      <div className="overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50">
            <tr>
              <Th>المؤشر</Th>
              <Th>الحالي</Th>
              <Th>السابق</Th>
              <Th>التغير</Th>
            </tr>
          </thead>
          <tbody>
            <CmpRow label="أيام العمل" current={props.monthDays} previous={null} fmt={(n) => String(n)} />
            <CmpRow label="ساعات العمل" current={props.monthMinutes} previous={null} fmt={fmtHours} />
            <CmpRow label="مستحقات معتمدة" current={props.accrualInMonth} previous={null} fmt={EGP} />
            <CmpRow label="مصروف فعليًا" current={props.paidInMonth} previous={null} fmt={EGP} />
            {props.isSalesperson && (
              <>
                <CmpRow label="إجمالي المبيعات" current={props.eligibleSales} previous={props.prevEligibleSales || null} fmt={EGP} />
                <CmpRow label="عدد الفواتير" current={props.invoicesCount} previous={props.prevInvoicesCount || null} fmt={(n) => String(n)} />
                <CmpRow label="متوسط الفاتورة" current={props.avgInvoice} previous={props.prevAvgInvoice || null} fmt={EGP} />
                <CmpRow label="مبلغ العمولة" current={props.commissionAmount} previous={props.prevCommissionAmount || null} fmt={EGP} />
              </>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function CmpRow({
  label, current, previous, fmt,
}: {
  label: string;
  current: number;
  previous: number | null;
  fmt: (n: number) => string;
}) {
  const hasPrev = previous != null && Number.isFinite(previous);
  const delta = hasPrev ? current - (previous as number) : null;
  const pct =
    hasPrev && previous && (previous as number) > 0
      ? Math.round(((current - (previous as number)) / (previous as number)) * 100)
      : null;
  return (
    <tr className="border-t border-slate-100">
      <Td>{label}</Td>
      <Td className="font-mono tabular-nums">{fmt(current)}</Td>
      <Td className="font-mono tabular-nums text-slate-500">
        {hasPrev ? fmt(previous as number) : 'غير متاح'}
      </Td>
      <Td
        className={`font-mono font-bold ${
          delta == null
            ? 'text-slate-400'
            : delta > 0
              ? 'text-emerald-700'
              : delta < 0
                ? 'text-rose-700'
                : 'text-slate-500'
        }`}
      >
        {delta == null
          ? '—'
          : pct != null
            ? `${pct > 0 ? '↑' : pct < 0 ? '↓' : '·'} ${Math.abs(pct)}%`
            : `${delta > 0 ? '↑' : '↓'} ${fmt(Math.abs(delta))}`}
      </Td>
    </tr>
  );
}

function SalespersonEmptyState() {
  return (
    <div className="px-5 py-8 text-center">
      <div className="w-14 h-14 mx-auto rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mb-3">
        <Award size={26} />
      </div>
      <div className="text-sm font-bold text-slate-700">
        الموظف غير مرتبط بمبيعات
      </div>
      <div className="text-xs text-slate-500 mt-1 leading-relaxed max-w-sm mx-auto">
        هذه الأقسام تظهر فقط للموظفين المرتبطين بفواتير مبيعات (مرتبطين عبر
        <code className="px-1 mx-1 bg-slate-100 rounded">invoice_items.salesperson_id</code>
        أو لديهم نسبة عمولة مفعّلة).
      </div>
    </div>
  );
}

function FooterMeta({ from, to }: { from: string; to: string }) {
  return (
    <div className="text-[11px] text-slate-400 flex items-center justify-between">
      <span>المبيعات والعمولة من /commissions/{`{summary,detail}`}</span>
      <span>الفترة {fmtDate(from)} — {fmtDate(to)} · جميع المبالغ بالجنيه المصري</span>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Helpers + small primitives
 * ───────────────────────────────────────────────────────────────── */

function changeLabel(delta: number, isMoney: boolean): string {
  const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '·';
  return `${arrow} ${
    isMoney ? EGP(Math.abs(delta)) : Math.abs(delta).toLocaleString('en-US')
  } عن الفترة السابقة`;
}

function Panel({
  title, subtitle, children,
}: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-3xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <h3 className="text-base font-black text-slate-800">{title}</h3>
        {subtitle && <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function SmallPanel({
  title, subtitle, children,
}: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <h4 className="text-sm font-black text-slate-800">{title}</h4>
        {subtitle && <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-right px-3 py-2.5 text-[11px] font-bold text-slate-500 bg-slate-50 whitespace-nowrap">
      {children}
    </th>
  );
}

function Td({
  children, className = '',
}: { children: React.ReactNode; className?: string }) {
  return (
    <td className={`px-3 py-2.5 text-xs text-slate-700 ${className}`}>
      {children}
    </td>
  );
}

function EmptyText({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-center text-xs text-slate-400 py-8 px-4">
      {children}
    </div>
  );
}

const _used = [Star]; void _used;
