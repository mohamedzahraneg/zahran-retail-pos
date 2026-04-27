/**
 * DashboardSection — PR-FIN-2
 *
 * Wrapper used by every panel-level section in the dashboard
 * (charts, tables, alerts, quick reports). Provides:
 *   · consistent surface (white/dark, rounded-2xl, shadow-sm)
 *   · Arabic title + optional subtitle
 *   · "عرض الكل" link slot (right side) — disabled by default since
 *     PR-FIN-2 ships only the dashboard; deep pages land in later PRs
 */
import { ReactNode } from 'react';

export interface DashboardSectionProps {
  title: string;
  subtitle?: string;
  /** Optional "عرض الكل" target. Pass null/undefined to disable. */
  viewAllHref?: string | null;
  /** Optional override for the "عرض الكل" label. */
  viewAllLabel?: string;
  testId?: string;
  className?: string;
  children: ReactNode;
}

export function DashboardSection({
  title,
  subtitle,
  viewAllHref,
  viewAllLabel = 'عرض الكل',
  testId,
  className = '',
  children,
}: DashboardSectionProps) {
  return (
    <section
      data-testid={testId}
      className={`rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm ${className}`}
    >
      <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-black text-slate-800 dark:text-slate-100 truncate">
            {title}
          </h3>
          {subtitle && (
            <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-0.5">
              {subtitle}
            </p>
          )}
        </div>
        {viewAllHref ? (
          <a
            href={viewAllHref}
            className="text-[11px] font-bold text-brand-700 dark:text-brand-400 hover:underline"
          >
            {viewAllLabel}
          </a>
        ) : viewAllHref === null ? (
          <span
            className="text-[11px] font-bold text-slate-400 dark:text-slate-500 cursor-not-allowed"
            title="ستفعَّل في تحديث لاحق"
          >
            {viewAllLabel}
          </span>
        ) : null}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}
