import { api, unwrap } from './client';

export interface EmployeeTask {
  id: string;
  user_id: string;
  title: string;
  description?: string;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  due_at?: string;
  assigned_at: string;
  acknowledged_at?: string;
  completed_at?: string;
  status: 'pending' | 'acknowledged' | 'completed' | 'cancelled';
}

// Display union for historical rows — keeps 'advance' so pre-existing
// approved/pending advance requests still render. Write-side uses the
// narrower SubmitRequestKind below (audit #4 — direct advance creation
// disabled; canonical path is expenses.is_advance=TRUE).
export type SubmitRequestKind = 'leave' | 'overtime_extension' | 'other';

export interface EmployeeRequest {
  id: string;
  user_id: string;
  kind: 'advance' | 'leave' | 'overtime_extension' | 'other';
  amount?: number | string;
  starts_at?: string;
  ends_at?: string;
  reason?: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decided_by?: string;
  decided_at?: string;
  decision_reason?: string;
  created_at: string;
  user_name?: string;
  username?: string;
  employee_no?: string;
}

export interface EmployeeDashboard {
  profile: {
    id: string;
    username: string;
    full_name: string;
    employee_no: string;
    job_title?: string;
    hire_date?: string;
    salary_amount: number | string;
    salary_frequency: 'daily' | 'weekly' | 'monthly';
    target_hours_day: number | string;
    target_hours_week: number | string;
    overtime_rate: number | string;
    shift_start_time?: string | null;
    shift_end_time?: string | null;
    late_grace_min?: number | string;
    role_name?: string;
    role_code?: string;
  };
  attendance: {
    today: any | null;
    today_late_minutes: number;
    today_early_leave_minutes: number;
    expected_end_utc: string | null;
    week: { minutes: number; days: number; target_hours: number };
    month: { minutes: number; days: number };
  };
  warnings: Array<{ kind: string; message: string }>;
  /**
   * Selected-month window (defaults to current Cairo month) + a live
   * week slice. Added by PR #88. `is_current` tells the UI whether
   * "today" attendance data is meaningful.
   */
  period: {
    month: { from: string; to: string; label: string; is_current: boolean };
    week: { from: string; to: string };
  };
  /**
   * Per-user ledger reset marker (migration 081). `date` is the cutoff
   * after which the post-reset main cards apply. NULL for employees
   * who never had a reset posted — UI falls back to legacy display.
   */
  ledger_reset: { date: string | null; has_reset: boolean };
  /**
   * Canonical monthly wage workflow (migrations 082–083). These are
   * the numbers the post-reset main cards read from.
   */
  wage: {
    daily_amount: number;
    target_minutes_day: number;
    accrual_in_month: number;
    accrual_count: number;
    paid_in_month: number;
    paid_count: number;
    remaining_from_month_accrual: number;
  };
  /**
   * GL balance headlines (migration 084). `opening_balance` = as-of
   * (month start − 1 day); `closing_balance` = as-of month end;
   * `live_snapshot` = v_employee_gl_balance right now.
   */
  gl: {
    opening_balance: number;
    closing_balance: number;
    live_snapshot: number;
  };
  salary: {
    amount: number;
    frequency: 'daily' | 'weekly' | 'monthly';
    expected: number;
    /**
     * Legacy source-derived numbers — after the ledger reset these are
     * shown only inside the collapsed "السجل القديم قبل التصفير"
     * archive section and must NOT drive the main cards. `gl_balance`
     * is kept as the live snapshot for backward compatibility.
     */
    accrued: number;
    bonuses: number;
    gl_balance: number;
    deductions: number;
    advances_month: number;
    advances_lifetime: number;
    net: number;
    debt_warning: boolean;
  };
  tasks: EmployeeTask[];
  requests: EmployeeRequest[];
  recommendations: string[];
}

export interface TeamRow {
  id: string;
  employee_no: string;
  full_name: string;
  username: string;
  job_title?: string;
  salary_amount: string;
  salary_frequency: 'daily' | 'weekly' | 'monthly';
  role_name?: string;
  /**
   * Target hours per working day (from `users.target_hours_day`).
   * Used for the Team list shortage / overtime columns. Server falls
   * back to 8 when the column is NULL.
   */
  target_hours_day: number | string | null;
  shift_start_time: string | null;
  shift_end_time: string | null;
  late_grace_min: number | null;
  minutes_this_month: number;
  /** Sum of (duration_min − target_minutes_day) on closed days when positive. */
  overtime_minutes_this_month: number;
  /** Sum of (target_minutes_day − duration_min) on closed days when positive. */
  shortage_minutes_this_month: number;
  /** Sum of clock-in lateness past shift_start_time + grace, Cairo TZ. */
  late_minutes_this_month: number;
  /** Sum of clock-out earliness before shift_end_time, Cairo TZ. */
  early_leave_minutes_this_month: number;
  advances_this_month: string;
  bonuses_this_month: string;
  open_tasks: number;
  pending_requests: number;
  /**
   * Canonical GL balance from v_employee_gl_balance. Positive =
   * employee owes company; negative = company owes employee.
   */
  gl_balance: string | number;
}

export const employeesApi = {
  dashboard: (month?: string) =>
    unwrap<EmployeeDashboard>(
      api.get('/employees/me/dashboard', {
        params: month ? { month } : undefined,
      }),
    ),

  myTasks: () => unwrap<EmployeeTask[]>(api.get('/employees/me/tasks')),
  ackTask: (id: string | number) =>
    unwrap<EmployeeTask>(api.post(`/employees/me/tasks/${id}/acknowledge`, {})),
  completeTask: (id: string | number) =>
    unwrap<EmployeeTask>(api.post(`/employees/me/tasks/${id}/complete`, {})),

  myRequests: () =>
    unwrap<EmployeeRequest[]>(api.get('/employees/me/requests')),
  submitRequest: (body: {
    kind: SubmitRequestKind;
    amount?: number;
    starts_at?: string;
    ends_at?: string;
    reason?: string;
  }) => unwrap<EmployeeRequest>(api.post('/employees/me/requests', body)),

  /**
   * PR-ESS-2A — self-service salary-advance REQUEST submission.
   *
   * Inserts an `employee_requests` row with `kind='advance'` and
   * `status='pending'`. **REQUEST-ONLY** — this never moves money,
   * never triggers GL/cashbox writes, never creates an expense, and
   * never invokes FinancialEngineService. Approval flips status to
   * `'approved'` only; the actual disbursement remains the operator's
   * separate Daily Expense step (PR-ESS-2B will link the two).
   *
   * In the UI an approved advance request must be labelled "موافق
   * عليه — بانتظار الصرف" (NOT "تم الصرف") so neither operators nor
   * employees mistake an approved request for a money movement.
   */
  submitAdvanceRequest: (body: {
    amount: number;
    reason: string;
    notes?: string;
  }) =>
    unwrap<EmployeeRequest>(
      api.post('/employees/me/requests/advance', body),
    ),

  // Admin / HR
  team: () => unwrap<TeamRow[]>(api.get('/employees/team')),
  pendingRequests: () =>
    unwrap<EmployeeRequest[]>(api.get('/employees/requests/pending')),
  decideRequest: (
    id: string | number,
    body: { decision: 'approved' | 'rejected'; reason?: string },
  ) => unwrap<EmployeeRequest>(api.post(`/employees/requests/${id}/decide`, body)),

  userDashboard: (id: string, month?: string) =>
    unwrap<EmployeeDashboard>(
      api.get(`/employees/${id}/dashboard`, {
        params: month ? { month } : undefined,
      }),
    ),

  updateProfile: (
    id: string,
    body: Partial<{
      employee_no: string;
      job_title: string;
      hire_date: string;
      salary_amount: number;
      salary_frequency: 'daily' | 'weekly' | 'monthly';
      target_hours_day: number;
      target_hours_week: number;
      overtime_rate: number;
      shift_start_time: string;
      shift_end_time: string;
      late_grace_min: number;
    }>,
  ) => unwrap<any>(api.patch(`/employees/${id}/profile`, body)),

  addBonus: (
    id: string,
    body: { amount: number; kind?: string; note?: string; bonus_date?: string },
  ) => unwrap<any>(api.post(`/employees/${id}/bonuses`, body)),

  addDeduction: (
    id: string,
    body: { amount: number; reason: string; deduction_date?: string },
  ) => unwrap<any>(api.post(`/employees/${id}/deductions`, body)),

  createTask: (body: {
    user_id: string;
    title: string;
    description?: string;
    priority?: 'low' | 'normal' | 'high' | 'urgent';
    due_at?: string;
  }) => unwrap<EmployeeTask>(api.post('/employees/tasks', body)),
  cancelTask: (id: string | number) =>
    unwrap<EmployeeTask>(api.post(`/employees/tasks/${id}/cancel`, {})),

  myHistory: (from?: string, to?: string) =>
    unwrap<{
      target_hours_day: number;
      hourly_rate: number;
      full_day_wage: number;
      overtime_rate: number;
      days: Array<{
        day: string;
        minutes: number;
        overtime_min: number;
        undertime_min: number;
        /** Target minutes for the day (target_hours_day × 60). */
        target_min: number;
        /** Lateness past shift_start + grace, Cairo TZ, in minutes. */
        late_min: number;
        /** Early-leave before shift_end, Cairo TZ, in minutes. */
        early_leave_min: number;
        first_in: string | null;
        last_out: string | null;
        bonuses: string;
        deductions: string;
        advances: string;
        hourly_rate: number;
        overtime_hourly_rate: number;
        full_day_wage: number;
        earned_hours_based: number;
        earned_overtime: number;
        earned_regular: number;
      }>;
    }>(
      api.get('/employees/me/history', {
        params: from || to ? { from, to } : undefined,
      }),
    ),

  userHistory: (id: string, from?: string, to?: string) =>
    unwrap<{
      target_hours_day: number;
      days: Array<any>;
    }>(
      api.get(`/employees/${id}/history`, {
        params: from || to ? { from, to } : undefined,
      }),
    ),

  // ── Financial ledger (migration 060) ─────────────────────────────
  myLedger: (from?: string, to?: string) =>
    unwrap<EmployeeLedger>(
      api.get('/employees/me/ledger', {
        params: from || to ? { from, to } : undefined,
      }),
    ),

  userLedger: (id: string, from?: string, to?: string) =>
    unwrap<EmployeeLedger>(
      api.get(`/employees/${id}/ledger`, {
        params: from || to ? { from, to } : undefined,
      }),
    ),

  addSettlement: (
    id: string,
    body: {
      amount: number;
      settlement_date?: string;
      method?: 'cash' | 'bank' | 'payroll_deduction' | 'other';
      cashbox_id?: string;
      notes?: string;
      /**
       * PR-EMP-FIX — explicit open-shift linkage. When the operator
       * picks "from open shift" in CashSourceSelector, this MUST be
       * forwarded; otherwise the backend treats the settlement as a
       * direct-cashbox payout and demands the
       * `employees.settlement.direct_cashbox` permission. Same shape
       * as PayWageModal.adminPayWage and the backend
       * recordSettlement DTO (employees.service.ts:1355).
       */
      shift_id?: string;
    },
  ) => unwrap<any>(api.post(`/employees/${id}/settlements`, body)),
};

export interface EmployeeLedgerEntry {
  event_date: string;
  entry_type:
    | 'shift_shortage'
    | 'advance'
    | 'deduction'
    | 'penalty'
    | 'settlement'
    | 'bonus';
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
}

export interface EmployeeGlLedgerEntry {
  entry_no: string;
  entry_date: string;
  reference_type: string;
  reference_id: string;
  description: string;
  account_code: '1123' | '213' | string;
  account_name: string;
  debit: number;
  credit: number;
  /** debit − credit. Positive pushes balance up (owes company more).
   *  Always 0 for voided rows — they have no economic effect. */
  signed_effect: number;
  running_balance: number;
  /** PR-25 — voided JEs are now included in the response (so admins
   *  can see what was reverted). Render with strikethrough + "ملغاة"
   *  chip; signed_effect is forced to 0 server-side. */
  is_voided?: boolean;
  void_reason?: string | null;
}

export interface EmployeeLedger {
  user: {
    id: string;
    full_name: string;
    username: string;
    employee_no: string;
    job_title?: string;
  };
  opening_balance: number;
  /**
   * Running balance from v_employee_ledger (source tables). Kept for
   * the "كيف حُسب الرصيد" breakdown — may differ from `gl_balance`
   * when opening-balance or reclassification JEs exist.
   */
  closing_balance: number;
  /**
   * GL-based opening/closing truncated at (from − 1 day) / to. Both
   * are NULL when `from`/`to` aren't supplied. Use these for the
   * main post-reset monthly ledger header.
   */
  gl_opening_balance: number | null;
  gl_closing_balance: number | null;
  /**
   * Canonical headline. From v_employee_gl_balance (COA 1123 + 213,
   * migration 075). Positive = employee owes company; negative =
   * company owes employee.
   */
  gl_balance: number;
  /**
   * Canonical ledger — every posted non-void journal_line tagged with
   * the employee on accounts 1123 / 213, with running balance. Use
   * this as the audit trail behind `gl_balance`. Includes
   * opening-balance resets and reclassification JEs.
   */
  gl_entries: EmployeeGlLedgerEntry[];
  entries: EmployeeLedgerEntry[];
  totals: {
    shortages: number;
    advances: number;
    manual_deductions: number;
    settlements: number;
    bonuses: number;
  };
}
