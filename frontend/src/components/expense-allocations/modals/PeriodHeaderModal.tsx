/**
 * PeriodHeaderModal — create draft + edit draft header (PR-FE-B.2).
 *
 * Two modes, one component:
 *   * `create` — from the list page; calls `createPeriod`.
 *   * `edit`   — from the detail page; calls `updatePeriod`.
 *
 * Form fields: period_start, period_end, warehouse_id (optional —
 * "جميع المخازن" sends null), notes (optional).  Native date inputs
 * emit 'YYYY-MM-DD' which matches the backend contract directly.
 *
 * Edit mode shows the verbatim FE-B design warning if the operator
 * changes warehouse_id while lines exist:
 *   "تنبيه: تغيير المخزن بعد إضافة السطور قد يجعل السطور الحالية
 *    غير متسقة مع نطاق الفترة."
 *
 * PR-FE-B.2 scope: no line UI, no approve, no reverse — those are
 * wired by sibling modals (DeleteDraftDialog, ApprovePeriodDialog in
 * this PR; line + reverse in FE-B.3 / FE-B.4).
 */
import { useEffect, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertTriangle, X } from 'lucide-react';
import {
  expenseAllocationsApi,
  type AllocationPeriodDetail,
} from '@/api/expenseAllocations.api';
import { WarehousePicker } from '@/components/expense-allocations/pickers/WarehousePicker';

type Mode = 'create' | 'edit';

export interface PeriodHeaderInitial {
  id: string;
  period_start: string;
  period_end: string;
  warehouse_id: string | null;
  notes: string | null;
  lines_count: number;
}

export interface PeriodHeaderModalProps {
  open: boolean;
  mode: Mode;
  initial?: PeriodHeaderInitial;
  onClose: () => void;
  onSuccess?: (period: AllocationPeriodDetail) => void;
}

export function PeriodHeaderModal({
  open,
  mode,
  initial,
  onClose,
  onSuccess,
}: PeriodHeaderModalProps) {
  const qc = useQueryClient();

  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [warehouseId, setWarehouseId] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Reset form whenever the dialog re-opens, populating from `initial`
  // in edit mode so the user sees the existing values.
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (mode === 'edit' && initial) {
      setPeriodStart(initial.period_start);
      setPeriodEnd(initial.period_end);
      setWarehouseId(initial.warehouse_id);
      setNotes(initial.notes ?? '');
    } else {
      setPeriodStart('');
      setPeriodEnd('');
      setWarehouseId(null);
      setNotes('');
    }
  }, [open, mode, initial]);

  const formatError = (err: unknown): string => {
    const e = err as { response?: { data?: { message?: unknown } }; message?: string };
    const m = e?.response?.data?.message ?? e?.message;
    if (Array.isArray(m)) return String(m[0]);
    return typeof m === 'string'
      ? m
      : mode === 'create'
        ? 'تعذر إنشاء الفترة.'
        : 'تعذر تحديث الفترة.';
  };

  const createMut = useMutation({
    mutationFn: () =>
      expenseAllocationsApi.createPeriod({
        period_start: periodStart,
        period_end: periodEnd,
        warehouse_id: warehouseId ?? undefined,
        notes: notes.trim() || undefined,
      }),
    onSuccess: (period) => {
      qc.invalidateQueries({ queryKey: ['allocations', 'periods'] });
      toast.success('تم إنشاء فترة المسودة.');
      onClose();
      onSuccess?.(period);
    },
    onError: (err) => setError(formatError(err)),
  });

  const updateMut = useMutation({
    mutationFn: () => {
      if (!initial) throw new Error('edit mode requires initial');
      // warehouse_id: pass through `null` to clear; the API treats
      // null explicitly as "company-wide".  notes: same semantics.
      return expenseAllocationsApi.updatePeriod(initial.id, {
        period_start: periodStart,
        period_end: periodEnd,
        warehouse_id: warehouseId,
        notes: notes.trim() === '' ? null : notes.trim(),
      });
    },
    onSuccess: (period) => {
      if (!initial) return;
      qc.invalidateQueries({ queryKey: ['allocations', 'periods'] });
      qc.invalidateQueries({ queryKey: ['allocations', 'period', initial.id] });
      toast.success('تم تحديث رأس الفترة.');
      onClose();
      onSuccess?.(period);
    },
    onError: (err) => setError(formatError(err)),
  });

  const isSubmitting = createMut.isPending || updateMut.isPending;
  const dateOrderOk = !!periodStart && !!periodEnd && periodEnd >= periodStart;
  const datesPresentButReversed =
    !!periodStart && !!periodEnd && periodEnd < periodStart;
  const canSubmit = dateOrderOk && !isSubmitting;

  const warehouseChanged =
    mode === 'edit' && !!initial && warehouseId !== initial.warehouse_id;
  const showWarehouseChangeWarning =
    warehouseChanged && (initial?.lines_count ?? 0) > 0;

  if (!open) return null;

  const title =
    mode === 'create' ? 'إنشاء فترة توزيع جديدة' : 'تعديل رأس فترة التوزيع';
  const submit = () =>
    mode === 'create' ? createMut.mutate() : updateMut.mutate();

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
        className="w-full max-w-lg overflow-hidden rounded-2xl bg-white shadow-xl"
      >
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <h3 className="text-base font-semibold text-slate-900">{title}</h3>
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

        <div className="space-y-3 px-5 py-4 text-sm">
          {error && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">
              {error}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-700">
                من تاريخ
              </span>
              <input
                type="date"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                disabled={isSubmitting}
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none disabled:bg-slate-50"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-700">
                إلى تاريخ
              </span>
              <input
                type="date"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                min={periodStart || undefined}
                disabled={isSubmitting}
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none disabled:bg-slate-50"
              />
            </label>
          </div>
          {datesPresentButReversed && (
            <div className="text-xs text-rose-600">
              «إلى تاريخ» يجب أن يكون مساويًا أو بعد «من تاريخ».
            </div>
          )}

          <div>
            <span className="mb-1 block text-xs font-medium text-slate-700">
              المخزن (اختياري — اتركه فارغًا للسماح بجميع المخازن)
            </span>
            <WarehousePicker
              value={warehouseId}
              onChange={(id) => setWarehouseId(id)}
              placeholder="جميع المخازن"
              allowAll
              disabled={isSubmitting}
            />
          </div>

          {showWarehouseChangeWarning && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
              <AlertTriangle className="h-4 w-4 shrink-0" />
              <div>
                تنبيه: تغيير المخزن بعد إضافة السطور قد يجعل السطور الحالية
                غير متسقة مع نطاق الفترة.
              </div>
            </div>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-700">
              ملاحظات (اختياري)
            </span>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              maxLength={500}
              disabled={isSubmitting}
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none disabled:bg-slate-50"
            />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            إلغاء
          </button>
          <button
            type="button"
            onClick={submit}
            disabled={!canSubmit}
            className="rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isSubmitting
              ? 'جاري الحفظ…'
              : mode === 'create'
                ? 'إنشاء'
                : 'حفظ التعديلات'}
          </button>
        </div>
      </div>
    </div>
  );
}
