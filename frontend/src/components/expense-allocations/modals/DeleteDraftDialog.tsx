/**
 * DeleteDraftDialog — typed-confirmation wrapper around
 * `expenseAllocationsApi.deletePeriod` (PR-FE-B.2).
 *
 * Visible only when the caller already knows the period is in the
 * `draft` state and the user has `expense_allocation.manage`.
 * Confirmation word: `حذف` (verbatim, exact match after trim).
 *
 * Wires the mutation locally so the caller passes just the period id
 * + lines count and an optional `onDeleted` callback for list
 * refresh / detail-page navigation back to the list.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { expenseAllocationsApi } from '@/api/expenseAllocations.api';
import { TypedConfirmDialog } from '@/components/common/TypedConfirmDialog';

export interface DeleteDraftDialogProps {
  open: boolean;
  periodId: string;
  /** Number of lines about to be cascade-deleted along with the period.
   *  Surfaced verbatim in the confirmation body. */
  linesCount: number;
  onClose: () => void;
  onDeleted?: () => void;
}

export function DeleteDraftDialog({
  open,
  periodId,
  linesCount,
  onClose,
  onDeleted,
}: DeleteDraftDialogProps) {
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: () => expenseAllocationsApi.deletePeriod(periodId),
    onSuccess: () => {
      // PR-FE-B.3 — fix for the FE-B.2 wart where deleting from the
      // detail page surfaced a transient "فترة التوزيع غير موجودة."
      // toast.  The previous broad `invalidateQueries(['allocations'])`
      // also matched the still-mounted detail page's
      // `['allocations','period', id]` query, which refetched the
      // now-deleted period before navigation completed and hit 404.
      //
      // The fix has two steps:
      //   (1) `removeQueries` drops the deleted period from cache
      //       entirely — no refetch is scheduled, so no 404 toast.
      //   (2) Narrow the invalidation to the periods list so the row
      //       disappears on the next list view.
      // Then the caller's onDeleted navigates as usual.
      qc.removeQueries({ queryKey: ['allocations', 'period', periodId] });
      qc.invalidateQueries({ queryKey: ['allocations', 'periods'] });
      toast.success('تم حذف فترة المسودة.');
      onClose();
      onDeleted?.();
    },
    // Errors surface via the global axios response interceptor (toast
    // on any 4xx with `data.message`).  No local handler needed.
  });

  return (
    <TypedConfirmDialog
      open={open}
      title="حذف فترة المسودة"
      body={
        <p>
          سيتم حذف الفترة وجميع سطورها (
          <span className="font-mono tabular-nums">{linesCount}</span> سطر)
          نهائيًا. لا يمكن التراجع عن هذا الإجراء.
        </p>
      }
      confirmWord="حذف"
      confirmLabel="حذف نهائيًا"
      onConfirm={async () => {
        await mut.mutateAsync();
      }}
      onClose={onClose}
      isSubmitting={mut.isPending}
      danger
    />
  );
}
