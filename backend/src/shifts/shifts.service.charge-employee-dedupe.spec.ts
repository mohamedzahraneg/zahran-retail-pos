/**
 * shifts.service.charge-employee-dedupe.spec.ts
 * PR-FIX-SHIFT-SHORTAGE-DEDUPE
 *
 * Pins the routing rule in ShiftsService.close():
 *
 *   variance < 0 && variance_treatment === 'charge_employee'
 *     → INSERT one row into employee_deductions (source='shift_shortage',
 *       shift_id=…, with ON CONFLICT DO NOTHING for idempotency)
 *     → DO NOT call engine.recordShiftVariance — no shift_variance JE,
 *       no shift_variance cashbox_transaction. The deduction row is
 *       the single source of truth; the existing
 *       trg_employee_deduction_post trigger mirrors it into the GL
 *       (DR 213 / CR 521) so v_employee_gl_balance still surfaces it,
 *       once, on the payable account.
 *
 *   variance < 0 && variance_treatment === 'company_loss'
 *   variance > 0 && variance_treatment === 'revenue' / 'suspense'
 *     → engine.recordShiftVariance writes JE + paired CT as before.
 *     → No employee_deductions row — those branches have no employee
 *       dimension.
 *
 * Idempotency: the SQL emitted for charge_employee includes
 *   `ON CONFLICT (shift_id) WHERE source='shift_shortage' AND ...`
 * matching the partial unique index introduced in migration 139.
 */
import { ShiftsService } from './shifts.service';

interface QueryCall {
  sql: string;
  params: unknown[];
}

const SHIFT_ID = 'aaaaaaaa-1111-2222-3333-444444444444';
const CASHBOX_ID = 'bbbbbbbb-1111-2222-3333-444444444444';
const EMPLOYEE_ID = 'cccccccc-1111-2222-3333-444444444444';
const USER_ID = 'dddddddd-1111-2222-3333-444444444444';

const OPEN_SHIFT = {
  id: SHIFT_ID,
  shift_no: 'SHF-2026-00099',
  status: 'open',
  opening_balance: '500',
  expected_closing: '500',
  cashbox_id: CASHBOX_ID,
  warehouse_id: 'eeeeeeee-1111-2222-3333-444444444444',
  variance_treatment: null,
  variance_employee_id: null,
  variance_notes: null,
  variance_journal_entry_id: null,
};

const CLOSE_SUMMARY = {
  expected_closing: 1000,
  total_sales: 500,
  total_returns: 0,
  total_expenses: 0,
  total_cash_in: 500,
  total_cash_out: 0,
  invoice_count: 5,
};

interface MakeSvcOpts {
  shift?: any;
  closeRow?: any;
}

function makeSvc(opts: MakeSvcOpts = {}) {
  const dsCalls: QueryCall[] = [];
  const emCalls: QueryCall[] = [];
  const shift = opts.shift ?? OPEN_SHIFT;
  const closeRow = opts.closeRow ?? { ...shift, status: 'closed', actual_closing: '900' };

  const em: any = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      emCalls.push({ sql, params });
      if (/UPDATE shifts SET[\s\S]*status\s*=\s*'closed'[\s\S]*RETURNING \*/i.test(sql)) {
        return [closeRow];
      }
      if (/INSERT INTO employee_deductions/i.test(sql)) {
        return [];
      }
      if (/UPDATE shifts SET variance_journal_entry_id/i.test(sql)) {
        return [];
      }
      return [];
    }),
  };

  const ds: any = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      dsCalls.push({ sql, params });
      if (/FROM shifts WHERE id/i.test(sql)) {
        return [shift];
      }
      return [];
    }),
    transaction: jest.fn(async (cb: (em: any) => Promise<any>) => cb(em)),
  };

  const recordShiftVariance = jest
    .fn()
    .mockResolvedValue({ ok: true, entry_id: 'je-99' });

  const engine: any = { recordShiftVariance };

  const svc = new ShiftsService(ds, undefined, engine);
  jest.spyOn(svc as any, 'computeSummary').mockResolvedValue(CLOSE_SUMMARY);
  jest.spyOn(svc as any, 'computeCanonicalSnapshot').mockResolvedValue({});
  jest.spyOn(svc as any, 'assertSnapshotIntegrity').mockReturnValue(undefined);

  return { svc, ds, em, engine, recordShiftVariance, dsCalls, emCalls };
}

const insertDeductionCall = (calls: QueryCall[]) =>
  calls.find((c) => /INSERT INTO employee_deductions/i.test(c.sql));

const cashTxnCall = (calls: QueryCall[]) =>
  calls.find((c) => /INSERT INTO cashbox_transactions/i.test(c.sql));

describe('PR-FIX-SHIFT-SHORTAGE-DEDUPE — close() variance routing', () => {
  // ────────────────────────────────────────────────────────────────
  // charge_employee shortage → deductions only, no engine call
  // ────────────────────────────────────────────────────────────────
  it('charge_employee shortage: INSERT employee_deductions, DO NOT call engine.recordShiftVariance', async () => {
    const { svc, engine, emCalls } = makeSvc();

    await svc.close(
      SHIFT_ID,
      {
        actual_closing: 900,
        variance_treatment: 'charge_employee',
        variance_employee_id: EMPLOYEE_ID,
      } as any,
      USER_ID,
      ['shifts.variance.approve'],
    );

    // The engine is the side that would otherwise have written the
    // shift_variance CT + 1123-tagged JE. Skipping it is the
    // dedupe — there must be ZERO calls.
    expect(engine.recordShiftVariance).not.toHaveBeenCalled();

    const insert = insertDeductionCall(emCalls);
    expect(insert).toBeDefined();
    expect(insert!.sql).toMatch(/'shift_shortage'/);
    expect(insert!.sql).toMatch(/ON CONFLICT\s*\(shift_id\)/i);
    expect(insert!.sql).toMatch(/source\s*=\s*'shift_shortage'/i);
    expect(insert!.sql).toMatch(/is_void\s*=\s*FALSE/i);
    expect(insert!.sql).toMatch(/DO NOTHING/i);

    // amount, employee, shift, reason all flow through.
    expect(insert!.params[0]).toBe(EMPLOYEE_ID);
    expect(insert!.params[1]).toBe(100); // abs(variance) = abs(900-1000)
    expect(String(insert!.params[2])).toMatch(/عجز وردية/);
    expect(insert!.params[3]).toBe(USER_ID);
    expect(insert!.params[4]).toBe(SHIFT_ID);

    // No direct cashbox_transactions insert from the close path itself.
    expect(cashTxnCall(emCalls)).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────
  // company_loss shortage → engine handles it, no deduction row
  // ────────────────────────────────────────────────────────────────
  it('company_loss shortage: engine.recordShiftVariance called, NO employee_deductions INSERT', async () => {
    const { svc, engine, emCalls } = makeSvc();

    await svc.close(
      SHIFT_ID,
      {
        actual_closing: 900,
        variance_treatment: 'company_loss',
      } as any,
      USER_ID,
      ['shifts.variance.approve'],
    );

    expect(engine.recordShiftVariance).toHaveBeenCalledTimes(1);
    const args = engine.recordShiftVariance.mock.calls[0][0];
    expect(args).toMatchObject({
      shift_id: SHIFT_ID,
      variance: -100,
      treatment: 'company_loss',
    });

    // company_loss has no employee dimension — no deduction row.
    expect(insertDeductionCall(emCalls)).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────
  // revenue overage → engine handles it, no deduction row
  // ────────────────────────────────────────────────────────────────
  it('revenue overage: engine.recordShiftVariance called, NO employee_deductions INSERT', async () => {
    const { svc, engine, emCalls } = makeSvc();

    await svc.close(
      SHIFT_ID,
      {
        actual_closing: 1100,
        variance_treatment: 'revenue',
      } as any,
      USER_ID,
      ['shifts.variance.approve'],
    );

    expect(engine.recordShiftVariance).toHaveBeenCalledTimes(1);
    const args = engine.recordShiftVariance.mock.calls[0][0];
    expect(args).toMatchObject({
      shift_id: SHIFT_ID,
      variance: 100,
      treatment: 'revenue',
    });

    expect(insertDeductionCall(emCalls)).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────
  // suspense overage → engine handles it, no deduction row
  // ────────────────────────────────────────────────────────────────
  it('suspense overage: engine.recordShiftVariance called, NO employee_deductions INSERT', async () => {
    const { svc, engine, emCalls } = makeSvc();

    await svc.close(
      SHIFT_ID,
      {
        actual_closing: 1100,
        variance_treatment: 'suspense',
      } as any,
      USER_ID,
      ['shifts.variance.approve'],
    );

    expect(engine.recordShiftVariance).toHaveBeenCalledTimes(1);
    expect(engine.recordShiftVariance.mock.calls[0][0].treatment).toBe(
      'suspense',
    );
    expect(insertDeductionCall(emCalls)).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────
  // Zero-variance close → no engine call, no deduction row
  // ────────────────────────────────────────────────────────────────
  it('zero-variance close: no engine call, no deduction', async () => {
    const { svc, engine, emCalls } = makeSvc();

    await svc.close(
      SHIFT_ID,
      { actual_closing: 1000 } as any,
      USER_ID,
      ['shifts.variance.approve'],
    );

    expect(engine.recordShiftVariance).not.toHaveBeenCalled();
    expect(insertDeductionCall(emCalls)).toBeUndefined();
  });

  // ────────────────────────────────────────────────────────────────
  // Idempotency: the emitted SQL uses ON CONFLICT DO NOTHING with
  // the predicate matching migration 139's partial unique index.
  // A replay on the same shift therefore can't double-charge.
  // ────────────────────────────────────────────────────────────────
  it('charge_employee shortage emits ON CONFLICT DO NOTHING with shift_id key', async () => {
    const { svc, emCalls } = makeSvc();

    await svc.close(
      SHIFT_ID,
      {
        actual_closing: 900,
        variance_treatment: 'charge_employee',
        variance_employee_id: EMPLOYEE_ID,
      } as any,
      USER_ID,
      ['shifts.variance.approve'],
    );

    const insert = insertDeductionCall(emCalls);
    expect(insert).toBeDefined();
    // The predicate on the ON CONFLICT must match the partial unique
    // index `uq_employee_deductions_shift_shortage_live` exactly so
    // PostgreSQL routes to that index. Verify each clause:
    expect(insert!.sql).toMatch(/ON CONFLICT\s*\(shift_id\)/i);
    expect(insert!.sql).toMatch(/WHERE\s+source\s*=\s*'shift_shortage'/i);
    expect(insert!.sql).toMatch(/AND\s+is_void\s*=\s*FALSE/i);
    expect(insert!.sql).toMatch(/AND\s+shift_id\s+IS\s+NOT\s+NULL/i);
    expect(insert!.sql).toMatch(/DO NOTHING/i);
  });
});
