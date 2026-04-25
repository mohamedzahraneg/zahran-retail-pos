import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { EmployeesService } from './employees.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

/**
 * Unit tests for the pure helpers added to EmployeesService for the
 * monthly-filtered Employee Profile (migrations 081–084). We pull the
 * private helpers via a subclass so we can exercise them without a
 * DataSource / NestJS module.
 */
class TestableEmployeesService extends EmployeesService {
  constructor() {
    super(null as any);
  }
  monthBoundsPublic(month?: string) {
    return (this as any).monthBounds(month);
  }
  dayBeforePublic(iso: string) {
    return (this as any).dayBefore(iso);
  }
}

describe('EmployeesService helpers — monthly filter', () => {
  const svc = new TestableEmployeesService();

  describe('monthBounds', () => {
    it('returns first + last day for a valid YYYY-MM', () => {
      const r = svc.monthBoundsPublic('2026-02');
      expect(r.from).toBe('2026-02-01');
      expect(r.to).toBe('2026-02-28');
      expect(r.label).toBe('2026-02');
    });

    it('handles a month with 31 days', () => {
      const r = svc.monthBoundsPublic('2026-01');
      expect(r.from).toBe('2026-01-01');
      expect(r.to).toBe('2026-01-31');
    });

    it('handles a leap-year February', () => {
      const r = svc.monthBoundsPublic('2024-02');
      expect(r.from).toBe('2024-02-01');
      expect(r.to).toBe('2024-02-29');
    });

    it('falls back to current month when input is absent or malformed', () => {
      for (const bad of [undefined, '', 'nonsense', '2026-13', '2026/04']) {
        const r = svc.monthBoundsPublic(bad as any);
        expect(r.label).toMatch(/^\d{4}-\d{2}$/);
        expect(r.from).toBe(`${r.label}-01`);
      }
    });

    it('flags is_current=true for the current Cairo month', () => {
      const nowCairo = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Africa/Cairo',
        year: 'numeric',
        month: '2-digit',
      }).formatToParts(new Date());
      const y = nowCairo.find((p) => p.type === 'year')!.value;
      const m = nowCairo.find((p) => p.type === 'month')!.value;
      const r = svc.monthBoundsPublic(`${y}-${m}`);
      expect(r.isCurrent).toBe(true);
    });

    it('flags is_current=false for a clearly past month', () => {
      const r = svc.monthBoundsPublic('2020-01');
      expect(r.isCurrent).toBe(false);
    });
  });

  describe('dayBefore', () => {
    it('returns the previous calendar day', () => {
      expect(svc.dayBeforePublic('2026-04-20')).toBe('2026-04-19');
      expect(svc.dayBeforePublic('2026-04-01')).toBe('2026-03-31');
      expect(svc.dayBeforePublic('2026-01-01')).toBe('2025-12-31');
    });

    it('handles leap-year Feb 29 + Mar 1 boundary', () => {
      expect(svc.dayBeforePublic('2024-03-01')).toBe('2024-02-29');
    });
  });
});

/**
 * Unit tests for the post-fix `recordSettlement` direction. After
 * migration 088 + the paired code change, cash/bank settlements
 * mean "company pays employee" — DR 213 / CR cashbox / cashbox 'out'.
 */
describe('EmployeesService.recordSettlement — cash/bank direction', () => {
  let service: EmployeesService;
  let ds: { query: jest.Mock; transaction: jest.Mock };
  let engine: { recordTransaction: jest.Mock };
  let em: { query: jest.Mock };

  beforeEach(async () => {
    em = { query: jest.fn() };
    ds = {
      query: jest.fn(),
      transaction: jest.fn(async (cb: any) => cb(em)),
    };
    engine = { recordTransaction: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EmployeesService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    service = moduleRef.get(EmployeesService);
  });

  it('cash settlement posts DR 213 / CR cashbox + cashbox direction=out', async () => {
    em.query
      // INSERT into employee_settlements RETURNING *
      .mockResolvedValueOnce([{ id: 7, journal_entry_id: null }])
      // SELECT uuid_generate_v5 ... RETURNING ref
      .mockResolvedValueOnce([{ ref: 'ref-uuid' }])
      // UPDATE employee_settlements SET journal_entry_id ...
      .mockResolvedValueOnce([]);
    engine.recordTransaction.mockResolvedValueOnce({
      ok: true,
      entry_id: 'new-je-uuid',
    });

    await service.recordSettlement(
      'employee-uuid',
      {
        amount: 100,
        method: 'cash',
        cashbox_id: 'cashbox-uuid',
      },
      'admin-uuid',
      // PR-25 — direct-cashbox branch (no shift_id) now requires this
      // permission; tests exercise the cash-out path so we grant it.
      ['employees.settlement.direct_cashbox'],
    );

    const [args] = engine.recordTransaction.mock.calls[0];
    // DR side = 213 tagged with employee
    expect(args.gl_lines[0]).toMatchObject({
      account_code: '213',
      debit: 100,
      employee_user_id: 'employee-uuid',
    });
    // CR side resolves to cashbox account
    expect(args.gl_lines[1]).toMatchObject({
      resolve_from_cashbox_id: 'cashbox-uuid',
      credit: 100,
      cashbox_id: 'cashbox-uuid',
    });
    // Cashbox movement direction must be 'out' (cash leaves drawer)
    expect(args.cash_movements).toHaveLength(1);
    expect(args.cash_movements[0]).toMatchObject({
      cashbox_id: 'cashbox-uuid',
      direction: 'out',
      amount: 100,
      category: 'employee_settlement',
    });
  });

  it('bank settlement posts DR 213 / CR cashbox + direction=out', async () => {
    em.query
      .mockResolvedValueOnce([{ id: 8, journal_entry_id: null }])
      .mockResolvedValueOnce([{ ref: 'ref-uuid' }])
      .mockResolvedValueOnce([]);
    engine.recordTransaction.mockResolvedValueOnce({
      ok: true,
      entry_id: 'new-je-uuid',
    });

    await service.recordSettlement(
      'employee-uuid',
      { amount: 50, method: 'bank', cashbox_id: 'bank-cashbox-uuid' },
      'admin-uuid',
      ['employees.settlement.direct_cashbox'],
    );
    const [args] = engine.recordTransaction.mock.calls[0];
    expect(args.gl_lines[0].account_code).toBe('213');
    expect(args.gl_lines[1].resolve_from_cashbox_id).toBe('bank-cashbox-uuid');
    expect(args.cash_movements[0].direction).toBe('out');
  });

  it('payroll_deduction stays DR 213 / CR 1123 with no cash movement', async () => {
    em.query
      .mockResolvedValueOnce([{ id: 9, journal_entry_id: null }])
      .mockResolvedValueOnce([{ ref: 'ref-uuid' }])
      .mockResolvedValueOnce([]);
    engine.recordTransaction.mockResolvedValueOnce({
      ok: true,
      entry_id: 'new-je-uuid',
    });

    await service.recordSettlement(
      'employee-uuid',
      { amount: 30, method: 'payroll_deduction' },
      'admin-uuid',
    );
    const [args] = engine.recordTransaction.mock.calls[0];
    expect(args.gl_lines[0].account_code).toBe('213');
    expect(args.gl_lines[1].account_code).toBe('1123');
    expect(args.cash_movements).toHaveLength(0);
  });

  it('other settlement stays DR <offset> / CR 1123 with no cash movement', async () => {
    em.query
      .mockResolvedValueOnce([{ id: 10, journal_entry_id: null }])
      .mockResolvedValueOnce([{ ref: 'ref-uuid' }])
      .mockResolvedValueOnce([]);
    engine.recordTransaction.mockResolvedValueOnce({
      ok: true,
      entry_id: 'new-je-uuid',
    });

    await service.recordSettlement(
      'employee-uuid',
      {
        amount: 70,
        method: 'other',
        offset_account_code: '1114',
      },
      'admin-uuid',
    );
    const [args] = engine.recordTransaction.mock.calls[0];
    expect(args.gl_lines[0].account_code).toBe('1114');
    expect(args.gl_lines[1].account_code).toBe('1123');
    expect(args.cash_movements).toHaveLength(0);
  });

  // PR-25 — direct-cashbox payouts (shift_id omitted, cashbox_id set,
  // method = cash/bank) require employees.settlement.direct_cashbox.
  // Wildcards (* / employees.*) satisfy. This test prevents the gate
  // from being silently dropped in a future refactor.
  it('rejects direct-cashbox cash settlement without the perm', async () => {
    await expect(
      service.recordSettlement(
        'employee-uuid',
        { amount: 100, method: 'cash', cashbox_id: 'cashbox-uuid' },
        'admin-uuid',
        [], // no perms
      ),
    ).rejects.toThrow(/employees\.settlement\.direct_cashbox/);
    // Engine must NOT have been touched on the rejection path.
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });
});
