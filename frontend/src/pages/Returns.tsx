import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Search,
  Plus,
  Receipt,
  Package,
  ArrowLeftRight,
  XCircle,
  CheckCircle2,
  Banknote,
  AlertCircle,
  Clock,
  ChevronLeft,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  returnsApi,
  ReturnStatus,
  ReturnReason,
  PaymentMethod,
  InvoiceLookup,
  InvoiceLookupItem,
  ReturnDetails,
  ItemCondition,
} from '@/api/returns.api';
import { productsApi } from '@/api/products.api';
import { Trash2 } from 'lucide-react';
import {
  CashSourceSelector,
  CashSource,
} from '@/components/CashSourceSelector';

const EGP = (n: number | string) => `${Number(n).toFixed(0)} ج.م`;

const STATUS_META: Record<
  ReturnStatus,
  { label: string; color: string; icon: typeof CheckCircle2 }
> = {
  pending: {
    label: 'بانتظار الموافقة',
    color: 'bg-amber-100 text-amber-800 border-amber-200',
    icon: Clock,
  },
  approved: {
    label: 'معتمد',
    color: 'bg-sky-100 text-sky-800 border-sky-200',
    icon: CheckCircle2,
  },
  refunded: {
    label: 'تم الصرف',
    color: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    icon: Banknote,
  },
  rejected: {
    label: 'مرفوض',
    color: 'bg-rose-100 text-rose-800 border-rose-200',
    icon: XCircle,
  },
};

const REASON_LABELS: Record<ReturnReason, string> = {
  defective: 'منتج معيب',
  wrong_size: 'مقاس غير مناسب',
  wrong_color: 'لون غير مناسب',
  customer_changed_mind: 'غيّر رأيه',
  not_as_described: 'غير مطابق للوصف',
  other: 'أخرى',
};

const CONDITION_LABELS: Record<ItemCondition, string> = {
  resellable: 'قابل لإعادة البيع',
  damaged: 'تالف',
  defective: 'معيب',
};

const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'كاش',
  card: 'بطاقة',
  instapay: 'انستا باي',
  bank_transfer: 'تحويل بنكي',
};

// ============================================================================
export default function Returns() {
  const [tab, setTab] = useState<'returns' | 'exchanges'>('returns');
  const [status, setStatus] = useState<ReturnStatus | 'all'>('all');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const { data: returns, isLoading } = useQuery({
    queryKey: ['returns', status, q],
    queryFn: () =>
      returnsApi.list({
        status: status === 'all' ? undefined : status,
        q: q || undefined,
        limit: 200,
      }),
    enabled: tab === 'returns',
  });

  const { data: exchanges } = useQuery({
    queryKey: ['exchanges', q],
    queryFn: () => returnsApi.listExchanges({ q: q || undefined, limit: 200 }),
    enabled: tab === 'exchanges',
  });

  const pendingCount = returns?.filter((r) => r.status === 'pending').length ?? 0;
  const refundedTotal =
    returns?.reduce(
      (s, r) => (r.status === 'refunded' ? s + Number(r.net_refund) : s),
      0,
    ) ?? 0;

  return (
    <div className="space-y-6">
      {/* Header ============================================================ */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black text-slate-900">
            المرتجعات والاستبدال
          </h1>
          <p className="text-slate-500 mt-1">
            إدارة مرتجعات العملاء + استبدال المنتجات
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary flex items-center gap-2"
        >
          <Plus size={18} /> {tab === 'returns' ? 'مرتجع جديد' : 'استبدال جديد'}
        </button>
      </div>

      {/* KPIs ============================================================== */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard
          label="بانتظار الموافقة"
          value={String(pendingCount)}
          icon={Clock}
          tint="from-amber-500 to-orange-500"
        />
        <KpiCard
          label="إجمالي المردود"
          value={EGP(refundedTotal)}
          icon={Banknote}
          tint="from-emerald-500 to-teal-500"
        />
        <KpiCard
          label="إجمالي السجلات"
          value={String(returns?.length ?? 0)}
          icon={Receipt}
          tint="from-brand-500 to-purple-500"
        />
      </div>

      {/* Tabs ============================================================== */}
      <div className="flex gap-2 border-b border-slate-200">
        {(
          [
            { v: 'returns', t: 'المرتجعات', icon: Receipt },
            { v: 'exchanges', t: 'الاستبدال', icon: ArrowLeftRight },
          ] as const
        ).map(({ v, t, icon: Icon }) => (
          <button
            key={v}
            onClick={() => {
              setTab(v);
              setSelectedId(null);
            }}
            className={`px-5 py-2.5 font-medium flex items-center gap-2 border-b-2 -mb-px transition-colors ${
              tab === v
                ? 'border-brand-500 text-brand-700'
                : 'border-transparent text-slate-500 hover:text-slate-800'
            }`}
          >
            <Icon size={16} /> {t}
          </button>
        ))}
      </div>

      {/* Filters =========================================================== */}
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[260px]">
          <Search
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
            size={18}
          />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="ابحث برقم المرتجع أو الفاتورة أو العميل..."
            className="input pr-10 w-full"
          />
        </div>
        {tab === 'returns' && (
          <div className="flex gap-2 flex-wrap">
            {(
              ['all', 'pending', 'approved', 'refunded', 'rejected'] as const
            ).map((s) => (
              <button
                key={s}
                onClick={() => setStatus(s)}
                className={`px-4 py-2 rounded-lg border text-sm font-medium transition-all ${
                  status === s
                    ? 'bg-brand-500 text-white border-brand-500 shadow-sm'
                    : 'bg-white text-slate-600 border-slate-200 hover:border-brand-300'
                }`}
              >
                {s === 'all' ? 'الكل' : STATUS_META[s].label}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Grid ============================================================= */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_480px] gap-6">
        {/* List */}
        <div className="card overflow-hidden">
          {tab === 'returns' ? (
            isLoading ? (
              <LoadingState />
            ) : !returns?.length ? (
              <EmptyState tab="returns" onCreate={() => setShowCreate(true)} />
            ) : (
              <div className="divide-y divide-slate-100">
                {returns.map((r) => (
                  <ReturnRow
                    key={r.id}
                    r={r}
                    isActive={selectedId === r.id}
                    onClick={() => setSelectedId(r.id)}
                  />
                ))}
              </div>
            )
          ) : !exchanges?.length ? (
            <EmptyState tab="exchanges" onCreate={() => setShowCreate(true)} />
          ) : (
            <div className="divide-y divide-slate-100">
              {exchanges.map((e) => (
                <ExchangeRow key={e.id} e={e} />
              ))}
            </div>
          )}
        </div>

        {/* Details */}
        <div>
          {tab === 'returns' && selectedId ? (
            <ReturnDetailsPanel
              id={selectedId}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <div className="card p-12 text-center text-slate-400">
              <Package size={48} className="mx-auto mb-3 text-slate-300" />
              <p>
                {tab === 'returns'
                  ? 'اختر مرتجع من القائمة لعرض التفاصيل'
                  : 'قائمة الاستبدال لعرض السجلات'}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Create modal ====================================================== */}
      {showCreate && tab === 'returns' && (
        <CreateReturnModal onClose={() => setShowCreate(false)} />
      )}
      {showCreate && tab === 'exchanges' && (
        <CreateExchangeModal onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}

// ============================================================================
// Rows
// ============================================================================
function ReturnRow({
  r,
  isActive,
  onClick,
}: {
  r: any;
  isActive: boolean;
  onClick: () => void;
}) {
  const meta = STATUS_META[r.status as ReturnStatus];
  const Icon = meta.icon;
  return (
    <button
      onClick={onClick}
      className={`w-full text-right px-5 py-4 hover:bg-brand-50/40 transition-colors flex items-center gap-4 ${
        isActive ? 'bg-brand-50' : ''
      }`}
    >
      <div
        className={`px-2.5 py-1 rounded-md border text-xs font-bold inline-flex items-center gap-1 ${meta.color}`}
      >
        <Icon size={12} /> {meta.label}
      </div>

      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-3">
          <div className="font-mono font-bold text-slate-800">{r.return_no}</div>
          <span className="text-xs text-slate-500">
            من فاتورة {r.invoice_no}
          </span>
        </div>
        <div className="text-sm text-slate-600 flex items-center gap-3 mt-0.5">
          <span>{r.customer_name || '—'}</span>
          <span>•</span>
          <span>{r.units_count} قطعة</span>
          <span>•</span>
          <span>{REASON_LABELS[r.reason as ReturnReason]}</span>
        </div>
      </div>

      <div className="text-left">
        <div className="font-bold text-slate-900">
          {EGP(r.net_refund)}
        </div>
        {Number(r.restocking_fee) > 0 && (
          <div className="text-xs text-amber-700">
            رسوم {EGP(r.restocking_fee)}
          </div>
        )}
      </div>
    </button>
  );
}

function ExchangeRow({ e }: { e: any }) {
  const diff = Number(e.price_difference);
  return (
    <div className="px-5 py-4 flex items-center gap-4">
      <ArrowLeftRight className="text-brand-500" size={18} />
      <div className="flex-1">
        <div className="font-mono font-bold">{e.exchange_no}</div>
        <div className="text-sm text-slate-600">
          من {e.original_invoice_no} ← إلى {e.new_invoice_no || '—'} ·{' '}
          {e.customer_name || '—'}
        </div>
      </div>
      <div className="text-left">
        <div
          className={`font-bold ${
            diff > 0 ? 'text-amber-700' : diff < 0 ? 'text-emerald-700' : 'text-slate-500'
          }`}
        >
          {diff > 0 ? '+' : ''}
          {EGP(diff)}
        </div>
        <div className="text-xs text-slate-500">فرق السعر</div>
      </div>
    </div>
  );
}

// ============================================================================
// Details panel
// ============================================================================
function ReturnDetailsPanel({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['return', id],
    queryFn: () => returnsApi.get(id),
  });
  const [action, setAction] = useState<'approve' | 'refund' | 'reject' | null>(
    null,
  );

  if (isLoading || !data) return <LoadingState />;
  const r = data as ReturnDetails;
  const meta = STATUS_META[r.status];
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['return', id] });
    qc.invalidateQueries({ queryKey: ['returns'] });
  };

  return (
    <div className="card overflow-hidden">
      {/* header */}
      <div className="bg-gradient-to-br from-brand-500 to-purple-600 text-white p-5">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-xs opacity-80">رقم المرتجع</div>
            <div className="font-mono text-xl font-black">{r.return_no}</div>
            <div className="text-xs opacity-80 mt-1">
              مرتجع من فاتورة {r.invoice_no}
            </div>
          </div>
          <button onClick={onClose} className="text-white/80 hover:text-white">
            <ChevronLeft size={22} />
          </button>
        </div>
        <div
          className={`mt-3 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold border ${meta.color}`}
        >
          <meta.icon size={12} /> {meta.label}
        </div>
      </div>

      {/* body */}
      <div className="p-5 space-y-5">
        <div className="rounded-lg bg-slate-50 p-4">
          <div className="text-xs text-slate-500 mb-1">العميل</div>
          <div className="font-bold text-slate-800">
            {r.customer_name || '—'}
          </div>
          {r.customer_phone && (
            <div className="text-sm text-slate-600 font-mono">
              {r.customer_phone}
            </div>
          )}
        </div>

        <div className="grid grid-cols-3 gap-3">
          <Stat label="إجمالي المرتجع" value={EGP(r.total_refund)} />
          <Stat
            label="رسوم التخزين"
            value={EGP(r.restocking_fee)}
            tint="text-amber-700"
          />
          <Stat
            label="صافي المردود"
            value={EGP(r.net_refund)}
            tint="text-emerald-700"
          />
        </div>

        <section>
          <div className="font-bold text-slate-700 mb-2">السبب</div>
          <div className="p-3 rounded-lg bg-slate-50 text-sm">
            <b>{REASON_LABELS[r.reason]}</b>
            {r.reason_details && (
              <div className="mt-1 text-slate-600">{r.reason_details}</div>
            )}
          </div>
        </section>

        <section>
          <div className="font-bold text-slate-700 mb-2">الأصناف</div>
          <div className="space-y-2">
            {r.items.map((it) => (
              <div
                key={it.id}
                className="flex items-center justify-between p-3 rounded-lg bg-white border border-slate-200"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">
                    {it.product_name}
                  </div>
                  <div className="text-xs text-slate-500 font-mono">
                    {it.sku} {it.color && `• ${it.color}`}{' '}
                    {it.size && `• ${it.size}`}
                  </div>
                  <div className="text-xs mt-1">
                    <span
                      className={`px-1.5 py-0.5 rounded ${
                        it.condition === 'resellable'
                          ? 'bg-emerald-100 text-emerald-700'
                          : 'bg-rose-100 text-rose-700'
                      }`}
                    >
                      {CONDITION_LABELS[it.condition]}
                    </span>
                    {it.back_to_stock && (
                      <span className="mr-2 text-sky-700">
                        ↻ سيعود للمخزون
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-left">
                  <div className="font-bold">{EGP(it.refund_amount)}</div>
                  <div className="text-xs text-slate-500">
                    {it.quantity} × {EGP(it.unit_price)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Actions */}
        {r.status === 'pending' && (
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={() => setAction('approve')}
              className="btn-primary text-sm"
            >
              ✓ اعتماد
            </button>
            <button
              onClick={() => setAction('reject')}
              className="bg-rose-500 hover:bg-rose-600 text-white font-bold py-2 rounded-lg text-sm"
            >
              ✗ رفض
            </button>
          </div>
        )}
        {r.status === 'approved' && (
          <button
            onClick={() => setAction('refund')}
            className="btn-primary w-full"
          >
            💵 صرف المبلغ للعميل
          </button>
        )}

        {r.refund_method && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm flex items-center justify-between">
            <span>طريقة الصرف</span>
            <b>{METHOD_LABELS[r.refund_method]}</b>
          </div>
        )}
      </div>

      {action === 'approve' && (
        <ApproveModal
          returnId={r.id}
          onClose={() => setAction(null)}
          onSuccess={() => {
            setAction(null);
            refresh();
          }}
        />
      )}
      {action === 'refund' && (
        <RefundModal
          ret={r}
          onClose={() => setAction(null)}
          onSuccess={() => {
            setAction(null);
            refresh();
          }}
        />
      )}
      {action === 'reject' && (
        <RejectModal
          returnId={r.id}
          onClose={() => setAction(null)}
          onSuccess={() => {
            setAction(null);
            refresh();
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Create Return — step 1: look up invoice; step 2: pick items
// ============================================================================
function CreateReturnModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'by_invoice' | 'standalone'>('by_invoice');
  const [invoiceNo, setInvoiceNo] = useState('');
  const [lookup, setLookup] = useState<InvoiceLookup | null>(null);
  // Walk-in (standalone) return — list of {variant_id, product_name,
  // sku, quantity, unit_price, condition, back_to_stock}.
  const [walkinItems, setWalkinItems] = useState<any[]>([]);
  const [productQ, setProductQ] = useState('');
  const [variantPick, setVariantPick] = useState<any | null>(null);
  const [selectedItems, setSelectedItems] = useState<
    Record<
      string,
      {
        quantity: number;
        condition: ItemCondition;
        back_to_stock: boolean;
      }
    >
  >({});
  const [reason, setReason] = useState<ReturnReason>('other');
  const [reasonDetails, setReasonDetails] = useState('');
  const [restockingFee, setRestockingFee] = useState(0);
  const [refundMethod, setRefundMethod] = useState<PaymentMethod>('cash');
  const [notes, setNotes] = useState('');

  const lookupMut = useMutation({
    mutationFn: () => returnsApi.lookupInvoice(invoiceNo),
    onSuccess: (d) => setLookup(d),
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'الفاتورة غير موجودة'),
  });

  const selectedLines = useMemo(() => {
    if (!lookup) return [] as (InvoiceLookupItem & {
      quantity: number;
      condition: ItemCondition;
      back_to_stock: boolean;
      refund_amount: number;
    })[];
    return lookup.items
      .filter((it) => selectedItems[it.invoice_item_id]?.quantity > 0)
      .map((it) => {
        const sel = selectedItems[it.invoice_item_id];
        return {
          ...it,
          quantity: sel.quantity,
          condition: sel.condition,
          back_to_stock: sel.back_to_stock,
          refund_amount: sel.quantity * Number(it.unit_price),
        };
      });
  }, [lookup, selectedItems]);

  const total = selectedLines.reduce((s, l) => s + l.refund_amount, 0);
  const net = Math.max(0, total - restockingFee);

  const walkinTotal = walkinItems.reduce(
    (s, i) => s + Number(i.quantity || 0) * Number(i.unit_price || 0),
    0,
  );
  const walkinNet = Math.max(0, walkinTotal - restockingFee);

  const createMut = useMutation({
    mutationFn: () => {
      if (mode === 'standalone') {
        if (walkinItems.length === 0)
          return Promise.reject(new Error('أضف صنف واحد على الأقل'));
        return returnsApi.createReturn({
          original_invoice_id: undefined as any,
          items: walkinItems.map((i) => ({
            variant_id: i.variant_id,
            quantity: Number(i.quantity || 1),
            unit_price: Number(i.unit_price || 0),
            refund_amount:
              Number(i.quantity || 1) * Number(i.unit_price || 0),
            condition: i.condition || 'resellable',
            back_to_stock: i.back_to_stock ?? true,
          })) as any,
          reason,
          reason_details: reasonDetails || undefined,
          restocking_fee: restockingFee,
          refund_method: refundMethod,
          notes: notes || undefined,
        } as any);
      }
      return returnsApi.createReturn({
        original_invoice_id: lookup!.invoice.id,
        items: selectedLines.map((l) => ({
          original_invoice_item_id: l.invoice_item_id,
          variant_id: l.variant_id,
          quantity: l.quantity,
          unit_price: Number(l.unit_price),
          refund_amount: l.refund_amount,
          condition: l.condition,
          back_to_stock: l.back_to_stock,
        })),
        reason,
        reason_details: reasonDetails || undefined,
        restocking_fee: restockingFee,
        refund_method: refundMethod,
        notes: notes || undefined,
      });
    },
    onSuccess: (r) => {
      toast.success(`تم إنشاء المرتجع ${r.return_no}`);
      qc.invalidateQueries({ queryKey: ['returns'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || e?.message || 'فشل إنشاء المرتجع'),
  });

  return (
    <Modal title="مرتجع جديد" onClose={onClose} size="xl">
      {/* Mode switch — from invoice vs standalone walk-in */}
      <div className="inline-flex rounded-lg bg-slate-100 p-1 mb-4 text-xs">
        <button
          type="button"
          className={`px-3 py-1.5 rounded-md font-bold ${
            mode === 'by_invoice'
              ? 'bg-white text-indigo-700 shadow-sm'
              : 'text-slate-600'
          }`}
          onClick={() => setMode('by_invoice')}
        >
          مرتجع من فاتورة
        </button>
        <button
          type="button"
          className={`px-3 py-1.5 rounded-md font-bold ${
            mode === 'standalone'
              ? 'bg-white text-indigo-700 shadow-sm'
              : 'text-slate-600'
          }`}
          onClick={() => setMode('standalone')}
        >
          مرتجع مباشر (بدون فاتورة)
        </button>
      </div>

      {/* Step 1: Invoice lookup */}
      {mode === 'by_invoice' && !lookup && (
        <div>
          <Field label="رقم الفاتورة — اكتب الرقم واضغط Enter">
            <div className="flex gap-2">
              <input
                value={invoiceNo}
                onChange={(e) => setInvoiceNo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && invoiceNo.trim()) {
                    e.preventDefault();
                    lookupMut.mutate();
                  }
                }}
                placeholder="مثال: INV-2026-0000001"
                className="input flex-1 font-mono"
                autoFocus
              />
              <button
                onClick={() => lookupMut.mutate()}
                disabled={!invoiceNo || lookupMut.isPending}
                className="btn-primary flex items-center gap-2"
              >
                <Search size={16} />
                {lookupMut.isPending ? 'جاري...' : 'بحث'}
              </button>
            </div>
          </Field>
          <div className="mt-6 p-4 bg-slate-50 rounded-lg text-sm text-slate-600">
            <AlertCircle className="inline ml-2" size={16} /> أدخل رقم فاتورة
            مكتملة/مدفوعة لاختيار الأصناف التي يرغب العميل في إرجاعها.
          </div>
        </div>
      )}

      {/* Standalone walk-in return — no invoice needed */}
      {mode === 'standalone' && (
        <WalkinReturnForm
          items={walkinItems}
          setItems={setWalkinItems}
          productQ={productQ}
          setProductQ={setProductQ}
          variantPick={variantPick}
          setVariantPick={setVariantPick}
          reason={reason}
          setReason={setReason}
          reasonDetails={reasonDetails}
          setReasonDetails={setReasonDetails}
          restockingFee={restockingFee}
          setRestockingFee={setRestockingFee}
          refundMethod={refundMethod}
          setRefundMethod={setRefundMethod}
          notes={notes}
          setNotes={setNotes}
          total={walkinTotal}
          net={walkinNet}
          onSubmit={() => createMut.mutate()}
          submitting={createMut.isPending}
        />
      )}

      {/* Step 2: Select items */}
      {mode === 'by_invoice' && lookup && (
        <>
          <div className="p-4 bg-brand-50 border border-brand-200 rounded-lg flex items-center justify-between mb-4">
            <div>
              <div className="font-mono font-bold">
                {lookup.invoice.invoice_no}
              </div>
              <div className="text-sm text-slate-600">
                {lookup.invoice.customer_name || '—'}{' '}
                {lookup.invoice.customer_phone &&
                  `• ${lookup.invoice.customer_phone}`}
              </div>
            </div>
            <div className="text-left">
              <div className="font-bold">{EGP(lookup.invoice.grand_total)}</div>
              <div className="text-xs text-slate-500">
                {new Date(lookup.invoice.completed_at).toLocaleDateString(
                  'en-US',
                )}
              </div>
            </div>
          </div>

          <div className="space-y-2 mb-5">
            {lookup.items.map((it) => {
              const sel = selectedItems[it.invoice_item_id];
              const available = it.available_to_return;
              const disabled = available <= 0;
              return (
                <div
                  key={it.invoice_item_id}
                  className={`p-3 rounded-lg border ${
                    sel && sel.quantity > 0
                      ? 'border-brand-300 bg-brand-50/40'
                      : 'border-slate-200'
                  } ${disabled ? 'opacity-50' : ''}`}
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={!!sel && sel.quantity > 0}
                      onChange={(e) => {
                        setSelectedItems((s) => ({
                          ...s,
                          [it.invoice_item_id]: e.target.checked
                            ? {
                                quantity: available,
                                condition: 'resellable',
                                back_to_stock: true,
                              }
                            : { quantity: 0, condition: 'resellable', back_to_stock: true },
                        }));
                      }}
                      className="w-4 h-4"
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold truncate">
                        {it.product_name}
                      </div>
                      <div className="text-xs text-slate-500 font-mono">
                        {it.sku} {it.color && `• ${it.color}`}{' '}
                        {it.size && `• ${it.size}`}
                      </div>
                      <div className="text-xs mt-1">
                        متاح للإرجاع: <b>{available}</b> من أصل{' '}
                        {it.original_quantity}
                      </div>
                    </div>
                    <div className="text-left font-bold">
                      {EGP(it.unit_price)}
                    </div>
                  </div>

                  {sel && sel.quantity > 0 && (
                    <div className="mt-3 grid grid-cols-3 gap-2 items-end">
                      <Field label="الكمية">
                        <input
                          type="number"
                          min={1}
                          max={available}
                          value={sel.quantity}
                          onChange={(e) =>
                            setSelectedItems((s) => ({
                              ...s,
                              [it.invoice_item_id]: {
                                ...sel,
                                quantity: Math.min(
                                  Math.max(1, Number(e.target.value)),
                                  available,
                                ),
                              },
                            }))
                          }
                          className="input w-full text-center"
                        />
                      </Field>
                      <Field label="الحالة">
                        <select
                          value={sel.condition}
                          onChange={(e) =>
                            setSelectedItems((s) => ({
                              ...s,
                              [it.invoice_item_id]: {
                                ...sel,
                                condition: e.target.value as ItemCondition,
                                back_to_stock: e.target.value === 'resellable',
                              },
                            }))
                          }
                          className="input w-full"
                        >
                          {Object.entries(CONDITION_LABELS).map(([k, v]) => (
                            <option key={k} value={k}>
                              {v}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <label className="text-sm flex items-center gap-1.5 pb-2">
                        <input
                          type="checkbox"
                          checked={sel.back_to_stock}
                          onChange={(e) =>
                            setSelectedItems((s) => ({
                              ...s,
                              [it.invoice_item_id]: {
                                ...sel,
                                back_to_stock: e.target.checked,
                              },
                            }))
                          }
                        />
                        إرجاع للمخزون
                      </label>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Form */}
          <div className="grid grid-cols-2 gap-4">
            <Field label="سبب الإرجاع">
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value as ReturnReason)}
                className="input w-full"
              >
                {Object.entries(REASON_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="طريقة الصرف">
              <select
                value={refundMethod}
                onChange={(e) =>
                  setRefundMethod(e.target.value as PaymentMethod)
                }
                className="input w-full"
              >
                {Object.entries(METHOD_LABELS).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="تفاصيل السبب" className="mt-3">
            <textarea
              value={reasonDetails}
              onChange={(e) => setReasonDetails(e.target.value)}
              className="input w-full"
              rows={2}
            />
          </Field>

          <div className="grid grid-cols-2 gap-4 mt-3">
            <Field label="رسوم التخزين (اختياري)">
              <input
                type="number"
                min={0}
                value={restockingFee}
                onChange={(e) =>
                  setRestockingFee(Math.max(0, Number(e.target.value)))
                }
                className="input w-full"
              />
            </Field>
            <Field label="ملاحظات">
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="input w-full"
              />
            </Field>
          </div>

          <div className="mt-5 p-4 rounded-lg bg-brand-50 border border-brand-100 space-y-1">
            <div className="flex justify-between">
              <span className="text-slate-600">إجمالي الإرجاع</span>
              <b>{EGP(total)}</b>
            </div>
            {restockingFee > 0 && (
              <div className="flex justify-between text-amber-700">
                <span>رسوم التخزين</span>
                <b>-{EGP(restockingFee)}</b>
              </div>
            )}
            <div className="flex justify-between border-t border-brand-200 pt-1 mt-1">
              <span className="font-bold">صافي المردود</span>
              <span className="text-2xl font-black text-emerald-700">
                {EGP(net)}
              </span>
            </div>
          </div>

          <div className="mt-5 flex gap-2 justify-end">
            <button
              onClick={() => setLookup(null)}
              className="btn-secondary"
            >
              ← فاتورة أخرى
            </button>
            <button className="btn-secondary" onClick={onClose}>
              إلغاء
            </button>
            <button
              disabled={selectedLines.length === 0 || createMut.isPending}
              onClick={() => createMut.mutate()}
              className="btn-primary disabled:opacity-50"
            >
              {createMut.isPending ? 'جاري الحفظ...' : 'إنشاء المرتجع'}
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

// ============================================================================
// Create Exchange modal — returned lines from invoice + new lines picked
// via the products catalog. Settles any price difference in one call.
// ============================================================================
function CreateExchangeModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [invoiceNo, setInvoiceNo] = useState('');
  const [lookup, setLookup] = useState<InvoiceLookup | null>(null);
  const [returnedQtys, setReturnedQtys] = useState<Record<string, number>>({});
  const [newItems, setNewItems] = useState<any[]>([]);
  const [productQ, setProductQ] = useState('');
  const [variantPick, setVariantPick] = useState<any | null>(null);
  const [reason, setReason] = useState<ReturnReason>('wrong_size');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('cash');
  const [refundMethod, setRefundMethod] = useState<PaymentMethod>('cash');
  const [notes, setNotes] = useState('');
  // PR-R1 — explicit cash source for the cash leg of the exchange.
  // Used only when the price difference is non-zero AND the chosen
  // method for the relevant direction is 'cash'. Equal exchanges and
  // non-cash differences ignore it.
  const [cashSource, setCashSource] = useState<CashSource>({
    mode: 'unset',
    shift_id: null,
    cashbox_id: null,
  });

  const lookupMut = useMutation({
    mutationFn: () => returnsApi.lookupInvoice(invoiceNo),
    onSuccess: (d) => setLookup(d),
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'الفاتورة غير موجودة'),
  });

  const { data: searchRes } = useQuery({
    queryKey: ['products-for-exchange', productQ],
    queryFn: () =>
      productsApi.list({ q: productQ || undefined, limit: 500 }),
    enabled: productQ.length >= 1,
  });

  // Returned value from the selected invoice lines.
  const returnedLines = useMemo(() => {
    if (!lookup) return [];
    return lookup.items
      .filter((i) => (returnedQtys[i.invoice_item_id] || 0) > 0)
      .map((i) => ({
        ...i,
        quantity: returnedQtys[i.invoice_item_id],
        line_total:
          returnedQtys[i.invoice_item_id] * Number(i.unit_price),
      }));
  }, [lookup, returnedQtys]);

  const returnedValue = returnedLines.reduce((s, l) => s + l.line_total, 0);
  const newValue = newItems.reduce(
    (s, i) => s + Number(i.quantity || 0) * Number(i.unit_price || 0),
    0,
  );
  const diff = newValue - returnedValue;

  const pushNewItem = (p: any, v: any) => {
    if (newItems.find((i) => i.variant_id === v.id)) {
      toast.error('الصنف مضاف بالفعل');
      return;
    }
    setNewItems((prev) => [
      ...prev,
      {
        variant_id: v.id,
        product_name: p.name_ar,
        sku: v.sku || '',
        color: v.color,
        size: v.size,
        quantity: 1,
        unit_price: Number(
          v.selling_price ?? v.price_override ?? p.base_price ?? 0,
        ),
      },
    ]);
    setProductQ('');
    setVariantPick(null);
  };

  const onEnterCode = async () => {
    const code = productQ.trim();
    if (!code) return;
    try {
      const { product, variant } = await productsApi.byBarcode(code);
      pushNewItem(product, variant);
    } catch {
      toast.error(`الكود ${code} غير موجود`);
    }
  };

  const pickProduct = async (p: any) => {
    try {
      const full = await productsApi.get(p.id);
      const vs = (full.variants || []).filter(
        (v: any) => v.is_active !== false,
      );
      if (vs.length === 0) return toast.error('المنتج بدون متغيرات نشطة');
      if (vs.length === 1) return pushNewItem(full, vs[0]);
      setVariantPick({ product: full, variants: vs });
    } catch {
      toast.error('فشل تحميل المتغيرات');
    }
  };

  // PR-R1 — when the cash leg is required (non-zero diff + cash method
  // for the relevant direction) the operator must pick a source.
  const needsCashSource =
    (diff < 0 && refundMethod === 'cash') ||
    (diff > 0 && paymentMethod === 'cash');

  const submitMut = useMutation({
    mutationFn: () => {
      if (!lookup) return Promise.reject(new Error('ابحث عن الفاتورة أولاً'));
      if (returnedLines.length === 0)
        return Promise.reject(new Error('اختر الأصناف المُرجعة من الفاتورة'));
      if (newItems.length === 0)
        return Promise.reject(new Error('أضف الأصناف الجديدة'));
      if (needsCashSource && cashSource.mode === 'unset') {
        return Promise.reject(
          new Error('اختر مصدر/وجهة النقدية للفرق'),
        );
      }
      return returnsApi.exchange({
        original_invoice_id: lookup.invoice.id,
        returned_items: returnedLines.map((l) => ({
          variant_id: l.variant_id,
          quantity: l.quantity,
          unit_price: Number(l.unit_price),
        })),
        new_items: newItems.map((i) => ({
          variant_id: i.variant_id,
          quantity: Number(i.quantity || 1),
          unit_price: Number(i.unit_price || 0),
        })),
        payment_method: diff > 0 ? paymentMethod : undefined,
        refund_method: diff < 0 ? refundMethod : undefined,
        reason,
        notes: notes || undefined,
        ...(needsCashSource && cashSource.mode === 'open_shift'
          ? { shift_id: cashSource.shift_id }
          : {}),
        ...(needsCashSource && cashSource.mode === 'direct_cashbox'
          ? { cashbox_id: cashSource.cashbox_id }
          : {}),
      });
    },
    onSuccess: (r) => {
      toast.success(`تم الاستبدال ${r.exchange_no}`);
      qc.invalidateQueries({ queryKey: ['exchanges'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || e?.message || 'فشل الاستبدال'),
  });

  return (
    <Modal title="استبدال جديد" onClose={onClose} size="xl">
      {/* Step 1 — invoice lookup */}
      {!lookup && (
        <div>
          <Field label="رقم فاتورة البيع الأصلية — اكتب واضغط Enter">
            <div className="flex gap-2">
              <input
                autoFocus
                className="input flex-1 font-mono"
                placeholder="INV-2026-000…"
                value={invoiceNo}
                onChange={(e) => setInvoiceNo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && invoiceNo.trim()) {
                    e.preventDefault();
                    lookupMut.mutate();
                  }
                }}
              />
              <button
                onClick={() => lookupMut.mutate()}
                disabled={!invoiceNo || lookupMut.isPending}
                className="btn-primary"
              >
                <Search size={16} />
                {lookupMut.isPending ? 'جاري...' : 'بحث'}
              </button>
            </div>
          </Field>
          <div className="mt-4 p-4 bg-slate-50 rounded-lg text-sm text-slate-600">
            <AlertCircle className="inline ml-1" size={14} /> الاستبدال يرد
            الأصناف القديمة للمخزون ويصدر فاتورة بيع جديدة للأصناف
            المستبدلة، والفرق يُحصَّل أو يُسترد حسب القيمة.
          </div>
        </div>
      )}

      {/* Step 2 — pick returned + new items */}
      {lookup && (
        <div className="space-y-4">
          {/* Invoice header */}
          <div className="p-3 bg-brand-50 border border-brand-200 rounded-lg flex items-center justify-between">
            <div>
              <div className="font-mono font-bold">
                {lookup.invoice.invoice_no}
              </div>
              <div className="text-xs text-slate-600">
                {lookup.invoice.customer_name || 'عميل عابر'}
                {lookup.invoice.customer_phone &&
                  ` · ${lookup.invoice.customer_phone}`}
              </div>
            </div>
            <div className="text-left">
              <div className="font-bold">{EGP(lookup.invoice.grand_total)}</div>
            </div>
          </div>

          {/* Returned items */}
          <section>
            <div className="font-bold text-sm text-slate-700 mb-2">
              الأصناف المُرجعة من الفاتورة
            </div>
            <div className="space-y-1.5">
              {lookup.items.map((it) => {
                const available = it.available_to_return;
                const disabled = available <= 0;
                const q = returnedQtys[it.invoice_item_id] || 0;
                return (
                  <div
                    key={it.invoice_item_id}
                    className={`p-2 rounded-lg border flex items-center gap-3 text-xs ${
                      q > 0
                        ? 'bg-rose-50 border-rose-200'
                        : 'bg-white border-slate-200'
                    } ${disabled ? 'opacity-50' : ''}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-bold">{it.product_name}</div>
                      <div className="text-[10px] text-slate-500 font-mono">
                        {it.sku}
                        {[it.color, it.size].filter(Boolean).length > 0 &&
                          ` · ${[it.color, it.size].filter(Boolean).join(' · ')}`}
                      </div>
                    </div>
                    <div className="text-[10px] text-slate-500">
                      متاح: {available}
                    </div>
                    <input
                      type="number"
                      min={0}
                      max={available}
                      disabled={disabled}
                      value={q}
                      onChange={(e) => {
                        const n = Math.min(
                          available,
                          Math.max(0, Number(e.target.value) || 0),
                        );
                        setReturnedQtys((prev) => ({
                          ...prev,
                          [it.invoice_item_id]: n,
                        }));
                      }}
                      className="input w-16 text-center py-1"
                    />
                    <div className="w-20 text-left font-mono text-slate-600">
                      {EGP(Number(it.unit_price) * q)}
                    </div>
                  </div>
                );
              })}
            </div>
          </section>

          {/* New items picker */}
          <section>
            <div className="font-bold text-sm text-slate-700 mb-2">
              الأصناف الجديدة
            </div>
            <div className="relative">
              <input
                type="search"
                value={productQ}
                onChange={(e) => setProductQ(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    onEnterCode();
                  }
                }}
                placeholder="اكتب الكود واضغط Enter أو ابحث بالاسم لاختيار لون/مقاس…"
                className="input w-full"
              />
              {searchRes && searchRes.data?.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 max-h-60 overflow-auto">
                  {(() => {
                    const q = productQ.trim().toLowerCase();
                    const exact = q
                      ? searchRes.data.find(
                          (p: any) =>
                            (p.sku_root || '').toLowerCase() === q,
                        )
                      : null;
                    const rest = exact
                      ? searchRes.data.filter((p: any) => p.id !== exact.id)
                      : searchRes.data;
                    return (
                      <>
                        {exact && (
                          <button
                            onClick={() => pickProduct(exact)}
                            className="w-full text-right p-2 bg-emerald-50 hover:bg-emerald-100 border-b border-emerald-200 flex justify-between"
                          >
                            <div className="font-black">
                              ✓ {exact.name_ar}
                            </div>
                            <div className="font-bold text-emerald-700">
                              {EGP(exact.base_price)}
                            </div>
                          </button>
                        )}
                        {rest.map((p: any) => (
                          <button
                            key={p.id}
                            onClick={() => pickProduct(p)}
                            className="w-full text-right p-2 hover:bg-brand-50 border-b last:border-b-0 border-slate-100 flex justify-between"
                          >
                            <div>
                              <div className="font-medium">{p.name_ar}</div>
                              <div className="text-xs text-slate-400 font-mono">
                                {p.sku_root}
                              </div>
                            </div>
                            <div className="font-bold text-brand-600">
                              {EGP(p.base_price)}
                            </div>
                          </button>
                        ))}
                      </>
                    );
                  })()}
                </div>
              )}
            </div>

            {variantPick && (
              <div className="mt-2 p-3 border-2 border-indigo-200 bg-indigo-50/60 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <div className="text-sm font-black text-indigo-800">
                    اختر اللون والمقاس — {variantPick.product.name_ar}
                  </div>
                  <button
                    onClick={() => setVariantPick(null)}
                    className="p-1 hover:bg-indigo-100 rounded"
                  >
                    ✕
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {variantPick.variants.map((v: any) => (
                    <button
                      key={v.id}
                      onClick={() => pushNewItem(variantPick.product, v)}
                      className="px-2 py-1.5 rounded-lg bg-white border border-indigo-200 hover:border-indigo-400 text-xs"
                    >
                      {[v.color, v.size].filter(Boolean).join(' · ') ||
                        v.sku ||
                        '—'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {newItems.length > 0 && (
              <div className="mt-2 space-y-1.5">
                {newItems.map((it, idx) => (
                  <div
                    key={it.variant_id}
                    className="p-2 rounded-lg border border-emerald-200 bg-emerald-50 flex items-center gap-3 text-xs"
                  >
                    <div className="flex-1 min-w-0">
                      <div className="font-bold">{it.product_name}</div>
                      <div className="text-[10px] text-slate-500 font-mono">
                        {it.sku}
                        {[it.color, it.size].filter(Boolean).length > 0 &&
                          ` · ${[it.color, it.size].filter(Boolean).join(' · ')}`}
                      </div>
                    </div>
                    <input
                      type="number"
                      min={1}
                      value={it.quantity}
                      onChange={(e) => {
                        const n = Math.max(1, Number(e.target.value) || 1);
                        setNewItems((p) =>
                          p.map((x, i) =>
                            i === idx ? { ...x, quantity: n } : x,
                          ),
                        );
                      }}
                      className="input w-16 text-center py-1"
                    />
                    <input
                      type="number"
                      step="0.01"
                      value={it.unit_price}
                      onChange={(e) =>
                        setNewItems((p) =>
                          p.map((x, i) =>
                            i === idx
                              ? {
                                  ...x,
                                  unit_price: Number(e.target.value) || 0,
                                }
                              : x,
                          ),
                        )
                      }
                      className="input w-20 text-center py-1"
                    />
                    <div className="w-20 text-left font-mono">
                      {EGP(it.quantity * it.unit_price)}
                    </div>
                    <button
                      onClick={() =>
                        setNewItems((p) => p.filter((_, i) => i !== idx))
                      }
                      className="text-rose-600 hover:bg-rose-100 rounded p-1"
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* Price diff + settlement */}
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">قيمة المُرجع</span>
              <span className="font-mono tabular-nums text-rose-700">
                {EGP(returnedValue)}
              </span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-600">قيمة الأصناف الجديدة</span>
              <span className="font-mono tabular-nums text-emerald-700">
                {EGP(newValue)}
              </span>
            </div>
            <div className="flex items-center justify-between text-base font-black border-t border-slate-300 pt-2">
              <span>
                {diff > 0
                  ? 'مستحق على العميل'
                  : diff < 0
                    ? 'مسترد للعميل'
                    : 'لا فرق'}
              </span>
              <span
                className={`font-mono tabular-nums ${
                  diff > 0
                    ? 'text-amber-700'
                    : diff < 0
                      ? 'text-indigo-700'
                      : 'text-slate-500'
                }`}
              >
                {EGP(Math.abs(diff))}
              </span>
            </div>
          </div>

          {/* Settlement method */}
          {diff > 0 && (
            <Field label="طريقة تحصيل الفرق">
              <select
                value={paymentMethod}
                onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
                className="input"
              >
                {Object.entries(METHOD_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {diff < 0 && (
            <Field label="طريقة صرف الفرق">
              <select
                value={refundMethod}
                onChange={(e) => setRefundMethod(e.target.value as PaymentMethod)}
                className="input"
              >
                {Object.entries(METHOD_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
          )}
          {needsCashSource && (
            <div className="mt-3">
              <div className="text-xs font-bold text-slate-700 dark:text-slate-200 mb-1">
                {diff < 0
                  ? 'مصدر صرف فرق الاستبدال (نقدي)'
                  : 'وجهة تحصيل فرق الاستبدال (نقدي)'}
              </div>
              <CashSourceSelector
                value={cashSource}
                onChange={setCashSource}
                disabled={submitMut.isPending}
              />
            </div>
          )}
          <div className="grid md:grid-cols-2 gap-3">
            <Field label="سبب الاستبدال">
              <select
                value={reason}
                onChange={(e) => setReason(e.target.value as ReturnReason)}
                className="input"
              >
                {Object.entries(REASON_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="ملاحظات">
              <input
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="input"
              />
            </Field>
          </div>

          <button
            onClick={() => submitMut.mutate()}
            disabled={
              submitMut.isPending ||
              returnedLines.length === 0 ||
              newItems.length === 0
            }
            className="btn-primary w-full"
          >
            {submitMut.isPending ? 'جاري الاستبدال...' : 'تأكيد الاستبدال'}
          </button>
        </div>
      )}
    </Modal>
  );
}

// ============================================================================
// Action modals
// ============================================================================
function ApproveModal({
  returnId,
  onClose,
  onSuccess,
}: {
  returnId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [notes, setNotes] = useState('');
  const mut = useMutation({
    mutationFn: () => returnsApi.approve(returnId, notes || undefined),
    onSuccess: () => {
      toast.success('تم اعتماد المرتجع وإعادة المخزون');
      onSuccess();
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'خطأ'),
  });
  return (
    <Modal title="اعتماد المرتجع" onClose={onClose}>
      <div className="p-3 rounded-lg bg-sky-50 border border-sky-200 text-sm mb-4">
        سيتم إعادة الأصناف القابلة لإعادة البيع إلى المخزون تلقائياً.
      </div>
      <Field label="ملاحظة (اختيارية)">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="input w-full"
          rows={3}
        />
      </Field>
      <div className="mt-5 flex gap-2 justify-end">
        <button className="btn-secondary" onClick={onClose}>
          إلغاء
        </button>
        <button
          disabled={mut.isPending}
          onClick={() => mut.mutate()}
          className="btn-primary"
        >
          {mut.isPending ? 'جاري...' : 'اعتماد'}
        </button>
      </div>
    </Modal>
  );
}

function RefundModal({
  ret,
  onClose,
  onSuccess,
}: {
  ret: ReturnDetails;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [method, setMethod] = useState<PaymentMethod>(
    ret.refund_method || 'cash',
  );
  const [reference, setReference] = useState('');
  // PR-R1 — explicit cash source. Default to 'unset'; CashSourceSelector
  // will pre-pick the user's open shift when there's exactly one.
  const [source, setSource] = useState<CashSource>({
    mode: 'unset',
    shift_id: null,
    cashbox_id: null,
  });
  const isCash = method === 'cash';
  const ready = !isCash || source.mode !== 'unset';
  const mut = useMutation({
    mutationFn: () =>
      returnsApi.refund(ret.id, {
        refund_method: method,
        reference,
        ...(isCash && source.mode === 'open_shift'
          ? { shift_id: source.shift_id }
          : {}),
        ...(isCash && source.mode === 'direct_cashbox'
          ? { cashbox_id: source.cashbox_id }
          : {}),
      }),
    onSuccess: () => {
      toast.success('تم صرف المبلغ للعميل');
      onSuccess();
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'خطأ'),
  });
  return (
    <Modal title="صرف المرتجع" onClose={onClose}>
      <div className="p-4 rounded-lg bg-emerald-50 border border-emerald-200 text-center mb-4">
        <div className="text-sm text-emerald-700">المبلغ المستحق للعميل</div>
        <div className="text-3xl font-black text-emerald-700">
          {EGP(ret.net_refund)}
        </div>
      </div>
      <Field label="طريقة الصرف">
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value as PaymentMethod)}
          className="input w-full"
        >
          {Object.entries(METHOD_LABELS).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </select>
      </Field>
      {method !== 'cash' && (
        <Field label="رقم المرجع" className="mt-3">
          <input
            value={reference}
            onChange={(e) => setReference(e.target.value)}
            className="input w-full"
          />
        </Field>
      )}
      {isCash && (
        <div className="mt-3">
          <CashSourceSelector
            value={source}
            onChange={setSource}
            disabled={mut.isPending}
          />
        </div>
      )}
      <div className="mt-5 flex gap-2 justify-end">
        <button className="btn-secondary" onClick={onClose}>
          إلغاء
        </button>
        <button
          disabled={mut.isPending || !ready}
          onClick={() => mut.mutate()}
          className="btn-primary"
        >
          {mut.isPending ? 'جاري...' : 'تأكيد الصرف'}
        </button>
      </div>
    </Modal>
  );
}

function RejectModal({
  returnId,
  onClose,
  onSuccess,
}: {
  returnId: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [reason, setReason] = useState('');
  const mut = useMutation({
    mutationFn: () => returnsApi.reject(returnId, reason),
    onSuccess: () => {
      toast.success('تم رفض المرتجع');
      onSuccess();
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'خطأ'),
  });
  return (
    <Modal title="رفض المرتجع" onClose={onClose}>
      <Field label="سبب الرفض *">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="input w-full"
          rows={3}
        />
      </Field>
      <div className="mt-5 flex gap-2 justify-end">
        <button className="btn-secondary" onClick={onClose}>
          تراجع
        </button>
        <button
          disabled={!reason || mut.isPending}
          onClick={() => mut.mutate()}
          className="bg-rose-500 hover:bg-rose-600 text-white font-bold px-5 py-2 rounded-lg disabled:opacity-50"
        >
          {mut.isPending ? 'جاري...' : 'تأكيد الرفض'}
        </button>
      </div>
    </Modal>
  );
}

// ============================================================================
// Shared UI
// ============================================================================
function KpiCard({
  label,
  value,
  icon: Icon,
  tint,
}: {
  label: string;
  value: string;
  icon: any;
  tint: string;
}) {
  return (
    <div className="card p-5 flex items-center gap-4">
      <div
        className={`w-12 h-12 rounded-xl bg-gradient-to-br ${tint} text-white flex items-center justify-center`}
      >
        <Icon size={22} />
      </div>
      <div>
        <div className="text-sm text-slate-500">{label}</div>
        <div className="text-2xl font-black text-slate-900">{value}</div>
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  tint = 'text-slate-900',
}: {
  label: string;
  value: string;
  tint?: string;
}) {
  return (
    <div className="p-3 rounded-lg bg-slate-50">
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`text-lg font-black ${tint}`}>{value}</div>
    </div>
  );
}

function Field({
  label,
  children,
  className = '',
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={`block ${className}`}>
      <span className="block text-sm font-semibold text-slate-700 mb-1.5">
        {label}
      </span>
      {children}
    </label>
  );
}

function LoadingState() {
  return <div className="p-12 text-center text-slate-400">جاري التحميل...</div>;
}

function EmptyState({
  tab,
  onCreate,
}: {
  tab: 'returns' | 'exchanges';
  onCreate: () => void;
}) {
  return (
    <div className="p-16 text-center">
      <div className="text-6xl mb-4">{tab === 'returns' ? '↩️' : '🔄'}</div>
      <h3 className="text-xl font-bold text-slate-800 mb-2">
        {tab === 'returns' ? 'لا توجد مرتجعات' : 'لا توجد عمليات استبدال'}
      </h3>
      <p className="text-slate-500 mb-5">
        {tab === 'returns'
          ? 'ابدأ بتسجيل أول مرتجع من فاتورة بيع'
          : 'لم يتم تسجيل أي عملية استبدال بعد'}
      </p>
      <button onClick={onCreate} className="btn-primary">
        <Plus size={18} className="inline ml-1" />{' '}
        {tab === 'returns' ? 'مرتجع جديد' : 'استبدال جديد'}
      </button>
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
  size = 'md',
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
  size?: 'md' | 'xl';
}) {
  return (
    <div
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full ${
          size === 'xl' ? 'max-w-4xl' : 'max-w-lg'
        } max-h-[90vh] overflow-y-auto`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-slate-100 px-6 py-4 flex items-center justify-between">
          <h3 className="text-lg font-black text-slate-900">{title}</h3>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
          >
            <XCircle size={22} />
          </button>
        </div>
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}

/* ───────── Walk-in (standalone) return form ───────── */

function WalkinReturnForm(props: {
  items: any[];
  setItems: (v: any[] | ((prev: any[]) => any[])) => void;
  productQ: string;
  setProductQ: (s: string) => void;
  variantPick: any;
  setVariantPick: (v: any) => void;
  reason: ReturnReason;
  setReason: (r: ReturnReason) => void;
  reasonDetails: string;
  setReasonDetails: (s: string) => void;
  restockingFee: number;
  setRestockingFee: (n: number) => void;
  refundMethod: PaymentMethod;
  setRefundMethod: (m: PaymentMethod) => void;
  notes: string;
  setNotes: (s: string) => void;
  total: number;
  net: number;
  onSubmit: () => void;
  submitting: boolean;
}) {
  const { data: products } = useQuery({
    queryKey: ['products-for-returns', props.productQ],
    queryFn: () =>
      productsApi.list({ q: props.productQ || undefined, limit: 500 }),
    enabled: props.productQ.length >= 1,
  });

  const pushItem = (p: any, v: any) => {
    if (props.items.find((i) => i.variant_id === v.id)) {
      toast.error('الصنف مضاف بالفعل');
      return;
    }
    props.setItems((prev) => [
      ...prev,
      {
        variant_id: v.id,
        product_name: p.name_ar,
        sku: v.sku || '',
        color: v.color,
        size: v.size,
        quantity: 1,
        unit_price: Number(v.selling_price ?? v.price_override ?? p.base_price ?? 0),
        condition: 'resellable' as ItemCondition,
        back_to_stock: true,
      },
    ]);
    props.setProductQ('');
    props.setVariantPick(null);
  };

  const onEnter = async () => {
    const code = props.productQ.trim();
    if (!code) return;
    try {
      const { product, variant } = await productsApi.byBarcode(code);
      pushItem(product, variant);
    } catch {
      toast.error(`الكود ${code} غير موجود`);
    }
  };

  const pickProduct = async (p: any) => {
    try {
      const full = await productsApi.get(p.id);
      const vs = (full.variants || []).filter((v: any) => v.is_active !== false);
      if (vs.length === 0) return toast.error('المنتج بدون متغيرات نشطة');
      if (vs.length === 1) return pushItem(full, vs[0]);
      props.setVariantPick({ product: full, variants: vs });
    } catch {
      toast.error('فشل تحميل المتغيرات');
    }
  };

  return (
    <div className="space-y-4">
      <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-900">
        <AlertCircle className="inline ml-2" size={16} />
        مرتجع بدون فاتورة — اختر الأصناف مباشرة. الصنف سيعود للمخزون لو
        "قابل لإعادة البيع".
      </div>

      {/* Search */}
      <div className="relative">
        <input
          type="search"
          value={props.productQ}
          onChange={(e) => props.setProductQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              onEnter();
            }
          }}
          placeholder="اكتب كود المنتج واضغط Enter أو ابحث بالاسم"
          className="input w-full"
        />
        {products && products.data?.length > 0 && (
          <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 max-h-60 overflow-auto">
            {(() => {
              const q = props.productQ.trim().toLowerCase();
              const exact = q
                ? products.data.find(
                    (p: any) => (p.sku_root || '').toLowerCase() === q,
                  )
                : null;
              const rest = exact
                ? products.data.filter((p: any) => p.id !== exact.id)
                : products.data;
              return (
                <>
                  {exact && (
                    <button
                      onClick={() => pickProduct(exact)}
                      className="w-full text-right p-2.5 bg-emerald-50 hover:bg-emerald-100 border-b border-emerald-200 flex justify-between"
                    >
                      <div>
                        <div className="font-black">
                          ✓ {exact.name_ar}
                        </div>
                        <div className="text-[11px] text-emerald-700 font-mono">
                          مطابقة تامة · {exact.sku_root}
                        </div>
                      </div>
                      <div className="font-bold text-emerald-700">
                        {EGP(exact.base_price)}
                      </div>
                    </button>
                  )}
                  {rest.map((p: any) => (
                    <button
                      key={p.id}
                      onClick={() => pickProduct(p)}
                      className="w-full text-right p-2.5 hover:bg-brand-50 border-b last:border-b-0 border-slate-100 flex justify-between"
                    >
                      <div>
                        <div className="font-medium">{p.name_ar}</div>
                        <div className="text-xs text-slate-500 font-mono">
                          {p.sku_root}
                        </div>
                      </div>
                      <div className="font-bold text-brand-600">
                        {EGP(p.base_price)}
                      </div>
                    </button>
                  ))}
                </>
              );
            })()}
          </div>
        )}
      </div>

      {props.variantPick && (
        <div className="p-3 border-2 border-indigo-200 bg-indigo-50/60 rounded-lg">
          <div className="flex items-center justify-between mb-2">
            <div className="text-sm font-black text-indigo-800">
              اختر اللون والمقاس — {props.variantPick.product.name_ar}
            </div>
            <button
              onClick={() => props.setVariantPick(null)}
              className="p-1 hover:bg-indigo-100 rounded text-indigo-700"
            >
              ✕
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {props.variantPick.variants.map((v: any) => (
              <button
                key={v.id}
                onClick={() => pushItem(props.variantPick.product, v)}
                className="px-2 py-1.5 rounded-lg bg-white border border-indigo-200 hover:border-indigo-400 text-xs flex items-center gap-1.5"
              >
                <span className="font-bold">
                  {[v.color, v.size].filter(Boolean).join(' · ') || v.sku || '—'}
                </span>
                <span className="text-[10px] text-slate-400">
                  {EGP(
                    v.selling_price ??
                      v.price_override ??
                      props.variantPick.product.base_price ??
                      0,
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Items table */}
      {props.items.length > 0 && (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs">
              <tr>
                <th className="p-2 text-right">الصنف</th>
                <th className="p-2 text-center">الكمية</th>
                <th className="p-2 text-center">السعر</th>
                <th className="p-2 text-center">الحالة</th>
                <th className="p-2 text-center">إعادة للمخزون</th>
                <th className="p-2 text-left">الإجمالي</th>
                <th className="p-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {props.items.map((it, idx) => (
                <tr key={it.variant_id}>
                  <td className="p-2">
                    <div className="font-bold">{it.product_name}</div>
                    <div className="text-[10px] font-mono text-slate-400">
                      {it.sku}
                      {[it.color, it.size].filter(Boolean).length > 0 &&
                        ` · ${[it.color, it.size].filter(Boolean).join(' · ')}`}
                    </div>
                  </td>
                  <td className="p-2 text-center">
                    <input
                      type="number"
                      min={1}
                      value={it.quantity}
                      onChange={(e) => {
                        const n = Math.max(1, Number(e.target.value) || 1);
                        props.setItems((prev) =>
                          prev.map((x, i) =>
                            i === idx ? { ...x, quantity: n } : x,
                          ),
                        );
                      }}
                      className="input w-16 text-center py-1"
                    />
                  </td>
                  <td className="p-2 text-center">
                    <input
                      type="number"
                      step="0.01"
                      value={it.unit_price}
                      onChange={(e) => {
                        const n = Number(e.target.value) || 0;
                        props.setItems((prev) =>
                          prev.map((x, i) =>
                            i === idx ? { ...x, unit_price: n } : x,
                          ),
                        );
                      }}
                      className="input w-20 text-center py-1"
                    />
                  </td>
                  <td className="p-2 text-center">
                    <select
                      value={it.condition}
                      onChange={(e) =>
                        props.setItems((prev) =>
                          prev.map((x, i) =>
                            i === idx ? { ...x, condition: e.target.value } : x,
                          ),
                        )
                      }
                      className="input py-1 text-xs"
                    >
                      <option value="resellable">قابل للبيع</option>
                      <option value="damaged">تالف</option>
                      <option value="defective">معيب</option>
                    </select>
                  </td>
                  <td className="p-2 text-center">
                    <input
                      type="checkbox"
                      checked={!!it.back_to_stock}
                      onChange={(e) =>
                        props.setItems((prev) =>
                          prev.map((x, i) =>
                            i === idx
                              ? { ...x, back_to_stock: e.target.checked }
                              : x,
                          ),
                        )
                      }
                    />
                  </td>
                  <td className="p-2 text-left font-bold">
                    {EGP(it.quantity * it.unit_price)}
                  </td>
                  <td className="p-2">
                    <button
                      onClick={() =>
                        props.setItems((prev) => prev.filter((_, i) => i !== idx))
                      }
                      className="p-1 text-rose-600 hover:bg-rose-50 rounded"
                    >
                      <Trash2 size={14} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Refund details */}
      <div className="grid md:grid-cols-2 gap-3">
        <Field label="السبب">
          <select
            value={props.reason}
            onChange={(e) => props.setReason(e.target.value as ReturnReason)}
            className="input"
          >
            {Object.entries(REASON_LABELS).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="طريقة الصرف">
          <select
            value={props.refundMethod}
            onChange={(e) =>
              props.setRefundMethod(e.target.value as PaymentMethod)
            }
            className="input"
          >
            {Object.entries(METHOD_LABELS).map(([v, label]) => (
              <option key={v} value={v}>
                {label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="تفاصيل السبب">
          <input
            value={props.reasonDetails}
            onChange={(e) => props.setReasonDetails(e.target.value)}
            className="input"
          />
        </Field>
        <Field label="رسوم إعادة (خصم)">
          <input
            type="number"
            min="0"
            step="0.01"
            value={props.restockingFee}
            onChange={(e) =>
              props.setRestockingFee(Number(e.target.value) || 0)
            }
            className="input"
          />
        </Field>
        <Field label="ملاحظات">
          <input
            value={props.notes}
            onChange={(e) => props.setNotes(e.target.value)}
            className="input"
          />
        </Field>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-2 gap-3 p-4 bg-slate-50 rounded-lg">
        <div>
          <div className="text-xs text-slate-500">إجمالي الأصناف</div>
          <div className="font-black text-xl tabular-nums">
            {EGP(props.total)}
          </div>
        </div>
        <div>
          <div className="text-xs text-slate-500">الصافي المسترد</div>
          <div
            className={`font-black text-xl tabular-nums ${
              props.net > 0 ? 'text-emerald-700' : 'text-slate-400'
            }`}
          >
            {EGP(props.net)}
          </div>
        </div>
      </div>

      <button
        onClick={props.onSubmit}
        disabled={props.submitting || props.items.length === 0}
        className="btn-primary w-full"
      >
        {props.submitting ? 'جاري الإنشاء...' : 'إنشاء المرتجع المباشر'}
      </button>
    </div>
  );
}
