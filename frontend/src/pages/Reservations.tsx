import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Plus,
  Search,
  Calendar,
  User,
  Package,
  XCircle,
  CheckCircle2,
  Clock,
  CircleDollarSign,
  AlertTriangle,
  ChevronLeft,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  reservationsApi,
  ReservationListItem,
  ReservationStatus,
  ReservationDetails,
  PaymentMethod,
  RefundPolicy,
} from '@/api/reservations.api';
import { customersApi } from '@/api/customers.api';
import { productsApi } from '@/api/products.api';

const WAREHOUSE_ID = import.meta.env.VITE_DEFAULT_WAREHOUSE_ID as string;

const EGP = (n: number | string) => `${Number(n).toFixed(0)} ج.م`;

const STATUS_META: Record<
  ReservationStatus,
  { label: string; color: string; icon: typeof CheckCircle2 }
> = {
  active: {
    label: 'نشط',
    color: 'bg-brand-100 text-brand-800 border-brand-200',
    icon: Clock,
  },
  completed: {
    label: 'مكتمل',
    color: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    icon: CheckCircle2,
  },
  cancelled: {
    label: 'ملغي',
    color: 'bg-rose-100 text-rose-800 border-rose-200',
    icon: XCircle,
  },
  expired: {
    label: 'منتهي',
    color: 'bg-slate-100 text-slate-700 border-slate-200',
    icon: AlertTriangle,
  },
};

const METHOD_LABELS: Record<PaymentMethod, string> = {
  cash: 'كاش',
  card: 'بطاقة',
  instapay: 'انستا باي',
  bank_transfer: 'تحويل بنكي',
};

// ============================================================================
export default function Reservations() {
  const [status, setStatus] = useState<ReservationStatus | 'all'>('active');
  const [q, setQ] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const { data: list, isLoading } = useQuery({
    queryKey: ['reservations', status, q],
    queryFn: () =>
      reservationsApi.list({
        status: status === 'all' ? undefined : status,
        q: q || undefined,
        limit: 200,
      }),
  });

  const totalActive = useMemo(
    () => list?.filter((r) => r.status === 'active').length ?? 0,
    [list],
  );
  const totalOwed = useMemo(
    () =>
      list?.reduce((s, r) => s + Number(r.remaining_amount || 0), 0) ?? 0,
    [list],
  );
  const totalCollected = useMemo(
    () => list?.reduce((s, r) => s + Number(r.paid_amount || 0), 0) ?? 0,
    [list],
  );

  return (
    <div className="space-y-6">
      {/* Header ============================================================ */}
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-3xl font-black text-slate-900">الحجوزات</h1>
          <p className="text-slate-500 mt-1">
            حجز المنتجات بعربون + تحصيل أقساط + تحويل لفاتورة
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary flex items-center gap-2"
        >
          <Plus size={18} /> حجز جديد
        </button>
      </div>

      {/* KPIs ============================================================== */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <KpiCard
          label="حجوزات نشطة"
          value={String(totalActive)}
          icon={Clock}
          tint="from-brand-500 to-pink-500"
        />
        <KpiCard
          label="إجمالي المحصّل"
          value={EGP(totalCollected)}
          icon={CircleDollarSign}
          tint="from-emerald-500 to-teal-500"
        />
        <KpiCard
          label="المبالغ المستحقة"
          value={EGP(totalOwed)}
          icon={AlertTriangle}
          tint="from-amber-500 to-orange-500"
        />
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
            placeholder="ابحث برقم الحجز أو اسم/تليفون العميل..."
            className="input pr-10 w-full"
          />
        </div>
        <div className="flex gap-2 flex-wrap">
          {(['active', 'completed', 'cancelled', 'expired', 'all'] as const).map(
            (s) => (
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
            ),
          )}
        </div>
      </div>

      {/* Grid: list + details ============================================= */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_480px] gap-6">
        {/* List */}
        <div className="card overflow-hidden">
          {isLoading ? (
            <div className="p-12 text-center text-slate-400">
              جاري التحميل...
            </div>
          ) : !list?.length ? (
            <EmptyState onCreate={() => setShowCreate(true)} />
          ) : (
            <div className="divide-y divide-slate-100">
              {list.map((r) => (
                <ReservationRow
                  key={r.id}
                  r={r}
                  isActive={selectedId === r.id}
                  onClick={() => setSelectedId(r.id)}
                />
              ))}
            </div>
          )}
        </div>

        {/* Details drawer */}
        <div>
          {selectedId ? (
            <ReservationDetailsPanel
              id={selectedId}
              onClose={() => setSelectedId(null)}
            />
          ) : (
            <div className="card p-12 text-center text-slate-400">
              <Package size={48} className="mx-auto mb-3 text-slate-300" />
              <p>اختر حجز من القائمة لعرض التفاصيل</p>
            </div>
          )}
        </div>
      </div>

      {/* Create modal ====================================================== */}
      {showCreate && (
        <CreateReservationModal onClose={() => setShowCreate(false)} />
      )}
    </div>
  );
}

// ============================================================================
// List row
// ============================================================================
function ReservationRow({
  r,
  isActive,
  onClick,
}: {
  r: ReservationListItem;
  isActive: boolean;
  onClick: () => void;
}) {
  const meta = STATUS_META[r.status];
  const Icon = meta.icon;
  const expired =
    r.status === 'active' &&
    r.expires_at &&
    new Date(r.expires_at) < new Date();

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
          <div className="font-mono font-bold text-slate-800">
            {r.reservation_no}
          </div>
          {expired ? (
            <span className="text-xs text-rose-600 font-semibold">
              ⚠ تجاوز تاريخ الانتهاء
            </span>
          ) : null}
        </div>
        <div className="text-sm text-slate-600 flex items-center gap-3 mt-0.5">
          <span className="inline-flex items-center gap-1">
            <User size={12} /> {r.customer_name || '—'}
          </span>
          <span className="inline-flex items-center gap-1">
            <Package size={12} /> {r.units_count} قطعة
          </span>
          {r.expires_at && (
            <span className="inline-flex items-center gap-1 text-amber-700">
              <Calendar size={12} />
              {new Date(r.expires_at).toLocaleDateString('en-US')}
            </span>
          )}
        </div>
      </div>

      <div className="text-left">
        <div className="font-bold text-slate-900">
          {EGP(r.total_amount)}
        </div>
        <div className="text-xs text-slate-500">
          مدفوع {EGP(r.paid_amount)}
        </div>
        {Number(r.remaining_amount) > 0 && (
          <div className="text-xs text-amber-700 font-semibold">
            متبقي {EGP(r.remaining_amount)}
          </div>
        )}
      </div>
    </button>
  );
}

// ============================================================================
// Details panel
// ============================================================================
function ReservationDetailsPanel({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ['reservation', id],
    queryFn: () => reservationsApi.get(id),
  });

  const [action, setAction] = useState<
    'pay' | 'convert' | 'cancel' | 'extend' | null
  >(null);

  if (isLoading || !data) {
    return (
      <div className="card p-12 text-center text-slate-400">
        جاري التحميل...
      </div>
    );
  }

  const res = data as ReservationDetails;
  const meta = STATUS_META[res.status];
  const isActive = res.status === 'active';

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['reservation', id] });
    qc.invalidateQueries({ queryKey: ['reservations'] });
  };

  return (
    <div className="card overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-br from-brand-500 to-purple-600 text-white p-5">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-xs opacity-80">رقم الحجز</div>
            <div className="font-mono text-xl font-black">
              {res.reservation_no}
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-white/80 hover:text-white"
            aria-label="close"
          >
            <ChevronLeft size={22} />
          </button>
        </div>
        <div
          className={`mt-3 inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-bold ${meta.color} border`}
        >
          <meta.icon size={12} /> {meta.label}
        </div>
      </div>

      {/* Body */}
      <div className="p-5 space-y-5">
        {/* Customer */}
        <div className="rounded-lg bg-slate-50 p-4">
          <div className="text-xs text-slate-500 mb-1">العميل</div>
          <div className="font-bold text-slate-800">
            {res.customer_name || '—'}
          </div>
          {res.customer_phone && (
            <div className="text-sm text-slate-600 font-mono">
              {res.customer_phone}
            </div>
          )}
        </div>

        {/* Totals */}
        <div className="grid grid-cols-2 gap-3">
          <Stat label="الإجمالي" value={EGP(res.total_amount)} />
          <Stat
            label="المدفوع"
            value={EGP(res.paid_amount)}
            tint="text-emerald-700"
          />
          <Stat
            label="المتبقي"
            value={EGP(res.remaining_amount)}
            tint="text-amber-700"
          />
          <Stat
            label="نسبة العربون"
            value={`${Number(res.deposit_required_pct).toFixed(0)}%`}
          />
        </div>

        {/* Dates */}
        <div className="text-sm space-y-1">
          <DateRow label="تاريخ الحجز" value={res.reserved_at} />
          {res.expires_at && (
            <DateRow label="تاريخ الانتهاء" value={res.expires_at} warn />
          )}
          {res.completed_at && (
            <DateRow label="تاريخ الإنجاز" value={res.completed_at} />
          )}
          {res.cancelled_at && (
            <DateRow label="تاريخ الإلغاء" value={res.cancelled_at} />
          )}
        </div>

        {/* Items */}
        <section>
          <div className="font-bold text-slate-700 mb-2">الأصناف</div>
          <div className="space-y-2">
            {res.items.map((it) => (
              <div
                key={it.id}
                className="flex items-center justify-between p-3 rounded-lg bg-white border border-slate-200"
              >
                <div className="min-w-0 flex-1">
                  <div className="font-semibold text-slate-800 truncate">
                    {it.product_name}
                  </div>
                  <div className="text-xs text-slate-500 font-mono">
                    {it.sku} {it.color && `• ${it.color}`}{' '}
                    {it.size && `• ${it.size}`}
                  </div>
                </div>
                <div className="text-left">
                  <div className="font-bold">{EGP(it.line_total)}</div>
                  <div className="text-xs text-slate-500">
                    {it.quantity} × {EGP(it.unit_price)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>

        {/* Payments */}
        {res.payments.length > 0 && (
          <section>
            <div className="font-bold text-slate-700 mb-2">
              الدفعات ({res.payments.length})
            </div>
            <div className="space-y-1.5">
              {res.payments.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between text-sm p-2.5 rounded-lg bg-emerald-50 border border-emerald-100"
                >
                  <span className="font-medium">
                    {p.kind === 'deposit'
                      ? 'عربون'
                      : p.kind === 'final'
                        ? 'تسوية نهائية'
                        : 'قسط'}{' '}
                    — {METHOD_LABELS[p.payment_method]}
                  </span>
                  <span className="font-bold text-emerald-700">
                    {EGP(p.amount)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Refunds */}
        {res.refunds.length > 0 && (
          <section>
            <div className="font-bold text-slate-700 mb-2">
              المرتجعات ({res.refunds.length})
            </div>
            <div className="space-y-1.5">
              {res.refunds.map((r) => (
                <div
                  key={r.id}
                  className="flex items-center justify-between text-sm p-2.5 rounded-lg bg-rose-50 border border-rose-100"
                >
                  <span className="font-medium">
                    {METHOD_LABELS[r.payment_method]} — رسوم{' '}
                    {EGP(r.fee_amount)}
                  </span>
                  <span className="font-bold text-rose-700">
                    -{EGP(r.net_refund_amount)}
                  </span>
                </div>
              ))}
            </div>
          </section>
        )}

        {/* Actions */}
        {isActive && (
          <div className="grid grid-cols-2 gap-2 pt-2">
            <button
              onClick={() => setAction('pay')}
              className="btn-secondary text-sm"
            >
              💰 تحصيل قسط
            </button>
            <button
              onClick={() => setAction('convert')}
              className="btn-primary text-sm"
            >
              ✅ تحويل لفاتورة
            </button>
            <button
              onClick={() => setAction('extend')}
              className="btn-secondary text-sm"
            >
              📅 تمديد
            </button>
            <button
              onClick={() => setAction('cancel')}
              className="bg-rose-500 hover:bg-rose-600 text-white font-bold py-2 rounded-lg text-sm"
            >
              ❌ إلغاء
            </button>
          </div>
        )}

        {/* Invoice link when completed */}
        {res.converted_invoice_id && (
          <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm">
            <span className="font-semibold text-emerald-800">
              ✓ تم إنجاز الحجز وإصدار فاتورة بيع
            </span>
          </div>
        )}

        {/* Cancellation reason */}
        {res.cancellation_reason && (
          <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-sm">
            <div className="font-semibold text-rose-800 mb-1">
              سبب الإلغاء
            </div>
            <div className="text-rose-700">{res.cancellation_reason}</div>
          </div>
        )}
      </div>

      {/* Sub-modals */}
      {action === 'pay' && (
        <AddPaymentModal
          reservation={res}
          onClose={() => setAction(null)}
          onSuccess={() => {
            setAction(null);
            refresh();
          }}
        />
      )}
      {action === 'convert' && (
        <ConvertModal
          reservation={res}
          onClose={() => setAction(null)}
          onSuccess={() => {
            setAction(null);
            refresh();
          }}
        />
      )}
      {action === 'cancel' && (
        <CancelModal
          reservation={res}
          onClose={() => setAction(null)}
          onSuccess={() => {
            setAction(null);
            refresh();
          }}
        />
      )}
      {action === 'extend' && (
        <ExtendModal
          reservation={res}
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
// Create Reservation Modal
// ============================================================================
function CreateReservationModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [customerQ, setCustomerQ] = useState('');
  const [customerId, setCustomerId] = useState<string>('');
  const [productQ, setProductQ] = useState('');
  const [items, setItems] = useState<
    Array<{
      variant_id: string;
      product_name: string;
      sku: string;
      quantity: number;
      unit_price: number;
    }>
  >([]);
  const [depositAmount, setDepositAmount] = useState<number>(0);
  const [depositMethod, setDepositMethod] = useState<PaymentMethod>('cash');
  const [expiresAt, setExpiresAt] = useState<string>(
    new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10),
  );
  const [depositPct, setDepositPct] = useState(30);
  const [notes, setNotes] = useState('');

  const { data: customers } = useQuery({
    queryKey: ['customers-for-res', customerQ],
    queryFn: () => customersApi.list({ q: customerQ, limit: 20 }),
    enabled: customerQ.length > 0,
  });

  const { data: products } = useQuery({
    queryKey: ['products-for-res', productQ],
    queryFn: () => productsApi.list({ q: productQ, limit: 20 }),
    enabled: productQ.length > 1,
  });

  const total = useMemo(
    () => items.reduce((s, it) => s + it.quantity * it.unit_price, 0),
    [items],
  );
  const required = useMemo(
    () => (total * depositPct) / 100,
    [total, depositPct],
  );

  const mutation = useMutation({
    mutationFn: () =>
      reservationsApi.create({
        customer_id: customerId,
        warehouse_id: WAREHOUSE_ID,
        items: items.map((it) => ({
          variant_id: it.variant_id,
          quantity: it.quantity,
          unit_price: it.unit_price,
        })),
        payments: [
          {
            payment_method: depositMethod,
            amount: depositAmount,
            kind: 'deposit',
          },
        ],
        deposit_required_pct: depositPct,
        expires_at: new Date(expiresAt).toISOString(),
        notes: notes || undefined,
      }),
    onSuccess: (r) => {
      toast.success(`تم إنشاء الحجز ${r.reservation_no}`);
      qc.invalidateQueries({ queryKey: ['reservations'] });
      onClose();
    },
    onError: (e: any) => {
      toast.error(e?.response?.data?.message || 'فشل إنشاء الحجز');
    },
  });

  const canSubmit =
    customerId &&
    items.length > 0 &&
    depositAmount >= required &&
    depositAmount > 0;

  const addItem = async (p: any) => {
    try {
      const full = await productsApi.get(p.id);
      const variant = full.variants?.[0];
      if (!variant) {
        toast.error('المنتج لا يحتوي على Variant');
        return;
      }
      if (items.find((i) => i.variant_id === variant.id)) {
        toast.error('الصنف مضاف بالفعل');
        return;
      }
      setItems([
        ...items,
        {
          variant_id: variant.id,
          product_name: p.name_ar,
          sku: variant.sku || '',
          quantity: 1,
          unit_price: Number(variant.price_override ?? p.base_price ?? 0),
        },
      ]);
      setProductQ('');
    } catch {
      toast.error('فشل تحميل بيانات المنتج');
    }
  };

  return (
    <Modal title="حجز جديد" onClose={onClose} size="xl">
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Customer */}
        <Field label="العميل *">
          <div className="relative">
            <input
              type="search"
              value={customerQ}
              onChange={(e) => {
                setCustomerQ(e.target.value);
                setCustomerId('');
              }}
              placeholder="ابحث بالاسم أو التليفون..."
              className="input w-full"
            />
            {customers && customers.data?.length > 0 && !customerId && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 max-h-60 overflow-auto">
                {customers.data.map((c: any) => (
                  <button
                    key={c.id}
                    onClick={() => {
                      setCustomerId(c.id);
                      setCustomerQ(c.full_name);
                    }}
                    className="w-full text-right p-2.5 hover:bg-brand-50 border-b last:border-b-0 border-slate-100"
                  >
                    <div className="font-medium">{c.full_name}</div>
                    <div className="text-xs text-slate-500 font-mono">
                      {c.phone}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </Field>

        {/* Expiry */}
        <Field label="ينتهي في">
          <input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="input w-full"
          />
        </Field>
      </div>

      {/* Products */}
      <div className="mt-5">
        <Field label="إضافة أصناف">
          <div className="relative">
            <input
              type="search"
              value={productQ}
              onChange={(e) => setProductQ(e.target.value)}
              placeholder="ابحث باسم المنتج أو SKU..."
              className="input w-full"
            />
            {products && products.data?.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-slate-200 rounded-lg shadow-lg z-50 max-h-60 overflow-auto">
                {products.data.map((p: any) => (
                  <button
                    key={p.id}
                    onClick={() => addItem(p)}
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
              </div>
            )}
          </div>
        </Field>

        {items.length > 0 && (
          <div className="mt-3 space-y-2">
            {items.map((it, idx) => (
              <div
                key={it.variant_id}
                className="flex items-center gap-3 p-3 bg-slate-50 rounded-lg"
              >
                <div className="flex-1 min-w-0">
                  <div className="font-semibold truncate">
                    {it.product_name}
                  </div>
                  <div className="text-xs font-mono text-slate-500">
                    {it.sku}
                  </div>
                </div>
                <input
                  type="number"
                  min={1}
                  value={it.quantity}
                  onChange={(e) => {
                    const next = [...items];
                    next[idx].quantity = Math.max(1, Number(e.target.value));
                    setItems(next);
                  }}
                  className="input w-20 text-center"
                />
                <input
                  type="number"
                  min={0}
                  value={it.unit_price}
                  onChange={(e) => {
                    const next = [...items];
                    next[idx].unit_price = Math.max(0, Number(e.target.value));
                    setItems(next);
                  }}
                  className="input w-28 text-center"
                />
                <div className="w-24 text-left font-bold">
                  {EGP(it.quantity * it.unit_price)}
                </div>
                <button
                  onClick={() =>
                    setItems(items.filter((_, i) => i !== idx))
                  }
                  className="text-rose-500 hover:text-rose-700"
                >
                  <XCircle size={20} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Totals + Deposit */}
      <div className="mt-5 grid grid-cols-1 md:grid-cols-3 gap-4">
        <Field label={`نسبة العربون (${depositPct}%)`}>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={depositPct}
            onChange={(e) => setDepositPct(Number(e.target.value))}
            className="w-full"
          />
          <div className="text-xs text-slate-500 mt-1">
            مطلوب على الأقل: {EGP(required)}
          </div>
        </Field>

        <Field label="مبلغ العربون *">
          <input
            type="number"
            min={0}
            step={10}
            value={depositAmount}
            onChange={(e) => setDepositAmount(Number(e.target.value))}
            className="input w-full text-center font-bold"
          />
        </Field>

        <Field label="طريقة الدفع">
          <select
            value={depositMethod}
            onChange={(e) =>
              setDepositMethod(e.target.value as PaymentMethod)
            }
            className="input w-full"
          >
            {(
              ['cash', 'card', 'instapay', 'bank_transfer'] as PaymentMethod[]
            ).map((m) => (
              <option key={m} value={m}>
                {METHOD_LABELS[m]}
              </option>
            ))}
          </select>
        </Field>
      </div>

      <Field label="ملاحظات" className="mt-4">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          className="input w-full"
          rows={2}
        />
      </Field>

      <div className="mt-5 p-4 rounded-lg bg-brand-50 border border-brand-100 flex items-center justify-between">
        <span className="font-semibold text-slate-700">الإجمالي</span>
        <span className="text-2xl font-black text-brand-700">
          {EGP(total)}
        </span>
      </div>

      <div className="mt-5 flex gap-2 justify-end">
        <button className="btn-secondary" onClick={onClose}>
          إلغاء
        </button>
        <button
          disabled={!canSubmit || mutation.isPending}
          onClick={() => mutation.mutate()}
          className="btn-primary disabled:opacity-50"
        >
          {mutation.isPending ? 'جاري الحفظ...' : 'حفظ الحجز'}
        </button>
      </div>
    </Modal>
  );
}

// ============================================================================
// Add payment modal
// ============================================================================
function AddPaymentModal({
  reservation,
  onClose,
  onSuccess,
}: {
  reservation: ReservationDetails;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const remaining = Number(reservation.remaining_amount);
  const [amount, setAmount] = useState<number>(remaining);
  const [method, setMethod] = useState<PaymentMethod>('cash');
  const [kind, setKind] = useState<'installment' | 'final'>(
    'installment',
  );
  const [note, setNote] = useState('');

  const mut = useMutation({
    mutationFn: () =>
      reservationsApi.addPayment(reservation.id, {
        payment_method: method,
        amount,
        kind,
        notes: note || undefined,
      }),
    onSuccess: () => {
      toast.success('تم تسجيل الدفعة');
      onSuccess();
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'خطأ'),
  });

  return (
    <Modal title="تحصيل قسط" onClose={onClose}>
      <div className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-sm mb-4">
        المتبقي: <b>{EGP(remaining)}</b>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="المبلغ">
          <input
            type="number"
            min={0}
            max={remaining}
            value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="input w-full text-center font-bold"
          />
        </Field>
        <Field label="الطريقة">
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
      </div>
      <Field label="نوع الدفعة" className="mt-3">
        <div className="flex gap-2">
          {(['installment', 'final'] as const).map((k) => (
            <button
              key={k}
              onClick={() => setKind(k)}
              className={`flex-1 py-2 rounded-lg border ${
                kind === k
                  ? 'bg-brand-500 text-white border-brand-500'
                  : 'bg-white border-slate-200'
              }`}
            >
              {k === 'installment' ? 'قسط' : 'تسوية نهائية'}
            </button>
          ))}
        </div>
      </Field>
      <Field label="ملاحظة" className="mt-3">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="input w-full"
        />
      </Field>
      <div className="mt-5 flex gap-2 justify-end">
        <button className="btn-secondary" onClick={onClose}>
          إلغاء
        </button>
        <button
          disabled={amount <= 0 || amount > remaining || mut.isPending}
          onClick={() => mut.mutate()}
          className="btn-primary disabled:opacity-50"
        >
          {mut.isPending ? 'جاري الحفظ...' : 'تسجيل الدفعة'}
        </button>
      </div>
    </Modal>
  );
}

// ============================================================================
// Convert to invoice
// ============================================================================
function ConvertModal({
  reservation,
  onClose,
  onSuccess,
}: {
  reservation: ReservationDetails;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const remaining = Number(reservation.remaining_amount);
  const needsPay = remaining > 0.005;
  const [amount, setAmount] = useState(remaining);
  const [method, setMethod] = useState<PaymentMethod>('cash');

  const mut = useMutation({
    mutationFn: () =>
      reservationsApi.convert(reservation.id, {
        final_payments: needsPay
          ? [
              {
                payment_method: method,
                amount,
                kind: 'final',
              },
            ]
          : [],
      }),
    onSuccess: (r) => {
      toast.success(`تم إصدار فاتورة ${r.doc_no}`);
      onSuccess();
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'خطأ'),
  });

  return (
    <Modal title="تحويل الحجز إلى فاتورة بيع" onClose={onClose}>
      <div className="p-4 rounded-lg bg-brand-50 border border-brand-200 text-sm space-y-1 mb-4">
        <div>
          إجمالي الحجز: <b>{EGP(reservation.total_amount)}</b>
        </div>
        <div>
          المدفوع سابقاً: <b>{EGP(reservation.paid_amount)}</b>
        </div>
        <div className="text-amber-700">
          المتبقي للتحصيل: <b>{EGP(remaining)}</b>
        </div>
      </div>

      {needsPay && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="المبلغ">
            <input
              type="number"
              min={remaining}
              step={1}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="input w-full text-center font-bold"
            />
          </Field>
          <Field label="الطريقة">
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
        </div>
      )}

      {!needsPay && (
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm">
          الحجز مدفوع بالكامل. اضغط تأكيد لإصدار الفاتورة.
        </div>
      )}

      <div className="mt-5 flex gap-2 justify-end">
        <button className="btn-secondary" onClick={onClose}>
          إلغاء
        </button>
        <button
          disabled={(needsPay && amount < remaining) || mut.isPending}
          onClick={() => mut.mutate()}
          className="btn-primary disabled:opacity-50"
        >
          {mut.isPending ? 'جاري الإصدار...' : 'تأكيد وإصدار الفاتورة'}
        </button>
      </div>
    </Modal>
  );
}

// ============================================================================
// Cancel modal
// ============================================================================
function CancelModal({
  reservation,
  onClose,
  onSuccess,
}: {
  reservation: ReservationDetails;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [reason, setReason] = useState('');
  const [policy, setPolicy] = useState<RefundPolicy>(
    reservation.refund_policy,
  );
  const [method, setMethod] = useState<PaymentMethod>('cash');

  const paid = Number(reservation.paid_amount);
  const feePct = Number(reservation.cancellation_fee_pct);
  const { fee, net } = useMemo(() => {
    if (policy === 'full') return { fee: 0, net: paid };
    if (policy === 'partial') {
      const f = Math.round(paid * (feePct / 100) * 100) / 100;
      return { fee: f, net: Math.max(0, paid - f) };
    }
    return { fee: 0, net: 0 };
  }, [policy, paid, feePct]);

  const mut = useMutation({
    mutationFn: () =>
      reservationsApi.cancel(reservation.id, {
        reason,
        refund_policy: policy,
        refund_method: method,
      }),
    onSuccess: () => {
      toast.success('تم إلغاء الحجز');
      onSuccess();
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'خطأ'),
  });

  return (
    <Modal title="إلغاء الحجز" onClose={onClose}>
      <Field label="سبب الإلغاء *">
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="input w-full"
          rows={2}
        />
      </Field>

      <Field label="سياسة الاسترداد" className="mt-3">
        <div className="grid grid-cols-3 gap-2">
          {(
            [
              { v: 'full' as const, t: 'استرداد كامل' },
              { v: 'partial' as const, t: `جزئي (رسوم ${feePct}%)` },
              { v: 'none' as const, t: 'بدون استرداد' },
            ]
          ).map((o) => (
            <button
              key={o.v}
              onClick={() => setPolicy(o.v)}
              className={`py-2 text-sm rounded-lg border ${
                policy === o.v
                  ? 'bg-brand-500 text-white border-brand-500'
                  : 'bg-white border-slate-200'
              }`}
            >
              {o.t}
            </button>
          ))}
        </div>
      </Field>

      {net > 0 && (
        <Field label="طريقة الاسترداد" className="mt-3">
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
      )}

      <div className="mt-4 p-3 rounded-lg bg-rose-50 border border-rose-200 text-sm space-y-1">
        <div>
          المدفوع: <b>{EGP(paid)}</b>
        </div>
        <div>
          رسوم الإلغاء: <b className="text-rose-700">{EGP(fee)}</b>
        </div>
        <div>
          صافي الاسترداد: <b className="text-emerald-700">{EGP(net)}</b>
        </div>
      </div>

      <div className="mt-5 flex gap-2 justify-end">
        <button className="btn-secondary" onClick={onClose}>
          تراجع
        </button>
        <button
          disabled={!reason || mut.isPending}
          onClick={() => mut.mutate()}
          className="bg-rose-500 hover:bg-rose-600 text-white font-bold px-5 py-2 rounded-lg disabled:opacity-50"
        >
          {mut.isPending ? 'جاري الإلغاء...' : 'تأكيد الإلغاء'}
        </button>
      </div>
    </Modal>
  );
}

// ============================================================================
// Extend expiry modal
// ============================================================================
function ExtendModal({
  reservation,
  onClose,
  onSuccess,
}: {
  reservation: ReservationDetails;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [date, setDate] = useState(
    new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString().slice(0, 10),
  );
  const mut = useMutation({
    mutationFn: () =>
      reservationsApi.extend(
        reservation.id,
        new Date(date).toISOString(),
      ),
    onSuccess: () => {
      toast.success('تم التمديد');
      onSuccess();
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'خطأ'),
  });

  return (
    <Modal title="تمديد تاريخ الانتهاء" onClose={onClose}>
      <Field label="التاريخ الجديد">
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          className="input w-full"
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
          {mut.isPending ? 'جاري الحفظ...' : 'تمديد'}
        </button>
      </div>
    </Modal>
  );
}

// ============================================================================
// Small UI helpers
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

function DateRow({
  label,
  value,
  warn,
}: {
  label: string;
  value: string;
  warn?: boolean;
}) {
  const d = new Date(value);
  const past = warn && d < new Date();
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-500">{label}</span>
      <span
        className={`font-mono ${past ? 'text-rose-600 font-bold' : 'text-slate-700'}`}
      >
        {d.toLocaleDateString('en-US')}
      </span>
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

function EmptyState({ onCreate }: { onCreate: () => void }) {
  return (
    <div className="p-16 text-center">
      <div className="text-6xl mb-4">📦</div>
      <h3 className="text-xl font-bold text-slate-800 mb-2">
        لا توجد حجوزات
      </h3>
      <p className="text-slate-500 mb-5">
        ابدأ بحجز منتج لعميل مقابل عربون
      </p>
      <button onClick={onCreate} className="btn-primary">
        <Plus size={18} className="inline ml-1" /> حجز جديد
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
