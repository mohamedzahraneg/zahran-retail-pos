/**
 * Single-shift report builder — produces the HTML for `printReport`
 * and the sheet array for `exportMultiSheet`. Pure functions: same
 * inputs always produce same output, no fetches, no DOM access. The
 * caller passes already-loaded `summary` (from /shifts/:id/summary)
 * and `adjustments` (from /shifts/:id/adjustments).
 *
 * Strict classification rules (PR-B2):
 *   · Operating expenses come from `summary.expenses` (PR-14 already
 *     filters out advances).
 *   · Employee advances + settlements come from
 *     `summary.employee_cash_movements` (single source — never
 *     duplicated as expenses).
 *   · Totals echo back `summary.total_*` directly so the report
 *     numbers always match the on-screen UI.
 */

import type { Shift, ShiftSummary, ShiftCountAdjustment } from '@/api/shifts.api';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const fmtTime = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleString('en-GB', {
        timeZone: 'Africa/Cairo',
        hour12: false,
      })
    : '—';

const fmtDateOnly = (iso: string | null | undefined) =>
  iso
    ? new Date(iso).toLocaleDateString('en-GB', { timeZone: 'Africa/Cairo' })
    : '—';

const STATUS_LABEL_AR: Record<string, string> = {
  open: 'مفتوحة',
  pending_close: 'بانتظار الاعتماد',
  closed: 'مغلقة',
};

const escapeHtml = (s: string | null | undefined) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/* ─── HTML report (printReport input) ────────────────────────────── */

export function buildShiftReportHtml(opts: {
  shift: Shift;
  summary: ShiftSummary;
  adjustments: ShiftCountAdjustment[];
  generatedByName?: string | null;
}): string {
  const { shift, summary: s, adjustments } = opts;
  const status = STATUS_LABEL_AR[s.status] ?? s.status;
  const variance = Number(s.variance ?? 0);
  const varianceLabel =
    Math.abs(variance) < 0.01
      ? 'متوازنة (لا يوجد فرق)'
      : variance < 0
        ? `عجز ${EGP(Math.abs(variance))}`
        : `زيادة ${EGP(variance)}`;

  const headerRow = (
    label: string,
    value: string | number | null | undefined,
  ) => `
    <tr>
      <td style="background:#f8fafc;font-weight:bold;width:35%;">${escapeHtml(label)}</td>
      <td>${escapeHtml(String(value ?? '—'))}</td>
    </tr>`;

  const summaryRow = (
    label: string,
    value: string,
    bold = false,
    color?: string,
  ) => `
    <tr>
      <td>${escapeHtml(label)}</td>
      <td class="right" ${bold || color ? `style="${bold ? 'font-weight:bold;' : ''}${color ? `color:${color};` : ''}"` : ''}>${escapeHtml(value)}</td>
    </tr>`;

  /* ─── 1. Operating expenses table ─── */
  const opExpensesRows = s.expenses
    .map(
      (e) => `
        <tr>
          <td>${escapeHtml(fmtDateOnly(e.expense_date))}</td>
          <td>${escapeHtml(e.category_name || '—')}</td>
          <td>${escapeHtml(e.description || '—')}</td>
          <td class="right">${escapeHtml(EGP(Number(e.amount)))}</td>
          <td>${escapeHtml((e as any).cashbox_name || '—')}</td>
          <td>${escapeHtml((e as any).created_by_name || '—')}</td>
          <td>${escapeHtml((e as any).je_entry_no || '—')}</td>
        </tr>`,
    )
    .join('');
  const opExpensesTable =
    s.expenses.length === 0
      ? '<div class="muted">لا توجد مصروفات تشغيلية.</div>'
      : `
        <table>
          <thead>
            <tr>
              <th>التاريخ</th>
              <th>البند</th>
              <th>الوصف</th>
              <th>المبلغ</th>
              <th>الخزنة</th>
              <th>تمت بواسطة</th>
              <th>رقم القيد</th>
            </tr>
          </thead>
          <tbody>${opExpensesRows}</tbody>
          <tfoot>
            <tr style="background:#f1f5f9;font-weight:bold;">
              <td colspan="3" class="right">الإجمالي</td>
              <td class="right">${escapeHtml(EGP(s.total_operating_expenses))}</td>
              <td colspan="3"></td>
            </tr>
          </tfoot>
        </table>`;

  /* ─── 2. Employee cash movements table ─── */
  const ecmRows = s.employee_cash_movements
    .map(
      (m) => `
        <tr>
          <td>${escapeHtml(fmtTime(m.created_at))}</td>
          <td>${escapeHtml(m.employee_name || '—')}</td>
          <td>${escapeHtml(m.type_label)}</td>
          <td class="right">${escapeHtml(EGP(m.amount))}</td>
          <td>${escapeHtml(m.cashbox_name || '—')}</td>
          <td>${escapeHtml(m.created_by_name || '—')}</td>
          <td>${escapeHtml(m.je_entry_no || '—')}</td>
          <td>${escapeHtml(m.accounting_impact)}</td>
          <td>${m.link_method === 'explicit' ? 'مرتبط بالوردية' : 'مطابقة تلقائية'}</td>
        </tr>`,
    )
    .join('');
  const ecmTable =
    s.employee_cash_movements.length === 0
      ? '<div class="muted">لا توجد حركات موظفين نقدية.</div>'
      : `
        <table>
          <thead>
            <tr>
              <th>التاريخ والوقت</th>
              <th>الموظف المستلم</th>
              <th>النوع</th>
              <th>المبلغ</th>
              <th>الخزنة</th>
              <th>تمت بواسطة</th>
              <th>رقم القيد</th>
              <th>التأثير المحاسبي</th>
              <th>حالة الربط</th>
            </tr>
          </thead>
          <tbody>${ecmRows}</tbody>
          <tfoot>
            <tr style="background:#f1f5f9;font-weight:bold;">
              <td colspan="3" class="right">الإجمالي</td>
              <td class="right">${escapeHtml(EGP(s.total_employee_cash_out))}</td>
              <td colspan="5"></td>
            </tr>
          </tfoot>
        </table>`;

  /* ─── 3. Cashbox movements summary ─── */
  const cashboxBlock = `
    <table>
      <thead>
        <tr>
          <th>البند</th>
          <th>المبلغ</th>
        </tr>
      </thead>
      <tbody>
        ${summaryRow('قبض من عملاء (in / receipt)', EGP(s.customer_receipts))}
        ${summaryRow('مدفوعات للموردين (out / payment)', EGP(s.supplier_payments))}
        ${summaryRow('حركات نقدية أخرى (داخل)', EGP(s.other_cash_in))}
        ${summaryRow('حركات نقدية أخرى (خارج)', EGP(s.other_cash_out))}
        ${summaryRow('المرتجعات النقدية', EGP(s.total_returns))}
      </tbody>
    </table>`;

  /* ─── 4. Sales / payment breakdown ─── */
  const salesBlock = `
    <table>
      <thead>
        <tr>
          <th>طريقة الدفع</th>
          <th>عدد الفواتير</th>
          <th>الإجمالي</th>
        </tr>
      </thead>
      <tbody>
        ${(['cash', 'card', 'instapay', 'bank_transfer'] as const)
          .map((m) => {
            const slot = (s.payment_breakdown as any)[m] || { count: 0, amount: 0 };
            const label = {
              cash: 'نقدي',
              card: 'بطاقة',
              instapay: 'إنستاباي',
              bank_transfer: 'تحويل بنكي',
            }[m];
            return `<tr><td>${label}</td><td>${slot.count}</td><td class="right">${escapeHtml(EGP(slot.amount))}</td></tr>`;
          })
          .join('')}
      </tbody>
      <tfoot>
        <tr style="background:#f1f5f9;font-weight:bold;">
          <td>إجمالي المبيعات</td>
          <td>${s.invoice_count}</td>
          <td class="right">${escapeHtml(EGP(s.total_sales))}</td>
        </tr>
      </tfoot>
    </table>`;

  /* ─── 5. Count adjustments history ─── */
  const adjustmentRows = adjustments
    .map(
      (a) => `
        <tr>
          <td>${escapeHtml(fmtTime(a.adjusted_at))}</td>
          <td>${escapeHtml(a.adjusted_by_name || '—')}</td>
          <td>${escapeHtml(a.reason)}</td>
          <td class="right">${a.old_actual_closing == null ? '—' : escapeHtml(EGP(Number(a.old_actual_closing)))}</td>
          <td class="right">${escapeHtml(EGP(Number(a.new_actual_closing)))}</td>
          <td class="right">${a.old_difference == null ? '—' : escapeHtml(EGP(Number(a.old_difference)))}</td>
          <td class="right">${a.new_difference == null ? '—' : escapeHtml(EGP(Number(a.new_difference)))}</td>
        </tr>`,
    )
    .join('');
  const adjustmentTable =
    adjustments.length === 0
      ? '<div class="muted">لا توجد تعديلات على مبلغ الإقفال.</div>'
      : `
        <table>
          <thead>
            <tr>
              <th>التاريخ والوقت</th>
              <th>من عدّل</th>
              <th>السبب</th>
              <th>المبلغ القديم</th>
              <th>المبلغ الجديد</th>
              <th>الفرق القديم</th>
              <th>الفرق الجديد</th>
            </tr>
          </thead>
          <tbody>${adjustmentRows}</tbody>
        </table>`;

  /* ─── Compose the full report body ─── */
  return `
    <h2 style="margin:18px 0 6px;">معلومات الوردية</h2>
    <table>
      <tbody>
        ${headerRow('رقم الوردية', shift.shift_no)}
        ${headerRow('الحالة', status)}
        ${headerRow('الخزنة', shift.cashbox_name)}
        ${headerRow('فاتح الوردية', shift.opened_by_name)}
        ${headerRow('وقت الفتح', fmtTime(shift.opened_at))}
        ${headerRow('وقت طلب الإغلاق', fmtTime((shift as any).close_requested_at))}
        ${headerRow('وقت الاعتماد / الإغلاق', fmtTime((shift as any).close_approved_at || shift.closed_at))}
        ${headerRow('تمت الموافقة بواسطة', (shift as any).close_approved_by_name || (shift as any).closed_by_name)}
        ${headerRow('المستخدم مُصدِر التقرير', opts.generatedByName)}
      </tbody>
    </table>

    <h2 style="margin:18px 0 6px;">الملخص المالي</h2>
    <table>
      <tbody>
        ${summaryRow('رصيد بداية الوردية', EGP(s.opening_balance))}
        ${summaryRow('إجمالي الداخل', EGP(s.total_cash_in))}
        ${summaryRow('مبيعات نقدية', EGP(s.payment_breakdown?.cash?.amount || 0))}
        ${summaryRow('قبض من عملاء', EGP(s.customer_receipts))}
        ${summaryRow('المرتجعات', EGP(s.total_returns))}
        ${summaryRow('المصروفات التشغيلية', EGP(s.total_operating_expenses))}
        ${summaryRow('سلف الموظفين', EGP(s.total_employee_advances))}
        ${summaryRow('صرف مستحقات الموظفين', EGP(s.total_employee_settlements))}
        ${summaryRow('إجمالي حركات الموظفين النقدية', EGP(s.total_employee_cash_out), true, '#7c3aed')}
        ${summaryRow('مدفوعات للموردين', EGP(s.supplier_payments))}
        ${summaryRow('خروج نقدي آخر', EGP(s.other_cash_out))}
        ${summaryRow('إجمالي الخروج النقدي', EGP(s.total_cash_out), true, '#dc2626')}
        ${summaryRow('الرصيد المتوقع', EGP(s.expected_closing), true)}
        ${summaryRow('المبلغ المعدود (الفعلي)', EGP(s.actual_closing ?? 0), true)}
        ${summaryRow('الفرق', varianceLabel, true, Math.abs(variance) < 0.01 ? '#15803d' : variance < 0 ? '#dc2626' : '#15803d')}
      </tbody>
    </table>

    <h2 style="margin:18px 0 6px;">المصروفات التشغيلية</h2>
    ${opExpensesTable}

    <h2 style="margin:18px 0 6px;">حركات موظفين نقدية</h2>
    ${ecmTable}

    <h2 style="margin:18px 0 6px;">حركات الخزنة</h2>
    ${cashboxBlock}

    <h2 style="margin:18px 0 6px;">المبيعات والمدفوعات</h2>
    ${salesBlock}

    <h2 style="margin:18px 0 6px;">سجل تعديلات مبلغ الإقفال</h2>
    ${adjustmentTable}

    ${
      (shift as any).close_requested_notes
        ? `<h2 style="margin:18px 0 6px;">ملاحظات الإقفال</h2>
           <div style="padding:8px;border:1px solid #ddd;background:#fffbea;">${escapeHtml(
             (shift as any).close_requested_notes,
           )}</div>`
        : ''
    }
  `;
}

/* ─── Excel sheets (exportMultiSheet input) ──────────────────────── */

export function buildShiftReportSheets(opts: {
  shift: Shift;
  summary: ShiftSummary;
  adjustments: ShiftCountAdjustment[];
  generatedByName?: string | null;
}): Array<{ name: string; rows: any[] }> {
  const { shift, summary: s, adjustments } = opts;

  /* Sheet 1 — Summary (header + financial totals as one flat table) */
  const summarySheet: any[] = [
    { 'البند': 'رقم الوردية', القيمة: shift.shift_no },
    { 'البند': 'الحالة', القيمة: STATUS_LABEL_AR[s.status] ?? s.status },
    { 'البند': 'الخزنة', القيمة: shift.cashbox_name || '—' },
    { 'البند': 'فاتح الوردية', القيمة: shift.opened_by_name || '—' },
    { 'البند': 'وقت الفتح', القيمة: fmtTime(shift.opened_at) },
    { 'البند': 'وقت الإغلاق', القيمة: fmtTime(shift.closed_at) },
    { 'البند': 'تاريخ إصدار التقرير', القيمة: fmtTime(new Date().toISOString()) },
    { 'البند': 'مُصدِر التقرير', القيمة: opts.generatedByName || '—' },
    { 'البند': '', القيمة: '' },
    { 'البند': '— الملخص المالي —', القيمة: '' },
    { 'البند': 'رصيد بداية الوردية', القيمة: Number(s.opening_balance) },
    { 'البند': 'إجمالي الداخل', القيمة: Number(s.total_cash_in) },
    { 'البند': 'مبيعات نقدية', القيمة: Number(s.payment_breakdown?.cash?.amount || 0) },
    { 'البند': 'قبض من عملاء', القيمة: Number(s.customer_receipts) },
    { 'البند': 'المرتجعات', القيمة: Number(s.total_returns) },
    { 'البند': 'المصروفات التشغيلية', القيمة: Number(s.total_operating_expenses) },
    { 'البند': 'سلف الموظفين', القيمة: Number(s.total_employee_advances) },
    { 'البند': 'صرف مستحقات الموظفين', القيمة: Number(s.total_employee_settlements) },
    { 'البند': 'إجمالي حركات الموظفين النقدية', القيمة: Number(s.total_employee_cash_out) },
    { 'البند': 'مدفوعات للموردين', القيمة: Number(s.supplier_payments) },
    { 'البند': 'خروج نقدي آخر', القيمة: Number(s.other_cash_out) },
    { 'البند': 'إجمالي الخروج النقدي', القيمة: Number(s.total_cash_out) },
    { 'البند': 'الرصيد المتوقع', القيمة: Number(s.expected_closing) },
    { 'البند': 'المبلغ المعدود (الفعلي)', القيمة: Number(s.actual_closing ?? 0) },
    { 'البند': 'الفرق', القيمة: Number(s.variance ?? 0) },
  ];

  /* Sheet 2 — Operating expenses */
  const opExpenses =
    s.expenses.length > 0
      ? s.expenses.map((e) => ({
          التاريخ: fmtDateOnly(e.expense_date),
          البند: e.category_name || '',
          الوصف: e.description || '',
          المبلغ: Number(e.amount),
          الخزنة: (e as any).cashbox_name || '',
          'تمت بواسطة': (e as any).created_by_name || '',
          'رقم القيد': (e as any).je_entry_no || '',
        }))
      : [{ التاريخ: 'لا توجد بيانات', البند: '', الوصف: '', المبلغ: '', الخزنة: '', 'تمت بواسطة': '', 'رقم القيد': '' }];

  /* Sheet 3 — Employee cash movements */
  const ecm =
    s.employee_cash_movements.length > 0
      ? s.employee_cash_movements.map((m) => ({
          'التاريخ والوقت': fmtTime(m.created_at),
          'الموظف المستلم': m.employee_name || '',
          النوع: m.type_label,
          المبلغ: Number(m.amount),
          الخزنة: m.cashbox_name || '',
          'تمت بواسطة': m.created_by_name || '',
          'رقم القيد': m.je_entry_no || '',
          'التأثير المحاسبي': m.accounting_impact,
          'حالة الربط': m.link_method === 'explicit' ? 'مرتبط بالوردية' : 'مطابقة تلقائية',
        }))
      : [
          {
            'التاريخ والوقت': 'لا توجد بيانات',
            'الموظف المستلم': '',
            النوع: '',
            المبلغ: '',
            الخزنة: '',
            'تمت بواسطة': '',
            'رقم القيد': '',
            'التأثير المحاسبي': '',
            'حالة الربط': '',
          },
        ];

  /* Sheet 4 — Cashbox movements */
  const cashboxMovements = [
    { البند: 'قبض من عملاء (in / receipt)', المبلغ: Number(s.customer_receipts) },
    { البند: 'مدفوعات للموردين (out / payment)', المبلغ: Number(s.supplier_payments) },
    { البند: 'حركات نقدية أخرى (داخل)', المبلغ: Number(s.other_cash_in) },
    { البند: 'حركات نقدية أخرى (خارج)', المبلغ: Number(s.other_cash_out) },
    { البند: 'المرتجعات النقدية', المبلغ: Number(s.total_returns) },
  ];

  /* Sheet 5 — Count adjustments */
  const adjustmentSheet =
    adjustments.length > 0
      ? adjustments.map((a) => ({
          'التاريخ والوقت': fmtTime(a.adjusted_at),
          'من عدّل': a.adjusted_by_name || '',
          السبب: a.reason,
          'المبلغ القديم': a.old_actual_closing == null ? '' : Number(a.old_actual_closing),
          'المبلغ الجديد': Number(a.new_actual_closing),
          'الفرق القديم': a.old_difference == null ? '' : Number(a.old_difference),
          'الفرق الجديد': a.new_difference == null ? '' : Number(a.new_difference),
        }))
      : [
          {
            'التاريخ والوقت': 'لا توجد بيانات',
            'من عدّل': '',
            السبب: '',
            'المبلغ القديم': '',
            'المبلغ الجديد': '',
            'الفرق القديم': '',
            'الفرق الجديد': '',
          },
        ];

  return [
    { name: 'الملخص', rows: summarySheet },
    { name: 'المصروفات التشغيلية', rows: opExpenses },
    { name: 'حركات موظفين نقدية', rows: ecm },
    { name: 'حركات الخزنة', rows: cashboxMovements },
    { name: 'تعديلات الإقفال', rows: adjustmentSheet },
  ];
}
