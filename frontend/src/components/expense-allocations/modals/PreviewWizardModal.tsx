/**
 * PreviewWizardModal — engine-driven batch allocation (PR-FE-C).
 *
 * Linear 3-step wizard with an optional 4th replace-confirmation
 * step:
 *
 *   1. Source        : pick approved expense OR expense category.
 *   2. Target/Method : pick target_kind (product/category/warehouse)
 *                      and method (by_revenue/by_units_sold/by_gross_profit).
 *   3. Result        : POST /preview, render proposed_lines + stats.
 *                      Save Preview (manage + draft) advances to:
 *   4. Replace?      : conditional — only when the first save-preview
 *                      attempt returns 400 «الفترة تحتوي على سطور
 *                      بالفعل», ask the operator to type «استبدال»
 *                      to retry with replace_existing=true.
 *
 * Hard scope reminders (mirror FE-C design):
 *   * Preview is server-side `expense_allocation.view` — viewers can
 *     open the wizard and run preview.  The Save Preview button is
 *     hidden for viewers and for non-draft periods.
 *   * Save Preview does NOT approve the period.  After save, the
 *     wizard closes and the lines appear on the detail page; the
 *     operator must still click اعتماد separately to approve.
 *   * Reports are NOT invalidated on save-preview — they consume
 *     approved-only data, so saving lines into a draft can't change
 *     what they show.  Approve/reverse keep their existing report
 *     invalidations.
 *   * Method labels reuse the existing METHOD_LABEL map shape from
 *     ExpenseAllocationDetail.tsx; kept inline here for cohesion.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  ArrowLeftCircle,
  ArrowRightCircle,
  Calculator,
  X,
} from 'lucide-react';
import {
  expenseAllocationsApi,
  type AllocationPeriodDetail,
  type PreviewBody,
  type PreviewMethod,
  type PreviewProposedLine,
  type PreviewResult,
  type PreviewTargetKind,
} from '@/api/expenseAllocations.api';
import { ExpensePicker } from '@/components/expense-allocations/pickers/ExpensePicker';
import { ExpenseCategoryPicker } from '@/components/expense-allocations/pickers/ExpenseCategoryPicker';

export interface PreviewWizardModalProps {
  open: boolean;
  period: AllocationPeriodDetail;
  canManage: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

type Step = 'source' | 'target_method' | 'result' | 'replace_confirm';
type SourceKind = 'expense' | 'expense_category';

const METHOD_LABEL_AR: Record<PreviewMethod, string> = {
  by_revenue: 'حسب الإيراد',
  by_units_sold: 'حسب الكمية المباعة',
  by_gross_profit: 'حسب الربح الإجمالي',
};

const TARGET_LABEL_AR: Record<PreviewTargetKind, string> = {
  product: 'منتج',
  category: 'فئة منتج',
  warehouse: 'مخزن',
};

// PR-FE-C-POLISH-1 — single source of truth for the «lines exist»
// message pattern.  Used in TWO places:
//   1. `isLinesExistError(err)` below, to switch the wizard to the
//      replace-confirm step on 400.
//   2. The `_silentOnErrorPattern` on the save-preview request config,
//      so the global axios toast doesn't fire the same Arabic message
//      in parallel.  See `api/client.ts` ApiRequestConfig docs.
//
// Stable substring from BadRequestException at backend/src/expense-
// allocations/expense-allocations.service.ts:886.  Any future
// translation tweak of the rest of the sentence stays grep-safe.
const LINES_EXIST_PATTERN = /تحتوي على سطور/;

const isLinesExistError = (err: unknown): boolean => {
  const e = err as {
    response?: { status?: number; data?: { message?: unknown } };
  };
  if (e?.response?.status !== 400) return false;
  const msg = e.response?.data?.message;
  const text = Array.isArray(msg) ? String(msg[0]) : String(msg ?? '');
  return LINES_EXIST_PATTERN.test(text);
};

const formatError = (err: unknown, fallback: string): string => {
  const e = err as {
    response?: { data?: { message?: unknown } };
    message?: string;
  };
  const m = e?.response?.data?.message ?? e?.message;
  if (Array.isArray(m)) return String(m[0]);
  return typeof m === 'string' && m ? m : fallback;
};

export function PreviewWizardModal({
  open,
  period,
  canManage,
  onClose,
  onSaved,
}: PreviewWizardModalProps) {
  const qc = useQueryClient();

  const [step, setStep] = useState<Step>('source');

  const [sourceKind, setSourceKind] = useState<SourceKind>('expense');
  const [expenseId, setExpenseId] = useState<string | null>(null);
  const [expenseCategoryId, setExpenseCategoryId] = useState<string | null>(
    null,
  );

  const [targetKind, setTargetKind] = useState<PreviewTargetKind>('product');
  const [method, setMethod] = useState<PreviewMethod>('by_revenue');

  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [typedReplace, setTypedReplace] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Reset on every open transition — no stale config carry-over.
  useEffect(() => {
    if (!open) return;
    setStep('source');
    setSourceKind('expense');
    setExpenseId(null);
    setExpenseCategoryId(null);
    setTargetKind('product');
    setMethod('by_revenue');
    setPreview(null);
    setTypedReplace('');
    setError(null);
  }, [open]);

  const previewBody = useMemo<PreviewBody>(
    () => ({
      source:
        sourceKind === 'expense'
          ? { expense_id: expenseId ?? undefined }
          : { expense_category_id: expenseCategoryId ?? undefined },
      target_kind: targetKind,
      method,
    }),
    [sourceKind, expenseId, expenseCategoryId, targetKind, method],
  );

  const previewMut = useMutation({
    mutationFn: () =>
      expenseAllocationsApi.previewAllocation(period.id, previewBody),
    onSuccess: (data) => {
      setPreview(data);
      setError(null);
      setStep('result');
    },
    onError: (err) =>
      setError(formatError(err, 'تعذر تشغيل المعاينة.')),
  });

  const saveMut = useMutation({
    mutationFn: (replace: boolean) =>
      expenseAllocationsApi.savePreview(
        period.id,
        {
          ...previewBody,
          replace_existing: replace,
        },
        {
          // PR-FE-C-POLISH-1 — suppress the global axios toast ONLY
          // for the expected «lines exist» 400 we already translate
          // into the replace-confirm step below.  Any other 4xx on
          // this call (e.g. 403, validation, server error) still
          // toasts as usual.
          _silentOnErrorPattern: LINES_EXIST_PATTERN,
        },
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['allocations', 'periods'] });
      qc.invalidateQueries({
        queryKey: ['allocations', 'period', period.id],
      });
      // Reports are NOT invalidated here — they only show approved
      // data, and save-preview never approves.  Approve/reverse keep
      // their existing report invalidations.
      toast.success('تم حفظ سطور المعاينة.');
      onClose();
      onSaved?.();
    },
    onError: (err) => {
      if (isLinesExistError(err)) {
        setError(null);
        setTypedReplace('');
        setStep('replace_confirm');
        return;
      }
      setError(formatError(err, 'تعذر حفظ سطور المعاينة.'));
    },
  });

  if (!open) return null;

  // ─── Step-specific derived state ───────────────────────────────

  const sourceSelected =
    sourceKind === 'expense' ? !!expenseId : !!expenseCategoryId;

  const hasProposed =
    !!preview && preview.proposed_lines && preview.proposed_lines.length > 0;
  const hasZeroBasis = !!preview?.zero_basis_warning;
  const showSaveButton =
    !!preview &&
    canManage &&
    period.status === 'draft' &&
    hasProposed &&
    !hasZeroBasis;

  const isSubmitting = previewMut.isPending || saveMut.isPending;
  const canRunPreview = sourceSelected && !isSubmitting;
  const replaceMatches = typedReplace.trim() === 'استبدال';

  // ─── Render helpers ─────────────────────────────────────────────

  const StepDots = () => {
    // Three visible dots regardless of step 4; step 4 is a branch
    // off step 3, not a fourth "phase" of the user's mental model.
    const idx =
      step === 'source'
        ? 0
        : step === 'target_method'
          ? 1
          : 2;
    return (
      <div className="flex items-center gap-1">
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className={
              i === idx
                ? 'h-1.5 w-6 rounded-full bg-violet-500'
                : i < idx
                  ? 'h-1.5 w-3 rounded-full bg-violet-200'
                  : 'h-1.5 w-3 rounded-full bg-slate-200'
            }
          />
        ))}
      </div>
    );
  };

  const Banner = () =>
    error ? (
      <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800">
        {error}
      </div>
    ) : null;

  // ─── Step renderers ─────────────────────────────────────────────

  const renderSource = () => (
    <div className="space-y-3 text-sm">
      <Banner />
      <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        المصدر
      </div>
      <Segmented<SourceKind>
        value={sourceKind}
        onChange={setSourceKind}
        disabled={isSubmitting}
        options={[
          { value: 'expense', label: 'مصروف معتمد' },
          { value: 'expense_category', label: 'فئة مصاريف' },
        ]}
      />
      {sourceKind === 'expense' ? (
        <ExpensePicker
          value={expenseId}
          onChange={(id) => setExpenseId(id)}
          period_start={period.period_start}
          period_end={period.period_end}
          disabled={isSubmitting}
        />
      ) : (
        <ExpenseCategoryPicker
          value={expenseCategoryId}
          onChange={(id) => setExpenseCategoryId(id)}
          disabled={isSubmitting}
        />
      )}
    </div>
  );

  const renderTargetMethod = () => (
    <div className="space-y-4 text-sm">
      <Banner />
      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          الهدف
        </div>
        <Segmented<PreviewTargetKind>
          value={targetKind}
          onChange={setTargetKind}
          disabled={isSubmitting}
          options={[
            { value: 'product', label: TARGET_LABEL_AR.product },
            { value: 'category', label: TARGET_LABEL_AR.category },
            { value: 'warehouse', label: TARGET_LABEL_AR.warehouse },
          ]}
        />
      </div>
      <div className="space-y-2">
        <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          طريقة التوزيع
        </div>
        <Segmented<PreviewMethod>
          value={method}
          onChange={setMethod}
          disabled={isSubmitting}
          options={[
            { value: 'by_revenue', label: METHOD_LABEL_AR.by_revenue },
            {
              value: 'by_units_sold',
              label: METHOD_LABEL_AR.by_units_sold,
            },
            {
              value: 'by_gross_profit',
              label: METHOD_LABEL_AR.by_gross_profit,
            },
          ]}
        />
      </div>
    </div>
  );

  const renderResult = () => {
    if (!preview) return null;
    const sourceAmount = Number(preview.source.amount);
    return (
      <div className="space-y-3 text-sm">
        <Banner />

        {preview.zero_basis_warning && (
          <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <div>{preview.zero_basis_warning}</div>
          </div>
        )}

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          <SummaryChip
            label="مبلغ المصدر"
            value={sourceAmount.toLocaleString('en-EG', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
            suffix="جنيه"
          />
          <SummaryChip
            label="عدد الأهداف"
            value={String(preview.candidates_total)}
            note={
              preview.candidates_excluded > 0
                ? `+${preview.candidates_excluded} مستبعد`
                : undefined
            }
          />
          <SummaryChip
            label="إجمالي القاعدة"
            value={Number(preview.total_basis).toLocaleString('en-EG', {
              maximumFractionDigits: 6,
            })}
          />
          <SummaryChip
            label="فرق التقريب"
            value={Number(preview.rounding_residual).toLocaleString('en-EG', {
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            })}
          />
        </div>

        <div className="overflow-hidden rounded-md border border-slate-200">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <th className="p-2 text-right font-medium">الهدف</th>
                <th className="p-2 text-right font-medium">قيمة القاعدة</th>
                <th className="p-2 text-right font-medium">الوزن %</th>
                <th className="p-2 text-right font-medium">المبلغ المقترح</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {preview.proposed_lines.length === 0 ? (
                <tr>
                  <td
                    colSpan={4}
                    className="p-4 text-center text-slate-400"
                  >
                    لا توجد سطور مقترحة.
                  </td>
                </tr>
              ) : (
                preview.proposed_lines.map((line) => (
                  <ProposedLineRow
                    key={line.target_id}
                    line={line}
                    isResidualAbsorber={
                      preview.rounding_residual_absorbed_into_target_id ===
                      line.target_id
                    }
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        <p className="text-[11px] text-slate-400">
          هذه المعاينة محسوبة على الخادم بدون أي كتابة في قاعدة البيانات.
          الحفظ ينشئ السطور في الفترة كمسودة — لا يُعتمَد الاعتماد تلقائيًا.
        </p>
      </div>
    );
  };

  const renderReplaceConfirm = () => {
    const newCount = preview?.proposed_lines.length ?? 0;
    return (
      <div className="space-y-3 text-sm">
        <Banner />
        <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <div className="text-sm">
            الفترة تحتوي على{' '}
            <span className="font-mono tabular-nums">
              {period.lines.length}
            </span>{' '}
            سطر بالفعل. حفظ المعاينة سيحذف هذه السطور ويستبدلها بـ{' '}
            <span className="font-mono tabular-nums">{newCount}</span> سطر
            جديد محسوب من المعاينة. لا يمكن التراجع.
          </div>
        </div>
        <label className="block">
          <span className="mb-1 block text-xs font-medium text-slate-700">
            للتأكيد، اكتب «<span className="font-semibold">استبدال</span>»:
          </span>
          <input
            type="text"
            value={typedReplace}
            onChange={(e) => setTypedReplace(e.target.value)}
            autoFocus
            disabled={saveMut.isPending}
            dir="rtl"
            className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none disabled:bg-slate-50"
          />
        </label>
      </div>
    );
  };

  // ─── Footer button rows per step ────────────────────────────────

  const renderFooter = () => {
    switch (step) {
      case 'source':
        return (
          <>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              إلغاء
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => setStep('target_method')}
              disabled={!sourceSelected || isSubmitting}
              className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <span>التالي</span>
              <ArrowLeftCircle className="h-4 w-4" />
            </button>
          </>
        );
      case 'target_method':
        return (
          <>
            <button
              type="button"
              onClick={() => setStep('source')}
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <ArrowRightCircle className="h-4 w-4" />
              <span>السابق</span>
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => previewMut.mutate()}
              disabled={!canRunPreview}
              className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Calculator className="h-4 w-4" />
              <span>
                {previewMut.isPending ? 'جاري الحساب…' : 'تشغيل المعاينة'}
              </span>
            </button>
          </>
        );
      case 'result':
        return (
          <>
            <button
              type="button"
              onClick={() => setStep('target_method')}
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <ArrowRightCircle className="h-4 w-4" />
              <span>السابق</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              إغلاق
            </button>
            <div className="flex-1" />
            {showSaveButton && (
              <button
                type="button"
                onClick={() => saveMut.mutate(false)}
                disabled={isSubmitting}
                className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {saveMut.isPending ? 'جاري الحفظ…' : 'حفظ المعاينة'}
              </button>
            )}
          </>
        );
      case 'replace_confirm':
        return (
          <>
            <button
              type="button"
              onClick={() => setStep('result')}
              disabled={saveMut.isPending}
              className="inline-flex items-center gap-2 rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
            >
              <ArrowRightCircle className="h-4 w-4" />
              <span>العودة للنتيجة</span>
            </button>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => saveMut.mutate(true)}
              disabled={!replaceMatches || saveMut.isPending}
              className="rounded-md bg-rose-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {saveMut.isPending ? 'جاري الاستبدال…' : 'استبدال'}
            </button>
          </>
        );
    }
  };

  const title =
    step === 'replace_confirm'
      ? 'استبدال السطور الحالية'
      : 'معاينة التوزيع';

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={isSubmitting ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl overflow-hidden rounded-2xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <div className="flex items-center gap-3">
            <h3 className="text-base font-semibold text-slate-900">
              {title}
            </h3>
            {step !== 'replace_confirm' && <StepDots />}
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="إغلاق"
            className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">
          {step === 'source' && renderSource()}
          {step === 'target_method' && renderTargetMethod()}
          {step === 'result' && renderResult()}
          {step === 'replace_confirm' && renderReplaceConfirm()}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 px-5 py-3">
          {renderFooter()}
        </div>
      </div>
    </div>
  );
}

// ─── Local sub-components ──────────────────────────────────────────

function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
  disabled?: boolean;
}) {
  return (
    <div className="inline-flex rounded-md border border-slate-200 bg-slate-50 p-1">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            disabled={disabled}
            className={
              active
                ? 'rounded bg-white px-3 py-1 text-xs font-medium text-slate-900 shadow-sm'
                : 'rounded px-3 py-1 text-xs text-slate-600 hover:text-slate-900'
            }
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function SummaryChip({
  label,
  value,
  suffix,
  note,
}: {
  label: string;
  value: string;
  suffix?: string;
  note?: string;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white px-3 py-2">
      <div className="text-[10px] font-medium text-slate-500">{label}</div>
      <div className="mt-0.5 font-mono tabular-nums text-sm text-slate-900">
        {value}
        {suffix && (
          <span className="ms-1 text-[10px] text-slate-400">{suffix}</span>
        )}
      </div>
      {note && (
        <div className="mt-0.5 text-[10px] text-slate-500">{note}</div>
      )}
    </div>
  );
}

function ProposedLineRow({
  line,
  isResidualAbsorber,
}: {
  line: PreviewProposedLine;
  isResidualAbsorber: boolean;
}) {
  return (
    <tr
      className={
        isResidualAbsorber ? 'bg-violet-50/40 hover:bg-violet-50/60' : 'hover:bg-slate-50'
      }
    >
      <td className="p-2 text-slate-800">
        <div className="flex items-center gap-1">
          <span>{line.target_name}</span>
          {isResidualAbsorber && (
            <span
              title="هذا الهدف يستوعب الكسر الناتج عن التقريب."
              className="rounded-full bg-violet-100 px-1.5 py-0.5 text-[9px] font-medium text-violet-700"
            >
              + الكسر
            </span>
          )}
        </div>
      </td>
      <td className="p-2 font-mono tabular-nums text-[11px] text-slate-700">
        {Number(line.basis_value).toLocaleString('en-EG', {
          maximumFractionDigits: 6,
        })}
      </td>
      <td className="p-2 font-mono tabular-nums text-[11px] text-slate-700">
        {Number(line.weight_pct).toLocaleString('en-EG', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 4,
        })}
        %
      </td>
      <td className="p-2 font-mono tabular-nums text-slate-900">
        {Number(line.proposed_amount).toLocaleString('en-EG', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}
      </td>
    </tr>
  );
}
