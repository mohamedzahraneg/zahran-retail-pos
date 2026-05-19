/**
 * InventoryReports.tsx — PR-INVENTORY-REPORTS
 *
 * Read-only analytics surface mounted at /inventory/reports. Four
 * tabs (valuation / low-stock / dead-stock / profitability), each
 * with summary cards + a table. Filters: branch, warehouse, group,
 * category (valuation), date range (profitability), days window
 * (dead-stock). No write actions anywhere.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  BarChart3,
  AlertTriangle,
  Activity,
  Boxes,
  Calendar,
  Coins,
  Filter,
  TrendingUp,
  TrendingDown,
  PackageX,
  Wallet,
  Search,
  X,
  Download,
  type LucideIcon,
} from 'lucide-react';
import {
  inventoryApi,
  type ValuationFilters,
  type LowStockFilters,
  type DeadStockFilters,
  type ProfitabilityFilters,
} from '@/api/inventory.api';
import { settingsApi, type Warehouse } from '@/api/settings.api';
import { branchesApi, type Branch } from '@/api/branches.api';
import { productGroupsApi } from '@/api/productGroups.api';
import { categoriesApi } from '@/api/categories.api';

type ReportTab = 'valuation' | 'low-stock' | 'dead-stock' | 'profitability';

const TAB_LABELS_AR: Record<ReportTab, string> = {
  valuation: 'تقييم المخزون',
  'low-stock': 'النواقص',
  'dead-stock': 'الراكد',
  profitability: 'الربحية',
};

function fmtNumber(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toLocaleString('en-EG') : '0';
}

function fmtEGP(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return `${v.toLocaleString('en-EG', { maximumFractionDigits: 2 })} ج.م`;
}

function fmtPct(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return `${v.toLocaleString('en-EG', { maximumFractionDigits: 1 })}٪`;
}

function fmtDate(s?: string | null): string {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleDateString('ar-EG');
  } catch {
    return s;
  }
}

export default function InventoryReports() {
  const [tab, setTab] = useState<ReportTab>('valuation');

  // ── Shared filters ────────────────────────────────────────────
  const [branchId, setBranchId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [groupId, setGroupId] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [search, setSearch] = useState('');
  // Tab-specific
  const [days, setDays] = useState<number>(90);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // ── Reference data ────────────────────────────────────────────
  const { data: branches = [] } = useQuery({
    queryKey: ['inventory-reports-branches'],
    queryFn: () => branchesApi.list(),
    staleTime: 5 * 60_000,
  });
  const { data: warehouses = [] } = useQuery({
    queryKey: ['inventory-reports-warehouses'],
    queryFn: () => settingsApi.listWarehouses(true),
    staleTime: 5 * 60_000,
  });
  const { data: groups = [] } = useQuery({
    queryKey: ['inventory-reports-groups'],
    queryFn: () => productGroupsApi.list({ is_active: true }),
    staleTime: 5 * 60_000,
  });
  const { data: categories = [] } = useQuery({
    queryKey: ['inventory-reports-categories'],
    queryFn: () => categoriesApi.list(),
    staleTime: 5 * 60_000,
  });

  // ── Filter chips ──────────────────────────────────────────────
  const branchById = (id: string) =>
    (branches as Branch[]).find((b) => b.id === id);
  const warehouseById = (id: string) =>
    (warehouses as Warehouse[]).find((w) => w.id === id);
  const groupById = (id: string) =>
    (groups as any[]).find((g) => g.id === id);
  const categoryById = (id: string) =>
    (categories as any[]).find((c) => c.id === id);

  const activeChips: Array<{
    key: string;
    label: string;
    onClear: () => void;
  }> = [];
  if (branchId) {
    activeChips.push({
      key: 'branch',
      label: `الفرع: ${branchById(branchId)?.name_ar || branchId}`,
      onClear: () => setBranchId(''),
    });
  }
  if (warehouseId) {
    activeChips.push({
      key: 'warehouse',
      label: `المخزن: ${warehouseById(warehouseId)?.name_ar || warehouseId}`,
      onClear: () => setWarehouseId(''),
    });
  }
  if (groupId) {
    activeChips.push({
      key: 'group',
      label: `المجموعة: ${groupById(groupId)?.name_ar || groupId}`,
      onClear: () => setGroupId(''),
    });
  }
  if (categoryId) {
    activeChips.push({
      key: 'category',
      label: `التصنيف: ${categoryById(categoryId)?.name_ar || categoryId}`,
      onClear: () => setCategoryId(''),
    });
  }
  if (search.trim()) {
    activeChips.push({
      key: 'search',
      label: `بحث: ${search.trim()}`,
      onClear: () => setSearch(''),
    });
  }
  if (tab === 'dead-stock' && days !== 90) {
    activeChips.push({
      key: 'days',
      label: `النافذة: ${days} يوم`,
      onClear: () => setDays(90),
    });
  }
  if (tab === 'profitability' && dateFrom) {
    activeChips.push({
      key: 'date-from',
      label: `من: ${dateFrom}`,
      onClear: () => setDateFrom(''),
    });
  }
  if (tab === 'profitability' && dateTo) {
    activeChips.push({
      key: 'date-to',
      label: `إلى: ${dateTo}`,
      onClear: () => setDateTo(''),
    });
  }

  const clearAllFilters = () => {
    setBranchId('');
    setWarehouseId('');
    setGroupId('');
    setCategoryId('');
    setSearch('');
    setDays(90);
    setDateFrom('');
    setDateTo('');
  };

  // Per-tab filter objects — hoisted so the hook count stays
  // constant across renders (rules-of-hooks).
  const valuationFilters = useMemo<ValuationFilters>(
    () => ({
      branch_id: branchId || undefined,
      warehouse_id: warehouseId || undefined,
      group_id: groupId || undefined,
      category_id: categoryId || undefined,
      search: search.trim() || undefined,
    }),
    [branchId, warehouseId, groupId, categoryId, search],
  );
  const lowStockFilters = useMemo<LowStockFilters>(
    () => ({
      branch_id: branchId || undefined,
      warehouse_id: warehouseId || undefined,
      group_id: groupId || undefined,
      category_id: categoryId || undefined,
    }),
    [branchId, warehouseId, groupId, categoryId],
  );
  const deadStockFilters = useMemo<DeadStockFilters>(
    () => ({
      branch_id: branchId || undefined,
      warehouse_id: warehouseId || undefined,
      group_id: groupId || undefined,
      days,
    }),
    [branchId, warehouseId, groupId, days],
  );
  const profitabilityFilters = useMemo<ProfitabilityFilters>(
    () => ({
      branch_id: branchId || undefined,
      warehouse_id: warehouseId || undefined,
      group_id: groupId || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
    }),
    [branchId, warehouseId, groupId, dateFrom, dateTo],
  );

  return (
    <div
      className="space-y-4"
      dir="rtl"
      data-testid="inventory-reports-page"
    >
      {/* Header */}
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
            <BarChart3 className="w-5 h-5 text-indigo-600" />
            تقارير المخزون
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            تقارير قراءة فقط: تقييم المخزون، النواقص، المخزون الراكد، وربحية
            المنتجات. كل التقارير branch-aware عبر <code>warehouse_branches</code>.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-sm"
          disabled
          title="قريبًا"
          data-testid="reports-export-button"
        >
          <Download size={14} />
          تصدير (قريبًا)
        </button>
      </header>

      {/* Tabs */}
      <nav
        className="flex flex-wrap gap-1 border-b border-slate-200"
        data-testid="reports-tabs"
      >
        {(['valuation', 'low-stock', 'dead-stock', 'profitability'] as ReportTab[]).map(
          (t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTab(t)}
              className={`px-3 py-1.5 text-sm font-bold border-b-2 -mb-px transition-colors ${
                tab === t
                  ? 'border-indigo-600 text-indigo-700'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
              data-testid={`reports-tab-${t}`}
              data-active={tab === t}
            >
              {TAB_LABELS_AR[t]}
            </button>
          ),
        )}
      </nav>

      {/* Filters */}
      <section
        className="card p-3 space-y-2"
        data-testid="reports-filters"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
          <select
            className="input"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            data-testid="reports-branch-filter"
            aria-label="الفرع"
          >
            <option value="">كل الفروع</option>
            {(branches as Branch[]).map((b) => (
              <option key={b.id} value={b.id}>
                {b.name_ar}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            data-testid="reports-warehouse-filter"
            aria-label="المخزن"
          >
            <option value="">كل المخازن</option>
            {(warehouses as Warehouse[]).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name_ar}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
            data-testid="reports-group-filter"
            aria-label="المجموعة"
          >
            <option value="">كل المجموعات</option>
            {(groups as any[]).map((g) => (
              <option key={g.id} value={g.id}>
                {g.name_ar}
              </option>
            ))}
          </select>

          {(tab === 'valuation' || tab === 'low-stock') && (
            <select
              className="input"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              data-testid="reports-category-filter"
              aria-label="التصنيف"
            >
              <option value="">كل التصنيفات</option>
              {(categories as any[]).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name_ar}
                </option>
              ))}
            </select>
          )}

          {tab === 'valuation' && (
            <label className="flex items-center gap-2 input">
              <Search size={14} className="text-slate-400" />
              <input
                type="text"
                placeholder="بحث بالاسم / SKU / باركود…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="flex-1 bg-transparent outline-none text-sm"
                data-testid="reports-search"
              />
            </label>
          )}

          {tab === 'dead-stock' && (
            <select
              className="input"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              data-testid="reports-days-filter"
              aria-label="النافذة الزمنية"
            >
              <option value={30}>آخر 30 يوم</option>
              <option value={60}>آخر 60 يوم</option>
              <option value={90}>آخر 90 يوم</option>
              <option value={180}>آخر 180 يوم</option>
            </select>
          )}

          {tab === 'profitability' && (
            <>
              <label className="flex items-center gap-2 input">
                <Calendar size={14} className="text-slate-400" />
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value)}
                  className="flex-1 bg-transparent outline-none text-sm"
                  data-testid="reports-date-from"
                  aria-label="من تاريخ"
                />
              </label>
              <label className="flex items-center gap-2 input">
                <Calendar size={14} className="text-slate-400" />
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value)}
                  className="flex-1 bg-transparent outline-none text-sm"
                  data-testid="reports-date-to"
                  aria-label="إلى تاريخ"
                />
              </label>
            </>
          )}

          <button
            type="button"
            className="btn btn-sm"
            onClick={clearAllFilters}
            disabled={activeChips.length === 0}
            data-testid="reports-clear-filters"
          >
            <X size={13} /> مسح الفلاتر
          </button>
        </div>

        {activeChips.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1 pt-1"
            data-testid="reports-active-chips"
          >
            <Filter size={12} className="text-slate-400" />
            <span className="text-[10px] text-slate-500">فلاتر نشطة:</span>
            {activeChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.onClear}
                className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                data-testid={`reports-chip-${chip.key}`}
              >
                {chip.label} <X size={10} />
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Tab body */}
      {tab === 'valuation' && <ValuationTab filters={valuationFilters} />}
      {tab === 'low-stock' && <LowStockTab filters={lowStockFilters} />}
      {tab === 'dead-stock' && <DeadStockTab filters={deadStockFilters} />}
      {tab === 'profitability' && (
        <ProfitabilityTab filters={profitabilityFilters} />
      )}
    </div>
  );
}

// ─── Tab: Valuation ──────────────────────────────────────────────
function ValuationTab({ filters }: { filters: ValuationFilters }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['inventory-reports-valuation', filters],
    queryFn: () => inventoryApi.reportValuation(filters),
    placeholderData: (prev) => prev,
  });
  return (
    <section
      className="space-y-3"
      data-testid="reports-valuation-section"
    >
      <div
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2"
        data-testid="reports-valuation-summary"
      >
        <SummaryCard
          icon={Boxes}
          label="إجمالي الكمية"
          value={fmtNumber(data?.totals.total_qty)}
          tone="default"
        />
        <SummaryCard
          icon={Boxes}
          label="المتاح"
          value={fmtNumber(data?.totals.total_available)}
          tone="emerald"
        />
        <SummaryCard
          icon={Coins}
          label="قيمة (تكلفة)"
          value={fmtEGP(data?.totals.total_cost_value)}
          tone="default"
        />
        <SummaryCard
          icon={Wallet}
          label="قيمة (بيع)"
          value={fmtEGP(data?.totals.total_sale_value)}
          tone="default"
        />
        <SummaryCard
          icon={TrendingUp}
          label="هامش متوقع"
          value={fmtEGP(data?.totals.potential_margin)}
          tone="emerald"
        />
      </div>
      <ReportTable
        loading={isLoading}
        empty={!data?.items.length}
        errorText={isError ? (error as Error)?.message : null}
        testid="reports-valuation-table"
      >
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="text-right px-3 py-2">المنتج</th>
              <th className="text-right px-3 py-2">المتغير</th>
              <th className="text-right px-3 py-2">المخزن</th>
              <th className="text-left px-3 py-2">على الرف</th>
              <th className="text-left px-3 py-2">المتاح</th>
              <th className="text-left px-3 py-2">قيمة (تكلفة)</th>
              <th className="text-left px-3 py-2">قيمة (بيع)</th>
              <th className="text-left px-3 py-2">هامش متوقع</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(data?.items ?? []).map((r) => (
              <tr key={`${r.variant_id}:${r.warehouse_id}`} data-testid="reports-valuation-row">
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-800">{r.product_name}</div>
                  <div className="text-[10px] text-slate-400">{r.sku_prefix}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="font-mono tabular-nums">{r.sku}</div>
                  <div className="text-[10px] text-slate-500">
                    {[r.color, r.size].filter(Boolean).join(' · ') || '—'}
                  </div>
                </td>
                <td className="px-3 py-2 text-slate-600">{r.warehouse_name}</td>
                <td className="px-3 py-2 text-left tabular-nums">
                  {fmtNumber(r.quantity_on_hand)}
                </td>
                <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                  {fmtNumber(r.available_quantity)}
                </td>
                <td className="px-3 py-2 text-left tabular-nums">
                  {fmtEGP(r.stock_cost_value)}
                </td>
                <td className="px-3 py-2 text-left tabular-nums">
                  {fmtEGP(r.stock_sale_value)}
                </td>
                <td className="px-3 py-2 text-left tabular-nums text-emerald-700 font-bold">
                  {fmtEGP(r.potential_margin)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ReportTable>
    </section>
  );
}

// ─── Tab: Low stock ──────────────────────────────────────────────
function LowStockTab({ filters }: { filters: LowStockFilters }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['inventory-reports-low-stock', filters],
    queryFn: () => inventoryApi.reportLowStock(filters),
    placeholderData: (prev) => prev,
  });
  return (
    <section className="space-y-3" data-testid="reports-low-stock-section">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
        <SummaryCard
          icon={AlertTriangle}
          label="منخفض"
          value={fmtNumber(data?.totals.low_count)}
          tone="amber"
        />
        <SummaryCard
          icon={PackageX}
          label="نفد"
          value={fmtNumber(data?.totals.out_count)}
          tone="rose"
        />
        <SummaryCard
          icon={Activity}
          label="إجمالي الوحدات الناقصة"
          value={fmtNumber(data?.totals.total_units_short)}
          tone="default"
        />
      </div>
      <ReportTable
        loading={isLoading}
        empty={!data?.items.length}
        errorText={isError ? (error as Error)?.message : null}
        testid="reports-low-stock-table"
      >
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="text-right px-3 py-2">المنتج</th>
              <th className="text-right px-3 py-2">المتغير</th>
              <th className="text-right px-3 py-2">المخزن</th>
              <th className="text-left px-3 py-2">على الرف</th>
              <th className="text-left px-3 py-2">إعادة طلب</th>
              <th className="text-left px-3 py-2">الوحدات الناقصة</th>
              <th className="text-right px-3 py-2">الحالة</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(data?.items ?? []).map((r) => (
              <tr key={`${r.variant_id}:${r.warehouse_id}`} data-testid="reports-low-stock-row">
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-800">{r.product_name}</div>
                  <div className="text-[10px] text-slate-400">{r.sku_prefix}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="font-mono tabular-nums">{r.sku}</div>
                  <div className="text-[10px] text-slate-500">
                    {[r.color, r.size].filter(Boolean).join(' · ') || '—'}
                  </div>
                </td>
                <td className="px-3 py-2 text-slate-600">{r.warehouse_name}</td>
                <td
                  className={`px-3 py-2 text-left tabular-nums font-bold ${
                    r.shortage_kind === 'out' ? 'text-rose-700' : 'text-amber-700'
                  }`}
                >
                  {fmtNumber(r.quantity_on_hand)}
                </td>
                <td className="px-3 py-2 text-left tabular-nums text-slate-500">
                  {fmtNumber(r.reorder_point)}
                </td>
                <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                  {fmtNumber(r.units_short)}
                </td>
                <td className="px-3 py-2">
                  <span
                    className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${
                      r.shortage_kind === 'out'
                        ? 'bg-rose-50 text-rose-700 border-rose-200'
                        : 'bg-amber-50 text-amber-700 border-amber-200'
                    }`}
                  >
                    {r.shortage_kind === 'out' ? 'نفد' : 'منخفض'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ReportTable>
    </section>
  );
}

// ─── Tab: Dead stock ─────────────────────────────────────────────
function DeadStockTab({ filters }: { filters: DeadStockFilters }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['inventory-reports-dead-stock', filters],
    queryFn: () => inventoryApi.reportDeadStock(filters),
    placeholderData: (prev) => prev,
  });
  return (
    <section className="space-y-3" data-testid="reports-dead-stock-section">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <SummaryCard
          icon={Boxes}
          label="عدد الأصناف"
          value={fmtNumber(data?.totals.items_count)}
          tone="default"
        />
        <SummaryCard
          icon={Activity}
          label="إجمالي الكميات"
          value={fmtNumber(data?.totals.total_units)}
          tone="default"
        />
        <SummaryCard
          icon={Coins}
          label="قيمة راكدة (تكلفة)"
          value={fmtEGP(data?.totals.total_cost_value)}
          tone="rose"
        />
        <SummaryCard
          icon={Calendar}
          label="النافذة الزمنية"
          value={`${fmtNumber(data?.totals.days_window ?? filters.days ?? 90)} يوم`}
          tone="default"
        />
      </div>
      <ReportTable
        loading={isLoading}
        empty={!data?.items.length}
        errorText={isError ? (error as Error)?.message : null}
        testid="reports-dead-stock-table"
      >
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="text-right px-3 py-2">المنتج</th>
              <th className="text-right px-3 py-2">المتغير</th>
              <th className="text-right px-3 py-2">المخزن</th>
              <th className="text-left px-3 py-2">على الرف</th>
              <th className="text-left px-3 py-2">قيمة راكدة</th>
              <th className="text-right px-3 py-2">آخر مبيعة</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(data?.items ?? []).map((r) => (
              <tr key={`${r.variant_id}:${r.warehouse_id}`} data-testid="reports-dead-stock-row">
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-800">{r.product_name}</div>
                  <div className="text-[10px] text-slate-400">{r.sku_prefix}</div>
                </td>
                <td className="px-3 py-2">
                  <div className="font-mono tabular-nums">{r.sku}</div>
                  <div className="text-[10px] text-slate-500">
                    {[r.color, r.size].filter(Boolean).join(' · ') || '—'}
                  </div>
                </td>
                <td className="px-3 py-2 text-slate-600">{r.warehouse_name}</td>
                <td className="px-3 py-2 text-left tabular-nums font-bold">
                  {fmtNumber(r.quantity_on_hand)}
                </td>
                <td className="px-3 py-2 text-left tabular-nums text-rose-700">
                  {fmtEGP(r.stuck_cost_value)}
                </td>
                <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                  {fmtDate(r.last_sale_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ReportTable>
    </section>
  );
}

// ─── Tab: Profitability ──────────────────────────────────────────
function ProfitabilityTab({ filters }: { filters: ProfitabilityFilters }) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['inventory-reports-profitability', filters],
    queryFn: () => inventoryApi.reportProfitability(filters),
    placeholderData: (prev) => prev,
  });
  return (
    <section className="space-y-3" data-testid="reports-profitability-section">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
        <SummaryCard
          icon={TrendingUp}
          label="إجمالي المبيعات"
          value={fmtEGP(data?.totals.sales_total)}
          tone="emerald"
        />
        <SummaryCard
          icon={TrendingDown}
          label="COGS"
          value={fmtEGP(data?.totals.cogs_total)}
          tone="rose"
        />
        <SummaryCard
          icon={Coins}
          label="إجمالي الربح"
          value={fmtEGP(data?.totals.gross_profit)}
          tone="emerald"
        />
        <SummaryCard
          icon={Wallet}
          label="هامش الربح"
          value={fmtPct(data?.totals.margin_pct)}
          tone="default"
        />
      </div>
      <ReportTable
        loading={isLoading}
        empty={!data?.items.length}
        errorText={isError ? (error as Error)?.message : null}
        testid="reports-profitability-table"
      >
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="text-right px-3 py-2">المنتج</th>
              <th className="text-left px-3 py-2">باع</th>
              <th className="text-left px-3 py-2">مرتجع</th>
              <th className="text-left px-3 py-2">صافي</th>
              <th className="text-left px-3 py-2">مبيعات</th>
              <th className="text-left px-3 py-2">COGS</th>
              <th className="text-left px-3 py-2">ربح</th>
              <th className="text-left px-3 py-2">هامش</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(data?.items ?? []).map((r) => (
              <tr key={r.product_id} data-testid="reports-profitability-row">
                <td className="px-3 py-2">
                  <div className="font-medium text-slate-800">{r.product_name}</div>
                  <div className="text-[10px] text-slate-400">{r.sku_prefix}</div>
                </td>
                <td className="px-3 py-2 text-left tabular-nums">{fmtNumber(r.sold_qty)}</td>
                <td className="px-3 py-2 text-left tabular-nums text-rose-700">
                  {fmtNumber(r.returned_qty)}
                </td>
                <td className="px-3 py-2 text-left tabular-nums font-bold">
                  {fmtNumber(r.net_qty)}
                </td>
                <td className="px-3 py-2 text-left tabular-nums">{fmtEGP(r.sales_total)}</td>
                <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                  {fmtEGP(r.cogs_total)}
                </td>
                <td className="px-3 py-2 text-left tabular-nums text-emerald-700 font-bold">
                  {fmtEGP(r.gross_profit)}
                </td>
                <td className="px-3 py-2 text-left tabular-nums">
                  {fmtPct(r.margin_pct)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </ReportTable>
    </section>
  );
}

// ─── Shared sub-components ───────────────────────────────────────
function SummaryCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone: 'default' | 'amber' | 'emerald' | 'rose';
}) {
  const toneMap: Record<typeof tone, string> = {
    default: 'border-slate-200 bg-white',
    amber: 'border-amber-200 bg-amber-50/60',
    emerald: 'border-emerald-200 bg-emerald-50/60',
    rose: 'border-rose-200 bg-rose-50/60',
  };
  const iconColor: Record<typeof tone, string> = {
    default: 'text-indigo-600',
    amber: 'text-amber-600',
    emerald: 'text-emerald-600',
    rose: 'text-rose-600',
  };
  return (
    <div
      className={`card p-2.5 border ${toneMap[tone]}`}
      data-testid="reports-summary-card"
    >
      <div className="flex items-center gap-2 text-[11px] text-slate-500">
        <Icon size={13} className={iconColor[tone]} />
        {label}
      </div>
      <div className="text-sm font-black text-slate-800 tabular-nums mt-1">
        {value}
      </div>
    </div>
  );
}

function ReportTable({
  loading,
  empty,
  errorText,
  testid,
  children,
}: {
  loading: boolean;
  empty: boolean;
  errorText: string | null;
  testid: string;
  children: React.ReactNode;
}) {
  return (
    <div className="card overflow-x-auto" data-testid={testid}>
      {loading ? (
        <div className="p-6 text-center text-sm text-slate-400">
          جاري التحميل…
        </div>
      ) : errorText ? (
        <div className="p-4 bg-rose-50 text-rose-800 text-sm">{errorText}</div>
      ) : empty ? (
        <div className="p-6 text-center text-sm text-slate-400">
          لا توجد بيانات.
        </div>
      ) : (
        children
      )}
    </div>
  );
}
