import { useMemo, useState } from 'react';
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
} from 'lucide-react';
import { posApi } from '@/api/pos.api';
import { usersApi } from '@/api/users.api';
import { Receipt, ReceiptData } from '@/components/Receipt';
import { useAuthStore } from '@/stores/auth.store';

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
  const canVoid = user?.role === 'admin' || user?.role === 'manager';

  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + '-01';

  const [q, setQ] = useState('');
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState<Status>('all');
  const [cashierId, setCashierId] = useState<string>('');
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [voidTarget, setVoidTarget] = useState<any | null>(null);

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

  const totals = useMemo(() => {
    const arr = invoices as any[];
    let count = 0;
    let grand = 0;
    let profit = 0;
    let cancelledCount = 0;
    for (const i of arr) {
      if (i.status === 'cancelled') {
        cancelledCount++;
        continue;
      }
      count++;
      grand += Number(i.grand_total || 0);
      profit += Number(i.gross_profit || 0);
    }
    return { count, grand, profit, cancelledCount, total: arr.length };
  }, [invoices]);

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
          label="الربح"
          value={EGP(totals.profit)}
          tone="pink"
        />
        <KpiCard
          icon={Ban}
          label="فواتير ملغاة"
          value={NUM(totals.cancelledCount)}
          tone="rose"
        />
      </div>

      {/* Filters */}
      <div className="card p-4 grid grid-cols-1 md:grid-cols-5 gap-3">
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
          <label className="text-xs text-slate-500 block mb-1">من</label>
          <input
            type="date"
            className="input"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-slate-500 block mb-1">إلى</label>
          <input
            type="date"
            className="input"
            value={to}
            onChange={(e) => setTo(e.target.value)}
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
              <th className="text-right p-3">رقم الفاتورة</th>
              <th className="text-right p-3">التاريخ والوقت</th>
              <th className="text-right p-3">العميل</th>
              <th className="text-right p-3">الكاشير</th>
              <th className="text-left p-3">الإجمالي</th>
              <th className="text-left p-3">الربح</th>
              <th className="text-center p-3">الحالة</th>
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
              (invoices as any[]).map((i) => (
                <tr
                  key={i.id}
                  className={`border-b border-slate-100 ${
                    i.status === 'cancelled'
                      ? 'bg-rose-50/30 opacity-75'
                      : 'hover:bg-slate-50'
                  }`}
                >
                  <td className="p-3 font-mono text-sm font-bold text-brand-700">
                    {i.invoice_no || i.doc_no}
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
                        title="عرض/طباعة الإيصال"
                      >
                        <Printer size={14} />
                      </button>
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
            {!isLoading && !invoices.length && (
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
              className="btn-primary text-xs"
              onClick={() => window.print()}
              disabled={isLoading}
            >
              <Printer size={14} /> إعادة طباعة
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
