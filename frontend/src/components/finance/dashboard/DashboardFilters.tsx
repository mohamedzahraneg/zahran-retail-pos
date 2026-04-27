/**
 * DashboardFilters — PR-FIN-2
 *
 * Filter bar matching the dashboard image (right→left order):
 *   1. الفترة          (date range, two date inputs)
 *   2. الخزائن         (cashbox dropdown — kept as "كل الخزائن" when no
 *                       cashboxes loaded; gracefully hidden if api fails)
 *   3. وسيلة الدفع     (payment_account dropdown)
 *   4. المستخدم        (users dropdown)
 *   5. الوردية         (shift dropdown)
 *
 * Pure controlled component. Owns no state. The page passes the
 * current filter object plus an `onChange` handler. Local fresh
 * implementation — does NOT touch the existing PeriodSelector
 * component used by /analytics (per Q8 of the approved plan).
 */
import { CalendarRange, Filter } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { cashDeskApi } from '@/api/cash-desk.api';
import { paymentsApi } from '@/api/payments.api';
import type { DashboardFilters as Filters } from '@/api/finance.api';

export interface DashboardFiltersProps {
  filters: Filters;
  onChange: (next: Filters) => void;
}

export function DashboardFilters({
  filters,
  onChange,
}: DashboardFiltersProps) {
  // These dropdowns are best-effort populated from existing endpoints.
  // If a fetch fails we fall back to "all" (no filtering); we never
  // block the dashboard render.
  const { data: cashboxes = [] } = useQuery({
    queryKey: ['finance-dashboard-filters-cashboxes'],
    queryFn: () => cashDeskApi.cashboxes(),
    staleTime: 5 * 60 * 1000,
  });
  const { data: paymentAccounts = [] } = useQuery({
    queryKey: ['finance-dashboard-filters-payment-accounts'],
    queryFn: () => paymentsApi.listAccounts(),
    staleTime: 5 * 60 * 1000,
  });

  const update = (patch: Partial<Filters>) =>
    onChange({ ...filters, ...patch });

  return (
    <div
      data-testid="finance-dashboard-filters"
      className="rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm p-3 flex flex-wrap items-end gap-3"
      dir="rtl"
    >
      <div className="flex flex-col gap-1">
        <label className="text-[11px] font-bold text-slate-600 dark:text-slate-400">
          الفترة
        </label>
        <div className="flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2 py-1.5">
          <CalendarRange
            size={14}
            className="text-slate-400 dark:text-slate-500"
          />
          <input
            type="date"
            value={filters.from ?? ''}
            onChange={(e) => update({ from: e.target.value || undefined })}
            className="bg-transparent text-[11px] text-slate-700 dark:text-slate-200 outline-none"
            data-testid="dashboard-filter-from"
          />
          <span className="text-slate-400 dark:text-slate-500 text-[11px]">
            -
          </span>
          <input
            type="date"
            value={filters.to ?? ''}
            onChange={(e) => update({ to: e.target.value || undefined })}
            className="bg-transparent text-[11px] text-slate-700 dark:text-slate-200 outline-none"
            data-testid="dashboard-filter-to"
          />
        </div>
      </div>

      <FilterSelect
        label="الخزائن"
        defaultLabel="كل الخزائن"
        value={filters.cashbox_id ?? ''}
        options={cashboxes.map((c: any) => ({
          value: c.id,
          label: c.name_ar ?? c.name_en ?? c.id,
        }))}
        onChange={(v) => update({ cashbox_id: v || undefined })}
        testId="dashboard-filter-cashbox"
      />

      <FilterSelect
        label="وسيلة الدفع"
        defaultLabel="كل الوسائل"
        value={filters.payment_account_id ?? ''}
        options={paymentAccounts.map((p: any) => ({
          value: p.id,
          label: p.display_name ?? p.method,
        }))}
        onChange={(v) => update({ payment_account_id: v || undefined })}
        testId="dashboard-filter-payment-account"
      />

      <FilterSelect
        label="المستخدم"
        defaultLabel="كل المستخدمين"
        value={filters.user_id ?? ''}
        options={[]}
        onChange={(v) => update({ user_id: v || undefined })}
        testId="dashboard-filter-user"
      />

      <FilterSelect
        label="الوردية"
        defaultLabel="كل الورديات"
        value={filters.shift_id ?? ''}
        options={[]}
        onChange={(v) => update({ shift_id: v || undefined })}
        testId="dashboard-filter-shift"
      />

      <div className="flex items-center gap-1 text-[11px] text-slate-500 dark:text-slate-400 pt-5">
        <Filter size={12} />
        <span>تصفية شاملة</span>
      </div>
    </div>
  );
}

function FilterSelect({
  label,
  defaultLabel,
  value,
  options,
  onChange,
  testId,
}: {
  label: string;
  defaultLabel: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (v: string) => void;
  testId: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <label className="text-[11px] font-bold text-slate-600 dark:text-slate-400">
        {label}
      </label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 text-[11px] text-slate-700 dark:text-slate-200 px-2 py-1.5 min-w-[150px]"
        data-testid={testId}
      >
        <option value="">{defaultLabel}</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
