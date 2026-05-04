/**
 * financial-engine.employee-codes.spec.ts — PR-AUDIT-POSTING-GL-CONSTANTS-B1-EMPLOYEE
 * ────────────────────────────────────────────────────────────────────
 *
 * Regression spec written BEFORE the literal-to-constant substitution
 * in `financial-engine.service.ts`. Pins the two previously-uncovered
 * branches that emit `'1123'` (Employee Receivables) on the DR side:
 *
 *   1. recordExpense        with is_advance=true + employee_user_id
 *      → DR 1123 / CR cashbox or 210
 *
 *   2. recordShiftVariance  with treatment='charge_employee' (deficit)
 *      → DR 1123 / CR cashbox  + cash 'out'
 *
 * Plus a defensive companion test pinning the un-migrated literal:
 *
 *   3. recordShiftVariance  with treatment='company_loss' (deficit,
 *      no employee charge) → DR 531 / CR cashbox  + cash 'out'
 *
 * The `'531'` literal is intentionally LEFT as a string literal in
 * source code by this PR (out of B1 scope — deferred to a future
 * COGS/shortage-loss phase). Pinning it here means a future Phase B2
 * substitution (when 531 is migrated to a named constant) cannot
 * silently change the emitted code.
 *
 * Stub strategy:
 *   • Mock `DataSource.transaction` to invoke the callback with a
 *     stubbed `EntityManager` that captures `INSERT INTO journal_entries`
 *     + `INSERT INTO journal_lines` calls without touching Postgres.
 *   • Spy on `recordTransaction` (the engine's internal entry point)
 *     to capture the `gl_lines` array directly — much smaller-blast-
 *     radius than mocking the full DB layer.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { FinancialEngineService } from './financial-engine.service';

describe('FinancialEngine — employee GL codes (PR-AUDIT-POSTING-GL-CONSTANTS-B1-EMPLOYEE)', () => {
  let service: FinancialEngineService;

  beforeEach(async () => {
    const ds: any = {
      query: jest.fn(),
      transaction: jest.fn(async (cb: any) => cb({ query: jest.fn() })),
    };
    const moduleRef = await Test.createTestingModule({
      providers: [
        FinancialEngineService,
        { provide: DataSource, useValue: ds },
      ],
    }).compile();
    service = moduleRef.get(FinancialEngineService);
  });

  describe('recordExpense — advance branch', () => {
    it('with is_advance=true + employee_user_id → DR account_code = "1123"', async () => {
      // Spy on the internal `recordTransaction` so we can assert the
      // gl_lines without exercising the JE INSERT path.
      const spy = jest
        .spyOn(service as any, 'recordTransaction')
        .mockResolvedValue({ ok: true, entry_id: 'stub-je-id' });

      await service.recordExpense({
        expense_id: 'exp-uuid',
        expense_no: 'EXP-2026-000999',
        amount: 250,
        category_account_id: null,
        cashbox_id: 'cashbox-uuid',
        payment_method: 'cash',
        user_id: 'admin-uuid',
        is_advance: true,
        employee_user_id: 'employee-uuid',
      });

      expect(spy).toHaveBeenCalledTimes(1);
      const [args] = spy.mock.calls[0] as [any];
      // DR side carries the employee-receivable code, the employee tag,
      // and the full amount. Behavior pinned: account_code === '1123'.
      expect(args.gl_lines[0]).toMatchObject({
        account_code: '1123',
        debit: 250,
        employee_user_id: 'employee-uuid',
      });
      // Reference shape (unchanged by this PR's substitution scope).
      expect(args.reference_type).toBe('expense');
      expect(args.reference_id).toBe('exp-uuid');
      // Cash side (CR) resolves the cashbox account, no GL code.
      expect(args.gl_lines[1]).toMatchObject({
        resolve_from_cashbox_id: 'cashbox-uuid',
        credit: 250,
        cashbox_id: 'cashbox-uuid',
      });
    });

    it('non-advance expense with category_account_id does NOT emit "1123"', async () => {
      // Defensive: refuse a regression where the advance branch is
      // entered for non-advance expenses.
      const spy = jest
        .spyOn(service as any, 'recordTransaction')
        .mockResolvedValue({ ok: true, entry_id: 'stub-je-id' });

      await service.recordExpense({
        expense_id: 'exp-uuid',
        amount: 250,
        category_account_id: 'category-coa-uuid',
        cashbox_id: 'cashbox-uuid',
        payment_method: 'cash',
        user_id: 'admin-uuid',
        // is_advance omitted → false
      });

      const [args] = spy.mock.calls[0] as [any];
      // DR side uses account_id (the category COA), NOT account_code '1123'.
      expect(args.gl_lines[0]).toMatchObject({
        account_id: 'category-coa-uuid',
        debit: 250,
      });
      expect(args.gl_lines[0].account_code).toBeUndefined();
    });
  });

  describe('recordShiftVariance — deficit branches', () => {
    it("with treatment='charge_employee' → DR account_code = '1123' tagged with employee", async () => {
      const spy = jest
        .spyOn(service as any, 'recordTransaction')
        .mockResolvedValue({ ok: true, entry_id: 'stub-je-id' });

      await service.recordShiftVariance({
        shift_id: 'shift-uuid',
        shift_no: 'SHF-2026-00099',
        cashbox_id: 'cashbox-uuid',
        variance: -75, // deficit
        user_id: 'admin-uuid',
        treatment: 'charge_employee',
        employee_id: 'employee-uuid',
      });

      expect(spy).toHaveBeenCalledTimes(1);
      const [args] = spy.mock.calls[0] as [any];
      // DR side: 1123 tagged with the employee.
      expect(args.gl_lines[0]).toMatchObject({
        account_code: '1123',
        debit: 75,
        employee_user_id: 'employee-uuid',
      });
      // CR side resolves the cashbox.
      expect(args.gl_lines[1]).toMatchObject({
        resolve_from_cashbox_id: 'cashbox-uuid',
        credit: 75,
        cashbox_id: 'cashbox-uuid',
      });
      // Reference shape pinned (unchanged by this PR).
      expect(args.reference_type).toBe('shift_variance');
      expect(args.reference_id).toBe('shift-uuid');
      // Cash leaves the drawer (deficit = cash short).
      expect(args.cash_movements[0]).toMatchObject({
        cashbox_id: 'cashbox-uuid',
        direction: 'out',
        amount: 75,
        category: 'shift_variance',
      });
    });

    it("with treatment='company_loss' → DR account_code = '531' (NOT employee-tagged)", async () => {
      // Defensive companion: pins the un-migrated literal '531' so a
      // future COGS/shortage-loss phase that touches it cannot silently
      // change the emitted code. THIS PR DOES NOT REPLACE '531'.
      const spy = jest
        .spyOn(service as any, 'recordTransaction')
        .mockResolvedValue({ ok: true, entry_id: 'stub-je-id' });

      await service.recordShiftVariance({
        shift_id: 'shift-uuid',
        cashbox_id: 'cashbox-uuid',
        variance: -50, // deficit
        user_id: 'admin-uuid',
        treatment: 'company_loss',
      });

      const [args] = spy.mock.calls[0] as [any];
      expect(args.gl_lines[0]).toMatchObject({
        account_code: '531',
        debit: 50,
      });
      // No employee tag on company_loss.
      expect(args.gl_lines[0].employee_user_id).toBeUndefined();
    });
  });
});
