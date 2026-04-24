import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Clock,
  LogIn,
  LogOut,
  Calendar,
  Users,
  Timer,
} from 'lucide-react';
import toast from 'react-hot-toast';
import {
  attendanceApi,
  type AttendanceRecord,
} from '@/api/attendance.api';
import { useAuthStore } from '@/stores/auth.store';
import { invalidateMonthly } from '@/utils/employee-cache';

const fmtTime = (iso: string | null) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
  });
};

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString('ar-EG', { weekday: 'long' });

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

const fmtMinutes = (mins: number | null) => {
  if (mins == null) return '—';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}س ${m.toString().padStart(2, '0')}د`;
};

export default function Attendance() {
  const user = useAuthStore((s) => s.user);
  const qc = useQueryClient();
  const isAdmin = !!user && ['admin', 'manager', 'accountant'].includes(user.role);

  const today = new Date().toISOString().slice(0, 10);
  const thirtyAgo = new Date(Date.now() - 29 * 24 * 3600 * 1000)
    .toISOString()
    .slice(0, 10);
  const [from, setFrom] = useState(thirtyAgo);
  const [to, setTo] = useState(today);

  const [now, setNow] = useState(new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const { data: myRecord } = useQuery({
    queryKey: ['attendance-my-today'],
    queryFn: () => attendanceApi.myToday(),
    refetchInterval: 60_000,
  });

  const { data: list = [] } = useQuery({
    queryKey: ['attendance-list', from, to],
    queryFn: () => attendanceApi.list({ from, to, limit: 500 }),
    enabled: isAdmin,
  });

  const { data: summary = [] } = useQuery({
    queryKey: ['attendance-summary', from, to],
    queryFn: () => attendanceApi.summary(from, to),
    enabled: isAdmin,
  });

  // PR-1: broaden invalidation to match EmployeeProfile.tsx so the
  // Team list, Payroll tab, and Employee Profile cards all refresh
  // when clock-in/out happens from this page. Previously only the
  // attendance-* keys refreshed and downstream balances stayed stale
  // until the user navigated.
  const clockIn = useMutation({
    mutationFn: (note?: string) => attendanceApi.clockIn(note),
    onSuccess: () => {
      toast.success('تم تسجيل الحضور');
      invalidateMonthly(qc);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'تعذر تسجيل الحضور'),
  });

  const clockOut = useMutation({
    mutationFn: (note?: string) => attendanceApi.clockOut(note),
    onSuccess: () => {
      toast.success('تم تسجيل الانصراف');
      invalidateMonthly(qc);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'تعذر تسجيل الانصراف'),
  });

  // Live elapsed when clocked in without clock_out
  const elapsedText = (() => {
    if (!myRecord?.clock_in || myRecord?.clock_out) return null;
    const ms = now.getTime() - new Date(myRecord.clock_in).getTime();
    const mins = Math.floor(ms / 60000);
    return fmtMinutes(mins);
  })();

  return (
    <div className="p-6 space-y-6" dir="rtl">
      <header>
        <h1 className="text-2xl font-black flex items-center gap-2 text-slate-800">
          <Clock className="w-7 h-7 text-brand-500" />
          الحضور والانصراف
        </h1>
        <p className="text-sm text-slate-500 mt-1">
          سجّل حضورك وانصرافك، وتابع حضور فريق العمل.
        </p>
      </header>

      {/* Clock-in widget */}
      <section className="card p-6 bg-gradient-to-l from-brand-50 to-white border border-brand-100">
        <div className="flex items-center justify-between flex-wrap gap-4">
          <div>
            <div className="text-xs text-slate-500">مستخدم</div>
            <div className="text-lg font-black text-slate-800">
              {user?.full_name || user?.username}
            </div>
            <div className="text-xs text-slate-500 mt-1">
              {fmtDay(today)} · {fmtDate(today)}
            </div>
          </div>
          <div className="text-center">
            <div className="text-xs text-slate-500 mb-1">الوقت الحالي</div>
            <div className="font-mono text-3xl font-black text-brand-600">
              {now.toLocaleTimeString('en-US', { hour12: true })}
            </div>
          </div>
          <div className="flex items-center gap-3">
            {myRecord?.clock_in && !myRecord?.clock_out ? (
              <div className="text-left">
                <div className="text-xs text-emerald-600 font-bold">
                  حضرت في {fmtTime(myRecord.clock_in)}
                </div>
                {elapsedText && (
                  <div className="text-xs text-slate-500 font-mono">
                    منذ {elapsedText}
                  </div>
                )}
              </div>
            ) : myRecord?.clock_in && myRecord?.clock_out ? (
              <div className="text-left text-xs text-slate-600">
                <div>
                  حضور: <span className="font-mono">{fmtTime(myRecord.clock_in)}</span>
                </div>
                <div>
                  انصراف:{' '}
                  <span className="font-mono">{fmtTime(myRecord.clock_out)}</span>
                </div>
                <div className="text-slate-500">
                  المدة: {fmtMinutes(myRecord.duration_min)}
                </div>
              </div>
            ) : null}

            {!myRecord?.clock_in || myRecord?.clock_out ? (
              <button
                onClick={() => clockIn.mutate(undefined)}
                disabled={clockIn.isPending}
                className="btn-primary flex items-center gap-2"
              >
                <LogIn className="w-4 h-4" />
                تسجيل حضور
              </button>
            ) : (
              <button
                onClick={() => clockOut.mutate(undefined)}
                disabled={clockOut.isPending}
                className="btn-ghost border border-rose-200 text-rose-700 hover:bg-rose-50 flex items-center gap-2"
              >
                <LogOut className="w-4 h-4" />
                تسجيل انصراف
              </button>
            )}
          </div>
        </div>
      </section>

      {isAdmin && (
        <>
          {/* Filters */}
          <section className="card p-4 flex items-center gap-3 flex-wrap">
            <Calendar className="w-4 h-4 text-slate-400" />
            <span className="text-sm text-slate-600">من</span>
            <input
              type="date"
              className="input w-40"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
            <span className="text-sm text-slate-600">إلى</span>
            <input
              type="date"
              className="input w-40"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </section>

          {/* Summary per user */}
          <section className="card p-4">
            <div className="flex items-center gap-2 mb-3">
              <Users className="w-5 h-5 text-brand-500" />
              <h2 className="font-bold text-slate-800">ملخص الموظفين</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="p-3 text-right">الموظف</th>
                    <th className="p-3 text-right">أيام الحضور</th>
                    <th className="p-3 text-right">إجمالي الوقت</th>
                    <th className="p-3 text-right">أول حضور</th>
                    <th className="p-3 text-right">آخر انصراف</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {summary.length === 0 && (
                    <tr>
                      <td
                        colSpan={5}
                        className="p-6 text-center text-slate-400"
                      >
                        لا توجد بيانات
                      </td>
                    </tr>
                  )}
                  {summary.map((s) => (
                    <tr key={s.user_id} className="hover:bg-slate-50">
                      <td className="p-3 font-medium">
                        {s.full_name || s.username}
                      </td>
                      <td className="p-3">
                        <span className="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 text-xs font-bold">
                          {s.days_present}
                        </span>
                      </td>
                      <td className="p-3 font-mono">
                        {fmtMinutes(s.total_minutes)}
                      </td>
                      <td className="p-3 text-xs text-slate-500 font-mono">
                        {s.first_in
                          ? `${fmtDate(s.first_in)} ${fmtTime(s.first_in)}`
                          : '—'}
                      </td>
                      <td className="p-3 text-xs text-slate-500 font-mono">
                        {s.last_out
                          ? `${fmtDate(s.last_out)} ${fmtTime(s.last_out)}`
                          : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          {/* Full log */}
          <section className="card p-4">
            <div className="flex items-center gap-2 mb-3">
              <Timer className="w-5 h-5 text-brand-500" />
              <h2 className="font-bold text-slate-800">سجل الحضور التفصيلي</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-slate-600">
                  <tr>
                    <th className="p-3 text-right">اليوم</th>
                    <th className="p-3 text-right">التاريخ</th>
                    <th className="p-3 text-right">الموظف</th>
                    <th className="p-3 text-right">حضور</th>
                    <th className="p-3 text-right">انصراف</th>
                    <th className="p-3 text-right">المدة</th>
                    <th className="p-3 text-right">IP</th>
                    <th className="p-3 text-right">الجهاز</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {list.length === 0 && (
                    <tr>
                      <td
                        colSpan={8}
                        className="p-6 text-center text-slate-400"
                      >
                        لا توجد سجلات في الفترة المحددة
                      </td>
                    </tr>
                  )}
                  {list.map((r: AttendanceRecord) => (
                    <tr key={r.id} className="hover:bg-slate-50">
                      <td className="p-3 text-xs">{fmtDay(r.work_date)}</td>
                      <td className="p-3 text-xs font-mono">
                        {fmtDate(r.work_date)}
                      </td>
                      <td className="p-3 font-medium">
                        {r.full_name || r.username}
                        {r.role_name && (
                          <div className="text-[10px] text-slate-400">
                            {r.role_name}
                          </div>
                        )}
                      </td>
                      <td className="p-3 text-xs font-mono text-emerald-700">
                        {fmtTime(r.clock_in)}
                      </td>
                      <td className="p-3 text-xs font-mono text-rose-700">
                        {fmtTime(r.clock_out)}
                      </td>
                      <td className="p-3 text-xs font-mono">
                        {fmtMinutes(r.duration_min)}
                      </td>
                      <td className="p-3 text-xs font-mono text-slate-500">
                        {r.ip_in || '—'}
                      </td>
                      <td className="p-3 text-xs text-slate-500">
                        {r.device_in?.browser || r.device_in?.os || '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
