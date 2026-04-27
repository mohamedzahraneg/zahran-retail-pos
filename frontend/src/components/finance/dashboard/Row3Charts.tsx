/**
 * Row3Charts — PR-FIN-2
 *
 * Three charts + the top-10 products table (matches the third row of
 * the dashboard image, RTL right→left):
 *
 *   1. حركة الأرباح عبر الزمن    (line: gross / net / cogs)
 *   2. توزيع وسائل الدفع (المبيعات) (donut)
 *   3. أرباح المجموعات             (bar)
 *   4. أفضل ١٠ أصناف ربحًا         (table)
 *
 * Chart options use neutral palettes that work in both light and dark
 * mode (axis colors derived from CSS variables in `index.css` would be
 * the next iteration; for now the colors are slate-tone safe).
 */
import { useMemo } from 'react';
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
import type { FinanceDashboard } from '@/api/finance.api';
import { DashboardSection } from './shared/DashboardSection';
import { fmtEGP, fmtPct } from './shared/utils';

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

export function Row3Charts({ data }: { data: FinanceDashboard }) {
  return (
    <div
      className="grid grid-cols-1 xl:grid-cols-12 gap-3"
      dir="rtl"
      data-testid="dashboard-row-3"
    >
      <div className="xl:col-span-4">
        <ProfitTrendChart trend={data.profit_trend} />
      </div>
      <div className="xl:col-span-3">
        <PaymentMethodsDonut channels={data.payment_channels} />
      </div>
      <div className="xl:col-span-2">
        <GroupProfitsBar groups={data.group_profits} />
      </div>
      <div className="xl:col-span-3">
        <TopProductsTable items={data.top_products} />
      </div>
    </div>
  );
}

function ProfitTrendChart({
  trend,
}: {
  trend: FinanceDashboard['profit_trend'];
}) {
  const chartData = useMemo(
    () => ({
      labels: trend.map((d) => d.date.slice(5)), // MM-DD
      datasets: [
        {
          label: 'مجمل الربح',
          data: trend.map((d) => d.gross_profit),
          borderColor: '#10B981',
          backgroundColor: 'rgba(16, 185, 129, 0.15)',
          tension: 0.3,
          fill: false,
        },
        {
          label: 'صافي الربح',
          data: trend.map((d) => d.net_profit),
          borderColor: '#EF4444',
          backgroundColor: 'rgba(239, 68, 68, 0.15)',
          tension: 0.3,
          borderDash: [4, 4],
          fill: false,
        },
        {
          label: 'تكلفة البضاعة',
          data: trend.map((d) => d.cogs),
          borderColor: '#3B82F6',
          backgroundColor: 'rgba(59, 130, 246, 0.15)',
          tension: 0.3,
          fill: false,
        },
      ],
    }),
    [trend],
  );
  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom' as const, rtl: true, labels: { boxWidth: 10 } },
        tooltip: { rtl: true },
      },
      scales: { y: { beginAtZero: true } },
    }),
    [],
  );

  return (
    <DashboardSection
      title="حركة الأرباح عبر الزمن"
      testId="chart-profit-trend"
      viewAllHref={null}
    >
      <div className="h-64">
        {trend.length > 0 ? (
          <Line data={chartData} options={options} />
        ) : (
          <EmptyChart />
        )}
      </div>
    </DashboardSection>
  );
}

function PaymentMethodsDonut({
  channels,
}: {
  channels: FinanceDashboard['payment_channels'];
}) {
  const palette = ['#10B981', '#3B82F6', '#8B5CF6', '#F59E0B', '#EF4444', '#94A3B8'];
  const chartData = useMemo(
    () => ({
      labels: channels.map((c) => c.label_ar),
      datasets: [
        {
          data: channels.map((c) => c.sales),
          backgroundColor: channels.map((_, i) => palette[i % palette.length]),
          borderWidth: 0,
        },
      ],
    }),
    [channels],
  );
  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'right' as const, rtl: true, labels: { boxWidth: 10 } },
        tooltip: { rtl: true },
      },
      cutout: '65%',
    }),
    [],
  );
  return (
    <DashboardSection
      title="توزيع وسائل الدفع (المبيعات)"
      testId="chart-payment-channels"
      viewAllHref={null}
    >
      <div className="h-64">
        {channels.length > 0 ? (
          <Doughnut data={chartData} options={options} />
        ) : (
          <EmptyChart />
        )}
      </div>
    </DashboardSection>
  );
}

function GroupProfitsBar({
  groups,
}: {
  groups: FinanceDashboard['group_profits'];
}) {
  const chartData = useMemo(
    () => ({
      labels: groups.map((g) => g.label_ar),
      datasets: [
        {
          label: 'الربح',
          data: groups.map((g) => g.profit),
          backgroundColor: '#8B5CF6',
          borderRadius: 6,
        },
      ],
    }),
    [groups],
  );
  const options = useMemo(
    () => ({
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { rtl: true } },
      indexAxis: 'x' as const,
      scales: { y: { beginAtZero: true } },
    }),
    [],
  );
  return (
    <DashboardSection
      title="أرباح المجموعات"
      testId="chart-group-profits"
      viewAllHref={null}
    >
      <div className="h-64">
        {groups.length > 0 ? (
          <Bar data={chartData} options={options} />
        ) : (
          <EmptyChart />
        )}
      </div>
    </DashboardSection>
  );
}

function TopProductsTable({
  items,
}: {
  items: FinanceDashboard['top_products'];
}) {
  return (
    <DashboardSection
      title="أفضل 10 أصناف ربحًا"
      testId="table-top-products"
      viewAllHref={null}
    >
      <div className="overflow-x-auto -mx-4 -my-4 max-h-72">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 dark:bg-slate-800">
            <tr>
              <Th>الصنف</Th>
              <Th>المبيعات</Th>
              <Th>مجمل الربح</Th>
              <Th>هامش الربح</Th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 ? (
              <tr>
                <td colSpan={4} className="text-center py-6 text-slate-400">
                  لا توجد بيانات
                </td>
              </tr>
            ) : (
              items.map((p) => (
                <tr
                  key={p.product_id}
                  className="border-t border-slate-100 dark:border-slate-800"
                >
                  <Td className="text-slate-700 dark:text-slate-200">
                    {p.name_ar}
                  </Td>
                  <Td className="font-mono tabular-nums">{fmtEGP(p.sales)}</Td>
                  <Td className="font-mono tabular-nums text-emerald-700 dark:text-emerald-400 font-bold">
                    {fmtEGP(p.gross_profit)}
                  </Td>
                  <Td className="font-mono tabular-nums">
                    {fmtPct(p.margin_pct)}
                  </Td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </DashboardSection>
  );
}

function EmptyChart() {
  return (
    <div className="h-full flex items-center justify-center text-xs text-slate-400 dark:text-slate-500">
      لا توجد بيانات في الفترة الحالية
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-right px-3 py-2 text-[10px] font-bold text-slate-500 dark:text-slate-400 whitespace-nowrap">
      {children}
    </th>
  );
}
function Td({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`px-3 py-2 text-[11px] ${className}`}>{children}</td>
  );
}
