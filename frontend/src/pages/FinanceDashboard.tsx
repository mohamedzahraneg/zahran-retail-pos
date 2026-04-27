/**
 * FinanceDashboard — PR-FIN-2
 * ────────────────────────────────────────────────────────────────────
 *
 * "لوحة الحسابات والمالية" — read-only operational dashboard that
 * matches the approved design image pixel-close (within Tailwind +
 * RTL constraints). Single network call to `GET /finance/dashboard`
 * powers the entire screen.
 *
 * Strict guarantees:
 *   · ZERO writes (verified by backend service-level tests).
 *   · ZERO mutation of any existing financial page (incl. the
 *     frozen DailyExpenses surface).
 *   · ZERO migrations.
 *   · No FinancialEngine calls.
 *
 * Loading / error states match the existing dashboard vocabulary so
 * the page degrades gracefully if the API hiccups.
 */
import { useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Loader2, AlertTriangle } from 'lucide-react';
import {
  financeApi,
  type DashboardFilters as Filters,
} from '@/api/finance.api';
import { DashboardHeader } from '@/components/finance/dashboard/DashboardHeader';
import { DashboardFilters } from '@/components/finance/dashboard/DashboardFilters';
import { Row1Cards } from '@/components/finance/dashboard/Row1Cards';
import { Row2ProfitSummary } from '@/components/finance/dashboard/Row2ProfitSummary';
import { Row3Charts } from '@/components/finance/dashboard/Row3Charts';
import { Row4ProfitTables } from '@/components/finance/dashboard/Row4ProfitTables';
import { Row5Movements } from '@/components/finance/dashboard/Row5Movements';
import { Row6QuickReports } from '@/components/finance/dashboard/Row6QuickReports';
import { defaultDateRange } from '@/components/finance/dashboard/shared/utils';

export function FinanceDashboard() {
  const initial = useMemo<Filters>(() => defaultDateRange(), []);
  const [filters, setFilters] = useState<Filters>(initial);

  const {
    data,
    isLoading,
    isFetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ['finance-dashboard', filters],
    queryFn: () => financeApi.dashboard(filters),
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const onRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  const onPrint = useCallback(() => {
    // Existing print stylesheet keeps the page light + RTL regardless
    // of dark mode — see index.css `@media print` rules.
    window.print();
  }, []);

  const onExport = useCallback(() => {
    // Excel export is intentionally a placeholder in PR-FIN-2 — the
    // unified financial-report builder lives in PR-FIN-7. We avoid
    // half-baked CSVs that wouldn't carry the proper headers.
    alert('سيتم تفعيل تصدير Excel في تحديث لاحق (PR-FIN-7).');
  }, []);

  return (
    <div className="p-4 lg:p-6 space-y-4" dir="rtl">
      <DashboardHeader
        onRefresh={onRefresh}
        onPrint={onPrint}
        onExport={onExport}
        isFetching={isFetching}
      />

      <DashboardFilters filters={filters} onChange={setFilters} />

      {isLoading && !data ? (
        <DashboardLoading />
      ) : error ? (
        <DashboardError onRetry={refetch} />
      ) : data ? (
        <>
          <Row1Cards data={data} />
          <Row2ProfitSummary data={data} />
          <Row3Charts data={data} />
          <Row4ProfitTables data={data} />
          <Row5Movements data={data} />
          <Row6QuickReports data={data} />
        </>
      ) : null}
    </div>
  );
}

function DashboardLoading() {
  return (
    <div
      className="flex flex-col items-center justify-center py-20 gap-3"
      data-testid="dashboard-loading"
    >
      <Loader2 className="text-brand-600 animate-spin" size={32} />
      <div className="text-sm text-slate-500 dark:text-slate-400">
        جارٍ تحميل البيانات…
      </div>
    </div>
  );
}

function DashboardError({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="rounded-2xl border border-rose-200 dark:border-rose-900 bg-rose-50/60 dark:bg-rose-900/20 p-5 flex flex-col items-center gap-3"
      data-testid="dashboard-error"
    >
      <AlertTriangle className="text-rose-600 dark:text-rose-400" size={24} />
      <div className="text-sm font-bold text-rose-800 dark:text-rose-200">
        تعذّر تحميل بيانات لوحة الحسابات والمالية
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="text-[11px] font-bold text-rose-700 dark:text-rose-300 hover:underline"
      >
        إعادة المحاولة
      </button>
    </div>
  );
}

export default FinanceDashboard;
