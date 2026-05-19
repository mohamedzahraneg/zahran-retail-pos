/**
 * InventoryBalances.tsx — PR-FIX-INVENTORY-UX-BALANCES-MOVEMENTS
 *
 * Daily-use stock balances grid. Strictly read-only:
 *   · no mutations
 *   · no edit/save/apply/delete affordances
 *   · all action links navigate (Product 360 / Movements ledger).
 *
 * The server side already does the heavy lifting (filters, paging,
 * group EXISTS sub-query) — this page focuses on giving operators
 * the right summary, the right filters, and quick navigation into
 * the underlying detail pages.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search,
  AlertTriangle,
  PackageX,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Tags,
  Boxes,
  Wallet,
  Coins,
  Layers,
  Filter,
  X,
  Image as ImageIcon,
  History,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react';
import {
  inventoryApi,
  type InventoryBalanceRow,
  type InventoryBalancesFilters,
} from '@/api/inventory.api';
import { settingsApi } from '@/api/settings.api';
import { productGroupsApi } from '@/api/productGroups.api';
import { categoriesApi } from '@/api/categories.api';
import { productsApi } from '@/api/products.api';
import { branchesApi } from '@/api/branches.api';

function fmtNumber(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toLocaleString('en-EG') : '0';
}

function fmtEGP(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return `${v.toLocaleString('en-EG', { maximumFractionDigits: 2 })} ج.م`;
}

function fmtRelativeTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleDateString('ar-EG', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return '—';
  }
}

function useDebouncedValue<T>(value: T, delayMs = 300): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(t);
  }, [value, delayMs]);
  return debounced;
}

interface PageTotals {
  rows: number;
  variants: number;
  total_qty: number;
  total_available: number;
  total_cost_value: number;
  total_sale_value: number;
  low_rows: number;
  out_rows: number;
}

function computePageTotals(items: InventoryBalanceRow[]): PageTotals {
  const variantSet = new Set<string>();
  let total_qty = 0;
  let total_available = 0;
  let total_cost_value = 0;
  let total_sale_value = 0;
  let low_rows = 0;
  let out_rows = 0;
  for (const r of items) {
    variantSet.add(r.variant_id);
    total_qty += Number(r.quantity_on_hand) || 0;
    total_available += Number(r.available_quantity) || 0;
    total_cost_value += Number(r.stock_cost_value) || 0;
    total_sale_value += Number(r.stock_sale_value) || 0;
    if (Number(r.quantity_on_hand) <= 0) {
      out_rows += 1;
    } else if (
      Number(r.reorder_point) > 0 &&
      Number(r.quantity_on_hand) <= Number(r.reorder_point)
    ) {
      low_rows += 1;
    }
  }
  return {
    rows: items.length,
    variants: variantSet.size,
    total_qty,
    total_available,
    total_cost_value,
    total_sale_value,
    low_rows,
    out_rows,
  };
}

export default function InventoryBalances() {
  const [searchParams] = useSearchParams();
  const initialLowStock = searchParams.get('low_stock') === 'true';
  const initialOutOfStock = searchParams.get('out_of_stock') === 'true';
  const initialWarehouse = searchParams.get('warehouse_id') ?? '';
  const initialGroup = searchParams.get('group_id') ?? '';
  const initialCategory = searchParams.get('category_id') ?? '';
  const initialBranch = searchParams.get('branch_id') ?? '';

  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);

  const [warehouseId, setWarehouseId] = useState(initialWarehouse);
  const [branchId, setBranchId] = useState(initialBranch);
  const [categoryId, setCategoryId] = useState(initialCategory);
  const [groupId, setGroupId] = useState(initialGroup);
  const [colorId, setColorId] = useState('');
  const [sizeId, setSizeId] = useState('');
  const [lowStock, setLowStock] = useState(initialLowStock);
  const [outOfStock, setOutOfStock] = useState(initialOutOfStock);
  const limit = 50;

  const resetPage = () => setPage(1);

  useEffect(() => {
    resetPage();
  }, [
    search,
    warehouseId,
    branchId,
    categoryId,
    groupId,
    colorId,
    sizeId,
    lowStock,
    outOfStock,
  ]);

  const { data: warehouseList = [] } = useQuery({
    queryKey: ['inventory-balances-warehouses'],
    queryFn: () => settingsApi.listWarehouses() as any,
    staleTime: 5 * 60_000,
  });

  const { data: branchList = [] } = useQuery({
    queryKey: ['inventory-balances-branches'],
    queryFn: () => branchesApi.list(),
    staleTime: 5 * 60_000,
  });

  const { data: groupList = [] } = useQuery({
    queryKey: ['inventory-balances-groups'],
    queryFn: () => productGroupsApi.list({ is_active: true }),
    staleTime: 5 * 60_000,
  });

  const { data: categoryList = [] } = useQuery({
    queryKey: ['inventory-balances-categories'],
    queryFn: () => categoriesApi.list(),
    staleTime: 5 * 60_000,
  });

  const { data: colorList = [] } = useQuery({
    queryKey: ['inventory-balances-colors'],
    queryFn: () => productsApi.colors(),
    staleTime: 5 * 60_000,
  });

  const { data: sizeList = [] } = useQuery({
    queryKey: ['inventory-balances-sizes'],
    queryFn: () => productsApi.sizes(),
    staleTime: 5 * 60_000,
  });

  const filters: InventoryBalancesFilters = useMemo(
    () => ({
      page,
      limit,
      search: search.trim() || undefined,
      warehouse_id: warehouseId || undefined,
      branch_id: branchId || undefined,
      category_id: categoryId || undefined,
      group_id: groupId || undefined,
      color_id: colorId || undefined,
      size_id: sizeId || undefined,
      low_stock: lowStock || undefined,
      out_of_stock: outOfStock || undefined,
    }),
    [
      page,
      limit,
      search,
      warehouseId,
      branchId,
      categoryId,
      groupId,
      colorId,
      sizeId,
      lowStock,
      outOfStock,
    ],
  );

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ['inventory-balances', filters],
    queryFn: () => inventoryApi.getBalances(filters),
    placeholderData: (prev) => prev,
    staleTime: 30_000,
  });

  const items = useMemo(() => data?.items ?? [], [data]);
  const totals = useMemo(() => computePageTotals(items), [items]);
  const totalPages = data ? Math.max(1, Math.ceil(data.total / limit)) : 1;

  const warehouseName = (warehouseList as any[]).find(
    (w) => w.id === warehouseId,
  );
  const branchName = (branchList as any[]).find((b) => b.id === branchId);
  const groupName = (groupList as any[]).find((g) => g.id === groupId);
  const categoryName = (categoryList as any[]).find(
    (c) => c.id === categoryId,
  );
  const colorName = (colorList as any[]).find((c) => c.id === colorId);
  const sizeName = (sizeList as any[]).find((s) => s.id === sizeId);

  const activeChips: Array<{ key: string; label: string; onClear: () => void }> =
    [];
  if (search.trim()) {
    activeChips.push({
      key: 'search',
      label: `بحث: ${search.trim()}`,
      onClear: () => setSearchInput(''),
    });
  }
  if (branchId) {
    activeChips.push({
      key: 'branch',
      label: `الفرع: ${branchName?.name_ar || branchId}`,
      onClear: () => setBranchId(''),
    });
  }
  if (warehouseId) {
    activeChips.push({
      key: 'warehouse',
      label: `المخزن: ${warehouseName?.name_ar || warehouseName?.name || warehouseId}`,
      onClear: () => setWarehouseId(''),
    });
  }
  if (categoryId) {
    activeChips.push({
      key: 'category',
      label: `التصنيف: ${categoryName?.name_ar || categoryId}`,
      onClear: () => setCategoryId(''),
    });
  }
  if (groupId) {
    activeChips.push({
      key: 'group',
      label: `المجموعة: ${groupName?.name_ar || groupId}`,
      onClear: () => setGroupId(''),
    });
  }
  if (colorId) {
    activeChips.push({
      key: 'color',
      label: `اللون: ${colorName?.name_ar || colorId}`,
      onClear: () => setColorId(''),
    });
  }
  if (sizeId) {
    activeChips.push({
      key: 'size',
      label: `المقاس: ${sizeName?.size_label || sizeId}`,
      onClear: () => setSizeId(''),
    });
  }
  if (lowStock) {
    activeChips.push({
      key: 'low',
      label: 'منخفض فقط',
      onClear: () => setLowStock(false),
    });
  }
  if (outOfStock) {
    activeChips.push({
      key: 'out',
      label: 'نفد فقط',
      onClear: () => setOutOfStock(false),
    });
  }

  const clearAllFilters = () => {
    setSearchInput('');
    setWarehouseId('');
    setBranchId('');
    setCategoryId('');
    setGroupId('');
    setColorId('');
    setSizeId('');
    setLowStock(false);
    setOutOfStock(false);
  };

  return (
    <div className="space-y-4" data-testid="inventory-balances">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-black text-slate-800">أرصدة المخزون</h1>
          <p className="text-xs text-slate-500">
            عرض المتغيرات × المخازن مع المجموعات المرتبطة. تنقل مباشرة إلى صفحة
            المنتج أو سجل الحركات.
          </p>
        </div>
        {data && (
          <div className="text-xs text-slate-500 tabular-nums">
            <span className="font-bold text-slate-700">
              {fmtNumber(data.total)}
            </span>{' '}
            صف إجمالًا
          </div>
        )}
      </div>

      {/* ── Summary cards (page totals) ────────────────────────── */}
      <section
        className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-2"
        data-testid="balances-summary"
      >
        <SummaryCard
          icon={Layers}
          label="صفوف الصفحة"
          value={fmtNumber(totals.rows)}
          subtitle={`${fmtNumber(totals.variants)} متغير`}
          tone="default"
        />
        <SummaryCard
          icon={Boxes}
          label="إجمالي الكمية"
          value={fmtNumber(totals.total_qty)}
          subtitle="في هذه الصفحة"
          tone="default"
        />
        <SummaryCard
          icon={CheckCircle2}
          label="المتاح"
          value={fmtNumber(totals.total_available)}
          subtitle="في هذه الصفحة"
          tone="emerald"
        />
        <SummaryCard
          icon={Coins}
          label="قيمة (تكلفة)"
          value={fmtEGP(totals.total_cost_value)}
          subtitle="في هذه الصفحة"
          tone="default"
        />
        <SummaryCard
          icon={Wallet}
          label="قيمة (بيع)"
          value={fmtEGP(totals.total_sale_value)}
          subtitle="في هذه الصفحة"
          tone="default"
        />
        <SummaryCard
          icon={AlertTriangle}
          label="منخفض"
          value={fmtNumber(totals.low_rows)}
          subtitle="صفوف منخفضة"
          tone="amber"
        />
        <SummaryCard
          icon={PackageX}
          label="نفد"
          value={fmtNumber(totals.out_rows)}
          subtitle="صفوف نافدة"
          tone="rose"
        />
        <SummaryCard
          icon={Tags}
          label="فلاتر نشطة"
          value={fmtNumber(activeChips.length)}
          subtitle={activeChips.length ? 'اضغط × لإزالة فلتر' : 'بدون فلاتر'}
          tone="default"
        />
      </section>

      {/* ── Filters ────────────────────────────────────────────── */}
      <section
        className="card p-3 space-y-2"
        data-testid="balances-filters"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
          <label className="flex items-center gap-2 input">
            <Search size={14} className="text-slate-400" />
            <input
              type="text"
              placeholder="بحث بالمنتج / SKU / باركود…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="flex-1 bg-transparent outline-none text-sm"
              data-testid="balances-search"
            />
          </label>

          <select
            className="input"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            data-testid="balances-branch-filter"
          >
            <option value="">كل الفروع</option>
            {(branchList as any[]).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name_ar}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            data-testid="balances-warehouse-filter"
          >
            <option value="">كل المخازن</option>
            {(warehouseList as any[]).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name_ar || w.name}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
            data-testid="balances-category-filter"
          >
            <option value="">كل التصنيفات</option>
            {(categoryList as any[]).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name_ar}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            data-testid="balances-group-filter"
          >
            <option value="">كل المجموعات</option>
            {(groupList as any[]).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name_ar}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={colorId}
            onChange={(e) => setColorId(e.target.value)}
            data-testid="balances-color-filter"
          >
            <option value="">كل الألوان</option>
            {(colorList as any[]).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name_ar}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={sizeId}
            onChange={(e) => setSizeId(e.target.value)}
            data-testid="balances-size-filter"
          >
            <option value="">كل المقاسات</option>
            {(sizeList as any[]).map((s) => (
              <option key={s.id} value={s.id}>
                {s.size_label}
              </option>
            ))}
          </select>

          <div className="flex items-center gap-3 text-xs col-span-1 md:col-span-2">
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={lowStock}
                onChange={(e) => {
                  setLowStock(e.target.checked);
                  if (e.target.checked) setOutOfStock(false);
                }}
                data-testid="balances-low-stock"
              />
              <AlertTriangle size={13} className="text-amber-600" />
              منخفض
            </label>
            <label className="flex items-center gap-1 cursor-pointer">
              <input
                type="checkbox"
                checked={outOfStock}
                onChange={(e) => {
                  setOutOfStock(e.target.checked);
                  if (e.target.checked) setLowStock(false);
                }}
                data-testid="balances-out-of-stock"
              />
              <PackageX size={13} className="text-rose-600" />
              نفد
            </label>
            <button
              type="button"
              className="btn btn-sm"
              onClick={clearAllFilters}
              disabled={activeChips.length === 0}
              data-testid="balances-clear-filters"
            >
              <X size={13} />
              مسح الفلاتر
            </button>
          </div>
        </div>

        {/* Active filter chips */}
        {activeChips.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1 pt-1"
            data-testid="balances-active-chips"
          >
            <Filter size={12} className="text-slate-400" />
            <span className="text-[10px] text-slate-500">فلاتر نشطة:</span>
            {activeChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.onClear}
                className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                data-testid={`balances-chip-${chip.key}`}
              >
                {chip.label}
                <X size={10} />
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ── Table ──────────────────────────────────────────────── */}
      <section className="card overflow-x-auto" data-testid="balances-table">
        {isLoading ? (
          <div className="p-6 text-center text-sm text-slate-400">
            جاري التحميل…
          </div>
        ) : isError ? (
          <div className="p-4 bg-rose-50 text-rose-800 text-sm">
            {(error as Error)?.message || 'تعذّر تحميل الأرصدة.'}
          </div>
        ) : !data || data.items.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-400">
            لا توجد أرصدة مطابقة للفلاتر.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="text-right px-3 py-2">المنتج</th>
                <th className="text-right px-3 py-2">المتغير</th>
                <th className="text-right px-3 py-2">المجموعات</th>
                <th className="text-right px-3 py-2">المخزن</th>
                <th className="text-left px-3 py-2">على الرف</th>
                <th className="text-left px-3 py-2">محجوز</th>
                <th className="text-left px-3 py-2">المتاح</th>
                <th className="text-left px-3 py-2">إعادة طلب</th>
                <th className="text-right px-3 py-2">الحالة</th>
                <th className="text-left px-3 py-2">متوسط التكلفة</th>
                <th className="text-left px-3 py-2">سعر البيع</th>
                <th className="text-left px-3 py-2">قيمة (تكلفة)</th>
                <th className="text-left px-3 py-2">قيمة (بيع)</th>
                <th className="text-right px-3 py-2">آخر حركة</th>
                <th className="text-center px-3 py-2">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((r) => {
                const onHand = Number(r.quantity_on_hand) || 0;
                const reorder = Number(r.reorder_point) || 0;
                const low =
                  onHand > 0 && reorder > 0 && onHand <= reorder;
                const out = onHand <= 0;
                return (
                  <tr
                    key={`${r.variant_id}:${r.warehouse_id}`}
                    className={
                      out
                        ? 'bg-rose-50/40'
                        : low
                        ? 'bg-amber-50/40'
                        : ''
                    }
                    data-testid="balances-row"
                  >
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <div
                          className="w-8 h-8 rounded-md border border-slate-200 bg-slate-50 flex items-center justify-center text-slate-300 shrink-0"
                          data-testid="balance-product-image"
                          aria-hidden
                        >
                          <ImageIcon size={14} />
                        </div>
                        <div className="min-w-0">
                          <Link
                            to={`/products/${r.product_id}`}
                            className="font-medium text-slate-800 hover:text-indigo-600 truncate block"
                          >
                            {r.product_name}
                          </Link>
                          <div className="text-[10px] text-slate-400 tabular-nums">
                            {r.sku_prefix}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      <div className="font-medium text-slate-700 tabular-nums">
                        {r.sku}
                      </div>
                      {r.barcode && (
                        <div className="text-[10px] text-slate-400 tabular-nums">
                          {r.barcode}
                        </div>
                      )}
                      <div className="text-[10px] text-slate-500">
                        {[r.color_name, r.size_label]
                          .filter(Boolean)
                          .join(' · ') || '—'}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <GroupBadges
                        ids={r.group_ids}
                        names={r.group_names_ar}
                        colors={r.group_colors}
                      />
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {r.warehouse_name}
                    </td>
                    <td className="px-3 py-2 text-left tabular-nums">
                      {fmtNumber(r.quantity_on_hand)}
                    </td>
                    <td className="px-3 py-2 text-left tabular-nums text-slate-500">
                      {r.quantity_reserved > 0
                        ? fmtNumber(r.quantity_reserved)
                        : '—'}
                    </td>
                    <td className="px-3 py-2 text-left tabular-nums font-bold">
                      <span
                        className={
                          out
                            ? 'text-rose-700'
                            : low
                            ? 'text-amber-700'
                            : 'text-slate-800'
                        }
                      >
                        {fmtNumber(r.available_quantity)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-left tabular-nums text-slate-500">
                      {reorder > 0 ? fmtNumber(reorder) : '—'}
                    </td>
                    <td className="px-3 py-2">
                      <StockStatusBadge onHand={onHand} reorder={reorder} />
                    </td>
                    <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                      {r.avg_cost == null
                        ? '—'
                        : fmtEGP(r.avg_cost)}
                    </td>
                    <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                      {fmtEGP(r.selling_price)}
                    </td>
                    <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                      {fmtEGP(r.stock_cost_value)}
                    </td>
                    <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                      {fmtEGP(r.stock_sale_value)}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                      {fmtRelativeTime(r.last_movement_at)}
                    </td>
                    <td className="px-3 py-2">
                      <div
                        className="flex items-center justify-center gap-1"
                        data-testid="balances-row-actions"
                      >
                        <Link
                          to={`/products/${r.product_id}`}
                          className="icon-btn"
                          title="عرض المنتج"
                          data-testid="balances-action-product"
                        >
                          <ExternalLink size={13} />
                        </Link>
                        <Link
                          to={`/inventory/movements?variant_id=${r.variant_id}`}
                          className="icon-btn"
                          title="سجل الحركات"
                          data-testid="balances-action-movements"
                        >
                          <History size={13} />
                        </Link>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Pagination ─────────────────────────────────────────── */}
      {data && data.total > limit && (
        <div className="flex items-center justify-between text-xs">
          <button
            type="button"
            className="btn"
            disabled={page <= 1 || isFetching}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            data-testid="balances-prev"
          >
            <ChevronRight size={14} />
            السابق
          </button>
          <div className="tabular-nums text-slate-500">
            صفحة {page} من {totalPages}
          </div>
          <button
            type="button"
            className="btn"
            disabled={page >= totalPages || isFetching}
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            data-testid="balances-next"
          >
            التالي
            <ChevronLeft size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
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
  };
  const iconColor: Record<typeof tone, string> = {
    default: 'text-indigo-600',
    amber: 'text-amber-600',
    rose: 'text-rose-600',
    emerald: 'text-emerald-600',
  };
  return (
    <div
      className={`card p-2.5 border ${toneMap[tone]}`}
      data-testid="balances-summary-card"
    >
      <div className="flex items-center gap-2 text-[11px] text-slate-500">
        <Icon size={13} className={iconColor[tone]} />
        {label}
      </div>
      <div className="text-sm font-black text-slate-800 tabular-nums mt-1">
        {value}
      </div>
      {subtitle && (
        <div className="text-[10px] text-slate-500 mt-0.5">{subtitle}</div>
      )}
    </div>
  );
}

function StockStatusBadge({
  onHand,
  reorder,
}: {
  onHand: number;
  reorder: number;
}) {
  if (onHand <= 0) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200"
        data-testid="balance-status-badge"
        data-status="out"
      >
        <PackageX size={11} />
        نفد
      </span>
    );
  }
  if (reorder > 0 && onHand <= reorder) {
    return (
      <span
        className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200"
        data-testid="balance-status-badge"
        data-status="low"
      >
        <AlertTriangle size={11} />
        منخفض
      </span>
    );
  }
  return (
    <span
      className="inline-flex items-center gap-1 text-[9px] font-bold px-1.5 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200"
      data-testid="balance-status-badge"
      data-status="ok"
    >
      <CheckCircle2 size={11} />
      متاح
    </span>
  );
}

function GroupBadges({
  ids,
  names,
  colors,
}: {
  ids: string[];
  names: string[];
  colors: Array<string | null>;
}) {
  if (!ids?.length) {
    return <span className="text-[10px] text-slate-300">—</span>;
  }
  return (
    <div
      className="flex flex-wrap gap-1"
      data-testid="balance-group-badges"
    >
      {ids.map((gid, i) => (
        <span
          key={gid}
          className="inline-flex items-center gap-1 text-[10px] font-bold px-1.5 py-0.5 rounded-full border border-slate-200 bg-white"
          title={names[i]}
        >
          <span
            aria-hidden
            className="inline-block w-2 h-2 rounded-full"
            style={{ backgroundColor: colors[i] || '#94a3b8' }}
          />
          <Tags size={10} className="text-slate-400" />
          {names[i]}
        </span>
      ))}
    </div>
  );
}
