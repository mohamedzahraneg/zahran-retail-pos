import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { EmployeesService } from '../employees/employees.service';
import { AccountingService } from '../accounting/accounting.service';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const UAParser = require('ua-parser-js');

export interface ClockCtx {
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * Parse a User-Agent string into a small structured device record — used to
 * enrich check-in / check-out rows with browser, OS, and device type info.
 */
function deviceFromUA(ua: string | null | undefined) {
  if (!ua) return null;
  const p = UAParser(ua);
  return {
    browser: p.browser?.name
      ? `${p.browser.name}${p.browser.version ? ' ' + p.browser.version : ''}`
      : null,
    os: p.os?.name
      ? `${p.os.name}${p.os.version ? ' ' + p.os.version : ''}`
      : null,
    device_type: p.device?.type || 'desktop',
    device_model:
      [p.device?.vendor, p.device?.model].filter(Boolean).join(' ') || null,
  };
}

@Injectable()
export class AttendanceService {
  constructor(
    private readonly ds: DataSource,
    private readonly empSvc: EmployeesService,
    private readonly accountingSvc: AccountingService,
  ) {}

  async clockIn(userId: string, ctx: ClockCtx = {}, note?: string) {
    const today = new Date().toISOString().slice(0, 10);
    const existing = await this.ds.query(
      `SELECT id, clock_in, clock_out FROM attendance_records
        WHERE user_id = $1 AND work_date = $2`,
      [userId, today],
    );
    if (existing[0]?.clock_in && !existing[0]?.clock_out) {
      throw new BadRequestException('سجّلت حضورك بالفعل اليوم');
    }
    const device = deviceFromUA(ctx.userAgent);
    const deviceJson = device ? JSON.stringify(device) : null;
    if (existing[0] && existing[0].clock_out) {
      // Re-opening the same day — clear clock_out and reset clock_in
      const [row] = await this.ds.query(
        `UPDATE attendance_records
            SET clock_in = now(), clock_out = NULL,
                ip_in = NULLIF($2,'')::inet, device_in = $3::jsonb,
                ip_out = NULL, device_out = NULL,
                note = COALESCE($4::text, note)
          WHERE id = $1
          RETURNING *`,
        [existing[0].id, ctx.ip || '', deviceJson, note || null],
      );
      return row;
    }
    const [row] = await this.ds.query(
      `INSERT INTO attendance_records
         (user_id, work_date, clock_in, ip_in, device_in, note)
       VALUES ($1, $2, now(), NULLIF($3,'')::inet, $4::jsonb, $5::text)
       RETURNING *`,
      [userId, today, ctx.ip || '', deviceJson, note || null],
    );
    return row;
  }

  async clockOut(userId: string, ctx: ClockCtx = {}, note?: string) {
    const today = new Date().toISOString().slice(0, 10);
    const [row] = await this.ds.query(
      `SELECT id, clock_in, clock_out FROM attendance_records
        WHERE user_id = $1 AND work_date = $2`,
      [userId, today],
    );
    if (!row) throw new BadRequestException('لم تسجّل حضورك اليوم');
    if (row.clock_out) throw new BadRequestException('سجّلت انصرافك بالفعل');
    const device = deviceFromUA(ctx.userAgent);
    const deviceJson = device ? JSON.stringify(device) : null;
    const [updated] = await this.ds.query(
      `UPDATE attendance_records
          SET clock_out = now(),
              ip_out = NULLIF($2,'')::inet, device_out = $3::jsonb,
              note = CASE WHEN $4::text IS NOT NULL THEN COALESCE(note || E'\n', '') || $4::text ELSE note END
        WHERE id = $1
        RETURNING *`,
      [row.id, ctx.ip || '', deviceJson, note || null],
    );
    return updated;
  }

  async myToday(userId: string) {
    const today = new Date().toISOString().slice(0, 10);
    const [row] = await this.ds.query(
      `SELECT * FROM attendance_records WHERE user_id = $1 AND work_date = $2`,
      [userId, today],
    );
    return row || null;
  }

  async list(params: {
    user_id?: string;
    from?: string;
    to?: string;
    limit?: number;
  }) {
    const where: string[] = ['1=1'];
    const args: any[] = [];
    if (params.user_id) {
      args.push(params.user_id);
      where.push(`a.user_id = $${args.length}`);
    }
    if (params.from) {
      args.push(params.from);
      where.push(`a.work_date >= $${args.length}::date`);
    }
    if (params.to) {
      args.push(params.to);
      where.push(`a.work_date <= $${args.length}::date`);
    }
    const limit = Math.min(Math.max(Number(params.limit) || 200, 1), 1000);
    return this.ds.query(
      `SELECT a.*, u.username, u.full_name, u.role_id, r.name_ar AS role_name
         FROM attendance_records a
         LEFT JOIN users u ON u.id = a.user_id
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE ${where.join(' AND ')}
        ORDER BY a.work_date DESC, a.clock_in DESC
        LIMIT ${limit}`,
      args,
    );
  }

  /** Per-user totals over the selected period. */
  async summary(params: { from?: string; to?: string }) {
    const where: string[] = ['1=1'];
    const args: any[] = [];
    if (params.from) {
      args.push(params.from);
      where.push(`a.work_date >= $${args.length}::date`);
    }
    if (params.to) {
      args.push(params.to);
      where.push(`a.work_date <= $${args.length}::date`);
    }
    return this.ds.query(
      `SELECT u.id AS user_id, u.username, u.full_name,
              COUNT(a.id)::int AS days_present,
              COALESCE(SUM(a.duration_min), 0)::int AS total_minutes,
              MIN(a.clock_in) AS first_in,
              MAX(a.clock_out) AS last_out
         FROM users u
         LEFT JOIN attendance_records a
                ON a.user_id = u.id AND ${where.join(' AND ').replace(/a\./g, 'a.')}
        WHERE u.is_active = true
        GROUP BY u.id, u.username, u.full_name
        ORDER BY total_minutes DESC NULLS LAST`,
      args,
    );
  }

  async adjust(
    id: string,
    dto: { clock_in?: string; clock_out?: string; note?: string },
  ) {
    const [row] = await this.ds.query(
      `SELECT id FROM attendance_records WHERE id = $1`,
      [id],
    );
    if (!row) throw new NotFoundException('السجل غير موجود');
    const [updated] = await this.ds.query(
      `UPDATE attendance_records
          SET clock_in  = COALESCE($2::timestamptz, clock_in),
              clock_out = COALESCE($3::timestamptz, clock_out),
              note      = COALESCE($4::text, note)
        WHERE id = $1
        RETURNING *`,
      [id, dto.clock_in || null, dto.clock_out || null, dto.note || null],
    );
    return updated;
  }

  // ── Admin attendance + wage accrual (employee.attendance.manage) ──────
  //
  // These endpoints let an authorized user (admin / HR) record attendance
  // on behalf of an employee, mark a payable day without attendance, or
  // approve / void the wage accrual for any given day. They never move
  // cashbox — that's employee_settlements territory.

  async adminClockIn(targetUserId: string, adminId: string, note?: string) {
    const [target] = await this.ds.query(
      `SELECT id FROM users WHERE id = $1 AND is_active = TRUE`,
      [targetUserId],
    );
    if (!target) throw new NotFoundException('الموظف غير موجود');
    const today = new Date().toISOString().slice(0, 10);
    const [existing] = await this.ds.query(
      `SELECT id, clock_in, clock_out FROM attendance_records
        WHERE user_id = $1 AND work_date = $2`,
      [targetUserId, today],
    );
    if (existing?.clock_in && !existing?.clock_out) {
      throw new BadRequestException('الموظف مسجّل حضور بالفعل اليوم');
    }
    const adminNote = `[admin:${adminId}]${note ? ' ' + note : ''}`;
    if (existing && existing.clock_out) {
      const [row] = await this.ds.query(
        `UPDATE attendance_records
            SET clock_in = now(), clock_out = NULL,
                ip_in = NULL, device_in = NULL,
                ip_out = NULL, device_out = NULL,
                note = COALESCE($2::text, note)
          WHERE id = $1
          RETURNING *`,
        [existing.id, adminNote],
      );
      return row;
    }
    const [row] = await this.ds.query(
      `INSERT INTO attendance_records
         (user_id, work_date, clock_in, note)
       VALUES ($1, $2, now(), $3::text)
       RETURNING *`,
      [targetUserId, today, adminNote],
    );
    return row;
  }

  async adminClockOut(targetUserId: string, adminId: string, note?: string) {
    const today = new Date().toISOString().slice(0, 10);
    const [row] = await this.ds.query(
      `SELECT id, clock_in, clock_out FROM attendance_records
        WHERE user_id = $1 AND work_date = $2`,
      [targetUserId, today],
    );
    if (!row) throw new BadRequestException('لا يوجد سجل حضور اليوم');
    if (row.clock_out) throw new BadRequestException('مسجّل انصراف بالفعل');
    const adminNote = `[admin:${adminId}]${note ? ' ' + note : ''}`;
    const [updated] = await this.ds.query(
      `UPDATE attendance_records
          SET clock_out = now(),
              note = CASE WHEN $2::text IS NOT NULL
                          THEN COALESCE(note || E'\n', '') || $2::text
                          ELSE note END
        WHERE id = $1
        RETURNING *`,
      [row.id, adminNote],
    );
    return updated;
  }

  /**
   * Mark a work_date as payable for an employee without requiring
   * attendance rows. Reason is mandatory. Creates (or reuses) the
   * wage_accrual row and posts DR 521 / CR 213 exactly once.
   *
   * PR-3: optional override params. When omitted, behaviour is exactly
   * what it was before (full-day rule). When supplied, recorded on
   * employee_payable_days.calculated_amount / override_type /
   * approval_reason / approved_by + posted GL amount = approved.
   */
  async adminMarkPayableDay(
    targetUserId: string,
    workDate: string,
    reason: string,
    adminId: string,
    override?: {
      calculated_amount?: number;
      override_type?: 'calculated' | 'full_day' | 'custom_amount';
      approved_amount?: number;
      approval_reason?: string;
    },
  ) {
    if (!reason || !reason.trim()) {
      throw new BadRequestException('السبب مطلوب');
    }
    const [profile] = await this.ds.query(
      `SELECT u.id, u.salary_amount, u.salary_frequency, u.target_hours_day
         FROM users u
        WHERE u.id = $1 AND u.is_active = TRUE`,
      [targetUserId],
    );
    if (!profile) throw new NotFoundException('الموظف غير موجود');
    const daily = Number(profile.salary_amount || 0);
    if (daily <= 0) {
      throw new BadRequestException('لم يُحدَّد راتب يومي للموظف');
    }
    const targetMinutes = profile.target_hours_day
      ? Math.round(Number(profile.target_hours_day) * 60)
      : null;

    // Without attendance there's no hours-based "calculated" — admin
    // is asserting a payable day, so calculated defaults to the full
    // daily wage. Override-type defaults to 'full_day' (today's
    // canonical behaviour).
    const calculated = Number(override?.calculated_amount ?? daily);
    const overrideType = override?.override_type ?? 'full_day';
    const approved = Number(
      override?.approved_amount ??
        (overrideType === 'calculated' ? calculated : daily),
    );
    if (!(approved > 0)) {
      throw new BadRequestException('المبلغ المعتمد يجب أن يكون أكبر من صفر');
    }
    if (
      overrideType === 'custom_amount' &&
      Math.abs(approved - calculated) > 0.005 &&
      !override?.approval_reason?.trim()
    ) {
      throw new BadRequestException(
        'سبب الاعتماد مطلوب عند إدخال مبلغ مخصص يختلف عن المبلغ المحسوب',
      );
    }

    const [row] = await this.ds.query(
      `SELECT fn_post_employee_wage_accrual(
         $1::uuid, $2::date, $3::numeric,
         'admin_manual'::text, NULL::uuid, NULL::int,
         $4::numeric, $5::int, $6::text, $7::uuid,
         $8::numeric, $9::text, $10::text, $11::uuid
       ) AS payable_day_id`,
      [
        targetUserId,
        workDate,
        approved,
        daily,
        targetMinutes,
        reason.trim(),
        adminId,
        calculated,
        overrideType,
        override?.approval_reason?.trim() || null,
        adminId,
      ],
    );
    return { payable_day_id: row.payable_day_id };
  }

  /**
   * Approve wage accrual from an existing attendance record. Idempotent
   * — calling twice for the same (user, work_date) returns the first
   * payable_day_id.
   *
   * PR-3: optional override params. When omitted, behaviour is exactly
   * what it was before (full-day rule, today's canonical Option A).
   * When supplied, calculated_amount = daily_wage × min(worked/target,
   * 1) — capped at daily_wage. approved_amount can be calculated /
   * full / custom; the JE posts the approved amount.
   */
  async adminApproveWageFromAttendance(
    attendanceId: string,
    adminId: string,
    override?: {
      override_type?: 'calculated' | 'full_day' | 'custom_amount';
      approved_amount?: number;
      approval_reason?: string;
    },
  ) {
    const [att] = await this.ds.query(
      `SELECT a.id, a.user_id, a.work_date, a.clock_out, a.duration_min,
              u.salary_amount, u.target_hours_day
         FROM attendance_records a
         JOIN users u ON u.id = a.user_id
        WHERE a.id = $1`,
      [attendanceId],
    );
    if (!att) throw new NotFoundException('سجل الحضور غير موجود');
    if (!att.clock_out) {
      throw new BadRequestException('لا يمكن تثبيت يومية قبل تسجيل الانصراف');
    }
    const daily = Number(att.salary_amount || 0);
    if (daily <= 0) {
      throw new BadRequestException('لم يُحدَّد راتب يومي للموظف');
    }
    const targetMinutes = att.target_hours_day
      ? Math.round(Number(att.target_hours_day) * 60)
      : null;
    const workedMinutes = att.duration_min ? Number(att.duration_min) : 0;

    // Hours-based calculated amount, capped at full daily wage.
    const calculated =
      targetMinutes && targetMinutes > 0
        ? Math.round(daily * Math.min(workedMinutes / targetMinutes, 1) * 100) / 100
        : daily;

    const overrideType = override?.override_type ?? 'full_day';
    const approved = Number(
      override?.approved_amount ??
        (overrideType === 'calculated' ? calculated : daily),
    );
    if (!(approved > 0)) {
      throw new BadRequestException('المبلغ المعتمد يجب أن يكون أكبر من صفر');
    }
    if (
      overrideType === 'custom_amount' &&
      Math.abs(approved - calculated) > 0.005 &&
      !override?.approval_reason?.trim()
    ) {
      throw new BadRequestException(
        'سبب الاعتماد مطلوب عند إدخال مبلغ مخصص يختلف عن المبلغ المحسوب',
      );
    }

    const [row] = await this.ds.query(
      `SELECT fn_post_employee_wage_accrual(
         $1::uuid, $2::date, $3::numeric,
         'attendance'::text, $4::uuid, $5::int,
         $6::numeric, $7::int, NULL::text, $8::uuid,
         $9::numeric, $10::text, $11::text, $12::uuid
       ) AS payable_day_id`,
      [
        att.user_id,
        att.work_date,
        approved,
        att.id,
        att.duration_min || null,
        daily,
        targetMinutes,
        adminId,
        calculated,
        overrideType,
        override?.approval_reason?.trim() || null,
        adminId,
      ],
    );
    return { payable_day_id: row.payable_day_id };
  }

  /**
   * Approve a wage override that adjusts an existing accrual. Uses the
   * void+repost pattern (PR #89's `fn_void_employee_wage_accrual` +
   * `fn_post_employee_wage_accrual`) so the audit trail captures both
   * the original and the corrected accrual as distinct rows.
   *
   * Use cases:
   *   * Existing accrual is full_day but admin wants to switch to
   *     hours-based calculated amount.
   *   * Existing accrual is calculated but admin wants to bump up to
   *     full_day for an approved exception.
   *   * Admin enters a custom amount that differs from both.
   *
   * If no live accrual exists for the (user, date), falls through to
   * `adminMarkPayableDay` (admin_manual source).
   */
  async adminApproveWageOverride(
    targetUserId: string,
    workDate: string,
    body: {
      override_type: 'calculated' | 'full_day' | 'custom_amount';
      approved_amount?: number;
      approval_reason?: string;
      reason?: string; // for the new admin_manual row when no existing accrual
    },
    adminId: string,
  ) {
    if (
      !body?.override_type ||
      !['calculated', 'full_day', 'custom_amount'].includes(body.override_type)
    ) {
      throw new BadRequestException(
        'override_type يجب أن يكون calculated أو full_day أو custom_amount',
      );
    }

    return this.ds.transaction(async (em) => {
      const [existing] = await em.query(
        `SELECT id, attendance_record_id, source
           FROM employee_payable_days
          WHERE user_id = $1 AND work_date = $2::date
            AND kind = 'wage_accrual' AND NOT is_void
          LIMIT 1`,
        [targetUserId, workDate],
      );

      // Void existing accrual (if any) so the partial UNIQUE index
      // permits the new posting. Reason captured for audit.
      if (existing) {
        const voidReason = `تعديل الاعتماد إلى ${body.override_type}${body.approval_reason ? ` — ${body.approval_reason.trim()}` : ''}`;
        await em.query(
          `SELECT fn_void_employee_wage_accrual($1::uuid, $2::text, $3::uuid)`,
          [existing.id, voidReason, adminId],
        );
      }

      // Post the new accrual. Route through the right service method
      // based on whether there's an attendance record to link.
      if (existing?.attendance_record_id) {
        return this.adminApproveWageFromAttendance(
          existing.attendance_record_id,
          adminId,
          {
            override_type: body.override_type,
            approved_amount: body.approved_amount,
            approval_reason: body.approval_reason,
          },
        );
      }
      // No attendance link → admin_manual path. Reason for the row is
      // either the supplied `reason` or "تعديل اعتماد سابق".
      return this.adminMarkPayableDay(
        targetUserId,
        workDate,
        body.reason?.trim() ||
          (existing ? 'تعديل اعتماد سابق' : 'اعتماد يدوي للأدمن'),
        adminId,
        {
          override_type: body.override_type,
          approved_amount: body.approved_amount,
          approval_reason: body.approval_reason,
        },
      );
    });
  }

  async adminVoidWageAccrual(
    payableDayId: string,
    reason: string,
    adminId: string,
  ) {
    if (!reason || !reason.trim()) {
      throw new BadRequestException('السبب مطلوب');
    }
    const [row] = await this.ds.query(
      `SELECT fn_void_employee_wage_accrual($1::uuid, $2::text, $3::uuid) AS id`,
      [payableDayId, reason.trim(), adminId],
    );
    return { payable_day_id: row.id };
  }

  /**
   * Compute the employee's live payable balance (what the company
   * currently owes them on 213 / 1123). Positive = company owes
   * employee; 0 = no payable or employee owes company.
   */
  private async payableBalance(userId: string): Promise<number> {
    const [row] = await this.ds.query(
      `SELECT balance::numeric(14,2) AS balance
         FROM v_employee_gl_balance
        WHERE employee_user_id = $1`,
      [userId],
    );
    const gl = Number(row?.balance || 0);
    // v_employee_gl_balance: positive = employee owes; negative = company owes.
    // Payable to employee = max(0, -gl).
    return Math.max(0, -gl);
  }

  /**
   * Daily-wage payout. Single canonical entry point for all cash that
   * leaves the cashbox toward an employee.
   *
   * Splits:
   *   amount <= payable  → single settlement (DR 213 / CR cashbox)
   *   amount >  payable  → settlement for the payable portion, then
   *                        the excess classified explicitly:
   *                          'advance' → DR 1123 / CR cashbox (via the
   *                                      canonical daily-expense path
   *                                      with is_advance=TRUE)
   *                          'bonus'   → DR 521 / CR 213 (accrual),
   *                                      then DR 213 / CR cashbox
   *                                      (settlement of the bonus)
   *
   * No silent fallback: if amount > payable and excess_handling is
   * missing, the whole call rejects with 400.
   *
   * Cashbox moves exactly `amount` across the call (sum of all cashbox
   * transactions). Trial balance stays 0 (every leg is balanced).
   */
  async payWage(
    targetUserId: string,
    body: {
      amount: number;
      cashbox_id: string;
      excess_handling?: 'advance' | 'bonus';
      notes?: string;
      /** PR-15 — explicit shift linkage. When supplied, both the
       *  settlement leg and the advance/bonus excess leg propagate
       *  the same shift_id so the whole transaction shows up
       *  consistently in the source shift's closing. */
      shift_id?: string;
    },
    adminId: string,
    adminPermissions: string[] = [],
  ) {
    const amount = Number(body?.amount || 0);
    if (!(amount > 0)) {
      throw new BadRequestException('المبلغ يجب أن يكون أكبر من صفر');
    }
    if (!body?.cashbox_id) {
      throw new BadRequestException('cashbox_id مطلوب لصرف اليومية نقدًا');
    }
    const [target] = await this.ds.query(
      `SELECT id FROM users WHERE id = $1 AND is_active = TRUE`,
      [targetUserId],
    );
    if (!target) throw new NotFoundException('الموظف غير موجود');

    const payable = await this.payableBalance(targetUserId);
    const payablePart = Math.min(amount, payable);
    const excess = Math.max(0, amount - payable);
    // Round to 2dp so comparisons don't get bitten by fp drift.
    const r2 = (n: number) => Math.round(n * 100) / 100;

    if (r2(excess) > 0 && !body.excess_handling) {
      throw new BadRequestException(
        `المبلغ يتجاوز المتبقي المستحق بـ ${r2(excess).toFixed(2)} ج.م — ` +
          `يجب اختيار تصنيف الزيادة: advance أو bonus.`,
      );
    }
    if (body.excess_handling && r2(excess) <= 0) {
      throw new BadRequestException(
        'لا توجد زيادة لتصنيفها — المبلغ لا يتجاوز المتبقي المستحق.',
      );
    }

    const today = new Date().toISOString().slice(0, 10);
    const baseNote = (body.notes || '').trim();
    const result: {
      payable_before: number;
      payable_amount_settled: number;
      excess_amount: number;
      excess_handling: 'advance' | 'bonus' | null;
      settlement_ids: string[];
      bonus_id: number | null;
      advance_expense_id: string | null;
    } = {
      payable_before: r2(payable),
      payable_amount_settled: 0,
      excess_amount: r2(excess),
      excess_handling: body.excess_handling || null,
      settlement_ids: [],
      bonus_id: null,
      advance_expense_id: null,
    };

    // 1. Settle the payable portion (if any).
    if (r2(payablePart) > 0) {
      const settlement = await this.empSvc.recordSettlement(
        targetUserId,
        {
          amount: r2(payablePart),
          settlement_date: today,
          method: 'cash',
          cashbox_id: body.cashbox_id,
          notes: baseNote || 'صرف يومية — الجزء المستحق',
          shift_id: body.shift_id,
        },
        adminId,
      );
      result.payable_amount_settled = r2(payablePart);
      if ((settlement as any)?.id != null) {
        result.settlement_ids.push(String((settlement as any).id));
      }
    }

    // 2. Handle excess.
    if (r2(excess) > 0) {
      if (body.excess_handling === 'advance') {
        // Resolve the shared employee_advance category (migration 086).
        const [cat] = await this.ds.query(
          `SELECT id FROM expense_categories
            WHERE code = 'employee_advance' AND is_active = TRUE
            LIMIT 1`,
        );
        if (!cat?.id) {
          throw new BadRequestException(
            'فئة سلف الموظفين غير مُفعّلة — أعد تشغيل الترحيل 086 أو فعّل فئة employee_advance يدوياً.',
          );
        }
        // is_advance lives on CreateExpenseDto; CreateDailyExpenseDto
        // doesn't declare it but the service reads it through `(dto as any)`
        // (accounting.service.ts:152-154). Inject via spread + cast.
        const expense = await this.accountingSvc.createDailyExpense(
          {
            amount: r2(excess),
            category_id: cat.id,
            payment_method: 'cash',
            cashbox_id: body.cashbox_id,
            expense_date: today,
            description: baseNote || 'زيادة عن اليومية — سلفة للموظف',
            employee_user_id: targetUserId,
            is_advance: true,
            // PR-15 — propagate shift linkage to the advance leg too,
            // so an open-shift Pay Wage with excess routes the whole
            // amount (settlement + advance) to the same shift's
            // closing.
            shift_id: body.shift_id,
          } as any,
          adminId,
          adminPermissions,
        );
        result.advance_expense_id = (expense as any)?.id ?? null;
      } else if (body.excess_handling === 'bonus') {
        // Accrue bonus → DR 521 / CR 213 (no cashbox).
        const bonus = await this.empSvc.addBonus(
          targetUserId,
          {
            amount: r2(excess),
            kind: 'bonus',
            note: baseNote || 'زيادة عن اليومية — مكافأة',
            bonus_date: today,
          },
          adminId,
        );
        result.bonus_id = (bonus as any)?.id ?? null;

        // Pay the bonus → DR 213 / CR cashbox.
        const bonusSettlement = await this.empSvc.recordSettlement(
          targetUserId,
          {
            amount: r2(excess),
            settlement_date: today,
            method: 'cash',
            cashbox_id: body.cashbox_id,
            notes: baseNote || 'صرف المكافأة الزائدة',
            shift_id: body.shift_id,
          },
          adminId,
        );
        if ((bonusSettlement as any)?.id != null) {
          result.settlement_ids.push(String((bonusSettlement as any).id));
        }
      }
    }

    return result;
  }

  /** List payable-day rows for an employee in a date range. */
  async listPayableDays(params: {
    user_id: string;
    from?: string;
    to?: string;
  }) {
    const where: string[] = ['p.user_id = $1'];
    const args: any[] = [params.user_id];
    if (params.from) {
      args.push(params.from);
      where.push(`p.work_date >= $${args.length}::date`);
    }
    if (params.to) {
      args.push(params.to);
      where.push(`p.work_date <= $${args.length}::date`);
    }
    return this.ds.query(
      `SELECT p.*, je.entry_no, je.is_void AS je_is_void
         FROM employee_payable_days p
         LEFT JOIN journal_entries je ON je.id = p.journal_entry_id
        WHERE ${where.join(' AND ')}
        ORDER BY p.work_date DESC, p.created_at DESC`,
      args,
    );
  }
}
