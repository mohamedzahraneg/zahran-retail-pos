import { useEffect, useMemo, useState } from 'react';
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
} from 'lucide-react';
import {
  employeesApi,
  EmployeeDashboard,
  EmployeeTask,
} from '@/api/employees.api';
import { attendanceApi } from '@/api/attendance.api';
import { useAuthStore } from '@/stores/auth.store';

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

export default function EmployeeProfile() {
  const qc = useQueryClient();
  const authUser = useAuthStore((s) => s.user);

  const { data, isLoading } = useQuery({
    queryKey: ['employee-dashboard'],
    queryFn: () => employeesApi.dashboard(),
    refetchInterval: 30_000,
  });

  if (isLoading || !data) {
    return (
      <div className="card p-12 text-center text-slate-500">
        جارٍ تحميل ملفك…
      </div>
    );
  }
  return <EmployeeDashboardBody data={data} />;
}

function EmployeeDashboardBody({ data }: { data: EmployeeDashboard }) {
  const qc = useQueryClient();
  const { profile, attendance, salary, tasks, requests, recommendations } = data;

  const clockIn = useMutation({
    mutationFn: () => attendanceApi.clockIn(),
    onSuccess: () => {
      toast.success('تم تسجيل حضورك');
      qc.invalidateQueries({ queryKey: ['employee-dashboard'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تسجيل الحضور'),
  });
  const clockOut = useMutation({
    mutationFn: () => attendanceApi.clockOut(),
    onSuccess: () => {
      toast.success('تم تسجيل انصرافك');
      qc.invalidateQueries({ queryKey: ['employee-dashboard'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تسجيل الانصراف'),
  });

  const clockInAt = attendance.today?.clock_in || null;
  const clockOutAt = attendance.today?.clock_out || null;
  const isClockedIn = clockInAt && !clockOutAt;

  // Target minutes for today
  const targetDayMin = Math.round(
    Number((profile as any).target_hours_day || 8) * 60,
  );
  const monthHours = attendance.month.minutes / 60;

  return (
    <div className="space-y-5">
      {/* ─── Profile header card ─── */}
      <div className="card p-5 bg-gradient-to-br from-indigo-600 to-violet-600 text-white">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div className="flex items-center gap-4">
            <div className="w-14 h-14 rounded-2xl bg-white/15 flex items-center justify-center">
              <Briefcase size={26} />
            </div>
            <div>
              <div className="text-xs uppercase tracking-widest opacity-80">
                ملف الموظف
              </div>
              <div className="text-2xl font-black mt-1">{profile.full_name}</div>
              <div className="text-xs opacity-90 flex items-center gap-2 mt-1 flex-wrap">
                <span className="chip bg-white/15 border-white/20 font-mono text-[11px]">
                  {profile.employee_no}
                </span>
                {profile.job_title && (
                  <span className="opacity-90">{profile.job_title}</span>
                )}
                {profile.role_name && (
                  <span className="chip bg-white/15 border-white/20 text-[11px]">
                    {profile.role_name}
                  </span>
                )}
              </div>
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs opacity-80 mb-1">
              {isClockedIn
                ? 'منذ تسجيل الحضور'
                : clockOutAt
                  ? 'انصرفت اليوم'
                  : 'لم تسجّل حضورك'}
            </div>
            {isClockedIn ? (
              <div className="text-3xl">
                <LiveElapsed since={clockInAt} />
              </div>
            ) : (
              <div className="text-xl font-bold">
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
                  className="px-3 py-1.5 rounded-lg bg-white/15 border border-white/30 text-xs font-black"
                  onClick={() => clockOut.mutate()}
                  disabled={clockOut.isPending}
                >
                  تسجيل انصراف
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

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

      {/* ─── Metric strip ─── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <MetricCard
          label="ساعات اليوم"
          value={
            attendance.today?.duration_min
              ? fmtMinutes(Number(attendance.today.duration_min))
              : isClockedIn
                ? 'مستمر'
                : '—'
          }
          hint={`هدف ${(targetDayMin / 60).toFixed(1)}س`}
          tone="indigo"
          icon={<Clock size={18} />}
        />
        <MetricCard
          label="ساعات الشهر"
          value={`${monthHours.toFixed(1)}س`}
          hint={`${attendance.month.days} يوم`}
          tone="emerald"
          icon={<Clock size={18} />}
        />
        <MetricCard
          label="الصافي المتوقع"
          value={EGP(salary.net)}
          hint={
            salary.debt_warning
              ? 'تجاوزت رصيدك!'
              : `من ${EGP(salary.accrued)} مستحق`
          }
          tone={salary.debt_warning ? 'rose' : 'emerald'}
          icon={<DollarSign size={18} />}
        />
        <MetricCard
          label="السلف هذا الشهر"
          value={EGP(salary.advances_month)}
          hint={`مجموعها ${EGP(salary.advances_lifetime)}`}
          tone="amber"
          icon={<DollarSign size={18} />}
        />
      </div>

      {/* ─── Salary breakdown ─── */}
      <div className="card p-5">
        <div className="flex items-center gap-2 mb-4">
          <DollarSign className="text-brand-600" size={18} />
          <h3 className="font-black text-slate-800">تفاصيل الدخل</h3>
          <span className="text-[11px] text-slate-500 mr-auto">
            {profile.salary_frequency === 'daily'
              ? 'يومي'
              : profile.salary_frequency === 'weekly'
                ? 'أسبوعي'
                : 'شهري'}{' '}
            · {EGP(profile.salary_amount)}
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
          <BreakdownRow label="مستحق حتى الآن" value={EGP(salary.accrued)} tone="emerald" />
          <BreakdownRow label="حوافز ومكافآت" value={EGP(salary.bonuses)} tone="indigo" />
          <BreakdownRow label="خصومات" value={EGP(salary.deductions)} tone="rose" />
          <BreakdownRow label="سلف" value={EGP(salary.advances_month)} tone="amber" />
          <BreakdownRow
            label="الصافي"
            value={EGP(salary.net)}
            tone={salary.debt_warning ? 'rose' : 'emerald'}
            big
          />
        </div>
      </div>

      {/* ─── Tasks + Requests ─── */}
      <div className="grid lg:grid-cols-2 gap-5">
        <TasksCard tasks={tasks} />
        <RequestsCard requests={requests} />
      </div>

      {/* ─── Daily history ─── */}
      <HistoryCard />
    </div>
  );
}

/* ───────── History card ───────── */

function HistoryCard() {
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

  return (
    <div className="card p-5">
      <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <Clock size={18} className="text-indigo-600" />
          <h3 className="font-black text-slate-800">سجل الأيام</h3>
          <span className="text-[11px] text-slate-500">
            الهدف {targetDayHr} س/يوم
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
              <th className="p-2 text-right">اليوم</th>
              <th className="p-2 text-center">الحضور</th>
              <th className="p-2 text-center">الانصراف</th>
              <th className="p-2 text-center">ساعات فعلية</th>
              <th className="p-2 text-center">إضافي</th>
              <th className="p-2 text-center">تأخير/نقص</th>
              <th className="p-2 text-center">حوافز</th>
              <th className="p-2 text-center">خصم</th>
              <th className="p-2 text-center">سلف</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {days.map((d) => (
              <tr key={d.day}>
                <td className="p-2 tabular-nums font-medium text-slate-700">
                  {d.day}
                </td>
                <td className="p-2 text-center tabular-nums text-slate-600">
                  {d.first_in
                    ? new Date(d.first_in).toLocaleTimeString('ar-EG', {
                        timeZone: 'Africa/Cairo',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: true,
                      })
                    : '—'}
                </td>
                <td className="p-2 text-center tabular-nums text-slate-600">
                  {d.last_out
                    ? new Date(d.last_out).toLocaleTimeString('ar-EG', {
                        timeZone: 'Africa/Cairo',
                        hour: '2-digit',
                        minute: '2-digit',
                        hour12: true,
                      })
                    : '—'}
                </td>
                <td className="p-2 text-center tabular-nums font-bold">
                  {d.minutes ? fmtMinutes(d.minutes) : '—'}
                </td>
                <td className="p-2 text-center tabular-nums text-emerald-700 font-bold">
                  {d.overtime_min ? `+${fmtMinutes(d.overtime_min)}` : '—'}
                </td>
                <td className="p-2 text-center tabular-nums text-rose-700 font-bold">
                  {d.undertime_min && d.minutes
                    ? `-${fmtMinutes(d.undertime_min)}`
                    : '—'}
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
              </tr>
            ))}
            {!days.length && (
              <tr>
                <td colSpan={9} className="p-10 text-center text-slate-400">
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
  tone: 'indigo' | 'emerald' | 'amber' | 'rose';
  icon?: React.ReactNode;
}) {
  const bg = {
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-700',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    rose: 'bg-rose-50 border-rose-200 text-rose-700',
  }[tone];
  return (
    <div className={`rounded-xl border p-4 ${bg}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[11px] font-bold opacity-80">{label}</span>
        <span className="opacity-80">{icon}</span>
      </div>
      <div className="text-2xl font-black truncate">{value}</div>
      {hint && <div className="text-[10px] opacity-70 mt-0.5">{hint}</div>}
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
    <div className="bg-slate-50 rounded-lg p-3 border border-slate-100">
      <div className="text-[11px] text-slate-500 font-bold mb-1">{label}</div>
      <div
        className={`font-black ${textTone} tabular-nums ${
          big ? 'text-xl' : 'text-base'
        }`}
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
  const [kind, setKind] = useState<
    'advance' | 'leave' | 'overtime_extension'
  >('advance');
  const [amount, setAmount] = useState('');
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('');

  const submit = useMutation({
    mutationFn: () =>
      employeesApi.submitRequest({
        kind,
        amount: kind === 'advance' ? Number(amount) : undefined,
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
              {(['advance', 'leave', 'overtime_extension'] as const).map((k) => (
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

          {kind === 'advance' && (
            <label className="block">
              <span className="text-xs font-bold text-slate-600 mb-1 block">
                قيمة السلفة (ج.م)
              </span>
              <input
                type="number"
                className="input w-full"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                min={0}
                step="0.01"
                placeholder="0.00"
              />
            </label>
          )}

          {kind !== 'advance' && (
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
          )}

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
                if (kind === 'advance' && (!amount || Number(amount) <= 0)) {
                  toast.error('يجب تحديد قيمة السلفة');
                  return;
                }
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
