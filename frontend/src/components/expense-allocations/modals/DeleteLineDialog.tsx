/**
 * DeleteLineDialog — typed-confirmation wrapper around
 * `expenseAllocationsApi.deleteLine` (PR-PHASE2-B5).
 *
 * Visible only when the caller already knows the period is in the
 * `draft` state, has at least one line, and the user holds
 * `expense_allocation.manage`.  Confirmation word: `حذف` (verbatim,
 * exact match after trim).
 *
 * Deletes a single line under the period.  Unlike `ClearLinesDialog`
 * (bulk wipe) and `DeleteDraftDialog` (period + cascade), this is the
 * targeted per-line correction path:  the period itself stays as a
 * draft, and `total_allocated` is recomputed by the server in the same
 * transaction.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { expenseAllocationsApi } from '@/api/expenseAllocations.api';
import { TypedConfirmDialog } from '@/components/common/TypedConfirmDialog';

export interface DeleteLineDialogProps {
  open: boolean;
  periodId: string;
  lineId: string;
  /** Short human-readable label for the line — surfaced verbatim in
   *  the body so the operator can double-check they're deleting the
   *  intended row.  Caller composes it (e.g.
   *  `EXP-2026-000038 → كوتشي الشماع`). */
  lineLabel: string;
  /** The line's `allocated_amount`.  Surfaced verbatim, formatted
   *  en-EG with 2 decimals. */
  lineAmount: string | number;
  onClose: () => void;
  onDeleted?: () => void;
}

export function DeleteLineDialog({
  open,
  periodId,
  lineId,
  lineLabel,
  lineAmount,
  onClose,
  onDeleted,
}: DeleteLineDialogProps) {
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: () => expenseAllocationsApi.deleteLine(periodId, lineId),
    onSuccess: () => {
      // Period header (total_allocated, lines_count) changes — refetch
      // both the list and the open detail.  Reports don't need to
      // refresh: they consume approved-only data, and a draft's lines
      // never appear there.
      qc.invalidateQueries({ queryKey: ['allocations', 'periods'] });
      qc.invalidateQueries({
        queryKey: ['allocations', 'period', periodId],
      });
      toast.success('تم حذف سطر التوزيع.');
      onClose();
      onDeleted?.();
    },
    // 4xx surfaces via the global axios response interceptor toast.
  });

  const amountFmt = Number(lineAmount).toLocaleString('en-EG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return (
    <TypedConfirmDialog
      open={open}
      title="حذف سطر التوزيع"
      body={
        <div className="space-y-2">
          <p>
            سيتم حذف هذا السطر فقط من الفترة. تبقى الفترة كمسودة، ويُعاد
            حساب الإجمالي تلقائيًا.
          </p>
          <p className="rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-700">
            <span className="text-slate-500">السطر: </span>
            <span className="font-medium text-slate-900">{lineLabel}</span>
            <span className="text-slate-400"> · </span>
            <span className="font-mono tabular-nums text-slate-900">
              {amountFmt}
            </span>
            <span className="text-slate-500"> جنيه</span>
          </p>
        </div>
      }
      confirmWord="حذف"
      confirmLabel="حذف السطر"
      onConfirm={async () => {
        await mut.mutateAsync();
      }}
      onClose={onClose}
      isSubmitting={mut.isPending}
      danger
    />
  );
}
