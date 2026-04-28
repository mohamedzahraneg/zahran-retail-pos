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

/**
 * PR-FIN-2-HOTFIX-4 — supplier balances now consult three sources
 * (suppliers.current_balance → GL 211 → unpaid purchases). Card
 * always shows the value (even 0) plus a caption describing which
 * source(s) actually carried data, so a "0" reads as "no records
 * across all sources" instead of "this card is broken".
 */
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
      <KpiRow
        label="إجمالي المستحق"
        value={fmtEGP(data.total_due)}
        emphasis
        testId="suppliers-total-due"
      />
      <KpiRow
        label="عدد الموردين"
        value={fmtNumber(data.count)}
        testId="suppliers-count"
      />
      {data.top ? (
        <>
          <KpiRow label="أعلى مورد مستحق" value={data.top.name} />
          <KpiRow label="" value={fmtEGP(data.top.amount)} tone="neutral" />
        </>
      ) : (
        <KpiRow label="أعلى مورد مستحق" value="—" tone="neutral" />
      )}
      <div
        className="text-[10px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed"
        data-testid="suppliers-source-caption"
      >
        {data.effective_source === 'none'
          ? 'لا توجد أرصدة موردين مسجلة حاليًا'
          : `محسوب من: ${SUPPLIER_SOURCE_LABEL_AR[data.effective_source]}`}
      </div>
      <div className="text-[9px] text-slate-400 dark:text-slate-500">
        المصادر المُراجَعة: سجل الموردين · GL 211 · المشتريات غير المسدّدة
      </div>
    </KpiCard>
  );
}

const SUPPLIER_SOURCE_LABEL_AR: Record<
  FinanceDashboard['balances']['suppliers']['effective_source'],
  string
> = {
  suppliers_table: 'سجل الموردين',
  gl_211: 'GL 211 — الموردون والدائنون',
  purchases: 'المشتريات غير المسدّدة',
  mixed: 'مصادر متعددة (سجل الموردين + GL 211 + المشتريات)',
  none: '—',
};

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

/**
 * PR-FIN-2-HOTFIX-4 — split into "اليوم" + "الفترة" so the operator
 * can see the period activity even when today is quiet. Title
 * renamed; component file name kept as `TodayExpensesCard` to keep
 * the diff tight.
 */
function TodayExpensesCard({
  data,
}: {
  data: FinanceDashboard['daily_expenses'];
}) {
  return (
    <KpiCard
      title="المصروفات (اليوم / الفترة)"
      icon={<Receipt size={18} />}
      tone="rose"
      testId="card-today-expenses"
    >
      {/* Today block */}
      <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400 mt-0.5">
        اليوم
      </div>
      <KpiRow
        label="مصروفات اليوم"
        value={fmtEGP(data.today_total)}
        emphasis
        tone={data.today_total > 0 ? 'negative' : 'neutral'}
        testId="expenses-today-total"
      />
      <KpiRow
        label="عدد مصروفات اليوم"
        value={fmtNumber(data.today_count)}
        testId="expenses-today-count"
      />

      {/* Period block */}
      <div className="border-t border-slate-200 dark:border-slate-700 pt-2 mt-1">
        <div className="text-[10px] font-bold text-slate-500 dark:text-slate-400">
          الفترة
        </div>
        <KpiRow
          label="مصروفات الفترة"
          value={fmtEGP(data.period_total)}
          emphasis
          tone={data.period_total > 0 ? 'negative' : 'neutral'}
          testId="expenses-period-total"
        />
        <KpiRow
          label="عدد مصروفات الفترة"
          value={fmtNumber(data.period_count)}
          testId="expenses-period-count"
        />
        {data.period_largest ? (
          <>
            <KpiRow
              label="أكبر مصروف في الفترة"
              value={data.period_largest.category ?? 'مصروف'}
              testId="expenses-period-largest-cat"
            />
            <KpiRow
              label=""
              value={fmtEGP(data.period_largest.amount)}
              testId="expenses-period-largest-amt"
            />
          </>
        ) : (
          <KpiRow label="أكبر مصروف في الفترة" value="—" />
        )}
      </div>
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

  // PR-FIN-2-HOTFIX-4 — five distinct rows so the operator can tell
  // a real money problem (Trial Balance, رصيد الخزائن, قيود غير
  // متوازنة) from a data-quality / historical concern (فروق تصنيف
  // مراجع, Engine Alerts تاريخية). Captions explain each row's
  // semantics in Arabic so a "تنبيه" overall status doesn't read as
  // "money is missing".
  const lastSeen = data.engine_bypass_alerts_last_seen;
  const lastSeenLabel = lastSeen
    ? new Date(lastSeen).toLocaleDateString('en-GB', {
        timeZone: 'Africa/Cairo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      })
    : null;

  const items: Array<{
    testId: string;
    label: string;
    ok: boolean;
    value: string;
    caption?: string;
  }> = [
    {
      testId: 'health-row-trial-balance',
      label: 'Trial Balance',
      ok: Math.abs(data.trial_balance_imbalance) <= 0.01,
      value: data.trial_balance_imbalance.toFixed(2),
    },
    {
      testId: 'health-row-cashbox-balance',
      label: 'رصيد الخزائن',
      ok: data.cashbox_balance_drift_count === 0,
      value: String(data.cashbox_balance_drift_count),
      caption:
        data.cashbox_balance_drift_count === 0
          ? 'الرصيد الفعلي للخزائن مطابق لمجموع الحركات'
          : 'فرق فعلي في رصيد إحدى الخزائن — مراجعة فورية',
    },
    {
      testId: 'health-row-reference-drift',
      label: 'فروق تصنيف مراجع',
      ok: data.cashbox_drift_count === 0,
      value: `${data.cashbox_drift_count} / ${data.cashbox_drift_total.toFixed(2)}`,
      caption:
        'فروق ربط/تصنيف قديمة — لا تعني فرقًا فعليًا في رصيد الخزائن',
    },
    {
      testId: 'health-row-engine-alerts',
      label: 'Engine Alerts تاريخية',
      ok: data.engine_bypass_alerts_7d === 0,
      value: String(data.engine_bypass_alerts_7d),
      caption: lastSeenLabel
        ? `آخر تنبيه: ${lastSeenLabel} — تنبيهات تاريخية، لا توجد حركة مالية جديدة بسببها`
        : 'تنبيهات تاريخية — لا توجد حركة مالية جديدة بسببها',
    },
    {
      testId: 'health-row-unbalanced',
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
        <div key={it.label} data-testid={it.testId}>
          <div className="flex items-center justify-between gap-2 text-[11px]">
            <span className="text-slate-600 dark:text-slate-400">
              {it.label}
            </span>
            <span className="flex items-center gap-1.5">
              <span
                className={`font-mono tabular-nums ${
                  it.ok
                    ? 'text-emerald-700 dark:text-emerald-400'
                    : 'text-rose-700 dark:text-rose-400'
                }`}
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
          {it.caption && !it.ok && (
            <div className="text-[9px] text-slate-500 dark:text-slate-400 leading-relaxed mt-0.5 mb-1">
              {it.caption}
            </div>
          )}
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
