import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Wallet2,
  RefreshCw,
  ArrowRightCircle,
  Calendar,
  Calculator,
  UserCircle2,
  Warehouse,
  AlertTriangle,
  Pencil,
  Plus,
  ShieldCheck,
  Eraser,
  Trash2,
  Undo2,
} from 'lucide-react';
import {
  expenseAllocationsApi,
  type AllocationLineRow,
} from '@/api/expenseAllocations.api';
import { PeriodStatusBadge } from '@/components/expense-allocations/PeriodStatusBadge';
import { AllocationBanner } from '@/components/expense-allocations/AllocationBanner';
// PR-FE-B.2 — period-level write actions.
// PR-FE-B.3 — line-level write actions (add/edit + clear-all).
// PR-FE-B.4 — reverse-approved write action.
// PR-FE-C   — preview + save-preview wizard.
import { PeriodHeaderModal } from '@/components/expense-allocations/modals/PeriodHeaderModal';
import { DeleteDraftDialog } from '@/components/expense-allocations/modals/DeleteDraftDialog';
import { ApprovePeriodDialog } from '@/components/expense-allocations/modals/ApprovePeriodDialog';
import { LineModal } from '@/components/expense-allocations/modals/LineModal';
import { ClearLinesDialog } from '@/components/expense-allocations/modals/ClearLinesDialog';
import { DeleteLineDialog } from '@/components/expense-allocations/modals/DeleteLineDialog';
import { ReversePeriodDialog } from '@/components/expense-allocations/modals/ReversePeriodDialog';
import { PreviewWizardModal } from '@/components/expense-allocations/modals/PreviewWizardModal';
import { useAuthStore } from '@/stores/auth.store';
import { fmtCairoDate, fmtCairoDateTimeSeconds } from '@/lib/dates';

/**
 * Allocation period detail — PR-FE-A (read) + PR-FE-B.2 (period write)
 * + PR-FE-B.3 (line write) + PR-FE-B.4 (reverse-approved) +
 * PR-PHASE2-B5 (per-line delete).
 *
 * Renders the period header (with audit fields based on status) and
 * the lines table.  Three write surfaces, each gated by
 * `expense_allocation.manage` AND the period's FSM state:
 *
 *   draft     → تعديل الرأس · + سطر يدوي · pencil-per-line · trash-
 *               per-line · مسح كل السطور (when lines>0) · اعتماد
 *               (when lines>0) · حذف الفترة.
 *   approved  → عكس only.  Approve is recoverable via reverse, so
 *               approved periods are otherwise read-only.
 *   reversed  → no write actions.  Terminal state — period stays
 *               visible as an audit record (lines + reversed_by/at/
 *               reason).
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

  // PR-FE-B.2 — defense-in-depth: server enforces
  // `expense_allocation.manage` on every write, but the UI also hides
  // every action when the operator lacks the permission.
  const canManage = useAuthStore((s) => s.hasPermission)(
    'expense_allocation.manage',
  );
  const [editOpen, setEditOpen] = useState(false);
  const [approveOpen, setApproveOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  // PR-FE-B.3 — line-level dialog state.
  const [addLineOpen, setAddLineOpen] = useState(false);
  const [editLineCandidate, setEditLineCandidate] =
    useState<AllocationLineRow | null>(null);
  const [clearLinesOpen, setClearLinesOpen] = useState(false);
  // PR-PHASE2-B5 — per-line delete dialog state.  Same draft + manage
  // gate as the edit pencil; mirror's clearLinesOpen at the line scope.
  const [deleteLineCandidate, setDeleteLineCandidate] =
    useState<AllocationLineRow | null>(null);
  // PR-FE-B.4 — reverse-approved dialog state.
  const [reverseOpen, setReverseOpen] = useState(false);
  // PR-FE-C — preview wizard state.  Open to anyone with the view
  // permission (preview is server-side read-only); the wizard's
  // internal Save button gates itself on manage + draft.
  const [previewOpen, setPreviewOpen] = useState(false);

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

  const isDraft = period?.status === 'draft';
  const isApproved = period?.status === 'approved';
  const isReversed = period?.status === 'reversed';
  const linesCount = period?.lines.length ?? 0;
  const showWriteActions = canManage && isDraft;
  const showReverseAction = canManage && isApproved;
  // PR-FE-UX-ALLOC-1 — visible reason row for non-draft periods so the
  // operator immediately understands why action buttons are absent.
  // Symmetric to the existing approved row at the same coordinates.
  const showReversedNotice = isReversed;

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
        {/* PR-FE-C — Preview wizard entry-point.  Server gates the
            preview endpoint with `expense_allocation.view`, so this
            button is visible to anyone who can already view the
            page.  The Save button inside the wizard self-gates on
            `expense_allocation.manage` AND `status === 'draft'`. */}
        {period && (
          <button
            type="button"
            onClick={() => setPreviewOpen(true)}
            className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
          >
            <Calculator className="h-4 w-4" />
            <span>معاينة التوزيع</span>
          </button>
        )}
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

            {/* PR-FE-B.2 + PR-FE-B.3 — period-level + line-level
                actions for draft periods.  Order (RTL, right→left):
                  · تعديل الرأس
                  · + سطر يدوي
                  · اعتماد
                  · (spacer)
                  · مسح كل السطور (only when lines exist)
                  · حذف الفترة */}
            {showWriteActions && (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                <button
                  type="button"
                  onClick={() => setEditOpen(true)}
                  className="inline-flex items-center gap-2 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50"
                >
                  <Pencil className="h-4 w-4" />
                  <span>تعديل الرأس</span>
                </button>
                <button
                  type="button"
                  onClick={() => setAddLineOpen(true)}
                  className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700"
                >
                  <Plus className="h-4 w-4" />
                  <span>سطر يدوي</span>
                </button>
                <button
                  type="button"
                  onClick={() => setApproveOpen(true)}
                  disabled={linesCount === 0}
                  title={
                    linesCount === 0
                      ? 'أضف سطرًا واحدًا على الأقل قبل الاعتماد.'
                      : undefined
                  }
                  className="inline-flex items-center gap-2 rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ShieldCheck className="h-4 w-4" />
                  <span>اعتماد</span>
                </button>
                <div className="flex-1" />
                {linesCount > 0 && (
                  <button
                    type="button"
                    onClick={() => setClearLinesOpen(true)}
                    className="inline-flex items-center gap-2 rounded-md border border-amber-200 bg-white px-3 py-1.5 text-sm text-amber-700 hover:bg-amber-50"
                  >
                    <Eraser className="h-4 w-4" />
                    <span>مسح كل السطور</span>
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setDeleteOpen(true)}
                  className="inline-flex items-center gap-2 rounded-md border border-rose-200 bg-white px-3 py-1.5 text-sm text-rose-700 hover:bg-rose-50"
                >
                  <Trash2 className="h-4 w-4" />
                  <span>حذف الفترة</span>
                </button>
              </div>
            )}

            {/* PR-FE-B.4 — single-button action row for approved
                periods.  Reverse is the only operation allowed once
                approved (the FSM is draft → approved → reversed, and
                reversed is terminal). */}
            {showReverseAction && (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                <span className="text-xs text-slate-500">
                  الفترة معتمدة. التعديل على الرأس والسطور غير متاح.
                </span>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => setReverseOpen(true)}
                  title="العكس إجراء تدقيقي لا رجعة فيه. يتطلب سببًا."
                  className="inline-flex items-center gap-2 rounded-md border border-amber-300 bg-white px-3 py-1.5 text-sm font-medium text-amber-700 hover:bg-amber-50"
                >
                  <Undo2 className="h-4 w-4" />
                  <span>عكس</span>
                </button>
              </div>
            )}

            {/* PR-FE-UX-ALLOC-1 — symmetric notice for reversed
                (terminal) periods.  Without this row the page looked
                "empty of actions" without an in-context reason,
                leading admin users to suspect a missing permission. */}
            {showReversedNotice && (
              <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3">
                <Undo2 className="h-4 w-4 text-slate-400" />
                <span className="text-xs text-slate-500">
                  هذه الفترة معكوسة (حالة نهائية). الصفحة للعرض فقط
                  كسجل تدقيقي — لا توجد إجراءات تعديل.
                </span>
              </div>
            )}
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
                  {showWriteActions && (
                    <th className="w-12 p-3 text-right font-medium"></th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {period.lines.length === 0 ? (
                  <tr>
                    <td
                      colSpan={showWriteActions ? 8 : 7}
                      className="p-6 text-center text-slate-500"
                    >
                      <div>لا توجد سطور في هذه الفترة.</div>
                      {/* PR-FE-B.3 — empty-state hint, draft + manage only. */}
                      {showWriteActions && (
                        <div className="mt-1 text-xs text-slate-400">
                          اضغط «+ سطر يدوي» لإضافة أول سطر.
                        </div>
                      )}
                    </td>
                  </tr>
                ) : (
                  period.lines.map((l) => (
                    <LineRow
                      key={l.id}
                      line={l}
                      canEdit={showWriteActions}
                      onEdit={() => setEditLineCandidate(l)}
                      onDelete={() => setDeleteLineCandidate(l)}
                    />
                  ))
                )}
              </tbody>
            </table>
          </div>

          <p className="text-[11px] text-slate-400">
            جميع إجراءات الكتابة (تعديل، إضافة سطر، اعتماد، حذف، عكس) تظهر
            لمن لديه صلاحية{' '}
            <code className="font-mono">expense_allocation.manage</code>.
            الإجراءات المتاحة تتغير حسب حالة الفترة: مسودة (تعديل/سطور/
            اعتماد/حذف) أو معتمدة (عكس فقط) أو معكوسة (للعرض كسجل تدقيقي).
          </p>
        </>
      )}

      {/* PR-FE-B.2 + PR-FE-B.3 — write modals.  Each renders its
          overlay only while `open` is true (no DOM cost otherwise),
          and the whole tree stays unmounted for users without
          `expense_allocation.manage`. */}
      {canManage && period && (
        <>
          <PeriodHeaderModal
            open={editOpen}
            mode="edit"
            initial={{
              id: period.id,
              period_start: period.period_start,
              period_end: period.period_end,
              warehouse_id: period.warehouse_id,
              notes: period.notes,
              lines_count: period.lines.length,
            }}
            onClose={() => setEditOpen(false)}
          />
          <ApprovePeriodDialog
            open={approveOpen}
            period={period}
            onClose={() => setApproveOpen(false)}
          />
          <DeleteDraftDialog
            open={deleteOpen}
            periodId={period.id}
            linesCount={period.lines.length}
            onClose={() => setDeleteOpen(false)}
            onDeleted={() => navigate('/expense-allocations')}
          />
          {/* PR-FE-B.3 — line CRUD + clear-all. */}
          <LineModal
            open={addLineOpen}
            mode="create"
            periodId={period.id}
            periodStart={period.period_start}
            periodEnd={period.period_end}
            onClose={() => setAddLineOpen(false)}
          />
          <LineModal
            open={!!editLineCandidate}
            mode="edit"
            periodId={period.id}
            periodStart={period.period_start}
            periodEnd={period.period_end}
            initial={
              editLineCandidate
                ? {
                    id: editLineCandidate.id,
                    expense_id: editLineCandidate.expense_id,
                    expense_category_id:
                      editLineCandidate.expense_category_id,
                    source_amount: editLineCandidate.source_amount,
                    product_id: editLineCandidate.product_id,
                    product_category_id:
                      editLineCandidate.product_category_id,
                    warehouse_id: editLineCandidate.warehouse_id,
                    allocated_amount: editLineCandidate.allocated_amount,
                    // PR-FE-C — forward the stored method so the
                    // chip in the edit modal reflects reality
                    // (manual / by_revenue / by_units_sold / etc).
                    allocation_method: editLineCandidate.allocation_method,
                  }
                : undefined
            }
            onClose={() => setEditLineCandidate(null)}
          />
          <ClearLinesDialog
            open={clearLinesOpen}
            periodId={period.id}
            linesCount={period.lines.length}
            totalAllocated={period.total_allocated}
            onClose={() => setClearLinesOpen(false)}
          />
          {/* PR-PHASE2-B5 — per-line delete.  Mounted alongside the
              edit modal so the line's identity stays in state while
              the typed-confirm dialog is open. */}
          <DeleteLineDialog
            open={!!deleteLineCandidate}
            periodId={period.id}
            lineId={deleteLineCandidate?.id ?? ''}
            lineLabel={
              deleteLineCandidate ? lineLabelFor(deleteLineCandidate) : ''
            }
            lineAmount={deleteLineCandidate?.allocated_amount ?? '0'}
            onClose={() => setDeleteLineCandidate(null)}
          />
          {/* PR-FE-B.4 — reverse-approved. */}
          <ReversePeriodDialog
            open={reverseOpen}
            periodId={period.id}
            onClose={() => setReverseOpen(false)}
          />
        </>
      )}
      {/* PR-FE-C — preview wizard.  Mounted outside the canManage
          block because preview itself is read-only — viewers can
          open the wizard and see the proposed lines.  The wizard's
          internal Save button hides itself for non-manage / non-
          draft. */}
      {period && (
        <PreviewWizardModal
          open={previewOpen}
          period={period}
          canManage={canManage}
          onClose={() => setPreviewOpen(false)}
        />
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

function LineRow({
  line,
  canEdit,
  onEdit,
  onDelete,
}: {
  line: AllocationLineRow;
  canEdit?: boolean;
  onEdit?: () => void;
  onDelete?: () => void;
}) {
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
      {/* PR-FE-B.3 / PR-PHASE2-B5 — pencil opens the LineModal in edit
          mode; trash opens the per-line typed-confirm DeleteLineDialog.
          Both icons share the same draft + manage gate (canEdit). */}
      {canEdit && (
        <td className="p-3 text-left">
          <div className="flex items-center justify-end gap-1">
            <button
              type="button"
              aria-label="تعديل السطر"
              title="تعديل السطر"
              onClick={onEdit}
              className="rounded p-1 text-slate-500 hover:bg-slate-100 hover:text-slate-700"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              aria-label="حذف السطر"
              title="حذف السطر"
              onClick={onDelete}
              className="rounded p-1 text-slate-500 hover:bg-rose-50 hover:text-rose-700"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
        </td>
      )}
    </tr>
  );
}

/**
 * Compose a short human-readable label for a line — used in the
 * per-line delete confirm dialog so the operator can sanity-check
 * which row they're about to remove.  Mirrors the (source → target)
 * layout the table already shows; the amount is rendered separately
 * by DeleteLineDialog.
 */
function lineLabelFor(line: AllocationLineRow): string {
  const source = line.expense_no
    ? `مصروف ${line.expense_no}`
    : line.expense_category_name
      ? `فئة ${line.expense_category_name}`
      : '—';
  const target =
    line.product_name ??
    line.product_category_name ??
    line.target_warehouse_name ??
    '—';
  return `${source} ← ${target}`;
}
