/**
 * DashboardHeader — PR-FIN-2
 *
 * Title bar matching the approved image:
 *   · right-aligned title  "لوحة الحسابات والمالية"
 *   · subtitle             "نظرة شاملة على الوضع المالي لحظيًا"
 *   · left-aligned actions (Refresh / Print / Export Excel)
 *
 * Print + Export delegate to callbacks the parent provides; the
 * dashboard ships with a default print() that respects RTL via the
 * existing index.css print rules.
 */
import { RefreshCw, Printer, FileSpreadsheet, BarChart3 } from 'lucide-react';

export interface DashboardHeaderProps {
  onRefresh: () => void;
  onPrint: () => void;
  onExport: () => void;
  isFetching?: boolean;
}

export function DashboardHeader({
  onRefresh,
  onPrint,
  onExport,
  isFetching,
}: DashboardHeaderProps) {
  return (
    <header
      className="flex items-start justify-between gap-3 flex-wrap"
      data-testid="finance-dashboard-header"
    >
      <div className="order-2 lg:order-1 flex items-center gap-2">
        <button
          type="button"
          onClick={onRefresh}
          disabled={isFetching}
          className="inline-flex items-center gap-2 rounded-xl bg-slate-800 dark:bg-slate-700 text-white px-3 py-2 text-xs font-bold hover:bg-slate-900 dark:hover:bg-slate-600 disabled:opacity-50"
          data-testid="dashboard-action-refresh"
        >
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
          تحديث
        </button>
        <button
          type="button"
          onClick={onPrint}
          className="inline-flex items-center gap-2 rounded-xl bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-bold hover:bg-slate-50 dark:hover:bg-slate-700"
          data-testid="dashboard-action-print"
        >
          <Printer size={14} />
          طباعة
        </button>
        <button
          type="button"
          onClick={onExport}
          className="inline-flex items-center gap-2 rounded-xl bg-emerald-600 dark:bg-emerald-700 text-white px-3 py-2 text-xs font-bold hover:bg-emerald-700 dark:hover:bg-emerald-600"
          data-testid="dashboard-action-excel"
        >
          <FileSpreadsheet size={14} />
          تصدير Excel
        </button>
      </div>

      <div className="order-1 lg:order-2 flex items-start gap-3">
        <div className="text-right">
          <h1 className="text-xl font-black text-slate-900 dark:text-slate-100">
            لوحة الحسابات والمالية
          </h1>
          <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
            نظرة شاملة على الوضع المالي لحظيًا
          </p>
        </div>
        <div className="w-10 h-10 rounded-xl bg-brand-50 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
          <BarChart3 size={20} />
        </div>
      </div>
    </header>
  );
}
