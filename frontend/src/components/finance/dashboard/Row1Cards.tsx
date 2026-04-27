/**
 * Row1Cards — PR-FIN-2
 *
 * Six-card row matching the top of the dashboard image:
 *   1. النقدية وما في حكمها
 *   2. أرصدة العملاء
 *   3. أرصدة الموردين
 *   4. أرصدة الموظفين
 *   5. المصروفات اليوم
 *   6. مؤشرات السلامة المالية
 *
 * Cards rendered right→left (RTL) and the order matches the image.
 * Each card data-source is a sub-shape of `FinanceDashboard`.
 */
import {
  Wallet,
  Users,
  Truck,
  UserCheck,
  Receipt,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  AlertCircle,
} from 'lucide-react';
import type { FinanceDashboard } from '@/api/finance.api';
import { KpiCard, KpiRow } from './shared/KpiCard';
import { fmtEGP, fmtNumber } from './shared/utils';

export function Row1Cards({ data }: { data: FinanceDashboard }) {
  return (
    <div
      className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3"
      data-testid="dashboard-row-1"
      dir="rtl"
    >
      <CashEquivalentsCard data={data.liquidity} />
      <CustomersBalanceCard data={data.balances.customers} />
      <SuppliersBalanceCard data={data.balances.suppliers} />
      <EmployeesBalanceCard data={data.balances.employees} />
      <TodayExpensesCard data={data.daily_expenses} />
      <HealthCard data={data.health} />
    </div>
  );
}

function CashEquivalentsCard({ data }: { data: FinanceDashboard['liquidity'] }) {
  return (
    <KpiCard
      title="النقدية وما في حكمها"
      icon={<Wallet size={18} />}
      tone="emerald"
      testId="card-cash-equivalents"
    >
      <KpiRow label="إجمالي الخزائن" value={fmtEGP(data.cashboxes_total)} />
      <KpiRow label="إجمالي البنوك" value={fmtEGP(data.banks_total)} />
      <KpiRow label="إجمالي المحافظ" value={fmtEGP(data.wallets_total)} />
      <span title="لا توجد حسابات بطاقات مفعلة بعد">
        <KpiRow label="إجمالي البطاقات" value={fmtEGP(data.cards_total)} />
      </span>
      <div className="border-t border-slate-200 dark:border-slate-700 pt-2 mt-1">
        <KpiRow
          label="الإجمالي"
          value={fmtEGP(data.total_cash_equivalents)}
          emphasis
          tone="positive"
        />
      </div>
    </KpiCard>
  );
}

function CustomersBalanceCard({
  data,
}: {
  data: FinanceDashboard['balances']['customers'];
}) {
  return (
    <KpiCard
      title="أرصدة العملاء"
      icon={<Users size={18} />}
      tone="indigo"
      testId="card-customers-balance"
    >
      <KpiRow label="إجمالي المدينة" value={fmtEGP(data.total_due)} emphasis />
      <KpiRow label="عدد العملاء" value={fmtNumber(data.count)} />
      {data.top ? (
        <>
          <KpiRow label="أعلى عميل مدينة" value={data.top.name} />
          <KpiRow label="" value={fmtEGP(data.top.amount)} tone="neutral" />
        </>
      ) : (
        <KpiRow label="أعلى عميل مدينة" value="—" tone="neutral" />
      )}
    </KpiCard>
  );
}

function SuppliersBalanceCard({
  data,
}: {
  data: FinanceDashboard['balances']['suppliers'];
}) {
  return (
    <KpiCard
      title="أرصدة الموردين"
      icon={<Truck size={18} />}
      tone="violet"
      testId="card-suppliers-balance"
    >
      <KpiRow label="إجمالي المستحق" value={fmtEGP(data.total_due)} emphasis />
      <KpiRow label="عدد الموردين" value={fmtNumber(data.count)} />
      {data.top ? (
        <>
          <KpiRow label="أعلى مورد مستحق" value={data.top.name} />
          <KpiRow label="" value={fmtEGP(data.top.amount)} tone="neutral" />
        </>
      ) : (
        <KpiRow label="أعلى مورد مستحق" value="—" tone="neutral" />
      )}
    </KpiCard>
  );
}

function EmployeesBalanceCard({
  data,
}: {
  data: FinanceDashboard['balances']['employees'];
}) {
  return (
    <KpiCard
      title="أرصدة الموظفين"
      icon={<UserCheck size={18} />}
      tone="sky"
      testId="card-employees-balance"
    >
      <KpiRow
        label="إجمالي له"
        value={fmtEGP(data.total_owed_to)}
        tone="positive"
      />
      <KpiRow
        label="إجمالي عليه"
        value={fmtEGP(data.total_owed_by)}
        tone="negative"
      />
      <div className="border-t border-slate-200 dark:border-slate-700 pt-2 mt-1">
        <KpiRow
          label="صافي الرصيد"
          value={fmtEGP(data.net)}
          emphasis
          tone={data.net >= 0 ? 'positive' : 'negative'}
        />
      </div>
    </KpiCard>
  );
}

function TodayExpensesCard({
  data,
}: {
  data: FinanceDashboard['daily_expenses'];
}) {
  return (
    <KpiCard
      title="المصروفات اليوم"
      icon={<Receipt size={18} />}
      tone="rose"
      testId="card-today-expenses"
    >
      <KpiRow
        label="إجمالي المصروفات"
        value={fmtEGP(data.total)}
        emphasis
        tone="negative"
      />
      <KpiRow label="عدد المصروفات" value={fmtNumber(data.count)} />
      {data.largest ? (
        <>
          <KpiRow
            label="أكبر مصروف"
            value={data.largest.category ?? 'مصروف'}
          />
          <KpiRow label="" value={fmtEGP(data.largest.amount)} />
        </>
      ) : (
        <KpiRow label="أكبر مصروف" value="—" />
      )}
    </KpiCard>
  );
}

function HealthCard({ data }: { data: FinanceDashboard['health'] }) {
  const tone =
    data.overall === 'healthy'
      ? 'emerald'
      : data.overall === 'warning'
        ? 'amber'
        : 'rose';
  const StatusIcon =
    data.overall === 'healthy'
      ? CheckCircle2
      : data.overall === 'warning'
        ? AlertTriangle
        : AlertCircle;
  const statusLabel =
    data.overall === 'healthy'
      ? 'سليم'
      : data.overall === 'warning'
        ? 'تنبيه'
        : 'حرج';
  const statusToneClass =
    data.overall === 'healthy'
      ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300 border-emerald-200 dark:border-emerald-800'
      : data.overall === 'warning'
        ? 'bg-amber-50 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300 border-amber-200 dark:border-amber-800'
        : 'bg-rose-50 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300 border-rose-200 dark:border-rose-800';

  // Each invariant gets its own row with a check/x icon — never relies
  // on color alone (dark mode + accessibility).
  const items: Array<{ label: string; ok: boolean; value: string }> = [
    {
      label: 'Trial Balance',
      ok: Math.abs(data.trial_balance_imbalance) <= 0.01,
      value: data.trial_balance_imbalance.toFixed(2),
    },
    {
      label: 'Cashbox Drift',
      ok: data.cashbox_drift_total === 0,
      value: data.cashbox_drift_total.toFixed(2),
    },
    {
      label: 'Engine Alerts (٧ أيام)',
      ok: data.engine_bypass_alerts_7d === 0,
      value: String(data.engine_bypass_alerts_7d),
    },
    {
      label: 'قيود غير متوازنة',
      ok: data.unbalanced_entries_count === 0,
      value: String(data.unbalanced_entries_count),
    },
  ];

  return (
    <KpiCard
      title="مؤشرات السلامة المالية"
      icon={<ShieldCheck size={18} />}
      tone={tone}
      testId="card-health"
    >
      {items.map((it) => (
        <div
          key={it.label}
          className="flex items-center justify-between gap-2 text-[11px]"
          data-testid={`health-row-${it.label}`}
        >
          <span className="text-slate-600 dark:text-slate-400">{it.label}</span>
          <span className="flex items-center gap-1.5">
            <span
              className={`font-mono tabular-nums ${it.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-700 dark:text-rose-400'}`}
            >
              {it.value}
            </span>
            {it.ok ? (
              <CheckCircle2
                size={12}
                className="text-emerald-700 dark:text-emerald-400"
              />
            ) : (
              <AlertCircle
                size={12}
                className="text-rose-700 dark:text-rose-400"
              />
            )}
          </span>
        </div>
      ))}
      <div
        className={`mt-1 rounded-lg border px-2.5 py-1.5 flex items-center justify-between text-[11px] font-bold ${statusToneClass}`}
        data-testid="health-overall"
      >
        <span>الحالة</span>
        <span className="flex items-center gap-1">
          <StatusIcon size={12} />
          {statusLabel}
        </span>
      </div>
    </KpiCard>
  );
}
