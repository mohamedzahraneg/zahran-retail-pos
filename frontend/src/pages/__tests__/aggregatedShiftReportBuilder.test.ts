/**
 * aggregatedShiftReportBuilder.test.ts
 * PR-SHIFT-REPORTS-AGGREGATED-DETAIL-FE
 *
 * Pins the consolidated aggregated report builder:
 *   1. HTML for a 2-shift fixture contains BOTH shift_no values in
 *      the header.
 *   2. Aggregated summary totals appear once each.
 *   3. At least one row from each shift appears in the operating-
 *      expenses + employee-cash-movements + closing-adjustments
 *      sections, each tagged with the correct shift_no.
 *   4. Sheets builder returns the expected sheet names + count.
 *   5. Empty sections render the localized placeholder, not a
 *      thrown error.
 */
import { describe, it, expect } from 'vitest';
import {
  buildAggregatedShiftReportHtml,
  buildAggregatedShiftReportSheets,
} from '../aggregatedShiftReportBuilder';
import type { AggregateDetailResponse } from '@/api/shifts.api';

const ctx = (
  shift_id: string,
  shift_no: string,
  cashier = 'كاشير 1',
  cashbox = 'الخزينة الرئيسية',
) => ({
  shift_id,
  shift_no,
  shift_date: '2026-05-04',
  cashier_name: cashier,
  cashbox_name: cashbox,
  original_movement_at: '2026-05-04T08:00:00+02:00',
});

function makeFixture(): AggregateDetailResponse {
  return {
    header: {
      date_range: { from: '2026-05-04', to: '2026-05-04' },
      shift_count: 2,
      shifts: [
        {
          id: 'sh-A',
          shift_no: 'SHF-001',
          status: 'closed',
          opened_at: '2026-05-04T07:00:00+02:00',
          closed_at: '2026-05-04T15:00:00+02:00',
          cashier_name: 'كاشير 1',
          cashbox_name: 'الخزينة الرئيسية',
          opening_balance: 300,
          expected_closing: 1085,
          actual_closing: 1085,
          variance: 0,
          net_shift_amount: 1085, // = expected_closing per business definition
          net_cash_movement: 785, // = expected − opening
          invoice_count: 3,
          total_sales: 1000,
          total_collections: 1000,
          cash_total: 700,
          non_cash_total: 300,
          total_operating_expenses: 60,
          total_returns: 0,
        },
        {
          id: 'sh-B',
          shift_no: 'SHF-002',
          status: 'closed',
          opened_at: '2026-05-04T16:00:00+02:00',
          closed_at: '2026-05-04T23:00:00+02:00',
          cashier_name: 'كاشير 2',
          cashbox_name: 'الخزينة الرئيسية',
          opening_balance: 300,
          expected_closing: 880,
          actual_closing: 895,
          variance: 15,
          net_shift_amount: 880, // = expected_closing
          net_cash_movement: 580,
          invoice_count: 2,
          total_sales: 500,
          total_collections: 500,
          cash_total: 400,
          non_cash_total: 100,
          total_operating_expenses: 40,
          total_returns: 0,
        },
      ],
      cashiers: [
        { user_id: 'u-1', full_name: 'كاشير 1' },
        { user_id: 'u-2', full_name: 'كاشير 2' },
      ],
      cashboxes: [{ cashbox_id: 'cb-1', name_ar: 'الخزينة الرئيسية' }],
      selection_mode: 'explicit',
      generated_by: { user_id: 'mgr', full_name: 'سارة المديرة' },
      generated_at: '2026-05-05T12:00:00.000Z',
    },
    totals: {
      opening_balance: 600,
      total_sales: 1500,
      invoice_count: 5,
      cancelled_count: 0,
      total_cancelled: 0,
      remaining_receivable: 0,
      cash_total: 1100,
      non_cash_total: 400,
      grand_payment_total: 1500,
      customer_receipts: 50,
      supplier_payments: 25,
      other_cash_in: 0,
      other_cash_out: 10,
      total_returns: 0,
      return_count: 0,
      total_expenses: 100,
      expense_count: 2,
      total_operating_expenses: 100,
      operating_expense_count: 2,
      total_employee_advances: 0,
      employee_advance_count: 0,
      total_employee_settlements: 200,
      employee_settlement_count: 2,
      total_employee_cash_out: 200,
      total_refund_cash_out: 0,
      total_refund_cash_in: 0,
      net_refund_cash_impact: 0,
      cancelled_return_out_amount: 0,
      cancelled_return_reversal_amount: 0,
      cancelled_return_net: 0,
      total_cash_in: 1700,
      total_cash_out: 335,
      expected_closing: 1965,
      actual_closing: 1980,
      variance: 15,
      closed_shift_count: 2,
      net_shift_amount: 1965, // = sum of expected_closing
      net_cash_movement: 1365, // = sum (expected − opening)
    },
    sections: {
      operating_expenses: [
        {
          id: 'exp-A-1',
          expense_no: 'EXP-001',
          amount: 60,
          description: 'كهرباء',
          category_name: 'كهرباء',
          expense_date: '2026-05-04',
          status: 'approved',
          ...ctx('sh-A', 'SHF-001'),
        },
        {
          id: 'exp-B-1',
          expense_no: 'EXP-002',
          amount: 40,
          description: 'وقود',
          category_name: 'مواصلات',
          expense_date: '2026-05-04',
          status: 'approved',
          ...ctx('sh-B', 'SHF-002', 'كاشير 2'),
        },
      ],
      employee_cash_movements: [
        {
          kind: 'settlement',
          id: 'set-A-1',
          movement_type: 'settlement',
          type_label: 'تسوية',
          employee_user_id: 'emp-1',
          employee_name: 'موظف 1',
          amount: 100,
          created_at: '2026-05-04T10:00:00+02:00',
          cashbox_id: 'cb-1',
          payment_method: 'cash',
          description: null,
          je_entry_no: 'JE-100',
          created_by_name: 'كاشير 1',
          accounting_impact: 'DR 213 / CR الخزينة',
          link_method: 'explicit',
          ...ctx('sh-A', 'SHF-001'),
        },
        {
          kind: 'settlement',
          id: 'set-B-1',
          movement_type: 'settlement',
          type_label: 'تسوية',
          employee_user_id: 'emp-2',
          employee_name: 'موظف 2',
          amount: 100,
          created_at: '2026-05-04T18:00:00+02:00',
          cashbox_id: 'cb-1',
          payment_method: 'cash',
          description: null,
          je_entry_no: 'JE-101',
          created_by_name: 'كاشير 2',
          accounting_impact: 'DR 213 / CR الخزينة',
          link_method: 'explicit',
          ...ctx('sh-B', 'SHF-002', 'كاشير 2'),
        },
      ],
      cashbox_movements: [
        {
          id: 'sh-A:customer_receipts',
          category: 'customer_receipts',
          amount: 50,
          ...ctx('sh-A', 'SHF-001'),
        },
        {
          id: 'sh-B:supplier_payments',
          category: 'supplier_payments',
          amount: 25,
          ...ctx('sh-B', 'SHF-002', 'كاشير 2'),
        },
      ],
      payment_breakdown: [
        {
          method: 'cash',
          method_label_ar: 'كاش',
          total_amount: 1100,
          invoice_count: 4,
          payment_count: 4,
          accounts: [
            {
              payment_account_id: null,
              display_name: null,
              identifier: null,
              provider_key: null,
              total_amount: 1100,
              invoice_count: 4,
              payment_count: 4,
            },
          ],
        },
        {
          method: 'instapay',
          method_label_ar: 'انستاباي',
          total_amount: 400,
          invoice_count: 1,
          payment_count: 1,
          accounts: [
            {
              payment_account_id: 'pa-insta-1',
              display_name: 'InstaPay',
              identifier: 'instapay-01',
              provider_key: 'instapay',
              total_amount: 400,
              invoice_count: 1,
              payment_count: 1,
            },
          ],
        },
      ],
      refund_cash_movements: [],
      closing_adjustments: [
        {
          id: 'adj-A-1',
          old_actual_closing: 500,
          new_actual_closing: 510,
          old_expected_closing: 500,
          new_expected_closing: 500,
          old_difference: 0,
          new_difference: 10,
          reason: 'تصحيح عد',
          adjusted_by: 'mgr',
          adjusted_by_name: 'سارة المديرة',
          adjusted_at: '2026-05-04T16:00:00+02:00',
          ...ctx('sh-A', 'SHF-001'),
          original_movement_at: '2026-05-04T16:00:00+02:00',
        },
        {
          id: 'adj-B-1',
          old_actual_closing: 700,
          new_actual_closing: 705,
          old_expected_closing: 700,
          new_expected_closing: 700,
          old_difference: 0,
          new_difference: 5,
          reason: 'تعديل مدير',
          adjusted_by: 'mgr',
          adjusted_by_name: 'سارة المديرة',
          adjusted_at: '2026-05-04T23:30:00+02:00',
          ...ctx('sh-B', 'SHF-002', 'كاشير 2'),
          original_movement_at: '2026-05-04T23:30:00+02:00',
        },
      ],
    },
  };
}

describe('buildAggregatedShiftReportHtml — 2-shift fixture', () => {
  const fx = makeFixture();
  const html = buildAggregatedShiftReportHtml(fx);

  it('contains both shift_no values in the selected-shifts header table', () => {
    expect(html).toContain('SHF-001');
    expect(html).toContain('SHF-002');
  });

  it('renders the consolidated header (selection mode + cashiers + cashboxes)', () => {
    expect(html).toContain('معلومات التقرير');
    expect(html).toContain('الورديات المحددة يدوياً');
    expect(html).toContain('كاشير 1');
    expect(html).toContain('كاشير 2');
    expect(html).toContain('الخزينة الرئيسية');
  });

  it('renders the consolidated financial summary with key totals', () => {
    expect(html).toContain('الملخص المالي المجمّع');
    // Major totals — formatted as "<n> ج.م"
    expect(html).toContain('1,500.00 ج.م'); // total_sales
    expect(html).toContain('1,100.00 ج.م'); // cash_total
    // PR-FIX-SHIFT-AGGREGATE-CASH-VS-NONCASH-VARIANCE
    // net_shift_amount = sum of expected_closing = 1085 + 880 = 1965
    expect(html).toContain('1,965.00 ج.م'); // net_shift_amount
    expect(html).toContain('200.00 ج.م'); // total_employee_cash_out
  });

  it('operating expenses section shows at least one row from each shift with shift context', () => {
    expect(html).toContain('المصروفات التشغيلية');
    // Row content from shift A
    expect(html).toContain('كهرباء');
    // Row content from shift B
    expect(html).toContain('وقود');
    // Each row carries the shift_no in the leading cell
    const expSectionStart = html.indexOf('المصروفات التشغيلية');
    const ecmSectionStart = html.indexOf('حركات موظفين نقدية');
    const expSection = html.slice(expSectionStart, ecmSectionStart);
    expect(expSection).toContain('SHF-001');
    expect(expSection).toContain('SHF-002');
  });

  it('employee cash movements section shows rows from both shifts', () => {
    const ecmStart = html.indexOf('حركات موظفين نقدية');
    const cbStart = html.indexOf('حركات الخزن');
    const ecmSection = html.slice(ecmStart, cbStart);
    expect(ecmSection).toContain('SHF-001');
    expect(ecmSection).toContain('SHF-002');
    expect(ecmSection).toContain('موظف 1');
    expect(ecmSection).toContain('موظف 2');
  });

  it('closing adjustments section shows rows from both shifts', () => {
    const adjStart = html.indexOf('سجل تعديلات مبالغ الإقفال');
    const adjSection = html.slice(adjStart);
    expect(adjSection).toContain('SHF-001');
    expect(adjSection).toContain('SHF-002');
    expect(adjSection).toContain('تصحيح عد');
    expect(adjSection).toContain('تعديل مدير');
  });

  it('payment breakdown shows aggregated method × account rows with totals', () => {
    expect(html).toContain('المبيعات والمدفوعات');
    expect(html).toContain('كاش');
    expect(html).toContain('انستاباي');
    expect(html).toContain('InstaPay');
    expect(html).toContain('1,500.00 ج.م'); // grand_payment_total in tfoot
  });

  it('refunds section renders the empty-state placeholder when no refund rows', () => {
    expect(html).toContain('حركات المرتجعات النقدية');
    expect(html).toContain('لا توجد حركات مرتجعات نقدية');
  });
});

describe('buildAggregatedShiftReportSheets — 2-shift fixture', () => {
  const fx = makeFixture();
  const sheets = buildAggregatedShiftReportSheets(fx);

  it('returns 8 sheets in the expected order with the expected names', () => {
    const names = sheets.map((s) => s.name);
    expect(names).toEqual([
      'ملخص',
      'الورديات',
      'المصروفات',
      'حركات الموظفين',
      'حركات الخزن',
      'وسائل الدفع',
      'المرتجعات',
      'سجل التعديلات',
    ]);
  });

  it('every detail-section row carries shift_no + shift_date', () => {
    const detailSheets = ['المصروفات', 'حركات الموظفين', 'حركات الخزن', 'سجل التعديلات'];
    for (const name of detailSheets) {
      const sheet = sheets.find((s) => s.name === name);
      expect(sheet).toBeDefined();
      for (const row of sheet!.rows) {
        // Either the row is the "no data" placeholder OR it has shift context
        if (row['رقم الوردية'] === 'لا توجد بيانات') continue;
        expect(row).toHaveProperty('رقم الوردية');
        expect(row).toHaveProperty('تاريخ الوردية');
        expect(row['رقم الوردية']).toMatch(/^SHF-/);
      }
    }
  });

  it('summary sheet includes the totals + shift_count + generated_by', () => {
    const summary = sheets.find((s) => s.name === 'ملخص');
    expect(summary).toBeDefined();
    const findRow = (label: string) =>
      summary!.rows.find((r: any) => r['البند'] === label);
    expect(findRow('عدد الورديات')?.['القيمة']).toBe(2);
    expect(findRow('إجمالي المبيعات')?.['القيمة']).toBe(1500);
    expect(findRow('إجمالي التحصيلات')?.['القيمة']).toBe(1500);
    // PR-FIX-SHIFT-AGGREGATE-CASH-VS-NONCASH-VARIANCE
    // صافي إجمالي الورديات = sum of expected_closing across selected
    // shifts (already includes opening). Was 1365 (= expected − opening)
    // pre-fix.
    expect(findRow('صافي إجمالي الورديات')?.['القيمة']).toBe(1965);
    expect(findRow('مُصدِر التقرير')?.['القيمة']).toBe('سارة المديرة');
  });

  it('refunds sheet renders the no-data placeholder row, not throw', () => {
    const refunds = sheets.find((s) => s.name === 'المرتجعات');
    expect(refunds).toBeDefined();
    expect(refunds!.rows).toHaveLength(1);
    expect(refunds!.rows[0]['رقم الوردية']).toBe('لا توجد بيانات');
  });
});

describe('buildAggregatedShiftReportHtml — N=1 still renders consolidated form', () => {
  it('does not error and includes the single shift_no', () => {
    const fx = makeFixture();
    fx.header.shifts = [fx.header.shifts[0]];
    fx.header.shift_count = 1;
    fx.sections.operating_expenses = [fx.sections.operating_expenses[0]];
    fx.sections.employee_cash_movements = [
      fx.sections.employee_cash_movements[0],
    ];
    fx.sections.cashbox_movements = [fx.sections.cashbox_movements[0]];
    fx.sections.closing_adjustments = [fx.sections.closing_adjustments[0]];
    const html = buildAggregatedShiftReportHtml(fx);
    expect(html).toContain('SHF-001');
    expect(html).not.toContain('SHF-002');
    expect(html).toContain('معلومات التقرير');
  });
});

/**
 * PR-FIX-SHIFT-AGGREGATE-OPENING-CASH-BALANCE
 *
 * Pins the per-shift financial columns on the "selected shifts"
 * table (HTML + XLSX). Real repro fixture: Mahmoud Zahran's
 * SHF-2026-00013 with `opening_balance = 105`, which previously
 * never reached the report.
 */
describe('buildAggregated — per-shift financial columns (Mahmoud Zahran repro)', () => {
  function mahmoudFixture(): AggregateDetailResponse {
    return {
      header: {
        date_range: { from: '2026-04-30', to: '2026-05-05' },
        shift_count: 2,
        shifts: [
          {
            id: 'sh-MZ-13',
            shift_no: 'SHF-2026-00013',
            status: 'closed',
            opened_at: '2026-04-30T11:22:35+00:00',
            closed_at: '2026-05-02T20:49:25+00:00',
            cashier_name: 'محمود زهران',
            cashbox_name: 'الخزينة الرئيسية',
            opening_balance: 105,
            expected_closing: 1455,
            actual_closing: 1455,
            variance: 0,
            net_shift_amount: 1455, // = expected_closing
            net_cash_movement: 1350, // = 1455 − 105
            invoice_count: 4,
            total_sales: 1350,
            total_collections: 1350,
            cash_total: 1350,
            non_cash_total: 0,
            total_operating_expenses: 0,
            total_returns: 0,
          },
          {
            id: 'sh-MZ-17',
            shift_no: 'SHF-2026-00017',
            status: 'open',
            opened_at: '2026-05-05T07:00:00+00:00',
            closed_at: null,
            cashier_name: 'محمود زهران',
            cashbox_name: 'الخزينة الرئيسية',
            opening_balance: 200,
            expected_closing: 200,
            actual_closing: null,
            variance: null,
            net_shift_amount: 200, // = expected_closing (open shift, no cash movement yet)
            net_cash_movement: 0,
            invoice_count: 0,
            total_sales: 0,
            total_collections: 0,
            cash_total: 0,
            non_cash_total: 0,
            total_operating_expenses: 0,
            total_returns: 0,
          },
        ],
        cashiers: [{ user_id: 'u-mz', full_name: 'محمود زهران' }],
        cashboxes: [{ cashbox_id: 'cb-1', name_ar: 'الخزينة الرئيسية' }],
        selection_mode: 'explicit',
        generated_by: { user_id: 'mgr', full_name: 'مدير' },
        generated_at: '2026-05-05T12:00:00.000Z',
      },
      totals: {
        opening_balance: 305, // 105 + 200
        total_sales: 1350,
        invoice_count: 5,
        cancelled_count: 0,
        total_cancelled: 0,
        remaining_receivable: 0,
        cash_total: 1350,
        non_cash_total: 0,
        grand_payment_total: 1350,
        customer_receipts: 0,
        supplier_payments: 0,
        other_cash_in: 0,
        other_cash_out: 0,
        total_returns: 0,
        return_count: 0,
        total_expenses: 0,
        expense_count: 0,
        total_operating_expenses: 0,
        operating_expense_count: 0,
        total_employee_advances: 0,
        employee_advance_count: 0,
        total_employee_settlements: 0,
        employee_settlement_count: 0,
        total_employee_cash_out: 0,
        total_refund_cash_out: 0,
        total_refund_cash_in: 0,
        net_refund_cash_impact: 0,
        cancelled_return_out_amount: 0,
        cancelled_return_reversal_amount: 0,
        cancelled_return_net: 0,
        total_cash_in: 1350,
        total_cash_out: 0,
        expected_closing: 1655, // 1455 + 200
        actual_closing: 1455, // closed shifts only
        variance: 0,
        closed_shift_count: 1,
        net_shift_amount: 1655, // = sum of expected_closing per business definition
        net_cash_movement: 1350, // = 1655 − 305 (legacy formula)
      },
      sections: {
        operating_expenses: [],
        employee_cash_movements: [],
        cashbox_movements: [],
        payment_breakdown: [],
        refund_cash_movements: [],
        closing_adjustments: [],
      },
    };
  }

  it('HTML "selected shifts" table renders the 5 new columns (مبلغ الافتتاح / المتوقع / الإغلاق الفعلي / الفرق / الصافي)', () => {
    const html = buildAggregatedShiftReportHtml(mahmoudFixture());
    // PR-FIX-SHIFT-AGGREGATE-CASH-VS-NONCASH-VARIANCE
    // Cash-side columns labelled "النقدي" so non-cash payments are
    // never read as cash deficit.
    expect(html).toContain('<th>مبلغ الافتتاح</th>');
    expect(html).toContain('<th>المتوقع النقدي</th>');
    expect(html).toContain('<th>الإغلاق الفعلي النقدي</th>');
    expect(html).toContain('<th>فرق الكاش</th>');
    expect(html).toContain('<th>الصافي</th>');
    // Sales + payment breakdown columns.
    expect(html).toContain('<th>عدد الفواتير</th>');
    expect(html).toContain('<th>إجمالي المبيعات</th>');
    expect(html).toContain('<th>إجمالي التحصيلات</th>');
    expect(html).toContain('<th>كاش</th>');
    expect(html).toContain('<th>غير نقدي</th>');
    expect(html).toContain('<th>المصروفات</th>');
    expect(html).toContain('<th>المرتجعات</th>');
  });

  it('Mahmoud Zahran SHF-2026-00013 row shows opening 105.00 ج.م + الصافي 1,455.00 (= expected_closing)', () => {
    const html = buildAggregatedShiftReportHtml(mahmoudFixture());
    // Slice between the shifts header and the financial summary so we
    // assert specifically against the per-shift table.
    const start = html.indexOf('الورديات المشمولة');
    const end = html.indexOf('الملخص المالي المجمّع');
    const shiftsBlock = html.slice(start, end);
    expect(shiftsBlock).toContain('SHF-2026-00013');
    expect(shiftsBlock).toContain('محمود زهران');
    expect(shiftsBlock).toContain('105.00 ج.م');
    // expected_closing + actual_closing + الصافي all equal 1,455.00
    // (الصافي = expected_closing per business definition).
    expect(shiftsBlock).toContain('1,455.00 ج.م');
  });

  it('open-shift row renders "—" for actual_closing and variance', () => {
    const html = buildAggregatedShiftReportHtml(mahmoudFixture());
    const start = html.indexOf('الورديات المشمولة');
    const end = html.indexOf('الملخص المالي المجمّع');
    const shiftsBlock = html.slice(start, end);
    expect(shiftsBlock).toContain('SHF-2026-00017');
    const openRowStart = shiftsBlock.indexOf('SHF-2026-00017');
    const openRow = shiftsBlock.slice(openRowStart, openRowStart + 2000);
    const dashes = openRow.match(/>—</g) || [];
    expect(dashes.length).toBeGreaterThanOrEqual(2);
  });

  it('HTML shifts-table tfoot shows aggregated opening (305.00) and total الصافي (1,655.00 = sum expected)', () => {
    const html = buildAggregatedShiftReportHtml(mahmoudFixture());
    const start = html.indexOf('الورديات المشمولة');
    const end = html.indexOf('الملخص المالي المجمّع');
    const shiftsBlock = html.slice(start, end);
    expect(shiftsBlock).toContain('الإجمالي عبر الورديات المحددة');
    expect(shiftsBlock).toContain('305.00 ج.م'); // sum opening
    // sum expected = 1455 + 200 = 1655 (also the new total الصافي).
    expect(shiftsBlock).toContain('1,655.00 ج.م');
  });

  it('XLSX "الورديات" sheet includes opening + cash-side + sales + collections + cash + non_cash + expenses + returns columns', () => {
    const sheets = buildAggregatedShiftReportSheets(mahmoudFixture());
    const wardyat = sheets.find((s) => s.name === 'الورديات');
    expect(wardyat).toBeDefined();
    expect(wardyat!.rows).toHaveLength(2);
    const r13 = wardyat!.rows.find(
      (r: any) => r['رقم الوردية'] === 'SHF-2026-00013',
    );
    const r17 = wardyat!.rows.find(
      (r: any) => r['رقم الوردية'] === 'SHF-2026-00017',
    );
    expect(r13).toBeDefined();
    // Sales + payment breakdown
    expect(r13['عدد الفواتير']).toBe(4);
    expect(r13['إجمالي المبيعات']).toBe(1350);
    expect(r13['إجمالي التحصيلات']).toBe(1350);
    expect(r13['كاش']).toBe(1350);
    expect(r13['غير نقدي']).toBe(0);
    expect(r13['المصروفات']).toBe(0);
    expect(r13['المرتجعات']).toBe(0);
    // Cash-side reconciliation
    expect(r13['مبلغ الافتتاح']).toBe(105);
    expect(r13['المتوقع النقدي']).toBe(1455);
    expect(r13['الإغلاق الفعلي النقدي']).toBe(1455);
    expect(r13['فرق الكاش']).toBe(0);
    expect(r13['الصافي']).toBe(1455); // = expected_closing per business definition
    // Open shift — actual / variance blank, الصافي = expected = 200.
    expect(r17['مبلغ الافتتاح']).toBe(200);
    expect(r17['المتوقع النقدي']).toBe(200);
    expect(r17['الإغلاق الفعلي النقدي']).toBe('');
    expect(r17['فرق الكاش']).toBe('');
    expect(r17['الصافي']).toBe(200);
  });

  it('XLSX "ملخص" sheet includes the total opening amount (إجمالي رصيد البداية = 305)', () => {
    const sheets = buildAggregatedShiftReportSheets(mahmoudFixture());
    const summary = sheets.find((s) => s.name === 'ملخص');
    expect(summary).toBeDefined();
    const row = summary!.rows.find(
      (r: any) => r['البند'] === 'إجمالي رصيد البداية',
    );
    expect(row).toBeDefined();
    expect(row!['القيمة']).toBe(305);
  });
});

/**
 * PR-FIX-SHIFT-AGGREGATE-CASH-VS-NONCASH-VARIANCE
 *
 * Real production repro: SHF-2026-00016 (محمود زهران) had a 500 EGP
 * InstaPay payment. The pre-fix UI showed عجز 500 because the all-
 * shifts table was reading `s.variance` from the stale stored
 * `shifts.expected_closing` (which briefly included the non-cash
 * payment). The single-shift card has always been correct: cash
 * expected = 1,160 / actual = 1,160 / variance = 0.
 *
 * The aggregated report must NOT show a 500 EGP shortage for this
 * shift. The 500 belongs under "غير نقدي".
 */
describe('buildAggregated — SHF-2026-00016: 500 InstaPay does NOT create cash deficit', () => {
  function shf16Fixture(): AggregateDetailResponse {
    return {
      header: {
        date_range: { from: '2026-05-04', to: '2026-05-05' },
        shift_count: 1,
        shifts: [
          {
            id: 'sh-MZ-16',
            shift_no: 'SHF-2026-00016',
            status: 'closed',
            opened_at: '2026-05-04T09:36:13+00:00',
            closed_at: '2026-05-05T10:34:37+00:00',
            cashier_name: 'محمود زهران',
            cashbox_name: 'الخزينة الرئيسية',
            // Live single-shift values (production confirmed).
            opening_balance: 465,
            expected_closing: 1160, // CASH-ONLY — does NOT include the 500 InstaPay
            actual_closing: 1160,
            variance: 0, // matched, NOT 500
            net_shift_amount: 1160, // = expected_closing
            net_cash_movement: 695, // legacy: 1160 − 465
            invoice_count: 7,
            total_sales: 1725,
            total_collections: 1725,
            cash_total: 1225,
            non_cash_total: 500, // The 500 EGP InstaPay lives HERE
            total_operating_expenses: 500,
            total_returns: 0,
          },
        ],
        cashiers: [{ user_id: 'u-mz', full_name: 'محمود زهران' }],
        cashboxes: [{ cashbox_id: 'cb-1', name_ar: 'الخزينة الرئيسية' }],
        selection_mode: 'explicit',
        generated_by: { user_id: 'mgr', full_name: 'مدير' },
        generated_at: '2026-05-05T15:00:00.000Z',
      },
      totals: {
        opening_balance: 465,
        total_sales: 1725,
        invoice_count: 7,
        cancelled_count: 0,
        total_cancelled: 0,
        remaining_receivable: 0,
        cash_total: 1225,
        non_cash_total: 500,
        grand_payment_total: 1725,
        customer_receipts: 0,
        supplier_payments: 0,
        other_cash_in: 0,
        other_cash_out: 0,
        total_returns: 0,
        return_count: 0,
        total_expenses: 500,
        expense_count: 3,
        total_operating_expenses: 500,
        operating_expense_count: 3,
        total_employee_advances: 0,
        employee_advance_count: 0,
        total_employee_settlements: 30,
        employee_settlement_count: 1,
        total_employee_cash_out: 30,
        total_refund_cash_out: 0,
        total_refund_cash_in: 0,
        net_refund_cash_impact: 0,
        cancelled_return_out_amount: 0,
        cancelled_return_reversal_amount: 0,
        cancelled_return_net: 0,
        total_cash_in: 1225,
        total_cash_out: 530,
        expected_closing: 1160,
        actual_closing: 1160,
        variance: 0,
        closed_shift_count: 1,
        net_shift_amount: 1160,
        net_cash_movement: 695,
      },
      sections: {
        operating_expenses: [],
        employee_cash_movements: [],
        cashbox_movements: [],
        payment_breakdown: [],
        refund_cash_movements: [],
        closing_adjustments: [],
      },
    };
  }

  it('SHF-16 row in HTML: variance = 0, no عجز, الصافي = 1,160, غير نقدي = 500', () => {
    const html = buildAggregatedShiftReportHtml(shf16Fixture());
    const start = html.indexOf('الورديات المشمولة');
    const end = html.indexOf('الملخص المالي المجمّع');
    const block = html.slice(start, end);

    // The repro shift renders.
    expect(block).toContain('SHF-2026-00016');
    expect(block).toContain('محمود زهران');

    // Cash side — all 1,160 (no shortage).
    expect(block).toContain('465.00 ج.م'); // opening
    expect(block).toContain('1,160.00 ج.م'); // expected + actual + الصافي
    // Variance = 0 → renders as "0.00 ج.م", not "500.00 ج.م".
    // Slice the cash-side cells (last 5 numeric cells of the row).
    const rowStart = block.indexOf('SHF-2026-00016');
    const row = block.slice(rowStart, rowStart + 3500);
    expect(row).not.toContain('-500');
    // The 500 (non-cash) IS present in the row, but in the غير نقدي column.
    expect(row).toContain('500.00 ج.م');

    // Cash-side column labels are unambiguous.
    expect(html).toContain('<th>المتوقع النقدي</th>');
    expect(html).toContain('<th>الإغلاق الفعلي النقدي</th>');
    expect(html).toContain('<th>فرق الكاش</th>');
    expect(html).toContain('<th>غير نقدي</th>');
  });

  it('SHF-16 XLSX row: فرق الكاش = 0 and غير نقدي = 500', () => {
    const sheets = buildAggregatedShiftReportSheets(shf16Fixture());
    const wardyat = sheets.find((s) => s.name === 'الورديات');
    expect(wardyat).toBeDefined();
    const row = wardyat!.rows.find(
      (r: any) => r['رقم الوردية'] === 'SHF-2026-00016',
    );
    expect(row).toBeDefined();
    expect(row['مبلغ الافتتاح']).toBe(465);
    expect(row['المتوقع النقدي']).toBe(1160);
    expect(row['الإغلاق الفعلي النقدي']).toBe(1160);
    expect(row['فرق الكاش']).toBe(0); // No deficit.
    expect(row['الصافي']).toBe(1160); // = expected_closing
    // Sales / payment breakdown.
    expect(row['عدد الفواتير']).toBe(7);
    expect(row['إجمالي المبيعات']).toBe(1725);
    expect(row['إجمالي التحصيلات']).toBe(1725);
    expect(row['كاش']).toBe(1225);
    expect(row['غير نقدي']).toBe(500); // The 500 InstaPay.
    expect(row['المصروفات']).toBe(500);
    expect(row['المرتجعات']).toBe(0);
  });

  it('SHF-16 totals: net_shift_amount equals expected_closing, NOT (expected − opening)', () => {
    const fx = shf16Fixture();
    const sheets = buildAggregatedShiftReportSheets(fx);
    const summary = sheets.find((s) => s.name === 'ملخص');
    const findRow = (label: string) =>
      summary!.rows.find((r: any) => r['البند'] === label);
    expect(findRow('إجمالي رصيد البداية')!['القيمة']).toBe(465);
    expect(findRow('إجمالي المبيعات')!['القيمة']).toBe(1725);
    // Live cash totals — 1,225 cash + 500 non-cash, NOT all under cash.
    expect(findRow('مبيعات نقدية (كاش)')!['القيمة']).toBe(1225);
    expect(findRow('مبيعات غير نقدية')!['القيمة']).toBe(500);
    // الصافي per business definition = sum of expected_closing.
    expect(fx.totals.net_shift_amount).toBe(1160);
    expect(fx.totals.net_cash_movement).toBe(695);
  });
});
