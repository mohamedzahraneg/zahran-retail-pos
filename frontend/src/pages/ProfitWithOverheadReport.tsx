import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BarChart3, RefreshCw, Filter, Info } from 'lucide-react';
import {
  expenseAllocationsApi,
  type ProfitWithOverheadRow,
  type ReportFilters,
} from '@/api/expenseAllocations.api';
import { AllocationBanner } from '@/components/expense-allocations/AllocationBanner';

/**
 * Profit-with-overhead report — PR-FE-A (read-only).
 *
 * Wraps the existing `v_product_profit` view and overlays
 * `overhead_allocated` from approved-only allocation periods.  Draft
 * and reversed periods are intentionally invisible to this report —
 * we surface a small info note explaining that.
 */
export default function ProfitWithOverheadReport() {
  const [filters, setFilters] = useState<ReportFilters>({});

  const { data, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['reports', 'profit-with-overhead', filters] as const,
    queryFn: () => expenseAllocationsApi.profitWithOverhead(filters),
  });

  const rows: ProfitWithOverheadRow[] = useMemo(() => data ?? [], [data]);

  const summary = useMemo(() => {
    const totalOverhead = rows.reduce(
      (s, r) => s + Number(r.overhead_allocated ?? 0),
      0,
    );
    const productsWithOverhead = rows.filter(
      (r) => Number(r.overhead_allocated) > 0,
    ).length;
    return { totalOverhead, productsWithOverhead };
  }, [rows]);

  const errMsg = error
    ? (error as any)?.response?.data?.message ||
      (error as any)?.message ||
      'تعذر تحميل تقرير الأرباح بعد التوزيع.'
    : null;

  return (
    <div dir="rtl" className="space-y-4 p-4">
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-emerald-50 p-2 text-emerald-700">
          <BarChart3 className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900">
            الأرباح بعد توزيع المصاريف التشغيلية
          </h1>
          <p className="text-sm text-slate-500">
            صافي ربح كل منتج بعد خصم نصيبه من المصاريف الموزعة في الفترات
            المعتمدة فقط.
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

      {/* Info chip explaining the approved-only filter */}
      <div className="flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-700">
        <Info className="h-4 w-4 shrink-0 text-slate-500" />
        <div>
          تظهر هنا فقط المصاريف الموزعة من فترات{' '}
          <strong className="font-semibold">معتمدة</strong>. الفترات في حالة
          المسودة أو المعكوسة لا تؤثر على هذا التقرير.
        </div>
      </div>

      {/* Summary chips */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryChip label="عدد المنتجات" value={rows.length.toString()} />
        <SummaryChip
          label="منتجات بتوزيع غير صفري"
          value={summary.productsWithOverhead.toString()}
        />
        <SummaryChip
          label="إجمالي التوزيع الظاهر"
          value={summary.totalOverhead.toLocaleString('en-EG', {
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
              <th className="p-3 text-right font-medium">المنتج</th>
              <th className="p-3 text-right font-medium">الكمية</th>
              <th className="p-3 text-right font-medium">الإيراد</th>
              <th className="p-3 text-right font-medium">التكلفة</th>
              <th className="p-3 text-right font-medium">إجمالي الربح</th>
              <th className="p-3 text-right font-medium">المصاريف الموزعة</th>
              <th className="p-3 text-right font-medium">صافي الربح بعد التوزيع</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading ? (
              <tr>
                <td colSpan={7} className="p-6 text-center text-slate-400">
                  جاري التحميل…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-6 text-center text-slate-500">
                  لا توجد بيانات للفترة المحددة.
                </td>
              </tr>
            ) : (
              rows.map((r) => <PWORow key={r.product_id} row={r} />)
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

function PWORow({ row }: { row: ProfitWithOverheadRow }) {
  const overhead = Number(row.overhead_allocated);
  const highlightOverhead = overhead > 0;
  return (
    <tr className="hover:bg-slate-50">
      <td className="p-3 text-slate-800">{row.product_name}</td>
      <td className="p-3 font-mono tabular-nums text-xs text-slate-700">
        {Number(row.units_sold).toLocaleString('en-EG')}
      </td>
      <td className="p-3 font-mono tabular-nums text-xs text-slate-700">
        {Number(row.revenue).toLocaleString('en-EG', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </td>
      <td className="p-3 font-mono tabular-nums text-xs text-slate-700">
        {Number(row.cogs).toLocaleString('en-EG', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </td>
      <td className="p-3 font-mono tabular-nums text-slate-800">
        {Number(row.gross_profit).toLocaleString('en-EG', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </td>
      <td
        className={
          highlightOverhead
            ? 'p-3 font-mono tabular-nums text-amber-700 bg-amber-50/60'
            : 'p-3 font-mono tabular-nums text-slate-400'
        }
      >
        {overhead.toLocaleString('en-EG', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </td>
      <td className="p-3 font-mono tabular-nums text-slate-900">
        {Number(row.net_profit_after_overhead).toLocaleString('en-EG', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </td>
    </tr>
  );
}
