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
  salary: {
    amount: number;
    frequency: 'daily' | 'weekly' | 'monthly';
    expected: number;
    accrued: number;
    bonuses: number;
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
  minutes_this_month: number;
  advances_this_month: string;
  bonuses_this_month: string;
  open_tasks: number;
  pending_requests: number;
}

export const employeesApi = {
  dashboard: () =>
    unwrap<EmployeeDashboard>(api.get('/employees/me/dashboard')),

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

  // Admin / HR
  team: () => unwrap<TeamRow[]>(api.get('/employees/team')),
  pendingRequests: () =>
    unwrap<EmployeeRequest[]>(api.get('/employees/requests/pending')),
  decideRequest: (
    id: string | number,
    body: { decision: 'approved' | 'rejected'; reason?: string },
  ) => unwrap<EmployeeRequest>(api.post(`/employees/requests/${id}/decide`, body)),

  userDashboard: (id: string) =>
    unwrap<EmployeeDashboard>(api.get(`/employees/${id}/dashboard`)),

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

export interface EmployeeLedger {
  user: {
    id: string;
    full_name: string;
    username: string;
    employee_no: string;
    job_title?: string;
  };
  opening_balance: number;
  closing_balance: number;
  entries: EmployeeLedgerEntry[];
  totals: {
    shortages: number;
    advances: number;
    manual_deductions: number;
    settlements: number;
    bonuses: number;
  };
}
