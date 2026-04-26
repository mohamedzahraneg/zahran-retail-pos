import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AccountingService } from './accounting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

/**
 * Migration 113 — disbursement of an approved advance_request.
 *
 * When HR posts an expense with is_advance=true +
 * source_employee_request_id=N, the service MUST validate that:
 *
 *   · the referenced request exists
 *   · its kind is 'advance_request' (not legacy 'advance')
 *   · its status is 'approved'
 *   · its user_id matches the disbursing employee_user_id
 *   · no live (non-voided) disbursement already exists for it
 *
 * These tests pin every rejection path. The happy-path posting via
 * FinancialEngineService is exercised by the existing integration
 * coverage in posting.service.spec.ts; here we only assert that
 * validation throws BEFORE any INSERT into expenses.
 */
describe('AccountingService.createExpense — source_employee_request_id validation', () => {
  let service: AccountingService;
  let ds: { query: jest.Mock; transaction: jest.Mock };
  let em: { query: jest.Mock };
  let engine: { recordTransaction: jest.Mock };

  // Helper — runs createExpense for a card-paid advance (no cashbox
  // needed) tied to an employee, with a source_employee_request_id
  // set. Lets each test focus on the SELECT employee_requests result.
  const callCreate = (sourceReqId: number, employeeId = 'employee-uuid') =>
    service.createExpense(
      {
        warehouse_id: 'warehouse-uuid',
        category_id: 'category-uuid',
        amount: 500,
        payment_method: 'card', // skips cash/cashbox requirement
        employee_user_id: employeeId,
        is_advance: true,
        source_employee_request_id: sourceReqId,
      } as any,
      'admin-uuid',
    );

  beforeEach(async () => {
    em = { query: jest.fn() };
    ds = {
      query: jest.fn(),
      transaction: jest.fn(async (cb: any) => cb(em)),
    };
    engine = { recordTransaction: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AccountingService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    service = moduleRef.get(AccountingService);
  });

  // Default query sequence used before the source-request validation
  // runs:
  //   1. SELECT id, cashbox_id FROM shifts (auto-resolve open shift)
  //      → return [] so we drop straight through to the validation
  //   2. (cashboxId null + shiftId null + payment 'card' → skip cashbox check)
  //   3. (employee_user_id given on DTO → skip auto-match SELECT)
  //   4. SELECT employee_requests ... FOR UPDATE → driven by each test
  const primeShiftLookup = () => {
    em.query.mockResolvedValueOnce([]); // no open shift
  };

  it('rejects when source_employee_request_id used without is_advance=true', async () => {
    em.query.mockResolvedValueOnce([]); // shift lookup
    await expect(
      service.createExpense(
        {
          warehouse_id: 'w',
          category_id: 'c',
          amount: 100,
          payment_method: 'card',
          employee_user_id: 'employee-uuid',
          source_employee_request_id: 99,
          is_advance: false, // ← the offence
        } as any,
        'admin-uuid',
      ),
    ).rejects.toThrow(/is_advance=true/);
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  it('rejects a non-existing request', async () => {
    primeShiftLookup();
    em.query.mockResolvedValueOnce([]); // SELECT employee_requests → empty
    await expect(callCreate(99)).rejects.toThrow(/طلب الموظف المرتبط غير موجود/);
    // No INSERT happened.
    const inserts = em.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    expect(inserts).toHaveLength(0);
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  it('rejects when the referenced request is the legacy kind=advance', async () => {
    primeShiftLookup();
    em.query.mockResolvedValueOnce([
      { id: 99, user_id: 'employee-uuid', status: 'approved', kind: 'advance' },
    ]);
    await expect(callCreate(99)).rejects.toThrow(/advance_request/);
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  it('rejects when the request is not approved yet', async () => {
    primeShiftLookup();
    em.query.mockResolvedValueOnce([
      { id: 99, user_id: 'employee-uuid', status: 'pending', kind: 'advance_request' },
    ]);
    await expect(callCreate(99)).rejects.toThrow(/غير معتمد/);
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  it('rejects when the request belongs to a different employee', async () => {
    primeShiftLookup();
    em.query.mockResolvedValueOnce([
      {
        id: 99,
        user_id: 'OTHER-employee-uuid',
        status: 'approved',
        kind: 'advance_request',
      },
    ]);
    await expect(callCreate(99, 'employee-uuid')).rejects.toThrow(
      /لا يطابق صاحب الطلب/,
    );
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  it('rejects a duplicate live disbursement for the same request', async () => {
    primeShiftLookup();
    em.query
      .mockResolvedValueOnce([
        // request lookup OK
        {
          id: 99,
          user_id: 'employee-uuid',
          status: 'approved',
          kind: 'advance_request',
        },
      ])
      .mockResolvedValueOnce([
        // dup-check returns a row → an active disbursement exists
        { id: 'existing-expense-uuid' },
      ]);
    await expect(callCreate(99)).rejects.toThrow(/مرتبط بالفعل/);
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  it('allows reprocessing when the previous JE was voided', async () => {
    // After void, the LEFT JOIN evaluates COALESCE(je.is_void, FALSE)
    // = TRUE so the WHERE clause filters the prior expense out → the
    // dup-check returns no rows. Validation passes through to INSERT.
    //
    // We assert success by checking that the INSERT INTO expenses
    // statement was executed with the FK persisted on the row. We
    // do NOT drive postViaEngine to completion in a unit test —
    // its category resolution + GL account lookup live in dedicated
    // helpers covered by posting.service.spec.ts. The createExpense
    // transaction will reject downstream (postViaEngine without a
    // resolver / engine helpers wired up), but by then the INSERT
    // has run and we have the proof we want.
    primeShiftLookup();
    em.query
      .mockResolvedValueOnce([
        { id: 99, user_id: 'employee-uuid', status: 'approved', kind: 'advance_request' },
      ])
      .mockResolvedValueOnce([]) // dup-check empty (only voided JE existed)
      // INSERT INTO expenses RETURNING * → minimal row.
      .mockResolvedValueOnce([
        {
          id: 'new-expense-uuid',
          amount: '500',
          category_id: 'category-uuid',
          payment_method: 'card',
          cashbox_id: null,
          employee_user_id: 'employee-uuid',
          is_advance: true,
          source_employee_request_id: 99,
        },
      ])
      // Any further em.query calls (UPDATE is_approved, etc.) return
      // empty so the chain proceeds until postViaEngine throws.
      .mockResolvedValue([]);

    // The transaction will ultimately reject when postViaEngine can't
    // complete its category-resolution path. That's expected for this
    // unit test — we only care that the validation accepted the row
    // and the INSERT fired.
    await callCreate(99).catch(() => undefined);

    const inserts = em.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    expect(inserts).toHaveLength(1);
    // FK was persisted as the last positional param ($14 — see
    // accounting.service.ts:304-329).
    const [, insertParams] = inserts[0];
    expect(insertParams[insertParams.length - 1]).toBe(99);
  });

  it('fails the dup-check the SECOND time the same request is disbursed live', async () => {
    // Sanity bookend for the void-reprocessing test above: when the
    // previous JE is NOT voided, the dup-check catches us. This is
    // the regression guard against the audit-#4-style double-pay.
    primeShiftLookup();
    em.query
      .mockResolvedValueOnce([
        { id: 99, user_id: 'employee-uuid', status: 'approved', kind: 'advance_request' },
      ])
      .mockResolvedValueOnce([{ id: 'existing-expense-uuid' }]); // active disbursement
    await expect(callCreate(99)).rejects.toThrow(/مرتبط بالفعل/);
    const inserts = em.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    expect(inserts).toHaveLength(0);
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });
});
