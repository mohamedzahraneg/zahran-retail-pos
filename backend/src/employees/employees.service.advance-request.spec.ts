/**
 * employees.service.advance-request.spec.ts — PR-ESS-2A-HOTFIX-1
 * ────────────────────────────────────────────────────────────────────
 *
 * Regression suite for the safe self-service salary-advance request
 * flow. Pins three invariants that the legacy `kind='advance'` path
 * violated (silent auto-post of GL + employee_transactions on
 * approval) and that the new `kind='advance_request'` path MUST hold:
 *
 *   1. submitAdvanceRequest INSERTs with kind='advance_request'
 *      (NOT 'advance' — the latter trips fn_mirror_advance_to_txn).
 *   2. Approval of an `advance_request` is a pure status flip: the
 *      service issues a single UPDATE on employee_requests and never
 *      writes / triggers writes to employee_transactions or
 *      journal_entries (verified at the unit level by checking that
 *      decideRequest doesn't call FinancialEngineService and that
 *      submitAdvanceRequest doesn't issue any non-employee_requests
 *      INSERT).
 *   3. Legacy kind='advance' submissions through the generic
 *      submitRequest path remain accessible for HISTORICAL rows but
 *      our new endpoint never emits that kind.
 *
 * The trigger cascade itself is tested at the database level by the
 * migration's self-validation block; jest stubs the DataSource so we
 * can assert the SQL strings the service emits without touching a
 * real Postgres.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

describe('EmployeesService.submitAdvanceRequest — PR-ESS-2A-HOTFIX-1 safe kind', () => {
  let service: EmployeesService;
  let ds: { query: jest.Mock; transaction: jest.Mock };
  let engine: { recordTransaction: jest.Mock };

  beforeEach(async () => {
    ds = {
      query: jest.fn(),
      transaction: jest.fn(),
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

  it('inserts kind = advance_request (NOT legacy advance)', async () => {
    ds.query.mockResolvedValueOnce([{ id: 99, kind: 'advance_request' }]);

    await service.submitAdvanceRequest('user-uuid', {
      amount: 250,
      reason: 'ظرف طارئ',
    });

    expect(ds.query).toHaveBeenCalledTimes(1);
    const [sql, params] = ds.query.mock.calls[0];
    // SQL must literal-INSERT 'advance_request'. The legacy mirror
    // trigger fires only on NEW.kind='advance', so any drift on this
    // literal would re-introduce the silent auto-post.
    expect(sql).toMatch(/INSERT INTO employee_requests/);
    expect(sql).toContain("'advance_request'");
    expect(sql).not.toMatch(/'advance'(?!_)/); // exact 'advance' literal
    // Positional params: user, amount, reason. NO kind param — kind
    // is hardcoded in the SQL so a typo would fail the literal test
    // above instead of silently resolving from a parameter.
    expect(params).toEqual(['user-uuid', 250, 'ظرف طارئ']);
  });

  it('appends notes to reason separated by a blank line', async () => {
    ds.query.mockResolvedValueOnce([{ id: 100 }]);

    await service.submitAdvanceRequest('user-uuid', {
      amount: 50,
      reason: 'ظرف',
      notes: 'يفضّل الصرف الأسبوع القادم',
    });

    const [, params] = ds.query.mock.calls[0];
    expect(params[2]).toBe('ظرف\n\nيفضّل الصرف الأسبوع القادم');
  });

  it('does NOT call FinancialEngineService on submission', async () => {
    ds.query.mockResolvedValueOnce([{ id: 101 }]);

    await service.submitAdvanceRequest('user-uuid', {
      amount: 250,
      reason: 'ظرف',
    });

    // The endpoint contract is REQUEST-ONLY — no GL/cashbox writes
    // and no engine calls under any path. This pins the contract so
    // accidental engine wiring fails the build.
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  it('emits exactly ONE SQL statement (no employee_transactions / journal write)', async () => {
    ds.query.mockResolvedValueOnce([{ id: 102 }]);

    await service.submitAdvanceRequest('user-uuid', {
      amount: 250,
      reason: 'ظرف',
    });

    // Single INSERT into employee_requests; ANY second SQL would be
    // a regression because submission must not touch employee_transactions,
    // journal_entries, journal_lines, cashbox_transactions, or expenses.
    expect(ds.query).toHaveBeenCalledTimes(1);
    const sqls = ds.query.mock.calls.map((c) => c[0] as string);
    for (const sql of sqls) {
      expect(sql).not.toMatch(/employee_transactions/i);
      expect(sql).not.toMatch(/journal_entries/i);
      expect(sql).not.toMatch(/journal_lines/i);
      expect(sql).not.toMatch(/cashbox_transactions/i);
      expect(sql).not.toMatch(/INSERT INTO expenses/i);
    }
  });

  it('rejects amount <= 0', async () => {
    await expect(
      service.submitAdvanceRequest('user-uuid', { amount: 0, reason: 'x' }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.submitAdvanceRequest('user-uuid', { amount: -5, reason: 'x' }),
    ).rejects.toThrow(BadRequestException);

    expect(ds.query).not.toHaveBeenCalled();
  });

  it('rejects empty reason', async () => {
    await expect(
      service.submitAdvanceRequest('user-uuid', { amount: 100, reason: '' }),
    ).rejects.toThrow(BadRequestException);

    await expect(
      service.submitAdvanceRequest('user-uuid', { amount: 100, reason: '   ' }),
    ).rejects.toThrow(BadRequestException);

    expect(ds.query).not.toHaveBeenCalled();
  });
});

describe('EmployeesService.decideRequest — PR-ESS-2A-HOTFIX-1 status-flip only', () => {
  let service: EmployeesService;
  let ds: { query: jest.Mock; transaction: jest.Mock };
  let engine: { recordTransaction: jest.Mock };

  beforeEach(async () => {
    ds = { query: jest.fn(), transaction: jest.fn() };
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

  it('approving an advance_request issues a single UPDATE — no engine call, no extra writes', async () => {
    ds.query.mockResolvedValueOnce([
      { id: 1, kind: 'advance_request', status: 'approved', amount: '250' },
    ]);

    await service.decideRequest('1', 'approved', 'admin-uuid');

    // Single UPDATE on employee_requests, full stop.
    expect(ds.query).toHaveBeenCalledTimes(1);
    const [sql] = ds.query.mock.calls[0];
    expect(sql).toMatch(/UPDATE employee_requests/);
    expect(sql).not.toMatch(/employee_transactions/i);
    expect(sql).not.toMatch(/journal_entries/i);
    expect(sql).not.toMatch(/cashbox_transactions/i);
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  it('approving a leave request also issues only a single UPDATE — no side effects', async () => {
    ds.query.mockResolvedValueOnce([
      { id: 2, kind: 'leave', status: 'approved' },
    ]);

    await service.decideRequest('2', 'approved', 'admin-uuid');

    expect(ds.query).toHaveBeenCalledTimes(1);
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  it('rejecting requires a reason and is also a single UPDATE', async () => {
    await expect(
      service.decideRequest('3', 'rejected', 'admin-uuid', '   '),
    ).rejects.toThrow(BadRequestException);

    ds.query.mockResolvedValueOnce([
      { id: 3, status: 'rejected', decision_reason: 'duplicate' },
    ]);

    await service.decideRequest('3', 'rejected', 'admin-uuid', 'duplicate');

    expect(ds.query).toHaveBeenCalledTimes(1);
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  it('decideRequest service body never references the legacy kind=advance trigger path', () => {
    // Belt-and-braces source-level assertion — if anyone re-introduces
    // a code path that calls fn_mirror_advance_to_txn or similar
    // helpers from this method, this test will fail loudly.
    const src = (service as any).decideRequest.toString() as string;
    expect(src).not.toMatch(/fn_mirror_advance_to_txn/);
    expect(src).not.toMatch(/employee_transactions/i);
    expect(src).not.toMatch(/journal_entries/i);
  });
});

describe('EmployeesService.submitRequest — legacy generic endpoint untouched', () => {
  let service: EmployeesService;
  let ds: { query: jest.Mock; transaction: jest.Mock };
  let engine: { recordTransaction: jest.Mock };

  beforeEach(async () => {
    ds = { query: jest.fn(), transaction: jest.fn() };
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

  it('leave request still works through the generic endpoint', async () => {
    ds.query.mockResolvedValueOnce([{ id: 50, kind: 'leave' }]);

    await service.submitRequest('user-uuid', {
      kind: 'leave',
      starts_at: '2026-05-01',
      ends_at: '2026-05-03',
      reason: 'إجازة عائلية',
    });

    const [sql] = ds.query.mock.calls[0];
    expect(sql).toMatch(/INSERT INTO employee_requests/);
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  it('overtime_extension request still works', async () => {
    ds.query.mockResolvedValueOnce([{ id: 51, kind: 'overtime_extension' }]);

    await service.submitRequest('user-uuid', {
      kind: 'overtime_extension',
      reason: 'عمل إضافي',
    });

    expect(ds.query).toHaveBeenCalledTimes(1);
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  it('"other" kind still works', async () => {
    ds.query.mockResolvedValueOnce([{ id: 52, kind: 'other' }]);

    await service.submitRequest('user-uuid', {
      kind: 'other',
      reason: 'استفسار عام',
    });

    expect(ds.query).toHaveBeenCalledTimes(1);
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  it('legacy kind=advance is still accepted by the underlying SQL (preserves historical writers) but submission rejects without amount', async () => {
    // The generic submitRequest method retains the legacy 'advance'
    // kind in its DTO union so historical callers don't break. Our
    // controller-side RequestDto narrows the public surface, so this
    // test is just pinning the service-level contract.
    await expect(
      service.submitRequest('user-uuid', {
        kind: 'advance',
        // missing amount — service must reject before insert
        reason: 'سلفة',
      }),
    ).rejects.toThrow(BadRequestException);

    expect(ds.query).not.toHaveBeenCalled();
  });
});
