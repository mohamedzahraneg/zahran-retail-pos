import { useEffect, useMemo, useState } from 'react';
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
  Pencil,
  Minus,
} from 'lucide-react';
import {
  purchasesApi,
  type PurchaseDetail,
  type PurchaseStatus,
  type CreatePurchaseItemPayload,
  type CreatePurchasePayload,
  type PurchaseProductSearchRow,
} from '@/api/purchases.api';
import { suppliersApi } from '@/api/suppliers.api';
import { settingsApi } from '@/api/settings.api';
// PR-PURCHASES-P1 — new purchase-invoice helpers.
import { SupplierContextCard } from '@/components/purchases/SupplierContextCard';
import { PurchaseProductSearch } from '@/components/purchases/PurchaseProductSearch';
import { PurchaseLineEntry } from '@/components/purchases/PurchaseLineEntry';
import { QuickAddProductModal } from '@/components/purchases/QuickAddProductModal';
// PR-PURCHASES-P2.2 — landed-cost UI + preview math.
import { LandedCostsSection } from '@/components/purchases/LandedCostsSection';
import type { ExtraCostRow } from '@/components/purchases/landedCostState';
import {
  COST_TYPE_LABEL as COST_TYPE_LABEL_AR,
  ALLOC_METHOD_LABEL as ALLOC_METHOD_LABEL_AR,
} from '@/components/purchases/landedCostLabels';
import { computeLandedPreview } from '@/components/purchases/landedCostMath';
import { useAuthStore } from '@/stores/auth.store';
import { useTableSort } from '@/lib/useTableSort';
// PR-FE-IDEM-STOCK-PURCHASES-OPS (Sprint 5 / FE-IDEM PR 7C) —
// per-action reset hooks. Receive + cancel are page-level row
// buttons → per-click reset. Pay uses modal mount/unmount
// (PayPurchaseModal). cancelReturn route is BE-protected but has
// no current FE caller — helper gates the URL only.
import {
  resetPurchaseReceiveIdempotencyKey,
  resetPurchaseCancelIdempotencyKey,
  resetPurchasePayIdempotencyKey,
} from '@/lib/stock-purchases-idempotency';

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
  const [editId, setEditId] = useState<string | null>(null);

  const user = useAuthStore((s) => s.user);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  // Permission-only: admin passes through the '*' wildcard. Managers
  // now need the purchases.* grants explicitly.
  void user;
  const canEdit = hasPermission('purchases.edit');
  const canCancelNonDraft = hasPermission('purchases.cancel');

  const qc = useQueryClient();

  const { data: purchasesRaw = [], isLoading } = useQuery({
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

  const { sorted: purchases, thProps, sortIcon } = useTableSort(
    purchasesRaw,
    'invoice_date',
    'desc',
    {
      remaining: (p: any) =>
        Number(p.grand_total || 0) - Number(p.paid_amount || 0),
    },
  );

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
                  <th {...thProps('purchase_no')} className={`p-3 text-right ${thProps('purchase_no').className}`}>
                    {sortIcon('purchase_no')} رقم الفاتورة
                  </th>
                  <th {...thProps('supplier_name')} className={`p-3 text-right ${thProps('supplier_name').className}`}>
                    {sortIcon('supplier_name')} المورد
                  </th>
                  <th {...thProps('invoice_date')} className={`p-3 text-right ${thProps('invoice_date').className}`}>
                    {sortIcon('invoice_date')} التاريخ
                  </th>
                  <th {...thProps('grand_total')} className={`p-3 text-right ${thProps('grand_total').className}`}>
                    {sortIcon('grand_total')} الإجمالي
                  </th>
                  <th {...thProps('paid_amount')} className={`p-3 text-right ${thProps('paid_amount').className}`}>
                    {sortIcon('paid_amount')} المسدد
                  </th>
                  <th {...thProps('remaining')} className={`p-3 text-right ${thProps('remaining').className}`}>
                    {sortIcon('remaining')} المتبقي
                  </th>
                  <th {...thProps('status')} className={`p-3 text-right ${thProps('status').className}`}>
                    {sortIcon('status')} الحالة
                  </th>
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
                                  // PR-FE-IDEM-STOCK-PURCHASES-OPS —
                                  // reset per-click so each purchase's
                                  // receive gets a fresh key.
                                  resetPurchaseReceiveIdempotencyKey();
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
                          {canEdit && p.status !== 'cancelled' && (
                            <button
                              title="تعديل"
                              onClick={() => setEditId(p.id)}
                              className="icon-btn text-amber-600"
                            >
                              <Pencil className="w-4 h-4" />
                            </button>
                          )}
                          {(p.status === 'draft' ||
                            (canCancelNonDraft && p.status !== 'cancelled')) && (
                            <button
                              title="إلغاء"
                              onClick={() => {
                                if (
                                  window.confirm(
                                    p.status === 'draft'
                                      ? `هل تريد إلغاء الفاتورة ${p.purchase_no}؟`
                                      : `إلغاء الفاتورة ${p.purchase_no} سيعكس المخزون والدفعات. المتابعة؟`,
                                  )
                                ) {
                                  // PR-FE-IDEM-STOCK-PURCHASES-OPS —
                                  // reset per-click so each purchase's
                                  // cancel gets a fresh key.
                                  resetPurchaseCancelIdempotencyKey();
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

      {editId && (
        <EditPurchaseModal id={editId} onClose={() => setEditId(null)} />
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

  // PR-PURCHASES-P1 — line items now carry optional UI-only metadata
  // (carton mode, cartons, pieces_per_carton, carton_cost) for the
  // table display. The backend payload is still piece-level only —
  // see `_ui` strip in the createMut.
  type LineItem = CreatePurchaseItemPayload & {
    display?: string;
    _ui?: {
      display: string;
      mode: 'piece' | 'carton';
      cartons?: number;
      pieces_per_carton?: number;
      carton_cost?: number;
    };
  };
  const [items, setItems] = useState<LineItem[]>([]);

  // Currently-picked variant awaiting line-entry confirmation. When
  // null the operator is back on the search input.
  const [pendingRow, setPendingRow] = useState<PurchaseProductSearchRow | null>(
    null,
  );
  // Seed text for the quick-add modal; null = closed.
  const [quickAddSeed, setQuickAddSeed] = useState<string | null>(null);

  // PR-PURCHASES-P2.2 — landed-cost extras state (operator-edited
  // rows). Backend reruns the same allocation engine on save, so the
  // frontend math here is preview-only.
  const [extraCosts, setExtraCosts] = useState<ExtraCostRow[]>([]);

  // Live allocation preview. Backend is source of truth; this is for
  // operator visibility (per-line breakdown + summary tiles).
  const preview = useMemo(
    () =>
      computeLandedPreview({
        lines: items.map((i) => ({
          variant_id: i.variant_id,
          quantity: i.quantity,
          base_unit_cost: i.unit_cost,
          discount: i.discount,
          tax: i.tax,
        })),
        extras: extraCosts.map((e) => ({
          cost_type: e.cost_type,
          amount: Number(e.amount || 0),
          capitalize_to_inventory: e.capitalize_to_inventory !== false,
          allocation_method: e.allocation_method ?? 'by_value',
          manual_allocations: e.manual_allocations,
        })),
        shipping_cost: Number(form.shipping_cost || 0),
        discount_amount: Number(form.discount_amount || 0),
        tax_amount: Number(form.tax_amount || 0),
      }),
    [
      items,
      extraCosts,
      form.shipping_cost,
      form.discount_amount,
      form.tax_amount,
    ],
  );
  // Index per-variant for fast lookup when rendering the line table.
  const previewByVariant = useMemo(() => {
    const m = new Map<string, (typeof preview)['lines'][number]>();
    for (const l of preview.lines) m.set(l.variant_id, l);
    return m;
  }, [preview]);

  const subtotal = preview.products_base_subtotal;
  const totalPieces = useMemo(
    () => items.reduce((s, i) => s + (i.quantity || 0), 0),
    [items],
  );
  const distinctVariants = useMemo(
    () => new Set(items.map((i) => i.variant_id)).size,
    [items],
  );
  const grandTotal = preview.grand_total_preview;
  const hasCapitalizedExtras = preview.extra_costs_capitalized > 0;
  const hasAnyExtras =
    preview.extra_costs_capitalized > 0
    || preview.extra_costs_non_capitalized > 0;
  const extraCostErrors = preview.errors;
  const hasExtraErrors = Object.keys(extraCostErrors).length > 0;

  // Drop rows with amount <= 0 before sending; manual_allocations
  // travel as-is so the backend can revalidate.
  const cleanExtraCosts = useMemo(
    () =>
      extraCosts
        .map(({ _key: _k, ...rest }) => rest)
        .filter((r) => Number(r.amount || 0) > 0),
    [extraCosts],
  );

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
        // Strip UI-only metadata before sending. Backend payload remains
        // exactly the existing CreatePurchaseDto shape — items[].unit_cost
        // stays the BASE price the operator typed; the backend allocator
        // converts it to landed.
        items: items.map(({ display: _d, _ui: _u, ...rest }) => rest),
        extra_costs: cleanExtraCosts.length > 0 ? cleanExtraCosts : undefined,
      }),
    onSuccess: () => {
      toast.success('تم إنشاء فاتورة المشتريات');
      qc.invalidateQueries({ queryKey: ['purchases'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل إنشاء الفاتورة'),
  });

  // Confirm a line from PurchaseLineEntry → append to items.
  const confirmLine = (
    payload: CreatePurchaseItemPayload & {
      _ui: NonNullable<LineItem['_ui']>;
    },
  ) => {
    setItems((xs) => [
      ...xs,
      {
        ...payload,
        display: payload._ui.display,
      } as LineItem,
    ]);
    setPendingRow(null);
  };

  // QuickAddProductModal → product+variant created → wrap as a search
  // row and route to PurchaseLineEntry just like a search-result pick.
  const onQuickAddCreated = ({
    product,
    variant,
  }: {
    product: any;
    variant: any;
  }) => {
    const row: PurchaseProductSearchRow = {
      product_id: product.id,
      sku_root: product.sku_root,
      name_ar: product.name_ar,
      name_en: product.name_en ?? null,
      primary_image_url: product.primary_image_url ?? null,
      base_price: Number(product.base_price ?? 0),
      variant_id: variant.id,
      variant_sku: variant.sku,
      variant_barcode: variant.barcode ?? null,
      variant_image_url: variant.image_url ?? null,
      color: variant.color ?? null,
      size: variant.size ?? null,
      cost_price: Number(variant.cost_price ?? product.cost_price ?? 0),
      selling_price: Number(
        variant.selling_price ?? product.base_price ?? 0,
      ),
      available_stock: 0,
      last_purchase_price: null,
      last_purchase_at: null,
      last_supplier_name: null,
      last_supplier_id: null,
      exact_match: true,
      rank_score: 1,
    };
    setQuickAddSeed(null);
    setPendingRow(row);
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
    if (hasExtraErrors) {
      toast.error(
        'يوجد خطأ في توزيع المصاريف الإضافية — راجع التوزيع اليدوي.',
      );
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

        {/* PR-PURCHASES-P1 — Supplier context card, shown once a
            supplier is selected. Read-only single-roundtrip fetch. */}
        {form.supplier_id ? (
          <SupplierContextCard supplierId={form.supplier_id} />
        ) : null}

        {/* PR-PURCHASES-P1 — line entry replaces the cascading
            product → variant dropdowns with a unified search. */}
        <div className="border border-slate-200 rounded-xl p-3 space-y-3">
          <h3 className="font-bold text-slate-700">الأصناف</h3>

          {pendingRow ? (
            <PurchaseLineEntry
              row={pendingRow}
              onConfirm={confirmLine}
              onCancel={() => setPendingRow(null)}
            />
          ) : (
            <PurchaseProductSearch
              warehouseId={form.warehouse_id || undefined}
              onSelect={(row) => setPendingRow(row)}
              onQuickAdd={(q) => setQuickAddSeed(q)}
              autoFocus={items.length === 0}
            />
          )}

          {items.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="p-2 text-right">الصنف</th>
                    <th className="p-2 text-right">الوحدة</th>
                    <th className="p-2 text-right">القطع</th>
                    {hasCapitalizedExtras ? (
                      <>
                        <th className="p-2 text-right">سعر القطعة الأساسي</th>
                        <th className="p-2 text-right">نصيب المصاريف</th>
                        <th className="p-2 text-right">تكلفة القطعة النهائية</th>
                        <th className="p-2 text-right">إجمالي السطر النهائي</th>
                      </>
                    ) : (
                      <>
                        <th className="p-2 text-right">سعر القطعة</th>
                        <th className="p-2 text-right">إجمالي السطر</th>
                      </>
                    )}
                    <th className="p-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {items.map((it, idx) => {
                    const lt =
                      it.quantity * it.unit_cost -
                      (it.discount || 0) +
                      (it.tax || 0);
                    const ui = it._ui;
                    const unitLabel = ui
                      ? ui.mode === 'carton'
                        ? `${ui.cartons ?? 0} × كرتونة (${ui.pieces_per_carton ?? 1})`
                        : ui.pieces_per_carton && ui.pieces_per_carton > 1
                          ? `قطعة (${ui.pieces_per_carton}/كرتونة)`
                          : 'قطعة'
                      : 'قطعة';
                    const pv = previewByVariant.get(it.variant_id);
                    return (
                      <tr key={idx}>
                        <td className="p-2">{it.display || it.variant_id}</td>
                        <td className="p-2 text-xs">{unitLabel}</td>
                        <td className="p-2">{it.quantity}</td>
                        {hasCapitalizedExtras ? (
                          <>
                            <td className="p-2">{EGP(it.unit_cost)}</td>
                            <td
                              className="p-2 text-emerald-700"
                              data-testid={`line-allocated-${idx}`}
                            >
                              +{EGP(pv?.allocated_cost_per_unit ?? 0)}
                            </td>
                            <td
                              className="p-2 font-bold"
                              data-testid={`line-final-unit-cost-${idx}`}
                            >
                              {EGP(pv?.final_unit_cost ?? it.unit_cost)}
                            </td>
                            <td
                              className="p-2 font-bold"
                              data-testid={`line-final-line-total-${idx}`}
                            >
                              {EGP(pv?.final_line_total ?? lt)}
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="p-2">{EGP(it.unit_cost)}</td>
                            <td className="p-2 font-bold">{EGP(lt)}</td>
                          </>
                        )}
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

          {/* Live summary tiles — extra tiles surface when extras exist. */}
          {items.length > 0 ? (
            <div
              data-testid="purchase-invoice-summary"
              className={`grid gap-2 text-xs ${
                hasAnyExtras
                  ? 'grid-cols-2 md:grid-cols-4'
                  : 'grid-cols-2 md:grid-cols-4'
              }`}
            >
              <SummaryTile label="عدد الأصناف" value={String(distinctVariants)} />
              <SummaryTile label="عدد القطع" value={String(totalPieces)} />
              <SummaryTile label="إجمالي المنتجات قبل المصاريف" value={EGP(subtotal)} />
              <SummaryTile label="إجمالي الفاتورة" value={EGP(grandTotal)} highlight />
              {hasAnyExtras ? (
                <>
                  <SummaryTile
                    label="مصاريف محملة على التكلفة"
                    value={EGP(preview.extra_costs_capitalized)}
                  />
                  <SummaryTile
                    label="مصاريف غير محملة"
                    value={EGP(preview.extra_costs_non_capitalized)}
                  />
                  <SummaryTile
                    label="إجمالي المخزون بعد التحميل"
                    value={EGP(preview.final_inventory_total)}
                  />
                  <SummaryTile
                    label="إجمالي الفاتورة النهائي"
                    value={EGP(preview.grand_total_preview)}
                    highlight
                  />
                </>
              ) : null}
            </div>
          ) : null}
        </div>

        {/* PR-PURCHASES-P2.2 — landed-cost extras section. */}
        <LandedCostsSection
          rows={extraCosts}
          lines={items.map((it) => ({
            variant_id: it.variant_id,
            display: it.display || it.variant_id,
            quantity: it.quantity,
            base_unit_cost: it.unit_cost,
          }))}
          capitalizedTotal={preview.extra_costs_capitalized}
          nonCapitalizedTotal={preview.extra_costs_non_capitalized}
          errors={extraCostErrors}
          onChange={setExtraCosts}
        />

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
            disabled={createMut.isPending || hasExtraErrors}
            className="btn-primary"
            data-testid="purchase-submit"
            title={
              hasExtraErrors
                ? 'يوجد خطأ في توزيع المصاريف الإضافية'
                : undefined
            }
          >
            حفظ كمسودة
          </button>
        </div>
      </form>

      {/* PR-PURCHASES-P1 — quick-add product modal layered on top. */}
      {quickAddSeed !== null ? (
        <QuickAddProductModal
          initialQuery={quickAddSeed}
          onClose={() => setQuickAddSeed(null)}
          onCreated={onQuickAddCreated}
        />
      ) : null}
    </div>
  );
}

// PR-PURCHASES-P1 — tiny presentational helper used by the live
// summary tiles in CreatePurchaseModal. Kept local so the modal stays
// self-contained.
function SummaryTile({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div
      className={`rounded-md border p-2 ${
        highlight
          ? 'bg-brand-50 border-brand-200 text-brand-700'
          : 'bg-white border-slate-200 text-slate-700'
      }`}
    >
      <div className="text-[10px] text-slate-500 mb-0.5">{label}</div>
      <div className="font-bold">{value}</div>
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
  // PR-PURCHASES-P2.2 — surface backend-persisted landed-cost data.
  // Backend writes these on receive (and on create when extras exist),
  // so legacy purchases just render the classic 5-column layout.
  const capitalizedTotal = Number(p.extra_costs_capitalized || 0);
  const nonCapitalizedTotal = Number(p.extra_costs_non_capitalized || 0);
  const extras = p.extra_costs ?? [];
  const hasLandedColumns = p.items.some(
    (it) =>
      it.base_unit_cost != null
      && Number(it.allocated_cost_total || 0) > 0,
  );
  const hasExtras = extras.length > 0;
  const hasExtraTotals = capitalizedTotal > 0 || nonCapitalizedTotal > 0;
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
                {hasLandedColumns ? (
                  <>
                    <th className="p-2 text-right">سعر القطعة الأساسي</th>
                    <th className="p-2 text-right">نصيب المصاريف / قطعة</th>
                    <th className="p-2 text-right">تكلفة القطعة النهائية</th>
                  </>
                ) : (
                  <th className="p-2 text-right">السعر</th>
                )}
                <th className="p-2 text-right">الإجمالي</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {p.items.map((it) => (
                <tr key={it.id} data-testid={`detail-item-${it.id}`}>
                  <td className="p-2">{it.product_name}</td>
                  <td className="p-2 font-mono text-xs">{it.sku}</td>
                  <td className="p-2">{it.quantity}</td>
                  {hasLandedColumns ? (
                    <>
                      <td className="p-2">
                        {EGP(it.base_unit_cost ?? it.unit_cost)}
                      </td>
                      <td
                        className="p-2 text-emerald-700"
                        data-testid={`detail-allocated-${it.id}`}
                      >
                        +{EGP(it.allocated_cost_per_unit ?? 0)}
                        {it.manual_allocation ? (
                          <span className="text-[10px] text-slate-500 mr-1">
                            (يدوي)
                          </span>
                        ) : null}
                      </td>
                      <td
                        className="p-2 font-bold"
                        data-testid={`detail-final-unit-${it.id}`}
                      >
                        {EGP(it.unit_cost)}
                      </td>
                    </>
                  ) : (
                    <td className="p-2">{EGP(it.unit_cost)}</td>
                  )}
                  <td className="p-2 font-bold">{EGP(it.line_total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {hasExtras ? (
        <section data-testid="detail-extras">
          <h3 className="font-bold text-slate-700 mb-2">مصاريف إضافية</h3>
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-sm">
              <thead className="bg-slate-50">
                <tr>
                  <th className="p-2 text-right">النوع</th>
                  <th className="p-2 text-right">الوصف</th>
                  <th className="p-2 text-right">المبلغ</th>
                  <th className="p-2 text-right">يدخل في التكلفة؟</th>
                  <th className="p-2 text-right">طريقة التوزيع</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {extras.map((ec) => (
                  <tr key={ec.id} data-testid={`detail-extra-${ec.id}`}>
                    <td className="p-2">{COST_TYPE_LABEL_AR[ec.cost_type]}</td>
                    <td className="p-2 text-xs">{ec.label || '—'}</td>
                    <td className="p-2 font-bold">{EGP(ec.amount)}</td>
                    <td className="p-2">
                      {ec.capitalize_to_inventory ? 'نعم' : 'لا'}
                    </td>
                    <td className="p-2 text-xs">
                      {ALLOC_METHOD_LABEL_AR[ec.allocation_method]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <InfoBlock label="المجموع الجزئي" value={EGP(p.subtotal)} />
        <InfoBlock label="الشحن" value={EGP(p.shipping_cost)} />
        <InfoBlock label="الخصم" value={EGP(p.discount_amount)} />
        <InfoBlock label="الضريبة" value={EGP(p.tax_amount)} />
        {hasExtraTotals ? (
          <>
            <InfoBlock
              label="مصاريف محملة"
              value={EGP(capitalizedTotal)}
              accent="emerald"
            />
            <InfoBlock
              label="مصاريف غير محملة"
              value={EGP(nonCapitalizedTotal)}
            />
          </>
        ) : null}
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

  // PR-FE-IDEM-STOCK-PURCHASES-OPS — clean slate on mount, defensive
  // reset on unmount. Pay posts JE + CT (cash/bank), updates
  // purchase paid_amount. Independent key from receive/cancel.
  useEffect(() => {
    resetPurchasePayIdempotencyKey();
    return () => resetPurchasePayIdempotencyKey();
  }, []);

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

/* ───────── Edit purchase modal ───────── */

interface EditItem {
  variant_id: string;
  product_name?: string;
  sku?: string;
  quantity: number;
  unit_cost: number;
  discount: number;
  tax: number;
}

export function EditPurchaseModal({
  id,
  onClose,
}: {
  id: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: detail, isLoading } = useQuery({
    queryKey: ['purchase-detail', id],
    queryFn: () => purchasesApi.get(id),
  });

  const [items, setItems] = useState<EditItem[]>([]);
  const [notes, setNotes] = useState('');
  const [shippingCost, setShippingCost] = useState(0);
  const [discountAmount, setDiscountAmount] = useState(0);
  const [taxAmount, setTaxAmount] = useState(0);
  const [reason, setReason] = useState('');
  // PR-PURCHASES-P2.3A — landed-cost extras state. Preloaded from
  // detail.extra_costs on first render. Only sent back to the API for
  // DRAFT purchases (non-draft surfaces a blocking banner instead).
  const [extraCosts, setExtraCosts] = useState<ExtraCostRow[]>([]);

  useEffect(() => {
    if (!detail) return;
    setItems(
      (detail.items || []).map((it: any) => ({
        variant_id: it.variant_id,
        product_name: it.product_name || '',
        sku: it.sku || '',
        quantity: Number(it.quantity || 0),
        // Preload the operator-facing BASE price (P2.1's base_unit_cost
        // column). Falls back to unit_cost for legacy purchases that
        // pre-date migration 133. Sending base lets the allocator
        // rebuild the landed cost from scratch — otherwise re-saving a
        // draft would double-bake the allocation into unit_cost.
        unit_cost: Number(it.base_unit_cost ?? it.unit_cost ?? 0),
        discount: Number(it.discount || 0),
        tax: Number(it.tax || 0),
      })),
    );
    setNotes((detail as any).notes || '');
    setShippingCost(Number((detail as any).shipping_cost || 0));
    setDiscountAmount(Number((detail as any).discount_amount || 0));
    setTaxAmount(Number((detail as any).tax_amount || 0));
    setExtraCosts(
      ((detail as any).extra_costs ?? []).map(
        (e: any, idx: number): ExtraCostRow => ({
          _key: `ec-load-${e.id ?? idx}`,
          cost_type: e.cost_type,
          label: e.label ?? '',
          amount: Number(e.amount ?? 0),
          capitalize_to_inventory: e.capitalize_to_inventory !== false,
          allocation_method: e.allocation_method ?? 'by_value',
          notes: e.notes ?? '',
          sort_order: Number(e.sort_order ?? idx),
          // Manual sub-allocations aren't persisted on the read model
          // yet — operators reapply them when switching to manual.
          manual_allocations: [],
        }),
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detail?.id]);

  const isDraft = detail?.status === 'draft';

  // PR-PURCHASES-P2.3A — preview the same allocation the backend will
  // run on save (draft only). Non-draft renders extras read-only and
  // does not need the live preview.
  const preview = useMemo(
    () =>
      computeLandedPreview({
        lines: items.map((it) => ({
          variant_id: it.variant_id,
          quantity: it.quantity,
          base_unit_cost: it.unit_cost,
          discount: it.discount,
          tax: it.tax,
        })),
        extras: extraCosts.map((e) => ({
          cost_type: e.cost_type,
          amount: Number(e.amount || 0),
          capitalize_to_inventory: e.capitalize_to_inventory !== false,
          allocation_method: e.allocation_method ?? 'by_value',
          manual_allocations: e.manual_allocations,
        })),
        shipping_cost: Number(shippingCost || 0),
        discount_amount: Number(discountAmount || 0),
        tax_amount: Number(taxAmount || 0),
      }),
    [items, extraCosts, shippingCost, discountAmount, taxAmount],
  );
  const previewByVariant = useMemo(() => {
    const m = new Map<string, (typeof preview)['lines'][number]>();
    for (const l of preview.lines) m.set(l.variant_id, l);
    return m;
  }, [preview]);

  const subtotal = preview.products_base_subtotal;
  const grand = preview.grand_total_preview;
  const hasCapitalizedExtras = preview.extra_costs_capitalized > 0;
  const extraCostErrors = preview.errors;
  const hasExtraErrors = Object.keys(extraCostErrors).length > 0;

  // PR-PURCHASES-P2.3A — non-draft purchases with extras are blocked
  // from any landed-cost mutation. The flag covers both pre-existing
  // extras on the loaded purchase and any extras the operator
  // attempted to add through the modal.
  const detailHasExtras = ((detail as any)?.extra_costs ?? []).length > 0;
  const nonDraftLandedBlocked =
    !!detail && !isDraft && (detailHasExtras || extraCosts.length > 0);

  const cleanExtraCosts = useMemo(
    () =>
      extraCosts
        .map(({ _key: _k, ...rest }) => rest)
        .filter((r) => Number(r.amount || 0) > 0),
    [extraCosts],
  );

  const update = (idx: number, patch: Partial<EditItem>) =>
    setItems((p) => p.map((it, i) => (i === idx ? { ...it, ...patch } : it)));
  const remove = (idx: number) =>
    setItems((p) => p.filter((_, i) => i !== idx));

  const save = useMutation({
    mutationFn: () => {
      if (items.length === 0)
        return Promise.reject(new Error('يجب وجود صنف واحد على الأقل'));
      if (detail?.status !== 'draft' && !reason.trim())
        return Promise.reject(new Error('يجب كتابة سبب التعديل'));
      if (hasExtraErrors)
        return Promise.reject(
          new Error(
            'يوجد خطأ في توزيع المصاريف الإضافية — راجع التوزيع اليدوي.',
          ),
        );
      if (nonDraftLandedBlocked)
        return Promise.reject(
          new Error(
            'لا يمكن تعديل مصاريف فاتورة مشتريات مستلمة أو مدفوعة حاليًا. أنشئ تسوية مخصصة أو تواصل مع المدير.',
          ),
        );
      const body: CreatePurchasePayload & { edit_reason?: string } = {
        supplier_id: detail!.supplier_id,
        warehouse_id: detail!.warehouse_id,
        notes: notes || undefined,
        shipping_cost: shippingCost || undefined,
        discount_amount: discountAmount || undefined,
        tax_amount: taxAmount || undefined,
        edit_reason: reason || 'تعديل فاتورة مشتريات',
        items: items.map((it) => ({
          variant_id: it.variant_id,
          quantity: it.quantity,
          // Always BASE — backend re-runs the allocator. Sending the
          // landed value here would double-bake on save.
          unit_cost: it.unit_cost,
          discount: it.discount || 0,
          tax: it.tax || 0,
        })),
        // Extras only for drafts — non-draft never reaches this branch
        // because the guard above blocks it.
        extra_costs:
          isDraft && cleanExtraCosts.length > 0
            ? cleanExtraCosts
            : undefined,
      };
      return purchasesApi.edit(id, body);
    },
    onSuccess: () => {
      toast.success('تم حفظ التعديل');
      qc.invalidateQueries({ queryKey: ['purchases'] });
      qc.invalidateQueries({ queryKey: ['purchase-detail', id] });
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
              تعديل فاتورة {detail?.purchase_no || ''}
            </h3>
            <p className="text-xs text-slate-500 mt-1">
              {isDraft
                ? 'الفاتورة مسودة — سيتم التعديل في نفس السجل.'
                : detailHasExtras
                  ? 'الفاتورة مستلمة وتحتوي مصاريف محملة — تعديل المصاريف غير متاح في هذه الواجهة.'
                  : 'الفاتورة مستلمة — سيُصدر فاتورة جديدة بديلة وتُلغى الحالية مع عكس المخزون والدفعات.'}
            </p>
          </div>
          <button className="icon-btn" onClick={onClose} title="إغلاق">
            <XCircle className="w-4 h-4" />
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
                      <th className="p-2 text-right">
                        {hasCapitalizedExtras
                          ? 'سعر القطعة الأساسي'
                          : 'تكلفة الوحدة'}
                      </th>
                      <th className="p-2 text-right">خصم</th>
                      <th className="p-2 text-right">ضريبة</th>
                      {hasCapitalizedExtras ? (
                        <>
                          <th className="p-2 text-right">نصيب المصاريف</th>
                          <th className="p-2 text-right">
                            تكلفة القطعة النهائية
                          </th>
                        </>
                      ) : null}
                      <th className="p-2 text-right">الإجمالي</th>
                      <th className="p-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {items.map((it, idx) => {
                      const baseTotal =
                        it.quantity * it.unit_cost -
                        (it.discount || 0) +
                        (it.tax || 0);
                      const pv = previewByVariant.get(it.variant_id);
                      const total = hasCapitalizedExtras
                        ? (pv?.final_line_total ?? baseTotal)
                        : baseTotal;
                      return (
                        <tr key={`${it.variant_id}-${idx}`}>
                          <td className="p-2">
                            <div className="font-medium">
                              {it.product_name || '—'}
                            </div>
                            <div className="text-[10px] text-slate-400 font-mono">
                              {it.sku}
                            </div>
                          </td>
                          <td className="p-2">
                            <div className="flex items-center gap-1">
                              <button
                                className="p-1 rounded bg-slate-100 hover:bg-slate-200"
                                onClick={() =>
                                  update(idx, {
                                    quantity: Math.max(1, it.quantity - 1),
                                  })
                                }
                              >
                                <Minus size={12} />
                              </button>
                              <input
                                className="w-16 text-center border rounded text-sm"
                                type="number"
                                value={it.quantity}
                                min={1}
                                onChange={(e) =>
                                  update(idx, {
                                    quantity: Math.max(
                                      1,
                                      Number(e.target.value) || 1,
                                    ),
                                  })
                                }
                              />
                              <button
                                className="p-1 rounded bg-slate-100 hover:bg-slate-200"
                                onClick={() =>
                                  update(idx, { quantity: it.quantity + 1 })
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
                              value={it.unit_cost}
                              onChange={(e) =>
                                update(idx, {
                                  unit_cost: Number(e.target.value) || 0,
                                })
                              }
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              step="0.01"
                              className="w-20 border rounded px-1 py-0.5 text-sm"
                              value={it.discount}
                              onChange={(e) =>
                                update(idx, {
                                  discount: Number(e.target.value) || 0,
                                })
                              }
                            />
                          </td>
                          <td className="p-2">
                            <input
                              type="number"
                              step="0.01"
                              className="w-20 border rounded px-1 py-0.5 text-sm"
                              value={it.tax}
                              onChange={(e) =>
                                update(idx, {
                                  tax: Number(e.target.value) || 0,
                                })
                              }
                            />
                          </td>
                          {hasCapitalizedExtras ? (
                            <>
                              <td
                                className="p-2 text-emerald-700 text-xs"
                                data-testid={`edit-line-allocated-${idx}`}
                              >
                                +{EGP(pv?.allocated_cost_per_unit ?? 0)}
                              </td>
                              <td
                                className="p-2 font-bold"
                                data-testid={`edit-line-final-unit-${idx}`}
                              >
                                {EGP(pv?.final_unit_cost ?? it.unit_cost)}
                              </td>
                            </>
                          ) : null}
                          <td className="p-2 font-mono font-bold">
                            {EGP(total)}
                          </td>
                          <td className="p-2">
                            <button
                              onClick={() => remove(idx)}
                              className="icon-btn text-rose-600"
                              title="حذف"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                    {items.length === 0 && (
                      <tr>
                        <td
                          colSpan={hasCapitalizedExtras ? 9 : 7}
                          className="p-6 text-center text-slate-400"
                        >
                          لا توجد أصناف
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div>
                  <label className="text-xs text-slate-600 block mb-1">
                    شحن
                  </label>
                  <input
                    type="number"
                    className="input"
                    value={shippingCost}
                    onChange={(e) =>
                      setShippingCost(Number(e.target.value) || 0)
                    }
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-600 block mb-1">
                    خصم إجمالي
                  </label>
                  <input
                    type="number"
                    className="input"
                    value={discountAmount}
                    onChange={(e) =>
                      setDiscountAmount(Number(e.target.value) || 0)
                    }
                  />
                </div>
                <div>
                  <label className="text-xs text-slate-600 block mb-1">
                    ضريبة
                  </label>
                  <input
                    type="number"
                    className="input"
                    value={taxAmount}
                    onChange={(e) => setTaxAmount(Number(e.target.value) || 0)}
                  />
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

              {/* PR-PURCHASES-P2.3A — landed-cost UI. DRAFT gets the
                  full editor; non-draft renders extras as read-only
                  rows with a blocking Arabic banner. */}
              {isDraft ? (
                <LandedCostsSection
                  rows={extraCosts}
                  lines={items.map((it) => ({
                    variant_id: it.variant_id,
                    display: it.product_name || it.sku || it.variant_id,
                    quantity: it.quantity,
                    base_unit_cost: it.unit_cost,
                  }))}
                  capitalizedTotal={preview.extra_costs_capitalized}
                  nonCapitalizedTotal={preview.extra_costs_non_capitalized}
                  errors={extraCostErrors}
                  onChange={setExtraCosts}
                />
              ) : detailHasExtras ? (
                <section
                  data-testid="edit-landed-readonly"
                  className="rounded-xl border border-rose-200 bg-rose-50/40 p-3 space-y-2"
                >
                  <div
                    data-testid="edit-landed-block-banner"
                    className="text-xs font-bold text-rose-700"
                  >
                    لا يمكن تعديل مصاريف فاتورة مشتريات مستلمة أو مدفوعة حاليًا.
                    أنشئ تسوية مخصصة أو تواصل مع المدير.
                  </div>
                  <div className="overflow-x-auto border border-rose-100 rounded-lg bg-white">
                    <table className="w-full text-xs">
                      <thead className="bg-slate-50 text-slate-600">
                        <tr>
                          <th className="p-2 text-right">النوع</th>
                          <th className="p-2 text-right">الوصف</th>
                          <th className="p-2 text-right">المبلغ</th>
                          <th className="p-2 text-right">يدخل في التكلفة؟</th>
                          <th className="p-2 text-right">طريقة التوزيع</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {((detail as any).extra_costs ?? []).map((ec: any) => (
                          <tr key={ec.id}>
                            <td className="p-2">
                              {COST_TYPE_LABEL_AR[
                                ec.cost_type as keyof typeof COST_TYPE_LABEL_AR
                              ] ?? ec.cost_type}
                            </td>
                            <td className="p-2">{ec.label || '—'}</td>
                            <td className="p-2 font-bold">{EGP(ec.amount)}</td>
                            <td className="p-2">
                              {ec.capitalize_to_inventory ? 'نعم' : 'لا'}
                            </td>
                            <td className="p-2">
                              {ALLOC_METHOD_LABEL_AR[
                                ec.allocation_method as keyof typeof ALLOC_METHOD_LABEL_AR
                              ] ?? ec.allocation_method}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
              ) : null}

              <div className="flex items-center justify-between bg-slate-50 rounded-lg px-4 py-3">
                <div className="text-sm text-slate-600">
                  المجموع الفرعي:{' '}
                  <span className="font-bold">{EGP(subtotal)}</span>
                </div>
                <div className="text-lg font-black text-brand-600">
                  الإجمالي: {EGP(grand)}
                </div>
              </div>

              {!isDraft && (
                <div>
                  <label className="text-xs text-slate-600 block mb-1">
                    سبب التعديل *
                  </label>
                  <textarea
                    rows={2}
                    className="input"
                    placeholder="مثال: تصحيح كمية / تعديل تكلفة"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  />
                </div>
              )}
            </>
          )}
        </div>

        <div className="p-4 border-t flex items-center justify-end gap-2">
          <button onClick={onClose} className="btn-ghost">
            إلغاء
          </button>
          <button
            data-testid="edit-purchase-submit"
            onClick={() => save.mutate()}
            disabled={
              save.isPending ||
              items.length === 0 ||
              isLoading ||
              (!isDraft && !reason.trim()) ||
              hasExtraErrors ||
              nonDraftLandedBlocked
            }
            className="btn-primary"
            title={
              nonDraftLandedBlocked
                ? 'لا يمكن تعديل مصاريف فاتورة مشتريات مستلمة أو مدفوعة حاليًا.'
                : hasExtraErrors
                  ? 'يوجد خطأ في توزيع المصاريف الإضافية'
                  : undefined
            }
          >
            {save.isPending
              ? 'جاري الحفظ...'
              : isDraft
                ? 'حفظ التعديل'
                : 'إصدار فاتورة بديلة'}
          </button>
        </div>
      </div>
    </div>
  );
}
