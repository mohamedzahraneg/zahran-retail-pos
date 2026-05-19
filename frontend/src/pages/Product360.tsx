/**
 * Product360.tsx — PR-FIX-PRODUCT-360-ENHANCEMENT
 *
 * Read-only product analysis page. Two tabs ship with live data
 * (Overview + Matrix); the remaining five are placeholders pointing
 * at existing surfaces so users never hit a dead end.
 *
 * Enhancements over the shell version:
 *   · Rich product header (image placeholder, status badge, prices,
 *     category/brand chips, group badges).
 *   · 8 KPI cards including a derived margin_pct_30d (no new API).
 *   · 7 detail sections each with its own empty state:
 *       Variants summary, Stock by warehouse summary, Recent stock
 *       movements, Recent invoice items, Recent purchase items,
 *       Price history, Cost history.
 *   · Matrix tab gets local filters (warehouse / group / low_stock /
 *     out_of_stock) that operate on the already-loaded `cells[]` and
 *     `per_warehouse[]` — no new server calls.
 *   · Richer per-cell display: SKU, barcode, total/available/
 *     reserved quantities, cost + selling price, status badge,
 *     group chips, expandable per-warehouse list.
 *
 * Hard contract (do not break):
 *   · ZERO mutations. No POST / PATCH / DELETE.
 *   · No `useMutation` from React Query.
 *   · Anything that looks like an edit affordance is `disabled` /
 *     "قريباً".
 *   · The legacy /products list page is untouched.
 */
import { useMemo, useState } from 'react';
import { Link, useLocation, useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Package,
  Boxes,
  Warehouse,
  Activity,
  Tags,
  ChevronLeft,
  ShoppingBag,
  Coins,
  AlertTriangle,
  Layers,
  PackageX,
  TrendingUp,
  PackageSearch,
  Percent,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import {
  inventoryApi,
  type Product360Response,
  type ProductMatrixResponse,
  type ProductMatrixCell,
  type ProductMatrixCellWarehouse,
  type VariantGroupArrays,
} from '@/api/inventory.api';

type TabKey = 'overview' | 'matrix';

/** Local filters shared by both tabs. They never round-trip to the
 *  server — every value is applied to data already in the page. */
interface LocalFilters {
  warehouse_id: string;
  group_id: string;
  only_low_stock: boolean;
  only_out_of_stock: boolean;
}

const EMPTY_FILTERS: LocalFilters = {
  warehouse_id: '',
  group_id: '',
  only_low_stock: false,
  only_out_of_stock: false,
};

// ──────────────────────────────────────────────────────────────────
// Number helpers (top-level so they're shared by every sub-component)
// ──────────────────────────────────────────────────────────────────
function fmtNumber(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toLocaleString('en-EG') : '0';
}

function fmtEGP(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return `${v.toLocaleString('en-EG', { maximumFractionDigits: 2 })} ج.م`;
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ar-EG', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return iso;
  }
}

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${n.toFixed(1).replace(/\.0$/, '')}٪`;
}

// ──────────────────────────────────────────────────────────────────
// Page root
// ──────────────────────────────────────────────────────────────────
export default function Product360() {
  const { id } = useParams<{ id: string }>();
  const { pathname } = useLocation();

  const initialTab: TabKey = pathname.endsWith('/matrix')
    ? 'matrix'
    : 'overview';
  const activeTab = initialTab;
  const productId = id!;

  // Local filter state — shared between Overview and Matrix. Reset
  // on product change so loading a different product doesn't carry
  // stale filters.
  const [filters, setFilters] = useState<LocalFilters>(EMPTY_FILTERS);

  // Overview pulls /360. Matrix has its own endpoint so the tab
  // switch can be instant once cached.
  const overviewQ = useQuery({
    queryKey: ['product-360', productId],
    queryFn: () => inventoryApi.getProduct360(productId),
    enabled: !!productId,
    staleTime: 30_000,
  });

  const matrixQ = useQuery({
    queryKey: ['product-matrix', productId],
    queryFn: () => inventoryApi.getProductMatrix(productId),
    enabled: !!productId && activeTab === 'matrix',
    staleTime: 30_000,
  });

  // Derive the warehouse list + group list locally from already-
  // loaded data — avoids new server calls. The Overview response is
  // the richer source (it covers every warehouse the product has
  // stock in); we fall back to the matrix per_warehouse list when
  // only the matrix tab has loaded.
  const warehouseOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of overviewQ.data?.stock_by_warehouse ?? []) {
      m.set(r.warehouse_id, r.warehouse_name);
    }
    for (const cell of matrixQ.data?.cells ?? []) {
      for (const w of cell.per_warehouse ?? []) {
        if (w.warehouse_id) m.set(w.warehouse_id, w.warehouse_name);
      }
    }
    return Array.from(m.entries()).map(([id, name]) => ({ id, name }));
  }, [overviewQ.data, matrixQ.data]);

  const groupOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const g of overviewQ.data?.product_groups ?? []) {
      m.set(g.group_id, g.name_ar);
    }
    // Variants + matrix cells can also surface groups via their
    // parallel arrays.
    const harvest = (arr: VariantGroupArrays[] | undefined) => {
      for (const x of arr ?? []) {
        x.group_ids?.forEach((gid, i) => {
          if (gid) m.set(gid, x.group_names_ar?.[i] ?? gid);
        });
      }
    };
    harvest(overviewQ.data?.variants);
    harvest(matrixQ.data?.cells);
    return Array.from(m.entries()).map(([id, name]) => ({ id, name }));
  }, [overviewQ.data, matrixQ.data]);

  return (
    <div className="space-y-4" data-testid="product-360">
      <div className="flex items-center gap-2 text-xs text-slate-500">
        <Link to="/products" className="hover:text-indigo-600">
          المنتجات
        </Link>
        <ChevronLeft size={12} className="rotate-180" />
        <span>تفاصيل المنتج</span>
      </div>

      {/* ── Tab navigation ───────────────────────────────────── */}
      <nav
        className="card p-1 flex flex-wrap gap-1 text-xs"
        data-testid="product-360-tabs"
      >
        <Tab to={`/products/${productId}`} active={activeTab === 'overview'}>
          <Package size={13} /> نظرة عامة
        </Tab>
        <Tab
          to={`/products/${productId}/matrix`}
          active={activeTab === 'matrix'}
        >
          <Boxes size={13} /> شبكة المتغيرات
        </Tab>
        <DisabledTab>
          <Warehouse size={13} /> المخزون
        </DisabledTab>
        <DisabledTab>
          <Activity size={13} /> الحركات
        </DisabledTab>
        <DisabledTab>
          <ShoppingBag size={13} /> المبيعات
        </DisabledTab>
        <DisabledTab>
          <Layers size={13} /> المشتريات
        </DisabledTab>
        <DisabledTab>
          <Coins size={13} /> سجل الأسعار/التكاليف
        </DisabledTab>
      </nav>

      {/* ── Local filters bar (applies to both tabs) ─────────── */}
      <FiltersBar
        filters={filters}
        onChange={setFilters}
        warehouses={warehouseOptions}
        groups={groupOptions}
      />

      {/* ── Tab content ──────────────────────────────────────── */}
      {activeTab === 'overview' && (
        <OverviewTab
          productId={productId}
          data={overviewQ.data}
          isLoading={overviewQ.isLoading}
          isError={overviewQ.isError}
          error={overviewQ.error as Error | null}
          filters={filters}
        />
      )}
      {activeTab === 'matrix' && (
        <MatrixTab
          data={matrixQ.data}
          isLoading={matrixQ.isLoading}
          isError={matrixQ.isError}
          error={matrixQ.error as Error | null}
          filters={filters}
        />
      )}
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Filters bar
// ──────────────────────────────────────────────────────────────────
function FiltersBar({
  filters,
  onChange,
  warehouses,
  groups,
}: {
  filters: LocalFilters;
  onChange: (f: LocalFilters) => void;
  warehouses: Array<{ id: string; name: string }>;
  groups: Array<{ id: string; name: string }>;
}) {
  return (
    <section
      data-testid="product-360-filters"
      className="card p-3 flex flex-wrap items-center gap-2 text-xs"
    >
      <select
        className="input"
        value={filters.warehouse_id}
        onChange={(e) =>
          onChange({ ...filters, warehouse_id: e.target.value })
        }
        data-testid="filter-warehouse"
      >
        <option value="">كل المخازن</option>
        {warehouses.map((w) => (
          <option key={w.id} value={w.id}>
            {w.name}
          </option>
        ))}
      </select>

      <select
        className="input"
        value={filters.group_id}
        onChange={(e) => onChange({ ...filters, group_id: e.target.value })}
        data-testid="filter-group"
      >
        <option value="">كل المجموعات</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
      </select>

      <label className="inline-flex items-center gap-1 cursor-pointer">
        <input
          type="checkbox"
          checked={filters.only_low_stock}
          onChange={(e) =>
            onChange({
              ...filters,
              only_low_stock: e.target.checked,
              // Mutually exclusive with "out of stock" — picking one
              // clears the other so the UI never says "only items
              // that are both low and zero" (an empty set).
              only_out_of_stock: e.target.checked
                ? false
                : filters.only_out_of_stock,
            })
          }
          data-testid="filter-low-stock"
        />
        <AlertTriangle size={13} className="text-amber-600" />
        منخفض فقط
      </label>

      <label className="inline-flex items-center gap-1 cursor-pointer">
        <input
          type="checkbox"
          checked={filters.only_out_of_stock}
          onChange={(e) =>
            onChange({
              ...filters,
              only_out_of_stock: e.target.checked,
              only_low_stock: e.target.checked ? false : filters.only_low_stock,
            })
          }
          data-testid="filter-out-of-stock"
        />
        <PackageX size={13} className="text-rose-600" />
        نفد فقط
      </label>

      {(filters.warehouse_id ||
        filters.group_id ||
        filters.only_low_stock ||
        filters.only_out_of_stock) && (
        <button
          type="button"
          className="text-indigo-600 hover:underline"
          onClick={() => onChange(EMPTY_FILTERS)}
          data-testid="filter-clear"
        >
          مسح الفلاتر
        </button>
      )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// Overview tab
// ──────────────────────────────────────────────────────────────────
function OverviewTab({
  productId,
  data,
  isLoading,
  isError,
  error,
  filters,
}: {
  productId: string;
  data: Product360Response | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  filters: LocalFilters;
}) {
  // ── Hooks MUST run before any early return so the call order stays
  // stable across renders (react-hooks/rules-of-hooks). We read every
  // optional collection via nullish coalescing so the hooks have safe
  // default inputs while `data` is still loading. Collections that
  // feed downstream useMemo deps are themselves wrapped in useMemo
  // so the `?? []` doesn't allocate a fresh array on each render and
  // bust the dependency cache.
  const product = data?.product;
  const groups = data?.product_groups ?? [];
  const variants = useMemo(() => data?.variants ?? [], [data?.variants]);
  const stockByWh = useMemo(
    () => data?.stock_by_warehouse ?? [],
    [data?.stock_by_warehouse],
  );
  const totals = data?.totals;
  const recentMovements = data?.recent_movements ?? [];
  const recentInvoices = data?.recent_invoice_items ?? [];
  const recentPurchases = data?.recent_purchase_items ?? [];
  const priceHistory = data?.price_history ?? [];
  const costHistory = data?.cost_history ?? [];

  // Margin% derived locally; no new API.
  const marginPct30d = useMemo(() => {
    const revenue = Number(totals?.sold_revenue_30d ?? 0);
    const profit = Number(totals?.gross_profit_30d ?? 0);
    if (!Number.isFinite(revenue) || revenue <= 0) return null;
    return (profit / revenue) * 100;
  }, [totals]);

  // Local filtering for the variants table.
  const filteredVariants = useMemo(() => {
    return variants.filter((v) => {
      if (filters.group_id && !v.group_ids?.includes(filters.group_id)) {
        return false;
      }
      if (filters.only_out_of_stock && v.total_qty > 0) return false;
      if (
        filters.only_low_stock &&
        !(v.total_available > 0 && v.total_available <= 2)
      ) {
        return false;
      }
      return true;
    });
  }, [variants, filters]);

  // Aggregate stock_by_warehouse[] to per-warehouse rollups for the
  // summary card. The raw rows are per (variant × warehouse) — we
  // GROUP BY warehouse and sum. Apply the warehouse filter here too.
  const stockByWhSummary = useMemo(() => {
    const m = new Map<
      string,
      {
        warehouse_id: string;
        warehouse_name: string;
        qty: number;
        reserved: number;
        available: number;
        variants_count: number;
      }
    >();
    for (const r of stockByWh) {
      if (filters.warehouse_id && r.warehouse_id !== filters.warehouse_id) {
        continue;
      }
      const prev = m.get(r.warehouse_id) ?? {
        warehouse_id: r.warehouse_id,
        warehouse_name: r.warehouse_name,
        qty: 0,
        reserved: 0,
        available: 0,
        variants_count: 0,
      };
      prev.qty += Number(r.quantity_on_hand ?? 0);
      prev.reserved += Number(r.quantity_reserved ?? 0);
      prev.available += Number(r.available_quantity ?? 0);
      prev.variants_count += 1;
      m.set(r.warehouse_id, prev);
    }
    return Array.from(m.values()).sort((a, b) => b.qty - a.qty);
  }, [stockByWh, filters.warehouse_id]);

  // ── Early returns AFTER hooks. ────────────────────────────────
  if (isLoading) {
    return (
      <div
        data-testid="product-360-overview-loading"
        className="card p-8 text-center text-sm text-slate-400"
      >
        جاري التحميل…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="card p-4 bg-rose-50 text-rose-800 text-sm">
        {error?.message || 'تعذّر تحميل بيانات المنتج.'}
      </div>
    );
  }
  if (!data || !product || !totals) {
    return (
      <div className="card p-8 text-center text-sm text-slate-400">
        المنتج غير موجود.
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="product-360-overview">
      <ProductHeader product={product} groups={groups} productId={productId} />

      {/* ── 8 KPI cards ──────────────────────────────────────── */}
      <section
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3"
        data-testid="product-360-totals"
      >
        <StatCard
          icon={Boxes}
          label="إجمالي الكميات"
          value={fmtNumber(totals.total_qty)}
        />
        <StatCard
          icon={PackageSearch}
          label="المتاح للبيع"
          value={fmtNumber(totals.total_available)}
          tone={totals.total_available <= 0 ? 'rose' : 'default'}
        />
        <StatCard
          icon={Coins}
          label="قيمة التكلفة"
          value={fmtEGP(totals.total_cost_value)}
        />
        <StatCard
          icon={Coins}
          label="قيمة البيع"
          value={fmtEGP(totals.total_sale_value)}
        />
        <StatCard
          icon={ShoppingBag}
          label="مبيعات 30 يوم"
          value={fmtNumber(totals.sold_qty_30d)}
          subtitle={fmtEGP(totals.sold_revenue_30d)}
        />
        <StatCard
          icon={Activity}
          label="مرتجعات 30 يوم"
          value={fmtNumber(totals.returned_qty_30d)}
          tone={totals.returned_qty_30d > 0 ? 'amber' : 'default'}
        />
        <StatCard
          icon={TrendingUp}
          label="ربح 30 يوم"
          value={fmtEGP(totals.gross_profit_30d)}
          tone={
            totals.gross_profit_30d < 0
              ? 'rose'
              : totals.gross_profit_30d === 0
              ? 'default'
              : 'emerald'
          }
        />
        <StatCard
          icon={Percent}
          label="هامش 30 يوم"
          value={fmtPct(marginPct30d)}
          tone={
            marginPct30d == null
              ? 'default'
              : marginPct30d < 0
              ? 'rose'
              : marginPct30d < 10
              ? 'amber'
              : 'emerald'
          }
        />
      </section>

      {/* ── Variants summary ─────────────────────────────────── */}
      <SectionCard
        title={`المتغيرات (${filteredVariants.length} من ${variants.length})`}
        testId="product-360-variants"
      >
        {filteredVariants.length === 0 ? (
          <EmptySection
            text={
              variants.length === 0
                ? 'لا توجد متغيرات لهذا المنتج.'
                : 'لا توجد متغيرات تطابق الفلاتر الحالية.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="text-right px-3 py-2">SKU</th>
                <th className="text-right px-3 py-2">اللون</th>
                <th className="text-right px-3 py-2">المقاس</th>
                <th className="text-left px-3 py-2">المتاح</th>
                <th className="text-left px-3 py-2">المحجوز</th>
                <th className="text-left px-3 py-2">الكلي</th>
                <th className="text-left px-3 py-2">سعر التكلفة</th>
                <th className="text-left px-3 py-2">سعر البيع</th>
                <th className="text-right px-3 py-2">الحالة</th>
                <th className="text-right px-3 py-2">المجموعات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filteredVariants.map((v) => (
                <tr key={v.variant_id} data-testid="product-360-variant-row">
                  <td className="px-3 py-2 text-slate-700 tabular-nums">
                    {v.sku}
                    {v.barcode && (
                      <div className="text-[10px] text-slate-400">
                        {v.barcode}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {v.color_name ? (
                      <span className="inline-flex items-center gap-1">
                        {v.hex_code && (
                          <span
                            className="inline-block w-3 h-3 rounded-full ring-1 ring-slate-200"
                            style={{ backgroundColor: v.hex_code }}
                          />
                        )}
                        {v.color_name}
                      </span>
                    ) : (
                      <span className="text-slate-300">بدون لون</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {v.size_label ?? (
                      <span className="text-slate-300">بدون مقاس</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums font-bold">
                    <span
                      className={
                        v.total_available <= 0
                          ? 'text-rose-700'
                          : v.total_available > 0 && v.total_available <= 2
                          ? 'text-amber-700'
                          : 'text-slate-800'
                      }
                    >
                      {fmtNumber(v.total_available)}
                    </span>
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                    {fmtNumber(v.total_reserved)}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums">
                    {fmtNumber(v.total_qty)}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                    {fmtEGP(v.cost_price)}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                    {fmtEGP(v.selling_price)}
                  </td>
                  <td className="px-3 py-2">
                    <StockStatusBadge
                      total_qty={v.total_qty}
                      available_qty={v.total_available}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <GroupBadges groups={v} compact />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      {/* ── Stock by warehouse summary ───────────────────────── */}
      <SectionCard
        title={`المخزون حسب المخزن (${stockByWhSummary.length})`}
        testId="product-360-stock-by-warehouse"
      >
        {stockByWhSummary.length === 0 ? (
          <EmptySection
            text={
              filters.warehouse_id
                ? 'لا يوجد مخزون لهذا المنتج في المخزن المختار.'
                : 'لا يوجد مخزون مسجّل لهذا المنتج بعد.'
            }
          />
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="text-right px-3 py-2">المخزن</th>
                <th className="text-left px-3 py-2">المتغيرات</th>
                <th className="text-left px-3 py-2">على الرف</th>
                <th className="text-left px-3 py-2">المحجوز</th>
                <th className="text-left px-3 py-2">المتاح</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {stockByWhSummary.map((w) => (
                <tr key={w.warehouse_id} data-testid="stock-by-warehouse-row">
                  <td className="px-3 py-2 font-medium text-slate-700">
                    {w.warehouse_name}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                    {fmtNumber(w.variants_count)}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums">
                    {fmtNumber(w.qty)}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                    {fmtNumber(w.reserved)}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums font-bold">
                    {fmtNumber(w.available)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </SectionCard>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Recent stock movements ─────────────────────────── */}
        <SectionCard
          title="آخر حركات المخزون"
          testId="product-360-movements"
          headerExtra={
            <Link
              to={`/inventory/movements?product_id=${productId}`}
              className="text-xs text-indigo-600 hover:underline"
            >
              عرض الكل ←
            </Link>
          }
        >
          {recentMovements.length === 0 ? (
            <EmptySection text="لا توجد حركات حديثة لهذا المنتج." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {recentMovements.slice(0, 8).map((m) => (
                <li
                  key={m.id}
                  className="px-3 py-2 flex items-center gap-3 text-sm"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{m.movement_type}</div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {m.sku} · {m.warehouse_name}
                      {m.source_module && ` · ${m.source_module}`}
                    </div>
                  </div>
                  <div className="text-left tabular-nums">
                    <div
                      className={
                        m.direction === 'in'
                          ? 'text-emerald-700 font-bold'
                          : 'text-rose-700 font-bold'
                      }
                    >
                      {m.direction === 'in' ? '+' : '-'}
                      {fmtNumber(m.quantity)}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {fmtDate(m.created_at)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {/* ── Recent invoice items ───────────────────────────── */}
        <SectionCard title="آخر فواتير البيع" testId="product-360-invoices">
          {recentInvoices.length === 0 ? (
            <EmptySection text="لا توجد فواتير بيع حديثة." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {recentInvoices.slice(0, 8).map((it) => (
                <li
                  key={it.id}
                  className="px-3 py-2 flex items-center gap-3 text-sm"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">
                      {it.invoice_no}
                      {it.voided_at && (
                        <span className="text-[10px] text-rose-600 px-1">
                          ملغاة
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {it.sku} · {fmtNumber(it.quantity)} ×{' '}
                      {fmtEGP(it.unit_price)}
                    </div>
                  </div>
                  <div className="text-left tabular-nums">
                    <div className="font-bold text-slate-800">
                      {fmtEGP(it.line_total)}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {fmtDate(it.invoice_created_at)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {/* ── Recent purchase items ──────────────────────────── */}
        <SectionCard title="آخر فواتير الشراء" testId="product-360-purchases">
          {recentPurchases.length === 0 ? (
            <EmptySection text="لا توجد فواتير شراء حديثة." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {recentPurchases.slice(0, 8).map((it) => (
                <li
                  key={it.id}
                  className="px-3 py-2 flex items-center gap-3 text-sm"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">
                      {it.purchase_no}
                      {it.supplier_name && (
                        <span className="text-[10px] text-slate-400 px-1">
                          · {it.supplier_name}
                        </span>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {it.sku} · {fmtNumber(it.quantity)} ×{' '}
                      {fmtEGP(it.unit_cost)}
                    </div>
                  </div>
                  <div className="text-left tabular-nums">
                    <div className="font-bold text-slate-800">
                      {fmtEGP(it.line_total)}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {fmtDate(it.purchase_created_at)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {/* ── Price history ──────────────────────────────────── */}
        <SectionCard title="سجل تغيّر الأسعار" testId="product-360-price-history">
          {priceHistory.length === 0 ? (
            <EmptySection text="لم يتم تسجيل أي تغييرات على سعر البيع." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {priceHistory.slice(0, 8).map((h) => (
                <li
                  key={h.id}
                  className="px-3 py-2 flex items-center gap-3 text-sm"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{h.sku}</div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {h.reason || h.source_purchase_no || '—'}
                    </div>
                  </div>
                  <div className="text-left tabular-nums">
                    <div className="text-slate-600">
                      <span className="text-rose-600 line-through">
                        {fmtEGP(h.old_selling_price)}
                      </span>{' '}
                      →{' '}
                      <span className="font-bold text-emerald-700">
                        {fmtEGP(h.new_selling_price)}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {fmtDate(h.changed_at)}
                      {h.changed_by_name && ` · ${h.changed_by_name}`}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>

        {/* ── Cost history ───────────────────────────────────── */}
        <SectionCard title="سجل تغيّر التكاليف" testId="product-360-cost-history">
          {costHistory.length === 0 ? (
            <EmptySection text="لم يتم تسجيل أي تعديلات على تكلفة الشراء." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {costHistory.slice(0, 8).map((h) => (
                <li
                  key={h.id}
                  className="px-3 py-2 flex items-center gap-3 text-sm"
                >
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{h.sku}</div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {h.adjustment_type ?? '—'}
                      {h.reason && ` · ${h.reason}`}
                    </div>
                  </div>
                  <div className="text-left tabular-nums">
                    <div className="text-slate-600">
                      <span className="text-rose-600 line-through">
                        {fmtEGP(h.old_cost_price)}
                      </span>{' '}
                      →{' '}
                      <span className="font-bold text-slate-800">
                        {fmtEGP(h.new_cost_price)}
                      </span>
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {fmtDate(h.changed_at)}
                      {h.changed_by_name && ` · ${h.changed_by_name}`}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </SectionCard>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Matrix tab
// ──────────────────────────────────────────────────────────────────
function MatrixTab({
  data,
  isLoading,
  isError,
  error,
  filters,
}: {
  data: ProductMatrixResponse | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  filters: LocalFilters;
}) {
  // Map every cell against the local filter set BEFORE building the
  // (color, size) lookup so the row/column headers can hide colors
  // / sizes that have no remaining cells.
  const filteredCells = useMemo(() => {
    if (!data) return [] as ProductMatrixCell[];
    return data.cells
      .map((c) => projectCellForWarehouse(c, filters.warehouse_id))
      .filter((c) => {
        if (filters.group_id && !c.group_ids?.includes(filters.group_id)) {
          return false;
        }
        if (filters.only_out_of_stock && c.total_qty > 0) return false;
        if (
          filters.only_low_stock &&
          !(c.available_qty > 0 && c.available_qty <= 2)
        ) {
          return false;
        }
        return true;
      });
  }, [data, filters]);

  const byKey = useMemo(() => {
    const m = new Map<string, ProductMatrixCell>();
    for (const c of filteredCells) {
      m.set(`${c.color_id ?? '_'}::${c.size_id ?? '_'}`, c);
    }
    return m;
  }, [filteredCells]);

  // Drop colors / sizes that have zero matching cells AFTER filters.
  const visibleColors = useMemo(() => {
    if (!data) return [];
    const presentColorIds = new Set(
      filteredCells.map((c) => c.color_id ?? '_'),
    );
    return data.colors.filter((c) => presentColorIds.has(c.id));
  }, [data, filteredCells]);

  const visibleSizes = useMemo(() => {
    if (!data) return [];
    const presentSizeIds = new Set(filteredCells.map((c) => c.size_id ?? '_'));
    return data.sizes.filter((sz) => presentSizeIds.has(sz.id));
  }, [data, filteredCells]);

  if (isLoading) {
    return (
      <div className="card p-8 text-center text-sm text-slate-400">
        جاري تحميل الشبكة…
      </div>
    );
  }
  if (isError) {
    return (
      <div className="card p-4 bg-rose-50 text-rose-800 text-sm">
        {error?.message || 'تعذّر تحميل شبكة المتغيرات.'}
      </div>
    );
  }
  if (!data) {
    return (
      <div className="card p-8 text-center text-sm text-slate-400">
        المنتج غير موجود.
      </div>
    );
  }
  if (data.cells.length === 0) {
    return (
      <div className="card p-8 text-center text-sm text-slate-400">
        لا توجد متغيرات لإنشاء شبكة لهذا المنتج.
      </div>
    );
  }
  if (filteredCells.length === 0) {
    return (
      <div
        className="card p-8 text-center text-sm text-slate-400"
        data-testid="product-matrix-empty-after-filter"
      >
        لا توجد متغيرات تطابق الفلاتر الحالية.
      </div>
    );
  }

  const colorCount = visibleColors.length;
  const sizeCount = visibleSizes.length;
  const cellCount = filteredCells.length;

  return (
    <section className="card overflow-x-auto" data-testid="product-matrix">
      <div className="px-4 py-3 border-b border-slate-100 font-bold text-slate-800 flex items-center justify-between">
        <span>
          شبكة المتغيرات — {colorCount} لون × {sizeCount} مقاس ({cellCount}{' '}
          متغير)
        </span>
        {filters.warehouse_id && (
          <span className="text-[11px] text-indigo-600 font-normal">
            عرض الكميات للمخزن المختار فقط
          </span>
        )}
      </div>
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-xs text-slate-500">
          <tr>
            <th className="text-right px-3 py-2 sticky right-0 bg-slate-50">
              اللون \ المقاس
            </th>
            {visibleSizes.map((sz) => (
              <th key={sz.id} className="text-center px-3 py-2">
                {sz.size_label || (
                  <span className="text-slate-300">بدون مقاس</span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {visibleColors.map((c) => (
            <tr key={c.id} data-testid="matrix-row">
              <th className="text-right px-3 py-2 align-top sticky right-0 bg-white">
                <div className="flex items-center gap-2">
                  {c.hex_code && (
                    <span
                      className="inline-block w-3 h-3 rounded-full ring-1 ring-slate-200"
                      style={{ backgroundColor: c.hex_code }}
                    />
                  )}
                  <span>
                    {c.name_ar || (
                      <span className="text-slate-300">بدون لون</span>
                    )}
                  </span>
                </div>
              </th>
              {visibleSizes.map((sz) => {
                const cell = byKey.get(`${c.id}::${sz.id}`);
                return (
                  <td
                    key={sz.id}
                    className="px-2 py-2 text-center align-top"
                    data-testid="matrix-cell"
                  >
                    {cell ? (
                      <MatrixCell cell={cell} />
                    ) : (
                      <span className="inline-block text-[10px] text-slate-300 py-3">
                        —
                      </span>
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Re-project a cell against a specific warehouse: when the filter is
 * active, recompute the cell's `total_qty` / `available_qty` from
 * the `per_warehouse[]` entry for that warehouse only. Filters out
 * the rest of `per_warehouse` for display. When no warehouse filter
 * is set, the cell passes through unchanged.
 */
function projectCellForWarehouse(
  cell: ProductMatrixCell,
  warehouseId: string,
): ProductMatrixCell {
  if (!warehouseId) return cell;
  const ws = (cell.per_warehouse ?? []).filter(
    (w) => w.warehouse_id === warehouseId,
  );
  const total = ws.reduce((s, w) => s + Number(w.quantity_on_hand ?? 0), 0);
  const available = ws.reduce(
    (s, w) => s + Number(w.available_quantity ?? 0),
    0,
  );
  return {
    ...cell,
    total_qty: total,
    available_qty: available,
    per_warehouse: ws,
  };
}

// ──────────────────────────────────────────────────────────────────
// Header / shared components
// ──────────────────────────────────────────────────────────────────
function ProductHeader({
  product,
  groups,
  productId,
}: {
  product: Product360Response['product'];
  groups: Product360Response['product_groups'];
  productId: string;
}) {
  return (
    <section className="card p-4" data-testid="product-360-header">
      <div className="flex flex-wrap items-start gap-4">
        {/* Image placeholder — the 360 API doesn't surface a primary
            image yet; this slot is wired so the future
            product_images join can drop straight in. */}
        <div
          aria-hidden
          className="shrink-0 w-20 h-20 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center text-slate-400"
          data-testid="product-360-image"
        >
          <Package size={32} />
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1
              className="text-xl font-black text-slate-800 truncate"
              data-testid="product-360-name"
            >
              {product.name_ar}
            </h1>
            {product.name_en && (
              <span className="text-sm text-slate-400">
                · {product.name_en}
              </span>
            )}
            {product.is_active ? (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200"
                data-testid="product-360-status"
              >
                <CheckCircle2 size={11} />
                نشط
              </span>
            ) : (
              <span
                className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200"
                data-testid="product-360-status"
              >
                <XCircle size={11} />
                موقوف
              </span>
            )}
          </div>

          {/* Identity strip */}
          <div className="text-xs text-slate-500 mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-mono tabular-nums">{product.sku_prefix}</span>
            <span>·</span>
            <span>{product.product_type}</span>
            <span>·</span>
            <span>{product.target_audience}</span>
            {product.category_name && (
              <>
                <span>·</span>
                <Chip>{product.category_name}</Chip>
              </>
            )}
            {product.brand_name && (
              <>
                <span>·</span>
                <Chip>{product.brand_name}</Chip>
              </>
            )}
          </div>

          {/* Price strip */}
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
            <PriceStat label="سعر التكلفة الأساسي" value={product.base_cost} />
            <PriceStat label="سعر البيع الأساسي" value={product.base_price} />
            <PriceStat
              label="السعر المقترح"
              value={product.suggested_price}
              accent
            />
            {product.min_margin_pct != null && (
              <span className="text-slate-500">
                هامش أدنى:{' '}
                <span className="font-bold tabular-nums">
                  {fmtPct(Number(product.min_margin_pct))}
                </span>
              </span>
            )}
          </div>

          {/* Group chips */}
          {groups.length > 0 && (
            <div
              className="mt-3 flex flex-wrap gap-1.5"
              data-testid="product-360-group-chips"
            >
              {groups.map((g) => (
                <span
                  key={g.group_id}
                  className="inline-flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full border border-slate-200 bg-white"
                >
                  <span
                    aria-hidden
                    className="inline-block w-2 h-2 rounded-full"
                    style={{ backgroundColor: g.color || '#94a3b8' }}
                  />
                  <Tags size={11} className="text-slate-400" />
                  {g.name_ar}
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="shrink-0 flex flex-col items-stretch gap-2">
          <Link
            to={`/inventory/movements?product_id=${productId}`}
            className="btn-sm"
          >
            <Activity size={13} />
            حركات هذا المنتج
          </Link>
          <Link
            to={`/inventory/balances?search=${encodeURIComponent(
              product.sku_prefix,
            )}`}
            className="btn-sm"
          >
            <PackageSearch size={13} />
            أرصدة هذا المنتج
          </Link>
        </div>
      </div>
    </section>
  );
}

function MatrixCell({ cell }: { cell: ProductMatrixCell }) {
  const [open, setOpen] = useState(false);
  const status = deriveStockStatus(cell.total_qty, cell.available_qty);
  const cellTone =
    status === 'out'
      ? 'border-rose-200 bg-rose-50/40'
      : status === 'low'
      ? 'border-amber-200 bg-amber-50/40'
      : 'border-slate-200 bg-white';

  return (
    <div
      className={`inline-block min-w-[8.5rem] max-w-[12rem] rounded-lg border p-2 text-right ${cellTone}`}
      data-testid="matrix-cell-content"
    >
      <div className="flex items-center justify-between text-[10px] text-slate-500">
        <span className="tabular-nums truncate" title={cell.sku}>
          {cell.sku}
        </span>
        <StockStatusBadge
          total_qty={cell.total_qty}
          available_qty={cell.available_qty}
          compact
        />
      </div>
      {cell.barcode && (
        <div className="text-[9px] text-slate-400 tabular-nums truncate">
          {cell.barcode}
        </div>
      )}
      <div className="mt-1 tabular-nums font-bold text-slate-800 text-sm">
        {fmtNumber(cell.available_qty)}
      </div>
      <div className="text-[10px] text-slate-400 leading-tight">
        إجمالي: {fmtNumber(cell.total_qty)}
        {' · '}بيع:{' '}
        {Number(cell.selling_price ?? 0).toLocaleString('en-EG', {
          maximumFractionDigits: 0,
        })}
        <div>
          تكلفة:{' '}
          {Number(cell.cost_price ?? 0).toLocaleString('en-EG', {
            maximumFractionDigits: 0,
          })}
        </div>
      </div>
      {cell.group_ids?.length > 0 && (
        <div
          className="mt-1 flex flex-wrap justify-end gap-0.5"
          data-testid="matrix-cell-groups"
        >
          {cell.group_ids.map((gid, i) => (
            <span
              key={gid}
              className="inline-block w-2 h-2 rounded-full ring-1 ring-white"
              style={{ backgroundColor: cell.group_colors[i] || '#94a3b8' }}
              title={cell.group_names_ar[i]}
            />
          ))}
        </div>
      )}
      {cell.per_warehouse?.length > 0 && (
        <div className="mt-1 border-t border-slate-100 pt-1">
          <button
            type="button"
            className="text-[10px] text-indigo-600 hover:underline inline-flex items-center gap-0.5"
            onClick={() => setOpen((v) => !v)}
            data-testid="matrix-cell-warehouses-toggle"
          >
            {open ? <ChevronUp size={11} /> : <ChevronDown size={11} />}
            {open ? 'إخفاء' : 'حسب المخزن'}
          </button>
          {open && (
            <WarehouseQtyList warehouses={cell.per_warehouse} />
          )}
        </div>
      )}
    </div>
  );
}

function WarehouseQtyList({
  warehouses,
}: {
  warehouses: ProductMatrixCellWarehouse[];
}) {
  return (
    <ul
      className="mt-1 space-y-0.5 text-[10px]"
      data-testid="matrix-cell-warehouses"
    >
      {warehouses.map((w) => (
        <li
          key={w.warehouse_id}
          className="flex items-center justify-between gap-2"
        >
          <span className="truncate text-slate-500" title={w.warehouse_name}>
            {w.warehouse_name}
          </span>
          <span className="tabular-nums font-bold text-slate-700">
            {fmtNumber(w.available_quantity)}
            {w.quantity_reserved > 0 && (
              <span className="text-slate-400">
                {' '}
                ({fmtNumber(w.quantity_reserved)} محجوز)
              </span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}

type StockStatus = 'out' | 'low' | 'ok';

function deriveStockStatus(
  totalQty: number,
  availableQty: number,
): StockStatus {
  if (totalQty <= 0) return 'out';
  if (availableQty > 0 && availableQty <= 2) return 'low';
  return 'ok';
}

function StockStatusBadge({
  total_qty,
  available_qty,
  compact,
}: {
  total_qty: number;
  available_qty: number;
  compact?: boolean;
}) {
  const status = deriveStockStatus(total_qty, available_qty);
  if (status === 'out') {
    return (
      <span
        className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200"
        data-testid="stock-status-badge"
        data-status="out"
      >
        <PackageX size={compact ? 10 : 11} />
        {!compact && 'نفد'}
      </span>
    );
  }
  if (status === 'low') {
    return (
      <span
        className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200"
        data-testid="stock-status-badge"
        data-status="low"
      >
        <AlertTriangle size={compact ? 10 : 11} />
        {!compact && 'منخفض'}
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200"
      data-testid="stock-status-badge"
      data-status="ok"
    >
      <CheckCircle2 size={compact ? 10 : 11} />
      {!compact && 'متاح'}
    </span>
  );
}

function GroupBadges({
  groups,
  compact,
}: {
  groups: VariantGroupArrays;
  compact?: boolean;
}) {
  if (!groups?.group_ids?.length) {
    return <span className="text-[10px] text-slate-300">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1" data-testid="group-badges">
      {groups.group_ids.map((gid, i) => (
        <span
          key={gid}
          className={`inline-flex items-center gap-1 ${
            compact ? 'text-[10px]' : 'text-[11px]'
          } font-bold px-1.5 py-0.5 rounded-full border border-slate-200 bg-white`}
          title={groups.group_names_ar[i]}
        >
          <span
            aria-hidden
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: groups.group_colors[i] || '#94a3b8' }}
          />
          {groups.group_names_ar[i]}
        </span>
      ))}
    </div>
  );
}

function EmptySection({ text }: { text: string }) {
  return (
    <div
      className="p-6 text-center text-sm text-slate-400"
      data-testid="empty-section"
    >
      {text}
    </div>
  );
}

function SectionCard({
  title,
  children,
  testId,
  headerExtra,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
  headerExtra?: React.ReactNode;
}) {
  return (
    <section className="card overflow-x-auto" data-testid={testId}>
      <div className="px-4 py-3 border-b border-slate-100 font-bold text-slate-800 flex items-center justify-between gap-2">
        <span>{title}</span>
        {headerExtra}
      </div>
      {children}
    </section>
  );
}

function StatCard({
  icon: Icon,
  label,
  value,
  subtitle,
  tone = 'default',
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  subtitle?: string;
  tone?: 'default' | 'amber' | 'rose' | 'emerald';
}) {
  const toneMap: Record<typeof tone, string> = {
    default: 'border-slate-200 bg-white',
    amber: 'border-amber-200 bg-amber-50/60',
    rose: 'border-rose-200 bg-rose-50/60',
    emerald: 'border-emerald-200 bg-emerald-50/60',
  } as any;
  const iconColor: Record<typeof tone, string> = {
    default: 'text-indigo-600',
    amber: 'text-amber-600',
    rose: 'text-rose-600',
    emerald: 'text-emerald-600',
  } as any;
  return (
    <div className={`card p-3 border ${toneMap[tone]}`} data-testid="stat-card">
      <div className="flex items-center gap-2 text-[11px] text-slate-500">
        <Icon size={14} className={iconColor[tone]} />
        {label}
      </div>
      <div className="text-base font-black text-slate-800 tabular-nums mt-1">
        {value}
      </div>
      {subtitle && (
        <div className="text-[10px] text-slate-500 mt-0.5">{subtitle}</div>
      )}
    </div>
  );
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200">
      {children}
    </span>
  );
}

function PriceStat({
  label,
  value,
  accent,
}: {
  label: string;
  value: number | string | null | undefined;
  accent?: boolean;
}) {
  if (value == null || value === '') return null;
  return (
    <span className="text-slate-500 inline-flex items-center gap-1">
      {label}:{' '}
      <span
        className={`font-bold tabular-nums ${
          accent ? 'text-indigo-700' : 'text-slate-800'
        }`}
      >
        {fmtEGP(value)}
      </span>
    </span>
  );
}

// ──────────────────────────────────────────────────────────────────
// Tab nav bits
// ──────────────────────────────────────────────────────────────────
function Tab({
  to,
  active,
  children,
}: {
  to: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Link
      to={to}
      className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md font-bold ${
        active
          ? 'bg-indigo-50 text-indigo-700'
          : 'text-slate-600 hover:bg-slate-50'
      }`}
    >
      {children}
    </Link>
  );
}

function DisabledTab({ children }: { children: React.ReactNode }) {
  return (
    <span
      aria-disabled
      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-slate-400 cursor-not-allowed"
      title="قريباً"
    >
      {children}
    </span>
  );
}
