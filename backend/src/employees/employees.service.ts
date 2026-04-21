import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { DataSource } from 'typeorm';

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
  constructor(private readonly ds: DataSource) {}

  // ── helpers ──────────────────────────────────────────────────────────
  private async getProfile(userId: string) {
    const [row] = await this.ds.query(
      `SELECT u.id, u.username, u.full_name, u.employee_no, u.job_title,
              u.hire_date, u.salary_amount, u.salary_frequency,
              u.target_hours_day, u.target_hours_week, u.overtime_rate,
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

    return {
      profile,
      period: { month: { from: mFrom, to: mTo }, week: { from: wFrom, to: wTo } },
      attendance: {
        today: todayAtt || null,
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
        net: Math.round(net * 100) / 100,
        debt_warning: debtWarning,
      },
      tasks,
      requests,
      recommendations: debtWarning
        ? [
            'مديونيتك تجاوزت رصيد الراتب الحالي.',
            'قلّل من السلف الشهر القادم أو اطلب تمديد ساعات إضافية لزيادة الدخل.',
          ]
        : [],
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
              overtime_rate     = COALESCE($9, overtime_rate)
        WHERE id = $1
        RETURNING id, employee_no, job_title, hire_date, salary_amount,
                  salary_frequency, target_hours_day, target_hours_week,
                  overtime_rate`,
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
      ],
    );
    if (!row) throw new NotFoundException('المستخدم غير موجود');
    return row;
  }

  /** Admin team overview — one row per active user with summary metrics. */
  async teamOverview() {
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
                WHERE q.user_id = u.id AND q.status = 'pending')::int AS pending_requests
         FROM users u
         LEFT JOIN roles r ON r.id = u.role_id
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
}
