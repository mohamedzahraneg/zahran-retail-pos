/**
 * cashboxDriftReportBuilder.ts — PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX
 *
 * Pure builders for the drift-detail report (Excel rows + Print HTML).
 * Mirrors the cashbox-movements builder pattern from REPORTS-1B; same
 * inputs always produce same output, no fetches, no DOM, no mutations.
 *
 * Shape consumed: `CashboxDriftDetailResponse` from the backend's
 * `/cash-desk/cashboxes/:id/drift-detail` endpoint, already split
 * via `categorizeDrift()` so the export carries the same operator-
 * facing structure as the on-screen panel.
 */

import type {
  CashboxDriftCoverage,
  CashboxDriftDetailRow,
  CashboxDriftDetailResponse,
} from '@/api/cash-desk.api';
import { formatArabicDate } from '@/lib/format-arabic-date';
import { categorizeDrift } from './cashboxDriftCategorize';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const SIGNED_EGP = (n: number | string) => {
  const num = Number(n || 0);
  return `${num > 0 ? '+' : ''}${EGP(num)}`;
};

const REFERENCE_TYPE_LABEL_AR: Record<string, string> = {
  invoice:              'فاتورة بيع',
  return:               'مرتجع',
  customer_payment:     'سند قبض من عميل',
  supplier_payment:     'سند صرف لمورد',
  expense:              'مصروف',
  purchase:             'فاتورة شراء',
  shift:                'وردية',
  shift_variance:       'فرق وردية',
  employee_settlement:  'تسوية موظف',
  other:                'أخرى',
};

const COVERAGE_LABEL_AR: Record<CashboxDriftCoverage, string> = {
  CT_only: 'في الخزنة فقط',
  JE_only: 'في الأستاذ العام فقط',
  both:    'كلاهما (بفرق)',
};

const escapeHtml = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export interface CashboxDriftReportInput {
  data: CashboxDriftDetailResponse;
}

export function buildDriftReportFilename(input: CashboxDriftReportInput): string {
  const base =
    (input.data.cashbox?.name || 'cashbox')
      .replace(/[\\/:*?"<>|]/g, '')
      .trim()
      .replace(/\s+/g, '_');
  const today = new Date().toISOString().slice(0, 10);
  return `cashbox-drift-report-${base}-${today}`;
}

export function buildDriftReportTitle(input: CashboxDriftReportInput): string {
  const name = input.data.cashbox?.name || '—';
  return `تقرير فجوة الخزنة مع الأستاذ العام — ${name}`;
}

/**
 * Excel rows — one row per drift contributor. Money columns kept as
 * Number so Excel can SUM/sort. Includes a `category` column flagging
 * "real economic" vs "self-cancelling" so the operator can filter
 * inside Excel without re-running the categorization mentally.
 */
export function buildDriftExcelRows(
  input: CashboxDriftReportInput,
): Record<string, unknown>[] {
  const { real, selfCancelling, realSum, selfCancellingSum } = categorizeDrift(
    input.data.rows,
  );

  const mapRow = (
    r: CashboxDriftDetailRow,
    category: 'real' | 'self_cancelling',
  ) => ({
    'التصنيف':           category === 'real'
                          ? 'فرق مؤثر على الرصيد'
                          : 'اختلاف تصنيف يلغي نفسه',
    'نوع المرجع':         REFERENCE_TYPE_LABEL_AR[r.reference_type] ?? r.reference_type,
    'رقم المرجع':         r.reference_no ?? '',
    'التغطية':            COVERAGE_LABEL_AR[r.coverage] ?? r.coverage,
    'مبلغ الخزنة (CT)':   Number(r.ct_signed_amount ?? 0),
    'مبلغ الأستاذ (JE)':  Number(r.je_signed_amount ?? 0),
    'الفرق':              Number(r.drift_amount ?? 0),
    'أول ظهور':           formatArabicDate(r.first_seen_at),
    'آخر ظهور':           formatArabicDate(r.last_seen_at),
    'قيد عيني':           r.sample_entry_no ?? '',
  });

  const rows = [
    ...real.map((r) => mapRow(r, 'real')),
    ...selfCancelling.map((r) => mapRow(r, 'self_cancelling')),
  ];

  if (rows.length === 0) return [];

  const summary = {
    'التصنيف':           '— ملخص الفجوة —',
    'نوع المرجع':         '',
    'رقم المرجع':         '',
    'التغطية':            '',
    'مبلغ الخزنة (CT)':   Number(input.data.totals.total_ct ?? 0),
    'مبلغ الأستاذ (JE)':  Number(input.data.totals.total_je ?? 0),
    'الفرق':              Number(input.data.totals.total_drift ?? 0),
    'أول ظهور':           '',
    'آخر ظهور':           '',
    'قيد عيني':           `فروقات حقيقية: ${SIGNED_EGP(realSum)} · اختلافات تلغي نفسها: ${SIGNED_EGP(selfCancellingSum)}`,
  };
  return [...rows, summary];
}

/**
 * Print/PDF HTML body. Includes the four summary cards, top
 * contributors, the read-only guidance section, both grouped
 * tables, and the read-only footer.
 */
export function buildDriftPrintHtml(input: CashboxDriftReportInput): string {
  const data = input.data;
  const cashbox = data.cashbox;
  const { real, selfCancelling, realSum, selfCancellingSum } = categorizeDrift(
    data.rows,
  );

  const renderRowsTable = (rows: CashboxDriftDetailRow[], badge: string) => {
    if (rows.length === 0) {
      return `<p class="empty">لا توجد صفوف في هذه المجموعة.</p>`;
    }
    return `
      <table class="rows">
        <thead>
          <tr>
            <th>نوع المرجع</th>
            <th>رقم المرجع</th>
            <th>التغطية</th>
            <th>مبلغ الخزنة (CT)</th>
            <th>مبلغ الأستاذ (JE)</th>
            <th>الفرق</th>
            <th>قيد عيني</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r) => `
            <tr>
              <td>
                ${escapeHtml(REFERENCE_TYPE_LABEL_AR[r.reference_type] ?? r.reference_type)}
                <span class="badge">${escapeHtml(badge)}</span>
              </td>
              <td class="mono">${escapeHtml(r.reference_no ?? '—')}</td>
              <td>${escapeHtml(COVERAGE_LABEL_AR[r.coverage] ?? r.coverage)}</td>
              <td class="mono">${escapeHtml(SIGNED_EGP(r.ct_signed_amount))}</td>
              <td class="mono">${escapeHtml(SIGNED_EGP(r.je_signed_amount))}</td>
              <td class="mono drift">${escapeHtml(SIGNED_EGP(r.drift_amount))}</td>
              <td class="mono">${escapeHtml(r.sample_entry_no ?? '—')}</td>
            </tr>`).join('')}
        </tbody>
      </table>`;
  };

  const styles = `
    <style>
      .summary { display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px; margin: 8px 0 12px; }
      .summary .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 8px; text-align: center; background: #f8fafc; }
      .summary .card .label { font-size: 10px; color: #64748b; }
      .summary .card .value { font-size: 16px; font-weight: bold; color: #1e293b; margin-top: 4px; font-family: 'Tajawal','Courier New',monospace; }
      .meta, .rows, .contrib, .guide { width: 100%; border-collapse: collapse; margin: 8px 0 12px; }
      .meta th, .meta td { border: 1px solid #ddd; padding: 5px 8px; text-align: right; font-size: 12px; }
      .meta th { background: #f1f5f9; }
      .rows th, .rows td, .contrib th, .contrib td { border: 1px solid #e2e8f0; padding: 4px 6px; text-align: right; font-size: 11px; }
      .rows th, .contrib th { background: #f8fafc; font-weight: bold; }
      .rows .mono, .contrib .mono { font-family: 'Tajawal','Courier New',monospace; }
      .rows .drift, .contrib .drift { font-weight: bold; color: #b91c1c; }
      .badge { display: inline-block; padding: 1px 4px; margin-right: 4px; border-radius: 3px; background: #fef3c7; color: #92400e; font-size: 9px; }
      .section-title { font-size: 13px; font-weight: bold; color: #1e293b; margin: 14px 0 4px; border-bottom: 2px solid #cbd5e1; padding-bottom: 2px; }
      .empty { text-align: center; color: #64748b; padding: 12px; font-size: 11px; font-style: italic; }
      .footer { margin-top: 14px; font-size: 11px; color: #64748b; border-top: 1px dashed #cbd5e1; padding-top: 8px; }
      .guide ul { margin: 0; padding-right: 18px; }
      .guide li { margin: 2px 0; font-size: 11px; }
    </style>`;

  const headerTable = `
    <table class="meta">
      <tr><th>اسم الخزنة</th><td>${escapeHtml(cashbox?.name ?? '—')}</td>
          <th>الفرق على مستوى الخزنة</th><td class="drift">${escapeHtml(SIGNED_EGP(cashbox?.gl_drift ?? '0'))}</td></tr>
      <tr><th>رصيد الخزنة (Stored)</th><td>${escapeHtml(EGP(cashbox?.stored_balance ?? '0'))}</td>
          <th>رصيد الأستاذ العام (GL)</th><td>${escapeHtml(EGP(cashbox?.gl_net ?? '0'))}</td></tr>
    </table>`;

  const summaryCards = `
    <div class="summary">
      <div class="card"><div class="label">إجمالي الفرق</div>
        <div class="value drift">${escapeHtml(SIGNED_EGP(data.totals.total_drift))}</div></div>
      <div class="card"><div class="label">عدد المراجع</div>
        <div class="value">${escapeHtml(String(data.totals.count))}</div></div>
      <div class="card"><div class="label">فروقات حقيقية</div>
        <div class="value">${escapeHtml(String(real.length))} · ${escapeHtml(SIGNED_EGP(realSum))}</div></div>
      <div class="card"><div class="label">اختلافات تلغي نفسها</div>
        <div class="value">${escapeHtml(String(selfCancelling.length))} · ${escapeHtml(SIGNED_EGP(selfCancellingSum))}</div></div>
    </div>`;

  const top = real
    .slice()
    .sort(
      (a, b) =>
        Math.abs(Number(b.drift_amount || 0)) -
        Math.abs(Number(a.drift_amount || 0)),
    )
    .slice(0, 5);
  const contributorsSection = real.length === 0 ? '' : `
    <div class="section-title">ما سبب الفرق؟</div>
    <table class="contrib">
      <thead>
        <tr>
          <th>نوع المرجع</th>
          <th>رقم المرجع</th>
          <th>الفرق</th>
        </tr>
      </thead>
      <tbody>
        ${top.map((r) => `
          <tr>
            <td>${escapeHtml(REFERENCE_TYPE_LABEL_AR[r.reference_type] ?? r.reference_type)}</td>
            <td class="mono">${escapeHtml(r.reference_no ?? r.reference_id.slice(0, 8) + '…')}</td>
            <td class="mono drift">${escapeHtml(SIGNED_EGP(r.drift_amount))}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  const guidance = `
    <div class="section-title">ماذا أفعل؟</div>
    <div class="guide">
      <ul>
        <li>راجع الفواتير ذات الفرق أولاً.</li>
        <li>لا تقم بتسوية تلقائية قبل معرفة هل الحركة ناقصة في الخزنة أم في الأستاذ.</li>
        <li>إذا كان القيد ناقصًا: أنشئ تسوية محاسبية من شاشة التسويات بعد موافقة المدير.</li>
        <li>إذا كان الفرق بسبب تصنيف مرجع فقط: لا تحتاج قيد مالي، تحتاج تصحيح مطابقة/تصنيف.</li>
      </ul>
    </div>`;

  return `
    ${styles}
    ${headerTable}
    ${summaryCards}
    ${contributorsSection}
    ${guidance}
    <div class="section-title">الفروقات المؤثرة على الرصيد (${real.length})</div>
    ${renderRowsTable(real, 'سبب رئيسي')}
    <div class="section-title">اختلافات تصنيف لا تؤثر على الإجمالي (${selfCancelling.length})</div>
    ${renderRowsTable(selfCancelling, 'يلغي نفسه')}
    <div class="footer">
      هذه قراءة فقط؛ لا يتم إجراء أي تسوية تلقائية.
    </div>
  `;
}
