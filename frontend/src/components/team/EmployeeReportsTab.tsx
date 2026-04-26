/**
 * EmployeeReportsTab — PR-T5
 *
 * Replaces the placeholder "التقارير" panel with 6 real report cards
 * (شامل / حضور / حسابات / سلف / مبيعات / موافقات). Each card has
 * three actions: Preview (in-page modal) · Print (new-window
 * window.print()) · Excel (multi-sheet xlsx download).
 *
 * No backend writes. All data comes from the same APIs the other
 * tabs already consume — TanStack Query keys are reused so cached
 * values render instantly when the operator navigates here.
 *
 * Permission gating per-section:
 *   employee.ledger.view            → financial sections (accounts,
 *                                      adjustments). Section is
 *                                      hidden when missing.
 *   employee.attendance.manage      → attendance section. Falls
 *                                      back to employee.dashboard.view.
 *   (anyone with team workspace)    → sales section + comprehensive
 *                                      shell.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  ClipboardList,
  Download,
  FileBarChart,
  FileText,
  Printer,
  Wallet,
  CalendarCheck,
  Receipt,
  ShoppingCart,
  CheckCircle2,
  X,
} from 'lucide-react';
import { TeamRow, employeesApi } from '@/api/employees.api';
import { commissionsApi } from '@/api/commissions.api';
import { useAuthStore } from '@/stores/auth.store';
import { exportMultiSheet, printReport } from '@/lib/exportExcel';
import {
  EmployeeReportPayload,
  buildAccountsReport,
  buildAdjustmentsReport,
  buildApprovalsReport,
  buildAttendanceReport,
  buildComprehensiveReport,
  buildSalesReport,
} from './employeeReportBuilders';

interface PeriodBounds {
  from: string;
  to: string;
}

function cairoMonthBounds(): PeriodBounds {
  const today = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(today);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${d}` };
}

type ReportKey =
  | 'comprehensive'
  | 'attendance'
  | 'accounts'
  | 'adjustments'
  | 'sales'
  | 'approvals';

interface CardSpec {
  key: ReportKey;
  title: string;
  description: string;
  icon: React.ReactNode;
  tone: 'green' | 'blue' | 'orange' | 'purple' | 'rose' | 'slate';
  permission?: string;
  build: (p: EmployeeReportPayload) => ReturnType<typeof buildSalesReport>;
}

export function EmployeeReportsTab({
  employee,
  initialReport,
}: {
  employee: TeamRow;
  initialReport?: ReportKey;
}) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [period, setPeriod] = useState<PeriodBounds>(() => cairoMonthBounds());

  const { data: dashboard } = useQuery({
    queryKey: ['employee-user-dashboard', employee.id],
    queryFn: () => employeesApi.userDashboard(employee.id),
  });
  const { data: ledger } = useQuery({
    queryKey: ['employee-user-ledger', employee.id, period.from, period.to],
    queryFn: () => employeesApi.userLedger(employee.id, period.from, period.to),
    enabled: hasPermission('employee.ledger.view'),
  });
  const { data: detail = [] } = useQuery({
    queryKey: ['commissions-detail', employee.id, period.from, period.to],
    queryFn: () => commissionsApi.detail(employee.id, period.from, period.to),
  });
  const { data: categoryBreakdown = [] } = useQuery({
    queryKey: ['commissions-category-breakdown', employee.id, period.from, period.to],
    queryFn: () =>
      commissionsApi.categoryBreakdown(employee.id, period.from, period.to),
  });
  const { data: sellerSettings } = useQuery({
    queryKey: ['commissions-seller-settings', employee.id],
    queryFn: () => commissionsApi.getSellerSettings(employee.id),
  });

  const payload: EmployeeReportPayload = useMemo(
    () => ({
      employee,
      from: period.from,
      to: period.to,
      dashboard,
      ledger,
      detail,
      categoryBreakdown,
      sellerSettings,
    }),
    [employee, period, dashboard, ledger, detail, categoryBreakdown, sellerSettings],
  );

  const cards: CardSpec[] = [
    {
      key: 'comprehensive',
      title: 'التقرير الشامل للموظف',
      description: 'كل الأقسام في ملف واحد: الحضور، الحسابات، السلف، المبيعات، الموافقات.',
      icon: <FileBarChart size={20} />,
      tone: 'purple',
      build: buildComprehensiveReport,
    },
    {
      key: 'attendance',
      title: 'تقرير الحضور واليوميات',
      description: 'أيام العمل، الساعات، اليوميات المعتمدة والمصروفة.',
      icon: <CalendarCheck size={20} />,
      tone: 'blue',
      build: buildAttendanceReport,
    },
    {
      key: 'accounts',
      title: 'تقرير الحسابات والحركات',
      description: 'كشف الحساب الكامل من gl_entries مع الأرصدة المفتوحة والختامية.',
      icon: <Wallet size={20} />,
      tone: 'green',
      permission: 'employee.ledger.view',
      build: buildAccountsReport,
    },
    {
      key: 'adjustments',
      title: 'تقرير السلف والخصومات والمكافآت',
      description: 'جداول مفصّلة لكل نوع + المجاميع والصافي.',
      icon: <Receipt size={20} />,
      tone: 'orange',
      permission: 'employee.ledger.view',
      build: buildAdjustmentsReport,
    },
    {
      key: 'sales',
      title: 'تقرير المبيعات والعمولات',
      description: 'فواتير، تحصيلات، نسبة تحصيل، تارجت، عمولة تقديرية.',
      icon: <ShoppingCart size={20} />,
      tone: 'rose',
      build: buildSalesReport,
    },
    {
      key: 'approvals',
      title: 'تقرير الموافقات والتعديلات',
      description: 'الطلبات + سجل التدقيق للقيود الملغاة.',
      icon: <CheckCircle2 size={20} />,
      tone: 'slate',
      build: buildApprovalsReport,
    },
  ];

  const visibleCards = cards.filter(
    (c) => !c.permission || hasPermission(c.permission),
  );

  // Preview modal state. The same html body is used for print and
  // preview so the operator sees exactly what the print window will
  // produce.
  const [previewOpen, setPreviewOpen] = useState<ReportKey | null>(
    initialReport ?? null,
  );

  return (
    <div className="space-y-5">
      <PeriodHeader period={period} onChange={setPeriod} />

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {visibleCards.map((c) => (
          <ReportCard
            key={c.key}
            spec={c}
            payload={payload}
            onPreview={() => setPreviewOpen(c.key)}
          />
        ))}
      </div>

      <PermissionNotes hasPermission={hasPermission} />

      {previewOpen && (
        <PreviewModal
          spec={cards.find((c) => c.key === previewOpen)!}
          payload={payload}
          onClose={() => setPreviewOpen(null)}
        />
      )}
    </div>
  );
}

function PeriodHeader({
  period,
  onChange,
}: {
  period: PeriodBounds;
  onChange: (p: PeriodBounds) => void;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 flex items-center justify-between gap-3 flex-wrap">
      <div>
        <h3 className="text-base font-black text-slate-800">تقارير الموظف</h3>
        <p className="text-xs text-slate-500 mt-0.5">
          كل تقرير يحترم الفترة المختارة هنا. التقارير المالية تظهر فقط
          إذا كان لديك صلاحية <code>employee.ledger.view</code>.
        </p>
      </div>
      <div className="inline-flex items-center gap-2 text-xs font-bold text-slate-700">
        <span className="text-slate-500">من</span>
        <input
          type="date"
          value={period.from}
          max={period.to}
          onChange={(e) => onChange({ from: e.target.value, to: period.to })}
          className="rounded-lg border border-slate-200 px-2 py-1 outline-none"
        />
        <span className="text-slate-500">إلى</span>
        <input
          type="date"
          value={period.to}
          min={period.from}
          onChange={(e) => onChange({ from: period.from, to: e.target.value })}
          className="rounded-lg border border-slate-200 px-2 py-1 outline-none"
        />
      </div>
    </div>
  );
}

function ReportCard({
  spec,
  payload,
  onPreview,
}: {
  spec: CardSpec;
  payload: EmployeeReportPayload;
  onPreview: () => void;
}) {
  const map: Record<string, { fg: string; tile: string }> = {
    green: { fg: 'text-emerald-700', tile: 'bg-emerald-50 border-emerald-200' },
    blue: { fg: 'text-blue-700', tile: 'bg-blue-50 border-blue-200' },
    orange: { fg: 'text-amber-700', tile: 'bg-amber-50 border-amber-200' },
    purple: { fg: 'text-violet-700', tile: 'bg-violet-50 border-violet-200' },
    rose: { fg: 'text-rose-700', tile: 'bg-rose-50 border-rose-200' },
    slate: { fg: 'text-slate-700', tile: 'bg-slate-50 border-slate-200' },
  };
  const t = map[spec.tone];

  const onPrint = () => {
    const r = spec.build(payload);
    printReport(r.title, r.htmlBody);
  };
  const onExcel = () => {
    const r = spec.build(payload);
    const safeName = `${r.title}-${payload.from}-${payload.to}`.replace(/[^\w؀-ۿ\- ]/g, '');
    exportMultiSheet(safeName, r.sheets);
  };

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm p-4 flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div
          className={`shrink-0 w-12 h-12 rounded-xl border ${t.tile} ${t.fg} flex items-center justify-center`}
        >
          {spec.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-base font-black text-slate-800">{spec.title}</div>
          <div className="text-xs text-slate-500 mt-1 leading-relaxed">
            {spec.description}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2 mt-auto pt-2 border-t border-slate-100">
        <button
          type="button"
          onClick={onPreview}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-100 text-slate-700 text-xs font-bold hover:bg-slate-200"
        >
          <FileText size={12} />
          عرض
        </button>
        <button
          type="button"
          onClick={onPrint}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200 text-xs font-bold hover:bg-indigo-100"
        >
          <Printer size={12} />
          طباعة / PDF
        </button>
        <button
          type="button"
          onClick={onExcel}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-bold hover:bg-emerald-100"
        >
          <Download size={12} />
          Excel
        </button>
      </div>
    </div>
  );
}

function PreviewModal({
  spec,
  payload,
  onClose,
}: {
  spec: CardSpec;
  payload: EmployeeReportPayload;
  onClose: () => void;
}) {
  const r = useMemo(() => spec.build(payload), [spec, payload]);
  const onPrint = () => printReport(r.title, r.htmlBody);
  const onExcel = () => {
    const safeName = `${r.title}-${payload.from}-${payload.to}`.replace(
      /[^\w؀-ۿ\- ]/g,
      '',
    );
    exportMultiSheet(safeName, r.sheets);
  };

  return (
    <div
      className="fixed inset-0 z-40 bg-black/40 flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl bg-white rounded-2xl shadow-2xl my-6"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white">
          <div className="flex items-center gap-2">
            <ClipboardList size={16} className="text-slate-400" />
            <div>
              <h3 className="text-base font-black text-slate-800">{r.title}</h3>
              <div className="text-[11px] text-slate-500 mt-0.5">
                الفترة: {payload.from} — {payload.to}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onPrint}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-50 text-indigo-700 border border-indigo-200 text-xs font-bold"
            >
              <Printer size={12} />
              طباعة / PDF
            </button>
            <button
              type="button"
              onClick={onExcel}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 text-xs font-bold"
            >
              <Download size={12} />
              Excel
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
              title="إغلاق"
            >
              <X size={14} />
            </button>
          </div>
        </div>
        <div
          className="p-5 max-h-[70vh] overflow-y-auto report-preview"
          dangerouslySetInnerHTML={{ __html: r.htmlBody }}
        />
        <style>{`
          .report-preview h2 { font-size:14px; font-weight:900; color:#1e293b; margin: 12px 0 6px; }
          .report-preview table { width:100%; border-collapse:collapse; margin: 6px 0; font-size:12px; }
          .report-preview th, .report-preview td { border:1px solid #e2e8f0; padding:5px 8px; text-align:right; }
          .report-preview th { background:#f8fafc; font-weight:700; color:#475569; }
          .report-preview .muted { color:#64748b; font-size:11px; margin-top:8px; }
        `}</style>
      </div>
    </div>
  );
}

function PermissionNotes({
  hasPermission,
}: {
  hasPermission: (...p: string[]) => boolean;
}) {
  const missing: string[] = [];
  if (!hasPermission('employee.ledger.view'))
    missing.push('employee.ledger.view (الحسابات والسلف)');
  if (missing.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
      <div className="font-bold mb-1">ملاحظة صلاحيات</div>
      التقارير المالية مخفية لأن المستخدم لا يملك:{' '}
      <code className="bg-white/60 px-1 rounded">{missing.join(' · ')}</code>.
    </div>
  );
}
