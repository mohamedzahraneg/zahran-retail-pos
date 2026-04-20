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
};
