/**
 * PR-REPORTS-1 — Period-scoped report builders.
 *
 * Pure HTML + Excel sheet generators for two reports that span a date
 * range (the single-shift builder lives in ./shiftReportBuilder.ts):
 *
 *   1. All-shifts table report — every shift inside the window with
 *      cash / non-cash / sales / expenses / variance columns and a
 *      bottom totals row that exactly equals the sum of the rows.
 *
 *   2. Payment-channel report — `dashboard/payment-channels`-shaped
 *      data grouped by method then per-account, with share-of-grand
 *      already computed server-side.
 *
 * The builders take already-loaded data (no fetches) so they're safe
 * to unit-test and trivially deterministic.
 */

import type { Shift } from '@/api/shifts.api';
import type { PaymentChannelsResponse } from '@/api/dashboard.api';

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

/** A shift list row enriched with per-shift summary numbers (cash /
 *  non-cash / grand). The page loads `shiftsApi.list(...)` then fans
 *  out `shiftsApi.summary(id)` per shift to fill these in. */
export interface ShiftRowWithBreakdown extends Shift {
  cash_total?: number;
  non_cash_total?: number;
  grand_payment_total?: number;
}

const num = (v: string | number | null | undefined) => Number(v || 0);

export interface AllShiftsTotals {
  cash_total: number;
  non_cash_total: number;
  grand_payment_total: number;
  sales_total: number;
  expenses_total: number;
  invoice_count: number;
  variance_total: number;
}

export function computeAllShiftsTotals(
  rows: ShiftRowWithBreakdown[],
): AllShiftsTotals {
  return rows.reduce<AllShiftsTotals>(
    (acc, r) => {
      acc.cash_total += num(r.cash_total);
      acc.non_cash_total += num(r.non_cash_total);
      acc.grand_payment_total += num(r.grand_payment_total);
      acc.sales_total += num(r.total_sales);
      acc.expenses_total += num(r.total_expenses);
      acc.invoice_count += num(r.invoice_count);
      acc.variance_total += num(r.variance);
      return acc;
    },
    {
      cash_total: 0,
      non_cash_total: 0,
      grand_payment_total: 0,
      sales_total: 0,
      expenses_total: 0,
      invoice_count: 0,
      variance_total: 0,
    },
  );
}

/* ─── Report 2 — All shifts in a window ─────────────────────────── */

export function buildAllShiftsReportHtml(opts: {
  rows: ShiftRowWithBreakdown[];
  from: string;
  to: string;
  rangeLabel?: string;
  generatedByName?: string | null;
}): string {
  const { rows, from, to, rangeLabel, generatedByName } = opts;
  const totals = computeAllShiftsTotals(rows);

  const header = `
    <div class="muted" style="margin-bottom:8px;">
      الفترة: ${escapeHtml(rangeLabel || `من ${from} إلى ${to}`)}
      ${generatedByName ? ` · مُصدِر التقرير: ${escapeHtml(generatedByName)}` : ''}
      · عدد الورديات: ${rows.length}
    </div>`;

  if (rows.length === 0) {
    return `${header}<div class="muted">لا توجد ورديات داخل الفترة المحددة.</div>`;
  }

  const body = rows
    .map((r) => {
      const variance = num(r.variance);
      const varianceColor =
        Math.abs(variance) < 0.01
          ? '#15803d'
          : variance < 0
            ? '#dc2626'
            : '#15803d';
      return `
        <tr>
          <td>${escapeHtml(r.shift_no)}</td>
          <td>${escapeHtml(fmtDateOnly(r.opened_at))}</td>
          <td>${escapeHtml(r.opened_by_name || '—')}</td>
          <td>${escapeHtml(r.cashbox_name || '—')}</td>
          <td>${escapeHtml(fmtTime(r.opened_at))}</td>
          <td>${escapeHtml(fmtTime(r.closed_at))}</td>
          <td>${escapeHtml(STATUS_LABEL_AR[r.status] ?? r.status)}</td>
          <td class="right">${escapeHtml(EGP(r.cash_total ?? 0))}</td>
          <td class="right">${escapeHtml(EGP(r.non_cash_total ?? 0))}</td>
          <td class="right">${escapeHtml(EGP(r.grand_payment_total ?? 0))}</td>
          <td class="right">${escapeHtml(EGP(r.total_sales))}</td>
          <td class="right">${r.invoice_count}</td>
          <td class="right">${escapeHtml(EGP(r.total_expenses))}</td>
          <td class="right" style="color:${varianceColor};font-weight:bold;">
            ${escapeHtml(EGP(variance))}
          </td>
          <td>${escapeHtml((r as any).notes || '—')}</td>
        </tr>`;
    })
    .join('');

  return `
    ${header}
    <table>
      <thead>
        <tr>
          <th>رقم الوردية</th>
          <th>التاريخ</th>
          <th>الكاشير</th>
          <th>الخزنة</th>
          <th>وقت الفتح</th>
          <th>وقت الإغلاق</th>
          <th>الحالة</th>
          <th>كاش</th>
          <th>غير نقدي</th>
          <th>إجمالي التحصيلات</th>
          <th>إجمالي المبيعات</th>
          <th>عدد الفواتير</th>
          <th>المصروفات</th>
          <th>الفرق</th>
          <th>ملاحظات</th>
        </tr>
      </thead>
      <tbody>${body}</tbody>
      <tfoot>
        <tr style="background:#f1f5f9;font-weight:bold;">
          <td colspan="7" class="right">الإجمالي</td>
          <td class="right">${escapeHtml(EGP(totals.cash_total))}</td>
          <td class="right">${escapeHtml(EGP(totals.non_cash_total))}</td>
          <td class="right">${escapeHtml(EGP(totals.grand_payment_total))}</td>
          <td class="right">${escapeHtml(EGP(totals.sales_total))}</td>
          <td class="right">${totals.invoice_count}</td>
          <td class="right">${escapeHtml(EGP(totals.expenses_total))}</td>
          <td class="right">${escapeHtml(EGP(totals.variance_total))}</td>
          <td></td>
        </tr>
      </tfoot>
    </table>`;
}

export function buildAllShiftsReportSheets(opts: {
  rows: ShiftRowWithBreakdown[];
  from: string;
  to: string;
}): Array<{ name: string; rows: any[] }> {
  const { rows } = opts;
  const totals = computeAllShiftsTotals(rows);

  const shiftsSheet = rows.map((r) => ({
    'رقم الوردية': r.shift_no,
    التاريخ: fmtDateOnly(r.opened_at),
    الكاشير: r.opened_by_name || '',
    الخزنة: r.cashbox_name || '',
    'وقت الفتح': fmtTime(r.opened_at),
    'وقت الإغلاق': fmtTime(r.closed_at),
    الحالة: STATUS_LABEL_AR[r.status] ?? r.status,
    كاش: num(r.cash_total),
    'غير نقدي': num(r.non_cash_total),
    'إجمالي التحصيلات': num(r.grand_payment_total),
    'إجمالي المبيعات': num(r.total_sales),
    'عدد الفواتير': num(r.invoice_count),
    المصروفات: num(r.total_expenses),
    الفرق: num(r.variance),
    ملاحظات: (r as any).notes || '',
  }));

  const totalsSheet = [
    { البند: 'الفترة من', القيمة: opts.from },
    { البند: 'الفترة إلى', القيمة: opts.to },
    { البند: 'عدد الورديات', القيمة: rows.length },
    { البند: 'إجمالي الكاش', القيمة: totals.cash_total },
    { البند: 'إجمالي التحصيلات غير النقدية', القيمة: totals.non_cash_total },
    { البند: 'إجمالي التحصيلات', القيمة: totals.grand_payment_total },
    { البند: 'إجمالي المبيعات', القيمة: totals.sales_total },
    { البند: 'إجمالي عدد الفواتير', القيمة: totals.invoice_count },
    { البند: 'إجمالي المصروفات', القيمة: totals.expenses_total },
    { البند: 'إجمالي الفروقات', القيمة: totals.variance_total },
  ];

  return [
    { name: 'الورديات', rows: shiftsSheet },
    { name: 'الإجماليات', rows: totalsSheet },
  ];
}

/* ─── Report 3 — Payment method / account ───────────────────────── */

export function buildPaymentChannelsReportHtml(opts: {
  data: PaymentChannelsResponse;
  rangeLabel?: string;
  generatedByName?: string | null;
}): string {
  const { data, rangeLabel, generatedByName } = opts;
  const grand = Number(data.grand_total || 0);

  const header = `
    <div class="muted" style="margin-bottom:8px;">
      الفترة: ${escapeHtml(
        rangeLabel || `من ${data.range.from} إلى ${data.range.to}`,
      )}
      ${generatedByName ? ` · مُصدِر التقرير: ${escapeHtml(generatedByName)}` : ''}
    </div>`;

  if (data.channels.length === 0) {
    return `${header}<div class="muted">لا توجد تحصيلات داخل الفترة المحددة.</div>`;
  }

  /* Method-level summary */
  const methodRows = data.channels
    .map(
      (m) => `
        <tr>
          <td>${escapeHtml(m.method_label_ar || m.method)}</td>
          <td class="right">${escapeHtml(EGP(m.total_amount))}</td>
          <td class="right">${m.invoice_count}</td>
          <td class="right">${m.payment_count}</td>
          <td class="right">${m.share_pct.toFixed(2)}%</td>
        </tr>`,
    )
    .join('');

  /* Account-level breakdown — flat with method on every row */
  const accountRows = data.channels
    .flatMap((m) =>
      m.accounts.map((a) => ({
        method: m.method_label_ar || m.method,
        display: a.display_name || m.method_label_ar || m.method,
        identifier: a.identifier || '—',
        provider: a.provider_key || '—',
        amount: a.total_amount,
        invoice_count: a.invoice_count,
        payment_count: a.payment_count,
        share_pct: a.share_pct,
      })),
    )
    .map(
      (r) => `
        <tr>
          <td>${escapeHtml(r.method)}</td>
          <td>${escapeHtml(r.display)}</td>
          <td>${escapeHtml(r.identifier)}</td>
          <td>${escapeHtml(r.provider)}</td>
          <td class="right">${escapeHtml(EGP(r.amount))}</td>
          <td class="right">${r.invoice_count}</td>
          <td class="right">${r.payment_count}</td>
          <td class="right">${r.share_pct.toFixed(2)}%</td>
        </tr>`,
    )
    .join('');

  return `
    ${header}
    <h2 style="margin:18px 0 6px;">الإجماليات</h2>
    <table>
      <tbody>
        <tr>
          <td style="background:#f8fafc;font-weight:bold;width:35%;">إجمالي الكاش</td>
          <td class="right">${escapeHtml(EGP(data.cash_total))}</td>
        </tr>
        <tr>
          <td style="background:#f8fafc;font-weight:bold;">إجمالي التحصيلات غير النقدية</td>
          <td class="right">${escapeHtml(EGP(data.non_cash_total))}</td>
        </tr>
        <tr>
          <td style="background:#f8fafc;font-weight:bold;">الإجمالي الكلي</td>
          <td class="right" style="font-weight:bold;">${escapeHtml(EGP(grand))}</td>
        </tr>
      </tbody>
    </table>

    <h2 style="margin:18px 0 6px;">حسب وسيلة الدفع</h2>
    <table>
      <thead>
        <tr>
          <th>الوسيلة</th>
          <th>المبلغ</th>
          <th>عدد الفواتير</th>
          <th>عدد الدفعات</th>
          <th>النسبة</th>
        </tr>
      </thead>
      <tbody>${methodRows}</tbody>
      <tfoot>
        <tr style="background:#f1f5f9;font-weight:bold;">
          <td>الإجمالي</td>
          <td class="right">${escapeHtml(EGP(grand))}</td>
          <td class="right">—</td>
          <td class="right">—</td>
          <td class="right">100.00%</td>
        </tr>
      </tfoot>
    </table>

    <h2 style="margin:18px 0 6px;">حسب الحساب</h2>
    <table>
      <thead>
        <tr>
          <th>الوسيلة</th>
          <th>اسم الحساب</th>
          <th>المعرّف</th>
          <th>المزود</th>
          <th>المبلغ</th>
          <th>عدد الفواتير</th>
          <th>عدد الدفعات</th>
          <th>النسبة</th>
        </tr>
      </thead>
      <tbody>${accountRows}</tbody>
      <tfoot>
        <tr style="background:#f1f5f9;font-weight:bold;">
          <td colspan="4" class="right">الإجمالي</td>
          <td class="right">${escapeHtml(EGP(grand))}</td>
          <td class="right">—</td>
          <td class="right">—</td>
          <td class="right">100.00%</td>
        </tr>
      </tfoot>
    </table>`;
}

export function buildPaymentChannelsReportSheets(opts: {
  data: PaymentChannelsResponse;
}): Array<{ name: string; rows: any[] }> {
  const { data } = opts;

  const byMethod = data.channels.map((m) => ({
    الوسيلة: m.method_label_ar || m.method,
    المبلغ: m.total_amount,
    'عدد الفواتير': m.invoice_count,
    'عدد الدفعات': m.payment_count,
    'النسبة %': m.share_pct,
  }));

  const byAccount = data.channels.flatMap((m) =>
    m.accounts.map((a) => ({
      الوسيلة: m.method_label_ar || m.method,
      'اسم الحساب': a.display_name || m.method_label_ar || m.method,
      المعرّف: a.identifier || '',
      المزود: a.provider_key || '',
      المبلغ: a.total_amount,
      'عدد الفواتير': a.invoice_count,
      'عدد الدفعات': a.payment_count,
      'النسبة %': a.share_pct,
    })),
  );

  return [
    { name: 'حسب الوسيلة', rows: byMethod.length ? byMethod : [{ الوسيلة: 'لا توجد بيانات' }] },
    { name: 'حسب الحساب', rows: byAccount.length ? byAccount : [{ الوسيلة: 'لا توجد بيانات' }] },
  ];
}
