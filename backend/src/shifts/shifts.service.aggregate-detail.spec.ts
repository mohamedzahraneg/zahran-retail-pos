/**
 * shifts.service.aggregate-detail.spec.ts
 * PR-SHIFT-REPORTS-AGGREGATED-DETAIL-BE
 *
 * Pins the aggregator's contract:
 *   1. aggregateDetail([A]).totals == summary(A) totals (back-compat for N=1).
 *   2. aggregateDetail([A,B,C]).totals == sum(summary(A,B,C)).
 *   3. Every detail row in every section carries shift context
 *      (shift_id, shift_no, shift_date, cashier_name, cashbox_name,
 *      original_movement_at).
 *   4. filters-only request resolves shifts via the same `list()`
 *      predicate.
 *   5. When both `shift_ids` and `filters` are supplied,
 *      `shift_ids` wins.
 *   6. Empty final selection → 400.
 *   7. > 50 shifts → 422.
 *   8. Closing adjustments are aggregated and tagged with shift
 *      context.
 *   9. (Coverage of attribution semantics is delegated to
 *      `shifts.service.summary.spec.ts` — we spy on `summary()` and
 *      `listAdjustments()` so this suite exercises ONLY the
 *      reducer / selection / dedupe code paths.)
 *
 * Spy strategy: construct a real `ShiftsService` against a stub
 * `DataSource`, then `jest.spyOn` `summary` / `listAdjustments` /
 * `list` so we can return canned per-shift summaries without
 * driving the 8-query single-shift pipeline.
 */
import { BadRequestException, HttpException, HttpStatus } from '@nestjs/common';
import { ShiftsService } from './shifts.service';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function makeSvc(opts: {
  dsResults?: any[][];
  /** Optional `summary(id)` override per id. */
  summaries?: Record<string, any>;
  /** Optional `listAdjustments(id)` override per id. */
  adjustments?: Record<string, any[]>;
  /** Optional `list(...)` override (resolves filters). */
  listResult?: any[];
}) {
  const calls: QueryCall[] = [];
  let i = 0;
  const ds: any = {
    manager: {
      query: async (sql: string, params: any[] = []) => {
        calls.push({ sql, params });
        return opts.dsResults?.[i++] ?? [];
      },
    },
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return opts.dsResults?.[i++] ?? [];
    },
  };
  const svc = new ShiftsService(ds);
  if (opts.summaries) {
    jest
      .spyOn(svc, 'summary')
      .mockImplementation(async (id: string) => {
        const s = opts.summaries![id];
        if (!s) throw new Error(`no fixture summary for ${id}`);
        return s;
      });
  }
  if (opts.adjustments) {
    jest
      .spyOn(svc, 'listAdjustments')
      .mockImplementation(async (id: string) =>
        opts.adjustments![id] ?? [],
      );
  }
  if (opts.listResult) {
    jest.spyOn(svc, 'list').mockResolvedValue(opts.listResult as any);
  }
  return { svc, calls };
}

const SHIFT_A = '11111111-1111-1111-1111-111111111111';
const SHIFT_B = '22222222-2222-2222-2222-222222222222';
const SHIFT_C = '33333333-3333-3333-3333-333333333333';
const CASHBOX = '44444444-4444-4444-4444-444444444444';
const USER = '55555555-5555-5555-5555-555555555555';
const GENERATED_BY = '66666666-6666-6666-6666-666666666666';

function shiftRow(id: string, shiftNo: string, overrides: any = {}) {
  return {
    id,
    shift_no: shiftNo,
    cashbox_id: CASHBOX,
    cashbox_name: 'الخزينة الرئيسية',
    opened_by: USER,
    opened_by_name: 'كاشير 1',
    opened_at: '2026-05-04T07:00:00+02:00',
    closed_at: '2026-05-04T15:00:00+02:00',
    status: 'closed',
    opening_balance: '300',
    expected_closing: '500',
    actual_closing: '500',
    ...overrides,
  };
}

function summaryFixture(id: string, overrides: any = {}): any {
  return {
    shift_id: id,
    shift_no: 'X',
    status: 'closed',
    opening_balance: 300,
    opened_at: '2026-05-04T07:00:00+02:00',
    closed_at: '2026-05-04T15:00:00+02:00',

    total_sales: 1000,
    invoice_count: 3,
    cancelled_count: 0,
    total_cancelled: 0,
    remaining_receivable: 0,

    payment_breakdown: {
      cash: { amount: 600, count: 2 },
      card: { amount: 0, count: 0 },
      instapay: { amount: 400, count: 1 },
      bank_transfer: { amount: 0, count: 0 },
    },
    payment_breakdown_v2: [
      {
        method: 'cash',
        method_label_ar: 'كاش',
        total_amount: 600,
        invoice_count: 2,
        payment_count: 2,
        accounts: [
          {
            payment_account_id: null,
            display_name: null,
            identifier: null,
            provider_key: null,
            total_amount: 600,
            invoice_count: 2,
            payment_count: 2,
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
    cash_total: 600,
    non_cash_total: 400,
    grand_payment_total: 1000,

    customer_receipts: 50,
    supplier_payments: 25,
    other_cash_in: 0,
    other_cash_out: 10,

    total_returns: 0,
    return_count: 0,
    total_expenses: 100,
    expense_count: 2,
    expenses: [
      {
        id: `exp-${id}-1`,
        expense_no: 'EXP-001',
        amount: 60,
        description: 'كهرباء',
        category_name: 'كهرباء وماء',
        cashbox_id: CASHBOX,
        cashbox_name: 'الخزينة الرئيسية',
        created_at: '2026-05-04T08:00:00+02:00',
        shift_id: id,
        is_employee_advance: false,
      },
      {
        id: `exp-${id}-2`,
        expense_no: 'EXP-002',
        amount: 40,
        description: 'وقود',
        category_name: 'مواصلات',
        cashbox_id: CASHBOX,
        cashbox_name: 'الخزينة الرئيسية',
        created_at: '2026-05-04T09:00:00+02:00',
        shift_id: id,
        is_employee_advance: false,
      },
    ],

    total_operating_expenses: 100,
    operating_expense_count: 2,
    total_employee_advances: 0,
    employee_advance_count: 0,
    total_employee_settlements: 200,
    employee_settlement_count: 1,
    total_employee_cash_out: 200,
    employee_cash_movements: [
      {
        kind: 'settlement',
        id: `set-${id}-1`,
        movement_type: 'settlement',
        type_label: 'تسوية',
        employee_user_id: 'emp-1',
        employee_name: 'موظف 1',
        amount: 200,
        created_at: '2026-05-04T10:00:00+02:00',
        cashbox_id: CASHBOX,
        cashbox_name: 'الخزينة الرئيسية',
        payment_method: 'cash',
        link_method: 'explicit',
      },
    ],

    total_refund_cash_out: 30,
    total_refund_cash_in: 0,
    net_refund_cash_impact: 30,
    cancelled_return_out_amount: 0,
    cancelled_return_reversal_amount: 0,
    cancelled_return_net: 0,
    refund_cash_movements: [
      {
        id: `ct-${id}-r1`,
        kind: 'return',
        type_label: 'مرتجع',
        direction: 'out',
        direction_label: 'صرف',
        amount: 30,
        reference_no: 'RET-001',
        customer_name: 'عميل 1',
        cashbox_name: 'الخزينة الرئيسية',
        created_at: '2026-05-04T11:00:00+02:00',
        link_method: 'explicit',
        is_reversal: false,
        source_return_status: 'refunded',
      },
    ],

    total_cash_in: 650,
    total_cash_out: 365,
    expected_closing: 585,
    actual_closing: 500,
    variance: -85,

    ...overrides,
  };
}

function adjustmentFixture(id: string, n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `adj-${id}-${i + 1}`,
    shift_id: id,
    old_actual_closing: 500,
    new_actual_closing: 510,
    old_expected_closing: 585,
    new_expected_closing: 585,
    old_difference: -85,
    new_difference: -75,
    reason: `تصحيح عد ${i + 1}`,
    adjusted_by: USER,
    adjusted_by_name: 'كاشير 1',
    adjusted_at: '2026-05-04T16:00:00+02:00',
  }));
}

const SHIFT_CTX_KEYS = [
  'shift_id',
  'shift_no',
  'shift_date',
  'cashier_name',
  'cashbox_name',
  'original_movement_at',
] as const;

function expectShiftContext(row: any) {
  for (const k of SHIFT_CTX_KEYS) {
    expect(row).toHaveProperty(k);
  }
  expect(row.shift_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
}

describe('ShiftsService — PR-SHIFT-REPORTS-AGGREGATED-DETAIL-BE', () => {
  // ─── 1. N=1 totals equal summary(A) totals ────────────────────────
  it('aggregateDetail([A]) totals match summary(A) for every numeric field', async () => {
    const sumA = summaryFixture(SHIFT_A);
    const { svc } = makeSvc({
      // First DS call: shift lookup by ANY($1::uuid[]).
      // Second DS call: generated_by users lookup.
      dsResults: [
        [shiftRow(SHIFT_A, 'SHF-001')],
        [{ full_name: 'مدير' }],
      ],
      summaries: { [SHIFT_A]: sumA },
      adjustments: { [SHIFT_A]: [] },
    });

    const out = await svc.aggregateDetail(
      { shift_ids: [SHIFT_A] },
      { user_id: GENERATED_BY, username: 'manager' },
    );

    expect(out.header.shift_count).toBe(1);
    expect(out.totals.total_sales).toBe(sumA.total_sales);
    expect(out.totals.cash_total).toBe(sumA.cash_total);
    expect(out.totals.non_cash_total).toBe(sumA.non_cash_total);
    expect(out.totals.grand_payment_total).toBe(sumA.grand_payment_total);
    expect(out.totals.customer_receipts).toBe(sumA.customer_receipts);
    expect(out.totals.supplier_payments).toBe(sumA.supplier_payments);
    expect(out.totals.other_cash_in).toBe(sumA.other_cash_in);
    expect(out.totals.other_cash_out).toBe(sumA.other_cash_out);
    expect(out.totals.total_operating_expenses).toBe(
      sumA.total_operating_expenses,
    );
    expect(out.totals.total_employee_settlements).toBe(
      sumA.total_employee_settlements,
    );
    expect(out.totals.total_refund_cash_out).toBe(sumA.total_refund_cash_out);
    expect(out.totals.expected_closing).toBe(sumA.expected_closing);
    expect(out.totals.actual_closing).toBe(sumA.actual_closing);
    expect(out.totals.variance).toBe(sumA.variance);
    expect(out.totals.closed_shift_count).toBe(1);
    expect(out.totals.net_shift_amount).toBe(
      sumA.expected_closing - sumA.opening_balance,
    );
  });

  // ─── 2. N=3 totals equal sum across A/B/C ─────────────────────────
  it('aggregateDetail([A,B,C]) totals equal sum of summary(A/B/C)', async () => {
    const sums = {
      [SHIFT_A]: summaryFixture(SHIFT_A, {
        total_sales: 1000,
        cash_total: 600,
        non_cash_total: 400,
        grand_payment_total: 1000,
        opening_balance: 300,
        expected_closing: 585,
        actual_closing: 500,
        variance: -85,
        invoice_count: 3,
        total_employee_settlements: 200,
      }),
      [SHIFT_B]: summaryFixture(SHIFT_B, {
        total_sales: 500,
        cash_total: 500,
        non_cash_total: 0,
        grand_payment_total: 500,
        opening_balance: 200,
        expected_closing: 700,
        actual_closing: 720,
        variance: 20,
        invoice_count: 2,
        total_employee_settlements: 0,
      }),
      [SHIFT_C]: summaryFixture(SHIFT_C, {
        total_sales: 250,
        cash_total: 0,
        non_cash_total: 250,
        grand_payment_total: 250,
        opening_balance: 100,
        expected_closing: 100,
        actual_closing: null, // open shift
        variance: null,
        invoice_count: 1,
        total_employee_settlements: 50,
      }),
    };
    const { svc } = makeSvc({
      dsResults: [
        [
          shiftRow(SHIFT_A, 'SHF-001'),
          shiftRow(SHIFT_B, 'SHF-002', {
            opened_at: '2026-05-04T16:00:00+02:00',
          }),
          shiftRow(SHIFT_C, 'SHF-003', {
            opened_at: '2026-05-05T07:00:00+02:00',
            closed_at: null,
            status: 'open',
            actual_closing: null,
          }),
        ],
        [{ full_name: 'مدير' }],
      ],
      summaries: sums,
      adjustments: { [SHIFT_A]: [], [SHIFT_B]: [], [SHIFT_C]: [] },
    });

    const out = await svc.aggregateDetail(
      { shift_ids: [SHIFT_A, SHIFT_B, SHIFT_C] },
      { user_id: GENERATED_BY, username: 'manager' },
    );

    expect(out.header.shift_count).toBe(3);
    expect(out.totals.total_sales).toBe(1750); // 1000+500+250
    expect(out.totals.cash_total).toBe(1100); // 600+500+0
    expect(out.totals.non_cash_total).toBe(650); // 400+0+250
    expect(out.totals.grand_payment_total).toBe(1750);
    expect(out.totals.opening_balance).toBe(600); // 300+200+100
    expect(out.totals.expected_closing).toBe(1385); // 585+700+100
    expect(out.totals.invoice_count).toBe(6);
    expect(out.totals.total_employee_settlements).toBe(250); // 200+0+50

    // actual_closing/variance roll up over CLOSED shifts only.
    expect(out.totals.closed_shift_count).toBe(2);
    expect(out.totals.actual_closing).toBe(1220); // 500+720
    expect(out.totals.variance).toBe(-65); // -85 + 20

    // net_shift_amount = expected_closing_total − opening_balance_total
    expect(out.totals.net_shift_amount).toBe(1385 - 600);
  });

  // ─── 3. Every detail row in every section carries shift context ───
  it('every detail row in every section carries shift context', async () => {
    const sums = {
      [SHIFT_A]: summaryFixture(SHIFT_A),
      [SHIFT_B]: summaryFixture(SHIFT_B),
    };
    const { svc } = makeSvc({
      dsResults: [
        [
          shiftRow(SHIFT_A, 'SHF-001'),
          shiftRow(SHIFT_B, 'SHF-002', {
            opened_at: '2026-05-04T16:00:00+02:00',
          }),
        ],
        [{ full_name: 'مدير' }],
      ],
      summaries: sums,
      adjustments: {
        [SHIFT_A]: adjustmentFixture(SHIFT_A, 1),
        [SHIFT_B]: adjustmentFixture(SHIFT_B, 2),
      },
    });

    const out = await svc.aggregateDetail(
      { shift_ids: [SHIFT_A, SHIFT_B] },
      { user_id: GENERATED_BY, username: 'manager' },
    );

    for (const row of out.sections.operating_expenses) expectShiftContext(row);
    for (const row of out.sections.employee_cash_movements)
      expectShiftContext(row);
    for (const row of out.sections.cashbox_movements) expectShiftContext(row);
    for (const row of out.sections.refund_cash_movements)
      expectShiftContext(row);
    for (const row of out.sections.closing_adjustments)
      expectShiftContext(row);

    // Both shifts should be represented.
    const expShifts = new Set(
      out.sections.operating_expenses.map((r: any) => r.shift_id),
    );
    expect(expShifts).toEqual(new Set([SHIFT_A, SHIFT_B]));

    // Closing adjustments aggregated correctly: 1 for A + 2 for B.
    expect(out.sections.closing_adjustments).toHaveLength(3);

    // Cashbox movements: 4 categories × 2 shifts.
    expect(out.sections.cashbox_movements).toHaveLength(8);
  });

  // ─── 4. filters-only request resolves via list() ──────────────────
  it('filters-only request resolves shifts via the same list() predicate', async () => {
    const filters = { from: '2026-05-04', to: '2026-05-04', status: 'closed' };
    const listed = [
      shiftRow(SHIFT_A, 'SHF-001'),
      shiftRow(SHIFT_B, 'SHF-002', {
        opened_at: '2026-05-04T16:00:00+02:00',
      }),
    ];
    const { svc } = makeSvc({
      // Only the generated_by users lookup goes through ds.query;
      // shift resolution is mocked via list() spy below.
      dsResults: [[{ full_name: 'مدير' }]],
      summaries: {
        [SHIFT_A]: summaryFixture(SHIFT_A),
        [SHIFT_B]: summaryFixture(SHIFT_B),
      },
      adjustments: { [SHIFT_A]: [], [SHIFT_B]: [] },
      listResult: listed,
    });

    const listSpy = jest.spyOn(svc, 'list');

    const out = await svc.aggregateDetail(
      { filters },
      { user_id: GENERATED_BY, username: 'manager' },
    );

    expect(listSpy).toHaveBeenCalledWith(
      'closed',
      undefined,
      undefined,
      '2026-05-04',
      '2026-05-04',
    );
    expect(out.header.shift_count).toBe(2);
    expect(out.header.selection_mode).toBe('filters');
  });

  // ─── 5. Selection wins over filters when both are present ─────────
  it('shift_ids wins when both shift_ids and filters are provided', async () => {
    const filters = { from: '2026-05-04', to: '2026-05-04' };
    const { svc } = makeSvc({
      dsResults: [
        [shiftRow(SHIFT_A, 'SHF-001')],
        [{ full_name: 'مدير' }],
      ],
      summaries: { [SHIFT_A]: summaryFixture(SHIFT_A) },
      adjustments: { [SHIFT_A]: [] },
      listResult: [
        shiftRow(SHIFT_B, 'SHF-002'),
        shiftRow(SHIFT_C, 'SHF-003'),
      ],
    });

    const listSpy = jest.spyOn(svc, 'list');

    const out = await svc.aggregateDetail(
      { shift_ids: [SHIFT_A], filters },
      { user_id: GENERATED_BY, username: 'manager' },
    );

    // Selection won — list() must NOT be called.
    expect(listSpy).not.toHaveBeenCalled();
    expect(out.header.shift_count).toBe(1);
    expect(out.header.selection_mode).toBe('explicit');
    expect(out.header.shifts[0].id).toBe(SHIFT_A);
  });

  // ─── 6. Empty final selection → 400 ───────────────────────────────
  it('throws 400 (BadRequestException) when final selection is empty', async () => {
    const { svc } = makeSvc({
      dsResults: [[]],            // shift_ids resolved to zero rows
    });
    await expect(
      svc.aggregateDetail(
        { shift_ids: [SHIFT_A] },
        { user_id: GENERATED_BY, username: 'manager' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    // Also from filters that resolve to zero
    const { svc: svc2 } = makeSvc({ listResult: [] });
    await expect(
      svc2.aggregateDetail(
        { filters: { from: '2026-05-04' } },
        { user_id: GENERATED_BY, username: 'manager' },
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ─── 7. > 50 shifts → 422 ─────────────────────────────────────────
  it('throws 422 (UNPROCESSABLE_ENTITY) when more than 50 shifts are resolved', async () => {
    const tooMany = Array.from({ length: 51 }, (_, i) =>
      shiftRow(
        `${(i + 1).toString().padStart(8, '0')}-1111-1111-1111-111111111111`,
        `SHF-${i + 1}`,
      ),
    );
    const { svc } = makeSvc({
      dsResults: [tooMany],
    });
    let caught: unknown;
    try {
      await svc.aggregateDetail(
        { shift_ids: tooMany.map((s) => s.id) },
        { user_id: GENERATED_BY, username: 'manager' },
      );
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(HttpException);
    expect((caught as HttpException).getStatus()).toBe(
      HttpStatus.UNPROCESSABLE_ENTITY,
    );
  });

  // ─── 8. Closing adjustments aggregated and tagged ─────────────────
  it('closing adjustments are aggregated across shifts and carry shift context', async () => {
    const { svc } = makeSvc({
      dsResults: [
        [
          shiftRow(SHIFT_A, 'SHF-001'),
          shiftRow(SHIFT_B, 'SHF-002', {
            opened_at: '2026-05-04T16:00:00+02:00',
          }),
        ],
        [{ full_name: 'مدير' }],
      ],
      summaries: {
        [SHIFT_A]: summaryFixture(SHIFT_A),
        [SHIFT_B]: summaryFixture(SHIFT_B),
      },
      adjustments: {
        [SHIFT_A]: adjustmentFixture(SHIFT_A, 2),
        [SHIFT_B]: adjustmentFixture(SHIFT_B, 1),
      },
    });

    const out = await svc.aggregateDetail(
      { shift_ids: [SHIFT_A, SHIFT_B] },
      { user_id: GENERATED_BY, username: 'manager' },
    );

    expect(out.sections.closing_adjustments).toHaveLength(3);
    for (const adj of out.sections.closing_adjustments) {
      expectShiftContext(adj);
      expect(['SHF-001', 'SHF-002']).toContain(adj.shift_no);
      // original_movement_at must be the adjustment's own timestamp.
      expect(adj.original_movement_at).toBe(adj.adjusted_at);
      // Underlying audit fields preserved.
      expect(adj).toHaveProperty('reason');
      expect(adj).toHaveProperty('new_actual_closing');
    }
  });

  // ─── Additional: header carries selection_mode + generated_by ─────
  it('header carries generated_by from JWT user (not client-supplied) and generated_at from server', async () => {
    const { svc } = makeSvc({
      dsResults: [
        [shiftRow(SHIFT_A, 'SHF-001')],
        [{ full_name: 'سارة المديرة' }],
      ],
      summaries: { [SHIFT_A]: summaryFixture(SHIFT_A) },
      adjustments: { [SHIFT_A]: [] },
    });

    const before = Date.now();
    const out = await svc.aggregateDetail(
      { shift_ids: [SHIFT_A] },
      { user_id: GENERATED_BY, username: 'sara' },
    );
    const after = Date.now();

    expect(out.header.generated_by.user_id).toBe(GENERATED_BY);
    expect(out.header.generated_by.full_name).toBe('سارة المديرة');
    const ts = +new Date(out.header.generated_at);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  // ─── Additional: payment_breakdown merges by method × account ─────
  it('payment_breakdown merges by (method × payment_account_id)', async () => {
    const sumA = summaryFixture(SHIFT_A); // cash 600 + insta-1 400
    const sumB = summaryFixture(SHIFT_B, {
      payment_breakdown_v2: [
        {
          method: 'cash',
          method_label_ar: 'كاش',
          total_amount: 200,
          invoice_count: 1,
          payment_count: 1,
          accounts: [
            {
              payment_account_id: null,
              display_name: null,
              identifier: null,
              provider_key: null,
              total_amount: 200,
              invoice_count: 1,
              payment_count: 1,
            },
          ],
        },
        {
          method: 'instapay',
          method_label_ar: 'انستاباي',
          total_amount: 100,
          invoice_count: 1,
          payment_count: 1,
          accounts: [
            // SAME account as A → must merge
            {
              payment_account_id: 'pa-insta-1',
              display_name: 'InstaPay',
              identifier: 'instapay-01',
              provider_key: 'instapay',
              total_amount: 100,
              invoice_count: 1,
              payment_count: 1,
            },
          ],
        },
      ],
    });
    const { svc } = makeSvc({
      dsResults: [
        [
          shiftRow(SHIFT_A, 'SHF-001'),
          shiftRow(SHIFT_B, 'SHF-002', {
            opened_at: '2026-05-04T16:00:00+02:00',
          }),
        ],
        [{ full_name: 'مدير' }],
      ],
      summaries: { [SHIFT_A]: sumA, [SHIFT_B]: sumB },
      adjustments: { [SHIFT_A]: [], [SHIFT_B]: [] },
    });

    const out = await svc.aggregateDetail(
      { shift_ids: [SHIFT_A, SHIFT_B] },
      { user_id: GENERATED_BY, username: 'manager' },
    );

    const cash = out.sections.payment_breakdown.find(
      (m: any) => m.method === 'cash',
    );
    const insta = out.sections.payment_breakdown.find(
      (m: any) => m.method === 'instapay',
    );
    expect(cash).toBeDefined();
    expect(insta).toBeDefined();
    expect(cash!.total_amount).toBe(800); // 600 + 200
    expect(insta!.total_amount).toBe(500); // 400 + 100
    // The shared instapay account merged into one row.
    const instaAccts = insta!.accounts.filter(
      (a: any) => a.payment_account_id === 'pa-insta-1',
    );
    expect(instaAccts).toHaveLength(1);
    expect(instaAccts[0].total_amount).toBe(500);
    expect(instaAccts[0].invoice_count).toBe(2);
    expect(instaAccts[0].payment_count).toBe(2);
  });

  // ─── Additional: dedupe — same expense matched by 2 shifts ────────
  it('dedupes same source row matched by multiple selected shifts (later shift wins)', async () => {
    // Construct two summaries that contain THE SAME expense id (the
    // legacy fallback can attribute one expense to two overlapping
    // shifts on the same cashbox). Per the dedupe contract, the
    // attributed shift with the LATER opened_at wins.
    const sharedExp = {
      id: 'exp-SHARED-1',
      expense_no: 'EXP-SHARED-001',
      amount: 50,
      description: 'إيجار',
      category_name: 'إيجار',
      cashbox_id: CASHBOX,
      cashbox_name: 'الخزينة الرئيسية',
      created_at: '2026-05-04T08:30:00+02:00',
      shift_id: null, // fallback attribution
      is_employee_advance: false,
    };
    const sumA = summaryFixture(SHIFT_A, { expenses: [sharedExp] });
    const sumB = summaryFixture(SHIFT_B, {
      expenses: [sharedExp], // same id
    });
    const { svc } = makeSvc({
      dsResults: [
        [
          shiftRow(SHIFT_A, 'SHF-001', {
            opened_at: '2026-05-04T07:00:00+02:00',
          }),
          shiftRow(SHIFT_B, 'SHF-002', {
            opened_at: '2026-05-04T16:00:00+02:00', // later
          }),
        ],
        [{ full_name: 'مدير' }],
      ],
      summaries: { [SHIFT_A]: sumA, [SHIFT_B]: sumB },
      adjustments: { [SHIFT_A]: [], [SHIFT_B]: [] },
    });

    const out = await svc.aggregateDetail(
      { shift_ids: [SHIFT_A, SHIFT_B] },
      { user_id: GENERATED_BY, username: 'manager' },
    );

    const occurrences = out.sections.operating_expenses.filter(
      (e: any) => e.id === 'exp-SHARED-1',
    );
    expect(occurrences).toHaveLength(1);
    expect(occurrences[0].shift_no).toBe('SHF-002'); // later-opened wins
    // Internal helper field is stripped.
    expect(occurrences[0]).not.toHaveProperty('_attributed_shift_opened_at');
  });
});
