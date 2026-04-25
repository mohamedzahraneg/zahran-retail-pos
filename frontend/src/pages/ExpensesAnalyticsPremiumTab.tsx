/**
 * Premium Expense Analytics tab — visual target was the XHTML mockup
 * (PR-7) but with light/dark theme awareness layered on (PR-8). All
 * numbers come from real system data via the shared
 * `ExpenseTabContext` plus two tab-local queries (prev-period items +
 * prev-period P&L); no fake sample data.
 *
 * Theme strategy
 * --------------
 *   · Page background is provided by AppLayout (`bg-slate-50
 *     dark:bg-slate-950`). This component does NOT add an outer
 *     gradient panel any more — it lets each card stand on the page
 *     so the dashboard "fills" the area instead of looking like a
 *     dark island in a light page.
 *   · Every card / text / border ships with a light default + a
 *     `dark:` variant. Tailwind's `dark:` class strategy is wired in
 *     `tailwind.config.js` (`darkMode: 'class'`) and the existing
 *     `useTheme()` hook toggles `<html class="dark">`.
 *   · Charts read live theme via `useChartTheme()` so axis ticks and
 *     grid lines stay readable in both modes.
 *
 * Data sources (every tile cites one):
 *   · ctx.items                       — current filtered expenses
 *   · ctx.totalAmount                 — register total (sanity guard)
 *   · ctx.pnl                         — period P&L (revenue, COGS,
 *                                       op-ex, net profit, margins)
 *   · prevItems (this file)           — same filters, prior window
 *   · prevPnl  (this file)            — period-only P&L for the
 *                                       prior window */

import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  Activity,
  BarChart3,
  Clock,
  Download,
  FileText,
  Hash,
  Moon,
  Percent,
  PieChart as PieIcon,
  RefreshCw,
  Sparkles,
  Sun,
  TrendingUp,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { Doughnut, Line } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
} from 'chart.js';

import { accountingApi, Expense } from '@/api/accounting.api';
import type { ExpenseTabContext } from './DailyExpenses';
import { useTheme } from '@/hooks/useTheme';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

/* ─── Local formatters (kept inline — duplication < cycle risk) ─── */

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const fmtPct = (n: number | null | undefined, digits = 1) =>
  Number.isFinite(Number(n)) ? `${Number(n).toFixed(digits)}%` : '—';

const _ymdParts = (d: Date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  return {
    y: parts.find((p) => p.type === 'year')!.value,
    m: parts.find((p) => p.type === 'month')!.value,
    d: parts.find((p) => p.type === 'day')!.value,
  };
};

function toCairoYMD(input: string | Date | null | undefined): string {
  if (!input) return '';
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return input;
  }
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  const { y, m, d: dd } = _ymdParts(d);
  return `${y}-${m}-${dd}`;
}

const fmtDateDMY = (input: string | Date | null | undefined) => {
  const ymd = toCairoYMD(input);
  if (!ymd) return '—';
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
};

const fmtTimeHM = (iso: string | Date | null | undefined) => {
  if (!iso) return '—';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-GB', {
    timeZone: 'Africa/Cairo',
    hour: '2-digit',
    minute: '2-digit',
  });
};

function shiftYMD(ymd: string, deltaDays: number): string {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function diffDaysInclusive(from: string, to: string): number {
  const a = new Date(from + 'T00:00:00Z').getTime();
  const b = new Date(to + 'T00:00:00Z').getTime();
  return Math.max(1, Math.round((b - a) / 86400_000) + 1);
}

function deltaPct(current: number, prior: number): number | null {
  if (!Number.isFinite(prior) || prior === 0) return null;
  return ((current - prior) / Math.abs(prior)) * 100;
}

/** Live colors for chart.js axes/grid that flip with the theme. */
function useChartTheme() {
  const [theme] = useTheme();
  if (theme === 'dark') {
    return {
      tick: '#94a3b8',
      grid: 'rgba(148, 163, 184, 0.10)',
      legend: '#cbd5e1',
      donutBorder: '#0b1624',
    };
  }
  return {
    tick: '#475569',
    grid: 'rgba(100, 116, 139, 0.16)',
    legend: '#334155',
    donutBorder: '#ffffff',
  };
}

/* ─── Theme-aware utility class fragments ───────────────────────────
 *
 * Centralising these so a single tweak ripples across every card. */
const CARD =
  'rounded-2xl border border-slate-200 bg-white shadow-sm ' +
  'dark:border-slate-700/40 dark:bg-slate-900/70 dark:shadow-xl dark:shadow-black/20';
const CARD_PAD = `${CARD} p-4`;
const TEXT_MUTED = 'text-slate-500 dark:text-slate-400';
const TEXT_STRONG = 'text-slate-900 dark:text-white';
const DIVIDER = 'divide-slate-200 dark:divide-slate-700/40';
const CHIP_MUTED =
  'rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 ' +
  'dark:border-slate-700/40 dark:bg-slate-950/40';

/* ─── Sub-components ────────────────────────────────────────────────── */

function LiveClock({ lastUpdated }: { lastUpdated: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const i = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(i);
  }, []);
  const sec = Math.max(0, Math.floor((now - lastUpdated) / 1000));
  const label =
    sec < 5 ? 'الآن' : sec < 60 ? `${sec} ثانية` : `${Math.floor(sec / 60)} دقيقة`;
  return (
    <span className={`${TEXT_MUTED} text-[12px]`}>
      آخر تحديث:{' '}
      <span className={`${TEXT_STRONG} tabular-nums`}>منذ {label}</span>
    </span>
  );
}

function ThemeToggle() {
  const [theme, setTheme] = useTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      title={next === 'dark' ? 'تفعيل الوضع الداكن' : 'تفعيل الوضع الفاتح'}
      className="px-2.5 py-2 rounded-xl border border-slate-300 bg-white text-slate-600 hover:bg-slate-100 dark:border-slate-600/50 dark:bg-slate-800/60 dark:text-slate-200 dark:hover:bg-slate-700/60 flex items-center gap-1.5"
    >
      {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
    </button>
  );
}

function KpiCard({
  title,
  value,
  hint,
  icon,
  tone,
}: {
  title: string;
  value: string;
  hint?: React.ReactNode;
  icon: React.ReactNode;
  tone: 'red' | 'green' | 'amber' | 'blue' | 'purple' | 'cyan';
}) {
  const accentBorder = {
    red: 'border-rose-200 dark:border-rose-500/30',
    green: 'border-emerald-200 dark:border-emerald-500/25',
    amber: 'border-amber-200 dark:border-amber-500/30',
    blue: 'border-sky-200 dark:border-sky-500/25',
    purple: 'border-violet-200 dark:border-violet-500/25',
    cyan: 'border-cyan-200 dark:border-cyan-500/25',
  }[tone];
  const iconTone = {
    red: 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300',
    green: 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300',
    amber: 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300',
    blue: 'bg-sky-50 text-sky-600 dark:bg-sky-500/15 dark:text-sky-300',
    purple: 'bg-violet-50 text-violet-600 dark:bg-violet-500/15 dark:text-violet-300',
    cyan: 'bg-cyan-50 text-cyan-600 dark:bg-cyan-500/15 dark:text-cyan-300',
  }[tone];
  return (
    <div
      className={`rounded-2xl border ${accentBorder} bg-white dark:bg-slate-900/70 shadow-sm dark:shadow-xl dark:shadow-black/20 p-4 min-h-[126px] flex flex-col`}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-[12px] font-extrabold text-slate-600 dark:text-slate-300">
          {title}
        </span>
        <span className={`p-2 rounded-xl ${iconTone}`}>{icon}</span>
      </div>
      <div className={`mt-4 text-[22px] font-black ${TEXT_STRONG} tabular-nums leading-tight`}>
        {value}
      </div>
      {hint !== undefined && (
        <div className="mt-auto pt-3 text-[11px] text-slate-500 dark:text-slate-400">
          {hint}
        </div>
      )}
    </div>
  );
}

function DeltaHint({
  pct,
  suffix = 'عن الفترة السابقة',
}: {
  pct: number | null;
  suffix?: string;
}) {
  if (pct === null) return <span className="text-slate-400 dark:text-slate-500">— {suffix}</span>;
  const up = pct >= 0;
  return (
    <span className={up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
      {up ? '↑' : '↓'} {Math.abs(pct).toFixed(1)}% {suffix}
    </span>
  );
}

/** Same as DeltaHint but inverts color polarity — used for metrics
 *  where a rise is bad (expenses, expense ratio). */
function DeltaHintInverted({
  pct,
  suffix = 'عن الفترة السابقة',
}: {
  pct: number | null;
  suffix?: string;
}) {
  if (pct === null) return <span className="text-slate-400 dark:text-slate-500">— {suffix}</span>;
  const up = pct >= 0;
  return (
    <span className={up ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}>
      {up ? '↑' : '↓'} {Math.abs(pct).toFixed(1)}% {suffix}
    </span>
  );
}

function BreakdownDonut({
  title,
  icon,
  rows,
  total,
}: {
  title: string;
  icon: React.ReactNode;
  rows: Array<{ label: string; total: number }>;
  total: number;
}) {
  const ct = useChartTheme();
  const TOP = 4;
  const top = rows.slice(0, TOP);
  const restTotal = rows.slice(TOP).reduce((s, r) => s + r.total, 0);
  const labels = [
    ...top.map((r) => r.label),
    ...(restTotal > 0 ? [`أخرى (${rows.length - TOP})`] : []),
  ];
  const data = [...top.map((r) => r.total), ...(restTotal > 0 ? [restTotal] : [])];
  const palette = ['#3b82f6', '#22c55e', '#f59e0b', '#ef4444', '#8b5cf6'];

  return (
    <div className={CARD_PAD}>
      <h3 className={`text-[15px] font-black ${TEXT_STRONG} mb-3 flex items-center gap-2`}>
        {icon} {title}
      </h3>
      {rows.length === 0 ? (
        <div className={`text-center ${TEXT_MUTED} text-xs py-8`}>لا توجد بيانات.</div>
      ) : (
        <div className="grid grid-cols-[128px_1fr] gap-3 items-center">
          <div className="relative w-[128px] h-[128px] mx-auto">
            <Doughnut
              data={{
                labels,
                datasets: [
                  {
                    data,
                    backgroundColor: labels.map((_, i) => palette[i % palette.length]),
                    borderWidth: 2,
                    borderColor: ct.donutBorder,
                  },
                ],
              }}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                cutout: '62%',
                plugins: {
                  legend: { display: false },
                  tooltip: {
                    callbacks: {
                      label: (c) => {
                        const v = Number(c.parsed) || 0;
                        const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0.0';
                        return `${c.label}: ${EGP(v)} (${pct}%)`;
                      },
                    },
                  },
                },
              }}
            />
            <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
              <div className="text-[11px] text-slate-500 dark:text-slate-400">المجموع</div>
              <div className={`text-[12px] font-black ${TEXT_STRONG} tabular-nums`}>
                {Number(total).toLocaleString('en-US', { maximumFractionDigits: 0 })}
              </div>
            </div>
          </div>
          <div className="space-y-1.5 max-h-[160px] overflow-y-auto pr-1">
            {rows.slice(0, 8).map((r, i) => {
              const pct = total > 0 ? (r.total / total) * 100 : 0;
              return (
                <div
                  key={r.label + i}
                  className="flex items-center justify-between text-[11px] gap-2"
                >
                  <span className="flex items-center gap-1.5 truncate min-w-0">
                    <span
                      className="w-2 h-2 rounded-full shrink-0"
                      style={{ background: palette[i % palette.length] }}
                    />
                    <span className="truncate text-slate-700 dark:text-slate-300">
                      {r.label}
                    </span>
                  </span>
                  <span className={`${TEXT_STRONG} font-bold tabular-nums shrink-0`}>
                    {pct.toFixed(1)}%
                  </span>
                </div>
              );
            })}
            {rows.length > 8 && (
              <div className="text-[10px] text-slate-400 dark:text-slate-500 text-center pt-1">
                +{rows.length - 8} عناصر أخرى
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ─── Main component ────────────────────────────────────────────────── */

export default function ExpensesAnalyticsPremiumTab({
  ctx,
}: {
  ctx: ExpenseTabContext;
}) {
  const {
    filters: { preset, from, to, employeeId, categoryId, cashboxId, shiftId, status },
    setFilter,
    setRangePreset,
    resetFilters,
    filtersDirty,
    items,
    totalAmount,
    isFetching,
    refresh,
    categories,
    cashboxes,
    users,
    shifts,
    pnl,
    isPnlFetching,
    exportExcel,
    exportPdf,
  } = ctx;

  const ct = useChartTheme();

  /* ── Prior-period range ── */
  const periodLen = diffDaysInclusive(from, to);
  const prevTo = shiftYMD(from, -1);
  const prevFrom = shiftYMD(prevTo, -(periodLen - 1));
  const prevLabel =
    preset === 'day'
      ? 'عن أمس'
      : preset === 'week'
        ? 'عن الأسبوع السابق'
        : preset === 'month'
          ? 'عن الشهر السابق'
          : preset === 'year'
            ? 'عن السنة السابقة'
            : 'عن الفترة السابقة';

  /* ── Prev-period items (same filters, shifted window) ── */
  const prevListingParams = {
    from: prevFrom,
    to: prevTo,
    employee_user_id: employeeId || undefined,
    category_id: categoryId || undefined,
    cashbox_id: cashboxId || undefined,
    shift_id: shiftId || undefined,
    status: status === 'all' ? undefined : status,
    limit: 500,
  };
  const { data: prevListing } = useQuery({
    queryKey: ['daily-expenses-prev-list', prevListingParams],
    queryFn: () => accountingApi.listExpenses(prevListingParams),
    staleTime: 60_000,
  });
  const prevItems: Expense[] = prevListing?.items ?? [];
  const prevTotal = Number(prevListing?.total_amount ?? 0);

  /* ── Prev-period P&L ── */
  const { data: prevPnl } = useQuery({
    queryKey: ['daily-expenses-prev-pnl', prevFrom, prevTo],
    queryFn: () => accountingApi.profitAndLoss({ from: prevFrom, to: prevTo }),
    staleTime: 60_000,
  });

  /* ── Live "آخر تحديث" timestamp ── */
  const [lastUpdated, setLastUpdated] = useState(() => Date.now());
  useEffect(() => {
    setLastUpdated(Date.now());
  }, [items]);

  /* ── Derive every analytic from real data ── */
  const stats = useMemo(() => {
    const count = items.length;
    const total = items.reduce((s, e) => s + Number(e.amount || 0), 0);
    const avg = count > 0 ? total / count : 0;

    const groupBy = (key: (e: Expense) => string) => {
      const m = new Map<string, { label: string; total: number; count: number }>();
      items.forEach((e) => {
        const k = key(e);
        const cur = m.get(k) || { label: k, total: 0, count: 0 };
        cur.total += Number(e.amount || 0);
        cur.count += 1;
        m.set(k, cur);
      });
      return Array.from(m.values()).sort((a, b) => b.total - a.total);
    };

    const byCategory = groupBy((e) => e.category_name || '— غير محدد —');
    const byEmployee = groupBy(
      (e) => e.employee_name || e.employee_username || '— غير محدد —',
    );
    const byCashbox = groupBy((e) => e.cashbox_name || '— بدون خزنة —');
    const byShift = groupBy((e) => e.shift_no || '— بدون وردية —');

    const dailyMap = new Map<string, number>();
    items.forEach((e) => {
      const d = toCairoYMD(e.expense_date);
      if (!d) return;
      dailyMap.set(d, (dailyMap.get(d) || 0) + Number(e.amount || 0));
    });
    const dailyTrend = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, t]) => ({ date, label: fmtDateDMY(date), total: t }));

    const prevDailyMap = new Map<string, number>();
    prevItems.forEach((e) => {
      const d = toCairoYMD(e.expense_date);
      if (!d) return;
      prevDailyMap.set(d, (prevDailyMap.get(d) || 0) + Number(e.amount || 0));
    });
    const prevDailyTrend = Array.from(prevDailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([_, t]) => ({ total: t }));

    const dailyHigh = dailyTrend.length
      ? Math.max(...dailyTrend.map((d) => d.total))
      : 0;
    const dailyLow = dailyTrend.length
      ? Math.min(...dailyTrend.map((d) => d.total))
      : 0;
    const dailyAvg = dailyTrend.length ? total / dailyTrend.length : 0;

    const sortedByAmount = items
      .slice()
      .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0));
    const topN = sortedByAmount.slice(0, 10);

    const sortedAmounts = items
      .map((e) => Number(e.amount || 0))
      .sort((a, b) => a - b);
    const p80Index = Math.floor(sortedAmounts.length * 0.8);
    const p80 = sortedAmounts[p80Index] ?? 0;
    const categoryCount = new Map<string, number>();
    items.forEach((e) => {
      const k = e.category_name || '—';
      categoryCount.set(k, (categoryCount.get(k) || 0) + 1);
    });
    const impactFor = (e: Expense): 'high' | 'repeat' | 'normal' => {
      if (Number(e.amount || 0) >= p80 && p80 > 0) return 'high';
      if ((categoryCount.get(e.category_name || '—') || 0) >= 3) return 'repeat';
      return 'normal';
    };

    const topCategories = byCategory.slice(0, 5);

    /* ── Smart alerts (all derived) ── */
    const alerts: Array<{ msg: string; severity: 'info' | 'warn' | 'crit' }> = [];

    if (byCategory.length > 0 && prevItems.length > 0) {
      const prevByCat = new Map<string, number>();
      prevItems.forEach((e) => {
        const k = e.category_name || '— غير محدد —';
        prevByCat.set(k, (prevByCat.get(k) || 0) + Number(e.amount || 0));
      });
      let worst: { name: string; pct: number } | null = null;
      byCategory.forEach((row) => {
        const prev = prevByCat.get(row.label) || 0;
        if (prev === 0) return;
        const pct = ((row.total - prev) / prev) * 100;
        if (pct >= 25 && (!worst || pct > worst.pct)) {
          worst = { name: row.label, pct };
        }
      });
      if (worst) {
        const w = worst as { name: string; pct: number };
        alerts.push({
          msg: `بند "${w.name}" زاد ${w.pct.toFixed(0)}% ${prevLabel}`,
          severity: w.pct >= 50 ? 'crit' : 'warn',
        });
      }
    }

    const noShift = items.filter((e) => !e.shift_no).length;
    if (noShift > 0) {
      alerts.push({
        msg: `مصروفات بدون وردية: ${noShift} حركة`,
        severity: 'warn',
      });
    }

    const pending = items.filter((e) => !e.is_approved && !e.je_is_void).length;
    if (pending > 0) {
      alerts.push({
        msg: `مصروفات بانتظار الموافقة: ${pending} حركة`,
        severity: 'info',
      });
    }

    const voided = items.filter((e) => e.je_is_void).length;
    if (voided > 0) {
      alerts.push({
        msg: `مصروفات ملغاة (قيود معكوسة): ${voided} حركة`,
        severity: 'info',
      });
    }

    const topShiftRow =
      byShift.length > 0 && byShift[0].label !== '— بدون وردية —'
        ? byShift[0]
        : byShift.length > 1
          ? byShift[1]
          : null;
    if (topShiftRow && total > 0 && topShiftRow.total / total > 0.4) {
      alerts.push({
        msg: `وردية ${topShiftRow.label} سجلت ${EGP(topShiftRow.total)} (${((topShiftRow.total / total) * 100).toFixed(0)}% من مصروفات الفترة)`,
        severity: 'crit',
      });
    }

    const critCount = alerts.filter((a) => a.severity === 'crit').length;
    const warnCount = alerts.filter((a) => a.severity === 'warn').length;
    const health =
      critCount > 0
        ? { word: 'حرج', tone: 'red' as const }
        : warnCount > 0
          ? { word: 'تحتاج متابعة', tone: 'amber' as const }
          : alerts.length > 0
            ? { word: 'تحت المراقبة', tone: 'amber' as const }
            : { word: 'صحي', tone: 'green' as const };

    return {
      count, total, avg,
      byCategory, byEmployee, byCashbox, byShift,
      dailyTrend, prevDailyTrend,
      dailyHigh, dailyLow, dailyAvg,
      topN, topCategories,
      alerts, health, impactFor,
    };
  }, [items, prevItems, prevLabel]);

  /* ── KPI deltas ── */
  const periodRevenue = Number(pnl?.net_revenue || 0);
  const periodNetProfit = Number(pnl?.net_profit || 0);
  const periodOpEx = Number(pnl?.operating_expenses || 0);
  const periodCogs = Number(pnl?.cogs || 0);
  const periodGrossProfit = Number(pnl?.gross_profit || 0);
  const periodGrossMargin = Number(pnl?.gross_margin_pct || 0);
  const periodNetMargin = Number(pnl?.net_margin_pct || 0);

  const prevRevenue = Number(prevPnl?.net_revenue || 0);
  const prevNetProfit = Number(prevPnl?.net_profit || 0);
  const prevOpEx = Number(prevPnl?.operating_expenses || 0);
  const prevNetMargin = Number(prevPnl?.net_margin_pct || 0);

  const expensesAsPctOfRevenue =
    periodRevenue > 0 ? (stats.total / periodRevenue) * 100 : null;
  const prevExpensesAsPctOfRevenue =
    prevRevenue > 0 ? (prevTotal / prevRevenue) * 100 : null;

  const dExpenses = deltaPct(stats.total, prevTotal);
  const dCount = deltaPct(stats.count, prevItems.length);
  const dRevenue = deltaPct(periodRevenue, prevRevenue);
  const dNetProfit = deltaPct(periodNetProfit, prevNetProfit);
  const dOpEx = deltaPct(periodOpEx, prevOpEx);
  const dExpensePctOfRev =
    expensesAsPctOfRevenue !== null && prevExpensesAsPctOfRevenue !== null
      ? expensesAsPctOfRevenue - prevExpensesAsPctOfRevenue
      : null;
  const dNetMargin = periodNetMargin - prevNetMargin;

  /* ── Sanity guard ── */
  const totalDrift = Math.abs(stats.total - Number(totalAmount));

  const impactNote =
    expensesAsPctOfRevenue !== null
      ? `كل 100 ج.م إيراد يقابلها ${expensesAsPctOfRevenue.toFixed(1)} ج.م مصروفات`
      : 'لا توجد إيرادات في الفترة لاحتساب نسبة المصروفات';

  /* ─── Render ─── */
  return (
    <div className="space-y-3" dir="rtl">
      {/* PR-9: header has no border-b separator any more (the tab bar
       * already provides one above) and uses tighter pb so the dashboard
       * starts higher up the viewport. */}
      <div className="flex items-center justify-between gap-3 flex-wrap pb-1">
        <div className="flex items-center gap-3">
          <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-blue-600 to-violet-600 flex items-center justify-center text-white shadow-lg shadow-blue-900/20">
            <Sparkles size={22} />
          </div>
          <div>
            <h2 className={`text-[20px] font-black ${TEXT_STRONG} leading-tight`}>
              تحليلات المصروفات
            </h2>
            <p className={`${TEXT_MUTED} text-[12px] mt-0.5`}>
              رؤية ذكية ومباشرة لتأثير المصروفات على الإيرادات والأرباح
            </p>
          </div>
        </div>

        <div className="flex items-center flex-wrap gap-2 text-[12px]">
          <span className="text-emerald-600 dark:text-emerald-400 font-extrabold flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            مباشر
          </span>
          <LiveClock lastUpdated={lastUpdated} />
          <ThemeToggle />
          <button
            type="button"
            onClick={refresh}
            disabled={isFetching || isPnlFetching}
            className="px-3 py-2 rounded-xl border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 dark:border-blue-500/40 dark:bg-blue-600/20 dark:text-sky-200 dark:hover:bg-blue-600/30 disabled:opacity-50 font-bold text-[12px] flex items-center gap-1.5"
          >
            <RefreshCw
              size={13}
              className={isFetching || isPnlFetching ? 'animate-spin' : ''}
            />
            تحديث
          </button>
          <button
            type="button"
            onClick={exportPdf}
            className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-600/50 dark:bg-slate-800/60 dark:text-slate-200 dark:hover:bg-slate-700/60 font-bold text-[12px] flex items-center gap-1.5"
          >
            <FileText size={13} /> PDF
          </button>
          <button
            type="button"
            onClick={exportExcel}
            className="px-3 py-2 rounded-xl border border-slate-300 bg-white text-slate-700 hover:bg-slate-100 dark:border-slate-600/50 dark:bg-slate-800/60 dark:text-slate-200 dark:hover:bg-slate-700/60 font-bold text-[12px] flex items-center gap-1.5"
          >
            <Download size={13} /> Excel
          </button>
        </div>
      </div>

      {/* ─── Filter card ─── */}
      <div className={CARD_PAD}>
        <div className="grid lg:grid-cols-[auto_1fr] gap-4 items-end">
          <div className="flex flex-wrap gap-2">
            {(['day', 'week', 'month', 'year', 'custom'] as const).map((p) => {
              const label = {
                day: 'اليوم', week: 'الأسبوع', month: 'الشهر', year: 'السنة', custom: 'مخصص',
              }[p];
              const active = preset === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setRangePreset(p)}
                  className={`min-w-[70px] px-3 py-2 rounded-xl text-[12px] font-extrabold transition border ${
                    active
                      ? 'bg-gradient-to-br from-blue-600 to-blue-700 text-white border-blue-500 shadow-md shadow-blue-900/20'
                      : 'bg-slate-50 text-slate-700 border-slate-200 hover:bg-slate-100 dark:bg-slate-950/40 dark:text-slate-300 dark:border-slate-700/40 dark:hover:bg-slate-800/60'
                  }`}
                >
                  {label}
                </button>
              );
            })}
            <button
              type="button"
              onClick={resetFilters}
              disabled={!filtersDirty}
              title="استعادة الفلاتر الافتراضية"
              className={`px-3 py-2 rounded-xl text-[12px] font-extrabold border transition flex items-center gap-1 ${
                filtersDirty
                  ? 'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30 dark:hover:bg-rose-500/25'
                  : 'bg-slate-50 text-slate-400 border-slate-200 dark:bg-slate-900/40 dark:text-slate-600 dark:border-slate-700/30 cursor-not-allowed'
              }`}
            >
              <X size={11} /> مسح
            </button>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-7 gap-2">
            <ThemedField label="من">
              <input
                type="date"
                disabled={preset !== 'custom'}
                className={INPUT_CLS}
                value={from}
                onChange={(e) => setFilter({ from: e.target.value })}
              />
            </ThemedField>
            <ThemedField label="إلى">
              <input
                type="date"
                disabled={preset !== 'custom'}
                className={INPUT_CLS}
                value={to}
                onChange={(e) => setFilter({ to: e.target.value })}
              />
            </ThemedField>
            <ThemedField label="الخزنة">
              <select
                className={INPUT_CLS}
                value={cashboxId}
                onChange={(e) => setFilter({ cashboxId: e.target.value })}
              >
                <option value="">كل الخزن</option>
                {cashboxes.map((c) => <option key={c.id} value={c.id}>{c.name_ar}</option>)}
              </select>
            </ThemedField>
            <ThemedField label="الوردية">
              <select
                className={INPUT_CLS}
                value={shiftId}
                onChange={(e) => setFilter({ shiftId: e.target.value })}
              >
                <option value="">كل الورديات</option>
                {shifts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.shift_no} ({s.status === 'open' ? 'مفتوحة' : 'مغلقة'})
                  </option>
                ))}
              </select>
            </ThemedField>
            <ThemedField label="المسؤول">
              <select
                className={INPUT_CLS}
                value={employeeId}
                onChange={(e) => setFilter({ employeeId: e.target.value })}
              >
                <option value="">كل الموظفين</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>{u.full_name || u.username}</option>
                ))}
              </select>
            </ThemedField>
            <ThemedField label="البند">
              <select
                className={INPUT_CLS}
                value={categoryId}
                onChange={(e) => setFilter({ categoryId: e.target.value })}
              >
                <option value="">كل البنود</option>
                {categories.map((c) => <option key={c.id} value={c.id}>{c.name_ar}</option>)}
              </select>
            </ThemedField>
            <ThemedField label="الحالة">
              <select
                className={INPUT_CLS}
                value={status}
                onChange={(e) => setFilter({ status: e.target.value as typeof status })}
              >
                <option value="all">كل الحالات</option>
                <option value="approved">معتمد</option>
                <option value="pending">معلّق</option>
              </select>
            </ThemedField>
          </div>
        </div>

        <div className="mt-3 px-3 py-2.5 rounded-xl border border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-500/25 dark:bg-blue-600/10 dark:text-sky-200 text-[12px]">
          الإيرادات حسب الفترة فقط ({fmtDateDMY(from)} → {fmtDateDMY(to)})، بينما المصروفات تتبع كل الفلاتر.
        </div>

        {totalDrift > 0.01 && (
          <div className="mt-2 px-3 py-2 rounded-xl border border-rose-200 bg-rose-50 text-rose-700 dark:border-rose-500/30 dark:bg-rose-500/10 dark:text-rose-200 text-[11px]">
            تنبيه: فرق {EGP(totalDrift)} بين إجمالي السجل وإجمالي التحليل — راجِع البيانات.
          </div>
        )}
      </div>

      {/* ─── KPI grid (6) ─── */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <KpiCard
          title="إجمالي المصروفات"
          value={EGP(stats.total)}
          icon={<Wallet size={18} />}
          tone="red"
          hint={<DeltaHintInverted pct={dExpenses} suffix={prevLabel} />}
        />
        <KpiCard
          title="عدد الحركات"
          value={`${stats.count.toLocaleString('en-US')} حركة`}
          icon={<Hash size={18} />}
          tone="cyan"
          hint={
            <span className={TEXT_MUTED}>
              {prevItems.length.toLocaleString('en-US')} حركة {prevLabel}
            </span>
          }
        />
        <KpiCard
          title="متوسط المصروف للحركة"
          value={EGP(stats.avg)}
          icon={<BarChart3 size={18} />}
          tone="blue"
          hint={<span className={TEXT_MUTED}>متوسط يومي {EGP(stats.dailyAvg)}</span>}
        />
        <KpiCard
          title="نسبة المصروفات من الإيرادات"
          value={expensesAsPctOfRevenue !== null ? fmtPct(expensesAsPctOfRevenue) : '—'}
          icon={<Percent size={18} />}
          tone="amber"
          hint={
            dExpensePctOfRev === null ? (
              <span className={TEXT_MUTED}>لا توجد إيرادات</span>
            ) : (
              <span className={dExpensePctOfRev >= 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}>
                {dExpensePctOfRev >= 0 ? '↑' : '↓'} {Math.abs(dExpensePctOfRev).toFixed(1)} نقطة {prevLabel}
              </span>
            )
          }
        />
        <KpiCard
          title="صافي الربح بعد المصروفات"
          value={EGP(periodNetProfit)}
          icon={<TrendingUp size={18} />}
          tone={periodNetProfit >= 0 ? 'green' : 'red'}
          hint={<DeltaHint pct={dNetProfit} suffix={prevLabel} />}
        />
        <KpiCard
          title="هامش الربح بعد المصروفات"
          value={fmtPct(periodNetMargin)}
          icon={<Activity size={18} />}
          tone="purple"
          hint={
            <span className={dNetMargin >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}>
              {dNetMargin >= 0 ? '↑' : '↓'} {Math.abs(dNetMargin).toFixed(1)} نقطة {prevLabel}
            </span>
          }
        />
      </div>

      {/* ─── Main grid: Health · Trend chart · P&L impact ─── */}
      <div className="grid grid-cols-1 xl:grid-cols-[0.8fr_1.25fr_1fr] gap-3">
        {/* Health card */}
        <div className={CARD_PAD}>
          <div className="flex items-center justify-between mb-3">
            <div>
              <h3 className={`text-[15px] font-black ${TEXT_STRONG} mb-1`}>صحة المصروفات</h3>
              <div
                className={`text-[22px] font-black ${
                  stats.health.tone === 'red'
                    ? 'text-rose-600 dark:text-rose-400'
                    : stats.health.tone === 'amber'
                      ? 'text-amber-600 dark:text-amber-400'
                      : 'text-emerald-600 dark:text-emerald-400'
                }`}
              >
                {stats.health.word}
              </div>
            </div>
            <div
              className={`w-14 h-14 rounded-2xl flex items-center justify-center ${
                stats.health.tone === 'red'
                  ? 'bg-rose-50 text-rose-600 dark:bg-rose-500/15 dark:text-rose-300'
                  : stats.health.tone === 'amber'
                    ? 'bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300'
                    : 'bg-emerald-50 text-emerald-600 dark:bg-emerald-500/15 dark:text-emerald-300'
              }`}
            >
              <AlertTriangle size={26} />
            </div>
          </div>

          <div className="space-y-2">
            {stats.alerts.length === 0 ? (
              <div className={`text-center ${TEXT_MUTED} text-xs py-6`}>
                لا توجد تنبيهات للفترة الحالية ✓
              </div>
            ) : (
              stats.alerts.map((a, i) => (
                <div
                  key={i}
                  className="flex items-center justify-between gap-3 px-3 py-2.5 rounded-xl bg-slate-50 dark:bg-slate-950/40 text-slate-800 dark:text-slate-200 text-[12.5px]"
                >
                  <span className="flex-1">{a.msg}</span>
                  <span
                    className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                      a.severity === 'crit'
                        ? 'bg-rose-500'
                        : a.severity === 'warn'
                          ? 'bg-amber-500'
                          : 'bg-sky-500'
                    }`}
                  />
                </div>
              ))
            )}
          </div>
        </div>

        {/* Trend chart */}
        <div className={CARD_PAD}>
          <h3 className={`text-[15px] font-black ${TEXT_STRONG} mb-3`}>
            اتجاه المصروفات يوم بيوم (ج.م)
          </h3>
          <div className="h-[260px]">
            {stats.dailyTrend.length === 0 ? (
              <div className={`h-full flex items-center justify-center ${TEXT_MUTED} text-xs`}>
                لا توجد بيانات في الفترة الحالية
              </div>
            ) : (
              <Line
                data={{
                  labels: stats.dailyTrend.map((d) => d.label),
                  datasets: [
                    {
                      label: 'الفترة الحالية',
                      data: stats.dailyTrend.map((d) => d.total),
                      borderColor: '#3b82f6',
                      backgroundColor: 'rgba(59, 130, 246, 0.10)',
                      borderWidth: 3,
                      pointRadius: 4,
                      pointBackgroundColor: '#3b82f6',
                      tension: 0.35,
                      fill: true,
                    },
                    {
                      label: prevLabel.replace('عن ', ''),
                      data: stats.dailyTrend.map((_, i) => stats.prevDailyTrend[i]?.total ?? null),
                      borderColor: ct.legend,
                      borderWidth: 2,
                      borderDash: [6, 6],
                      pointRadius: 0,
                      tension: 0.3,
                      fill: false,
                    },
                  ],
                }}
                options={{
                  responsive: true,
                  maintainAspectRatio: false,
                  plugins: {
                    legend: { labels: { color: ct.legend, font: { size: 11 } } },
                    tooltip: {
                      callbacks: {
                        label: (c) => `${c.dataset.label}: ${EGP(Number(c.parsed.y || 0))}`,
                      },
                    },
                  },
                  scales: {
                    x: {
                      ticks: { color: ct.tick, font: { size: 10 } },
                      grid: { color: ct.grid },
                    },
                    y: {
                      beginAtZero: true,
                      ticks: {
                        color: ct.tick,
                        font: { size: 10 },
                        callback: (v) => `${Number(v).toLocaleString('en-US')}`,
                      },
                      grid: { color: ct.grid },
                    },
                  },
                }}
              />
            )}
          </div>
          <div className="grid grid-cols-3 gap-2 mt-3">
            <MiniStat label="أعلى يوم" value={EGP(stats.dailyHigh)} />
            <MiniStat label="أقل يوم" value={EGP(stats.dailyLow)} />
            <MiniStat label="متوسط يومي" value={EGP(stats.dailyAvg)} />
          </div>
        </div>

        {/* P&L impact panel */}
        <div className={CARD_PAD}>
          <h3 className={`text-[15px] font-black ${TEXT_STRONG} mb-3`}>
            تأثير المصروفات على الإيرادات والأرباح
          </h3>
          <div className={`divide-y ${DIVIDER} text-[13.5px]`}>
            <PnlRow label="إجمالي الإيرادات" value={EGP(periodRevenue)} tone="green" />
            <PnlRow label="تكلفة البضاعة" value={EGP(periodCogs)} tone="red" />
            <PnlRow label="مجمل الربح" value={EGP(periodGrossProfit)} tone="blue" />
            <PnlRow label="المصروفات التشغيلية" value={EGP(periodOpEx)} tone="amber" />
            <PnlRow
              label="صافي الربح"
              value={EGP(periodNetProfit)}
              tone={periodNetProfit >= 0 ? 'green' : 'red'}
            />
            <PnlRow label="هامش الربح قبل المصروفات" value={fmtPct(periodGrossMargin)} tone="purple" />
            <PnlRow label="هامش الربح بعد المصروفات" value={fmtPct(periodNetMargin)} tone="purple" />
          </div>
          <div className="mt-3 px-3 py-3 rounded-xl border border-blue-200 bg-blue-50 text-blue-800 dark:border-blue-500/25 dark:bg-blue-600/10 dark:text-sky-200 text-center text-[13px] font-bold">
            {impactNote}
          </div>
          {isPnlFetching && (
            <div className={`mt-2 text-center text-[10px] ${TEXT_MUTED}`}>
              جارٍ تحديث الأرباح…
            </div>
          )}
        </div>
      </div>

      {/* ─── Breakdown grid (4 donuts) ─── */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
        <BreakdownDonut title="حسب البند" icon={<PieIcon size={14} />} rows={stats.byCategory} total={stats.total} />
        <BreakdownDonut title="حسب الموظف المسؤول" icon={<Users size={14} />} rows={stats.byEmployee} total={stats.total} />
        <BreakdownDonut title="حسب الخزنة" icon={<Wallet size={14} />} rows={stats.byCashbox} total={stats.total} />
        <BreakdownDonut title="حسب الوردية" icon={<Clock size={14} />} rows={stats.byShift} total={stats.total} />
      </div>

      {/* ─── Top 5 categories ─── */}
      <div className={CARD_PAD}>
        <h3 className={`text-[15px] font-black ${TEXT_STRONG} mb-3 flex items-center gap-2`}>
          <TrendingUp size={14} /> أعلى 5 بنود
        </h3>
        {stats.topCategories.length === 0 ? (
          <div className={`text-center ${TEXT_MUTED} text-xs py-6`}>لا توجد بيانات.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className={`text-right ${TEXT_MUTED}`}>
                  <th className="py-2 px-2 font-bold">#</th>
                  <th className="py-2 px-2 font-bold">البند</th>
                  <th className="py-2 px-2 font-bold text-center">عدد الحركات</th>
                  <th className="py-2 px-2 font-bold text-center">الإجمالي</th>
                  <th className="py-2 px-2 font-bold text-center">% من المجموع</th>
                </tr>
              </thead>
              <tbody className={`divide-y ${DIVIDER}`}>
                {stats.topCategories.map((row, i) => {
                  const pct = stats.total > 0 ? (row.total / stats.total) * 100 : 0;
                  return (
                    <tr key={row.label + i} className={TEXT_STRONG}>
                      <td className="py-2 px-2 text-slate-500 dark:text-slate-400 tabular-nums">{i + 1}</td>
                      <td className="py-2 px-2">{row.label}</td>
                      <td className="py-2 px-2 text-center tabular-nums">{row.count}</td>
                      <td className="py-2 px-2 text-center font-bold tabular-nums text-rose-600 dark:text-rose-300">
                        {EGP(row.total)}
                      </td>
                      <td className="py-2 px-2 text-center tabular-nums">{pct.toFixed(1)}%</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─── Bottom grid: Top-10 impactful · Period comparison ─── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        {/* Top 10 impactful expenses */}
        <div className={CARD_PAD}>
          <h3 className={`text-[15px] font-black ${TEXT_STRONG} mb-3 flex items-center gap-2`}>
            <AlertTriangle size={14} /> أعلى 10 مصروفات مؤثرة
          </h3>
          {stats.topN.length === 0 ? (
            <div className={`text-center ${TEXT_MUTED} text-xs py-6`}>لا توجد بيانات.</div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead>
                  <tr className={`text-right ${TEXT_MUTED}`}>
                    <th className="py-2 px-2 font-bold">#</th>
                    <th className="py-2 px-2 font-bold">التاريخ والوقت</th>
                    <th className="py-2 px-2 font-bold text-center">المبلغ</th>
                    <th className="py-2 px-2 font-bold">البند</th>
                    <th className="py-2 px-2 font-bold">المسؤول</th>
                    <th className="py-2 px-2 font-bold">الخزنة</th>
                    <th className="py-2 px-2 font-bold">الوردية</th>
                    <th className="py-2 px-2 font-bold text-center">الأثر</th>
                  </tr>
                </thead>
                <tbody className={`divide-y ${DIVIDER}`}>
                  {stats.topN.map((e, i) => {
                    const impact = stats.impactFor(e);
                    return (
                      <tr key={e.id} className={TEXT_STRONG}>
                        <td className="py-2 px-2 text-slate-500 dark:text-slate-400 tabular-nums">{i + 1}</td>
                        <td className="py-2 px-2 font-mono tabular-nums whitespace-nowrap">
                          {fmtDateDMY(e.expense_date)} {fmtTimeHM(e.created_at)}
                        </td>
                        <td className="py-2 px-2 text-center font-black tabular-nums text-rose-600 dark:text-rose-300">
                          {EGP(e.amount)}
                        </td>
                        <td className="py-2 px-2 truncate max-w-[140px]">{e.category_name || '—'}</td>
                        <td className="py-2 px-2 text-slate-600 dark:text-slate-300 truncate max-w-[120px]">
                          {e.employee_name || e.employee_username || '—'}
                        </td>
                        <td className="py-2 px-2 text-slate-600 dark:text-slate-300 truncate max-w-[100px]">
                          {e.cashbox_name || '—'}
                        </td>
                        <td className="py-2 px-2 text-slate-500 dark:text-slate-400 font-mono text-[11px]">
                          {e.shift_no || '—'}
                        </td>
                        <td className="py-2 px-2 text-center font-black">
                          {impact === 'high' ? (
                            <span className="text-rose-600 dark:text-rose-400">مرتفع</span>
                          ) : impact === 'repeat' ? (
                            <span className="text-amber-600 dark:text-amber-400">متكرر</span>
                          ) : (
                            <span className="text-emerald-600 dark:text-emerald-400">طبيعي</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Period comparison */}
        <div className={CARD_PAD}>
          <h3 className={`text-[15px] font-black ${TEXT_STRONG} mb-3`}>مقارنة الفترات</h3>
          <p className={`text-[11px] ${TEXT_MUTED} mb-3`}>
            الفترة الحالية ({fmtDateDMY(from)} → {fmtDateDMY(to)}) مقابل {fmtDateDMY(prevFrom)} → {fmtDateDMY(prevTo)}
          </p>
          <div className={`divide-y ${DIVIDER} text-[13px]`}>
            <CompareRow label="إجمالي المصروفات" current={EGP(stats.total)} prev={EGP(prevTotal)} delta={dExpenses} invertPolarity />
            <CompareRow label="عدد الحركات" current={`${stats.count}`} prev={`${prevItems.length}`} delta={dCount} invertPolarity />
            <CompareRow label="إجمالي الإيرادات" current={EGP(periodRevenue)} prev={EGP(prevRevenue)} delta={dRevenue} />
            <CompareRow label="المصروفات التشغيلية (P&L)" current={EGP(periodOpEx)} prev={EGP(prevOpEx)} delta={dOpEx} invertPolarity />
            <CompareRow label="صافي الربح" current={EGP(periodNetProfit)} prev={EGP(prevNetProfit)} delta={dNetProfit} />
            <CompareRow label="هامش الربح" current={fmtPct(periodNetMargin)} prev={fmtPct(prevNetMargin)} delta={dNetMargin} isPercentagePoints />
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─── Tiny presentational helpers ─── */

const INPUT_CLS =
  'w-full h-9 rounded-lg border border-slate-300 bg-white text-slate-900 ' +
  'dark:border-slate-600/50 dark:bg-slate-950/55 dark:text-slate-100 ' +
  'px-2.5 text-[13px] outline-none ' +
  'focus:border-blue-500 focus:ring-2 focus:ring-blue-500/20 ' +
  'disabled:opacity-50 disabled:cursor-not-allowed';

function ThemedField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block text-[11px] text-slate-600 dark:text-slate-400 mb-1.5 font-bold">
        {label}
      </span>
      {children}
    </label>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div className={CHIP_MUTED + ' text-center'}>
      <div className="text-[11px] text-slate-500 dark:text-slate-400">{label}</div>
      <div className={`mt-0.5 text-[13px] font-black ${TEXT_STRONG} tabular-nums`}>{value}</div>
    </div>
  );
}

function PnlRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'red' | 'green' | 'blue' | 'amber' | 'purple';
}) {
  const c = {
    red: 'text-rose-600 dark:text-rose-300',
    green: 'text-emerald-600 dark:text-emerald-300',
    blue: 'text-sky-600 dark:text-sky-300',
    amber: 'text-amber-600 dark:text-amber-300',
    purple: 'text-violet-600 dark:text-violet-300',
  }[tone];
  return (
    <div className="flex items-center justify-between py-2.5">
      <span className="text-slate-700 dark:text-slate-300">{label}</span>
      <span className={`font-black tabular-nums ${c}`}>{value}</span>
    </div>
  );
}

function CompareRow({
  label,
  current,
  prev,
  delta,
  invertPolarity = false,
  isPercentagePoints = false,
}: {
  label: string;
  current: string;
  prev: string;
  delta: number | null;
  invertPolarity?: boolean;
  isPercentagePoints?: boolean;
}) {
  const up = (delta ?? 0) >= 0;
  const positiveIsGood = !invertPolarity;
  const goodColor = (up && positiveIsGood) || (!up && !positiveIsGood);
  const color =
    delta === null
      ? 'text-slate-400 dark:text-slate-500'
      : goodColor
        ? 'text-emerald-600 dark:text-emerald-400'
        : 'text-rose-600 dark:text-rose-400';
  return (
    <div className="grid grid-cols-[1.2fr_1fr_1fr_1fr] gap-2 items-center py-2.5">
      <span className="text-slate-700 dark:text-slate-300 text-[12.5px]">{label}</span>
      <span className={`${TEXT_STRONG} font-bold tabular-nums text-[12.5px] text-center`}>
        {current}
      </span>
      <span className="text-slate-500 dark:text-slate-400 tabular-nums text-[12px] text-center">
        {prev}
      </span>
      <span className={`font-black text-[12.5px] text-center ${color}`}>
        {delta === null
          ? '—'
          : `${up ? '↑' : '↓'} ${Math.abs(delta).toFixed(1)}${isPercentagePoints ? ' نقطة' : '%'}`}
      </span>
    </div>
  );
}
