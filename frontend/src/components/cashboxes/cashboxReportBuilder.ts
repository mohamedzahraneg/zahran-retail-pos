/**
 * cashboxReportBuilder.ts — PR-FIN-PAYACCT-4D-REPORTS-1B
 * ────────────────────────────────────────────────────────────────────
 *
 * Pure builders for the cashbox-movements report (Excel rows + Print
 * HTML). Same inputs always produce same output — no fetches, no DOM
 * access, no mutations.
 *
 * Consumers:
 *   • `exportToExcel(filename, buildExcelRows(input), 'حركات الخزنة')`
 *   • `printReport(buildReportTitle(input), buildPrintHtml(input))`
 *
 * Read-only by design — the builders never write, never call any
 * API instance. They take pre-loaded rows from the
 * `/cash-desk/cashboxes/:id/movements-unified` query response. The
 * accompanying spec verifies this at the source-code level so a
 * future regression that imports a write primitive will fail CI
 * before it can ship.
 */

import type {
  Cashbox,
  CashboxKind,
  CashboxMovementUnifiedRow,
} from '@/api/cash-desk.api';
import {
  type PaymentMethodCode,
  METHOD_LABEL_AR,
} from '@/api/payments.api';
import {
  formatArabicDate,
  formatArabicDateTime,
} from '@/lib/format-arabic-date';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const KIND_LABEL_AR: Record<CashboxKind, string> = {
  cash:    'نقدي',
  bank:    'بنكي',
  ewallet: 'محفظة إلكترونية',
  check:   'شيكات',
};

const SOURCE_LABEL_AR: Record<string, string> = {
  cashbox_txn:      'حركة خزنة مباشرة',
  invoice_payment:  'دفعة فاتورة',
  customer_payment: 'سند قبض من عميل',
  supplier_payment: 'سند صرف لمورد',
};

const escapeHtml = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

export interface CashboxReportInput {
  cashbox: Pick<Cashbox, 'name' | 'name_ar' | 'kind' | 'currency'>;
  /** ISO from/to as the operator selected — undefined when "all time". */
  range: { from?: string; to?: string };
  /** Currently visible / sorted rows (the FE never invents rows). */
  rows: CashboxMovementUnifiedRow[];
  /**
   * Totals as returned by the backend for the SAME filter window.
   * Used in the print header so the report always matches the table
   * the operator sees.
   */
  totals: { in: string; out: string; net: string; count: number };
}

/**
 * Excel filename slug — Arabic-safe + filesystem-safe. Strips
 * punctuation that breaks Windows file picker tooltips and
 * collapses spaces to underscores.
 */
export function buildExcelFilename(input: CashboxReportInput): string {
  const base =
    (input.cashbox.name_ar || input.cashbox.name || 'cashbox')
      .replace(/[\\/:*?"<>|]/g, '')
      .trim()
      .replace(/\s+/g, '_');
  const today = new Date().toISOString().slice(0, 10);
  return `cashbox-report-${base}-${today}`;
}

/**
 * Operator-facing report title (used for both the print `<h1>` and
 * the printReport window `<title>`). Includes cashbox name + window.
 */
export function buildReportTitle(input: CashboxReportInput): string {
  const name = input.cashbox.name_ar || input.cashbox.name || '—';
  const range = formatRangeLabel(input.range);
  return `تقرير حركات الخزنة — ${name}${range ? ` — ${range}` : ''}`;
}

function formatRangeLabel(range: CashboxReportInput['range']): string {
  if (!range.from && !range.to) return '';
  const f = range.from ? formatArabicDate(range.from) : '';
  const t = range.to   ? formatArabicDate(range.to)   : '';
  if (f && t) return `من ${f} إلى ${t}`;
  if (f)      return `منذ ${f}`;
  if (t)      return `حتى ${t}`;
  return '';
}

/**
 * Excel rows. Arabic column headers, money columns kept as plain
 * numerics (no "ج.م" suffix) so Excel treats them as numbers and the
 * operator can SUM/sort. Datetime is the operator-spec compact format
 * `DD/MM/YYYY HH:mm:ss`.
 *
 * Returns one row per movement plus, when totals exist, two
 * trailing-totals rows that are visually marked so the operator
 * knows they're aggregates, not actual movements.
 */
export function buildExcelRows(
  input: CashboxReportInput,
): Record<string, unknown>[] {
  const rows = input.rows.map((r) => ({
    'التاريخ والوقت':       formatArabicDateTime(r.occurred_at),
    'المصدر':               SOURCE_LABEL_AR[r.source] ?? r.source,
    'نوع العملية':          r.kind_ar ?? '',
    'رقم المرجع':           r.reference_no ?? '',
    'الطرف المقابل':        r.counterparty_name ?? '',
    'الداخل':               Number(r.amount_in  ?? 0),
    'الخارج':               Number(r.amount_out ?? 0),
    'الصافي':               Number(r.net_amount ?? 0),
    'الرصيد بعد الحركة':    r.balance_after !== null && r.balance_after !== undefined
                              ? Number(r.balance_after)
                              : '',
    'وسيلة الدفع':          r.payment_method
                              ? METHOD_LABEL_AR[r.payment_method as PaymentMethodCode] ?? r.payment_method
                              : '',
    'حساب الدفع':           r.payment_account_id ?? '',
    'رقم القيد':            r.journal_entry_no ?? '',
    'المستخدم':             r.user_name ?? '',
    'ملاحظات':              r.notes ?? '',
  }));

  // Trailing summary rows so the workbook is self-explanatory if
  // someone opens it without context. Marked with an empty-source
  // cell + an "إجماليات" marker in the date column.
  const summaryHeader = {
    'التاريخ والوقت':    '— إجماليات الصفوف المعروضة —',
    'المصدر':            '',
    'نوع العملية':       '',
    'رقم المرجع':        '',
    'الطرف المقابل':     '',
    'الداخل':            Number(input.totals.in  ?? 0),
    'الخارج':            Number(input.totals.out ?? 0),
    'الصافي':            Number(input.totals.net ?? 0),
    'الرصيد بعد الحركة': '',
    'وسيلة الدفع':       '',
    'حساب الدفع':        '',
    'رقم القيد':         '',
    'المستخدم':          '',
    'ملاحظات':           `عدد الحركات: ${input.totals.count}`,
  };
  return rows.length === 0 ? [] : [...rows, summaryHeader];
}

/**
 * Print/PDF HTML body for `printReport(title, htmlBody)`. Includes
 * the report header (cashbox + range + totals + generated_at),
 * the rows table, and a read-only footer line. RTL by default — the
 * `printReport` window already wraps everything in `<html dir="rtl">`.
 */
export function buildPrintHtml(input: CashboxReportInput): string {
  const name     = input.cashbox.name_ar || input.cashbox.name || '—';
  const kind     = KIND_LABEL_AR[input.cashbox.kind] ?? String(input.cashbox.kind);
  const currency = input.cashbox.currency || 'EGP';
  const range    = formatRangeLabel(input.range) || 'كل الفترات';
  const generatedAt = formatArabicDateTime(new Date().toISOString());

  const headerTable = `
    <table class="meta">
      <tr><th>اسم الخزنة</th><td>${escapeHtml(name)}</td>
          <th>النوع</th><td>${escapeHtml(kind)}</td></tr>
      <tr><th>العملة</th><td>${escapeHtml(currency)}</td>
          <th>الفترة</th><td>${escapeHtml(range)}</td></tr>
      <tr><th>عدد الحركات</th><td>${escapeHtml(String(input.totals.count))}</td>
          <th>تاريخ التقرير</th><td>${escapeHtml(generatedAt)}</td></tr>
    </table>`;

  const totalsTable = `
    <table class="totals">
      <tr>
        <th>إجمالي الداخل</th>
        <td class="positive">${escapeHtml(EGP(input.totals.in))}</td>
        <th>إجمالي الخارج</th>
        <td class="negative">${escapeHtml(EGP(input.totals.out))}</td>
        <th>صافي الحركة</th>
        <td class="${Number(input.totals.net) >= 0 ? 'positive' : 'negative'}">
          ${escapeHtml(EGP(input.totals.net))}
        </td>
      </tr>
    </table>`;

  const rowsBody = input.rows.length === 0
    ? `<tr><td colspan="13" class="empty">لا توجد حركات للعرض في هذه الفترة</td></tr>`
    : input.rows.map((r) => {
        const sourceLabel = SOURCE_LABEL_AR[r.source] ?? r.source;
        const methodLabel = r.payment_method
          ? METHOD_LABEL_AR[r.payment_method as PaymentMethodCode] ?? r.payment_method
          : '';
        return `
          <tr>
            <td class="dt">${escapeHtml(formatArabicDateTime(r.occurred_at))}</td>
            <td>${escapeHtml(sourceLabel)}</td>
            <td>${escapeHtml(r.kind_ar ?? '')}</td>
            <td class="mono">${escapeHtml(r.reference_no ?? '—')}</td>
            <td>${escapeHtml(r.counterparty_name ?? '—')}</td>
            <td class="mono positive">${escapeHtml(Number(r.amount_in)  > 0 ? EGP(r.amount_in)  : '—')}</td>
            <td class="mono negative">${escapeHtml(Number(r.amount_out) > 0 ? EGP(r.amount_out) : '—')}</td>
            <td class="mono">${escapeHtml(EGP(r.net_amount))}</td>
            <td class="mono">${escapeHtml(
              r.balance_after !== null && r.balance_after !== undefined
                ? EGP(r.balance_after)
                : '—',
            )}</td>
            <td>${escapeHtml(methodLabel || '—')}</td>
            <td class="mono">${escapeHtml(r.journal_entry_no ?? '—')}</td>
            <td>${escapeHtml(r.user_name ?? '—')}</td>
            <td class="notes">${escapeHtml(r.notes ?? '')}</td>
          </tr>`;
      }).join('');

  const styles = `
    <style>
      .meta, .totals, .rows { width: 100%; border-collapse: collapse; margin: 8px 0 12px; }
      .meta th, .meta td, .totals th, .totals td { border: 1px solid #ddd; padding: 5px 8px; text-align: right; font-size: 12px; }
      .meta th, .totals th { background: #f1f5f9; }
      .rows th, .rows td { border: 1px solid #e2e8f0; padding: 4px 6px; text-align: right; font-size: 11px; }
      .rows th { background: #f8fafc; font-weight: bold; }
      .rows .dt { white-space: nowrap; }
      .rows .mono { font-family: 'Tajawal','Courier New',monospace; }
      .rows .positive { color: #047857; }
      .rows .negative { color: #b91c1c; }
      .rows .notes { max-width: 200px; }
      .rows .empty { text-align: center; color: #64748b; padding: 20px; }
      .footer { margin-top: 14px; font-size: 11px; color: #64748b; border-top: 1px dashed #cbd5e1; padding-top: 8px; }
    </style>
  `;

  return `
    ${styles}
    ${headerTable}
    ${totalsTable}
    <table class="rows">
      <thead>
        <tr>
          <th>التاريخ والوقت</th>
          <th>المصدر</th>
          <th>نوع العملية</th>
          <th>رقم المرجع</th>
          <th>الطرف المقابل</th>
          <th>الداخل</th>
          <th>الخارج</th>
          <th>الصافي</th>
          <th>الرصيد بعد الحركة</th>
          <th>وسيلة الدفع</th>
          <th>رقم القيد</th>
          <th>المستخدم</th>
          <th>ملاحظات</th>
        </tr>
      </thead>
      <tbody>
        ${rowsBody}
      </tbody>
    </table>
    <div class="footer">
      هذا التقرير للقراءة فقط ولا يُجري أي تعديل على البيانات.
    </div>
  `;
}
