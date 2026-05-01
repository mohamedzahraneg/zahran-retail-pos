/**
 * cashboxReportBuilder.test.ts — PR-FIN-PAYACCT-4D-REPORTS-1B
 *
 * Pure-function tests for the Excel/Print report builder. Uses real
 * production-shaped fixtures so the builder's output is pinned to
 * the exact shapes operators will see (rather than synthetic numbers).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { CashboxMovementUnifiedRow } from '@/api/cash-desk.api';
import {
  buildExcelFilename,
  buildExcelRows,
  buildPrintHtml,
  buildReportTitle,
} from '../cashboxReportBuilder';

const CASHBOX = {
  name:    'الرئيسية',
  name_ar: 'الخزينة الرئيسية',
  kind:    'cash' as const,
  currency: 'EGP',
};

const ROWS: CashboxMovementUnifiedRow[] = [
  {
    source: 'cashbox_txn',
    id: 'ct-1',
    direction: 'in',
    amount_in:  '1500.00',
    amount_out: '0',
    net_amount: '1500.00',
    kind_ar: 'مبيعات كاش',
    reference_type: 'invoice',
    reference_id: 'inv-1',
    reference_no: 'INV-2026-0001',
    counterparty_name: 'علي حسن',
    payment_account_id: null,
    payment_method: null,
    balance_after: '29800.00',
    user_id: 'u-1',
    user_name: 'محمود زهران',
    journal_entry_id: null,
    journal_entry_no: null,
    occurred_at: '2026-05-01T11:35:09Z',
    notes: 'دفعة كاش لفاتورة بيع',
  },
  {
    source: 'invoice_payment',
    id: 'ip-1',
    direction: 'in',
    amount_in:  '350.00',
    amount_out: '0',
    net_amount: '350.00',
    kind_ar: 'دفعة فاتورة',
    reference_type: 'invoice',
    reference_id: 'inv-2',
    reference_no: 'INV-2026-0002',
    counterparty_name: 'سامية محمد',
    payment_account_id: '4dbe8e84-ff41-4e1b-b298-8199d16ef839',
    payment_method: 'instapay',
    balance_after: null,
    user_id: 'u-1',
    user_name: 'محمود زهران',
    journal_entry_id: 'je-1',
    journal_entry_no: 'JE-2026-000333',
    occurred_at: '2026-05-01T09:42:19Z',
    notes: '',
  },
];

const TOTALS = { in: '1850.00', out: '0', net: '1850.00', count: 2 };

describe('buildReportTitle — PR-FIN-PAYACCT-4D-REPORTS-1B', () => {
  it('uses name_ar when present and includes the date range', () => {
    const t = buildReportTitle({
      cashbox: CASHBOX,
      range: { from: '2026-04-30', to: '2026-05-01' },
      rows: ROWS,
      totals: TOTALS,
    });
    expect(t).toMatch(/^تقرير حركات الخزنة/);
    expect(t).toMatch(/الخزينة الرئيسية/);
    expect(t).toMatch(/من /);
    expect(t).toMatch(/ إلى /);
  });

  it('falls back to name when name_ar is empty + omits range when both ends missing', () => {
    const t = buildReportTitle({
      cashbox: { ...CASHBOX, name_ar: '' as any },
      range: {},
      rows: ROWS,
      totals: TOTALS,
    });
    expect(t).toMatch(/الرئيسية/);
    expect(t).not.toMatch(/من /);
    expect(t).not.toMatch(/ إلى /);
  });
});

describe('buildExcelFilename — PR-FIN-PAYACCT-4D-REPORTS-1B', () => {
  it('uses name_ar, today, and stripped filesystem chars', () => {
    const f = buildExcelFilename({
      cashbox: { ...CASHBOX, name_ar: 'الخزينة الرئيسية / فرع 1' },
      range: {},
      rows: ROWS,
      totals: TOTALS,
    });
    // No filesystem-illegal chars.
    expect(f).not.toMatch(/[\\/:*?"<>|]/);
    // Has the YYYY-MM-DD suffix.
    expect(f).toMatch(/cashbox-report-/);
    expect(f).toMatch(/-\d{4}-\d{2}-\d{2}$/);
  });
});

describe('buildExcelRows — PR-FIN-PAYACCT-4D-REPORTS-1B', () => {
  it('renders Arabic column headers + appends a totals summary row', () => {
    const rows = buildExcelRows({
      cashbox: CASHBOX, range: {}, rows: ROWS, totals: TOTALS,
    });
    // 2 movement rows + 1 trailing summary row.
    expect(rows).toHaveLength(3);
    const sample = rows[0]!;
    // Arabic headers must be present as keys.
    expect(sample).toHaveProperty('التاريخ والوقت');
    expect(sample).toHaveProperty('المصدر');
    expect(sample).toHaveProperty('نوع العملية');
    expect(sample).toHaveProperty('رقم المرجع');
    expect(sample).toHaveProperty('الطرف المقابل');
    expect(sample).toHaveProperty('الداخل');
    expect(sample).toHaveProperty('الخارج');
    expect(sample).toHaveProperty('الصافي');
    expect(sample).toHaveProperty('الرصيد بعد الحركة');
    expect(sample).toHaveProperty('وسيلة الدفع');
    expect(sample).toHaveProperty('حساب الدفع');
    expect(sample).toHaveProperty('رقم القيد');
    expect(sample).toHaveProperty('المستخدم');
    expect(sample).toHaveProperty('ملاحظات');
  });

  it('money columns are typed Number (not "1500.00 ج.م") so Excel can SUM them', () => {
    const rows = buildExcelRows({
      cashbox: CASHBOX, range: {}, rows: ROWS, totals: TOTALS,
    });
    const r0: any = rows[0];
    expect(typeof r0['الداخل']).toBe('number');
    expect(typeof r0['الخارج']).toBe('number');
    expect(typeof r0['الصافي']).toBe('number');
    expect(r0['الداخل']).toBe(1500);
  });

  it('datetime column uses the operator-spec compact format DD/MM/YYYY HH:mm:ss', () => {
    const rows = buildExcelRows({
      cashbox: CASHBOX, range: {}, rows: ROWS, totals: TOTALS,
    });
    const r0: any = rows[0];
    expect(r0['التاريخ والوقت']).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
  });

  it('trailing summary row carries totals.in / totals.out / totals.net + count', () => {
    const rows = buildExcelRows({
      cashbox: CASHBOX, range: {}, rows: ROWS, totals: TOTALS,
    });
    const last: any = rows[rows.length - 1];
    expect(last['التاريخ والوقت']).toMatch(/إجماليات الصفوف المعروضة/);
    expect(last['الداخل']).toBe(1850);
    expect(last['الخارج']).toBe(0);
    expect(last['الصافي']).toBe(1850);
    expect(last['ملاحظات']).toMatch(/عدد الحركات: 2/);
  });

  it('returns [] when the input row list is empty (so we never produce a blank workbook)', () => {
    const rows = buildExcelRows({
      cashbox: CASHBOX, range: {}, rows: [], totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    expect(rows).toEqual([]);
  });

  it('does NOT leak raw JS Date / GMT shapes into the datetime column', () => {
    const noisyRow: CashboxMovementUnifiedRow = {
      ...ROWS[0]!,
      occurred_at: 'Wed Apr 29 2026 00:00:00 GMT+0300 (Eastern European Summer Time)',
    };
    const rows = buildExcelRows({
      cashbox: CASHBOX, range: {}, rows: [noisyRow], totals: TOTALS,
    });
    const r0: any = rows[0];
    expect(r0['التاريخ والوقت']).not.toMatch(/GMT\+0300/);
    expect(r0['التاريخ والوقت']).not.toMatch(/Wed Apr/);
  });
});

describe('buildPrintHtml — PR-FIN-PAYACCT-4D-REPORTS-1B', () => {
  it('includes cashbox name, kind, currency, range, totals, and the read-only footer', () => {
    const html = buildPrintHtml({
      cashbox: CASHBOX,
      range: { from: '2026-04-30', to: '2026-05-01' },
      rows: ROWS, totals: TOTALS,
    });
    expect(html).toMatch(/الخزينة الرئيسية/);
    expect(html).toMatch(/نقدي/);   // kind
    expect(html).toMatch(/EGP/);    // currency
    expect(html).toMatch(/من /);    // range header
    expect(html).toMatch(/إجمالي الداخل/);
    expect(html).toMatch(/إجمالي الخارج/);
    expect(html).toMatch(/صافي الحركة/);
    expect(html).toMatch(
      /هذا التقرير للقراءة فقط ولا يُجري أي تعديل على البيانات/,
    );
  });

  it('renders one <tr> per row with Arabic source labels (never raw schema codes)', () => {
    const html = buildPrintHtml({
      cashbox: CASHBOX, range: {}, rows: ROWS, totals: TOTALS,
    });
    // Arabic source labels rendered.
    expect(html).toMatch(/حركة خزنة مباشرة/);
    expect(html).toMatch(/دفعة فاتورة/);
    // Raw schema codes must NOT appear in user-visible cells (they may
    // appear as testid suffixes elsewhere, but the print HTML is operator-only).
    expect(html).not.toMatch(/>cashbox_txn</);
    expect(html).not.toMatch(/>invoice_payment</);
  });

  it('renders the empty-state row when no movements are passed (no crash, no fake data)', () => {
    const html = buildPrintHtml({
      cashbox: CASHBOX, range: {}, rows: [], totals: { in: '0', out: '0', net: '0', count: 0 },
    });
    expect(html).toMatch(/لا توجد حركات للعرض في هذه الفترة/);
  });

  it('escapes HTML special chars in user-supplied fields (notes / counterparty / cashbox name)', () => {
    const html = buildPrintHtml({
      cashbox: { ...CASHBOX, name_ar: '<script>alert(1)</script>' },
      range: {},
      rows: [{ ...ROWS[0]!, counterparty_name: 'A & B', notes: '<img src=x>' }],
      totals: TOTALS,
    });
    expect(html).not.toMatch(/<script>alert/);
    expect(html).not.toMatch(/<img src=x>/);
    expect(html).toMatch(/&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    expect(html).toMatch(/A &amp; B/);
    expect(html).toMatch(/&lt;img src=x&gt;/);
  });

  it('does NOT leak raw JS Date / GMT shapes anywhere in the output', () => {
    const noisyRow: CashboxMovementUnifiedRow = {
      ...ROWS[0]!,
      occurred_at: 'Wed Apr 29 2026 00:00:00 GMT+0300 (Eastern European Summer Time)',
    };
    const html = buildPrintHtml({
      cashbox: CASHBOX, range: {}, rows: [noisyRow], totals: TOTALS,
    });
    expect(html).not.toMatch(/GMT\+0300/);
    expect(html).not.toMatch(/Wed Apr/);
    expect(html).not.toMatch(/Eastern European/);
  });
});

/**
 * PR-FIN-PAYACCT-4D-REPORTS-1B — read-only contract pinned at the
 * source-code level. Reads the builder module's text and asserts it
 * imports zero write/edit primitives. If a future edit accidentally
 * adds `useMutation`, calls `.mutate(...)`, or imports the API
 * `cashDeskApi`/`paymentsApi` instances (which expose write methods),
 * this test fails before the change can ship.
 *
 * The builder is supposed to be a pure function over already-loaded
 * data — never call APIs, never write.
 */
describe('cashboxReportBuilder source — PR-FIN-PAYACCT-4D-REPORTS-1B read-only contract', () => {
  it('imports zero write primitives (no useMutation, no .mutate(, no cashDeskApi instance)', () => {
    const path = resolve(__dirname, '..', 'cashboxReportBuilder.ts');
    const src = readFileSync(path, 'utf8');
    expect(src).not.toMatch(/\buseMutation\b/);
    expect(src).not.toMatch(/\.mutate\(/);
    // The builder is data-only — it must NOT pull in the API client.
    expect(src).not.toMatch(/from\s+['"]@\/api\/cash-desk\.api['"]\s*;.*cashDeskApi/);
    expect(src).not.toMatch(/from\s+['"]@\/api\/payments\.api['"]\s*;.*paymentsApi/);
  });
});
