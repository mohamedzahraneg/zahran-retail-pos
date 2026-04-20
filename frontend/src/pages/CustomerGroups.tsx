import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Users2,
  Plus,
  Trash2,
  Edit2,
  Crown,
  Star,
  X,
  Tag,
  Percent,
  DollarSign,
  CheckCircle2,
  XCircle,
} from 'lucide-react';
import {
  customerGroupsApi,
  CustomerGroup,
  GroupPrice,
  CreateCustomerGroupInput,
} from '@/api/customerGroups.api';

const EGP = (n: number | string) => {
  const v = typeof n === 'string' ? Number(n) : n;
  return isFinite(v) ? `${v.toFixed(2)} EGP` : '—';
};

export default function CustomerGroups() {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CustomerGroup | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: groups = [], isLoading } = useQuery({
    queryKey: ['customer-groups'],
    queryFn: () => customerGroupsApi.list(true),
  });

  const removeM = useMutation({
    mutationFn: (id: string) => customerGroupsApi.remove(id),
    onSuccess: () => {
      toast.success('تم الحذف');
      qc.invalidateQueries({ queryKey: ['customer-groups'] });
      if (selectedId) setSelectedId(null);
    },
    onError: (e: any) => toast.error(e?.message || 'فشل الحذف'),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['customer-groups'] });
    qc.invalidateQueries({ queryKey: ['customer-group', selectedId] });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Users2 className="text-brand-600" /> مجموعات العملاء والأسعار
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            تعريف شرائح التجزئة / الجملة وأسعار مخصصة لكل شريحة — تُطبَّق تلقائياً في
            نقطة البيع.
          </p>
        </div>
        <button
          className="btn-primary"
          onClick={() => {
            setEditing(null);
            setShowForm(true);
          }}
        >
          <Plus size={16} /> مجموعة جديدة
        </button>
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {isLoading && (
          <div className="col-span-3 py-12 text-center text-slate-400">
            جارٍ التحميل...
          </div>
        )}
        {groups.map((g) => (
          <div
            key={g.id}
            className={`card p-5 cursor-pointer transition ${
              selectedId === g.id
                ? 'ring-2 ring-brand-500 shadow-glow'
                : 'hover:shadow-md'
            }`}
            onClick={() => setSelectedId(g.id)}
          >
            <div className="flex items-start justify-between mb-3">
              <div>
                <div className="flex items-center gap-2">
                  {g.is_wholesale ? (
                    <Crown size={16} className="text-amber-500" />
                  ) : (
                    <Star size={16} className="text-sky-500" />
                  )}
                  <div className="font-black text-slate-800 text-lg">
                    {g.name_ar}
                  </div>
                </div>
                <div className="text-xs text-slate-500 font-mono mt-1">
                  {g.code}
                </div>
              </div>
              <div className="flex flex-col items-end gap-1">
                {g.is_default && (
                  <span className="chip bg-brand-100 text-brand-700">
                    افتراضي
                  </span>
                )}
                {!g.is_active && (
                  <span className="chip bg-slate-200 text-slate-600">
                    معطّلة
                  </span>
                )}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-2 mt-3 text-center">
              <div className="bg-slate-50 rounded-lg py-2">
                <div className="text-xs text-slate-500">عملاء</div>
                <div className="font-black">{g.customers_count ?? 0}</div>
              </div>
              <div className="bg-slate-50 rounded-lg py-2">
                <div className="text-xs text-slate-500">أسعار SKU</div>
                <div className="font-black">
                  {g.variant_overrides_count ?? 0}
                </div>
              </div>
              <div className="bg-slate-50 rounded-lg py-2">
                <div className="text-xs text-slate-500">تصنيفات</div>
                <div className="font-black">{g.category_rules_count ?? 0}</div>
              </div>
            </div>

            <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-100">
              <div className="flex items-center gap-2 text-sm text-slate-600">
                <Percent size={14} className="text-brand-500" />
                <span className="font-semibold">
                  خصم افتراضي: {g.default_discount_pct}%
                </span>
              </div>
              <div className="flex gap-1">
                <button
                  className="icon-btn"
                  onClick={(e) => {
                    e.stopPropagation();
                    setEditing(g);
                    setShowForm(true);
                  }}
                >
                  <Edit2 size={14} />
                </button>
                <button
                  className="icon-btn text-rose-600"
                  disabled={g.is_default}
                  title={g.is_default ? 'لا يمكن حذف الافتراضي' : 'حذف'}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (confirm(`حذف المجموعة ${g.name_ar}؟`)) removeM.mutate(g.id);
                  }}
                >
                  <Trash2 size={14} />
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>

      {selectedId && (
        <GroupDetails
          groupId={selectedId}
          onClose={() => setSelectedId(null)}
          onInvalidate={invalidate}
        />
      )}

      {showForm && (
        <GroupFormModal
          editing={editing}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            invalidate();
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Group Details Panel (prices + category rules)
// ============================================================================

function GroupDetails({
  groupId,
  onClose,
  onInvalidate,
}: {
  groupId: string;
  onClose: () => void;
  onInvalidate: () => void;
}) {
  const qc = useQueryClient();
  const [showPriceForm, setShowPriceForm] = useState(false);
  const [showCatForm, setShowCatForm] = useState(false);

  const { data: details, isLoading } = useQuery({
    queryKey: ['customer-group', groupId],
    queryFn: () => customerGroupsApi.get(groupId),
  });

  const removePriceM = useMutation({
    mutationFn: (id: string) => customerGroupsApi.removePrice(id),
    onSuccess: () => {
      toast.success('تم الحذف');
      qc.invalidateQueries({ queryKey: ['customer-group', groupId] });
      onInvalidate();
    },
  });
  const removeCatM = useMutation({
    mutationFn: (id: string) => customerGroupsApi.removeCategoryRule(id),
    onSuccess: () => {
      toast.success('تم الحذف');
      qc.invalidateQueries({ queryKey: ['customer-group', groupId] });
      onInvalidate();
    },
  });

  if (isLoading || !details) {
    return (
      <div className="card p-8 text-center text-slate-400">
        جارٍ تحميل تفاصيل المجموعة...
      </div>
    );
  }

  return (
    <div className="card p-5 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-xl font-black text-slate-800">
            تفاصيل: {details.name_ar}
          </h3>
          <div className="text-xs text-slate-500 font-mono mt-1">
            {details.code}
          </div>
        </div>
        <button className="icon-btn" onClick={onClose}>
          <X size={18} />
        </button>
      </div>

      {/* Variant-level prices */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-bold text-slate-700 flex items-center gap-2">
            <DollarSign size={16} /> أسعار مخصصة لكل SKU (
            {details.prices?.length ?? 0})
          </h4>
          <button
            className="btn-secondary"
            onClick={() => setShowPriceForm(true)}
          >
            <Plus size={14} /> سعر لمنتج
          </button>
        </div>

        {(details.prices?.length ?? 0) === 0 ? (
          <div className="text-sm text-slate-400 py-4 text-center border border-dashed border-slate-200 rounded-lg">
            لا توجد أسعار مخصصة — سيُطبَّق الخصم الافتراضي للمجموعة
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-right">المنتج</th>
                  <th className="px-3 py-2 text-right">SKU</th>
                  <th className="px-3 py-2 text-right">السعر الأساسي</th>
                  <th className="px-3 py-2 text-right">سعر المجموعة</th>
                  <th className="px-3 py-2 text-right">الحد الأدنى</th>
                  <th className="px-3 py-2 text-right">الحالة</th>
                  <th className="px-3 py-2 text-right"></th>
                </tr>
              </thead>
              <tbody>
                {details.prices?.map((p: GroupPrice) => (
                  <tr key={p.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{p.product_name || '—'}</td>
                    <td className="px-3 py-2 font-mono">{p.sku || '—'}</td>
                    <td className="px-3 py-2 text-slate-500">
                      {EGP(p.base_price ?? 0)}
                    </td>
                    <td className="px-3 py-2 font-bold text-brand-700">
                      {EGP(p.price)}
                    </td>
                    <td className="px-3 py-2">{p.min_qty}</td>
                    <td className="px-3 py-2">
                      {p.is_active ? (
                        <span className="chip bg-emerald-100 text-emerald-800">
                          <CheckCircle2 size={12} /> فعّال
                        </span>
                      ) : (
                        <span className="chip bg-slate-200 text-slate-600">
                          <XCircle size={12} /> معطّل
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-left">
                      <button
                        className="icon-btn text-rose-600"
                        onClick={() => {
                          if (confirm('حذف هذا السعر؟'))
                            removePriceM.mutate(p.id);
                        }}
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
      </div>

      {/* Category rules */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h4 className="font-bold text-slate-700 flex items-center gap-2">
            <Tag size={16} /> قواعد خصم لكل تصنيف (
            {details.categories?.length ?? 0})
          </h4>
          <button className="btn-secondary" onClick={() => setShowCatForm(true)}>
            <Plus size={14} /> قاعدة تصنيف
          </button>
        </div>

        {(details.categories?.length ?? 0) === 0 ? (
          <div className="text-sm text-slate-400 py-4 text-center border border-dashed border-slate-200 rounded-lg">
            لا توجد قواعد تصنيف — سيُطبَّق الخصم الافتراضي للمجموعة
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="px-3 py-2 text-right">التصنيف</th>
                  <th className="px-3 py-2 text-right">كود</th>
                  <th className="px-3 py-2 text-right">نسبة الخصم</th>
                  <th className="px-3 py-2 text-right">الحالة</th>
                  <th className="px-3 py-2 text-right"></th>
                </tr>
              </thead>
              <tbody>
                {details.categories?.map((c) => (
                  <tr key={c.id} className="border-t border-slate-100">
                    <td className="px-3 py-2">{c.category_name || '—'}</td>
                    <td className="px-3 py-2 font-mono">
                      {c.category_code || '—'}
                    </td>
                    <td className="px-3 py-2 font-bold text-brand-700">
                      {c.discount_pct}%
                    </td>
                    <td className="px-3 py-2">
                      {c.is_active ? (
                        <span className="chip bg-emerald-100 text-emerald-800">
                          فعّال
                        </span>
                      ) : (
                        <span className="chip bg-slate-200 text-slate-600">
                          معطّل
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-left">
                      <button
                        className="icon-btn text-rose-600"
                        onClick={() => {
                          if (confirm('حذف هذه القاعدة؟'))
                            removeCatM.mutate(c.id);
                        }}
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
      </div>

      {showPriceForm && (
        <PriceFormModal
          groupId={groupId}
          onClose={() => setShowPriceForm(false)}
          onSaved={() => {
            setShowPriceForm(false);
            qc.invalidateQueries({ queryKey: ['customer-group', groupId] });
            onInvalidate();
          }}
        />
      )}
      {showCatForm && (
        <CategoryRuleFormModal
          groupId={groupId}
          onClose={() => setShowCatForm(false)}
          onSaved={() => {
            setShowCatForm(false);
            qc.invalidateQueries({ queryKey: ['customer-group', groupId] });
            onInvalidate();
          }}
        />
      )}
    </div>
  );
}

// ============================================================================
// Group Form Modal
// ============================================================================

function GroupFormModal({
  editing,
  onClose,
  onSaved,
}: {
  editing: CustomerGroup | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<CreateCustomerGroupInput>({
    code: editing?.code || '',
    name_ar: editing?.name_ar || '',
    name_en: editing?.name_en || '',
    description: editing?.description || '',
    is_wholesale: editing?.is_wholesale ?? false,
    default_discount_pct: editing?.default_discount_pct ?? 0,
    min_order_amount: editing?.min_order_amount ?? 0,
    credit_limit: editing?.credit_limit ?? 0,
    payment_terms_days: editing?.payment_terms_days ?? 0,
    is_active: editing?.is_active ?? true,
    is_default: editing?.is_default ?? false,
  });

  const saveM = useMutation({
    mutationFn: () =>
      editing
        ? customerGroupsApi.update(editing.id, form)
        : customerGroupsApi.create(form),
    onSuccess: () => {
      toast.success(editing ? 'تم التحديث' : 'تم الإنشاء');
      onSaved();
    },
    onError: (e: any) => toast.error(e?.message || 'فشل الحفظ'),
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-xl">
        <div className="flex items-center justify-between p-4 border-b border-slate-100">
          <h3 className="font-black text-lg">
            {editing ? 'تعديل مجموعة' : 'مجموعة عملاء جديدة'}
          </h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <Field label="الرمز" required>
              <input
                className="input"
                value={form.code}
                onChange={(e) => setForm((f) => ({ ...f, code: e.target.value }))}
                placeholder="WHS-GOLD"
              />
            </Field>
            <Field label="الاسم العربي" required>
              <input
                className="input"
                value={form.name_ar}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name_ar: e.target.value }))
                }
                placeholder="جملة ذهبية"
              />
            </Field>
            <Field label="الاسم الإنجليزي">
              <input
                className="input"
                value={form.name_en}
                onChange={(e) =>
                  setForm((f) => ({ ...f, name_en: e.target.value }))
                }
              />
            </Field>
            <Field label="نسبة الخصم الافتراضية (%)">
              <input
                type="number"
                className="input"
                min={0}
                max={100}
                value={form.default_discount_pct ?? 0}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    default_discount_pct: Number(e.target.value),
                  }))
                }
              />
            </Field>
            <Field label="الحد الأدنى للفاتورة">
              <input
                type="number"
                className="input"
                min={0}
                value={form.min_order_amount ?? 0}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    min_order_amount: Number(e.target.value),
                  }))
                }
              />
            </Field>
            <Field label="حد الائتمان">
              <input
                type="number"
                className="input"
                min={0}
                value={form.credit_limit ?? 0}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    credit_limit: Number(e.target.value),
                  }))
                }
              />
            </Field>
            <Field label="مهلة السداد (يوم)">
              <input
                type="number"
                className="input"
                min={0}
                value={form.payment_terms_days ?? 0}
                onChange={(e) =>
                  setForm((f) => ({
                    ...f,
                    payment_terms_days: Number(e.target.value),
                  }))
                }
              />
            </Field>
          </div>

          <Field label="الوصف">
            <textarea
              className="input min-h-[60px]"
              value={form.description || ''}
              onChange={(e) =>
                setForm((f) => ({ ...f, description: e.target.value }))
              }
            />
          </Field>

          <div className="grid grid-cols-3 gap-3 pt-2">
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.is_wholesale}
                onChange={(e) =>
                  setForm((f) => ({ ...f, is_wholesale: e.target.checked }))
                }
              />
              <span className="text-sm">جملة</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.is_active}
                onChange={(e) =>
                  setForm((f) => ({ ...f, is_active: e.target.checked }))
                }
              />
              <span className="text-sm">فعّالة</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                checked={form.is_default}
                onChange={(e) =>
                  setForm((f) => ({ ...f, is_default: e.target.checked }))
                }
              />
              <span className="text-sm">افتراضية</span>
            </label>
          </div>
        </div>

        <div className="p-4 border-t border-slate-100 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            إلغاء
          </button>
          <button
            className="btn-primary"
            disabled={saveM.isPending}
            onClick={() => saveM.mutate()}
          >
            {saveM.isPending ? '...' : 'حفظ'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Price Form Modal (per-SKU override)
// ============================================================================

function PriceFormModal({
  groupId,
  onClose,
  onSaved,
}: {
  groupId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    variant_id: '',
    price: 0,
    min_qty: 1,
    valid_from: '' as string | '',
    valid_to: '' as string | '',
    is_active: true,
    notes: '',
  });

  const saveM = useMutation({
    mutationFn: () =>
      customerGroupsApi.upsertPrice(groupId, {
        variant_id: form.variant_id,
        price: form.price,
        min_qty: form.min_qty,
        valid_from: form.valid_from || null,
        valid_to: form.valid_to || null,
        is_active: form.is_active,
        notes: form.notes,
      }),
    onSuccess: () => {
      toast.success('تم الحفظ');
      onSaved();
    },
    onError: (e: any) => toast.error(e?.message || 'فشل الحفظ'),
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-4 border-b border-slate-100">
          <h3 className="font-black text-lg">سعر مخصص لمنتج</h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <Field label="معرّف المنتج (variant_id)" required>
            <input
              className="input font-mono text-xs"
              value={form.variant_id}
              onChange={(e) =>
                setForm((f) => ({ ...f, variant_id: e.target.value }))
              }
              placeholder="uuid"
            />
            <p className="text-xs text-slate-500 mt-1">
              انسخ معرّف الـ SKU من صفحة المنتجات
            </p>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="السعر" required>
              <input
                type="number"
                step="0.01"
                className="input"
                value={form.price}
                onChange={(e) =>
                  setForm((f) => ({ ...f, price: Number(e.target.value) }))
                }
              />
            </Field>
            <Field label="الحد الأدنى للكمية">
              <input
                type="number"
                min={1}
                className="input"
                value={form.min_qty}
                onChange={(e) =>
                  setForm((f) => ({ ...f, min_qty: Number(e.target.value) }))
                }
              />
            </Field>
            <Field label="من تاريخ">
              <input
                type="date"
                className="input"
                value={form.valid_from}
                onChange={(e) =>
                  setForm((f) => ({ ...f, valid_from: e.target.value }))
                }
              />
            </Field>
            <Field label="إلى تاريخ">
              <input
                type="date"
                className="input"
                value={form.valid_to}
                onChange={(e) =>
                  setForm((f) => ({ ...f, valid_to: e.target.value }))
                }
              />
            </Field>
          </div>
          <Field label="ملاحظات">
            <input
              className="input"
              value={form.notes}
              onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            />
          </Field>
          <label className="flex items-center gap-2 pt-2">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) =>
                setForm((f) => ({ ...f, is_active: e.target.checked }))
              }
            />
            <span className="text-sm">فعّال</span>
          </label>
        </div>
        <div className="p-4 border-t border-slate-100 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            إلغاء
          </button>
          <button
            className="btn-primary"
            disabled={saveM.isPending || !form.variant_id}
            onClick={() => saveM.mutate()}
          >
            {saveM.isPending ? '...' : 'حفظ'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// Category Rule Modal
// ============================================================================

function CategoryRuleFormModal({
  groupId,
  onClose,
  onSaved,
}: {
  groupId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState({
    category_id: '',
    discount_pct: 10,
    is_active: true,
  });
  const saveM = useMutation({
    mutationFn: () =>
      customerGroupsApi.upsertCategoryRule(groupId, {
        category_id: form.category_id,
        discount_pct: form.discount_pct,
        is_active: form.is_active,
      }),
    onSuccess: () => {
      toast.success('تم الحفظ');
      onSaved();
    },
    onError: (e: any) => toast.error(e?.message || 'فشل الحفظ'),
  });

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-md">
        <div className="flex items-center justify-between p-4 border-b border-slate-100">
          <h3 className="font-black text-lg">قاعدة خصم لتصنيف</h3>
          <button className="icon-btn" onClick={onClose}>
            <X size={18} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <Field label="معرّف التصنيف (category_id)" required>
            <input
              className="input font-mono text-xs"
              value={form.category_id}
              onChange={(e) =>
                setForm((f) => ({ ...f, category_id: e.target.value }))
              }
              placeholder="uuid"
            />
          </Field>
          <Field label="نسبة الخصم (%)" required>
            <input
              type="number"
              min={0}
              max={100}
              className="input"
              value={form.discount_pct}
              onChange={(e) =>
                setForm((f) => ({ ...f, discount_pct: Number(e.target.value) }))
              }
            />
          </Field>
          <label className="flex items-center gap-2 pt-2">
            <input
              type="checkbox"
              checked={form.is_active}
              onChange={(e) =>
                setForm((f) => ({ ...f, is_active: e.target.checked }))
              }
            />
            <span className="text-sm">فعّال</span>
          </label>
        </div>
        <div className="p-4 border-t border-slate-100 flex justify-end gap-2">
          <button className="btn-ghost" onClick={onClose}>
            إلغاء
          </button>
          <button
            className="btn-primary"
            disabled={saveM.isPending || !form.category_id}
            onClick={() => saveM.mutate()}
          >
            {saveM.isPending ? '...' : 'حفظ'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------- helpers ----------

function Field({
  label,
  children,
  required,
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
}) {
  return (
    <label className="block">
      <div className="text-xs font-semibold text-slate-600 mb-1">
        {label} {required && <span className="text-rose-500">*</span>}
      </div>
      {children}
    </label>
  );
}
