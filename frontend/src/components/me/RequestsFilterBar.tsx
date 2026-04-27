/**
 * RequestsFilterBar — PR-ESS-2C-2
 * ────────────────────────────────────────────────────────────────────
 *
 * Reusable filter strip for `employee_requests` list views. Shared by:
 *   · /me MyRequestsCard
 *   · /team ApprovalsAuditTab "كل طلبات الموظف" panel
 *
 * Pure controlled component — owns no state. Parent passes a single
 * `RequestFilters` object plus an `onChange` handler.
 *
 * Filters surfaced (matching backend `/employees/me/requests` and
 * `/employees/:id/requests` query params):
 *   · status: الكل / قيد المراجعة / موافق عليه / تم الصرف / مرفوض / ملغي
 *   · kind:   الكل / السلف / الإجازات / تمديد ساعات / أخرى
 *   · from / to: YYYY-MM-DD on `created_at`
 *
 * NOT exposed here: `limit` / `offset` (pagination is owned by the
 * parent — defaults to 50/0 server-side). The component intentionally
 * stays presentational.
 */
import { Filter } from 'lucide-react';
import { RequestFilters } from '@/api/employees.api';

type StatusKey = NonNullable<RequestFilters['status']> | 'all';
type KindKey = NonNullable<RequestFilters['kind']> | 'all';

const STATUS_TABS: { key: StatusKey; label: string }[] = [
  { key: 'all', label: 'الكل' },
  { key: 'pending', label: 'قيد المراجعة' },
  { key: 'approved', label: 'موافق عليه' },
  { key: 'disbursed', label: 'تم الصرف' },
  { key: 'rejected', label: 'مرفوض' },
  { key: 'cancelled', label: 'ملغي' },
];

const KIND_OPTIONS: { key: KindKey; label: string }[] = [
  { key: 'all', label: 'كل الأنواع' },
  { key: 'advance_request', label: 'سلف' },
  { key: 'leave', label: 'إجازات' },
  { key: 'overtime_extension', label: 'تمديد ساعات' },
  { key: 'other', label: 'أخرى' },
];

export interface RequestsFilterBarProps {
  filters: RequestFilters;
  onChange: (next: RequestFilters) => void;
  /** Optional — show date inputs (defaults to true). */
  showDates?: boolean;
  /** data-testid prefix — defaults to "requests-filter-bar". */
  testIdPrefix?: string;
}

export function RequestsFilterBar({
  filters,
  onChange,
  showDates = true,
  testIdPrefix = 'requests-filter-bar',
}: RequestsFilterBarProps) {
  const activeStatus: StatusKey = (filters.status ?? 'all') as StatusKey;
  const activeKind: KindKey = (filters.kind ?? 'all') as KindKey;

  const setStatus = (s: StatusKey) => {
    onChange({
      ...filters,
      status: s === 'all' ? undefined : s,
      offset: undefined,
    });
  };

  const setKind = (k: KindKey) => {
    onChange({
      ...filters,
      kind: k === 'all' ? undefined : k,
      offset: undefined,
    });
  };

  const setFrom = (v: string) =>
    onChange({ ...filters, from: v || undefined, offset: undefined });

  const setTo = (v: string) =>
    onChange({ ...filters, to: v || undefined, offset: undefined });

  return (
    <div
      className="flex flex-col gap-2 px-4 py-3 bg-slate-50/60 border-b border-slate-100"
      data-testid={testIdPrefix}
      dir="rtl"
    >
      {/* Status tabs */}
      <div
        className="flex flex-wrap gap-1.5"
        data-testid={`${testIdPrefix}-status-tabs`}
      >
        {STATUS_TABS.map((t) => {
          const active = activeStatus === t.key;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => setStatus(t.key)}
              className={`text-[11px] font-bold rounded-full px-3 py-1 border transition ${
                active
                  ? 'bg-slate-800 text-white border-slate-800'
                  : 'bg-white text-slate-600 border-slate-200 hover:border-slate-300'
              }`}
              data-testid={`${testIdPrefix}-status-${t.key}`}
              aria-pressed={active}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Kind + dates row */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 text-[11px] text-slate-500">
          <Filter size={12} />
          <span>تصفية:</span>
        </div>
        <select
          value={activeKind}
          onChange={(e) => setKind(e.target.value as KindKey)}
          className="text-[11px] border border-slate-200 rounded-lg bg-white px-2 py-1 text-slate-700"
          data-testid={`${testIdPrefix}-kind`}
        >
          {KIND_OPTIONS.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>

        {showDates && (
          <>
            <label className="text-[11px] text-slate-500 flex items-center gap-1">
              من
              <input
                type="date"
                value={filters.from ?? ''}
                onChange={(e) => setFrom(e.target.value)}
                className="text-[11px] border border-slate-200 rounded-lg bg-white px-2 py-1 text-slate-700"
                data-testid={`${testIdPrefix}-from`}
              />
            </label>
            <label className="text-[11px] text-slate-500 flex items-center gap-1">
              إلى
              <input
                type="date"
                value={filters.to ?? ''}
                onChange={(e) => setTo(e.target.value)}
                className="text-[11px] border border-slate-200 rounded-lg bg-white px-2 py-1 text-slate-700"
                data-testid={`${testIdPrefix}-to`}
              />
            </label>
          </>
        )}

        {(activeStatus !== 'all' ||
          activeKind !== 'all' ||
          filters.from ||
          filters.to) && (
          <button
            type="button"
            onClick={() =>
              onChange({
                kind: undefined,
                status: undefined,
                from: undefined,
                to: undefined,
                offset: undefined,
                limit: filters.limit,
              })
            }
            className="text-[11px] text-slate-500 underline hover:text-slate-700"
            data-testid={`${testIdPrefix}-clear`}
          >
            مسح التصفية
          </button>
        )}
      </div>
    </div>
  );
}
