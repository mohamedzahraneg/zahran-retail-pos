/**
 * PR-REPORTS-1 — Shift reports page.
 *
 * Three reports, all driven by the same period + filter bar:
 *
 *   1. Single shift  → reuses ./shiftReportBuilder (HTML + Excel)
 *   2. All shifts    → ./shiftsPeriodReportBuilder (HTML + Excel)
 *   3. Payment channels → ./shiftsPeriodReportBuilder
 *
 * The page is read-only. No mutations, no migrations — it composes
 * existing endpoints (`/shifts`, `/shifts/:id/summary`,
 * `/dashboard/payment-channels`) plus the `from/to/cashbox_id` filter
 * extensions added to `GET /shifts` in this PR.
 */

import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  FileText,
  Printer,
  Download,
  RefreshCw,
  CalendarDays,
  Wallet,
  Layers,
  ClipboardList,
  Info,
} from 'lucide-react';

import { useAuthStore } from '@/stores/auth.store';
import { shiftsApi, Shift } from '@/api/shifts.api';
import { dashboardApi } from '@/api/dashboard.api';
import { cashDeskApi } from '@/api/cash-desk.api';
import { usersApi } from '@/api/users.api';
import { exportMultiSheet, printReport } from '@/lib/exportExcel';
import {
  buildShiftReportHtml,
  buildShiftReportSheets,
} from './shiftReportBuilder';
import {
  buildAllShiftsReportHtml,
  buildAllShiftsReportSheets,
  buildPaymentChannelsReportHtml,
  buildPaymentChannelsReportSheets,
  ShiftRowWithBreakdown,
  computeAllShiftsTotals,
} from './shiftsPeriodReportBuilder';

const EGP = (n: number | string) =>
  `${Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

type Preset = 'today' | 'week' | 'month' | 'custom';
type ReportTab = 'single' | 'all' | 'channels';
type StatusFilter = 'all' | 'open' | 'closed' | 'pending_close';

/** Cairo-local YYYY-MM-DD for `d` (browser TZ-agnostic). */
function cairoIso(d: Date): string {
  // toLocaleDateString in en-CA gives YYYY-MM-DD reliably.
  return d.toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
}

function rangeForPreset(preset: Preset, today = new Date()): { from: string; to: string } {
  const to = cairoIso(today);
  if (preset === 'today') return { from: to, to };
  if (preset === 'week') {
    // ISO-style week: Saturday is the conventional Egyptian start, but
    // we use 7-days-ago window to keep the math TZ-independent and
    // align with the cashier's mental model ("the last week").
    const start = new Date(today);
    start.setDate(start.getDate() - 6);
    return { from: cairoIso(start), to };
  }
  if (preset === 'month') {
    const start = new Date(today);
    start.setDate(start.getDate() - 29);
    return { from: cairoIso(start), to };
  }
  return { from: to, to };
}

function presetLabel(preset: Preset, from: string, to: string): string {
  if (preset === 'today') return `اليوم (${from})`;
  if (preset === 'week') return `آخر 7 أيام (${from} → ${to})`;
  if (preset === 'month') return `آخر 30 يوم (${from} → ${to})`;
  return `من ${from} إلى ${to}`;
}

export default function ShiftReports() {
  const user = useAuthStore((s) => s.user);
  const generatedByName = user?.full_name || user?.username || null;

  /* ─── Filters ─── */
  const [preset, setPreset] = useState<Preset>('today');
  const initialRange = rangeForPreset('today');
  const [from, setFrom] = useState(initialRange.from);
  const [to, setTo] = useState(initialRange.to);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [cashboxId, setCashboxId] = useState<string>('');
  const [cashierId, setCashierId] = useState<string>('');
  const [tab, setTab] = useState<ReportTab>('all');
  const [selectedShiftId, setSelectedShiftId] = useState<string>('');

  const setPresetAndRange = (p: Preset) => {
    setPreset(p);
    if (p !== 'custom') {
      const r = rangeForPreset(p);
      setFrom(r.from);
      setTo(r.to);
    }
  };

  /* ─── Reference data for pickers ─── */
  const { data: cashboxes = [] } = useQuery({
    queryKey: ['cashboxes-all'],
    queryFn: () => cashDeskApi.cashboxes(true),
  });
  const { data: cashiers = [] } = useQuery({
    queryKey: ['users-pickable'],
    queryFn: () => usersApi.pickable(),
  });

  /* ─── Shifts list (uses new from/to/cashbox_id filters) ─── */
  const shiftsQuery = useQuery({
    queryKey: ['report-shifts', { from, to, statusFilter, cashboxId, cashierId }],
    queryFn: () =>
      shiftsApi.list({
        status: statusFilter === 'all' ? undefined : statusFilter,
        user_id: cashierId || undefined,
        cashbox_id: cashboxId || undefined,
        from,
        to,
      }),
  });
  const shifts: Shift[] = shiftsQuery.data ?? [];

  /* ─── Per-shift summary fan-out (only fetched when needed) ─── */
  const shiftIds = useMemo(() => shifts.map((s) => s.id), [shifts]);
  const summariesQuery = useQuery({
    queryKey: ['report-shift-summaries', shiftIds],
    enabled: tab === 'all' && shiftIds.length > 0,
    queryFn: async () => {
      const arr = await Promise.all(
        shiftIds.map((id) =>
          shiftsApi.summary(id).catch(() => null),
        ),
      );
      const map: Record<string, any> = {};
      shiftIds.forEach((id, i) => {
        if (arr[i]) map[id] = arr[i];
      });
      return map;
    },
  });

  /** Shift rows enriched with cash / non-cash / grand from summaries. */
  const enrichedShifts: ShiftRowWithBreakdown[] = useMemo(() => {
    const map = summariesQuery.data || {};
    return shifts.map((s) => {
      const sum = map[s.id];
      return {
        ...s,
        cash_total: sum?.cash_total ?? sum?.payment_breakdown?.cash?.amount ?? 0,
        non_cash_total: sum?.non_cash_total ?? 0,
        grand_payment_total:
          sum?.grand_payment_total ?? sum?.total_sales ?? Number(s.total_sales || 0),
      } as ShiftRowWithBreakdown;
    });
  }, [shifts, summariesQuery.data]);

  const allShiftsTotals = useMemo(
    () => computeAllShiftsTotals(enrichedShifts),
    [enrichedShifts],
  );

  /* ─── Payment-channels query (Report 3) ─── */
  const channelsQuery = useQuery({
    queryKey: ['report-payment-channels', { from, to }],
    enabled: tab === 'channels',
    queryFn: () => dashboardApi.paymentChannels(from, to),
  });

  /* ─── Single-shift query (Report 1) ─── */
  const singleSummaryQuery = useQuery({
    queryKey: ['report-single-summary', selectedShiftId],
    enabled: tab === 'single' && !!selectedShiftId,
    queryFn: () => shiftsApi.summary(selectedShiftId),
  });
  const singleAdjustmentsQuery = useQuery({
    queryKey: ['report-single-adjustments', selectedShiftId],
    enabled: tab === 'single' && !!selectedShiftId,
    queryFn: () => shiftsApi.listAdjustments(selectedShiftId),
  });
  const selectedShift = useMemo(
    () => shifts.find((s) => s.id === selectedShiftId) || null,
    [shifts, selectedShiftId],
  );

  /* ─── Print + Export handlers ─── */
  const rangeLabel = presetLabel(preset, from, to);

  const handlePrintAll = () => {
    if (enrichedShifts.length === 0) {
      toast.error('لا توجد ورديات للطباعة');
      return;
    }
    const html = buildAllShiftsReportHtml({
      rows: enrichedShifts,
      from,
      to,
      rangeLabel,
      generatedByName,
    });
    printReport(`تقرير الورديات — ${rangeLabel}`, html);
  };

  const handleExportAll = () => {
    if (enrichedShifts.length === 0) {
      toast.error('لا توجد ورديات للتصدير');
      return;
    }
    const sheets = buildAllShiftsReportSheets({
      rows: enrichedShifts,
      from,
      to,
    });
    exportMultiSheet(`shifts-report-${from}_${to}`, sheets);
  };

  const handlePrintChannels = () => {
    if (!channelsQuery.data) return;
    const html = buildPaymentChannelsReportHtml({
      data: channelsQuery.data,
      rangeLabel,
      generatedByName,
    });
    printReport(`تقرير وسائل الدفع — ${rangeLabel}`, html);
  };

  const handleExportChannels = () => {
    if (!channelsQuery.data) return;
    const sheets = buildPaymentChannelsReportSheets({ data: channelsQuery.data });
    exportMultiSheet(`payment-channels-${from}_${to}`, sheets);
  };

  const handlePrintSingle = () => {
    if (!selectedShift || !singleSummaryQuery.data) return;
    const html = buildShiftReportHtml({
      shift: selectedShift,
      summary: singleSummaryQuery.data,
      adjustments: singleAdjustmentsQuery.data ?? [],
      generatedByName,
    });
    printReport(
      `تقرير وردية ${selectedShift.shift_no}`,
      html,
    );
  };

  const handleExportSingle = () => {
    if (!selectedShift || !singleSummaryQuery.data) return;
    const sheets = buildShiftReportSheets({
      shift: selectedShift,
      summary: singleSummaryQuery.data,
      adjustments: singleAdjustmentsQuery.data ?? [],
      generatedByName,
    });
    exportMultiSheet(
      `shift-${selectedShift.shift_no}-${cairoIso(new Date())}`,
      sheets,
    );
  };

  /* ─── Render ─── */
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <ClipboardList className="text-brand-600" /> تقارير الورديات
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            تقارير قابلة للطباعة والتصدير: وردية محددة، الورديات خلال الفترة،
            والتحصيلات حسب وسيلة الدفع
          </p>
        </div>
        <button
          className="btn-secondary flex items-center gap-2"
          onClick={() => {
            shiftsQuery.refetch();
            summariesQuery.refetch();
            channelsQuery.refetch();
          }}
        >
          <RefreshCw size={16} /> تحديث
        </button>
      </div>

      {/* ── Filter bar ── */}
      <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
        <div className="flex flex-wrap gap-2">
          {(['today', 'week', 'month', 'custom'] as Preset[]).map((p) => (
            <button
              key={p}
              onClick={() => setPresetAndRange(p)}
              className={`chip ${
                preset === p
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-100 text-slate-700'
              }`}
            >
              {p === 'today' && 'اليوم'}
              {p === 'week' && 'هذا الأسبوع'}
              {p === 'month' && 'هذا الشهر'}
              {p === 'custom' && 'مخصص'}
            </button>
          ))}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-5 gap-3">
          <label className="text-sm">
            <span className="block text-slate-600 mb-1">من</span>
            <input
              type="date"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setPreset('custom');
              }}
              className="input w-full"
            />
          </label>
          <label className="text-sm">
            <span className="block text-slate-600 mb-1">إلى</span>
            <input
              type="date"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setPreset('custom');
              }}
              className="input w-full"
            />
          </label>
          <label className="text-sm">
            <span className="block text-slate-600 mb-1">الحالة</span>
            <select
              value={statusFilter}
              onChange={(e) =>
                setStatusFilter(e.target.value as StatusFilter)
              }
              className="input w-full"
            >
              <option value="all">الكل</option>
              <option value="open">مفتوحة</option>
              <option value="pending_close">بانتظار الاعتماد</option>
              <option value="closed">مغلقة</option>
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-slate-600 mb-1">الخزنة</span>
            <select
              value={cashboxId}
              onChange={(e) => setCashboxId(e.target.value)}
              className="input w-full"
            >
              <option value="">جميع الخزن</option>
              {cashboxes.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name_ar || c.name}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm">
            <span className="block text-slate-600 mb-1">الكاشير</span>
            <select
              value={cashierId}
              onChange={(e) => setCashierId(e.target.value)}
              className="input w-full"
            >
              <option value="">جميع الكاشيرز</option>
              {cashiers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name || u.username}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {/* ── Tabs ── */}
      <div className="flex gap-2 flex-wrap">
        <button
          onClick={() => setTab('all')}
          className={`px-4 py-2 rounded-lg flex items-center gap-2 ${
            tab === 'all' ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200'
          }`}
        >
          <Layers size={16} /> تقرير الفترة
        </button>
        <button
          onClick={() => setTab('single')}
          className={`px-4 py-2 rounded-lg flex items-center gap-2 ${
            tab === 'single' ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200'
          }`}
        >
          <FileText size={16} /> تقرير وردية محددة
        </button>
        <button
          onClick={() => setTab('channels')}
          className={`px-4 py-2 rounded-lg flex items-center gap-2 ${
            tab === 'channels' ? 'bg-brand-600 text-white' : 'bg-white border border-slate-200'
          }`}
        >
          <Wallet size={16} /> تقرير وسائل الدفع
        </button>
      </div>

      {/* ── Report panels ── */}
      {tab === 'all' && (
        <AllShiftsPanel
          shifts={enrichedShifts}
          loading={shiftsQuery.isLoading || summariesQuery.isFetching}
          rangeLabel={rangeLabel}
          totals={allShiftsTotals}
          onPrint={handlePrintAll}
          onExport={handleExportAll}
        />
      )}

      {tab === 'single' && (
        <SingleShiftPanel
          shifts={shifts}
          selectedShiftId={selectedShiftId}
          onSelect={setSelectedShiftId}
          summary={singleSummaryQuery.data}
          loading={singleSummaryQuery.isFetching}
          onPrint={handlePrintSingle}
          onExport={handleExportSingle}
        />
      )}

      {tab === 'channels' && (
        <>
          {(cashboxId || cashierId || statusFilter !== 'all') && (
            <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-800 flex items-start gap-2">
              <Info size={16} className="mt-0.5 flex-shrink-0" />
              <div>
                <strong>تنبيه:</strong> تقرير وسائل الدفع مفلتَر بالفترة فقط
                حالياً. الفلاتر الأخرى (الخزنة / الكاشير / حالة الوردية)
                <strong> لا تُطبَّق </strong>
                على هذا التقرير في هذه النسخة، لأن نقطة الـ API الحالية
                <code className="mx-1">/dashboard/payment-channels</code>
                تستقبل التواريخ فقط. سيُضاف الدعم في PR-REPORTS-2.
              </div>
            </div>
          )}
          <ChannelsPanel
            data={channelsQuery.data}
            loading={channelsQuery.isFetching}
            rangeLabel={rangeLabel}
            onPrint={handlePrintChannels}
            onExport={handleExportChannels}
          />
        </>
      )}
    </div>
  );
}

/* ─── All-shifts preview panel ─── */

function AllShiftsPanel(props: {
  shifts: ShiftRowWithBreakdown[];
  loading: boolean;
  rangeLabel: string;
  totals: ReturnType<typeof computeAllShiftsTotals>;
  onPrint: () => void;
  onExport: () => void;
}) {
  const { shifts, loading, rangeLabel, totals, onPrint, onExport } = props;
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm text-slate-600 flex items-center gap-2">
          <CalendarDays size={16} /> {rangeLabel} · عدد الورديات: {shifts.length}
        </div>
        <div className="flex gap-2">
          <button
            className="btn-secondary flex items-center gap-2"
            onClick={onPrint}
            disabled={loading || shifts.length === 0}
          >
            <Printer size={16} /> طباعة
          </button>
          <button
            className="btn-primary flex items-center gap-2"
            onClick={onExport}
            disabled={loading || shifts.length === 0}
          >
            <Download size={16} /> Excel
          </button>
        </div>
      </div>

      {loading && shifts.length === 0 && (
        <div className="text-center text-slate-500 py-8">جارٍ التحميل…</div>
      )}

      {!loading && shifts.length === 0 && (
        <div className="text-center text-slate-500 py-8">
          لا توجد ورديات داخل الفترة المحددة.
        </div>
      )}

      {shifts.length > 0 && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
            <SummaryCard label="إجمالي المبيعات" value={EGP(totals.sales_total)} />
            <SummaryCard label="إجمالي التحصيلات" value={EGP(totals.grand_payment_total)} />
            <SummaryCard label="إجمالي الكاش" value={EGP(totals.cash_total)} />
            <SummaryCard label="إجمالي غير نقدي" value={EGP(totals.non_cash_total)} />
            <SummaryCard label="إجمالي الفواتير" value={String(totals.invoice_count)} />
            <SummaryCard label="إجمالي المصروفات" value={EGP(totals.expenses_total)} />
            <SummaryCard
              label="إجمالي الفروقات"
              value={EGP(totals.variance_total)}
              tone={
                Math.abs(totals.variance_total) < 0.01
                  ? 'green'
                  : totals.variance_total < 0
                    ? 'red'
                    : 'green'
              }
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="p-2 text-right">الرقم</th>
                  <th className="p-2 text-right">التاريخ</th>
                  <th className="p-2 text-right">الكاشير</th>
                  <th className="p-2 text-right">الخزنة</th>
                  <th className="p-2 text-right">الحالة</th>
                  <th className="p-2 text-right">كاش</th>
                  <th className="p-2 text-right">غير نقدي</th>
                  <th className="p-2 text-right">المبيعات</th>
                  <th className="p-2 text-right">المصروفات</th>
                  <th className="p-2 text-right">الفرق</th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((s) => (
                  <tr key={s.id} className="border-t border-slate-100">
                    <td className="p-2">{s.shift_no}</td>
                    <td className="p-2">
                      {new Date(s.opened_at).toLocaleDateString('en-GB', {
                        timeZone: 'Africa/Cairo',
                      })}
                    </td>
                    <td className="p-2">{s.opened_by_name || '—'}</td>
                    <td className="p-2">{s.cashbox_name || '—'}</td>
                    <td className="p-2">
                      {s.status === 'open' && 'مفتوحة'}
                      {s.status === 'closed' && 'مغلقة'}
                      {s.status === 'pending_close' && 'بانتظار الاعتماد'}
                    </td>
                    <td className="p-2">{EGP(s.cash_total ?? 0)}</td>
                    <td className="p-2">{EGP(s.non_cash_total ?? 0)}</td>
                    <td className="p-2">{EGP(s.total_sales)}</td>
                    <td className="p-2">{EGP(s.total_expenses)}</td>
                    <td className="p-2">{EGP(Number(s.variance ?? 0))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/* ─── Single-shift preview panel ─── */

function SingleShiftPanel(props: {
  shifts: Shift[];
  selectedShiftId: string;
  onSelect: (id: string) => void;
  summary: any;
  loading: boolean;
  onPrint: () => void;
  onExport: () => void;
}) {
  const { shifts, selectedShiftId, onSelect, summary, loading, onPrint, onExport } = props;
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <label className="text-sm flex-1 min-w-[260px]">
          <span className="block text-slate-600 mb-1">اختر الوردية</span>
          <select
            value={selectedShiftId}
            onChange={(e) => onSelect(e.target.value)}
            className="input w-full"
          >
            <option value="">— اختر وردية —</option>
            {shifts.map((s) => (
              <option key={s.id} value={s.id}>
                {s.shift_no} · {s.opened_by_name || '—'} ·{' '}
                {new Date(s.opened_at).toLocaleDateString('en-GB', {
                  timeZone: 'Africa/Cairo',
                })}
              </option>
            ))}
          </select>
        </label>
        <div className="flex gap-2 mt-5">
          <button
            className="btn-secondary flex items-center gap-2"
            onClick={onPrint}
            disabled={loading || !summary}
          >
            <Printer size={16} /> طباعة
          </button>
          <button
            className="btn-primary flex items-center gap-2"
            onClick={onExport}
            disabled={loading || !summary}
          >
            <Download size={16} /> Excel
          </button>
        </div>
      </div>

      {!selectedShiftId && (
        <div className="text-center text-slate-500 py-6">
          اختر وردية من الفترة الحالية لعرض ملخصها وطباعة تقريرها.
        </div>
      )}

      {selectedShiftId && loading && (
        <div className="text-center text-slate-500 py-6">جارٍ تحميل ملخص الوردية…</div>
      )}

      {summary && !loading && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <SummaryCard label="رقم الوردية" value={summary.shift_no} />
          <SummaryCard label="إجمالي المبيعات" value={EGP(summary.total_sales)} />
          <SummaryCard label="عدد الفواتير" value={String(summary.invoice_count)} />
          <SummaryCard
            label="كاش في الدرج (متوقع)"
            value={EGP(summary.expected_closing)}
          />
          <SummaryCard
            label="كاش (نقدي)"
            value={EGP(summary.payment_breakdown?.cash?.amount || 0)}
          />
          <SummaryCard
            label="غير نقدي"
            value={EGP(summary.non_cash_total || 0)}
          />
          <SummaryCard label="المصروفات" value={EGP(summary.total_expenses)} />
          <SummaryCard
            label="الفرق"
            value={EGP(Number(summary.variance ?? 0))}
            tone={
              Math.abs(Number(summary.variance ?? 0)) < 0.01
                ? 'green'
                : Number(summary.variance ?? 0) < 0
                  ? 'red'
                  : 'green'
            }
          />
        </div>
      )}
    </div>
  );
}

/* ─── Payment channels panel ─── */

function ChannelsPanel(props: {
  data: any;
  loading: boolean;
  rangeLabel: string;
  onPrint: () => void;
  onExport: () => void;
}) {
  const { data, loading, rangeLabel, onPrint, onExport } = props;
  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm text-slate-600 flex items-center gap-2 flex-wrap">
          <CalendarDays size={16} /> {rangeLabel}
          <span className="text-xs text-slate-500">
            · مفلتَر بالفترة فقط (راجع PR-REPORTS-2 لإضافة فلاتر الخزنة/الكاشير)
          </span>
        </div>
        <div className="flex gap-2">
          <button
            className="btn-secondary flex items-center gap-2"
            onClick={onPrint}
            disabled={loading || !data}
          >
            <Printer size={16} /> طباعة
          </button>
          <button
            className="btn-primary flex items-center gap-2"
            onClick={onExport}
            disabled={loading || !data}
          >
            <Download size={16} /> Excel
          </button>
        </div>
      </div>

      {loading && (
        <div className="text-center text-slate-500 py-6">جارٍ التحميل…</div>
      )}

      {!loading && data && data.channels.length === 0 && (
        <div className="text-center text-slate-500 py-6">
          لا توجد تحصيلات داخل الفترة المحددة.
        </div>
      )}

      {!loading && data && data.channels.length > 0 && (
        <>
          <div className="grid grid-cols-3 gap-3 text-sm">
            <SummaryCard label="إجمالي الكاش" value={EGP(data.cash_total)} />
            <SummaryCard label="إجمالي غير نقدي" value={EGP(data.non_cash_total)} />
            <SummaryCard label="الإجمالي الكلي" value={EGP(data.grand_total)} tone="green" />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="p-2 text-right">الوسيلة</th>
                  <th className="p-2 text-right">المبلغ</th>
                  <th className="p-2 text-right">عدد الفواتير</th>
                  <th className="p-2 text-right">عدد الدفعات</th>
                  <th className="p-2 text-right">النسبة</th>
                </tr>
              </thead>
              <tbody>
                {data.channels.map((m: any) => (
                  <tr key={m.method} className="border-t border-slate-100">
                    <td className="p-2 font-bold">{m.method_label_ar || m.method}</td>
                    <td className="p-2">{EGP(m.total_amount)}</td>
                    <td className="p-2">{m.invoice_count}</td>
                    <td className="p-2">{m.payment_count}</td>
                    <td className="p-2">{m.share_pct.toFixed(2)}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="p-2 text-right">الوسيلة</th>
                  <th className="p-2 text-right">الحساب</th>
                  <th className="p-2 text-right">المعرّف</th>
                  <th className="p-2 text-right">المبلغ</th>
                  <th className="p-2 text-right">النسبة</th>
                </tr>
              </thead>
              <tbody>
                {data.channels.flatMap((m: any) =>
                  m.accounts.map((a: any) => (
                    <tr
                      key={`${m.method}-${a.payment_account_id ?? 'null'}`}
                      className="border-t border-slate-100"
                    >
                      <td className="p-2">{m.method_label_ar || m.method}</td>
                      <td className="p-2">
                        {a.display_name || m.method_label_ar || m.method}
                      </td>
                      <td className="p-2">{a.identifier || '—'}</td>
                      <td className="p-2">{EGP(a.total_amount)}</td>
                      <td className="p-2">{a.share_pct.toFixed(2)}%</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

/* ─── Tiny presentational helper ─── */

function SummaryCard(props: {
  label: string;
  value: string;
  tone?: 'green' | 'red';
}) {
  const toneClass =
    props.tone === 'green'
      ? 'text-emerald-700'
      : props.tone === 'red'
        ? 'text-rose-700'
        : 'text-slate-800';
  return (
    <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg">
      <div className="text-slate-500 text-xs">{props.label}</div>
      <div className={`text-base font-bold ${toneClass}`}>{props.value}</div>
    </div>
  );
}
