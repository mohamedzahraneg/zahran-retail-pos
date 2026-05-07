/**
 * Zakat — PR-FE-ACCOUNTING-ZAKAT-FRAMING (header)
 *      + PR-FE-ACCOUNTING-ZAKAT-DATA-SOURCES (this PR)
 * ────────────────────────────────────────────────────────────────────
 *
 * Read-only data-source readiness page for the upcoming Zakat module.
 * Renders the future workspace shell (pool components, configuration,
 * KPIs, CTAs) PLUS a "جاهزية مصادر الوعاء الزكوي" matrix that
 * classifies each pool component as available / partial / missing
 * against existing read-only APIs in this codebase.
 *
 * Strict guarantees (preserved from the framing PR + reinforced):
 *   · ZERO writes — no mutation calls, no journal entries, no
 *     cashbox transactions, no migrations
 *   · ZERO engine touches — does not import or call FinancialEngine
 *   · ZERO API calls — page imports zero @/api clients (we
 *     deliberately stayed off `useQuery` even for safe read-only
 *     endpoints; the readiness matrix surfaces source classification
 *     without surfacing any aggregate number that could be misread
 *     as a "zakat pool". When business approves wiring real source-
 *     data balances, a follow-up PR will add the queries one source
 *     at a time.)
 *   · ZERO formula changes — the displayed default rate (2.5%) is a
 *     visual literal only, not consumed by any calculation path
 *   · ZERO final zakat amounts — the 5 KPI cards stay at "—"; the
 *     readiness matrix surfaces source status text only
 *   · CTAs render disabled with "قريبًا" pills, tooltip updated to
 *     "يتطلب اعتماد مصادر البيانات أولًا"
 *   · Pool drilldowns become active <Link>s ONLY for the 4
 *     sources where a real read-only operational route exists in
 *     this app (cashboxes / customers / suppliers); inventory stays
 *     disabled because no aggregate-valuation page exists today
 *
 * Permission gate (handled at the route level):
 *   `finance.dashboard.view` — admin gets it via the `*` wildcard;
 *   manager / accountant inherit per the existing sidebar entry.
 */

import { useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  Banknote,
  BookOpen,
  Calculator,
  CalendarRange,
  Database,
  FileSpreadsheet,
  HandCoins,
  Info,
  Layers,
  PieChart,
  Receipt,
  Settings as SettingsIcon,
  Sparkles,
  Wallet,
} from 'lucide-react';

const ZAKAT_RATE_DEFAULT_PCT = 2.5;

/** Visual placeholder for any monetary KPI. NEVER a numeric literal. */
const EMPTY = '—';

interface KpiCardSpec {
  key: string;
  label: string;
  value: string;
  icon: typeof HandCoins;
  tone: 'brand' | 'emerald' | 'rose' | 'amber' | 'indigo';
  hint: string;
}

/**
 * Drill-down metadata for a pool-component row.
 *
 * `route` is set ONLY for components that have a real read-only
 * operational route in this app today. When `route` is null the row
 * keeps the disabled "قريبًا" button (no fake link).
 */
interface PoolComponentSpec {
  key: string;
  label: string;
  source_ar: string;
  icon: typeof Wallet;
  route: string | null;
}

/**
 * Status of a data source feeding the zakat pool.
 *
 *   · 'available' — endpoint exists, is in production use, and maps
 *     unambiguously to this pool component.
 *   · 'partial'   — data exists somewhere, but either the endpoint
 *     isn't in production use yet, or the value needs additional
 *     classification / aggregation before it's safe to surface.
 *   · 'missing'   — no aggregate API exists today; needs a backend
 *     PR before this row can carry a number.
 */
type SourceStatus = 'available' | 'partial' | 'missing';

interface ReadinessRowSpec {
  key: string;
  component_label: string;
  data_source_ar: string;
  status: SourceStatus;
  confidence_ar: string;
  next_action_ar: string;
}

interface CtaSpec {
  key: string;
  label: string;
  icon: typeof SettingsIcon;
  description: string;
}

const KPI_CARDS: KpiCardSpec[] = [
  {
    key: 'pool',
    label: 'وعاء الزكاة',
    value: EMPTY,
    icon: HandCoins,
    tone: 'brand',
    hint: 'إجمالي الأصول الزكوية بعد خصم الالتزامات',
  },
  {
    key: 'assets',
    label: 'الأصول الزكوية',
    value: EMPTY,
    icon: Layers,
    tone: 'emerald',
    hint: 'النقدية والمخزون والذمم المؤهلة للزكاة',
  },
  {
    key: 'liabilities',
    label: 'الالتزامات المخصومة',
    value: EMPTY,
    icon: Receipt,
    tone: 'rose',
    hint: 'الديون والالتزامات الجائز خصمها من الوعاء',
  },
  {
    key: 'rate',
    label: 'نسبة الزكاة',
    // The "2.5%" string here is a visual default surfaced so the
    // operator can see what the future rule will read FROM. It is NOT
    // wired to any calculation today — no function reads this literal.
    value: `${ZAKAT_RATE_DEFAULT_PCT}%`,
    icon: PieChart,
    tone: 'indigo',
    hint: 'النسبة الافتراضية المقترحة (قابلة للتعديل لاحقًا)',
  },
  {
    key: 'estimated',
    label: 'الزكاة المقدّرة',
    value: EMPTY,
    icon: Calculator,
    tone: 'amber',
    hint: 'تُحتسب لاحقًا بعد ضبط قواعد الوعاء والحول',
  },
];

const POOL_COMPONENTS: PoolComponentSpec[] = [
  {
    key: 'cash',
    label: 'النقدية والخزائن',
    source_ar: 'مصدر مقترح: أرصدة الخزائن النقدية',
    icon: Wallet,
    // PR-FE-ACCOUNTING-ZAKAT-DATA-SOURCES — /cashboxes is the
    // unified treasury page used by 17+ files in production.
    route: '/cashboxes',
  },
  {
    key: 'bank_wallet',
    label: 'البنوك والمحافظ',
    source_ar: 'مصدر مقترح: أرصدة الحسابات البنكية والمحافظ الإلكترونية',
    icon: Banknote,
    // Same operational page (cashboxes carries the kind: bank /
    // ewallet / check classification).
    route: '/cashboxes',
  },
  {
    key: 'inventory',
    label: 'المخزون',
    source_ar: 'مصدر مقترح: تكلفة المخزون المتاح للبيع',
    icon: Layers,
    // No aggregate inventory-valuation page exists in this app
    // today (`/products` is the catalog, `/stock-adjustments` is
    // operational — neither surfaces a total cost). Keep the row
    // disabled rather than route the user to a misleading page.
    route: null,
  },
  {
    key: 'receivables',
    label: 'الذمم المدينة',
    source_ar: 'مصدر مقترح: أرصدة العملاء النشطة المؤهلة',
    icon: BookOpen,
    // /customers carries the per-customer current_balance column
    // and a "Pay" entry-point; safe read-only destination.
    route: '/customers',
  },
  {
    key: 'liabilities',
    label: 'الالتزامات المؤهلة للخصم',
    source_ar: 'مصدر مقترح: أرصدة الموردين والمصاريف المستحقة',
    icon: Receipt,
    // /suppliers carries supplier outstanding (used by the page
    // itself); accrued-expense liabilities are not yet surfaced
    // anywhere — readiness matrix flags this as "partial".
    route: '/suppliers',
  },
];

/**
 * Source-readiness classification per pool component. Pure static
 * data — never mutated, never derived from a live API call. The
 * field values describe the *current* state of the codebase as of
 * PR-FE-ACCOUNTING-ZAKAT-DATA-SOURCES; future backend work will
 * flip rows from "partial"/"missing" to "available".
 */
const READINESS_ROWS: ReadinessRowSpec[] = [
  {
    key: 'cash',
    component_label: 'النقدية والخزائن',
    data_source_ar: 'cashDeskApi.cashboxes (kind=cash)',
    status: 'available',
    confidence_ar: 'مرتفع — مصدر مستخدم في الإنتاج',
    next_action_ar: 'الربط الفعلي يحتاج اعتماد قواعد التجميع',
  },
  {
    key: 'bank_wallet',
    component_label: 'البنوك والمحافظ',
    data_source_ar: 'cashDeskApi.cashboxes (kind=bank/ewallet/check)',
    status: 'partial',
    // GL codes (1113 / 1114 / 1115) intentionally NOT inlined here —
    // the readiness matrix must stay digit-free so the "no fake
    // numbers" guard can match the whole tbody. The technical
    // grouping rule is documented in cash-desk.api.ts:29-41.
    confidence_ar: 'متوسط — current_balance غير معتمد لغير النقدية',
    next_action_ar: 'تجميع رصيد المحاسبة العام لكل نوع قبل الربط',
  },
  {
    key: 'inventory',
    component_label: 'المخزون',
    data_source_ar: 'لا يوجد — مطلوب endpoint تقييم مخزون',
    status: 'missing',
    confidence_ar: 'منخفض — لا توجد API تقييم اليوم',
    next_action_ar: 'PR لاحق يضيف backend endpoint للتقييم',
  },
  {
    key: 'receivables',
    component_label: 'الذمم المدينة',
    data_source_ar: 'customersApi.outstanding',
    status: 'partial',
    confidence_ar: 'متوسط — endpoint موجود لكن غير مستخدم في الإنتاج',
    next_action_ar: 'تثبيت شكل الاستجابة + استهلاك في صفحة العملاء أولًا',
  },
  {
    key: 'liabilities',
    component_label: 'الالتزامات المؤهلة للخصم',
    data_source_ar: 'suppliersApi.outstanding (جزء من الصورة فقط)',
    status: 'partial',
    confidence_ar: 'متوسط — لا يشمل المصروفات والأجور المستحقة',
    next_action_ar: 'إضافة مصادر مكمّلة قبل اعتماد الخصم',
  },
];

/** Visual styling for each status. Pure presentational — no logic. */
const STATUS_PILL: Record<SourceStatus, { label: string; className: string }> = {
  available: {
    label: 'جاهز للربط',
    className: 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  },
  partial: {
    label: 'جزئي',
    className: 'bg-amber-50 text-amber-700 border border-amber-200',
  },
  missing: {
    label: 'غير مربوط',
    className: 'bg-slate-50 text-slate-500 border border-slate-200',
  },
};

const CTAS: CtaSpec[] = [
  {
    key: 'setup-rules',
    label: 'إعداد قواعد الزكاة',
    icon: SettingsIcon,
    description: 'تحديد المكونات المؤهلة، نسبة الزكاة، وحدود النصاب.',
  },
  {
    key: 'dry-run',
    label: 'حساب تجريبي',
    icon: Calculator,
    description: 'اختبار محاكاة دون إنشاء قيد محاسبي أو حركة خزينة.',
  },
  {
    key: 'export-report',
    label: 'تصدير تقرير الزكاة',
    icon: FileSpreadsheet,
    description: 'تنزيل تقرير الوعاء الزكوي والمكوّنات بصيغة Excel أو PDF.',
  },
];

const TONE_BG: Record<KpiCardSpec['tone'], string> = {
  brand: 'bg-brand-50 text-brand-700',
  emerald: 'bg-emerald-50 text-emerald-700',
  rose: 'bg-rose-50 text-rose-700',
  amber: 'bg-amber-50 text-amber-700',
  indigo: 'bg-indigo-50 text-indigo-700',
};

export function Zakat() {
  // useMemo on static literals — keeps the array references stable
  // so any future re-render that maps over them doesn't churn keys.
  const kpis = useMemo(() => KPI_CARDS, []);
  const pool = useMemo(() => POOL_COMPONENTS, []);
  const readiness = useMemo(() => READINESS_ROWS, []);

  return (
    <div
      className="p-4 lg:p-6 space-y-5"
      dir="rtl"
      data-testid="zakat-page"
    >
      {/* ── Header ────────────────────────────────────────────────── */}
      <header
        className="flex items-start justify-between gap-3 flex-wrap"
        data-testid="zakat-header"
      >
        <div className="order-1 flex items-start gap-3">
          <div className="w-12 h-12 rounded-2xl bg-brand-50 text-brand-700 flex items-center justify-center shrink-0">
            <HandCoins size={24} />
          </div>
          <div className="text-right">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl lg:text-2xl font-black text-slate-900">
                الزكاة
              </h1>
              <span
                className="text-[10px] font-bold rounded-full bg-amber-100 text-amber-800 border border-amber-200 px-2 py-0.5"
                data-testid="zakat-stage-badge"
              >
                مرحلة التوطير
              </span>
              {/* PR-FE-ACCOUNTING-ZAKAT-DATA-SOURCES — secondary
                  badge announcing the new readiness focus. Visual
                  only; carries no semantic state. */}
              <span
                className="inline-flex items-center gap-1 text-[10px] font-bold rounded-full bg-indigo-50 text-indigo-700 border border-indigo-200 px-2 py-0.5"
                data-testid="zakat-data-sources-badge"
              >
                <Database size={10} />
                ربط مصادر البيانات
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1 max-w-xl">
              إدارة احتساب الزكاة ومراجعة الوعاء الزكوي قبل الاعتماد.
            </p>
          </div>
        </div>
      </header>

      {/* ── Framing notice (page is read-only) ─────────────────────── */}
      <div
        className="rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3 flex items-start gap-3"
        data-testid="zakat-framing-notice"
      >
        <AlertTriangle
          size={18}
          className="text-amber-600 shrink-0 mt-0.5"
        />
        <div className="text-[12px] text-amber-900 leading-relaxed">
          هذه الصفحة للتأطير والمراجعة فقط. لا يتم إنشاء قيود أو اعتماد
          مبالغ من هنا حاليًا.
        </div>
      </div>

      {/* ── Secondary notice — source data clarification ──────────── */}
      <div
        className="rounded-2xl border border-indigo-100 bg-indigo-50/50 px-4 py-3 flex items-start gap-3"
        data-testid="zakat-source-data-notice"
      >
        <Info size={16} className="text-indigo-500 shrink-0 mt-0.5" />
        <div className="text-[11px] text-indigo-900 leading-relaxed">
          الأرقام المعروضة — إن وجدت — تمثل مصادر بيانات أولية ولا تمثل
          وعاءً زكويًا معتمدًا.
        </div>
      </div>

      {/* ── KPI cards ──────────────────────────────────────────────── */}
      <section
        className="grid grid-cols-2 lg:grid-cols-5 gap-3"
        data-testid="zakat-kpis"
      >
        {kpis.map((c) => {
          const Icon = c.icon;
          return (
            <div
              key={c.key}
              className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              data-testid={`zakat-kpi-${c.key}`}
            >
              <div className="flex items-center justify-between gap-2">
                <div
                  className={`w-9 h-9 rounded-xl flex items-center justify-center ${TONE_BG[c.tone]}`}
                >
                  <Icon size={18} />
                </div>
              </div>
              <div className="mt-3 text-[11px] font-bold text-slate-500">
                {c.label}
              </div>
              <div className="mt-1 text-xl font-black text-slate-900 tabular-nums">
                {c.value}
              </div>
              <div className="mt-1 text-[10px] text-slate-400 leading-snug">
                {c.hint}
              </div>
            </div>
          );
        })}
      </section>

      {/* ── Settings preview ───────────────────────────────────────── */}
      <section
        className="rounded-2xl border border-slate-200 bg-white p-5 space-y-4"
        data-testid="zakat-settings"
      >
        <div className="flex items-center gap-2">
          <SettingsIcon size={18} className="text-slate-500" />
          <h2 className="text-sm font-black text-slate-800">
            إعدادات الزكاة
          </h2>
          <span className="text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5">
            قريبًا
          </span>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <SettingRow
            icon={PieChart}
            label="نسبة الزكاة الافتراضية"
            value={`${ZAKAT_RATE_DEFAULT_PCT}%`}
            note="قابلة للتعديل من إعدادات الزكاة المستقبلية"
          />
          <SettingRow
            icon={CalendarRange}
            label="بداية / نهاية الحول"
            value={EMPTY}
            note="يُحدَّد ضمن دورة الإعداد القادمة"
          />
          <SettingRow
            icon={Sparkles}
            label="طريقة الاحتساب"
            value={EMPTY}
            note="نقدية / مختلطة — يُحدَّد لاحقًا"
          />
        </div>
      </section>

      {/* ── Pool components ────────────────────────────────────────── */}
      <section
        className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
        data-testid="zakat-pool-components"
      >
        <div className="flex items-center gap-2">
          <Layers size={18} className="text-slate-500" />
          <h2 className="text-sm font-black text-slate-800">
            مكونات الوعاء
          </h2>
          <span className="text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5">
            مخطط — غير منفّذ
          </span>
        </div>
        <ul className="divide-y divide-slate-100">
          {pool.map((p) => {
            const Icon = p.icon;
            return (
              <li
                key={p.key}
                className="flex items-center justify-between gap-3 py-3"
                data-testid={`zakat-pool-${p.key}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-slate-50 text-slate-500 flex items-center justify-center shrink-0">
                    <Icon size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[12px] font-bold text-slate-800">
                      {p.label}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {p.source_ar}
                    </div>
                  </div>
                </div>
                {p.route ? (
                  // Active drilldown — links to an existing
                  // operational page. NavLink intentionally NOT used:
                  // a plain Link gives us a non-active <a> with no
                  // mutation surface. Read-only navigation only.
                  <Link
                    to={p.route}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-white text-slate-700 border border-slate-200 hover:border-brand-300 hover:text-brand-700 px-2.5 py-1.5 text-[10px] font-bold shrink-0 transition"
                    data-testid={`zakat-pool-drilldown-${p.key}`}
                  >
                    استعراض المصدر
                  </Link>
                ) : (
                  // No safe drilldown — keep the disabled button so
                  // the operator isn't routed to a misleading page.
                  <button
                    type="button"
                    disabled
                    aria-disabled="true"
                    title="متاح في تحديث لاحق"
                    className="inline-flex items-center gap-1.5 rounded-lg bg-white text-slate-400 border border-dashed border-slate-200 px-2.5 py-1.5 text-[10px] font-bold cursor-not-allowed shrink-0"
                    data-testid={`zakat-pool-drilldown-${p.key}`}
                  >
                    استعراض
                    <span className="text-[8px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5 leading-none">
                      قريبًا
                    </span>
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {/* ── Data-source readiness matrix ───────────────────────────── */}
      <section
        className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
        data-testid="zakat-readiness"
      >
        <div className="flex items-center gap-2">
          <Database size={18} className="text-slate-500" />
          <h2 className="text-sm font-black text-slate-800">
            جاهزية مصادر الوعاء الزكوي
          </h2>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]" dir="rtl">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-right p-2 font-bold">المكوّن</th>
                <th className="text-right p-2 font-bold">مصدر البيانات</th>
                <th className="text-right p-2 font-bold">حالة الربط</th>
                <th className="text-right p-2 font-bold">مستوى الثقة</th>
                <th className="text-right p-2 font-bold">الإجراء القادم</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {readiness.map((r) => {
                const pill = STATUS_PILL[r.status];
                return (
                  <tr
                    key={r.key}
                    data-testid={`zakat-readiness-${r.key}`}
                  >
                    <td className="p-2 font-bold text-slate-800 whitespace-nowrap">
                      {r.component_label}
                    </td>
                    <td className="p-2 text-slate-600 font-mono text-[10px]">
                      {r.data_source_ar}
                    </td>
                    <td className="p-2">
                      <span
                        className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold ${pill.className}`}
                        data-testid={`zakat-readiness-status-${r.key}`}
                      >
                        {pill.label}
                      </span>
                    </td>
                    <td className="p-2 text-slate-500">
                      {r.confidence_ar}
                    </td>
                    <td className="p-2 text-slate-500">
                      {r.next_action_ar}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Non-executive CTAs ─────────────────────────────────────── */}
      <section
        className="grid grid-cols-1 md:grid-cols-3 gap-3"
        data-testid="zakat-ctas"
      >
        {CTAS.map((c) => {
          const Icon = c.icon;
          return (
            <button
              key={c.key}
              type="button"
              disabled
              aria-disabled="true"
              // PR-FE-ACCOUNTING-ZAKAT-DATA-SOURCES — tooltip
              // updated to reflect the new readiness gate.
              title="يتطلب اعتماد مصادر البيانات أولًا"
              className="rounded-2xl border border-dashed border-slate-200 bg-white p-4 text-right opacity-70 cursor-not-allowed flex items-start gap-3"
              data-testid={`zakat-cta-${c.key}`}
            >
              <div className="w-10 h-10 rounded-xl bg-slate-50 text-slate-500 flex items-center justify-center shrink-0">
                <Icon size={18} />
              </div>
              <div className="min-w-0 text-right">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-[12px] font-black text-slate-700">
                    {c.label}
                  </span>
                  <span className="text-[9px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5 leading-none">
                    قريبًا
                  </span>
                </div>
                <div className="text-[10px] text-slate-400 leading-snug mt-1">
                  {c.description}
                </div>
              </div>
            </button>
          );
        })}
      </section>
    </div>
  );
}

function SettingRow({
  icon: Icon,
  label,
  value,
  note,
}: {
  icon: typeof SettingsIcon;
  label: string;
  value: string;
  note: string;
}) {
  return (
    <div className="rounded-xl border border-slate-100 bg-slate-50/50 p-3">
      <div className="flex items-center gap-2">
        <Icon size={14} className="text-slate-400" />
        <div className="text-[11px] font-bold text-slate-600">{label}</div>
      </div>
      <div className="mt-2 text-base font-black text-slate-900 tabular-nums">
        {value}
      </div>
      <div className="mt-1 text-[10px] text-slate-400 leading-snug">{note}</div>
    </div>
  );
}

export default Zakat;
