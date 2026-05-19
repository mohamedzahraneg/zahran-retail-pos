/**
 * InventoryDashboard.tsx — PR-FIX-INVENTORY-UI-SHELL
 *
 * Read-only landing page for the new inventory section. KPI cards +
 * recent movements + top low-stock + top product-groups (by stock
 * value and by 30-day sales). Strictly visualization; every value
 * comes from `GET /inventory/dashboard`. No charts library — plain
 * Tailwind cards/tables.
 */
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Package,
  PackageSearch,
  Boxes,
  Tags,
  Warehouse,
  AlertTriangle,
  Activity,
  ArrowDownCircle,
  ArrowUpCircle,
  Coins,
  TrendingUp,
  Building2,
  X,
  type LucideIcon,
} from 'lucide-react';
import { inventoryApi } from '@/api/inventory.api';
import { branchesApi } from '@/api/branches.api';

function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return '0';
  return n.toLocaleString('en-EG');
}

function fmtEGP(n: number): string {
  if (!Number.isFinite(n)) return '٠ ج.م';
  return `${n.toLocaleString('en-EG', { maximumFractionDigits: 2 })} ج.م`;
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

export default function InventoryDashboard() {
  // PR-BRANCHES-INVENTORY-FILTERS — branch scope. Selecting a branch
  // re-fetches with `branch_id` and re-scopes every KPI + top-N list
  // server-side via the EXISTS sub-query over `warehouse_branches`.
  const [branchId, setBranchId] = useState('');
  const { data: branchList = [] } = useQuery({
    queryKey: ['inventory-dashboard-branches'],
    queryFn: () => branchesApi.list(),
    staleTime: 5 * 60_000,
  });
  const branch = (branchList as any[]).find((b) => b.id === branchId);

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['inventory-dashboard', { branch_id: branchId || undefined }],
    queryFn: () =>
      inventoryApi.getDashboard({ branch_id: branchId || undefined }),
    staleTime: 30_000,
  });

  if (isLoading) {
    return (
      <div className="space-y-4">
        <Header
          onRefresh={() => refetch()}
          loading
          branchId={branchId}
          branchList={branchList as any[]}
          onBranchChange={setBranchId}
        />
        <div
          data-testid="inventory-dashboard-loading"
          className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3"
        >
          {Array.from({ length: 8 }).map((_, i) => (
            <div
              key={i}
              className="card p-4 animate-pulse h-24 bg-slate-100/40"
            />
          ))}
        </div>
      </div>
    );
  }

  if (isError) {
    return (
      <div className="space-y-3">
        <Header
          onRefresh={() => refetch()}
          branchId={branchId}
          branchList={branchList as any[]}
          onBranchChange={setBranchId}
        />
        <div
          data-testid="inventory-dashboard-error"
          className="card border border-rose-200 bg-rose-50 text-rose-800 p-4"
        >
          <div className="font-bold mb-1">تعذّر تحميل لوحة المخزون</div>
          <div className="text-xs opacity-80">
            {(error as Error)?.message || 'حاول مرة أخرى.'}
          </div>
        </div>
      </div>
    );
  }

  const totals = data!.totals;
  const lowStock = data!.top_low_stock;
  const movements = data!.recent_movements;
  const topGroupsValue = data!.top_groups_by_stock_value;
  const topGroupsSales = data!.top_groups_by_sales_30d;

  return (
    <div className="space-y-4" data-testid="inventory-dashboard">
      <Header
        onRefresh={() => refetch()}
        loading={isRefetching}
        branchId={branchId}
        branchList={branchList as any[]}
        onBranchChange={setBranchId}
      />

      {/* PR-BRANCHES-INVENTORY-FILTERS — active scope chip. Mirrors
          the chip pattern on Balances / Movements. Clearing the chip
          returns the dashboard to the global (all-branches) view. */}
      {branchId && (
        <div
          className="flex flex-wrap items-center gap-1"
          data-testid="dashboard-active-chips"
        >
          <span className="text-[10px] text-slate-500">نطاق:</span>
          <button
            type="button"
            onClick={() => setBranchId('')}
            className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
            data-testid="dashboard-chip-branch"
          >
            الفرع: {branch?.name_ar || branchId}
            <X size={10} />
          </button>
        </div>
      )}

      {/* ── KPI cards ────────────────────────────────────────────── */}
      <section
        data-testid="inventory-kpi-grid"
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3"
      >
        <Kpi
          icon={Package}
          label="المنتجات النشطة"
          value={fmtNumber(totals.total_products)}
        />
        <Kpi
          icon={Boxes}
          label="إجمالي المتغيرات"
          value={fmtNumber(totals.total_variants)}
        />
        <Kpi
          icon={PackageSearch}
          label="إجمالي الكميات"
          value={fmtNumber(totals.total_stock_qty)}
          subtitle={`المتاح: ${fmtNumber(totals.total_available_qty)}`}
        />
        <Kpi
          icon={Warehouse}
          label="المخازن"
          value={fmtNumber(totals.warehouses_count)}
        />
        <Kpi
          icon={Coins}
          label="قيمة المخزون (تكلفة)"
          value={fmtEGP(totals.total_stock_cost_value)}
        />
        <Kpi
          icon={TrendingUp}
          label="قيمة المخزون (بيع)"
          value={fmtEGP(totals.total_stock_sale_value)}
        />
        <Kpi
          icon={AlertTriangle}
          label="مخزون منخفض"
          value={fmtNumber(totals.low_stock_count)}
          subtitle={`${fmtNumber(totals.out_of_stock_count)} نفد بالكامل`}
          tone="amber"
        />
        <Kpi
          icon={Activity}
          label="حركات اليوم"
          value={fmtNumber(totals.movements_today_count)}
          subtitle={`${fmtNumber(totals.low_stock_groups_count)} مجموعة فيها نقص`}
        />
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Top low stock ───────────────────────────────────── */}
        <section className="card p-4" data-testid="top-low-stock">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-slate-800 flex items-center gap-2">
              <AlertTriangle size={16} className="text-amber-600" />
              أعلى الأصناف منخفضة المخزون
            </h2>
            <Link
              to="/inventory/balances?low_stock=true"
              className="text-xs text-indigo-600 hover:underline"
            >
              عرض الكل ←
            </Link>
          </div>
          {lowStock.length === 0 ? (
            <EmptyRow text="لا توجد أصناف منخفضة حالياً." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-500">
                  <tr>
                    <th className="text-right py-1">المنتج</th>
                    <th className="text-right py-1">SKU</th>
                    <th className="text-right py-1">المخزن</th>
                    <th className="text-left py-1">المتبقي</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {lowStock.map((it) => (
                    <tr key={`${it.variant_id}:${it.warehouse_id}`}>
                      <td className="py-1.5">
                        <div className="font-medium">{it.product_name}</div>
                        <div className="text-[10px] text-slate-500">
                          {[it.color_name, it.size_label]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </td>
                      <td className="py-1.5 text-slate-600 tabular-nums">
                        {it.sku}
                      </td>
                      <td className="py-1.5 text-slate-600">
                        {it.warehouse_name}
                      </td>
                      <td className="py-1.5 text-left">
                        <span className="font-bold text-amber-700 tabular-nums">
                          {fmtNumber(it.quantity_on_hand)}
                        </span>
                        <span className="text-xs text-slate-400 px-1">
                          / {fmtNumber(it.reorder_point)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        {/* ── Recent movements ────────────────────────────────── */}
        <section className="card p-4" data-testid="recent-movements">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-slate-800 flex items-center gap-2">
              <Activity size={16} className="text-indigo-600" />
              آخر حركات المخزون
            </h2>
            <Link
              to="/inventory/movements"
              className="text-xs text-indigo-600 hover:underline"
            >
              عرض الكل ←
            </Link>
          </div>
          {movements.length === 0 ? (
            <EmptyRow text="لا توجد حركات حديثة." />
          ) : (
            <ul
              className="divide-y divide-slate-100"
              data-testid="recent-movements-list"
            >
              {movements.map((m) => (
                <li key={m.id} className="py-2 flex items-center gap-3 text-sm">
                  {m.direction === 'in' ? (
                    <ArrowDownCircle
                      size={18}
                      className="text-emerald-600 shrink-0"
                    />
                  ) : (
                    <ArrowUpCircle
                      size={18}
                      className="text-rose-600 shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="truncate font-medium">{m.product_name}</div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {m.sku} · {m.warehouse_name} · {m.movement_type}
                      {m.source_module ? ` · ${m.source_module}` : ''}
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
                      {fmtTime(m.created_at)}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ── Top groups by stock value ───────────────────────── */}
        <section className="card p-4" data-testid="top-groups-value">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-slate-800 flex items-center gap-2">
              <Tags size={16} className="text-indigo-600" />
              أعلى المجموعات قيمة بالمخزون
            </h2>
            <Link
              to="/product-groups"
              className="text-xs text-indigo-600 hover:underline"
            >
              إدارة المجموعات ←
            </Link>
          </div>
          {topGroupsValue.length === 0 ? (
            <EmptyRow text="لا توجد مجموعات بمخزون حالياً." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {topGroupsValue.map((g) => (
                <li
                  key={g.group_id}
                  className="py-2 flex items-center gap-3 text-sm"
                >
                  <GroupSwatch color={g.color} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{g.name_ar}</div>
                    {g.name_en && (
                      <div className="text-[10px] text-slate-400 truncate">
                        {g.name_en}
                      </div>
                    )}
                  </div>
                  <div className="text-left tabular-nums">
                    <div className="font-bold text-slate-800">
                      {fmtEGP(g.stock_value)}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {fmtNumber(g.stock_qty)} قطعة
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* ── Top groups by sales 30d ─────────────────────────── */}
        <section className="card p-4" data-testid="top-groups-sales">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-slate-800 flex items-center gap-2">
              <TrendingUp size={16} className="text-emerald-600" />
              أعلى المجموعات مبيعاً (آخر 30 يوماً)
            </h2>
          </div>
          {topGroupsSales.length === 0 ? (
            <EmptyRow text="لا توجد مبيعات على المجموعات في آخر 30 يوماً." />
          ) : (
            <ul className="divide-y divide-slate-100">
              {topGroupsSales.map((g) => (
                <li
                  key={g.group_id}
                  className="py-2 flex items-center gap-3 text-sm"
                >
                  <GroupSwatch color={g.color} />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate">{g.name_ar}</div>
                  </div>
                  <div className="text-left tabular-nums">
                    <div className="font-bold text-emerald-700">
                      {fmtEGP(g.revenue_30d)}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {fmtNumber(g.qty_30d)} قطعة
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────

function Header({
  onRefresh,
  loading,
  branchId,
  branchList,
  onBranchChange,
}: {
  onRefresh: () => void;
  loading?: boolean;
  branchId: string;
  branchList: Array<{ id: string; name_ar: string }>;
  onBranchChange: (id: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h1 className="text-xl font-black text-slate-800">لوحة المخزون</h1>
        <p className="text-xs text-slate-500">
          نظرة سريعة على أرصدة المخازن والحركات الأخيرة.
        </p>
      </div>
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 input min-w-[12rem]">
          <Building2 size={13} className="text-indigo-600" />
          <select
            value={branchId}
            onChange={(e) => onBranchChange(e.target.value)}
            className="bg-transparent outline-none text-sm flex-1"
            data-testid="dashboard-branch-filter"
            aria-label="الفرع"
          >
            <option value="">كل الفروع</option>
            {branchList.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name_ar}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="icon-btn"
          onClick={onRefresh}
          disabled={loading}
          title="تحديث"
          aria-label="تحديث"
        >
          <Activity size={16} className={loading ? 'animate-pulse' : ''} />
        </button>
      </div>
    </div>
  );
}

function Kpi({
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
  tone?: 'default' | 'amber';
}) {
  const toneClass =
    tone === 'amber'
      ? 'border-amber-200 bg-amber-50/60'
      : 'border-slate-200 bg-white';
  const iconClass =
    tone === 'amber' ? 'text-amber-600' : 'text-indigo-600';
  return (
    <div className={`card p-3 border ${toneClass}`}>
      <div className="flex items-center gap-2 text-[11px] text-slate-500">
        <Icon size={14} className={iconClass} />
        {label}
      </div>
      <div className="text-lg font-black text-slate-800 tabular-nums mt-1">
        {value}
      </div>
      {subtitle && (
        <div className="text-[10px] text-slate-500 mt-0.5">{subtitle}</div>
      )}
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="text-center text-sm text-slate-400 py-6">{text}</div>
  );
}

function GroupSwatch({ color }: { color: string | null }) {
  return (
    <span
      aria-hidden
      className="inline-block w-3 h-3 rounded-full shrink-0 ring-1 ring-slate-200"
      style={{ backgroundColor: color || '#e2e8f0' }}
    />
  );
}
