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
} from 'lucide-react';
import { posApi } from '@/api/pos.api';
import { usersApi } from '@/api/users.api';
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
  const canEdit = hasPermission('invoices.edit');

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
  const [previewId, setPreviewId] = useState<string | null>(null);
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
                  <td className="p-3 font-mono text-sm font-bold text-brand-700">
                    <InvoiceHoverCard
                      invoiceId={i.id}
                      label={i.invoice_no || i.doc_no}
                      className="font-mono font-bold text-brand-700 hover:text-brand-900 hover:underline cursor-pointer"
                    />
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
                        onClick={() => setPreviewId(i.id)}
                        title="عرض الإيصال والطباعة"
                      >
                        <ReceiptIcon size={14} />
                      </button>
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

      {previewId && (
        <ReceiptPreviewModal
          invoiceId={previewId}
          onClose={() => setPreviewId(null)}
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
}: {
  invoiceId: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['receipt', invoiceId],
    queryFn: () => posApi.receipt(invoiceId),
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4 print:bg-transparent print:p-0">
      <div className="bg-white rounded-2xl max-w-md w-full max-h-[90vh] overflow-hidden flex flex-col print:rounded-none print:max-w-none print:w-auto print:max-h-none">
        <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between print:hidden">
          <h3 className="font-black text-slate-800">معاينة الإيصال</h3>
          <div className="flex gap-2">
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
            <button
              className="btn-ghost text-xs"
              onClick={onClose}
            >
              <X size={14} />
            </button>
          </div>
        </div>
        <div className="overflow-y-auto print:overflow-visible">
          {isLoading && (
            <div className="p-12 text-center text-slate-400 print:hidden">
              جارٍ التحميل...
            </div>
          )}
          {data && <Receipt data={data as ReceiptData} />}
        </div>
      </div>
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

function InvoiceEditModal({
  invoiceId,
  onClose,
}: {
  invoiceId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState<EditLine[]>([]);
  const [paymentMethod, setPaymentMethod] = useState<
    'cash' | 'card' | 'instapay' | 'bank_transfer'
  >('cash');
  const [discountTotal, setDiscountTotal] = useState(0);
  const [notes, setNotes] = useState('');

  const { data, isLoading } = useQuery({
    queryKey: ['invoice-edit', invoiceId],
    queryFn: () => posApi.get(invoiceId),
  });

  // Seed the editor once when the invoice payload lands.
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
    const firstPay = (data.payments || [])[0];
    if (firstPay?.payment_method) setPaymentMethod(firstPay.payment_method);
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

  const save = useMutation({
    mutationFn: () => {
      if (lines.length === 0)
        return Promise.reject(new Error('يجب وجود صنف واحد على الأقل'));
      if (!reason.trim())
        return Promise.reject(new Error('يجب كتابة سبب التعديل'));
      return posApi.edit(invoiceId, {
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
        payments: [
          {
            payment_method: paymentMethod,
            amount: grand,
          },
        ],
      });
    },
    onSuccess: () => {
      toast.success('تم حفظ التعديل على نفس الفاتورة');
      qc.invalidateQueries({ queryKey: ['invoices'] });
      qc.invalidateQueries({ queryKey: ['dashboard-overview'] });
      qc.invalidateQueries({ queryKey: ['invoice-edit-history', invoiceId] });
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
              التعديل يتم على نفس الفاتورة. البنود والدفعات السابقة تُحفظ
              في سجل التعديلات مع اسم المعدِّل والتاريخ والوقت.
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

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
                    طريقة الدفع
                  </label>
                  <select
                    className="input"
                    value={paymentMethod}
                    onChange={(e) => setPaymentMethod(e.target.value as any)}
                  >
                    <option value="cash">كاش</option>
                    <option value="card">بطاقة</option>
                    <option value="instapay">إنستا باي</option>
                    <option value="bank_transfer">تحويل بنكي</option>
                  </select>
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

        <div className="p-4 border-t flex items-center justify-end gap-2">
          <button onClick={onClose} className="btn-ghost">
            إلغاء
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={
              save.isPending ||
              !reason.trim() ||
              lines.length === 0 ||
              isLoading
            }
            className="btn-primary"
          >
            {save.isPending ? 'جاري الحفظ...' : 'حفظ التعديل على نفس الفاتورة'}
          </button>
        </div>
      </div>
    </div>
  );
}
