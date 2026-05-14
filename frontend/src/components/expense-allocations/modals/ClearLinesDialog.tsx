/**
 * ClearLinesDialog — typed-confirmation wrapper around
 * `expenseAllocationsApi.clearLines` (PR-FE-B.3).
 *
 * Visible only when the caller already knows the period is in the
 * `draft` state, has at least one line, and the user holds
 * `expense_allocation.manage`.  Confirmation word: `مسح` (verbatim,
 * exact match after trim).
 *
 * Wipes ALL lines under the period in a single backend call.  The
 * period header itself stays as a draft with `total_allocated = 0`
 * — useful when the operator wants to start over without recreating
 * the period.
 *
 * Per-line delete is intentionally NOT available in FE-B.3 (the
 * backend has no DELETE /lines/:line_id endpoint).  The two
 * supported correction paths are:
 *   * Edit the offending line via LineModal (pencil icon), OR
 *   * Clear all lines via this dialog and re-add.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { expenseAllocationsApi } from '@/api/expenseAllocations.api';
import { TypedConfirmDialog } from '@/components/common/TypedConfirmDialog';

export interface ClearLinesDialogProps {
  open: boolean;
  periodId: string;
  /** Surfaced verbatim in the body. */
  linesCount: number;
  /** Surfaced verbatim in the body, formatted en-EG with 2 decimals. */
  totalAllocated: string | number;
  onClose: () => void;
  onCleared?: () => void;
}

export function ClearLinesDialog({
  open,
  periodId,
  linesCount,
  totalAllocated,
  onClose,
  onCleared,
}: ClearLinesDialogProps) {
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: () => expenseAllocationsApi.clearLines(periodId),
    onSuccess: () => {
      // Period header (total_allocated, lines_count) changes — refetch
      // both the list and the open detail.  Reports don't need to
      // refresh: they consume approved-only data, and a draft's lines
      // never appear there.
      qc.invalidateQueries({ queryKey: ['allocations', 'periods'] });
      qc.invalidateQueries({
        queryKey: ['allocations', 'period', periodId],
      });
      toast.success('تم مسح جميع السطور.');
      onClose();
      onCleared?.();
    },
    // 4xx surfaces via the global axios response interceptor toast.
  });

  const totalFmt = Number(totalAllocated).toLocaleString('en-EG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return (
    <TypedConfirmDialog
      open={open}
      title="مسح جميع السطور"
      body={
        <p>
          سيتم حذف جميع السطور (
          <span className="font-mono tabular-nums">{linesCount}</span> سطر،
          إجمالي{' '}
          <span className="font-mono tabular-nums">{totalFmt}</span> جنيه) من
          هذه الفترة. الفترة نفسها تبقى كمسودة فارغة.
        </p>
      }
      confirmWord="مسح"
      confirmLabel="مسح كل السطور"
      onConfirm={async () => {
        await mut.mutateAsync();
      }}
      onClose={onClose}
      isSubmitting={mut.isPending}
      danger
    />
  );
}
