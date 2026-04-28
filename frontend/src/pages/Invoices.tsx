import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Receipt as ReceiptIcon,
  Printer,
  Search,
  X,
  Ban,
  FileText,
  DollarSign,
  Activity,
  Undo2,
  Pencil,
  Plus,
  Minus,
  Trash2,
  History,
} from 'lucide-react';
import { posApi } from '@/api/pos.api';
import { paymentsApi, type PaymentMethodCode } from '@/api/payments.api';
// PR-POS-PAY-2 — split-payment helpers + shared editor.
//   Pure helpers stay in lib (DOM-free, fully unit-tested).
//   Shared editor is the same component the POS PaymentModal uses,
//   so the edit modal renders an identical multi-row UI without
//   forking the implementation.
import {
  type SplitPaymentRow,
  validateSplitPayments,
  rowsToPaymentDrafts,
  makeRowUid,
} from '@/lib/posSplitPayment';
import { SplitPaymentsEditor } from '@/components/pos/SplitPaymentsEditor';
import { usersApi } from '@/api/users.api';
import { productsApi, Product, Variant } from '@/api/products.api';
import { Receipt, ReceiptData } from '@/components/Receipt';
import { InvoiceHoverCard } from '@/components/InvoiceHoverCard';
import { useAuthStore } from '@/stores/auth.store';
import { printInvoiceThermal } from '@/lib/printInvoiceThermal';
import { useTableSort } from '@/lib/useTableSort';
import {
  PeriodSelector,
  resolvePeriod,
  type PeriodRange,
} from '@/components/common/PeriodSelector';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const NUM = (n: number) => Number(n || 0).toLocaleString('en-US');

function fmtDateTime(iso?: string) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const day = d.toLocaleDateString('ar-EG-u-ca-gregory', { weekday: 'short' });
    const date = d.toLocaleDateString('en-GB');
    const time = d.toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${day} ${date} · ${time}`;
  } catch {
    return iso;
  }
}

type Status = 'all' | 'paid' | 'completed' | 'partially_paid' | 'cancelled' | 'draft';

const STATUS_LABELS: Record<string, string> = {
  paid: 'مدفوعة',
  completed: 'مكتملة',
  partially_paid: 'جزئية',
  cancelled: 'ملغاة',
  draft: 'مسودة',
  refunded: 'مسترَدة',
};

const STATUS_STYLE: Record<string, string> = {
  paid: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  completed: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  partially_paid: 'bg-amber-100 text-amber-700 border-amber-200',
  cancelled: 'bg-rose-100 text-rose-700 border-rose-200',
  draft: 'bg-slate-100 text-slate-600 border-slate-200',
  refunded: 'bg-purple-100 text-purple-700 border-purple-200',
};

export default function Invoices() {
  const user = useAuthStore((s) => s.user);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  // Permissions are authoritative. Role fallbacks used to leak edit /
  // void buttons to managers who hadn't been granted the permission;
  // hasPermission('*') handles system admins via the wildcard.
  const canVoid = hasPermission('invoices.void');
  // Users with invoices.edit apply changes directly; users with
  // invoices.edit_request submit a pending request for approval.
  // Either permission reveals the edit button.
  const canEdit =
    hasPermission('invoices.edit') || hasPermission('invoices.edit_request');

  const [period, setPeriod] = useState<PeriodRange>(() =>
    resolvePeriod('day'),
  );
  const [q, setQ] = useState('');
  const from = period.from;
  const to = period.to;
  const setFrom = (v: string) =>
    setPeriod({ ...period, key: 'custom', from: v, label: 'مخصص' });
  const setTo = (v: string) =>
    setPeriod({ ...period, key: 'custom', to: v, label: 'مخصص' });
  const [status, setStatus] = useState<Status>('all');
  const [cashierId, setCashierId] = useState<string>('');
  const [amountMin, setAmountMin] = useState('');
  const [amountMax, setAmountMax] = useState('');
  const [preview, setPreview] = useState<
    { id: string; tab: 'receipt' | 'history' } | null
  >(null);
  const [voidTarget, setVoidTarget] = useState<any | null>(null);
  const [editTarget, setEditTarget] = useState<any | null>(null);

  const { data: invoices = [], isLoading } = useQuery({
    queryKey: ['invoices', { q, from, to, status, cashierId }],
    queryFn: () =>
      posApi.list({
        q: q || undefined,
        from: from || undefined,
        to: to || undefined,
        status: status === 'all' ? undefined : status,
        cashier_id: cashierId || undefined,
        limit: 500,
      }),
  });

  const { data: users = [] } = useQuery({
    queryKey: ['users-list'],
    queryFn: () => usersApi.list(),
    staleTime: 5 * 60_000,
  });

  // Amount range is applied client-side (server filters q/date/status).
  const filtered = useMemo(() => {
    const min = amountMin ? Number(amountMin) : null;
    const max = amountMax ? Number(amountMax) : null;
    return (invoices as any[]).filter((i) => {
      const g = Number(i.grand_total || 0);
      if (min != null && g < min) return false;
      if (max != null && g > max) return false;
      return true;
    });
  }, [invoices, amountMin, amountMax]);

  const { sorted: sortedInvoices, thProps, sortIcon } = useTableSort(
    filtered,
    'created_at',
    'desc',
  );

  const totals = useMemo(() => {
    let count = 0;
    let grand = 0;
    let profit = 0;
    let cancelledCount = 0;
    for (const i of filtered) {
      if (i.status === 'cancelled') {
        cancelledCount++;
        continue;
      }
      count++;
      grand += Number(i.grand_total || 0);
      profit += Number(i.gross_profit || 0);
    }
    return { count, grand, profit, cancelledCount, total: filtered.length };
  }, [filtered]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg">
            <ReceiptIcon size={22} className="text-white" />
          </div>
          <div>
            <h2 className="text-2xl font-black text-slate-800">
              فواتير المبيعات
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              عرض وإعادة طباعة وإلغاء الفواتير
            </p>
          </div>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <KpiCard
          icon={FileText}
          label="عدد الفواتير"
          value={NUM(totals.count)}
          hint={`${NUM(totals.total)} إجمالي`}
          tone="indigo"
        />
        <KpiCard
          icon={DollarSign}
          label="إجمالي المبيعات"
          value={EGP(totals.grand)}
          tone="emerald"
        />
        <KpiCard
          icon={Activity}
          label={totals.profit < 0 ? 'الخسارة' : 'الربح'}
          value={EGP(Math.abs(totals.profit))}
          tone={totals.profit < 0 ? 'rose' : 'pink'}
        />
        <KpiCard
          icon={Ban}
          label="فواتير ملغاة"
          value={NUM(totals.cancelledCount)}
          tone="rose"
        />
      </div>

      {/* Period selector */}
      <div className="card p-3 flex items-center justify-between flex-wrap gap-3">
        <div className="text-sm font-bold text-slate-700">الفترة:</div>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      {/* Filters */}
      <div className="card p-4 grid grid-cols-1 md:grid-cols-6 gap-3">
        <div className="relative md:col-span-2">
          <Search
            size={16}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            className="input pr-9"
            placeholder="بحث برقم الفاتورة / اسم العميل / الهاتف..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-slate-500 block mb-1">الكاشير</label>
          <select
            className="input"
            value={cashierId}
            onChange={(e) => setCashierId(e.target.value)}
          >
            <option value="">الكل</option>
            {users.map((u: any) => (
              <option key={u.id} value={u.id}>
                {u.full_name || u.username}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-slate-500 block mb-1">
            المبلغ من (ج.م)
          </label>
          <input
            type="number"
            className="input"
            value={amountMin}
            onChange={(e) => setAmountMin(e.target.value)}
            placeholder="0"
          />
        </div>
        <div>
          <label className="text-xs text-slate-500 block mb-1">
            المبلغ إلى (ج.م)
          </label>
          <input
            type="number"
            className="input"
            value={amountMax}
            onChange={(e) => setAmountMax(e.target.value)}
            placeholder="∞"
          />
        </div>
        <div className="flex items-end">
          <button
            onClick={() => {
              setQ('');
              setCashierId('');
              setAmountMin('');
              setAmountMax('');
              setStatus('all');
              setPeriod(resolvePeriod('day'));
            }}
            className="btn-ghost w-full"
            title="مسح الفلاتر"
          >
            مسح
          </button>
        </div>
      </div>

      {/* Status tabs */}
      <div className="flex flex-wrap gap-2">
        {(
          [
            { k: 'all', label: 'الكل' },
            { k: 'paid', label: 'مدفوعة' },
            { k: 'partially_paid', label: 'جزئية' },
            { k: 'cancelled', label: 'ملغاة' },
            { k: 'draft', label: 'مسودة' },
          ] as const
        ).map((s) => (
          <button
            key={s.k}
            onClick={() => setStatus(s.k as Status)}
            className={`px-3 py-1.5 rounded-lg text-sm font-bold transition ${
              status === s.k
                ? 'bg-brand-600 text-white shadow'
                : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
            }`}
          >
            {s.label}
          </button>
        ))}
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr className="text-xs text-slate-500 font-bold">
              <th {...thProps('invoice_no')} className={`text-right p-3 ${thProps('invoice_no').className}`}>
                {sortIcon('invoice_no')} رقم الفاتورة
              </th>
              <th {...thProps('created_at')} className={`text-right p-3 ${thProps('created_at').className}`}>
                {sortIcon('created_at')} التاريخ والوقت
              </th>
              <th {...thProps('customer_name')} className={`text-right p-3 ${thProps('customer_name').className}`}>
                {sortIcon('customer_name')} العميل
              </th>
              <th {...thProps('cashier_name')} className={`text-right p-3 ${thProps('cashier_name').className}`}>
                {sortIcon('cashier_name')} الكاشير
              </th>
              <th {...thProps('grand_total')} className={`text-left p-3 ${thProps('grand_total').className}`}>
                {sortIcon('grand_total')} الإجمالي
              </th>
              <th {...thProps('gross_profit')} className={`text-left p-3 ${thProps('gross_profit').className}`}>
                {sortIcon('gross_profit')} الربح / الخسارة
              </th>
              <th {...thProps('status')} className={`text-center p-3 ${thProps('status').className}`}>
                {sortIcon('status')} الحالة
              </th>
              <th className="text-center p-3">إجراءات</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td
                  colSpan={8}
                  className="text-center py-12 text-slate-400 text-sm"
                >
                  جاري التحميل...
                </td>
              </tr>
            )}
            {!isLoading &&
              sortedInvoices.map((i: any) => (
                <tr
                  key={i.id}
                  className={`border-b border-slate-100 ${
                    i.status === 'cancelled'
                      ? 'bg-rose-50/30 opacity-75'
                      : 'hover:bg-slate-50'
                  }`}
                >
                  <td className="p-3 font-mono text-sm font-bold text-brand-700 min-w-[240px]">
                    <div className="flex items-center gap-1.5">
                      <InvoiceHoverCard
                        invoiceId={i.id}
                        label={i.invoice_no || i.doc_no}
                        className="font-mono font-bold text-brand-700 hover:text-brand-900 hover:underline cursor-pointer"
                      />
                      {Number(i.edit_count || 0) > 0 && (
                        <span
                          className="chip bg-amber-100 text-amber-700 border-amber-200 text-[10px] font-bold"
                          title={`تم تعديلها ${i.edit_count} مرة — آخر تعديل ${fmtDateTime(
                            i.last_edited_at || i.updated_at,
                          )}`}
                        >
                          <Pencil size={10} />
                          {Number(i.edit_count)}
                        </span>
                      )}
                      {Number(i.pending_edit_requests || 0) > 0 && (
                        <span
                          className="chip bg-amber-50 text-amber-700 border-amber-300 text-[10px] font-bold"
                          title={`${i.pending_edit_requests} طلب تعديل ينتظر الموافقة`}
                        >
                          ⏳ {Number(i.pending_edit_requests)}
                        </span>
                      )}
                    </div>
                    {Array.isArray(i.items_summary) &&
                      i.items_summary.length > 0 && (
                        <ItemsSummary items={i.items_summary} />
                      )}
                  </td>
                  <td className="p-3 text-xs text-slate-600">
                    {fmtDateTime(i.completed_at || i.created_at)}
                  </td>
                  <td className="p-3 text-sm text-slate-700">
                    <div>
                      {i.customer_name || (
                        <span className="text-slate-400">عميل عابر</span>
                      )}
                    </div>
                    {i.customer_phone && (
                      <div
                        className="text-[10px] text-slate-400 font-mono"
                        dir="ltr"
                      >
                        {i.customer_phone}
                      </div>
                    )}
                  </td>
                  <td className="p-3 text-xs text-slate-600">
                    {i.cashier_name || '—'}
                  </td>
                  <td className="p-3 text-left font-bold text-slate-800 tabular-nums">
                    {EGP(i.grand_total)}
                  </td>
                  <td
                    className={`p-3 text-left text-sm tabular-nums ${
                      Number(i.gross_profit) < 0
                        ? 'text-rose-600'
                        : 'text-emerald-700'
                    }`}
                  >
                    {EGP(i.gross_profit || 0)}
                  </td>
                  <td className="p-3 text-center">
                    <span
                      className={`chip border font-bold text-[11px] ${
                        STATUS_STYLE[i.status] ||
                        'bg-slate-100 text-slate-500 border-slate-200'
                      }`}
                    >
                      {STATUS_LABELS[i.status] || i.status}
                    </span>
                  </td>
                  <td className="p-3 text-center">
                    <div className="flex items-center justify-center gap-1">
                      <button
                        className="p-1.5 rounded hover:bg-brand-50 text-slate-500 hover:text-brand-600"
                        onClick={() => setPreview({ id: i.id, tab: 'receipt' })}
                        title="عرض الإيصال والطباعة"
                      >
                        <ReceiptIcon size={14} />
                      </button>
                      {(Number(i.edit_count || 0) > 0 ||
                        Number(i.pending_edit_requests || 0) > 0) && (
                        <button
                          className="relative p-1.5 rounded hover:bg-indigo-50 text-slate-500 hover:text-indigo-600"
                          onClick={() =>
                            setPreview({ id: i.id, tab: 'history' })
                          }
                          title="سجل التعديلات"
                        >
                          <History size={14} />
                          {Number(i.pending_edit_requests || 0) > 0 && (
                            <span className="absolute -top-1 -right-1 min-w-[14px] h-[14px] rounded-full bg-amber-500 text-white text-[9px] font-bold flex items-center justify-center px-0.5">
                              {Number(i.pending_edit_requests)}
                            </span>
                          )}
                        </button>
                      )}
                      {canEdit && i.status !== 'cancelled' && (
                        <button
                          className="p-1.5 rounded hover:bg-amber-50 text-slate-500 hover:text-amber-600"
                          onClick={() => setEditTarget(i)}
                          title="تعديل الفاتورة"
                        >
                          <Pencil size={14} />
                        </button>
                      )}
                      {canVoid && i.status !== 'cancelled' && (
                        <button
                          className="p-1.5 rounded hover:bg-rose-50 text-slate-500 hover:text-rose-600"
                          onClick={() => setVoidTarget(i)}
                          title="إلغاء الفاتورة (admin)"
                        >
                          <Undo2 size={14} />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            {!isLoading && !sortedInvoices.length && (
              <tr>
                <td
                  colSpan={8}
                  className="text-center py-12 text-slate-400 text-sm"
                >
                  لا توجد فواتير في هذه الفترة
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {preview && (
        <ReceiptPreviewModal
          invoiceId={preview.id}
          initialTab={preview.tab}
          onClose={() => setPreview(null)}
        />
      )}

      {voidTarget && (
        <VoidConfirmModal
          invoice={voidTarget}
          onClose={() => setVoidTarget(null)}
        />
      )}

      {editTarget && (
        <InvoiceEditModal
          invoiceId={editTarget.id}
          onClose={() => setEditTarget(null)}
        />
      )}
    </div>
  );
}

/* ───────── KPI card ───────── */

function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: any;
  label: string;
  value: string;
  hint?: string;
  tone: 'indigo' | 'emerald' | 'pink' | 'rose';
}) {
  const bg = {
    indigo: 'from-indigo-500 to-blue-600 shadow-indigo-500/30',
    emerald: 'from-emerald-500 to-teal-600 shadow-emerald-500/30',
    pink: 'from-pink-500 to-rose-600 shadow-pink-500/30',
    rose: 'from-rose-500 to-red-600 shadow-rose-500/30',
  }[tone];
  return (
    <div className="card p-4">
      <div className="flex items-center justify-between mb-2">
        <div
          className={`w-9 h-9 rounded-lg bg-gradient-to-br ${bg} flex items-center justify-center shadow-md`}
        >
          <Icon size={16} className="text-white" />
        </div>
        <div className="text-xs text-slate-500 text-left">{label}</div>
      </div>
      <div className="text-xl font-black text-slate-800">{value}</div>
      {hint && <div className="text-[10px] text-slate-400 mt-0.5">{hint}</div>}
    </div>
  );
}

/* ───────── Receipt preview modal ───────── */

function ReceiptPreviewModal({
  invoiceId,
  onClose,
  initialTab = 'receipt',
}: {
  invoiceId: string;
  onClose: () => void;
  initialTab?: 'receipt' | 'history';
}) {
  const [tab, setTab] = useState<'receipt' | 'history'>(initialTab);
  const { data, isLoading } = useQuery({
    queryKey: ['receipt', invoiceId],
    queryFn: () => posApi.receipt(invoiceId),
  });
  const { data: history = [] } = useQuery({
    queryKey: ['invoice-edit-history', invoiceId],
    queryFn: () => posApi.editHistory(invoiceId),
    enabled: tab === 'history',
  });
  const { data: requests = [] } = useQuery({
    queryKey: ['invoice-edit-requests', invoiceId],
    queryFn: () => posApi.editRequests(invoiceId),
    enabled: tab === 'history',
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 print:bg-transparent print:p-0">
      <div
        className={`bg-white rounded-2xl w-full max-h-[90vh] overflow-hidden flex flex-col print:rounded-none print:max-w-none print:w-auto print:max-h-none ${
          tab === 'history' ? 'max-w-3xl' : 'max-w-md'
        }`}
      >
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between print:hidden">
          <div className="inline-flex rounded-lg bg-slate-100 p-1 text-xs">
            <button
              className={`px-3 py-1.5 rounded-md font-bold transition ${
                tab === 'receipt'
                  ? 'bg-white text-indigo-700 shadow-sm'
                  : 'text-slate-600'
              }`}
              onClick={() => setTab('receipt')}
            >
              معاينة الإيصال
            </button>
            <button
              className={`px-3 py-1.5 rounded-md font-bold transition ${
                tab === 'history'
                  ? 'bg-white text-indigo-700 shadow-sm'
                  : 'text-slate-600'
              }`}
              onClick={() => setTab('history')}
            >
              سجل التعديلات
            </button>
          </div>
          <div className="flex gap-2">
            {tab === 'receipt' && (
              <>
                <button
                  className="btn-primary text-xs bg-emerald-600 hover:bg-emerald-700"
                  onClick={() => {
                    printInvoiceThermal(invoiceId).catch((err) =>
                      toast.error(
                        err?.response?.data?.message || 'فشل الطباعة الحرارية',
                      ),
                    );
                  }}
                  disabled={isLoading}
                  title="طباعة حرارية 80mm"
                >
                  🧾 طباعة حرارية
                </button>
                <button
                  className="btn-ghost text-xs border border-slate-300"
                  onClick={() => window.print()}
                  disabled={isLoading}
                  title="طباعة بحجم A4"
                >
                  <Printer size={14} /> طباعة A4
                </button>
              </>
            )}
            <button className="btn-ghost text-xs" onClick={onClose}>
              <X size={14} />
            </button>
          </div>
        </div>
        {tab === 'receipt' ? (
          <div className="overflow-y-auto print:overflow-visible">
            {isLoading && (
              <div className="p-12 text-center text-slate-400 print:hidden">
                جارٍ التحميل...
              </div>
            )}
            {data && <Receipt data={data as ReceiptData} />}
          </div>
        ) : (
          <EditHistoryTab
            invoiceId={invoiceId}
            history={history}
            requests={requests}
          />
        )}
      </div>
    </div>
  );
}

/* ───────── Edit history tab ───────── */

function fmtWhen(s: string) {
  if (!s) return '';
  const d = new Date(s);
  const dow = d.toLocaleDateString('ar-EG', {
    timeZone: 'Africa/Cairo',
    weekday: 'long',
  });
  const rest = d.toLocaleString('ar-EG', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  return `${dow} · ${rest}`;
}

function lineSummary(items: any[] | undefined | null): string {
  if (!items || !items.length) return 'لا بنود';
  return items
    .map((it) => {
      const name = it.product_name_snapshot || it.product_name || '—';
      return `${name} × ${it.quantity || 0}`;
    })
    .join(' · ');
}

type LineLike = {
  variant_id: string;
  product_name_snapshot?: string;
  product_name?: string;
  sku?: string;
  sku_snapshot?: string;
  quantity?: number;
  qty?: number;
  unit_price?: number;
  unit_cost?: number;
  discount_amount?: number;
  discount?: number;
  color_name_snapshot?: string;
  size_label_snapshot?: string;
  color?: string;
  size?: string;
};

function normQty(l: LineLike) {
  return Number((l as any).quantity ?? (l as any).qty ?? 0);
}
function normPrice(l: LineLike) {
  return Number(l.unit_price ?? 0);
}
function normDiscount(l: LineLike) {
  return Number(l.discount_amount ?? l.discount ?? 0);
}
function lineSku(l: LineLike) {
  return l.sku_snapshot || l.sku || '';
}
function lineColor(l: LineLike) {
  return l.color_name_snapshot || l.color || '';
}
function lineSize(l: LineLike) {
  return l.size_label_snapshot || l.size || '';
}

function displayName(l: LineLike): string {
  const name = l.product_name_snapshot || l.product_name || '—';
  const sku = lineSku(l);
  const cs = [lineColor(l), lineSize(l)].filter(Boolean).join(' · ');
  const parts = [name];
  if (sku) parts.push(`[${sku}]`);
  if (cs) parts.push(`(${cs})`);
  return parts.join(' ');
}

function fullLineText(l: LineLike): string {
  return `${displayName(l)} · الكمية ${normQty(l)} · السعر ${normPrice(
    l,
  ).toLocaleString('en-US')} ج.م${
    normDiscount(l) > 0
      ? ` · خصم ${normDiscount(l).toLocaleString('en-US')} ج.م`
      : ''
  }`;
}

/** Diff the lines between a before/after snapshot, producing a list of
 *  human-readable change descriptions. */
function diffLines(
  before: LineLike[] | undefined,
  after: LineLike[] | undefined,
): Array<{ type: 'added' | 'removed' | 'qty' | 'price' | 'discount'; text: string }> {
  const out: Array<any> = [];
  const b = before || [];
  const a = after || [];
  const byId = (list: LineLike[]) => {
    const m = new Map<string, LineLike>();
    for (const l of list) m.set(l.variant_id, l);
    return m;
  };
  const bMap = byId(b);
  const aMap = byId(a);
  // Added
  for (const [id, al] of aMap) {
    if (!bMap.has(id)) {
      out.push({ type: 'added', text: `إضافة صنف · ${fullLineText(al)}` });
    }
  }
  // Removed
  for (const [id, bl] of bMap) {
    if (!aMap.has(id)) {
      out.push({ type: 'removed', text: `حذف صنف · ${fullLineText(bl)}` });
    }
  }
  // Quantity / price / discount changes
  for (const [id, bl] of bMap) {
    const al = aMap.get(id);
    if (!al) continue;
    const bQty = normQty(bl);
    const aQty = normQty(al);
    const bPrice = normPrice(bl);
    const aPrice = normPrice(al);
    const bDisc = normDiscount(bl);
    const aDisc = normDiscount(al);
    if (bQty !== aQty) {
      out.push({
        type: 'qty',
        text: `تعديل الكمية لـ ${displayName(bl)}: ${bQty} → ${aQty}`,
      });
    }
    if (bPrice !== aPrice) {
      out.push({
        type: 'price',
        text: `تعديل السعر لـ ${displayName(bl)}: ${bPrice.toLocaleString('en-US')} → ${aPrice.toLocaleString('en-US')} ج.م`,
      });
    }
    if (bDisc !== aDisc) {
      out.push({
        type: 'discount',
        text: `تعديل الخصم لـ ${displayName(bl)}: ${bDisc.toLocaleString('en-US')} → ${aDisc.toLocaleString('en-US')} ج.م`,
      });
    }
  }
  return out;
}

const CHANGE_BADGE: Record<string, { bg: string; label: string }> = {
  added:    { bg: 'bg-emerald-100 text-emerald-700 border-emerald-200', label: 'إضافة صنف' },
  removed:  { bg: 'bg-rose-100 text-rose-700 border-rose-200',          label: 'حذف صنف' },
  qty:      { bg: 'bg-amber-100 text-amber-700 border-amber-200',       label: 'تغيير كمية' },
  price:    { bg: 'bg-indigo-100 text-indigo-700 border-indigo-200',    label: 'تغيير سعر' },
  discount: { bg: 'bg-violet-100 text-violet-700 border-violet-200',    label: 'تغيير خصم' },
};

function EditHistoryTab({
  invoiceId,
  history,
  requests,
}: {
  invoiceId: string;
  history: any[];
  requests: any[];
}) {
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canDecide = hasPermission('invoices.edit_approve');
  const [rejectTarget, setRejectTarget] = useState<any | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const approve = useMutation({
    mutationFn: (id: number | string) => posApi.approveEditRequest(id),
    onSuccess: () => {
      toast.success('تم اعتماد التعديل وتطبيقه على الفاتورة');
      qc.invalidateQueries({ queryKey: ['invoice-edit-history', invoiceId] });
      qc.invalidateQueries({ queryKey: ['invoice-edit-requests', invoiceId] });
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['pending-edit-requests'] });
      qc.invalidateQueries({ queryKey: ['receipt', invoiceId] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل اعتماد التعديل'),
  });

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: number | string; reason: string }) =>
      posApi.rejectEditRequest(id, reason),
    onSuccess: () => {
      toast.success('تم رفض طلب التعديل');
      setRejectTarget(null);
      setRejectReason('');
      qc.invalidateQueries({ queryKey: ['invoice-edit-requests', invoiceId] });
      qc.invalidateQueries({ queryKey: ['pending-edit-requests'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل رفض الطلب'),
  });

  const approved = history || [];
  const pending = (requests || []).filter((r) => r.status === 'pending');
  const rejected = (requests || []).filter((r) => r.status === 'rejected');

  if (approved.length === 0 && pending.length === 0 && rejected.length === 0) {
    return (
      <div className="p-10 text-center text-slate-400 text-sm">
        لا توجد تعديلات على هذه الفاتورة.
      </div>
    );
  }

  return (
    <div className="overflow-y-auto p-4 space-y-4">
      {pending.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-black text-amber-700">
            طلبات تنتظر الموافقة ({pending.length})
          </div>
          {pending.map((r) => (
            <div
              key={`pend-${r.id}`}
              className="border border-amber-300 bg-amber-50 rounded-lg p-3 text-xs space-y-2"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="chip bg-amber-200 text-amber-800 border-amber-400 text-[10px] font-bold">
                    ⏳ انتظار الموافقة
                  </span>
                  <div className="font-bold text-amber-800">
                    {r.requested_by_name || r.requested_by_username || '—'}
                  </div>
                </div>
                <div className="text-slate-500 tabular-nums">
                  {fmtWhen(r.requested_at)}
                </div>
              </div>
              {r.reason && (
                <div className="text-slate-700">السبب: {r.reason}</div>
              )}
              <div>
                <div className="text-[10px] font-bold text-slate-500 mb-1">
                  التغييرات المقترحة
                </div>
                <PendingChanges request={r} />
              </div>
              {canDecide && (
                <div className="flex items-center gap-2 pt-1">
                  <button
                    type="button"
                    className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[11px]"
                    onClick={() => approve.mutate(r.id)}
                    disabled={approve.isPending || reject.isPending}
                  >
                    {approve.isPending && approve.variables === r.id
                      ? 'جاري الاعتماد…'
                      : 'اعتماد التعديل'}
                  </button>
                  <button
                    type="button"
                    className="px-3 py-1.5 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold text-[11px]"
                    onClick={() => {
                      setRejectTarget(r);
                      setRejectReason('');
                    }}
                    disabled={approve.isPending || reject.isPending}
                  >
                    رفض
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {canDecide && rejectTarget && (
        <div
          className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4"
          onClick={() => {
            if (!reject.isPending) {
              setRejectTarget(null);
              setRejectReason('');
            }
          }}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="font-black text-slate-800 mb-2">رفض طلب التعديل</h4>
            <p className="text-xs text-slate-500 mb-3">
              اكتب سبباً واضحاً — سيظهر لصاحب الطلب.
            </p>
            <textarea
              autoFocus
              rows={3}
              className="input w-full"
              placeholder="مثال: البند لا يحتاج تعديل / السعر غير صحيح / إلخ"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              disabled={reject.isPending}
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                className="btn-ghost"
                onClick={() => {
                  setRejectTarget(null);
                  setRejectReason('');
                }}
                disabled={reject.isPending}
              >
                إلغاء
              </button>
              <button
                className="px-4 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-bold text-sm"
                disabled={reject.isPending}
                onClick={() => {
                  if (!rejectReason.trim()) {
                    toast.error('يجب كتابة سبب الرفض');
                    return;
                  }
                  reject.mutate({
                    id: rejectTarget.id,
                    reason: rejectReason.trim(),
                  });
                }}
              >
                {reject.isPending ? 'جاري الرفض…' : 'تأكيد الرفض'}
              </button>
            </div>
          </div>
        </div>
      )}

      {approved.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-black text-emerald-700">
            تعديلات مُطبَّقة ({approved.length})
          </div>
          {approved.map((h) => {
            const before = h.before_snapshot || {};
            const after = h.after_summary || {};
            const beforeTotal = Number(before?.invoice?.grand_total || 0);
            const afterTotal = Number(after?.grand_total || 0);
            const delta = afterTotal - beforeTotal;
            return (
              <div
                key={`hist-${h.id}`}
                className="border border-emerald-200 bg-emerald-50/60 rounded-lg p-3 text-xs"
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="chip bg-emerald-200 text-emerald-800 border-emerald-400 text-[10px] font-bold">
                        ✓ معتمد
                      </span>
                      <div className="font-bold text-emerald-800">
                        اعتمد: {h.edited_by_name || h.edited_by_username || '—'}
                      </div>
                    </div>
                    {(h.requested_by_name || h.requested_by_username) && (
                      <div className="text-[11px] text-slate-600">
                        مقدم الطلب:{' '}
                        <span className="font-bold">
                          {h.requested_by_name || h.requested_by_username}
                        </span>
                        {h.requested_at && (
                          <span className="text-slate-400 mx-1">
                            · تم الطلب {fmtWhen(h.requested_at)}
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="text-slate-500 tabular-nums text-[11px] text-left">
                    {fmtWhen(h.edited_at)}
                  </div>
                </div>
                {h.reason && (
                  <div className="text-slate-700 mb-2">السبب: {h.reason}</div>
                )}
                <div className="grid grid-cols-2 gap-2 mb-2">
                  <div className="bg-white rounded border border-slate-200 p-2">
                    <div className="text-[10px] font-bold text-slate-500 mb-1">
                      قبل التعديل
                    </div>
                    <div className="text-slate-700">
                      {lineSummary(before.items)}
                    </div>
                    <div className="text-slate-500 mt-1 tabular-nums">
                      الإجمالي: {beforeTotal.toLocaleString('en-US')} ج.م
                    </div>
                  </div>
                  <div className="bg-white rounded border border-slate-200 p-2">
                    <div className="text-[10px] font-bold text-slate-500 mb-1">
                      بعد التعديل
                    </div>
                    <div className="text-slate-700">
                      {Number(after.items_count || 0)} بند
                    </div>
                    <div className="text-slate-500 mt-1 tabular-nums">
                      الإجمالي: {afterTotal.toLocaleString('en-US')} ج.م
                      {delta !== 0 && (
                        <span
                          className={`mr-2 ${
                            delta > 0 ? 'text-emerald-700' : 'text-rose-700'
                          }`}
                        >
                          ({delta > 0 ? '+' : ''}
                          {delta.toLocaleString('en-US')})
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <AppliedChanges history={h} />
              </div>
            );
          })}
        </div>
      )}

      {rejected.length > 0 && (
        <div className="space-y-2">
          <div className="text-xs font-black text-rose-700">
            طلبات مرفوضة ({rejected.length})
          </div>
          {rejected.map((r) => (
            <div
              key={`rej-${r.id}`}
              className="border border-rose-200 bg-rose-50/60 rounded-lg p-3 text-xs"
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2">
                  <span className="chip bg-rose-200 text-rose-800 border-rose-400 text-[10px] font-bold">
                    ✗ مرفوض
                  </span>
                  <div className="font-bold text-rose-800">
                    {r.requested_by_name || r.requested_by_username || '—'}
                  </div>
                </div>
                <div className="text-slate-500 tabular-nums">
                  {fmtWhen(r.requested_at)}
                </div>
              </div>
              {r.reason && (
                <div className="text-slate-700 mb-1">السبب: {r.reason}</div>
              )}
              {r.decision_reason && (
                <div className="text-rose-700">
                  سبب الرفض: {r.decision_reason}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ───────── Void (admin) confirm modal ───────── */

function VoidConfirmModal({
  invoice,
  onClose,
}: {
  invoice: any;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');

  const mutation = useMutation({
    mutationFn: () => posApi.void(invoice.id, reason),
    onSuccess: () => {
      toast.success('تم إلغاء الفاتورة، وتم استعادة المخزون والخزينة');
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['dashboard-overview'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإلغاء'),
  });

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-xl">
        <div className="p-5 border-b border-slate-100">
          <h3 className="font-black text-slate-800">
            إلغاء فاتورة {invoice.invoice_no}
          </h3>
        </div>
        <div className="p-5 space-y-4">
          <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-sm text-rose-800">
            ⚠️ الإلغاء سيُرجع المخزون تلقائياً ويعكس الدفعات النقدية من الخزينة.
            هذا الإجراء يظل في السجل ولا يمكن التراجع عنه.
          </div>
          <div className="bg-slate-50 rounded-lg p-3 text-sm space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-500">العميل:</span>
              <span className="font-bold">
                {invoice.customer_name || 'عميل عابر'}
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-slate-500">الإجمالي:</span>
              <span className="font-bold">{EGP(invoice.grand_total)}</span>
            </div>
          </div>
          <div>
            <label className="text-xs text-slate-600 block mb-1">
              سبب الإلغاء *
            </label>
            <textarea
              rows={3}
              className="input"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="مثال: خطأ في الإدخال / طلب العميل..."
              autoFocus
            />
          </div>
        </div>
        <div className="p-4 border-t border-slate-100 flex items-center justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            تراجع
          </button>
          <button
            className="bg-rose-600 hover:bg-rose-700 text-white rounded-lg px-4 py-2 text-sm font-bold disabled:opacity-50"
            onClick={() => {
              if (!reason.trim()) {
                toast.error('يجب كتابة سبب الإلغاء');
                return;
              }
              mutation.mutate();
            }}
            disabled={mutation.isPending || !reason.trim()}
          >
            {mutation.isPending ? 'جاري الإلغاء...' : 'تأكيد الإلغاء'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────── Invoice edit modal ───────── */

interface EditLine {
  variant_id: string;
  product_name: string;
  sku: string;
  color_name?: string;
  size_label?: string;
  qty: number;
  unit_price: number;
  discount: number;
}

// PR-POS-PAY-2 — exported for direct DOM tests of the multi-row
// payment editor wiring (see `__tests__/Invoices.edit-split-payment.test.tsx`).
// Re-exporting an internal modal keeps the test from having to render
// the full Invoices page (and mock every list/sort/pagination side
// effect) just to reach the edit form.
export function InvoiceEditModal({
  invoiceId,
  onClose,
}: {
  invoiceId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<EditLine[]>([]);
  // PR-POS-PAY-2 — Multi-row split-payments state (replaces the
  // PR-PAY-3 single-method/single-account tuple). Each row carries
  // its own method, amount, and (for non-cash) payment_account_id.
  // The seed effect below loads ALL original payments — not just the
  // first row — so an invoice that was already split stays split in
  // the editor instead of silently collapsing to its first row.
  const [payments, setPayments] = useState<SplitPaymentRow[]>([]);
  const [discountTotal, setDiscountTotal] = useState(0);
  const [notes, setNotes] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['invoice-edit', invoiceId],
    queryFn: () => posApi.get(invoiceId),
  });

  // Subscribe to active payment accounts so the submit-time gate
  // (`isAccountRequired`) matches what the editor itself enforces.
  // The editor mounts the same query internally; React Query caches
  // the shared key so we don't refetch.
  const accountsQuery = useQuery({
    queryKey: ['payment-accounts', 'active'],
    queryFn: () => paymentsApi.listAccounts({ active: true }),
  });
  const accounts = accountsQuery.data ?? [];

  // Seed the editor once when the invoice payload lands. Map ALL
  // existing invoice_payments rows into UI rows (PR-POS-PAY-2 fix
  // for the legacy "first-row only" behaviour). If an invoice had
  // no payments yet, fall back to a single cash row at the grand
  // total so the operator never sees an empty editor.
  useEffect(() => {
    if (!data) return;
    const items = (data.items || data.lines || []).map((it: any) => ({
      variant_id: it.variant_id,
      product_name: it.product_name_snapshot || it.product_name || '',
      sku: it.sku_snapshot || it.sku || '',
      color_name: it.color_name_snapshot || undefined,
      size_label: it.size_label_snapshot || undefined,
      qty: Number(it.quantity || 0),
      unit_price: Number(it.unit_price || 0),
      discount: Number(it.discount_amount || 0),
    }));
    setLines(items);
    setDiscountTotal(Number(data.invoice_discount || 0));
    setNotes(data.notes || '');

    const origPayments = (data.payments || []) as Array<{
      payment_method?: PaymentMethodCode;
      amount?: number | string;
      payment_account_id?: string | null;
      payment_account_snapshot?: { display_name?: string } | null;
      reference?: string | null;
    }>;
    if (origPayments.length === 0) {
      // No prior payments → seed one cash row at the invoice grand
      // total. This is a defensive fallback (every paid invoice
      // already has at least one row) so the editor never opens
      // with zero rows.
      setPayments([
        {
          uid: makeRowUid(),
          method: 'cash',
          amount: Number(data.grand_total || data.paid_total || 0),
          payment_account_id: null,
        },
      ]);
    } else {
      setPayments(
        origPayments.map((p) => ({
          uid: makeRowUid(),
          method: (p.payment_method ?? 'cash') as PaymentMethodCode,
          amount: Number(p.amount || 0),
          payment_account_id: p.payment_account_id ?? null,
          account_display_name: p.payment_account_snapshot?.display_name ?? null,
          reference: p.reference ?? undefined,
        })),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.id]);

  const subtotal = lines.reduce(
    (s, l) => s + l.qty * l.unit_price - (l.discount || 0),
    0,
  );
  const grand = Math.max(0, subtotal - discountTotal);

  const updateLine = (idx: number, patch: Partial<EditLine>) =>
    setLines((prev) =>
      prev.map((l, i) => (i === idx ? { ...l, ...patch } : l)),
    );
  const removeLine = (idx: number) =>
    setLines((prev) => prev.filter((_, i) => i !== idx));

  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canApplyDirect = hasPermission('invoices.edit');
  const canSubmitRequest =
    !canApplyDirect && hasPermission('invoices.edit_request');

  // PR-POS-PAY-2 — Same predicate the editor uses internally; we
  // recompute it here so the submit-time gate matches the validation
  // banner the operator sees.
  const isAccountRequired = (m: PaymentMethodCode) =>
    m !== 'cash' && accounts.filter((a) => a.method === m).length > 0;
  const paymentValidation = validateSplitPayments(payments, grand, {
    isAccountRequired,
  });

  const save = useMutation<unknown>({
    mutationFn: () => {
      if (lines.length === 0)
        return Promise.reject(new Error('يجب وجود صنف واحد على الأقل'));
      if (!reason.trim())
        return Promise.reject(new Error('يجب كتابة سبب التعديل'));
      // PR-POS-PAY-2 — multi-row validation. Same helper PaymentModal
      // uses, so the rules are identical to the new-invoice flow:
      //   - ≥ 1 row, each amount > 0
      //   - non-cash + accounts catalogued → must select an account
      //   - non-cash overpay blocked (cash overpay → change)
      if (!paymentValidation.ok) {
        return Promise.reject(
          new Error(paymentValidation.reason ?? 'تحقّق من سطور الدفع'),
        );
      }
      // Build the API payload from the freshly-built drafts. Both
      // permission paths (`invoices.edit` direct + `invoices.edit_request`
      // approval queue) share the SAME builder so the multi-row UI
      // stays consistent across roles.
      const drafts = rowsToPaymentDrafts(payments);
      const payload = {
        warehouse_id: data.warehouse_id,
        customer_id: data.customer_id || undefined,
        salesperson_id: data.salesperson_id || undefined,
        notes: notes || undefined,
        discount_total: discountTotal,
        edit_reason: reason,
        lines: lines.map((l) => ({
          variant_id: l.variant_id,
          qty: l.qty,
          unit_price: l.unit_price,
          discount: l.discount || 0,
        })),
        payments: drafts.map((d) => ({
          payment_method: d.method,
          amount: d.amount,
          reference: d.reference,
          payment_account_id: d.payment_account_id ?? undefined,
        })),
      };
      if (canApplyDirect) return posApi.edit(invoiceId, payload);
      if (canSubmitRequest) return posApi.submitEditRequest(invoiceId, payload);
      return Promise.reject(new Error('لا تملك صلاحية طلب تعديل الفاتورة'));
    },
    onSuccess: () => {
      if (canApplyDirect) {
        toast.success('تم حفظ التعديل على نفس الفاتورة');
      } else {
        toast.success(
          'أُرسل طلب التعديل لمدير النظام — سيُنفّذ بعد الموافقة',
        );
      }
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['dashboard-overview'] });
      qc.invalidateQueries({ queryKey: ['invoice-edit-history', invoiceId] });
      qc.invalidateQueries({ queryKey: ['invoice-edit-requests', invoiceId] });
      qc.invalidateQueries({ queryKey: ['pending-edit-requests'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || e?.message || 'فشل التعديل'),
  });

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div
        className="bg-white rounded-2xl w-full max-w-4xl shadow-xl max-h-[90vh] overflow-hidden flex flex-col"
        dir="rtl"
      >
        <div className="p-4 border-b flex items-center justify-between">
          <div>
            <h3 className="font-black text-slate-800 flex items-center gap-2">
              <Pencil className="w-5 h-5 text-amber-500" />
              تعديل فاتورة {data?.invoice_no || ''}
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              {canApplyDirect
                ? 'التعديل يتم على نفس الفاتورة. البنود والدفعات السابقة تُحفظ في سجل التعديلات مع اسم المعدِّل والتاريخ والوقت.'
                : 'ليس لديك صلاحية تنفيذ التعديل مباشرة — طلبك سيُرسل لمدير النظام لاعتماده. بعد الموافقة تُطبَّق التعديلات على نفس الفاتورة.'}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded hover:bg-slate-100"
            title="إغلاق"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4 overflow-y-auto space-y-4 flex-1">
          {isLoading ? (
            <div className="p-10 text-center text-slate-400">جاري التحميل…</div>
          ) : (
            <>
              <EditAddItemBar
                onAdd={(variant, product) => {
                  setLines((prev) => {
                    const existingIdx = prev.findIndex(
                      (l) => l.variant_id === variant.id,
                    );
                    if (existingIdx >= 0) {
                      return prev.map((l, i) =>
                        i === existingIdx ? { ...l, qty: l.qty + 1 } : l,
                      );
                    }
                    return [
                      ...prev,
                      {
                        variant_id: variant.id,
                        product_name: product?.name_ar || '',
                        sku: variant.sku || '',
                        color_name: variant.color ?? undefined,
                        size_label: variant.size ?? undefined,
                        qty: 1,
                        unit_price: Number(
                          variant.selling_price ??
                            variant.price_override ??
                            product?.base_price ??
                            0,
                        ),
                        discount: 0,
                      },
                    ];
                  });
                }}
              />

              <div className="border rounded-lg overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-slate-600 text-xs">
                    <tr>
                      <th className="p-2 text-right">الصنف</th>
                      <th className="p-2 text-right">الكمية</th>
                      <th className="p-2 text-right">سعر الوحدة</th>
                      <th className="p-2 text-right">خصم</th>
                      <th className="p-2 text-right">الإجمالي</th>
                      <th className="p-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {lines.map((l, idx) => {
                      const total = l.qty * l.unit_price - (l.discount || 0);
                      return (
                        <tr key={`${l.variant_id}-${idx}`}>
                          <td className="p-2">
                            <div className="font-medium">{l.product_name}</div>
                            <div className="text-[10px] text-slate-400 font-mono">
                              {l.sku}{' '}
                              {[l.color_name, l.size_label]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          </td>
                          <td className="p-2">
                            <div className="flex items-center gap-1">
                              <button
                                className="p-1 rounded bg-slate-100 hover:bg-slate-200"
                                onClick={() =>
                                  updateLine(idx, {
                                    qty: Math.max(1, l.qty - 1),
                                  })
                                }
                              >
                                <Minus size={12} />
                              </button>
                              <input
                                className="w-14 text-center border rounded"
                                type="number"
                                value={l.qty}
                                min={1}
                                onChange={(e) =>
                                  updateLine(idx, {
                                    qty: Math.max(1, Number(e.target.value) || 1),
                                  })
                                }
                              />
                              <button
                                className="p-1 rounded bg-slate-100 hover:bg-slate-200"
                                onClick={() =>
                                  updateLine(idx, { qty: l.qty + 1 })
                                }
                              >
                                <Plus size={12} />
                              </button>
                            </div>
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              step="0.01"
                              className="w-24 border rounded px-1 py-0.5 text-sm"
                              value={l.unit_price}
                              onChange={(e) =>
                                updateLine(idx, {
                                  unit_price: Number(e.target.value) || 0,
                                })
                              }
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              step="0.01"
                              className="w-20 border rounded px-1 py-0.5 text-sm"
                              value={l.discount}
                              onChange={(e) =>
                                updateLine(idx, {
                                  discount: Number(e.target.value) || 0,
                                })
                              }
                            />
                          </td>
                          <td className="p-2 font-mono font-bold">
                            {EGP(total)}
                          </td>
                          <td className="p-2">
                            <button
                              onClick={() => removeLine(idx)}
                              className="p-1 rounded hover:bg-rose-50 text-rose-600"
                              title="حذف"
                            >
                              <Trash2 size={14} />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {lines.length === 0 && (
                      <tr>
                        <td
                          colSpan={6}
                          className="p-6 text-center text-slate-400"
                        >
                          لا توجد أصناف
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-slate-600 block mb-1">
                    خصم إجمالي
                  </label>
                  <input
                    type="number"
                    className="input"
                    value={discountTotal}
                    onChange={(e) =>
                      setDiscountTotal(Number(e.target.value) || 0)
                    }
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-600 block mb-1">
                    ملاحظات
                  </label>
                  <input
                    className="input"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between bg-slate-50 rounded-lg px-4 py-3">
                <div className="text-sm text-slate-600">
                  المجموع الفرعي:{' '}
                  <span className="font-bold">{EGP(subtotal)}</span>
                </div>
                <div className="text-lg font-black text-brand-600">
                  الإجمالي: {EGP(grand)}
                </div>
              </div>

              {/* PR-POS-PAY-2 — Multi-row split-payment editor.
                  Same shared component the POS PaymentModal uses, in
                  the light variant to fit the edit modal's surface.
                  `hideGrandTotalBanner` because the row above already
                  shows the invoice total. */}
              <div className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="text-xs text-slate-600 font-bold mb-3">
                  طرق الدفع
                </div>
                <SplitPaymentsEditor
                  rows={payments}
                  onChange={setPayments}
                  grandTotal={grand}
                  variant="light"
                  hideGrandTotalBanner
                />
              </div>

              <div>
                <label className="text-xs text-slate-600 block mb-1">
                  سبب التعديل *
                </label>
                <textarea
                  rows={2}
                  className="input"
                  placeholder="مثال: تصحيح كمية / تعديل سعر / إلخ"
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
            </>
          )}
        </div>

        <div className="p-4 border-t flex items-center justify-between gap-2">
          <div className="text-xs text-amber-700 min-h-[16px]">
            {!reason.trim() && 'اكتب سبب التعديل قبل الإرسال'}
            {reason.trim() && lines.length === 0 && 'أضف صنف واحد على الأقل'}
            {reason.trim() &&
              lines.length > 0 &&
              !paymentValidation.ok &&
              paymentValidation.reason}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={onClose} className="btn-ghost" disabled={save.isPending}>
              إلغاء
            </button>
            <button
              type="button"
              onClick={() => {
                // Surface common blockers as toasts so users don't stare
                // at an unresponsive disabled button.
                if (isLoading) {
                  toast('جارٍ تحميل بيانات الفاتورة — انتظر قليلًا');
                  return;
                }
                if (lines.length === 0) {
                  toast.error('أضف صنف واحد على الأقل قبل الحفظ');
                  return;
                }
                if (!reason.trim()) {
                  toast.error('يجب كتابة سبب التعديل قبل الإرسال');
                  return;
                }
                if (!canApplyDirect && !canSubmitRequest) {
                  toast.error('لا تملك صلاحية تعديل الفاتورة');
                  return;
                }
                // PR-POS-PAY-2 — surface multi-row payment errors
                // (zero-amount row, missing non-cash account, non-cash
                // overpay) so the cashier knows why save is blocked.
                if (!paymentValidation.ok) {
                  toast.error(
                    paymentValidation.reason ?? 'تحقّق من سطور الدفع',
                  );
                  return;
                }
                save.mutate();
              }}
              disabled={save.isPending || !paymentValidation.ok}
              data-testid="invoice-edit-save"
              className={`btn-primary ${
                save.isPending ? 'opacity-60 cursor-wait' : ''
              }`}
            >
              {save.isPending
                ? 'جاري الحفظ...'
                : canApplyDirect
                  ? 'حفظ التعديل على نفس الفاتورة'
                  : 'إرسال طلب تعديل للموافقة'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ───────── Edit — add-item search bar ───────── */

function EditAddItemBar({
  onAdd,
}: {
  onAdd: (variant: Variant, product: Product) => void;
}) {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  // Product-level search (list endpoint returns products w/o variants).
  const { data } = useQuery({
    queryKey: ['edit-add-item-search', q],
    queryFn: () => productsApi.list({ q, limit: 25, active: true }),
    enabled: q.trim().length >= 2,
    staleTime: 30_000,
  });
  const items: Product[] = (data as any)?.data || (data as any) || [];

  // Variants for the currently-expanded product. Lazy — only fetched
  // on click so we don't burn 25 requests per keystroke.
  const { data: expanded } = useQuery({
    queryKey: ['edit-add-item-variants', expandedId],
    queryFn: () => productsApi.get(expandedId as string),
    enabled: !!expandedId,
    staleTime: 30_000,
  });

  return (
    <div className="relative">
      <div className="flex items-center gap-2">
        <div className="relative flex-1">
          <Search
            size={14}
            className="absolute top-1/2 -translate-y-1/2 right-3 text-slate-400"
          />
          <input
            className="input w-full pr-9"
            placeholder="إضافة صنف… اكتب الاسم أو الكود أو الباركود"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setOpen(true);
              setExpandedId(null);
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 150)}
          />
        </div>
      </div>
      {open && q.trim().length >= 2 && items.length > 0 && (
        <div className="absolute z-20 mt-1 left-0 right-0 bg-white border border-slate-200 rounded-lg shadow-lg max-h-80 overflow-y-auto">
          {items.map((p) => {
            const isExpanded = expandedId === p.id;
            const variants = isExpanded
              ? ((expanded as any)?.variants || [])
              : [];
            const variantsCount = Number((p as any).variants_count || 0);
            return (
              <div
                key={p.id}
                className="border-b border-slate-100 last:border-0"
              >
                <button
                  type="button"
                  className="w-full text-right px-3 py-2 bg-slate-50 hover:bg-brand-50 font-bold text-xs text-slate-700 flex items-center justify-between"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    setExpandedId(isExpanded ? null : p.id);
                  }}
                >
                  <span className="flex items-center gap-1.5">
                    <span>{p.name_ar}</span>
                    {variantsCount > 0 && (
                      <span className="chip bg-indigo-100 text-indigo-700 border-indigo-200 text-[10px]">
                        {variantsCount} متغير
                      </span>
                    )}
                  </span>
                  <span className="font-mono text-[10px] text-slate-400">
                    {(p as any).sku_root || ''}
                  </span>
                </button>
                {isExpanded && variants.length === 0 && (
                  <div className="p-3 text-center text-xs text-slate-400">
                    جارٍ تحميل المتغيرات…
                  </div>
                )}
                {isExpanded && variants.length > 0 && (
                  <div className="divide-y divide-slate-100">
                    {variants.map((v: any) => (
                      <button
                        key={v.id}
                        type="button"
                        className="w-full text-right px-3 py-2 hover:bg-emerald-50 flex items-center justify-between text-xs"
                        onMouseDown={(e) => {
                          e.preventDefault();
                          onAdd(v as Variant, p);
                          setQ('');
                          setOpen(false);
                          setExpandedId(null);
                        }}
                      >
                        <span className="text-slate-700">
                          {[v.color, v.size].filter(Boolean).join(' · ') ||
                            v.sku ||
                            '—'}
                        </span>
                        <span className="flex items-center gap-2 text-[11px]">
                          <span className="text-slate-400 tabular-nums">
                            رصيد {Number(v.total_stock ?? v.qty ?? 0)}
                          </span>
                          <span className="font-mono text-slate-600">
                            {Number(
                              v.selling_price ??
                                v.price_override ??
                                (p as any).base_price ??
                                0,
                            ).toLocaleString('en-US')}{' '}
                            ج.م
                          </span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ───────── Change renderers ───────── */

function ChangeList({ changes }: { changes: Array<{ type: string; text: string }> }) {
  if (!changes.length) {
    return (
      <div className="text-[11px] text-slate-500">
        لا اختلافات في البنود — قد يكون التعديل على الدفع أو الخصم الإجمالي فقط.
      </div>
    );
  }
  return (
    <ul className="space-y-1">
      {changes.map((c, i) => {
        const badge = CHANGE_BADGE[c.type] || CHANGE_BADGE.qty;
        return (
          <li
            key={i}
            className="flex items-start gap-2 text-[11px] bg-white border border-slate-200 rounded px-2 py-1"
          >
            <span className={`chip border text-[10px] ${badge.bg}`}>
              {badge.label}
            </span>
            <span className="text-slate-700 flex-1">{c.text}</span>
          </li>
        );
      })}
    </ul>
  );
}

/** Compare the original invoice (fetched via posApi.get) with the
 *  request's proposed_changes.lines to render a concrete diff. */
function PendingChanges({ request }: { request: any }) {
  const { data: inv } = useQuery({
    queryKey: ['invoice-baseline', request.invoice_id],
    queryFn: () => posApi.get(request.invoice_id),
    staleTime: 60_000,
  });
  const changes = diffLines(
    (inv as any)?.items || (inv as any)?.lines || [],
    request?.proposed_changes?.lines || [],
  );
  return <ChangeList changes={changes} />;
}

/** Compact, two-line items preview shown under the invoice number
 *  in the list so cashiers can see "what's in this invoice" without
 *  opening it. Collapses after 3 items into "...و N أخرى". */
function ItemsSummary({ items }: { items: any[] }) {
  const shown = items.slice(0, 3);
  const extra = Math.max(0, items.length - shown.length);
  return (
    <div className="mt-1 text-[11px] font-normal text-slate-500 leading-snug">
      {shown.map((it, i) => (
        <div key={i} className="truncate">
          <span className="text-slate-700 font-medium">
            {it.name || '—'}
          </span>
          {it.sku && (
            <span className="font-mono text-slate-400 mx-1">
              [{it.sku}]
            </span>
          )}
          <span className="text-slate-500">× {Number(it.qty || 0)}</span>
          {[it.color, it.size].filter(Boolean).length > 0 && (
            <span className="text-slate-400 mr-1">
              ({[it.color, it.size].filter(Boolean).join(' · ')})
            </span>
          )}
        </div>
      ))}
      {extra > 0 && (
        <div className="text-slate-400">… و {extra} صنف آخر</div>
      )}
    </div>
  );
}

/** Diff a stored edit's before/after snapshots. Falls back to the
 *  current invoice state only if after_snapshot is missing (legacy
 *  rows written before the after_snapshot column existed). */
function AppliedChanges({ history }: { history: any }) {
  const hasAfterSnap = !!history?.after_snapshot?.items;
  const { data: current } = useQuery({
    queryKey: ['invoice-post-edit', history.invoice_id],
    queryFn: () => posApi.get(history.invoice_id),
    staleTime: 30_000,
    enabled: !hasAfterSnap && !!history?.invoice_id,
  });
  const beforeItems = history?.before_snapshot?.items || [];
  const afterItems = hasAfterSnap
    ? history.after_snapshot.items
    : (current as any)?.items || (current as any)?.lines || [];
  const changes = diffLines(beforeItems, afterItems);
  return <ChangeList changes={changes} />;
}

// PR-POS-PAY-2 — `EditPaymentPicker` (single-method+single-account
// dropdown) was removed; the invoice-edit modal now embeds the same
// `<SplitPaymentsEditor />` the POS PaymentModal uses.
