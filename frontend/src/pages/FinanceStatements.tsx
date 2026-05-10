/**
 * FinanceStatements — PR-FIN-3
 * ────────────────────────────────────────────────────────────────────
 *
 * Read-only page rendering the seven statement tabs documented in
 * the approved plan. Each tab uses the unified `StatementResponse`
 * shape returned by /finance/statements/*. Print + Excel buttons
 * render as disabled placeholders pointing at PR-FIN-7 (the unified
 * builder will activate them later). Drilldown is null/disabled
 * until PR-FIN-4 ships the audit-trail page.
 *
 * UX cleanup (PR-FIN-3-UX):
 *   - Title sits on the right at every breakpoint (no `lg:order-*`
 *     swap that flipped it left at desktop sizes).
 *   - Print/Export demoted to the filter bar so they no longer crowd
 *     the page title; gating predicate now checks entity + rows so
 *     once PR-FIN-7 ships they activate cleanly.
 *   - Empty state shows a 3-step guide (tab → entity → range) instead
 *     of two flat lines.
 *   - Date presets (اليوم / هذا الأسبوع / هذا الشهر / من بداية الشهر /
 *     آخر 30 يوم) avoid manual date typing.
 *   - `confidence.note` from the BE is surfaced as an info banner
 *     above the table when rows exist; the existing empty-state still
 *     surfaces it in-place when rows are zero.
 *
 * Strict guarantees:
 *   · ZERO writes; ZERO mutation of any existing financial page
 *   · ZERO migrations; ZERO FinancialEngine calls
 *   · DailyExpenses.tsx untouched (frozen surface)
 *   · No accounting writes; no cashbox writes
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  CalendarRange,
  FileSpreadsheet,
  Info,
  Loader2,
  MousePointer,
  Printer,
  RefreshCw,
  ScrollText,
} from 'lucide-react';
import { statementsApi, type StatementResponse } from '@/api/statements.api';
import { StatementsTabs, type StatementTab } from '@/components/finance/statements/StatementsTabs';
import { EntitySelector } from '@/components/finance/statements/EntitySelector';
import { StatementHeaderCard } from '@/components/finance/statements/StatementHeaderCard';
import { StatementTable } from '@/components/finance/statements/StatementTable';

/** PR-FIN-7 has not shipped — print + Excel always render disabled
 *  no matter the entity/rows state.  When the unified builder ships,
 *  flipping this constant to `false` activates them subject to the
 *  full gating predicate. */
const PRINT_NOT_IMPLEMENTED = true;

// ─── Date helpers ────────────────────────────────────────────────────

/** Format a Date as `YYYY-MM-DD` in Africa/Cairo. */
function fmtCairoYmd(d: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const day = parts.find((p) => p.type === 'day')!.value;
  return `${y}-${m}-${day}`;
}

/** Same Cairo-month default the backend uses. */
function defaultRange(): { from: string; to: string } {
  const today = fmtCairoYmd(new Date());
  return { from: today.slice(0, 7) + '-01', to: today };
}

type PresetKey = 'today' | 'week' | 'month' | 'mtd' | 'last30';

// PR-FIN-3-UX — date arithmetic helpers that operate on YYYY-MM-DD
// calendar strings rather than `Date.setDate(...)` on a wall-clock
// `Date` object.  Necessary because the runner's local TZ (UTC in CI,
// host-local for devs) is not Cairo, so doing `setDate(d - 29)` then
// re-formatting in Cairo can drift the result by a full day at the
// midnight crossover.  Treating the Cairo date as a pure calendar
// value sidesteps the issue entirely.

/** Add `days` (signed) to a YYYY-MM-DD calendar date. */
function ymdAddDays(ymd: string, days: number): string {
  const [y, m, d] = ymd.split('-').map(Number);
  const t = Date.UTC(y!, m! - 1, d!);
  const shifted = new Date(t + days * 86_400_000);
  const yy = shifted.getUTCFullYear();
  const mm = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(shifted.getUTCDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}

/** Day-of-week (0=Sun..6=Sat) for a YYYY-MM-DD calendar date. */
function ymdDayOfWeek(ymd: string): number {
  const [y, m, d] = ymd.split('-').map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** Resolve a named preset to a `{from, to}` pair in Cairo time. */
export function presetRange(preset: PresetKey, now: Date = new Date()): { from: string; to: string } {
  const today = fmtCairoYmd(now);
  if (preset === 'today') return { from: today, to: today };
  if (preset === 'last30') return { from: ymdAddDays(today, -29), to: today };
  if (preset === 'week') {
    // Saturday-start week (common in Egypt).  ymdDayOfWeek returns
    // 0=Sun..6=Sat for the calendar date itself.
    const dow = ymdDayOfWeek(today);
    const daysSinceSat = (dow + 1) % 7;
    return { from: ymdAddDays(today, -daysSinceSat), to: today };
  }
  // 'month' (full current month) and 'mtd' (1st → today) both want
  // the 1st of the current month as `from`.  `month` extends `to` to
  // the last day of the month; `mtd` clamps at today.
  const firstOfMonth = today.slice(0, 7) + '-01';
  if (preset === 'mtd') return { from: firstOfMonth, to: today };
  // 'month' — last day of current calendar month
  const [yr, mo] = today.split('-').map(Number);
  const lastDay = new Date(Date.UTC(yr!, mo!, 0)).getUTCDate(); // Date.UTC(y, m, 0) → last day of month m-1, expressed in UTC
  const last = `${String(yr).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
  return { from: firstOfMonth, to: last };
}

const PRESETS: ReadonlyArray<{ key: PresetKey; label: string }> = [
  { key: 'today', label: 'اليوم' },
  { key: 'week', label: 'هذا الأسبوع' },
  { key: 'month', label: 'هذا الشهر' },
  { key: 'mtd', label: 'من بداية الشهر' },
  { key: 'last30', label: 'آخر 30 يوم' },
];

// ─── Page ────────────────────────────────────────────────────────────

export function FinanceStatements() {
  const [tab, setTab] = useState<StatementTab>('gl_account');
  const [entityId, setEntityId] = useState<string | null>(null);
  const [range, setRange] = useState(() => defaultRange());

  // Reset entity selection when the tab changes — entities don't
  // overlap across tabs.
  const handleTab = (next: StatementTab) => {
    setTab(next);
    setEntityId(null);
  };

  const queryKey = useMemo(
    () => ['finance-statement', tab, entityId, range.from, range.to],
    [tab, entityId, range.from, range.to],
  );

  const { data, isFetching, error, refetch } = useQuery<
    StatementResponse,
    unknown
  >({
    queryKey,
    enabled: !!entityId,
    queryFn: () => {
      if (!entityId) {
        return Promise.reject(new Error('no entity'));
      }
      const f = { from: range.from, to: range.to };
      switch (tab) {
        case 'gl_account':
          return statementsApi.glAccount(entityId, f);
        case 'cashbox_cash':
        case 'cashbox_bank':
        case 'cashbox_wallet':
          return statementsApi.cashbox(entityId, f);
        case 'employee':
          return statementsApi.employee(entityId, f);
        case 'customer':
          return statementsApi.customer(entityId, f);
        case 'supplier':
          return statementsApi.supplier(entityId, f);
      }
    },
    staleTime: 60 * 1000,
  });

  const hasRows = (data?.rows.length ?? 0) > 0;
  // Print + Excel gating — keep the title constant so the existing
  // contract with the deferred PR-FIN-7 stays clear, but compute the
  // disabled predicate from real conditions so flipping
  // PRINT_NOT_IMPLEMENTED activates the buttons at the right moments.
  const printDisabled = PRINT_NOT_IMPLEMENTED || !entityId || !hasRows || isFetching;

  return (
    <div className="p-4 lg:p-6 space-y-4" dir="rtl">
      {/* Header — title pinned to the right at all breakpoints (RTL),
          actions cluster on the left. */}
      <header
        className="flex items-start justify-between gap-3 flex-wrap"
        data-testid="statements-header"
      >
        <div className="order-1 flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl bg-brand-50 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
            <ScrollText size={20} />
          </div>
          <div className="text-right">
            <h1 className="text-xl font-black text-slate-900 dark:text-slate-100">
              كشف الحسابات
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              كشوف حسابات تفصيلية لكل كيان مالي مع الرصيد الافتتاحي
              والختامي.
            </p>
          </div>
        </div>

        <div className="order-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching || !entityId}
            className="inline-flex items-center gap-2 rounded-xl bg-slate-800 dark:bg-slate-700 text-white px-3 py-2 text-xs font-bold hover:bg-slate-900 disabled:opacity-50"
            data-testid="statements-refresh-btn"
          >
            <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} />
            تحديث
          </button>
        </div>
      </header>

      {/* Tabs */}
      <StatementsTabs active={tab} onChange={handleTab} />

      {/* Filter bar */}
      <div
        className="flex flex-col gap-3 p-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm"
        dir="rtl"
        data-testid="statements-filter-bar"
      >
        <div className="flex flex-wrap items-end gap-3">
          <EntitySelector
            tab={tab}
            value={entityId}
            onChange={setEntityId}
          />
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold text-slate-600 dark:text-slate-400">
              الفترة
            </label>
            <div className="flex items-center gap-1 rounded-lg border border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-800 px-2 py-1.5">
              <CalendarRange size={14} className="text-slate-400 dark:text-slate-500" />
              <input
                type="date"
                value={range.from}
                onChange={(e) => setRange({ ...range, from: e.target.value })}
                className="bg-transparent text-[11px] text-slate-700 dark:text-slate-200 outline-none"
                data-testid="statements-date-from"
              />
              <span className="text-slate-400 dark:text-slate-500 text-[11px]">-</span>
              <input
                type="date"
                value={range.to}
                onChange={(e) => setRange({ ...range, to: e.target.value })}
                className="bg-transparent text-[11px] text-slate-700 dark:text-slate-200 outline-none"
                data-testid="statements-date-to"
              />
            </div>
          </div>

          {/* Demoted Print / Excel cluster.  Lives in the filter bar
              instead of the page header so it no longer competes with
              the title.  Stays disabled until an entity is picked AND
              rows exist (or until PR-FIN-7 lands). */}
          <div
            className="flex items-end gap-1 ms-auto"
            data-testid="statements-secondary-actions"
          >
            <button
              type="button"
              disabled={printDisabled}
              title="قريبًا في PR-FIN-7"
              className="inline-flex items-center gap-1.5 rounded-lg bg-transparent text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="statements-print-btn"
            >
              <Printer size={13} />
              طباعة
              <span className="text-[9px] font-bold rounded-full bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5">
                قريبًا
              </span>
            </button>
            <button
              type="button"
              disabled={printDisabled}
              title="قريبًا في PR-FIN-7"
              className="inline-flex items-center gap-1.5 rounded-lg bg-transparent text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-slate-800 px-2.5 py-1.5 text-[11px] font-semibold disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="statements-export-btn"
            >
              <FileSpreadsheet size={13} />
              تصدير Excel
              <span className="text-[9px] font-bold rounded-full bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5">
                قريبًا
              </span>
            </button>
          </div>
        </div>

        {/* Date presets — set both inputs in one click. */}
        <div
          className="flex flex-wrap items-center gap-1.5"
          data-testid="statements-date-presets"
        >
          <span className="text-[10px] font-bold text-slate-500 dark:text-slate-400 ms-1">
            فترات سريعة:
          </span>
          {PRESETS.map((p) => (
            <button
              key={p.key}
              type="button"
              onClick={() => setRange(presetRange(p.key))}
              className="inline-flex items-center rounded-full border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-brand-50 hover:border-brand-200 dark:hover:bg-brand-900/30 px-2.5 py-1 text-[10px] font-semibold text-slate-700 dark:text-slate-200 transition-colors"
              data-testid={`statements-preset-${p.key}`}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Confidence banner — surface the BE's explanatory note when
          rows exist.  Empty-state already shows it inline. */}
      {entityId && data && data.rows.length > 0 && data.confidence.note && (
        <div
          className="flex items-start gap-2 rounded-xl border border-blue-200 dark:border-blue-900 bg-blue-50/60 dark:bg-blue-900/20 px-3 py-2 text-xs text-blue-900 dark:text-blue-200"
          data-testid="statements-confidence-banner"
          dir="rtl"
        >
          <Info size={14} className="mt-0.5 flex-shrink-0 text-blue-600 dark:text-blue-300" />
          <span className="leading-relaxed">{data.confidence.note}</span>
        </div>
      )}

      {/* Content */}
      {!entityId ? (
        <EntityNotSelected />
      ) : isFetching && !data ? (
        <Loading />
      ) : error ? (
        <ErrorState onRetry={() => refetch()} />
      ) : data ? (
        <>
          <StatementHeaderCard data={data} />
          <StatementTable data={data} />
        </>
      ) : null}
    </div>
  );
}

function EntityNotSelected() {
  return (
    <div
      className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/40 dark:bg-slate-900/40 p-6 lg:p-8"
      data-testid="statements-no-entity"
      dir="rtl"
    >
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-brand-50 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
          <ScrollText size={20} />
        </div>
        <div className="flex-1">
          <div className="text-sm font-bold text-slate-700 dark:text-slate-200">
            ابدأ بإنشاء كشف حساب
          </div>
          <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">
            اتّبع الخطوات الثلاث لعرض كشف الحركات لأي كيان مالي:
            حسابات الأستاذ العام، الخزائن النقدية والبنكية والمحافظ،
            الموظفين، العملاء، والموردين.
          </div>
        </div>
      </div>

      <ol
        className="mt-5 grid grid-cols-1 sm:grid-cols-3 gap-3 text-right"
        data-testid="statements-empty-steps"
      >
        <Step n={1} title="اختر نوع الكشف">
          من شريط التبويبات أعلاه: حساب عام / خزنة / بنك / محفظة /
          موظف / عميل / مورد.
        </Step>
        <Step n={2} title="اختر الكيان">
          من قائمة "اختر..." في شريط الفلاتر.
        </Step>
        <Step n={3} title="حدّد الفترة">
          استخدم الفترات السريعة أو حقلَي التاريخ يدويًا.
        </Step>
      </ol>

      <div className="mt-4 flex items-center justify-center gap-1.5 text-[10px] text-slate-400 dark:text-slate-500">
        <MousePointer size={12} />
        ابدأ بالخطوة الأولى من شريط التبويبات في الأعلى.
      </div>
    </div>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <li
      className="rounded-xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 p-3"
      data-testid={`statements-step-${n}`}
    >
      <div className="flex items-center gap-2">
        <span className="w-6 h-6 rounded-full bg-brand-100 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 flex items-center justify-center text-[11px] font-black">
          {n}
        </span>
        <span className="text-xs font-bold text-slate-800 dark:text-slate-100">
          {title}
        </span>
      </div>
      <p className="text-[11px] text-slate-500 dark:text-slate-400 mt-1.5 leading-relaxed">
        {children}
      </p>
    </li>
  );
}

function Loading() {
  return (
    <div
      className="flex flex-col items-center justify-center py-20 gap-3"
      data-testid="statements-loading"
    >
      <Loader2 className="text-brand-600 animate-spin" size={32} />
      <div className="text-sm text-slate-500 dark:text-slate-400">
        جارٍ تحميل الكشف…
      </div>
    </div>
  );
}

function ErrorState({ onRetry }: { onRetry: () => void }) {
  return (
    <div
      className="rounded-2xl border border-rose-200 dark:border-rose-900 bg-rose-50/60 dark:bg-rose-900/20 p-5 flex flex-col items-center gap-3"
      data-testid="statements-error"
    >
      <AlertTriangle className="text-rose-600 dark:text-rose-400" size={24} />
      <div className="text-sm font-bold text-rose-800 dark:text-rose-200">
        تعذّر تحميل الكشف
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

export default FinanceStatements;
