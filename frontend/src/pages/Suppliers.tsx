import { useState, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Truck,
  Plus,
  Search,
  Phone,
  Mail,
  MapPin,
  X,
  AlertTriangle,
  FileText,
  CreditCard,
  Pencil,
  ExternalLink,
  Trash2,
  PieChart as PieChartIcon,
  TrendingUp,
  CalendarClock,
} from 'lucide-react';
import { suppliersApi, Supplier, SupplierOutstanding } from '@/api/suppliers.api';
import { cashDeskApi } from '@/api/cash-desk.api';

const EGP = (n: number | string) =>
  `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;

type SupplierSort =
  | 'name'
  | 'balance_desc'
  | 'balance_asc'
  | 'overdue_desc'
  | 'created_desc';

export default function Suppliers() {
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SupplierSort>('balance_desc');
  const [onlyOutstanding, setOnlyOutstanding] = useState(false);
  const [typeFilter, setTypeFilter] = useState<'all' | 'cash' | 'credit' | 'installments'>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<Supplier | null>(null);
  const [payTarget, setPayTarget] = useState<Supplier | null>(null);
  const [editTarget, setEditTarget] = useState<Supplier | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Supplier | null>(null);
  const qc = useQueryClient();

  const deleteMutation = useMutation({
    mutationFn: (id: string) => suppliersApi.remove(id),
    onSuccess: () => {
      toast.success('تم حذف المورد');
      qc.invalidateQueries({ queryKey: ['suppliers'] });
      qc.invalidateQueries({ queryKey: ['suppliers-outstanding'] });
      setDeleteTarget(null);
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message || 'فشل الحذف';
      toast.error(Array.isArray(msg) ? msg[0] : String(msg));
    },
  });

  const { data: suppliers = [], isLoading } = useQuery({
    queryKey: ['suppliers', q],
    queryFn: () => suppliersApi.list(q || undefined),
  });

  const { data: outstanding = [] } = useQuery({
    queryKey: ['suppliers-outstanding'],
    queryFn: suppliersApi.outstanding,
  });

  const { data: analytics } = useQuery({
    queryKey: ['suppliers-analytics'],
    queryFn: suppliersApi.analytics,
    refetchInterval: 120_000,
  });

  const { data: upcoming = [] } = useQuery({
    queryKey: ['suppliers-upcoming'],
    queryFn: () => suppliersApi.upcomingPayments(7),
    refetchInterval: 300_000,
  });

  const sortedSuppliers = useMemo(() => {
    const m: Record<string, SupplierOutstanding> = {};
    for (const o of outstanding) m[o.id] = o;
    let list = suppliers.slice();
    if (onlyOutstanding) {
      list = list.filter(
        (s) => Number(m[s.id]?.current_balance || s.current_balance || 0) > 0,
      );
    }
    if (typeFilter !== 'all') {
      list = list.filter((s) => (s.supplier_type || 'credit') === typeFilter);
    }
    list.sort((a, b) => {
      const oa = m[a.id];
      const ob = m[b.id];
      switch (sort) {
        case 'name':
          return String((a as any).full_name || (a as any).name || '').localeCompare(
            String((b as any).full_name || (b as any).name || ''),
            'ar',
          );
        case 'balance_asc':
          return (
            Number(oa?.current_balance || a.current_balance || 0) -
            Number(ob?.current_balance || b.current_balance || 0)
          );
        case 'balance_desc':
          return (
            Number(ob?.current_balance || b.current_balance || 0) -
            Number(oa?.current_balance || a.current_balance || 0)
          );
        case 'overdue_desc':
          return (
            Number((ob as any)?.overdue_amount || 0) -
            Number((oa as any)?.overdue_amount || 0)
          );
        default:
          return (
            Date.parse(String((b as any).created_at || 0)) -
            Date.parse(String((a as any).created_at || 0))
          );
      }
    });
    return list;
  }, [suppliers, outstanding, sort, onlyOutstanding, typeFilter]);

  const outstandingMap = useMemo(() => {
    const m: Record<string, SupplierOutstanding> = {};
    for (const o of outstanding) m[o.id] = o;
    return m;
  }, [outstanding]);

  const totals = useMemo(() => {
    // current_balance already *includes* the opening balance (it's
    // seeded at create-time and reconciled on updates), so the
    // "total" is just the sum of current_balance. Opening is shown
    // as a breakdown hint for transparency, not added again.
    const due = outstanding.reduce((s, o) => s + Number(o.current_balance || 0), 0);
    const overdue = outstanding.reduce(
      (s, o) => s + Number(o.overdue_amount || 0),
      0,
    );
    const opening = suppliers.reduce(
      (s, x) => s + Number(x.opening_balance || 0),
      0,
    );
    return {
      due,
      overdue,
      opening,
      total: due, // opening is embedded in due
      count: outstanding.length,
    };
  }, [outstanding, suppliers]);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Truck className="text-brand-600" /> الموردون
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            إدارة الموردين ومستحقاتهم
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={18} /> إضافة مورد
        </button>
      </div>

      {/* KPIs */}
      <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi
          title="إجمالي مستحقات الموردين"
          value={EGP(totals.total)}
          color="bg-amber-50"
          icon={<CreditCard className="text-amber-600" />}
          hint={`جاري ${EGP(
            Math.max(0, totals.due - totals.opening),
          )} · افتتاحي ${EGP(totals.opening)}`}
        />
        <Kpi
          title="المدفوعات — آخر 30 يوم"
          value={EGP(analytics?.totals?.paid_last_30d || 0)}
          color="bg-emerald-50"
          icon={<CreditCard className="text-emerald-600" />}
          hint={
            analytics?.totals
              ? `${analytics.totals.payment_count_30d} دفعة`
              : undefined
          }
        />
        <Kpi
          title="مستحقات متأخرة"
          value={EGP(totals.overdue)}
          color="bg-rose-50"
          icon={<AlertTriangle className="text-rose-600" />}
        />
        <Kpi
          title="موردون نشطون"
          value={String(analytics?.totals?.supplier_count ?? suppliers.length)}
          color="bg-brand-50"
          icon={<Truck className="text-brand-600" />}
          hint={
            analytics?.totals
              ? `مشتريات آخر 30 يوم ${EGP(analytics.totals.purchases_last_30d)}`
              : undefined
          }
        />
      </div>

      {/* Analytics strip — type breakdown + top outstanding + top spend */}
      {analytics && <SuppliersAnalytics analytics={analytics} />}

      {/* Upcoming payments inbox */}
      {upcoming.length > 0 && <UpcomingPaymentsInbox upcoming={upcoming} />}

      {/* Search + sort + filter */}
      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search
            size={16}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            className="input pr-9"
            placeholder="ابحث باسم المورد أو الكود..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select
          className="input max-w-[200px]"
          value={sort}
          onChange={(e) => setSort(e.target.value as SupplierSort)}
        >
          <option value="balance_desc">الرصيد الأعلى</option>
          <option value="balance_asc">الرصيد الأقل</option>
          <option value="overdue_desc">متأخر أكثر</option>
          <option value="name">الاسم (أ-ي)</option>
          <option value="created_desc">الأحدث أولاً</option>
        </select>
        <select
          className="input max-w-[160px]"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value as any)}
        >
          <option value="all">كل الأنواع</option>
          <option value="cash">كاش</option>
          <option value="credit">آجل</option>
          <option value="installments">أقساط</option>
        </select>
        <label className="inline-flex items-center gap-1 text-sm text-slate-600">
          <input
            type="checkbox"
            checked={onlyOutstanding}
            onChange={(e) => setOnlyOutstanding(e.target.checked)}
          />
          لديهم مستحق فقط
        </label>
      </div>

      {/* Grid */}
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading && (
          <div className="col-span-full text-center py-12 text-slate-400">
            جارٍ التحميل...
          </div>
        )}
        {sortedSuppliers.map((s) => {
          const o = outstandingMap[s.id];
          const due = Number(o?.current_balance || s.current_balance || 0);
          return (
            <div
              key={s.id}
              className="card p-4 hover:shadow-glow transition cursor-pointer"
              onClick={() => setSelected(s)}
            >
              <div className="flex items-start justify-between mb-3 gap-2">
                <div className="min-w-0 flex-1">
                  <div className="font-black text-slate-800 truncate">{s.name}</div>
                  <div className="text-xs text-slate-500 font-mono flex items-center gap-1.5 mt-0.5">
                    <span>{s.code}</span>
                    {s.supplier_type && (
                      <span
                        className={`chip border text-[10px] px-1.5 py-0 ${
                          TYPE_TONE[s.supplier_type] || TYPE_TONE.credit
                        }`}
                      >
                        {TYPE_LABEL_AR[s.supplier_type] || s.supplier_type}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {due > 0 && (
                    <span className="chip bg-rose-100 text-rose-700">
                      مدين {EGP(due)}
                    </span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      window.location.href = `/suppliers/${s.id}`;
                    }}
                    className="p-1.5 rounded-lg hover:bg-indigo-50 text-slate-500 hover:text-indigo-600"
                    title="الصفحة الذكية للمورد"
                  >
                    <ExternalLink size={14} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditTarget(s);
                    }}
                    className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-brand-600"
                    title="تعديل"
                  >
                    <Pencil size={14} />
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setDeleteTarget(s);
                    }}
                    className="p-1.5 rounded-lg hover:bg-rose-50 text-slate-500 hover:text-rose-600"
                    title="حذف"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              {s.phone && (
                <div className="flex items-center gap-2 text-sm text-slate-600 mb-1">
                  <Phone size={14} />
                  <span dir="ltr">{s.phone}</span>
                </div>
              )}
              {s.email && (
                <div className="flex items-center gap-2 text-sm text-slate-600 mb-1">
                  <Mail size={14} />
                  <span className="truncate">{s.email}</span>
                </div>
              )}
              {s.address && (
                <div className="flex items-center gap-2 text-sm text-slate-600 mb-1">
                  <MapPin size={14} />
                  <span className="truncate">{s.address}</span>
                </div>
              )}

              {/* Balance strip — always visible, includes opening balance
                  so the displayed figure matches the detail page. */}
              <div className="mt-3 p-2 rounded-lg bg-slate-50 border border-slate-100 text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-500">الرصيد الحالي</span>
                  <span
                    className={`font-mono font-black tabular-nums ${
                      due > 0 ? 'text-rose-700' : 'text-emerald-700'
                    }`}
                  >
                    {EGP(due)}
                  </span>
                </div>
                {Number(s.opening_balance || 0) > 0 && (
                  <div className="flex items-center justify-between mt-1 text-[10px] text-slate-400">
                    <span>رصيد افتتاحي</span>
                    <span className="tabular-nums">
                      {EGP(s.opening_balance || 0)}
                    </span>
                  </div>
                )}
                {Number(s.credit_limit || 0) > 0 && (
                  <div className="flex items-center justify-between mt-1 text-[10px] text-slate-400">
                    <span>حد الائتمان</span>
                    <span className="tabular-nums">
                      {EGP(s.credit_limit || 0)}
                    </span>
                  </div>
                )}
              </div>

              <div className="flex gap-2 mt-3 pt-3 border-t border-slate-100">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setSelected(s);
                  }}
                  className="flex-1 text-xs py-1.5 bg-slate-100 rounded-lg hover:bg-slate-200 font-bold flex items-center justify-center gap-1"
                >
                  <FileText size={12} /> كشف حساب
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setPayTarget(s);
                  }}
                  className="flex-1 text-xs py-1.5 bg-emerald-100 text-emerald-700 rounded-lg hover:bg-emerald-200 font-bold flex items-center justify-center gap-1"
                >
                  <CreditCard size={12} /> دفعة
                </button>
              </div>
            </div>
          );
        })}

        {!isLoading && !suppliers.length && (
          <div className="col-span-full text-center py-12 text-slate-400">
            لا توجد بيانات موردين
          </div>
        )}
      </div>

      {showCreate && (
        <CreateSupplierModal
          onClose={() => setShowCreate(false)}
          onSuccess={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['suppliers'] });
          }}
        />
      )}

      {selected && (
        <LedgerModal supplier={selected} onClose={() => setSelected(null)} />
      )}

      {payTarget && (
        <QuickPayModal
          supplier={payTarget}
          onClose={() => setPayTarget(null)}
          onSuccess={() => {
            setPayTarget(null);
            qc.invalidateQueries({ queryKey: ['suppliers-outstanding'] });
            qc.invalidateQueries({ queryKey: ['supplier-payments'] });
          }}
        />
      )}

      {editTarget && (
        <EditSupplierModal
          supplier={editTarget}
          onClose={() => setEditTarget(null)}
          onSuccess={() => {
            setEditTarget(null);
            qc.invalidateQueries({ queryKey: ['suppliers'] });
          }}
        />
      )}

      {deleteTarget && (
        <ConfirmDeleteModal
          supplier={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onConfirm={() => deleteMutation.mutate(deleteTarget.id)}
          isPending={deleteMutation.isPending}
        />
      )}

      {/* Sticky footer — grand totals across every supplier */}
      <SuppliersTotalsBar
        outstanding={totals.due}
        opening={totals.opening}
        creditForUs={Number(analytics?.totals?.credit_for_us_total || 0)}
        paid30={Number(analytics?.totals?.paid_last_30d || 0)}
        paidCount30={Number(analytics?.totals?.payment_count_30d || 0)}
      />
    </div>
  );
}

function SuppliersTotalsBar({
  outstanding,
  opening,
  creditForUs,
  paid30,
  paidCount30,
}: {
  outstanding: number;
  opening: number;
  creditForUs: number;
  paid30: number;
  paidCount30: number;
}) {
  // outstanding already contains opening — use it directly, break it
  // out on the right for transparency.
  const total = outstanding;
  const running = Math.max(0, outstanding - opening);
  return (
    <div className="sticky bottom-0 -mx-3 md:-mx-6 mt-6 bg-gradient-to-l from-slate-900 via-slate-800 to-slate-900 text-white px-4 py-3 shadow-2xl border-t border-slate-700 z-40">
      <div className="flex items-center justify-between gap-4 flex-wrap text-xs">
        <div className="flex items-center gap-4 flex-wrap">
          <TotalPill
            label="إجمالي مستحقات الموردين"
            value={EGP(total)}
            accent="text-amber-300"
          />
          <TotalPill
            label="جاري"
            value={EGP(running)}
            accent="text-indigo-300"
          />
          <TotalPill
            label="افتتاحي"
            value={EGP(opening)}
            accent="text-slate-300"
          />
          {creditForUs > 0 && (
            <TotalPill
              label="زيادة لصالحنا"
              value={EGP(creditForUs)}
              accent="text-emerald-300"
            />
          )}
        </div>
        <div className="flex items-center gap-2 text-slate-300">
          <span>مدفوعات 30 يوم:</span>
          <span className="font-black text-emerald-300 tabular-nums">
            {EGP(paid30)}
          </span>
          <span className="text-slate-500">· {paidCount30} دفعة</span>
        </div>
      </div>
    </div>
  );
}

function TotalPill({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-slate-400">{label}</span>
      <span className={`font-black tabular-nums ${accent}`}>{value}</span>
    </div>
  );
}

function EditSupplierModal({
  supplier,
  onClose,
  onSuccess,
}: {
  supplier: Supplier;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState({
    code: supplier.code || '',
    name: supplier.name || '',
    phone: supplier.phone || '',
    email: supplier.email || '',
    address: supplier.address || '',
    supplier_type: (supplier.supplier_type as any) || 'credit',
    credit_limit: String(supplier.credit_limit ?? ''),
    opening_balance: String(supplier.opening_balance ?? ''),
    payment_terms_days: String(supplier.payment_terms_days ?? ''),
    payment_day_of_week:
      (supplier as any).payment_day_of_week == null
        ? ''
        : String((supplier as any).payment_day_of_week),
    payment_installment_amount: String(
      (supplier as any).payment_installment_amount ?? '',
    ),
  });
  const mutation = useMutation({
    mutationFn: (body: Partial<Supplier>) =>
      suppliersApi.update(supplier.id, body),
    onSuccess: () => {
      toast.success('تم تحديث المورد');
      onSuccess();
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message || 'فشل التحديث';
      toast.error(Array.isArray(msg) ? msg[0] : String(msg));
    },
  });

  return (
    <Modal title={`تعديل المورد: ${supplier.name}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="الكود *">
            <input
              className="input"
              value={form.code}
              onChange={(e) => setForm({ ...form, code: e.target.value })}
            />
          </Field>
          <Field label="الاسم *">
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="الهاتف">
            <input
              className="input"
              dir="ltr"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </Field>
          <Field label="البريد الإلكتروني">
            <input
              className="input"
              type="email"
              dir="ltr"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
        </div>
        <Field label="العنوان">
          <textarea
            rows={2}
            className="input"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
        </Field>
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="نوع التعامل">
            <select
              className="input"
              value={form.supplier_type}
              onChange={(e) =>
                setForm({ ...form, supplier_type: e.target.value as any })
              }
            >
              <option value="cash">كاش</option>
              <option value="credit">آجل</option>
              <option value="installments">أقساط</option>
            </select>
          </Field>
          <Field label="مهلة السداد (يوم)">
            <input
              type="number"
              min="0"
              className="input"
              dir="ltr"
              value={form.payment_terms_days}
              onChange={(e) =>
                setForm({ ...form, payment_terms_days: e.target.value })
              }
            />
          </Field>
          <Field label="حد الائتمان (ج.م)">
            <input
              type="number"
              min="0"
              step="0.01"
              className="input"
              dir="ltr"
              value={form.credit_limit}
              onChange={(e) =>
                setForm({ ...form, credit_limit: e.target.value })
              }
            />
          </Field>
          <Field label="الرصيد الافتتاحي (ج.م)">
            <input
              type="number"
              min="0"
              step="0.01"
              className="input"
              dir="ltr"
              value={form.opening_balance}
              onChange={(e) =>
                setForm({ ...form, opening_balance: e.target.value })
              }
              title="يُسجَّل كرصيد افتتاحي في كشف حساب المورد"
            />
          </Field>
          <Field label="يوم الدفع الأسبوعي">
            <select
              className="input"
              value={form.payment_day_of_week}
              onChange={(e) =>
                setForm({ ...form, payment_day_of_week: e.target.value })
              }
            >
              <option value="">بدون</option>
              <option value="6">السبت</option>
              <option value="0">الأحد</option>
              <option value="1">الإثنين</option>
              <option value="2">الثلاثاء</option>
              <option value="3">الأربعاء</option>
              <option value="4">الخميس</option>
              <option value="5">الجمعة</option>
            </select>
          </Field>
          <Field label="قيمة الدفعة الأسبوعية (ج.م)">
            <input
              type="number"
              min="0"
              step="0.01"
              className="input"
              dir="ltr"
              value={form.payment_installment_amount}
              onChange={(e) =>
                setForm({
                  ...form,
                  payment_installment_amount: e.target.value,
                })
              }
            />
          </Field>
        </div>
        <div className="flex gap-2 pt-2">
          <button
            className="btn-primary flex-1"
            onClick={() => {
              if (!form.code || !form.name)
                return toast.error('الكود والاسم مطلوبان');
              if (!/^[0-9]+$/.test(form.code))
                return toast.error('كود المورد أرقام إنجليزي فقط');
              mutation.mutate({
                ...form,
                credit_limit: form.credit_limit
                  ? Number(form.credit_limit)
                  : undefined,
                opening_balance: form.opening_balance
                  ? Number(form.opening_balance)
                  : undefined,
                payment_terms_days: form.payment_terms_days
                  ? Number(form.payment_terms_days)
                  : undefined,
                payment_day_of_week:
                  form.payment_day_of_week === ''
                    ? undefined
                    : Number(form.payment_day_of_week),
                payment_installment_amount: form.payment_installment_amount
                  ? Number(form.payment_installment_amount)
                  : undefined,
              } as any);
            }}
            disabled={mutation.isPending}
          >
            {mutation.isPending ? 'جاري الحفظ...' : 'حفظ التعديلات'}
          </button>
          <button className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ConfirmDeleteModal({
  supplier,
  onClose,
  onConfirm,
  isPending,
}: {
  supplier: Supplier;
  onClose: () => void;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Modal title="تأكيد الحذف" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex items-start gap-3 p-3 rounded-lg bg-rose-50 border border-rose-200">
          <AlertTriangle className="text-rose-600 flex-shrink-0 mt-0.5" size={20} />
          <div className="text-sm text-slate-700">
            هل أنت متأكد من حذف المورد <b>{supplier.name}</b>؟
            <br />
            <span className="text-xs text-slate-500">
              سيتم أرشفة المورد. لا يمكن الحذف إذا كان عليه رصيد مستحق.
            </span>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            className="flex-1 py-2 rounded-lg bg-rose-600 text-white font-bold hover:bg-rose-700 disabled:opacity-50"
            onClick={onConfirm}
            disabled={isPending}
          >
            <Trash2 size={16} className="inline -mt-1 ml-1" />
            {isPending ? 'جاري الحذف...' : 'تأكيد الحذف'}
          </button>
          <button className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Kpi({
  title,
  value,
  color,
  icon,
  hint,
}: {
  title: string;
  value: string;
  color: string;
  icon: React.ReactNode;
  hint?: string;
}) {
  return (
    <div className="card p-5 flex items-center gap-4">
      <div className={`w-12 h-12 rounded-xl flex items-center justify-center ${color}`}>
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xs text-slate-500">{title}</div>
        <div className="font-black text-2xl text-slate-800 truncate">{value}</div>
        {hint && <div className="text-[11px] text-slate-400 mt-0.5">{hint}</div>}
      </div>
    </div>
  );
}

/* ───────── Analytics strip ───────── */

const TYPE_LABEL_AR: Record<string, string> = {
  cash: 'كاش',
  credit: 'آجل',
  installments: 'أقساط',
};
const TYPE_TONE: Record<string, string> = {
  cash: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  credit: 'bg-amber-100 text-amber-700 border-amber-200',
  installments: 'bg-violet-100 text-violet-700 border-violet-200',
};

function SuppliersAnalytics({ analytics }: { analytics: any }) {
  const outstandingTotal = Number(analytics.totals.outstanding_total || 0);
  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <PieChartIcon className="text-violet-600" size={18} />
          <h3 className="font-black text-slate-800">توزيع الموردين</h3>
        </div>
        <div className="space-y-2">
          {analytics.byType.map((t: any) => {
            // outstanding already embeds opening — don't add it twice.
            const amount = Number(t.outstanding || 0);
            const pct = outstandingTotal > 0 ? (amount / outstandingTotal) * 100 : 0;
            return (
              <div key={t.supplier_type}>
                <div className="flex items-center justify-between text-xs mb-1">
                  <div className="flex items-center gap-2">
                    <span
                      className={`chip border text-[11px] ${TYPE_TONE[t.supplier_type]}`}
                    >
                      {TYPE_LABEL_AR[t.supplier_type] || t.supplier_type}
                    </span>
                    <span className="text-slate-500">{t.count} مورد</span>
                  </div>
                  <span className="font-mono tabular-nums text-slate-700">
                    {EGP(amount)} · {pct.toFixed(1)}%
                  </span>
                </div>
                <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-l from-indigo-500 to-violet-500"
                    style={{ width: `${Math.min(100, pct)}%` }}
                  />
                </div>
              </div>
            );
          })}
          {analytics.byType.length === 0 && (
            <div className="text-xs text-slate-400">لا بيانات</div>
          )}
        </div>
      </div>

      <div className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="text-amber-600" size={18} />
          <h3 className="font-black text-slate-800">
            أكبر مستحقات (أعلى 5)
          </h3>
        </div>
        {analytics.topOutstanding.length === 0 ? (
          <div className="text-xs text-slate-400">لا مستحقات حالية</div>
        ) : (
          <ul className="space-y-1 text-xs">
            {analytics.topOutstanding.map((t: any) => (
              <li
                key={t.id}
                className="flex items-center justify-between border-b border-slate-100 last:border-0 py-1.5"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-mono text-[10px] text-slate-400">
                    {t.code}
                  </span>
                  <span className="truncate font-bold text-slate-700">
                    {t.name}
                  </span>
                </div>
                <span className="font-mono font-bold text-rose-700">
                  {EGP(t.current_balance)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card p-5">
        <div className="flex items-center gap-2 mb-3">
          <TrendingUp className="text-emerald-600" size={18} />
          <h3 className="font-black text-slate-800">
            أعلى مشتريات — آخر 30 يوم
          </h3>
        </div>
        {analytics.topSpend.length === 0 ? (
          <div className="text-xs text-slate-400">لا مشتريات</div>
        ) : (
          <ul className="space-y-1 text-xs">
            {analytics.topSpend.map((t: any) => (
              <li
                key={t.id}
                className="flex items-center justify-between border-b border-slate-100 last:border-0 py-1.5"
              >
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="font-mono text-[10px] text-slate-400">
                    {t.code}
                  </span>
                  <span className="truncate font-bold text-slate-700">
                    {t.name}
                  </span>
                </div>
                <span className="font-mono font-bold text-emerald-700">
                  {EGP(t.spend)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/* ───────── Upcoming payments inbox ───────── */

const DOW_LABEL: Record<number, string> = {
  0: 'الأحد',
  1: 'الإثنين',
  2: 'الثلاثاء',
  3: 'الأربعاء',
  4: 'الخميس',
  5: 'الجمعة',
  6: 'السبت',
};

function UpcomingPaymentsInbox({ upcoming }: { upcoming: any[] }) {
  return (
    <div className="card p-5 border-2 border-amber-200 bg-amber-50/40">
      <div className="flex items-center gap-2 mb-3">
        <CalendarClock className="text-amber-600" size={18} />
        <h3 className="font-black text-amber-800">
          دفعات قريبة ({upcoming.length})
        </h3>
      </div>
      <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-2">
        {upcoming.map((u) => (
          <Link
            key={u.id}
            to={`/suppliers/${u.id}`}
            className="bg-white border border-amber-200 rounded-lg p-3 text-xs hover:border-amber-400"
          >
            <div className="flex items-center justify-between mb-1">
              <div className="flex items-center gap-2 min-w-0">
                <span className="font-mono text-[10px] text-slate-400">
                  {u.code}
                </span>
                <span className="font-black text-slate-800 truncate">
                  {u.name}
                </span>
              </div>
              <span
                className={`chip border text-[10px] ${
                  u.days_until <= 1
                    ? 'bg-rose-100 text-rose-700 border-rose-200'
                    : u.days_until <= 3
                      ? 'bg-amber-100 text-amber-700 border-amber-200'
                      : 'bg-slate-100 text-slate-600 border-slate-200'
                }`}
              >
                {u.days_until === 0
                  ? 'اليوم'
                  : u.days_until === 1
                    ? 'غدًا'
                    : `بعد ${u.days_until} يوم`}
              </span>
            </div>
            <div className="text-slate-500">
              {DOW_LABEL[u.payment_day_of_week]} —{' '}
              <span className="tabular-nums">{u.next_payment_date}</span>
            </div>
            <div className="flex items-center justify-between mt-1.5">
              <span className="text-slate-600">
                دفعة:{' '}
                <span className="font-bold">
                  {u.payment_installment_amount
                    ? EGP(u.payment_installment_amount)
                    : 'غير محددة'}
                </span>
              </span>
              <span className="font-mono text-rose-700">
                مدين {EGP(u.current_balance)}
              </span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}

function Modal({
  title,
  onClose,
  children,
  size = 'md',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  size?: 'md' | 'lg';
}) {
  const w = size === 'lg' ? 'max-w-3xl' : 'max-w-xl';
  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className={`bg-white rounded-2xl w-full ${w} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between p-5 border-b border-slate-100 sticky top-0 bg-white z-10">
          <h3 className="font-black text-lg text-slate-800">{title}</h3>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X size={20} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function CreateSupplierModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [form, setForm] = useState({
    code: '',
    name: '',
    phone: '',
    email: '',
    address: '',
    supplier_type: 'credit' as 'cash' | 'credit' | 'installments',
    credit_limit: '',
    opening_balance: '',
    payment_terms_days: '',
  });
  const mutation = useMutation({
    mutationFn: (body: any) => suppliersApi.create(body),
    onSuccess: () => {
      toast.success('تم إضافة المورد');
      onSuccess();
    },
    onError: (e: any) =>
      toast.error(
        e?.response?.data?.message ||
          (Array.isArray(e?.response?.data?.message)
            ? e.response.data.message[0]
            : 'فشل إضافة المورد'),
      ),
  });

  return (
    <Modal title="إضافة مورد جديد" onClose={onClose}>
      <div className="space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="كود المورد (اختياري — أرقام فقط)">
            <input
              className="input"
              dir="ltr"
              value={form.code}
              onChange={(e) =>
                setForm({
                  ...form,
                  code: e.target.value.replace(/[^0-9]/g, ''),
                })
              }
              placeholder="يُولَّد تلقائيًا"
            />
          </Field>
          <Field label="الاسم *">
            <input
              className="input"
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
            />
          </Field>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="الهاتف">
            <input
              className="input"
              dir="ltr"
              value={form.phone}
              onChange={(e) => setForm({ ...form, phone: e.target.value })}
            />
          </Field>
          <Field label="البريد الإلكتروني">
            <input
              className="input"
              type="email"
              dir="ltr"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
            />
          </Field>
        </div>
        <Field label="العنوان">
          <textarea
            rows={2}
            className="input"
            value={form.address}
            onChange={(e) => setForm({ ...form, address: e.target.value })}
          />
        </Field>
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="نوع التعامل">
            <select
              className="input"
              value={form.supplier_type}
              onChange={(e) =>
                setForm({ ...form, supplier_type: e.target.value as any })
              }
            >
              <option value="cash">كاش</option>
              <option value="credit">آجل</option>
              <option value="installments">أقساط</option>
            </select>
          </Field>
          <Field label="مهلة السداد (يوم)">
            <input
              type="number"
              min="0"
              className="input"
              dir="ltr"
              value={form.payment_terms_days}
              onChange={(e) =>
                setForm({ ...form, payment_terms_days: e.target.value })
              }
            />
          </Field>
          <Field label="حد الائتمان (ج.م)">
            <input
              type="number"
              min="0"
              step="0.01"
              className="input"
              dir="ltr"
              value={form.credit_limit}
              onChange={(e) =>
                setForm({ ...form, credit_limit: e.target.value })
              }
            />
          </Field>
          <Field label="الرصيد الافتتاحي (ج.م)">
            <input
              type="number"
              min="0"
              step="0.01"
              className="input"
              dir="ltr"
              value={form.opening_balance}
              onChange={(e) =>
                setForm({ ...form, opening_balance: e.target.value })
              }
            />
          </Field>
        </div>

        <div className="flex gap-2 pt-2">
          <button
            className="btn-primary flex-1"
            onClick={() => {
              if (!form.name) return toast.error('الاسم مطلوب');
              if (form.code && !/^[0-9]+$/.test(form.code)) {
                return toast.error('كود المورد أرقام إنجليزي فقط');
              }
              mutation.mutate({
                ...form,
                code: form.code || undefined,
                credit_limit: form.credit_limit
                  ? Number(form.credit_limit)
                  : undefined,
                opening_balance: form.opening_balance
                  ? Number(form.opening_balance)
                  : undefined,
                payment_terms_days: form.payment_terms_days
                  ? Number(form.payment_terms_days)
                  : undefined,
              } as any);
            }}
            disabled={mutation.isPending}
          >
            <Plus size={18} /> حفظ
          </button>
          <button className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function LedgerModal({
  supplier,
  onClose,
}: {
  supplier: Supplier;
  onClose: () => void;
}) {
  const { data: entries = [], isLoading } = useQuery({
    queryKey: ['supplier-ledger', supplier.id],
    queryFn: () => suppliersApi.ledger(supplier.id),
  });

  return (
    <Modal title={`كشف حساب: ${supplier.name}`} onClose={onClose} size="lg">
      {isLoading ? (
        <div className="text-center py-8 text-slate-400">جارٍ التحميل...</div>
      ) : entries.length === 0 ? (
        <div className="text-center py-8 text-slate-400">لا توجد حركات</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs font-bold">
              <tr>
                <th className="text-right px-3 py-2">التاريخ</th>
                <th className="text-right px-3 py-2">البيان</th>
                <th className="text-right px-3 py-2">مدين</th>
                <th className="text-right px-3 py-2">دائن</th>
                <th className="text-right px-3 py-2">الرصيد</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e: any, idx: number) => (
                <tr key={idx} className="border-t border-slate-100">
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {new Date(e.entry_date).toLocaleDateString('en-US')}
                  </td>
                  <td className="px-3 py-2">
                    <div className="font-bold">{e.description || e.doc_type}</div>
                    <div className="text-xs text-slate-400 font-mono">{e.doc_no}</div>
                  </td>
                  <td className="px-3 py-2 text-rose-600 font-bold">
                    {Number(e.debit) ? EGP(e.debit) : '—'}
                  </td>
                  <td className="px-3 py-2 text-emerald-600 font-bold">
                    {Number(e.credit) ? EGP(e.credit) : '—'}
                  </td>
                  <td className="px-3 py-2 font-bold">{EGP(e.balance)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

function QuickPayModal({
  supplier,
  onClose,
  onSuccess,
}: {
  supplier: Supplier;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<
    'cash' | 'card' | 'instapay' | 'bank_transfer'
  >('cash');
  const [reference, setReference] = useState('');
  const [notes, setNotes] = useState('');

  const { data: cashboxes = [] } = useQuery({
    queryKey: ['cashboxes'],
    queryFn: () => cashDeskApi.cashboxes(),
  });
  const [cashboxId, setCashboxId] = useState('');

  const mutation = useMutation({
    mutationFn: cashDeskApi.pay,
    onSuccess: () => {
      toast.success('تم حفظ الدفعة');
      onSuccess();
    },
  });

  const cbId = cashboxId || cashboxes[0]?.id;

  return (
    <Modal title={`دفعة للمورد: ${supplier.name}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="الخزينة">
            <select
              className="input"
              value={cbId || ''}
              onChange={(e) => setCashboxId(e.target.value)}
            >
              <option value="">-- اختر --</option>
              {cashboxes.map((cb) => (
                <option key={cb.id} value={cb.id}>
                  {cb.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="طريقة الدفع">
            <select
              className="input"
              value={method}
              onChange={(e) => setMethod(e.target.value as any)}
            >
              <option value="cash">نقدي</option>
              <option value="card">بطاقة</option>
              <option value="instapay">إنستا باي</option>
              <option value="bank_transfer">تحويل بنكي</option>
            </select>
          </Field>
        </div>
        <div className="grid md:grid-cols-2 gap-3">
          <Field label="المبلغ">
            <input
              type="number"
              step="0.01"
              className="input"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
            />
          </Field>
          <Field label="المرجع">
            <input
              className="input"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
            />
          </Field>
        </div>
        <Field label="ملاحظات">
          <textarea
            rows={2}
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        <div className="flex gap-2 pt-2">
          <button
            className="btn-primary flex-1"
            disabled={mutation.isPending}
            onClick={() => {
              if (!cbId) return toast.error('اختر الخزينة');
              const amt = Number(amount);
              if (!amt || amt <= 0) return toast.error('أدخل مبلغاً');
              mutation.mutate({
                supplier_id: supplier.id,
                cashbox_id: cbId,
                payment_method: method,
                amount: amt,
                reference: reference || undefined,
                notes: notes || undefined,
              });
            }}
          >
            <CreditCard size={18} /> حفظ الدفعة
          </button>
          <button className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-slate-600 mb-1 block">{label}</span>
      {children}
    </label>
  );
}
