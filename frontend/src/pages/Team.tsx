import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Users,
  Search,
  DollarSign,
  Clock,
  ListPlus,
  Gift,
  Minus,
  ClipboardList,
  CheckCircle2,
  XCircle,
  Settings,
  Eye,
  ArrowLeft,
} from 'lucide-react';
import {
  employeesApi,
  TeamRow,
  EmployeeRequest,
  EmployeeDashboard,
} from '@/api/employees.api';
import { useAuthStore } from '@/stores/auth.store';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const FREQ_LABEL = {
  daily: 'يومي',
  weekly: 'أسبوعي',
  monthly: 'شهري',
} as const;

function fmtHours(minutes: number) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
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

export default function Team() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [q, setQ] = useState('');
  const [active, setActive] = useState<TeamRow | null>(null);

  const { data: team = [] } = useQuery({
    queryKey: ['employees-team'],
    queryFn: () => employeesApi.team(),
    refetchInterval: 60_000,
  });

  const { data: pending = [] } = useQuery({
    queryKey: ['employees-pending'],
    queryFn: () => employeesApi.pendingRequests(),
    enabled: hasPermission('employee.requests.approve'),
    refetchInterval: 30_000,
  });

  const filtered = useMemo(() => {
    if (!q.trim()) return team;
    const needle = q.trim().toLowerCase();
    return team.filter(
      (t) =>
        t.full_name?.toLowerCase().includes(needle) ||
        t.username?.toLowerCase().includes(needle) ||
        t.employee_no?.toLowerCase().includes(needle),
    );
  }, [team, q]);

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Users className="text-indigo-600" />
            إدارة فريق العمل
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            ملفات الموظفين · المهام · الحوافز · الاستقطاعات · الطلبات
          </p>
        </div>
      </div>

      {pending.length > 0 && (
        <PendingInbox requests={pending} />
      )}

      <div className="card p-4">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <div className="flex items-center gap-2 flex-1 max-w-md">
            <Search size={14} className="text-slate-400" />
            <input
              className="input flex-1"
              placeholder="بحث بالاسم / اسم المستخدم / كود الموظف"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
          <div className="text-xs text-slate-500">
            عدد الموظفين: <span className="font-bold">{team.length}</span>
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-xs">
              <tr>
                <th className="p-3 text-right">الموظف</th>
                <th className="p-3 text-center">الدور</th>
                <th className="p-3 text-center">الراتب</th>
                <th className="p-3 text-center">ساعات الشهر</th>
                <th className="p-3 text-center">سلف الشهر</th>
                <th className="p-3 text-center">حوافز الشهر</th>
                <th className="p-3 text-center">مهام / طلبات</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {filtered.map((t) => (
                <tr key={t.id} className="hover:bg-slate-50">
                  <td className="p-3">
                    <div className="font-bold text-slate-800">
                      {t.full_name || t.username}
                    </div>
                    <div className="text-[10px] font-mono text-slate-400 flex items-center gap-1.5 mt-0.5">
                      <span>{t.employee_no}</span>
                      {t.job_title && <span>· {t.job_title}</span>}
                    </div>
                  </td>
                  <td className="p-3 text-center text-xs">
                    <span className="chip bg-indigo-50 border-indigo-200 text-indigo-700">
                      {t.role_name || '—'}
                    </span>
                  </td>
                  <td className="p-3 text-center tabular-nums font-mono">
                    {EGP(t.salary_amount)}
                    <div className="text-[10px] text-slate-400">
                      {FREQ_LABEL[t.salary_frequency]}
                    </div>
                  </td>
                  <td className="p-3 text-center tabular-nums">
                    {fmtHours(Number(t.minutes_this_month || 0))}
                  </td>
                  <td className="p-3 text-center tabular-nums font-mono text-amber-700">
                    {EGP(t.advances_this_month)}
                  </td>
                  <td className="p-3 text-center tabular-nums font-mono text-emerald-700">
                    {EGP(t.bonuses_this_month)}
                  </td>
                  <td className="p-3 text-center text-xs">
                    {Number(t.open_tasks) > 0 && (
                      <span className="chip bg-indigo-50 text-indigo-700 border-indigo-200 mx-0.5">
                        {t.open_tasks} مهمة
                      </span>
                    )}
                    {Number(t.pending_requests) > 0 && (
                      <span className="chip bg-amber-50 text-amber-700 border-amber-200 mx-0.5">
                        {t.pending_requests} طلب
                      </span>
                    )}
                  </td>
                  <td className="p-3">
                    <button
                      className="p-1.5 rounded hover:bg-brand-50 text-slate-500 hover:text-brand-600"
                      onClick={() => setActive(t)}
                      title="فتح الملف"
                    >
                      <Eye size={14} />
                    </button>
                  </td>
                </tr>
              ))}
              {!filtered.length && (
                <tr>
                  <td colSpan={8} className="p-10 text-center text-slate-400">
                    لا نتائج
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {active && (
        <EmployeeDetailDrawer
          row={active}
          onClose={() => setActive(null)}
        />
      )}
    </div>
  );
}

/* ───────── Pending-requests inbox ───────── */

const KIND_LABEL: Record<string, string> = {
  advance: 'سلفة',
  leave: 'إجازة',
  overtime_extension: 'تمديد ساعات إضافية',
  other: 'أخرى',
};

function PendingInbox({ requests }: { requests: EmployeeRequest[] }) {
  const qc = useQueryClient();
  const [rejectTarget, setRejectTarget] = useState<EmployeeRequest | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const decide = useMutation({
    mutationFn: ({
      id,
      decision,
      reason,
    }: {
      id: string | number;
      decision: 'approved' | 'rejected';
      reason?: string;
    }) => employeesApi.decideRequest(id, { decision, reason }),
    onSuccess: (_r, v) => {
      toast.success(
        v.decision === 'approved' ? 'تم اعتماد الطلب' : 'تم رفض الطلب',
      );
      qc.invalidateQueries({ queryKey: ['employees-pending'] });
      qc.invalidateQueries({ queryKey: ['employees-team'] });
      setRejectTarget(null);
      setRejectReason('');
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تنفيذ القرار'),
  });

  return (
    <div className="card p-5 border-2 border-amber-200 bg-amber-50/40">
      <div className="flex items-center gap-2 mb-3">
        <ClipboardList className="text-amber-600" size={18} />
        <h3 className="font-black text-amber-800">
          طلبات تنتظر اعتمادك ({requests.length})
        </h3>
      </div>
      <div className="space-y-2">
        {requests.map((r) => (
          <div
            key={r.id}
            className="bg-white border border-amber-200 rounded-lg p-3 text-xs"
          >
            <div className="flex items-center justify-between mb-1 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <span className="chip bg-amber-100 text-amber-700 border-amber-200 font-bold text-[10px]">
                  {KIND_LABEL[r.kind]}
                </span>
                <span className="font-bold text-slate-800">
                  {r.user_name || r.username}
                </span>
                {r.employee_no && (
                  <span className="font-mono text-[10px] text-slate-400">
                    {r.employee_no}
                  </span>
                )}
                {r.amount != null && (
                  <span className="font-mono text-slate-700">
                    {EGP(r.amount)}
                  </span>
                )}
              </div>
              <span className="text-slate-500 tabular-nums">
                {fmtWhen(r.created_at)}
              </span>
            </div>
            {r.reason && (
              <div className="text-slate-600 mb-2">السبب: {r.reason}</div>
            )}
            {(r.starts_at || r.ends_at) && (
              <div className="text-slate-600 mb-2 tabular-nums">
                {r.starts_at && <>من {fmtWhen(r.starts_at)}</>}
                {r.ends_at && <> · إلى {fmtWhen(r.ends_at)}</>}
              </div>
            )}
            <div className="flex items-center gap-2">
              <button
                className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[11px]"
                disabled={decide.isPending}
                onClick={() =>
                  decide.mutate({ id: r.id, decision: 'approved' })
                }
              >
                <CheckCircle2 size={12} /> اعتماد
              </button>
              <button
                className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-700 text-white font-bold text-[11px]"
                disabled={decide.isPending}
                onClick={() => {
                  setRejectTarget(r);
                  setRejectReason('');
                }}
              >
                <XCircle size={12} /> رفض
              </button>
            </div>
          </div>
        ))}
      </div>

      {rejectTarget && (
        <div
          className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4"
          onClick={() => {
            if (!decide.isPending) {
              setRejectTarget(null);
              setRejectReason('');
            }
          }}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="font-black text-slate-800 mb-2">رفض الطلب</h4>
            <p className="text-xs text-slate-500 mb-3">
              اكتب سبب الرفض — سيظهر لمقدم الطلب.
            </p>
            <textarea
              rows={3}
              className="input w-full"
              placeholder="مثال: تعارض مع مواعيد الفريق / ميزانية غير كافية"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              disabled={decide.isPending}
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                className="btn-ghost"
                disabled={decide.isPending}
                onClick={() => {
                  setRejectTarget(null);
                  setRejectReason('');
                }}
              >
                إلغاء
              </button>
              <button
                className="px-4 py-2 rounded-lg bg-rose-600 text-white text-sm font-bold"
                disabled={decide.isPending}
                onClick={() => {
                  if (!rejectReason.trim()) {
                    toast.error('يجب كتابة سبب الرفض');
                    return;
                  }
                  decide.mutate({
                    id: rejectTarget.id,
                    decision: 'rejected',
                    reason: rejectReason.trim(),
                  });
                }}
              >
                تأكيد الرفض
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ───────── Detail drawer ───────── */

type DetailTab = 'overview' | 'profile' | 'bonus' | 'deduction' | 'task';

function EmployeeDetailDrawer({
  row,
  onClose,
}: {
  row: TeamRow;
  onClose: () => void;
}) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const [tab, setTab] = useState<DetailTab>('overview');

  const { data: dash } = useQuery({
    queryKey: ['employee-user-dashboard', row.id],
    queryFn: () => employeesApi.userDashboard(row.id),
  });

  const tabs: Array<{ key: DetailTab; label: string; show: boolean }> = [
    { key: 'overview', label: 'نظرة عامة', show: true },
    {
      key: 'profile',
      label: 'تعديل الملف',
      show: hasPermission('employee.profile.manage'),
    },
    {
      key: 'bonus',
      label: 'حافز / مكافأة',
      show: hasPermission('employee.bonuses.manage'),
    },
    {
      key: 'deduction',
      label: 'خصم',
      show: hasPermission('employee.deductions.manage'),
    },
    {
      key: 'task',
      label: 'إسناد مهمة',
      show: hasPermission('employee.tasks.assign'),
    },
  ];

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex" onClick={onClose}>
      <div
        className="mr-auto w-full max-w-2xl bg-slate-50 h-full overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="sticky top-0 bg-white border-b border-slate-200 p-4 flex items-center justify-between z-10">
          <div>
            <h3 className="font-black text-slate-800">
              {row.full_name || row.username}
            </h3>
            <div className="text-xs text-slate-500 font-mono">
              {row.employee_no} · {row.role_name}
            </div>
          </div>
          <button
            className="p-2 rounded hover:bg-slate-100"
            onClick={onClose}
            title="إغلاق"
          >
            <ArrowLeft size={16} />
          </button>
        </div>

        <div className="px-4 pt-3">
          <div className="inline-flex rounded-lg bg-slate-200 p-1 flex-wrap">
            {tabs
              .filter((t) => t.show)
              .map((t) => (
                <button
                  key={t.key}
                  className={`px-3 py-1.5 rounded-md text-xs font-bold ${
                    tab === t.key
                      ? 'bg-white text-indigo-700 shadow-sm'
                      : 'text-slate-600'
                  }`}
                  onClick={() => setTab(t.key)}
                >
                  {t.label}
                </button>
              ))}
          </div>
        </div>

        <div className="p-4 space-y-4">
          {tab === 'overview' && <OverviewTab dash={dash} />}
          {tab === 'profile' && <ProfileForm userId={row.id} dash={dash} />}
          {tab === 'bonus' && <BonusForm userId={row.id} />}
          {tab === 'deduction' && <DeductionForm userId={row.id} />}
          {tab === 'task' && <TaskForm userId={row.id} />}
        </div>
      </div>
    </div>
  );
}

function OverviewTab({ dash }: { dash?: EmployeeDashboard }) {
  if (!dash)
    return <div className="text-center text-slate-400 py-10">جارٍ التحميل…</div>;
  const { salary, attendance, tasks, requests } = dash;
  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
        <div className="bg-white border border-slate-200 rounded-lg p-3">
          <div className="text-slate-500 text-[11px]">ساعات الشهر</div>
          <div className="font-black text-indigo-700 tabular-nums">
            {fmtHours(attendance.month.minutes)}
          </div>
          <div className="text-slate-400 text-[10px]">
            {attendance.month.days} يوم
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-3">
          <div className="text-slate-500 text-[11px]">مستحق</div>
          <div className="font-black text-emerald-700 tabular-nums">
            {EGP(salary.accrued)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-3">
          <div className="text-slate-500 text-[11px]">سلف الشهر</div>
          <div className="font-black text-amber-700 tabular-nums">
            {EGP(salary.advances_month)}
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-lg p-3">
          <div className="text-slate-500 text-[11px]">الصافي</div>
          <div
            className={`font-black tabular-nums ${
              salary.debt_warning ? 'text-rose-700' : 'text-emerald-700'
            }`}
          >
            {EGP(salary.net)}
          </div>
        </div>
      </div>

      <div className="card p-4">
        <h4 className="font-bold text-slate-800 mb-2 flex items-center gap-2 text-sm">
          <Clock size={14} /> مهام مفتوحة ({tasks.length})
        </h4>
        {tasks.length === 0 ? (
          <div className="text-xs text-slate-400">لا مهام مفتوحة</div>
        ) : (
          <ul className="space-y-1 text-xs">
            {tasks.map((t) => (
              <li
                key={t.id}
                className="flex items-center justify-between border-b border-slate-100 last:border-0 py-1"
              >
                <span className="font-bold text-slate-700">{t.title}</span>
                <span className="chip bg-slate-50 border-slate-200 text-slate-600 text-[10px]">
                  {t.status === 'pending'
                    ? 'لم يستلم'
                    : t.status === 'acknowledged'
                      ? 'مستلمة'
                      : t.status}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="card p-4">
        <h4 className="font-bold text-slate-800 mb-2 text-sm">
          طلبات معلّقة ({requests.length})
        </h4>
        {requests.length === 0 ? (
          <div className="text-xs text-slate-400">لا توجد طلبات</div>
        ) : (
          <ul className="space-y-1 text-xs">
            {requests.map((r) => (
              <li
                key={r.id}
                className="flex items-center justify-between border-b border-slate-100 last:border-0 py-1"
              >
                <span>
                  {KIND_LABEL[r.kind]} {r.amount != null && `— ${EGP(r.amount)}`}
                </span>
                <span className="text-slate-400">{fmtWhen(r.created_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function ProfileForm({
  userId,
  dash,
}: {
  userId: string;
  dash?: EmployeeDashboard;
}) {
  const qc = useQueryClient();
  const p = dash?.profile;
  const [employeeNo, setEmployeeNo] = useState(p?.employee_no || '');
  const [jobTitle, setJobTitle] = useState(p?.job_title || '');
  const [hireDate, setHireDate] = useState(p?.hire_date || '');
  const [salaryAmount, setSalaryAmount] = useState(
    String(p?.salary_amount ?? ''),
  );
  const [salaryFrequency, setSalaryFrequency] = useState<
    'daily' | 'weekly' | 'monthly'
  >((p?.salary_frequency as any) || 'monthly');
  const [targetDay, setTargetDay] = useState(
    String(p?.target_hours_day ?? ''),
  );
  const [targetWeek, setTargetWeek] = useState(
    String(p?.target_hours_week ?? ''),
  );
  const [overtimeRate, setOvertimeRate] = useState(
    String(p?.overtime_rate ?? ''),
  );

  const save = useMutation({
    mutationFn: () =>
      employeesApi.updateProfile(userId, {
        employee_no: employeeNo || undefined,
        job_title: jobTitle || undefined,
        hire_date: hireDate || undefined,
        salary_amount: salaryAmount ? Number(salaryAmount) : undefined,
        salary_frequency: salaryFrequency,
        target_hours_day: targetDay ? Number(targetDay) : undefined,
        target_hours_week: targetWeek ? Number(targetWeek) : undefined,
        overtime_rate: overtimeRate ? Number(overtimeRate) : undefined,
      }),
    onSuccess: () => {
      toast.success('تم حفظ الملف');
      qc.invalidateQueries({ queryKey: ['employees-team'] });
      qc.invalidateQueries({ queryKey: ['employee-user-dashboard', userId] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  return (
    <div className="card p-4 space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-3">
        <Field label="كود الموظف">
          <input
            className="input w-full"
            value={employeeNo}
            onChange={(e) => setEmployeeNo(e.target.value)}
          />
        </Field>
        <Field label="المسمى الوظيفي">
          <input
            className="input w-full"
            value={jobTitle}
            onChange={(e) => setJobTitle(e.target.value)}
          />
        </Field>
        <Field label="تاريخ التعيين">
          <input
            type="date"
            className="input w-full"
            value={hireDate ? hireDate.slice(0, 10) : ''}
            onChange={(e) => setHireDate(e.target.value)}
          />
        </Field>
        <Field label="تواتر الصرف">
          <select
            className="input w-full"
            value={salaryFrequency}
            onChange={(e) => setSalaryFrequency(e.target.value as any)}
          >
            <option value="monthly">شهري</option>
            <option value="weekly">أسبوعي</option>
            <option value="daily">يومي</option>
          </select>
        </Field>
        <Field label="قيمة الراتب (ج.م)">
          <input
            type="number"
            step="0.01"
            className="input w-full"
            value={salaryAmount}
            onChange={(e) => setSalaryAmount(e.target.value)}
          />
        </Field>
        <Field label="الساعات المستهدفة في اليوم">
          <input
            type="number"
            step="0.25"
            className="input w-full"
            value={targetDay}
            onChange={(e) => setTargetDay(e.target.value)}
          />
        </Field>
        <Field label="الساعات المستهدفة في الأسبوع">
          <input
            type="number"
            step="0.5"
            className="input w-full"
            value={targetWeek}
            onChange={(e) => setTargetWeek(e.target.value)}
          />
        </Field>
        <Field label="معدل ساعة الإضافي (×)">
          <input
            type="number"
            step="0.1"
            className="input w-full"
            value={overtimeRate}
            onChange={(e) => setOvertimeRate(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <button
          className="btn-primary"
          disabled={save.isPending}
          onClick={() => save.mutate()}
        >
          <Settings size={14} /> حفظ الملف
        </button>
      </div>
    </div>
  );
}

function BonusForm({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [kind, setKind] = useState('bonus');
  const [note, setNote] = useState('');
  const [date, setDate] = useState('');

  const { data: history = [] } = useQuery({
    queryKey: ['employee-bonuses', userId],
    queryFn: () =>
      employeesApi.team().then(() => null).catch(() => null), // placeholder
    enabled: false,
  });
  void history;

  const add = useMutation({
    mutationFn: () =>
      employeesApi.addBonus(userId, {
        amount: Number(amount),
        kind,
        note: note || undefined,
        bonus_date: date || undefined,
      }),
    onSuccess: () => {
      toast.success('تم إضافة الحافز');
      setAmount('');
      setNote('');
      qc.invalidateQueries({ queryKey: ['employees-team'] });
      qc.invalidateQueries({ queryKey: ['employee-user-dashboard', userId] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإضافة'),
  });

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Gift className="text-emerald-600" size={18} />
        <h4 className="font-bold text-slate-800 text-sm">
          إضافة حافز / مكافأة / ساعة إضافية
        </h4>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="القيمة (ج.م)">
          <input
            type="number"
            step="0.01"
            className="input w-full"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="النوع">
          <select
            className="input w-full"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="bonus">مكافأة</option>
            <option value="incentive">حافز أداء</option>
            <option value="overtime">ساعات إضافية</option>
            <option value="other">أخرى</option>
          </select>
        </Field>
        <Field label="التاريخ">
          <input
            type="date"
            className="input w-full"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <Field label="ملاحظات">
          <input
            className="input w-full"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="اختياري"
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <button
          className="btn-primary bg-emerald-600 hover:bg-emerald-700"
          disabled={add.isPending || !amount}
          onClick={() => add.mutate()}
        >
          <ListPlus size={14} /> إضافة
        </button>
      </div>
    </div>
  );
}

function DeductionForm({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [date, setDate] = useState('');

  const add = useMutation({
    mutationFn: () =>
      employeesApi.addDeduction(userId, {
        amount: Number(amount),
        reason,
        deduction_date: date || undefined,
      }),
    onSuccess: () => {
      toast.success('تم إضافة الخصم');
      setAmount('');
      setReason('');
      qc.invalidateQueries({ queryKey: ['employees-team'] });
      qc.invalidateQueries({ queryKey: ['employee-user-dashboard', userId] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإضافة'),
  });

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <Minus className="text-rose-600" size={18} />
        <h4 className="font-bold text-slate-800 text-sm">إضافة خصم</h4>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Field label="القيمة (ج.م)">
          <input
            type="number"
            step="0.01"
            className="input w-full"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </Field>
        <Field label="التاريخ">
          <input
            type="date"
            className="input w-full"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </Field>
        <div className="col-span-2">
          <Field label="السبب">
            <textarea
              rows={2}
              className="input w-full"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="مثال: مخالفة مواعيد / خصم مخزون / إلخ"
            />
          </Field>
        </div>
      </div>
      <div className="flex justify-end">
        <button
          className="btn-primary bg-rose-600 hover:bg-rose-700"
          disabled={add.isPending || !amount || !reason.trim()}
          onClick={() => add.mutate()}
        >
          <Minus size={14} /> تأكيد الخصم
        </button>
      </div>
    </div>
  );
}

function TaskForm({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState<
    'low' | 'normal' | 'high' | 'urgent'
  >('normal');
  const [dueAt, setDueAt] = useState('');

  const add = useMutation({
    mutationFn: () =>
      employeesApi.createTask({
        user_id: userId,
        title,
        description: description || undefined,
        priority,
        due_at: dueAt || undefined,
      }),
    onSuccess: () => {
      toast.success('تم إسناد المهمة');
      setTitle('');
      setDescription('');
      setDueAt('');
      qc.invalidateQueries({ queryKey: ['employees-team'] });
      qc.invalidateQueries({ queryKey: ['employee-user-dashboard', userId] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإسناد'),
  });

  return (
    <div className="card p-4 space-y-3">
      <div className="flex items-center gap-2">
        <ListPlus className="text-indigo-600" size={18} />
        <h4 className="font-bold text-slate-800 text-sm">إسناد مهمة جديدة</h4>
      </div>
      <Field label="العنوان">
        <input
          className="input w-full"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="مثال: جرد رف الأحذية · الدور الثاني"
        />
      </Field>
      <Field label="تفاصيل">
        <textarea
          rows={3}
          className="input w-full"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="الأولوية">
          <select
            className="input w-full"
            value={priority}
            onChange={(e) => setPriority(e.target.value as any)}
          >
            <option value="low">منخفضة</option>
            <option value="normal">عادية</option>
            <option value="high">هامة</option>
            <option value="urgent">عاجلة</option>
          </select>
        </Field>
        <Field label="موعد الإنجاز">
          <input
            type="datetime-local"
            className="input w-full"
            value={dueAt}
            onChange={(e) => setDueAt(e.target.value)}
          />
        </Field>
      </div>
      <div className="flex justify-end">
        <button
          className="btn-primary"
          disabled={add.isPending || !title.trim()}
          onClick={() => add.mutate()}
        >
          <ListPlus size={14} /> إسناد
        </button>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs text-slate-600 font-bold mb-1 block">
        {label}
      </span>
      {children}
    </label>
  );
}
