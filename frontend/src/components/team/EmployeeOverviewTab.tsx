/**
 * EmployeeOverviewTab — PR-T4.1
 * ─────────────────────────────────────────────────────────────────────
 *
 * Replaces the legacy OverviewTab (defined inline in Team.tsx) with the
 * employee-overview design from
 * `employee_overview_sales_performance_design.html`. Real data only —
 * commission/sales numbers come from the existing /commissions/summary
 * + /commissions/:id/detail endpoints. Performance-rating + collection-
 * ratio fields aren't exposed by any current API; those slots fall back
 * to "غير متاح" placeholders rather than fabricated numbers.
 *
 * Backend invariants (all unchanged in this PR):
 *   · /employees/:id/dashboard (existing) — work hours/days,
 *     wage.accrual_in_month, wage.paid_in_month, salary.advances_month,
 *     gl.live_snapshot
 *   · /commissions/summary?from&to (existing, PR-15) — eligible_sales,
 *     invoices_count, commission_rate, commission_amount per user
 *   · /commissions/:id/detail?from&to (existing) — invoice-level rows
 *     for the "أعلى الفواتير" list
 *   · No new endpoints, no migrations, no FinancialEngine changes
 */

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Receipt,
  CalendarCheck,
  Banknote,
  Wallet,
  TrendingUp,
  Percent,
  TrendingDown,
  Award,
  Star,
  Briefcase,
  Clock,
} from 'lucide-react';
import { TeamRow, employeesApi } from '@/api/employees.api';
import { commissionsApi, CommissionDetailRow } from '@/api/commissions.api';

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

function monthBounds(): PeriodBounds {
  const today = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(today);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${d}` };
}

function previousMonthBounds(): PeriodBounds {
  // Previous full Cairo month (1st → last day). Used for the
  // period-comparison column.
  const today = new Date();
  const cairoToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(today);
  const y = parseInt(cairoToday.find((p) => p.type === 'year')!.value, 10);
  const m = parseInt(cairoToday.find((p) => p.type === 'month')!.value, 10);
  const prevY = m === 1 ? y - 1 : y;
  const prevM = m === 1 ? 12 : m - 1;
  const lastDay = new Date(prevY, prevM, 0).getDate(); // day 0 of next month = last day of prev
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    from: `${prevY}-${pad(prevM)}-01`,
    to: `${prevY}-${pad(prevM)}-${pad(lastDay)}`,
  };
}

/* ─────────────────────────────────────────────────────────────────
 * Top-level component
 * ───────────────────────────────────────────────────────────────── */

export function EmployeeOverviewTab({ employee }: { employee: TeamRow }) {
  const userId = employee.id;
  const month = useMemo(() => monthBounds(), []);
  const prevMonth = useMemo(() => previousMonthBounds(), []);

  const { data: dash } = useQuery({
    queryKey: ['employee-user-dashboard', userId],
    queryFn: () => employeesApi.userDashboard(userId),
  });

  // Commission summary for the current month — gives us
  // eligible_sales, invoices_count, commission_rate, commission_amount
  // for THIS employee. The endpoint returns one row per salesperson;
  // we filter to ours. Non-salespeople get an empty result and the
  // sales cards fall back to "غير متاح".
  const { data: commissionSummary = [] } = useQuery({
    queryKey: ['commissions-summary', month.from, month.to],
    queryFn: () => commissionsApi.summary(month.from, month.to),
  });
  const myCommission = useMemo(
    () => commissionSummary.find((c) => c.user_id === userId),
    [commissionSummary, userId],
  );

  // Same for previous month — drives the "تغير" column in the
  // period-comparison table.
  const { data: prevCommissionSummary = [] } = useQuery({
    queryKey: ['commissions-summary', prevMonth.from, prevMonth.to],
    queryFn: () => commissionsApi.summary(prevMonth.from, prevMonth.to),
  });
  const prevMyCommission = useMemo(
    () => prevCommissionSummary.find((c) => c.user_id === userId),
    [prevCommissionSummary, userId],
  );

  // Top invoices — only meaningful for salespeople. Skip the query
  // when the user isn't in the commission summary (no invoices match).
  const { data: detail = [] } = useQuery({
    queryKey: ['commissions-detail', userId, month.from, month.to],
    queryFn: () => commissionsApi.detail(userId, month.from, month.to),
    enabled: !!myCommission,
  });
  const topInvoices = useMemo(
    () =>
      [...(detail as CommissionDetailRow[])]
        .sort((a, b) => Number(b.eligible_total) - Number(a.eligible_total))
        .slice(0, 5),
    [detail],
  );

  const isSalesperson = !!myCommission;
  const eligibleSales = Number(myCommission?.eligible_sales || 0);
  const prevEligibleSales = Number(prevMyCommission?.eligible_sales || 0);
  const invoicesCount = Number(myCommission?.invoices_count || 0);
  const prevInvoicesCount = Number(prevMyCommission?.invoices_count || 0);
  const commissionRate = Number(myCommission?.commission_rate || 0);
  const commissionAmount = Number(myCommission?.commission_amount || 0);
  const prevCommissionAmount = Number(prevMyCommission?.commission_amount || 0);
  const avgInvoice = invoicesCount > 0 ? eligibleSales / invoicesCount : 0;
  const prevAvgInvoice =
    prevInvoicesCount > 0 ? prevEligibleSales / prevInvoicesCount : 0;

  const monthDays = dash?.attendance?.month?.days ?? 0;
  const monthMinutes = dash?.attendance?.month?.minutes ?? 0;
  const accrualInMonth = Number(dash?.wage?.accrual_in_month || 0);
  const paidInMonth = Number(dash?.wage?.paid_in_month || 0);
  const advancesMonth = Number(dash?.salary?.advances_month || 0);
  const liveGl = Number(dash?.gl?.live_snapshot ?? 0);

  return (
    <div className="space-y-5">
      {/* Top KPI strip — 5 cards mixing payroll + sales (real data). */}
      <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
        <KpiCard
          tone="green"
          icon={<CalendarCheck size={20} />}
          label="أيام العمل (الشهر)"
          value={monthDays.toString()}
          sub={`${fmtHours(monthMinutes)} إجمالي`}
        />
        <KpiCard
          tone="blue"
          icon={<Banknote size={20} />}
          label="مستحقات معتمدة"
          value={EGP(accrualInMonth)}
          sub="من اعتماد اليوميات"
        />
        <KpiCard
          tone="orange"
          icon={<Wallet size={20} />}
          label="مصروف فعليًا"
          value={EGP(paidInMonth)}
          sub="مجموع التسويات النقدية"
        />
        <KpiCard
          tone="purple"
          icon={<TrendingDown size={20} />}
          label="سلف الشهر"
          value={EGP(advancesMonth)}
          sub="ذمم على الموظف"
        />
        <KpiCard
          tone={liveGl < -0.01 ? 'green' : liveGl > 0.01 ? 'red' : 'slate'}
          icon={<Receipt size={20} />}
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

      {/* Sales / commission strip — only meaningful when employee has a
          commission rate. Otherwise show an explainer card. */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          tone="blue"
          icon={<Receipt size={20} />}
          label="فواتير المبيعات (الشهر)"
          value={isSalesperson ? invoicesCount.toLocaleString('en-US') : 'غير متاح'}
          sub={
            isSalesperson
              ? prevInvoicesCount > 0
                ? changeLabel(invoicesCount - prevInvoicesCount, false)
                : undefined
              : 'غير مرتبط بمبيعات'
          }
        />
        <KpiCard
          tone="green"
          icon={<TrendingUp size={20} />}
          label="إجمالي المبيعات"
          value={isSalesperson ? EGP(eligibleSales) : 'غير متاح'}
          sub={
            isSalesperson && prevEligibleSales > 0
              ? changeLabel(eligibleSales - prevEligibleSales, true)
              : undefined
          }
        />
        <KpiCard
          tone="orange"
          icon={<Award size={20} />}
          label="متوسط قيمة الفاتورة"
          value={isSalesperson ? EGP(avgInvoice) : 'غير متاح'}
          sub={
            isSalesperson && prevAvgInvoice > 0
              ? changeLabel(avgInvoice - prevAvgInvoice, true)
              : undefined
          }
        />
        <KpiCard
          tone="purple"
          icon={<Percent size={20} />}
          label="عمولة الموظف"
          value={
            isSalesperson
              ? `${EGP(commissionAmount)} (${commissionRate}%)`
              : 'غير متاح'
          }
          sub={
            isSalesperson && prevCommissionAmount > 0
              ? changeLabel(commissionAmount - prevCommissionAmount, true)
              : isSalesperson
                ? `بمعدل عمولة ${commissionRate}%`
                : undefined
          }
        />
      </div>

      {/* Two-column body: top invoices (left) + period comparison (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-5">
        <SectionCard
          title="أعلى فواتير المبيعات (الشهر)"
          subtitle={
            isSalesperson
              ? 'مرتبة حسب القيمة المؤهلة للعمولة'
              : 'الموظف غير مرتبط بمبيعات.'
          }
        >
          {!isSalesperson ? (
            <EmptyRow message="لا توجد فواتير مبيعات لهذا الموظف. هذا القسم يظهر فقط للموظفين المرتبطين بمبيعات (لديهم نسبة عمولة)." />
          ) : topInvoices.length === 0 ? (
            <EmptyRow message="لا توجد فواتير في هذا الشهر." />
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50">
                  <tr>
                    <Th>#</Th>
                    <Th>رقم الفاتورة</Th>
                    <Th>التاريخ</Th>
                    <Th>العميل</Th>
                    <Th>القيمة المؤهلة</Th>
                    <Th>العمولة</Th>
                  </tr>
                </thead>
                <tbody>
                  {topInvoices.map((inv, i) => (
                    <tr key={inv.invoice_id} className="border-t border-slate-100">
                      <Td className="font-mono">{i + 1}</Td>
                      <Td className="font-mono text-[11px]">{inv.invoice_no}</Td>
                      <Td className="font-mono tabular-nums">
                        {fmtDate(inv.completed_at)}
                      </Td>
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
        </SectionCard>

        <SectionCard
          title="ملخص مقارن (الشهر الحالي vs السابق)"
          subtitle="من نفس مصادر البيانات الحقيقية — لا توجد قيم مزيفة."
        >
          <div className="overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50">
                <tr>
                  <Th>المؤشر</Th>
                  <Th>الشهر الحالي</Th>
                  <Th>الشهر السابق</Th>
                  <Th>التغير</Th>
                </tr>
              </thead>
              <tbody>
                <ComparisonRow
                  label="أيام العمل"
                  current={monthDays}
                  previous={null}
                  formatter={(n) => String(n)}
                />
                <ComparisonRow
                  label="ساعات العمل"
                  current={monthMinutes}
                  previous={null}
                  formatter={fmtHours}
                />
                <ComparisonRow
                  label="مستحقات معتمدة"
                  current={accrualInMonth}
                  previous={null}
                  formatter={EGP}
                />
                <ComparisonRow
                  label="مصروف فعليًا"
                  current={paidInMonth}
                  previous={null}
                  formatter={EGP}
                />
                {isSalesperson && (
                  <>
                    <ComparisonRow
                      label="إجمالي المبيعات"
                      current={eligibleSales}
                      previous={prevEligibleSales || null}
                      formatter={EGP}
                    />
                    <ComparisonRow
                      label="عدد الفواتير"
                      current={invoicesCount}
                      previous={prevInvoicesCount || null}
                      formatter={(n) => String(n)}
                    />
                    <ComparisonRow
                      label="متوسط الفاتورة"
                      current={avgInvoice}
                      previous={prevAvgInvoice || null}
                      formatter={EGP}
                    />
                    <ComparisonRow
                      label="مبلغ العمولة"
                      current={commissionAmount}
                      previous={prevCommissionAmount || null}
                      formatter={EGP}
                    />
                  </>
                )}
              </tbody>
            </table>
          </div>
          <div className="px-4 pt-3 pb-4 text-[10px] text-slate-400 border-t border-slate-100 leading-relaxed">
            * مؤشرات الحضور والمستحقات المقارنة بالشهر السابق ستُضاف عند توفر
            موسع API للـ dashboard. مؤشرات المبيعات/العمولة تستخدم endpoint
            <code className="px-1 mx-1 bg-slate-100 rounded">/commissions/summary</code>
            مع نطاق تاريخ الشهر السابق.
          </div>
        </SectionCard>
      </div>

      {/* Tasks + requests teaser — kept minimal; full audit is in the
          الموافقات والتعديلات tab and the tasks system has a separate
          modal in the Actions dropdown. */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <SectionCard
          title={`مهام مفتوحة (${dash?.tasks?.length ?? 0})`}
          subtitle="من /employees/:id/dashboard"
        >
          {!dash?.tasks?.length ? (
            <EmptyRow message="لا مهام مفتوحة." />
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
        </SectionCard>
        <SectionCard
          title={`طلبات معلّقة (${dash?.requests?.length ?? 0})`}
          subtitle="القرار يتم من تبويب الموافقات والتعديلات"
        >
          {!dash?.requests?.length ? (
            <EmptyRow message="لا توجد طلبات." />
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
        </SectionCard>
      </div>

      {/* Performance/rating — currently no API. Honest placeholder per spec. */}
      <SectionCard
        title="تقييم الأداء"
        subtitle="هذه المؤشرات ستُضاف عند توفر API لتقييم الأداء."
      >
        <div className="px-5 py-6 grid grid-cols-1 md:grid-cols-3 gap-4 text-center">
          <PlaceholderStat icon={<Award size={20} />} label="مستوى الأداء" />
          <PlaceholderStat icon={<Star size={20} />} label="تقييم الأداء (نجوم)" />
          <PlaceholderStat icon={<Briefcase size={20} />} label="نسبة التحصيل" />
        </div>
      </SectionCard>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Helpers
 * ───────────────────────────────────────────────────────────────── */

function changeLabel(delta: number, isMoney: boolean): string {
  const arrow = delta > 0 ? '↑' : delta < 0 ? '↓' : '·';
  return `${arrow} ${isMoney ? EGP(Math.abs(delta)) : Math.abs(delta).toLocaleString('en-US')} عن الفترة السابقة`;
}

function ComparisonRow({
  label,
  current,
  previous,
  formatter,
}: {
  label: string;
  current: number;
  previous: number | null;
  formatter: (n: number) => string;
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
      <Td className="font-mono tabular-nums">{formatter(current)}</Td>
      <Td className="font-mono tabular-nums text-slate-500">
        {hasPrev ? formatter(previous as number) : 'غير متاح'}
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
            : `${delta > 0 ? '↑' : '↓'} ${formatter(Math.abs(delta))}`}
      </Td>
    </tr>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Small UI primitives
 * ───────────────────────────────────────────────────────────────── */

function KpiCard({
  tone,
  icon,
  label,
  value,
  sub,
}: {
  tone: 'green' | 'blue' | 'orange' | 'purple' | 'red' | 'slate';
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
    red:    { fg: 'text-rose-700',    tile: 'bg-rose-100' },
    slate:  { fg: 'text-slate-600',   tile: 'bg-slate-100' },
  };
  const t = map[tone];
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 flex items-center justify-between gap-3 shadow-sm">
      <div className="min-w-0">
        <div className="text-[11px] font-bold text-slate-500">{label}</div>
        <div className={`text-lg font-black mt-1 ${t.fg} truncate tabular-nums`}>
          {value}
        </div>
        {sub && (
          <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>
        )}
      </div>
      <div className={`shrink-0 w-10 h-10 rounded-xl ${t.tile} ${t.fg} flex items-center justify-center`}>
        {icon}
      </div>
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <h4 className="text-sm font-black text-slate-800">{title}</h4>
        {subtitle && (
          <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

function PlaceholderStat({
  icon,
  label,
}: {
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-5">
      <div className="text-slate-400 mb-2 flex justify-center">{icon}</div>
      <div className="text-xs font-bold text-slate-500">{label}</div>
      <div className="text-xs text-slate-400 mt-2">غير متاح حاليًا</div>
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
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`px-3 py-2.5 text-xs text-slate-700 ${className}`}>
      {children}
    </td>
  );
}

function EmptyRow({ message }: { message: string }) {
  return <div className="text-center text-xs text-slate-400 py-8 px-4">{message}</div>;
}

const _used = [Clock]; void _used;
