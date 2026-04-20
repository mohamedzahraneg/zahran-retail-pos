import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Truck,
  Plus,
  Search,
  PackageCheck,
  CreditCard,
  XCircle,
  Eye,
  Trash2,
  FileText,
} from 'lucide-react';
import {
  purchasesApi,
  type Purchase,
  type PurchaseDetail,
  type PurchaseStatus,
  type CreatePurchaseItemPayload,
} from '@/api/purchases.api';
import { suppliersApi } from '@/api/suppliers.api';
import { settingsApi } from '@/api/settings.api';
import { productsApi } from '@/api/products.api';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const STATUS_LABELS: Record<PurchaseStatus, string> = {
  draft: 'مسودة',
  received: 'مستلمة',
  partial: 'سداد جزئي',
  paid: 'مسددة',
  cancelled: 'ملغاة',
};

const STATUS_COLORS: Record<PurchaseStatus, string> = {
  draft: 'bg-slate-100 text-slate-700',
  received: 'bg-blue-50 text-blue-700',
  partial: 'bg-amber-50 text-amber-700',
  paid: 'bg-emerald-50 text-emerald-700',
  cancelled: 'bg-rose-50 text-rose-700',
};

export default function PurchasesPage() {
  const [filter, setFilter] = useState<PurchaseStatus | ''>('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [payId, setPayId] = useState<string | null>(null);

  const qc = useQueryClient();

  const { data: purchases = [], isLoading } = useQuery({
    queryKey: ['purchases', filter, supplierFilter],
    queryFn: () =>
      purchasesApi.list({
        status: (filter || undefined) as PurchaseStatus | undefined,
        supplier_id: supplierFilter || undefined,
      }),
  });

  const { data: suppliers = [] } = useQuery({
    queryKey: ['suppliers-all'],
    queryFn: () => suppliersApi.list(),
  });

  const totals = useMemo(() => {
    const t = {
      count: purchases.length,
      total: 0,
      paid: 0,
      remaining: 0,
    };
    for (const p of purchases) {
      t.total += Number(p.grand_total || 0);
      t.paid += Number(p.paid_amount || 0);
      t.remaining += Number(p.grand_total || 0) - Number(p.paid_amount || 0);
    }
    return t;
  }, [purchases]);

  const receiveMut = useMutation({
    mutationFn: (id: string) => purchasesApi.receive(id),
    onSuccess: () => {
      toast.success('تم استلام الفاتورة وتحديث المخزون');
      qc.invalidateQueries({ queryKey: ['purchases'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الاستلام'),
  });

  const cancelMut = useMutation({
    mutationFn: (id: string) => purchasesApi.cancel(id),
    onSuccess: () => {
      toast.success('تم إلغاء الفاتورة');
      qc.invalidateQueries({ queryKey: ['purchases'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإلغاء'),
  });

  return (
    <div className="p-6 space-y-6" dir="rtl">
      <header className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-black flex items-center gap-2 text-slate-800">
            <Truck className="w-7 h-7 text-brand-500" />
            فواتير المشتريات
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            أوامر الشراء من الموردين واستلام البضاعة والسداد
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          فاتورة شراء جديدة
        </button>
      </header>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="عدد الفواتير" value={String(totals.count)} tone="slate" />
        <StatCard label="إجمالي المشتريات" value={EGP(totals.total)} tone="brand" />
        <StatCard label="المسدد" value={EGP(totals.paid)} tone="emerald" />
        <StatCard label="المتبقي" value={EGP(totals.remaining)} tone="rose" />
      </section>

      <div className="card p-4 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2 flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-slate-400" />
          <select
            className="bg-transparent outline-none flex-1"
            value={supplierFilter}
            onChange={(e) => setSupplierFilter(e.target.value)}
          >
            <option value="">كل الموردين</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <select
          className="input w-48"
          value={filter}
          onChange={(e) => setFilter(e.target.value as PurchaseStatus | '')}
        >
          <option value="">كل الحالات</option>
          <option value="draft">مسودة</option>
          <option value="received">مستلمة</option>
          <option value="partial">سداد جزئي</option>
          <option value="paid">مسددة</option>
          <option value="cancelled">ملغاة</option>
        </select>
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-10 text-center text-slate-400">جاري التحميل…</div>
        ) : purchases.length === 0 ? (
          <div className="p-10 text-center text-slate-400">
            لا توجد فواتير مشتريات
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="p-3 text-right">رقم الفاتورة</th>
                  <th className="p-3 text-right">المورد</th>
                  <th className="p-3 text-right">التاريخ</th>
                  <th className="p-3 text-right">الإجمالي</th>
                  <th className="p-3 text-right">المسدد</th>
                  <th className="p-3 text-right">المتبقي</th>
                  <th className="p-3 text-right">الحالة</th>
                  <th className="p-3"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {purchases.map((p) => {
                  const remaining = Number(p.grand_total) - Number(p.paid_amount);
                  return (
                    <tr key={p.id} className="hover:bg-slate-50">
                      <td className="p-3 font-mono font-bold text-brand-600">
                        {p.purchase_no}
                      </td>
                      <td className="p-3 font-medium">
                        {p.supplier_name || '—'}
                        {p.supplier_ref && (
                          <span className="block text-xs text-slate-400">
                            مرجع المورد: {p.supplier_ref}
                          </span>
                        )}
                      </td>
                      <td className="p-3 text-slate-600">
                        {new Date(p.invoice_date).toLocaleDateString('en-US')}
                      </td>
                      <td className="p-3 font-semibold">{EGP(p.grand_total)}</td>
                      <td className="p-3 text-emerald-600">
                        {EGP(p.paid_amount)}
                      </td>
                      <td className="p-3 text-rose-600">{EGP(remaining)}</td>
                      <td className="p-3">
                        <span
                          className={`px-2 py-1 rounded-full text-xs font-semibold ${STATUS_COLORS[p.status]}`}
                        >
                          {STATUS_LABELS[p.status]}
                        </span>
                      </td>
                      <td className="p-3">
                        <div className="flex items-center gap-1 justify-end">
                          <button
                            title="عرض التفاصيل"
                            onClick={() => setDetailId(p.id)}
                            className="icon-btn"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          {p.status === 'draft' && (
                            <button
                              title="استلام البضاعة"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `هل تريد استلام الفاتورة ${p.purchase_no}؟ سيتم تحديث المخزون تلقائياً`,
                                  )
                                ) {
                                  receiveMut.mutate(p.id);
                                }
                              }}
                              className="icon-btn text-blue-600"
                            >
                              <PackageCheck className="w-4 h-4" />
                            </button>
                          )}
                          {(p.status === 'received' || p.status === 'partial') && (
                            <button
                              title="تسجيل دفعة"
                              onClick={() => setPayId(p.id)}
                              className="icon-btn text-emerald-600"
                            >
                              <CreditCard className="w-4 h-4" />
                            </button>
                          )}
                          {p.status === 'draft' && (
                            <button
                              title="إلغاء"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `هل تريد إلغاء الفاتورة ${p.purchase_no}؟`,
                                  )
                                ) {
                                  cancelMut.mutate(p.id);
                                }
                              }}
                              className="icon-btn text-rose-600"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && (
        <CreatePurchaseModal onClose={() => setShowCreate(false)} />
      )}

      {detailId && (
        <PurchaseDetailModal id={detailId} onClose={() => setDetailId(null)} />
      )}

      {payId && (
        <PayPurchaseModal id={payId} onClose={() => setPayId(null)} />
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'slate' | 'brand' | 'emerald' | 'rose';
}) {
  const colors = {
    slate: 'text-slate-700',
    brand: 'text-brand-600',
    emerald: 'text-emerald-600',
    rose: 'text-rose-600',
  };
  return (
    <div className="card p-4">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className={`text-xl font-black ${colors[tone]}`}>{value}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function CreatePurchaseModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: suppliers = [] } = useQuery({
    queryKey: ['suppliers-all'],
    queryFn: () => suppliersApi.list(),
  });
  const { data: warehouses = [] } = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => settingsApi.listWarehouses(),
  });
  const { data: products } = useQuery({
    queryKey: ['products-for-purchase'],
    queryFn: () => productsApi.list({ limit: 500 }),
  });

  const [form, setForm] = useState({
    supplier_id: '',
    warehouse_id: '',
    invoice_date: new Date().toISOString().slice(0, 10),
    due_date: '',
    supplier_ref: '',
    shipping_cost: 0,
    discount_amount: 0,
    tax_amount: 0,
    notes: '',
  });

  const [items, setItems] = useState<
    (CreatePurchaseItemPayload & { display?: string })[]
  >([]);
  const [newItem, setNewItem] = useState({
    variant_id: '',
    quantity: 1,
    unit_cost: 0,
    discount: 0,
    tax: 0,
  });
  const [selectedProductId, setSelectedProductId] = useState('');

  const { data: productDetail } = useQuery({
    queryKey: ['product-variants', selectedProductId],
    queryFn: () => productsApi.get(selectedProductId),
    enabled: !!selectedProductId,
  });

  const subtotal = useMemo(
    () =>
      items.reduce(
        (s, i) =>
          s + (i.quantity * i.unit_cost - (i.discount || 0) + (i.tax || 0)),
        0,
      ),
    [items],
  );
  const grandTotal =
    subtotal -
    Number(form.discount_amount || 0) +
    Number(form.tax_amount || 0) +
    Number(form.shipping_cost || 0);

  const createMut = useMutation({
    mutationFn: () =>
      purchasesApi.create({
        supplier_id: form.supplier_id,
        warehouse_id: form.warehouse_id,
        invoice_date: form.invoice_date || undefined,
        due_date: form.due_date || undefined,
        supplier_ref: form.supplier_ref || undefined,
        shipping_cost: Number(form.shipping_cost) || undefined,
        discount_amount: Number(form.discount_amount) || undefined,
        tax_amount: Number(form.tax_amount) || undefined,
        notes: form.notes || undefined,
        items: items.map(({ display: _d, ...rest }) => rest),
      }),
    onSuccess: () => {
      toast.success('تم إنشاء فاتورة المشتريات');
      qc.invalidateQueries({ queryKey: ['purchases'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل إنشاء الفاتورة'),
  });

  const addItem = () => {
    if (!newItem.variant_id || newItem.quantity < 1 || newItem.unit_cost <= 0) {
      toast.error('اختر صنفاً وأدخل كمية وسعر صحيحين');
      return;
    }
    const v = productDetail?.variants?.find((x) => x.id === newItem.variant_id);
    const display = v
      ? `${productDetail?.name_ar} — ${v.sku}`
      : newItem.variant_id;
    setItems((xs) => [...xs, { ...newItem, display }]);
    setNewItem({ variant_id: '', quantity: 1, unit_cost: 0, discount: 0, tax: 0 });
    setSelectedProductId('');
  };

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.supplier_id || !form.warehouse_id) {
      toast.error('المورد والمخزن مطلوبان');
      return;
    }
    if (items.length === 0) {
      toast.error('أضف صنفاً واحداً على الأقل');
      return;
    }
    createMut.mutate();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-4xl space-y-4 max-h-[95vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-black flex items-center gap-2">
            <FileText className="w-5 h-5 text-brand-500" />
            فاتورة مشتريات جديدة
          </h2>
          <button type="button" onClick={onClose} className="icon-btn">
            <XCircle className="w-5 h-5" />
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <div>
            <label className="label">المورد *</label>
            <select
              className="input"
              value={form.supplier_id}
              onChange={(e) =>
                setForm({ ...form, supplier_id: e.target.value })
              }
              required
            >
              <option value="">— اختر —</option>
              {suppliers.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">المخزن *</label>
            <select
              className="input"
              value={form.warehouse_id}
              onChange={(e) =>
                setForm({ ...form, warehouse_id: e.target.value })
              }
              required
            >
              <option value="">— اختر —</option>
              {warehouses.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name_ar}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="label">تاريخ الفاتورة</label>
            <input
              type="date"
              className="input"
              value={form.invoice_date}
              onChange={(e) =>
                setForm({ ...form, invoice_date: e.target.value })
              }
            />
          </div>
          <div>
            <label className="label">تاريخ الاستحقاق</label>
            <input
              type="date"
              className="input"
              value={form.due_date}
              onChange={(e) => setForm({ ...form, due_date: e.target.value })}
            />
          </div>
          <div>
            <label className="label">مرجع المورد</label>
            <input
              className="input"
              placeholder="رقم فاتورة المورد"
              value={form.supplier_ref}
              onChange={(e) =>
                setForm({ ...form, supplier_ref: e.target.value })
              }
            />
          </div>
          <div>
            <label className="label">ملاحظات</label>
            <input
              className="input"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
            />
          </div>
        </div>

        {/* Items */}
        <div className="border border-slate-200 rounded-xl p-3 space-y-3">
          <h3 className="font-bold text-slate-700">الأصناف</h3>

          <div className="grid grid-cols-1 md:grid-cols-6 gap-2 items-end">
            <div className="md:col-span-2">
              <label className="label">المنتج</label>
              <select
                className="input"
                value={selectedProductId}
                onChange={(e) => {
                  setSelectedProductId(e.target.value);
                  setNewItem((i) => ({ ...i, variant_id: '' }));
                }}
              >
                <option value="">— اختر —</option>
                {(products?.data || []).map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name_ar} ({p.sku_root})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">اللون/المقاس</label>
              <select
                className="input"
                value={newItem.variant_id}
                onChange={(e) =>
                  setNewItem({ ...newItem, variant_id: e.target.value })
                }
                disabled={!selectedProductId}
              >
                <option value="">— اختر —</option>
                {(productDetail?.variants || []).map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.sku}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="label">الكمية</label>
              <input
                type="number"
                min={1}
                className="input"
                value={newItem.quantity}
                onChange={(e) =>
                  setNewItem({ ...newItem, quantity: Number(e.target.value) })
                }
              />
            </div>
            <div>
              <label className="label">سعر التكلفة</label>
              <input
                type="number"
                min={0}
                step="0.01"
                className="input"
                value={newItem.unit_cost}
                onChange={(e) =>
                  setNewItem({ ...newItem, unit_cost: Number(e.target.value) })
                }
              />
            </div>
            <button
              type="button"
              onClick={addItem}
              className="btn-primary h-10"
            >
              <Plus className="w-4 h-4" /> إضافة
            </button>
          </div>

          {items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="p-2 text-right">الصنف</th>
                    <th className="p-2 text-right">الكمية</th>
                    <th className="p-2 text-right">السعر</th>
                    <th className="p-2 text-right">الإجمالي</th>
                    <th className="p-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((it, idx) => {
                    const lt =
                      it.quantity * it.unit_cost -
                      (it.discount || 0) +
                      (it.tax || 0);
                    return (
                      <tr key={idx}>
                        <td className="p-2">{it.display || it.variant_id}</td>
                        <td className="p-2">{it.quantity}</td>
                        <td className="p-2">{EGP(it.unit_cost)}</td>
                        <td className="p-2 font-bold">{EGP(lt)}</td>
                        <td className="p-2">
                          <button
                            type="button"
                            onClick={() =>
                              setItems((xs) => xs.filter((_, i) => i !== idx))
                            }
                            className="icon-btn text-rose-500"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
          <div>
            <label className="label">الشحن</label>
            <input
              type="number"
              min={0}
              step="0.01"
              className="input"
              value={form.shipping_cost}
              onChange={(e) =>
                setForm({ ...form, shipping_cost: Number(e.target.value) })
              }
            />
          </div>
          <div>
            <label className="label">خصم إجمالي</label>
            <input
              type="number"
              min={0}
              step="0.01"
              className="input"
              value={form.discount_amount}
              onChange={(e) =>
                setForm({ ...form, discount_amount: Number(e.target.value) })
              }
            />
          </div>
          <div>
            <label className="label">ضريبة إجمالية</label>
            <input
              type="number"
              min={0}
              step="0.01"
              className="input"
              value={form.tax_amount}
              onChange={(e) =>
                setForm({ ...form, tax_amount: Number(e.target.value) })
              }
            />
          </div>
          <div>
            <label className="label">المجموع النهائي</label>
            <div className="input bg-slate-50 font-black text-brand-600">
              {EGP(grandTotal)}
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-ghost">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={createMut.isPending}
            className="btn-primary"
          >
            حفظ كمسودة
          </button>
        </div>
      </form>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function PurchaseDetailModal({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['purchase', id],
    queryFn: () => purchasesApi.get(id),
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-3xl space-y-4 max-h-[95vh] overflow-y-auto"
      >
        {isLoading || !data ? (
          <div className="p-10 text-center text-slate-400">جاري التحميل…</div>
        ) : (
          <PurchaseDetailContent purchase={data} onClose={onClose} />
        )}
      </div>
    </div>
  );
}

function PurchaseDetailContent({
  purchase: p,
  onClose,
}: {
  purchase: PurchaseDetail;
  onClose: () => void;
}) {
  const remaining = Number(p.grand_total) - Number(p.paid_amount);
  return (
    <>
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-black flex items-center gap-2">
            <FileText className="w-5 h-5 text-brand-500" />
            فاتورة مشتريات {p.purchase_no}
          </h2>
          <div className="text-xs text-slate-500 mt-1">
            {p.supplier_name} — {new Date(p.invoice_date).toLocaleDateString('en-US')}
          </div>
        </div>
        <span
          className={`px-3 py-1 rounded-full text-sm font-bold ${STATUS_COLORS[p.status]}`}
        >
          {STATUS_LABELS[p.status]}
        </span>
      </div>

      <section>
        <h3 className="font-bold text-slate-700 mb-2">الأصناف</h3>
        <div className="overflow-x-auto border border-slate-200 rounded-lg">
          <table className="w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <th className="p-2 text-right">الصنف</th>
                <th className="p-2 text-right">SKU</th>
                <th className="p-2 text-right">الكمية</th>
                <th className="p-2 text-right">السعر</th>
                <th className="p-2 text-right">الإجمالي</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {p.items.map((it) => (
                <tr key={it.id}>
                  <td className="p-2">{it.product_name}</td>
                  <td className="p-2 font-mono text-xs">{it.sku}</td>
                  <td className="p-2">{it.quantity}</td>
                  <td className="p-2">{EGP(it.unit_cost)}</td>
                  <td className="p-2 font-bold">{EGP(it.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <InfoBlock label="المجموع الجزئي" value={EGP(p.subtotal)} />
        <InfoBlock label="الشحن" value={EGP(p.shipping_cost)} />
        <InfoBlock label="الخصم" value={EGP(p.discount_amount)} />
        <InfoBlock label="الضريبة" value={EGP(p.tax_amount)} />
        <InfoBlock
          label="المجموع الكلي"
          value={EGP(p.grand_total)}
          accent="brand"
        />
        <InfoBlock label="المسدد" value={EGP(p.paid_amount)} accent="emerald" />
        <InfoBlock label="المتبقي" value={EGP(remaining)} accent="rose" />
      </section>

      {p.payments.length > 0 && (
        <section>
          <h3 className="font-bold text-slate-700 mb-2">سجل الدفعات</h3>
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="p-2 text-right">التاريخ</th>
                  <th className="p-2 text-right">الطريقة</th>
                  <th className="p-2 text-right">المبلغ</th>
                  <th className="p-2 text-right">المرجع</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {p.payments.map((pay) => (
                  <tr key={pay.id}>
                    <td className="p-2 text-xs">
                      {new Date(pay.paid_at).toLocaleString('en-US')}
                    </td>
                    <td className="p-2">{pay.payment_method}</td>
                    <td className="p-2 font-bold text-emerald-600">
                      {EGP(pay.amount)}
                    </td>
                    <td className="p-2 text-xs text-slate-500">
                      {pay.reference_number || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <div className="flex justify-end">
        <button type="button" onClick={onClose} className="btn-ghost">
          إغلاق
        </button>
      </div>
    </>
  );
}

function InfoBlock({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: 'brand' | 'emerald' | 'rose';
}) {
  const colors = {
    brand: 'text-brand-600',
    emerald: 'text-emerald-600',
    rose: 'text-rose-600',
  };
  return (
    <div className="bg-slate-50 rounded-lg p-3">
      <div className="text-xs text-slate-500 mb-1">{label}</div>
      <div className={`font-black ${accent ? colors[accent] : 'text-slate-700'}`}>
        {value}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function PayPurchaseModal({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: purchase } = useQuery({
    queryKey: ['purchase', id],
    queryFn: () => purchasesApi.get(id),
  });
  const { data: methods = [] } = useQuery({
    queryKey: ['payment-methods'],
    queryFn: () => settingsApi.listPaymentMethods(),
  });

  const [form, setForm] = useState({
    payment_method: 'cash',
    amount: 0,
    reference_number: '',
    notes: '',
  });

  const remaining = purchase
    ? Number(purchase.grand_total) - Number(purchase.paid_amount)
    : 0;

  const mut = useMutation({
    mutationFn: () =>
      purchasesApi.pay(id, {
        payment_method: form.payment_method,
        amount: Number(form.amount),
        reference_number: form.reference_number || undefined,
        notes: form.notes || undefined,
      }),
    onSuccess: () => {
      toast.success('تم تسجيل الدفعة');
      qc.invalidateQueries({ queryKey: ['purchases'] });
      qc.invalidateQueries({ queryKey: ['purchase', id] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تسجيل الدفعة'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (form.amount <= 0) return toast.error('أدخل مبلغاً صحيحاً');
    if (form.amount > remaining)
      return toast.error('المبلغ أكبر من المتبقي');
    mut.mutate();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-md space-y-4"
      >
        <h2 className="text-lg font-black flex items-center gap-2">
          <CreditCard className="w-5 h-5 text-emerald-500" />
          تسجيل دفعة لفاتورة {purchase?.purchase_no}
        </h2>

        <div className="bg-slate-50 rounded-lg p-3 text-sm space-y-1">
          <div className="flex justify-between">
            <span className="text-slate-500">الإجمالي</span>
            <span className="font-bold">{EGP(purchase?.grand_total || 0)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">المسدد</span>
            <span className="font-bold text-emerald-600">
              {EGP(purchase?.paid_amount || 0)}
            </span>
          </div>
          <div className="flex justify-between">
            <span className="text-slate-500">المتبقي</span>
            <span className="font-bold text-rose-600">{EGP(remaining)}</span>
          </div>
        </div>

        <div>
          <label className="label">طريقة الدفع</label>
          <select
            className="input"
            value={form.payment_method}
            onChange={(e) =>
              setForm({ ...form, payment_method: e.target.value })
            }
          >
            {methods.length === 0 ? (
              <>
                <option value="cash">نقدي</option>
                <option value="bank_transfer">تحويل بنكي</option>
                <option value="cheque">شيك</option>
              </>
            ) : (
              methods.map((m) => (
                <option key={m.code} value={m.code}>
                  {m.name_ar}
                </option>
              ))
            )}
          </select>
        </div>

        <div>
          <label className="label">المبلغ *</label>
          <input
            type="number"
            min={0.01}
            max={remaining}
            step="0.01"
            className="input"
            value={form.amount || ''}
            onChange={(e) =>
              setForm({ ...form, amount: Number(e.target.value) })
            }
            required
          />
          <button
            type="button"
            onClick={() => setForm({ ...form, amount: remaining })}
            className="text-xs text-brand-600 mt-1 hover:underline"
          >
            سداد كامل المتبقي
          </button>
        </div>

        <div>
          <label className="label">رقم المرجع</label>
          <input
            className="input"
            placeholder="رقم الشيك / التحويل"
            value={form.reference_number}
            onChange={(e) =>
              setForm({ ...form, reference_number: e.target.value })
            }
          />
        </div>

        <div>
          <label className="label">ملاحظات</label>
          <input
            className="input"
            value={form.notes}
            onChange={(e) => setForm({ ...form, notes: e.target.value })}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button type="button" onClick={onClose} className="btn-ghost">
            إلغاء
          </button>
          <button
            type="submit"
            disabled={mut.isPending}
            className="btn-primary"
          >
            حفظ الدفعة
          </button>
        </div>
      </form>
    </div>
  );
}
