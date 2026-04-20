import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Undo2,
  TrendingDown,
  AlertTriangle,
  Package,
  Clock,
  Percent,
} from 'lucide-react';
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
import { Line, Doughnut, Bar } from 'react-chartjs-2';
import {
  returnsAnalyticsApi,
  REASON_LABELS_AR,
  CONDITION_LABELS_AR,
} from '@/api/returnsAnalytics.api';

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

function KPI({ icon: Icon, label, value, hint, color }: any) {
  return (
    <div className="card p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-sm text-slate-500 font-semibold">{label}</div>
          <div className="text-2xl font-black text-slate-800 mt-1">{value}</div>
          {hint && <div className="text-xs text-slate-400 mt-1">{hint}</div>}
        </div>
        <div className={`p-3 rounded-xl ${color}`}>
          <Icon size={22} className="text-white" />
        </div>
      </div>
    </div>
  );
}

export default function ReturnsAnalytics() {
  const [trendType, setTrendType] = useState<'daily' | 'monthly'>('monthly');

  const { data, isLoading } = useQuery({
    queryKey: ['returns-analytics'],
    queryFn: () => returnsAnalyticsApi.all(),
    refetchInterval: 60_000,
  });

  const summary = data?.summary as any;
  const byReason = data?.byReason || [];
  const topProducts = data?.topProducts || [];
  const trendMonthly = data?.trendMonthly || [];
  const trendDaily = data?.trendDaily || [];
  const byCondition = data?.byCondition || [];

  const trendData = trendType === 'monthly' ? trendMonthly : trendDaily;

  const reasonChart = useMemo(
    () => ({
      labels: byReason.map(
        (r: any) => REASON_LABELS_AR[r.reason] || r.reason,
      ),
      datasets: [
        {
          data: byReason.map((r: any) => Number(r.return_count || 0)),
          backgroundColor: [
            '#ef4444',
            '#f59e0b',
            '#8b5cf6',
            '#06b6d4',
            '#ec4899',
            '#64748b',
          ],
        },
      ],
    }),
    [byReason],
  );

  const conditionChart = useMemo(
    () => ({
      labels: byCondition.map(
        (c: any) => CONDITION_LABELS_AR[c.condition] || c.condition,
      ),
      datasets: [
        {
          data: byCondition.map((c: any) => Number(c.qty || 0)),
          backgroundColor: ['#10b981', '#f59e0b', '#ef4444'],
        },
      ],
    }),
    [byCondition],
  );

  if (isLoading) {
    return (
      <div className="card p-12 text-center text-slate-500">
        جارٍ التحميل...
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-black text-slate-800">تحليل المرتجعات</h1>
          <p className="text-sm text-slate-500 mt-1">
            نظرة شاملة على أسباب المرتجعات والمنتجات الأكثر إرجاعاً
          </p>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KPI
          icon={Undo2}
          label="مرتجعات آخر 30 يوم"
          value={summary?.count_30d || 0}
          hint={EGP.format(Number(summary?.net_refund_30d || 0))}
          color="bg-gradient-to-br from-rose-500 to-red-600"
        />
        <KPI
          icon={TrendingDown}
          label="نسبة الإرجاع"
          value={`${Number(summary?.return_rate_30d || 0).toFixed(2)}%`}
          hint="آخر 30 يوم"
          color="bg-gradient-to-br from-amber-500 to-orange-600"
        />
        <KPI
          icon={Clock}
          label="مرتجعات معلّقة"
          value={summary?.pending_count || 0}
          hint={EGP.format(Number(summary?.pending_amount || 0))}
          color="bg-gradient-to-br from-indigo-500 to-blue-600"
        />
        <KPI
          icon={Percent}
          label="إجمالي المسترد"
          value={EGP.format(Number(summary?.total_net_refund || 0))}
          hint={`${summary?.total_count || 0} مرتجع`}
          color="bg-gradient-to-br from-purple-500 to-pink-600"
        />
      </div>

      {/* Reason + Condition */}
      <div className="grid lg:grid-cols-2 gap-6">
        <div className="card p-5">
          <h3 className="font-black text-slate-800 mb-4 flex items-center gap-2">
            <AlertTriangle size={18} className="text-rose-500" />
            أسباب المرتجعات
          </h3>
          {byReason.length === 0 ? (
            <div className="text-center text-slate-400 py-12">
              لا توجد بيانات
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 items-center">
              <Doughnut
                data={reasonChart}
                options={{ plugins: { legend: { display: false } } }}
              />
              <div className="space-y-2 text-sm">
                {byReason.map((r: any, i: number) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="inline-block w-3 h-3 rounded-full flex-shrink-0"
                        style={{
                          backgroundColor:
                            reasonChart.datasets[0].backgroundColor[i],
                        }}
                      />
                      <span className="font-semibold text-slate-700 truncate">
                        {REASON_LABELS_AR[r.reason] || r.reason}
                      </span>
                    </div>
                    <span className="chip bg-slate-100 text-slate-700">
                      {r.return_count}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="card p-5">
          <h3 className="font-black text-slate-800 mb-4 flex items-center gap-2">
            <Package size={18} className="text-indigo-500" />
            حالة البضاعة المرتجعة
          </h3>
          {byCondition.length === 0 ? (
            <div className="text-center text-slate-400 py-12">
              لا توجد بيانات
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4 items-center">
              <Doughnut
                data={conditionChart}
                options={{ plugins: { legend: { display: false } } }}
              />
              <div className="space-y-2 text-sm">
                {byCondition.map((c: any, i: number) => (
                  <div
                    key={i}
                    className="flex items-center justify-between gap-2"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="inline-block w-3 h-3 rounded-full flex-shrink-0"
                        style={{
                          backgroundColor:
                            conditionChart.datasets[0].backgroundColor[i],
                        }}
                      />
                      <span className="font-semibold text-slate-700 truncate">
                        {CONDITION_LABELS_AR[c.condition] || c.condition}
                      </span>
                    </div>
                    <span className="chip bg-slate-100 text-slate-700">
                      {c.qty} ({Number(c.pct_of_total).toFixed(1)}%)
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Trend */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-black text-slate-800">اتجاه المرتجعات</h3>
          <div className="flex bg-slate-100 rounded-lg p-1 text-sm">
            <button
              onClick={() => setTrendType('monthly')}
              className={`px-3 py-1 rounded ${
                trendType === 'monthly'
                  ? 'bg-white shadow font-semibold text-brand-700'
                  : 'text-slate-600'
              }`}
            >
              شهري
            </button>
            <button
              onClick={() => setTrendType('daily')}
              className={`px-3 py-1 rounded ${
                trendType === 'daily'
                  ? 'bg-white shadow font-semibold text-brand-700'
                  : 'text-slate-600'
              }`}
            >
              يومي
            </button>
          </div>
        </div>
        {trendData.length === 0 ? (
          <div className="text-center text-slate-400 py-12">لا توجد بيانات</div>
        ) : (
          <Line
            data={{
              labels: trendData.map(
                (t: any) => t.month || t.day?.substring(5) || '',
              ),
              datasets: [
                {
                  label: 'عدد المرتجعات',
                  data: trendData.map((t: any) => Number(t.return_count || 0)),
                  borderColor: '#ef4444',
                  backgroundColor: 'rgba(239, 68, 68, 0.1)',
                  fill: true,
                  tension: 0.35,
                  pointRadius: 3,
                  yAxisID: 'y',
                },
                {
                  label: 'المبلغ المسترد (EGP)',
                  data: trendData.map((t: any) => Number(t.net_refund || 0)),
                  borderColor: '#8b5cf6',
                  backgroundColor: 'rgba(139, 92, 246, 0.1)',
                  fill: false,
                  tension: 0.35,
                  pointRadius: 3,
                  yAxisID: 'y1',
                },
              ],
            }}
            options={{
              responsive: true,
              interaction: { mode: 'index' as const, intersect: false },
              plugins: { legend: { position: 'top' as const } },
              scales: {
                y: {
                  type: 'linear' as const,
                  position: 'left' as const,
                  beginAtZero: true,
                  title: { display: true, text: 'عدد' },
                },
                y1: {
                  type: 'linear' as const,
                  position: 'right' as const,
                  beginAtZero: true,
                  grid: { drawOnChartArea: false },
                  title: { display: true, text: 'EGP' },
                },
              },
            }}
            height={80}
          />
        )}
      </div>

      {/* Top returned products */}
      <div className="card p-5">
        <h3 className="font-black text-slate-800 mb-4">
          أعلى المنتجات مرتجعة
        </h3>
        {topProducts.length === 0 ? (
          <div className="text-center text-slate-400 py-12">لا توجد بيانات</div>
        ) : (
          <div className="grid lg:grid-cols-2 gap-6">
            <Bar
              data={{
                labels: topProducts
                  .slice(0, 8)
                  .map((p: any) => p.name_ar || p.sku),
                datasets: [
                  {
                    label: 'الكمية المرتجعة',
                    data: topProducts
                      .slice(0, 8)
                      .map((p: any) => Number(p.returned_qty || 0)),
                    backgroundColor: '#ef4444',
                    borderRadius: 8,
                  },
                ],
              }}
              options={{
                indexAxis: 'y' as const,
                plugins: { legend: { display: false } },
              }}
            />
            <div className="overflow-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-slate-500 text-xs border-b border-slate-100">
                    <th className="text-right py-2 font-semibold">المنتج</th>
                    <th className="text-left py-2 font-semibold">مُرتجع</th>
                    <th className="text-left py-2 font-semibold">مُباع</th>
                    <th className="text-left py-2 font-semibold">نسبة</th>
                    <th className="text-left py-2 font-semibold">مبلغ</th>
                  </tr>
                </thead>
                <tbody>
                  {topProducts.slice(0, 12).map((p: any, i: number) => (
                    <tr key={i} className="border-b border-slate-50">
                      <td className="py-2 font-semibold text-slate-700">
                        <div className="truncate max-w-[180px]">
                          {p.name_ar}
                        </div>
                        <div className="text-xs text-slate-400 font-mono">
                          {p.sku}
                        </div>
                      </td>
                      <td className="py-2 text-left font-bold text-rose-600">
                        {p.returned_qty}
                      </td>
                      <td className="py-2 text-left text-slate-600">
                        {p.sold_qty}
                      </td>
                      <td className="py-2 text-left">
                        <span
                          className={`chip ${
                            Number(p.return_rate_pct) >= 20
                              ? 'bg-rose-100 text-rose-700'
                              : Number(p.return_rate_pct) >= 10
                                ? 'bg-amber-100 text-amber-700'
                                : 'bg-slate-100 text-slate-700'
                          }`}
                        >
                          {Number(p.return_rate_pct).toFixed(1)}%
                        </span>
                      </td>
                      <td className="py-2 text-left text-slate-600">
                        {EGP.format(Number(p.refund_total || 0))}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
