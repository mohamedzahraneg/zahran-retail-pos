import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Line, Doughnut, Bar } from 'react-chartjs-2';
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
} from 'chart.js';
import {
  DollarSign,
  ShoppingBag,
  Users,
  TrendingUp,
  TrendingDown,
  AlertTriangle,
  Package,
  Target,
  Sparkles,
  Activity,
  Award,
  ArrowUpRight,
  ArrowDownRight,
  Lightbulb,
} from 'lucide-react';
import { dashboardApi } from '@/api/dashboard.api';
import { accountingApi } from '@/api/accounting.api';
import { ReturnsWidget } from '@/components/dashboard/ReturnsWidget';

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

const EGP = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'EGP',
  maximumFractionDigits: 0,
});
const NUM = (n: number) => Number(n || 0).toLocaleString('en-US');

function shortDate(iso: string) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit' });
}

function useRecommendations(data: any, pl: any) {
  return useMemo(() => {
    const recs: Array<{
      id: string;
      priority: 'critical' | 'high' | 'medium' | 'low';
      icon: any;
      title: string;
      detail: string;
      action?: { to: string; label: string };
    }> = [];
    const today = data?.today || {};
    const lowStock = data?.lowStock || [];
    const alerts = data?.alerts || [];
    const revenue30 = data?.revenue30 || [];

    if (pl?.analysis) {
      if (pl.analysis.headline === 'loss') {
        recs.push({
          id: 'pl-loss',
          priority: 'critical',
          icon: TrendingDown,
          title: `خسارة هذا الشهر: ${EGP.format(Math.abs(Number(pl.net_profit) || 0))}`,
          detail:
            pl.analysis.reasons?.[0]?.message ||
            'راجع المصروفات والإيرادات لمعرفة السبب.',
          action: { to: '/accounting', label: 'افتح تقرير الأرباح' },
        });
      } else if (pl.analysis.headline === 'profit' && pl.net_profit > 0) {
        recs.push({
          id: 'pl-profit',
          priority: 'low',
          icon: TrendingUp,
          title: `ربح الشهر: ${EGP.format(Number(pl.net_profit) || 0)}`,
          detail: `هامش صافي ${Number(pl.net_margin_pct).toFixed(1)}%.`,
          action: { to: '/accounting', label: 'عرض التفاصيل' },
        });
      }
    }

    if (lowStock.length > 0) {
      recs.push({
        id: 'low-stock',
        priority: lowStock.length >= 5 ? 'high' : 'medium',
        icon: Package,
        title: `${lowStock.length} صنف على وشك النفاد`,
        detail: `أعلى شُح: ${lowStock[0]?.product_name || ''} (المتبقي ${
          lowStock[0]?.quantity ?? 0
        }).`,
        action: { to: '/stock-adjustments', label: 'راجع المخزون' },
      });
    }

    if (alerts.length > 0) {
      recs.push({
        id: 'alerts',
        priority: 'high',
        icon: AlertTriangle,
        title: `${alerts.length} تنبيه نشط`,
        detail: alerts[0]?.message || alerts[0]?.title || 'راجع صفحة التنبيهات.',
        action: { to: '/alerts', label: 'افتح التنبيهات' },
      });
    }

    if (revenue30.length >= 14) {
      const last7 = revenue30
        .slice(-7)
        .reduce((s: number, r: any) => s + Number(r.revenue || 0), 0);
      const prev7 = revenue30
        .slice(-14, -7)
        .reduce((s: number, r: any) => s + Number(r.revenue || 0), 0);
      if (prev7 > 0) {
        const delta = ((last7 - prev7) / prev7) * 100;
        if (delta <= -15) {
          recs.push({
            id: 'revenue-drop',
            priority: 'high',
            icon: ArrowDownRight,
            title: `إيراد آخر 7 أيام انخفض ${Math.abs(delta).toFixed(0)}%`,
            detail: `من ${EGP.format(prev7)} إلى ${EGP.format(last7)}. راجع حركة المبيعات.`,
            action: { to: '/reports', label: 'تحليل المبيعات' },
          });
        } else if (delta >= 20) {
          recs.push({
            id: 'revenue-growth',
            priority: 'low',
            icon: ArrowUpRight,
            title: `نمو ${delta.toFixed(0)}% في إيراد آخر 7 أيام`,
            detail: `من ${EGP.format(prev7)} إلى ${EGP.format(last7)} — أداء ممتاز.`,
          });
        }
      }
    }

    if (Number(today.invoice_count || 0) === 0) {
      const hour = new Date().getHours();
      if (hour >= 12) {
        recs.push({
          id: 'no-sales-today',
          priority: 'medium',
          icon: Activity,
          title: 'لا توجد فواتير اليوم',
          detail: 'افحص نقطة البيع أو راجع حركة الكاشيرين.',
          action: { to: '/pos', label: 'افتح نقطة البيع' },
        });
      }
    }

    const receivable = Number(today.receivables || 0);
    if (receivable > 10000) {
      recs.push({
        id: 'receivables',
        priority: 'medium',
        icon: Users,
        title: `مستحقات العملاء: ${EGP.format(receivable)}`,
        detail: 'فكر في جولة تحصيل لتقليل الذمم المدينة.',
        action: { to: '/customers', label: 'قائمة العملاء' },
      });
    }

    const order: Record<string, number> = {
      critical: 0,
      high: 1,
      medium: 2,
      low: 3,
    };
    recs.sort((a, b) => order[a.priority] - order[b.priority]);
    return recs;
  }, [data, pl]);
}

export default function Dashboard() {
  const { data, isLoading } = useQuery({
    queryKey: ['dashboard-overview'],
    queryFn: () => dashboardApi.overview(),
    refetchInterval: 60_000,
  });

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';

  const { data: pl } = useQuery({
    queryKey: ['dashboard-pl', monthStart, today],
    queryFn: () =>
      accountingApi.profitAndLossAnalysis({ from: monthStart, to: today }),
    refetchInterval: 120_000,
  });

  const recs = useRecommendations(data, pl);

  if (isLoading) {
    return (
      <div className="card p-12 text-center text-slate-500">جارٍ التحميل...</div>
    );
  }

  const todayData = data?.today || ({} as any);
  const revenue = data?.revenue30 || [];
  const mix = data?.paymentMix || [];
  const cashiers = data?.cashierPerf || [];
  const products = data?.topProducts || [];

  const now = new Date();
  const dayStr = now.toLocaleDateString('ar-EG-u-ca-gregory', {
    weekday: 'long',
  });
  const dateStr = now.toLocaleDateString('en-GB');

  return (
    <div className="space-y-6">
      {/* ═════ Hero ═════ */}
      <div
        className="rounded-2xl p-6 text-white relative overflow-hidden"
        style={{
          background:
            'linear-gradient(135deg, #6366f1 0%, #a855f7 50%, #ec4899 100%)',
        }}
      >
        <div className="absolute inset-0 opacity-20 pointer-events-none">
          <div className="absolute top-0 right-0 w-64 h-64 bg-white rounded-full blur-3xl -translate-y-1/2 translate-x-1/4"></div>
          <div className="absolute bottom-0 left-0 w-48 h-48 bg-yellow-300 rounded-full blur-3xl translate-y-1/2 -translate-x-1/4"></div>
        </div>
        <div className="relative flex items-center justify-between flex-wrap gap-4">
          <div>
            <div className="text-xs uppercase tracking-widest opacity-80">
              لوحة التحكم
            </div>
            <div className="text-3xl font-black mt-1">أهلاً بك 👋</div>
            <div className="text-sm opacity-90 mt-1">
              {dayStr} · {dateStr}
            </div>
          </div>
          <div className="text-left">
            <div className="text-xs opacity-80 mb-1">صافي ربح الشهر</div>
            <div
              className={`text-3xl font-black ${
                Number(pl?.net_profit || 0) >= 0
                  ? 'text-emerald-200'
                  : 'text-rose-200'
              }`}
            >
              {EGP.format(Number(pl?.net_profit || 0))}
            </div>
            <div className="text-xs opacity-80 mt-1">
              هامش {Number(pl?.net_margin_pct || 0).toFixed(1)}% ·{' '}
              {Number(pl?.invoice_count || 0)} فاتورة
            </div>
          </div>
        </div>
      </div>

      {/* ═════ KPIs ═════ */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPI
          icon={DollarSign}
          label="إيرادات اليوم"
          value={EGP.format(Number(todayData.revenue || 0))}
          hint={`${NUM(Number(todayData.invoice_count || 0))} فاتورة`}
          tone="emerald"
        />
        <KPI
          icon={Target}
          label="ربح اليوم"
          value={EGP.format(Number(todayData.profit || 0))}
          hint={`متوسط ${EGP.format(Number(todayData.avg_invoice || 0))}`}
          tone="indigo"
        />
        <KPI
          icon={ShoppingBag}
          label="القطع المباعة"
          value={NUM(Number(todayData.items_sold || 0))}
          hint="اليوم"
          tone="pink"
        />
        <KPI
          icon={Users}
          label="عملاء جدد"
          value={NUM(Number(todayData.new_customers || 0))}
          hint="اليوم"
          tone="amber"
        />
      </div>

      {/* ═════ Smart Recommendations ═════ */}
      {recs.length > 0 && (
        <div className="card p-5 border-2 border-dashed border-brand-200 bg-gradient-to-br from-brand-50 to-white">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-amber-400 to-pink-500 flex items-center justify-center shadow-md">
              <Lightbulb size={18} className="text-white" />
            </div>
            <div>
              <div className="font-black text-slate-800">توصيات ذكية</div>
              <div className="text-xs text-slate-500">
                {recs.length} توصية مرتبة حسب الأولوية
              </div>
            </div>
            <div className="mr-auto flex items-center gap-1 text-xs text-brand-700">
              <Sparkles size={14} /> محدّثة الآن
            </div>
          </div>
          <div className="grid md:grid-cols-2 gap-3">
            {recs.map((r) => (
              <RecommendationCard key={r.id} rec={r} />
            ))}
          </div>
        </div>
      )}

      {/* ═════ Revenue + Payment Mix ═════ */}
      <div className="grid lg:grid-cols-3 gap-6">
        <div className="card p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h3 className="font-black text-slate-800">
                الإيرادات — آخر 30 يوم
              </h3>
              <div className="text-xs text-slate-500 mt-0.5">
                {revenue.length} يوم نشط
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs text-slate-500">إجمالي</div>
              <div className="font-black text-brand-600">
                {EGP.format(
                  revenue.reduce(
                    (s: number, r: any) => s + Number(r.revenue || 0),
                    0,
                  ),
                )}
              </div>
            </div>
          </div>
          <Line
            data={{
              labels: revenue.map((r: any) => shortDate(r.day)),
              datasets: [
                {
                  label: 'إيراد',
                  data: revenue.map((r: any) => Number(r.revenue || 0)),
                  borderColor: '#ec4899',
                  backgroundColor: 'rgba(236, 72, 153, 0.15)',
                  fill: true,
                  tension: 0.35,
                  pointRadius: 2,
                  borderWidth: 2,
                },
              ],
            }}
            options={{
              responsive: true,
              plugins: { legend: { display: false } },
              scales: {
                y: {
                  beginAtZero: true,
                  ticks: { callback: (v) => NUM(Number(v)) },
                },
              },
            }}
            height={140}
          />
        </div>

        <div className="card p-5">
          <h3 className="font-black text-slate-800 mb-4">توزيع طرق الدفع</h3>
          {mix.length > 0 ? (
            <Doughnut
              data={{
                labels: mix.map((m: any) => {
                  const ar: Record<string, string> = {
                    cash: 'كاش',
                    card: 'كارت',
                    instapay: 'إنستاباي',
                    bank_transfer: 'تحويل',
                  };
                  return ar[m.method] || m.method;
                }),
                datasets: [
                  {
                    data: mix.map((m: any) => Number(m.total || 0)),
                    backgroundColor: [
                      '#10b981',
                      '#6366f1',
                      '#ec4899',
                      '#f59e0b',
                    ],
                    borderWidth: 0,
                  },
                ],
              }}
              options={{ plugins: { legend: { position: 'bottom' } } }}
              height={220}
            />
          ) : (
            <div className="text-center text-slate-400 py-8 text-sm">
              لا توجد بيانات بعد
            </div>
          )}
        </div>
      </div>

      {/* ═════ Top products + Cashier performance ═════ */}
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="card p-5">
          <h3 className="font-black text-slate-800 flex items-center gap-2 mb-4">
            <Award size={18} className="text-amber-500" />
            أفضل المنتجات — آخر 30 يوم
          </h3>
          {products.length > 0 ? (
            <div className="space-y-2">
              {products.slice(0, 6).map((p: any, i: number) => (
                <div
                  key={p.product_id || i}
                  className="flex items-center justify-between p-2 rounded-lg hover:bg-slate-50"
                >
                  <div className="flex items-center gap-3">
                    <div
                      className={`w-8 h-8 rounded-lg flex items-center justify-center font-black text-sm ${
                        i === 0
                          ? 'bg-amber-100 text-amber-700'
                          : i === 1
                            ? 'bg-slate-100 text-slate-700'
                            : i === 2
                              ? 'bg-orange-100 text-orange-700'
                              : 'bg-slate-50 text-slate-500'
                      }`}
                    >
                      {i + 1}
                    </div>
                    <div>
                      <div className="font-bold text-sm text-slate-800">
                        {p.name_ar || p.product_name || '—'}
                      </div>
                      <div className="text-xs text-slate-500">
                        {NUM(Number(p.units_sold || 0))} قطعة
                      </div>
                    </div>
                  </div>
                  <div className="text-sm font-bold text-brand-600">
                    {EGP.format(Number(p.revenue || 0))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-center text-slate-400 py-6 text-sm">
              لا توجد مبيعات بعد
            </div>
          )}
        </div>

        <div className="card p-5">
          <h3 className="font-black text-slate-800 flex items-center gap-2 mb-4">
            <Activity size={18} className="text-indigo-500" />
            أداء الكاشيرين
          </h3>
          {cashiers.length > 0 ? (
            <Bar
              data={{
                labels: cashiers.map(
                  (c: any) => c.full_name || c.username || '—',
                ),
                datasets: [
                  {
                    label: 'إيراد',
                    data: cashiers.map((c: any) => Number(c.revenue || 0)),
                    backgroundColor: '#6366f1',
                    borderRadius: 6,
                  },
                ],
              }}
              options={{
                responsive: true,
                plugins: { legend: { display: false } },
                scales: {
                  y: {
                    beginAtZero: true,
                    ticks: { callback: (v) => NUM(Number(v)) },
                  },
                },
              }}
              height={220}
            />
          ) : (
            <div className="text-center text-slate-400 py-10 text-sm">
              لا توجد بيانات الكاشيرين بعد
            </div>
          )}
        </div>
      </div>

      {/* ═════ Returns widget ═════ */}
      <ReturnsWidget />
    </div>
  );
}

function KPI({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: any;
  label: string;
  value: string | number;
  hint?: string;
  tone: 'emerald' | 'indigo' | 'pink' | 'amber';
}) {
  const bg = {
    emerald: 'from-emerald-500 to-teal-600 shadow-emerald-500/30',
    indigo: 'from-indigo-500 to-blue-600 shadow-indigo-500/30',
    pink: 'from-pink-500 to-rose-600 shadow-pink-500/30',
    amber: 'from-amber-500 to-orange-600 shadow-amber-500/30',
  }[tone];
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-3">
        <div
          className={`w-10 h-10 rounded-xl bg-gradient-to-br ${bg} flex items-center justify-center shadow-lg`}
        >
          <Icon size={18} className="text-white" />
        </div>
        <div className="text-xs text-slate-500 text-left">{label}</div>
      </div>
      <div className="text-2xl font-black text-slate-800">{value}</div>
      {hint && <div className="text-xs text-slate-500 mt-1">{hint}</div>}
    </div>
  );
}

function RecommendationCard({ rec }: { rec: any }) {
  const Icon = rec.icon;
  const priorityStyle = {
    critical: 'bg-rose-50 border-rose-200 text-rose-900',
    high: 'bg-amber-50 border-amber-200 text-amber-900',
    medium: 'bg-indigo-50 border-indigo-200 text-indigo-900',
    low: 'bg-emerald-50 border-emerald-200 text-emerald-900',
  }[rec.priority as 'critical' | 'high' | 'medium' | 'low'];
  const iconStyle = {
    critical: 'bg-rose-200 text-rose-700',
    high: 'bg-amber-200 text-amber-700',
    medium: 'bg-indigo-200 text-indigo-700',
    low: 'bg-emerald-200 text-emerald-700',
  }[rec.priority as 'critical' | 'high' | 'medium' | 'low'];
  const label = {
    critical: 'حرج',
    high: 'مهم',
    medium: 'ملاحظة',
    low: 'جيد',
  }[rec.priority as 'critical' | 'high' | 'medium' | 'low'];
  return (
    <div className={`rounded-xl border p-4 ${priorityStyle}`}>
      <div className="flex items-start gap-3">
        <div
          className={`w-10 h-10 rounded-lg flex items-center justify-center shrink-0 ${iconStyle}`}
        >
          <Icon size={18} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-black">{rec.title}</span>
            <span className="chip text-[10px] bg-white/60">{label}</span>
          </div>
          <div className="text-sm opacity-80">{rec.detail}</div>
          {rec.action && (
            <a
              href={rec.action.to}
              className="inline-flex items-center gap-1 text-xs font-bold mt-2 hover:underline"
            >
              {rec.action.label} <ArrowUpRight size={12} />
            </a>
          )}
        </div>
      </div>
    </div>
  );
}
