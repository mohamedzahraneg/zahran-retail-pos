/**
 * shifts.service.summary.spec.ts — PR-EMP-ADVANCE-PAY-2
 *
 * Pins the close-out attribution rules that the previous PR
 * (PR-EMP-ADVANCE-PAY-1) made `expenses.shift_id` honest about, but
 * which `shifts.service::summary` was still ignoring:
 *
 *   (a) An expense explicitly attributed to this shift
 *       (`e.shift_id = shift.id`) is always included.
 *
 *   (b) Legacy generous match (cashbox / warehouse / created_by)
 *       still applies for OPERATING expenses with `e.shift_id IS NULL`
 *       — preserves the historical "cashier left cashbox blank"
 *       behaviour for non-advance rows.
 *
 *   (c) Direct-cashbox ADVANCES (`is_advance=TRUE` AND
 *       `shift_id IS NULL`) are EXCLUDED from every shift's summary
 *       — even when the cashbox matches the shift's drawer (the
 *       only-cashbox-in-the-system case that produced EXP-2026-000034
 *       and EXP-2026-000031). The metadata `shift_id IS NULL` set by
 *       PR-EMP-ADVANCE-PAY-1 is now the authoritative "do not
 *       attribute to any shift" marker.
 *
 * The test mocks just enough of `DataSource.query(...)` to drive the
 * sequential queries `computeSummary` issues. We don't simulate
 * Postgres's WHERE filter — instead we (1) inspect the captured SQL
 * to assert the new clauses are emitted, and (2) feed pre-filtered
 * fixture rows that match what Postgres WOULD return, then assert
 * the resulting totals.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { ShiftsService } from './shifts.service';

interface QueryCall {
  sql: string;
  params: unknown[];
}

type FixtureExpense = {
  id: string;
  expense_no: string;
  amount: number;
  description: string | null;
  category_name: string | null;
  expense_date: string;
  is_advance: boolean;
  employee_user_id: string | null;
  employee_name: string | null;
  cashbox_id: string | null;
  cashbox_name: string | null;
  payment_method: 'cash' | 'card' | 'transfer' | 'wallet' | 'mixed';
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
  shift_id: string | null;
  account_code: string | null;
  is_employee_advance: boolean;
  je_entry_no: string | null;
  status: 'approved' | 'pending';
  warehouse_id: string;
};

const SHIFT_ID = '11111111-1111-1111-1111-111111111111';
const OTHER_SHIFT_ID = '99999999-9999-9999-9999-999999999999';
const CASHBOX_ID = '22222222-2222-2222-2222-222222222222';
const WAREHOUSE_ID = '33333333-3333-3333-3333-333333333333';
const OPENER = '44444444-4444-4444-4444-444444444444';
const OTHER_USER = '55555555-5555-5555-5555-555555555555';
const EMPLOYEE = '66666666-6666-6666-6666-666666666666';

function shiftRow(overrides: Record<string, unknown> = {}) {
  return {
    id: SHIFT_ID,
    shift_no: 'SHF-T-00001',
    cashbox_id: CASHBOX_ID,
    warehouse_id: WAREHOUSE_ID,
    opened_by: OPENER,
    opening_balance: '300.00',
    expected_closing: '300.00',
    actual_closing: null,
    status: 'open',
    opened_at: '2026-04-28 07:00:00+00',
    closed_at: null,
    notes: null,
    ...overrides,
  };
}

/**
 * Apply the SAME WHERE filter the production SQL uses, against a
 * fixture array. This lets the test verify behavioural expectations
 * without spinning up Postgres. Mirrors the actual query at
 * `shifts.service.ts:340–384` (PR-EMP-ADVANCE-PAY-2 form).
 */
function emulateExpenseFilter(
  rows: FixtureExpense[],
  shift: ReturnType<typeof shiftRow>,
  upperBound: string,
): FixtureExpense[] {
  return rows.filter((e) => {
    if (e.created_at < shift.opened_at) return false;
    if (e.created_at > upperBound) return false;
    // (a) explicit shift attribution
    if (e.shift_id === shift.id) return true;
    // (b) legacy generous match for operating expenses
    if (
      e.shift_id === null &&
      e.is_advance === false &&
      (e.cashbox_id === shift.cashbox_id ||
        e.cashbox_id === null ||
        e.warehouse_id === shift.warehouse_id ||
        e.created_by === shift.opened_by)
    ) {
      return true;
    }
    return false;
  });
}

/**
 * Stateful query stub. Inspects the SQL of each call to figure out
 * which query is being issued and returns the right shape.
 *
 * Nothing fancy — just pattern-matches a few unique SQL fragments.
 */
function buildQueryStub(opts: {
  shift: ReturnType<typeof shiftRow>;
  expenseFixture: FixtureExpense[];
}): { calls: QueryCall[]; query: jest.Mock } {
  const calls: QueryCall[] = [];
  const upperBound = opts.shift.closed_at || new Date().toISOString();

  const query = jest.fn(async (sql: string, params: unknown[]) => {
    calls.push({ sql, params });

    if (/SELECT \* FROM shifts WHERE id/i.test(sql)) {
      return [opts.shift];
    }
    if (/SUM\(CASE WHEN i\.status IN/i.test(sql)) {
      // invoice totals
      return [
        {
          total_sales: 0,
          total_cancelled: 0,
          invoice_count: 0,
          cancelled_count: 0,
          remaining_receivable: 0,
        },
      ];
    }
    if (/FROM invoice_payments ip/i.test(sql)) {
      return []; // payment breakdown
    }
    if (/FROM cashbox_transactions/i.test(sql)) {
      // every cashbox-driven query — return zero buckets
      return [];
    }
    if (
      /FROM expenses e/i.test(sql) &&
      /LEFT JOIN expense_categories/i.test(sql)
    ) {
      // The expenseRows query — emulate the filter against the fixture.
      return emulateExpenseFilter(
        opts.expenseFixture,
        opts.shift,
        upperBound,
      );
    }
    if (/FROM returns r/i.test(sql)) {
      return [{ total_returns: 0, return_count: 0 }];
    }
    if (/customer_payments/i.test(sql)) {
      return [{ total_customer_payments: 0, payment_count: 0 }];
    }
    if (/supplier_payments/i.test(sql)) {
      return [{ total_supplier_payments: 0, payment_count: 0 }];
    }
    if (/employee_settlements|FROM settlements/i.test(sql)) {
      return [];
    }
    // catch-all — return empty rows for anything else.
    return [];
  });

  return { calls, query };
}

describe('ShiftsService.summary — PR-EMP-ADVANCE-PAY-2 attribution rules', () => {
  let service: ShiftsService;
  let queryStub: { calls: QueryCall[]; query: jest.Mock };
  let shift: ReturnType<typeof shiftRow>;

  /**
   * Helper: build the service + datasource with a fresh fixture per
   * test, so every test owns its row set without ordering coupling.
   */
  async function setup(expenseFixture: FixtureExpense[]) {
    shift = shiftRow();
    queryStub = buildQueryStub({ shift, expenseFixture });
    const ds = { query: queryStub.query, transaction: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ShiftsService,
        { provide: DataSource, useValue: ds },
      ],
    }).compile();
    service = moduleRef.get(ShiftsService);
  }

  function makeExpense(over: Partial<FixtureExpense> = {}): FixtureExpense {
    return {
      id: 'e-' + Math.random().toString(36).slice(2, 8),
      expense_no: 'EXP-T',
      amount: 5,
      description: 'test',
      category_name: 'سلف',
      expense_date: '2026-04-28',
      is_advance: true,
      employee_user_id: EMPLOYEE,
      employee_name: 'موظف اختبار',
      cashbox_id: CASHBOX_ID,
      cashbox_name: 'الخزينة',
      payment_method: 'cash',
      created_by: OTHER_USER,
      created_by_name: 'admin',
      created_at: '2026-04-28 12:00:00+00',
      shift_id: null,
      account_code: '529',
      is_employee_advance: true,
      je_entry_no: 'JE-T',
      status: 'approved',
      warehouse_id: WAREHOUSE_ID,
      ...over,
    };
  }

  it('emits the new WHERE clause and passes shift.id as $6', async () => {
    await setup([]);
    await service.summary(SHIFT_ID);
    const expenseQuery = queryStub.calls.find(
      (c) => /FROM expenses e/i.test(c.sql) && /LEFT JOIN expense_categories/i.test(c.sql),
    );
    expect(expenseQuery).toBeTruthy();

    // (a) explicit shift attribution clause
    expect(expenseQuery!.sql).toMatch(/e\.shift_id = \$6/);

    // (b) legacy fallback gated on operating expenses only
    expect(expenseQuery!.sql).toMatch(/e\.shift_id IS NULL/);
    expect(expenseQuery!.sql).toMatch(
      /COALESCE\(e\.is_advance, FALSE\)\s*=\s*FALSE/,
    );

    // (c) shift.id is the 6th positional param
    expect(expenseQuery!.params[5]).toBe(SHIFT_ID);
    // Sanity on the legacy params being preserved.
    expect(expenseQuery!.params[2]).toBe(CASHBOX_ID);
    expect(expenseQuery!.params[3]).toBe(WAREHOUSE_ID);
    expect(expenseQuery!.params[4]).toBe(OPENER);
  });

  it('(a) explicit shift_id match: includes the advance in totals even if cashbox differs', async () => {
    const fixture = [
      makeExpense({
        is_advance: true,
        shift_id: SHIFT_ID,                 // explicit
        cashbox_id: 'some-other-cashbox',   // would NOT match by cashbox
        amount: 12,
      }),
    ];
    await setup(fixture);
    const result = (await service.summary(SHIFT_ID)) as any;
    expect(Number(result.total_employee_advances)).toBe(12);
    expect(result.employee_advance_count).toBe(1);
  });

  it('(b) legacy operating expense with shift_id NULL + matching cashbox: still INCLUDED', async () => {
    const fixture = [
      makeExpense({
        is_advance: false,
        is_employee_advance: false,         // operating, not an advance
        account_code: '521',
        shift_id: null,
        cashbox_id: CASHBOX_ID,             // legacy match by cashbox
        amount: 30,
      }),
    ];
    await setup(fixture);
    const result = (await service.summary(SHIFT_ID)) as any;
    expect(Number(result.total_operating_expenses)).toBe(30);
    expect(Number(result.total_employee_advances)).toBe(0);
  });

  it('(c) DIRECT-CASHBOX ADVANCE (is_advance=true + shift_id NULL + matching cashbox) is EXCLUDED — the headline fix', async () => {
    // Mirrors the real EXP-2026-000034 / EXP-2026-000031 case.
    const fixture = [
      makeExpense({
        is_advance: true,
        shift_id: null,                     // direct-cashbox marker
        cashbox_id: CASHBOX_ID,             // SAME drawer the shift uses
        amount: 5,
      }),
    ];
    await setup(fixture);
    const result = (await service.summary(SHIFT_ID)) as any;
    expect(Number(result.total_employee_advances)).toBe(0);
    expect(result.employee_advance_count).toBe(0);
    // expected_closing must NOT subtract this 5 EGP — without any
    // other cash flows, expected_closing = opening_balance = 300.
    expect(Number(result.expected_closing)).toBe(300);
  });

  it('mixed fixture: explicit-shift advance + direct-cashbox advance + legacy operating: only (a) and (b) are counted', async () => {
    const fixture = [
      makeExpense({
        is_advance: true,
        shift_id: SHIFT_ID,
        cashbox_id: CASHBOX_ID,
        amount: 25,
        expense_no: 'EXP-A',
      }),
      makeExpense({
        is_advance: true,
        shift_id: null,
        cashbox_id: CASHBOX_ID,
        amount: 5,                          // headline-fix excluded
        expense_no: 'EXP-B',
      }),
      makeExpense({
        is_advance: false,
        is_employee_advance: false,
        shift_id: null,
        cashbox_id: CASHBOX_ID,
        amount: 40,                         // operating, included
        expense_no: 'EXP-C',
      }),
    ];
    await setup(fixture);
    const result = (await service.summary(SHIFT_ID)) as any;
    expect(Number(result.total_employee_advances)).toBe(25);
    expect(Number(result.total_operating_expenses)).toBe(40);
    // expected_closing reduces by 25 (advance) + 40 (operating) = 65,
    // leaving 300 − 65 = 235.
    expect(Number(result.expected_closing)).toBe(235);
  });

  it('expense linked to a DIFFERENT shift (e.g. EXP-2026-000031 → SHF-2026-00008) is NOT included in this shift', async () => {
    const fixture = [
      makeExpense({
        is_advance: true,
        shift_id: OTHER_SHIFT_ID,           // pre-existing legacy mis-attribution
        cashbox_id: CASHBOX_ID,
        amount: 6,
      }),
    ];
    await setup(fixture);
    const result = (await service.summary(SHIFT_ID)) as any;
    expect(Number(result.total_employee_advances)).toBe(0);
  });
});
