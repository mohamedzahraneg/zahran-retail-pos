/**
 * employeeReportBuilders — pure data-shaping + HTML/Excel-row builders
 * for the PR-T5 Employee Reports tab.
 *
 * Each builder takes the same data envelope the EmployeeOverviewTab
 * already fetches (from /employees/:id/dashboard, /employees/:id/ledger,
 * /commissions/:id/{detail,categoryBreakdown,seller-settings}) and
 * produces:
 *   - htmlBody : RTL HTML fragment for `printReport(title, htmlBody)`
 *   - sheets   : Array of { name, rows } for `exportMultiSheet(...)`
 *
 * No backend writes. No API calls. No fake data — when a field is
 * unavailable the builders render "غير متاح" so the report stays
 * honest.
 */
import {
  CommissionCategoryBreakdownRow,
  CommissionDetailRow,
  SellerSettings,
} from '@/api/commissions.api';
import {
  EmployeeDashboard,
  EmployeeLedger,
  TeamRow,
} from '@/api/employees.api';

// ──────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const fmtDate = (iso?: string | null) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
};

const fmtHours = (minutes: number) => {
  if (!minutes) return '0س 00د';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}س ${String(m).padStart(2, '0')}د`;
};

const periodLabelMap: Record<string, string> = {
  none: 'بدون تارجت',
  daily: 'يومي',
  weekly: 'أسبوعي',
  monthly: 'شهري',
};
const modeLabelMap: Record<string, string> = {
  general: 'نسبة عامة من كل المبيعات',
  after_target: 'نسبة بعد تحقيق التارجت',
  over_target: 'نسبة على الأوفر تارجت',
  general_plus_over_target: 'نسبة عامة + إضافية على الأوفر',
};

function tableHtml(title: string, headers: string[], rows: string[][]) {
  return `
<h2>${title}</h2>
<table>
  <thead>
    <tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>
  </thead>
  <tbody>
    ${rows
      .map(
        (r) =>
          `<tr>${r.map((c) => `<td>${c ?? '—'}</td>`).join('')}</tr>`,
      )
      .join('')}
  </tbody>
</table>`;
}

function summaryRowsHtml(label: string, pairs: Array<[string, string]>) {
  return `
<h2>${label}</h2>
<table>
  <tbody>
    ${pairs.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join('')}
  </tbody>
</table>`;
}

function reportHeaderHtml(args: {
  title: string;
  employee: TeamRow;
  from: string;
  to: string;
}) {
  return `
<div class="muted" style="display:flex;justify-content:space-between;border-bottom:2px solid #1e293b;padding-bottom:6px;margin-bottom:14px">
  <div>
    <div style="font-size:18px;font-weight:bold;color:#1e293b">${args.employee.full_name || args.employee.username}</div>
    <div>الرقم الوظيفي: ${args.employee.employee_no || '—'} · ${args.employee.role_name || args.employee.job_title || '—'}</div>
  </div>
  <div style="text-align:left">
    <div>الفترة: ${fmtDate(args.from)} — ${fmtDate(args.to)}</div>
    <div>أُنشئ في ${new Date().toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' })}</div>
  </div>
</div>`;
}

// ──────────────────────────────────────────────────────────────────
// Report payload envelope
// ──────────────────────────────────────────────────────────────────

export interface EmployeeReportPayload {
  employee: TeamRow;
  from: string;
  to: string;
  dashboard?: EmployeeDashboard;
  ledger?: EmployeeLedger;
  detail?: CommissionDetailRow[];
  categoryBreakdown?: CommissionCategoryBreakdownRow[];
  sellerSettings?: SellerSettings;
}

export interface BuiltReport {
  title: string;
  htmlBody: string;
  sheets: Array<{ name: string; rows: any[] }>;
}

// ──────────────────────────────────────────────────────────────────
// Sales / commission derivations (mirror EmployeeOverviewTab logic)
// ──────────────────────────────────────────────────────────────────

interface SalesDerived {
  invoiceCount: number;
  eligibleSales: number;
  avgInvoice: number;
  collectionsTotal: number;
  grandTotal: number;
  collectionRatio: number | null;
  topInvoices: CommissionDetailRow[];
  dailySales: { date: string; amount: number }[];
}

function deriveSales(detail: CommissionDetailRow[]): SalesDerived {
  const invoiceCount = detail.length;
  const eligibleSales = detail.reduce(
    (s, r) => s + Number(r.eligible_total || 0),
    0,
  );
  const grandTotal = detail.reduce(
    (s, r) => s + Number(r.grand_total || 0),
    0,
  );
  const collectionsTotal = detail.reduce(
    (s, r) => s + Number(r.paid_total || 0),
    0,
  );
  const avgInvoice = invoiceCount > 0 ? eligibleSales / invoiceCount : 0;
  const anyCollections = detail.some((r) => Number(r.paid_total || 0) > 0);
  const collectionRatio =
    anyCollections && grandTotal > 0
      ? (collectionsTotal / grandTotal) * 100
      : null;
  const topInvoices = [...detail]
    .sort((a, b) => Number(b.eligible_total) - Number(a.eligible_total))
    .slice(0, 10);
  const m = new Map<string, number>();
  for (const r of detail) {
    const d = (r.completed_at || '').slice(0, 10);
    if (!d) continue;
    m.set(d, (m.get(d) || 0) + Number(r.eligible_total || 0));
  }
  const dailySales = [...m.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, amount]) => ({ date, amount }));
  return {
    invoiceCount,
    eligibleSales,
    avgInvoice,
    collectionsTotal,
    grandTotal,
    collectionRatio,
    topInvoices,
    dailySales,
  };
}

function deriveTarget(s: SellerSettings | undefined, achieved: number) {
  const enabled =
    !!s &&
    s.sales_target_period !== 'none' &&
    s.sales_target_amount != null &&
    Number(s.sales_target_amount) > 0;
  const target = enabled ? Number(s!.sales_target_amount) : 0;
  const baseRate = s ? Number(s.commission_rate || 0) : 0;
  const afterRate =
    s?.commission_after_target_rate != null
      ? Number(s.commission_after_target_rate)
      : null;
  const overRate =
    s?.over_target_commission_rate != null
      ? Number(s.over_target_commission_rate)
      : null;
  const mode = (s?.commission_mode as any) || 'general';
  const achievementPct =
    enabled && target > 0 ? Math.min((achieved / target) * 100, 999) : null;
  const remaining = enabled ? Math.max(target - achieved, 0) : 0;
  const overTarget = enabled ? Math.max(achieved - target, 0) : 0;
  let estimatedCommission = 0;
  if (baseRate > 0) {
    if (mode === 'after_target') {
      estimatedCommission = enabled && achieved >= target
        ? (achieved * (afterRate ?? baseRate)) / 100
        : 0;
    } else if (mode === 'over_target') {
      estimatedCommission =
        enabled && overTarget > 0 ? (overTarget * (overRate ?? 0)) / 100 : 0;
    } else if (mode === 'general_plus_over_target') {
      estimatedCommission = (achieved * baseRate) / 100;
      if (enabled && overTarget > 0) {
        estimatedCommission += (overTarget * (overRate ?? 0)) / 100;
      }
    } else {
      estimatedCommission = (achieved * baseRate) / 100;
    }
  }
  return {
    enabled,
    target,
    baseRate,
    afterRate,
    overRate,
    mode,
    achievementPct,
    remaining,
    overTarget,
    estimatedCommission,
  };
}

// ──────────────────────────────────────────────────────────────────
// Builders — one per report type
// ──────────────────────────────────────────────────────────────────

export function buildAttendanceReport(p: EmployeeReportPayload): BuiltReport {
  const dash = p.dashboard;
  const monthDays = dash?.attendance.month?.days ?? 0;
  const monthMinutes = dash?.attendance.month?.minutes ?? 0;
  const weekDays = dash?.attendance.week?.days ?? 0;
  const weekMinutes = dash?.attendance.week?.minutes ?? 0;
  const targetHoursDay = Number(dash?.profile.target_hours_day ?? 0);
  const targetMinutesDay = Number(dash?.wage.target_minutes_day ?? targetHoursDay * 60);

  const summary: Array<[string, string]> = [
    ['أيام العمل (الفترة)', monthDays.toString()],
    ['ساعات العمل (الفترة)', fmtHours(monthMinutes)],
    ['أيام الأسبوع الحالي', weekDays.toString()],
    ['ساعات الأسبوع الحالي', fmtHours(weekMinutes)],
    ['الساعات المستهدفة في اليوم', `${targetHoursDay} ساعة`],
    ['بداية الوردية', dash?.profile.shift_start_time || 'غير متاح'],
    ['نهاية الوردية', dash?.profile.shift_end_time || 'غير متاح'],
    ['تأخر اليوم', `${dash?.attendance.today_late_minutes ?? 0} دقيقة`],
    ['انصراف مبكر اليوم', `${dash?.attendance.today_early_leave_minutes ?? 0} دقيقة`],
  ];

  const wagePairs: Array<[string, string]> = [
    ['اليومية المعتمدة في الفترة', EGP(dash?.wage.accrual_in_month ?? 0)],
    ['عدد اليوميات المعتمدة', String(dash?.wage.accrual_count ?? 0)],
    ['اليومية المصروفة في الفترة', EGP(dash?.wage.paid_in_month ?? 0)],
    ['عدد عمليات الصرف', String(dash?.wage.paid_count ?? 0)],
    ['المتبقي من اعتمادات الفترة', EGP(dash?.wage.remaining_from_month_accrual ?? 0)],
    ['اليومية الأساسية', EGP(dash?.wage.daily_amount ?? 0)],
  ];

  const htmlBody = `
${reportHeaderHtml({ title: 'تقرير الحضور واليوميات', employee: p.employee, from: p.from, to: p.to })}
${summaryRowsHtml('ملخص الحضور', summary)}
${summaryRowsHtml('ملخص اليوميات', wagePairs)}
<div class="muted">المصدر: /employees/${p.employee.id}/dashboard · ساعة العمل بتوقيت القاهرة</div>`;

  const sheets = [
    {
      name: 'ملخص الحضور',
      rows: summary.map(([k, v]) => ({ بند: k, القيمة: v })),
    },
    {
      name: 'ملخص اليوميات',
      rows: wagePairs.map(([k, v]) => ({ بند: k, القيمة: v })),
    },
  ];

  return {
    title: `تقرير الحضور واليوميات — ${p.employee.full_name || p.employee.username}`,
    htmlBody,
    sheets,
  };
}

export function buildAccountsReport(p: EmployeeReportPayload): BuiltReport {
  const led = p.ledger;
  const opening = led?.gl_opening_balance ?? led?.opening_balance ?? 0;
  const closing = led?.gl_closing_balance ?? led?.closing_balance ?? 0;
  const live = led?.gl_balance ?? 0;

  const summary: Array<[string, string]> = [
    ['الرصيد الافتتاحي للفترة', led?.gl_opening_balance != null ? EGP(opening) : 'غير متاح'],
    ['الرصيد الختامي للفترة', led?.gl_closing_balance != null ? EGP(closing) : 'غير متاح'],
    ['الرصيد الحالي (مباشر)', EGP(live)],
    ['عدد القيود في الفترة', String(led?.gl_entries.length ?? 0)],
    ['ملاحظة: موجب = مدين للشركة، سالب = مستحق له', ''],
  ];

  const entries = (led?.gl_entries ?? []).map((e) => [
    e.entry_no,
    fmtDate(e.entry_date),
    e.account_code,
    e.account_name,
    e.description,
    Number(e.debit) > 0 ? EGP(e.debit) : '—',
    Number(e.credit) > 0 ? EGP(e.credit) : '—',
    EGP(e.signed_effect),
    EGP(e.running_balance),
    e.is_voided ? `ملغاة — ${e.void_reason || ''}` : '',
  ]);

  const htmlBody = `
${reportHeaderHtml({ title: 'تقرير الحسابات والحركات', employee: p.employee, from: p.from, to: p.to })}
${summaryRowsHtml('ملخص الرصيد', summary)}
${tableHtml(
  'سجل الحركات (gl_entries)',
  ['رقم القيد','تاريخ','الحساب','اسم الحساب','الوصف','مدين','دائن','الأثر','الرصيد المتراكم','حالة'],
  entries,
)}
<div class="muted">المصدر: /employees/${p.employee.id}/ledger · حسابات 1123 + 213 (مهاجرة 075)</div>`;

  const sheets = [
    {
      name: 'ملخص الرصيد',
      rows: summary.map(([k, v]) => ({ بند: k, القيمة: v })),
    },
    {
      name: 'سجل الحركات',
      rows: (led?.gl_entries ?? []).map((e) => ({
        'رقم القيد': e.entry_no,
        'التاريخ': fmtDate(e.entry_date),
        'الحساب': e.account_code,
        'اسم الحساب': e.account_name,
        'الوصف': e.description,
        'مدين': Number(e.debit) || 0,
        'دائن': Number(e.credit) || 0,
        'الأثر الموقّع': Number(e.signed_effect) || 0,
        'الرصيد المتراكم': Number(e.running_balance) || 0,
        'الحالة': e.is_voided ? 'ملغاة' : 'فعّالة',
        'سبب الإلغاء': e.is_voided ? e.void_reason || '' : '',
      })),
    },
  ];

  return {
    title: `تقرير الحسابات والحركات — ${p.employee.full_name || p.employee.username}`,
    htmlBody,
    sheets,
  };
}

export function buildAdjustmentsReport(p: EmployeeReportPayload): BuiltReport {
  const led = p.ledger;
  const entries = led?.entries ?? [];
  const advances = entries.filter((e) => e.entry_type === 'advance');
  const deductions = entries.filter(
    (e) => e.entry_type === 'deduction' || e.entry_type === 'penalty',
  );
  const bonuses = entries.filter((e) => e.entry_type === 'bonus');

  const sumAbs = (rows: typeof entries) =>
    rows.reduce((s, r) => s + Math.abs(Number(r.amount_owed_delta || 0)), 0);

  const summary: Array<[string, string]> = [
    ['إجمالي السلف', EGP(sumAbs(advances))],
    ['إجمالي الخصومات', EGP(sumAbs(deductions))],
    ['إجمالي المكافآت', EGP(sumAbs(bonuses))],
    [
      'صافي الأثر على رصيد الموظف',
      EGP(
        sumAbs(advances) +
          sumAbs(deductions) -
          sumAbs(bonuses),
      ),
    ],
  ];

  const tablize = (rows: typeof entries) =>
    rows.map((r) => [
      fmtDate(r.event_date),
      r.description,
      EGP(Math.abs(Number(r.amount_owed_delta || 0))),
      r.notes || '',
      r.journal_entry_id || '—',
    ]);

  const htmlBody = `
${reportHeaderHtml({ title: 'تقرير السلف والخصومات والمكافآت', employee: p.employee, from: p.from, to: p.to })}
${summaryRowsHtml('الملخص', summary)}
${tableHtml('السلف', ['التاريخ','الوصف','المبلغ','ملاحظة','رقم القيد'], tablize(advances))}
${tableHtml('الخصومات', ['التاريخ','الوصف','المبلغ','ملاحظة','رقم القيد'], tablize(deductions))}
${tableHtml('المكافآت', ['التاريخ','الوصف','المبلغ','ملاحظة','رقم القيد'], tablize(bonuses))}`;

  const sheetRows = (rows: typeof entries) =>
    rows.map((r) => ({
      'التاريخ': fmtDate(r.event_date),
      'الوصف': r.description,
      'المبلغ': Math.abs(Number(r.amount_owed_delta || 0)),
      'ملاحظة': r.notes || '',
      'رقم القيد': r.journal_entry_id || '',
    }));

  const sheets = [
    {
      name: 'الملخص',
      rows: summary.map(([k, v]) => ({ بند: k, القيمة: v })),
    },
    { name: 'السلف', rows: sheetRows(advances) },
    { name: 'الخصومات', rows: sheetRows(deductions) },
    { name: 'المكافآت', rows: sheetRows(bonuses) },
  ];

  return {
    title: `تقرير السلف والخصومات والمكافآت — ${p.employee.full_name || p.employee.username}`,
    htmlBody,
    sheets,
  };
}

export function buildSalesReport(p: EmployeeReportPayload): BuiltReport {
  const detail = p.detail ?? [];
  const sales = deriveSales(detail);
  const target = deriveTarget(p.sellerSettings, sales.eligibleSales);
  const cats = (p.categoryBreakdown ?? []).filter(
    (c) => c.category_id !== null && Number(c.total) > 0,
  );
  const unclassifiedCat = (p.categoryBreakdown ?? [])
    .filter((c) => c.category_id === null)
    .reduce((s, c) => s + Number(c.total || 0), 0);

  const salesSummary: Array<[string, string]> = [
    ['عدد الفواتير', sales.invoiceCount.toString()],
    ['إجمالي المبيعات (المؤهل للعمولة)', EGP(sales.eligibleSales)],
    ['متوسط قيمة الفاتورة', EGP(sales.avgInvoice)],
    ['إجمالي قيمة الفواتير (grand_total)', EGP(sales.grandTotal)],
    ['التحصيلات (paid_total)', EGP(sales.collectionsTotal)],
    [
      'نسبة التحصيل',
      sales.collectionRatio !== null
        ? `${sales.collectionRatio.toFixed(1)}%`
        : 'غير متاح',
    ],
  ];

  const targetSummary: Array<[string, string]> = !target.enabled
    ? [
        ['نظام التارجت', 'بدون تارجت'],
        [
          'نوع العمولة',
          modeLabelMap[target.mode] || target.mode,
        ],
        [
          'نسبة العمولة الأساسية',
          target.baseRate > 0 ? `${target.baseRate}%` : 'لا توجد نسبة عمولة محددة',
        ],
        ['العمولة التقديرية', target.baseRate > 0 ? EGP(target.estimatedCommission) : 'غير متاح'],
      ]
    : [
        ['نظام التارجت', periodLabelMap[p.sellerSettings?.sales_target_period ?? 'none']],
        ['نوع العمولة', modeLabelMap[target.mode] || target.mode],
        ['قيمة التارجت', EGP(target.target)],
        ['المبيعات المحققة', EGP(sales.eligibleSales)],
        [
          'نسبة التحقيق',
          target.achievementPct !== null
            ? `${target.achievementPct.toFixed(1)}%`
            : '—',
        ],
        ['المتبقي للتارجت', target.remaining > 0 ? EGP(target.remaining) : 'تم تحقيق التارجت'],
        ['أوفر التارجت', target.overTarget > 0 ? EGP(target.overTarget) : '—'],
        [
          'نسبة العمولة الأساسية',
          target.baseRate > 0 ? `${target.baseRate}%` : 'لا توجد نسبة عمولة محددة',
        ],
        [
          'نسبة العمولة بعد التارجت',
          target.afterRate != null ? `${target.afterRate}%` : '—',
        ],
        [
          'نسبة الأوفر تارجت',
          target.overRate != null ? `${target.overRate}%` : '—',
        ],
        ['العمولة التقديرية', target.baseRate > 0 ? EGP(target.estimatedCommission) : 'غير متاح'],
      ];

  const topInvoiceRows = sales.topInvoices.map((r) => [
    r.invoice_no,
    fmtDate(r.completed_at),
    r.customer_name || '—',
    EGP(r.eligible_total),
    EGP(r.grand_total),
    EGP(r.paid_total),
  ]);

  const dailyRows = sales.dailySales.map((d) => [fmtDate(d.date), EGP(d.amount)]);

  const catRows: string[][] =
    cats.length > 0
      ? cats.map((c) => [
          c.category_name,
          String(c.invoices_count),
          EGP(c.total),
          `${(
            (Number(c.total) / cats.reduce((s, x) => s + Number(x.total), 0)) *
            100
          ).toFixed(1)}%`,
        ])
      : [];

  const htmlBody = `
${reportHeaderHtml({ title: 'تقرير المبيعات والعمولات', employee: p.employee, from: p.from, to: p.to })}
${summaryRowsHtml('ملخص المبيعات', salesSummary)}
${summaryRowsHtml('العمولة والتارجت', targetSummary)}
${
  catRows.length > 0
    ? tableHtml('توزيع المبيعات حسب الفئة', ['الفئة', 'عدد الفواتير', 'الإجمالي', '%'], catRows)
    : `<h2>توزيع المبيعات حسب الفئة</h2><p class="muted">غير متاح — منتجات الفواتير في هذه الفترة لا تحمل تصنيف. ${
        unclassifiedCat > 0 ? `إجمالي بدون تصنيف: ${EGP(unclassifiedCat)}` : ''
      }</p>`
}
${tableHtml('أعلى الفواتير', ['رقم الفاتورة','التاريخ','العميل','المؤهل','الإجمالي','المحصل'], topInvoiceRows)}
${tableHtml('المبيعات اليومية', ['التاريخ','الإجمالي'], dailyRows)}
<div class="muted">المصدر: /commissions/${p.employee.id}/{detail,category-breakdown,seller-settings}</div>`;

  const sheets = [
    {
      name: 'ملخص المبيعات',
      rows: salesSummary.map(([k, v]) => ({ بند: k, القيمة: v })),
    },
    {
      name: 'العمولة والتارجت',
      rows: targetSummary.map(([k, v]) => ({ بند: k, القيمة: v })),
    },
    {
      name: 'الفواتير',
      rows: detail.map((r) => ({
        'رقم الفاتورة': r.invoice_no,
        'التاريخ': fmtDate(r.completed_at),
        'العميل': r.customer_name || '',
        'المؤهل للعمولة': Number(r.eligible_total) || 0,
        'الإجمالي': Number(r.grand_total) || 0,
        'المحصل': Number(r.paid_total) || 0,
        'نسبة العمولة': Number(r.commission_rate) || 0,
        'العمولة المحسوبة': Number(r.commission) || 0,
      })),
    },
    {
      name: 'المبيعات اليومية',
      rows: sales.dailySales.map((d) => ({
        'التاريخ': fmtDate(d.date),
        'الإجمالي': d.amount,
      })),
    },
    {
      name: 'الفئات',
      rows:
        cats.length > 0
          ? cats.map((c) => ({
              'الفئة': c.category_name,
              'عدد الفواتير': Number(c.invoices_count) || 0,
              'الإجمالي': Number(c.total) || 0,
            }))
          : [
              {
                'الفئة': 'غير متاح — منتجات بدون تصنيف',
                'عدد الفواتير': 0,
                'الإجمالي': unclassifiedCat,
              },
            ],
    },
  ];

  return {
    title: `تقرير المبيعات والعمولات — ${p.employee.full_name || p.employee.username}`,
    htmlBody,
    sheets,
  };
}

export function buildApprovalsReport(p: EmployeeReportPayload): BuiltReport {
  const requests = p.dashboard?.requests ?? [];
  const led = p.ledger;
  const voidedJEs = (led?.gl_entries ?? []).filter((e) => e.is_voided);

  const reqRows = requests.map((r: any) => [
    r.kind,
    fmtDate(r.created_at),
    r.amount != null ? EGP(r.amount) : '—',
    r.status || 'pending',
    r.reason || '',
  ]);

  const voidRows = voidedJEs.map((e) => [
    e.entry_no,
    fmtDate(e.entry_date),
    e.account_code,
    e.description,
    EGP(e.debit || 0),
    EGP(e.credit || 0),
    e.void_reason || '—',
  ]);

  const summary: Array<[string, string]> = [
    ['عدد الطلبات في الفترة', String(requests.length)],
    ['عدد القيود الملغاة', String(voidedJEs.length)],
  ];

  const htmlBody = `
${reportHeaderHtml({ title: 'تقرير الموافقات والتعديلات', employee: p.employee, from: p.from, to: p.to })}
${summaryRowsHtml('الملخص', summary)}
${tableHtml('الطلبات', ['النوع', 'التاريخ', 'المبلغ', 'الحالة', 'السبب'], reqRows)}
${tableHtml(
  'القيود الملغاة (سجل التدقيق)',
  ['رقم القيد','تاريخ','الحساب','الوصف','مدين','دائن','سبب الإلغاء'],
  voidRows,
)}
<div class="muted">المصدر: /employees/${p.employee.id}/{dashboard.requests, ledger.gl_entries}</div>`;

  const sheets = [
    {
      name: 'الملخص',
      rows: summary.map(([k, v]) => ({ بند: k, القيمة: v })),
    },
    {
      name: 'الطلبات',
      rows: requests.map((r: any) => ({
        'النوع': r.kind,
        'التاريخ': fmtDate(r.created_at),
        'المبلغ': r.amount ?? '',
        'الحالة': r.status || 'pending',
        'السبب': r.reason || '',
      })),
    },
    {
      name: 'القيود الملغاة',
      rows: voidedJEs.map((e) => ({
        'رقم القيد': e.entry_no,
        'التاريخ': fmtDate(e.entry_date),
        'الحساب': e.account_code,
        'اسم الحساب': e.account_name,
        'الوصف': e.description,
        'مدين': Number(e.debit) || 0,
        'دائن': Number(e.credit) || 0,
        'سبب الإلغاء': e.void_reason || '',
      })),
    },
  ];

  return {
    title: `تقرير الموافقات والتعديلات — ${p.employee.full_name || p.employee.username}`,
    htmlBody,
    sheets,
  };
}

export function buildComprehensiveReport(p: EmployeeReportPayload): BuiltReport {
  const att = buildAttendanceReport(p);
  const acc = buildAccountsReport(p);
  const adj = buildAdjustmentsReport(p);
  const sal = buildSalesReport(p);
  const apr = buildApprovalsReport(p);

  const liveGl = p.ledger?.gl_balance ?? 0;
  const balanceLabel =
    liveGl < -0.01
      ? 'مستحق له (الشركة مدينة)'
      : liveGl > 0.01
        ? 'مدين للشركة'
        : 'متوازن';

  const profileSummary: Array<[string, string]> = [
    ['الاسم', p.employee.full_name || p.employee.username],
    ['الرقم الوظيفي', p.employee.employee_no || '—'],
    ['الوظيفة', p.employee.role_name || p.employee.job_title || '—'],
    ['تاريخ التعيين', p.dashboard?.profile.hire_date || 'غير متاح'],
    ['الراتب الأساسي', EGP(p.dashboard?.profile.salary_amount ?? 0)],
    ['تواتر الصرف', p.dashboard?.profile.salary_frequency || 'monthly'],
    ['الرصيد النهائي (مباشر)', `${EGP(Math.abs(liveGl))} — ${balanceLabel}`],
  ];

  const htmlBody = `
${reportHeaderHtml({ title: 'التقرير الشامل للموظف', employee: p.employee, from: p.from, to: p.to })}
${summaryRowsHtml('ملخص الموظف', profileSummary)}
${att.htmlBody.split('</div>').slice(1).join('</div>')}
${acc.htmlBody.split('</div>').slice(1).join('</div>')}
${adj.htmlBody.split('</div>').slice(1).join('</div>')}
${sal.htmlBody.split('</div>').slice(1).join('</div>')}
${apr.htmlBody.split('</div>').slice(1).join('</div>')}`;

  const sheets = [
    {
      name: 'ملخص الموظف',
      rows: profileSummary.map(([k, v]) => ({ بند: k, القيمة: v })),
    },
    ...att.sheets.map((s) => ({ ...s, name: `حضور — ${s.name}` })),
    ...acc.sheets.map((s) => ({ ...s, name: `حسابات — ${s.name}` })),
    ...adj.sheets.map((s) => ({ ...s, name: `سلف — ${s.name}` })),
    ...sal.sheets.map((s) => ({ ...s, name: `مبيعات — ${s.name}` })),
    ...apr.sheets.map((s) => ({ ...s, name: `موافقات — ${s.name}` })),
  ];

  return {
    title: `التقرير الشامل — ${p.employee.full_name || p.employee.username}`,
    htmlBody,
    sheets,
  };
}
