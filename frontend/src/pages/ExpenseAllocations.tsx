import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import {
  Wallet2,
  RefreshCw,
  Filter,
  ArrowLeftCircle,
  Plus,
  Trash2,
  Eye,
  EyeOff,
} from 'lucide-react';
import {
  expenseAllocationsApi,
  type AllocationPeriodRow,
  type AllocationPeriodStatus,
  type PeriodFilters,
} from '@/api/expenseAllocations.api';
import { PeriodStatusBadge } from '@/components/expense-allocations/PeriodStatusBadge';
import { AllocationBanner } from '@/components/expense-allocations/AllocationBanner';
// PR-FE-B.2 — period-level write actions.  Mounted from this page
// only when the operator holds `expense_allocation.manage`.  Line
// editing, approve, and reverse stay outside FE-B.2's scope.
import { PeriodHeaderModal } from '@/components/expense-allocations/modals/PeriodHeaderModal';
import { DeleteDraftDialog } from '@/components/expense-allocations/modals/DeleteDraftDialog';
import { useAuthStore } from '@/stores/auth.store';
import { fmtCairoDate } from '@/lib/dates';

/**
 * Allocation periods list — PR-FE-A (read) + PR-FE-B.2 (period write)
 * + PR-FE-UX-ALLOC-2 (hide-reversed default).
 *
 * Renders all allocation periods with status, dates, audit fields,
 * and line counts.  Filters: from/to/status/warehouse_id.
 *
 * Reversed periods are terminal audit records — they clutter the
 * active worklist, so the list **hides them by default** and exposes
 * a sticky "إظهار المعكوسة" toggle.  Explicit `status=reversed` from
 * the dropdown overrides the toggle so direct URLs and saved filters
 * keep working.  Detail pages for reversed periods are unaffected
 * (they live on a separate route).
 *
 * Write surface added in FE-B.2 and gated by `expense_allocation.manage`:
 *   * "+ فترة جديدة" header button (CreatePeriod via PeriodHeaderModal).
 *   * Per-row "حذف المسودة" trash icon, draft-only, with typed-
 *     confirmation via DeleteDraftDialog.
 * Edit-header, approve, line CRUD, and reverse live on the detail
 * page (and FE-B.3 / FE-B.4) — not here.
 */
const STATUS_OPTIONS: { value: '' | AllocationPeriodStatus; label: string }[] = [
  { value: '', label: 'كل الحالات' },
  { value: 'draft', label: 'مسودة' },
  { value: 'approved', label: 'معتمدة' },
  { value: 'reversed', label: 'معكوسة' },
];

export default function ExpenseAllocations() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<PeriodFilters>({});
  // PR-FE-UX-ALLOC-2 — hide reversed (terminal/audit) periods by
  // default so the active worklist isn't cluttered.  The toggle
  // surfaces them when the operator explicitly asks; an explicit
  // `status=reversed` filter also overrides the toggle so URLs and
  // saved filters keep working.
  const [showReversed, setShowReversed] = useState(false);

  // PR-FE-B.2 — defense-in-depth: server already enforces
  // `expense_allocation.manage` on every write, but we also hide the
  // entire write surface for users without the permission.  Viewers
  // see exactly the FE-A list.
  const canManage = useAuthStore((s) => s.hasPermission)(
    'expense_allocation.manage',
  );
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteCandidate, setDeleteCandidate] =
    useState<AllocationPeriodRow | null>(null);

  const { data: periods, isLoading, isFetching, refetch, error } = useQuery({
    queryKey: ['allocations', 'periods', filters] as const,
    queryFn: () => expenseAllocationsApi.listPeriods(filters),
  });

  // PR-FE-UX-ALLOC-2 — client-side filter for the reversed-hide
  // toggle.  Bypassed when the user explicitly selected
  // `status=reversed` from the dropdown.
  const rawRows: AllocationPeriodRow[] = useMemo(() => periods ?? [], [periods]);
  const explicitReversedFilter = filters.status === 'reversed';
  const rows = useMemo(
    () =>
      showReversed || explicitReversedFilter
        ? rawRows
        : rawRows.filter((p) => p.status !== 'reversed'),
    [rawRows, showReversed, explicitReversedFilter],
  );
  const hiddenReversedCount = useMemo(
    () =>
      showReversed || explicitReversedFilter
        ? 0
        : rawRows.filter((p) => p.status === 'reversed').length,
    [rawRows, showReversed, explicitReversedFilter],
  );

  const errMsg = error
    ? (error as any)?.response?.data?.message ||
      (error as any)?.message ||
      'تعذر تحميل قائمة الفترات.'
    : null;

  return (
    <div dir="rtl" className="space-y-4 p-4">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="rounded-lg bg-violet-50 p-2 text-violet-700">
          <Wallet2 className="h-5 w-5" />
        </div>
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900">
            توزيع المصاريف التشغيلية
          </h1>
          <p className="text-sm text-slate-500">
            فترات توزيع المصاريف على المنتجات والفئات والمخازن للتقارير
            الإدارية.
          </p>
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
        {canManage && (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700"
          >
            <Plus className="h-4 w-4" />
            <span>فترة جديدة</span>
          </button>
        )}
      </div>

      <AllocationBanner />

      {/* Filters */}
      <div className="rounded-lg border border-slate-200 bg-white p-3">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium text-slate-500">
          <Filter className="h-3.5 w-3.5" />
          <span>تصفية</span>
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
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
          <label className="flex flex-col gap-1 text-xs text-slate-600">
            <span>الحالة</span>
            <select
              value={filters.status ?? ''}
              onChange={(e) =>
                setFilters((f) => ({
                  ...f,
                  status: (e.target.value || undefined) as
                    | AllocationPeriodStatus
                    | undefined,
                }))
              }
              className="rounded-md border border-slate-200 px-2 py-1.5 text-sm"
            >
              {STATUS_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <div className="flex flex-col items-stretch justify-end gap-2">
            {/* PR-FE-UX-ALLOC-2 — reversed-visibility toggle.  Hidden
                (i.e. no effect) when the operator already selected
                `status=reversed` explicitly from the dropdown — that
                selection overrides the toggle. */}
            {!explicitReversedFilter && (
              <button
                type="button"
                onClick={() => setShowReversed((v) => !v)}
                title={
                  showReversed
                    ? 'إخفاء الفترات المعكوسة (سجل تدقيقي)'
                    : 'إظهار الفترات المعكوسة (سجل تدقيقي)'
                }
                className={
                  'inline-flex items-center justify-center gap-2 rounded-md border px-3 py-1.5 text-xs ' +
                  (showReversed
                    ? 'border-slate-300 bg-slate-100 text-slate-700 hover:bg-slate-200'
                    : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50')
                }
              >
                {showReversed ? (
                  <EyeOff className="h-3.5 w-3.5" />
                ) : (
                  <Eye className="h-3.5 w-3.5" />
                )}
                <span>
                  {showReversed
                    ? 'إخفاء المعكوسة'
                    : 'إظهار المعكوسة'}
                  {!showReversed && hiddenReversedCount > 0 && (
                    <span className="ms-1 font-mono tabular-nums text-slate-400">
                      ({hiddenReversedCount})
                    </span>
                  )}
                </span>
              </button>
            )}
            {(filters.from || filters.to || filters.status) && (
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
              <th className="p-3 text-right font-medium">الفترة</th>
              <th className="p-3 text-right font-medium">المخزن</th>
              <th className="p-3 text-right font-medium">الحالة</th>
              <th className="p-3 text-right font-medium">إجمالي التوزيع</th>
              <th className="p-3 text-right font-medium">عدد السطور</th>
              <th className="p-3 text-right font-medium">أنشئت بواسطة</th>
              <th className="p-3 text-right font-medium">أنشئت في</th>
              <th className="p-3 text-right font-medium w-20"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {isLoading ? (
              <tr>
                <td colSpan={8} className="p-6 text-center text-slate-400">
                  جاري التحميل…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={8} className="p-6 text-center text-slate-500">
                  <div>لا توجد فترات توزيع مطابقة للتصفية.</div>
                  {hiddenReversedCount > 0 && (
                    <div className="mt-1 text-xs text-slate-400">
                      توجد{' '}
                      <span className="font-mono tabular-nums">
                        {hiddenReversedCount}
                      </span>{' '}
                      فترة معكوسة مخفية — فعّل «إظهار المعكوسة» للعرض.
                    </div>
                  )}
                </td>
              </tr>
            ) : (
              rows.map((p) => (
                <tr
                  key={p.id}
                  className="cursor-pointer hover:bg-slate-50"
                  onClick={() => navigate(`/expense-allocations/${p.id}`)}
                >
                  <td className="p-3 font-mono tabular-nums text-xs">
                    <div className="text-slate-700">
                      {fmtCairoDate(p.period_start)} — {fmtCairoDate(p.period_end)}
                    </div>
                    {p.notes && (
                      <div className="text-[11px] text-slate-400">{p.notes}</div>
                    )}
                  </td>
                  <td className="p-3 text-slate-700">
                    {p.warehouse_name ?? (
                      <span className="text-slate-400">جميع المخازن</span>
                    )}
                  </td>
                  <td className="p-3">
                    <PeriodStatusBadge status={p.status} />
                  </td>
                  <td className="p-3 font-mono tabular-nums text-slate-900">
                    {Number(p.total_allocated).toLocaleString('en-EG', {
                      minimumFractionDigits: 2,
                      maximumFractionDigits: 2,
                    })}
                  </td>
                  <td className="p-3 font-mono tabular-nums text-slate-700">
                    {Number(p.lines_count)}
                  </td>
                  <td className="p-3 text-slate-700">
                    {p.created_by_name ?? '—'}
                  </td>
                  <td className="p-3 text-xs text-slate-500">
                    {fmtCairoDate(p.created_at)}
                  </td>
                  <td className="p-3 text-left">
                    <div className="flex items-center justify-end gap-1">
                      {canManage && p.status === 'draft' && (
                        <button
                          type="button"
                          aria-label="حذف المسودة"
                          title="حذف المسودة"
                          onClick={(e) => {
                            e.stopPropagation();
                            setDeleteCandidate(p);
                          }}
                          className="rounded p-1 text-rose-500 hover:bg-rose-50 hover:text-rose-700"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      )}
                      <ArrowLeftCircle className="h-4 w-4 text-slate-400" />
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-slate-400">
        إنشاء وحذف الفترات المسودة متاحان لمن لديه صلاحية{' '}
        <code className="font-mono">expense_allocation.manage</code>. التعديل
        على السطور واعتماد وعكس الفترات يظهران داخل صفحة التفاصيل. الفترات
        المعكوسة (سجل تدقيقي) مخفية افتراضيًا — استخدم زر «إظهار المعكوسة»
        أو فلتر الحالة لعرضها.
      </p>

      {/* PR-FE-B.2 — write modals, mounted only when the operator
          has `expense_allocation.manage`.  Each modal renders a
          backdrop only while `open` is true (no DOM cost otherwise). */}
      {canManage && (
        <>
          <PeriodHeaderModal
            open={createOpen}
            mode="create"
            onClose={() => setCreateOpen(false)}
            onSuccess={(period) => navigate(`/expense-allocations/${period.id}`)}
          />
          <DeleteDraftDialog
            open={!!deleteCandidate}
            periodId={deleteCandidate?.id ?? ''}
            linesCount={Number(deleteCandidate?.lines_count ?? 0)}
            onClose={() => setDeleteCandidate(null)}
          />
        </>
      )}
    </div>
  );
}
