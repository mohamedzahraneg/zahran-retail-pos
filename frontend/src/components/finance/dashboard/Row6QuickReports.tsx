/**
 * Row6QuickReports — PR-FIN-2 (التقارير السريعة)
 *
 * 4×4 grid of report shortcuts. Each tile honors the `available`
 * flag from the backend:
 *   · available=true  → real Link rendered with brand-colored tile
 *   · available=false → disabled placeholder with tooltip + grayed
 *     icon (per Q11 of approved plan: "no fabrication; placeholders
 *     for unimplemented reports")
 *
 * Labels are rendered exactly as specified by the backend so they
 * always match the dashboard image (no translation here).
 */
import {
  FileText,
  Wallet,
  Building2,
  Banknote,
  Users,
  Truck,
  Receipt,
  TrendingUp,
  Scale,
  ArrowDownUp,
  Sparkles,
  Boxes,
  Undo2,
  Tag,
  PieChart,
  Activity,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type { FinanceDashboard } from '@/api/finance.api';
import { DashboardSection } from './shared/DashboardSection';

// Map keys → icons. Keys come from the backend's static
// `quick_reports` list; the dashboard image dictates the order.
const ICON_MAP: Record<string, typeof FileText> = {
  'customer-statement': Users,
  'wallet-statement':   Wallet,
  'bank-statement':     Building2,
  'cashbox-statement':  Banknote,
  'employee-statement': Users,
  'supplier-statement': Truck,
  'expenses-report':    Receipt,
  'revenues-report':    TrendingUp,
  'balance-sheet':      Scale,
  cashflow:             ArrowDownUp,
  'zakat-report':       Sparkles,
  'inventory-report':   Boxes,
  'returns-report':     Undo2,
  'discounts-report':   Tag,
  'profits-report':     PieChart,
  'audit-trail':        Activity,
};

export function Row6QuickReports({
  data,
}: {
  data: FinanceDashboard;
}) {
  return (
    <DashboardSection
      title="التقارير السريعة"
      testId="quick-reports"
      viewAllHref={null}
    >
      <div
        className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2"
        dir="rtl"
      >
        {data.quick_reports.map((r) => {
          const Icon = ICON_MAP[r.key] ?? FileText;
          if (r.available && r.href) {
            return (
              <Link
                key={r.key}
                to={r.href}
                data-testid={`quick-report-${r.key}`}
                data-available="true"
                className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 hover:bg-brand-50 dark:hover:bg-brand-900/20 hover:border-brand-300 dark:hover:border-brand-700 transition px-2 py-3 text-center"
              >
                <Icon
                  size={18}
                  className="text-brand-600 dark:text-brand-400"
                />
                <span className="text-[11px] font-bold text-slate-700 dark:text-slate-200">
                  {r.label_ar}
                </span>
              </Link>
            );
          }
          return (
            <button
              key={r.key}
              type="button"
              disabled
              data-testid={`quick-report-${r.key}`}
              data-available="false"
              title="سيُتاح في تحديث لاحق"
              className="flex flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-800/50 px-2 py-3 text-center cursor-not-allowed opacity-70"
            >
              <Icon size={18} className="text-slate-400 dark:text-slate-500" />
              <span className="text-[11px] font-bold text-slate-500 dark:text-slate-400">
                {r.label_ar}
              </span>
            </button>
          );
        })}
      </div>
    </DashboardSection>
  );
}
