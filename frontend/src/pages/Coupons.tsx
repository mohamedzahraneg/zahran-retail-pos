import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Ticket,
  Plus,
  Search,
  X,
  Pencil,
  Power,
  Calendar,
  Percent,
  Tag,
  TrendingUp,
} from 'lucide-react';
import {
  couponsApi,
  Coupon,
  CreateCouponPayload,
  CouponType,
} from '@/api/coupons.api';

const EGP = (n: number | string) =>
  `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleDateString('en-US') : '—';

export default function Coupons() {
  const [q, setQ] = useState('');
  const [activeFilter, setActiveFilter] = useState<string>('');
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Coupon | null>(null);
  const [selected, setSelected] = useState<Coupon | null>(null);
  const qc = useQueryClient();

  const { data: coupons = [], isLoading } = useQuery({
    queryKey: ['coupons', q, activeFilter],
    queryFn: () =>
      couponsApi.list({
        q: q || undefined,
        active: activeFilter || undefined,
      }),
  });

  const totals = useMemo(() => {
    const active = coupons.filter((c) => c.is_active).length;
    const uses = coupons.reduce((s, c) => s + Number(c.uses_count), 0);
    return { total: coupons.length, active, uses };
  }, [coupons]);

  const toggleM = useMutation({
    mutationFn: (c: Coupon) =>
      couponsApi.update(c.id, { is_active: !c.is_active }),
    onSuccess: () => {
      toast.success('تم تحديث الحالة');
      qc.invalidateQueries({ queryKey: ['coupons'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل التحديث'),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Ticket className="text-brand-600" /> الكوبونات
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            إدارة أكواد الخصم والعروض
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={18} /> كوبون جديد
        </button>
      </div>

      <div className="grid md:grid-cols-3 gap-4">
        <Kpi
          title="إجمالي الكوبونات"
          value={String(totals.total)}
          icon={<Tag className="text-brand-600" />}
          color="bg-brand-50"
        />
        <Kpi
          title="المُفعّلة حالياً"
          value={String(totals.active)}
          icon={<Power className="text-emerald-600" />}
          color="bg-emerald-50"
        />
        <Kpi
          title="مجموع الاستخدامات"
          value={String(totals.uses)}
          icon={<TrendingUp className="text-amber-600" />}
          color="bg-amber-50"
        />
      </div>

      {/* Search + filters */}
      <div className="card p-4 flex gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px]">
          <Search
            size={16}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            className="input pr-10"
            placeholder="بحث بالكود أو الاسم…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <select
          className="input max-w-[200px]"
          value={activeFilter}
          onChange={(e) => setActiveFilter(e.target.value)}
        >
          <option value="">كل الحالات</option>
          <option value="true">مُفعّل فقط</option>
          <option value="false">معطّل فقط</option>
        </select>
      </div>

      {/* Table */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-slate-400">جاري التحميل…</div>
        ) : coupons.length === 0 ? (
          <div className="p-12 text-center">
            <Ticket className="mx-auto text-slate-300 mb-3" size={48} />
            <p className="text-slate-500">لا توجد كوبونات</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <Th>الكود</Th>
                  <Th>الاسم</Th>
                  <Th>النوع</Th>
                  <Th>القيمة</Th>
                  <Th>حد أدنى</Th>
                  <Th>الصلاحية</Th>
                  <Th>الاستخدام</Th>
                  <Th>الحالة</Th>
                  <Th>إجراءات</Th>
                </tr>
              </thead>
              <tbody>
                {coupons.map((c) => (
                  <tr
                    key={c.id}
                    className="border-t hover:bg-slate-50 cursor-pointer"
                    onClick={() => setSelected(c)}
                  >
                    <Td>
                      <span className="font-mono font-black text-brand-700 text-base">
                        {c.code}
                      </span>
                    </Td>
                    <Td className="font-bold">{c.name_ar}</Td>
                    <Td>
                      {c.coupon_type === 'percentage' ? (
                        <span className="text-emerald-700 inline-flex items-center gap-1">
                          <Percent size={12} /> نسبة
                        </span>
                      ) : (
                        <span className="text-blue-700">مبلغ ثابت</span>
                      )}
                    </Td>
                    <Td className="font-bold">
                      {c.coupon_type === 'percentage'
                        ? `${Number(c.value)}%`
                        : EGP(c.value)}
                    </Td>
                    <Td className="text-xs">
                      {Number(c.min_order_value) > 0
                        ? EGP(c.min_order_value)
                        : '—'}
                    </Td>
                    <Td className="text-xs text-slate-500">
                      {fmtDate(c.starts_at)} - {fmtDate(c.expires_at)}
                    </Td>
                    <Td>
                      <span className="font-bold">{c.uses_count}</span>
                      {c.max_uses_total && (
                        <span className="text-slate-400">
                          {' '}
                          / {c.max_uses_total}
                        </span>
                      )}
                    </Td>
                    <Td>
                      {c.is_active ? (
                        <span className="px-2 py-1 bg-emerald-100 text-emerald-700 rounded-lg text-xs font-bold">
                          مُفعّل
                        </span>
                      ) : (
                        <span className="px-2 py-1 bg-rose-100 text-rose-700 rounded-lg text-xs font-bold">
                          معطّل
                        </span>
                      )}
                    </Td>
                    <Td>
                      <div
                        className="flex gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          className="p-1.5 rounded-lg hover:bg-brand-100 text-brand-700"
                          title="تعديل"
                          onClick={() => setEditing(c)}
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className={`p-1.5 rounded-lg hover:bg-amber-100 ${c.is_active ? 'text-amber-700' : 'text-emerald-700'}`}
                          title={c.is_active ? 'تعطيل' : 'تفعيل'}
                          onClick={() => toggleM.mutate(c)}
                        >
                          <Power size={14} />
                        </button>
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {(showCreate || editing) && (
        <CouponModal
          coupon={editing || undefined}
          onClose={() => {
            setShowCreate(false);
            setEditing(null);
          }}
        />
      )}
      {selected && !editing && (
        <CouponDetailModal
          coupon={selected}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/* ---------------- Create / Edit Modal ---------------- */

function CouponModal({
  coupon,
  onClose,
}: {
  coupon?: Coupon;
  onClose: () => void;
}) {
  const [form, setForm] = useState<CreateCouponPayload>({
    code: coupon?.code || '',
    name_ar: coupon?.name_ar || '',
    name_en: coupon?.name_en || '',
    coupon_type: (coupon?.coupon_type as CouponType) || 'percentage',
    value: coupon ? Number(coupon.value) : 10,
    max_discount_amount: coupon?.max_discount_amount
      ? Number(coupon.max_discount_amount)
      : undefined,
    min_order_value: coupon ? Number(coupon.min_order_value) : 0,
    starts_at: coupon?.starts_at?.slice(0, 10),
    expires_at: coupon?.expires_at?.slice(0, 10),
    max_uses_total: coupon?.max_uses_total || undefined,
    max_uses_per_customer: coupon?.max_uses_per_customer || 1,
    is_active: coupon?.is_active ?? true,
  });
  const qc = useQueryClient();

  const saveM = useMutation({
    mutationFn: (payload: CreateCouponPayload) =>
      coupon
        ? couponsApi.update(coupon.id, payload)
        : couponsApi.create(payload),
    onSuccess: () => {
      toast.success(coupon ? 'تم التحديث' : 'تم الإنشاء');
      qc.invalidateQueries({ queryKey: ['coupons'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  const submit = () => {
    if (!form.code) return toast.error('أدخل الكود');
    if (!form.name_ar) return toast.error('أدخل الاسم');
    if (!form.value || form.value <= 0) return toast.error('أدخل القيمة');
    saveM.mutate({
      ...form,
      starts_at: form.starts_at || undefined,
      expires_at: form.expires_at || undefined,
    });
  };

  return (
    <Modal title={coupon ? 'تعديل كوبون' : 'كوبون جديد'} onClose={onClose} wide>
      <div className="grid md:grid-cols-2 gap-3">
        <Field label="الكود *">
          <input
            className="input uppercase"
            value={form.code}
            onChange={(e) =>
              setForm({ ...form, code: e.target.value.toUpperCase() })
            }
            placeholder="EID2026"
          />
        </Field>
        <Field label="الاسم بالعربي *">
          <input
            className="input"
            value={form.name_ar}
            onChange={(e) => setForm({ ...form, name_ar: e.target.value })}
          />
        </Field>
        <Field label="الاسم بالإنجليزي">
          <input
            className="input"
            value={form.name_en || ''}
            onChange={(e) => setForm({ ...form, name_en: e.target.value })}
          />
        </Field>
        <Field label="نوع الخصم">
          <select
            className="input"
            value={form.coupon_type}
            onChange={(e) =>
              setForm({
                ...form,
                coupon_type: e.target.value as CouponType,
              })
            }
          >
            <option value="percentage">نسبة %</option>
            <option value="fixed">مبلغ ثابت</option>
          </select>
        </Field>
        <Field
          label={
            form.coupon_type === 'percentage' ? 'النسبة (%)' : 'المبلغ (ج.م)'
          }
        >
          <input
            type="number"
            step="0.01"
            className="input"
            value={form.value}
            onChange={(e) =>
              setForm({ ...form, value: Number(e.target.value) || 0 })
            }
          />
        </Field>
        {form.coupon_type === 'percentage' && (
          <Field label="الحد الأقصى للخصم (اختياري)">
            <input
              type="number"
              step="0.01"
              className="input"
              value={form.max_discount_amount || ''}
              onChange={(e) =>
                setForm({
                  ...form,
                  max_discount_amount: e.target.value
                    ? Number(e.target.value)
                    : undefined,
                })
              }
            />
          </Field>
        )}
        <Field label="الحد الأدنى للفاتورة">
          <input
            type="number"
            step="0.01"
            className="input"
            value={form.min_order_value || 0}
            onChange={(e) =>
              setForm({
                ...form,
                min_order_value: Number(e.target.value) || 0,
              })
            }
          />
        </Field>
        <Field label="تاريخ البدء">
          <input
            type="date"
            className="input"
            value={form.starts_at || ''}
            onChange={(e) => setForm({ ...form, starts_at: e.target.value })}
          />
        </Field>
        <Field label="تاريخ الانتهاء">
          <input
            type="date"
            className="input"
            value={form.expires_at || ''}
            onChange={(e) => setForm({ ...form, expires_at: e.target.value })}
          />
        </Field>
        <Field label="حد الاستخدامات الإجمالي (اختياري)">
          <input
            type="number"
            className="input"
            value={form.max_uses_total || ''}
            onChange={(e) =>
              setForm({
                ...form,
                max_uses_total: e.target.value
                  ? Number(e.target.value)
                  : undefined,
              })
            }
          />
        </Field>
        <Field label="حد استخدامات لكل عميل">
          <input
            type="number"
            min={1}
            className="input"
            value={form.max_uses_per_customer || 1}
            onChange={(e) =>
              setForm({
                ...form,
                max_uses_per_customer: Number(e.target.value) || 1,
              })
            }
          />
        </Field>
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={form.is_active ?? true}
          onChange={(e) =>
            setForm({ ...form, is_active: e.target.checked })
          }
        />
        <span className="text-sm font-bold">كوبون مُفعّل</span>
      </label>

      <div className="flex gap-2 justify-end pt-2">
        <button className="btn-ghost" onClick={onClose}>
          إلغاء
        </button>
        <button
          className="btn-primary"
          onClick={submit}
          disabled={saveM.isPending}
        >
          {saveM.isPending ? 'جاري الحفظ…' : 'حفظ'}
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- Detail Modal ---------------- */

function CouponDetailModal({
  coupon,
  onClose,
}: {
  coupon: Coupon;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['coupon', coupon.id],
    queryFn: () => couponsApi.get(coupon.id),
  });

  if (isLoading || !data) {
    return (
      <Modal title={coupon.code} onClose={onClose} wide>
        <div className="p-8 text-center text-slate-400">جاري التحميل…</div>
      </Modal>
    );
  }

  const usages = data.usages || [];

  return (
    <Modal title={`كوبون ${data.code}`} onClose={onClose} wide>
      <div className="grid md:grid-cols-4 gap-3">
        <MiniStat
          icon={
            data.coupon_type === 'percentage' ? (
              <Percent className="text-emerald-600" />
            ) : (
              <Tag className="text-blue-600" />
            )
          }
          title="النوع"
          value={
            data.coupon_type === 'percentage'
              ? `${Number(data.value)}%`
              : EGP(data.value)
          }
        />
        <MiniStat
          icon={<TrendingUp className="text-amber-600" />}
          title="الاستخدامات"
          value={`${data.uses_count}${data.max_uses_total ? ` / ${data.max_uses_total}` : ''}`}
        />
        <MiniStat
          icon={<Calendar className="text-slate-600" />}
          title="ينتهي في"
          value={fmtDate(data.expires_at)}
        />
        <MiniStat
          icon={<Power className={data.is_active ? 'text-emerald-600' : 'text-rose-600'} />}
          title="الحالة"
          value={data.is_active ? 'مُفعّل' : 'معطّل'}
        />
      </div>

      <div>
        <h3 className="font-bold mb-2">آخر الاستخدامات</h3>
        {usages.length === 0 ? (
          <p className="text-sm text-slate-500 text-center p-4 bg-slate-50 rounded-xl">
            لم يُستخدم بعد
          </p>
        ) : (
          <div className="card p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <Th>التاريخ</Th>
                  <Th>الفاتورة</Th>
                  <Th>العميل</Th>
                  <Th>قيمة الخصم</Th>
                </tr>
              </thead>
              <tbody>
                {usages.map((u) => (
                  <tr key={u.id} className="border-t">
                    <Td className="text-xs">
                      {new Date(u.used_at).toLocaleString('en-US')}
                    </Td>
                    <Td className="font-mono">{u.invoice_no}</Td>
                    <Td>{u.customer_name || '—'}</Td>
                    <Td className="font-bold text-emerald-700">
                      {EGP(u.discount_amount)}
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ---------------- Primitives ---------------- */

function Modal({
  title,
  onClose,
  wide,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? 'max-w-4xl' : 'max-w-xl'} my-8`}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-bold">{title}</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-100"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-4 space-y-3">{children}</div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="block text-sm font-bold text-slate-700 mb-1">
        {label}
      </label>
      {children}
    </div>
  );
}

function Kpi({
  title,
  value,
  icon,
  color,
}: {
  title: string;
  value: string;
  icon: React.ReactNode;
  color: string;
}) {
  return (
    <div className="card p-5 flex items-center gap-4">
      <div className={`p-3 rounded-xl ${color}`}>{icon}</div>
      <div>
        <div className="text-xs text-slate-500">{title}</div>
        <div className="text-2xl font-black text-slate-800">{value}</div>
      </div>
    </div>
  );
}

function MiniStat({
  icon,
  title,
  value,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
}) {
  return (
    <div className="card p-3 flex items-center gap-3">
      <div className="p-2 bg-slate-50 rounded-lg">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-500">{title}</div>
        <div className="font-bold text-sm truncate">{value}</div>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-right font-bold text-xs p-3">{children}</th>;
}
function Td({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`p-3 ${className}`}>{children}</td>;
}
