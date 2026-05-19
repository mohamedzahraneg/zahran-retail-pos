/**
 * InventoryMovements.tsx — PR-FIX-INVENTORY-UX-BALANCES-MOVEMENTS
 *
 * Read-only stock movements ledger. Surfaces the three audit columns
 * added by the DB hygiene PR (`balance_after_qty`, `source_module`,
 * `source_action`) plus existing reference linkage. Strictly
 * read-only: no mutations, no edit affordances; reference cells
 * become navigation links to the originating module (purchases /
 * stock-transfers / inventory-counts / products / sales).
 *
 * The page is also the natural target of variant-scoped deep links
 * coming from Balances or Product 360 — it reads `variant_id` /
 * `product_id` from the query string and keeps them pinned as
 * chips that the operator can clear explicitly.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Search,
  ArrowDownCircle,
  ArrowUpCircle,
  ChevronLeft,
  ChevronRight,
  Calendar,
  Filter,
  X,
  Activity,
  TrendingUp,
  TrendingDown,
  Sigma,
  Link2,
  Layers,
  Tags,
  ExternalLink,
  type LucideIcon,
} from 'lucide-react';
import {
  inventoryApi,
  type InventoryMovementRow,
  type InventoryMovementsFilters,
} from '@/api/inventory.api';
import { settingsApi } from '@/api/settings.api';
import { productGroupsApi } from '@/api/productGroups.api';
import { branchesApi } from '@/api/branches.api';

function fmtNumber(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toLocaleString('en-EG') : '0';
}

function fmtEGP(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return `${v.toLocaleString('en-EG', { maximumFractionDigits: 2 })} ج.م`;
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ar-EG', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return iso;
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

const MOVEMENT_TYPES = [
  'purchase',
  'sale',
  'return_in',
  'return_out',
  'transfer_out',
  'transfer_in',
  'adjustment_in',
  'adjustment_out',
  'reservation_hold',
  'reservation_release',
  'reservation_sale',
  'count_correction',
  'damaged',
  'initial',
  'adjustment',
  'transfer',
  'correction',
  'opening',
];

const MOVEMENT_TYPE_LABELS_AR: Record<string, string> = {
  purchase: 'شراء',
  sale: 'بيع',
  return_in: 'مرتجع وارد',
  return_out: 'مرتجع صادر',
  transfer_in: 'تحويل وارد',
  transfer_out: 'تحويل صادر',
  adjustment_in: 'تسوية موجبة',
  adjustment_out: 'تسوية سالبة',
  reservation_hold: 'حجز',
  reservation_release: 'إلغاء حجز',
  reservation_sale: 'بيع محجوز',
  count_correction: 'تصحيح جرد',
  damaged: 'تالف',
  initial: 'رصيد افتتاحي',
  adjustment: 'تسوية',
  transfer: 'تحويل',
  correction: 'تصحيح',
  opening: 'افتتاحي',
};

interface PageTotals {
  count: number;
  in_qty: number;
  out_qty: number;
  net_qty: number;
  in_rows: number;
  out_rows: number;
  with_reference: number;
  with_balance_after: number;
}

function computePageTotals(items: InventoryMovementRow[]): PageTotals {
  let in_qty = 0;
  let out_qty = 0;
  let in_rows = 0;
  let out_rows = 0;
  let with_reference = 0;
  let with_balance_after = 0;
  for (const m of items) {
    const qty = Math.abs(Number(m.quantity) || 0);
    if (m.direction === 'in') {
      in_qty += qty;
      in_rows += 1;
    } else {
      out_qty += qty;
      out_rows += 1;
    }
    if (m.reference_type) with_reference += 1;
    if (m.balance_after_qty != null) with_balance_after += 1;
  }
  return {
    count: items.length,
    in_qty,
    out_qty,
    net_qty: in_qty - out_qty,
    in_rows,
    out_rows,
    with_reference,
    with_balance_after,
  };
}

/**
 * Map a reference_type → in-app route. Returns `null` when the
 * reference type doesn't have a navigable destination (or the row
 * has no reference_id), so the renderer can fall back to plain text.
 */
function referenceLink(
  type: string | null,
  id: string | null,
): { to: string; label: string } | null {
  if (!type || !id) return null;
  switch (type) {
    case 'purchase':
    case 'purchases':
      return { to: '/purchases', label: 'فاتورة شراء' };
    case 'sale':
    case 'invoice':
    case 'invoices':
      return { to: '/invoices', label: 'فاتورة بيع' };
    case 'stock_transfer':
    case 'transfer':
      return { to: '/stock-transfers', label: 'تحويل مخزني' };
    case 'inventory_count':
    case 'count':
      return { to: '/stock-count', label: 'جرد' };
    case 'return':
    case 'returns':
      return { to: '/returns', label: 'مرتجع' };
    case 'product':
    case 'variant':
      return { to: `/products/${id}`, label: 'منتج' };
    default:
      return null;
  }
}

export default function InventoryMovements() {
  const [searchParams, setSearchParams] = useSearchParams();
  const initialVariant = searchParams.get('variant_id') ?? '';
  const initialProduct = searchParams.get('product_id') ?? '';

  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState('');
  const search = useDebouncedValue(searchInput, 300);
  const [variantId, setVariantId] = useState(initialVariant);
  const [productId, setProductId] = useState(initialProduct);
  const [warehouseId, setWarehouseId] = useState('');
  const [branchId, setBranchId] = useState(
    searchParams.get('branch_id') ?? '',
  );
  const [groupId, setGroupId] = useState('');
  const [movementType, setMovementType] = useState('');
  const [direction, setDirection] = useState<'' | 'in' | 'out'>('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const limit = 100;

  const resetPage = () => setPage(1);

  // Keep local state in sync with the URL when the operator navigates
  // here from a deep link (e.g. Balances row action). We only react
  // to *external* URL pushes — internal chip clears mutate state
  // directly and then the next effect flushes the URL.
  useEffect(() => {
    const urlVariant = searchParams.get('variant_id') ?? '';
    const urlProduct = searchParams.get('product_id') ?? '';
    if (urlVariant !== variantId) setVariantId(urlVariant);
    if (urlProduct !== productId) setProductId(urlProduct);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Mirror variant_id / product_id back to the URL so reloads keep
  // the scoped view, and so chip clears strip them from the URL too.
  useEffect(() => {
    const next = new URLSearchParams(searchParams);
    if (variantId) next.set('variant_id', variantId);
    else next.delete('variant_id');
    if (productId) next.set('product_id', productId);
    else next.delete('product_id');
    if (next.toString() !== searchParams.toString()) {
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variantId, productId]);

  useEffect(() => {
    resetPage();
  }, [
    search,
    variantId,
    productId,
    warehouseId,
    branchId,
    groupId,
    movementType,
    direction,
    dateFrom,
    dateTo,
  ]);

  const { data: warehouseList = [] } = useQuery({
    queryKey: ['inventory-movements-warehouses'],
    queryFn: () => settingsApi.listWarehouses() as any,
    staleTime: 5 * 60_000,
  });
  const { data: branchList = [] } = useQuery({
    queryKey: ['inventory-movements-branches'],
    queryFn: () => branchesApi.list(),
    staleTime: 5 * 60_000,
  });
  const { data: groupList = [] } = useQuery({
    queryKey: ['inventory-movements-groups'],
    queryFn: () => productGroupsApi.list({ is_active: true }),
    staleTime: 5 * 60_000,
  });

  const filters: InventoryMovementsFilters = useMemo(
    () => ({
      page,
      limit,
      search: search.trim() || undefined,
      variant_id: variantId || undefined,
      product_id: productId || undefined,
      warehouse_id: warehouseId || undefined,
      branch_id: branchId || undefined,
      movement_type: movementType || undefined,
      direction: direction || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      group_id: groupId || undefined,
    }),
    [
      page,
      limit,
      search,
      variantId,
      productId,
      warehouseId,
      branchId,
      movementType,
      direction,
      dateFrom,
      dateTo,
      groupId,
    ],
  );

  const { data, isLoading, isError, error, isFetching } = useQuery({
    queryKey: ['inventory-movements', filters],
    queryFn: () => inventoryApi.getMovements(filters),
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
  const scopedProductName =
    items.find((m) => m.product_id === productId)?.product_name || productId;
  const scopedVariantSku =
    items.find((m) => m.variant_id === variantId)?.sku || variantId;

  const activeChips: Array<{ key: string; label: string; onClear: () => void }> =
    [];
  if (search.trim()) {
    activeChips.push({
      key: 'search',
      label: `بحث: ${search.trim()}`,
      onClear: () => setSearchInput(''),
    });
  }
  if (productId) {
    activeChips.push({
      key: 'product',
      label: `المنتج: ${scopedProductName}`,
      onClear: () => setProductId(''),
    });
  }
  if (variantId) {
    activeChips.push({
      key: 'variant',
      label: `المتغير: ${scopedVariantSku}`,
      onClear: () => setVariantId(''),
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
  if (groupId) {
    activeChips.push({
      key: 'group',
      label: `المجموعة: ${groupName?.name_ar || groupId}`,
      onClear: () => setGroupId(''),
    });
  }
  if (movementType) {
    activeChips.push({
      key: 'type',
      label: `النوع: ${MOVEMENT_TYPE_LABELS_AR[movementType] || movementType}`,
      onClear: () => setMovementType(''),
    });
  }
  if (direction) {
    activeChips.push({
      key: 'direction',
      label: `الاتجاه: ${direction === 'in' ? 'داخل' : 'خارج'}`,
      onClear: () => setDirection(''),
    });
  }
  if (dateFrom) {
    activeChips.push({
      key: 'date-from',
      label: `من: ${dateFrom}`,
      onClear: () => setDateFrom(''),
    });
  }
  if (dateTo) {
    activeChips.push({
      key: 'date-to',
      label: `إلى: ${dateTo}`,
      onClear: () => setDateTo(''),
    });
  }

  const clearAllFilters = () => {
    setSearchInput('');
    setVariantId('');
    setProductId('');
    setWarehouseId('');
    setBranchId('');
    setGroupId('');
    setMovementType('');
    setDirection('');
    setDateFrom('');
    setDateTo('');
  };

  return (
    <div className="space-y-4" data-testid="inventory-movements">
      {/* ── Header ─────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-3">
        <div>
          <h1 className="text-xl font-black text-slate-800">حركات المخزون</h1>
          <p className="text-xs text-slate-500">
            سجل دائم لكل حركة دخول/خروج مع رصيد لحظة الحركة ومصدرها. اضغط على
            المرجع للانتقال إلى مصدر الحركة.
          </p>
        </div>
        {data && (
          <div className="text-xs text-slate-500 tabular-nums">
            <span className="font-bold text-slate-700">
              {fmtNumber(data.total)}
            </span>{' '}
            حركة إجمالًا
          </div>
        )}
      </div>

      {/* ── Summary cards (page totals) ────────────────────────── */}
      <section
        className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2"
        data-testid="movements-summary"
      >
        <SummaryCard
          icon={Activity}
          label="عدد الحركات"
          value={fmtNumber(totals.count)}
          subtitle="في هذه الصفحة"
          tone="default"
        />
        <SummaryCard
          icon={TrendingUp}
          label="إجمالي دخول"
          value={fmtNumber(totals.in_qty)}
          subtitle={`${fmtNumber(totals.in_rows)} حركة`}
          tone="emerald"
        />
        <SummaryCard
          icon={TrendingDown}
          label="إجمالي خروج"
          value={fmtNumber(totals.out_qty)}
          subtitle={`${fmtNumber(totals.out_rows)} حركة`}
          tone="rose"
        />
        <SummaryCard
          icon={Sigma}
          label="الصافي"
          value={(totals.net_qty >= 0 ? '+' : '') + fmtNumber(totals.net_qty)}
          subtitle="دخول − خروج"
          tone={totals.net_qty >= 0 ? 'emerald' : 'rose'}
        />
        <SummaryCard
          icon={Link2}
          label="مرتبطة بمرجع"
          value={fmtNumber(totals.with_reference)}
          subtitle="حركات بسجل مصدر"
          tone="default"
        />
        <SummaryCard
          icon={Layers}
          label="رصيد بعد"
          value={fmtNumber(totals.with_balance_after)}
          subtitle="حركات بقيمة رصيد"
          tone="default"
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
        data-testid="movements-filters"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
          <label className="flex items-center gap-2 input">
            <Search size={14} className="text-slate-400" />
            <input
              type="text"
              placeholder="بحث بالمنتج / SKU / باركود / ملاحظة…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="flex-1 bg-transparent outline-none text-sm"
              data-testid="movements-search"
            />
          </label>

          <select
            className="input"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            data-testid="movements-branch-filter"
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
            data-testid="movements-warehouse-filter"
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
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            data-testid="movements-group-filter"
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
            value={movementType}
            onChange={(e) => setMovementType(e.target.value)}
            data-testid="movements-type-filter"
          >
            <option value="">كل الأنواع</option>
            {MOVEMENT_TYPES.map((t) => (
              <option key={t} value={t}>
                {MOVEMENT_TYPE_LABELS_AR[t] || t}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={direction}
            onChange={(e) => setDirection(e.target.value as '' | 'in' | 'out')}
            data-testid="movements-direction-filter"
          >
            <option value="">الاتجاهين</option>
            <option value="in">داخل</option>
            <option value="out">خارج</option>
          </select>

          <label className="flex items-center gap-2 input">
            <Calendar size={14} className="text-slate-400" />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="flex-1 bg-transparent outline-none text-sm"
              data-testid="movements-date-from"
            />
          </label>

          <label className="flex items-center gap-2 input">
            <Calendar size={14} className="text-slate-400" />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="flex-1 bg-transparent outline-none text-sm"
              data-testid="movements-date-to"
            />
          </label>

          <div className="flex items-center gap-2 text-xs">
            <button
              type="button"
              className="btn btn-sm"
              onClick={clearAllFilters}
              disabled={activeChips.length === 0}
              data-testid="movements-clear-filters"
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
            data-testid="movements-active-chips"
          >
            <Filter size={12} className="text-slate-400" />
            <span className="text-[10px] text-slate-500">فلاتر نشطة:</span>
            {activeChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.onClear}
                className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                data-testid={`movements-chip-${chip.key}`}
              >
                {chip.label}
                <X size={10} />
              </button>
            ))}
          </div>
        )}
      </section>

      {/* ── Table ──────────────────────────────────────────────── */}
      <section className="card overflow-x-auto" data-testid="movements-table">
        {isLoading ? (
          <div className="p-6 text-center text-sm text-slate-400">
            جاري التحميل…
          </div>
        ) : isError ? (
          <div className="p-4 bg-rose-50 text-rose-800 text-sm">
            {(error as Error)?.message || 'تعذّر تحميل الحركات.'}
          </div>
        ) : !data || data.items.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-400">
            لا توجد حركات مطابقة للفلاتر.
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="text-right px-3 py-2">التاريخ</th>
                <th className="text-right px-3 py-2">المنتج / المتغير</th>
                <th className="text-right px-3 py-2">SKU / باركود</th>
                <th className="text-right px-3 py-2">المخزن</th>
                <th className="text-right px-3 py-2">النوع</th>
                <th className="text-center px-3 py-2">الاتجاه</th>
                <th className="text-left px-3 py-2">الكمية</th>
                <th className="text-left px-3 py-2">تكلفة الوحدة</th>
                <th className="text-left px-3 py-2">الرصيد بعدها</th>
                <th className="text-right px-3 py-2">المصدر</th>
                <th className="text-right px-3 py-2">المرجع</th>
                <th className="text-right px-3 py-2">المستخدم</th>
                <th className="text-right px-3 py-2">ملاحظات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.items.map((m) => {
                const refLink = referenceLink(m.reference_type, m.reference_id);
                return (
                  <tr key={m.id} data-testid="movements-row">
                    <td className="px-3 py-2 text-slate-600 text-xs whitespace-nowrap">
                      {fmtTime(m.created_at)}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        to={`/products/${m.product_id}`}
                        className="font-medium text-slate-800 hover:text-indigo-600"
                      >
                        {m.product_name}
                      </Link>
                      <div className="text-[10px] text-slate-400 tabular-nums">
                        {m.sku_prefix}
                      </div>
                    </td>
                    <td className="px-3 py-2 text-slate-600 tabular-nums">
                      <div>{m.sku}</div>
                      {m.barcode && (
                        <div className="text-[10px] text-slate-400">
                          {m.barcode}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-slate-600">
                      {m.warehouse_name}
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border border-slate-200 bg-white"
                        data-testid="movement-type"
                      >
                        {MOVEMENT_TYPE_LABELS_AR[m.movement_type] ||
                          m.movement_type}
                      </span>
                    </td>
                    <td
                      className="px-3 py-2 text-center"
                      data-testid="movement-direction"
                    >
                      {m.direction === 'in' ? (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200"
                          data-direction="in"
                        >
                          <ArrowDownCircle size={11} />
                          داخل
                        </span>
                      ) : (
                        <span
                          className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 border border-rose-200"
                          data-direction="out"
                        >
                          <ArrowUpCircle size={11} />
                          خارج
                        </span>
                      )}
                    </td>
                    <td
                      className="px-3 py-2 text-left tabular-nums font-bold"
                      data-testid="movement-qty"
                    >
                      <span
                        className={
                          m.direction === 'in'
                            ? 'text-emerald-700'
                            : 'text-rose-700'
                        }
                      >
                        {m.direction === 'in' ? '+' : '-'}
                        {fmtNumber(m.quantity)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                      {m.unit_cost == null ? '—' : fmtEGP(m.unit_cost)}
                    </td>
                    <td
                      className="px-3 py-2 text-left tabular-nums text-slate-600"
                      data-testid="movement-balance-after"
                    >
                      {m.balance_after_qty == null
                        ? '—'
                        : fmtNumber(m.balance_after_qty)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {m.source_module ? (
                        <div data-testid="movement-source">
                          <span className="font-medium text-slate-700">
                            {m.source_module}
                          </span>
                          {m.source_action && (
                            <span className="text-slate-400">
                              {' · '}
                              {m.source_action}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500">
                      {m.reference_type ? (
                        <div data-testid="movement-reference">
                          {refLink ? (
                            <Link
                              to={refLink.to}
                              className="inline-flex items-center gap-1 font-medium text-indigo-600 hover:text-indigo-700"
                              data-testid="movement-reference-link"
                            >
                              {refLink.label}
                              <ExternalLink size={10} />
                            </Link>
                          ) : (
                            <div className="font-medium text-slate-600">
                              {m.reference_type}
                            </div>
                          )}
                          {m.reference_id && (
                            <div className="text-[10px] text-slate-400 truncate max-w-[12rem]">
                              {m.reference_id}
                            </div>
                          )}
                        </div>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {m.user_name || m.user_username || '—'}
                    </td>
                    <td className="px-3 py-2 text-xs text-slate-500 max-w-[14rem] truncate">
                      {m.notes || '—'}
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
            data-testid="movements-prev"
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
            data-testid="movements-next"
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
      data-testid="movements-summary-card"
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
