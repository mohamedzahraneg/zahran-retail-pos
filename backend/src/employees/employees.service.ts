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
              u.ledger_reset_date,
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
   * Resolve a selected month (YYYY-MM) into first/last day in Cairo time.
   * Falls back to the current month when the input is missing or
   * malformed — never throws, since this runs inside /dashboard where a
   * bad query param shouldn't 500.
   */
  private monthBounds(month?: string): {
    from: string;
    to: string;
    label: string;
    isCurrent: boolean;
  } {
    const now = new Date();
    const todayParts = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Africa/Cairo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(now);
    const curY = todayParts.find((x) => x.type === 'year')!.value;
    const curM = todayParts.find((x) => x.type === 'month')!.value;

    const match = (month || '').match(/^(\d{4})-(\d{2})$/);
    const y = match ? match[1] : curY;
    const m = match ? match[2] : curM;

    const first = `${y}-${m}-01`;
    // Last day via "first of next month − 1 day" — handled by Postgres
    // when used as a query arg; here we just do the JS calc.
    const dt = new Date(Date.UTC(Number(y), Number(m), 1));
    dt.setUTCDate(dt.getUTCDate() - 1);
    const last =
      dt.getUTCFullYear() +
      '-' +
      String(dt.getUTCMonth() + 1).padStart(2, '0') +
      '-' +
      String(dt.getUTCDate()).padStart(2, '0');

    return {
      from: first,
      to: last,
      label: `${y}-${m}`,
      isCurrent: y === curY && m === curM,
    };
  }

  /**
   * Day before a given YYYY-MM-DD, suitable for opening-balance lookup.
   */
  private dayBefore(iso: string): string {
    const dt = new Date(iso + 'T00:00:00Z');
    dt.setUTCDate(dt.getUTCDate() - 1);
    return (
      dt.getUTCFullYear() +
      '-' +
      String(dt.getUTCMonth() + 1).padStart(2, '0') +
      '-' +
      String(dt.getUTCDate()).padStart(2, '0')
    );
  }

  /**
   * Personal dashboard payload — everything the employee sees on the
   * home page. Accepts an optional `month=YYYY-MM` param so the profile
   * can scope attendance / accrual / source aggregates to the selected
   * month. Headline GL numbers include both the live snapshot and
   * opening/closing balances around the selected month.
   */
  async myDashboard(userId: string, month?: string) {
    const profile = await this.getProfile(userId);
    const monthSel = this.monthBounds(month);
    const mFrom = monthSel.from;
    const mTo = monthSel.to;
    // The "week" strip still reflects the real current week — it's a
    // live indicator on the self-service home screen and shouldn't
    // shift when the admin picks a historical month for audit.
    const { from: wFrom, to: wTo } = this.periodBounds('week');
    const resetDate: string | null = profile.ledger_reset_date
      ? String(profile.ledger_reset_date).slice(0, 10)
      : null;

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

    // Bonuses + deductions this month. `AND NOT is_void` hides admin-
    // voided rows (PR #82+) so the "تفاصيل الدخل" breakdown on the
    // Employee Profile only shows live transactions. Canonical balance
    // still comes from v_employee_gl_balance which was fixed in
    // migration 079.
    const [bonus] = await this.ds.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(14,2) AS amount,
              COUNT(*)::int AS count
         FROM employee_bonuses
        WHERE user_id = $1
          AND bonus_date BETWEEN $2::date AND $3::date
          AND NOT is_void`,
      [userId, mFrom, mTo],
    );
    const [deduct] = await this.ds.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(14,2) AS amount,
              COUNT(*)::int AS count
         FROM employee_deductions
        WHERE user_id = $1
          AND deduction_date BETWEEN $2::date AND $3::date
          AND NOT is_void`,
      [userId, mFrom, mTo],
    );

    // ─── Canonical monthly wage workflow (migration 082/083/084) ───────
    // Accrual = what was earned this month (DR 521 / CR 213 rows)
    // Paid    = what admin actually paid out this month (employee_settlements)
    // Remaining = max(accrual − paid, 0) for display only — GL balance
    //             remains the source of truth for "who owes whom".
    const [accrual] = await this.ds.query(
      `SELECT COALESCE(SUM(amount_accrued),0)::numeric(14,2) AS amount,
              COUNT(*)::int AS count
         FROM employee_payable_days
        WHERE user_id = $1 AND kind = 'wage_accrual'
          AND work_date BETWEEN $2::date AND $3::date
          AND NOT is_void`,
      [userId, mFrom, mTo],
    );
    const [paid] = await this.ds.query(
      `SELECT COALESCE(SUM(amount),0)::numeric(14,2) AS amount,
              COUNT(*)::int AS count
         FROM employee_settlements
        WHERE user_id = $1
          AND settlement_date BETWEEN $2::date AND $3::date
          AND NOT is_void`,
      [userId, mFrom, mTo],
    );

    // ─── GL opening / closing balance around the selected month ────────
    const [openRow] = await this.ds.query(
      `SELECT fn_employee_gl_balance_as_of($1::uuid, $2::date) AS bal`,
      [userId, this.dayBefore(mFrom)],
    );
    const [closeRow] = await this.ds.query(
      `SELECT fn_employee_gl_balance_as_of($1::uuid, $2::date) AS bal`,
      [userId, mTo],
    );
    const openingGl = Number(openRow?.bal || 0);
    const closingGl = Number(closeRow?.bal || 0);

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

    const accrualInMonth = Number(accrual?.amount || 0);
    const paidInMonth = Number(paid?.amount || 0);
    const remainingFromAccrual = Math.max(0, accrualInMonth - paidInMonth);

    return {
      profile,
      period: {
        month: { from: mFrom, to: mTo, label: monthSel.label, is_current: monthSel.isCurrent },
        week: { from: wFrom, to: wTo },
      },
      ledger_reset: {
        date: resetDate,
        has_reset: !!resetDate,
      },
      attendance: {
        // Today's row is only meaningful when viewing the current month.
        today: monthSel.isCurrent ? todayAtt || null : null,
        today_late_minutes: monthSel.isCurrent ? lateMinutes : 0,
        today_early_leave_minutes: monthSel.isCurrent ? earlyLeaveMinutes : 0,
        expected_end_utc: monthSel.isCurrent ? expectedEndUtc : null,
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
      // Canonical monthly wage workflow — the new post-reset cards.
      wage: {
        daily_amount: salaryAmount,
        target_minutes_day: Math.round(targetDay * 60),
        accrual_in_month: Math.round(accrualInMonth * 100) / 100,
        accrual_count: Number(accrual?.count || 0),
        paid_in_month: Math.round(paidInMonth * 100) / 100,
        paid_count: Number(paid?.count || 0),
        remaining_from_month_accrual: Math.round(remainingFromAccrual * 100) / 100,
      },
      // GL balance headlines — the source of truth.
      gl: {
        opening_balance: Math.round(openingGl * 100) / 100,
        closing_balance: Math.round(closingGl * 100) / 100,
        live_snapshot: Math.round(Number(glBalance) * 100) / 100,
      },
      salary: {
        amount: salaryAmount,
        frequency: freq,
        expected: expectedForPeriod,
        // Legacy source-derived numbers — still shipped so the archived
        // "السجل القديم قبل التصفير" section in the UI can render them
        // without a second query. The main post-reset cards come from
        // `wage` + `gl` above; `salary.*` must NOT drive headline UI.
        accrued: Math.round(accrualBase * 100) / 100,
        bonuses: Number(bonus.amount || 0),
        deductions: Number(deduct.amount || 0),
        advances_month: Number(adv.amount || 0),
        advances_lifetime: Number(advLifetime.amount || 0),
        net: Math.round(net * 100) / 100,
        outstanding_debt: Math.round(outstandingDebt * 100) / 100,
        debt_warning: debtWarning,
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
    // Migration 113 — for kind='advance_request' rows, surface the
    // disbursing expense (if any) so the UI can show
    // "processed → EXP-2026-NNNNN". The LATERAL join picks the most
    // recent live link; voided expenses fall away because the JE is
    // marked is_void on void.
    return this.ds.query(
      `SELECT r.*,
              fx.expense_id,
              fx.expense_no
         FROM employee_requests r
         LEFT JOIN LATERAL (
           SELECT e.id   AS expense_id,
                  e.expense_no
             FROM expenses e
             LEFT JOIN journal_entries je
               ON je.reference_type = 'expense'
              AND je.reference_id   = e.id
            WHERE e.source_employee_request_id = r.id
              AND COALESCE(je.is_void, FALSE) = FALSE
            ORDER BY e.created_at DESC
            LIMIT 1
         ) fx ON TRUE
        WHERE r.user_id = $1
        ORDER BY r.created_at DESC`,
      [userId],
    );
  }

  async submitRequest(
    userId: string,
    dto: {
      kind:
        | 'advance'
        | 'advance_request'
        | 'leave'
        | 'overtime_extension'
        | 'other';
      amount?: number;
      starts_at?: string;
      ends_at?: string;
      reason?: string;
    },
    callerPerms: string[] = [],
  ) {
    // Hard block: the legacy 'advance' kind is reserved for historical
    // rows. The fn_mirror_advance_to_txn trigger (migration 040) auto-
    // posts to employee_transactions when this kind is approved, which
    // double-posts against the canonical FinancialEngine path. Self-
    // service callers must use 'advance_request' (migration 113) — a
    // pure informational request with NO GL/cashbox side effects.
    if (dto.kind === 'advance') {
      throw new BadRequestException(
        'استخدم نوع advance_request — السلف القديمة محجوزة للسجلات السابقة فقط',
      );
    }

    if (dto.kind === 'advance_request') {
      // Per-kind permission check (controller-level guard is intentionally
      // permissive so leave/overtime asks aren't blocked when an org
      // disables advance asks).
      const has = (code: string) =>
        callerPerms.includes('*') ||
        callerPerms.includes('employee.*') ||
        callerPerms.includes(code);
      if (!has('employee.advance.request')) {
        throw new ForbiddenException(
          'صلاحيات ناقصة: employee.advance.request',
        );
      }
      if (!dto.amount || dto.amount <= 0) {
        throw new BadRequestException('يجب تحديد قيمة السلفة المطلوبة');
      }
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
    // Pending list is for approvers — same shape as before; advance_request
    // rows come through with kind='advance_request' so the UI can render
    // them with the right approve-vs-pay flow. No expense_id surfaced
    // here because pending rows by definition have no disbursement yet.
    return this.ds.query(
      `SELECT r.*,
              u.full_name AS user_name, u.username, u.employee_no
         FROM employee_requests r
         JOIN users u ON u.id = r.user_id
        WHERE r.status = 'pending'
        ORDER BY r.created_at DESC`,
    );
  }

  // Approved advance_request rows that haven't been disbursed yet —
  // feeds the HR "outstanding advance asks" worklist. Once the linked
  // expense exists with a live (non-void) JE, the row drops off.
  listApprovedAdvanceRequestsAwaitingDisbursement() {
    return this.ds.query(
      `SELECT r.id, r.user_id, r.amount, r.reason, r.decided_at,
              u.full_name AS user_name, u.username, u.employee_no
         FROM employee_requests r
         JOIN users u ON u.id = r.user_id
        WHERE r.kind = 'advance_request'
          AND r.status = 'approved'
          AND NOT EXISTS (
            SELECT 1
              FROM expenses e
              LEFT JOIN journal_entries je
                ON je.reference_type = 'expense'
               AND je.reference_id   = e.id
             WHERE e.source_employee_request_id = r.id
               AND COALESCE(je.is_void, FALSE) = FALSE
          )
        ORDER BY r.decided_at DESC`,
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
    // Audit #4 invariant — this method MUST NOT post to GL or move
    // cashbox. For kind='advance_request' the trigger
    // fn_mirror_advance_to_txn does not fire (it guards on
    // kind='advance'); the actual disbursement happens later via
    // POST /accounting/expenses (is_advance=true,
    // source_employee_request_id=N), which is the single money-moving
    // path and goes through FinancialEngineService.
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
          AND NOT b.is_void
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
      `SELECT * FROM employee_deductions
        WHERE user_id = $1 AND NOT is_void
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
    //
    // PR-1 wiring: also expose target_hours_day + monthly aggregates
    // for overtime / lateness / early-leave so the Team list can
    // surface them without the admin opening each drawer. The math
    // here matches the per-day formulas used in myDashboard
    // (lines 323-386 for late/early, generated `duration_min` for
    // overtime). All time-of-day comparisons are done in Cairo TZ to
    // align with the rest of the codebase.
    return this.ds.query(
      `SELECT u.id, u.employee_no, u.full_name, u.username, u.job_title,
              u.salary_amount, u.salary_frequency,
              u.target_hours_day,
              u.shift_start_time,
              u.shift_end_time,
              u.late_grace_min,
              r.name_ar AS role_name,
              COALESCE((
                SELECT SUM(duration_min) FROM attendance_records a
                 WHERE a.user_id = u.id
                   AND a.work_date >= date_trunc('month', (now() AT TIME ZONE 'Africa/Cairo'))::date
                   AND a.clock_out IS NOT NULL
              ), 0)::int AS minutes_this_month,
              -- Overtime minutes this month: sum of (duration − target)
              -- on each closed day where the worker exceeded target.
              COALESCE((
                SELECT SUM(GREATEST(0,
                         a.duration_min - COALESCE(u.target_hours_day,8) * 60))
                  FROM attendance_records a
                 WHERE a.user_id = u.id
                   AND a.work_date >= date_trunc('month', (now() AT TIME ZONE 'Africa/Cairo'))::date
                   AND a.clock_out IS NOT NULL
              ), 0)::int AS overtime_minutes_this_month,
              -- Shortage minutes this month: sum of (target − duration)
              -- on closed days where the worker fell short of target.
              COALESCE((
                SELECT SUM(GREATEST(0,
                         COALESCE(u.target_hours_day,8) * 60 - a.duration_min))
                  FROM attendance_records a
                 WHERE a.user_id = u.id
                   AND a.work_date >= date_trunc('month', (now() AT TIME ZONE 'Africa/Cairo'))::date
                   AND a.clock_out IS NOT NULL
              ), 0)::int AS shortage_minutes_this_month,
              -- Late minutes this month: minutes past shift_start_time
              -- (after grace) at clock-in. Cairo TZ; NULL shift_start
              -- → 0. Same shape as the per-day calc in myDashboard.
              COALESCE((
                SELECT SUM(GREATEST(0,
                         EXTRACT(EPOCH FROM (
                           ((a.clock_in AT TIME ZONE 'Africa/Cairo')::time - u.shift_start_time)
                         )) / 60
                         - COALESCE(u.late_grace_min, 10)))
                  FROM attendance_records a
                 WHERE a.user_id = u.id
                   AND u.shift_start_time IS NOT NULL
                   AND a.clock_in IS NOT NULL
                   AND a.work_date >= date_trunc('month', (now() AT TIME ZONE 'Africa/Cairo'))::date
              ), 0)::int AS late_minutes_this_month,
              -- Early-leave minutes this month: minutes before
              -- shift_end_time at clock-out.
              COALESCE((
                SELECT SUM(GREATEST(0,
                         EXTRACT(EPOCH FROM (
                           u.shift_end_time - (a.clock_out AT TIME ZONE 'Africa/Cairo')::time
                         )) / 60))
                  FROM attendance_records a
                 WHERE a.user_id = u.id
                   AND u.shift_end_time IS NOT NULL
                   AND a.clock_out IS NOT NULL
                   AND a.work_date >= date_trunc('month', (now() AT TIME ZONE 'Africa/Cairo'))::date
              ), 0)::int AS early_leave_minutes_this_month,
              COALESCE((
                SELECT SUM(amount) FROM expenses e
                 WHERE e.employee_user_id = u.id AND e.is_advance = true
                   AND e.expense_date >= date_trunc('month', (now() AT TIME ZONE 'Africa/Cairo'))::date
              ), 0)::numeric(14,2) AS advances_this_month,
              COALESCE((
                SELECT SUM(amount) FROM employee_bonuses b
                 WHERE b.user_id = u.id
                   AND b.bonus_date >= date_trunc('month', (now() AT TIME ZONE 'Africa/Cairo'))::date
                   AND NOT b.is_void
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
              salary_frequency, overtime_rate,
              shift_start_time, shift_end_time, late_grace_min
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
        -- Per-day attendance + Cairo-TZ-aware late / early-leave
        -- minutes. Same formulas as teamOverview() (PR-1) and the
        -- per-row block in myDashboard. NULL shift_start/end →
        -- 0 (no rule to compare against).
        SELECT a.work_date AS day,
               MIN(a.clock_in)  AS first_in,
               MAX(a.clock_out) AS last_out,
               COALESCE(SUM(a.duration_min),0)::int AS minutes,
               COALESCE(SUM(GREATEST(0,
                 EXTRACT(EPOCH FROM (
                   ((a.clock_in AT TIME ZONE 'Africa/Cairo')::time - $5::time)
                 )) / 60
                 - $7::int)
               )::int, 0) AS late_min,
               COALESCE(SUM(GREATEST(0,
                 EXTRACT(EPOCH FROM (
                   $6::time - (a.clock_out AT TIME ZONE 'Africa/Cairo')::time
                 )) / 60)
               )::int, 0) AS early_leave_min
          FROM attendance_records a
         WHERE a.user_id = $1
           AND a.work_date BETWEEN $2::date AND $3::date
         GROUP BY a.work_date
      ),
      bns AS (
        SELECT bonus_date AS day, COALESCE(SUM(amount),0)::numeric(14,2) AS amt
          FROM employee_bonuses
         WHERE user_id = $1 AND bonus_date BETWEEN $2::date AND $3::date
           AND NOT is_void
         GROUP BY bonus_date
      ),
      dds AS (
        SELECT deduction_date AS day, COALESCE(SUM(amount),0)::numeric(14,2) AS amt
          FROM employee_deductions
         WHERE user_id = $1 AND deduction_date BETWEEN $2::date AND $3::date
           AND NOT is_void
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
             $4::int                                 AS target_min,
             COALESCE(att.late_min, 0)::int          AS late_min,
             COALESCE(att.early_leave_min, 0)::int   AS early_leave_min,
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
      [
        userId,
        fromISO,
        toISO,
        targetDayMin,
        profile?.shift_start_time ?? null,
        profile?.shift_end_time ?? null,
        Number(profile?.late_grace_min ?? 10),
      ],
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
     * GL-based opening balance truncated at (from − 1 day). Uses
     * fn_employee_gl_balance_as_of — the canonical post-reset balance
     * source. NULL when `from` is not supplied (full history view).
     */
    gl_opening_balance: number | null;
    /**
     * GL-based closing balance truncated at `to`. Uses
     * fn_employee_gl_balance_as_of. NULL when `to` is not supplied.
     */
    gl_closing_balance: number | null;
    /**
     * Canonical GL balance from v_employee_gl_balance (COA 1123 + 213,
     * migration 075). Use this for the live snapshot headline.
     * `closing_balance` is the source-table running balance — kept for
     * the breakdown equation but may differ from gl_balance when
     * opening-balance or reclassification JEs exist (e.g. PR #73's
     * ledger reset).
     */
    gl_balance: number;
    /**
     * Canonical ledger — every posted non-void journal_line tagged
     * with the employee on accounts 1123 ذمم / 213 مستحقات, ordered
     * chronologically with a running balance. This is the audit trail
     * behind `gl_balance`: every reset / reclass / bonus / deduction
     * shows up as its own row. SUM of signed_effect == gl_balance.
     */
    gl_entries: Array<{
      entry_no: string;
      entry_date: string;
      reference_type: string;
      reference_id: string;
      description: string;
      account_code: string;
      account_name: string;
      debit: number;
      credit: number;
      /** debit − credit. Positive pushes employee balance up
       *  (they owe company more); negative pushes it down. */
      signed_effect: number;
      running_balance: number;
    }>;
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

    // Canonical GL ledger — every posted non-void journal_line tagged
    // with this employee on accounts 1123/213, ordered chronologically.
    // Opening-balance resets (reference_type='employee_ledger_reset_*')
    // and reclassification JEs (reference_type='expense_reclass_to_*')
    // show up as their own rows. SUM(signed_effect) == gl_balance.
    // PR-25 — include voided JEs in the response so wage approvals
    // that the admin later reverted are still visible (with an
    // is_voided flag the UI uses to render them faded + a "ملغاة"
    // chip). Voided rows do NOT contribute to running_balance.
    const glRaw = await this.ds.query(
      `SELECT je.entry_no,
              je.entry_date::text AS entry_date,
              je.reference_type,
              je.reference_id::text AS reference_id,
              je.is_void AS is_voided,
              je.void_reason,
              COALESCE(jl.description, je.description) AS description,
              coa.code    AS account_code,
              coa.name_ar AS account_name,
              jl.debit::numeric(14,2)  AS debit,
              jl.credit::numeric(14,2) AS credit,
              jl.line_no
         FROM journal_lines jl
         JOIN journal_entries je ON je.id = jl.entry_id
         JOIN chart_of_accounts coa ON coa.id = jl.account_id
        WHERE COALESCE(jl.employee_id, jl.employee_user_id) = $1
          AND coa.code IN ('1123', '213')
          AND je.is_posted = TRUE
        ORDER BY je.entry_date ASC, je.entry_no ASC, jl.line_no ASC`,
      [userId],
    );
    let glRunning = 0;
    const gl_entries = glRaw.map((r: any) => {
      const debit = Number(r.debit);
      const credit = Number(r.credit);
      const isVoided = r.is_voided === true;
      // Voided rows have zero economic effect — they're shown for
      // audit (so the admin can see what was reverted) but never
      // move the running balance.
      const signed_effect = isVoided
        ? 0
        : Math.round((debit - credit) * 100) / 100;
      glRunning = Math.round((glRunning + signed_effect) * 100) / 100;
      return {
        entry_no: r.entry_no,
        entry_date: r.entry_date,
        reference_type: r.reference_type,
        reference_id: r.reference_id,
        description: r.description || '',
        account_code: r.account_code,
        account_name: r.account_name,
        debit,
        credit,
        signed_effect,
        running_balance: glRunning,
        is_voided: isVoided,
        void_reason: r.void_reason || null,
      };
    });

    // GL-based opening/closing around the selected range. These are the
    // canonical post-reset numbers the UI's main cards should use; the
    // source-delta `opening_balance` / `closing_balance` remain for the
    // archived "السجل القديم قبل التصفير" section.
    let glOpening: number | null = null;
    let glClosing: number | null = null;
    if (from) {
      const [o] = await this.ds.query(
        `SELECT fn_employee_gl_balance_as_of($1::uuid, $2::date) AS bal`,
        [userId, this.dayBefore(from)],
      );
      glOpening = Math.round(Number(o?.bal || 0) * 100) / 100;
    }
    if (to) {
      const [c] = await this.ds.query(
        `SELECT fn_employee_gl_balance_as_of($1::uuid, $2::date) AS bal`,
        [userId, to],
      );
      glClosing = Math.round(Number(c?.bal || 0) * 100) / 100;
    }

    return {
      user,
      opening_balance: Math.round(opening * 100) / 100,
      closing_balance: Math.round(running * 100) / 100,
      gl_opening_balance: glOpening,
      gl_closing_balance: glClosing,
      gl_balance: Math.round(Number(glRow?.balance || 0) * 100) / 100,
      gl_entries,
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
   * Record a settlement — the company paying out cash to an employee
   * for an amount it owes them on 213 مستحقات الموظفين, or (for
   * payroll_deduction / other) an internal offset against another
   * account.
   *
   * Per-method GL spec:
   *   * cash              — DR 213 / CR cashbox (resolved from
   *                         cashbox.kind → 1111). Cash movement OUT.
   *   * bank              — DR 213 / CR cashbox (resolved from
   *                         cashbox.kind → 1113 bank or 1114 ewallet).
   *                         Cash movement OUT.
   *   * payroll_deduction — DR 213 / CR 1123 — no cash. Clears a
   *                         receivable against the accrued-payable
   *                         so next payroll run pays the net.
   *   * other             — DR <offset_account_code> / CR 1123 — no
   *                         cash; caller-supplied offset (write-off,
   *                         inter-company receivable, etc.).
   *
   * History notes:
   *   * Before PR-this: cash/bank posted DR cashbox / CR 1123 with
   *     cash IN — i.e. "employee paid us back" semantics. Every real
   *     caller (Payroll payout, pay-wage payable settle, pay-wage
   *     bonus settle, the settlement modal) actually means the
   *     opposite — company pays employee. The wrong direction
   *     surfaced as Abu Youssef's GL going from −1150 → −1250 after
   *     a 100 EGP payout (expected −1050) — see hotfix migration 088
   *     for the corrective reposts.
   *   * Before PR #77: only 'cash' posted a JE and the other three
   *     methods created a silent settlement row that never reduced
   *     the receivable.
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
      /**
       * PR-15 — explicit shift linkage. When supplied:
       *   - shift must be in 'open' or 'pending_close' status
       *   - if cashbox_id is also supplied it must equal the shift's
       *     cashbox_id (otherwise the settlement would be attributed
       *     to the wrong drawer)
       *   - if cashbox_id is omitted we derive it from the shift
       * When omitted, the settlement is recorded with shift_id=NULL
       * (the historical "direct cashbox" path) — shift-closing falls
       * back to the derived (cashbox+time-window) match for visibility.
       */
      shift_id?: string;
    },
    createdBy: string,
    userPermissions: string[] = [],
  ) {
    if (!dto.amount || dto.amount <= 0) {
      throw new BadRequestException('قيمة التسوية يجب أن تكون أكبر من صفر');
    }
    const method = dto.method ?? 'cash';

    // PR-15 — shift validation + cashbox derivation. Runs before the
    // method pre-conditions so a bad shift is caught with a friendly
    // Arabic error instead of a downstream "cashbox required".
    let resolvedCashboxId = dto.cashbox_id;
    let resolvedShiftId: string | null = null;
    if (dto.shift_id) {
      const [shift] = await this.ds.query(
        `SELECT id, status, cashbox_id FROM shifts WHERE id = $1`,
        [dto.shift_id],
      );
      if (!shift) {
        throw new BadRequestException('الوردية المختارة غير موجودة');
      }
      if (shift.status !== 'open' && shift.status !== 'pending_close') {
        throw new BadRequestException(
          'لا يمكن الصرف من وردية مغلقة — اختر وردية مفتوحة أو خزنة مباشرة',
        );
      }
      if (resolvedCashboxId && resolvedCashboxId !== shift.cashbox_id) {
        throw new BadRequestException(
          'الخزنة المختارة لا تطابق خزنة الوردية المختارة',
        );
      }
      resolvedCashboxId = resolvedCashboxId ?? shift.cashbox_id;
      resolvedShiftId = shift.id;
    }

    // PR-25 — direct-cashbox payouts (shift_id omitted, cashbox_id
    // supplied, method = cash/bank) are explicitly NOT attached to any
    // shift's closing summary. That bypass requires its own permission
    // so a cashier can't drain a drawer outside their own shift's
    // visibility — same loophole PR-R1 closed for refunds via
    // returns.refund.direct_cashbox.
    const isDirectCashbox =
      !dto.shift_id &&
      !!resolvedCashboxId &&
      (method === 'cash' || method === 'bank');
    if (isDirectCashbox) {
      const hasPerm =
        userPermissions.includes('*') ||
        userPermissions.includes('employees.*') ||
        userPermissions.includes('employees.settlement.direct_cashbox');
      if (!hasPerm) {
        throw new BadRequestException(
          'الصرف من خزنة مباشرة (بدون وردية) يتطلب صلاحية employees.settlement.direct_cashbox — اختر وردية مفتوحة بدلاً من ذلك',
        );
      }
    }

    // Per-method pre-conditions — fail early so we never create a
    // settlement row without the inputs needed to post its JE.
    if ((method === 'cash' || method === 'bank') && !resolvedCashboxId) {
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
      // PR-15 — shift_id column added in migration 095. Stored as NULL
      // when the operator chose the direct-cashbox path.
      const [row] = await em.query(
        `INSERT INTO employee_settlements
           (user_id, amount, settlement_date, method, cashbox_id,
            notes, created_by, shift_id)
         VALUES ($1, $2, COALESCE($3::date, CURRENT_DATE),
                 $4, $5, $6, $7, $8)
         RETURNING *`,
        [
          userId,
          dto.amount,
          dto.settlement_date || null,
          method,
          resolvedCashboxId || null,
          dto.notes || null,
          createdBy,
          resolvedShiftId,
        ],
      );

      // 2. Build the per-method GL spec.
      //
      //   cash / bank  →  DR 213 (reduce employee payable, tagged with
      //                   employee_user_id) / CR cashbox (resolved
      //                   from cashbox.kind). Cash movement OUT.
      //
      //   payroll_deduction / other  →  unchanged from the PR #77
      //                                  shape (DR offset / CR 1123).
      //                                  No cash movement.
      const description = `تسوية من موظف ${row.id} (${method})`.trim();
      const isCashOrBank = method === 'cash' || method === 'bank';
      const dr = isCashOrBank
        ? {
            account_code: '213',
            debit: dto.amount,
            employee_user_id: userId,
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
      const cr = isCashOrBank
        ? {
            resolve_from_cashbox_id: resolvedCashboxId!,
            credit: dto.amount,
            cashbox_id: resolvedCashboxId!,
          }
        : {
            account_code: '1123',
            credit: dto.amount,
            employee_user_id: userId,
          };
      const cashMovements = isCashOrBank
        ? [
            {
              cashbox_id: resolvedCashboxId!,
              direction: 'out' as const,
              amount: dto.amount,
              category: 'employee_settlement',
              notes: description,
            },
          ]
        : [];

      // journal_entries.reference_id is UUID-typed but employee_
      // settlements.id is BIGSERIAL, so passing String(row.id) gave
      // `invalid input syntax for type uuid: "N"` and blocked every
      // settlement from ever posting (0 rows on live pre-this-fix,
      // so the bug was latent until PR #77 first exercised the
      // payout path). Compute a deterministic v5 UUID derived from
      // the settlement's bigint id — idempotent on retry (same id →
      // same uuid → engine skips duplicates), and leaves a visible
      // `reference_id` on journal_entries that correlates 1:1 with
      // the employee_settlements row.
      const [{ ref }] = await em.query(
        `SELECT uuid_generate_v5(uuid_ns_oid(), 'employee_settlement:' || $1::text) AS ref`,
        [row.id],
      );
      const res = await engine.recordTransaction({
        kind: 'manual_adjustment',
        reference_type: 'employee_settlement',
        reference_id: ref,
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
