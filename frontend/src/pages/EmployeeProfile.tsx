import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Briefcase,
  Clock,
  DollarSign,
  AlertTriangle,
  CheckCircle2,
  ListTodo,
  MessageSquare,
  Plus,
  X,
  Lightbulb,
  Archive,
  Info,
  ShieldCheck,
} from 'lucide-react';
import {
  employeesApi,
  EmployeeDashboard,
  EmployeeTask,
  type SubmitRequestKind,
} from '@/api/employees.api';
import { attendanceApi } from '@/api/attendance.api';
import { useAuthStore } from '@/stores/auth.store';
import { invalidateMonthly } from '@/utils/employee-cache';
import { CashSourceSelector, CashSource } from '@/components/CashSourceSelector';

// ═══ Month picker helpers ═════════════════════════════════════════════
// Single place for YYYY-MM parsing / default / bounds so the page and
// all child cards stay consistent.

function currentMonthCairo(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  return `${y}-${m}`;
}

function monthBounds(month: string): { from: string; to: string } {
  const match = /^(\d{4})-(\d{2})$/.exec(month);
  const y = match ? Number(match[1]) : new Date().getUTCFullYear();
  const m = match ? Number(match[2]) : new Date().getUTCMonth() + 1;
  const first = `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-01`;
  const lastDate = new Date(Date.UTC(y, m, 1));
  lastDate.setUTCDate(lastDate.getUTCDate() - 1);
  const last =
    lastDate.getUTCFullYear() +
    '-' +
    String(lastDate.getUTCMonth() + 1).padStart(2, '0') +
    '-' +
    String(lastDate.getUTCDate()).padStart(2, '0');
  return { from: first, to: last };
}

function addMonths(month: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(month) || ['', '2026', '01'];
  let y = Number(match[1]);
  let m = Number(match[2]) + delta;
  while (m <= 0) {
    y -= 1;
    m += 12;
  }
  while (m > 12) {
    y += 1;
    m -= 12;
  }
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}`;
}

function monthLabelArabic(month: string): string {
  const { from } = monthBounds(month);
  const d = new Date(from + 'T00:00:00');
  return d.toLocaleDateString('ar-EG-u-ca-gregory', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: 'long',
  });
}

/**
 * Month picker + URL sync. Drives the whole Employee Profile month
 * scope. Default = current Cairo month. Persists selection in the
 * `?m=YYYY-MM` query param so refresh / deep-link survives.
 */
function useMonthSelector(): {
  month: string;
  setMonth: (m: string) => void;
  isCurrent: boolean;
  label: string;
  from: string;
  to: string;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const cur = currentMonthCairo();
  const raw = searchParams.get('m') || '';
  const month = /^\d{4}-\d{2}$/.test(raw) ? raw : cur;

  const setMonth = (next: string) => {
    const clean = /^\d{4}-\d{2}$/.test(next) ? next : cur;
    const copy = new URLSearchParams(searchParams);
    if (clean === cur) {
      copy.delete('m');
    } else {
      copy.set('m', clean);
    }
    setSearchParams(copy, { replace: false });
  };

  const { from, to } = monthBounds(month);
  return {
    month,
    setMonth,
    isCurrent: month === cur,
    label: monthLabelArabic(month),
    from,
    to,
  };
}

// `invalidateMonthly` and the canonical query-key list moved to
// `frontend/src/utils/employee-cache.ts` in PR-1 so Attendance.tsx
// can use the same broad invalidation. Imported above.

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;

function fmtMinutes(min: number) {
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${h}س ${String(m).padStart(2, '0')}د`;
}

function fmtWhen(s?: string) {
  if (!s) return '';
  const d = new Date(s);
  const dow = d.toLocaleDateString('ar-EG', {
    timeZone: 'Africa/Cairo',
    weekday: 'long',
  });
  const rest = d.toLocaleString('ar-EG', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  return `${dow} · ${rest}`;
}

/**
 * Live elapsed-time counter since the given timestamp. Ticks every
 * second. Used for "you've been clocked in for Xhr Ymin Zsec".
 */
function LiveElapsed({ since }: { since: string | null | undefined }) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!since) return;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [since]);
  if (!since) return null;
  const ms = now.getTime() - new Date(since).getTime();
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return (
    <span className="tabular-nums font-black">
      {String(h).padStart(2, '0')}:{String(m).padStart(2, '0')}:
      {String(sec).padStart(2, '0')}
    </span>
  );
}

/**
 * Smart countdown to the expected end-of-shift. Shows:
 *   • Time remaining until the target is reached (green)
 *   • If past target: overtime accrued so far (amber) with a + sign
 * Ticks every second. No-op if no clock-in.
 */
function ShiftCountdown({
  clockIn,
  expectedEnd,
}: {
  clockIn: string | null;
  expectedEnd: string | null;
}) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    if (!clockIn || !expectedEnd) return;
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, [clockIn, expectedEnd]);
  if (!clockIn || !expectedEnd) return null;

  const endMs = new Date(expectedEnd).getTime();
  const diffMs = endMs - now.getTime();
  const past = diffMs < 0;
  const abs = Math.abs(diffMs);
  const s = Math.floor(abs / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const fmt = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;

  return (
    <div
      className={`text-xs flex items-center gap-1.5 font-bold ${
        past ? 'text-amber-100' : 'text-emerald-100'
      }`}
    >
      {past ? '🟡 ساعات إضافية' : '🟢 متبقي للهدف'}
      <span className="tabular-nums">{past ? '+' : ''}{fmt}</span>
    </div>
  );
}

/** Live date + day + clock (HH:MM:SS) in Cairo time. */
function LiveDateTime() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const dow = now.toLocaleDateString('ar-EG', {
    timeZone: 'Africa/Cairo',
    weekday: 'long',
  });
  const date = now.toLocaleDateString('ar-EG-u-ca-gregory', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });
  const clock = now.toLocaleTimeString('ar-EG', {
    timeZone: 'Africa/Cairo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  return (
    <div className="bg-white/15 backdrop-blur-sm border border-white/25 rounded-xl px-3 py-2 text-white flex items-center gap-3 text-xs">
      <span className="opacity-90">{dow}</span>
      <span className="opacity-90">·</span>
      <span className="opacity-90">{date}</span>
      <span className="opacity-90">·</span>
      <span className="tabular-nums font-black text-sm">{clock}</span>
    </div>
  );
}

export default function EmployeeProfile() {
  const monthSel = useMonthSelector();

  const { data, isLoading } = useQuery({
    queryKey: ['employee-dashboard', 'me', monthSel.month],
    queryFn: () => employeesApi.dashboard(monthSel.month),
    refetchInterval: 30_000,
  });

  if (isLoading || !data) {
    return (
      <div className="card p-12 text-center text-slate-500">
        جارٍ تحميل ملفك…
      </div>
    );
  }
  return <EmployeeDashboardBody data={data} monthSel={monthSel} />;
}

type MonthSelector = ReturnType<typeof useMonthSelector>;

function EmployeeDashboardBody({
  data,
  monthSel,
}: {
  data: EmployeeDashboard;
  monthSel: MonthSelector;
}) {
  const qc = useQueryClient();
  const { profile, attendance, salary, tasks, requests, recommendations } = data;
  // Self-service /me intentionally renders no admin-on-behalf controls
  // — those moved to the Team drawer in this PR. We still keep the
  // monthly view + self-clock + attendance log here.
  const wage = data.wage;
  const gl = data.gl;
  const ledgerReset = data.ledger_reset;
  const showArchive = !!ledgerReset?.has_reset;

  const clockIn = useMutation({
    mutationFn: () => attendanceApi.clockIn(),
    onSuccess: () => {
      toast.success('تم تسجيل حضورك');
      invalidateMonthly(qc);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تسجيل الحضور'),
  });
  const clockOut = useMutation({
    mutationFn: () => attendanceApi.clockOut(),
    onSuccess: () => {
      toast.success('تم تسجيل انصرافك');
      invalidateMonthly(qc);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تسجيل الانصراف'),
  });

  const clockInAt = attendance.today?.clock_in || null;
  const clockOutAt = attendance.today?.clock_out || null;
  const isClockedIn = clockInAt && !clockOutAt;
  const lateMin = Number(attendance.today_late_minutes || 0);
  const earlyMin = Number(attendance.today_early_leave_minutes || 0);

  // Target minutes for today
  const targetDayMin = Math.round(
    Number((profile as any).target_hours_day || 8) * 60,
  );
  const monthHours = attendance.month.minutes / 60;

  return (
    <div className="space-y-5">
      {/* ─── Profile header card ─── */}
      <div className="card p-5 bg-gradient-to-br from-indigo-700 via-indigo-600 to-violet-600 text-white">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-white/20 border border-white/20 flex items-center justify-center">
              <Briefcase size={26} />
            </div>
            <div>
              <div className="text-[11px] uppercase tracking-widest text-white/80">
                ملف الموظف
              </div>
              <div className="text-2xl font-black mt-1 text-white">
                {profile.full_name}
              </div>
              <div className="text-xs flex items-center gap-2 mt-1 flex-wrap">
                <span className="chip bg-white/20 border-white/30 font-mono text-[11px] text-white">
                  {profile.employee_no}
                </span>
                {profile.job_title && (
                  <span className="text-white/90">{profile.job_title}</span>
                )}
                {profile.role_name && (
                  <span className="chip bg-white/20 border-white/30 text-[11px] text-white">
                    {profile.role_name}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="text-center">
            <div className="text-[11px] text-white/80 mb-1">
              {isClockedIn
                ? 'منذ تسجيل الحضور'
                : clockOutAt
                  ? 'انصرفت اليوم'
                  : 'لم تسجّل حضورك'}
            </div>
            {isClockedIn ? (
              <div>
                <div className="text-3xl text-white">
                  <LiveElapsed since={clockInAt} />
                </div>
                {attendance.expected_end_utc && (
                  <ShiftCountdown
                    clockIn={clockInAt}
                    expectedEnd={attendance.expected_end_utc}
                  />
                )}
              </div>
            ) : (
              <div className="text-xl font-bold text-white">
                {clockOutAt ? 'شكراً لجهدك' : '—'}
              </div>
            )}
            <div className="mt-2 flex gap-2 justify-center">
              {!isClockedIn && !clockOutAt && (
                <button
                  className="px-3 py-1.5 rounded-lg bg-white text-indigo-700 text-xs font-black"
                  onClick={() => clockIn.mutate()}
                  disabled={clockIn.isPending}
                >
                  تسجيل حضور
                </button>
              )}
              {isClockedIn && (
                <button
                  className="px-3 py-1.5 rounded-lg bg-white text-indigo-700 text-xs font-black"
                  onClick={() => clockOut.mutate()}
                  disabled={clockOut.isPending}
                >
                  تسجيل انصراف
                </button>
              )}
            </div>
          </div>
        </div>
        {/* Live date + day + clock — always visible, distinct from the
            attendance timer above. */}
        <div className="mt-4 flex justify-start">
          <LiveDateTime />
        </div>
      </div>

      {/* ─── Shift-timing warnings ─── */}
      {(lateMin > 0 || earlyMin > 0 || (data.warnings?.length || 0) > 0) && (
        <div className="card p-4 border-2 border-rose-200 bg-rose-50">
          <div className="flex items-start gap-2">
            <AlertTriangle
              className="text-rose-600 flex-shrink-0 mt-0.5"
              size={18}
            />
            <div className="flex-1">
              <div className="font-black text-rose-800 text-sm mb-1">
                تنبيهات مواعيد اليوم
              </div>
              <ul className="space-y-1 text-xs text-rose-900">
                {(data.warnings || []).map((w, i) => (
                  <li key={i}>• {w.message}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* ─── Recommendations + warnings ─── */}
      {recommendations.length > 0 && (
        <div className="card p-4 border-2 border-amber-200 bg-amber-50">
          <div className="flex items-start gap-2">
            <AlertTriangle className="text-amber-600 flex-shrink-0 mt-0.5" size={18} />
            <div>
              <div className="font-black text-amber-800 text-sm mb-1">
                توصية ذكية
              </div>
              <ul className="space-y-1 text-xs text-amber-900">
                {recommendations.map((r, i) => (
                  <li key={i}>• {r}</li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      )}

      {/* ─── Month selector ─── */}
      <MonthSelectorBar monthSel={monthSel} />

      {/* Self-service profile only — admin attendance controls live
          in /team → الحضور واليوميات (AttendanceWageTab). The legacy
          AdminAttendancePanel that used to live here was removed in
          PR-T6 cleanup; the Team workspace now owns that flow. */}

      {/* ─── Attendance cards (monthly) ─── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <MetricCard
          label="ساعات اليوم"
          value={
            !monthSel.isCurrent
              ? '—'
              : attendance.today?.duration_min
                ? fmtMinutes(Number(attendance.today.duration_min))
                : isClockedIn
                  ? 'مستمر'
                  : '—'
          }
          hint={
            monthSel.isCurrent
              ? `هدف ${(targetDayMin / 60).toFixed(1)}س`
              : 'الشهر الحالي فقط'
          }
          tone="indigo"
          icon={<Clock size={18} />}
        />
        <MetricCard
          label="ساعات الشهر"
          value={`${monthHours.toFixed(1)}س`}
          hint={monthSel.label}
          tone="emerald"
          icon={<Clock size={18} />}
        />
        <MetricCard
          label="أيام العمل"
          value={`${attendance.month.days} يوم`}
          hint={monthSel.label}
          tone="slate"
          icon={<Clock size={18} />}
        />
        <MetricCard
          label="آخر حضور"
          value={attendance.today?.clock_in ? fmtClockAr(attendance.today.clock_in) : '—'}
          hint={monthSel.isCurrent ? 'اليوم' : '—'}
          tone="emerald"
          icon={<Clock size={18} />}
        />
        <MetricCard
          label="آخر انصراف"
          value={attendance.today?.clock_out ? fmtClockAr(attendance.today.clock_out) : '—'}
          hint={monthSel.isCurrent ? 'اليوم' : '—'}
          tone="rose"
          icon={<Clock size={18} />}
        />
      </div>

      {/* ─── Main canonical post-reset cards ─── */}
      <div className="card p-4 border-2 border-indigo-100 bg-indigo-50/40">
        <div className="flex items-start gap-2 mb-3">
          <Info className="text-indigo-600 shrink-0 mt-0.5" size={16} />
          <div className="text-[11px] text-indigo-900 leading-relaxed">
            استحقاق اليومية لا يعني صرف نقدي. الصرف من الخزنة يتم فقط عند
            تسجيل صرف. الأرقام الرئيسية تعتمد على القيود المحاسبية
            والحركات الجديدة فقط.
          </div>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <MetricCard
            label="الرصيد النهائي من القيود"
            value={
              gl.live_snapshot > 0.01
                ? `مدين ${EGP(gl.live_snapshot)}`
                : gl.live_snapshot < -0.01
                  ? `مستحق له ${EGP(-gl.live_snapshot)}`
                  : 'متوازن'
            }
            hint={`افتتاحي ${EGP(gl.opening_balance)} · ختامي ${EGP(gl.closing_balance)}`}
            tone={
              gl.live_snapshot > 0.01
                ? 'rose'
                : gl.live_snapshot < -0.01
                  ? 'emerald'
                  : 'indigo'
            }
            icon={<DollarSign size={18} />}
          />
          <MetricCard
            label="استحقاق اليومية لهذا الشهر"
            value={EGP(wage.accrual_in_month)}
            hint={`${wage.accrual_count} يوم · يومية ${EGP(wage.daily_amount)}`}
            tone="indigo"
            icon={<DollarSign size={18} />}
          />
          <MetricCard
            label="المدفوع فعليًا خلال الشهر"
            value={EGP(wage.paid_in_month)}
            hint={`${wage.paid_count} تسوية`}
            tone="emerald"
            icon={<DollarSign size={18} />}
          />
          <MetricCard
            label="المتبقي مستحق"
            value={EGP(wage.remaining_from_month_accrual)}
            hint="استحقاق − مدفوع"
            tone={wage.remaining_from_month_accrual > 0.01 ? 'amber' : 'emerald'}
            icon={<DollarSign size={18} />}
          />
          <MetricCard
            label="السلف الجديدة خارج اليومية"
            value={EGP(salary.advances_month)}
            hint={monthSel.label}
            tone="amber"
            icon={<DollarSign size={18} />}
          />
          <MetricCard
            label="مكافآت / خصومات / جزاءات"
            value={`+${EGP(salary.bonuses)} / −${EGP(salary.deductions)}`}
            hint="ضمن الشهر المختار"
            tone="slate"
            icon={<DollarSign size={18} />}
          />
        </div>
      </div>

      {/* ─── Archived old-history section (collapsed by default) ───
          Kept so admins can audit pre-reset numbers, but nothing here
          drives the main cards above.  */}
      {showArchive && (
        <details className="card p-0 group">
          <summary className="cursor-pointer list-none p-4 flex items-center gap-2 select-none">
            <Archive className="text-slate-500 shrink-0" size={16} />
            <div className="min-w-0 flex-1">
              <div className="font-black text-slate-700 text-sm">
                السجل القديم قبل التصفير
              </div>
              <div className="text-[10px] text-slate-500 mt-0.5 break-words">
                تاريخ التصفير: {ledgerReset.date} · هذه الأرقام مصدرها
                الجداول الأصلية وليست هي الرصيد النهائي.
              </div>
            </div>
            <span className="text-[10px] text-slate-400 group-open:hidden">عرض ▾</span>
            <span className="text-[10px] text-slate-400 hidden group-open:inline">إخفاء ▴</span>
          </summary>
          <div className="px-4 pb-4 border-t border-slate-100 pt-4">
            <div className="text-[11px] text-slate-500 mb-3">
              الأرقام الرئيسية بعد التصفير تعتمد على القيود المحاسبية والحركات
              الجديدة فقط. السجل القديم متاح للأرشفة والمراجعة.
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
              <BreakdownRow
                label="مستحق حتى الآن (قديم)"
                value={EGP(salary.accrued)}
                tone="emerald"
              />
              <BreakdownRow
                label="حوافز ومكافآت (قديم)"
                value={EGP(salary.bonuses)}
                tone="indigo"
              />
              <BreakdownRow
                label="خصومات (قديم)"
                value={EGP(salary.deductions)}
                tone="rose"
              />
              <BreakdownRow
                label="سلف (قديم)"
                value={EGP(salary.advances_month)}
                tone="amber"
              />
              <BreakdownRow
                label="الصافي من الرواتب (قديم — ليس الرصيد النهائي)"
                value={EGP(salary.net)}
                tone={salary.debt_warning ? 'rose' : 'emerald'}
                big
              />
              <BreakdownRow
                label="إجمالي السلف عبر التاريخ"
                value={EGP(salary.advances_lifetime)}
                tone="amber"
              />
            </div>
          </div>
        </details>
      )}

      {/* ─── Tasks + Requests ─── */}
      <div className="grid lg:grid-cols-2 gap-5">
        <TasksCard tasks={tasks} />
        <RequestsCard requests={requests} />
      </div>

      {/* ─── Financial Ledger — monthly GL view ─── */}
      <FinancialLedgerCard userId={profile.id} monthSel={monthSel} />

      {/* ─── Daily history ─── */}
      <HistoryCard userId={profile.id} />
    </div>
  );
}

/* ───────── Month selector bar ───────── */

function MonthSelectorBar({ monthSel }: { monthSel: MonthSelector }) {
  const prev = addMonths(monthSel.month, -1);
  const next = addMonths(monthSel.month, +1);
  const cur = currentMonthCairo();
  return (
    <div className="card p-3 flex items-center gap-2 flex-wrap">
      <button
        className="btn-ghost px-2 py-1 text-xs"
        onClick={() => monthSel.setMonth(prev)}
        title={prev}
      >
        ← الشهر السابق
      </button>
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-[11px] text-slate-500">الشهر المعروض:</span>
        <input
          type="month"
          className="input input-sm tabular-nums"
          value={monthSel.month}
          onChange={(e) => monthSel.setMonth(e.target.value || cur)}
        />
        <span className="text-xs font-bold text-slate-800 truncate">
          {monthSel.label}
        </span>
        {monthSel.isCurrent && (
          <span className="chip bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px]">
            الحالي
          </span>
        )}
      </div>
      <button
        className="btn-ghost px-2 py-1 text-xs"
        onClick={() => monthSel.setMonth(next)}
        title={next}
      >
        الشهر التالي →
      </button>
      {!monthSel.isCurrent && (
        <button
          className="btn-ghost px-2 py-1 text-xs mr-auto"
          onClick={() => monthSel.setMonth(cur)}
        >
          العودة للشهر الحالي
        </button>
      )}
    </div>
  );
}


/* ───────── Pay Wage modal ─────────
   Splits the payout into:
     • payable portion (≤ 213 balance)  → DR 213 / CR cashbox
     • excess (if any)  → admin must classify:
         'advance' → DR 1123 / CR cashbox (via canonical expense path)
         'bonus'   → DR 521 / CR 213, then DR 213 / CR cashbox
   Backend: POST /attendance/admin/pay-wage. Server enforces the same
   rules — no silent fallback.
*/
// PR-T2 — exported so the new AttendanceWageTab can reuse the
// existing payout modal verbatim. Payout redesign (separate
// CashSourceSelector polish) lands in PR-T3.
export function PayWageModal({
  userId,
  fullName,
  liveGlBalance,
  onClose,
  onSuccess,
}: {
  userId: string;
  fullName: string;
  liveGlBalance: number;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const payableBalance = Math.max(0, -Number(liveGlBalance || 0));
  const [amount, setAmount] = useState<string>('');
  // PR-15 — replaces the bare cashbox dropdown with the structured
  // CashSource so we capture both the chosen mode AND the resulting
  // (shift_id, cashbox_id) pair in one place. payWage propagates
  // shift_id to BOTH the settlement leg and any advance/bonus excess
  // leg so the whole transaction shows up in the source shift.
  const [cashSource, setCashSource] = useState<CashSource>({
    mode: 'unset', shift_id: null, cashbox_id: null,
  });
  const cashboxId = cashSource.cashbox_id || '';
  const [excessHandling, setExcessHandling] = useState<'advance' | 'bonus' | ''>('');
  const [notes, setNotes] = useState<string>('');

  const amtNum = Number(amount || 0);
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const payablePart = r2(Math.min(amtNum, payableBalance));
  const excess = r2(Math.max(0, amtNum - payableBalance));
  const needsClassifier = excess > 0;
  const validClassifier = !needsClassifier || excessHandling !== '';

  const pay = useMutation({
    mutationFn: () =>
      attendanceApi.adminPayWage({
        user_id: userId,
        amount: amtNum,
        cashbox_id: cashboxId,
        excess_handling: excessHandling || undefined,
        notes: notes.trim() || undefined,
        // PR-15 — propagate explicit shift linkage from the source
        // selector. The backend forwards it to recordSettlement and
        // (if there's excess) createDailyExpense, so both legs land
        // on the same shift's closing.
        shift_id:
          cashSource.mode === 'open_shift' ? cashSource.shift_id : undefined,
      }),
    onSuccess: (r) => {
      const parts: string[] = [];
      if (r.payable_amount_settled > 0)
        parts.push(`صرف مستحق ${EGP(r.payable_amount_settled)}`);
      if (r.excess_amount > 0) {
        parts.push(
          r.excess_handling === 'advance'
            ? `سلفة ${EGP(r.excess_amount)}`
            : `مكافأة ${EGP(r.excess_amount)}`,
        );
      }
      toast.success(`تم: ${parts.join(' · ')}`);
      onSuccess();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل صرف اليومية'),
  });

  const canSubmit =
    amtNum > 0 &&
    !!cashboxId &&
    validClassifier &&
    !pay.isPending;

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel w-full max-w-md space-y-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-lg font-bold">صرف يومية — {fullName}</h3>
          <button onClick={onClose} className="icon-btn">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Always show BOTH balances side-by-side: the 213 payable
            amount (what we owe him today, normally payable) and the
            canonical final GL balance (the headline number, sign-aware).
            Showing only the 213 amount hid cases where the employee
            owes the company — admin couldn't tell why "lا يوجد مستحق
            متبقٍّ" was appearing. */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-[11px] text-emerald-900 leading-relaxed">
            <div className="text-[10px] text-emerald-700/80">
              رصيد المستحقات (حساب 213)
            </div>
            <div className="font-black tabular-nums text-sm mt-0.5">
              {EGP(payableBalance)}
            </div>
            <div className="text-[10px] text-emerald-800/80 mt-0.5">
              {payableBalance > 0
                ? 'الجزء القابل للصرف نقدًا مباشرة'
                : 'لا يوجد مستحق متبقٍّ على 213'}
            </div>
          </div>
          <div
            className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
              liveGlBalance > 0.01
                ? 'border-rose-200 bg-rose-50 text-rose-900'
                : liveGlBalance < -0.01
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
                  : 'border-slate-200 bg-slate-50 text-slate-700'
            }`}
          >
            <div className="text-[10px] opacity-70">
              الرصيد النهائي من القيود (213 + 1123)
            </div>
            <div className="font-black tabular-nums text-sm mt-0.5">
              {liveGlBalance > 0.01
                ? `عليه للشركة ${EGP(liveGlBalance)}`
                : liveGlBalance < -0.01
                  ? `مستحق له ${EGP(-liveGlBalance)}`
                  : 'متوازن'}
            </div>
            <div className="text-[10px] opacity-70 mt-0.5">
              v_employee_gl_balance — موجب = الموظف عليه للشركة
            </div>
          </div>
        </div>

        {/* Admin warning when the employee owes the company on net.
            We don't BLOCK the payout (server still validates), but
            we make it explicit that any cash leaving for this
            employee right now is excess and must be classified as
            advance or bonus. Daily wage accrual reduces the debt
            without moving cash. */}
        {liveGlBalance > 0.01 && (
          <div className="rounded-lg border-2 border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-900 leading-relaxed flex items-start gap-2">
            <AlertTriangle className="text-amber-600 shrink-0 mt-0.5" size={14} />
            <div>
              <div className="font-bold mb-0.5">
                الموظف عليه مديونية للشركة
              </div>
              <div>
                تثبيت اليومية سيقلل هذه المديونية على حساب 213، ولا يوجد
                صرف نقدي عادي متاح الآن. أي مبلغ يُصرف نقدًا يجب تصنيفه
                صراحةً كسلفة أو مكافأة (تزيد المديونية أو ترصيد الموظف
                حسب التصنيف).
              </div>
            </div>
          </div>
        )}

        <div>
          <label className="label">المبلغ المراد صرفه نقدًا *</label>
          <input
            type="number"
            step="0.01"
            min="0"
            className="input"
            value={amount}
            placeholder="0.00"
            onChange={(e) => {
              setAmount(e.target.value);
              if (Number(e.target.value || 0) - payableBalance <= 0.001) {
                setExcessHandling('');
              }
            }}
            disabled={pay.isPending}
          />
        </div>

        {/* PR-15 — structured cash-source selector replaces the bare
         *  cashbox dropdown. Operator picks open shift (records
         *  shift_id on every leg of the payout) or direct cashbox
         *  (no shift link). */}
        <CashSourceSelector
          value={cashSource}
          onChange={setCashSource}
          disabled={pay.isPending}
        />

        {/* Live split preview. */}
        {amtNum > 0 && (
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[11px] text-slate-700 space-y-1">
            <div className="flex justify-between">
              <span>الجزء المستحق (DR 213 / CR خزنة)</span>
              <span className="tabular-nums font-bold">
                {EGP(payablePart)}
              </span>
            </div>
            {excess > 0 && (
              <div className="flex justify-between text-amber-700">
                <span>الزيادة عن المستحق</span>
                <span className="tabular-nums font-bold">{EGP(excess)}</span>
              </div>
            )}
          </div>
        )}

        {/* Excess classifier — required when there's overpayment. */}
        {needsClassifier && (
          <div className="rounded-lg border-2 border-amber-200 bg-amber-50/50 px-3 py-2 space-y-2">
            <div className="text-[11px] font-bold text-amber-900">
              المبلغ يتجاوز المتبقي بـ {EGP(excess)} — اختر تصنيف الزيادة:
            </div>
            <label className="flex items-start gap-2 text-xs text-slate-800">
              <input
                type="radio"
                name="excess"
                checked={excessHandling === 'advance'}
                onChange={() => setExcessHandling('advance')}
                disabled={pay.isPending}
              />
              <span>
                <span className="font-bold">سلفة خارج اليومية</span>
                <span className="text-[10px] text-slate-500 block">
                  DR 1123 ذمم الموظفين / CR الخزنة. تزيد ما يدين به الموظف
                  للشركة.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-xs text-slate-800">
              <input
                type="radio"
                name="excess"
                checked={excessHandling === 'bonus'}
                onChange={() => setExcessHandling('bonus')}
                disabled={pay.isPending}
              />
              <span>
                <span className="font-bold">مكافأة / حافز</span>
                <span className="text-[10px] text-slate-500 block">
                  DR 521 رواتب / CR 213 ثم DR 213 / CR الخزنة. تزيد دخل
                  الموظف وتُصرف فورًا.
                </span>
              </span>
            </label>
          </div>
        )}

        <div>
          <label className="label">ملاحظات</label>
          <input
            type="text"
            className="input"
            placeholder="اختياري"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={pay.isPending}
          />
        </div>

        <div className="text-[10px] text-slate-500 leading-relaxed">
          الخزنة تتحرك مرة واحدة فقط بالمبلغ الكامل. ميزان المراجعة يبقى
          صفرًا.
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="btn-ghost" disabled={pay.isPending}>
            إلغاء
          </button>
          <button
            className="btn-primary"
            disabled={!canSubmit}
            onClick={() => pay.mutate()}
          >
            {pay.isPending ? 'جارٍ الصرف…' : 'صرف الآن'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ───────── Financial Ledger card ─────────
   Unified view of everything that shifts the employee's outstanding
   balance with the company: shift shortages charged, cashbox advances,
   manual deductions, settlements paid back, and bonuses (informational
   only; bonuses live on the payroll side and don't affect the
   receivable). The running balance is computed server-side so the
   header tile matches whatever v_employee_ledger says.
*/
function FinancialLedgerCard({
  userId,
  monthSel,
}: {
  userId?: string;
  monthSel: MonthSelector;
}) {
  const authUser = useAuthStore((s) => s.user);
  const isSelf = !userId || userId === authUser?.id;
  const { from, to } = monthSel;
  const { data, isLoading } = useQuery({
    queryKey: ['employee-ledger', userId ?? 'me', monthSel.month],
    queryFn: () =>
      isSelf
        ? employeesApi.myLedger(from, to)
        : employeesApi.userLedger(userId!, from, to),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div className="card p-4 text-center text-slate-500 text-sm">
        جارٍ تحميل الملف المالي…
      </div>
    );
  }
  if (!data) return null;

  const fmt = (n: number) =>
    Number(n || 0).toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });

  const entryLabel = (t: string) =>
    ({
      shift_shortage: 'عجز وردية',
      advance: 'سلفة',
      deduction: 'خصم',
      penalty: 'مخالفة',
      settlement: 'سداد',
      bonus: 'حافز',
    } as Record<string, string>)[t] ?? t;

  // Canonical headline sourced from v_employee_gl_balance.
  const headlineBal =
    typeof data.gl_balance === 'number' ? data.gl_balance : data.closing_balance;
  const glOpening = typeof data.gl_opening_balance === 'number' ? data.gl_opening_balance : null;
  const glClosing = typeof data.gl_closing_balance === 'number' ? data.gl_closing_balance : null;
  // gl_entries come full-history from the API. Restrict the visible
  // timeline to the selected month so the "movements" table matches
  // the opening/closing headline.
  const inMonth = (d: string) => d >= monthSel.from && d <= monthSel.to;
  const monthEntries = (data.gl_entries || []).filter((g) => inMonth(g.entry_date));
  const monthMovement = monthEntries.reduce(
    (acc, g) => acc + Number(g.signed_effect || 0),
    0,
  );

  return (
    <div className="card p-5 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="min-w-0">
          <h3 className="font-black text-slate-800 break-words">
            الملف المالي — الرصيد النهائي من القيود المحاسبية
          </h3>
          <div className="text-[11px] text-slate-500 mt-0.5">
            {monthSel.label}
          </div>
        </div>
        <div
          className={`px-3 py-1.5 rounded-lg text-sm font-black tabular-nums ${
            headlineBal > 0.01
              ? 'bg-rose-100 text-rose-700 border border-rose-200'
              : headlineBal < -0.01
                ? 'bg-emerald-100 text-emerald-700 border border-emerald-200'
                : 'bg-slate-100 text-slate-700 border border-slate-200'
          }`}
        >
          {headlineBal > 0.01
            ? `مديون للشركة: ${fmt(headlineBal)} ج.م`
            : headlineBal < -0.01
              ? `له رصيد: ${fmt(-headlineBal)} ج.م`
              : 'مُسوّى بالكامل'}
        </div>
      </div>

      {/* Monthly opening + movement + closing strip. */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
        <LedgerTile
          label={`افتتاحي — قبل ${monthSel.from}`}
          value={glOpening ?? 0}
          tone="slate"
        />
        <LedgerTile
          label="حركات الشهر"
          value={monthMovement}
          tone={monthMovement > 0 ? 'rose' : monthMovement < 0 ? 'emerald' : 'slate'}
        />
        <LedgerTile
          label={`ختامي — حتى ${monthSel.to}`}
          value={glClosing ?? 0}
          tone="indigo"
        />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
        <LedgerTile label="عجز ورديات" value={data.totals.shortages} tone="rose" />
        <LedgerTile label="سلف" value={data.totals.advances} tone="amber" />
        <LedgerTile
          label="خصومات يدوية"
          value={data.totals.manual_deductions}
          tone="slate"
        />
        <LedgerTile
          label="تسويات"
          value={data.totals.settlements}
          tone="emerald"
        />
        <LedgerTile label="حوافز" value={data.totals.bonuses} tone="indigo" />
      </div>

      {/* ─── Canonical GL ledger — explains gl_balance ───────────────
           Every posted non-void journal_line on 1123 / 213 tagged
           with this employee, chronologically. Reset + reclassification
           JEs appear here as first-class rows. SUM(signed_effect) ==
           gl_balance. This is the audit trail behind the headline. */}
      <div className="space-y-2">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <h4 className="text-sm font-black text-slate-800">
            حركات الشهر — قيود اليومية على حسابات الموظف
          </h4>
          <span className="text-[10px] text-slate-500">
            حسابات 1123 ذمم / 213 مستحقات · صافي الحركة = {fmt(monthMovement)}
          </span>
        </div>
        {monthEntries.length === 0 ? (
          <div className="text-center text-slate-500 text-xs py-4">
            لا توجد قيود محاسبية خلال {monthSel.label}.
          </div>
        ) : (
          <div className="overflow-x-auto border border-slate-200 rounded-lg">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-[11px]">
                  <th className="p-2 text-right">التاريخ</th>
                  <th className="p-2 text-right">قيد</th>
                  <th className="p-2 text-right">الحساب</th>
                  <th className="p-2 text-right">المرجع</th>
                  <th className="p-2 text-center">مدين</th>
                  <th className="p-2 text-center">دائن</th>
                  <th className="p-2 text-center">الأثر</th>
                  <th className="p-2 text-center">الرصيد</th>
                </tr>
              </thead>
              <tbody>
                {monthEntries.map((g, i) => (
                  <tr
                    key={`${g.entry_no}-${i}`}
                    className={`border-t border-slate-100 ${
                      g.is_voided ? 'opacity-50 bg-slate-50/60' : ''
                    }`}
                  >
                    <td className="p-2 tabular-nums font-mono">{g.entry_date}</td>
                    <td className="p-2 font-mono text-[11px] text-slate-600">
                      <span className={g.is_voided ? 'line-through' : ''}>
                        {g.entry_no}
                      </span>
                      {g.is_voided && (
                        <span
                          className="chip text-[9px] bg-rose-50 text-rose-700 border-rose-200 mr-1"
                          title={g.void_reason || 'تم إلغاء هذا القيد'}
                        >
                          ملغاة
                        </span>
                      )}
                    </td>
                    <td className="p-2">
                      <span
                        className={`chip text-[10px] ${
                          g.account_code === '1123'
                            ? 'bg-amber-50 text-amber-700 border-amber-200'
                            : 'bg-indigo-50 text-indigo-700 border-indigo-200'
                        }`}
                      >
                        {g.account_code} {g.account_name}
                      </span>
                    </td>
                    <td className="p-2 text-slate-700">
                      <div
                        className={`text-[11px] ${g.is_voided ? 'line-through' : ''}`}
                      >
                        {g.description}
                      </div>
                      <div className="text-[10px] text-slate-400 font-mono">
                        {g.reference_type}
                      </div>
                    </td>
                    <td className="p-2 text-center tabular-nums">
                      {g.debit > 0 ? (
                        <span className={g.is_voided ? 'line-through' : ''}>
                          {fmt(g.debit)}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="p-2 text-center tabular-nums">
                      {g.credit > 0 ? (
                        <span className={g.is_voided ? 'line-through' : ''}>
                          {fmt(g.credit)}
                        </span>
                      ) : '—'}
                    </td>
                    <td
                      className={`p-2 text-center tabular-nums font-bold ${
                        g.is_voided
                          ? 'text-slate-400'
                          : g.signed_effect > 0
                            ? 'text-rose-700'
                            : g.signed_effect < 0
                              ? 'text-emerald-700'
                              : 'text-slate-500'
                      }`}
                    >
                      {g.is_voided ? '0.00' : (
                        <>
                          {g.signed_effect > 0 ? '+' : ''}
                          {fmt(g.signed_effect)}
                        </>
                      )}
                    </td>
                    <td className="p-2 text-center tabular-nums font-black">
                      {fmt(g.running_balance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ─── Legacy source-table log — archived / collapsed ─── */}
      <details className="group pt-3 border-t border-slate-200">
        <summary className="cursor-pointer list-none flex items-center gap-2 select-none py-1">
          <Archive className="text-slate-500 shrink-0" size={14} />
          <h4 className="text-sm font-bold text-slate-700 min-w-0 break-words">
            سجل العمليات الأصلي — أرشيف للمراجعة (لا يمثل الرصيد النهائي)
          </h4>
          <span className="text-[10px] text-slate-400 mr-auto group-open:hidden">عرض ▾</span>
          <span className="text-[10px] text-slate-400 mr-auto hidden group-open:inline">إخفاء ▴</span>
        </summary>
        <div className="pt-3 space-y-2">
          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-xs text-slate-700">
            <div className="font-bold mb-1">
              معادلة الحركات من الجداول الأصلية — مرجعية فقط
            </div>
            <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono tabular-nums leading-relaxed">
              <span className="font-bold">مجموع الحركات</span>
              <span>=</span>
              {data.opening_balance !== 0 && (
                <>
                  <span>رصيد افتتاحي {fmt(data.opening_balance)}</span>
                  <span>+</span>
                </>
              )}
              <span className="text-rose-700">عجز {fmt(data.totals.shortages)}</span>
              <span>+</span>
              <span className="text-amber-700">سلف {fmt(data.totals.advances)}</span>
              <span>−</span>
              <span className="text-slate-700">خصومات {fmt(data.totals.manual_deductions)}</span>
              <span>−</span>
              <span className="text-emerald-700">تسويات {fmt(data.totals.settlements)}</span>
              <span>−</span>
              <span className="text-indigo-700">حوافز {fmt(data.totals.bonuses)}</span>
              <span>=</span>
              <span className="font-black">{fmt(data.closing_balance)}</span>
            </div>
          </div>
      {data.entries.length === 0 ? (
        <div className="text-center text-slate-500 text-xs py-6">
          لا توجد حركات مالية في الفترة المحددة.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-slate-50 text-slate-600 text-[11px]">
                <th className="p-2 text-right">التاريخ</th>
                <th className="p-2 text-right">النوع</th>
                <th className="p-2 text-right">الوصف</th>
                <th className="p-2 text-center">المبلغ</th>
                <th className="p-2 text-center">الرصيد</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((e) => (
                <tr
                  key={`${e.reference_type}-${e.reference_id}`}
                  className="border-t border-slate-100"
                >
                  <td className="p-2 tabular-nums font-mono">
                    {e.event_date}
                  </td>
                  <td className="p-2">
                    <span
                      className={`chip text-[10px] ${
                        e.entry_type === 'settlement'
                          ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                          : e.entry_type === 'shift_shortage'
                            ? 'bg-rose-50 text-rose-700 border-rose-200'
                            : e.entry_type === 'advance'
                              ? 'bg-amber-50 text-amber-700 border-amber-200'
                              : e.entry_type === 'bonus'
                                ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
                                : 'bg-slate-50 text-slate-700 border-slate-200'
                      }`}
                    >
                      {entryLabel(e.entry_type)}
                    </span>
                  </td>
                  <td className="p-2 text-slate-700">
                    {e.description}
                    {e.journal_entry_id && (
                      <span className="text-[10px] text-slate-400 mr-2 font-mono">
                        JE
                      </span>
                    )}
                  </td>
                  <td
                    className={`p-2 text-center tabular-nums font-bold ${
                      e.amount_owed_delta > 0
                        ? 'text-rose-700'
                        : e.amount_owed_delta < 0
                          ? 'text-emerald-700'
                          : 'text-slate-500'
                    }`}
                  >
                    {e.amount_owed_delta > 0 ? '+' : ''}
                    {fmt(e.amount_owed_delta)}
                  </td>
                  <td className="p-2 text-center tabular-nums font-bold">
                    {fmt(e.running_balance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
        </div>
      </details>
    </div>
  );
}

function LedgerTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'rose' | 'amber' | 'slate' | 'emerald' | 'indigo';
}) {
  const toneCls: Record<string, string> = {
    rose: 'bg-rose-50 border-rose-200 text-rose-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    slate: 'bg-slate-50 border-slate-200 text-slate-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-700',
  };
  return (
    <div className={`rounded-lg p-2 border min-w-0 h-full ${toneCls[tone]}`}>
      <div className="font-bold mb-0.5 break-words">{label}</div>
      <div className="tabular-nums font-black text-sm break-words leading-tight">
        {Number(value || 0).toLocaleString('en-US', {
          minimumFractionDigits: 2,
          maximumFractionDigits: 2,
        })}{' '}
        ج.م
      </div>
    </div>
  );
}

/* ───────── History card ───────── */

/** Day cell: weekday (Arabic) + dd/mm/yyyy (English digits). */
function fmtDayHeader(iso: string) {
  const d = new Date(iso);
  const dow = d.toLocaleDateString('ar-EG', {
    timeZone: 'Africa/Cairo',
    weekday: 'long',
  });
  const date = d.toLocaleDateString('en-GB', {
    timeZone: 'Africa/Cairo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  return { dow, date };
}

/** HH:MM:SS AM/PM — digits in English, AM/PM in Arabic (ص/م). */
function fmtClockAr(iso: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  const t = d.toLocaleTimeString('en-GB', {
    timeZone: 'Africa/Cairo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
  // en-GB hour12 output ends with " AM" / " PM" — swap for ص/م.
  return t.replace(/\s?AM\s*$/i, ' ص').replace(/\s?PM\s*$/i, ' م');
}

function HistoryCard({ userId }: { userId?: string }) {
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canGrantFullDay = hasPermission('employee.bonuses.manage');
  const [range, setRange] = useState<'week' | 'month'>('month');
  const now = new Date();
  const to = now.toISOString().slice(0, 10);
  const from = new Date(
    now.getTime() - (range === 'week' ? 7 : 30) * 24 * 3600 * 1000,
  )
    .toISOString()
    .slice(0, 10);

  const { data } = useQuery({
    queryKey: ['employee-history-mine', from, to],
    queryFn: () => employeesApi.myHistory(from, to),
    refetchInterval: 60_000,
  });

  const days = data?.days || [];
  const targetDayHr = data?.target_hours_day || 8;
  const hourly = data?.hourly_rate || 0;
  const fullDayWage = data?.full_day_wage || 0;

  const payFullDay = useMutation({
    mutationFn: (row: any) => {
      const shortfall = Math.max(0, fullDayWage - Number(row.earned_hours_based || 0));
      return employeesApi.addBonus(userId || (row as any).user_id || '', {
        amount: Math.round(shortfall * 100) / 100,
        kind: 'bonus',
        bonus_date: row.day.slice(0, 10),
        note: 'صرف يومية كاملة رغم التأخير/النقص',
      });
    },
    onSuccess: () => {
      toast.success('تم صرف اليومية الكاملة كمكافأة');
      qc.invalidateQueries({ queryKey: ['employee-history-mine'] });
      qc.invalidateQueries({ queryKey: ['employee-dashboard'] });
      qc.invalidateQueries({ queryKey: ['payroll-balances'] });
      qc.invalidateQueries({ queryKey: ['payroll-list'] });
      qc.invalidateQueries({ queryKey: ['employee-ledger'] });
      qc.invalidateQueries({ queryKey: ['employees-team'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل صرف اليومية'),
  });

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Clock size={18} className="text-indigo-600" />
          <h3 className="font-black text-slate-800">سجل الأيام</h3>
          <span className="text-[11px] text-slate-500">
            الهدف {targetDayHr}س · قيمة الساعة {EGP(hourly)} · يومية كاملة {EGP(fullDayWage)}
          </span>
        </div>
        <div className="inline-flex rounded-lg bg-slate-100 p-1 text-xs">
          <button
            className={`px-3 py-1 rounded-md font-bold ${
              range === 'week'
                ? 'bg-white text-indigo-700 shadow-sm'
                : 'text-slate-600'
            }`}
            onClick={() => setRange('week')}
          >
            آخر 7 أيام
          </button>
          <button
            className={`px-3 py-1 rounded-md font-bold ${
              range === 'month'
                ? 'bg-white text-indigo-700 shadow-sm'
                : 'text-slate-600'
            }`}
            onClick={() => setRange('month')}
          >
            آخر 30 يوم
          </button>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="p-2 text-right">التاريخ / اليوم</th>
              <th className="p-2 text-center">حضور</th>
              <th className="p-2 text-center">انصراف</th>
              <th className="p-2 text-center">مدة العمل</th>
              <th className="p-2 text-center">الهدف</th>
              <th className="p-2 text-center">المتبقي</th>
              <th className="p-2 text-center">إضافي</th>
              <th className="p-2 text-center">تأخير</th>
              <th className="p-2 text-center">انصراف مبكر</th>
              <th className="p-2 text-center">الحالة</th>
              <th className="p-2 text-center">المستحق</th>
              <th className="p-2 text-center">حوافز</th>
              <th className="p-2 text-center">خصم</th>
              <th className="p-2 text-center">سلف</th>
              {canGrantFullDay && <th className="p-2"></th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {days.map((d) => {
              const h = fmtDayHeader(d.day);
              const earned = Number((d as any).earned_hours_based || 0);
              const earnedOt = Number((d as any).earned_overtime || 0);
              const targetMin =
                Number((d as any).target_min || targetDayHr * 60);
              const lateMin = Number((d as any).late_min || 0);
              const earlyLeaveMin = Number((d as any).early_leave_min || 0);
              const canShowFullDay =
                canGrantFullDay &&
                Number(d.minutes || 0) > 0 &&
                earned < fullDayWage - 0.01;
              // Status:
              //   • completed: clock_in + clock_out both set
              //   • active:    clock_in only (still working)
              //   • absent:    no record for the day
              const status: 'completed' | 'active' | 'absent' =
                d.first_in && d.last_out
                  ? 'completed'
                  : d.first_in
                    ? 'active'
                    : 'absent';
              const statusChip =
                status === 'completed'
                  ? { cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', txt: 'مكتمل' }
                  : status === 'active'
                    ? { cls: 'bg-amber-50 text-amber-700 border-amber-200', txt: 'جاري' }
                    : { cls: 'bg-slate-50 text-slate-500 border-slate-200', txt: 'غياب' };
              return (
                <tr key={d.day}>
                  <td className="p-2 font-medium text-slate-700">
                    <div>{h.dow}</div>
                    <div className="text-[10px] font-mono text-slate-400 tabular-nums">
                      {h.date}
                    </div>
                  </td>
                  <td className="p-2 text-center text-slate-700">
                    <span className="tabular-nums font-mono">
                      {fmtClockAr(d.first_in)}
                    </span>
                  </td>
                  <td className="p-2 text-center text-slate-700">
                    <span className="tabular-nums font-mono">
                      {fmtClockAr(d.last_out)}
                    </span>
                  </td>
                  <td className="p-2 text-center tabular-nums font-bold">
                    {d.minutes ? fmtMinutes(d.minutes) : '—'}
                  </td>
                  <td className="p-2 text-center tabular-nums text-slate-600">
                    {fmtMinutes(targetMin)}
                  </td>
                  <td className="p-2 text-center tabular-nums text-rose-700">
                    {d.undertime_min && d.minutes
                      ? `−${fmtMinutes(d.undertime_min)}`
                      : '—'}
                  </td>
                  <td className="p-2 text-center tabular-nums text-emerald-700 font-bold">
                    {d.overtime_min
                      ? `+${fmtMinutes(d.overtime_min)}`
                      : '—'}
                    {earnedOt > 0 && (
                      <div className="text-[10px] font-normal text-emerald-600">
                        +{EGP(earnedOt)}
                      </div>
                    )}
                  </td>
                  <td className="p-2 text-center tabular-nums text-amber-700">
                    {lateMin > 0 ? `${lateMin}د` : '—'}
                  </td>
                  <td className="p-2 text-center tabular-nums text-amber-700">
                    {earlyLeaveMin > 0 ? `${earlyLeaveMin}د` : '—'}
                  </td>
                  <td className="p-2 text-center">
                    <span
                      className={`chip text-[10px] ${statusChip.cls}`}
                    >
                      {statusChip.txt}
                    </span>
                  </td>
                  <td className="p-2 text-center tabular-nums">
                    {d.minutes ? (
                      <>
                        <span className="font-black text-indigo-700">
                          {EGP(earned)}
                        </span>
                        {earned < fullDayWage && (
                          <div className="text-[10px] text-slate-400 line-through">
                            أصل {EGP(fullDayWage)}
                          </div>
                        )}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="p-2 text-center tabular-nums text-indigo-700">
                    {Number(d.bonuses) > 0 ? EGP(d.bonuses) : '—'}
                  </td>
                  <td className="p-2 text-center tabular-nums text-rose-700">
                    {Number(d.deductions) > 0 ? EGP(d.deductions) : '—'}
                  </td>
                  <td className="p-2 text-center tabular-nums text-amber-700">
                    {Number(d.advances) > 0 ? EGP(d.advances) : '—'}
                  </td>
                  {canGrantFullDay && (
                    <td className="p-2 text-center">
                      {canShowFullDay && userId && (
                        <button
                          className="px-2 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[10px]"
                          disabled={payFullDay.isPending}
                          onClick={() => payFullDay.mutate(d)}
                          title="إضافة مكافأة بمقدار الفرق لصرف اليومية كاملة"
                        >
                          صرف يومية كاملة
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {!days.length && (
              <tr>
                <td
                  colSpan={canGrantFullDay ? 15 : 14}
                  className="p-10 text-center text-slate-400"
                >
                  لا سجل في الفترة المحددة
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/* ───────── Presentational helpers ───────── */

function MetricCard({
  label,
  value,
  hint,
  tone,
  icon,
}: {
  label: string;
  value: string;
  hint?: string;
  tone: 'indigo' | 'emerald' | 'amber' | 'rose' | 'slate';
  icon?: React.ReactNode;
}) {
  const bg = {
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    rose: 'bg-rose-50 border-rose-200 text-rose-700',
    slate: 'bg-slate-50 border-slate-200 text-slate-700',
  }[tone];
  return (
    // min-w-0 on the card so long Arabic values can wrap in a grid
    // cell without pushing the card wider than its track. h-full
    // keeps sibling cards in the same row aligned. overflow-hidden
    // is a safety net for extreme values.
    <div className={`rounded-xl border p-4 min-w-0 h-full overflow-hidden ${bg}`}>
      <div className="flex items-center justify-between gap-2 mb-2">
        <span className="text-[11px] font-bold opacity-80 min-w-0 break-words">
          {label}
        </span>
        <span className="opacity-80 shrink-0">{icon}</span>
      </div>
      {/* Responsive type — smaller on mobile so long labels like
          "مستحق له 885.00 ج.م" don't truncate or overflow. Breaking
          is allowed as a last resort via break-words. `title` lets
          the user see the full value on hover if a line-clamp
          kicks in on very narrow screens. */}
      <div
        className="text-lg sm:text-xl md:text-2xl font-black break-words tabular-nums leading-tight"
        title={value}
      >
        {value}
      </div>
      {hint && (
        <div className="text-[10px] opacity-70 mt-1 break-words">{hint}</div>
      )}
    </div>
  );
}

function BreakdownRow({
  label,
  value,
  tone,
  big,
}: {
  label: string;
  value: string;
  tone: 'indigo' | 'emerald' | 'amber' | 'rose';
  big?: boolean;
}) {
  const textTone = {
    indigo: 'text-indigo-700',
    emerald: 'text-emerald-700',
    amber: 'text-amber-700',
    rose: 'text-rose-700',
  }[tone];
  return (
    <div className="bg-slate-50 rounded-lg p-3 border border-slate-100 min-w-0 h-full">
      <div className="text-[11px] text-slate-500 font-bold mb-1 break-words">{label}</div>
      <div
        className={`font-black ${textTone} tabular-nums break-words leading-tight ${
          big ? 'text-lg sm:text-xl' : 'text-sm sm:text-base'
        }`}
        title={value}
      >
        {value}
      </div>
    </div>
  );
}

/* ───────── Tasks card ───────── */

const PRIORITY_STYLE: Record<string, string> = {
  low: 'bg-slate-100 text-slate-600 border-slate-200',
  normal: 'bg-indigo-100 text-indigo-700 border-indigo-200',
  high: 'bg-amber-100 text-amber-700 border-amber-200',
  urgent: 'bg-rose-100 text-rose-700 border-rose-200',
};
const PRIORITY_LABEL: Record<string, string> = {
  low: 'منخفضة',
  normal: 'عادية',
  high: 'هامة',
  urgent: 'عاجلة',
};

function TasksCard({ tasks }: { tasks: EmployeeTask[] }) {
  const qc = useQueryClient();
  const ack = useMutation({
    mutationFn: (id: string) => employeesApi.ackTask(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employee-dashboard'] });
      toast.success('تم الاستلام — ستبقى المهمة ظاهرة حتى اكتمالها');
    },
  });
  const done = useMutation({
    mutationFn: (id: string) => employeesApi.completeTask(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['employee-dashboard'] });
      toast.success('تم إنهاء المهمة');
    },
  });
  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-4">
        <ListTodo size={18} className="text-indigo-500" />
        <h3 className="font-black text-slate-800">مهامي</h3>
        <span className="chip bg-slate-100 border-slate-200 text-slate-700 text-[10px] font-bold">
          {tasks.length}
        </span>
      </div>
      {tasks.length === 0 ? (
        <div className="text-center text-xs text-slate-400 py-6">
          لا مهام مفتوحة حالياً — أحسنت.
        </div>
      ) : (
        <ul className="space-y-2">
          {tasks.map((t) => (
            <li
              key={t.id}
              className="border border-slate-200 rounded-lg p-3 text-xs"
            >
              <div className="flex items-start justify-between gap-2 mb-1">
                <div className="flex items-center gap-2">
                  <span
                    className={`chip border text-[10px] ${
                      PRIORITY_STYLE[t.priority] || PRIORITY_STYLE.normal
                    }`}
                  >
                    {PRIORITY_LABEL[t.priority] || 'عادية'}
                  </span>
                  <span className="font-bold text-slate-800">{t.title}</span>
                </div>
                {t.due_at && (
                  <span className="text-slate-500 tabular-nums">
                    موعد: {fmtWhen(t.due_at)}
                  </span>
                )}
              </div>
              {t.description && (
                <div className="text-slate-600 mb-2">{t.description}</div>
              )}
              <div className="flex items-center gap-2">
                {t.status === 'pending' && (
                  <button
                    className="btn-primary text-[11px] py-1"
                    disabled={ack.isPending}
                    onClick={() => ack.mutate(t.id)}
                  >
                    <CheckCircle2 size={12} /> استلمت
                  </button>
                )}
                {t.status !== 'completed' && (
                  <button
                    className="btn-ghost text-[11px] py-1 border border-emerald-200 text-emerald-700"
                    disabled={done.isPending}
                    onClick={() => done.mutate(t.id)}
                  >
                    إنهاء المهمة
                  </button>
                )}
                {t.status === 'acknowledged' && (
                  <span className="chip bg-emerald-50 text-emerald-700 border-emerald-200 text-[10px]">
                    تم الاستلام
                  </span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ───────── Requests card ───────── */

const KIND_LABEL: Record<string, string> = {
  advance: 'طلب سلفة',
  leave: 'طلب إجازة',
  overtime_extension: 'تمديد ساعات إضافية',
  other: 'طلب آخر',
};
const STATUS_LABEL: Record<string, string> = {
  pending: 'قيد الانتظار',
  approved: 'موافق عليه',
  rejected: 'مرفوض',
  cancelled: 'ملغى',
};
const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-100 text-amber-700 border-amber-200',
  approved: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  rejected: 'bg-rose-100 text-rose-700 border-rose-200',
  cancelled: 'bg-slate-100 text-slate-600 border-slate-200',
};

function RequestsCard({ requests }: { requests: any[] }) {
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canSubmit = hasPermission('employee.requests.submit');
  const [open, setOpen] = useState(false);

  const { data: all = [] } = useQuery({
    queryKey: ['employee-requests-mine'],
    queryFn: () => employeesApi.myRequests(),
  });

  return (
    <div className="card p-5">
      <div className="flex items-center gap-2 mb-4">
        <MessageSquare size={18} className="text-brand-600" />
        <h3 className="font-black text-slate-800">طلباتي</h3>
        <span className="chip bg-slate-100 border-slate-200 text-slate-700 text-[10px] font-bold">
          {all.length}
        </span>
        {canSubmit && (
          <button
            className="btn-primary text-[11px] mr-auto py-1"
            onClick={() => setOpen(true)}
          >
            <Plus size={12} /> طلب جديد
          </button>
        )}
      </div>
      {all.length === 0 ? (
        <div className="text-center text-xs text-slate-400 py-6">
          لا توجد طلبات بعد.
        </div>
      ) : (
        <ul className="space-y-2">
          {all.map((r: any) => (
            <li
              key={r.id}
              className="border border-slate-200 rounded-lg p-3 text-xs space-y-1"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={`chip border text-[10px] font-bold ${
                      STATUS_STYLE[r.status] || STATUS_STYLE.pending
                    }`}
                  >
                    {STATUS_LABEL[r.status]}
                  </span>
                  <span className="font-bold text-slate-800">
                    {KIND_LABEL[r.kind] || r.kind}
                  </span>
                  {r.amount != null && (
                    <span className="text-slate-600 font-mono tabular-nums">
                      {EGP(r.amount)}
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-slate-500 tabular-nums">
                  {fmtWhen(r.created_at)}
                </span>
              </div>
              {r.reason && <div className="text-slate-600">السبب: {r.reason}</div>}
              {r.decision_reason && (
                <div
                  className={
                    r.status === 'rejected' ? 'text-rose-700' : 'text-emerald-700'
                  }
                >
                  قرار: {r.decision_reason}
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      {open && (
        <RequestModal
          onClose={() => setOpen(false)}
          onSuccess={() => {
            setOpen(false);
            qc.invalidateQueries({ queryKey: ['employee-dashboard'] });
            qc.invalidateQueries({ queryKey: ['employee-requests-mine'] });
          }}
        />
      )}
    </div>
  );
}

function RequestModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  // 'advance' removed from the self-service request form (audit #4).
  // Advances must go through the canonical expenses.is_advance=TRUE
  // path via the accounting side, not a DB-triggered mirror that
  // would silently duplicate the GL entry and drift the cashbox.
  const [kind, setKind] = useState<SubmitRequestKind>('leave');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('');

  const submit = useMutation({
    mutationFn: () =>
      employeesApi.submitRequest({
        kind,
        starts_at: startsAt || undefined,
        ends_at: endsAt || undefined,
        reason: reason || undefined,
      }),
    onSuccess: () => {
      toast.success('تم إرسال طلبك — بانتظار الاعتماد');
      onSuccess();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل إرسال الطلب'),
  });

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl w-full max-w-md p-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-black text-slate-800">تقديم طلب جديد</h3>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X size={16} />
          </button>
        </div>

        <div className="space-y-3 text-sm">
          <div>
            <label className="text-xs font-bold text-slate-600 block mb-1">
              نوع الطلب
            </label>
            <div className="grid grid-cols-3 gap-2">
              {(['leave', 'overtime_extension', 'other'] as const).map((k) => (
                <button
                  type="button"
                  key={k}
                  className={`py-2 rounded-lg text-xs font-bold border ${
                    kind === k
                      ? 'bg-indigo-600 text-white border-indigo-600'
                      : 'bg-white text-slate-600 border-slate-200'
                  }`}
                  onClick={() => setKind(k)}
                >
                  {KIND_LABEL[k]}
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-xs font-bold text-slate-600 mb-1 block">
                من
              </span>
              <input
                type="datetime-local"
                className="input w-full"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-600 mb-1 block">
                إلى
              </span>
              <input
                type="datetime-local"
                className="input w-full"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
              />
            </label>
          </div>

          <label className="block">
            <span className="text-xs font-bold text-slate-600 mb-1 block">
              السبب
            </span>
            <textarea
              rows={3}
              className="input w-full"
              placeholder="اكتب سبب الطلب — مثال: ظرف عائلي / مصاريف طارئة / إلخ"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </label>

          <div className="flex justify-end gap-2 pt-2">
            <button
              className="btn-ghost"
              onClick={onClose}
              disabled={submit.isPending}
            >
              إلغاء
            </button>
            <button
              className="btn-primary"
              disabled={submit.isPending}
              onClick={() => {
                submit.mutate();
              }}
            >
              {submit.isPending ? 'جارٍ الإرسال…' : 'إرسال الطلب'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
