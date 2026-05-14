import clsx from 'clsx';
import { FileEdit, CheckCircle2, Undo2 } from 'lucide-react';
import type { AllocationPeriodStatus } from '@/api/expenseAllocations.api';

/**
 * Status badge for an allocation period.
 *
 *   draft     → مسودة      (grey)
 *   approved  → معتمدة     (emerald) — visible to reports
 *   reversed  → معكوسة     (rose, terminal) — preserved for audit only
 *
 * Terminal/reversed is rendered with an Undo2 icon to signal the
 * one-way transition.
 */
const STATUS_CONFIG: Record<
  AllocationPeriodStatus,
  { label: string; cls: string; Icon: typeof FileEdit }
> = {
  draft: {
    label: 'مسودة',
    cls: 'bg-slate-100 text-slate-700 ring-slate-200',
    Icon: FileEdit,
  },
  approved: {
    label: 'معتمدة',
    cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200',
    Icon: CheckCircle2,
  },
  reversed: {
    label: 'معكوسة',
    cls: 'bg-rose-50 text-rose-700 ring-rose-200',
    Icon: Undo2,
  },
};

export function PeriodStatusBadge({
  status,
  size = 'md',
}: {
  status: AllocationPeriodStatus;
  size?: 'sm' | 'md';
}) {
  const { label, cls, Icon } = STATUS_CONFIG[status];
  const sizeCls =
    size === 'sm'
      ? 'text-[11px] px-1.5 py-0.5 gap-1'
      : 'text-xs px-2 py-1 gap-1.5';
  const iconCls = size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5';
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full ring-1 font-medium',
        cls,
        sizeCls,
      )}
    >
      <Icon className={iconCls} />
      <span>{label}</span>
    </span>
  );
}
