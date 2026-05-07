/**
 * FinancialReports — PR-FE-ACCOUNTING-FINANCIAL-REPORTS-FRAMING
 * ────────────────────────────────────────────────────────────────────
 *
 * Framing / planning shell for the upcoming Financial Reports
 * workspace. Renders an empty-state version of the future page
 * (KPI cards, statement sections, operational links, readiness
 * matrix, CTAs) so the operator can see the structure before any
 * of the report-generation logic ships.
 *
 * Strict guarantees (mirrored from PR-FIN-3 / Zakat framing):
 *   · ZERO writes — no JE, no CT, no migrations, no engine touches
 *   · ZERO API calls — page imports zero @/api clients
 *   · ZERO formula changes — no calculations performed
 *   · ZERO fake numbers — every monetary / status cell renders the
 *     em-dash placeholder ("—") or the literal Arabic strings
 *     "غير مفعل" / "قريبًا"
 *   · CTAs render disabled with "قريبًا" pills
 *
 * Permission gate (handled at the route level):
 *   `finance.dashboard.view` — admin gets it via the `*` wildcard;
 *   manager / accountant inherit per the existing sidebar entry.
 */

import { useMemo } from 'react';
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ClipboardList,
  Coins,
  FileSpreadsheet,
  FileText,
  Layers,
  PieChart,
  Receipt,
  Scale,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
} from 'lucide-react';

/** Visual placeholder for any monetary / numeric KPI. */
const EMPTY = '—';

/** Status literal used in the readiness matrix. Never rendered as a
 * computed value — pure string. */
const STATUS_NOT_WIRED = 'غير مفعل';

interface ReportCardSpec {
  key: string;
  label: string;
  icon: typeof PieChart;
  tone: 'brand' | 'emerald' | 'rose' | 'amber' | 'indigo';
  hint: string;
}

interface StatementRowSpec {
  key: string;
  label: string;
  description_ar: string;
  icon: typeof Scale;
}

interface OperationalLinkSpec {
  key: string;
  label: string;
  source_ar: string;
  icon: typeof Wallet;
}

interface ReadinessRowSpec {
  key: string;
  report_label: string;
  required_data_ar: string;
  data_source_ar: string;
  status_ar: string;
  next_action_ar: string;
}

interface CtaSpec {
  key: string;
  label: string;
  icon: typeof FileText;
  description: string;
}

const REPORT_CARDS: ReportCardSpec[] = [
  {
    key: 'trial-balance',
    label: 'ميزان المراجعة',
    icon: Scale,
    tone: 'brand',
    hint: 'إجمالي المدين والدائن مع الرصيد لكل حساب',
  },
  {
    key: 'income-statement',
    label: 'قائمة الدخل',
    icon: TrendingUp,
    tone: 'emerald',
    hint: 'الإيرادات والمصروفات وصافي الربح للفترة',
  },
  {
    key: 'balance-sheet',
    label: 'الميزانية العمومية',
    icon: Layers,
    tone: 'indigo',
    hint: 'الأصول والخصوم وحقوق الملكية كما في تاريخ',
  },
  {
    key: 'cash-flows',
    label: 'التدفقات النقدية',
    icon: Coins,
    tone: 'amber',
    hint: 'الحركة النقدية التشغيلية والاستثمارية والتمويلية',
  },
  {
    key: 'zakat-tax',
    label: 'تقرير الزكاة والضريبة',
    icon: PieChart,
    tone: 'rose',
    hint: 'الوعاء الزكوي والاستحقاقات الضريبية المخططة',
  },
];

const STATEMENT_ROWS: StatementRowSpec[] = [
  {
    key: 'trial-balance',
    label: 'ميزان المراجعة',
    description_ar: 'تجميع أرصدة كل الحسابات مع تحقق توازن المدين والدائن',
    icon: Scale,
  },
  {
    key: 'income-statement',
    label: 'قائمة الدخل',
    description_ar: 'الإيرادات ناقص المصروفات لتحديد صافي الربح أو الخسارة',
    icon: TrendingUp,
  },
  {
    key: 'balance-sheet',
    label: 'الميزانية العمومية',
    description_ar: 'تركيبة الأصول والخصوم وحقوق الملكية في نقطة زمنية',
    icon: Layers,
  },
  {
    key: 'cash-flows',
    label: 'التدفقات النقدية',
    description_ar: 'مصادر واستخدامات النقد عبر الأنشطة الثلاثة',
    icon: Coins,
  },
];

const OPERATIONAL_LINKS: OperationalLinkSpec[] = [
  {
    key: 'cashboxes',
    label: 'الخزائن والبنوك',
    source_ar: 'مصدر مقترح: أرصدة الخزائن وحسابات البنوك والمحافظ',
    icon: Wallet,
  },
  {
    key: 'expenses',
    label: 'المصروفات',
    source_ar: 'مصدر مقترح: المصروفات اليومية والدورية',
    icon: Receipt,
  },
  {
    key: 'customers-suppliers',
    label: 'العملاء والموردين',
    source_ar: 'مصدر مقترح: أرصدة الذمم المدينة والدائنة',
    icon: Users,
  },
  {
    key: 'inventory',
    label: 'المخزون والجرد',
    source_ar: 'مصدر مقترح: تكلفة المخزون وفروقات الجرد الفعلي',
    icon: Layers,
  },
  {
    key: 'payroll',
    label: 'الموظفين والرواتب',
    source_ar: 'مصدر مقترح: الأجور المستحقة والمدفوعة وحركات الكشوف',
    icon: TrendingDown,
  },
];

const READINESS_ROWS: ReadinessRowSpec[] = [
  {
    key: 'trial-balance',
    report_label: 'ميزان المراجعة',
    required_data_ar: 'دليل الحسابات + قيود اليومية',
    data_source_ar: 'journal_entries + journal_lines',
    status_ar: STATUS_NOT_WIRED,
    next_action_ar: 'ربط مصدر البيانات في PR لاحق',
  },
  {
    key: 'income-statement',
    report_label: 'قائمة الدخل',
    required_data_ar: 'حسابات الإيرادات والمصروفات للفترة',
    data_source_ar: 'journal_lines (Income / Expense classes)',
    status_ar: STATUS_NOT_WIRED,
    next_action_ar: 'تعريف فترات المقارنة + هيكل القائمة',
  },
  {
    key: 'balance-sheet',
    report_label: 'الميزانية العمومية',
    required_data_ar: 'أرصدة الأصول والخصوم وحقوق الملكية',
    data_source_ar: 'journal_lines (Asset / Liability / Equity)',
    status_ar: STATUS_NOT_WIRED,
    next_action_ar: 'تحديد تاريخ المرجع + قواعد التجميع',
  },
  {
    key: 'cash-flows',
    report_label: 'التدفقات النقدية',
    required_data_ar: 'حركات الخزائن والبنوك مع تصنيف النشاط',
    data_source_ar: 'cashbox_transactions + journal_lines',
    status_ar: STATUS_NOT_WIRED,
    next_action_ar: 'تصنيف الحركات تشغيلية / استثمارية / تمويلية',
  },
  {
    key: 'zakat-tax',
    report_label: 'تقرير الزكاة والضريبة',
    required_data_ar: 'الوعاء الزكوي + الاستحقاقات الضريبية',
    data_source_ar: 'صفحة الزكاة (PR-FE-ACCOUNTING-ZAKAT-FRAMING)',
    status_ar: STATUS_NOT_WIRED,
    next_action_ar: 'تثبيت قواعد الزكاة قبل توليد التقرير',
  },
];

const CTAS: CtaSpec[] = [
  {
    key: 'generate',
    label: 'توليد تقرير',
    icon: Sparkles,
    description: 'إنشاء تقرير ضمن الفترة المختارة بعد ربط المصادر.',
  },
  {
    key: 'export-pdf',
    label: 'تصدير PDF',
    icon: FileText,
    description: 'تنزيل التقرير النهائي بصيغة PDF جاهزة للطباعة.',
  },
  {
    key: 'export-excel',
    label: 'تصدير Excel',
    icon: FileSpreadsheet,
    description: 'تنزيل التقرير ببيانات تفصيلية قابلة للتحليل.',
  },
  {
    key: 'approve',
    label: 'اعتماد التقرير',
    icon: CheckCircle2,
    description: 'اعتماد التقرير ضمن دورة المراجعة المحاسبية.',
  },
];

const TONE_BG: Record<ReportCardSpec['tone'], string> = {
  brand: 'bg-brand-50 text-brand-700',
  emerald: 'bg-emerald-50 text-emerald-700',
  rose: 'bg-rose-50 text-rose-700',
  amber: 'bg-amber-50 text-amber-700',
  indigo: 'bg-indigo-50 text-indigo-700',
};

export function FinancialReports() {
  // Stable references — same pattern used in Zakat.tsx.
  const cards = useMemo(() => REPORT_CARDS, []);
  const statements = useMemo(() => STATEMENT_ROWS, []);
  const operational = useMemo(() => OPERATIONAL_LINKS, []);
  const readiness = useMemo(() => READINESS_ROWS, []);

  return (
    <div
      className="p-4 lg:p-6 space-y-5"
      dir="rtl"
      data-testid="financial-reports-page"
    >
      {/* ── Header ────────────────────────────────────────────────── */}
      <header
        className="flex items-start justify-between gap-3 flex-wrap"
        data-testid="financial-reports-header"
      >
        <div className="order-1 flex items-start gap-3">
          <div className="w-12 h-12 rounded-2xl bg-brand-50 text-brand-700 flex items-center justify-center shrink-0">
            <PieChart size={24} />
          </div>
          <div className="text-right">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl lg:text-2xl font-black text-slate-900">
                التقارير المالية
              </h1>
              <span
                className="text-[10px] font-bold rounded-full bg-amber-100 text-amber-800 border border-amber-200 px-2 py-0.5"
                data-testid="financial-reports-stage-badge"
              >
                مرحلة التوطير
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1 max-w-xl">
              تجميع تقارير الأداء المالي والقوائم المحاسبية قبل تفعيل
              التصدير والاعتماد.
            </p>
          </div>
        </div>
      </header>

      {/* ── Framing notice (page is read-only) ─────────────────────── */}
      <div
        className="rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3 flex items-start gap-3"
        data-testid="financial-reports-framing-notice"
      >
        <AlertTriangle
          size={18}
          className="text-amber-600 shrink-0 mt-0.5"
        />
        <div className="text-[12px] text-amber-900 leading-relaxed">
          هذه الصفحة للتأطير والمراجعة فقط. لا يتم إنشاء قيود أو اعتماد
          تقارير من هنا حاليًا.
        </div>
      </div>

      {/* ── KPI cards (5 reports) ──────────────────────────────────── */}
      <section
        className="grid grid-cols-2 lg:grid-cols-5 gap-3"
        data-testid="financial-reports-kpis"
      >
        {cards.map((c) => {
          const Icon = c.icon;
          return (
            <div
              key={c.key}
              className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              data-testid={`financial-reports-kpi-${c.key}`}
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
                {EMPTY}
              </div>
              <div className="mt-1 text-[10px] text-slate-400 leading-snug">
                {c.hint}
              </div>
            </div>
          );
        })}
      </section>

      {/* ── Accounting statements ──────────────────────────────────── */}
      <section
        className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
        data-testid="financial-reports-statements"
      >
        <div className="flex items-center gap-2">
          <BookOpen size={18} className="text-slate-500" />
          <h2 className="text-sm font-black text-slate-800">
            القوائم المحاسبية
          </h2>
          <span className="text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5">
            مخطط — غير منفّذ
          </span>
        </div>
        <ul className="divide-y divide-slate-100">
          {statements.map((s) => {
            const Icon = s.icon;
            return (
              <li
                key={s.key}
                className="flex items-center justify-between gap-3 py-3"
                data-testid={`financial-reports-statement-${s.key}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-slate-50 text-slate-500 flex items-center justify-center shrink-0">
                    <Icon size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[12px] font-bold text-slate-800">
                      {s.label}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {s.description_ar}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  disabled
                  aria-disabled="true"
                  title="متاح في تحديث لاحق"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white text-slate-400 border border-dashed border-slate-200 px-2.5 py-1.5 text-[10px] font-bold cursor-not-allowed shrink-0"
                  data-testid={`financial-reports-statement-drilldown-${s.key}`}
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

      {/* ── Operational links ──────────────────────────────────────── */}
      <section
        className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
        data-testid="financial-reports-operational"
      >
        <div className="flex items-center gap-2">
          <ClipboardList size={18} className="text-slate-500" />
          <h2 className="text-sm font-black text-slate-800">
            تقارير تشغيلية مرتبطة
          </h2>
          <span className="text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5">
            مخطط — غير منفّذ
          </span>
        </div>
        <ul className="divide-y divide-slate-100">
          {operational.map((o) => {
            const Icon = o.icon;
            return (
              <li
                key={o.key}
                className="flex items-center justify-between gap-3 py-3"
                data-testid={`financial-reports-operational-${o.key}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-slate-50 text-slate-500 flex items-center justify-center shrink-0">
                    <Icon size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[12px] font-bold text-slate-800">
                      {o.label}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {o.source_ar}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  disabled
                  aria-disabled="true"
                  title="متاح في تحديث لاحق"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white text-slate-400 border border-dashed border-slate-200 px-2.5 py-1.5 text-[10px] font-bold cursor-not-allowed shrink-0"
                  data-testid={`financial-reports-operational-drilldown-${o.key}`}
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

      {/* ── Report readiness matrix ────────────────────────────────── */}
      <section
        className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
        data-testid="financial-reports-readiness"
      >
        <div className="flex items-center gap-2">
          <Sparkles size={18} className="text-slate-500" />
          <h2 className="text-sm font-black text-slate-800">
            جاهزية التقرير
          </h2>
          <span className="text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5">
            قريبًا
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]" dir="rtl">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-right p-2 font-bold">التقرير</th>
                <th className="text-right p-2 font-bold">البيانات المطلوبة</th>
                <th className="text-right p-2 font-bold">مصدر البيانات</th>
                <th className="text-right p-2 font-bold">حالة الربط</th>
                <th className="text-right p-2 font-bold">الإجراء القادم</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {readiness.map((r) => (
                <tr
                  key={r.key}
                  data-testid={`financial-reports-readiness-${r.key}`}
                >
                  <td className="p-2 font-bold text-slate-800 whitespace-nowrap">
                    {r.report_label}
                  </td>
                  <td className="p-2 text-slate-600">
                    {r.required_data_ar}
                  </td>
                  <td className="p-2 text-slate-500 font-mono text-[10px]">
                    {r.data_source_ar}
                  </td>
                  <td className="p-2">
                    <span
                      className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-600 px-2 py-0.5 text-[10px] font-bold"
                      data-testid={`financial-reports-readiness-status-${r.key}`}
                    >
                      {r.status_ar}
                    </span>
                  </td>
                  <td className="p-2 text-slate-500">{r.next_action_ar}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Non-executive CTAs ─────────────────────────────────────── */}
      <section
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3"
        data-testid="financial-reports-ctas"
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
              data-testid={`financial-reports-cta-${c.key}`}
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

export default FinancialReports;
