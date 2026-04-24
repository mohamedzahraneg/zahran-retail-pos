import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { AttendanceService } from './attendance.service';

/**
 * Unit tests for the admin-on-behalf + wage-accrual surface added in
 * migrations 081–084. DataSource is mocked — we assert the SQL shape
 * and the validation behaviour, not the database itself.
 */
describe('AttendanceService — admin + wage accrual', () => {
  let service: AttendanceService;
  let ds: { query: jest.Mock };

  beforeEach(async () => {
    ds = { query: jest.fn() };
    const moduleRef = await Test.createTestingModule({
      providers: [
        AttendanceService,
        { provide: DataSource, useValue: ds },
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
});
