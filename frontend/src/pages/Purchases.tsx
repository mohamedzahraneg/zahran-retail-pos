import { Fragment, useEffect, useMemo, useState } from 'react';
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
  Tag,
} from 'lucide-react';
import {
  purchasesApi,
  type PurchaseDetail,
  type PurchaseStatus,
  type CreatePurchaseItemPayload,
  type CreatePurchasePayload,
  type PurchaseProductSearchRow,
} from '@/api/purchases.api';
import { suppliersApi, type Supplier } from '@/api/suppliers.api';
import {
  settingsApi,
  SMART_PRICING_DEFAULTS,
  type SmartPricingSettings,
} from '@/api/settings.api';
// PR-PURCHASES-P1 — new purchase-invoice helpers.
import { SupplierContextCard } from '@/components/purchases/SupplierContextCard';
import { SupplierSearch } from '@/components/purchases/SupplierSearch';
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
// PR-PURCHASES-P3.1 — sale price suggestions (frontend-only).
import { PricingSuggestions } from '@/components/purchases/PricingSuggestions';
import {
  suggestPrices,
  type PricingStrategy,
} from '@/components/purchases/pricingMath';
// PR-PURCHASES-P3.2 — manual apply suggested sale price modal.
import {
  ApplyPricesModal,
  type ApplyPricesItem,
} from '@/components/purchases/ApplyPricesModal';
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
  // Purchases UX fixes — the default list view hides cancelled
  // invoices (the operator complaint that triggered this fix). The
  // filter dropdown now carries a virtual "all + cancelled" choice
  // that flips `include_cancelled` on; picking the explicit
  // `cancelled` status still returns just cancelled rows.
  type ListMode = '' | PurchaseStatus | 'all_with_cancelled';
  const [filter, setFilter] = useState<ListMode>('');
  const [supplierFilter, setSupplierFilter] = useState('');
  const [showCreate, setShowCreate] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [payId, setPayId] = useState<string | null>(null);
  const [editId, setEditId] = useState<string | null>(null);
  // Cash-flow UX bridge — remember which freshly-created purchases
  // were marked as "كاش" in the create modal. After receive succeeds
  // on one of these, we auto-open PayPurchaseModal with the existing
  // official path (no new endpoint, no direct cashbox call). The set
  // is local-only — refreshing the page clears it.
  const [cashIntentIds, setCashIntentIds] = useState<Set<string>>(new Set());
  // When the pay modal is auto-opened from a cash intent we want the
  // amount field to default to the remaining instead of zero. This
  // flag rides along with `payId` for that one modal session.
  const [payAutoFillRemaining, setPayAutoFillRemaining] = useState(false);

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
        status:
          filter === '' || filter === 'all_with_cancelled'
            ? undefined
            : (filter as PurchaseStatus),
        supplier_id: supplierFilter || undefined,
        include_cancelled: filter === 'all_with_cancelled' ? true : undefined,
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
    onSuccess: (_data, id) => {
      toast.success('تم استلام الفاتورة وتحديث المخزون');
      qc.invalidateQueries({ queryKey: ['purchases'] });
      // Cash-flow UX bridge — if this purchase was created with the
      // "كاش" intent, auto-open the existing PayPurchaseModal so the
      // operator records the payment via the OFFICIAL pay endpoint.
      if (cashIntentIds.has(id)) {
        setCashIntentIds((prev) => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
        setPayAutoFillRemaining(true);
        setPayId(id);
      }
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
          className="input w-56"
          value={filter}
          onChange={(e) => setFilter(e.target.value as ListMode)}
          data-testid="purchases-status-filter"
        >
          {/* Default — hides cancelled invoices. */}
          <option value="">كل الفواتير النشطة</option>
          <option value="draft">مسودة</option>
          <option value="received">مستلمة</option>
          <option value="partial">سداد جزئي</option>
          <option value="paid">مسددة</option>
          <option value="cancelled">ملغاة فقط</option>
          {/* Explicit "show cancelled too" option. */}
          <option value="all_with_cancelled">كل الفواتير + الملغاة</option>
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
        <CreatePurchaseModal
          onClose={() => setShowCreate(false)}
          onCreated={(newId, paymentType) => {
            // Cash-flow UX bridge — remember the cash-intent ids so
            // we can auto-open PayPurchaseModal after receive. Credit
            // invoices are silent.
            if (paymentType === 'cash' && newId) {
              setCashIntentIds((prev) => {
                const next = new Set(prev);
                next.add(newId);
                return next;
              });
            }
          }}
        />
      )}

      {detailId && (
        <PurchaseDetailModal id={detailId} onClose={() => setDetailId(null)} />
      )}

      {payId && (
        <PayPurchaseModal
          id={payId}
          autoFillRemaining={payAutoFillRemaining}
          onClose={() => {
            setPayId(null);
            setPayAutoFillRemaining(false);
          }}
        />
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

function CreatePurchaseModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  /** Cash-flow UX bridge — fired with the new purchase id + the
   *  selected payment type so the parent can remember "كاش" intent
   *  and auto-open PayPurchaseModal after receive. Optional so the
   *  modal stays usable from any future caller. */
  onCreated?: (newId: string | null, paymentType: 'cash' | 'credit') => void;
}) {
  const qc = useQueryClient();
  // Purchases UX fixes — supplier is now picked via the SupplierSearch
  // typeahead. We keep a Supplier object alongside the id so the
  // SupplierContextCard + search component both render correctly.
  const [supplier, setSupplier] = useState<Supplier | null>(null);
  // PR-PURCHASES-P3.3 — load smart_pricing settings once per modal
  // mount. Falls back to built-in defaults on failure so suggestion
  // cards always render — pricing config is non-blocking by design.
  const { data: pricingSettings = SMART_PRICING_DEFAULTS as SmartPricingSettings } =
    useQuery({
      queryKey: ['settings', 'smart_pricing'],
      queryFn: () => settingsApi.getSmartPricing(),
      staleTime: 60_000,
      retry: false,
    });
  const { data: warehouses = [] } = useQuery({
    queryKey: ['warehouses'],
    queryFn: () => settingsApi.listWarehouses(),
  });

  const [form, setForm] = useState({
    warehouse_id: '',
    invoice_date: new Date().toISOString().slice(0, 10),
    due_date: '',
    supplier_ref: '',
    discount_amount: 0,
    tax_amount: 0,
    notes: '',
  });
  // Purchases UX fixes — invoice payment intent (cash/credit). This
  // is a UI-only toggle for now: the backend has no `payment_type`
  // column and there is NO official cashbox-write path attached to
  // purchase creation. Picking "كاش" only locks `due_date` to today;
  // it does NOT post a payment, debit the cashbox, or move money. A
  // future migration can promote this to a real column when the
  // payment flow at create time is designed end-to-end.
  const [paymentType, setPaymentType] = useState<'cash' | 'credit'>('credit');

  // PR-PURCHASES-P1 — line items now carry optional UI-only metadata
  // (carton mode, cartons, pieces_per_carton, carton_cost) for the
  // table display. The backend payload is still piece-level only —
  // see `_ui` strip in the createMut.
  // PR-PURCHASES-P3.1 — `_ui.selling_price` captures the variant's
  // current sale price at search-pick time so the per-line pricing
  // suggestions panel can compute vs-current deltas without a refetch.
  type LineItem = CreatePurchaseItemPayload & {
    display?: string;
    _ui?: {
      display: string;
      mode: 'piece' | 'carton';
      cartons?: number;
      pieces_per_carton?: number;
      carton_cost?: number;
      selling_price?: number;
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

  // PR-PURCHASES-P3.1 — per-line pricing-suggestions UI state. Both
  // are LOCAL-ONLY. `expandedPricingRows` toggles the suggestion
  // panel; `pendingPrices` records which strategy + price the
  // operator marked. P3.1 NEVER persists either of these — the
  // purchase create payload below strips them out completely. P3.2
  // will introduce an explicit apply path.
  const [expandedPricingRows, setExpandedPricingRows] = useState<
    Record<number, boolean>
  >({});
  const [pendingPrices, setPendingPrices] = useState<
    Record<number, { strategy: PricingStrategy; price: number }>
  >({});
  // PR-PURCHASES-P3.2 — opens the apply-prices confirmation modal.
  // The modal calls a separate endpoint and is INDEPENDENT of the
  // purchase create payload, which still strips pendingPrices entirely.
  const [showApplyPrices, setShowApplyPrices] = useState(false);

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
        // Purchases UX fixes — the legacy `shipping_cost` input was
        // removed from the create modal in favour of the "إضافة مصروف"
        // (LandedCostsSection) flow. The preview always receives 0 so
        // landed-cost math stays anchored on extras + line costs only.
        shipping_cost: 0,
        discount_amount: Number(form.discount_amount || 0),
        tax_amount: Number(form.tax_amount || 0),
      }),
    [
      items,
      extraCosts,
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
        supplier_id: supplier?.id ?? '',
        warehouse_id: form.warehouse_id,
        invoice_date: form.invoice_date || undefined,
        // Purchases UX fixes — cash invoice means "paid on the invoice
        // date" intent, expressed as `due_date == invoice_date`. The
        // backend has no `payment_type` column and we deliberately do
        // NOT post a cashbox transaction here (no official path for
        // payment-at-create exists yet — see HOLD report). Credit
        // invoices honour the operator-supplied due_date.
        due_date:
          paymentType === 'cash'
            ? form.invoice_date || undefined
            : form.due_date || undefined,
        supplier_ref: form.supplier_ref || undefined,
        // Legacy `shipping_cost` is intentionally omitted — operators
        // enter shipping/transport/labour through "إضافة مصروف" now.
        // Sending 0 keeps the backend happy without altering existing
        // landed-cost math (the extras path is the source of truth).
        shipping_cost: 0,
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
    onSuccess: (created: any) => {
      toast.success('تم إنشاء فاتورة المشتريات');
      qc.invalidateQueries({ queryKey: ['purchases'] });
      // Notify the page so it can remember cash intent for the
      // auto-open-PayPurchaseModal bridge after receive succeeds.
      // The pay endpoint stays the OFFICIAL one — this is purely a
      // page-level memory hint.
      if (onCreated) onCreated(created?.id ?? null, paymentType);
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل إنشاء الفاتورة'),
  });

  // Confirm a line from PurchaseLineEntry → append to items.
  // PR-PURCHASES-P3.1 — capture the picked variant's current
  // selling_price into `_ui` so the per-line pricing-suggestions
  // panel can compute vs-current deltas without a re-fetch.
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
        _ui: {
          ...payload._ui,
          selling_price: pendingRow?.selling_price,
        },
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
    if (!supplier?.id || !form.warehouse_id) {
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
        // Purchases UX fixes — disable Enter-submits-form globally so
        // the keyboard flow (product → qty → price → Enter adds the
        // line) never accidentally fires the parent "Save" action. The
        // Save button (type=submit) still works on click; per-input
        // Enter handlers in SupplierSearch / PurchaseLineEntry call
        // their own `e.preventDefault()` so this is a belt-and-braces
        // guard for the remaining text inputs (notes / supplier_ref /
        // discount / tax).
        onKeyDown={(e) => {
          if (
            e.key === 'Enter'
            && !(e.target instanceof HTMLTextAreaElement)
            && !(e.target instanceof HTMLButtonElement)
          ) {
            e.preventDefault();
          }
        }}
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

        {/* Purchases UX fixes — supplier is now typeahead-searchable. */}
        <div>
          <label className="label">المورد *</label>
          <SupplierSearch
            value={supplier}
            onSelect={setSupplier}
            onClear={() => setSupplier(null)}
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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
          {/* Purchases UX fixes — payment intent toggle. UI-only;
              "كاش" snaps due_date = invoice_date but does NOT post a
              cashbox transaction (no official path for that yet). */}
          <div>
            <label className="label">نوع الفاتورة</label>
            <div
              className="inline-flex w-full rounded-lg border border-slate-200 overflow-hidden text-sm"
              role="tablist"
              data-testid="purchase-payment-type"
            >
              <button
                type="button"
                role="tab"
                aria-selected={paymentType === 'credit'}
                onClick={() => setPaymentType('credit')}
                className={`flex-1 px-3 py-2 ${
                  paymentType === 'credit'
                    ? 'bg-brand-500 text-white font-bold'
                    : 'bg-white text-slate-700 hover:bg-slate-50'
                }`}
                data-testid="purchase-payment-type-credit"
              >
                أجل
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={paymentType === 'cash'}
                onClick={() => setPaymentType('cash')}
                className={`flex-1 px-3 py-2 ${
                  paymentType === 'cash'
                    ? 'bg-brand-500 text-white font-bold'
                    : 'bg-white text-slate-700 hover:bg-slate-50'
                }`}
                data-testid="purchase-payment-type-cash"
              >
                كاش
              </button>
            </div>
          </div>
          <div>
            <label className="label">تاريخ الاستحقاق</label>
            <input
              type="date"
              className="input"
              value={paymentType === 'cash' ? form.invoice_date : form.due_date}
              disabled={paymentType === 'cash'}
              onChange={(e) => setForm({ ...form, due_date: e.target.value })}
              data-testid="purchase-due-date"
            />
            {paymentType === 'cash' ? (
              <p
                className="text-[11px] text-slate-500 mt-1"
                data-testid="purchase-payment-type-cash-hint"
              >
                فواتير الكاش يكون تاريخ الاستحقاق فيها هو نفس تاريخ الفاتورة.
                لا يتم تسجيل دفع تلقائي للخزينة الآن — سجّل الدفع لاحقًا من
                زر السداد.
              </p>
            ) : null}
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
        {supplier?.id ? (
          <SupplierContextCard supplierId={supplier.id} />
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
                      <Fragment key={idx}>
                        <tr>
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
                            <div className="flex items-center gap-1 justify-end">
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedPricingRows((m) => ({
                                    ...m,
                                    [idx]: !m[idx],
                                  }))
                                }
                                className="icon-btn text-amber-600"
                                title="اقتراحات السعر"
                                data-testid={`pricing-toggle-${idx}`}
                              >
                                <Tag className="w-4 h-4" />
                              </button>
                              <button
                                type="button"
                                onClick={() =>
                                  setItems((xs) =>
                                    xs.filter((_, i) => i !== idx),
                                  )
                                }
                                className="icon-btn text-rose-500"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                        {expandedPricingRows[idx] ? (
                          <tr
                            data-testid={`pricing-row-${idx}`}
                            className="bg-amber-50/30"
                          >
                            <td
                              colSpan={hasCapitalizedExtras ? 8 : 6}
                              className="p-2"
                            >
                              <PricingSuggestions
                                result={suggestPrices({
                                  cost:
                                    pv?.final_unit_cost ??
                                    Number(it.unit_cost || 0),
                                  currentSellingPrice: it._ui?.selling_price,
                                  // PR-PURCHASES-P3.3 — settings drive both
                                  // the strategy formulas and the
                                  // min-margin warning threshold.
                                  minMarginPct:
                                    pricingSettings.min_margin_pct_default,
                                  settings: {
                                    competitiveMarkupPct:
                                      pricingSettings.competitive_markup_pct,
                                    recommendedMarginPct:
                                      pricingSettings.recommended_margin_pct,
                                    highMarginPct:
                                      pricingSettings.high_margin_pct,
                                    wholesaleMarkupPct:
                                      pricingSettings.wholesale_markup_pct,
                                    roundingStep: pricingSettings.rounding_step,
                                    roundingMode: pricingSettings.rounding_mode,
                                  },
                                })}
                                appliedStrategy={
                                  pendingPrices[idx]?.strategy ?? null
                                }
                                onApply={(s) =>
                                  setPendingPrices((m) => ({
                                    ...m,
                                    [idx]: {
                                      strategy: s.strategy,
                                      price: s.price,
                                    },
                                  }))
                                }
                              />
                            </td>
                          </tr>
                        ) : null}
                      </Fragment>
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
              {/* PR-PURCHASES-P3.1 — pending-prices count tile. Surfaces
                  when the operator marked at least one suggested price.
                  Marker is LOCAL-ONLY; nothing is sent on save. */}
              {Object.keys(pendingPrices).length > 0 ? (
                <SummaryTile
                  label="أسعار مقترحة محددة"
                  value={`${Object.keys(pendingPrices).length} / ${items.length}`}
                />
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

        {/* Purchases UX fixes — the standalone "الشحن" input was
            removed. Shipping / transport / labour costs now flow
            through the LandedCostsSection ("إضافة مصروف") block above
            so the allocator can distribute them onto product costs
            consistently. */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
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

        <div className="flex justify-between items-center gap-2 pt-2">
          {/* PR-PURCHASES-P3.2 — manual apply button. INDEPENDENT of
              the purchase save mutation: clicking it opens a
              confirmation modal that calls /products/variants/apply-
              prices on its own. Visible only when ≥1 pending price. */}
          <div>
            {Object.keys(pendingPrices).length > 0 ? (
              <button
                type="button"
                onClick={() => setShowApplyPrices(true)}
                className="btn-ghost text-amber-700 border border-amber-300 hover:bg-amber-50"
                data-testid="apply-prices-open"
              >
                تطبيق الأسعار المحددة ({Object.keys(pendingPrices).length})
              </button>
            ) : null}
          </div>
          <div className="flex gap-2">
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

      {/* PR-PURCHASES-P3.2 — apply-prices confirmation modal. */}
      <ApplyPricesModal
        open={showApplyPrices}
        items={Object.entries(pendingPrices).map(([rowIdxStr, pp]) => {
          const rowIndex = Number(rowIdxStr);
          const line = items[rowIndex];
          return {
            row_index: rowIndex,
            variant_id: line?.variant_id ?? '',
            display:
              line?.display
              || line?._ui?.display
              || line?.variant_id
              || '',
            current_selling_price: line?._ui?.selling_price,
            new_selling_price: pp.price,
            strategy: pp.strategy,
          } satisfies ApplyPricesItem;
        })}
        onClose={() => setShowApplyPrices(false)}
        onApplied={(rowIndexes) =>
          setPendingPrices((m) => {
            const next = { ...m };
            for (const idx of rowIndexes) delete next[idx];
            return next;
          })
        }
      />
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
  autoFillRemaining = false,
}: {
  id: string;
  onClose: () => void;
  /** Cash-flow UX bridge — when true and the purchase data arrives,
   *  default `amount` to the remaining balance so the operator can
   *  hit save without retyping. Only set by the auto-open path; the
   *  manual pay-button flow leaves the form's existing 0 default. */
  autoFillRemaining?: boolean;
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

  // Cash-flow UX bridge — when the modal is auto-opened from the
  // cash-intent flow, default the amount to `remaining` once the
  // purchase data is available. We only apply this once (when the
  // form is still at its initial zero) so the operator can adjust
  // afterwards without us overwriting their input on the next render.
  useEffect(() => {
    if (autoFillRemaining && remaining > 0 && form.amount === 0) {
      setForm((f) => ({ ...f, amount: remaining }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoFillRemaining, remaining]);

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
  // PR-PURCHASES-P3.3 — smart_pricing settings, mirrors CreatePurchaseModal.
  const { data: pricingSettings = SMART_PRICING_DEFAULTS as SmartPricingSettings } =
    useQuery({
      queryKey: ['settings', 'smart_pricing'],
      queryFn: () => settingsApi.getSmartPricing(),
      staleTime: 60_000,
      retry: false,
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
  // PR-PURCHASES-P3.1 — local-only pricing-suggestions state. Same
  // shape and rules as CreatePurchaseModal: no payload leak, no DB
  // write. `currentSellingPrice` is unavailable on the edit detail
  // load (the read model doesn't surface variant.selling_price), so
  // suggestions render without the vs-current comparison.
  const [expandedPricingRows, setExpandedPricingRows] = useState<
    Record<number, boolean>
  >({});
  const [pendingPrices, setPendingPrices] = useState<
    Record<number, { strategy: PricingStrategy; price: number }>
  >({});
  // PR-PURCHASES-P3.2 — controlled apply-prices modal trigger.
  const [showApplyPrices, setShowApplyPrices] = useState(false);

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

  // PR-PURCHASES-P2.3B — derive the edit path. Only ONE of these is
  // true at a time. The save mutation + footer button + body banner
  // each read this flag instead of recomputing.
  const detailPaid = Number((detail as any)?.paid_amount ?? 0);
  const isPaidOrPartial =
    detail?.status === 'paid'
    || detail?.status === 'partial'
    || detailPaid > 0;
  const isCancelled = detail?.status === 'cancelled';
  const isAlreadyReplaced = !!(detail as any)?.replaced_by_purchase_id;
  const isReplacementSafe =
    !!detail
    && detail.status === 'received'
    && !isPaidOrPartial
    && !isAlreadyReplaced;
  const isBlocked = !!detail && !isDraft && !isReplacementSafe;
  // Precedence: already-replaced gives the operator the most
  // actionable hint ("go edit the newer row"), so it wins over the
  // generic "cancelled" message even when both apply (a replaced row
  // is always cancelled).
  const blockedMessage = isAlreadyReplaced
    ? 'هذه الفاتورة تم تبديلها بفاتورة مصححة بالفعل. عدّل الفاتورة الأحدث في السلسلة.'
    : isCancelled
      ? 'الفاتورة ملغاة — لا يمكن تعديلها.'
      : isPaidOrPartial
        ? 'الفاتورة مسددة جزئيًا أو كليًا. التعديل بعد بدء السداد يحتاج خطوة استرداد أو دفعة إضافية، وسيتم تنفيذه في المرحلة القادمة.'
        : '';

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

  // PR-PURCHASES-P2.3B — extras can now be edited on the
  // received+unpaid safe-replacement path. We only keep the read-only
  // extras view when the purchase is `isBlocked` (paid/partial/
  // cancelled/already-replaced) — those paths can't save anything
  // anyway.
  const detailHasExtras = ((detail as any)?.extra_costs ?? []).length > 0;

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
      if (!isDraft && reason.trim().length < 3)
        return Promise.reject(
          new Error('سبب التعديل مطلوب (3 أحرف على الأقل).'),
        );
      if (hasExtraErrors)
        return Promise.reject(
          new Error(
            'يوجد خطأ في توزيع المصاريف الإضافية — راجع التوزيع اليدوي.',
          ),
        );
      if (isBlocked)
        return Promise.reject(new Error(blockedMessage));
      const body: CreatePurchasePayload & { edit_reason?: string } = {
        supplier_id: detail!.supplier_id,
        warehouse_id: detail!.warehouse_id,
        notes: notes || undefined,
        shipping_cost: shippingCost || undefined,
        discount_amount: discountAmount || undefined,
        tax_amount: taxAmount || undefined,
        // PR-PURCHASES-P2.3B — edit_reason is mandatory for non-draft
        // (required >= 3 chars by both sides). For drafts the field is
        // optional and a generic fallback is fine.
        edit_reason: !isDraft
          ? reason.trim()
          : reason.trim() || 'تعديل فاتورة مشتريات',
        items: items.map((it) => ({
          variant_id: it.variant_id,
          quantity: it.quantity,
          // Always BASE — backend re-runs the allocator. Sending the
          // landed value here would double-bake on save.
          unit_cost: it.unit_cost,
          discount: it.discount || 0,
          tax: it.tax || 0,
        })),
        // PR-PURCHASES-P2.3B — extras are allowed on draft AND on the
        // received+unpaid safe-replacement path (the backend re-runs
        // the allocator inside the replacement transaction). Only the
        // blocked paths skip extras.
        extra_costs:
          (isDraft || isReplacementSafe) && cleanExtraCosts.length > 0
            ? cleanExtraCosts
            : undefined,
      };
      return purchasesApi.edit(id, body);
    },
    onSuccess: (res: any) => {
      // PR-PURCHASES-P2.3B — surface the replacement explicitly when
      // it happened so the operator sees that the OLD invoice was
      // cancelled and a NEW one was issued.
      if (res?.replacement?.new_purchase_id) {
        const newNo = res?.purchase?.purchase_no ?? '';
        toast.success(
          newNo
            ? `تم إلغاء الفاتورة وإصدار فاتورة بديلة ${newNo}.`
            : 'تم إلغاء الفاتورة وإصدار فاتورة بديلة.',
        );
      } else {
        toast.success('تم حفظ التعديل');
      }
      qc.invalidateQueries({ queryKey: ['purchases'] });
      qc.invalidateQueries({ queryKey: ['purchase-detail', id] });
      qc.invalidateQueries({ queryKey: ['pricing-history'] });
      qc.invalidateQueries({ queryKey: ['pricing-landed-impact'] });
      qc.invalidateQueries({ queryKey: ['sold-profit-products'] });
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
            <p
              className="text-xs text-slate-500 mt-1"
              data-testid="edit-purchase-subtitle"
            >
              {isDraft
                ? 'الفاتورة مسودة — سيتم التعديل في نفس السجل.'
                : isReplacementSafe
                  ? 'سيتم إلغاء الفاتورة المستلمة الحالية وعكس أثرها ثم إنشاء فاتورة مصححة واستلامها من جديد.'
                  : blockedMessage}
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
                        <Fragment key={`${it.variant_id}-${idx}`}>
                        <tr>
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
                            <div className="flex items-center gap-1 justify-end">
                              <button
                                type="button"
                                onClick={() =>
                                  setExpandedPricingRows((m) => ({
                                    ...m,
                                    [idx]: !m[idx],
                                  }))
                                }
                                className="icon-btn text-amber-600"
                                title="اقتراحات السعر"
                                data-testid={`edit-pricing-toggle-${idx}`}
                              >
                                <Tag className="w-4 h-4" />
                              </button>
                              <button
                                onClick={() => remove(idx)}
                                className="icon-btn text-rose-600"
                                title="حذف"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </td>
                        </tr>
                        {expandedPricingRows[idx] ? (
                          <tr
                            data-testid={`edit-pricing-row-${idx}`}
                            className="bg-amber-50/30"
                          >
                            <td
                              colSpan={hasCapitalizedExtras ? 9 : 7}
                              className="p-2"
                            >
                              <PricingSuggestions
                                result={suggestPrices({
                                  cost:
                                    pv?.final_unit_cost ??
                                    Number(it.unit_cost || 0),
                                  // Edit detail does not carry the
                                  // variant's current selling_price (out
                                  // of scope for P3.1 — would need a
                                  // backend join). Suggestions still
                                  // render; vs-current just goes blank.
                                  currentSellingPrice: undefined,
                                  // PR-PURCHASES-P3.3 — settings drive
                                  // formulas + min-margin threshold.
                                  minMarginPct:
                                    pricingSettings.min_margin_pct_default,
                                  settings: {
                                    competitiveMarkupPct:
                                      pricingSettings.competitive_markup_pct,
                                    recommendedMarginPct:
                                      pricingSettings.recommended_margin_pct,
                                    highMarginPct:
                                      pricingSettings.high_margin_pct,
                                    wholesaleMarkupPct:
                                      pricingSettings.wholesale_markup_pct,
                                    roundingStep: pricingSettings.rounding_step,
                                    roundingMode: pricingSettings.rounding_mode,
                                  },
                                })}
                                appliedStrategy={
                                  pendingPrices[idx]?.strategy ?? null
                                }
                                onApply={(s) =>
                                  setPendingPrices((m) => ({
                                    ...m,
                                    [idx]: {
                                      strategy: s.strategy,
                                      price: s.price,
                                    },
                                  }))
                                }
                              />
                            </td>
                          </tr>
                        ) : null}
                        </Fragment>
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

              {/* Purchases UX fixes — the standalone شحن input was
                  removed from the edit modal too. Legacy invoices that
                  carry a non-zero shipping_cost still load it into the
                  edit modal's state (read-only echo below) and the
                  value is re-sent on save so the totals don't drift.
                  New shipping/transport/labour costs go through the
                  LandedCostsSection ("إضافة مصروف") block above. */}
              {shippingCost > 0 ? (
                <div
                  className="rounded-md border border-slate-200 bg-slate-50 p-2 text-xs text-slate-600 flex items-center justify-between"
                  data-testid="edit-legacy-shipping-readonly"
                >
                  <span>شحن قديم (للقراءة فقط)</span>
                  <span className="font-bold">{EGP(shippingCost)}</span>
                </div>
              ) : null}
              <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
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

              {/* PR-PURCHASES-P2.3B — landed-cost UI:
                    · DRAFT and RECEIVED+UNPAID get the full editor
                      (the backend replacement flow re-runs the
                      allocator inside the same transaction).
                    · BLOCKED paths (paid / partial / cancelled /
                      already-replaced) render the existing extras
                      as read-only with the blocking Arabic banner. */}
              {isDraft || isReplacementSafe ? (
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
                    {blockedMessage}
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

              {/* PR-PURCHASES-P2.3B — operator banner for the
                  blocked paths. The save button stays disabled
                  but we surface the exact reason explicitly. */}
              {isBlocked ? (
                <div
                  data-testid="edit-purchase-blocked-banner"
                  className="rounded-xl border border-rose-200 bg-rose-50/40 p-3 text-xs font-bold text-rose-700"
                >
                  {blockedMessage}
                </div>
              ) : null}

              {/* PR-PURCHASES-P2.3B — replacement warning + reason
                  input for the received+unpaid safe path. */}
              {isReplacementSafe && (
                <div
                  data-testid="edit-purchase-replacement-warning"
                  className="rounded-xl border border-amber-300 bg-amber-50/60 p-3 text-xs text-amber-900 leading-relaxed"
                >
                  سيتم إلغاء الفاتورة المستلمة الحالية وعكس أثرها على المخزون
                  وقيود المشتريات ثم إنشاء فاتورة مصححة واستلامها من جديد.
                  الفاتورة الحالية لم تُسدَّد جزئيًا أو كليًا، لذلك العملية آمنة
                  ولن تُنشئ أي حركة خزنة. أدخل سبب التعديل أدناه.
                </div>
              )}
              {!isDraft && !isBlocked && (
                <div>
                  <label className="text-xs text-slate-600 block mb-1">
                    سبب التعديل * (3 أحرف على الأقل)
                  </label>
                  <textarea
                    rows={2}
                    className="input"
                    placeholder="مثال: تصحيح كمية / تعديل تكلفة"
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    data-testid="edit-purchase-reason"
                  />
                </div>
              )}
            </>
          )}
        </div>

        <div className="p-4 border-t flex items-center justify-between gap-2">
          {/* PR-PURCHASES-P3.2 — manual apply button (edit modal).
              Available regardless of draft/non-draft; pricing flow is
              independent of the purchase edit save. */}
          <div>
            {Object.keys(pendingPrices).length > 0 ? (
              <button
                type="button"
                onClick={() => setShowApplyPrices(true)}
                className="btn-ghost text-amber-700 border border-amber-300 hover:bg-amber-50"
                data-testid="edit-apply-prices-open"
              >
                تطبيق الأسعار المحددة ({Object.keys(pendingPrices).length})
              </button>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
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
                (!isDraft && reason.trim().length < 3) ||
                hasExtraErrors ||
                isBlocked
              }
              className="btn-primary"
              title={
                isBlocked
                  ? blockedMessage
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
      {/* PR-PURCHASES-P3.2 — apply-prices confirmation modal. */}
      <ApplyPricesModal
        open={showApplyPrices}
        sourcePurchaseId={detail?.id}
        items={Object.entries(pendingPrices).map(([rowIdxStr, pp]) => {
          const rowIndex = Number(rowIdxStr);
          const line = items[rowIndex];
          return {
            row_index: rowIndex,
            variant_id: line?.variant_id ?? '',
            display: line?.product_name || line?.sku || line?.variant_id || '',
            // Edit detail does not surface variant.selling_price, so
            // the diff column will be "—". Apply still works server-
            // side because the endpoint reads the current price live.
            current_selling_price: undefined,
            new_selling_price: pp.price,
            strategy: pp.strategy,
          } satisfies ApplyPricesItem;
        })}
        onClose={() => setShowApplyPrices(false)}
        onApplied={(rowIndexes) =>
          setPendingPrices((m) => {
            const next = { ...m };
            for (const idx of rowIndexes) delete next[idx];
            return next;
          })
        }
      />
    </div>
  );
}
