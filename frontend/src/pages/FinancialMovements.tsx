/**
 * FinancialMovements — PR-FE-ACCOUNTING-FINANCIAL-MOVEMENTS-FRAMING
 * ────────────────────────────────────────────────────────────────────
 *
 * Framing / planning shell for the upcoming Financial Movements
 * tracking workspace. Renders an empty-state version of the future
 * page (KPI cards, tracking paths, source families, link-status
 * matrix, CTAs) so the operator can see the structure before any
 * of the audit-trail logic ships.
 *
 * Strict guarantees (mirrored from PR #325 Zakat / PR #326
 * FinancialReports framing):
 *   · ZERO writes — no JE, no CT, no migrations, no engine touches
 *   · ZERO reverse / void / approve / post actions
 *   · ZERO API calls — page imports zero @/api clients
 *   · ZERO formula changes — no calculations performed
 *   · ZERO fake numbers — every monetary slot is "—"; every status
 *     cell is the literal Arabic string "غير مفعل"
 *   · CTAs render disabled with "قريبًا" pills
 *
 * Permission gate (handled at the route level):
 *   `finance.dashboard.view` — admin gets it via the `*` wildcard;
 *   manager / accountant inherit per the existing sidebar entry.
 */

import { useMemo } from 'react';
import {
  AlertTriangle,
  ArrowRightLeft,
  BookOpen,
  ClipboardList,
  Coins,
  FileSearch,
  FileSpreadsheet,
  History,
  Layers,
  Receipt,
  ReceiptText,
  ShieldAlert,
  Sparkles,
  Truck,
  Undo2,
  Users,
  Wallet,
} from 'lucide-react';

/** Visual placeholder for any monetary / numeric KPI. */
const EMPTY = '—';

/** Status literal used in the link-status matrix. Pure string — never
 *  rendered as a computed value. */
const STATUS_NOT_WIRED = 'غير مفعل';

interface KpiCardSpec {
  key: string;
  label: string;
  icon: typeof History;
  tone: 'brand' | 'emerald' | 'rose' | 'amber' | 'indigo';
  hint: string;
}

interface TrackingPathSpec {
  key: string;
  from_label: string;
  to_label: string;
  description_ar: string;
  icon: typeof ArrowRightLeft;
}

interface SourceFamilySpec {
  key: string;
  label: string;
  source_ar: string;
  icon: typeof Wallet;
}

interface LinkStatusRowSpec {
  key: string;
  source_label: string;
  journal_status_ar: string;
  cashbox_status_ar: string;
  inventory_status_ar: string;
  review_status_ar: string;
}

interface CtaSpec {
  key: string;
  label: string;
  icon: typeof FileSearch;
  description: string;
}

const KPI_CARDS: KpiCardSpec[] = [
  {
    key: 'today',
    label: 'حركات اليوم',
    icon: History,
    tone: 'brand',
    hint: 'إجمالي الحركات المالية المسجلة في اليوم الحالي',
  },
  {
    key: 'needs-review',
    label: 'حركات بحاجة لمراجعة',
    icon: ShieldAlert,
    tone: 'amber',
    hint: 'حركات معلّقة أو فيها استثناءات تحتاج فحصًا يدويًا',
  },
  {
    key: 'linked-journals',
    label: 'قيود مرتبطة',
    icon: BookOpen,
    tone: 'indigo',
    hint: 'القيود المحاسبية المرتبطة بهذه الحركات',
  },
  {
    key: 'linked-cashbox',
    label: 'حركات خزينة مرتبطة',
    icon: Wallet,
    tone: 'emerald',
    hint: 'حركات الخزائن والبنوك المرتبطة بنفس المصدر',
  },
  {
    key: 'linked-inventory',
    label: 'حركات مخزون مرتبطة',
    icon: Layers,
    tone: 'rose',
    hint: 'حركات المخزون الناتجة عن الفواتير والمرتجعات والجرد',
  },
];

const TRACKING_PATHS: TrackingPathSpec[] = [
  {
    key: 'invoice-to-journal',
    from_label: 'الفاتورة',
    to_label: 'القيد',
    description_ar:
      'تحقق أن كل فاتورة مبيعات أنتجت قيدًا محاسبيًا متوازنًا',
    icon: ReceiptText,
  },
  {
    key: 'payment-to-cashbox',
    from_label: 'الدفعة',
    to_label: 'الخزينة',
    description_ar:
      'تحقق أن كل دفعة عميل/مورد ولّدت حركة خزينة مقابلة',
    icon: Wallet,
  },
  {
    key: 'return-to-reverse',
    from_label: 'المرتجع',
    to_label: 'العكس المحاسبي',
    description_ar:
      'تحقق أن كل مرتجع أنتج قيدًا عكسيًا وسحبًا/إعادة للمخزون',
    icon: Undo2,
  },
  {
    key: 'count-to-stock-movement',
    from_label: 'الجرد',
    to_label: 'حركة المخزون',
    description_ar:
      'تحقق أن فروقات الجرد الفعلي ولّدت حركات تسوية مرئية',
    icon: Layers,
  },
  {
    key: 'payroll-to-employee-entry',
    from_label: 'الرواتب',
    to_label: 'قيد الموظف',
    description_ar:
      'تحقق أن قيد الراتب وصل إلى أرصدة الموظف ودفتره',
    icon: Users,
  },
];

const SOURCE_FAMILIES: SourceFamilySpec[] = [
  {
    key: 'sales',
    label: 'المبيعات',
    source_ar: 'مصدر مقترح: فواتير POS وفواتير المبيعات',
    icon: ReceiptText,
  },
  {
    key: 'returns',
    label: 'المرتجعات',
    source_ar: 'مصدر مقترح: مرتجعات العملاء ومرتجعات المشتريات',
    icon: Undo2,
  },
  {
    key: 'expenses',
    label: 'المصروفات',
    source_ar: 'مصدر مقترح: المصروفات اليومية والمصاريف الدورية',
    icon: Receipt,
  },
  {
    key: 'purchases',
    label: 'المشتريات',
    source_ar: 'مصدر مقترح: فواتير الموردين ودفعاتها',
    icon: Truck,
  },
  {
    key: 'cashboxes',
    label: 'الخزائن',
    source_ar: 'مصدر مقترح: حركات الخزائن والبنوك والمحافظ',
    icon: Wallet,
  },
  {
    key: 'inventory',
    label: 'المخزون',
    source_ar: 'مصدر مقترح: تسويات المخزون وتحويلاته والجرد',
    icon: Layers,
  },
  {
    key: 'payroll',
    label: 'الموظفين والرواتب',
    source_ar: 'مصدر مقترح: حضور وأجور وعلاوات وخصومات الموظفين',
    icon: Users,
  },
];

const LINK_STATUS_ROWS: LinkStatusRowSpec[] = [
  {
    key: 'sales',
    source_label: 'المبيعات',
    journal_status_ar: STATUS_NOT_WIRED,
    cashbox_status_ar: STATUS_NOT_WIRED,
    inventory_status_ar: STATUS_NOT_WIRED,
    review_status_ar: STATUS_NOT_WIRED,
  },
  {
    key: 'returns',
    source_label: 'المرتجعات',
    journal_status_ar: STATUS_NOT_WIRED,
    cashbox_status_ar: STATUS_NOT_WIRED,
    inventory_status_ar: STATUS_NOT_WIRED,
    review_status_ar: STATUS_NOT_WIRED,
  },
  {
    key: 'expenses',
    source_label: 'المصروفات',
    journal_status_ar: STATUS_NOT_WIRED,
    cashbox_status_ar: STATUS_NOT_WIRED,
    inventory_status_ar: STATUS_NOT_WIRED,
    review_status_ar: STATUS_NOT_WIRED,
  },
  {
    key: 'purchases',
    source_label: 'المشتريات',
    journal_status_ar: STATUS_NOT_WIRED,
    cashbox_status_ar: STATUS_NOT_WIRED,
    inventory_status_ar: STATUS_NOT_WIRED,
    review_status_ar: STATUS_NOT_WIRED,
  },
  {
    key: 'cashboxes',
    source_label: 'الخزائن',
    journal_status_ar: STATUS_NOT_WIRED,
    cashbox_status_ar: STATUS_NOT_WIRED,
    inventory_status_ar: STATUS_NOT_WIRED,
    review_status_ar: STATUS_NOT_WIRED,
  },
  {
    key: 'inventory',
    source_label: 'المخزون',
    journal_status_ar: STATUS_NOT_WIRED,
    cashbox_status_ar: STATUS_NOT_WIRED,
    inventory_status_ar: STATUS_NOT_WIRED,
    review_status_ar: STATUS_NOT_WIRED,
  },
  {
    key: 'payroll',
    source_label: 'الموظفين والرواتب',
    journal_status_ar: STATUS_NOT_WIRED,
    cashbox_status_ar: STATUS_NOT_WIRED,
    inventory_status_ar: STATUS_NOT_WIRED,
    review_status_ar: STATUS_NOT_WIRED,
  },
];

const CTAS: CtaSpec[] = [
  {
    key: 'trace-movement',
    label: 'تتبع حركة',
    icon: FileSearch,
    description: 'عرض شجرة الحركة من المصدر حتى القيد والخزينة والمخزون.',
  },
  {
    key: 'open-review-log',
    label: 'فتح سجل المراجعة',
    icon: ClipboardList,
    description: 'استعراض سجل التغييرات والمراجعات الخاصة بالحركة.',
  },
  {
    key: 'export-trace',
    label: 'تصدير أثر الحركة',
    icon: FileSpreadsheet,
    description: 'تنزيل تقرير مفصّل بأثر الحركة عبر الأنظمة المرتبطة.',
  },
  {
    key: 'view-exceptions',
    label: 'عرض الاستثناءات',
    icon: ShieldAlert,
    description: 'حركات بدون قيد مقابل أو فروقات في الربط.',
  },
];

const TONE_BG: Record<KpiCardSpec['tone'], string> = {
  brand: 'bg-brand-50 text-brand-700',
  emerald: 'bg-emerald-50 text-emerald-700',
  rose: 'bg-rose-50 text-rose-700',
  amber: 'bg-amber-50 text-amber-700',
  indigo: 'bg-indigo-50 text-indigo-700',
};

export function FinancialMovements() {
  // Stable references — same pattern used in Zakat.tsx /
  // FinancialReports.tsx.
  const kpis = useMemo(() => KPI_CARDS, []);
  const paths = useMemo(() => TRACKING_PATHS, []);
  const sources = useMemo(() => SOURCE_FAMILIES, []);
  const links = useMemo(() => LINK_STATUS_ROWS, []);

  return (
    <div
      className="p-4 lg:p-6 space-y-5"
      dir="rtl"
      data-testid="financial-movements-page"
    >
      {/* ── Header ────────────────────────────────────────────────── */}
      <header
        className="flex items-start justify-between gap-3 flex-wrap"
        data-testid="financial-movements-header"
      >
        <div className="order-1 flex items-start gap-3">
          <div className="w-12 h-12 rounded-2xl bg-brand-50 text-brand-700 flex items-center justify-center shrink-0">
            <History size={24} />
          </div>
          <div className="text-right">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl lg:text-2xl font-black text-slate-900">
                تتبع الحركات المالية
              </h1>
              <span
                className="text-[10px] font-bold rounded-full bg-amber-100 text-amber-800 border border-amber-200 px-2 py-0.5"
                data-testid="financial-movements-stage-badge"
              >
                مرحلة التوطير
              </span>
            </div>
            <p className="text-xs text-slate-500 mt-1 max-w-xl">
              مراجعة مسار الحركة المالية من المصدر التشغيلي حتى القيد
              والخزينة والمخزون.
            </p>
          </div>
        </div>
      </header>

      {/* ── Framing notice (page is read-only) ─────────────────────── */}
      <div
        className="rounded-2xl border border-amber-200 bg-amber-50/70 px-4 py-3 flex items-start gap-3"
        data-testid="financial-movements-framing-notice"
      >
        <AlertTriangle
          size={18}
          className="text-amber-600 shrink-0 mt-0.5"
        />
        <div className="text-[12px] text-amber-900 leading-relaxed">
          هذه الصفحة للتأطير والمراجعة فقط. لا يتم إنشاء أو تعديل أو
          عكس أي حركة مالية من هنا حاليًا.
        </div>
      </div>

      {/* ── KPI cards (5) ──────────────────────────────────────────── */}
      <section
        className="grid grid-cols-2 lg:grid-cols-5 gap-3"
        data-testid="financial-movements-kpis"
      >
        {kpis.map((c) => {
          const Icon = c.icon;
          return (
            <div
              key={c.key}
              className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"
              data-testid={`financial-movements-kpi-${c.key}`}
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

      {/* ── Tracking paths ─────────────────────────────────────────── */}
      <section
        className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
        data-testid="financial-movements-paths"
      >
        <div className="flex items-center gap-2">
          <ArrowRightLeft size={18} className="text-slate-500" />
          <h2 className="text-sm font-black text-slate-800">
            مسارات التتبع
          </h2>
          <span className="text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5">
            مخطط — غير منفّذ
          </span>
        </div>
        <ul className="divide-y divide-slate-100">
          {paths.map((p) => {
            const Icon = p.icon;
            return (
              <li
                key={p.key}
                className="flex items-center justify-between gap-3 py-3"
                data-testid={`financial-movements-path-${p.key}`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-8 h-8 rounded-lg bg-slate-50 text-slate-500 flex items-center justify-center shrink-0">
                    <Icon size={16} />
                  </div>
                  <div className="min-w-0">
                    <div className="text-[12px] font-bold text-slate-800 flex items-center gap-1">
                      <span>من {p.from_label}</span>
                      <ArrowRightLeft size={10} className="text-slate-400" />
                      <span>إلى {p.to_label}</span>
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {p.description_ar}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  disabled
                  aria-disabled="true"
                  title="متاح في تحديث لاحق"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white text-slate-400 border border-dashed border-slate-200 px-2.5 py-1.5 text-[10px] font-bold cursor-not-allowed shrink-0"
                  data-testid={`financial-movements-path-drilldown-${p.key}`}
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

      {/* ── Source families ────────────────────────────────────────── */}
      <section
        className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
        data-testid="financial-movements-sources"
      >
        <div className="flex items-center gap-2">
          <Coins size={18} className="text-slate-500" />
          <h2 className="text-sm font-black text-slate-800">
            مصادر الحركة
          </h2>
          <span className="text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5">
            مخطط — غير منفّذ
          </span>
        </div>
        <ul className="divide-y divide-slate-100">
          {sources.map((s) => {
            const Icon = s.icon;
            return (
              <li
                key={s.key}
                className="flex items-center justify-between gap-3 py-3"
                data-testid={`financial-movements-source-${s.key}`}
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
                      {s.source_ar}
                    </div>
                  </div>
                </div>
                <button
                  type="button"
                  disabled
                  aria-disabled="true"
                  title="متاح في تحديث لاحق"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-white text-slate-400 border border-dashed border-slate-200 px-2.5 py-1.5 text-[10px] font-bold cursor-not-allowed shrink-0"
                  data-testid={`financial-movements-source-drilldown-${s.key}`}
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

      {/* ── Link status matrix ─────────────────────────────────────── */}
      <section
        className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
        data-testid="financial-movements-link-status"
      >
        <div className="flex items-center gap-2">
          <Sparkles size={18} className="text-slate-500" />
          <h2 className="text-sm font-black text-slate-800">
            حالة الربط
          </h2>
          <span className="text-[10px] font-bold rounded-full bg-slate-100 text-slate-500 px-1.5 py-0.5">
            قريبًا
          </span>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-[11px]" dir="rtl">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="text-right p-2 font-bold">المصدر</th>
                <th className="text-right p-2 font-bold">القيد</th>
                <th className="text-right p-2 font-bold">الخزينة</th>
                <th className="text-right p-2 font-bold">المخزون</th>
                <th className="text-right p-2 font-bold">حالة المراجعة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {links.map((r) => (
                <tr
                  key={r.key}
                  data-testid={`financial-movements-link-status-${r.key}`}
                >
                  <td className="p-2 font-bold text-slate-800 whitespace-nowrap">
                    {r.source_label}
                  </td>
                  <td className="p-2">
                    <StatusChip
                      label={r.journal_status_ar}
                      testid={`financial-movements-link-journal-${r.key}`}
                    />
                  </td>
                  <td className="p-2">
                    <StatusChip
                      label={r.cashbox_status_ar}
                      testid={`financial-movements-link-cashbox-${r.key}`}
                    />
                  </td>
                  <td className="p-2">
                    <StatusChip
                      label={r.inventory_status_ar}
                      testid={`financial-movements-link-inventory-${r.key}`}
                    />
                  </td>
                  <td className="p-2">
                    <StatusChip
                      label={r.review_status_ar}
                      testid={`financial-movements-link-review-${r.key}`}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* ── Non-executive CTAs ─────────────────────────────────────── */}
      <section
        className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3"
        data-testid="financial-movements-ctas"
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
              data-testid={`financial-movements-cta-${c.key}`}
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

function StatusChip({
  label,
  testid,
}: {
  label: string;
  testid: string;
}) {
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full bg-slate-100 text-slate-600 px-2 py-0.5 text-[10px] font-bold"
      data-testid={testid}
    >
      {label}
    </span>
  );
}

export default FinancialMovements;
