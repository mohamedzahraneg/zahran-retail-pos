import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Receipt, RefreshCw, Filter, Info } from 'lucide-react';
import {
  expenseAllocationsApi,
  type UnallocatedExpenseRow,
  type ReportFilters,
} from '@/api/expenseAllocations.api';
import { AllocationBanner } from '@/components/expense-allocations/AllocationBanner';
import { fmtCairoDate } from '@/lib/dates';

/**
 * Unallocated-expenses report — PR-FE-A (read-only).
 *
 * Lists approved expenses that no approved allocation period covers.
 * Useful for "find the gaps" — every row here is an opportunity to
 * create or expand an allocation period.
 */
export default function ExpensesUnallocatedReport() {
  const [filters, setFilters] = useState<ReportFilters>({});

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['reports', 'unallocated-expenses', filters] as const,
    queryFn: () => expenseAllocationsApi.unallocatedExpenses(filters),
  });

  const rows: UnallocatedExpenseRow[] = useMemo(() => data ?? [], [data]);

  const summary = useMemo(() => {
    const totalAmount = rows.reduce((s, r) => s + Number(r.amount ?? 0), 0);
    return { totalAmount };
  }, [rows]);

  const errMsg = error
    ? (error as any)?.response?.data?.message ||
      (error as any)?.message ||
      'تعذر تحميل تقرير المصاريف غير الموزعة.'
    : null;

  return (
    <div dir="rtl" className="space-y-4 p-4">
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-amber-50 p-2 text-amber-700">
          <Receipt className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900">
            المصاريف المعتمدة بدون توزيع
          </h1>
          <p className="text-sm text-slate-500">
            مصاريف معتمدة لا تغطيها أي فترة توزيع معتمدة. ابحث عن الفجوات
            وأنشئ فترات لتوزيعها.
          </p>
        </div>
        <button
          type="button"
          onClick={() => refetch()}
          disabled={isFetching}
          className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
        >
          <RefreshCw className={isFetching ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          <span>تحديث</span>
        </button>
      </div>

      <AllocationBanner />

      {/* Filters */}
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-500">
          <Filter className="h-3.5 w-3.5" />
          <span>تصفية بالتواريخ (اختياري)</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            <span>من تاريخ</span>
            <input
              type="date"
              value={filters.from ?? ''}
              onChange={(e) =>
                setFilters((f) => ({ ...f, from: e.target.value || undefined }))
              }
              className="rounded-md border border-slate-200 px-2 py-1.5 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            <span>إلى تاريخ</span>
            <input
              type="date"
              value={filters.to ?? ''}
              onChange={(e) =>
                setFilters((f) => ({ ...f, to: e.target.value || undefined }))
              }
              className="rounded-md border border-slate-200 px-2 py-1.5 text-sm"
            />
          </label>
          <div className="flex items-end">
            {(filters.from || filters.to) && (
              <button
                type="button"
                onClick={() => setFilters({})}
                className="text-xs text-slate-600 underline hover:text-slate-900"
              >
                مسح التصفية
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Note */}
      <div className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
        <Info className="h-4 w-4 shrink-0 text-slate-500" />
        <div>
          المصاريف هنا معتمدة ولكن لا تغطيها أي فترة توزيع{' '}
          <strong className="font-semibold">معتمدة</strong>. عند اعتماد فترة
          تشمل تاريخ هذه المصاريف، تختفي من هذه القائمة.
        </div>
      </div>

      {/* Summary chips */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <SummaryChip label="عدد المصاريف" value={rows.length.toString()} />
        <SummaryChip
          label="الإجمالي"
          value={summary.totalAmount.toLocaleString('en-EG', {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          })}
          suffix="جنيه"
        />
      </div>

      {/* Error */}
      {errMsg && (
        <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
          {errMsg}
        </div>
      )}

      {/* Table */}
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600">
            <tr>
              <th className="p-3 text-right font-medium">رقم المصروف</th>
              <th className="p-3 text-right font-medium">التاريخ</th>
              <th className="p-3 text-right font-medium">الفئة</th>
              <th className="p-3 text-right font-medium">المخزن</th>
              <th className="p-3 text-right font-medium">المبلغ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading ? (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-400">
                  جاري التحميل…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-6 text-center text-slate-500">
                  لا توجد مصاريف معتمدة بدون توزيع. كل المصاريف مغطاة. 👍
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="p-3 font-mono tabular-nums text-xs text-slate-700">
                    {r.expense_no}
                  </td>
                  <td className="p-3 text-xs text-slate-700">
                    {fmtCairoDate(r.expense_date)}
                  </td>
                  <td className="p-3 text-slate-700">{r.category_name ?? '—'}</td>
                  <td className="p-3 text-slate-700">{r.warehouse_name ?? '—'}</td>
                  <td className="p-3 font-mono tabular-nums text-slate-900">
                    {Number(r.amount).toLocaleString('en-EG', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-slate-400">
        FE-A — تقرير للقراءة فقط. لا يوجد إجراء كتابي على هذه الصفحة.
      </p>
    </div>
  );
}

function SummaryChip({
  label,
  value,
  suffix,
}: {
  label: string;
  value: string;
  suffix?: string;
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white px-4 py-3">
      <div className="text-[11px] font-medium text-slate-500">{label}</div>
      <div className="mt-1 font-mono tabular-nums text-xl text-slate-900">
        {value}
        {suffix && <span className="ms-1 text-xs text-slate-400">{suffix}</span>}
      </div>
    </div>
  );
}
