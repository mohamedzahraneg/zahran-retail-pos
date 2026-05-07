/**
 * Zakat — PR-FE-ACCOUNTING-ZAKAT-FRAMING
 * ────────────────────────────────────────────────────────────────────
 *
 * Framing / planning shell for the upcoming Zakat module. Renders an
 * empty-state version of the future workspace so the operator can see
 * the structure (pool, components, configuration, CTAs) before any of
 * the calculation logic ships.
 *
 * Strict guarantees (mirrored from PR-FIN-3):
 *   · ZERO writes — no mutation calls, no journal entries, no
 *     cashbox transactions, no migrations
 *   · ZERO engine touches — does not import or call FinancialEngine
 *   · ZERO API calls in this PR — all numeric cards render as
 *     dashes (—) and an empty-state strip; no fake numbers
 *   · ZERO formula changes — the displayed default rate (2.5%) is a
 *     visual literal only, not consumed by any calculation path
 *   · CTAs render disabled with "قريبًا" pills, mirroring the
 *     placeholder convention used by PR-FIN-3 / PR-FIN-7
 *
 * Permission gate (handled at the route level):
 *   `finance.dashboard.view` — admin gets it via the `*` wildcard;
 *   manager / accountant inherit per the existing sidebar entry.
 */

import { useMemo } from 'react';
import {
  AlertTriangle,
  Banknote,
  BookOpen,
  Calculator,
  CalendarRange,
  FileSpreadsheet,
  HandCoins,
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

interface PoolComponentSpec {
  key: string;
  label: string;
  source_ar: string;
  icon: typeof Wallet;
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
  },
  {
    key: 'bank_wallet',
    label: 'البنوك والمحافظ',
    source_ar: 'مصدر مقترح: أرصدة الحسابات البنكية والمحافظ الإلكترونية',
    icon: Banknote,
  },
  {
    key: 'inventory',
    label: 'المخزون',
    source_ar: 'مصدر مقترح: تكلفة المخزون المتاح للبيع',
    icon: Layers,
  },
  {
    key: 'receivables',
    label: 'الذمم المدينة',
    source_ar: 'مصدر مقترح: أرصدة العملاء النشطة المؤهلة',
    icon: BookOpen,
  },
  {
    key: 'liabilities',
    label: 'الالتزامات المؤهلة للخصم',
    source_ar: 'مصدر مقترح: أرصدة الموردين والمصاريف المستحقة',
    icon: Receipt,
  },
];

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
  // useMemo on a static literal — keeps the array reference stable so
  // any future re-render that maps over it doesn't churn keys.
  const kpis = useMemo(() => KPI_CARDS, []);

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
          {POOL_COMPONENTS.map((p) => {
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
              </li>
            );
          })}
        </ul>
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
              title="متاح في تحديث لاحق"
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
