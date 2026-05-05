/**
 * PR-SHIFT-REPORTS-AGGREGATED-DETAIL-FE
 *
 * Aggregated shift report builder — produces ONE consolidated HTML
 * document and ONE Excel workbook covering N selected shifts.
 *
 * Pure functions. Consumes the BE response from
 * `POST /shifts/reports/aggregate-detail`
 * (`shiftsApi.aggregateDetail({ shift_ids? | filters? })`). No fetches,
 * no DOM access, no React. Mirrors the structure of
 * `shiftReportBuilder.ts` (single-shift) but adds a per-row shift
 * context column (شر / تاريخ / كاشير / خزنة / وقت الحركة الأصلي) so
 * one combined table disambiguates rows across shifts.
 *
 * The builder NEVER prints "one report per shift" — every section
 * concatenates all selected shifts' rows into one table.
 */

import type {
  AggregateAdjustmentRow,
  AggregateCashboxMovementRow,
  AggregateDetailResponse,
  AggregateEmployeeMovementRow,
  AggregateExpenseRow,
  AggregateRefundMovementRow,
  PaymentBreakdownMethod,
} from '@/api/shifts.api';

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

const fmtDate = (iso: string | null | undefined) =>
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

/* ─── HTML report (printReport input) ───────────────────────────── */

export function buildAggregatedShiftReportHtml(
  data: AggregateDetailResponse,
): string {
  const { header, totals, sections } = data;
  const variance = Number(totals.variance ?? 0);
  const varianceLabel =
    totals.variance === null
      ? 'لا توجد ورديات مغلقة لحساب الفرق'
      : Math.abs(variance) < 0.01
        ? 'متوازنة (لا يوجد فرق)'
        : variance < 0
          ? `عجز ${EGP(Math.abs(variance))}`
          : `زيادة ${EGP(variance)}`;
  const actualClosingLabel =
    totals.actual_closing === null
      ? 'لا توجد ورديات مغلقة'
      : EGP(totals.actual_closing);

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
      <td class="right" ${
        bold || color
          ? `style="${bold ? 'font-weight:bold;' : ''}${color ? `color:${color};` : ''}"`
          : ''
      }>${escapeHtml(value)}</td>
    </tr>`;

  /* ─── 1. Selected shifts table (header) ─── */
  // PR-FIX-SHIFT-AGGREGATE-OPENING-CASH-BALANCE — added 5 financial
  // columns per shift (opening / expected / actual / variance / net).
  // Same numbers the single-shift report displays. Open shifts show
  // "—" for actual_closing and variance.
  const shiftsRows = header.shifts
    .map(
      (s) => `
        <tr>
          <td>${escapeHtml(s.shift_no)}</td>
          <td>${escapeHtml(fmtDate(s.opened_at))}</td>
          <td>${escapeHtml(s.cashier_name)}</td>
          <td>${escapeHtml(s.cashbox_name)}</td>
          <td>${escapeHtml(STATUS_LABEL_AR[s.status] ?? s.status)}</td>
          <td>${escapeHtml(fmtTime(s.opened_at))}</td>
          <td>${escapeHtml(fmtTime(s.closed_at))}</td>
          <td class="right">${escapeHtml(EGP(s.opening_balance))}</td>
          <td class="right">${escapeHtml(EGP(s.expected_closing))}</td>
          <td class="right">${s.actual_closing == null ? '—' : escapeHtml(EGP(s.actual_closing))}</td>
          <td class="right">${s.variance == null ? '—' : escapeHtml(EGP(s.variance))}</td>
          <td class="right">${escapeHtml(EGP(s.net_shift_amount))}</td>
        </tr>`,
    )
    .join('');
  const shiftsTable = `
    <table>
      <thead>
        <tr>
          <th>رقم الوردية</th>
          <th>التاريخ</th>
          <th>الكاشير</th>
          <th>الخزنة</th>
          <th>الحالة</th>
          <th>وقت الفتح</th>
          <th>وقت الإغلاق</th>
          <th>مبلغ الافتتاح</th>
          <th>المتوقع</th>
          <th>الإغلاق الفعلي</th>
          <th>الفرق</th>
          <th>الصافي</th>
        </tr>
      </thead>
      <tbody>${shiftsRows}</tbody>
      <tfoot>
        <tr style="background:#f1f5f9;font-weight:bold;">
          <td colspan="7" class="right">الإجمالي عبر الورديات المحددة</td>
          <td class="right">${escapeHtml(EGP(totals.opening_balance))}</td>
          <td class="right">${escapeHtml(EGP(totals.expected_closing))}</td>
          <td class="right">${totals.actual_closing == null ? '—' : escapeHtml(EGP(totals.actual_closing))}</td>
          <td class="right">${totals.variance == null ? '—' : escapeHtml(EGP(totals.variance))}</td>
          <td class="right">${escapeHtml(EGP(totals.net_shift_amount))}</td>
        </tr>
      </tfoot>
    </table>`;

  /* ─── 2. Operating expenses (concatenated) ─── */
  const opExpensesRows = sections.operating_expenses
    .map(
      (e: AggregateExpenseRow) => `
        <tr>
          <td>${escapeHtml(e.shift_no)}</td>
          <td>${escapeHtml(e.shift_date)}</td>
          <td>${escapeHtml(e.cashier_name)}</td>
          <td>${escapeHtml(e.cashbox_name)}</td>
          <td>${escapeHtml(fmtTime(e.original_movement_at))}</td>
          <td>${escapeHtml(e.category_name || '—')}</td>
          <td>${escapeHtml(e.description || '—')}</td>
          <td class="right">${escapeHtml(EGP(Number(e.amount)))}</td>
          <td>${escapeHtml((e as any).created_by_name || '—')}</td>
          <td>${escapeHtml((e as any).je_entry_no || '—')}</td>
        </tr>`,
    )
    .join('');
  const opExpensesTable =
    sections.operating_expenses.length === 0
      ? '<div class="muted">لا توجد مصروفات تشغيلية في الورديات المحددة.</div>'
      : `
        <table>
          <thead>
            <tr>
              <th>رقم الوردية</th>
              <th>تاريخ الوردية</th>
              <th>الكاشير</th>
              <th>الخزنة</th>
              <th>وقت الحركة الأصلي</th>
              <th>البند</th>
              <th>الوصف</th>
              <th>المبلغ</th>
              <th>تمت بواسطة</th>
              <th>رقم القيد</th>
            </tr>
          </thead>
          <tbody>${opExpensesRows}</tbody>
          <tfoot>
            <tr style="background:#f1f5f9;font-weight:bold;">
              <td colspan="7" class="right">الإجمالي عبر كل الورديات المحددة</td>
              <td class="right">${escapeHtml(EGP(totals.total_operating_expenses))}</td>
              <td colspan="2"></td>
            </tr>
          </tfoot>
        </table>`;

  /* ─── 3. Employee cash movements ─── */
  const ecmRows = sections.employee_cash_movements
    .map(
      (m: AggregateEmployeeMovementRow) => `
        <tr>
          <td>${escapeHtml(m.shift_no)}</td>
          <td>${escapeHtml(m.shift_date)}</td>
          <td>${escapeHtml(m.cashier_name)}</td>
          <td>${escapeHtml(m.cashbox_name)}</td>
          <td>${escapeHtml(fmtTime(m.original_movement_at))}</td>
          <td>${escapeHtml(m.employee_name || '—')}</td>
          <td>${escapeHtml(m.type_label)}</td>
          <td class="right">${escapeHtml(EGP(m.amount))}</td>
          <td>${escapeHtml(m.created_by_name || '—')}</td>
          <td>${escapeHtml(m.je_entry_no || '—')}</td>
          <td>${escapeHtml(m.accounting_impact)}</td>
          <td>${m.link_method === 'explicit' ? 'مرتبط بالوردية' : 'مطابقة تلقائية'}</td>
        </tr>`,
    )
    .join('');
  const ecmTable =
    sections.employee_cash_movements.length === 0
      ? '<div class="muted">لا توجد حركات موظفين نقدية في الورديات المحددة.</div>'
      : `
        <table>
          <thead>
            <tr>
              <th>رقم الوردية</th>
              <th>تاريخ الوردية</th>
              <th>الكاشير</th>
              <th>الخزنة</th>
              <th>وقت الحركة الأصلي</th>
              <th>الموظف المستلم</th>
              <th>النوع</th>
              <th>المبلغ</th>
              <th>تمت بواسطة</th>
              <th>رقم القيد</th>
              <th>التأثير المحاسبي</th>
              <th>حالة الربط</th>
            </tr>
          </thead>
          <tbody>${ecmRows}</tbody>
          <tfoot>
            <tr style="background:#f1f5f9;font-weight:bold;">
              <td colspan="7" class="right">الإجمالي عبر كل الورديات المحددة</td>
              <td class="right">${escapeHtml(EGP(totals.total_employee_cash_out))}</td>
              <td colspan="4"></td>
            </tr>
          </tfoot>
        </table>`;

  /* ─── 4. Cashbox movements (4 rows per shift) ─── */
  const CATEGORY_LABEL: Record<string, string> = {
    customer_receipts: 'قبض من عملاء',
    supplier_payments: 'مدفوعات للموردين',
    other_cash_in: 'حركات نقدية أخرى (داخل)',
    other_cash_out: 'حركات نقدية أخرى (خارج)',
  };
  const cashboxRows = sections.cashbox_movements
    .map(
      (m: AggregateCashboxMovementRow) => `
        <tr>
          <td>${escapeHtml(m.shift_no)}</td>
          <td>${escapeHtml(m.shift_date)}</td>
          <td>${escapeHtml(m.cashier_name)}</td>
          <td>${escapeHtml(m.cashbox_name)}</td>
          <td>${escapeHtml(CATEGORY_LABEL[m.category] || m.category)}</td>
          <td class="right">${escapeHtml(EGP(m.amount))}</td>
        </tr>`,
    )
    .join('');
  const cashboxTable =
    sections.cashbox_movements.length === 0
      ? '<div class="muted">لا توجد حركات خزن.</div>'
      : `
        <table>
          <thead>
            <tr>
              <th>رقم الوردية</th>
              <th>تاريخ الوردية</th>
              <th>الكاشير</th>
              <th>الخزنة</th>
              <th>البند</th>
              <th>المبلغ</th>
            </tr>
          </thead>
          <tbody>${cashboxRows}</tbody>
          <tfoot>
            <tr style="background:#f1f5f9;font-weight:bold;">
              <td colspan="4" class="right">إجمالي قبض العملاء</td>
              <td>قبض من عملاء</td>
              <td class="right">${escapeHtml(EGP(totals.customer_receipts))}</td>
            </tr>
            <tr style="background:#f1f5f9;font-weight:bold;">
              <td colspan="4" class="right">إجمالي مدفوعات الموردين</td>
              <td>مدفوعات للموردين</td>
              <td class="right">${escapeHtml(EGP(totals.supplier_payments))}</td>
            </tr>
            <tr style="background:#f1f5f9;font-weight:bold;">
              <td colspan="4" class="right">إجمالي حركات نقدية أخرى (داخل)</td>
              <td>حركات نقدية أخرى (داخل)</td>
              <td class="right">${escapeHtml(EGP(totals.other_cash_in))}</td>
            </tr>
            <tr style="background:#f1f5f9;font-weight:bold;">
              <td colspan="4" class="right">إجمالي حركات نقدية أخرى (خارج)</td>
              <td>حركات نقدية أخرى (خارج)</td>
              <td class="right">${escapeHtml(EGP(totals.other_cash_out))}</td>
            </tr>
          </tfoot>
        </table>`;

  /* ─── 5. Sales / payment breakdown (aggregated by method+account) ─── */
  const paymentRows = sections.payment_breakdown
    .flatMap((m: PaymentBreakdownMethod) => {
      if (!m.accounts || m.accounts.length === 0) {
        return [
          `<tr>
             <td>${escapeHtml(m.method_label_ar || m.method)}</td>
             <td>—</td>
             <td>—</td>
             <td>${m.invoice_count}</td>
             <td>${m.payment_count}</td>
             <td class="right">${escapeHtml(EGP(m.total_amount))}</td>
           </tr>`,
        ];
      }
      return m.accounts.map(
        (a) => `
          <tr>
            <td>${escapeHtml(m.method_label_ar || m.method)}</td>
            <td>${escapeHtml(a.display_name || m.method_label_ar || m.method)}</td>
            <td>${escapeHtml(a.identifier || '—')}</td>
            <td>${a.invoice_count}</td>
            <td>${a.payment_count}</td>
            <td class="right">${escapeHtml(EGP(a.total_amount))}</td>
          </tr>`,
      );
    })
    .join('');
  const paymentTable =
    sections.payment_breakdown.length === 0
      ? '<div class="muted">لا توجد دفعات.</div>'
      : `
        <table>
          <thead>
            <tr>
              <th>الوسيلة</th>
              <th>الحساب</th>
              <th>المعرّف</th>
              <th>عدد الفواتير</th>
              <th>عدد الدفعات</th>
              <th>الإجمالي</th>
            </tr>
          </thead>
          <tbody>${paymentRows}</tbody>
          <tfoot>
            <tr style="background:#f1f5f9;font-weight:bold;">
              <td colspan="5" class="right">إجمالي التحصيلات</td>
              <td class="right">${escapeHtml(EGP(totals.grand_payment_total))}</td>
            </tr>
          </tfoot>
        </table>`;

  /* ─── 6. Refund cash movements (concat) ─── */
  const refundRows = sections.refund_cash_movements
    .map(
      (m: AggregateRefundMovementRow) => `
        <tr>
          <td>${escapeHtml(m.shift_no)}</td>
          <td>${escapeHtml(m.shift_date)}</td>
          <td>${escapeHtml(m.cashier_name)}</td>
          <td>${escapeHtml(m.cashbox_name)}</td>
          <td>${escapeHtml(fmtTime(m.original_movement_at))}</td>
          <td>${escapeHtml(m.type_label)}</td>
          <td>${escapeHtml(m.direction_label)}</td>
          <td class="right">${escapeHtml(EGP(m.amount))}</td>
          <td>${escapeHtml(m.reference_no || '—')}</td>
          <td>${escapeHtml(m.customer_name || '—')}</td>
          <td>${escapeHtml(m.je_entry_no || '—')}</td>
        </tr>`,
    )
    .join('');
  const refundTable =
    sections.refund_cash_movements.length === 0
      ? '<div class="muted">لا توجد حركات مرتجعات نقدية.</div>'
      : `
        <table>
          <thead>
            <tr>
              <th>رقم الوردية</th>
              <th>تاريخ الوردية</th>
              <th>الكاشير</th>
              <th>الخزنة</th>
              <th>وقت الحركة الأصلي</th>
              <th>النوع</th>
              <th>الاتجاه</th>
              <th>المبلغ</th>
              <th>المرجع</th>
              <th>العميل</th>
              <th>رقم القيد</th>
            </tr>
          </thead>
          <tbody>${refundRows}</tbody>
        </table>`;

  /* ─── 7. Closing adjustments (concat) ─── */
  const adjRows = sections.closing_adjustments
    .map(
      (a: AggregateAdjustmentRow) => `
        <tr>
          <td>${escapeHtml(a.shift_no)}</td>
          <td>${escapeHtml(a.shift_date)}</td>
          <td>${escapeHtml(a.cashier_name)}</td>
          <td>${escapeHtml(a.cashbox_name)}</td>
          <td>${escapeHtml(fmtTime(a.original_movement_at))}</td>
          <td>${escapeHtml(a.adjusted_by_name || '—')}</td>
          <td>${escapeHtml(a.reason)}</td>
          <td class="right">${a.old_actual_closing == null ? '—' : escapeHtml(EGP(Number(a.old_actual_closing)))}</td>
          <td class="right">${escapeHtml(EGP(Number(a.new_actual_closing)))}</td>
          <td class="right">${a.old_difference == null ? '—' : escapeHtml(EGP(Number(a.old_difference)))}</td>
          <td class="right">${a.new_difference == null ? '—' : escapeHtml(EGP(Number(a.new_difference)))}</td>
        </tr>`,
    )
    .join('');
  const adjTable =
    sections.closing_adjustments.length === 0
      ? '<div class="muted">لا توجد تعديلات على مبالغ الإقفال.</div>'
      : `
        <table>
          <thead>
            <tr>
              <th>رقم الوردية</th>
              <th>تاريخ الوردية</th>
              <th>الكاشير</th>
              <th>الخزنة</th>
              <th>وقت التعديل الأصلي</th>
              <th>من عدّل</th>
              <th>السبب</th>
              <th>المبلغ القديم</th>
              <th>المبلغ الجديد</th>
              <th>الفرق القديم</th>
              <th>الفرق الجديد</th>
            </tr>
          </thead>
          <tbody>${adjRows}</tbody>
        </table>`;

  /* ─── Compose ─── */
  const cashiersLabel =
    header.cashiers.length === 0
      ? '—'
      : header.cashiers.map((c) => c.full_name || c.user_id).join(' · ');
  const cashboxesLabel =
    header.cashboxes.length === 0
      ? '—'
      : header.cashboxes.map((c) => c.name_ar || c.cashbox_id).join(' · ');
  const selectionModeLabel =
    header.selection_mode === 'explicit'
      ? 'الورديات المحددة يدوياً'
      : 'كل الورديات في الفلاتر الحالية';

  return `
    <h2 style="margin:18px 0 6px;">معلومات التقرير</h2>
    <table>
      <tbody>
        ${headerRow('وضع الاختيار', selectionModeLabel)}
        ${headerRow('من تاريخ', header.date_range.from)}
        ${headerRow('إلى تاريخ', header.date_range.to)}
        ${headerRow('عدد الورديات', header.shift_count)}
        ${headerRow('الكاشيرات المشمولة', cashiersLabel)}
        ${headerRow('الخزن المشمولة', cashboxesLabel)}
        ${headerRow('مُصدِر التقرير', header.generated_by.full_name || header.generated_by.user_id)}
        ${headerRow('وقت إصدار التقرير', fmtTime(header.generated_at))}
      </tbody>
    </table>

    <h2 style="margin:18px 0 6px;">الورديات المشمولة</h2>
    ${shiftsTable}

    <h2 style="margin:18px 0 6px;">الملخص المالي المجمّع</h2>
    <table>
      <tbody>
        ${summaryRow('إجمالي رصيد البداية', EGP(totals.opening_balance))}
        ${summaryRow('إجمالي المبيعات', EGP(totals.total_sales), true)}
        ${summaryRow('عدد الفواتير', String(totals.invoice_count))}
        ${summaryRow('مبيعات نقدية (كاش)', EGP(totals.cash_total))}
        ${summaryRow('مبيعات غير نقدية (محافظ / إنستا / تحويل / بطاقات)', EGP(totals.non_cash_total))}
        ${summaryRow('إجمالي التحصيلات', EGP(totals.grand_payment_total), true)}
        ${summaryRow('قبض من عملاء', EGP(totals.customer_receipts))}
        ${summaryRow('مدفوعات للموردين', EGP(totals.supplier_payments))}
        ${summaryRow('المرتجعات', EGP(totals.total_returns))}
        ${summaryRow('المصروفات التشغيلية', EGP(totals.total_operating_expenses))}
        ${summaryRow('سلف الموظفين', EGP(totals.total_employee_advances))}
        ${summaryRow('صرف مستحقات الموظفين', EGP(totals.total_employee_settlements))}
        ${summaryRow('إجمالي حركات الموظفين النقدية', EGP(totals.total_employee_cash_out), true, '#7c3aed')}
        ${summaryRow('حركات نقدية أخرى (داخل)', EGP(totals.other_cash_in))}
        ${summaryRow('حركات نقدية أخرى (خارج)', EGP(totals.other_cash_out))}
        ${summaryRow('صافي تأثير المرتجعات النقدية', EGP(totals.net_refund_cash_impact))}
        ${summaryRow('إجمالي الداخل', EGP(totals.total_cash_in), true, '#15803d')}
        ${summaryRow('إجمالي الخارج', EGP(totals.total_cash_out), true, '#dc2626')}
        ${summaryRow('الرصيد المتوقع (إجمالي)', EGP(totals.expected_closing), true)}
        ${summaryRow(`المبلغ المعدود (الفعلي) [${totals.closed_shift_count} وردية مغلقة]`, actualClosingLabel, true)}
        ${summaryRow('إجمالي الفروقات', varianceLabel, true, totals.variance === null || Math.abs(variance) < 0.01 ? '#15803d' : variance < 0 ? '#dc2626' : '#15803d')}
        ${summaryRow('صافي إجمالي الورديات', EGP(totals.net_shift_amount), true)}
      </tbody>
    </table>

    <h2 style="margin:18px 0 6px;">المصروفات التشغيلية</h2>
    ${opExpensesTable}

    <h2 style="margin:18px 0 6px;">حركات موظفين نقدية</h2>
    ${ecmTable}

    <h2 style="margin:18px 0 6px;">حركات الخزن</h2>
    ${cashboxTable}

    <h2 style="margin:18px 0 6px;">المبيعات والمدفوعات</h2>
    ${paymentTable}

    <h2 style="margin:18px 0 6px;">حركات المرتجعات النقدية</h2>
    ${refundTable}

    <h2 style="margin:18px 0 6px;">سجل تعديلات مبالغ الإقفال</h2>
    ${adjTable}
  `;
}

/* ─── Excel sheets (exportMultiSheet input) ─────────────────────── */

export function buildAggregatedShiftReportSheets(
  data: AggregateDetailResponse,
): Array<{ name: string; rows: any[] }> {
  const { header, totals, sections } = data;

  /* Sheet 1 — ملخص (header + financial totals) */
  const summarySheet: any[] = [
    {
      البند: 'وضع الاختيار',
      القيمة:
        header.selection_mode === 'explicit'
          ? 'الورديات المحددة يدوياً'
          : 'كل الورديات في الفلاتر الحالية',
    },
    { البند: 'من تاريخ', القيمة: header.date_range.from || '—' },
    { البند: 'إلى تاريخ', القيمة: header.date_range.to || '—' },
    { البند: 'عدد الورديات', القيمة: header.shift_count },
    {
      البند: 'الكاشيرات',
      القيمة:
        header.cashiers.map((c) => c.full_name || c.user_id).join(' · ') ||
        '—',
    },
    {
      البند: 'الخزن',
      القيمة:
        header.cashboxes.map((c) => c.name_ar || c.cashbox_id).join(' · ') ||
        '—',
    },
    {
      البند: 'مُصدِر التقرير',
      القيمة: header.generated_by.full_name || header.generated_by.user_id,
    },
    { البند: 'وقت إصدار التقرير', القيمة: fmtTime(header.generated_at) },
    { البند: '', القيمة: '' },
    { البند: '— الملخص المالي المجمّع —', القيمة: '' },
    { البند: 'إجمالي رصيد البداية', القيمة: Number(totals.opening_balance) },
    { البند: 'إجمالي المبيعات', القيمة: Number(totals.total_sales) },
    { البند: 'عدد الفواتير', القيمة: Number(totals.invoice_count) },
    { البند: 'مبيعات نقدية (كاش)', القيمة: Number(totals.cash_total) },
    { البند: 'مبيعات غير نقدية', القيمة: Number(totals.non_cash_total) },
    { البند: 'إجمالي التحصيلات', القيمة: Number(totals.grand_payment_total) },
    { البند: 'قبض من عملاء', القيمة: Number(totals.customer_receipts) },
    { البند: 'مدفوعات للموردين', القيمة: Number(totals.supplier_payments) },
    { البند: 'المرتجعات', القيمة: Number(totals.total_returns) },
    {
      البند: 'المصروفات التشغيلية',
      القيمة: Number(totals.total_operating_expenses),
    },
    {
      البند: 'سلف الموظفين',
      القيمة: Number(totals.total_employee_advances),
    },
    {
      البند: 'صرف مستحقات الموظفين',
      القيمة: Number(totals.total_employee_settlements),
    },
    {
      البند: 'إجمالي حركات الموظفين النقدية',
      القيمة: Number(totals.total_employee_cash_out),
    },
    { البند: 'حركات نقدية أخرى (داخل)', القيمة: Number(totals.other_cash_in) },
    { البند: 'حركات نقدية أخرى (خارج)', القيمة: Number(totals.other_cash_out) },
    {
      البند: 'صافي تأثير المرتجعات النقدية',
      القيمة: Number(totals.net_refund_cash_impact),
    },
    { البند: 'إجمالي الداخل', القيمة: Number(totals.total_cash_in) },
    { البند: 'إجمالي الخارج', القيمة: Number(totals.total_cash_out) },
    { البند: 'الرصيد المتوقع (إجمالي)', القيمة: Number(totals.expected_closing) },
    {
      البند: `المبلغ المعدود (إجمالي ${totals.closed_shift_count} وردية مغلقة)`,
      القيمة: totals.actual_closing == null ? '—' : Number(totals.actual_closing),
    },
    {
      البند: 'إجمالي الفروقات',
      القيمة: totals.variance == null ? '—' : Number(totals.variance),
    },
    { البند: 'صافي إجمالي الورديات', القيمة: Number(totals.net_shift_amount) },
  ];

  /* Sheet 2 — الورديات (selected shifts metadata + per-shift financials) */
  // PR-FIX-SHIFT-AGGREGATE-OPENING-CASH-BALANCE — same 5 financial
  // columns as the HTML "selected shifts" table.
  const shiftsSheet =
    header.shifts.length > 0
      ? header.shifts.map((s) => ({
          'رقم الوردية': s.shift_no,
          التاريخ: fmtDate(s.opened_at),
          الكاشير: s.cashier_name || '—',
          الخزنة: s.cashbox_name || '—',
          الحالة: STATUS_LABEL_AR[s.status] ?? s.status,
          'وقت الفتح': fmtTime(s.opened_at),
          'وقت الإغلاق': fmtTime(s.closed_at),
          'مبلغ الافتتاح': Number(s.opening_balance),
          المتوقع: Number(s.expected_closing),
          'الإغلاق الفعلي':
            s.actual_closing == null ? '' : Number(s.actual_closing),
          الفرق: s.variance == null ? '' : Number(s.variance),
          الصافي: Number(s.net_shift_amount),
        }))
      : [
          {
            'رقم الوردية': 'لا توجد ورديات',
            التاريخ: '',
            الكاشير: '',
            الخزنة: '',
            الحالة: '',
            'وقت الفتح': '',
            'وقت الإغلاق': '',
            'مبلغ الافتتاح': '',
            المتوقع: '',
            'الإغلاق الفعلي': '',
            الفرق: '',
            الصافي: '',
          },
        ];

  /* Sheet 3 — المصروفات */
  const opExpenses =
    sections.operating_expenses.length > 0
      ? sections.operating_expenses.map((e) => ({
          'رقم الوردية': e.shift_no,
          'تاريخ الوردية': e.shift_date || '',
          الكاشير: e.cashier_name || '',
          الخزنة: e.cashbox_name || '',
          'وقت الحركة الأصلي': fmtTime(e.original_movement_at),
          البند: e.category_name || '',
          الوصف: e.description || '',
          المبلغ: Number(e.amount),
          'تمت بواسطة': (e as any).created_by_name || '',
          'رقم القيد': (e as any).je_entry_no || '',
        }))
      : [
          {
            'رقم الوردية': 'لا توجد بيانات',
            'تاريخ الوردية': '',
            الكاشير: '',
            الخزنة: '',
            'وقت الحركة الأصلي': '',
            البند: '',
            الوصف: '',
            المبلغ: '',
            'تمت بواسطة': '',
            'رقم القيد': '',
          },
        ];

  /* Sheet 4 — حركات الموظفين */
  const ecm =
    sections.employee_cash_movements.length > 0
      ? sections.employee_cash_movements.map((m) => ({
          'رقم الوردية': m.shift_no,
          'تاريخ الوردية': m.shift_date || '',
          الكاشير: m.cashier_name || '',
          الخزنة: m.cashbox_name || '',
          'وقت الحركة الأصلي': fmtTime(m.original_movement_at),
          'الموظف المستلم': m.employee_name || '',
          النوع: m.type_label,
          المبلغ: Number(m.amount),
          'تمت بواسطة': m.created_by_name || '',
          'رقم القيد': m.je_entry_no || '',
          'التأثير المحاسبي': m.accounting_impact,
          'حالة الربط':
            m.link_method === 'explicit' ? 'مرتبط بالوردية' : 'مطابقة تلقائية',
        }))
      : [
          {
            'رقم الوردية': 'لا توجد بيانات',
            'تاريخ الوردية': '',
            الكاشير: '',
            الخزنة: '',
            'وقت الحركة الأصلي': '',
            'الموظف المستلم': '',
            النوع: '',
            المبلغ: '',
            'تمت بواسطة': '',
            'رقم القيد': '',
            'التأثير المحاسبي': '',
            'حالة الربط': '',
          },
        ];

  /* Sheet 5 — حركات الخزن */
  const CATEGORY_LABEL: Record<string, string> = {
    customer_receipts: 'قبض من عملاء',
    supplier_payments: 'مدفوعات للموردين',
    other_cash_in: 'حركات نقدية أخرى (داخل)',
    other_cash_out: 'حركات نقدية أخرى (خارج)',
  };
  const cashbox =
    sections.cashbox_movements.length > 0
      ? sections.cashbox_movements.map((m) => ({
          'رقم الوردية': m.shift_no,
          'تاريخ الوردية': m.shift_date || '',
          الكاشير: m.cashier_name || '',
          الخزنة: m.cashbox_name || '',
          البند: CATEGORY_LABEL[m.category] || m.category,
          المبلغ: Number(m.amount),
        }))
      : [
          {
            'رقم الوردية': 'لا توجد بيانات',
            'تاريخ الوردية': '',
            الكاشير: '',
            الخزنة: '',
            البند: '',
            المبلغ: '',
          },
        ];

  /* Sheet 6 — وسائل الدفع */
  const paymentRows = sections.payment_breakdown.flatMap((m) => {
    if (!m.accounts || m.accounts.length === 0) {
      return [
        {
          الوسيلة: m.method_label_ar || m.method,
          الحساب: '',
          المعرّف: '',
          'عدد الفواتير': Number(m.invoice_count),
          'عدد الدفعات': Number(m.payment_count),
          الإجمالي: Number(m.total_amount),
        },
      ];
    }
    return m.accounts.map((a) => ({
      الوسيلة: m.method_label_ar || m.method,
      الحساب: a.display_name || m.method_label_ar || m.method,
      المعرّف: a.identifier || '',
      'عدد الفواتير': Number(a.invoice_count),
      'عدد الدفعات': Number(a.payment_count),
      الإجمالي: Number(a.total_amount),
    }));
  });
  const payments =
    paymentRows.length > 0
      ? paymentRows
      : [
          {
            الوسيلة: 'لا توجد بيانات',
            الحساب: '',
            المعرّف: '',
            'عدد الفواتير': '',
            'عدد الدفعات': '',
            الإجمالي: '',
          },
        ];

  /* Sheet 7 — المرتجعات */
  const refunds =
    sections.refund_cash_movements.length > 0
      ? sections.refund_cash_movements.map((m) => ({
          'رقم الوردية': m.shift_no,
          'تاريخ الوردية': m.shift_date || '',
          الكاشير: m.cashier_name || '',
          الخزنة: m.cashbox_name || '',
          'وقت الحركة الأصلي': fmtTime(m.original_movement_at),
          النوع: m.type_label,
          الاتجاه: m.direction_label,
          المبلغ: Number(m.amount),
          المرجع: m.reference_no || '',
          العميل: m.customer_name || '',
          'رقم القيد': m.je_entry_no || '',
        }))
      : [
          {
            'رقم الوردية': 'لا توجد بيانات',
            'تاريخ الوردية': '',
            الكاشير: '',
            الخزنة: '',
            'وقت الحركة الأصلي': '',
            النوع: '',
            الاتجاه: '',
            المبلغ: '',
            المرجع: '',
            العميل: '',
            'رقم القيد': '',
          },
        ];

  /* Sheet 8 — سجل التعديلات */
  const adjustments =
    sections.closing_adjustments.length > 0
      ? sections.closing_adjustments.map((a) => ({
          'رقم الوردية': a.shift_no,
          'تاريخ الوردية': a.shift_date || '',
          الكاشير: a.cashier_name || '',
          الخزنة: a.cashbox_name || '',
          'وقت التعديل الأصلي': fmtTime(a.original_movement_at),
          'من عدّل': a.adjusted_by_name || '',
          السبب: a.reason,
          'المبلغ القديم':
            a.old_actual_closing == null ? '' : Number(a.old_actual_closing),
          'المبلغ الجديد': Number(a.new_actual_closing),
          'الفرق القديم':
            a.old_difference == null ? '' : Number(a.old_difference),
          'الفرق الجديد':
            a.new_difference == null ? '' : Number(a.new_difference),
        }))
      : [
          {
            'رقم الوردية': 'لا توجد بيانات',
            'تاريخ الوردية': '',
            الكاشير: '',
            الخزنة: '',
            'وقت التعديل الأصلي': '',
            'من عدّل': '',
            السبب: '',
            'المبلغ القديم': '',
            'المبلغ الجديد': '',
            'الفرق القديم': '',
            'الفرق الجديد': '',
          },
        ];

  return [
    { name: 'ملخص', rows: summarySheet },
    { name: 'الورديات', rows: shiftsSheet },
    { name: 'المصروفات', rows: opExpenses },
    { name: 'حركات الموظفين', rows: ecm },
    { name: 'حركات الخزن', rows: cashbox },
    { name: 'وسائل الدفع', rows: payments },
    { name: 'المرتجعات', rows: refunds },
    { name: 'سجل التعديلات', rows: adjustments },
  ];
}
