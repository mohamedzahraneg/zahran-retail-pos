/**
 * PricingReports — PR-PURCHASES-P3.4A
 *
 * Four read-only pricing reports under `/pricing-reports`:
 *   A. Pricing health — per-variant margin / markup / status
 *   B. Losses — below-cost + below-min-margin filtered list
 *   C. Price history — variant_price_history from P3.2
 *   D. Landed-cost impact — last-purchase cost vs current price
 *
 * Read-only by design: zero apply-prices calls, zero purchase
 * mutation. The frontend never posts to any of the existing write
 * endpoints from this page.
 *
 * Markup vs margin are shown side-by-side everywhere so the operator
 * never confuses one with the other.
 */
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  TrendingDown,
  TrendingUp,
  AlertTriangle,
  Clock,
  Package,
  History as HistoryIcon,
  DollarSign,
  Sparkles,
  FileSpreadsheet,
  FileText,
} from 'lucide-react';
import {
  reportsApi,
  type PricingHealthRow,
  type PricingHistoryRow,
  type PricingLandedImpactRow,
  type PricingLossRow,
  type PricingStatus,
  type SoldProfitInvoiceRow,
  type SoldProfitProductRow,
  type SoldProfitSort,
  type SoldProfitStatus,
  type SoldProfitNetProductRow,
  type SoldProfitNetStatus,
  type FairPriceAllocationBasis,
  type FairPriceOverheadSource,
  type PricingFairPriceParams,
  type PricingFairPriceRow,
} from '@/api/reports.api';
import type {
  CostAdjustmentFilters,
  SmartPricingScope,
  SmartPricingStatusFilter,
} from '@/api/products.api';
import { SmartPricingAssistantModal } from '@/components/pricing/SmartPricingAssistantModal';
import { CostAdjustmentAssistantModal } from '@/components/pricing/CostAdjustmentAssistantModal';

// Map the frontend's wider PricingStatus to the smart-pricing-allowed subset.
const SMART_PRICING_STATUS_FILTER = new Set<SmartPricingStatusFilter>([
  'below_cost',
  'below_min_margin',
  'ok',
  'unknown_cost',
]);
function toSmartPricingStatus(
  s: PricingStatus | '',
): SmartPricingStatusFilter | undefined {
  return s && SMART_PRICING_STATUS_FILTER.has(s as SmartPricingStatusFilter)
    ? (s as SmartPricingStatusFilter)
    : undefined;
}

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const PCT = (n: number | null | undefined) =>
  n == null
    ? '—'
    : `${Number(n).toLocaleString('en-US', {
        minimumFractionDigits: 1,
        maximumFractionDigits: 2,
      })}%`;

const STATUS_LABEL_AR: Record<PricingStatus, string> = {
  ok: 'سعر صحي',
  below_min_margin: 'هامش منخفض',
  below_cost: 'تحت التكلفة (خسارة)',
  no_price: 'بدون سعر بيع',
  unknown_cost: 'تكلفة غير معروفة',
};

const STATUS_COLOR: Record<PricingStatus, string> = {
  ok: 'bg-emerald-100 text-emerald-700',
  below_min_margin: 'bg-amber-100 text-amber-700',
  below_cost: 'bg-rose-100 text-rose-700',
  no_price: 'bg-slate-100 text-slate-700',
  unknown_cost: 'bg-slate-100 text-slate-700',
};

type Tab =
  | 'health'
  | 'losses'
  | 'history'
  | 'landed'
  | 'sold-profit'
  | 'fair-price';

/**
 * Local toolbar trigger that opens the SmartPricingAssistantModal.
 *
 * The modal itself is pricing-only: it ONLY mutates
 * product_variants.selling_price + inserts variant_price_history audit
 * rows. It never calls /products/variants/apply-prices, never touches
 * cost_price (deferred to P3.5B), and never calls any
 * purchases/POS/accounting endpoint.
 */
interface SmartPricingTriggerProps {
  selectedVariantIds: Set<string>;
  filters?: SmartPricingScope['filters'];
  onApplied: () => void;
  /** data-testid suffix to disambiguate per-tab triggers. */
  testIdSuffix: string;
}

function SmartPricingTrigger({
  selectedVariantIds,
  filters,
  onApplied,
  testIdSuffix,
}: SmartPricingTriggerProps) {
  const [open, setOpen] = useState(false);
  const ids = useMemo(
    () => Array.from(selectedVariantIds),
    [selectedVariantIds],
  );
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid={`open-smart-pricing-${testIdSuffix}`}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold bg-amber-500 text-white hover:bg-amber-600 shadow-sm"
      >
        <Sparkles className="w-4 h-4" />
        مساعد تعديل الأسعار
        {ids.length > 0 && (
          <span className="bg-white/20 rounded px-1 text-xs">
            {ids.length}
          </span>
        )}
      </button>
      <SmartPricingAssistantModal
        open={open}
        context={{
          selectedVariantIds: ids,
          filters,
        }}
        onClose={() => setOpen(false)}
        onApplied={() => {
          onApplied();
        }}
      />
    </>
  );
}

/**
 * PR-PURCHASES-P3.6A — Local toolbar trigger that opens the
 * CostAdjustmentAssistantModal.
 *
 * Cost-reference-only by design: the modal ONLY mutates
 * product_variants.cost_price + inserts variant_cost_history rows. It
 * never touches accounting, cashbox, stock ledgers, supplier ledgers,
 * historical invoices/returns, or selling_price.
 */
interface CostAdjustmentTriggerProps {
  selectedVariantIds: Set<string>;
  filters?: CostAdjustmentFilters;
  onApplied: () => void;
  testIdSuffix: string;
}

function CostAdjustmentTrigger({
  selectedVariantIds,
  filters,
  onApplied,
  testIdSuffix,
}: CostAdjustmentTriggerProps) {
  const [open, setOpen] = useState(false);
  const ids = useMemo(
    () => Array.from(selectedVariantIds),
    [selectedVariantIds],
  );
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-testid={`open-cost-adjust-${testIdSuffix}`}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold bg-emerald-600 text-white hover:bg-emerald-700 shadow-sm"
      >
        مساعد تعديل التكلفة
        {ids.length > 0 && (
          <span className="bg-white/20 rounded px-1 text-xs">{ids.length}</span>
        )}
      </button>
      <CostAdjustmentAssistantModal
        open={open}
        context={{ selectedVariantIds: ids, filters }}
        onClose={() => setOpen(false)}
        onApplied={() => onApplied()}
      />
    </>
  );
}

const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: 'health', label: 'صحة الأسعار', icon: TrendingUp },
  { key: 'losses', label: 'منتجات تحت الحد / خاسرة', icon: TrendingDown },
  { key: 'history', label: 'تاريخ تغيير الأسعار', icon: HistoryIcon },
  { key: 'landed', label: 'أثر آخر مشتريات', icon: Package },
  { key: 'sold-profit', label: 'الربح الفعلي', icon: DollarSign },
  { key: 'fair-price', label: 'السعر العادل', icon: AlertTriangle },
];

export default function PricingReports() {
  const [tab, setTab] = useState<Tab>('health');
  return (
    <div className="space-y-4" dir="rtl" data-testid="pricing-reports-page">
      {/* P3.5A.1 — Sticky controls. The page title + tab strip stay
          pinned to the top of the scroll container so the user never
          has to scroll back up to switch tabs or open the assistant.
          `top-0` sits below any outer app shell padding; the page is
          already rendered inside the app layout container.            */}
      <div
        className="sticky top-0 z-30 -mx-4 px-4 pt-2 pb-3 bg-slate-50/95 backdrop-blur supports-[backdrop-filter]:bg-slate-50/70 border-b border-slate-200"
        data-testid="pricing-sticky-controls"
      >
        <header>
          <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-amber-500" />
            تقارير التسعير والربحية
          </h1>
          <p className="text-xs text-slate-600 mt-1">
            تقارير قراءة فقط مبنية على بيانات المشتريات والمخزون وسجل تغييرات
            الأسعار. لا تغيّر أي سعر أو فاتورة.
          </p>
        </header>

        <div className="flex flex-wrap gap-2 mt-3">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                data-testid={`pricing-reports-tab-${t.key}`}
                className={`px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 transition ${
                  active
                    ? 'bg-amber-500 text-white shadow'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                <Icon className="w-4 h-4" /> {t.label}
              </button>
            );
          })}
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="p-4">
          {tab === 'health' && <HealthTab />}
          {tab === 'losses' && <LossesTab />}
          {tab === 'history' && <HistoryTab />}
          {tab === 'landed' && <LandedImpactTab />}
          {tab === 'sold-profit' && <SoldProfitTab />}
          {tab === 'fair-price' && <FairPriceTab />}
        </div>
      </div>
    </div>
  );
}

/* ────────────────── Shared selection helpers (P3.5A.1) ────────────── */

/**
 * Tri-state header checkbox. Reflects whether all visible rows are
 * selected (✓), some are (indeterminate), or none are (☐). Clicking
 * cycles between "select all visible" and "clear visible".
 */
interface SelectAllHeaderProps {
  visibleIds: string[];
  selectedIds: Set<string>;
  onToggleAll: () => void;
  testId?: string;
}

function SelectAllHeader({
  visibleIds,
  selectedIds,
  onToggleAll,
  testId,
}: SelectAllHeaderProps) {
  const visibleSelected = visibleIds.filter((id) => selectedIds.has(id)).length;
  const allChecked = visibleIds.length > 0 && visibleSelected === visibleIds.length;
  const someChecked = visibleSelected > 0 && visibleSelected < visibleIds.length;
  const ref = (el: HTMLInputElement | null) => {
    if (el) el.indeterminate = someChecked;
  };
  return (
    <input
      type="checkbox"
      ref={ref}
      checked={allChecked}
      disabled={visibleIds.length === 0}
      onChange={onToggleAll}
      aria-label="تحديد كل الظاهر"
      data-testid={testId ?? 'pricing-select-all-visible'}
    />
  );
}

/**
 * Compact toolbar showing the selected count + a clear-selection link.
 * Renders inline next to the smart-pricing trigger; always rendered so
 * the count area has stable layout.
 */
/**
 * P3.4C — Export buttons for pricing reports. Wraps the existing
 * read-only `reportsApi.export(slug, format, params)` helper which
 * funnels every download through the shared backend xlsx/pdf pipeline.
 *
 * The component is intentionally tiny: each tab passes its own
 * slug + the current filter object. No formula lives here; the
 * backend re-runs the same SELECT it serves to the JSON callers and
 * relabels the columns to Arabic via the controller-side mapper.
 */
interface ExportButtonsProps {
  /** Report slug under `/api/v1/reports/<slug>`. Examples:
   *  `pricing/health`, `pricing/sold-profit/products`. */
  slug: string;
  /** Filters mirroring what the JSON fetch already uses. */
  params: Record<string, any>;
  /** Per-tab test-id suffix for vitest selection. */
  testIdSuffix: string;
}

function ExportButtons({ slug, params, testIdSuffix }: ExportButtonsProps) {
  const [busy, setBusy] = useState<null | 'xlsx' | 'pdf'>(null);
  const run = async (format: 'xlsx' | 'pdf') => {
    if (busy) return;
    setBusy(format);
    try {
      await reportsApi.export(slug, format, params);
    } catch {
      toast.error('تعذر تصدير التقرير. حاول مرة أخرى.');
    } finally {
      setBusy(null);
    }
  };
  const label = (base: string) =>
    busy ? 'جاري تجهيز الملف...' : base;
  return (
    <div className="flex items-center gap-2 flex-wrap">
      <button
        type="button"
        onClick={() => run('xlsx')}
        disabled={busy !== null}
        data-testid={`pricing-export-xlsx-${testIdSuffix}`}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold bg-emerald-50 text-emerald-700 hover:bg-emerald-100 border border-emerald-200 disabled:opacity-60"
      >
        <FileSpreadsheet className="w-4 h-4" />
        {label('تصدير Excel')}
      </button>
      <button
        type="button"
        onClick={() => run('pdf')}
        disabled={busy !== null}
        data-testid={`pricing-export-pdf-${testIdSuffix}`}
        className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-bold bg-rose-50 text-rose-700 hover:bg-rose-100 border border-rose-200 disabled:opacity-60"
      >
        <FileText className="w-4 h-4" />
        {label('تصدير PDF')}
      </button>
    </div>
  );
}

interface SelectionToolbarProps {
  selectedIds: Set<string>;
  onClear: () => void;
}

function SelectionToolbar({ selectedIds, onClear }: SelectionToolbarProps) {
  return (
    <div className="flex items-center gap-2 text-xs text-slate-600">
      <span data-testid="pricing-selected-count">
        المحدد: <span className="font-bold">{selectedIds.size}</span>
      </span>
      {selectedIds.size > 0 && (
        <button
          type="button"
          onClick={onClear}
          data-testid="pricing-clear-selection"
          className="text-amber-700 hover:text-amber-900 underline-offset-2 hover:underline"
        >
          إلغاء التحديد
        </button>
      )}
    </div>
  );
}

/**
 * Toggles the selected set against a list of currently visible row ids:
 *   · if every visible id is already selected → remove them
 *   · otherwise add the missing ones (without dropping previously-selected
 *     ids from other filter views)
 */
function toggleAllVisible(
  prev: Set<string>,
  visibleIds: string[],
): Set<string> {
  const next = new Set(prev);
  const allIn = visibleIds.every((id) => next.has(id));
  if (allIn) {
    for (const id of visibleIds) next.delete(id);
  } else {
    for (const id of visibleIds) next.add(id);
  }
  return next;
}

/* ────────────────── Health tab (Report A) ────────────────── */

function HealthTab() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<PricingStatus | ''>('');
  const [onlyInStock, setOnlyInStock] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const { data, isLoading } = useQuery({
    queryKey: ['pricing-health', q, status, onlyInStock],
    queryFn: () =>
      reportsApi.pricingHealth({
        q: q.trim() || undefined,
        status: status || undefined,
        only_in_stock: onlyInStock,
        limit: 1000,
      }),
  });

  const smartFilters = useMemo<SmartPricingScope['filters']>(() => {
    const f: SmartPricingScope['filters'] = {};
    if (q.trim()) f.q = q.trim();
    const mappedStatus = toSmartPricingStatus(status);
    if (mappedStatus) f.status = mappedStatus;
    if (onlyInStock) f.only_in_stock = true;
    return f;
  }, [q, status, onlyInStock]);

  // PR-PURCHASES-P3.6A — Cost-adjustment filters only support a subset
  // of pricing-health filters (q / only_in_stock). Status is a pricing
  // concept and is intentionally not forwarded — cost adjustment is
  // about cost, not about sale-price health.
  const costFilters = useMemo<CostAdjustmentFilters>(() => {
    const f: CostAdjustmentFilters = {};
    if (q.trim()) f.q = q.trim();
    if (onlyInStock) f.only_in_stock = true;
    return f;
  }, [q, onlyInStock]);

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
        <div className="md:col-span-2">
          <input
            type="search"
            placeholder="بحث بالاسم أو SKU أو الباركود"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="pricing-health-search"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value as PricingStatus | '')}
          data-testid="pricing-health-status-filter"
          className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
        >
          <option value="">كل الحالات</option>
          <option value="ok">سعر صحي</option>
          <option value="below_min_margin">هامش منخفض</option>
          <option value="below_cost">تحت التكلفة</option>
          <option value="no_price">بدون سعر بيع</option>
          <option value="unknown_cost">تكلفة غير معروفة</option>
        </select>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyInStock}
            onChange={(e) => setOnlyInStock(e.target.checked)}
            data-testid="pricing-health-only-in-stock"
          />
          الأصناف في المخزون فقط
        </label>
      </div>

      <div className="flex items-center justify-between gap-2 flex-wrap">
        <SelectionToolbar
          selectedIds={selectedIds}
          onClear={() => setSelectedIds(new Set())}
        />
        <div className="flex items-center gap-2 flex-wrap">
          <ExportButtons
            slug="pricing/health"
            params={{
              q: q.trim() || undefined,
              status: status || undefined,
              only_in_stock: onlyInStock || undefined,
              limit: 1000,
            }}
            testIdSuffix="health"
          />
          <SmartPricingTrigger
            selectedVariantIds={selectedIds}
            filters={smartFilters}
            onApplied={() => setSelectedIds(new Set())}
            testIdSuffix="health"
          />
          <CostAdjustmentTrigger
            selectedVariantIds={selectedIds}
            filters={costFilters}
            onApplied={() => setSelectedIds(new Set())}
            testIdSuffix="health"
          />
        </div>
      </div>

      <SummaryStrip>
        <Tile label="إجمالي الأصناف" value={String(data?.summary.total_variants ?? 0)} />
        <Tile
          label="تحت التكلفة"
          value={String(data?.summary.below_cost ?? 0)}
          accent="rose"
        />
        <Tile
          label="تحت الحد الأدنى"
          value={String(data?.summary.below_min_margin ?? 0)}
          accent="amber"
        />
        <Tile
          label="قيمة المخزون بالتكلفة"
          value={EGP(data?.summary.stock_value_at_cost ?? 0)}
        />
        <Tile
          label="إيرادات متوقعة"
          value={EGP(data?.summary.potential_revenue ?? 0)}
        />
        <Tile
          label="ربح متوقع"
          value={EGP(data?.summary.potential_profit ?? 0)}
          accent="emerald"
        />
      </SummaryStrip>

      {isLoading ? (
        <div className="p-6 text-center text-slate-400">جاري التحميل...</div>
      ) : (
        <HealthTable
          rows={data?.items ?? []}
          selectedIds={selectedIds}
          onToggle={(id) =>
            setSelectedIds((s) => {
              const next = new Set(s);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onToggleAll={(visibleIds) =>
            setSelectedIds((s) => toggleAllVisible(s, visibleIds))
          }
        />
      )}
    </div>
  );
}

interface HealthTableProps {
  rows: PricingHealthRow[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (visibleIds: string[]) => void;
}

function HealthTable({ rows, selectedIds, onToggle, onToggleAll }: HealthTableProps) {
  const visibleIds = rows.map((r) => r.variant_id);
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600 text-xs">
          <tr>
            <th className="p-2">
              <SelectAllHeader
                visibleIds={visibleIds}
                selectedIds={selectedIds}
                onToggleAll={() => onToggleAll(visibleIds)}
              />
            </th>
            <th className="p-2 text-right">الصنف</th>
            <th className="p-2 text-right">SKU</th>
            <th className="p-2 text-right">التكلفة</th>
            <th className="p-2 text-right">سعر البيع</th>
            <th className="p-2 text-right">الربح/قطعة</th>
            <th className="p-2 text-right">هامش الربح</th>
            <th className="p-2 text-right">الزيادة على التكلفة</th>
            <th className="p-2 text-right">المخزون</th>
            <th className="p-2 text-right">الحالة</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={10} className="p-6 text-center text-slate-400">
                لا توجد بيانات للعرض
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.variant_id} data-testid={`pricing-health-row-${r.variant_id}`}>
                <td className="p-2">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(r.variant_id)}
                    onChange={() => onToggle(r.variant_id)}
                    data-testid={`pricing-row-select-${r.variant_id}`}
                  />
                </td>
                <td className="p-2">
                  <div className="font-medium">{r.product_name}</div>
                  <div className="text-[10px] text-slate-400 font-mono">
                    {[r.color, r.size].filter(Boolean).join(' / ')}
                  </div>
                </td>
                <td className="p-2 font-mono text-xs">{r.sku}</td>
                <td className="p-2">{EGP(r.cost_price)}</td>
                <td className="p-2 font-bold">{EGP(r.selling_price)}</td>
                <td
                  className={`p-2 font-bold ${
                    r.profit >= 0 ? 'text-emerald-700' : 'text-rose-700'
                  }`}
                >
                  {EGP(r.profit)}
                </td>
                <td className="p-2">{PCT(r.margin_pct)}</td>
                <td className="p-2">{PCT(r.markup_pct)}</td>
                <td className="p-2">{r.stock_qty}</td>
                <td className="p-2">
                  <span
                    className={`text-[10px] font-bold px-2 py-1 rounded ${STATUS_COLOR[r.status]}`}
                    data-testid={`pricing-health-status-${r.variant_id}`}
                  >
                    {STATUS_LABEL_AR[r.status]}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ────────────────── Losses tab (Report B) ────────────────── */

function LossesTab() {
  const [onlyInStock, setOnlyInStock] = useState(true);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const { data, isLoading } = useQuery({
    queryKey: ['pricing-losses', onlyInStock],
    queryFn: () =>
      reportsApi.pricingLosses({ only_in_stock: onlyInStock, limit: 1000 }),
  });

  // Losses report is implicitly below_cost + below_min_margin only,
  // so we don't bind a single status filter through to smart pricing —
  // we just pass only_in_stock so "filtered" scope mirrors the UI.
  const smartFilters = useMemo<SmartPricingScope['filters']>(
    () => (onlyInStock ? { only_in_stock: true } : {}),
    [onlyInStock],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={onlyInStock}
              onChange={(e) => setOnlyInStock(e.target.checked)}
              data-testid="pricing-losses-only-in-stock"
            />
            الأصناف في المخزون فقط
          </label>
          <SelectionToolbar
            selectedIds={selectedIds}
            onClear={() => setSelectedIds(new Set())}
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <ExportButtons
            slug="pricing/losses"
            params={{
              only_in_stock: onlyInStock || undefined,
              limit: 1000,
            }}
            testIdSuffix="losses"
          />
          <SmartPricingTrigger
            selectedVariantIds={selectedIds}
            filters={smartFilters}
            onApplied={() => setSelectedIds(new Set())}
            testIdSuffix="losses"
          />
        </div>
      </div>

      <SummaryStrip>
        <Tile
          label="تحت التكلفة"
          value={String(data?.summary.below_cost ?? 0)}
          accent="rose"
        />
        <Tile
          label="تحت الحد الأدنى"
          value={String(data?.summary.below_min_margin ?? 0)}
          accent="amber"
        />
        <Tile
          label="إجمالي الخسارة المحتملة"
          value={EGP(data?.summary.total_loss_exposure ?? 0)}
          accent="rose"
        />
      </SummaryStrip>

      {isLoading ? (
        <div className="p-6 text-center text-slate-400">جاري التحميل...</div>
      ) : (
        <LossesTable
          rows={data?.items ?? []}
          selectedIds={selectedIds}
          onToggle={(id) =>
            setSelectedIds((s) => {
              const next = new Set(s);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onToggleAll={(visibleIds) =>
            setSelectedIds((s) => toggleAllVisible(s, visibleIds))
          }
        />
      )}
    </div>
  );
}

interface LossesTableProps {
  rows: PricingLossRow[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (visibleIds: string[]) => void;
}

function LossesTable({ rows, selectedIds, onToggle, onToggleAll }: LossesTableProps) {
  const visibleIds = rows.map((r) => r.variant_id);
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600 text-xs">
          <tr>
            <th className="p-2">
              <SelectAllHeader
                visibleIds={visibleIds}
                selectedIds={selectedIds}
                onToggleAll={() => onToggleAll(visibleIds)}
              />
            </th>
            <th className="p-2 text-right">الصنف</th>
            <th className="p-2 text-right">SKU</th>
            <th className="p-2 text-right">التكلفة</th>
            <th className="p-2 text-right">سعر البيع</th>
            <th className="p-2 text-right">هامش الربح</th>
            <th className="p-2 text-right">الزيادة على التكلفة</th>
            <th className="p-2 text-right">المخزون</th>
            <th className="p-2 text-right">الخسارة المحتملة</th>
            <th className="p-2 text-right">فجوة الهامش</th>
            <th className="p-2 text-right">الحالة</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={11} className="p-6 text-center text-slate-400">
                <AlertTriangle className="w-5 h-5 inline-block ml-2 text-emerald-500" />
                لا توجد منتجات تحت الحد الأدنى
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.variant_id} data-testid={`pricing-loss-row-${r.variant_id}`}>
                <td className="p-2">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(r.variant_id)}
                    onChange={() => onToggle(r.variant_id)}
                    data-testid={`pricing-row-select-${r.variant_id}`}
                  />
                </td>
                <td className="p-2">
                  <div className="font-medium">{r.product_name}</div>
                </td>
                <td className="p-2 font-mono text-xs">{r.sku}</td>
                <td className="p-2">{EGP(r.cost_price)}</td>
                <td className="p-2 font-bold">{EGP(r.selling_price)}</td>
                <td className="p-2">{PCT(r.margin_pct)}</td>
                <td className="p-2">{PCT(r.markup_pct)}</td>
                <td className="p-2">{r.stock_qty}</td>
                <td className="p-2 font-bold text-rose-700">
                  {r.loss_exposure ? EGP(r.loss_exposure) : '—'}
                </td>
                <td className="p-2 font-bold text-amber-700">
                  {r.margin_gap_pct != null ? PCT(r.margin_gap_pct) : '—'}
                </td>
                <td className="p-2">
                  <span
                    className={`text-[10px] font-bold px-2 py-1 rounded ${STATUS_COLOR[r.status]}`}
                  >
                    {STATUS_LABEL_AR[r.status]}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ────────────────── History tab (Report C) ────────────────── */

function HistoryTab() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const { data, isLoading } = useQuery({
    queryKey: ['pricing-history', from, to],
    queryFn: () =>
      reportsApi.pricingHistory({
        from: from || undefined,
        to: to || undefined,
        limit: 500,
      }),
  });

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">
            من تاريخ
          </label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            data-testid="pricing-history-from"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">
            إلى تاريخ
          </label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
            data-testid="pricing-history-to"
          />
        </div>
      </div>

      <div className="flex justify-end">
        <ExportButtons
          slug="pricing/history"
          params={{
            from: from || undefined,
            to: to || undefined,
            limit: 500,
          }}
          testIdSuffix="history"
        />
      </div>

      <SummaryStrip>
        <Tile label="عدد التغييرات" value={String(data?.summary.total ?? 0)} />
        <Tile
          label="آخر تغيير"
          value={
            data?.summary.last_change
              ? new Date(data.summary.last_change).toLocaleString('en-US')
              : '—'
          }
        />
      </SummaryStrip>

      {isLoading ? (
        <div className="p-6 text-center text-slate-400">جاري التحميل...</div>
      ) : (
        <HistoryTable rows={data?.items ?? []} />
      )}
    </div>
  );
}

function HistoryTable({ rows }: { rows: PricingHistoryRow[] }) {
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600 text-xs">
          <tr>
            <th className="p-2 text-right">التاريخ</th>
            <th className="p-2 text-right">الصنف</th>
            <th className="p-2 text-right">السعر القديم</th>
            <th className="p-2 text-right">السعر الجديد</th>
            <th className="p-2 text-right">الفرق</th>
            <th className="p-2 text-right">الفرق %</th>
            <th className="p-2 text-right">المصدر</th>
            <th className="p-2 text-right">المستخدم</th>
            <th className="p-2 text-right">السبب</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={9} className="p-6 text-center text-slate-400">
                <Clock className="w-5 h-5 inline-block ml-2" />
                لا توجد تغييرات أسعار
              </td>
            </tr>
          ) : (
            rows.map((r) => {
              const delta = Number(r.delta_amount);
              return (
                <tr key={r.id} data-testid={`pricing-history-row-${r.id}`}>
                  <td className="p-2 text-xs">
                    {new Date(r.changed_at).toLocaleString('en-US')}
                  </td>
                  <td className="p-2">
                    <div className="font-medium">{r.product_name}</div>
                    <div className="text-[10px] text-slate-400 font-mono">
                      {r.sku}
                    </div>
                  </td>
                  <td className="p-2">{EGP(r.old_selling_price)}</td>
                  <td className="p-2 font-bold">{EGP(r.new_selling_price)}</td>
                  <td
                    className={`p-2 font-bold ${
                      delta >= 0 ? 'text-emerald-700' : 'text-rose-700'
                    }`}
                  >
                    {delta >= 0 ? '+' : ''}
                    {EGP(delta)}
                  </td>
                  <td className="p-2">
                    {r.delta_pct == null
                      ? '—'
                      : `${Number(r.delta_pct).toFixed(2)}%`}
                  </td>
                  <td className="p-2 text-xs">
                    {r.source_purchase_no || '—'}
                  </td>
                  <td className="p-2 text-xs">{r.changed_by_name || '—'}</td>
                  <td className="p-2 text-xs">{r.reason || '—'}</td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ────────────────── Landed impact tab (Report D) ────────────────── */

function LandedImpactTab() {
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const { data, isLoading } = useQuery({
    queryKey: ['pricing-landed-impact', needsReviewOnly],
    queryFn: () =>
      reportsApi.pricingLandedImpact({
        needs_review_only: needsReviewOnly,
        limit: 1000,
      }),
  });

  const smartFilters = useMemo<SmartPricingScope['filters']>(
    () => (needsReviewOnly ? { needs_review_only: true } : {}),
    [needsReviewOnly],
  );

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={needsReviewOnly}
              onChange={(e) => setNeedsReviewOnly(e.target.checked)}
              data-testid="pricing-landed-needs-review-only"
            />
            عرض المنتجات التي تحتاج مراجعة سعر فقط
          </label>
          <SelectionToolbar
            selectedIds={selectedIds}
            onClear={() => setSelectedIds(new Set())}
          />
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <ExportButtons
            slug="pricing/landed-impact"
            params={{
              needs_review_only: needsReviewOnly || undefined,
              limit: 1000,
            }}
            testIdSuffix="landed"
          />
          <SmartPricingTrigger
            selectedVariantIds={selectedIds}
            filters={smartFilters}
            onApplied={() => setSelectedIds(new Set())}
            testIdSuffix="landed"
          />
        </div>
      </div>

      <SummaryStrip>
        <Tile label="إجمالي الأصناف" value={String(data?.summary.total ?? 0)} />
        <Tile
          label="تحتاج مراجعة"
          value={String(data?.summary.needs_review ?? 0)}
          accent="amber"
        />
      </SummaryStrip>

      {isLoading ? (
        <div className="p-6 text-center text-slate-400">جاري التحميل...</div>
      ) : (
        <LandedTable
          rows={data?.items ?? []}
          selectedIds={selectedIds}
          onToggle={(id) =>
            setSelectedIds((s) => {
              const next = new Set(s);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            })
          }
          onToggleAll={(visibleIds) =>
            setSelectedIds((s) => toggleAllVisible(s, visibleIds))
          }
        />
      )}
    </div>
  );
}

interface LandedTableProps {
  rows: PricingLandedImpactRow[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (visibleIds: string[]) => void;
}

function LandedTable({ rows, selectedIds, onToggle, onToggleAll }: LandedTableProps) {
  const visibleIds = rows.map((r) => r.variant_id);
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600 text-xs">
          <tr>
            <th className="p-2">
              <SelectAllHeader
                visibleIds={visibleIds}
                selectedIds={selectedIds}
                onToggleAll={() => onToggleAll(visibleIds)}
              />
            </th>
            <th className="p-2 text-right">الصنف</th>
            <th className="p-2 text-right">آخر فاتورة</th>
            <th className="p-2 text-right">المورد</th>
            <th className="p-2 text-right">سعر القطعة الأساسي</th>
            <th className="p-2 text-right">نصيب المصاريف</th>
            <th className="p-2 text-right">التكلفة النهائية</th>
            <th className="p-2 text-right">سعر البيع الحالي</th>
            <th className="p-2 text-right">هامش الربح</th>
            <th className="p-2 text-right">الزيادة على التكلفة</th>
            <th className="p-2 text-right">يحتاج مراجعة؟</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={11} className="p-6 text-center text-slate-400">
                لا توجد بيانات للعرض
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr
                key={r.variant_id}
                data-testid={`pricing-landed-row-${r.variant_id}`}
              >
                <td className="p-2">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(r.variant_id)}
                    onChange={() => onToggle(r.variant_id)}
                    data-testid={`pricing-row-select-${r.variant_id}`}
                  />
                </td>
                <td className="p-2">
                  <div className="font-medium">{r.product_name}</div>
                  <div className="text-[10px] text-slate-400 font-mono">
                    {r.sku}
                  </div>
                </td>
                <td className="p-2 text-xs">
                  <div>{r.last_purchase.purchase_no}</div>
                  <div className="text-[10px] text-slate-400">
                    {r.last_purchase.received_at
                      ? new Date(r.last_purchase.received_at).toLocaleDateString(
                          'en-US',
                        )
                      : r.last_purchase.invoice_date
                        ? new Date(r.last_purchase.invoice_date).toLocaleDateString(
                            'en-US',
                          )
                        : '—'}
                  </div>
                </td>
                <td className="p-2 text-xs">
                  {r.last_purchase.supplier_name || '—'}
                </td>
                <td className="p-2">{EGP(r.base_unit_cost)}</td>
                <td className="p-2 text-emerald-700">
                  +{EGP(r.allocated_cost_per_unit)}
                </td>
                <td className="p-2 font-bold">{EGP(r.landed_unit_cost)}</td>
                <td className="p-2 font-bold">
                  {EGP(r.current_selling_price)}
                </td>
                <td className="p-2">{PCT(r.margin_pct)}</td>
                <td className="p-2">{PCT(r.markup_pct)}</td>
                <td className="p-2">
                  {r.needs_review ? (
                    <span
                      className="text-[10px] font-bold px-2 py-1 rounded bg-amber-100 text-amber-700"
                      data-testid={`pricing-landed-needs-review-${r.variant_id}`}
                    >
                      {r.needs_review_reason
                        ? STATUS_LABEL_AR[
                            r.needs_review_reason as PricingStatus
                          ] ?? 'مراجعة'
                        : 'مراجعة'}
                    </span>
                  ) : (
                    <span className="text-[10px] font-bold px-2 py-1 rounded bg-emerald-100 text-emerald-700">
                      سليم
                    </span>
                  )}
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ────────────────── Shared bits ────────────────── */

function SummaryStrip({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2"
      data-testid="pricing-reports-summary"
    >
      {children}
    </div>
  );
}

/* ────────────────── Sold-profit tab (P3.4B) ────────────────── */

const SOLD_STATUS_LABEL_AR: Record<SoldProfitStatus, string> = {
  ok: 'ربح صحي',
  low_margin: 'هامش منخفض',
  loss: 'خسارة',
  unknown_cost: 'تكلفة غير معروفة',
};

const SOLD_STATUS_COLOR: Record<SoldProfitStatus, string> = {
  ok: 'bg-emerald-100 text-emerald-700',
  low_margin: 'bg-amber-100 text-amber-700',
  loss: 'bg-rose-100 text-rose-700',
  unknown_cost: 'bg-slate-100 text-slate-700',
};

function SoldProfitTab() {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<SoldProfitStatus | ''>('');
  const [sort, setSort] = useState<SoldProfitSort>('gross_profit_desc');
  const [view, setView] = useState<'products' | 'invoices'>('products');
  // P3.4D — Gross / Net mode toggle. Net deducts returns attributed
  // to their `refunded_at` date (NOT the original sale date) so a
  // November sale + December return lands in December's net profit.
  // Gross keeps the existing report shape untouched.
  const [mode, setMode] = useState<'gross' | 'net'>('gross');
  const [netStatus, setNetStatus] = useState<SoldProfitNetStatus | ''>('');
  // Sold-profit selections only make sense for the products view —
  // the invoices view doesn't expose variant_ids one-per-row.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const netSummaryQ = useQuery({
    queryKey: ['sold-profit-net-summary', from, to],
    queryFn: () =>
      reportsApi.soldProfitNetSummary({
        from: from || undefined,
        to: to || undefined,
      }),
    enabled: mode === 'net',
  });
  const netProductsQ = useQuery({
    queryKey: ['sold-profit-net-products', from, to, q, netStatus],
    queryFn: () =>
      reportsApi.soldProfitNetProducts({
        from: from || undefined,
        to: to || undefined,
        q: q.trim() || undefined,
        status: netStatus || undefined,
        limit: 1000,
      }),
    enabled: mode === 'net',
  });

  // Sold-profit's status enum (low_margin / loss / …) doesn't map to
  // SmartPricingStatusFilter, and its date filters don't apply to the
  // current-state smart-pricing scope. We pass only `q` so "filtered"
  // scope mirrors the visible search.
  const smartFilters = useMemo<SmartPricingScope['filters']>(() => {
    const f: SmartPricingScope['filters'] = {};
    if (q.trim()) f.q = q.trim();
    return f;
  }, [q]);

  const summaryQ = useQuery({
    queryKey: ['sold-profit-summary', from, to],
    queryFn: () =>
      reportsApi.soldProfitSummary({
        from: from || undefined,
        to: to || undefined,
      }),
  });
  const productsQ = useQuery({
    queryKey: ['sold-profit-products', from, to, q, status, sort],
    queryFn: () =>
      reportsApi.soldProfitProducts({
        from: from || undefined,
        to: to || undefined,
        q: q.trim() || undefined,
        status: status || undefined,
        sort,
        limit: 1000,
      }),
    enabled: view === 'products',
  });
  const invoicesQ = useQuery({
    queryKey: ['sold-profit-invoices', from, to, q, status],
    queryFn: () =>
      reportsApi.soldProfitInvoices({
        from: from || undefined,
        to: to || undefined,
        q: q.trim() || undefined,
        status: status || undefined,
        limit: 1000,
      }),
    enabled: view === 'invoices',
  });

  return (
    <div className="space-y-3">
      {/* Filter strip */}
      <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">
            من تاريخ
          </label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            data-testid="sold-profit-from"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">
            إلى تاريخ
          </label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            data-testid="sold-profit-to"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">
            بحث
          </label>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={
              view === 'products' ? 'بحث صنف / SKU' : 'بحث رقم فاتورة / عميل'
            }
            data-testid="sold-profit-search"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">
            الحالة
          </label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as SoldProfitStatus | '')}
            data-testid="sold-profit-status-filter"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">كل الحالات</option>
            <option value="ok">ربح صحي</option>
            <option value="low_margin">هامش منخفض</option>
            <option value="loss">خسارة</option>
            <option value="unknown_cost">تكلفة غير معروفة</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-bold text-slate-700 mb-1">
            العرض
          </label>
          <select
            value={view}
            onChange={(e) =>
              setView(e.target.value as 'products' | 'invoices')
            }
            data-testid="sold-profit-view-toggle"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          >
            <option value="products">حسب المنتج</option>
            <option value="invoices">حسب الفاتورة</option>
          </select>
        </div>
      </div>

      {/* P3.4D — Gross / Net mode toggle. Gross UI below stays as
          P3.4B/C; Net mounts a parallel block driven by net-summary +
          net-products endpoints. */}
      <div
        className="inline-flex rounded-lg border border-slate-200 overflow-hidden text-sm"
        role="tablist"
        data-testid="sold-profit-mode-toggle"
      >
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'gross'}
          onClick={() => setMode('gross')}
          className={`px-4 py-2 font-bold ${
            mode === 'gross'
              ? 'bg-amber-500 text-white'
              : 'bg-white text-slate-700 hover:bg-slate-50'
          }`}
          data-testid="sold-profit-mode-gross"
        >
          إجمالي Gross
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'net'}
          onClick={() => setMode('net')}
          className={`px-4 py-2 font-bold ${
            mode === 'net'
              ? 'bg-amber-500 text-white'
              : 'bg-white text-slate-700 hover:bg-slate-50'
          }`}
          data-testid="sold-profit-mode-net"
        >
          صافي بعد المرتجعات Net
        </button>
      </div>

      {mode === 'gross' && (
        <div
          className="text-[11px] text-slate-600 bg-amber-50 border border-amber-200 rounded p-2"
          data-testid="sold-profit-returns-notice"
        >
          ملاحظة: هذه الأرقام هي إجمالي المبيعات (Gross) — فواتير المرتجعات
          مستبعدة من الحساب لكنها لا تُخصم تلقائيًا. للحصول على صافي الربح
          بعد المرتجعات، فعّل وضع &quot;صافي بعد المرتجعات Net&quot; أعلاه.
        </div>
      )}
      {mode === 'net' && (
        <div
          className="text-[11px] text-slate-600 bg-sky-50 border border-sky-200 rounded p-2"
          data-testid="sold-profit-net-notice"
        >
          يتم نسب المرتجعات إلى تاريخ ردّ المبلغ (refunded_at) وليس تاريخ
          البيع الأصلي. مرتجع نوفمبر لفاتورة أكتوبر يُخصم من صافي ربح
          نوفمبر.
        </div>
      )}

      {mode === 'net' && (
        <NetSoldProfitBlock
          summary={netSummaryQ.data}
          isSummaryLoading={netSummaryQ.isLoading}
          products={netProductsQ.data?.items ?? []}
          isProductsLoading={netProductsQ.isLoading}
          netStatus={netStatus}
          onNetStatusChange={setNetStatus}
          from={from}
          to={to}
          q={q}
        />
      )}

      {mode === 'gross' && (<>
      {/* Summary export — one-row sheet pinned to the active date range. */}
      <div className="flex justify-end">
        <ExportButtons
          slug="pricing/sold-profit/summary"
          params={{
            from: from || undefined,
            to: to || undefined,
          }}
          testIdSuffix="sold-profit-summary"
        />
      </div>

      {/* Summary cards */}
      <SummaryStrip>
        <Tile
          label="إجمالي المبيعات"
          value={EGP(summaryQ.data?.total_revenue ?? 0)}
          accent="emerald"
        />
        <Tile
          label="تكلفة البضاعة المباعة"
          value={EGP(summaryQ.data?.total_cogs ?? 0)}
        />
        <Tile
          label="مجمل الربح"
          value={EGP(summaryQ.data?.gross_profit ?? 0)}
          accent={
            (summaryQ.data?.gross_profit ?? 0) >= 0 ? 'emerald' : 'rose'
          }
        />
        <Tile
          label="هامش الربح"
          value={PCT(summaryQ.data?.gross_margin_pct ?? null)}
        />
        <Tile
          label="عدد الفواتير"
          value={String(summaryQ.data?.invoice_count ?? 0)}
        />
        <Tile
          label="عدد القطع المباعة"
          value={String(summaryQ.data?.total_qty_sold ?? 0)}
        />
      </SummaryStrip>

      {(summaryQ.data?.top_profit_product || summaryQ.data?.worst_margin_product) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
          {summaryQ.data?.top_profit_product && (
            <div
              className="rounded-md border border-emerald-200 bg-emerald-50/40 p-2"
              data-testid="sold-profit-top"
            >
              <div className="text-[10px] text-slate-500 mb-0.5">
                أعلى ربح
              </div>
              <div className="font-bold">
                {summaryQ.data.top_profit_product.product_name}{' '}
                <span className="text-emerald-700">
                  ({EGP(summaryQ.data.top_profit_product.gross_profit)})
                </span>
              </div>
            </div>
          )}
          {summaryQ.data?.worst_margin_product && (
            <div
              className="rounded-md border border-rose-200 bg-rose-50/40 p-2"
              data-testid="sold-profit-worst"
            >
              <div className="text-[10px] text-slate-500 mb-0.5">
                أسوأ هامش ربح
              </div>
              <div className="font-bold">
                {summaryQ.data.worst_margin_product.product_name}{' '}
                <span className="text-rose-700">
                  ({PCT(summaryQ.data.worst_margin_product.gross_margin_pct)})
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Sort selector + selection toolbar + smart-pricing trigger —
          only meaningful for the products view */}
      {view === 'products' && (
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-3 flex-wrap">
            <label className="text-xs font-bold text-slate-700">ترتيب:</label>
            <select
              value={sort}
              onChange={(e) => setSort(e.target.value as SoldProfitSort)}
              data-testid="sold-profit-sort"
              className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
            >
              <option value="gross_profit_desc">الربح من الأعلى للأقل</option>
              <option value="gross_profit_asc">الربح من الأقل للأعلى</option>
              <option value="margin_desc">الهامش من الأعلى للأقل</option>
              <option value="margin_asc">الهامش من الأقل للأعلى</option>
              <option value="qty_desc">الكمية المباعة</option>
            </select>
            <SelectionToolbar
              selectedIds={selectedIds}
              onClear={() => setSelectedIds(new Set())}
            />
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <ExportButtons
              slug="pricing/sold-profit/products"
              params={{
                q: q.trim() || undefined,
                from: from || undefined,
                to: to || undefined,
                status: status || undefined,
                sort,
                limit: 1000,
              }}
              testIdSuffix="sold-profit-products"
            />
            <SmartPricingTrigger
              selectedVariantIds={selectedIds}
              filters={smartFilters}
              onApplied={() => setSelectedIds(new Set())}
              testIdSuffix="sold-profit"
            />
          </div>
        </div>
      )}
      {view === 'invoices' && (
        <div className="flex justify-end">
          <ExportButtons
            slug="pricing/sold-profit/invoices"
            params={{
              q: q.trim() || undefined,
              from: from || undefined,
              to: to || undefined,
              status: status || undefined,
              limit: 1000,
            }}
            testIdSuffix="sold-profit-invoices"
          />
        </div>
      )}

      {/* Table */}
      {view === 'products' ? (
        productsQ.isLoading ? (
          <div className="p-6 text-center text-slate-400">جاري التحميل...</div>
        ) : (
          <SoldProductsTable
            rows={productsQ.data?.items ?? []}
            selectedIds={selectedIds}
            onToggle={(id) =>
              setSelectedIds((s) => {
                const next = new Set(s);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return next;
              })
            }
            onToggleAll={(visibleIds) =>
              setSelectedIds((s) => toggleAllVisible(s, visibleIds))
            }
          />
        )
      ) : invoicesQ.isLoading ? (
        <div className="p-6 text-center text-slate-400">جاري التحميل...</div>
      ) : (
        <SoldInvoicesTable rows={invoicesQ.data?.items ?? []} />
      )}
      </>)}
    </div>
  );
}

/* ────────────────── P3.4D — Net-of-returns block ────────────────── */

const NET_STATUS_LABEL_AR: Record<SoldProfitNetStatus, string> = {
  ok: 'ربح صحي',
  low_margin: 'هامش منخفض',
  loss: 'خسارة',
  unknown: 'غير محدد',
};

const NET_STATUS_COLOR: Record<SoldProfitNetStatus, string> = {
  ok: 'bg-emerald-100 text-emerald-700',
  low_margin: 'bg-amber-100 text-amber-700',
  loss: 'bg-rose-100 text-rose-700',
  unknown: 'bg-slate-100 text-slate-700',
};

interface NetSoldProfitBlockProps {
  summary: import('@/api/reports.api').SoldProfitNetSummary | undefined;
  isSummaryLoading: boolean;
  products: SoldProfitNetProductRow[];
  isProductsLoading: boolean;
  netStatus: SoldProfitNetStatus | '';
  onNetStatusChange: (s: SoldProfitNetStatus | '') => void;
  from: string;
  to: string;
  q: string;
}

function NetSoldProfitBlock({
  summary,
  isSummaryLoading,
  products,
  isProductsLoading,
  netStatus,
  onNetStatusChange,
  from,
  to,
  q,
}: NetSoldProfitBlockProps) {
  return (
    <div className="space-y-3" data-testid="sold-profit-net-block">
      {/* Net summary export */}
      <div className="flex justify-end">
        <ExportButtons
          slug="pricing/sold-profit/net-summary"
          params={{
            from: from || undefined,
            to: to || undefined,
          }}
          testIdSuffix="sold-profit-net-summary"
        />
      </div>

      {/* Net summary cards — 8 tiles per spec. */}
      <div
        className="grid grid-cols-2 md:grid-cols-4 gap-2"
        data-testid="sold-profit-net-summary"
      >
        <Tile
          label="إجمالي المبيعات"
          value={EGP(summary?.gross_revenue ?? 0)}
        />
        <Tile
          label="إجمالي المرتجعات"
          value={EGP(summary?.returns_revenue ?? 0)}
          accent="rose"
        />
        <Tile
          label="صافي المبيعات"
          value={EGP(summary?.net_revenue ?? 0)}
          accent="emerald"
        />
        <Tile
          label="تكلفة المبيعات"
          value={EGP(summary?.gross_cogs ?? 0)}
        />
        <Tile
          label="تكلفة المرتجعات"
          value={EGP(summary?.returns_cogs ?? 0)}
          accent="rose"
        />
        <Tile
          label="صافي تكلفة البضاعة"
          value={EGP(summary?.net_cogs ?? 0)}
        />
        <Tile
          label="صافي الربح"
          value={EGP(summary?.net_profit ?? 0)}
          accent={(summary?.net_profit ?? 0) >= 0 ? 'emerald' : 'rose'}
        />
        <Tile
          label="هامش صافي الربح"
          value={PCT(summary?.net_margin_pct ?? null)}
        />
      </div>

      {isSummaryLoading && (
        <div className="text-xs text-slate-400">جاري تحميل الملخص...</div>
      )}

      {/* Status filter + products export */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <label className="text-xs font-bold text-slate-700">
            حالة صافي الربح:
          </label>
          <select
            value={netStatus}
            onChange={(e) =>
              onNetStatusChange(e.target.value as SoldProfitNetStatus | '')
            }
            data-testid="sold-profit-net-status-filter"
            className="border border-slate-200 rounded-lg px-3 py-2 text-sm"
          >
            <option value="">كل الحالات</option>
            <option value="ok">ربح صحي</option>
            <option value="low_margin">هامش منخفض</option>
            <option value="loss">خسارة</option>
            <option value="unknown">غير محدد</option>
          </select>
        </div>
        <ExportButtons
          slug="pricing/sold-profit/net-products"
          params={{
            q: q.trim() || undefined,
            from: from || undefined,
            to: to || undefined,
            status: netStatus || undefined,
            limit: 1000,
          }}
          testIdSuffix="sold-profit-net-products"
        />
      </div>

      {/* Net products table */}
      {isProductsLoading ? (
        <div className="p-6 text-center text-slate-400">جاري التحميل...</div>
      ) : (
        <NetProductsTable rows={products} />
      )}
    </div>
  );
}

function NetProductsTable({ rows }: { rows: SoldProfitNetProductRow[] }) {
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600 text-xs">
          <tr>
            <th className="p-2 text-right">المنتج</th>
            <th className="p-2 text-right">SKU</th>
            <th className="p-2 text-right">كمية مباعة</th>
            <th className="p-2 text-right">كمية مرتجعة</th>
            <th className="p-2 text-right">صافي الكمية</th>
            <th className="p-2 text-right">مبيعات</th>
            <th className="p-2 text-right">مرتجعات</th>
            <th className="p-2 text-right">صافي المبيعات</th>
            <th className="p-2 text-right">تكلفة مبيعات</th>
            <th className="p-2 text-right">تكلفة مرتجعات</th>
            <th className="p-2 text-right">صافي التكلفة</th>
            <th className="p-2 text-right">صافي الربح</th>
            <th className="p-2 text-right">هامش صافي الربح</th>
            <th className="p-2 text-right">الزيادة على التكلفة</th>
            <th className="p-2 text-right">الحالة</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={15} className="p-6 text-center text-slate-400">
                لا توجد بيانات صافية للفترة المحددة
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr
                key={r.variant_id}
                data-testid={`sold-profit-net-row-${r.variant_id}`}
              >
                <td className="p-2">
                  <div className="font-medium">{r.product_name}</div>
                  <div className="text-[10px] text-slate-400 font-mono">
                    {[r.color, r.size].filter(Boolean).join(' / ')}
                  </div>
                </td>
                <td className="p-2 font-mono text-xs">{r.sku}</td>
                <td className="p-2">{r.qty_sold}</td>
                <td className="p-2 text-rose-700">{r.qty_returned}</td>
                <td className="p-2 font-bold">{r.qty_net}</td>
                <td className="p-2">{EGP(r.sales_revenue)}</td>
                <td className="p-2 text-rose-700">
                  {EGP(r.returns_revenue)}
                </td>
                <td className="p-2 font-bold">{EGP(r.net_revenue)}</td>
                <td className="p-2">{EGP(r.sales_cogs)}</td>
                <td className="p-2 text-rose-700">{EGP(r.returns_cogs)}</td>
                <td className="p-2 font-bold">{EGP(r.net_cogs)}</td>
                <td
                  className={`p-2 font-bold ${
                    r.net_profit >= 0 ? 'text-emerald-700' : 'text-rose-700'
                  }`}
                >
                  {EGP(r.net_profit)}
                </td>
                <td className="p-2">{PCT(r.net_margin_pct)}</td>
                <td className="p-2">{PCT(r.net_markup_pct)}</td>
                <td className="p-2">
                  <span
                    className={`text-[10px] font-bold px-2 py-1 rounded ${NET_STATUS_COLOR[r.status]}`}
                  >
                    {NET_STATUS_LABEL_AR[r.status]}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

interface SoldProductsTableProps {
  rows: SoldProfitProductRow[];
  selectedIds: Set<string>;
  onToggle: (id: string) => void;
  onToggleAll: (visibleIds: string[]) => void;
}

function SoldProductsTable({
  rows,
  selectedIds,
  onToggle,
  onToggleAll,
}: SoldProductsTableProps) {
  const visibleIds = rows.map((r) => r.variant_id);
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600 text-xs">
          <tr>
            <th className="p-2">
              <SelectAllHeader
                visibleIds={visibleIds}
                selectedIds={selectedIds}
                onToggleAll={() => onToggleAll(visibleIds)}
              />
            </th>
            <th className="p-2 text-right">الصنف</th>
            <th className="p-2 text-right">SKU</th>
            <th className="p-2 text-right">كمية مباعة</th>
            <th className="p-2 text-right">المبيعات</th>
            <th className="p-2 text-right">تكلفة البضاعة</th>
            <th className="p-2 text-right">مجمل الربح</th>
            <th className="p-2 text-right">هامش الربح</th>
            <th className="p-2 text-right">الزيادة على التكلفة</th>
            <th className="p-2 text-right">آخر بيع</th>
            <th className="p-2 text-right">الحالة</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={11} className="p-6 text-center text-slate-400">
                لا توجد مبيعات في النطاق المختار
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr
                key={r.variant_id}
                data-testid={`sold-profit-product-row-${r.variant_id}`}
              >
                <td className="p-2">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(r.variant_id)}
                    onChange={() => onToggle(r.variant_id)}
                    data-testid={`pricing-row-select-${r.variant_id}`}
                  />
                </td>
                <td className="p-2">
                  <div className="font-medium">{r.product_name}</div>
                  <div className="text-[10px] text-slate-400 font-mono">
                    {[r.color, r.size].filter(Boolean).join(' / ')}
                  </div>
                </td>
                <td className="p-2 font-mono text-xs">{r.sku}</td>
                <td className="p-2">{r.qty_sold}</td>
                <td className="p-2">{EGP(r.revenue)}</td>
                <td className="p-2">{EGP(r.cogs)}</td>
                <td
                  className={`p-2 font-bold ${
                    r.gross_profit >= 0 ? 'text-emerald-700' : 'text-rose-700'
                  }`}
                >
                  {EGP(r.gross_profit)}
                </td>
                <td className="p-2">{PCT(r.gross_margin_pct)}</td>
                <td className="p-2">{PCT(r.markup_pct)}</td>
                <td className="p-2 text-[10px] text-slate-500">
                  {r.last_sold_at
                    ? new Date(r.last_sold_at).toLocaleDateString('en-US')
                    : '—'}
                </td>
                <td className="p-2">
                  <span
                    className={`text-[10px] font-bold px-2 py-1 rounded ${SOLD_STATUS_COLOR[r.status]}`}
                  >
                    {SOLD_STATUS_LABEL_AR[r.status]}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function SoldInvoicesTable({ rows }: { rows: SoldProfitInvoiceRow[] }) {
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600 text-xs">
          <tr>
            <th className="p-2 text-right">رقم الفاتورة</th>
            <th className="p-2 text-right">التاريخ</th>
            <th className="p-2 text-right">العميل</th>
            <th className="p-2 text-right">عدد الأصناف</th>
            <th className="p-2 text-right">عدد القطع</th>
            <th className="p-2 text-right">المبيعات</th>
            <th className="p-2 text-right">تكلفة البضاعة</th>
            <th className="p-2 text-right">مجمل الربح</th>
            <th className="p-2 text-right">هامش الربح</th>
            <th className="p-2 text-right">الحالة</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.length === 0 ? (
            <tr>
              <td colSpan={10} className="p-6 text-center text-slate-400">
                لا توجد فواتير في النطاق المختار
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr
                key={r.invoice_id}
                data-testid={`sold-profit-invoice-row-${r.invoice_id}`}
              >
                <td className="p-2 font-mono text-xs">{r.invoice_no}</td>
                <td className="p-2 text-xs">
                  {new Date(r.sold_at).toLocaleString('en-US')}
                </td>
                <td className="p-2 text-xs">{r.customer_name || '—'}</td>
                <td className="p-2">{r.item_count}</td>
                <td className="p-2">{r.qty_sold}</td>
                <td className="p-2">{EGP(r.revenue)}</td>
                <td className="p-2">{EGP(r.cogs)}</td>
                <td
                  className={`p-2 font-bold ${
                    r.gross_profit >= 0 ? 'text-emerald-700' : 'text-rose-700'
                  }`}
                >
                  {EGP(r.gross_profit)}
                </td>
                <td className="p-2">{PCT(r.gross_margin_pct)}</td>
                <td className="p-2">
                  <span
                    className={`text-[10px] font-bold px-2 py-1 rounded ${SOLD_STATUS_COLOR[r.status]}`}
                  >
                    {SOLD_STATUS_LABEL_AR[r.status]}
                  </span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

interface TileProps {
  label: string;
  value: string;
  accent?: 'emerald' | 'rose' | 'amber';
}

function Tile({ label, value, accent }: TileProps) {
  const color =
    accent === 'emerald'
      ? 'text-emerald-700 bg-emerald-50 border-emerald-200'
      : accent === 'rose'
        ? 'text-rose-700 bg-rose-50 border-rose-200'
        : accent === 'amber'
          ? 'text-amber-700 bg-amber-50 border-amber-200'
          : 'text-slate-800 bg-white border-slate-200';
  return (
    <div className={`rounded-md border p-2 ${color}`}>
      <div className="text-[10px] text-slate-500 mb-0.5">{label}</div>
      <div className="font-bold text-sm">{value}</div>
    </div>
  );
}

/* ────────────────── PR-P8.1 — Fair Price Report tab ────────────────── */

const FAIR_PRICE_BASIS_LABEL: Record<FairPriceAllocationBasis, string> = {
  revenue_share: 'حسب حصة الإيرادات',
  units_share: 'حسب عدد القطع المباعة',
  stock_value_share: 'حسب قيمة المخزون',
  flat_per_sku: 'موزّعة بالتساوي على كل صنف',
};

const FAIR_PRICE_SOURCE_LABEL: Record<FairPriceOverheadSource, string> = {
  actual_expenses: 'مصروفات فعلية في الفترة',
  recurring_monthly_equivalent: 'تقدير المصروفات الدورية',
};

const FAIR_PRICE_WARNING_LABEL: Record<string, string> = {
  cost_zero: 'التكلفة غير معروفة',
  no_sales_in_period: 'لا توجد مبيعات في الفترة',
  no_stock: 'لا يوجد مخزون',
};

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function FairPriceTab() {
  const [from, setFrom] = useState<string>(isoDaysAgo(30));
  const [to, setTo] = useState<string>(isoDaysAgo(0));
  const [basis, setBasis] =
    useState<FairPriceAllocationBasis>('revenue_share');
  const [source, setSource] =
    useState<FairPriceOverheadSource>('actual_expenses');
  // Target margin lives as text so the input is controllable; sent as
  // number to the API only when non-empty (lets the server fall back to
  // the smart_pricing.recommended_margin_pct setting otherwise).
  const [targetMarginText, setTargetMarginText] = useState<string>('');
  const [q, setQ] = useState<string>('');
  const [onlyInStock, setOnlyInStock] = useState<boolean>(false);
  const [onlyActive, setOnlyActive] = useState<boolean>(true);

  const params = useMemo<PricingFairPriceParams>(() => {
    const p: PricingFairPriceParams = {
      from,
      to,
      allocation_basis: basis,
      overhead_source: source,
      only_in_stock: onlyInStock || undefined,
      only_active: onlyActive,
      limit: 1000,
    };
    const tm = Number(targetMarginText);
    if (targetMarginText.trim() !== '' && Number.isFinite(tm)) {
      p.target_margin_pct = tm;
    }
    if (q.trim()) p.q = q.trim();
    return p;
  }, [from, to, basis, source, targetMarginText, q, onlyInStock, onlyActive]);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['pricing-fair-price', params],
    queryFn: () => reportsApi.pricingFairPrice(params),
    placeholderData: (prev) => prev,
  });

  // Surface server-side validation errors (e.g. target_margin > 94) as
  // a toast — but only once per error transition so the operator can
  // see what to fix.
  useEffect(() => {
    if (!isError) return;
    const msg = (error as any)?.response?.data?.message;
    if (msg) toast.error(String(msg));
  }, [isError, error]);

  const items = data?.items ?? [];
  const summary = data?.summary;

  const exportParams = useMemo(() => {
    const p: Record<string, any> = { ...params };
    // booleans → 'true'/'false' for the export URL; the existing
    // `reportsApi.export` helper passes params through as query string.
    if (onlyInStock) p.only_in_stock = true;
    return p;
  }, [params, onlyInStock]);

  return (
    <div className="space-y-3" data-testid="fair-price-tab">
      <div
        className="rounded-lg border border-rose-200 bg-rose-50/60 p-3 text-xs text-rose-900 leading-relaxed"
        data-testid="fair-price-advisory"
      >
        <b>تقرير استرشادي فقط.</b> لا يقوم بأي تعديل تلقائي على الأسعار، ولا
        يحرّك مخزون أو خزنة أو قيود محاسبية. الأرقام للاسترشاد فقط — قرار
        التسعير النهائي للمسؤول.
      </div>

      <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
        <div>
          <label className="text-[11px] text-slate-600 block mb-1">من</label>
          <input
            type="date"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            data-testid="fair-price-from"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-[11px] text-slate-600 block mb-1">إلى</label>
          <input
            type="date"
            value={to}
            onChange={(e) => setTo(e.target.value)}
            data-testid="fair-price-to"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-[11px] text-slate-600 block mb-1">
            توزيع التكاليف التشغيلية
          </label>
          <select
            value={basis}
            onChange={(e) =>
              setBasis(e.target.value as FairPriceAllocationBasis)
            }
            data-testid="fair-price-basis"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          >
            {(Object.keys(FAIR_PRICE_BASIS_LABEL) as FairPriceAllocationBasis[]).map(
              (k) => (
                <option key={k} value={k}>
                  {FAIR_PRICE_BASIS_LABEL[k]}
                </option>
              ),
            )}
          </select>
        </div>
        <div>
          <label className="text-[11px] text-slate-600 block mb-1">
            مصدر التكاليف
          </label>
          <select
            value={source}
            onChange={(e) =>
              setSource(e.target.value as FairPriceOverheadSource)
            }
            data-testid="fair-price-source"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          >
            {(Object.keys(FAIR_PRICE_SOURCE_LABEL) as FairPriceOverheadSource[]).map(
              (k) => (
                <option key={k} value={k}>
                  {FAIR_PRICE_SOURCE_LABEL[k]}
                </option>
              ),
            )}
          </select>
        </div>
        <div className="md:col-span-2">
          <label className="text-[11px] text-slate-600 block mb-1">
            بحث (اسم / SKU / باركود)
          </label>
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            data-testid="fair-price-search"
            placeholder="بحث"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div>
          <label className="text-[11px] text-slate-600 block mb-1">
            الهامش المستهدف %
          </label>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            max={94}
            step="0.1"
            value={targetMarginText}
            onChange={(e) => setTargetMarginText(e.target.value)}
            data-testid="fair-price-target-margin"
            placeholder="افتراضي من إعدادات التسعير"
            className="w-full border border-slate-200 rounded-lg px-3 py-2 text-sm"
          />
        </div>
        <div className="flex items-end gap-3">
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={onlyInStock}
              onChange={(e) => setOnlyInStock(e.target.checked)}
              data-testid="fair-price-only-in-stock"
            />
            <span>في المخزون فقط</span>
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={onlyActive}
              onChange={(e) => setOnlyActive(e.target.checked)}
              data-testid="fair-price-only-active"
            />
            <span>أصناف نشطة فقط</span>
          </label>
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 flex-wrap">
        <ExportButtons
          slug="pricing/fair-price"
          params={exportParams}
          testIdSuffix="fair-price"
        />
      </div>

      <SummaryStrip>
        <Tile
          label="إجمالي التكاليف التشغيلية"
          value={EGP(summary?.overhead_total ?? 0)}
        />
        <Tile
          label="عدد الأصناف تحت السعر العادل"
          value={String(summary?.variants_below_fair ?? 0)}
          accent={
            (summary?.variants_below_fair ?? 0) > 0 ? 'amber' : undefined
          }
        />
        <Tile
          label="إجمالي الفجوة عن السعر العادل"
          value={EGP(summary?.current_gap_total ?? 0)}
          accent={
            (summary?.current_gap_total ?? 0) > 0 ? 'rose' : undefined
          }
        />
        <Tile
          label="متوسط التكلفة التشغيلية / قطعة"
          value={EGP(summary?.average_overhead_per_unit ?? 0)}
        />
      </SummaryStrip>

      {summary?.truncated && summary?.message_ar && (
        <div
          className="rounded-md border border-amber-300 bg-amber-50 p-2 text-[12px] text-amber-800"
          data-testid="fair-price-truncated"
        >
          {summary.message_ar}
        </div>
      )}

      {isLoading ? (
        <div
          className="text-center text-slate-500 text-sm py-10"
          data-testid="fair-price-loading"
        >
          جاري الحساب…
        </div>
      ) : (
        <div className="border rounded-lg overflow-hidden">
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-[12px]">
              <thead className="bg-slate-50 text-slate-600 sticky top-0">
                <tr>
                  <th className="p-2 text-right">المنتج</th>
                  <th className="p-2 text-right">SKU</th>
                  <th className="p-2 text-left">الكمية المباعة</th>
                  <th className="p-2 text-left">الإيرادات</th>
                  <th className="p-2 text-left">سعر البيع الحالي</th>
                  <th className="p-2 text-left">التكلفة</th>
                  <th className="p-2 text-left">نصيب التكاليف</th>
                  <th className="p-2 text-left">تكلفة تشغيلية / قطعة</th>
                  <th className="p-2 text-left">سعر التعادل</th>
                  <th className="p-2 text-left">السعر العادل</th>
                  <th className="p-2 text-left">الفرق</th>
                  <th className="p-2 text-left">هامش قبل</th>
                  <th className="p-2 text-left">هامش بعد</th>
                  <th className="p-2 text-right">ملاحظة</th>
                </tr>
              </thead>
              <tbody>
                {items.map((r: PricingFairPriceRow) => (
                  <tr
                    key={r.variant_id}
                    data-testid={`fair-price-row-${r.variant_id}`}
                    className={
                      r.gap_to_fair > 0
                        ? 'bg-rose-50/30'
                        : r.gap_to_fair < 0
                          ? 'bg-emerald-50/20'
                          : ''
                    }
                  >
                    <td className="p-2 text-right font-bold">
                      {r.product_name}
                    </td>
                    <td className="p-2 text-right font-mono text-[11px]">
                      {r.sku}
                    </td>
                    <td className="p-2 text-left">
                      {r.units_sold_in_period.toLocaleString('en-US')}
                    </td>
                    <td className="p-2 text-left">
                      {EGP(r.revenue_in_period)}
                    </td>
                    <td className="p-2 text-left">
                      {EGP(r.current_selling_price)}
                    </td>
                    <td className="p-2 text-left">
                      {EGP(r.current_cost_price)}
                    </td>
                    <td className="p-2 text-left">{EGP(r.overhead_share)}</td>
                    <td className="p-2 text-left">
                      {EGP(r.overhead_per_unit)}
                    </td>
                    <td className="p-2 text-left">
                      {EGP(r.break_even_price)}
                    </td>
                    <td className="p-2 text-left font-bold">
                      {EGP(r.fair_price)}
                    </td>
                    <td
                      className={`p-2 text-left ${
                        r.gap_to_fair > 0
                          ? 'text-rose-700'
                          : r.gap_to_fair < 0
                            ? 'text-emerald-700'
                            : ''
                      }`}
                    >
                      {EGP(r.gap_to_fair)}
                    </td>
                    <td className="p-2 text-left">
                      {PCT(r.current_margin_pct)}
                    </td>
                    <td className="p-2 text-left">
                      {PCT(r.margin_after_overhead_pct)}
                    </td>
                    <td className="p-2 text-right text-[11px] text-amber-700">
                      {r.warning
                        ? (FAIR_PRICE_WARNING_LABEL[r.warning] ?? r.warning)
                        : ''}
                    </td>
                  </tr>
                ))}
                {items.length === 0 && !isLoading && (
                  <tr>
                    <td
                      colSpan={14}
                      className="p-6 text-center text-slate-500"
                    >
                      لا توجد بيانات لعرضها — جرّب توسيع الفترة أو إزالة
                      الفلاتر.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
