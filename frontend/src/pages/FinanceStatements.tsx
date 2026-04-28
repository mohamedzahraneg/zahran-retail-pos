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
  Loader2,
  Printer,
  RefreshCw,
  ScrollText,
} from 'lucide-react';
import { statementsApi, type StatementResponse } from '@/api/statements.api';
import { StatementsTabs, type StatementTab } from '@/components/finance/statements/StatementsTabs';
import { EntitySelector } from '@/components/finance/statements/EntitySelector';
import { StatementHeaderCard } from '@/components/finance/statements/StatementHeaderCard';
import { StatementTable } from '@/components/finance/statements/StatementTable';

/** Same Cairo-month default the backend uses. */
function defaultRange(): { from: string; to: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${d}` };
}

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

  return (
    <div className="p-4 lg:p-6 space-y-4" dir="rtl">
      {/* Header */}
      <header
        className="flex items-start justify-between gap-3 flex-wrap"
        data-testid="statements-header"
      >
        <div className="order-2 lg:order-1 flex items-center gap-2">
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
          <button
            type="button"
            disabled
            title="قريبًا في PR-FIN-7"
            className="inline-flex items-center gap-2 rounded-xl bg-white dark:bg-slate-800 text-slate-400 dark:text-slate-500 border border-dashed border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-bold cursor-not-allowed"
            data-testid="statements-print-btn"
          >
            <Printer size={14} />
            طباعة
            <span className="text-[9px] font-bold rounded-full bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5">
              قريبًا
            </span>
          </button>
          <button
            type="button"
            disabled
            title="قريبًا في PR-FIN-7"
            className="inline-flex items-center gap-2 rounded-xl bg-white dark:bg-slate-800 text-slate-400 dark:text-slate-500 border border-dashed border-slate-200 dark:border-slate-700 px-3 py-2 text-xs font-bold cursor-not-allowed"
            data-testid="statements-export-btn"
          >
            <FileSpreadsheet size={14} />
            تصدير Excel
            <span className="text-[9px] font-bold rounded-full bg-slate-100 dark:bg-slate-800 px-1.5 py-0.5">
              قريبًا
            </span>
          </button>
        </div>

        <div className="order-1 lg:order-2 flex items-start gap-3">
          <div className="text-right">
            <h1 className="text-xl font-black text-slate-900 dark:text-slate-100">
              كشف الحسابات
            </h1>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              كشوف حسابات تفصيلية لكل كيان مالي مع الرصيد الافتتاحي
              والختامي.
            </p>
          </div>
          <div className="w-10 h-10 rounded-xl bg-brand-50 dark:bg-brand-900/40 text-brand-700 dark:text-brand-300 flex items-center justify-center shrink-0">
            <ScrollText size={20} />
          </div>
        </div>
      </header>

      {/* Tabs */}
      <StatementsTabs active={tab} onChange={handleTab} />

      {/* Filter bar */}
      <div
        className="flex flex-wrap items-end gap-3 p-3 rounded-2xl border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shadow-sm"
        dir="rtl"
        data-testid="statements-filter-bar"
      >
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
      </div>

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
      className="rounded-2xl border border-dashed border-slate-300 dark:border-slate-700 bg-slate-50/40 dark:bg-slate-900/40 p-8 text-center"
      data-testid="statements-no-entity"
      dir="rtl"
    >
      <ScrollText
        size={28}
        className="mx-auto text-slate-400 dark:text-slate-500"
      />
      <div className="mt-2 text-sm font-bold text-slate-700 dark:text-slate-200">
        اختر كيانًا لعرض كشف الحسابات
      </div>
      <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1">
        اختر التبويب المناسب ثم الكيان من القائمة.
      </div>
    </div>
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
