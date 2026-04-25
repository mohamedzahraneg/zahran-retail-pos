import { api, unwrap } from './client';

export interface AttendanceRecord {
  id: string;
  user_id: string;
  work_date: string;
  clock_in: string | null;
  clock_out: string | null;
  duration_min: number | null;
  note: string | null;
  ip_in: string | null;
  ip_out: string | null;
  device_in: any;
  device_out: any;
  username?: string;
  full_name?: string;
  role_name?: string;
}

export interface AttendanceSummaryRow {
  user_id: string;
  username: string;
  full_name: string;
  days_present: number;
  total_minutes: number;
  first_in: string | null;
  last_out: string | null;
}

export interface PayableDayRow {
  id: string;
  user_id: string;
  work_date: string;
  kind: 'wage_accrual';
  source: 'attendance' | 'admin_manual';
  attendance_record_id: string | null;
  worked_minutes: number | null;
  daily_wage_snapshot: string | number;
  target_minutes_snapshot: number | null;
  amount_accrued: string | number;
  journal_entry_id: string | null;
  reason: string | null;
  is_void: boolean;
  void_reason: string | null;
  voided_at: string | null;
  voided_by: string | null;
  created_by: string;
  created_at: string;
  entry_no?: string;
  je_is_void?: boolean;
  // PR-3 — wage approval metadata
  calculated_amount?: string | number | null;
  override_type?: 'calculated' | 'full_day' | 'custom_amount';
  approval_reason?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
}

export const attendanceApi = {
  myToday: () =>
    unwrap<AttendanceRecord | null>(api.get('/attendance/me/today')),

  clockIn: (note?: string) =>
    unwrap<AttendanceRecord>(api.post('/attendance/clock-in', { note })),

  clockOut: (note?: string) =>
    unwrap<AttendanceRecord>(api.post('/attendance/clock-out', { note })),

  list: (params?: {
    user_id?: string;
    from?: string;
    to?: string;
    limit?: number;
  }) =>
    unwrap<AttendanceRecord[]>(api.get('/attendance', { params })),

  summary: (from?: string, to?: string) =>
    unwrap<AttendanceSummaryRow[]>(
      api.get('/attendance/summary', { params: { from, to } }),
    ),

  adjust: (
    id: string,
    body: { clock_in?: string; clock_out?: string; note?: string },
  ) => unwrap<AttendanceRecord>(api.patch(`/attendance/${id}`, body)),

  // ── Admin-on-behalf + wage accrual (employee.attendance.manage) ──────
  adminClockIn: (body: { user_id: string; note?: string }) =>
    unwrap<AttendanceRecord>(api.post('/attendance/admin/clock-in', body)),

  adminClockOut: (body: { user_id: string; note?: string }) =>
    unwrap<AttendanceRecord>(api.post('/attendance/admin/clock-out', body)),

  adminMarkPayableDay: (body: {
    user_id: string;
    work_date: string;
    reason: string;
  }) =>
    unwrap<{ payable_day_id: string }>(
      api.post('/attendance/admin/mark-payable-day', body),
    ),

  adminApproveWage: (attendanceId: string) =>
    unwrap<{ payable_day_id: string }>(
      api.post(`/attendance/admin/approve-wage/${attendanceId}`, {}),
    ),

  adminVoidAccrual: (payableDayId: string, body: { reason: string }) =>
    unwrap<{ payable_day_id: string }>(
      api.post(`/attendance/admin/void-accrual/${payableDayId}`, body),
    ),

  payableDays: (params: { user_id: string; from?: string; to?: string }) =>
    unwrap<PayableDayRow[]>(api.get('/attendance/payable-days', { params })),

  /**
   * Daily-wage payout. Settles the payable portion (DR 213 / CR cashbox);
   * any excess must be classified explicitly as 'advance' (DR 1123 /
   * CR cashbox) or 'bonus' (DR 521 / CR 213 then DR 213 / CR cashbox).
   */
  /**
   * PR-3 — explicit approval of an existing or new payable day with
   * three modes: calculated (hours-based), full_day (canonical), or
   * custom_amount (admin-typed). Voids any existing live accrual for
   * the (user, work_date) and posts a new one with the chosen mode.
   * No cashbox movement — accrual only.
   */
  adminApproveWageOverride: (body: {
    user_id: string;
    work_date: string;
    override_type: 'calculated' | 'full_day' | 'custom_amount';
    approved_amount?: number;
    approval_reason?: string;
    reason?: string;
  }) =>
    unwrap<{ payable_day_id: string }>(
      api.post('/attendance/admin/approve-wage-override', body),
    ),

  adminPayWage: (body: {
    user_id: string;
    amount: number;
    cashbox_id: string;
    excess_handling?: 'advance' | 'bonus';
    notes?: string;
    /** PR-15 — explicit shift linkage from the source selector. */
    shift_id?: string;
  }) =>
    unwrap<{
      payable_before: number;
      payable_amount_settled: number;
      excess_amount: number;
      excess_handling: 'advance' | 'bonus' | null;
      settlement_ids: string[];
      bonus_id: number | null;
      advance_expense_id: string | null;
    }>(api.post('/attendance/admin/pay-wage', body)),
};
