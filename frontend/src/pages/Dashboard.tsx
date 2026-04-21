import { useMemo, useState } from 'react';
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
import { useAuthStore } from '@/stores/auth.store';
import { ReturnsWidget } from '@/components/dashboard/ReturnsWidget';
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

function useRecommendations(data: any, pl: any, periodLabel = 'هذه الفترة') {
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

    if (pl) {
      // Drive headline from the actual sign of net_profit, not just the
      // backend's analytical label — negative always means loss.
      const np = Number(pl.net_profit) || 0;
      if (np < 0) {
        recs.push({
          id: 'pl-loss',
          priority: 'critical',
          icon: TrendingDown,
          title: `خسارة ${periodLabel}: ${EGP.format(Math.abs(np))}`,
          detail:
            pl.analysis?.reasons?.[0]?.message ||
            'راجع المصروفات والإيرادات لمعرفة السبب.',
          action: { to: '/accounting', label: 'افتح تقرير الأرباح' },
        });
      } else if (np > 0) {
        recs.push({
          id: 'pl-profit',
          priority: 'low',
          icon: TrendingUp,
          title: `ربح ${periodLabel}: ${EGP.format(np)}`,
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
    refetchInterval: 15_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const [period, setPeriod] = useState<PeriodRange>(() =>
    resolvePeriod('day'),
  );

  const { data: pl } = useQuery({
    queryKey: ['dashboard-pl', period.from, period.to],
    queryFn: () =>
      accountingApi.profitAndLossAnalysis({
        from: period.from,
        to: period.to,
      }),
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const { data: analytics } = useQuery({
    queryKey: ['dashboard-analytics', period.from, period.to],
    queryFn: () => dashboardApi.analytics(period.from, period.to),
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
    refetchOnReconnect: true,
  });

  const periodNoun = {
    day: 'اليوم',
    week: 'الأسبوع',
    month: 'الشهر',
    year: 'السنة',
    custom: 'الفترة',
  }[period.key];

  const recs = useRecommendations(data, pl, periodNoun);

  if (isLoading) {
    return (
      <div className="card p-12 text-center text-slate-500">جارٍ التحميل...</div>
    );
  }

  const todayData = data?.today || ({} as any);
  const revenue = data?.revenue30 || [];
  const mix = data?.paymentMix || [];
  // Prefer period-aware perf from analytics; fall back to the legacy
  // overview arrays if analytics hasn't loaded yet.
  const cashiers = analytics?.cashierPerf ?? data?.cashierPerf ?? [];
  const salespeople = analytics?.salespersonPerf ?? data?.salespersonPerf ?? [];
  const products = data?.topProducts || [];

  const authUser = useAuthStore((s) => s.user);
  const displayName =
    authUser?.full_name || authUser?.username || 'بك';

  const now = new Date();
  const dayStr = now.toLocaleDateString('ar-EG-u-ca-gregory', {
    weekday: 'long',
  });
  const dateStr = now.toLocaleDateString('en-GB');

  // Cairo hour for time-of-day greeting.
  const cairoHour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Africa/Cairo',
      hour: '2-digit',
      hour12: false,
    }).format(now),
  );
  // Before noon Cairo = صباح الخير, from noon onwards = مساء الخير.
  const greeting = cairoHour < 12 ? 'صباح الخير' : 'مساء الخير';

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
            <div className="text-3xl font-black mt-1">
              {greeting} {displayName} 👋
            </div>
          </div>
          <div className="text-left">
            {(() => {
              const np = Number(pl?.net_profit || 0);
              const loss = np < 0;
              return (
                <>
                  <div className="text-xs opacity-80 mb-1">
                    {loss
                      ? `صافي خسارة ${periodNoun}`
                      : `صافي ربح ${periodNoun}`}
                  </div>
                  <div
                    className={`text-3xl font-black ${
                      loss ? 'text-rose-200' : 'text-emerald-200'
                    }`}
                  >
                    {EGP.format(Math.abs(np))}
                  </div>
                </>
              );
            })()}
            <div className="text-xs opacity-80 mt-1">
              {(() => {
                const m = Number(pl?.net_margin_pct || 0);
                return (
                  <>
                    {m < 0 ? 'هامش خسارة' : 'هامش'} {m.toFixed(1)}%
                  </>
                );
              })()}{' '}
              · {Number(pl?.invoice_count || 0)} فاتورة
            </div>
          </div>
        </div>
        <div className="relative mt-4 bg-white/10 rounded-lg p-2 backdrop-blur-sm">
          <PeriodSelector
            value={period}
            onChange={setPeriod}
            className="text-white [&_.bg-slate-100]:bg-white/20 [&_button]:text-white [&_button:hover]:text-white [&_.bg-white]:bg-white [&_.bg-white]:text-indigo-700"
          />
        </div>
      </div>

      {/* ═════ Period analytics hero — revenue / profit / expenses / returns / discounts ═════ */}
      {analytics?.totals && (() => {
        const t = analytics.totals;
        const rev = Number(t.revenue || 0);
        const invCount = Number(t.invoices || 0);
        const pct = (n: number) => (rev > 0 ? `${((n / rev) * 100).toFixed(1)}%` : '—');
        const avg = invCount > 0 ? rev / invCount : 0;
        const discInvShare = invCount > 0 ? ((Number(t.discount_invoices || 0) / invCount) * 100).toFixed(1) : '0';
        return (
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            <AnalyticsCell
              label={`إيرادات ${periodNoun}`}
              value={EGP.format(rev)}
              tone="indigo"
              hint={`${NUM(invCount)} فاتورة · متوسط ${EGP.format(avg)}`}
            />
            <AnalyticsCell
              label="ربح إجمالي"
              value={EGP.format(Number(t.profit || 0))}
              tone="emerald"
              hint={`هامش ${Number(t.margin_pct || 0).toFixed(1)}% · ${NUM(Number(t.units_sold || 0))} قطعة`}
            />
            <AnalyticsCell
              label="مصاريف"
              value={EGP.format(Number(t.expenses || 0))}
              tone="amber"
              hint={`${NUM(Number(t.expense_count || 0))} بند · ${pct(Number(t.expenses || 0))} من الإيراد`}
            />
            <AnalyticsCell
              label="مرتجعات"
              value={EGP.format(Number(t.returns_amount || 0))}
              tone="rose"
              hint={`${NUM(Number(t.returns_count || 0))} عملية · ${pct(Number(t.returns_amount || 0))} من الإيراد`}
            />
            <AnalyticsCell
              label="إجمالي الخصومات"
              value={EGP.format(Number(t.discounts || 0))}
              tone="violet"
              hint={`بعد الخصم ${EGP.format(rev)} · ${pct(Number(t.discounts || 0))} من الإيراد`}
            />
            <AnalyticsCell
              label="فواتير الخصم"
              value={NUM(Number(t.discount_invoices || 0))}
              tone="violet"
              hint={`${discInvShare}% من إجمالي الفواتير`}
            />
          </div>
        );
      })()}

      {/* ═════ KPIs ═════ */}
      <div className="grid grid-cols-2 gap-4">
        <KPI
          icon={ShoppingBag}
          label="القطع المباعة"
          value={NUM(
            Number(analytics?.totals?.units_sold ?? todayData.items_sold ?? 0),
          )}
          hint={periodNoun}
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
                  const key = m.payment_method || m.method;
                  const ar: Record<string, string> = {
                    cash: 'كاش',
                    card: 'كارت',
                    card_visa: 'فيزا',
                    card_mastercard: 'ماستركارد',
                    card_meeza: 'ميزة',
                    instapay: 'إنستاباي',
                    vodafone_cash: 'فودافون كاش',
                    orange_cash: 'أورانج كاش',
                    bank_transfer: 'تحويل بنكي',
                    credit: 'آجل',
                    other: 'أخرى',
                  };
                  return ar[key] || key;
                }),
                datasets: [
                  {
                    data: mix.map((m: any) => Number(m.total_amount ?? m.total ?? 0)),
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

      {/* ═════ Smart analysis panel + Cashier performance ═════ */}
      <div className="grid lg:grid-cols-2 gap-6">
        <SmartAnalysisPanel
          data={data}
          pl={pl}
          analytics={analytics}
          period={period}
          periodNoun={periodNoun}
        />

        <div className="card p-5">
          <h3 className="font-black text-slate-800 flex items-center gap-2 mb-4">
            <Activity size={18} className="text-indigo-500" />
            أداء الكاشيرين — {periodNoun}
          </h3>
          {cashiers.length > 0 ? (
            <Bar
              data={{
                labels: cashiers.map(
                  (c: any) => c.full_name || c.username || '—',
                ),
                datasets: [
                  {
                    label: `إيراد ${periodNoun}`,
                    data: cashiers.map((c: any) =>
                      Number(c.revenue ?? c.revenue_week ?? 0),
                    ),
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

      {/* ═════ Salesperson performance ═════ */}
      <div className="card p-5">
        <h3 className="font-black text-slate-800 flex items-center gap-2 mb-4">
          <Award size={18} className="text-emerald-500" />
          أداء البائعين — {periodNoun}
        </h3>
        {salespeople.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="p-2 text-right">#</th>
                  <th className="p-2 text-right">البائع</th>
                  <th className="p-2 text-center">عدد الفواتير</th>
                  <th className="p-2 text-left">الإيراد</th>
                  <th className="p-2 text-left">الربح</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {salespeople.map((s: any, i: number) => (
                  <tr key={s.user_id || i} className="hover:bg-slate-50">
                    <td className="p-2 text-slate-400 font-bold">{i + 1}</td>
                    <td className="p-2 font-semibold text-slate-800">
                      {s.full_name || s.username || '—'}
                    </td>
                    <td className="p-2 text-center text-slate-600">
                      {NUM(Number(s.invoices || 0))}
                    </td>
                    <td className="p-2 text-left font-bold text-brand-700">
                      {EGP.format(Number(s.revenue || 0))}
                    </td>
                    <td className="p-2 text-left font-bold text-emerald-600">
                      {EGP.format(Number(s.profit || 0))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="text-center text-slate-400 py-8 text-sm">
            لا توجد بيانات البائعين بعد
          </div>
        )}
      </div>

      {/* ═════ Best / worst / losing products — based on period ═════ */}
      {analytics && (analytics.topProducts?.length > 0 || analytics.losingProducts?.length > 0) && (
        <div className="grid lg:grid-cols-3 gap-4">
          <ProductPerfPanel
            title="الأفضل ربحاً"
            accent="emerald"
            icon={Award}
            rows={analytics.topProducts || []}
          />
          <ProductPerfPanel
            title="الأدنى ربحاً"
            accent="amber"
            icon={Activity}
            rows={analytics.worstProducts || []}
          />
          <ProductPerfPanel
            title="منتجات خاسرة"
            accent="rose"
            icon={Activity}
            rows={analytics.losingProducts || []}
            emptyText="لا توجد منتجات خاسرة 🎉"
          />
        </div>
      )}

      {/* ═════ Returns widget ═════ */}
      <ReturnsWidget from={period.from} to={period.to} label={periodNoun} />
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

/* ─── small helpers for the period analytics section ─────────────────── */
function AnalyticsCell({
  label, value, hint, tone,
}: { label: string; value: string; hint?: string; tone: 'indigo' | 'emerald' | 'amber' | 'rose' | 'violet' }) {
  const bg = {
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    rose: 'bg-rose-50 border-rose-200 text-rose-700',
    violet: 'bg-violet-50 border-violet-200 text-violet-700',
  }[tone];
  return (
    <div className={`rounded-xl border p-3 ${bg}`}>
      <div className="text-[11px] font-bold opacity-80">{label}</div>
      <div className="text-xl font-black mt-1 truncate">{value}</div>
      {hint && <div className="text-[10px] opacity-70 mt-0.5">{hint}</div>}
    </div>
  );
}

function ProductPerfPanel({
  title, accent, icon: Icon, rows, emptyText,
}: {
  title: string;
  accent: 'emerald' | 'amber' | 'rose';
  icon: any;
  rows: any[];
  emptyText?: string;
}) {
  const accentCls = {
    emerald: 'text-emerald-600',
    amber: 'text-amber-600',
    rose: 'text-rose-600',
  }[accent];
  return (
    <div className="card p-5">
      <h3 className="font-black text-slate-800 flex items-center gap-2 mb-4">
        <Icon size={18} className={accentCls} />
        {title}
      </h3>
      {rows.length > 0 ? (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-slate-500">
              <tr>
                <th className="text-right p-1">#</th>
                <th className="text-right p-1">المنتج</th>
                <th className="text-center p-1">باع</th>
                <th className="text-left p-1">الربح</th>
                <th className="text-left p-1">هامش%</th>
                <th className="text-left p-1">% من الإجمالي</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((p, i) => {
                const profit = Number(p.profit || 0);
                const margin = Number(p.margin_pct || 0);
                const share = Number(p.profit_share_pct || 0);
                return (
                  <tr key={p.product_id || i} className="hover:bg-slate-50">
                    <td className="p-1 text-slate-400 font-bold">{i + 1}</td>
                    <td className="p-1 font-semibold text-slate-800 max-w-[160px] truncate">
                      {p.name_ar || '—'}
                    </td>
                    <td className="p-1 text-center">{p.units_sold}</td>
                    <td className={`p-1 text-left font-bold ${profit < 0 ? 'text-rose-600' : 'text-emerald-600'}`}>
                      {EGP.format(profit)}
                    </td>
                    <td className={`p-1 text-left ${margin < 0 ? 'text-rose-500' : ''}`}>
                      {margin.toFixed(1)}%
                    </td>
                    <td className="p-1 text-left text-slate-500">{share.toFixed(2)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="text-center text-slate-400 py-6 text-sm">
          {emptyText || 'لا توجد بيانات للفترة المختارة'}
        </div>
      )}
    </div>
  );
}

/* ─── Smart analysis panel — rule-based insights per selected period ─── */
function SmartAnalysisPanel({
  data, pl, analytics, period, periodNoun,
}: {
  data: any; pl: any; analytics: any;
  period: PeriodRange; periodNoun: string;
}) {
  const insights = useMemo(() => {
    const out: Array<{
      level: 'good' | 'warn' | 'bad' | 'info';
      icon: any;
      title: string;
      detail: string;
    }> = [];
    const t = analytics?.totals;
    if (!t) return out;

    const revenue = Number(t.revenue || 0);
    const profit = Number(t.profit || 0);
    const margin = Number(t.margin_pct || 0);
    const expenses = Number(t.expenses || 0);
    const returnsAmt = Number(t.returns_amount || 0);
    const net = Number(t.net || 0);
    const invoices = Number(t.invoices || 0);
    const discounts = Number(t.discounts || 0);
    const aov = invoices > 0 ? revenue / invoices : 0;

    // Headline: profit vs loss
    if (net < 0) {
      out.push({
        level: 'bad',
        icon: TrendingDown,
        title: `صافي خسارة ${EGP.format(Math.abs(net))} في ${periodNoun}`,
        detail:
          profit < 0
            ? 'الإيراد أقل من تكلفة البضاعة — راجع أسعار البيع وسياسة الخصم.'
            : `الربح الإجمالي ${EGP.format(profit)}، لكن المصاريف والمرتجعات (${EGP.format(expenses + returnsAmt)}) ابتلعت الأرباح.`,
      });
    } else if (net > 0) {
      out.push({
        level: 'good',
        icon: TrendingUp,
        title: `ربح صافي ${EGP.format(net)}`,
        detail: `هامش إجمالي ${margin.toFixed(1)}% على ${invoices} فاتورة.`,
      });
    }

    // Margin assessment
    if (revenue > 0) {
      if (margin < 15 && margin >= 0) {
        out.push({
          level: 'warn',
          icon: Target,
          title: `هامش ربح ضعيف: ${margin.toFixed(1)}%`,
          detail: 'الهامش الصحي للأحذية/الحقائب عادةً 25-40%. راجع الخصومات أو أسعار الشراء.',
        });
      } else if (margin >= 30) {
        out.push({
          level: 'good',
          icon: Target,
          title: `هامش ربح ممتاز: ${margin.toFixed(1)}%`,
          detail: 'معدل الربحية أعلى من المتوسط في القطاع.',
        });
      }
    }

    // Discount share
    if (revenue > 0 && discounts / revenue > 0.15) {
      out.push({
        level: 'warn',
        icon: ArrowDownRight,
        title: `الخصومات ${((discounts / revenue) * 100).toFixed(0)}% من المبيعات`,
        detail: `إجمالي الخصومات ${EGP.format(discounts)} — كم منها خصم مُعتمد وكم ضياع غير محسوب؟`,
      });
    }

    // Returns rate
    if (revenue > 0 && returnsAmt > 0) {
      const rate = (returnsAmt / revenue) * 100;
      if (rate >= 5) {
        out.push({
          level: 'bad',
          icon: TrendingDown,
          title: `معدل مرتجعات ${rate.toFixed(1)}% (${EGP.format(returnsAmt)})`,
          detail: 'المعدل المقلق أكثر من 5%. راجع أسباب الإرجاع في تحليلات المرتجعات.',
        });
      }
    }

    // AOV insight
    if (invoices >= 5 && aov > 0) {
      out.push({
        level: 'info',
        icon: DollarSign,
        title: `متوسط قيمة الفاتورة: ${EGP.format(aov)}`,
        detail: `${invoices} فاتورة بإيراد ${EGP.format(revenue)}.`,
      });
    } else if (invoices === 0) {
      out.push({
        level: 'info',
        icon: Activity,
        title: 'لا توجد فواتير في هذه الفترة',
        detail: 'اختر فترة أطول أو افتح نقطة البيع.',
      });
    }

    // Losing products callout
    const losing = analytics?.losingProducts || [];
    if (losing.length > 0) {
      const top = losing[0];
      out.push({
        level: 'bad',
        icon: AlertTriangle,
        title: `${losing.length} منتج بيع بخسارة`,
        detail: `الأسوأ: "${top.name_ar}" بخسارة ${EGP.format(Math.abs(Number(top.profit)))}. اضبط سعر البيع.`,
      });
    }

    // Best performer
    const best = (analytics?.topProducts || [])[0];
    if (best && Number(best.profit) > 0) {
      out.push({
        level: 'good',
        icon: Award,
        title: `المنتج الأربح: ${best.name_ar}`,
        detail: `${NUM(Number(best.units_sold))} قطعة، ربح ${EGP.format(Number(best.profit))} (${Number(best.profit_share_pct).toFixed(1)}% من إجمالي الربح).`,
      });
    }

    // Low stock echo from overview
    const lowStock = data?.lowStock || [];
    if (lowStock.length > 0) {
      out.push({
        level: 'warn',
        icon: Package,
        title: `${lowStock.length} صنف على وشك النفاد`,
        detail: `${lowStock[0]?.product_name || ''} — المتبقي ${lowStock[0]?.quantity ?? 0}`,
      });
    }

    // Expenses warning
    if (expenses > 0 && revenue > 0 && expenses / revenue > 0.3) {
      out.push({
        level: 'warn',
        icon: AlertTriangle,
        title: `المصاريف ${((expenses / revenue) * 100).toFixed(0)}% من المبيعات`,
        detail: `مصاريف ${EGP.format(expenses)} — راجع المصروفات الثابتة.`,
      });
    }

    return out;
  }, [analytics, data, pl, periodNoun]);

  const toneMap: Record<string, string> = {
    good: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    warn: 'bg-amber-50 border-amber-200 text-amber-800',
    bad: 'bg-rose-50 border-rose-200 text-rose-800',
    info: 'bg-slate-50 border-slate-200 text-slate-700',
  };
  const iconMap: Record<string, string> = {
    good: 'bg-emerald-100 text-emerald-600',
    warn: 'bg-amber-100 text-amber-600',
    bad: 'bg-rose-100 text-rose-600',
    info: 'bg-slate-100 text-slate-600',
  };

  return (
    <div className="card p-5">
      <h3 className="font-black text-slate-800 flex items-center gap-2 mb-4">
        <Sparkles size={18} className="text-violet-500" />
        التحليل الذكي — {periodNoun}
      </h3>
      {insights.length === 0 ? (
        <div className="text-center text-slate-400 py-6 text-sm">
          لا توجد مؤشرات كافية للتحليل في هذه الفترة
        </div>
      ) : (
        <div className="space-y-2 max-h-[420px] overflow-y-auto pr-1">
          {insights.map((ins, i) => {
            const Icon = ins.icon;
            return (
              <div
                key={i}
                className={`flex items-start gap-3 rounded-lg border p-3 ${toneMap[ins.level]}`}
              >
                <div className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${iconMap[ins.level]}`}>
                  <Icon size={16} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="font-bold text-sm">{ins.title}</div>
                  <div className="text-xs opacity-80 mt-0.5">{ins.detail}</div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
