import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Search,
  Plus,
  Edit,
  Package,
  X,
  Trash2,
  Image as ImageIcon,
  FolderPlus,
  Tag,
  Palette,
  Ruler,
  Upload,
  PencilLine,
} from 'lucide-react';
import {
  productsApi,
  Product,
  SizeOption,
} from '@/api/products.api';
import { categoriesApi } from '@/api/categories.api';
import { suppliersApi, Supplier } from '@/api/suppliers.api';
import { stockApi } from '@/api/stock.api';
import { uploadsApi, resolveImageUrl } from '@/api/uploads.api';
import { settingsApi } from '@/api/settings.api';
import { compressImage } from '@/utils/compressImage';
import { useTableSort } from '@/lib/useTableSort';

const EGP = (n: number | string) => `${Number(n || 0).toFixed(0)} EGP`;

const UOM_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'piece', label: 'قطعة' },
  { value: 'pair', label: 'زوج' },
  { value: 'carton', label: 'كرتونة' },
  { value: 'box', label: 'صندوق' },
  { value: 'dozen', label: 'دستة' },
];

export default function Products() {
  const [type, setType] = useState<'all' | 'shoe' | 'bag' | 'accessory'>('all');
  const [q, setQ] = useState('');
  const [categoryFilter, setCategoryFilter] = useState<string>('');
  const [stockFilter, setStockFilter] = useState<'all' | 'in' | 'low' | 'out'>(
    'all',
  );
  const [activeFilter, setActiveFilter] = useState<'all' | 'active' | 'inactive'>(
    'active',
  );
  const [showCreate, setShowCreate] = useState(false);
  const [editTarget, setEditTarget] = useState<Product | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  // Per-column smart filters — each box narrows the rows by matching
  // the column's value. The "بحث ذكي" box looks inside the product's
  // variant summaries so color / size / variant SKU all match too.
  const [colSku, setColSku] = useState('');
  const [colName, setColName] = useState('');
  const [colPrice, setColPrice] = useState('');
  const [colStock, setColStock] = useState('');
  const [colVariant, setColVariant] = useState('');
  const [showGroups, setShowGroups] = useState(false);
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: ['products', type, q],
    queryFn: () =>
      productsApi.list({
        type: type === 'all' ? undefined : type,
        q: q || undefined,
        // Load all products (server limit is 200 by default). We set a
        // generous cap so the full 1k+ catalog renders without a
        // pagination UI — the list is virtualised / lightweight.
        limit: 2000,
      }),
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
    staleTime: 60_000,
  });

  const filteredData = useMemo(() => {
    let list = data?.data || [];
    if (categoryFilter)
      list = list.filter((p) => p.category_id === categoryFilter);
    if (activeFilter !== 'all')
      list = list.filter((p) =>
        activeFilter === 'active' ? p.is_active : !p.is_active,
      );
    if (stockFilter !== 'all') {
      list = list.filter((p) => {
        const s = Number(p.total_stock || 0);
        if (stockFilter === 'out') return s <= 0;
        if (stockFilter === 'low') return s > 0 && s <= 2;
        if (stockFilter === 'in') return s > 0;
        return true;
      });
    }
    // ── Per-column smart filters ────────────────────────────────────
    const sku = colSku.trim().toLowerCase();
    const nm = colName.trim().toLowerCase();
    const pr = colPrice.trim();
    const st = colStock.trim();
    const vq = colVariant.trim().toLowerCase();
    if (sku) {
      list = list.filter((p) => {
        if ((p.sku_root || '').toLowerCase().includes(sku)) return true;
        // Also match if any variant SKU contains the query
        const vs = (p as any).variants_summary || [];
        return vs.some((v: any) => (v.sku || '').toLowerCase().includes(sku));
      });
    }
    if (nm) {
      list = list.filter((p) =>
        (p.name_ar || '').toLowerCase().includes(nm) ||
        (p.name_en || '').toLowerCase().includes(nm),
      );
    }
    if (pr) list = list.filter((p) => String(p.base_price ?? '').includes(pr));
    if (st) list = list.filter((p) => String(p.total_stock ?? '').includes(st));
    if (vq) {
      list = list.filter((p) => {
        const vs = (p as any).variants_summary || [];
        return vs.some(
          (v: any) =>
            (v.color || '').toLowerCase().includes(vq) ||
            (v.size || '').toLowerCase().includes(vq) ||
            (v.sku || '').toLowerCase().includes(vq),
        );
      });
    }
    return list;
  }, [
    data,
    categoryFilter,
    activeFilter,
    stockFilter,
    colSku,
    colName,
    colPrice,
    colStock,
    colVariant,
  ]);

  // Grand totals across ALL products (pre-filter) for the footer.
  const catalogTotals = useMemo(() => {
    const all = data?.data || [];
    const products = all.length;
    const variants = all.reduce(
      (s, p) => s + Number((p as any).variants_count || 0),
      0,
    );
    const units = all.reduce(
      (s, p) => s + Number((p as any).total_stock || 0),
      0,
    );
    return { products, variants, units };
  }, [data]);

  const { sorted, thProps, sortIcon } = useTableSort(filteredData, null, 'asc');

  const deleteMutation = useMutation({
    mutationFn: (id: string) => productsApi.remove(id),
    onSuccess: () => {
      toast.success('تم حذف المنتج');
      qc.invalidateQueries({ queryKey: ['products'] });
      setDeleteTarget(null);
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.message || 'فشل الحذف';
      toast.error(Array.isArray(msg) ? msg[0] : String(msg));
    },
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <h2 className="text-2xl font-black text-slate-800">إدارة المنتجات</h2>
        <div className="flex items-center gap-2">
          <button
            className="btn-secondary"
            onClick={() => setShowGroups(true)}
            title="إدارة المجموعات / الأقسام"
          >
            <FolderPlus size={16} /> المجموعات
          </button>
          <button className="btn-primary" onClick={() => setShowCreate(true)}>
            <Plus size={18} /> إضافة منتج
          </button>
        </div>
      </div>

      <div className="card p-4 flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search
            size={16}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
          />
          <input
            className="input pr-9"
            placeholder="ابحث بالاسم أو SKU..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        {(['all', 'shoe', 'bag', 'accessory'] as const).map((c) => {
          const labels: Record<string, string> = {
            all: 'الكل',
            shoe: 'أحذية',
            bag: 'حقائب',
            accessory: 'إكسسوار',
          };
          return (
            <button
              key={c}
              onClick={() => setType(c)}
              className={`px-4 py-2 rounded-lg text-sm font-semibold ${
                type === c
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {labels[c]}
            </button>
          );
        })}
        <select
          className="input max-w-[180px]"
          value={categoryFilter}
          onChange={(e) => setCategoryFilter(e.target.value)}
        >
          <option value="">كل المجموعات</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name_ar}
            </option>
          ))}
        </select>
        <select
          className="input max-w-[140px]"
          value={stockFilter}
          onChange={(e) => setStockFilter(e.target.value as any)}
          title="فلتر المخزون"
        >
          <option value="all">كل المخزون</option>
          <option value="in">متوفر</option>
          <option value="low">قارب النفاد</option>
          <option value="out">نافذ</option>
        </select>
        <select
          className="input max-w-[120px]"
          value={activeFilter}
          onChange={(e) => setActiveFilter(e.target.value as any)}
          title="فلتر الحالة"
        >
          <option value="all">الكل</option>
          <option value="active">مفعّل</option>
          <option value="inactive">متوقف</option>
        </select>
      </div>

      <div className="text-xs text-slate-500">
        المعروض: <b className="text-slate-800">{sorted.length}</b>{' '}
        {sorted.length !== (data?.data.length || 0) && (
          <>
            من <b>{data?.data.length || 0}</b>
          </>
        )}
      </div>

      <div className="card overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr className="text-xs text-slate-500 font-bold">
              <th className="text-center p-3 w-12">#</th>
              <th {...thProps('name_ar')} className={`text-right p-3 ${thProps('name_ar').className}`}>
                {sortIcon('name_ar')} المنتج
              </th>
              <th {...thProps('sku_root')} className={`text-right p-3 ${thProps('sku_root').className}`}>
                {sortIcon('sku_root')} SKU
              </th>
              <th {...thProps('type')} className={`text-right p-3 ${thProps('type').className}`}>
                {sortIcon('type')} النوع
              </th>
              <th className="text-right p-3">المجموعة</th>
              <th {...thProps('base_price')} className={`text-left p-3 ${thProps('base_price').className}`}>
                {sortIcon('base_price')} السعر
              </th>
              <th {...thProps('cost_price')} className={`text-left p-3 ${thProps('cost_price').className}`}>
                {sortIcon('cost_price')} التكلفة
              </th>
              <th {...thProps('total_stock')} className={`text-left p-3 ${thProps('total_stock').className}`}>
                {sortIcon('total_stock')} المخزون
              </th>
              <th className="text-right p-3">الأصناف (لون/مقاس)</th>
              <th {...thProps('stock_value')} className={`text-left p-3 ${thProps('stock_value').className}`}>
                {sortIcon('stock_value')} قيمة المخزون
              </th>
              <th {...thProps('is_active')} className={`text-left p-3 ${thProps('is_active').className}`}>
                {sortIcon('is_active')} الحالة
              </th>
              <th className="text-left p-3">إجراءات</th>
            </tr>
            {/* Per-column filter row */}
            <tr className="bg-white border-t border-slate-100 text-xs">
              <td className="p-1.5"></td>
              <td className="p-1.5">
                <input
                  className="input py-1 text-xs"
                  placeholder="بحث بالاسم…"
                  value={colName}
                  onChange={(e) => setColName(e.target.value)}
                />
              </td>
              <td className="p-1.5">
                <input
                  className="input py-1 text-xs font-mono"
                  placeholder="كود"
                  dir="ltr"
                  value={colSku}
                  onChange={(e) => setColSku(e.target.value)}
                />
              </td>
              <td className="p-1.5"></td>
              <td className="p-1.5"></td>
              <td className="p-1.5">
                <input
                  className="input py-1 text-xs font-mono"
                  placeholder="سعر"
                  dir="ltr"
                  value={colPrice}
                  onChange={(e) => setColPrice(e.target.value)}
                />
              </td>
              <td className="p-1.5"></td>
              <td className="p-1.5">
                <input
                  className="input py-1 text-xs font-mono"
                  placeholder="كمية"
                  dir="ltr"
                  value={colStock}
                  onChange={(e) => setColStock(e.target.value)}
                />
              </td>
              <td className="p-1.5">
                <input
                  className="input py-1 text-xs"
                  placeholder="لون / مقاس / SKU صنف"
                  value={colVariant}
                  onChange={(e) => setColVariant(e.target.value)}
                />
              </td>
              <td className="p-1.5"></td>
              <td className="p-1.5"></td>
              <td className="p-1.5"></td>
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <tr>
                <td colSpan={12} className="text-center py-12 text-slate-400">
                  جارٍ التحميل...
                </td>
              </tr>
            )}
            {sorted.map((p, idx) => {
              const cat = categories.find((c) => c.id === p.category_id);
              // Does this product have an EXACT SKU match for colSku?
              // (If so, the row gets a small "✓" marker.)
              const skuQuery = colSku.trim().toLowerCase();
              const exactSkuHit =
                skuQuery.length > 0 &&
                ((p.sku_root || '').toLowerCase() === skuQuery ||
                  ((p as any).variants_summary || []).some(
                    (v: any) => (v.sku || '').toLowerCase() === skuQuery,
                  ));
              // Which variants match the current variant-search query?
              const vq = colVariant.trim().toLowerCase();
              const matchedVariants = vq
                ? ((p as any).variants_summary || []).filter(
                    (v: any) =>
                      (v.color || '').toLowerCase().includes(vq) ||
                      (v.size || '').toLowerCase().includes(vq) ||
                      (v.sku || '').toLowerCase().includes(vq),
                  )
                : [];
              return (
                <tr
                  key={p.id}
                  className={`border-b border-slate-100 hover:bg-slate-50 ${
                    exactSkuHit ? 'bg-emerald-50/50' : ''
                  }`}
                >
                  <td className="p-3 text-center">
                    <div className="inline-flex items-center gap-1 font-mono text-slate-500 text-xs tabular-nums">
                      {idx + 1}
                      {exactSkuHit && (
                        <span
                          className="text-emerald-600 font-bold"
                          title="مطابقة تامة للكود"
                        >
                          ✓
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="p-3">
                    <div className="flex items-center gap-3">
                      {p.primary_image_url ? (
                        <img
                          src={resolveImageUrl(p.primary_image_url)}
                          alt=""
                          className="w-10 h-10 rounded-lg object-cover bg-slate-100"
                        />
                      ) : (
                        <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-xl">
                          {/(^|\s)(شنط|شنطة|حقيبة|حقائب|كلاتش|ظهر)/i.test(p.name_ar || '') ? '👜' : '👠'}
                        </div>
                      )}
                      <div>
                        <div className="font-semibold text-slate-800">
                          {p.name_ar}
                        </div>
                        {p.name_en && (
                          <div className="text-xs text-slate-500">
                            {p.name_en}
                          </div>
                        )}
                      </div>
                    </div>
                  </td>
                  <td className="p-3 font-mono text-xs text-slate-600">
                    {p.sku_root}
                  </td>
                  <td className="p-3">
                    <span className="chip bg-slate-100 text-slate-600">
                      {p.type === 'shoe'
                        ? 'حذاء'
                        : p.type === 'bag'
                          ? 'حقيبة'
                          : 'إكسسوار'}
                    </span>
                  </td>
                  <td className="p-3 text-xs text-slate-600">
                    {cat?.name_ar || '—'}
                  </td>
                  <td className="p-3 text-left font-bold text-brand-600">
                    {EGP(p.base_price)}
                  </td>
                  <td className="p-3 text-left text-slate-500">
                    {EGP(p.cost_price)}
                  </td>
                  <td className="p-3 text-left">
                    {(() => {
                      const qty = p.total_stock ?? 0;
                      if (qty === 0)
                        return (
                          <span className="chip bg-rose-100 text-rose-700 font-bold">
                            نفذ
                          </span>
                        );
                      const low = qty <= 3;
                      return (
                        <span
                          className={`chip font-bold ${
                            low
                              ? 'bg-amber-100 text-amber-700'
                              : 'bg-emerald-100 text-emerald-700'
                          }`}
                        >
                          {qty}{' '}
                          <span className="text-[10px] opacity-70 font-normal">
                            ({p.variants_count ?? 0} أصناف)
                          </span>
                        </span>
                      );
                    })()}
                  </td>
                  <td className="p-2 text-xs">
                    {((p as any).variants_summary || []).length === 0 ? (
                      <span className="text-slate-400">—</span>
                    ) : (
                      <div className="flex flex-wrap gap-1 max-w-[260px]">
                        {((p as any).variants_summary || [])
                          .slice(0, 6)
                          .map((v: any, i: number) => {
                            const isHit = matchedVariants.includes(v);
                            const parts = [v.color, v.size]
                              .filter(Boolean)
                              .join(' · ');
                            return (
                              <span
                                key={i}
                                className={`chip border text-[10px] ${
                                  isHit
                                    ? 'bg-amber-100 text-amber-700 border-amber-300'
                                    : 'bg-slate-50 text-slate-600 border-slate-200'
                                }`}
                                title={v.sku}
                              >
                                {parts || v.sku || '—'}
                              </span>
                            );
                          })}
                        {((p as any).variants_summary || []).length > 6 && (
                          <span className="text-[10px] text-slate-400">
                            +{((p as any).variants_summary || []).length - 6}
                          </span>
                        )}
                      </div>
                    )}
                  </td>
                  <td className="p-3 text-left font-semibold text-slate-700">
                    {EGP(p.stock_value ?? 0)}
                  </td>
                  <td className="p-3 text-left">
                    {p.is_active ? (
                      <span className="chip bg-emerald-100 text-emerald-700">
                        نشط
                      </span>
                    ) : (
                      <span className="chip bg-slate-100 text-slate-500">
                        معطل
                      </span>
                    )}
                  </td>
                  <td className="p-3 text-left">
                    <div className="flex items-center justify-end gap-1">
                      <button
                        className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-brand-600"
                        onClick={() => setEditTarget(p)}
                        title="تعديل"
                      >
                        <Edit size={14} />
                      </button>
                      <button
                        className="p-1.5 rounded-lg hover:bg-rose-50 text-slate-500 hover:text-rose-600"
                        onClick={() => setDeleteTarget(p)}
                        title="حذف"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
            {!isLoading && sorted.length === 0 && (
              <tr>
                <td colSpan={10} className="text-center py-12 text-slate-400">
                  <Package className="mx-auto mb-2" size={32} />
                  لا توجد منتجات
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Sticky bottom totals bar */}
      <div className="sticky bottom-0 -mx-3 md:-mx-6 mt-6 bg-gradient-to-l from-slate-900 via-slate-800 to-slate-900 text-white px-4 py-3 shadow-2xl border-t border-slate-700 z-40">
        <div className="flex items-center justify-between gap-4 flex-wrap text-xs">
          <div className="flex items-center gap-4 flex-wrap">
            <span className="text-slate-400">المعروض:</span>
            <span className="font-black tabular-nums text-amber-300">
              {sorted.length.toLocaleString('en-US')} منتج
            </span>
            <span className="text-slate-500">من</span>
            <span className="font-black tabular-nums text-white">
              {catalogTotals.products.toLocaleString('en-US')}
            </span>
          </div>
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-1">
              <span className="text-slate-400">إجمالي المنتجات:</span>
              <span className="font-black tabular-nums text-white">
                {catalogTotals.products.toLocaleString('en-US')}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-slate-400">الأصناف:</span>
              <span className="font-black tabular-nums text-indigo-300">
                {catalogTotals.variants.toLocaleString('en-US')}
              </span>
            </div>
            <div className="flex items-center gap-1">
              <span className="text-slate-400">القطع:</span>
              <span className="font-black tabular-nums text-emerald-300">
                {catalogTotals.units.toLocaleString('en-US')}
              </span>
            </div>
          </div>
        </div>
      </div>

      {showCreate && (
        <ProductEditor
          onClose={() => setShowCreate(false)}
          onSaved={() => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['products'] });
          }}
        />
      )}

      {editTarget && (
        <ProductEditor
          productId={editTarget.id}
          onClose={() => setEditTarget(null)}
          onSaved={() => {
            setEditTarget(null);
            qc.invalidateQueries({ queryKey: ['products'] });
          }}
        />
      )}

      {deleteTarget && (
        <Modal title="تأكيد الحذف" onClose={() => setDeleteTarget(null)}>
          <div className="space-y-4">
            <div className="p-3 rounded-lg bg-rose-50 border border-rose-200 text-sm text-slate-700">
              هل أنت متأكد من حذف المنتج <b>{deleteTarget.name_ar}</b>؟
              <br />
              <span className="text-xs text-slate-500">
                سيتم أرشفة المنتج (إلغاء تنشيطه).
              </span>
            </div>
            <div className="flex gap-2">
              <button
                className="flex-1 py-2 rounded-lg bg-rose-600 text-white font-bold hover:bg-rose-700 disabled:opacity-50"
                onClick={() => deleteMutation.mutate(deleteTarget.id)}
                disabled={deleteMutation.isPending}
              >
                {deleteMutation.isPending ? 'جاري الحذف...' : 'تأكيد الحذف'}
              </button>
              <button
                className="btn-secondary"
                onClick={() => setDeleteTarget(null)}
              >
                إلغاء
              </button>
            </div>
          </div>
        </Modal>
      )}

      {showGroups && <GroupsModal onClose={() => setShowGroups(false)} />}
    </div>
  );
}

/* ─────────────────────── Product editor (create+edit) ─────────────────────── */

function ProductEditor({
  productId,
  onClose,
  onSaved,
}: {
  productId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'basic' | 'variants'>('basic');
  const [createdId, setCreatedId] = useState<string | null>(null);
  const isEdit = !!productId;

  const { data: existing } = useQuery({
    queryKey: ['product', productId],
    queryFn: () => productsApi.get(productId!),
    enabled: isEdit,
  });

  const { data: categories = [] } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
    staleTime: 60_000,
  });
  const { data: suppliers = [] } = useQuery({
    queryKey: ['suppliers-all'],
    queryFn: () => suppliersApi.list(),
    staleTime: 60_000,
  });

  const [form, setForm] = useState({
    sku_root: '',
    name_ar: '',
    name_en: '',
    type: 'shoe' as 'shoe' | 'bag' | 'accessory',
    base_price: '',
    cost_price: '',
    category_id: '',
    supplier_id: '',
    uom: 'piece',
    description: '',
    primary_image_url: '',
  });

  useEffect(() => {
    if (existing) {
      setForm({
        sku_root: existing.sku_root || '',
        name_ar: existing.name_ar || '',
        name_en: existing.name_en || '',
        type: existing.type,
        base_price: String(existing.base_price ?? ''),
        cost_price: String(existing.cost_price ?? ''),
        category_id: (existing as any).category_id || '',
        supplier_id: (existing as any).supplier_id || '',
        uom: (existing as any).uom || 'piece',
        description: (existing as any).description || '',
        primary_image_url: (existing as any).primary_image_url || '',
      });
    }
  }, [existing?.id]);

  // Live preview of the auto-generated SKU when the field is blank. Updates
  // when the user switches product type (shoe/bag/accessory).
  const { data: skuPreview } = useQuery({
    queryKey: ['product-next-sku', form.type],
    queryFn: () => productsApi.nextProductSku(form.type),
    enabled: !isEdit && !form.sku_root.trim(),
  });

  const saveProduct = useMutation({
    mutationFn: async () => {
      const payload: any = {
        // Send empty string as undefined so the backend trigger fires.
        sku_root: form.sku_root.trim() || undefined,
        name_ar: form.name_ar.trim(),
        name_en: form.name_en.trim() || undefined,
        type: form.type,
        base_price: Number(form.base_price) || 0,
        cost_price: Number(form.cost_price) || 0,
        category_id: form.category_id || undefined,
        supplier_id: form.supplier_id || undefined,
        uom: form.uom || 'piece',
        description: form.description.trim() || undefined,
        primary_image_url: form.primary_image_url || undefined,
      };
      if (isEdit) {
        return productsApi.update(productId!, payload);
      }
      return productsApi.create(payload);
    },
    onSuccess: (p: any) => {
      toast.success(
        isEdit
          ? 'تم تحديث المنتج'
          : `تم حفظ المنتج — SKU: ${p.sku_root || '—'}`,
      );
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['product', p.id] });
      if (!isEdit) {
        setCreatedId(p.id);
        // Backfill the generated sku_root so the variant editor can build
        // proper variant SKUs.
        if (p.sku_root) setForm((f) => ({ ...f, sku_root: p.sku_root }));
        setTab('variants');
      } else {
        onSaved();
      }
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.message || 'فشل الحفظ';
      toast.error(Array.isArray(msg) ? msg[0] : String(msg));
    },
  });

  const currentId = productId || createdId;
  const currentType = (existing?.type as any) || form.type;

  const submitBasic = () => {
    if (!form.name_ar.trim()) {
      toast.error('الاسم العربي مطلوب');
      return;
    }
    if (Number(form.base_price) < 0 || Number(form.cost_price) < 0) {
      toast.error('الأسعار يجب أن تكون موجبة');
      return;
    }
    saveProduct.mutate();
  };

  return (
    <Modal
      title={isEdit ? `تعديل: ${existing?.name_ar || ''}` : 'إضافة منتج جديد'}
      onClose={onClose}
      size="lg"
    >
      <div className="flex gap-1 mb-4 border-b border-slate-100 -mx-5 px-5">
        <TabBtn active={tab === 'basic'} onClick={() => setTab('basic')}>
          بيانات أساسية
        </TabBtn>
        <TabBtn
          active={tab === 'variants'}
          onClick={() => setTab('variants')}
          disabled={!currentId}
        >
          الأصناف (ألوان/مقاسات)
          {!currentId && (
            <span className="text-xs text-slate-400 mr-1">— احفظ أولاً</span>
          )}
        </TabBtn>
      </div>

      {tab === 'basic' && (
        <div className="space-y-3">
          <div className="grid md:grid-cols-3 gap-3">
            <Field
              label={
                form.sku_root.trim()
                  ? 'SKU الرئيسي'
                  : 'SKU الرئيسي (تلقائي)'
              }
            >
              <input
                className="input"
                value={form.sku_root}
                onChange={(e) => setForm({ ...form, sku_root: e.target.value })}
                placeholder={
                  !isEdit && skuPreview?.sku
                    ? `تلقائي: ${skuPreview.sku}`
                    : 'مثال: SH-00001'
                }
              />
              {!isEdit && !form.sku_root.trim() && skuPreview?.sku && (
                <div className="text-[11px] text-emerald-600 mt-1">
                  سيُولَّد تلقائيًا:{' '}
                  <span className="font-mono font-bold">{skuPreview.sku}</span>
                </div>
              )}
            </Field>
            <Field label="النوع *">
              <select
                className="input"
                value={form.type}
                onChange={(e) =>
                  setForm({ ...form, type: e.target.value as any })
                }
              >
                <option value="shoe">حذاء</option>
                <option value="bag">حقيبة</option>
                <option value="accessory">إكسسوار</option>
              </select>
            </Field>
            <Field label="وحدة القياس">
              <select
                className="input"
                value={form.uom}
                onChange={(e) => setForm({ ...form, uom: e.target.value })}
              >
                {UOM_OPTIONS.map((u) => (
                  <option key={u.value} value={u.value}>
                    {u.label}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <Field label="الاسم بالعربية *">
            <input
              className="input"
              value={form.name_ar}
              onChange={(e) => setForm({ ...form, name_ar: e.target.value })}
            />
          </Field>
          <Field label="الاسم بالإنجليزية">
            <input
              className="input"
              value={form.name_en}
              onChange={(e) => setForm({ ...form, name_en: e.target.value })}
            />
          </Field>

          <div className="grid md:grid-cols-2 gap-3">
            <Field label="المجموعة (القسم)">
              <select
                className="input"
                value={form.category_id}
                onChange={(e) =>
                  setForm({ ...form, category_id: e.target.value })
                }
              >
                <option value="">— بدون —</option>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name_ar}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="المورد">
              <select
                className="input"
                value={form.supplier_id}
                onChange={(e) =>
                  setForm({ ...form, supplier_id: e.target.value })
                }
              >
                <option value="">— بدون —</option>
                {suppliers.map((s: Supplier) => (
                  <option key={s.id} value={s.id}>
                    {s.name} ({s.code})
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid md:grid-cols-2 gap-3">
            <Field label="سعر البيع *">
              <input
                type="number"
                min={0}
                step="0.01"
                className="input"
                value={form.base_price}
                onChange={(e) =>
                  setForm({ ...form, base_price: e.target.value })
                }
              />
            </Field>
            <Field label="التكلفة *">
              <input
                type="number"
                min={0}
                step="0.01"
                className="input"
                value={form.cost_price}
                onChange={(e) =>
                  setForm({ ...form, cost_price: e.target.value })
                }
              />
            </Field>
          </div>

          <Field label="الصورة الرئيسية">
            <ImageUploader
              value={form.primary_image_url}
              onChange={(url) => setForm({ ...form, primary_image_url: url })}
            />
          </Field>

          <Field label="وصف">
            <textarea
              rows={2}
              className="input"
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
            />
          </Field>

          <div className="flex items-center justify-end gap-2 pt-4">
            <button className="btn-ghost" onClick={onClose}>
              إلغاء
            </button>
            <button
              className="btn-primary"
              onClick={submitBasic}
              disabled={saveProduct.isPending}
            >
              {saveProduct.isPending
                ? 'جاري الحفظ...'
                : isEdit
                  ? 'حفظ التعديلات'
                  : 'حفظ ومتابعة للأصناف'}
            </button>
          </div>
        </div>
      )}

      {tab === 'variants' && currentId && (
        <VariantsEditor
          productId={currentId}
          productType={currentType}
          baseSku={form.sku_root}
          defaultCost={Number(form.cost_price) || 0}
          defaultPrice={Number(form.base_price) || 0}
          onDone={onSaved}
        />
      )}
    </Modal>
  );
}

/* ───────────────────────── Variants editor ───────────────────────── */

type LocalVariant = {
  id?: string;
  color: string;
  size: string | null;
  sku: string;
  cost_price: string;
  selling_price: string;
  image_url: string;
  stock_qty: string;
  _saved?: boolean;
};

function VariantsEditor({
  productId,
  productType,
  baseSku,
  defaultCost,
  defaultPrice,
  onDone,
}: {
  productId: string;
  productType: 'shoe' | 'bag' | 'accessory';
  baseSku: string;
  defaultCost: number;
  defaultPrice: number;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const hasSizes = productType === 'shoe';

  const { data: existing = [] } = useQuery({
    queryKey: ['product', productId, 'variants'],
    queryFn: () => productsApi.get(productId).then((p) => p.variants || []),
  });
  const { data: colors = [] } = useQuery({
    queryKey: ['colors'],
    queryFn: productsApi.colors,
    staleTime: 60_000,
  });
  const { data: sizes = [] } = useQuery({
    queryKey: ['sizes'],
    queryFn: productsApi.sizes,
    staleTime: 60_000,
  });

  const [locals, setLocals] = useState<LocalVariant[]>([]);
  const hydratedRef = useRef(false);

  useEffect(() => {
    if (!hydratedRef.current && existing.length) {
      setLocals(
        (existing as any[]).map((v) => ({
          id: v.id,
          color: v.color || '',
          size: v.size || null,
          sku: v.sku,
          cost_price: String(v.cost_price ?? defaultCost),
          selling_price: String(
            v.selling_price ?? v.price_override ?? defaultPrice,
          ),
          image_url: v.image_url || '',
          stock_qty: '',
          _saved: true,
        })),
      );
      hydratedRef.current = true;
    }
  }, [existing, defaultCost, defaultPrice]);

  const byColor = useMemo(() => {
    const map = new Map<string, LocalVariant[]>();
    for (const v of locals) {
      if (!map.has(v.color)) map.set(v.color, []);
      map.get(v.color)!.push(v);
    }
    return Array.from(map.entries());
  }, [locals]);

  const addColorGroup = (color: string) => {
    if (locals.some((v) => v.color === color)) {
      toast.error('اللون مضاف بالفعل');
      return;
    }
    const newRow: LocalVariant = {
      color,
      size: hasSizes ? '' : 'مقاس حر',
      sku: buildSku(baseSku, color, hasSizes ? '' : 'حر'),
      cost_price: String(defaultCost),
      selling_price: String(defaultPrice),
      image_url: '',
      stock_qty: '0',
    };
    setLocals([...locals, newRow]);
  };

  const addSizeToColor = (color: string, size: string) => {
    if (locals.some((v) => v.color === color && v.size === size)) {
      toast.error('هذا المقاس مضاف بالفعل لهذا اللون');
      return;
    }
    const first = locals.find((v) => v.color === color);
    setLocals([
      ...locals,
      {
        color,
        size,
        sku: buildSku(baseSku, color, size),
        cost_price: first?.cost_price ?? String(defaultCost),
        selling_price: first?.selling_price ?? String(defaultPrice),
        image_url: first?.image_url || '',
        stock_qty: '0',
      },
    ]);
  };

  const updateLocal = (idx: number, patch: Partial<LocalVariant>) => {
    setLocals((arr) => arr.map((v, i) => (i === idx ? { ...v, ...patch } : v)));
  };

  const removeLocal = async (idx: number) => {
    const v = locals[idx];
    if (v.id && v._saved) {
      try {
        await productsApi.removeVariant(v.id);
        toast.success('تم حذف الصنف');
      } catch (e: any) {
        toast.error(e?.response?.data?.message || 'فشل الحذف');
        return;
      }
    }
    setLocals((arr) => arr.filter((_, i) => i !== idx));
  };

  const removeColorGroup = async (color: string) => {
    const rows = locals.filter((v) => v.color === color);
    for (const r of rows) {
      if (r.id && r._saved) {
        try {
          await productsApi.removeVariant(r.id);
        } catch {
          // ignore
        }
      }
    }
    setLocals((arr) => arr.filter((v) => v.color !== color));
    toast.success(`تم حذف اللون ${color}`);
  };

  const saveAll = useMutation({
    mutationFn: async () => {
      const warehouses = await settingsApi.listWarehouses(false);
      const wh =
        (warehouses as any[]).find((w: any) => w.is_main) ||
        (warehouses as any[])[0];
      if (!wh) throw new Error('لا يوجد فرع افتراضي');

      for (const v of locals) {
        if (v._saved && v.id) {
          await productsApi.updateVariant(v.id, {
            sku: v.sku,
            color: v.color,
            size: v.size || undefined,
            cost_price: Number(v.cost_price) || 0,
            selling_price: Number(v.selling_price) || 0,
            image_url: v.image_url || null,
          } as any);
        } else {
          const created = await productsApi.addVariant({
            product_id: productId,
            sku: v.sku,
            color: v.color,
            size: v.size || undefined,
            cost_price: Number(v.cost_price) || 0,
            selling_price: Number(v.selling_price) || 0,
            image_url: v.image_url || null,
          } as any);
          const qty = Number(v.stock_qty);
          if (qty > 0) {
            await stockApi.adjust({
              variant_id: created.id,
              warehouse_id: wh.id,
              delta: qty,
              reason: 'initial stock',
              unit_cost: Number(v.cost_price) || 0,
            });
          }
        }
      }
    },
    onSuccess: () => {
      toast.success('تم حفظ جميع الأصناف');
      qc.invalidateQueries({ queryKey: ['products'] });
      qc.invalidateQueries({ queryKey: ['product', productId, 'variants'] });
      onDone();
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.message || 'فشل حفظ بعض الأصناف';
      toast.error(Array.isArray(msg) ? msg[0] : String(msg));
    },
  });

  const [newColor, setNewColor] = useState('');

  return (
    <div className="space-y-4">
      <div className="p-3 rounded-lg bg-brand-50 border border-brand-100 text-sm text-slate-600">
        {hasSizes
          ? 'للأحذية: أضف اللون أولاً ثم اختر المقاسات المتوفرة لكل لون.'
          : 'للشنط والإكسسوارات: أضف الألوان المتوفرة فقط (مقاس واحد لكل لون).'}
      </div>

      <div className="flex items-center gap-2 p-3 rounded-lg bg-slate-50 border border-slate-200">
        <Palette size={16} className="text-slate-500" />
        <select
          className="input flex-1"
          value={newColor}
          onChange={(e) => setNewColor(e.target.value)}
        >
          <option value="">— اختر لوناً لإضافته —</option>
          {colors
            .filter((c) => !locals.some((v) => v.color === c.name_ar))
            .map((c) => (
              <option key={c.id} value={c.name_ar}>
                {c.name_ar}
              </option>
            ))}
        </select>
        <button
          className="btn-primary py-1.5"
          disabled={!newColor}
          onClick={() => {
            addColorGroup(newColor);
            setNewColor('');
          }}
        >
          <Plus size={14} /> إضافة اللون
        </button>
      </div>

      {byColor.length === 0 && (
        <div className="text-center py-8 text-slate-400 text-sm">
          لم تضف أي لون بعد.
        </div>
      )}

      {byColor.map(([color, rows]) => (
        <ColorGroup
          key={color}
          color={color}
          rows={rows}
          allLocals={locals}
          hasSizes={hasSizes}
          sizes={sizes}
          onAddSize={(size) => addSizeToColor(color, size)}
          onUpdate={(indexInAllLocals, patch) =>
            updateLocal(indexInAllLocals, patch)
          }
          onRemove={(indexInAllLocals) => removeLocal(indexInAllLocals)}
          onRemoveColor={() => removeColorGroup(color)}
        />
      ))}

      <div className="flex items-center justify-end gap-2 pt-4 border-t border-slate-100">
        <button className="btn-ghost" onClick={onDone}>
          إغلاق
        </button>
        <button
          className="btn-primary"
          onClick={() => saveAll.mutate()}
          disabled={saveAll.isPending || locals.length === 0}
        >
          {saveAll.isPending ? 'جاري الحفظ...' : 'حفظ جميع الأصناف'}
        </button>
      </div>
    </div>
  );
}

function ColorGroup({
  color,
  rows,
  allLocals,
  hasSizes,
  sizes,
  onAddSize,
  onUpdate,
  onRemove,
  onRemoveColor,
}: {
  color: string;
  rows: LocalVariant[];
  allLocals: LocalVariant[];
  hasSizes: boolean;
  sizes: SizeOption[];
  onAddSize: (size: string) => void;
  onUpdate: (indexInAllLocals: number, patch: Partial<LocalVariant>) => void;
  onRemove: (indexInAllLocals: number) => void;
  onRemoveColor: () => void;
}) {
  const [addSize, setAddSize] = useState('');
  const existingSizes = new Set(rows.map((r) => r.size));

  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden">
      <div className="flex items-center justify-between bg-slate-50 px-4 py-2 border-b border-slate-200">
        <div className="flex items-center gap-2">
          <span className="chip bg-pink-100 text-pink-700 font-bold">
            <Palette size={12} /> {color}
          </span>
          <span className="text-xs text-slate-500">{rows.length} صنف</span>
        </div>
        <button
          className="text-xs text-rose-600 hover:bg-rose-100 px-2 py-1 rounded"
          onClick={onRemoveColor}
        >
          <Trash2 size={12} className="inline" /> حذف اللون
        </button>
      </div>

      <div className="divide-y divide-slate-100">
        {rows.map((row) => {
          const idx = allLocals.indexOf(row);
          return (
            <div key={row.sku + '-' + idx} className="p-3">
              <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
                {hasSizes && (
                  <Field label="المقاس" dense>
                    <input
                      readOnly
                      className="input bg-slate-50"
                      value={row.size || ''}
                    />
                  </Field>
                )}
                <Field label="كود فرعي (SKU)" dense>
                  <input
                    className="input font-mono text-xs"
                    value={row.sku}
                    onChange={(e) => onUpdate(idx, { sku: e.target.value })}
                  />
                </Field>
                <Field label="التكلفة" dense>
                  <input
                    type="number"
                    className="input"
                    value={row.cost_price}
                    onChange={(e) =>
                      onUpdate(idx, { cost_price: e.target.value })
                    }
                  />
                </Field>
                <Field label="السعر" dense>
                  <input
                    type="number"
                    className="input"
                    value={row.selling_price}
                    onChange={(e) =>
                      onUpdate(idx, { selling_price: e.target.value })
                    }
                  />
                </Field>
                {!row._saved && (
                  <Field label="الكمية" dense>
                    <input
                      type="number"
                      min={0}
                      className="input"
                      value={row.stock_qty}
                      onChange={(e) =>
                        onUpdate(idx, { stock_qty: e.target.value })
                      }
                    />
                  </Field>
                )}
                <button
                  className="h-9 px-2 rounded-lg bg-rose-100 text-rose-600 hover:bg-rose-200"
                  onClick={() => onRemove(idx)}
                  title="حذف الصنف"
                >
                  <Trash2 size={14} />
                </button>
              </div>

              <div className="mt-2">
                <ImageUploader
                  compact
                  value={row.image_url}
                  onChange={(url) => onUpdate(idx, { image_url: url })}
                  label="صورة"
                />
              </div>
            </div>
          );
        })}
      </div>

      {hasSizes && (
        <div className="flex items-center gap-2 p-3 bg-slate-50 border-t border-slate-200">
          <Ruler size={14} className="text-slate-500" />
          <select
            className="input flex-1 py-1.5"
            value={addSize}
            onChange={(e) => setAddSize(e.target.value)}
          >
            <option value="">— اختر مقاساً لإضافته —</option>
            {sizes
              .filter((s) => !existingSizes.has(s.size_label))
              .map((s) => (
                <option key={s.id} value={s.size_label}>
                  {s.size_label}
                </option>
              ))}
          </select>
          <button
            className="btn-secondary py-1.5 text-sm"
            disabled={!addSize}
            onClick={() => {
              onAddSize(addSize);
              setAddSize('');
            }}
          >
            <Plus size={12} /> إضافة مقاس
          </button>
        </div>
      )}
    </div>
  );
}

function buildSku(base: string, color: string, size: string) {
  const c = (color || '').slice(0, 3).replace(/\s/g, '').toUpperCase();
  const s = (size || '').replace(/\s/g, '');
  return [base, c, s].filter(Boolean).join('-');
}

/* ─────────────────────── Groups / Categories modal ─────────────────────── */

function GroupsModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: categories = [], isLoading } = useQuery({
    queryKey: ['categories'],
    queryFn: categoriesApi.list,
  });
  const [newName, setNewName] = useState('');
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const createM = useMutation({
    mutationFn: () => categoriesApi.create({ name_ar: newName.trim() }),
    onSuccess: () => {
      toast.success('تم إضافة المجموعة');
      setNewName('');
      qc.invalidateQueries({ queryKey: ['categories'] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'فشل'),
  });
  const updateM = useMutation({
    mutationFn: (p: { id: string; name: string }) =>
      categoriesApi.update(p.id, { name_ar: p.name.trim() }),
    onSuccess: () => {
      toast.success('تم التعديل');
      setEditId(null);
      qc.invalidateQueries({ queryKey: ['categories'] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'فشل'),
  });
  const deleteM = useMutation({
    mutationFn: (id: string) => categoriesApi.remove(id),
    onSuccess: () => {
      toast.success('تم الحذف');
      qc.invalidateQueries({ queryKey: ['categories'] });
    },
  });

  return (
    <Modal title="إدارة المجموعات / الأقسام" onClose={onClose}>
      <div className="space-y-4">
        <div className="flex gap-2">
          <input
            className="input flex-1"
            placeholder="اسم المجموعة الجديدة..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && newName.trim()) createM.mutate();
            }}
          />
          <button
            className="btn-primary"
            onClick={() => newName.trim() && createM.mutate()}
            disabled={createM.isPending || !newName.trim()}
          >
            <Plus size={16} /> إضافة
          </button>
        </div>

        <div className="max-h-80 overflow-y-auto divide-y divide-slate-100 rounded-lg border border-slate-200">
          {isLoading && (
            <div className="p-4 text-center text-slate-400 text-sm">
              جارٍ التحميل...
            </div>
          )}
          {!isLoading && categories.length === 0 && (
            <div className="p-4 text-center text-slate-400 text-sm">
              لا توجد مجموعات — أضف أول مجموعة من الأعلى.
            </div>
          )}
          {categories.map((c) => (
            <div
              key={c.id}
              className="flex items-center justify-between p-3 hover:bg-slate-50"
            >
              {editId === c.id ? (
                <>
                  <input
                    className="input flex-1"
                    value={editName}
                    autoFocus
                    onChange={(e) => setEditName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter')
                        updateM.mutate({ id: c.id, name: editName });
                      if (e.key === 'Escape') setEditId(null);
                    }}
                  />
                  <button
                    className="text-emerald-600 px-2 py-1 hover:bg-emerald-50 rounded text-sm font-bold"
                    onClick={() => updateM.mutate({ id: c.id, name: editName })}
                  >
                    حفظ
                  </button>
                  <button
                    className="text-slate-500 px-2 py-1 text-sm"
                    onClick={() => setEditId(null)}
                  >
                    إلغاء
                  </button>
                </>
              ) : (
                <>
                  <div className="flex items-center gap-2">
                    <Tag size={14} className="text-slate-400" />
                    <span className="font-semibold">{c.name_ar}</span>
                    <span className="text-xs text-slate-400">
                      ({c.products_count ?? 0} منتج)
                    </span>
                  </div>
                  <div className="flex items-center gap-1">
                    <button
                      className="p-1.5 hover:bg-slate-200 rounded text-slate-500"
                      onClick={() => {
                        setEditId(c.id);
                        setEditName(c.name_ar);
                      }}
                    >
                      <PencilLine size={14} />
                    </button>
                    <button
                      className="p-1.5 hover:bg-rose-100 rounded text-rose-500"
                      onClick={() => {
                        if (
                          confirm(
                            `هل أنت متأكد من حذف المجموعة "${c.name_ar}"؟`,
                          )
                        ) {
                          deleteM.mutate(c.id);
                        }
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/* ─────────────────────── Image uploader w/ compression ─────────────────────── */

function ImageUploader({
  value,
  onChange,
  label = 'رفع صورة',
  compact = false,
}: {
  value?: string;
  onChange: (url: string) => void;
  label?: string;
  compact?: boolean;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (file: File) => {
    setUploading(true);
    try {
      const blob = await compressImage(file, {
        maxDimension: 1200,
        quality: 0.8,
      });
      const filename = file.name.replace(/\.[^.]+$/, '') + '.jpg';
      const res = await uploadsApi.image(blob, filename);
      onChange(res.url);
      toast.success(`تم رفع الصورة (${(blob.size / 1024).toFixed(0)} KB)`);
    } catch (e: any) {
      toast.error(e?.message || 'فشل رفع الصورة');
    } finally {
      setUploading(false);
    }
  };

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        {value ? (
          <img
            src={resolveImageUrl(value)}
            alt=""
            className="w-12 h-12 rounded-lg object-cover border border-slate-200"
          />
        ) : (
          <div className="w-12 h-12 rounded-lg bg-slate-50 border border-dashed border-slate-200 flex items-center justify-center text-slate-400">
            <ImageIcon size={16} />
          </div>
        )}
        <button
          type="button"
          className="btn-secondary py-1 text-xs"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          <Upload size={12} /> {uploading ? '...' : label}
        </button>
        {value && (
          <button
            type="button"
            className="p-1 rounded hover:bg-rose-100 text-rose-500"
            onClick={() => onChange('')}
            title="حذف الصورة"
          >
            <X size={14} />
          </button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) handleFile(f);
            e.target.value = '';
          }}
        />
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      {value ? (
        <img
          src={resolveImageUrl(value)}
          alt=""
          className="w-24 h-24 rounded-lg object-cover border border-slate-200"
        />
      ) : (
        <div className="w-24 h-24 rounded-lg bg-slate-50 border border-dashed border-slate-200 flex items-center justify-center text-slate-400">
          <ImageIcon size={20} />
        </div>
      )}
      <div className="flex flex-col gap-2">
        <button
          type="button"
          className="btn-secondary"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          <Upload size={14} /> {uploading ? 'جاري الرفع...' : label}
        </button>
        {value && (
          <button
            type="button"
            className="text-xs text-rose-600 hover:underline"
            onClick={() => onChange('')}
          >
            إزالة الصورة
          </button>
        )}
        <div className="text-xs text-slate-400">
          يتم ضغط الصورة قبل الرفع (1200px, JPEG 80%).
        </div>
      </div>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) handleFile(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/* ─────────────────────── Shared primitives ─────────────────────── */

function TabBtn({
  active,
  onClick,
  disabled,
  children,
}: {
  active: boolean;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`px-4 py-2 text-sm font-bold border-b-2 transition ${
        active
          ? 'border-brand-600 text-brand-600'
          : disabled
            ? 'border-transparent text-slate-300 cursor-not-allowed'
            : 'border-transparent text-slate-500 hover:text-slate-700'
      }`}
    >
      {children}
    </button>
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
  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div
        className={`bg-white rounded-2xl w-full ${
          size === 'lg' ? 'max-w-3xl' : 'max-w-xl'
        } max-h-[90vh] overflow-y-auto`}
      >
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

function Field({
  label,
  children,
  dense = false,
}: {
  label: string;
  children: React.ReactNode;
  dense?: boolean;
}) {
  return (
    <label className="block">
      <span
        className={`${
          dense ? 'text-[10px]' : 'text-xs'
        } font-bold text-slate-600 mb-1 block`}
      >
        {label}
      </span>
      {children}
    </label>
  );
}
