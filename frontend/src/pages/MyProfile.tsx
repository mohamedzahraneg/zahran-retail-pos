/**
 * MyProfile — PR-ESS-2A
 * ────────────────────────────────────────────────────────────────────
 *
 * The /me self-service personal employee file. Mirrors the Team
 * Management workspace layout but in READ-ONLY self mode — every
 * admin mutation surface is hidden. Only three action buttons are
 * exposed at the top of the page:
 *
 *   · حضور / انصراف
 *   · تقديم طلب إجازة
 *   · تقديم طلب سلفة
 *
 * Five tabs (matching the user spec):
 *   1. نظرة عامة                      → EmployeeOverviewTab    mode='self'
 *   2. السلف والخصومات والمكافآت     → AdjustmentsTab         mode='self'
 *   3. القبض والصرف                   → AccountsMovementsTab   mode='self'
 *   4. سجل الحضور والانصراف          → AttendanceWageTab      mode='self'
 *   5. السجلات النقدية                → CashRecordsTab         (self-only)
 *
 * The four Team tab components are reused as-is (with the new mode
 * prop they already accept), so this page is a shell that wires data
 * + tab navigation + the live attendance countdown. Manager / admin
 * Team Management view is untouched — it continues to render with
 * `mode='admin'` (the default).
 *
 * Data flow:
 *   · `/employees/me/dashboard` → profile, attendance.today, salary,
 *     gl. Drives the header + countdown.
 *   · `/attendance/me/today`    → today's clock-in/out for the
 *     "حضور / انصراف" toggle.
 *   · The 4 reused tabs each fetch their own data from /me/* endpoints.
 *
 * REQUEST-ONLY semantics: the leave + advance request modals open
 * from this header and submit to `POST /me/requests` and
 * `POST /me/requests/advance` respectively. Neither path moves money.
 * Approval flips status only; disbursement (PR-ESS-2B) is the
 * operator's separate Daily Expenses step.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  ClipboardList,
  Wallet2,
  Receipt,
  CalendarCheck,
  Banknote,
  CalendarRange,
  Coins,
  LogIn,
  LogOut,
  User,
} from 'lucide-react';
import {
  employeesApi,
  EmployeeDashboard,
  TeamRow,
} from '@/api/employees.api';
import { attendanceApi, AttendanceRecord } from '@/api/attendance.api';
import { EmployeeOverviewTab } from '@/components/team/EmployeeOverviewTab';
import { AdjustmentsTab } from '@/components/team/AdjustmentsTab';
import { AccountsMovementsTab } from '@/components/team/AccountsMovementsTab';
import { AttendanceWageTab } from '@/components/team/AttendanceWageTab';
import { CashRecordsTab } from '@/components/me/CashRecordsTab';
import { AttendanceCountdown } from '@/components/me/AttendanceCountdown';
import { LeaveRequestModal } from '@/components/me/LeaveRequestModal';
import { AdvanceRequestModal } from '@/components/me/AdvanceRequestModal';
import { MyRequestsCard } from '@/components/me/MyRequestsCard';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

type TabKey =
  | 'summary'
  | 'adjustments'
  | 'payments'
  | 'attendance'
  | 'cash';

interface TabDef {
  key: TabKey;
  label: string;
  icon: React.ReactNode;
}

const TABS: TabDef[] = [
  { key: 'summary',     label: 'نظرة عامة',                  icon: <ClipboardList size={15} /> },
  { key: 'adjustments', label: 'السلف والخصومات والمكافآت', icon: <Receipt size={15} /> },
  { key: 'payments',    label: 'القبض والصرف',               icon: <Wallet2 size={15} /> },
  { key: 'attendance',  label: 'سجل الحضور والانصراف',      icon: <CalendarCheck size={15} /> },
  { key: 'cash',        label: 'السجلات النقدية',            icon: <Banknote size={15} /> },
];

/**
 * Builds a synthetic TeamRow from the /me/dashboard response so the
 * reused Team tabs (which expect a TeamRow) get the right shape. The
 * fields used by the children in self mode are the basic identity +
 * working-hours config + salary; everything else is filled with safe
 * defaults (the Team list aggregates aren't shown in self-mode tabs).
 */
function teamRowFromDashboard(dash: EmployeeDashboard | undefined): TeamRow | null {
  if (!dash) return null;
  const p = dash.profile;
  return {
    id: p.id,
    employee_no: p.employee_no,
    full_name: p.full_name,
    username: p.username,
    job_title: p.job_title,
    salary_amount: String(p.salary_amount ?? 0),
    salary_frequency: p.salary_frequency,
    role_name: p.role_name,
    target_hours_day: p.target_hours_day,
    shift_start_time: p.shift_start_time ?? null,
    shift_end_time: p.shift_end_time ?? null,
    late_grace_min: p.late_grace_min != null ? Number(p.late_grace_min) : null,
    minutes_this_month: dash.attendance.month.minutes,
    overtime_minutes_this_month: 0,
    shortage_minutes_this_month: 0,
    late_minutes_this_month: 0,
    early_leave_minutes_this_month: 0,
    advances_this_month: '0',
    bonuses_this_month: '0',
    open_tasks: dash.tasks?.length ?? 0,
    pending_requests:
      dash.requests?.filter((r) => r.status === 'pending').length ?? 0,
    gl_balance: dash.gl.live_snapshot,
  };
}

export default function MyProfile() {
  const [tab, setTab] = useState<TabKey>('summary');
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [advanceOpen, setAdvanceOpen] = useState(false);

  const { data: dash } = useQuery({
    queryKey: ['my-dashboard'],
    queryFn: () => employeesApi.dashboard(),
  });

  const { data: todayRow, refetch: refetchToday } = useQuery({
    queryKey: ['my-today'],
    queryFn: () => attendanceApi.myToday(),
    refetchInterval: 60_000, // truth-source poll once a minute
  });

  const employee = useMemo(() => teamRowFromDashboard(dash), [dash]);

  const today = (todayRow as AttendanceRecord | null) ?? null;
  const checkedIn = !!today?.clock_in && !today?.clock_out;
  const checkedOut = !!today?.clock_in && !!today?.clock_out;

  const qc = useQueryClient();
  const clockInMut = useMutation({
    mutationFn: () => attendanceApi.clockIn(),
    onSuccess: () => {
      toast.success('تم تسجيل الحضور.');
      qc.invalidateQueries({ queryKey: ['my-today'] });
      qc.invalidateQueries({ queryKey: ['my-dashboard'] });
      refetchToday();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تسجيل الحضور'),
  });
  const clockOutMut = useMutation({
    mutationFn: () => attendanceApi.clockOut(),
    onSuccess: () => {
      toast.success('تم تسجيل الانصراف.');
      qc.invalidateQueries({ queryKey: ['my-today'] });
      qc.invalidateQueries({ queryKey: ['my-dashboard'] });
      refetchToday();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تسجيل الانصراف'),
  });

  return (
    <div className="space-y-5" dir="rtl">
      <ProfileHeader
        dash={dash}
        today={today}
        checkedIn={checkedIn}
        checkedOut={checkedOut}
        onClockIn={() => clockInMut.mutate()}
        onClockOut={() => clockOutMut.mutate()}
        onOpenLeave={() => setLeaveOpen(true)}
        onOpenAdvance={() => setAdvanceOpen(true)}
        clockBusy={clockInMut.isPending || clockOutMut.isPending}
      />

      <AttendanceCountdown
        clockInISO={today?.clock_in ?? null}
        clockOutISO={today?.clock_out ?? null}
        profile={dash?.profile ?? null}
      />

      {/* Tabs nav */}
      <div className="flex items-center gap-1 overflow-x-auto bg-white rounded-2xl border border-slate-200 p-2 shadow-sm">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`shrink-0 inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold transition ${
              tab === t.key
                ? 'bg-indigo-600 text-white border border-indigo-700'
                : 'bg-white text-slate-700 border border-slate-200 hover:bg-slate-50'
            }`}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div>
        {tab === 'summary' && (
          <div className="space-y-5">
            {employee ? (
              <EmployeeOverviewTab employee={employee} mode="self" />
            ) : (
              <PlaceholderCard text="جارٍ التحميل…" />
            )}
            <LeaveBalancePlaceholder />
            <MyRequestsCard />
          </div>
        )}
        {tab === 'adjustments' && (
          employee ? (
            <AdjustmentsTab employee={employee} mode="self" />
          ) : (
            <PlaceholderCard text="جارٍ التحميل…" />
          )
        )}
        {tab === 'payments' && (
          employee ? (
            <AccountsMovementsTab employee={employee} mode="self" />
          ) : (
            <PlaceholderCard text="جارٍ التحميل…" />
          )
        )}
        {tab === 'attendance' && (
          employee ? (
            <AttendanceWageTab employee={employee} mode="self" />
          ) : (
            <PlaceholderCard text="جارٍ التحميل…" />
          )
        )}
        {tab === 'cash' && <CashRecordsTab />}
      </div>

      {/* Modals */}
      {leaveOpen && <LeaveRequestModal onClose={() => setLeaveOpen(false)} />}
      {advanceOpen && (
        <AdvanceRequestModal onClose={() => setAdvanceOpen(false)} />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Header
 * ───────────────────────────────────────────────────────────────── */

type StatusKey = 'present' | 'left' | 'absent';

function ProfileHeader({
  dash,
  today,
  checkedIn,
  checkedOut,
  onClockIn,
  onClockOut,
  onOpenLeave,
  onOpenAdvance,
  clockBusy,
}: {
  dash?: EmployeeDashboard;
  today: AttendanceRecord | null;
  checkedIn: boolean;
  checkedOut: boolean;
  onClockIn: () => void;
  onClockOut: () => void;
  onOpenLeave: () => void;
  onOpenAdvance: () => void;
  clockBusy: boolean;
}) {
  const profile = dash?.profile;
  const status: StatusKey = checkedIn
    ? 'present'
    : checkedOut
      ? 'left'
      : 'absent';

  const statusToneMap: Record<StatusKey, string> = {
    present: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    left: 'bg-slate-100 text-slate-700 border-slate-200',
    absent: 'bg-amber-50 text-amber-800 border-amber-200',
  };
  const statusLabelMap: Record<StatusKey, string> = {
    present: 'حاضر',
    left: 'انصرف اليوم',
    absent: 'لم يبدأ الوردية',
  };

  return (
    <div className="rounded-2xl border border-indigo-200 bg-indigo-50/70 p-5 shadow-sm">
      <div className="flex items-start justify-between flex-wrap gap-4">
        <div className="flex items-start gap-3 min-w-0">
          <div className="w-12 h-12 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0">
            <User size={22} />
          </div>
          <div className="min-w-0">
            <h2 className="text-xl font-black text-indigo-900 truncate">
              {profile?.full_name || profile?.username || 'ملفي الشخصي'}
            </h2>
            <div className="text-xs text-indigo-900/70 mt-0.5 flex items-center gap-2 flex-wrap">
              {profile?.job_title && (
                <span className="font-bold">{profile.job_title}</span>
              )}
              {profile?.employee_no && (
                <span className="text-slate-500">
                  · رقم وظيفي {profile.employee_no}
                </span>
              )}
              <span
                className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold border ${statusToneMap[status]}`}
              >
                {statusLabelMap[status]}
              </span>
            </div>
            {profile && (
              <div className="text-[11px] text-indigo-900/70 mt-2 leading-relaxed flex items-center gap-3 flex-wrap">
                <span>
                  المرتب اليومي{' '}
                  <span className="font-bold">{EGP(profile.salary_amount)}</span>
                </span>
                {(profile.shift_start_time || profile.shift_end_time) && (
                  <span>
                    وردية{' '}
                    <span className="font-mono tabular-nums">
                      {profile.shift_start_time ?? '—'}
                    </span>{' '}
                    →{' '}
                    <span className="font-mono tabular-nums">
                      {profile.shift_end_time ?? '—'}
                    </span>
                  </span>
                )}
                <span>
                  ساعات اليوم المستهدفة{' '}
                  <span className="font-bold tabular-nums">
                    {profile.target_hours_day}
                  </span>
                </span>
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {checkedIn ? (
            <button
              type="button"
              onClick={onClockOut}
              disabled={clockBusy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-rose-600 text-white text-sm font-bold hover:bg-rose-700 disabled:opacity-50"
            >
              <LogOut size={15} />
              تسجيل انصراف
            </button>
          ) : checkedOut ? (
            <span className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-slate-100 text-slate-600 text-sm font-bold border border-slate-200">
              <LogOut size={15} />
              انصرفت اليوم
            </span>
          ) : (
            <button
              type="button"
              onClick={onClockIn}
              disabled={clockBusy}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-50"
            >
              <LogIn size={15} />
              تسجيل حضور
            </button>
          )}
          <button
            type="button"
            onClick={onOpenLeave}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white text-emerald-800 text-sm font-bold border border-emerald-200 hover:bg-emerald-50"
          >
            <CalendarRange size={15} />
            تقديم طلب إجازة
          </button>
          <button
            type="button"
            onClick={onOpenAdvance}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-white text-violet-800 text-sm font-bold border border-violet-200 hover:bg-violet-50"
          >
            <Coins size={15} />
            تقديم طلب سلفة
          </button>
        </div>
      </div>

      {today?.clock_in && (
        <div className="text-[11px] text-indigo-900/70 mt-3">
          سجلت الحضور اليوم في{' '}
          <span className="font-mono tabular-nums">
            {new Date(today.clock_in).toLocaleTimeString('en-GB', {
              timeZone: 'Africa/Cairo',
              hour: '2-digit',
              minute: '2-digit',
              hour12: false,
            })}
          </span>
          {today.clock_out
            ? ` · والانصراف في ${new Date(today.clock_out).toLocaleTimeString(
                'en-GB',
                {
                  timeZone: 'Africa/Cairo',
                  hour: '2-digit',
                  minute: '2-digit',
                  hour12: false,
                },
              )}`
            : ' · لم تنصرف بعد'}
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Placeholders
 * ───────────────────────────────────────────────────────────────── */

function LeaveBalancePlaceholder() {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50/60 p-4 shadow-sm">
      <div className="text-xs text-slate-600 leading-relaxed">
        <span className="font-bold text-slate-800">رصيد الإجازات:</span>{' '}
        غير مفعل حاليًا — سيتم تفعيل احتساب رصيد الإجازات في تحديث لاحق.
      </div>
    </div>
  );
}

function PlaceholderCard({ text }: { text: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-8 shadow-sm">
      <div className="text-center text-xs text-slate-400">{text}</div>
    </div>
  );
}
