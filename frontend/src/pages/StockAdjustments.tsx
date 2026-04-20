import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  PackagePlus,
  Plus,
  Minus,
  TrendingUp,
  TrendingDown,
  Search,
  AlertTriangle,
  History,
} from 'lucide-react';
import { stockApi } from '@/api/stock.api';
import { productsApi } from '@/api/products.api';
import { settingsApi } from '@/api/settings.api';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const COMMON_REASONS = [
  'جرد فعلي',
  'تالف',
  'مفقود',
  'إرجاع للمورد',
  'عينة/ديكور',
  'تسوية رصيد افتتاحي',
  'أخرى',
];

export default function StockAdjustmentsPage() {
  const [showCreate, setShowCreate] = useState(false);
  const [filterWarehouse, setFilterWarehouse] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const { data: warehouses = [] } = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => settingsApi.listWarehouses(),
  });

  const { data: adjustments = [], isLoading } = useQuery({
    queryKey: ['adjustments', filterWarehouse, fromDate, toDate],
    queryFn: () =>
      stockApi.listAdjustments({
        warehouse_id: filterWarehouse || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
        limit: 300,
      }),
  });

  const stats = useMemo(() => {
    const s = { total: adjustments.length, inQty: 0, outQty: 0 };
    for (const a of adjustments) {
      if (a.direction === 'in') s.inQty += Number(a.quantity);
      else s.outQty += Number(a.quantity);
    }
    return s;
  }, [adjustments]);

  return (
    <div className="p-6 space-y-6" dir="rtl">
      <header className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-black flex items-center gap-2 text-slate-800">
            <PackagePlus className="w-7 h-7 text-brand-500" />
            تسويات المخزون
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            إضافة أو خصم كميات من المخزون مع سجل تدقيق كامل
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary flex items-center gap-2"
        >
          <Plus className="w-4 h-4" />
          تسوية جديدة
        </button>
      </header>

      <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          label="عدد التسويات"
          value={String(stats.total)}
          icon={<History className="w-5 h-5 text-slate-500" />}
        />
        <StatCard
          label="إضافات للمخزون"
          value={`+${stats.inQty.toLocaleString('en-US')}`}
          icon={<TrendingUp className="w-5 h-5 text-emerald-500" />}
          tone="emerald"
        />
        <StatCard
          label="خصم من المخزون"
          value={`−${stats.outQty.toLocaleString('en-US')}`}
          icon={<TrendingDown className="w-5 h-5 text-rose-500" />}
          tone="rose"
        />
      </section>

      <div className="card p-4 flex items-center gap-3 flex-wrap">
        <select
          className="input w-56"
          value={filterWarehouse}
          onChange={(e) => setFilterWarehouse(e.target.value)}
        >
          <option value="">كل المخازن</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name_ar}
            </option>
          ))}
        </select>
        <input
          type="date"
          className="input w-44"
          value={fromDate}
          onChange={(e) => setFromDate(e.target.value)}
        />
        <span className="text-slate-400">→</span>
        <input
          type="date"
          className="input w-44"
          value={toDate}
          onChange={(e) => setToDate(e.target.value)}
        />
      </div>

      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-10 text-center text-slate-400">جاري التحميل…</div>
        ) : adjustments.length === 0 ? (
          <div className="p-10 text-center text-slate-400">
            لا توجد تسويات في هذه الفترة
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <th className="p-3 text-right">التاريخ</th>
                  <th className="p-3 text-right">الصنف</th>
                  <th className="p-3 text-right">SKU</th>
                  <th className="p-3 text-right">المخزن</th>
                  <th className="p-3 text-right">الاتجاه</th>
                  <th className="p-3 text-right">الكمية</th>
                  <th className="p-3 text-right">السبب / ملاحظات</th>
                  <th className="p-3 text-right">المستخدم</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {adjustments.map((a) => (
                  <tr key={a.id} className="hover:bg-slate-50">
                    <td className="p-3 text-xs text-slate-500 whitespace-nowrap">
                      {new Date(a.created_at).toLocaleString('en-US')}
                    </td>
                    <td className="p-3 font-medium">{a.product_name || '—'}</td>
                    <td className="p-3 font-mono text-xs">{a.sku}</td>
                    <td className="p-3 text-slate-600">
                      {a.warehouse_name} ({a.warehouse_code})
                    </td>
                    <td className="p-3">
                      {a.direction === 'in' ? (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-emerald-50 text-emerald-700 text-xs font-semibold">
                          <Plus className="w-3 h-3" /> إضافة
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 px-2 py-1 rounded-full bg-rose-50 text-rose-700 text-xs font-semibold">
                          <Minus className="w-3 h-3" /> خصم
                        </span>
                      )}
                    </td>
                    <td
                      className={`p-3 font-black ${a.direction === 'in' ? 'text-emerald-600' : 'text-rose-600'}`}
                    >
                      {a.direction === 'in' ? '+' : '−'}
                      {a.quantity}
                    </td>
                    <td className="p-3 text-slate-700 max-w-[260px] truncate">
                      {a.notes || '—'}
                    </td>
                    <td className="p-3 text-slate-500 text-xs">
                      {a.user_name || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && <AdjustmentModal onClose={() => setShowCreate(false)} />}
    </div>
  );
}

function StatCard({
  label,
  value,
  icon,
  tone,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  tone?: 'emerald' | 'rose';
}) {
  const tones = {
    emerald: 'text-emerald-600',
    rose: 'text-rose-600',
  };
  return (
    <div className="card p-4 flex items-center gap-3">
      <div className="w-10 h-10 rounded-lg bg-slate-50 flex items-center justify-center">
        {icon}
      </div>
      <div>
        <div className="text-xs text-slate-500">{label}</div>
        <div
          className={`text-xl font-black ${tone ? tones[tone] : 'text-slate-800'}`}
        >
          {value}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

function AdjustmentModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: products } = useQuery({
    queryKey: ['products-for-adj'],
    queryFn: () => productsApi.list({ limit: 500 }),
  });
  const { data: warehouses = [] } = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => settingsApi.listWarehouses(),
  });

  const [productId, setProductId] = useState('');
  const [form, setForm] = useState({
    variant_id: '',
    warehouse_id: '',
    direction: 'in' as 'in' | 'out',
    quantity: 1,
    unit_cost: 0,
    reason: 'جرد فعلي',
    notes: '',
  });

  const { data: productDetail } = useQuery({
    queryKey: ['product-detail', productId],
    queryFn: () => productsApi.get(productId),
    enabled: !!productId,
  });

  const { data: stockRows = [] } = useQuery({
    queryKey: ['stock-for-variant', form.variant_id],
    queryFn: () => stockApi.forVariant(form.variant_id),
    enabled: !!form.variant_id,
  });

  const currentQty = useMemo(() => {
    if (!form.warehouse_id) return null;
    const r = (stockRows as any[]).find(
      (s) => s.s_warehouse_id === form.warehouse_id,
    );
    return r ? Number(r.s_quantity) : 0;
  }, [stockRows, form.warehouse_id]);

  const mut = useMutation({
    mutationFn: () =>
      stockApi.adjust({
        variant_id: form.variant_id,
        warehouse_id: form.warehouse_id,
        delta: form.direction === 'in' ? form.quantity : -form.quantity,
        reason: form.notes ? `${form.reason} — ${form.notes}` : form.reason,
        unit_cost:
          form.direction === 'in' && form.unit_cost > 0
            ? form.unit_cost
            : undefined,
      }),
    onSuccess: () => {
      toast.success('تم حفظ التسوية');
      qc.invalidateQueries({ queryKey: ['adjustments'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل حفظ التسوية'),
  });

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.variant_id || !form.warehouse_id) {
      toast.error('اختر الصنف والمخزن');
      return;
    }
    if (form.quantity <= 0) {
      toast.error('الكمية يجب أن تكون أكبر من صفر');
      return;
    }
    if (
      form.direction === 'out' &&
      currentQty !== null &&
      form.quantity > currentQty
    ) {
      if (
        !window.confirm(
          `الكمية المتاحة ${currentQty} فقط — هل تريد المتابعة؟ سيصبح الرصيد بالسالب.`,
        )
      )
        return;
    }
    mut.mutate();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        onSubmit={submit}
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-lg space-y-4"
      >
        <h2 className="text-lg font-black flex items-center gap-2">
          <PackagePlus className="w-5 h-5 text-brand-500" />
          تسوية مخزون جديدة
        </h2>

        <div className="grid grid-cols-1 gap-3">
          <div>
            <label className="label">المنتج *</label>
            <select
              className="input"
              value={productId}
              onChange={(e) => {
                setProductId(e.target.value);
                setForm({ ...form, variant_id: '' });
              }}
              required
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
            <label className="label">اللون / المقاس *</label>
            <select
              className="input"
              value={form.variant_id}
              onChange={(e) => setForm({ ...form, variant_id: e.target.value })}
              disabled={!productId}
              required
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
            {currentQty !== null && (
              <div className="text-xs text-slate-500 mt-1">
                الرصيد الحالي: <strong>{currentQty}</strong>
              </div>
            )}
          </div>

          <div>
            <label className="label">نوع التسوية *</label>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setForm({ ...form, direction: 'in' })}
                className={`py-3 rounded-lg font-bold transition ${
                  form.direction === 'in'
                    ? 'bg-emerald-500 text-white'
                    : 'bg-slate-100 text-slate-600'
                }`}
              >
                <Plus className="w-4 h-4 inline mr-1" /> إضافة للمخزون
              </button>
              <button
                type="button"
                onClick={() => setForm({ ...form, direction: 'out' })}
                className={`py-3 rounded-lg font-bold transition ${
                  form.direction === 'out'
                    ? 'bg-rose-500 text-white'
                    : 'bg-slate-100 text-slate-600'
                }`}
              >
                <Minus className="w-4 h-4 inline mr-1" /> خصم من المخزون
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">الكمية *</label>
              <input
                type="number"
                min={1}
                className="input"
                value={form.quantity}
                onChange={(e) =>
                  setForm({ ...form, quantity: Number(e.target.value) })
                }
                required
              />
            </div>
            {form.direction === 'in' && (
              <div>
                <label className="label">سعر التكلفة (اختياري)</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  className="input"
                  value={form.unit_cost || ''}
                  onChange={(e) =>
                    setForm({ ...form, unit_cost: Number(e.target.value) })
                  }
                />
              </div>
            )}
          </div>

          <div>
            <label className="label">السبب *</label>
            <select
              className="input"
              value={form.reason}
              onChange={(e) => setForm({ ...form, reason: e.target.value })}
            >
              {COMMON_REASONS.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">ملاحظات إضافية</label>
            <textarea
              className="input min-h-[60px]"
              value={form.notes}
              onChange={(e) => setForm({ ...form, notes: e.target.value })}
              placeholder="تفاصيل إضافية تظهر في سجل التدقيق"
            />
          </div>

          {form.direction === 'out' &&
            currentQty !== null &&
            form.quantity > currentQty && (
              <div className="flex items-center gap-2 p-3 bg-amber-50 text-amber-800 rounded-lg text-sm">
                <AlertTriangle className="w-4 h-4" />
                <span>
                  تحذير: الكمية ({form.quantity}) أكبر من الرصيد المتاح ({currentQty})
                </span>
              </div>
            )}
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
            حفظ التسوية
          </button>
        </div>
      </form>
    </div>
  );
}
