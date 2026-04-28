/**
 * accounting.service.disbursement-linkage.spec.ts — PR-ESS-2B
 * ────────────────────────────────────────────────────────────────────
 *
 * Pins the disbursement-linkage contract for
 * `accountingService.createExpense` when the caller passes
 * `source_employee_request_id`:
 *
 *   1. Every pre-condition is checked BEFORE any expense INSERT —
 *      kind, status, amount, user, and absence of an existing link.
 *      Any mismatch throws BadRequestException and no expense row
 *      is written.
 *   2. The successful path INSERTs the expense with the linkage
 *      column populated, calls FinancialEngine.recordExpense, and
 *      then UPDATEs the request to status='disbursed' inside the
 *      same transaction.
 *   3. If the engine throws (e.g. unmapped category), the wrapping
 *      transaction rolls back: no expense, no status flip.
 *   4. Duplicate disbursement attempts for the same request are
 *      blocked.
 *
 * The tests stub the DataSource so we can assert the SQL strings the
 * service emits without touching a real Postgres. The trigger /
 * constraint behavior of the DB layer is covered by migration 117's
 * own self-validation block.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { AccountingService } from './accounting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

const ADMIN = '00000000-0000-0000-0000-00000000ad00';
const EMP = '11111111-1111-1111-1111-111111111111';
const OTHER_EMP = '22222222-2222-2222-2222-222222222222';
const CASHBOX = '33333333-3333-3333-3333-333333333333';
const SHIFT = '44444444-4444-4444-4444-444444444444';
const CATEGORY = '55555555-5555-5555-5555-555555555555';
const WAREHOUSE = '66666666-6666-6666-6666-666666666666';

function makeDto(overrides: Record<string, any> = {}) {
  return {
    warehouse_id: WAREHOUSE,
    cashbox_id: CASHBOX,
    category_id: CATEGORY,
    amount: 250,
    payment_method: 'cash',
    employee_user_id: EMP,
    is_advance: true,
    shift_id: SHIFT,
    source_employee_request_id: 7,
    ...overrides,
  };
}

describe('AccountingService.createExpense — PR-ESS-2B disbursement linkage', () => {
  let service: AccountingService;
  let ds: { query: jest.Mock; transaction: jest.Mock };
  let em: { query: jest.Mock };
  let engine: { recordExpense: jest.Mock; recordTransaction: jest.Mock };

  beforeEach(async () => {
    em = { query: jest.fn() };
    ds = {
      query: jest.fn(),
      transaction: jest.fn(async (cb: any) => cb(em)),
    };
    engine = {
      recordExpense: jest.fn(),
      recordTransaction: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AccountingService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    service = moduleRef.get(AccountingService);
  });

  // Helper: stub the shift-resolution query that fires BEFORE the
  // request validation. The employee-link query (auto-match by
  // category code ↔ employee_no) is SKIPPED when the DTO already
  // carries `employee_user_id`, so we only stub the shift validation.
  function stubShiftResolution() {
    em.query
      // SELECT shifts WHERE id = $1 (validate explicit shift)
      .mockResolvedValueOnce([
        { id: SHIFT, status: 'open', cashbox_id: CASHBOX },
      ]);
  }

  it('rejects when source_employee_request_id is set but is_advance is not true', async () => {
    // Shift validation runs BEFORE the linkage pre-check; stub it
    // so the service reaches the is_advance guard.
    stubShiftResolution();

    await expect(
      service.createExpense(
        makeDto({ is_advance: false }) as any,
        ADMIN,
      ),
    ).rejects.toThrow(/is_advance=true مطلوب/);

    // Validation must abort BEFORE any expense INSERT.
    const insertCalls = em.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('rejects when the request id does not exist', async () => {
    stubShiftResolution();
    // Then the SELECT FOR UPDATE on employee_requests returns []
    em.query.mockResolvedValueOnce([]);

    await expect(
      service.createExpense(makeDto() as any, ADMIN),
    ).rejects.toThrow(/طلب السلفة \(id=7\) غير موجود/);

    // No INSERT.
    const insertCalls = em.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('rejects when the request kind is not advance_request', async () => {
    stubShiftResolution();
    em.query.mockResolvedValueOnce([
      {
        id: 7,
        user_id: EMP,
        kind: 'leave',
        status: 'approved',
        amount: '250',
      },
    ]);

    await expect(
      service.createExpense(makeDto() as any, ADMIN),
    ).rejects.toThrow(/من نوع غير مدعوم/);
  });

  it('rejects when the request status is not approved', async () => {
    stubShiftResolution();
    em.query.mockResolvedValueOnce([
      {
        id: 7,
        user_id: EMP,
        kind: 'advance_request',
        status: 'pending',
        amount: '250',
      },
    ]);

    await expect(
      service.createExpense(makeDto() as any, ADMIN),
    ).rejects.toThrow(/يجب أن يكون "approved" قبل الصرف/);
  });

  it("rejects when the request belongs to a different employee", async () => {
    stubShiftResolution();
    em.query.mockResolvedValueOnce([
      {
        id: 7,
        user_id: OTHER_EMP,
        kind: 'advance_request',
        status: 'approved',
        amount: '250',
      },
    ]);

    await expect(
      service.createExpense(makeDto() as any, ADMIN),
    ).rejects.toThrow(/لا يطابق صاحب طلب السلفة/);
  });

  it('rejects when the amount does not match exactly (no partial disbursement)', async () => {
    stubShiftResolution();
    em.query.mockResolvedValueOnce([
      {
        id: 7,
        user_id: EMP,
        kind: 'advance_request',
        status: 'approved',
        amount: '500', // request asks 500
      },
    ]);

    await expect(
      service.createExpense(makeDto({ amount: 250 }) as any, ADMIN),
    ).rejects.toThrow(/لا تطابق قيمة طلب السلفة/);
  });

  it('rejects when another expense already links to this request (duplicate disbursement)', async () => {
    stubShiftResolution();
    em.query.mockResolvedValueOnce([
      {
        id: 7,
        user_id: EMP,
        kind: 'advance_request',
        status: 'approved',
        amount: '250',
      },
    ]);
    // Then the duplicate-link check finds an existing expense.
    em.query.mockResolvedValueOnce([
      { id: 'existing-expense-uuid' },
    ]);

    await expect(
      service.createExpense(makeDto() as any, ADMIN),
    ).rejects.toThrow(/مرتبط بالفعل بمصروف آخر/);

    const insertCalls = em.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    expect(insertCalls).toHaveLength(0);
  });

  // Helper: stub the full happy-path em.query sequence (FOR UPDATE
  // → existing-link check → INSERT → UPDATE is_approved → SELECT
  // category account_id → status flip). The category-account stub
  // is the legacy fallback path inside postViaEngine when no
  // CostAccountResolver is wired (the tests don't provide one).
  function stubHappyPathDownstream(opts: {
    requestRow?: any;
    statusFlipReturns?: any[];
  } = {}) {
    em.query.mockResolvedValueOnce([
      opts.requestRow ?? {
        id: 7,
        user_id: EMP,
        kind: 'advance_request',
        status: 'approved',
        amount: '250',
      },
    ]);
    em.query.mockResolvedValueOnce([]); // no existing link
    em.query.mockResolvedValueOnce([
      {
        id: 'new-expense-uuid',
        expense_no: 'EXP-2026-0042',
        amount: 250,
        source_employee_request_id: 7,
        is_advance: true,
        cashbox_id: CASHBOX,
        category_id: CATEGORY,
      },
    ]); // INSERT INTO expenses RETURNING *
    em.query.mockResolvedValueOnce([]); // UPDATE expenses SET is_approved
    em.query.mockResolvedValueOnce([
      { account_id: '99999999-9999-9999-9999-999999999999' },
    ]); // SELECT account_id FROM expense_categories (legacy resolver fallback)
    // engine.recordExpense is stubbed by the caller per scenario.
    em.query.mockResolvedValueOnce(opts.statusFlipReturns ?? [{ id: 7 }]); // UPDATE employee_requests
  }

  it('locks the request row with SELECT … FOR UPDATE during validation', async () => {
    stubShiftResolution();
    stubHappyPathDownstream();
    engine.recordExpense.mockResolvedValueOnce({ ok: true, entry_id: 'je' });

    await service.createExpense(makeDto() as any, ADMIN);

    const lockCall = em.query.mock.calls.find((c) =>
      /employee_requests[\s\S]*FOR UPDATE/.test(String(c[0])),
    );
    expect(lockCall).toBeTruthy();
  });

  it('happy path: INSERTs expense with linkage column AND flips request to disbursed AFTER engine success', async () => {
    stubShiftResolution();
    stubHappyPathDownstream();
    engine.recordExpense.mockResolvedValueOnce({
      ok: true,
      entry_id: 'je-uuid',
    });

    const result = await service.createExpense(makeDto() as any, ADMIN);

    // Expense INSERT included the linkage column.
    const insertCall = em.query.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    expect(insertCall).toBeTruthy();
    expect(String(insertCall![0])).toContain('source_employee_request_id');
    // Last positional arg of the INSERT params is the linkage id.
    const insertParams = insertCall![1] as any[];
    expect(insertParams[insertParams.length - 1]).toBe(7);

    // Status flip ran AFTER engine.recordExpense.
    const flipCall = em.query.mock.calls.find((c) =>
      /UPDATE employee_requests[\s\S]*'disbursed'/.test(String(c[0])),
    );
    expect(flipCall).toBeTruthy();
    // The flip must require status='approved' to be safe under
    // concurrent disbursements.
    expect(String(flipCall![0])).toContain("status = 'approved'");

    expect(engine.recordExpense).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ source_employee_request_id: 7 });
  });

  it('rolls back via thrown exception when engine returns ok=false (request stays approved)', async () => {
    stubShiftResolution();
    // Pre-validation passes; INSERT happens; auto-approve flag set;
    // category account looked up; engine called; engine FAILS; the
    // service throws and the wrapping transaction rolls back. The
    // status-flip UPDATE must never run.
    em.query.mockResolvedValueOnce([
      {
        id: 7,
        user_id: EMP,
        kind: 'advance_request',
        status: 'approved',
        amount: '250',
      },
    ]);
    em.query.mockResolvedValueOnce([]); // no existing link
    em.query.mockResolvedValueOnce([
      {
        id: 'new-expense-uuid',
        expense_no: 'EXP-2026-0099',
        amount: 250,
        source_employee_request_id: 7,
        is_advance: true,
        cashbox_id: CASHBOX,
        category_id: CATEGORY,
      },
    ]); // INSERT
    em.query.mockResolvedValueOnce([]); // auto-approve UPDATE
    em.query.mockResolvedValueOnce([
      { account_id: '99999999-9999-9999-9999-999999999999' },
    ]); // SELECT account_id (legacy fallback)
    engine.recordExpense.mockResolvedValueOnce({
      ok: false,
      error: 'unmapped category',
    });

    await expect(
      service.createExpense(makeDto() as any, ADMIN),
    ).rejects.toThrow(/فشل ترحيل المصروف/);

    const flipCall = em.query.mock.calls.find((c) =>
      /UPDATE employee_requests[\s\S]*'disbursed'/.test(String(c[0])),
    );
    expect(flipCall).toBeUndefined();
  });

  it('throws if status flip UPDATE returns 0 rows (defensive — should never happen given the FOR UPDATE lock)', async () => {
    stubShiftResolution();
    // Use the helper but override the status-flip return value so it
    // emits zero rows (simulates a concurrent flipper that already
    // moved the request out of 'approved').
    stubHappyPathDownstream({ statusFlipReturns: [] });
    engine.recordExpense.mockResolvedValueOnce({
      ok: true,
      entry_id: 'je-uuid',
    });

    await expect(
      service.createExpense(makeDto() as any, ADMIN),
    ).rejects.toThrow(/لم يتم تحديث حالة طلب السلفة/);
  });

  // ─────────────────────────────────────────────────────────────────
  // PR-EMP-ADVANCE-PAY-1 — `source_type` contract
  //
  // Pins the four explicit-source rules + a legacy backward-compat
  // assertion so the audit trail of EXP-2026-000031 (which silently
  // got `shift_id = SHF-2026-00008` despite the operator picking
  // "صرف من الخزنة") is no longer reproducible.
  // ─────────────────────────────────────────────────────────────────

  it('PR-EMP-ADVANCE-PAY-1: source_type=direct_cashbox + cashbox_id INSERTs expense with shift_id=NULL (no auto-resolve)', async () => {
    // No shift validation runs because shift_id is absent. The
    // legacy auto-resolve blocks (lines 167–190) MUST be skipped, so
    // we never see the `WHERE opened_by` lookup in the captured
    // queries. The INSERT then carries shift_id=null.
    stubHappyPathDownstream();
    engine.recordExpense.mockResolvedValueOnce({
      ok: true,
      entry_id: 'je-uuid',
    });

    await service.createExpense(
      makeDto({
        source_type: 'direct_cashbox',
        cashbox_id: CASHBOX,
        shift_id: undefined,
      }) as any,
      ADMIN,
    );

    // No auto-resolve query against `shifts WHERE opened_by` was
    // issued — the operator's explicit choice is honoured.
    const autoResolveByUser = em.query.mock.calls.find((c) =>
      /shifts[\s\S]*WHERE opened_by/.test(String(c[0])),
    );
    expect(autoResolveByUser).toBeUndefined();

    // No fallback "shift on this cashbox" lookup either.
    const autoResolveByCashbox = em.query.mock.calls.find((c) =>
      /shifts[\s\S]*WHERE cashbox_id = \$1[\s\S]*status = 'open'/.test(
        String(c[0]),
      ),
    );
    expect(autoResolveByCashbox).toBeUndefined();

    // The INSERT into expenses received shift_id=null. The INSERT
    // statement sends shift_id as one of the param positions; the
    // assertion below confirms the captured params include `null`
    // alongside the cashbox uuid.
    const insertCall = em.query.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    expect(insertCall).toBeTruthy();
    const insertParams = insertCall![1] as any[];
    expect(insertParams).toContain(CASHBOX);
    expect(insertParams).toContain(null); // shift_id position
  });

  it('PR-EMP-ADVANCE-PAY-1: source_type=direct_cashbox WITH shift_id is rejected (conflict)', async () => {
    await expect(
      service.createExpense(
        makeDto({
          source_type: 'direct_cashbox',
          cashbox_id: CASHBOX,
          shift_id: SHIFT, // contradictory
        }) as any,
        ADMIN,
      ),
    ).rejects.toThrow(/تعارض في مصدر الصرف/);

    // No INSERT happened.
    const insertCalls = em.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('PR-EMP-ADVANCE-PAY-1: source_type=direct_cashbox WITHOUT cashbox_id is rejected (missing-cashbox)', async () => {
    await expect(
      service.createExpense(
        makeDto({
          source_type: 'direct_cashbox',
          cashbox_id: undefined,
          shift_id: undefined,
        }) as any,
        ADMIN,
      ),
    ).rejects.toThrow(/يجب اختيار الخزنة عند الصرف من خزنة مباشرة/);

    const insertCalls = em.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('PR-EMP-ADVANCE-PAY-1: source_type=open_shift WITHOUT shift_id is rejected (missing-shift)', async () => {
    await expect(
      service.createExpense(
        makeDto({
          source_type: 'open_shift',
          cashbox_id: CASHBOX,
          shift_id: undefined,
        }) as any,
        ADMIN,
      ),
    ).rejects.toThrow(/يجب اختيار الوردية عند الصرف من وردية مفتوحة/);

    const insertCalls = em.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    expect(insertCalls).toHaveLength(0);
  });

  it('PR-EMP-ADVANCE-PAY-1: source_type=open_shift creates expense linked to the shift (regression — existing PR-15 contract)', async () => {
    stubShiftResolution();
    stubHappyPathDownstream();
    engine.recordExpense.mockResolvedValueOnce({
      ok: true,
      entry_id: 'je-uuid',
    });

    await service.createExpense(
      makeDto({
        source_type: 'open_shift',
        cashbox_id: CASHBOX,
        shift_id: SHIFT,
      }) as any,
      ADMIN,
    );

    // Shift validation query DID run (the existing PR-15 path).
    const shiftValidate = em.query.mock.calls.find((c) =>
      /SELECT id, status, cashbox_id FROM shifts WHERE id = \$1/.test(
        String(c[0]),
      ),
    );
    expect(shiftValidate).toBeTruthy();

    // INSERT carries the shift_id.
    const insertCall = em.query.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    const insertParams = insertCall![1] as any[];
    expect(insertParams).toContain(SHIFT);
  });

  it('PR-EMP-ADVANCE-PAY-1: legacy payload (no source_type) preserves the old auto-resolve behaviour', async () => {
    // No source_type → backend falls back to the pre-PR auto-resolve
    // path. This is exactly the codepath that fired for
    // EXP-2026-000031, kept intact here for any pre-PR caller that
    // hasn't been updated yet (e.g. older mobile builds).
    stubShiftResolution();
    stubHappyPathDownstream();
    engine.recordExpense.mockResolvedValueOnce({
      ok: true,
      entry_id: 'je-uuid',
    });

    await service.createExpense(
      makeDto({
        // No source_type field at all.
        cashbox_id: CASHBOX,
        shift_id: SHIFT,
      }) as any,
      ADMIN,
    );

    // Existing legacy validate-shift query still ran.
    const shiftValidate = em.query.mock.calls.find((c) =>
      /SELECT id, status, cashbox_id FROM shifts WHERE id = \$1/.test(
        String(c[0]),
      ),
    );
    expect(shiftValidate).toBeTruthy();

    // INSERT happens (no rejection).
    const insertCall = em.query.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    expect(insertCall).toBeTruthy();
  });
});
