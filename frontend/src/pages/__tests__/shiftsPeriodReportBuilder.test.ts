import { describe, it, expect } from 'vitest';
import {
  computeAllShiftsTotals,
  buildAllShiftsReportSheets,
  buildPaymentChannelsReportSheets,
  ShiftRowWithBreakdown,
} from '../shiftsPeriodReportBuilder';

/**
 * PR-REPORTS-1 — Lock the totals math for the period reports.
 *
 *   • The all-shifts totals row must equal the column-wise sum of the
 *     individual shift rows. Anything else means the printed report
 *     and the on-screen UI disagree, which is the exact bug PR-PAY-4
 *     introduced and PR-PAY-5 had to fix.
 *
 *   • Number coercion must accept the string-encoded numerics that
 *     come back from PostgreSQL through TypeORM (s.total_sales is
 *     `string | number`). The reduce must not silently drop them.
 *
 *   • Excel sheet builders must not crash on an empty input — the
 *     Reports page calls them every render in the worst case.
 */

const baseShift = (over: Partial<ShiftRowWithBreakdown>): ShiftRowWithBreakdown =>
  ({
    id: 'sh-1',
    shift_no: 'S-1',
    cashbox_id: 'cb-1',
    warehouse_id: 'wh-1',
    opened_by: 'u-1',
    status: 'closed',
    opening_balance: 0,
    expected_closing: 0,
    actual_closing: 0,
    total_sales: 0,
    total_returns: 0,
    total_expenses: 0,
    total_cash_in: 0,
    total_cash_out: 0,
    invoice_count: 0,
    opened_at: '2026-04-27T08:00:00Z',
    closed_at: '2026-04-27T16:00:00Z',
    notes: null,
    cash_total: 0,
    non_cash_total: 0,
    grand_payment_total: 0,
    variance: 0,
    ...over,
  } as ShiftRowWithBreakdown);

describe('computeAllShiftsTotals', () => {
  it('returns zeroed totals for an empty list', () => {
    const t = computeAllShiftsTotals([]);
    expect(t).toEqual({
      cash_total: 0,
      non_cash_total: 0,
      grand_payment_total: 0,
      sales_total: 0,
      expenses_total: 0,
      invoice_count: 0,
      variance_total: 0,
    });
  });

  it('sums numeric and string columns equally (TypeORM mix)', () => {
    const t = computeAllShiftsTotals([
      baseShift({
        cash_total: 100,
        non_cash_total: 50,
        grand_payment_total: 150,
        total_sales: '150',
        total_expenses: '20',
        invoice_count: 3,
        variance: '0',
      }),
      baseShift({
        id: 'sh-2',
        shift_no: 'S-2',
        cash_total: 200,
        non_cash_total: 100,
        grand_payment_total: 300,
        total_sales: 300,
        total_expenses: 10,
        invoice_count: 5,
        variance: '-5',
      }),
    ]);
    expect(t.cash_total).toBe(300);
    expect(t.non_cash_total).toBe(150);
    expect(t.grand_payment_total).toBe(450);
    expect(t.sales_total).toBe(450);
    expect(t.expenses_total).toBe(30);
    expect(t.invoice_count).toBe(8);
    expect(t.variance_total).toBe(-5);
  });

  it('grand_payment_total equals cash_total + non_cash_total', () => {
    const rows: ShiftRowWithBreakdown[] = [
      baseShift({ cash_total: 100, non_cash_total: 50, grand_payment_total: 150 }),
      baseShift({ id: 'sh-2', cash_total: 70, non_cash_total: 30, grand_payment_total: 100 }),
    ];
    const t = computeAllShiftsTotals(rows);
    expect(t.cash_total + t.non_cash_total).toBe(t.grand_payment_total);
  });
});

describe('buildAllShiftsReportSheets', () => {
  it('produces both sheets even when the input is empty', () => {
    const sheets = buildAllShiftsReportSheets({
      rows: [],
      from: '2026-04-01',
      to: '2026-04-27',
    });
    expect(sheets.map((s) => s.name)).toEqual(['الورديات', 'الإجماليات']);
    expect(sheets[0].rows).toEqual([]);
    // Totals sheet always has the static metadata rows.
    expect(sheets[1].rows.length).toBeGreaterThan(0);
  });

  it('totals sheet matches computeAllShiftsTotals', () => {
    const rows = [
      baseShift({ cash_total: 100, non_cash_total: 50, grand_payment_total: 150, total_sales: 150 }),
    ];
    const sheets = buildAllShiftsReportSheets({
      rows,
      from: '2026-04-01',
      to: '2026-04-27',
    });
    const totalsByLabel: Record<string, any> = {};
    for (const r of sheets[1].rows) totalsByLabel[r['البند']] = r['القيمة'];
    expect(totalsByLabel['إجمالي الكاش']).toBe(100);
    expect(totalsByLabel['إجمالي التحصيلات غير النقدية']).toBe(50);
    expect(totalsByLabel['إجمالي التحصيلات']).toBe(150);
  });
});

describe('buildPaymentChannelsReportSheets', () => {
  it('emits placeholder rows on empty input rather than crashing', () => {
    const sheets = buildPaymentChannelsReportSheets({
      data: {
        range: { from: '2026-04-27', to: '2026-04-27' },
        cash_total: 0,
        non_cash_total: 0,
        grand_total: 0,
        channels: [],
      },
    });
    expect(sheets.map((s) => s.name)).toEqual(['حسب الوسيلة', 'حسب الحساب']);
    expect(sheets[0].rows.length).toBe(1);
    expect(sheets[1].rows.length).toBe(1);
  });

  it('flattens method → account rows and keeps method label on each', () => {
    const sheets = buildPaymentChannelsReportSheets({
      data: {
        range: { from: '2026-04-27', to: '2026-04-27' },
        cash_total: 100,
        non_cash_total: 200,
        grand_total: 300,
        channels: [
          {
            method: 'cash',
            method_label_ar: 'كاش',
            total_amount: 100,
            invoice_count: 5,
            payment_count: 5,
            share_pct: 33.33,
            accounts: [
              {
                payment_account_id: null,
                display_name: null,
                identifier: null,
                provider_key: null,
                total_amount: 100,
                invoice_count: 5,
                payment_count: 5,
                share_pct: 33.33,
              },
            ],
          },
          {
            method: 'instapay',
            method_label_ar: 'إنستا باي',
            total_amount: 200,
            invoice_count: 4,
            payment_count: 4,
            share_pct: 66.67,
            accounts: [
              {
                payment_account_id: 'pa-1',
                display_name: 'InstaPay تجريبي',
                identifier: '01000000000',
                provider_key: 'instapay',
                total_amount: 200,
                invoice_count: 4,
                payment_count: 4,
                share_pct: 66.67,
              },
            ],
          },
        ],
      },
    });
    const accountSheet = sheets[1].rows;
    expect(accountSheet).toHaveLength(2);
    expect(accountSheet[1]['الوسيلة']).toBe('إنستا باي');
    expect(accountSheet[1]['اسم الحساب']).toBe('InstaPay تجريبي');
    // Sum of account amounts equals grand total.
    const sum = accountSheet.reduce(
      (s: number, r: any) => s + Number(r['المبلغ']),
      0,
    );
    expect(sum).toBe(300);
  });
});
