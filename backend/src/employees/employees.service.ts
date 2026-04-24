import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { DataSource } from 'typeorm';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

/**
 * Employee / HR module.
 *
 * Handles per-user dashboard payloads, attendance + salary aggregates,
 * advance / leave / overtime requests, bonuses, deductions, and task
 * assignments. Purely additive on top of existing tables — never
 * mutates anything outside the new employee_* tables + the new
 * user/HR columns from migration 040.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly ds: DataSource,
    @Optional() private readonly engine?: FinancialEngineService,
  ) {}

  // ── helpers ──────────────────────────────────────────────────────────
  private async getProfile(userId: string) {
    const [row] = await this.ds.query(
      `SELECT u.id, u.username, u.full_name, u.employee_no, u.job_title,
              u.hire_date, u.salary_amount, u.salary_frequency,
              u.target_hours_day, u.target_hours_week, u.overtime_rate,
              u.shift_start_time, u.shift_end_time, u.late_grace_min,
              r.name_ar AS role_name, r.code AS role_code
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
        WHERE u.id = $1`,
      [userId],
    );
    if (!row) throw new NotFoundException('المستخدم غير موجود');
    return row;
  }

  /** Period bounds in Cairo time. `period` defaults to current month. */
  private periodBounds(period: 'day' | 'week' | 'month', now = new Date()) {
    const parts = (tz = 'Africa/Cairo') =>
      new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(now);
    const p = parts();
    const y = p.find((x) => x.type === 'year')!.value;
    const m = p.find((x) => x.type === 'month')!.value;
    const d = p.find((x) => x.type === 'day')!.value;
    const today = `${y}-${m}-${d}`;

    if (period === 'day') return { from: today, to: today };
    if (period === 'month') return { from: `${y}-${m}-01`, to: today };
    // week → last 7 days (Sat-start is good enough for MVP; detailed
    // week rollover can land later)
    const dNow = new Date(now);
    dNow.setDate(dNow.getDate() - 6);
    const wParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(dNow);
    const wFrom =
      wParts.find((x) => x.type === 'year')!.value +
      '-' +
      wParts.find((x) => x.type === 'month')!.value +
      '-' +
      wParts.find((x) => x.type === 'day')!.value;
    return { from: wFrom, to: today };
  }

  /**
   * Personal dashboard payload — everything the employee sees on the
   * home page.
   */
  async myDashboard(userId: string) {
    const profile = await this.getProfile(userId);
    const { from: mFrom, to: mTo } = this.periodBounds('month');
    const { from: wFrom, to: wTo } = this.periodBounds('week');

    // Today's attendance row
    const [todayAtt] = await this.ds.query(
      `SELECT * FROM attendance_records
        WHERE user_id = $1
          AND work_date = (now() AT TIME ZONE 'Africa/Cairo')::date`,
      [userId],
    );

    // Aggregated minutes this week/month
    const [weekAgg] = await this.ds.query(
      `SELECT COALESCE(SUM(duration_min),0)::int AS minutes,
              COUNT(*)::int AS days
         FROM attendance_records
        WHERE user_id = $1 AND work_date BETWEEN $2::date AND $3::date
          AND clock_out IS NOT NULL`,
      [userId, wFrom, wTo],
    );
    const [monthAgg] = await this.ds.query(
      `SELECT COALESCE(SUM(duration_min),0)::int AS minutes,
              COUNT(*)::int AS days
         FROM attendance_records
        WHERE user_id = $1 AND work_date BETWEEN $2::date AND $3::date
          AND clock_out IS NOT NULL`,
      [userId, mFrom, mTo],
    );

    // Advances (from expenses tagged with this employee_user_id).
    const [adv] = await this.ds.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(14,2) AS amount,
              COUNT(*)::int AS count
         FROM expenses
        WHERE employee_user_id = $1 AND is_advance = true
          AND expense_date BETWEEN $2::date AND $3::date`,
      [userId, mFrom, mTo],
    );
    const [advLifetime] = await this.ds.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(14,2) AS amount
         FROM expenses
        WHERE employee_user_id = $1 AND is_advance = true`,
      [userId],
    );

    // Bonuses + deductions this month
    const [bonus] = await this.ds.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(14,2) AS amount,
              COUNT(*)::int AS count
         FROM employee_bonuses
        WHERE user_id = $1 AND bonus_date BETWEEN $2::date AND $3::date`,
      [userId, mFrom, mTo],
    );
    const [deduct] = await this.ds.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(14,2) AS amount,
              COUNT(*)::int AS count
         FROM employee_deductions
        WHERE user_id = $1 AND deduction_date BETWEEN $2::date AND $3::date`,
      [userId, mFrom, mTo],
    );

    // Open tasks + pending requests
    const tasks = await this.ds.query(
      `SELECT * FROM employee_tasks
        WHERE user_id = $1 AND status IN ('pending','acknowledged')
        ORDER BY CASE priority
                   WHEN 'urgent' THEN 1 WHEN 'high' THEN 2
                   WHEN 'normal' THEN 3 ELSE 4 END,
                 assigned_at DESC
        LIMIT 20`,
      [userId],
    );
    const requests = await this.ds.query(
      `SELECT * FROM employee_requests
        WHERE user_id = $1 AND status = 'pending'
        ORDER BY created_at DESC`,
      [userId],
    );

    // ─── salary math ────────────────────────────────────────────────
    const salaryAmount = Number(profile.salary_amount || 0);
    const freq = profile.salary_frequency || 'monthly';
    const targetDay = Number(profile.target_hours_day || 8);
    const targetWeek = Number(profile.target_hours_week || targetDay * 6);
    // Rough expected for the current period
    const expectedForPeriod =
      freq === 'daily'
        ? salaryAmount
        : freq === 'weekly'
          ? salaryAmount
          : salaryAmount;
    const accrualBase =
      freq === 'daily'
        ? salaryAmount * Number(monthAgg.days || 0)
        : freq === 'weekly'
          ? (salaryAmount / 7) * Number(monthAgg.days || 0)
          : (salaryAmount / 30) * Number(monthAgg.days || 0);

    // Net = (accrued salary) + bonuses - deductions - advances
    const net =
      accrualBase +
      Number(bonus.amount || 0) -
      Number(deduct.amount || 0) -
      Number(adv.amount || 0);
    const debtWarning = net < 0;
    const outstandingDebt = debtWarning ? Math.abs(net) : 0;

    // Canonical GL balance — read-only from v_employee_gl_balance.
    // This is the headline balance on the UI since PR #73 opened
    // account 32 for legacy opening-balance resets. Source-table
    // computation above (`net`) is kept as a breakdown.
    const [glRow] = await this.ds.query(
      `SELECT balance::numeric(14,2) AS balance
         FROM v_employee_gl_balance WHERE employee_user_id = $1`,
      [userId],
    );
    const glBalance = Number(glRow?.balance || 0);

    // ─── Timing warnings (late / early leave) ─────────────────────
    const warnings: Array<{ kind: string; message: string }> = [];
    const shiftStart = profile.shift_start_time as string | null;
    const shiftEnd = profile.shift_end_time as string | null;
    const graceMin = Number(profile.late_grace_min || 10);

    let lateMinutes = 0;
    let earlyLeaveMinutes = 0;
    let expectedEndUtc: string | null = null;

    if (todayAtt?.clock_in && shiftStart) {
      const [sh, sm] = (shiftStart as string).split(':').map(Number);
      const clockInCairo = new Date(todayAtt.clock_in);
      // Interpret clock-in timestamp in Cairo, compute expected minute
      const inHour = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Africa/Cairo',
          hour: '2-digit',
          hour12: false,
        }).format(clockInCairo),
      );
      const inMin = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Africa/Cairo',
          minute: '2-digit',
        }).format(clockInCairo),
      );
      lateMinutes = Math.max(0, inHour * 60 + inMin - (sh * 60 + sm) - graceMin);
      if (lateMinutes > 0) {
        warnings.push({
          kind: 'late_arrival',
          message: `تأخرت ${lateMinutes} دقيقة عن موعد الحضور الرسمي.`,
        });
      }
    }
    if (todayAtt?.clock_out && shiftEnd) {
      const [eh, em] = (shiftEnd as string).split(':').map(Number);
      const out = new Date(todayAtt.clock_out);
      const outHour = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Africa/Cairo',
          hour: '2-digit',
          hour12: false,
        }).format(out),
      );
      const outMin = Number(
        new Intl.DateTimeFormat('en-GB', {
          timeZone: 'Africa/Cairo',
          minute: '2-digit',
        }).format(out),
      );
      earlyLeaveMinutes = Math.max(0, eh * 60 + em - (outHour * 60 + outMin));
      if (earlyLeaveMinutes > 0) {
        warnings.push({
          kind: 'early_leave',
          message: `سجّلت انصراف قبل نهاية الوردية بـ ${earlyLeaveMinutes} دقيقة.`,
        });
      }
    }
    // Compute expected end for the live countdown on the client
    if (todayAtt?.clock_in && !todayAtt?.clock_out) {
      const inStamp = new Date(todayAtt.clock_in);
      expectedEndUtc = new Date(
        inStamp.getTime() + Number(profile.target_hours_day || 8) * 3600 * 1000,
      ).toISOString();
    }

    // ─── Smart recommendations ─────────────────────────────────────
    const recommendations: string[] = [];
    if (debtWarning) {
      recommendations.push(
        `مديونيتك الحالية ${outstandingDebt.toFixed(2)} ج.م — تجاوزت رصيد الراتب.`,
      );
      // Suggest how many extra hours at overtime rate would clear it.
      const rate =
        freq === 'daily'
          ? salaryAmount / Number(profile.target_hours_day || 8)
          : freq === 'weekly'
            ? salaryAmount / Number(profile.target_hours_week || 48)
            : salaryAmount /
              (Number(profile.target_hours_week || 48) * 4);
      const overtimeMultiplier = Number(profile.overtime_rate || 1.5);
      if (rate > 0 && overtimeMultiplier > 0) {
        const extraHours = Math.ceil(
          outstandingDebt / (rate * overtimeMultiplier),
        );
        recommendations.push(
          `${extraHours} ساعة إضافية بمعدل ×${overtimeMultiplier} كفيلة بتغطية المديونية.`,
        );
      }
      recommendations.push(
        'اطلب تمديد ساعات إضافية من الإدارة، أو قلّل السلف الشهر القادم.',
      );
    } else if (net > 0 && Number(bonus.amount || 0) === 0) {
      recommendations.push(
        'أنت على المسار الصحيح — اطلب ساعات إضافية لرفع الدخل هذا الشهر.',
      );
    }
    if (lateMinutes > 30) {
      recommendations.push(
        'التأخر المتكرر قد يُخصم من راتبك — حافظ على موعد الحضور.',
      );
    }

    return {
      profile,
      period: { month: { from: mFrom, to: mTo }, week: { from: wFrom, to: wTo } },
      attendance: {
        today: todayAtt || null,
        today_late_minutes: lateMinutes,
        today_early_leave_minutes: earlyLeaveMinutes,
        expected_end_utc: expectedEndUtc,
        week: {
          minutes: Number(weekAgg.minutes || 0),
          days: Number(weekAgg.days || 0),
          target_hours: targetWeek,
        },
        month: {
          minutes: Number(monthAgg.minutes || 0),
          days: Number(monthAgg.days || 0),
        },
      },
      salary: {
        amount: salaryAmount,
        frequency: freq,
        expected: expectedForPeriod,
        accrued: Math.round(accrualBase * 100) / 100,
        bonuses: Number(bonus.amount || 0),
        deductions: Number(deduct.amount || 0),
        advances_month: Number(adv.amount || 0),
        advances_lifetime: Number(advLifetime.amount || 0),
        // Source-derived net (accrued + bonuses − deductions − advances).
        // UI treats this as an operational breakdown, not the headline —
        // `gl_balance` below is the canonical employee GL balance.
        net: Math.round(net * 100) / 100,
        outstanding_debt: Math.round(outstandingDebt * 100) / 100,
        debt_warning: debtWarning,
        // Canonical from v_employee_gl_balance (COA 1123 + 213).
        // Positive = employee owes company; negative = company owes
        // employee. This is the headline the UI must display.
        gl_balance: Math.round(Number(glBalance) * 100) / 100,
      },
      tasks,
      requests,
      warnings,
      recommendations,
    };
  }

  // ── Tasks ───────────────────────────────────────────────────────────
  myTasks(userId: string) {
    return this.ds.query(
      `SELECT * FROM employee_tasks
        WHERE user_id = $1
        ORDER BY assigned_at DESC`,
      [userId],
    );
  }

  async acknowledgeTask(taskId: string, userId: string) {
    const [row] = await this.ds.query(
      `UPDATE employee_tasks
          SET acknowledged_at = NOW(),
              status          = CASE WHEN status = 'pending' THEN 'acknowledged' ELSE status END
        WHERE id = $1 AND user_id = $2
        RETURNING *`,
      [taskId, userId],
    );
    if (!row) throw new NotFoundException('المهمة غير موجودة');
    return row;
  }

  async completeTask(taskId: string, userId: string) {
    const [row] = await this.ds.query(
      `UPDATE employee_tasks
          SET completed_at = NOW(),
              status       = 'completed'
        WHERE id = $1 AND user_id = $2
          AND status <> 'cancelled'
        RETURNING *`,
      [taskId, userId],
    );
    if (!row) throw new NotFoundException('المهمة غير موجودة');
    return row;
  }

  async createTask(
    dto: {
      user_id: string;
      title: string;
      description?: string;
      priority?: 'low' | 'normal' | 'high' | 'urgent';
      due_at?: string;
    },
    assignedBy: string,
  ) {
    const [row] = await this.ds.query(
      `INSERT INTO employee_tasks
         (user_id, title, description, priority, due_at, assigned_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        dto.user_id,
        dto.title,
        dto.description || null,
        dto.priority || 'normal',
        dto.due_at || null,
        assignedBy,
      ],
    );
    return row;
  }

  async cancelTask(taskId: string) {
    const [row] = await this.ds.query(
      `UPDATE employee_tasks SET status = 'cancelled' WHERE id = $1 RETURNING *`,
      [taskId],
    );
    if (!row) throw new NotFoundException('المهمة غير موجودة');
    return row;
  }

  // ── Requests (advance / leave / overtime) ──────────────────────────
  myRequests(userId: string) {
    return this.ds.query(
      `SELECT * FROM employee_requests
        WHERE user_id = $1
        ORDER BY created_at DESC`,
      [userId],
    );
  }

  async submitRequest(
    userId: string,
    dto: {
      kind: 'advance' | 'leave' | 'overtime_extension' | 'other';
      amount?: number;
      starts_at?: string;
      ends_at?: string;
      reason?: string;
    },
  ) {
    if (dto.kind === 'advance' && (!dto.amount || dto.amount <= 0)) {
      throw new BadRequestException('يجب تحديد قيمة السلفة');
    }
    const [row] = await this.ds.query(
      `INSERT INTO employee_requests
         (user_id, kind, amount, starts_at, ends_at, reason)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        userId,
        dto.kind,
        dto.amount ?? null,
        dto.starts_at ?? null,
        dto.ends_at ?? null,
        dto.reason ?? null,
      ],
    );
    return row;
  }

  listPendingRequests() {
    return this.ds.query(
      `SELECT r.*,
              u.full_name AS user_name, u.username, u.employee_no
         FROM employee_requests r
         JOIN users u ON u.id = r.user_id
        WHERE r.status = 'pending'
        ORDER BY r.created_at DESC`,
    );
  }

  async decideRequest(
    id: string,
    decision: 'approved' | 'rejected',
    decidedBy: string,
    reason?: string,
  ) {
    if (decision === 'rejected' && !reason?.trim()) {
      throw new BadRequestException('يجب كتابة سبب الرفض');
    }
    const [row] = await this.ds.query(
      `UPDATE employee_requests
          SET status          = $2,
              decided_by      = $3,
              decided_at      = NOW(),
              decision_reason = $4
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [id, decision, decidedBy, reason || null],
    );
    if (!row) throw new NotFoundException('الطلب غير موجود أو مغلق');
    return row;
  }

  // ── Bonuses / deductions (admin) ───────────────────────────────────
  listBonuses(userId: string, from?: string, to?: string) {
    const where: string[] = ['b.user_id = $1'];
    const args: any[] = [userId];
    if (from) { args.push(from); where.push(`b.bonus_date >= $${args.length}::date`); }
    if (to)   { args.push(to);   where.push(`b.bonus_date <= $${args.length}::date`); }
    return this.ds.query(
      `SELECT b.*, u.full_name AS created_by_name
         FROM employee_bonuses b
         LEFT JOIN users u ON u.id = b.created_by
        WHERE ${where.join(' AND ')}
        ORDER BY b.bonus_date DESC`,
      args,
    );
  }

  async addBonus(
    userId: string,
    dto: { amount: number; kind?: string; note?: string; bonus_date?: string },
    createdBy: string,
  ) {
    if (!dto.amount || dto.amount <= 0) {
      throw new BadRequestException('قيمة الحافز يجب أن تكون أكبر من صفر');
    }
    const [row] = await this.ds.query(
      `INSERT INTO employee_bonuses
         (user_id, amount, kind, note, bonus_date, created_by)
       VALUES ($1,$2,$3,$4,COALESCE($5::date, CURRENT_DATE),$6)
       RETURNING *`,
      [
        userId,
        dto.amount,
        dto.kind || 'bonus',
        dto.note || null,
        dto.bonus_date || null,
        createdBy,
      ],
    );
    return row;
  }

  listDeductions(userId: string) {
    return this.ds.query(
      `SELECT * FROM employee_deductions WHERE user_id = $1
        ORDER BY deduction_date DESC`,
      [userId],
    );
  }

  async addDeduction(
    userId: string,
    dto: { amount: number; reason: string; deduction_date?: string },
    createdBy: string,
  ) {
    if (!dto.amount || dto.amount <= 0) {
      throw new BadRequestException('قيمة الخصم يجب أن تكون أكبر من صفر');
    }
    if (!dto.reason?.trim()) {
      throw new BadRequestException('يجب كتابة سبب الخصم');
    }
    const [row] = await this.ds.query(
      `INSERT INTO employee_deductions
         (user_id, amount, reason, deduction_date, created_by)
       VALUES ($1,$2,$3,COALESCE($4::date, CURRENT_DATE),$5)
       RETURNING *`,
      [userId, dto.amount, dto.reason, dto.deduction_date || null, createdBy],
    );
    return row;
  }

  // ── Admin — per-employee summary / profile management ──────────────
  async updateProfile(
    userId: string,
    dto: {
      employee_no?: string;
      job_title?: string;
      hire_date?: string;
      salary_amount?: number;
      salary_frequency?: 'daily' | 'weekly' | 'monthly';
      target_hours_day?: number;
      target_hours_week?: number;
      overtime_rate?: number;
      shift_start_time?: string;
      shift_end_time?: string;
      late_grace_min?: number;
    },
  ) {
    const [row] = await this.ds.query(
      `UPDATE users
          SET employee_no       = COALESCE($2, employee_no),
              job_title         = COALESCE($3, job_title),
              hire_date         = COALESCE($4::date, hire_date),
              salary_amount     = COALESCE($5, salary_amount),
              salary_frequency  = COALESCE($6, salary_frequency),
              target_hours_day  = COALESCE($7, target_hours_day),
              target_hours_week = COALESCE($8, target_hours_week),
              overtime_rate     = COALESCE($9, overtime_rate),
              shift_start_time  = COALESCE($10::time, shift_start_time),
              shift_end_time    = COALESCE($11::time, shift_end_time),
              late_grace_min    = COALESCE($12, late_grace_min)
        WHERE id = $1
        RETURNING id, employee_no, job_title, hire_date, salary_amount,
                  salary_frequency, target_hours_day, target_hours_week,
                  overtime_rate, shift_start_time, shift_end_time,
                  late_grace_min`,
      [
        userId,
        dto.employee_no ?? null,
        dto.job_title ?? null,
        dto.hire_date ?? null,
        dto.salary_amount ?? null,
        dto.salary_frequency ?? null,
        dto.target_hours_day ?? null,
        dto.target_hours_week ?? null,
        dto.overtime_rate ?? null,
        dto.shift_start_time ?? null,
        dto.shift_end_time ?? null,
        dto.late_grace_min ?? null,
      ],
    );
    if (!row) throw new NotFoundException('المستخدم غير موجود');
    return row;
  }

  /** Admin team overview — one row per active user with summary metrics. */
  async teamOverview() {
    // `gl_balance` is the canonical employee GL balance from
    // v_employee_gl_balance (COA 1123 + 213, migration 075). The UI
    // uses this as the headline — positive = employee owes company,
    // negative = company owes employee. The `_this_month` fields stay
    // as month-only operational details.
    return this.ds.query(
      `SELECT u.id, u.employee_no, u.full_name, u.username, u.job_title,
              u.salary_amount, u.salary_frequency,
              r.name_ar AS role_name,
              COALESCE((
                SELECT SUM(duration_min) FROM attendance_records a
                 WHERE a.user_id = u.id
                   AND a.work_date >= date_trunc('month', (now() AT TIME ZONE 'Africa/Cairo'))::date
                   AND a.clock_out IS NOT NULL
              ), 0)::int AS minutes_this_month,
              COALESCE((
                SELECT SUM(amount) FROM expenses e
                 WHERE e.employee_user_id = u.id AND e.is_advance = true
                   AND e.expense_date >= date_trunc('month', (now() AT TIME ZONE 'Africa/Cairo'))::date
              ), 0)::numeric(14,2) AS advances_this_month,
              COALESCE((
                SELECT SUM(amount) FROM employee_bonuses b
                 WHERE b.user_id = u.id
                   AND b.bonus_date >= date_trunc('month', (now() AT TIME ZONE 'Africa/Cairo'))::date
              ), 0)::numeric(14,2) AS bonuses_this_month,
              (SELECT COUNT(*) FROM employee_tasks t
                WHERE t.user_id = u.id AND t.status IN ('pending','acknowledged'))::int AS open_tasks,
              (SELECT COUNT(*) FROM employee_requests q
                WHERE q.user_id = u.id AND q.status = 'pending')::int AS pending_requests,
              COALESCE(gl.balance, 0)::numeric(14,2) AS gl_balance
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
         LEFT JOIN v_employee_gl_balance gl ON gl.employee_user_id = u.id
        WHERE u.is_active = true
        ORDER BY u.full_name`,
    );
  }

  /** Reject any attempt to touch another user's data from non-admin endpoints. */
  ensureSelfOrThrow(selfId: string, targetId: string) {
    if (selfId !== targetId) {
      throw new ForbiddenException('لا يمكنك الوصول إلى بيانات مستخدم آخر');
    }
  }

  /**
   * Per-day attendance + salary history for a user over an arbitrary
   * date range. Powers the "سجل الأيام" tab on the personal and admin
   * profiles. Returns one row per day with:
   *   - minutes worked & overtime minutes vs target
   *   - bonuses / deductions / advances for that day
   *   - late / early flags (based on target hours compared to actual)
   */
  async daysHistory(userId: string, fromISO: string, toISO: string) {
    const [profile] = await this.ds.query(
      `SELECT target_hours_day, target_hours_week, salary_amount,
              salary_frequency, overtime_rate
         FROM users WHERE id = $1`,
      [userId],
    );
    const targetDayHr = Number(profile?.target_hours_day || 8);
    const targetWeekHr = Number(profile?.target_hours_week || targetDayHr * 6);
    const targetDayMin = Math.round(targetDayHr * 60);
    const salary = Number(profile?.salary_amount || 0);
    const otRate = Number(profile?.overtime_rate || 1.5);
    // Hourly rate anchored to frequency so the math stays consistent:
    // daily  → salary / target_hours_day
    // weekly → salary / target_hours_week
    // monthly→ salary / (target_hours_week × 4)
    let hourlyRate = 0;
    if (salary > 0 && targetDayHr > 0) {
      if (profile.salary_frequency === 'daily') {
        hourlyRate = salary / targetDayHr;
      } else if (profile.salary_frequency === 'weekly') {
        hourlyRate = targetWeekHr > 0 ? salary / targetWeekHr : 0;
      } else {
        hourlyRate = targetWeekHr > 0 ? salary / (targetWeekHr * 4) : 0;
      }
    }
    const fullDayWage = hourlyRate * targetDayHr;
    const overtimeHourly = hourlyRate * otRate;

    const rows = await this.ds.query(
      `
      WITH days AS (
        SELECT generate_series($2::date, $3::date, INTERVAL '1 day')::date AS day
      ),
      att AS (
        SELECT work_date AS day,
               MIN(clock_in)  AS first_in,
               MAX(clock_out) AS last_out,
               COALESCE(SUM(duration_min),0)::int AS minutes
          FROM attendance_records
         WHERE user_id = $1 AND work_date BETWEEN $2::date AND $3::date
         GROUP BY work_date
      ),
      bns AS (
        SELECT bonus_date AS day, COALESCE(SUM(amount),0)::numeric(14,2) AS amt
          FROM employee_bonuses
         WHERE user_id = $1 AND bonus_date BETWEEN $2::date AND $3::date
         GROUP BY bonus_date
      ),
      dds AS (
        SELECT deduction_date AS day, COALESCE(SUM(amount),0)::numeric(14,2) AS amt
          FROM employee_deductions
         WHERE user_id = $1 AND deduction_date BETWEEN $2::date AND $3::date
         GROUP BY deduction_date
      ),
      advs AS (
        SELECT expense_date AS day, COALESCE(SUM(amount),0)::numeric(14,2) AS amt
          FROM expenses
         WHERE employee_user_id = $1 AND is_advance = true
           AND expense_date BETWEEN $2::date AND $3::date
         GROUP BY expense_date
      )
      SELECT d.day,
             COALESCE(att.minutes, 0)                AS minutes,
             GREATEST(COALESCE(att.minutes,0) - $4, 0)::int AS overtime_min,
             GREATEST($4 - COALESCE(att.minutes,0), 0)::int AS undertime_min,
             att.first_in,
             att.last_out,
             COALESCE(bns.amt, 0)  AS bonuses,
             COALESCE(dds.amt, 0)  AS deductions,
             COALESCE(advs.amt, 0) AS advances
        FROM days d
        LEFT JOIN att  ON att.day  = d.day
        LEFT JOIN bns  ON bns.day  = d.day
        LEFT JOIN dds  ON dds.day  = d.day
        LEFT JOIN advs ON advs.day = d.day
       ORDER BY d.day DESC`,
      [userId, fromISO, toISO, targetDayMin],
    );
    // Enrich each row with computed wage figures so the client can
    // show "المستحق" / "الأجر الكامل" without doing the math again.
    const enriched = rows.map((r: any) => {
      const actualMin = Number(r.minutes || 0);
      const regularMin = Math.min(actualMin, targetDayMin);
      const overtimeMin = Math.max(0, actualMin - targetDayMin);
      const earnedHours =
        (regularMin / 60) * hourlyRate + (overtimeMin / 60) * overtimeHourly;
      return {
        ...r,
        hourly_rate: Math.round(hourlyRate * 100) / 100,
        overtime_hourly_rate: Math.round(overtimeHourly * 100) / 100,
        full_day_wage: Math.round(fullDayWage * 100) / 100,
        earned_hours_based: Math.round(earnedHours * 100) / 100,
        earned_overtime: Math.round((overtimeMin / 60) * overtimeHourly * 100) / 100,
        earned_regular: Math.round((regularMin / 60) * hourlyRate * 100) / 100,
      };
    });

    return {
      target_hours_day: targetDayHr,
      hourly_rate: Math.round(hourlyRate * 100) / 100,
      full_day_wage: Math.round(fullDayWage * 100) / 100,
      overtime_rate: otRate,
      days: enriched,
    };
  }

  // ══════════════════════════════════════════════════════════════════════
  //   FINANCIAL LEDGER (migration 060) — unified "Financial Ledger" tab
  //   for the employee profile. Reads `v_employee_ledger` and folds a
  //   running balance in service code. Never bypasses the view so the
  //   signed-amount convention stays in exactly one place (SQL).
  // ══════════════════════════════════════════════════════════════════════

  /**
   * Return the employee's financial ledger for a date range + the current
   * outstanding balance (what they owe the company). Positive balance =
   * liability; negative balance = company owes them (rare — usually means
   * they overpaid a settlement).
   */
  async financialLedger(
    userId: string,
    from?: string,
    to?: string,
  ): Promise<{
    user: any;
    opening_balance: number;
    closing_balance: number;
    /**
     * Canonical GL balance from v_employee_gl_balance (COA 1123 + 213,
     * migration 075). Use this for the headline. `closing_balance` is
     * the source-table running balance — kept for the breakdown
     * equation but may differ from gl_balance when opening-balance
     * or reclassification JEs exist (e.g. PR #73's ledger reset).
     */
    gl_balance: number;
    entries: Array<{
      event_date: string;
      entry_type: string;
      description: string;
      amount_owed_delta: number;
      gross_amount: number;
      reference_type: string;
      reference_id: string;
      shift_id: string | null;
      journal_entry_id: string | null;
      running_balance: number;
      notes: string | null;
      created_at: string;
    }>;
    totals: {
      shortages: number;
      advances: number;
      manual_deductions: number;
      settlements: number;
      bonuses: number;
    };
  }> {
    const [user] = await this.ds.query(
      `SELECT id, full_name, username, employee_no, job_title
         FROM users WHERE id = $1`,
      [userId],
    );
    if (!user) throw new NotFoundException('الموظف غير موجود');

    // Opening balance = sum of everything BEFORE `from`. If no `from`
    // supplied, opening is 0 and we show full history.
    let opening = 0;
    if (from) {
      const [{ bal }] = await this.ds.query(
        `SELECT COALESCE(SUM(amount_owed_delta), 0)::numeric(14,2) AS bal
           FROM v_employee_ledger
          WHERE user_id = $1 AND event_date < $2::date`,
        [userId, from],
      );
      opening = Number(bal);
    }

    const where: string[] = ['v.user_id = $1'];
    const args: any[] = [userId];
    if (from) {
      args.push(from);
      where.push(`v.event_date >= $${args.length}::date`);
    }
    if (to) {
      args.push(to);
      where.push(`v.event_date <= $${args.length}::date`);
    }

    const rows = await this.ds.query(
      `
      SELECT v.event_date, v.entry_type, v.description,
             v.amount_owed_delta::numeric(14,2) AS amount_owed_delta,
             v.gross_amount::numeric(14,2)       AS gross_amount,
             v.reference_type, v.reference_id,
             v.shift_id, v.journal_entry_id,
             v.notes, v.created_at
        FROM v_employee_ledger v
       WHERE ${where.join(' AND ')}
       ORDER BY v.event_date ASC, v.created_at ASC
      `,
      args,
    );

    let running = opening;
    const entries = rows.map((r: any) => {
      running += Number(r.amount_owed_delta);
      return {
        ...r,
        amount_owed_delta: Number(r.amount_owed_delta),
        gross_amount: Number(r.gross_amount),
        running_balance: Math.round(running * 100) / 100,
      };
    });

    // Category breakdown for the header tiles.
    const totals = {
      shortages: 0,
      advances: 0,
      manual_deductions: 0,
      settlements: 0,
      bonuses: 0,
    };
    for (const r of rows) {
      const amt = Number(r.gross_amount);
      switch (r.entry_type) {
        case 'shift_shortage':
          totals.shortages += amt;
          break;
        case 'advance':
          totals.advances += amt;
          break;
        case 'deduction':
        case 'penalty':
          totals.manual_deductions += amt;
          break;
        case 'settlement':
          totals.settlements += amt;
          break;
        case 'bonus':
          totals.bonuses += amt;
          break;
      }
    }

    // Canonical GL balance — headline source. v_employee_gl_balance
    // is the authoritative per-employee number (COA 1123 + 213 since
    // migration 075). Read-only; no writes.
    const [glRow] = await this.ds.query(
      `SELECT balance::numeric(14,2) AS balance
         FROM v_employee_gl_balance WHERE employee_user_id = $1`,
      [userId],
    );

    return {
      user,
      opening_balance: Math.round(opening * 100) / 100,
      closing_balance: Math.round(running * 100) / 100,
      gl_balance: Math.round(Number(glRow?.balance || 0) * 100) / 100,
      entries,
      totals: {
        shortages: Math.round(totals.shortages * 100) / 100,
        advances: Math.round(totals.advances * 100) / 100,
        manual_deductions: Math.round(totals.manual_deductions * 100) / 100,
        settlements: Math.round(totals.settlements * 100) / 100,
        bonuses: Math.round(totals.bonuses * 100) / 100,
      },
    };
  }

  /**
   * Record a settlement — a payment BY the employee that reduces their
   * liability. When `method='cash'` and a cashbox is supplied, the
   * engine posts the matching journal entry:
   *
   *   DR Cash Register (resolved from cashbox)
   *   CR 1123 Employee Receivables       (tagged employee_user_id)
   *
   * All four methods now post a balanced JE:
   *   * cash              — DR cashbox (resolved from cashbox.kind →
   *                         1111) / CR 1123 — with cash movement IN
   *   * bank              — DR cashbox (resolved from cashbox.kind →
   *                         1113 bank or 1114 ewallet) / CR 1123 —
   *                         with cash movement IN
   *   * payroll_deduction — DR 213 Employee Payables / CR 1123 — no
   *                         cash movement; clears the receivable
   *                         against the accrued-payable, so next
   *                         payroll run pays out net
   *   * other             — DR <offset_account_code> / CR 1123 — no
   *                         cash movement; caller must supply the
   *                         explicit offset account (write-off,
   *                         inter-company receivable, etc.)
   *
   * Before this change only 'cash' posted a JE and the other three
   * methods created a silent settlement row that never reduced 1123
   * — the payroll page showed a payout, but the GL did not.
   */
  async recordSettlement(
    userId: string,
    dto: {
      amount: number;
      settlement_date?: string;
      method?: 'cash' | 'bank' | 'payroll_deduction' | 'other';
      cashbox_id?: string;
      offset_account_code?: string;
      notes?: string;
    },
    createdBy: string,
  ) {
    if (!dto.amount || dto.amount <= 0) {
      throw new BadRequestException('قيمة التسوية يجب أن تكون أكبر من صفر');
    }
    const method = dto.method ?? 'cash';

    // Per-method pre-conditions — fail early so we never create a
    // settlement row without the inputs needed to post its JE.
    if ((method === 'cash' || method === 'bank') && !dto.cashbox_id) {
      throw new BadRequestException(
        method === 'cash'
          ? 'تسوية نقدية تتطلب اختيار خزنة'
          : 'تسوية بنكية تتطلب اختيار حساب بنك/محفظة',
      );
    }
    if (method === 'other') {
      if (!dto.offset_account_code) {
        throw new BadRequestException(
          "تسوية بطريقة 'أخرى' تتطلب تحديد الحساب المقابل",
        );
      }
      if (dto.offset_account_code === '1123') {
        throw new BadRequestException(
          'لا يمكن استخدام 1123 كحساب مقابل — هو طرف التسوية نفسه',
        );
      }
    }
    const engine = this.engine;
    if (!engine) {
      throw new BadRequestException('محرك القيود غير متاح');
    }

    return this.ds.transaction(async (em) => {
      // 1. Insert the settlement row (journal_entry_id filled in below).
      const [row] = await em.query(
        `INSERT INTO employee_settlements
           (user_id, amount, settlement_date, method, cashbox_id, notes, created_by)
         VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE), $4, $5, $6, $7)
         RETURNING *`,
        [
          userId,
          dto.amount,
          dto.settlement_date || null,
          method,
          dto.cashbox_id || null,
          dto.notes || null,
          createdBy,
        ],
      );

      // 2. Build the per-method GL spec. CR side is always 1123
      // tagged with employee_user_id (039c guard requires
      // employee_id, which the engine mirrors from employee_user_id
      // post-PR #67).
      const description = `تسوية من موظف ${row.id} (${method})`.trim();
      const dr =
        method === 'cash' || method === 'bank'
          ? {
              resolve_from_cashbox_id: dto.cashbox_id!,
              debit: dto.amount,
              cashbox_id: dto.cashbox_id!,
            }
          : method === 'payroll_deduction'
            ? {
                account_code: '213',
                debit: dto.amount,
                employee_user_id: userId,
              }
            : {
                account_code: dto.offset_account_code!,
                debit: dto.amount,
              };
      const cr = {
        account_code: '1123',
        credit: dto.amount,
        employee_user_id: userId,
      };
      const cashMovements =
        method === 'cash' || method === 'bank'
          ? [
              {
                cashbox_id: dto.cashbox_id!,
                direction: 'in' as const,
                amount: dto.amount,
                category: 'employee_settlement',
                notes: description,
              },
            ]
          : [];

      const res = await engine.recordTransaction({
        kind: 'manual_adjustment',
        reference_type: 'employee_settlement',
        reference_id: String(row.id),
        description,
        gl_lines: [dr, cr],
        cash_movements: cashMovements,
        user_id: createdBy,
        em,
      });
      if (!res.ok) {
        throw new BadRequestException(`فشل ترحيل التسوية: ${res.error}`);
      }
      if ('entry_id' in res && res.entry_id) {
        await em.query(
          `UPDATE employee_settlements SET journal_entry_id = $1::uuid WHERE id = $2`,
          [res.entry_id, row.id],
        );
        row.journal_entry_id = res.entry_id;
      }

      return row;
    });
  }
}
