/**
 * ApprovePeriodDialog — summary-confirmation modal that approves a
 * draft allocation period (PR-FE-B.2).
 *
 * Deliberate UX asymmetry vs. delete / clear-lines / reverse: approve
 * does NOT require a typed confirmation word.  Reason: approval is
 * recoverable (via reverse with a reason), while the other three are
 * irreversible.  The body copy makes the constraint explicit so the
 * operator understands what changes after they click اعتماد.
 *
 * Visible only when the caller already knows the period is in the
 * `draft` state, has at least one line, and the user holds
 * `expense_allocation.manage`.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { ShieldCheck, X } from 'lucide-react';
import {
  expenseAllocationsApi,
  type AllocationPeriodDetail,
} from '@/api/expenseAllocations.api';
import { fmtCairoDate } from '@/lib/dates';

export interface ApprovePeriodDialogProps {
  open: boolean;
  period: AllocationPeriodDetail | null;
  onClose: () => void;
  onApproved?: (period: AllocationPeriodDetail) => void;
}

export function ApprovePeriodDialog({
  open,
  period,
  onClose,
  onApproved,
}: ApprovePeriodDialogProps) {
  const qc = useQueryClient();

  const mut = useMutation({
    mutationFn: () => {
      if (!period) throw new Error('approve requires a period');
      return expenseAllocationsApi.approvePeriod(period.id);
    },
    onSuccess: (updated) => {
      if (!period) return;
      qc.invalidateQueries({ queryKey: ['allocations', 'periods'] });
      qc.invalidateQueries({ queryKey: ['allocations', 'period', period.id] });
      // Reports consume approved-only data — refetch them so the new
      // overhead allocations show up immediately on the two reports.
      qc.invalidateQueries({ queryKey: ['reports', 'profit-with-overhead'] });
      qc.invalidateQueries({ queryKey: ['reports', 'unallocated-expenses'] });
      toast.success('تم اعتماد الفترة.');
      onClose();
      onApproved?.(updated);
    },
  });

  if (!open || !period) return null;

  const linesCount = period.lines.length;
  const total = Number(period.total_allocated).toLocaleString('en-EG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={mut.isPending ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-label="اعتماد فترة التوزيع"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl"
      >
        <div className="flex items-start gap-3 border-b border-emerald-100 bg-emerald-50 px-5 py-4">
          <div className="mt-0.5 rounded-full bg-emerald-100 p-2 text-emerald-700">
            <ShieldCheck className="h-4 w-4" />
          </div>
          <h3 className="flex-1 text-base font-semibold text-slate-900">
            اعتماد فترة التوزيع
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={mut.isPending}
            aria-label="إغلاق"
            className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4 text-sm">
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs">
            <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5">
              <div className="text-slate-500">الفترة</div>
              <div className="font-mono tabular-nums text-slate-800">
                {fmtCairoDate(period.period_start)} —{' '}
                {fmtCairoDate(period.period_end)}
              </div>
              <div className="text-slate-500">المخزن</div>
              <div className="text-slate-800">
                {period.warehouse_name ?? 'جميع المخازن'}
              </div>
              <div className="text-slate-500">عدد السطور</div>
              <div className="font-mono tabular-nums text-slate-800">
                {linesCount}
              </div>
              <div className="text-slate-500">إجمالي التوزيع</div>
              <div className="font-mono tabular-nums font-semibold text-slate-900">
                {total} <span className="text-xs text-slate-400">جنيه</span>
              </div>
            </div>
          </div>

          <p className="text-slate-700">
            بعد الاعتماد لا يُسمح بأي تعديل على السطور أو على الرأس.
            لإلغاء الاعتماد لاحقًا استخدم «عكس» مع ذكر السبب.
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={mut.isPending}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            إلغاء
          </button>
          <button
            type="button"
            onClick={() => mut.mutate()}
            disabled={mut.isPending}
            className="rounded-md bg-emerald-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {mut.isPending ? 'جاري الاعتماد…' : 'اعتماد'}
          </button>
        </div>
      </div>
    </div>
  );
}
