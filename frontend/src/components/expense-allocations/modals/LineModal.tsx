/**
 * LineModal — create + edit a manual allocation line (PR-FE-B.3).
 *
 * Two modes, one component (same pattern as PeriodHeaderModal):
 *   * `create` — from the detail page's `+ سطر يدوي` button;
 *     calls `addLine`.
 *   * `edit`   — from the per-line pencil icon; calls `updateLine`.
 *
 * Form contract mirrors the backend DTOs verbatim:
 *   · Source = exactly one of (expense_id | expense_category_id),
 *     selected via the segmented control at the top.
 *   · Target = exactly one of (product_id | product_category_id |
 *     warehouse_id), selected via the second segmented control.
 *   · `allocation_method` is locked to `'manual'` and shown as a
 *     read-only chip — PR-PHASE2-B2 backend only accepts 'manual'.
 *   · `source_amount` and `allocated_amount` are sent as numbers.
 *   · No `notes` field — backend accepts it on create but does not
 *     return it on read, so a write-only field would be misleading.
 *     (Decision recorded in the FE-B.3 design Q&A.)
 *
 * Hard validation: `allocated_amount > source_amount` blocks submit
 * with the verbatim message
 *   "المبلغ الموزع لا يمكن أن يتجاوز مبلغ المصدر."
 * Backend would reject too — the FE block is purely to save the
 * round-trip and surface the rule before the user clicks save.
 *
 * Edit-mode patch: always sends the canonical full shape (with
 * explicit `null` for the unselected source/target sibling fields)
 * so a kind-switch (e.g. product → warehouse) cleanly clears the
 * previous target column.  The backend `UpdateLineDto` treats `null`
 * as "clear" and `undefined` as "leave untouched".
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { X } from 'lucide-react';
import {
  expenseAllocationsApi,
  type AllocationLineRow,
} from '@/api/expenseAllocations.api';
import { ExpensePicker } from '@/components/expense-allocations/pickers/ExpensePicker';
import { ExpenseCategoryPicker } from '@/components/expense-allocations/pickers/ExpenseCategoryPicker';
import { ProductPicker } from '@/components/expense-allocations/pickers/ProductPicker';
import { ProductCategoryPicker } from '@/components/expense-allocations/pickers/ProductCategoryPicker';
import { WarehousePicker } from '@/components/expense-allocations/pickers/WarehousePicker';

type Mode = 'create' | 'edit';

type SourceKind = 'expense' | 'expense_category';
type TargetKind = 'product' | 'product_category' | 'warehouse';

export interface LineInitial {
  id: string;
  expense_id: string | null;
  expense_category_id: string | null;
  source_amount: string;
  product_id: string | null;
  product_category_id: string | null;
  warehouse_id: string | null;
  allocated_amount: string;
}

export interface LineModalProps {
  open: boolean;
  mode: Mode;
  periodId: string;
  /** YYYY-MM-DD — forwarded to ExpensePicker as its fixed range. */
  periodStart: string;
  periodEnd: string;
  initial?: LineInitial;
  onClose: () => void;
  onSuccess?: (line: AllocationLineRow) => void;
}

const deriveSourceKind = (init?: LineInitial): SourceKind =>
  init?.expense_id ? 'expense' : 'expense_category';

const deriveTargetKind = (init?: LineInitial): TargetKind => {
  if (init?.product_id) return 'product';
  if (init?.product_category_id) return 'product_category';
  return 'warehouse';
};

const numericStr = (v: string) => {
  if (v === '') return null;
  // Strip thousands separators users might type and Arabic-Indic
  // digits — keep the parser simple.
  const cleaned = v.replace(/[,،\s]/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

export function LineModal({
  open,
  mode,
  periodId,
  periodStart,
  periodEnd,
  initial,
  onClose,
  onSuccess,
}: LineModalProps) {
  const qc = useQueryClient();

  const [sourceKind, setSourceKind] = useState<SourceKind>('expense');
  const [expenseId, setExpenseId] = useState<string | null>(null);
  const [expenseCategoryId, setExpenseCategoryId] = useState<string | null>(
    null,
  );
  const [sourceAmount, setSourceAmount] = useState('');

  const [targetKind, setTargetKind] = useState<TargetKind>('product');
  const [productId, setProductId] = useState<string | null>(null);
  const [productCategoryId, setProductCategoryId] = useState<string | null>(
    null,
  );
  const [warehouseId, setWarehouseId] = useState<string | null>(null);

  const [allocatedAmount, setAllocatedAmount] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Hydrate the form whenever the dialog re-opens.  Edit mode reads
  // from `initial`; create mode resets to the empty defaults.
  useEffect(() => {
    if (!open) return;
    setError(null);
    if (mode === 'edit' && initial) {
      setSourceKind(deriveSourceKind(initial));
      setExpenseId(initial.expense_id);
      setExpenseCategoryId(initial.expense_category_id);
      setSourceAmount(String(Number(initial.source_amount)));
      setTargetKind(deriveTargetKind(initial));
      setProductId(initial.product_id);
      setProductCategoryId(initial.product_category_id);
      setWarehouseId(initial.warehouse_id);
      setAllocatedAmount(String(Number(initial.allocated_amount)));
    } else {
      setSourceKind('expense');
      setExpenseId(null);
      setExpenseCategoryId(null);
      setSourceAmount('');
      setTargetKind('product');
      setProductId(null);
      setProductCategoryId(null);
      setWarehouseId(null);
      setAllocatedAmount('');
    }
  }, [open, mode, initial]);

  const srcNum = useMemo(() => numericStr(sourceAmount), [sourceAmount]);
  const allocNum = useMemo(
    () => numericStr(allocatedAmount),
    [allocatedAmount],
  );

  const sourceSelected =
    sourceKind === 'expense' ? !!expenseId : !!expenseCategoryId;
  const targetSelected =
    targetKind === 'product'
      ? !!productId
      : targetKind === 'product_category'
        ? !!productCategoryId
        : !!warehouseId;

  const srcAmountValid = srcNum !== null && srcNum > 0;
  const allocAmountValid = allocNum !== null && allocNum > 0;
  const allocExceedsSrc =
    srcAmountValid && allocAmountValid && allocNum! > srcNum!;

  const formatError = (err: unknown): string => {
    const e = err as {
      response?: { data?: { message?: unknown } };
      message?: string;
    };
    const m = e?.response?.data?.message ?? e?.message;
    if (Array.isArray(m)) return String(m[0]);
    return typeof m === 'string'
      ? m
      : mode === 'create'
        ? 'تعذر إضافة السطر.'
        : 'تعذر تحديث السطر.';
  };

  const createMut = useMutation({
    mutationFn: () =>
      expenseAllocationsApi.addLine(periodId, {
        expense_id: sourceKind === 'expense' ? expenseId! : undefined,
        expense_category_id:
          sourceKind === 'expense_category' ? expenseCategoryId! : undefined,
        source_amount: srcNum!,
        product_id: targetKind === 'product' ? productId! : undefined,
        product_category_id:
          targetKind === 'product_category' ? productCategoryId! : undefined,
        warehouse_id: targetKind === 'warehouse' ? warehouseId! : undefined,
        allocation_method: 'manual',
        allocated_amount: allocNum!,
      }),
    onSuccess: (line) => {
      qc.invalidateQueries({ queryKey: ['allocations', 'periods'] });
      qc.invalidateQueries({
        queryKey: ['allocations', 'period', periodId],
      });
      toast.success('تم إضافة السطر.');
      onClose();
      onSuccess?.(line);
    },
    onError: (err) => setError(formatError(err)),
  });

  const updateMut = useMutation({
    mutationFn: () => {
      if (!initial) throw new Error('edit mode requires initial');
      // Always send the canonical full shape.  Explicit `null` on the
      // not-chosen sibling fields clears any leftover from the prior
      // source/target kind in the same call.
      return expenseAllocationsApi.updateLine(periodId, initial.id, {
        expense_id: sourceKind === 'expense' ? expenseId : null,
        expense_category_id:
          sourceKind === 'expense_category' ? expenseCategoryId : null,
        source_amount: srcNum!,
        product_id: targetKind === 'product' ? productId : null,
        product_category_id:
          targetKind === 'product_category' ? productCategoryId : null,
        warehouse_id: targetKind === 'warehouse' ? warehouseId : null,
        allocated_amount: allocNum!,
      });
    },
    onSuccess: (line) => {
      qc.invalidateQueries({ queryKey: ['allocations', 'periods'] });
      qc.invalidateQueries({
        queryKey: ['allocations', 'period', periodId],
      });
      toast.success('تم تحديث السطر.');
      onClose();
      onSuccess?.(line);
    },
    onError: (err) => setError(formatError(err)),
  });

  const isSubmitting = createMut.isPending || updateMut.isPending;
  const canSubmit =
    sourceSelected &&
    targetSelected &&
    srcAmountValid &&
    allocAmountValid &&
    !allocExceedsSrc &&
    !isSubmitting;

  if (!open) return null;

  const title =
    mode === 'create' ? 'إضافة سطر توزيع يدوي' : 'تعديل سطر توزيع';
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
        className="w-full max-w-xl overflow-hidden rounded-2xl bg-white shadow-xl"
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

        <div className="max-h-[70vh] space-y-4 overflow-y-auto px-5 py-4 text-sm">
          {error && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-rose-800">
              {error}
            </div>
          )}

          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">الطريقة:</span>
            <span className="rounded-full bg-violet-50 px-2 py-0.5 text-xs font-medium text-violet-700">
              يدوي
            </span>
          </div>

          {/* ─── Source ─── */}
          <div className="space-y-2">
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
                period_start={periodStart}
                period_end={periodEnd}
                disabled={isSubmitting}
              />
            ) : (
              <ExpenseCategoryPicker
                value={expenseCategoryId}
                onChange={(id) => setExpenseCategoryId(id)}
                disabled={isSubmitting}
              />
            )}
            <AmountField
              label="مبلغ المصدر"
              value={sourceAmount}
              onChange={setSourceAmount}
              disabled={isSubmitting}
              invalid={sourceAmount !== '' && !srcAmountValid}
              invalidMessage="ادخل مبلغًا موجبًا صحيحًا."
            />
          </div>

          {/* ─── Target ─── */}
          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              الهدف
            </div>
            <Segmented<TargetKind>
              value={targetKind}
              onChange={setTargetKind}
              disabled={isSubmitting}
              options={[
                { value: 'product', label: 'منتج' },
                { value: 'product_category', label: 'فئة منتج' },
                { value: 'warehouse', label: 'مخزن' },
              ]}
            />
            {targetKind === 'product' && (
              <ProductPicker
                value={productId}
                onChange={(id) => setProductId(id)}
                disabled={isSubmitting}
              />
            )}
            {targetKind === 'product_category' && (
              <ProductCategoryPicker
                value={productCategoryId}
                onChange={(id) => setProductCategoryId(id)}
                disabled={isSubmitting}
              />
            )}
            {targetKind === 'warehouse' && (
              <WarehousePicker
                value={warehouseId}
                onChange={(id) => setWarehouseId(id)}
                disabled={isSubmitting}
                /* No allowAll — a line must target a specific
                   warehouse, not the company-wide null sentinel. */
              />
            )}
          </div>

          <AmountField
            label="المبلغ الموزع"
            value={allocatedAmount}
            onChange={setAllocatedAmount}
            disabled={isSubmitting}
            invalid={allocatedAmount !== '' && !allocAmountValid}
            invalidMessage="ادخل مبلغًا موجبًا صحيحًا."
          />

          {allocExceedsSrc && (
            <div className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-800">
              المبلغ الموزع لا يمكن أن يتجاوز مبلغ المصدر.
            </div>
          )}
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
                ? 'إضافة'
                : 'حفظ التعديلات'}
          </button>
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

function AmountField({
  label,
  value,
  onChange,
  disabled,
  invalid,
  invalidMessage,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  invalidMessage?: string;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-xs font-medium text-slate-700">
        {label}
      </span>
      <input
        type="text"
        inputMode="decimal"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        dir="ltr"
        className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm font-mono tabular-nums focus:border-slate-400 focus:outline-none disabled:bg-slate-50"
      />
      {invalid && invalidMessage && (
        <span className="mt-1 block text-xs text-rose-600">
          {invalidMessage}
        </span>
      )}
    </label>
  );
}
