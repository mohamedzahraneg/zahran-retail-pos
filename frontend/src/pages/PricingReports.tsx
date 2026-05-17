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
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  TrendingDown,
  TrendingUp,
  AlertTriangle,
  Clock,
  Package,
  History as HistoryIcon,
} from 'lucide-react';
import {
  reportsApi,
  type PricingHealthRow,
  type PricingHistoryRow,
  type PricingLandedImpactRow,
  type PricingLossRow,
  type PricingStatus,
} from '@/api/reports.api';

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

type Tab = 'health' | 'losses' | 'history' | 'landed';

const TABS: { key: Tab; label: string; icon: any }[] = [
  { key: 'health', label: 'صحة الأسعار', icon: TrendingUp },
  { key: 'losses', label: 'منتجات تحت الحد / خاسرة', icon: TrendingDown },
  { key: 'history', label: 'تاريخ تغيير الأسعار', icon: HistoryIcon },
  { key: 'landed', label: 'أثر آخر مشتريات', icon: Package },
];

export default function PricingReports() {
  const [tab, setTab] = useState<Tab>('health');
  return (
    <div className="space-y-4" dir="rtl" data-testid="pricing-reports-page">
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

      <div className="bg-white rounded-xl border border-slate-200 shadow-sm">
        <div className="flex flex-wrap gap-2 p-3 border-b border-slate-200">
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

        <div className="p-4">
          {tab === 'health' && <HealthTab />}
          {tab === 'losses' && <LossesTab />}
          {tab === 'history' && <HistoryTab />}
          {tab === 'landed' && <LandedImpactTab />}
        </div>
      </div>
    </div>
  );
}

/* ────────────────── Health tab (Report A) ────────────────── */

function HealthTab() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<PricingStatus | ''>('');
  const [onlyInStock, setOnlyInStock] = useState(false);

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
        <HealthTable rows={data?.items ?? []} />
      )}
    </div>
  );
}

function HealthTable({ rows }: { rows: PricingHealthRow[] }) {
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600 text-xs">
          <tr>
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
              <td colSpan={9} className="p-6 text-center text-slate-400">
                لا توجد بيانات للعرض
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.variant_id} data-testid={`pricing-health-row-${r.variant_id}`}>
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
  const { data, isLoading } = useQuery({
    queryKey: ['pricing-losses', onlyInStock],
    queryFn: () =>
      reportsApi.pricingLosses({ only_in_stock: onlyInStock, limit: 1000 }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={onlyInStock}
            onChange={(e) => setOnlyInStock(e.target.checked)}
            data-testid="pricing-losses-only-in-stock"
          />
          الأصناف في المخزون فقط
        </label>
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
        <LossesTable rows={data?.items ?? []} />
      )}
    </div>
  );
}

function LossesTable({ rows }: { rows: PricingLossRow[] }) {
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600 text-xs">
          <tr>
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
              <td colSpan={10} className="p-6 text-center text-slate-400">
                <AlertTriangle className="w-5 h-5 inline-block ml-2 text-emerald-500" />
                لا توجد منتجات تحت الحد الأدنى
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.variant_id} data-testid={`pricing-loss-row-${r.variant_id}`}>
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
  const { data, isLoading } = useQuery({
    queryKey: ['pricing-landed-impact', needsReviewOnly],
    queryFn: () =>
      reportsApi.pricingLandedImpact({
        needs_review_only: needsReviewOnly,
        limit: 1000,
      }),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={needsReviewOnly}
            onChange={(e) => setNeedsReviewOnly(e.target.checked)}
            data-testid="pricing-landed-needs-review-only"
          />
          عرض المنتجات التي تحتاج مراجعة سعر فقط
        </label>
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
        <LandedTable rows={data?.items ?? []} />
      )}
    </div>
  );
}

function LandedTable({ rows }: { rows: PricingLandedImpactRow[] }) {
  return (
    <div className="overflow-x-auto border border-slate-200 rounded-lg">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600 text-xs">
          <tr>
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
              <td colSpan={10} className="p-6 text-center text-slate-400">
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

