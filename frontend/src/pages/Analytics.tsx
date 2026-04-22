import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Line, Bar, Doughnut } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  ChartOptions,
} from 'chart.js';
import {
  Sparkles,
  TrendingUp,
  AlertTriangle,
  Activity,
  Users,
  Package,
  DollarSign,
  Percent,
  Clock,
  Lightbulb,
  Download,
  Printer,
  BarChart3,
  Wallet,
} from 'lucide-react';

import { accountsApi } from '@/api/accounts.api';
import { exportMultiSheet, printReport } from '@/lib/exportExcel';
import {
  PeriodSelector,
  resolvePeriod,
  type PeriodRange,
} from '@/components/common/PeriodSelector';

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
  Filler,
);

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const shortEGP = (n: number | string) => {
  const v = Number(n || 0);
  if (Math.abs(v) >= 1_000_000)
    return `${(v / 1_000_000).toFixed(1)}م`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}ك`;
  return v.toFixed(0);
};

const DOW_AR = ['أحد', 'اثنين', 'ثلاثاء', 'أربعاء', 'خميس', 'جمعة', 'سبت'];

export default function Analytics() {
  const [period, setPeriod] = useState<PeriodRange>(() =>
    resolvePeriod('month'),
  );

  const { data: indicators } = useQuery({
    queryKey: ['analytics-indicators', period.from, period.to],
    queryFn: () =>
      accountsApi.indicators({ from: period.from, to: period.to }),
    refetchInterval: 60_000,
  });
  const { data: recommendations = [] } = useQuery({
    queryKey: ['analytics-recommendations', period.from, period.to],
    queryFn: () =>
      accountsApi.recommendations({ from: period.from, to: period.to }),
    refetchInterval: 120_000,
  });
  const { data: daily = [] } = useQuery({
    queryKey: ['analytics-daily', period.from, period.to],
    queryFn: () =>
      accountsApi.dailyPerformance({ from: period.from, to: period.to }),
  });
  const { data: heatmap = [] } = useQuery({
    queryKey: ['analytics-heatmap', period.from, period.to],
    queryFn: () =>
      accountsApi.hourlyHeatmap({ from: period.from, to: period.to }),
  });
  const { data: topProducts = [] } = useQuery({
    queryKey: ['analytics-topprod', period.from, period.to],
    queryFn: () =>
      accountsApi.topProducts({
        from: period.from,
        to: period.to,
        limit: 10,
      }),
  });
  const { data: topCustomers = [] } = useQuery({
    queryKey: ['analytics-topcust', period.from, period.to],
    queryFn: () =>
      accountsApi.topCustomers({
        from: period.from,
        to: period.to,
        limit: 10,
      }),
  });
  const { data: topSales = [] } = useQuery({
    queryKey: ['analytics-topsales', period.from, period.to],
    queryFn: () =>
      accountsApi.topSalespeople({
        from: period.from,
        to: period.to,
        limit: 10,
      }),
  });
  const { data: expenseBreak = [] } = useQuery({
    queryKey: ['analytics-expbreak', period.from, period.to],
    queryFn: () =>
      accountsApi.expenseBreakdown({ from: period.from, to: period.to }),
  });
  const { data: waterfall } = useQuery({
    queryKey: ['analytics-waterfall', period.from, period.to],
    queryFn: () =>
      accountsApi.cashflowWaterfall({ from: period.from, to: period.to }),
  });

  // Chart configurations
  const trendChart = useMemo(() => {
    return {
      labels: daily.map((d) => d.date.slice(5)),
      datasets: [
        {
          label: 'إيرادات',
          data: daily.map((d) => Number(d.revenue)),
          borderColor: 'rgb(16 185 129)',
          backgroundColor: 'rgba(16,185,129,0.1)',
          fill: true,
          tension: 0.3,
          pointRadius: 2,
          pointHoverRadius: 5,
        },
        {
          label: 'ربح إجمالي',
          data: daily.map((d) => Number(d.gross_profit)),
          borderColor: 'rgb(79 70 229)',
          backgroundColor: 'rgba(79,70,229,0.1)',
          fill: false,
          tension: 0.3,
          pointRadius: 2,
        },
        {
          label: 'صافي الربح',
          data: daily.map((d) => Number(d.net_profit)),
          borderColor: 'rgb(245 158 11)',
          backgroundColor: 'rgba(245,158,11,0.1)',
          fill: false,
          borderDash: [4, 4],
          tension: 0.3,
          pointRadius: 2,
        },
      ],
    };
  }, [daily]);

  // Candlestick-style daily bar (custom: using bar with open/close as bars)
  const ohlcChart = useMemo(() => {
    const up = daily.map((d) => {
      const n = Number(d.net_profit);
      return n >= 0 ? n : 0;
    });
    const down = daily.map((d) => {
      const n = Number(d.net_profit);
      return n < 0 ? Math.abs(n) : 0;
    });
    const tax = daily.map((d) => Number(d.tax));
    return {
      labels: daily.map((d) => d.date.slice(5)),
      datasets: [
        {
          label: 'ربح',
          data: up,
          backgroundColor: 'rgba(16,185,129,0.85)',
          stack: 'day',
          borderRadius: 4,
        },
        {
          label: 'خسارة',
          data: down,
          backgroundColor: 'rgba(239,68,68,0.85)',
          stack: 'day',
          borderRadius: 4,
        },
        {
          label: 'ضريبة',
          data: tax,
          backgroundColor: 'rgba(148,163,184,0.65)',
          stack: 'day',
          borderRadius: 4,
        },
      ],
    };
  }, [daily]);

  const expenseDoughnut = useMemo(() => {
    const top = expenseBreak.slice(0, 8);
    const palette = [
      'rgba(239,68,68,0.85)',
      'rgba(249,115,22,0.85)',
      'rgba(245,158,11,0.85)',
      'rgba(234,179,8,0.85)',
      'rgba(132,204,22,0.85)',
      'rgba(16,185,129,0.85)',
      'rgba(14,165,233,0.85)',
      'rgba(79,70,229,0.85)',
    ];
    return {
      labels: top.map((e) => `${e.code} — ${e.name_ar}`),
      datasets: [
        {
          data: top.map((e) => Number(e.amount)),
          backgroundColor: palette,
          borderWidth: 2,
          borderColor: '#fff',
        },
      ],
    };
  }, [expenseBreak]);

  const heatmapMatrix = useMemo(() => {
    const mat: number[][] = Array.from({ length: 7 }, () =>
      Array(24).fill(0),
    );
    let max = 0;
    for (const c of heatmap) {
      const v = Number(c.revenue || 0);
      mat[c.dow][c.hour] = v;
      if (v > max) max = v;
    }
    return { mat, max };
  }, [heatmap]);

  const lineOpts: ChartOptions<'line'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom' as const, labels: { font: { family: 'inherit' } } },
      tooltip: {
        callbacks: {
          label: (ctx) =>
            `${ctx.dataset.label}: ${EGP(Number(ctx.parsed.y))}`,
        },
      },
    },
    scales: {
      y: {
        ticks: { callback: (v) => shortEGP(Number(v)) },
      },
    },
  };

  const barOpts: ChartOptions<'bar'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'bottom' as const },
      tooltip: {
        callbacks: {
          label: (ctx) =>
            `${ctx.dataset.label}: ${EGP(Number(ctx.parsed.y))}`,
        },
      },
    },
    scales: {
      y: {
        stacked: true,
        ticks: { callback: (v) => shortEGP(Number(v)) },
      },
      x: { stacked: true },
    },
  };

  const doughnutOpts: ChartOptions<'doughnut'> = {
    responsive: true,
    maintainAspectRatio: false,
    plugins: {
      legend: { position: 'right' as const },
      tooltip: {
        callbacks: {
          label: (ctx) =>
            `${ctx.label}: ${EGP(Number(ctx.parsed))}`,
        },
      },
    },
  };

  const exportAll = () => {
    exportMultiSheet(
      `analytics-${period.from}-to-${period.to}`,
      [
        {
          name: 'الأداء اليومي',
          rows: daily.map((d) => ({
            التاريخ: d.date,
            'عدد الفواتير': d.invoice_count,
            الإيرادات: d.revenue,
            COGS: d.cogs,
            'ربح إجمالي': d.gross_profit,
            المصروفات: d.expenses,
            المرتجعات: d.returns,
            'صافي الربح': d.net_profit,
          })),
        },
        {
          name: 'أفضل المنتجات',
          rows: topProducts.map((p) => ({
            المنتج: p.product_name,
            SKU: p.sku,
            'الكمية': p.qty,
            الإيرادات: p.revenue,
            التكلفة: p.cogs,
            'الربح الإجمالي': p.gross,
          })),
        },
        {
          name: 'أفضل العملاء',
          rows: topCustomers.map((c) => ({
            الكود: c.code,
            العميل: c.full_name,
            الهاتف: c.phone,
            'عدد الفواتير': c.invoice_count,
            الإيرادات: c.revenue,
            'متوسط الفاتورة': c.avg_ticket,
          })),
        },
        {
          name: 'البائعون',
          rows: topSales.map((s) => ({
            البائع: s.full_name,
            'عدد الفواتير': s.invoice_count,
            الإيرادات: s.revenue,
            الربح: s.gross,
          })),
        },
      ],
    );
  };

  const indValue = (v: number | undefined) => Number(v || 0);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Sparkles className="text-brand-600" /> التحليلات الذكية
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            مؤشرات · توصيات · اتجاهات · شموع · خرائط حرارية — بيانات حية من
            دفتر الأستاذ العام
          </p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <PeriodSelector value={period} onChange={setPeriod} />
          <button className="btn-secondary" onClick={exportAll}>
            <Download size={14} /> Excel
          </button>
          <button className="btn-secondary" onClick={() => window.print()}>
            <Printer size={14} /> طباعة
          </button>
        </div>
      </div>

      {/* Smart indicators — top grid */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <IndicatorTile
          icon={<DollarSign size={16} />}
          label="الإيرادات"
          value={EGP(indValue(indicators?.revenue))}
          sub={`${indValue(indicators?.invoice_count)} فاتورة`}
          color="emerald"
        />
        <IndicatorTile
          icon={<Percent size={16} />}
          label="الهامش الإجمالي"
          value={`${indValue(indicators?.gross_margin_pct).toFixed(1)}%`}
          sub={`ربح ${EGP(indValue(indicators?.gross_profit))}`}
          color={
            indValue(indicators?.gross_margin_pct) >= 25
              ? 'emerald'
              : indValue(indicators?.gross_margin_pct) >= 15
                ? 'amber'
                : 'rose'
          }
        />
        <IndicatorTile
          icon={<TrendingUp size={16} />}
          label="صافي الربح"
          value={EGP(indValue(indicators?.net_profit))}
          sub={`${indValue(indicators?.net_margin_pct).toFixed(1)}% هامش`}
          color={
            indValue(indicators?.net_profit) >= 0 ? 'indigo' : 'rose'
          }
        />
        <IndicatorTile
          icon={<Package size={16} />}
          label="قيمة المخزون"
          value={EGP(indValue(indicators?.inventory_value))}
          sub={`دوران ${indValue(indicators?.inventory_turns).toFixed(1)}×/سنة`}
          color="slate"
        />
        <IndicatorTile
          icon={<Activity size={16} />}
          label="معدل المرتجع"
          value={`${indValue(indicators?.return_rate_pct).toFixed(1)}%`}
          sub={`${indValue(indicators?.return_count)} مرتجع`}
          color={
            indValue(indicators?.return_rate_pct) < 3
              ? 'emerald'
              : indValue(indicators?.return_rate_pct) < 5
                ? 'amber'
                : 'rose'
          }
        />
        <IndicatorTile
          icon={<Wallet size={16} />}
          label="السيولة"
          value={EGP(indValue(indicators?.cash_on_hand))}
          sub={`تكفي ${indValue(indicators?.cash_runway_days)} يوم`}
          color={
            indValue(indicators?.cash_runway_days) >= 30
              ? 'emerald'
              : indValue(indicators?.cash_runway_days) >= 14
                ? 'amber'
                : 'rose'
          }
        />
      </div>

      {/* Supplementary indicators */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MiniStat
          label="متوسط الفاتورة"
          value={EGP(indValue(indicators?.avg_ticket))}
        />
        <MiniStat
          label="مستحقات العملاء"
          value={EGP(indValue(indicators?.receivables))}
          color="amber"
        />
        <MiniStat
          label="مستحقات للموردين"
          value={EGP(indValue(indicators?.payables))}
          color="rose"
        />
        <MiniStat
          label="المصروف اليومي"
          value={EGP(indValue(indicators?.daily_burn))}
        />
      </div>

      {/* Smart recommendations */}
      {recommendations.length > 0 && (
        <div className="card p-4 border-2 border-indigo-200 bg-indigo-50/50">
          <div className="flex items-center gap-2 mb-3 font-black">
            <Lightbulb className="text-indigo-600" size={18} /> توصيات ذكية
          </div>
          <div className="grid md:grid-cols-2 gap-2">
            {recommendations.map((r, i) => (
              <RecommendationCard key={i} r={r} />
            ))}
          </div>
        </div>
      )}

      {/* Charts row 1 — trend line + candle-style bar */}
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-3 text-sm font-bold text-slate-700">
            <TrendingUp size={16} /> اتجاه الربحية (يومياً)
          </div>
          <div className="h-72">
            <Line data={trendChart} options={lineOpts} />
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-3 text-sm font-bold text-slate-700">
            <BarChart3 size={16} /> شمعات الأداء اليومي (ربح / خسارة / ضريبة)
          </div>
          <div className="h-72">
            <Bar data={ohlcChart} options={barOpts} />
          </div>
        </div>
      </div>

      {/* Charts row 2 — expense donut + hourly heatmap */}
      <div className="grid lg:grid-cols-2 gap-4">
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-3 text-sm font-bold text-slate-700">
            <DollarSign size={16} /> توزيع المصروفات
          </div>
          <div className="h-72">
            {expenseBreak.length > 0 ? (
              <Doughnut data={expenseDoughnut} options={doughnutOpts} />
            ) : (
              <EmptyState label="لا توجد مصروفات في هذه الفترة" />
            )}
          </div>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 mb-3 text-sm font-bold text-slate-700">
            <Clock size={16} /> خريطة حرارية — المبيعات حسب اليوم والساعة
          </div>
          <HeatmapGrid matrix={heatmapMatrix.mat} max={heatmapMatrix.max} />
        </div>
      </div>

      {/* Leaderboards */}
      <div className="grid lg:grid-cols-3 gap-4">
        <LeaderboardCard
          title="أفضل ١٠ منتجات"
          icon={<Package size={16} />}
          rows={topProducts.map((p) => ({
            label: p.product_name,
            sub: p.sku ? `SKU: ${p.sku}` : `قطعة: ${p.qty}`,
            value: Number(p.revenue),
            footer: `ربح ${EGP(p.gross)}`,
          }))}
        />
        <LeaderboardCard
          title="أفضل ١٠ عملاء"
          icon={<Users size={16} />}
          rows={topCustomers.map((c) => ({
            label: c.full_name,
            sub: `${c.code} · ${c.invoice_count} فاتورة`,
            value: Number(c.revenue),
            footer: `متوسط ${EGP(c.avg_ticket)}`,
          }))}
        />
        <LeaderboardCard
          title="أفضل ١٠ بائعين"
          icon={<Sparkles size={16} />}
          rows={topSales.map((s) => ({
            label: s.full_name,
            sub: `${s.invoice_count} فاتورة`,
            value: Number(s.revenue),
            footer: `ربح ${EGP(s.gross)}`,
          }))}
        />
      </div>

      {/* Cash flow waterfall */}
      {waterfall && (
        <CashFlowWaterfall
          opening={waterfall.opening}
          buckets={waterfall.buckets.map((b) => ({
            direction: b.direction,
            category: b.category,
            amount: Number(b.amount),
          }))}
        />
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Sub-components
// ════════════════════════════════════════════════════════════════════

function IndicatorTile({
  icon,
  label,
  value,
  sub,
  color,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
  color: 'emerald' | 'rose' | 'indigo' | 'amber' | 'slate';
}) {
  const cls: Record<string, string> = {
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    rose: 'bg-rose-50 border-rose-200 text-rose-800',
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-800',
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
    slate: 'bg-slate-50 border-slate-200 text-slate-800',
  };
  return (
    <div className={`card p-3 border-2 ${cls[color]}`}>
      <div className="text-xs font-bold flex items-center gap-1 opacity-80">
        {icon} {label}
      </div>
      <div className="font-black text-lg font-mono mt-1 truncate">
        {value}
      </div>
      {sub && (
        <div className="text-[10px] opacity-70 truncate mt-0.5">{sub}</div>
      )}
    </div>
  );
}

function MiniStat({
  label,
  value,
  color = 'slate',
}: {
  label: string;
  value: string;
  color?: 'slate' | 'amber' | 'rose';
}) {
  const cls: Record<string, string> = {
    slate: 'text-slate-700 border-slate-200',
    amber: 'text-amber-700 border-amber-200',
    rose: 'text-rose-700 border-rose-200',
  };
  return (
    <div className={`card p-3 border ${cls[color]}`}>
      <div className="text-xs text-slate-500">{label}</div>
      <div className="font-black text-lg font-mono mt-1">{value}</div>
    </div>
  );
}

function RecommendationCard({
  r,
}: {
  r: { severity: string; title: string; detail: string; action?: string };
}) {
  const cls: Record<string, string> = {
    critical: 'bg-rose-50 border-rose-300 text-rose-900',
    warning: 'bg-amber-50 border-amber-300 text-amber-900',
    info: 'bg-emerald-50 border-emerald-300 text-emerald-900',
  };
  const Icon = r.severity === 'info' ? Sparkles : AlertTriangle;
  return (
    <div className={`border-2 rounded-lg p-3 text-sm ${cls[r.severity]}`}>
      <div className="flex items-start gap-2">
        <Icon size={16} className="shrink-0 mt-0.5" />
        <div className="flex-1 min-w-0">
          <div className="font-black">{r.title}</div>
          <div className="text-xs opacity-80 mt-0.5">{r.detail}</div>
          {r.action && (
            <div className="text-xs font-bold mt-1">
              👉 {r.action}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function LeaderboardCard({
  title,
  icon,
  rows,
}: {
  title: string;
  icon: React.ReactNode;
  rows: Array<{
    label: string;
    sub?: string;
    value: number;
    footer?: string;
  }>;
}) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3 text-sm font-bold text-slate-700">
        {icon} {title}
      </div>
      {rows.length === 0 ? (
        <EmptyState label="لا توجد بيانات" />
      ) : (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={i} className="text-sm">
              <div className="flex justify-between items-baseline gap-2">
                <span className="font-bold truncate">
                  {i + 1}. {r.label}
                </span>
                <span className="font-mono font-black text-brand-700 shrink-0">
                  {EGP(r.value)}
                </span>
              </div>
              <div className="relative h-1.5 bg-slate-100 rounded-full overflow-hidden mt-1">
                <div
                  className="absolute top-0 right-0 bottom-0 bg-gradient-to-l from-brand-500 to-brand-300"
                  style={{ width: `${(r.value / max) * 100}%` }}
                />
              </div>
              {(r.sub || r.footer) && (
                <div className="flex justify-between text-[11px] text-slate-500 mt-0.5">
                  <span>{r.sub || ''}</span>
                  <span>{r.footer || ''}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function HeatmapGrid({ matrix, max }: { matrix: number[][]; max: number }) {
  return (
    <div className="overflow-auto">
      <div className="inline-grid grid-rows-8 grid-cols-[auto_repeat(24,minmax(22px,1fr))] gap-0.5 text-[10px] min-w-full">
        <div></div>
        {Array.from({ length: 24 }).map((_, h) => (
          <div
            key={h}
            className="text-center text-slate-400 font-mono"
            style={{ gridColumn: h + 2 }}
          >
            {h}
          </div>
        ))}
        {matrix.map((row, dow) => (
          <>
            <div
              key={`lbl-${dow}`}
              className="text-slate-500 text-right pr-1"
            >
              {DOW_AR[dow]}
            </div>
            {row.map((v, h) => {
              const intensity = max > 0 ? Math.sqrt(v / max) : 0;
              const bg =
                v > 0
                  ? `rgba(16,185,129,${0.1 + intensity * 0.85})`
                  : 'transparent';
              return (
                <div
                  key={`${dow}-${h}`}
                  className="rounded flex items-center justify-center"
                  style={{
                    backgroundColor: bg,
                    height: 22,
                    color: intensity > 0.5 ? '#fff' : '#475569',
                  }}
                  title={`${DOW_AR[dow]} ${h}:00 — ${EGP(v)}`}
                >
                  {v > 0 && intensity > 0.3 ? shortEGP(v) : ''}
                </div>
              );
            })}
          </>
        ))}
      </div>
    </div>
  );
}

function CashFlowWaterfall({
  opening,
  buckets,
}: {
  opening: number;
  buckets: Array<{ direction: 'in' | 'out'; category: string; amount: number }>;
}) {
  const totalIn = buckets
    .filter((b) => b.direction === 'in')
    .reduce((s, b) => s + b.amount, 0);
  const totalOut = buckets
    .filter((b) => b.direction === 'out')
    .reduce((s, b) => s + b.amount, 0);
  const closing = opening + totalIn - totalOut;

  return (
    <div className="card p-4">
      <div className="flex items-center gap-2 mb-3 text-sm font-bold text-slate-700">
        <Activity size={16} /> تدفق نقدي (بتصنيف العمليات)
      </div>
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 text-sm">
        <StepTile label="الرصيد الافتتاحي" value={opening} neutral />
        <StepTile label="إجمالي الداخل" value={totalIn} positive />
        <StepTile label="إجمالي الخارج" value={totalOut} negative />
        <StepTile label="الرصيد الختامي" value={closing} neutral highlight />
      </div>
      <div className="grid md:grid-cols-2 gap-3 mt-3">
        <Buckets
          title="تصنيفات الداخل"
          rows={buckets.filter((b) => b.direction === 'in')}
          color="emerald"
        />
        <Buckets
          title="تصنيفات الخارج"
          rows={buckets.filter((b) => b.direction === 'out')}
          color="rose"
        />
      </div>
    </div>
  );
}

function StepTile({
  label,
  value,
  positive,
  negative,
  neutral,
  highlight,
}: {
  label: string;
  value: number;
  positive?: boolean;
  negative?: boolean;
  neutral?: boolean;
  highlight?: boolean;
}) {
  const cls = negative
    ? 'bg-rose-50 border-rose-200 text-rose-700'
    : positive
      ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
      : 'bg-slate-50 border-slate-200 text-slate-700';
  return (
    <div
      className={`border rounded-lg p-3 ${cls} ${highlight ? 'border-2 ring-2 ring-indigo-200' : ''}`}
    >
      <div className="text-xs opacity-80">{label}</div>
      <div className="font-mono font-black text-lg mt-1">{EGP(value)}</div>
    </div>
  );
}

function Buckets({
  title,
  rows,
  color,
}: {
  title: string;
  rows: Array<{ category: string; amount: number }>;
  color: 'emerald' | 'rose';
}) {
  const max = Math.max(1, ...rows.map((r) => r.amount));
  const barColor =
    color === 'emerald' ? 'bg-emerald-400' : 'bg-rose-400';
  return (
    <div className="border border-slate-200 rounded-lg p-3">
      <div className="text-xs font-bold text-slate-600 mb-2">{title}</div>
      {rows.length === 0 ? (
        <div className="text-center text-slate-400 py-4 text-xs">
          لا توجد حركات
        </div>
      ) : (
        <div className="space-y-1.5">
          {rows.map((r, i) => (
            <div key={i} className="text-xs">
              <div className="flex justify-between">
                <span className="font-bold">{r.category}</span>
                <span className="font-mono">{EGP(r.amount)}</span>
              </div>
              <div className="h-1 bg-slate-100 rounded-full overflow-hidden mt-0.5">
                <div
                  className={`h-full ${barColor}`}
                  style={{ width: `${(r.amount / max) * 100}%` }}
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EmptyState({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-center h-full text-slate-400 text-sm">
      {label}
    </div>
  );
}
