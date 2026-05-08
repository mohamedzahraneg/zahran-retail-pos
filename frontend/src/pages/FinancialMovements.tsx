/**
 * FinancialMovements — read-only financial-movement trace tool
 * ────────────────────────────────────────────────────────────────────
 *
 * History:
 *   · PR-FE-ACCOUNTING-FINANCIAL-MOVEMENTS-FRAMING (#327) introduced
 *     this page as a framing/planning shell.
 *   · PR-FE-ACCOUNTING-FINANCIAL-MOVEMENTS-TRACE wired it to
 *     `GET /audit/financial-movements/trace` for single-movement deep
 *     trace.
 *   · PR-FE-ACCOUNTING-FINANCIAL-MOVEMENTS-LIST (this change) adds a
 *     browse-by-period panel powered by `GET /audit/financial-movements`
 *     so users can scan real movements (today / yesterday / week /
 *     month / custom) and click "عرض التتبع" to open the deep trace.
 *
 * Strict guarantees:
 *   · ZERO mutations — only `useQuery` (GET) is used; no
 *     `useMutation`, no `mutationFn`, no `.mutate(`
 *   · ZERO repair / fix / approve / void / post buttons — every
 *     action button on the page is either a list/detail trigger or a
 *     read-only "open source page" link
 *   · ZERO computed financial totals — totals shown are exactly the
 *     values returned by the BE service
 *   · Permission errors (403) are caught and rendered as a clear
 *     "no permission" message instead of a console exception
 *
 * Permission gate (route-level):
 *   `finance.dashboard.view` (existing, mirrors the original framing
 *   page; the BE endpoint itself enforces `audit.view`).
 */

import { useState, useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ArrowLeftRight,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Coins,
  ExternalLink,
  Eye,
  History,
  Info,
  Layers,
  ListFilter,
  Receipt,
  Search,
  ShieldAlert,
  Sparkles,
  Wallet,
  X,
} from 'lucide-react';
import {
  auditTraceApi,
  type ListParams,
  type ListPeriod,
  type ListResult,
  type MovementSummary,
  type TraceFlagSeverity,
  type TraceParams,
  type TraceReferenceType,
  type TraceResult,
} from '@/api/audit-trace.api';

interface ReferenceTypeOption {
  value: '' | TraceReferenceType;
  label: string;
}

const REFERENCE_TYPE_OPTIONS: ReferenceTypeOption[] = [
  { value: '', label: 'تخمين تلقائي' },
  { value: 'invoice', label: 'فاتورة مبيعات' },
  { value: 'return', label: 'مرتجع' },
  { value: 'purchase', label: 'فاتورة مشتريات' },
  { value: 'expense', label: 'مصروف' },
  { value: 'shift', label: 'وردية' },
  { value: 'customer_payment', label: 'دفعة عميل' },
  { value: 'supplier_payment', label: 'دفعة مورد' },
  { value: 'journal_entry', label: 'قيد محاسبي' },
];

const REFERENCE_TYPE_LABEL: Record<TraceReferenceType, string> = {
  invoice: 'فاتورة مبيعات',
  return: 'مرتجع',
  purchase: 'فاتورة مشتريات',
  expense: 'مصروف',
  shift: 'وردية',
  customer_payment: 'دفعة عميل',
  supplier_payment: 'دفعة مورد',
  journal_entry: 'قيد محاسبي',
};

interface PeriodTab {
  value: ListPeriod;
  label: string;
}

const PERIOD_TABS: PeriodTab[] = [
  { value: 'today', label: 'اليوم' },
  { value: 'yesterday', label: 'أمس' },
  { value: 'week', label: 'هذا الأسبوع' },
  { value: 'month', label: 'هذا الشهر' },
  { value: 'custom', label: 'مخصص' },
];

const todayISO = () => {
  const d = new Date();
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
};

const SEVERITY_PILL: Record<
  TraceFlagSeverity,
  { label: string; className: string }
> = {
  info: {
    label: 'ملاحظة',
    className: 'bg-slate-50 text-slate-700 border border-slate-200',
  },
  warning: {
    label: 'تنبيه',
    className: 'bg-amber-50 text-amber-700 border border-amber-200',
  },
  error: {
    label: 'خلل',
    className: 'bg-rose-50 text-rose-700 border border-rose-200',
  },
};

const EGP = (n: string | number | null | undefined) => {
  if (n === null || n === undefined || n === '') return '—';
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `${v.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;
};

const fmtDate = (s: string | null | undefined) => {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleString('en-US', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return s;
  }
};

export function FinancialMovements() {
  // ── Browse-by-period state ──────────────────────────────────────
  const [period, setPeriod] = useState<ListPeriod>('today');
  const [draftFrom, setDraftFrom] = useState<string>(todayISO());
  const [draftTo, setDraftTo] = useState<string>(todayISO());
  const [appliedRange, setAppliedRange] = useState<{
    from: string;
    to: string;
  } | null>(null);
  const [listReferenceType, setListReferenceType] = useState<
    '' | TraceReferenceType
  >('');

  // ── Detail (single-movement trace) state ────────────────────────
  const [draftReferenceType, setDraftReferenceType] = useState<
    '' | TraceReferenceType
  >('');
  const [draftQuery, setDraftQuery] = useState('');
  const [draftReferenceId, setDraftReferenceId] = useState('');
  const [draftIdemKey, setDraftIdemKey] = useState('');

  const [submitted, setSubmitted] = useState<TraceParams | null>(null);

  // ── List query (auto-fires on mount with period=today) ──────────
  const listParams: ListParams = useMemo(() => {
    if (period === 'custom' && appliedRange) {
      return {
        period: 'custom',
        from: appliedRange.from,
        to: appliedRange.to,
        reference_type: listReferenceType || undefined,
        limit: 100,
      };
    }
    return {
      period,
      reference_type: listReferenceType || undefined,
      limit: 100,
    };
  }, [period, appliedRange, listReferenceType]);

  // For period=custom we wait for the user to apply a range before
  // firing the query — otherwise an unconfigured "custom" tab would
  // throw a BadRequest from the BE.
  const listEnabled = period !== 'custom' || !!appliedRange;

  const {
    data: listData,
    isFetching: listFetching,
    error: listError,
  } = useQuery<ListResult, any>({
    queryKey: ['audit-financial-movements-list', listParams],
    queryFn: () => auditTraceApi.list(listParams),
    enabled: listEnabled,
    staleTime: 15_000,
    retry: false,
  });

  // ── Detail query ───────────────────────────────────────────────
  const { data, isFetching, error } = useQuery<TraceResult, any>({
    queryKey: ['audit-trace', submitted],
    queryFn: () => auditTraceApi.trace(submitted as TraceParams),
    enabled: !!submitted,
    staleTime: 30_000,
    retry: false,
  });

  const isPermissionError = useMemo(() => {
    if (!error) return false;
    const status = error?.response?.status;
    return status === 401 || status === 403;
  }, [error]);

  const isListPermissionError = useMemo(() => {
    if (!listError) return false;
    const status = listError?.response?.status;
    return status === 401 || status === 403;
  }, [listError]);

  // Reset custom-range applied state when leaving the custom tab so
  // re-entering it doesn't auto-fire stale params.
  useEffect(() => {
    if (period !== 'custom') setAppliedRange(null);
  }, [period]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = draftQuery.trim();
    const refId = draftReferenceId.trim();
    if (!q && !refId) return;
    setSubmitted({
      reference_type: draftReferenceType || undefined,
      reference_id: refId || undefined,
      q: q || undefined,
      idempotency_key: draftIdemKey.trim() || undefined,
    });
  };

  const handleClear = () => {
    setDraftReferenceType('');
    setDraftQuery('');
    setDraftReferenceId('');
    setDraftIdemKey('');
    setSubmitted(null);
  };

  const handleApplyCustomRange = () => {
    if (!draftFrom || !draftTo) return;
    if (draftFrom > draftTo) return;
    setAppliedRange({ from: draftFrom, to: draftTo });
  };

  const handleOpenTrace = (row: MovementSummary) => {
    setSubmitted({
      reference_type: row.source_type,
      reference_id: row.source_id,
    });
    if (typeof window !== 'undefined') {
      // Surface the detail panel for users who scrolled down the list.
      window.requestAnimationFrame(() => {
        const el = document.getElementById('financial-movements-detail-anchor');
        if (el && typeof el.scrollIntoView === 'function') {
          el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
      });
    }
  };

  const sourceLink = (() => {
    const src = data?.source;
    if (!src) return null;
    switch (src.type) {
      case 'invoice':
        return { href: '/invoices', label: 'فتح صفحة الفواتير' };
      case 'return':
        return { href: '/returns', label: 'فتح صفحة المرتجعات' };
      case 'purchase':
        return { href: '/purchases', label: 'فتح صفحة المشتريات' };
      case 'expense':
        return { href: '/daily-expenses', label: 'فتح المصروفات' };
      case 'shift':
        return { href: '/shifts', label: 'فتح الورديات' };
      case 'journal_entry':
        return { href: '/accounts', label: 'فتح القيود اليومية' };
      case 'customer_payment':
      case 'supplier_payment':
        return { href: '/cashboxes', label: 'فتح الخزائن' };
    }
  })();

  return (
    <div
      className="p-4 lg:p-6 space-y-5"
      dir="rtl"
      data-testid="financial-movements-page"
    >
      {/* ── Header ────────────────────────────────────────────────── */}
      <header
        className="flex items-start justify-between gap-3 flex-wrap"
        data-testid="financial-movements-header"
      >
        <div className="order-1 flex items-start gap-3">
          <div className="w-12 h-12 rounded-2xl bg-brand-50 text-brand-700 flex items-center justify-center shrink-0">
            <History size={24} />
          </div>
          <div className="text-right">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl lg:text-2xl font-black text-slate-900">
                تتبع حركة مالية
              </h1>
              <span
                className="text-[10px] font-bold rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 px-2 py-0.5"
                data-testid="financial-movements-readonly-badge"
              >
                قراءة فقط
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1 max-w-2xl">
              مراجعة مسار الحركة المالية من المصدر التشغيلي حتى القيد
              والخزينة والمخزون.
            </p>
          </div>
        </div>
      </header>

      {/* ── Read-only notice ───────────────────────────────────────── */}
      <div
        className="rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3 flex items-start gap-3"
        data-testid="financial-movements-readonly-notice"
      >
        <AlertTriangle
          size={18}
          className="text-amber-600 shrink-0 mt-0.5"
        />
        <div className="text-[12px] text-amber-900 leading-relaxed">
          هذه الصفحة للمراجعة فقط. لا يتم إنشاء أو تعديل أو عكس أي حركة
          مالية من هنا. مؤشرات الخلل تُعرض للتشخيص فقط ولا تشغّل أي إصلاح
          تلقائي.
        </div>
      </div>

      {/* ── Browse-by-period panel ─────────────────────────────────── */}
      <BrowsePanel
        period={period}
        onPeriodChange={setPeriod}
        draftFrom={draftFrom}
        draftTo={draftTo}
        onDraftFromChange={setDraftFrom}
        onDraftToChange={setDraftTo}
        onApplyCustomRange={handleApplyCustomRange}
        listReferenceType={listReferenceType}
        onListReferenceTypeChange={setListReferenceType}
        listData={listData}
        listFetching={listFetching}
        listError={listError}
        listPermissionDenied={isListPermissionError}
        listEnabled={listEnabled}
        onOpenTrace={handleOpenTrace}
      />

      {/* ── Search form ────────────────────────────────────────────── */}
      <form
        onSubmit={handleSubmit}
        className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
        data-testid="financial-movements-search-form"
      >
        <div className="grid grid-cols-1 md:grid-cols-12 gap-3">
          <div className="md:col-span-3 flex flex-col gap-1">
            <label className="text-[11px] font-bold text-slate-600">
              نوع المرجع
            </label>
            <select
              value={draftReferenceType}
              onChange={(e) =>
                setDraftReferenceType(e.target.value as '' | TraceReferenceType)
              }
              className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-[12px] text-slate-700 outline-none focus:bg-white focus:border-brand-300"
              data-testid="financial-movements-reference-type"
            >
              {REFERENCE_TYPE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div className="md:col-span-4 flex flex-col gap-1">
            <label className="text-[11px] font-bold text-slate-600">
              رقم المرجع
            </label>
            <div className="relative">
              <Search
                size={14}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
              />
              <input
                type="text"
                value={draftQuery}
                onChange={(e) => setDraftQuery(e.target.value)}
                placeholder="مثال: INV-2026-000123 أو RET-2026-000001"
                className="w-full bg-slate-50 border border-slate-200 rounded-lg pr-9 pl-3 py-2 text-[12px] text-slate-700 outline-none focus:bg-white focus:border-brand-300"
                data-testid="financial-movements-q-input"
                dir="rtl"
              />
            </div>
          </div>
          <div className="md:col-span-3 flex flex-col gap-1">
            <label className="text-[11px] font-bold text-slate-600">
              UUID (اختياري)
            </label>
            <input
              type="text"
              value={draftReferenceId}
              onChange={(e) => setDraftReferenceId(e.target.value)}
              placeholder="UUID للحركة"
              className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-[12px] text-slate-700 font-mono outline-none focus:bg-white focus:border-brand-300"
              data-testid="financial-movements-reference-id-input"
              dir="ltr"
            />
          </div>
          <div className="md:col-span-2 flex flex-col gap-1">
            <label className="text-[11px] font-bold text-slate-600">
              مفتاح منع التكرار (اختياري)
            </label>
            <input
              type="text"
              value={draftIdemKey}
              onChange={(e) => setDraftIdemKey(e.target.value)}
              placeholder="Idempotency-Key"
              className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-[12px] text-slate-700 font-mono outline-none focus:bg-white focus:border-brand-300"
              data-testid="financial-movements-idempotency-key-input"
              dir="ltr"
            />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="submit"
            className="inline-flex items-center gap-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white px-4 py-2 text-[12px] font-bold disabled:opacity-50"
            disabled={isFetching || (!draftQuery.trim() && !draftReferenceId.trim())}
            data-testid="financial-movements-search-submit"
          >
            <Search size={14} />
            تتبع الحركة
          </button>
          {(submitted || draftQuery || draftReferenceId || draftReferenceType || draftIdemKey) && (
            <button
              type="button"
              onClick={handleClear}
              className="inline-flex items-center gap-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 px-3 py-2 text-[11px] font-bold"
              data-testid="financial-movements-clear"
            >
              <X size={12} /> مسح
            </button>
          )}
        </div>
      </form>

      {/* ── Detail (deep-trace) states ────────────────────────────── */}
      <div id="financial-movements-detail-anchor" />

      {!submitted && <EmptyHint />}

      {submitted && isFetching && !data && (
        <LoadingState />
      )}

      {submitted && error && isPermissionError && (
        <PermissionDeniedState />
      )}

      {submitted && error && !isPermissionError && (
        <ErrorState message={error?.response?.data?.message || error?.message} />
      )}

      {submitted && data && (
        <TraceResultView data={data} sourceLink={sourceLink} />
      )}
    </div>
  );
}

function EmptyHint() {
  return (
    <div
      className="rounded-2xl border border-dashed border-slate-300 bg-slate-50/40 p-8 text-center"
      data-testid="financial-movements-empty-hint"
    >
      <ClipboardList size={28} className="mx-auto text-slate-400" />
      <div className="mt-2 text-sm font-bold text-slate-700">
        اختر حركة من القائمة بالأعلى لعرض تتبعها التفصيلي
      </div>
      <div className="text-[11px] text-slate-500 mt-1 max-w-md mx-auto leading-relaxed">
        أو ابحث برقم مرجع محدد (فاتورة، مرتجع، مشتريات، مصروف، وردية،
        دفعة عميل أو مورد، أو قيد محاسبي).
      </div>
    </div>
  );
}

// ─── Browse-by-period panel ─────────────────────────────────────────

interface BrowsePanelProps {
  period: ListPeriod;
  onPeriodChange: (p: ListPeriod) => void;
  draftFrom: string;
  draftTo: string;
  onDraftFromChange: (v: string) => void;
  onDraftToChange: (v: string) => void;
  onApplyCustomRange: () => void;
  listReferenceType: '' | TraceReferenceType;
  onListReferenceTypeChange: (v: '' | TraceReferenceType) => void;
  listData: ListResult | undefined;
  listFetching: boolean;
  listError: any;
  listPermissionDenied: boolean;
  listEnabled: boolean;
  onOpenTrace: (row: MovementSummary) => void;
}

function BrowsePanel(props: BrowsePanelProps) {
  const {
    period,
    onPeriodChange,
    draftFrom,
    draftTo,
    onDraftFromChange,
    onDraftToChange,
    onApplyCustomRange,
    listReferenceType,
    onListReferenceTypeChange,
    listData,
    listFetching,
    listError,
    listPermissionDenied,
    listEnabled,
    onOpenTrace,
  } = props;

  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4"
      data-testid="financial-movements-browse-panel"
    >
      {/* Header: title + period tabs */}
      <div className="flex items-center gap-2 flex-wrap">
        <ListFilter size={18} className="text-slate-500" />
        <h2 className="text-sm font-black text-slate-800">
          استعراض الحركات حسب الفترة
        </h2>
        <span className="text-[10px] text-slate-400">
          — قراءة فقط، اضغط "عرض التتبع" لفتح التفاصيل
        </span>
      </div>

      <div
        className="flex items-center gap-1 flex-wrap"
        role="tablist"
        data-testid="financial-movements-period-tabs"
      >
        {PERIOD_TABS.map((t) => {
          const active = period === t.value;
          return (
            <button
              key={t.value}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onPeriodChange(t.value)}
              className={`text-[12px] font-bold rounded-full px-3 py-1.5 transition-colors ${
                active
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
              data-testid={`financial-movements-period-${t.value}`}
            >
              {t.label}
            </button>
          );
        })}

        <div className="ms-auto flex items-center gap-2">
          <label className="text-[11px] font-bold text-slate-600">
            النوع
          </label>
          <select
            value={listReferenceType}
            onChange={(e) =>
              onListReferenceTypeChange(
                e.target.value as '' | TraceReferenceType,
              )
            }
            className="bg-slate-50 border border-slate-200 rounded-lg px-2 py-1 text-[11px] text-slate-700 outline-none focus:bg-white focus:border-brand-300"
            data-testid="financial-movements-list-reference-type"
          >
            <option value="">كل الأنواع</option>
            {(Object.keys(REFERENCE_TYPE_LABEL) as TraceReferenceType[]).map(
              (k) => (
                <option key={k} value={k}>
                  {REFERENCE_TYPE_LABEL[k]}
                </option>
              ),
            )}
          </select>
        </div>
      </div>

      {/* Custom date range */}
      {period === 'custom' && (
        <div
          className="rounded-xl border border-slate-100 bg-slate-50/50 p-3 flex flex-wrap items-end gap-3"
          data-testid="financial-movements-custom-range"
        >
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold text-slate-600">من</label>
            <input
              type="date"
              value={draftFrom}
              onChange={(e) => onDraftFromChange(e.target.value)}
              className="bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-[12px] text-slate-700 outline-none focus:border-brand-300"
              data-testid="financial-movements-custom-from"
              dir="ltr"
            />
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-[11px] font-bold text-slate-600">إلى</label>
            <input
              type="date"
              value={draftTo}
              onChange={(e) => onDraftToChange(e.target.value)}
              className="bg-white border border-slate-200 rounded-lg px-3 py-1.5 text-[12px] text-slate-700 outline-none focus:border-brand-300"
              data-testid="financial-movements-custom-to"
              dir="ltr"
            />
          </div>
          <button
            type="button"
            onClick={onApplyCustomRange}
            disabled={!draftFrom || !draftTo || draftFrom > draftTo}
            className="inline-flex items-center gap-1 rounded-lg bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white px-3 py-2 text-[12px] font-bold"
            data-testid="financial-movements-custom-apply"
          >
            <CalendarDays size={14} /> تطبيق
          </button>
          {draftFrom && draftTo && draftFrom > draftTo && (
            <div className="text-[11px] text-rose-700 font-bold">
              "من" يجب أن يكون قبل أو يساوي "إلى".
            </div>
          )}
        </div>
      )}

      {/* States */}
      {listPermissionDenied && (
        <div
          className="rounded-xl border border-rose-200 bg-rose-50/60 p-4 flex items-start gap-3"
          data-testid="financial-movements-list-permission-denied"
        >
          <ShieldAlert size={18} className="text-rose-600 shrink-0 mt-0.5" />
          <div className="text-[12px] text-rose-800">
            صلاحية{' '}
            <span className="font-mono font-bold">audit.view</span> مطلوبة
            لاستعراض الحركات.
          </div>
        </div>
      )}

      {listError && !listPermissionDenied && (
        <div
          className="rounded-xl border border-rose-200 bg-rose-50/60 p-4 flex items-start gap-3"
          data-testid="financial-movements-list-error"
        >
          <AlertTriangle size={18} className="text-rose-600 shrink-0 mt-0.5" />
          <div className="text-[12px] text-rose-800">
            تعذّر تحميل قائمة الحركات.
            {listError?.response?.data?.message && (
              <span className="block text-[11px] text-rose-700 mt-1">
                {listError.response.data.message}
              </span>
            )}
          </div>
        </div>
      )}

      {!listEnabled && (
        <div
          className="rounded-xl border border-dashed border-slate-300 bg-slate-50/40 p-6 text-center text-[12px] text-slate-600"
          data-testid="financial-movements-list-awaiting-range"
        >
          اختر تاريخين ثم اضغط "تطبيق" لعرض الحركات.
        </div>
      )}

      {listEnabled && listFetching && !listData && (
        <div
          className="rounded-xl border border-slate-200 bg-slate-50/40 p-6 text-center text-[12px] text-slate-600"
          data-testid="financial-movements-list-loading"
        >
          جارٍ تحميل الحركات…
        </div>
      )}

      {listEnabled && listData && (
        <>
          <BrowseSummaryCards data={listData} />
          {listData.items.length === 0 ? (
            <div
              className="rounded-xl border border-dashed border-slate-300 bg-slate-50/40 p-8 text-center"
              data-testid="financial-movements-list-empty"
            >
              <ClipboardList size={24} className="mx-auto text-slate-400" />
              <div className="mt-2 text-sm font-bold text-slate-700">
                لا توجد حركات مالية في هذه الفترة
              </div>
              <div className="text-[11px] text-slate-500 mt-1 leading-relaxed">
                جرّب فترة أوسع أو غيّر النوع.
              </div>
            </div>
          ) : (
            <BrowseListTable
              data={listData}
              onOpenTrace={onOpenTrace}
            />
          )}
        </>
      )}
    </section>
  );
}

function BrowseSummaryCards({ data }: { data: ListResult }) {
  const cards = [
    {
      key: 'total',
      label: 'إجمالي الحركات',
      value: data.totals.total,
      tone: 'text-slate-800',
    },
    {
      key: 'with_journal',
      label: 'بها قيود',
      value: data.totals.with_journal,
      tone: 'text-emerald-700',
    },
    {
      key: 'with_cashbox',
      label: 'بها خزينة',
      value: data.totals.with_cashbox_transaction,
      tone: 'text-sky-700',
    },
    {
      key: 'with_stock',
      label: 'بها مخزون',
      value: data.totals.with_stock_movement,
      tone: 'text-indigo-700',
    },
    {
      key: 'with_flags',
      label: 'بها مؤشرات',
      value: data.totals.with_flags,
      tone: 'text-amber-700',
    },
  ];
  return (
    <div
      className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2"
      data-testid="financial-movements-list-summary"
    >
      {cards.map((c) => (
        <div
          key={c.key}
          className="rounded-xl border border-slate-100 bg-slate-50/40 p-3"
          data-testid={`financial-movements-list-summary-${c.key}`}
        >
          <div className="text-[10px] font-bold text-slate-500">{c.label}</div>
          <div className={`mt-1 text-lg font-black tabular-nums ${c.tone}`}>
            {c.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function BrowseListTable({
  data,
  onOpenTrace,
}: {
  data: ListResult;
  onOpenTrace: (row: MovementSummary) => void;
}) {
  return (
    <div className="overflow-x-auto" data-testid="financial-movements-list-table">
      <table className="w-full text-[11px]" dir="rtl">
        <thead className="bg-slate-50 text-slate-500">
          <tr>
            <th className="text-right p-2 font-bold whitespace-nowrap">التاريخ</th>
            <th className="text-right p-2 font-bold">النوع</th>
            <th className="text-right p-2 font-bold">الرقم</th>
            <th className="text-right p-2 font-bold">العميل/المورد</th>
            <th className="text-right p-2 font-bold">الإجمالي</th>
            <th className="text-right p-2 font-bold">الحالة</th>
            <th className="text-center p-2 font-bold">قيد</th>
            <th className="text-center p-2 font-bold">خزينة</th>
            <th className="text-center p-2 font-bold">مخزون</th>
            <th className="text-center p-2 font-bold">مؤشرات</th>
            <th className="text-center p-2 font-bold"></th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {data.items.map((row) => (
            <tr
              key={`${row.source_type}-${row.source_id}`}
              data-testid={`financial-movements-list-row-${row.source_id}`}
            >
              <td className="p-2 text-slate-600 whitespace-nowrap">
                {fmtDate(row.date)}
              </td>
              <td className="p-2">
                <span className="text-[10px] font-bold rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5 whitespace-nowrap">
                  {REFERENCE_TYPE_LABEL[row.source_type]}
                </span>
              </td>
              <td className="p-2 font-mono font-bold text-slate-800 whitespace-nowrap">
                {row.number || '—'}
              </td>
              <td className="p-2 text-slate-600">{row.party_name || '—'}</td>
              <td className="p-2 tabular-nums whitespace-nowrap">
                {EGP(row.total)}
              </td>
              <td className="p-2 text-slate-600 whitespace-nowrap">
                {row.status || '—'}
              </td>
              <td className="p-2 text-center">
                <IndicatorDot on={row.has_journal} />
              </td>
              <td className="p-2 text-center">
                <IndicatorDot on={row.has_cashbox_transaction} />
              </td>
              <td className="p-2 text-center">
                <IndicatorDot on={row.has_stock_movement} />
              </td>
              <td className="p-2 text-center">
                {row.flags_count > 0 ? (
                  <span
                    className="text-[10px] font-bold rounded-full bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5 tabular-nums"
                    data-testid={`financial-movements-list-flags-${row.source_id}`}
                  >
                    {row.flags_count}
                  </span>
                ) : (
                  <span className="text-[10px] text-slate-400">—</span>
                )}
              </td>
              <td className="p-2 text-center">
                <button
                  type="button"
                  onClick={() => onOpenTrace(row)}
                  className="inline-flex items-center gap-1 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 px-2 py-1 text-[11px] font-bold whitespace-nowrap"
                  data-testid={`financial-movements-list-trace-${row.source_id}`}
                >
                  <Eye size={12} /> عرض التتبع
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data.truncated && (
        <div
          className="mt-2 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2"
          data-testid="financial-movements-list-truncated"
        >
          النتائج مقطوعة — جرّب فترة أضيق أو ارفع الحد الأقصى.
        </div>
      )}
    </div>
  );
}

function IndicatorDot({ on }: { on: boolean }) {
  return on ? (
    <span
      className="inline-block w-2 h-2 rounded-full bg-emerald-500"
      aria-label="موجود"
      data-on="1"
    />
  ) : (
    <span
      className="inline-block w-2 h-2 rounded-full bg-slate-300"
      aria-label="غير موجود"
      data-on="0"
    />
  );
}

function LoadingState() {
  return (
    <div
      className="rounded-2xl border border-slate-200 bg-white p-8 text-center"
      data-testid="financial-movements-loading"
    >
      <div className="mt-2 text-sm font-bold text-slate-700">
        جارٍ تحميل بيانات التتبع…
      </div>
    </div>
  );
}

function PermissionDeniedState() {
  return (
    <div
      className="rounded-2xl border border-rose-200 bg-rose-50/60 p-6 flex items-start gap-3"
      data-testid="financial-movements-permission-denied"
    >
      <ShieldAlert size={20} className="text-rose-600 shrink-0 mt-0.5" />
      <div>
        <div className="text-sm font-bold text-rose-800">لا توجد صلاحية</div>
        <div className="text-[11px] text-rose-700 mt-1 leading-relaxed">
          صلاحية <span className="font-mono font-bold">audit.view</span> مطلوبة لاستخدام تتبع الحركات المالية.
        </div>
      </div>
    </div>
  );
}

function ErrorState({ message }: { message: string | undefined }) {
  return (
    <div
      className="rounded-2xl border border-rose-200 bg-rose-50/60 p-6 flex items-start gap-3"
      data-testid="financial-movements-error"
    >
      <AlertTriangle size={20} className="text-rose-600 shrink-0 mt-0.5" />
      <div>
        <div className="text-sm font-bold text-rose-800">تعذّر تحميل البيانات</div>
        {message && (
          <div className="text-[11px] text-rose-700 mt-1 leading-relaxed">
            {message}
          </div>
        )}
      </div>
    </div>
  );
}

function TraceResultView({
  data,
  sourceLink,
}: {
  data: TraceResult;
  sourceLink: { href: string; label: string } | null;
}) {
  if (!data.source) {
    return (
      <div
        className="rounded-2xl border border-slate-200 bg-white p-8 text-center"
        data-testid="financial-movements-no-result"
      >
        <Search size={28} className="mx-auto text-slate-400" />
        <div className="mt-2 text-sm font-bold text-slate-700">لا توجد نتيجة</div>
        <div className="text-[11px] text-slate-500 mt-1">
          لم يتم العثور على حركة مرتبطة. تأكد من نوع المرجع ورقمه.
        </div>
        {data.flags.length > 0 && <FlagsPanel flags={data.flags} />}
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="financial-movements-result">
      <SummaryCard data={data} sourceLink={sourceLink} />
      <SourceCard data={data} />
      <FlagsPanel flags={data.flags} />
      {data.journalEntries.length > 0 && (
        <JournalEntriesCard data={data} />
      )}
      {data.journalLines.length > 0 && <JournalLinesTable data={data} />}
      {data.cashboxTransactions.length > 0 && (
        <CashboxTransactionsTable data={data} />
      )}
      {data.stockMovements.length > 0 && <StockMovementsTable data={data} />}
      {data.idempotency.length > 0 && (
        <IdempotencyCard idem={data.idempotency} />
      )}
    </div>
  );
}

function SummaryCard({
  data,
  sourceLink,
}: {
  data: TraceResult;
  sourceLink: { href: string; label: string } | null;
}) {
  const s = data.summary;
  const Pill = ({
    label,
    state,
  }: {
    label: string;
    state: boolean | null;
  }) => {
    let cls = 'bg-slate-50 text-slate-500 border border-slate-200';
    let txt = 'لا ينطبق';
    if (state === true) {
      cls = 'bg-emerald-50 text-emerald-700 border border-emerald-200';
      txt = 'مكتمل';
    } else if (state === false) {
      cls = 'bg-rose-50 text-rose-700 border border-rose-200';
      txt = 'يحتاج مراجعة';
    }
    return (
      <div className="rounded-xl border border-slate-100 p-3 flex items-center justify-between gap-2 bg-slate-50/40">
        <span className="text-[11px] font-bold text-slate-700">{label}</span>
        <span className={`text-[10px] font-bold rounded-full px-2 py-0.5 ${cls}`}>
          {txt}
        </span>
      </div>
    );
  };
  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
      data-testid="financial-movements-summary-card"
    >
      <div className="flex items-center gap-2 flex-wrap">
        <CheckCircle2 size={18} className="text-slate-500" />
        <h2 className="text-sm font-black text-slate-800">ملخص التتبع</h2>
        {sourceLink && (
          <a
            href={sourceLink.href}
            className="ms-auto inline-flex items-center gap-1 text-[11px] font-bold text-brand-700 hover:underline"
            data-testid="financial-movements-source-link"
          >
            <ExternalLink size={12} /> {sourceLink.label}
          </a>
        )}
      </div>
      <div className="grid grid-cols-2 lg:grid-cols-3 gap-2">
        <Pill label="القيد المحاسبي" state={s.hasJournal} />
        <Pill label="حركة الخزينة" state={s.hasCashboxTransaction} />
        <Pill label="حركة المخزون" state={s.hasStockMovement} />
        <Pill label="توازن القيد" state={s.journalBalanced} />
        <Pill label="مطابقة الكاش" state={s.cashMatched} />
        <Pill label="مطابقة المخزون" state={s.stockMatched} />
      </div>
    </section>
  );
}

function SourceCard({ data }: { data: TraceResult }) {
  const s = data.source!;
  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
      data-testid="financial-movements-source-card"
    >
      <div className="flex items-center gap-2">
        <Sparkles size={18} className="text-slate-500" />
        <h2 className="text-sm font-black text-slate-800">الحدث الأصلي</h2>
        <span className="text-[10px] font-bold rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5">
          {REFERENCE_TYPE_LABEL[s.type]}
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 text-[11px]">
        <Field label="رقم المرجع" value={s.number || '—'} mono />
        <Field label="UUID" value={s.id} mono ltr />
        <Field label="التاريخ" value={fmtDate(s.date)} />
        <Field label="الحالة" value={s.status || '—'} />
        <Field label="الإجمالي" value={EGP(s.total)} />
        <Field label="المدفوع" value={EGP(s.paid)} />
        {s.user_name && <Field label="المستخدم" value={s.user_name} />}
        {s.customer_name && <Field label="العميل" value={s.customer_name} />}
        {s.supplier_name && <Field label="المورد" value={s.supplier_name} />}
        {s.notes && <Field label="ملاحظات" value={s.notes} />}
      </div>
    </section>
  );
}

function Field({
  label,
  value,
  mono = false,
  ltr = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
  ltr?: boolean;
}) {
  return (
    <div className="rounded-xl border border-slate-100 p-2.5 bg-slate-50/40">
      <div className="text-[10px] font-bold text-slate-500">{label}</div>
      <div
        className={`mt-1 text-[12px] text-slate-800 ${mono ? 'font-mono' : ''} ${ltr ? 'text-left' : ''}`}
        dir={ltr ? 'ltr' : 'rtl'}
      >
        {value}
      </div>
    </div>
  );
}

function FlagsPanel({ flags }: { flags: TraceResult['flags'] }) {
  if (flags.length === 0) {
    return (
      <section
        className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-4 flex items-center gap-3"
        data-testid="financial-movements-flags-empty"
      >
        <CheckCircle2 size={18} className="text-emerald-600" />
        <div className="text-[12px] text-emerald-800 font-bold">
          لا توجد مؤشرات خلل على هذه الحركة.
        </div>
      </section>
    );
  }
  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5 space-y-2"
      data-testid="financial-movements-flags"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert size={18} className="text-slate-500" />
        <h2 className="text-sm font-black text-slate-800">مؤشرات الخلل</h2>
        <span className="text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5">
          {flags.length}
        </span>
        <span className="text-[10px] text-slate-400">— تشخيصية فقط</span>
      </div>
      <ul className="space-y-1.5">
        {flags.map((f, i) => {
          const pill = SEVERITY_PILL[f.severity];
          return (
            <li
              key={`${f.code}-${i}`}
              className="flex items-start justify-between gap-3 py-2 border-b border-slate-100 last:border-0"
              data-testid={`financial-movements-flag-${f.code}`}
            >
              <div className="flex items-start gap-2 min-w-0">
                <Info size={14} className="text-slate-400 shrink-0 mt-0.5" />
                <div className="min-w-0">
                  <div className="text-[12px] font-bold text-slate-800">
                    {f.message_ar}
                  </div>
                  <div className="text-[10px] text-slate-400 font-mono mt-0.5">
                    {f.code}
                  </div>
                </div>
              </div>
              <span
                className={`text-[10px] font-bold rounded-full px-2 py-0.5 shrink-0 ${pill.className}`}
              >
                {pill.label}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function JournalEntriesCard({ data }: { data: TraceResult }) {
  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
      data-testid="financial-movements-journal-entries"
    >
      <div className="flex items-center gap-2">
        <BookOpen size={18} className="text-slate-500" />
        <h2 className="text-sm font-black text-slate-800">القيد المحاسبي</h2>
        <span className="text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5">
          {data.journalEntries.length}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]" dir="rtl">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-right p-2 font-bold">رقم القيد</th>
              <th className="text-right p-2 font-bold">التاريخ</th>
              <th className="text-right p-2 font-bold">الوصف</th>
              <th className="text-right p-2 font-bold">إجمالي مدين</th>
              <th className="text-right p-2 font-bold">إجمالي دائن</th>
              <th className="text-right p-2 font-bold">التوازن</th>
              <th className="text-right p-2 font-bold">الحالة</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.journalEntries.map((e) => (
              <tr key={e.id}>
                <td className="p-2 font-mono font-bold text-slate-800">
                  {e.entry_no}
                </td>
                <td className="p-2 text-slate-600 whitespace-nowrap">
                  {e.entry_date}
                </td>
                <td className="p-2 text-slate-600">{e.description || '—'}</td>
                <td className="p-2 tabular-nums">{EGP(e.total_debit)}</td>
                <td className="p-2 tabular-nums">{EGP(e.total_credit)}</td>
                <td className="p-2">
                  {e.is_balanced ? (
                    <span className="text-[10px] font-bold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5">
                      متوازن
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold rounded-full bg-rose-50 text-rose-700 border border-rose-200 px-2 py-0.5">
                      غير متوازن
                    </span>
                  )}
                </td>
                <td className="p-2">
                  {e.is_void ? (
                    <span className="text-[10px] font-bold rounded-full bg-slate-50 text-slate-500 border border-slate-200 px-2 py-0.5">
                      ملغى
                    </span>
                  ) : e.is_posted ? (
                    <span className="text-[10px] font-bold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5">
                      مرحّل
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold rounded-full bg-amber-50 text-amber-700 border border-amber-200 px-2 py-0.5">
                      مسودة
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function JournalLinesTable({ data }: { data: TraceResult }) {
  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
      data-testid="financial-movements-journal-lines"
    >
      <div className="flex items-center gap-2">
        <Layers size={18} className="text-slate-500" />
        <h2 className="text-sm font-black text-slate-800">سطور القيد</h2>
        <span className="text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5">
          {data.journalLines.length}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]" dir="rtl">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-right p-2 font-bold">الحساب</th>
              <th className="text-right p-2 font-bold">الكود</th>
              <th className="text-right p-2 font-bold">مدين</th>
              <th className="text-right p-2 font-bold">دائن</th>
              <th className="text-right p-2 font-bold">الخزينة</th>
              <th className="text-right p-2 font-bold">الوصف</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.journalLines.map((l) => (
              <tr key={l.id}>
                <td className="p-2 font-bold text-slate-800">
                  {l.account_name || '—'}
                </td>
                <td className="p-2 font-mono text-slate-600">
                  {l.account_code || '—'}
                </td>
                <td className="p-2 tabular-nums">
                  {Number(l.debit) > 0 ? EGP(l.debit) : '—'}
                </td>
                <td className="p-2 tabular-nums">
                  {Number(l.credit) > 0 ? EGP(l.credit) : '—'}
                </td>
                <td className="p-2 text-slate-600">
                  {l.cashbox_name_ar || '—'}
                </td>
                <td className="p-2 text-slate-600">{l.description || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function CashboxTransactionsTable({ data }: { data: TraceResult }) {
  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
      data-testid="financial-movements-cashbox-transactions"
    >
      <div className="flex items-center gap-2">
        <Wallet size={18} className="text-slate-500" />
        <h2 className="text-sm font-black text-slate-800">حركة الخزينة</h2>
        <span className="text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5">
          {data.cashboxTransactions.length}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]" dir="rtl">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-right p-2 font-bold">الخزينة</th>
              <th className="text-right p-2 font-bold">الاتجاه</th>
              <th className="text-right p-2 font-bold">المبلغ</th>
              <th className="text-right p-2 font-bold">التصنيف</th>
              <th className="text-right p-2 font-bold">الرصيد بعد</th>
              <th className="text-right p-2 font-bold">التاريخ</th>
              <th className="text-right p-2 font-bold">المستخدم</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.cashboxTransactions.map((t) => (
              <tr key={t.id}>
                <td className="p-2 font-bold text-slate-800">
                  {t.cashbox_name_ar || '—'}
                </td>
                <td className="p-2">
                  {t.direction === 'in' ? (
                    <span className="text-[10px] font-bold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5">
                      وارد
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold rounded-full bg-rose-50 text-rose-700 border border-rose-200 px-2 py-0.5">
                      صادر
                    </span>
                  )}
                </td>
                <td className="p-2 tabular-nums">{EGP(t.amount)}</td>
                <td className="p-2 font-mono text-slate-600">{t.category}</td>
                <td className="p-2 tabular-nums text-slate-600">
                  {EGP(t.balance_after)}
                </td>
                <td className="p-2 text-slate-600 whitespace-nowrap">
                  {fmtDate(t.created_at)}
                </td>
                <td className="p-2 text-slate-600">{t.user_name || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function StockMovementsTable({ data }: { data: TraceResult }) {
  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
      data-testid="financial-movements-stock-movements"
    >
      <div className="flex items-center gap-2">
        <ArrowLeftRight size={18} className="text-slate-500" />
        <h2 className="text-sm font-black text-slate-800">حركة المخزون</h2>
        <span className="text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5">
          {data.stockMovements.length}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-[11px]" dir="rtl">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-right p-2 font-bold">المنتج</th>
              <th className="text-right p-2 font-bold">SKU</th>
              <th className="text-right p-2 font-bold">المخزن</th>
              <th className="text-right p-2 font-bold">النوع</th>
              <th className="text-right p-2 font-bold">الاتجاه</th>
              <th className="text-right p-2 font-bold">الكمية</th>
              <th className="text-right p-2 font-bold">التكلفة</th>
              <th className="text-right p-2 font-bold">التاريخ</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.stockMovements.map((m) => (
              <tr key={m.id}>
                <td className="p-2 font-bold text-slate-800">
                  {m.product_name_ar || '—'}
                </td>
                <td className="p-2 font-mono text-slate-600">
                  {m.variant_sku || '—'}
                </td>
                <td className="p-2 text-slate-600">
                  {m.warehouse_name_ar || '—'}
                </td>
                <td className="p-2 font-mono text-slate-600">
                  {m.movement_type}
                </td>
                <td className="p-2">
                  {m.direction === 'in' ? (
                    <span className="text-[10px] font-bold rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200 px-2 py-0.5">
                      دخول
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold rounded-full bg-rose-50 text-rose-700 border border-rose-200 px-2 py-0.5">
                      خروج
                    </span>
                  )}
                </td>
                <td className="p-2 tabular-nums">{m.quantity}</td>
                <td className="p-2 tabular-nums">{EGP(m.unit_cost)}</td>
                <td className="p-2 text-slate-600 whitespace-nowrap">
                  {fmtDate(m.created_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function IdempotencyCard({
  idem,
}: {
  idem: TraceResult['idempotency'];
}) {
  return (
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
      data-testid="financial-movements-idempotency"
    >
      <div className="flex items-center gap-2">
        <Coins size={18} className="text-slate-500" />
        <h2 className="text-sm font-black text-slate-800">بيانات منع التكرار</h2>
      </div>
      <ul className="space-y-2">
        {idem.map((it) => (
          <li
            key={it.key}
            className="rounded-xl border border-slate-100 p-3 bg-slate-50/40"
          >
            <div className="text-[10px] font-bold text-slate-500">المفتاح</div>
            <div className="font-mono text-[12px] text-slate-800 break-all" dir="ltr">
              {it.key}
            </div>
            <div className="text-[10px] text-slate-500 mt-2">{it.note_ar}</div>
          </li>
        ))}
      </ul>
    </section>
  );
}

export default FinancialMovements;
