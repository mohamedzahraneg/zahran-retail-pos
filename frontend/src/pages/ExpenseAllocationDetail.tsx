import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Wallet2,
  RefreshCw,
  ArrowRightCircle,
  Calendar,
  UserCircle2,
  Warehouse,
  AlertTriangle,
} from 'lucide-react';
import {
  expenseAllocationsApi,
  type AllocationLineRow,
} from '@/api/expenseAllocations.api';
import { PeriodStatusBadge } from '@/components/expense-allocations/PeriodStatusBadge';
import { AllocationBanner } from '@/components/expense-allocations/AllocationBanner';
import { fmtCairoDate, fmtCairoDateTimeSeconds } from '@/lib/dates';

/**
 * Allocation period detail — PR-FE-A (read-only).
 *
 * Renders the period header (with audit fields based on status) and
 * the lines table.  No action buttons in FE-A.
 */
const METHOD_LABEL: Record<string, string> = {
  manual: 'يدوي',
  by_revenue: 'حسب الإيراد',
  by_units_sold: 'حسب الكمية المباعة',
  by_gross_profit: 'حسب صافي الربح',
  by_category_pct: 'حسب نسبة الفئة',
  by_warehouse: 'حسب المخزن',
};

export default function ExpenseAllocationDetail() {
  const { id = '' } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const {
    data: period,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ['allocations', 'period', id] as const,
    queryFn: () => expenseAllocationsApi.getPeriod(id),
    enabled: !!id,
  });

  const errStatus = (error as any)?.response?.status;
  const errMsg = error
    ? (error as any)?.response?.data?.message ||
      (error as any)?.message ||
      'تعذر تحميل فترة التوزيع.'
    : null;

  return (
    <div dir="rtl" className="space-y-4 p-4">
      {/* Header bar */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => navigate('/expense-allocations')}
          className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
          aria-label="رجوع إلى القائمة"
        >
          <ArrowRightCircle className="h-5 w-5" />
        </button>
        <div className="rounded-lg bg-violet-50 p-2 text-violet-700">
          <Wallet2 className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900">
            تفاصيل فترة التوزيع
          </h1>
          <p className="text-xs text-slate-400 font-mono">{id}</p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          disabled={isFetching}
        >
          <RefreshCw className={isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          <span>تحديث</span>
        </button>
      </div>

      <AllocationBanner />

      {/* Error / loading */}
      {isLoading && (
        <div className="rounded-lg border border-slate-200 bg-white p-8 text-center text-sm text-slate-400">
          جاري التحميل…
        </div>
      )}
      {!isLoading && errMsg && (
        <div className="flex items-start gap-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-3 text-sm text-rose-800">
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <div className="flex-1">
            <div className="font-medium">
              {errStatus === 404 ? 'فترة التوزيع غير موجودة.' : 'حدث خطأ'}
            </div>
            <div className="text-xs">{errMsg}</div>
          </div>
        </div>
      )}

      {/* Period header */}
      {period && (
        <>
          <div className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm text-slate-700">
                  <Calendar className="h-4 w-4 text-slate-400" />
                  <span className="font-mono tabular-nums">
                    {fmtCairoDate(period.period_start)} —{' '}
                    {fmtCairoDate(period.period_end)}
                  </span>
                </div>
                {period.notes && (
                  <div className="text-sm text-slate-500">{period.notes}</div>
                )}
                <div className="flex items-center gap-3 pt-2 text-xs text-slate-500">
                  <span className="inline-flex items-center gap-1">
                    <Warehouse className="h-3.5 w-3.5" />
                    {period.warehouse_name ?? 'جميع المخازن'}
                  </span>
                </div>
              </div>
              <div className="text-end">
                <PeriodStatusBadge status={period.status} />
                <div className="mt-2 font-mono tabular-nums text-2xl text-slate-900">
                  {Number(period.total_allocated).toLocaleString('en-EG', {
                    minimumFractionDigits: 2,
                    maximumFractionDigits: 2,
                  })}{' '}
                  <span className="text-sm text-slate-400">جنيه</span>
                </div>
                <div className="text-xs text-slate-400">إجمالي التوزيع</div>
              </div>
            </div>

            {/* Audit grid */}
            <div className="mt-4 grid grid-cols-1 gap-3 border-t border-slate-100 pt-3 text-sm sm:grid-cols-3">
              <AuditField
                label="أنشئت بواسطة"
                name={period.created_by_name}
                at={period.created_at}
              />
              <AuditField
                label="اعتمدت بواسطة"
                name={period.approved_by_name}
                at={period.approved_at}
                muted={period.status === 'draft'}
              />
              <AuditField
                label="عُكست بواسطة"
                name={period.reversed_by_name}
                at={period.reversed_at}
                muted={period.status !== 'reversed'}
                extra={period.reversed_reason ?? undefined}
              />
            </div>
          </div>

          {/* Lines table */}
          <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
            <div className="border-b border-slate-100 bg-slate-50 px-4 py-2 text-sm font-medium text-slate-700">
              السطور ({period.lines.length})
            </div>
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-xs text-slate-600">
                <tr>
                  <th className="p-3 text-right font-medium">الطريقة</th>
                  <th className="p-3 text-right font-medium">المصدر</th>
                  <th className="p-3 text-right font-medium">الهدف</th>
                  <th className="p-3 text-right font-medium">قيمة القاعدة</th>
                  <th className="p-3 text-right font-medium">إجمالي القاعدة</th>
                  <th className="p-3 text-right font-medium">مبلغ المصدر</th>
                  <th className="p-3 text-right font-medium">المبلغ الموزع</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {period.lines.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="p-6 text-center text-slate-500">
                      لا توجد سطور في هذه الفترة.
                    </td>
                  </tr>
                ) : (
                  period.lines.map((l) => <LineRow key={l.id} line={l} />)
                )}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-slate-400">
            FE-A — عرض فقط. إضافة السطور وتعديلها واعتماد/عكس الفترة غير متاح
            في هذه المرحلة.
          </p>
        </>
      )}
    </div>
  );
}

function AuditField({
  label,
  name,
  at,
  muted,
  extra,
}: {
  label: string;
  name: string | null;
  at: string | null;
  muted?: boolean;
  extra?: string;
}) {
  if (muted) {
    return (
      <div className="text-xs text-slate-400">
        <div className="font-medium">{label}</div>
        <div>—</div>
      </div>
    );
  }
  return (
    <div className="space-y-0.5 text-sm">
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className="flex items-center gap-1.5 text-slate-800">
        <UserCircle2 className="h-3.5 w-3.5 text-slate-400" />
        <span>{name ?? '—'}</span>
      </div>
      <div className="text-[11px] text-slate-400">
        {at ? fmtCairoDateTimeSeconds(at) : '—'}
      </div>
      {extra && (
        <div className="text-xs text-slate-600">
          <strong className="font-medium text-slate-500">السبب: </strong>
          {extra}
        </div>
      )}
    </div>
  );
}

function LineRow({ line }: { line: AllocationLineRow }) {
  const target =
    line.product_name ??
    line.product_category_name ??
    line.target_warehouse_name ??
    '—';
  const targetKind = line.product_id
    ? 'منتج'
    : line.product_category_id
      ? 'فئة منتج'
      : line.warehouse_id
        ? 'مخزن'
        : '—';
  const source = line.expense_no
    ? `مصروف: ${line.expense_no}`
    : line.expense_category_name
      ? `فئة: ${line.expense_category_name}`
      : '—';
  return (
    <tr className="hover:bg-slate-50">
      <td className="p-3 text-slate-700">
        {METHOD_LABEL[line.allocation_method] ?? line.allocation_method}
      </td>
      <td className="p-3 text-slate-700 text-xs">{source}</td>
      <td className="p-3 text-slate-700">
        <div className="flex flex-col">
          <span>{target}</span>
          <span className="text-[11px] text-slate-400">{targetKind}</span>
        </div>
      </td>
      <td className="p-3 font-mono tabular-nums text-xs text-slate-700">
        {line.weight_basis_value ?? '—'}
      </td>
      <td className="p-3 font-mono tabular-nums text-xs text-slate-700">
        {line.weight_basis_total ?? '—'}
      </td>
      <td className="p-3 font-mono tabular-nums text-xs text-slate-700">
        {Number(line.source_amount).toLocaleString('en-EG', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </td>
      <td className="p-3 font-mono tabular-nums text-slate-900">
        {Number(line.allocated_amount).toLocaleString('en-EG', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </td>
    </tr>
  );
}
