/**
 * ReversePeriodDialog — typed-confirmation + required-reason wrapper
 * around `expenseAllocationsApi.reversePeriod` (PR-FE-B.4).
 *
 * Visible only when the caller already knows the period is in the
 * `approved` state and the user holds `expense_allocation.manage`.
 * Reverse is the terminal state in the FSM — the dialog body makes
 * that explicit so the operator understands what changes after they
 * click «عكس الفترة».
 *
 *   draft  →  approved  →  reversed  ← terminal, no further transitions
 *
 * UX contract:
 *   * Reason textarea: min 3 chars after trim (UX guard; backend
 *     enforces ≥ 1).
 *   * Typed confirmation word: «عكس» (exact match after trim).
 *   * Primary button disabled until BOTH conditions hold.
 *
 * On success: invalidates the periods list, the period detail, AND
 * both reports — because the report views consume approved-only data
 * and the reversal must remove the period's overhead from the views.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { expenseAllocationsApi } from '@/api/expenseAllocations.api';
import { TypedConfirmDialog } from '@/components/common/TypedConfirmDialog';

export interface ReversePeriodDialogProps {
  open: boolean;
  periodId: string;
  onClose: () => void;
  onReversed?: () => void;
}

export function ReversePeriodDialog({
  open,
  periodId,
  onClose,
  onReversed,
}: ReversePeriodDialogProps) {
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: ({ reason }: { reason: string }) =>
      expenseAllocationsApi.reversePeriod(periodId, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['allocations', 'periods'] });
      qc.invalidateQueries({
        queryKey: ['allocations', 'period', periodId],
      });
      // Reports consume approved-only data — both must refetch so the
      // reversed period stops contributing overhead and its source
      // expenses reappear in the unallocated list.
      qc.invalidateQueries({ queryKey: ['reports', 'profit-with-overhead'] });
      qc.invalidateQueries({ queryKey: ['reports', 'unallocated-expenses'] });
      toast.success('تم عكس الفترة.');
      onClose();
      onReversed?.();
    },
    // 4xx surfaces via the global axios response interceptor toast
    // (e.g. "الفترة لم تعد معتمدة" if someone reversed it elsewhere
    // first).  The dialog stays open so the operator can re-attempt.
  });

  return (
    <TypedConfirmDialog
      open={open}
      title="عكس فترة معتمدة"
      body={
        <div className="space-y-2">
          <p className="font-medium text-rose-700">
            العكس إجراء تدقيقي لا رجعة فيه.
          </p>
          <ul className="list-disc space-y-1 ps-5 text-xs text-slate-600">
            <li>الفترة ستظهر بحالة «معكوسة».</li>
            <li>السطور تبقى ظاهرة كسجل تدقيقي.</li>
            <li>التقارير تتجاهل الفترات المعكوسة تلقائيًا.</li>
            <li>لا يمكن إعادة الفترة المعكوسة إلى حالة المسودة.</li>
          </ul>
        </div>
      }
      requireReason
      reasonLabel="السبب"
      reasonPlaceholder="مثال: خطأ في تحديد المنتج المستهدف"
      minReasonLen={3}
      confirmWord="عكس"
      confirmLabel="عكس الفترة"
      onConfirm={async ({ reason }) => {
        await mut.mutateAsync({ reason });
      }}
      onClose={onClose}
      isSubmitting={mut.isPending}
      danger
    />
  );
}
