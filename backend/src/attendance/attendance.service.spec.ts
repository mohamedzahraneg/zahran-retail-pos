import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AttendanceService } from './attendance.service';
import { EmployeesService } from '../employees/employees.service';
import { AccountingService } from '../accounting/accounting.service';

/**
 * Unit tests for the admin-on-behalf + wage-accrual + pay-wage surface
 * added in migrations 081–084 and the PR-1 payroll cleanup.
 * DataSource + downstream services are mocked — we assert the SQL
 * shape and the validation behaviour, not the database itself.
 */
describe('AttendanceService — admin + wage accrual + pay-wage', () => {
  let service: AttendanceService;
  let ds: { query: jest.Mock };
  let empSvc: { recordSettlement: jest.Mock; addBonus: jest.Mock };
  let accountingSvc: { createDailyExpense: jest.Mock };

  beforeEach(async () => {
    ds = { query: jest.fn() };
    empSvc = { recordSettlement: jest.fn(), addBonus: jest.fn() };
    accountingSvc = { createDailyExpense: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: DataSource, useValue: ds },
        { provide: EmployeesService, useValue: empSvc },
        { provide: AccountingService, useValue: accountingSvc },
      ],
    }).compile();
    service = moduleRef.get(AttendanceService);
  });

  // ── Test B: admin records attendance for employee ──────────────────
  describe('adminClockIn', () => {
    it('throws when target user is inactive / missing', async () => {
      ds.query.mockResolvedValueOnce([]); // SELECT users → empty
      await expect(
        service.adminClockIn('target-uuid', 'admin-uuid'),
      ).rejects.toThrow('الموظف غير موجود');
    });

    it('inserts a new attendance row tagged with [admin:<id>] note', async () => {
      ds.query
        .mockResolvedValueOnce([{ id: 'target-uuid' }]) // active user
        .mockResolvedValueOnce([]) // no existing record today
        .mockResolvedValueOnce([{ id: 'new-attendance' }]); // INSERT

      const res = await service.adminClockIn('target-uuid', 'admin-uuid');
      expect(res.id).toBe('new-attendance');
      const insertCall = ds.query.mock.calls[2];
      expect(insertCall[0]).toContain('INSERT INTO attendance_records');
      expect(insertCall[1][2]).toMatch(/^\[admin:admin-uuid\]/);
    });

    it('refuses a second clock-in when already clocked in', async () => {
      ds.query
        .mockResolvedValueOnce([{ id: 'target-uuid' }])
        .mockResolvedValueOnce([
          { id: 'rec', clock_in: 'x', clock_out: null },
        ]);
      await expect(
        service.adminClockIn('target-uuid', 'admin-uuid'),
      ).rejects.toThrow('الموظف مسجّل حضور بالفعل اليوم');
    });
  });

  // ── Test C: admin marks payable day without attendance ─────────────
  describe('adminMarkPayableDay', () => {
    it('requires a non-empty reason', async () => {
      await expect(
        service.adminMarkPayableDay('u1', '2026-04-20', '', 'admin'),
      ).rejects.toThrow('السبب مطلوب');
      await expect(
        service.adminMarkPayableDay('u1', '2026-04-20', '   ', 'admin'),
      ).rejects.toThrow('السبب مطلوب');
    });

    it('throws when employee not found', async () => {
      ds.query.mockResolvedValueOnce([]);
      await expect(
        service.adminMarkPayableDay('u1', '2026-04-20', 'عيد', 'admin'),
      ).rejects.toThrow('الموظف غير موجود');
    });

    it('throws when daily wage is not configured', async () => {
      ds.query.mockResolvedValueOnce([
        { id: 'u1', salary_amount: 0, target_hours_day: 8 },
      ]);
      await expect(
        service.adminMarkPayableDay('u1', '2026-04-20', 'عيد', 'admin'),
      ).rejects.toThrow('لم يُحدَّد راتب يومي للموظف');
    });

    it('calls fn_post_employee_wage_accrual with admin_manual + reason', async () => {
      ds.query
        .mockResolvedValueOnce([
          { id: 'u1', salary_amount: 270, salary_frequency: 'daily', target_hours_day: 12 },
        ])
        .mockResolvedValueOnce([{ payable_day_id: 'pd-1' }]);

      const res = await service.adminMarkPayableDay(
        'u1',
        '2026-04-20',
        'عيد وطني',
        'admin',
      );
      expect(res).toEqual({ payable_day_id: 'pd-1' });

      const [sql, params] = ds.query.mock.calls[1];
      expect(sql).toContain('fn_post_employee_wage_accrual');
      expect(params[0]).toBe('u1');              // user_id
      expect(params[1]).toBe('2026-04-20');      // work_date
      expect(params[2]).toBe(270);               // amount
      expect(params[3]).toBe(270);               // daily_wage_snapshot
      expect(params[4]).toBe(720);               // target minutes = 12 * 60
      expect(params[5]).toBe('عيد وطني');        // reason
      expect(params[6]).toBe('admin');           // created_by
      // source='admin_manual' is a SQL literal inside the call; assert
      // via the raw SQL text instead of params.
      expect(sql).toContain(`'admin_manual'`);
      expect(sql).toContain('NULL::uuid');       // no attendance_record_id
    });
  });

  // ── Test B/A: approve wage from existing attendance ────────────────
  describe('adminApproveWageFromAttendance', () => {
    it('throws when attendance record is missing', async () => {
      ds.query.mockResolvedValueOnce([]);
      await expect(
        service.adminApproveWageFromAttendance('att-1', 'admin'),
      ).rejects.toThrow('سجل الحضور غير موجود');
    });

    it('refuses to accrue before clock-out is recorded', async () => {
      ds.query.mockResolvedValueOnce([
        {
          id: 'att-1',
          user_id: 'u1',
          work_date: '2026-04-20',
          clock_out: null,
          duration_min: null,
          salary_amount: 270,
          target_hours_day: 12,
        },
      ]);
      await expect(
        service.adminApproveWageFromAttendance('att-1', 'admin'),
      ).rejects.toThrow('لا يمكن تثبيت يومية قبل تسجيل الانصراف');
    });

    it('posts a wage accrual tied to the attendance record (source=attendance)', async () => {
      ds.query
        .mockResolvedValueOnce([
          {
            id: 'att-1',
            user_id: 'u1',
            work_date: '2026-04-20',
            clock_out: '2026-04-20T20:00:00Z',
            duration_min: 720,
            salary_amount: 270,
            target_hours_day: 12,
          },
        ])
        .mockResolvedValueOnce([{ payable_day_id: 'pd-1' }]);

      const res = await service.adminApproveWageFromAttendance('att-1', 'admin');
      expect(res).toEqual({ payable_day_id: 'pd-1' });

      const [sql, params] = ds.query.mock.calls[1];
      expect(sql).toContain('fn_post_employee_wage_accrual');
      expect(sql).toContain(`'attendance'`);   // source literal
      expect(params[0]).toBe('u1');
      expect(params[1]).toBe('2026-04-20');
      expect(params[2]).toBe(270);             // full-day rule (option A)
      expect(params[3]).toBe('att-1');         // attendance_record_id
      expect(params[4]).toBe(720);             // worked minutes
      expect(params[5]).toBe(270);             // daily_wage_snapshot
      expect(params[6]).toBe(720);             // target minutes
      expect(params[7]).toBe('admin');         // created_by
    });
  });

  // ── PR-1: pay-wage with overpayment classifier ─────────────────────
  describe('payWage', () => {
    const ADMIN = 'admin-uuid';
    const TARGET = 'target-uuid';
    const CASHBOX = 'cashbox-uuid';

    function mockGl(balance: number) {
      // Order of ds.query calls inside payWage:
      //   1. SELECT users WHERE id = $1 ... (active check)
      //   2. SELECT balance FROM v_employee_gl_balance ... (payable check)
      //   3. (advance branch only) SELECT id FROM expense_categories ...
      ds.query.mockImplementation((sql: string) => {
        if (typeof sql === 'string') {
          if (sql.includes('FROM users')) return [{ id: TARGET }];
          if (sql.includes('v_employee_gl_balance')) {
            return [{ balance }];
          }
          if (sql.includes('expense_categories')) {
            return [{ id: 'advance-cat-uuid' }];
          }
        }
        return [];
      });
    }

    it('rejects amount <= 0', async () => {
      await expect(
        service.payWage(TARGET, { amount: 0, cashbox_id: CASHBOX }, ADMIN),
      ).rejects.toThrow('المبلغ يجب أن يكون أكبر من صفر');
    });

    it('requires cashbox_id', async () => {
      await expect(
        service.payWage(TARGET, { amount: 100, cashbox_id: '' }, ADMIN),
      ).rejects.toThrow('cashbox_id مطلوب');
    });

    it('refuses to pay when employee not found / inactive', async () => {
      ds.query.mockResolvedValueOnce([]); // SELECT users → empty
      await expect(
        service.payWage(TARGET, { amount: 100, cashbox_id: CASHBOX }, ADMIN),
      ).rejects.toThrow('الموظف غير موجود');
    });

    it('amount <= payable: single settlement only — no excess flow', async () => {
      // payable = 270 (gl = -270 means company owes 270 to employee)
      mockGl(-270);
      empSvc.recordSettlement.mockResolvedValueOnce({ id: 'settle-1' });

      const r = await service.payWage(
        TARGET,
        { amount: 100, cashbox_id: CASHBOX },
        ADMIN,
      );

      expect(empSvc.recordSettlement).toHaveBeenCalledTimes(1);
      expect(empSvc.recordSettlement.mock.calls[0][1]).toMatchObject({
        amount: 100,
        method: 'cash',
        cashbox_id: CASHBOX,
      });
      expect(empSvc.addBonus).not.toHaveBeenCalled();
      expect(accountingSvc.createDailyExpense).not.toHaveBeenCalled();
      expect(r.payable_amount_settled).toBe(100);
      expect(r.excess_amount).toBe(0);
      expect(r.excess_handling).toBeNull();
      expect(r.settlement_ids).toEqual(['settle-1']);
    });

    it('amount = payable exactly: still one settlement, no excess flow', async () => {
      mockGl(-270);
      empSvc.recordSettlement.mockResolvedValueOnce({ id: 'settle-1' });

      const r = await service.payWage(
        TARGET,
        { amount: 270, cashbox_id: CASHBOX },
        ADMIN,
      );

      expect(empSvc.recordSettlement).toHaveBeenCalledTimes(1);
      expect(r.payable_amount_settled).toBe(270);
      expect(r.excess_amount).toBe(0);
    });

    it('amount > payable + no excess_handling: rejects with helpful message', async () => {
      mockGl(-100); // payable = 100
      await expect(
        service.payWage(
          TARGET,
          { amount: 150, cashbox_id: CASHBOX },
          ADMIN,
        ),
      ).rejects.toThrow(/تصنيف الزيادة/);
      expect(empSvc.recordSettlement).not.toHaveBeenCalled();
    });

    it('excess_handling supplied but no excess: rejects', async () => {
      mockGl(-200); // payable = 200
      await expect(
        service.payWage(
          TARGET,
          { amount: 100, cashbox_id: CASHBOX, excess_handling: 'advance' },
          ADMIN,
        ),
      ).rejects.toThrow('لا توجد زيادة');
    });

    it('excess as advance: settles payable + posts is_advance=TRUE expense', async () => {
      mockGl(-100); // payable = 100, amount = 270, excess = 170
      empSvc.recordSettlement.mockResolvedValueOnce({ id: 'settle-1' });
      accountingSvc.createDailyExpense.mockResolvedValueOnce({ id: 'exp-1' });

      const r = await service.payWage(
        TARGET,
        { amount: 270, cashbox_id: CASHBOX, excess_handling: 'advance' },
        ADMIN,
        ['*'],
      );

      // 1 settlement for payable
      expect(empSvc.recordSettlement).toHaveBeenCalledTimes(1);
      expect(empSvc.recordSettlement.mock.calls[0][1].amount).toBe(100);
      // 1 advance expense for the excess
      expect(accountingSvc.createDailyExpense).toHaveBeenCalledTimes(1);
      const expenseDto = accountingSvc.createDailyExpense.mock.calls[0][0];
      expect(expenseDto.amount).toBe(170);
      expect(expenseDto.is_advance).toBe(true);
      expect(expenseDto.employee_user_id).toBe(TARGET);
      expect(expenseDto.cashbox_id).toBe(CASHBOX);
      expect(expenseDto.category_id).toBe('advance-cat-uuid');
      // PR-EMP-ADVANCE-PAY-2 — without shift_id this internal call
      // must mark itself as `direct_cashbox` so accounting.service's
      // explicit-mode gate fires and `expenses.shift_id` stays NULL
      // (instead of the legacy auto-resolve re-attaching the excess
      // advance to whichever shift happens to share the cashbox).
      expect(expenseDto.source_type).toBe('direct_cashbox');
      expect(expenseDto.shift_id).toBeUndefined();
      expect(empSvc.addBonus).not.toHaveBeenCalled();

      expect(r.payable_amount_settled).toBe(100);
      expect(r.excess_amount).toBe(170);
      expect(r.excess_handling).toBe('advance');
      expect(r.advance_expense_id).toBe('exp-1');
      expect(r.bonus_id).toBeNull();
    });

    it('PR-EMP-ADVANCE-PAY-2: excess as advance WITH shift_id propagates source_type=open_shift', async () => {
      mockGl(-100);
      empSvc.recordSettlement.mockResolvedValueOnce({ id: 'settle-1' });
      accountingSvc.createDailyExpense.mockResolvedValueOnce({ id: 'exp-2' });

      const SHIFT = '77777777-7777-7777-7777-777777777777';
      await service.payWage(
        TARGET,
        {
          amount: 270,
          cashbox_id: CASHBOX,
          excess_handling: 'advance',
          shift_id: SHIFT,
        },
        ADMIN,
        ['*'],
      );

      const expenseDto = accountingSvc.createDailyExpense.mock.calls[0][0];
      expect(expenseDto.shift_id).toBe(SHIFT);
      // With shift_id present the internal call switches to
      // `open_shift` so the accounting service validates the shift
      // and links the advance to it (PR-15 contract preserved).
      expect(expenseDto.source_type).toBe('open_shift');
    });

    it('excess as bonus: settles payable + accrues bonus + settles bonus', async () => {
      mockGl(-100);
      empSvc.recordSettlement.mockResolvedValueOnce({ id: 'settle-payable' });
      empSvc.addBonus.mockResolvedValueOnce({ id: 99 });
      empSvc.recordSettlement.mockResolvedValueOnce({ id: 'settle-bonus' });

      const r = await service.payWage(
        TARGET,
        { amount: 270, cashbox_id: CASHBOX, excess_handling: 'bonus' },
        ADMIN,
      );

      // 1 settlement for payable + 1 bonus accrual + 1 settlement for bonus
      expect(empSvc.recordSettlement).toHaveBeenCalledTimes(2);
      expect(empSvc.addBonus).toHaveBeenCalledTimes(1);
      expect(empSvc.addBonus.mock.calls[0][1]).toMatchObject({
        amount: 170,
        kind: 'bonus',
      });
      expect(accountingSvc.createDailyExpense).not.toHaveBeenCalled();

      // The two settlements should sum to 270 (the cashbox total).
      const sum =
        empSvc.recordSettlement.mock.calls[0][1].amount +
        empSvc.recordSettlement.mock.calls[1][1].amount;
      expect(sum).toBe(270);

      expect(r.payable_amount_settled).toBe(100);
      expect(r.excess_amount).toBe(170);
      expect(r.excess_handling).toBe('bonus');
      expect(r.bonus_id).toBe(99);
      expect(r.settlement_ids).toEqual(['settle-payable', 'settle-bonus']);
    });

    it('payable=0, amount>0, advance: skips payable settlement, posts advance only', async () => {
      mockGl(0); // payable = 0
      accountingSvc.createDailyExpense.mockResolvedValueOnce({ id: 'exp-1' });

      const r = await service.payWage(
        TARGET,
        { amount: 100, cashbox_id: CASHBOX, excess_handling: 'advance' },
        ADMIN,
        ['*'],
      );

      expect(empSvc.recordSettlement).not.toHaveBeenCalled();
      expect(accountingSvc.createDailyExpense).toHaveBeenCalledTimes(1);
      expect(r.payable_amount_settled).toBe(0);
      expect(r.excess_amount).toBe(100);
    });

    it('advance branch errors when shared category is missing', async () => {
      // override: empty expense_categories result
      ds.query.mockImplementation((sql: string) => {
        if (typeof sql === 'string') {
          if (sql.includes('FROM users')) return [{ id: TARGET }];
          if (sql.includes('v_employee_gl_balance')) return [{ balance: 0 }];
          if (sql.includes('expense_categories')) return [];
        }
        return [];
      });

      await expect(
        service.payWage(
          TARGET,
          { amount: 100, cashbox_id: CASHBOX, excess_handling: 'advance' },
          ADMIN,
        ),
      ).rejects.toThrow(/employee_advance|الترحيل 086/);
    });
  });

  // ── Test D/F hygiene: void requires reason ────────────────────────
  describe('adminVoidWageAccrual', () => {
    it('requires a non-empty reason', async () => {
      await expect(
        service.adminVoidWageAccrual('pd-1', '', 'admin'),
      ).rejects.toThrow('السبب مطلوب');
    });

    it('calls fn_void_employee_wage_accrual with the trimmed reason', async () => {
      ds.query.mockResolvedValueOnce([{ id: 'pd-1' }]);
      const res = await service.adminVoidWageAccrual(
        'pd-1',
        '  خطأ إدخال  ',
        'admin',
      );
      expect(res).toEqual({ payable_day_id: 'pd-1' });
      const [sql, params] = ds.query.mock.calls[0];
      expect(sql).toContain('fn_void_employee_wage_accrual');
      expect(params).toEqual(['pd-1', 'خطأ إدخال', 'admin']);
    });
  });

  // ── PR-3: wage approval override metadata ─────────────────────────
  describe('adminMarkPayableDay — PR-3 override metadata', () => {
    it('default override (no params): override_type=full_day, calculated=daily, approved=daily', async () => {
      ds.query
        .mockResolvedValueOnce([
          { id: 'u1', salary_amount: 270, salary_frequency: 'daily', target_hours_day: 12 },
        ])
        .mockResolvedValueOnce([{ payable_day_id: 'pd-1' }]);

      await service.adminMarkPayableDay('u1', '2026-04-20', 'سبب', 'admin');
      const [, params] = ds.query.mock.calls[1];
      expect(params[2]).toBe(270);     // approved
      expect(params[3]).toBe(270);     // daily snapshot
      expect(params[7]).toBe(270);     // calculated (= daily by default)
      expect(params[8]).toBe('full_day'); // override_type
      expect(params[9]).toBeNull();    // approval_reason (null for default)
      expect(params[10]).toBe('admin'); // approved_by
    });

    it('custom_amount differs from calculated → requires approval_reason', async () => {
      ds.query.mockResolvedValueOnce([
        { id: 'u1', salary_amount: 270, target_hours_day: 12 },
      ]);
      await expect(
        service.adminMarkPayableDay('u1', '2026-04-20', 'سبب', 'admin', {
          override_type: 'custom_amount',
          approved_amount: 100, // differs from calculated=270
          // approval_reason missing
        }),
      ).rejects.toThrow('سبب الاعتماد مطلوب');
    });

    it('custom_amount with reason posts the approved amount, not the daily', async () => {
      ds.query
        .mockResolvedValueOnce([
          { id: 'u1', salary_amount: 270, target_hours_day: 12 },
        ])
        .mockResolvedValueOnce([{ payable_day_id: 'pd-2' }]);

      await service.adminMarkPayableDay('u1', '2026-04-20', 'سبب', 'admin', {
        override_type: 'custom_amount',
        approved_amount: 100,
        approval_reason: 'يومية مخفضة',
      });
      const [, params] = ds.query.mock.calls[1];
      expect(params[2]).toBe(100);     // approved (the GL amount)
      expect(params[7]).toBe(270);     // calculated still = daily
      expect(params[8]).toBe('custom_amount');
      expect(params[9]).toBe('يومية مخفضة');
    });

    it('rejects approved_amount <= 0', async () => {
      ds.query.mockResolvedValueOnce([
        { id: 'u1', salary_amount: 270, target_hours_day: 12 },
      ]);
      await expect(
        service.adminMarkPayableDay('u1', '2026-04-20', 'سبب', 'admin', {
          override_type: 'custom_amount',
          approved_amount: 0,
        }),
      ).rejects.toThrow('المبلغ المعتمد يجب أن يكون أكبر من صفر');
    });
  });

  describe('adminApproveWageFromAttendance — PR-3 hours-based calculated', () => {
    it('calculated mode posts daily × min(worked/target, 1)', async () => {
      // 6h worked, 12h target → calc = 270 × 0.5 = 135
      ds.query
        .mockResolvedValueOnce([
          {
            id: 'att-1',
            user_id: 'u1',
            work_date: '2026-04-20',
            clock_out: '2026-04-20T18:00:00Z',
            duration_min: 360,
            salary_amount: 270,
            target_hours_day: 12,
          },
        ])
        .mockResolvedValueOnce([{ payable_day_id: 'pd-3' }]);

      await service.adminApproveWageFromAttendance('att-1', 'admin', {
        override_type: 'calculated',
      });
      const [, params] = ds.query.mock.calls[1];
      expect(params[2]).toBe(135);     // approved = calculated
      expect(params[8]).toBe(135);     // calculated = 270 × 0.5
      expect(params[9]).toBe('calculated');
    });

    it('overtime is capped at full daily wage in calculated mode', async () => {
      // 18h worked, 12h target → calc capped at 270 (not 405)
      ds.query
        .mockResolvedValueOnce([
          {
            id: 'att-1',
            user_id: 'u1',
            work_date: '2026-04-20',
            clock_out: 'x',
            duration_min: 1080,
            salary_amount: 270,
            target_hours_day: 12,
          },
        ])
        .mockResolvedValueOnce([{ payable_day_id: 'pd-4' }]);

      await service.adminApproveWageFromAttendance('att-1', 'admin', {
        override_type: 'calculated',
      });
      const [, params] = ds.query.mock.calls[1];
      expect(params[8]).toBe(270);     // capped at daily
    });
  });
});
