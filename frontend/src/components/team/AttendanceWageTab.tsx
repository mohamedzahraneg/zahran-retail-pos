/**
 * AttendanceWageTab — PR-T2
 * ─────────────────────────────────────────────────────────────────────
 *
 * Redesigned الحضور واليوميات tab inside the unified Team Management
 * workspace. Replaces the cramped AdminAttendancePanel that was lifted
 * verbatim from EmployeeProfile.tsx in PR-T1.
 *
 * Key UX intent (per user spec):
 *   · Make the boundary between WAGE APPROVAL and WAGE PAYOUT visually
 *     unmissable. Approval is an accrual (DR 521 / CR 213) — no
 *     cashbox movement, no shift impact. Payout (separate flow,
 *     redesigned in PR-T3) is the only path that touches the drawer.
 *   · Wage approval lives in a focused modal with an accounting
 *     preview block, not as a side-form sharing space with payout.
 *   · Surface payable_days history (formerly invisible — the
 *     `payableDays` API was wired client-side but had zero consumers).
 *   · Surface the void path (formerly invisible — `adminVoidAccrual`
 *     was wired but had zero consumers).
 *
 * Backend invariants (all unchanged in this PR — confirmed by audit):
 *   · /attendance/admin/approve-wage-override is the canonical approval
 *     endpoint. PR-25's atomicity fix (em-threading in
 *     adminApproveWageOverride) means re-approving an existing day
 *     atomically voids+reposts in one transaction. No new replacement
 *     row is silently lost.
 *   · /attendance/admin/void-accrual marks the accrual + its JE void.
 *     Per migration 085, the void does NOT post a reversal JE —
 *     v_employee_gl_balance excludes voided JEs so the math returns
 *     to pre-approval automatically.
 *   · Wage payout (employee_settlement → DR 213 / CR cashbox) is NOT
 *     changed in this PR. The "صرف يومية" button still opens the
 *     existing PayWageModal (from EmployeeProfile.tsx) — redesign
 *     deferred to PR-T3.
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  CalendarCheck,
  Clock,
  ShieldCheck,
  Banknote,
  AlertTriangle,
  Wallet,
  X,
  CheckCircle2,
  XCircle,
  Edit3,
  Receipt,
} from 'lucide-react';
import {
  attendanceApi,
  AttendanceRecord,
  PayableDayRow,
} from '@/api/attendance.api';
import { useAuthStore } from '@/stores/auth.store';
import { TeamRow } from '@/api/employees.api';
// PR-T2 — payout intentionally stays in its current modal (PR-15 design).
// Redesign + source-selector polish for payout lands in PR-T3. We import
// PayWageModal so the "صرف يومية" button keeps working from the new tab.
import { PayWageModal } from '@/pages/EmployeeProfile';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const fmtTime = (iso: string | null | undefined) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleTimeString('en-GB', {
    timeZone: 'Africa/Cairo',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

const fmtDate = (iso: string | null | undefined) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
};

const fmtMin = (m: number | null | undefined) => {
  const mm = Number(m || 0);
  const h = Math.floor(mm / 60);
  const r = mm % 60;
  return `${h}س ${String(r).padStart(2, '0')}د`;
};

/* ─────────────────────────────────────────────────────────────────
 * Top-level component
 * ───────────────────────────────────────────────────────────────── */

export function AttendanceWageTab({ employee }: { employee: TeamRow }) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canManage = hasPermission('employee.attendance.manage');
  const canPayWage = hasPermission('employee.ledger.view');

  const userId = employee.id;
  const dailyAmount = Number(employee.salary_amount || 0);
  const liveGl = Number(employee.gl_balance || 0);

  const [approveOpen, setApproveOpen] = useState(false);
  const [editTarget, setEditTarget] = useState<PayableDayRow | null>(null);
  const [payoutOpen, setPayoutOpen] = useState(false);

  // Window: current month (Cairo) by default. Same window the dashboard
  // headlines use, so totals here line up with what's shown on the
  // employee profile summary card.
  const range = useMemo(() => monthBounds(), []);

  return (
    <div className="space-y-5">
      <HeaderCard />

      {/* Action bar — approval is left-aligned (primary action), payout
          sits with a distinct visual treatment so it's not confused with
          approval. Both gated on the existing per-action permissions. */}
      <div className="flex items-center justify-between flex-wrap gap-2 bg-white rounded-2xl border border-slate-200 shadow-sm p-3">
        <div className="flex items-center gap-2 flex-wrap">
          {canManage && (
            <button
              type="button"
              onClick={() => setApproveOpen(true)}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700"
            >
              <CheckCircle2 size={15} />
              اعتماد يومية
            </button>
          )}
          {canManage && <AdminClockInOutButtons userId={userId} />}
        </div>
        {canPayWage && (
          <button
            type="button"
            onClick={() => setPayoutOpen(true)}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-amber-50 text-amber-800 border border-amber-200 text-sm font-bold hover:bg-amber-100"
            title="صرف نقدي فعلي — يفتح الواجهة الحالية للصرف (سيتم تحديثها في PR-T3)"
          >
            <Wallet size={15} />
            صرف يومية / مستحقات
          </button>
        )}
      </div>

      <SummaryCards userId={userId} from={range.from} to={range.to} />
      <AttendanceLogCard userId={userId} from={range.from} to={range.to} />
      <DailyWageCard
        userId={userId}
        from={range.from}
        to={range.to}
        dailyAmount={dailyAmount}
        canManage={canManage}
        onEdit={(row) => setEditTarget(row)}
      />

      {approveOpen && (
        <WageApprovalModal
          userId={userId}
          fullName={employee.full_name || employee.username}
          dailyAmount={dailyAmount}
          onClose={() => setApproveOpen(false)}
        />
      )}
      {editTarget && (
        <WageApprovalModal
          userId={userId}
          fullName={employee.full_name || employee.username}
          dailyAmount={dailyAmount}
          existing={editTarget}
          onClose={() => setEditTarget(null)}
        />
      )}
      {payoutOpen && (
        <PayWageModal
          userId={userId}
          fullName={employee.full_name || employee.username}
          liveGlBalance={liveGl}
          onClose={() => setPayoutOpen(false)}
          onSuccess={() => setPayoutOpen(false)}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Sections
 * ───────────────────────────────────────────────────────────────── */

function HeaderCard() {
  return (
    <div className="rounded-2xl border border-violet-200 bg-violet-50/60 p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-violet-100 text-violet-700 flex items-center justify-center shrink-0">
          <CalendarCheck size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-black text-violet-900">
            الحضور واليوميات
          </h3>
          <p className="text-sm text-violet-900/70 mt-0.5">
            متابعة الحضور واعتماد اليوميات بدون صرف نقدي.
          </p>
          <div className="mt-3 flex items-start gap-2 rounded-xl bg-white border border-violet-200 px-3 py-2 text-xs text-slate-700 leading-relaxed">
            <ShieldCheck size={14} className="text-violet-600 shrink-0 mt-0.5" />
            <span>
              <span className="font-bold text-violet-900">اعتماد اليومية</span>
              {' '}يضيف مستحقًا للموظف فقط (DR 521 / CR 213) ولا يؤثر على
              الخزنة أو الوردية. الصرف النقدي يتم من زر{' '}
              <span className="font-bold text-amber-700">صرف يومية / مستحقات</span>
              {' '}بشكل منفصل.
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

function AdminClockInOutButtons({ userId }: { userId: string }) {
  const qc = useQueryClient();
  const inMut = useMutation({
    mutationFn: () => attendanceApi.adminClockIn({ user_id: userId }),
    onSuccess: () => {
      toast.success('تم تسجيل الحضور نيابةً');
      invalidate(qc);
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'فشل'),
  });
  const outMut = useMutation({
    mutationFn: () => attendanceApi.adminClockOut({ user_id: userId }),
    onSuccess: () => {
      toast.success('تم تسجيل الانصراف نيابةً');
      invalidate(qc);
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'فشل'),
  });
  return (
    <>
      <button
        type="button"
        onClick={() => inMut.mutate()}
        disabled={inMut.isPending}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-50"
      >
        <Clock size={14} />
        تسجيل حضور
      </button>
      <button
        type="button"
        onClick={() => outMut.mutate()}
        disabled={outMut.isPending}
        className="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 text-xs font-bold hover:bg-slate-50"
      >
        <Clock size={14} />
        تسجيل انصراف
      </button>
    </>
  );
}

function SummaryCards({
  userId,
  from,
  to,
}: {
  userId: string;
  from: string;
  to: string;
}) {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
  const { data: todayRow } = useQuery({
    queryKey: ['attendance-employee-today', userId, today],
    queryFn: () =>
      attendanceApi.list({ user_id: userId, from: today, to: today, limit: 1 }),
  });
  const { data: payable = [] } = useQuery({
    queryKey: ['payable-days', userId, from, to],
    queryFn: () => attendanceApi.payableDays({ user_id: userId, from, to }),
  });

  const todayAttendance = (todayRow as AttendanceRecord[] | undefined)?.[0];
  const presentToday = !!todayAttendance?.clock_in;
  const leftToday = !!todayAttendance?.clock_out;

  // Status derivation:
  //   · معتمدة = is_void=false (live accrual)
  //   · ملغاة  = is_void=true AND no live row exists for the same date
  //   · معدلة  = is_void=true AND a live row exists for the same date
  //              (the void was followed by a successful re-approval —
  //               PR-25's atomic void+repost path)
  const stats = useMemo(() => {
    const liveDates = new Set<string>();
    let approvedCount = 0;
    let approvedSum = 0;
    let editedCount = 0;
    let voidedCount = 0;
    for (const p of payable as PayableDayRow[]) {
      if (!p.is_void) {
        approvedCount++;
        approvedSum += Number(p.amount_accrued || 0);
        liveDates.add(p.work_date);
      }
    }
    for (const p of payable as PayableDayRow[]) {
      if (p.is_void) {
        if (liveDates.has(p.work_date)) editedCount++;
        else voidedCount++;
      }
    }
    return { approvedCount, approvedSum, editedCount, voidedCount };
  }, [payable]);

  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
      <SmallStat
        tone={presentToday ? 'green' : 'slate'}
        icon={<CheckCircle2 size={18} />}
        label="حاضر اليوم"
        value={presentToday ? 'نعم' : 'لا'}
        sub={todayAttendance?.clock_in ? `منذ ${fmtTime(todayAttendance.clock_in)}` : undefined}
      />
      <SmallStat
        tone={leftToday ? 'orange' : 'slate'}
        icon={<Clock size={18} />}
        label="منصرف"
        value={leftToday ? 'نعم' : 'لا'}
        sub={todayAttendance?.clock_out ? fmtTime(todayAttendance.clock_out) : undefined}
      />
      <SmallStat
        tone={!todayAttendance ? 'red' : 'slate'}
        icon={<XCircle size={18} />}
        label="لم يسجل حضور اليوم"
        value={!todayAttendance ? 'نعم' : 'لا'}
      />
      <SmallStat
        tone="green"
        icon={<Banknote size={18} />}
        label="يوميات معتمدة"
        value={String(stats.approvedCount)}
        sub={`إجمالي ${EGP(stats.approvedSum)}`}
      />
      <SmallStat
        tone="amber"
        icon={<Edit3 size={18} />}
        label="يوميات معدلة"
        value={String(stats.editedCount)}
        sub="اعتماد سابق + إعادة اعتماد"
      />
      <SmallStat
        tone="rose"
        icon={<XCircle size={18} />}
        label="يوميات ملغاة"
        value={String(stats.voidedCount)}
        sub="مرئية للتدقيق"
      />
    </div>
  );
}

function AttendanceLogCard({
  userId,
  from,
  to,
}: {
  userId: string;
  from: string;
  to: string;
}) {
  const { data: rows = [], isFetching } = useQuery({
    queryKey: ['attendance-employee-log', userId, from, to],
    queryFn: () =>
      attendanceApi.list({ user_id: userId, from, to, limit: 200 }),
  });
  const list = (rows as AttendanceRecord[]) || [];
  return (
    <SectionCard
      title="سجل الحضور (الشهر الحالي)"
      subtitle={`من ${fmtDate(from)} إلى ${fmtDate(to)} — ${list.length} سجل`}
    >
      {isFetching ? (
        <div className="text-center text-xs text-slate-400 py-6">
          جارٍ التحميل…
        </div>
      ) : list.length === 0 ? (
        <EmptyRow message="لا توجد سجلات حضور في هذا الشهر." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <Th>التاريخ</Th>
                <Th>حضور</Th>
                <Th>انصراف</Th>
                <Th>الساعات</Th>
                <Th>الحالة</Th>
                <Th>ملاحظة</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <Td className="font-mono tabular-nums">{fmtDate(r.work_date)}</Td>
                  <Td className="font-mono tabular-nums">{fmtTime(r.clock_in)}</Td>
                  <Td className="font-mono tabular-nums">{fmtTime(r.clock_out)}</Td>
                  <Td className="font-mono tabular-nums">
                    {r.duration_min != null ? fmtMin(r.duration_min) : '—'}
                  </Td>
                  <Td>
                    {r.clock_out ? (
                      <Chip tone="green">منصرف</Chip>
                    ) : r.clock_in ? (
                      <Chip tone="blue">حاضر</Chip>
                    ) : (
                      <Chip tone="slate">—</Chip>
                    )}
                  </Td>
                  <Td className="text-[11px] text-slate-500 max-w-[260px] truncate">
                    {r.note || '—'}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

function DailyWageCard({
  userId,
  from,
  to,
  dailyAmount,
  canManage,
  onEdit,
}: {
  userId: string;
  from: string;
  to: string;
  dailyAmount: number;
  canManage: boolean;
  onEdit: (row: PayableDayRow) => void;
}) {
  const qc = useQueryClient();
  const { data: rows = [], isFetching } = useQuery({
    queryKey: ['payable-days', userId, from, to],
    queryFn: () => attendanceApi.payableDays({ user_id: userId, from, to }),
  });
  const list = (rows as PayableDayRow[]) || [];

  // Build status per-row: معتمدة / ملغاة / معدلة. PR-T3 will extend
  // with مصروفة جزئيًا / بالكامل once the unified ledger is available.
  const livePerDate = useMemo(() => {
    const m = new Map<string, PayableDayRow>();
    for (const r of list) if (!r.is_void) m.set(r.work_date, r);
    return m;
  }, [list]);

  const voidMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      attendanceApi.adminVoidAccrual(id, { reason }),
    onSuccess: () => {
      toast.success('تم إلغاء الاعتماد. القيد ظاهر في السجل بحالة "ملغاة".');
      invalidate(qc);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل إلغاء الاعتماد'),
  });

  return (
    <SectionCard
      title="يوميات الموظف (الشهر الحالي)"
      subtitle="اعتماد أو تعديل الاعتماد لا يحرّك أي نقد. الصرف النقدي من زر منفصل."
    >
      {isFetching ? (
        <div className="text-center text-xs text-slate-400 py-6">
          جارٍ التحميل…
        </div>
      ) : list.length === 0 ? (
        <EmptyRow message="لا توجد يوميات معتمدة في هذا الشهر بعد." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50">
              <tr>
                <Th>التاريخ</Th>
                <Th>الساعات</Th>
                <Th>اليومية الأساسية</Th>
                <Th>المبلغ المحسوب</Th>
                <Th>المبلغ المعتمد</Th>
                <Th>نوع الاعتماد</Th>
                <Th>الحالة</Th>
                <Th>رقم القيد</Th>
                <Th>إجراءات</Th>
              </tr>
            </thead>
            <tbody>
              {list.map((r) => {
                const isLive = !r.is_void;
                const isEdited = r.is_void && livePerDate.has(r.work_date);
                return (
                  <tr
                    key={r.id}
                    className={`border-t border-slate-100 ${
                      r.is_void ? 'opacity-60 bg-slate-50/60' : ''
                    }`}
                  >
                    <Td className="font-mono tabular-nums">{fmtDate(r.work_date)}</Td>
                    <Td className="font-mono tabular-nums">
                      {r.worked_minutes != null ? fmtMin(r.worked_minutes) : '—'}
                    </Td>
                    <Td className="font-mono tabular-nums text-slate-600">
                      {EGP(r.daily_wage_snapshot)}
                    </Td>
                    <Td className="font-mono tabular-nums text-slate-600">
                      {r.calculated_amount != null ? EGP(r.calculated_amount) : '—'}
                    </Td>
                    <Td className="font-mono tabular-nums font-bold">
                      <span className={r.is_void ? 'line-through' : ''}>
                        {EGP(r.amount_accrued)}
                      </span>
                    </Td>
                    <Td>
                      <OverrideTypeChip type={r.override_type} />
                    </Td>
                    <Td>
                      {isLive ? (
                        <Chip tone="green">معتمدة</Chip>
                      ) : isEdited ? (
                        <Chip tone="amber" title="اعتماد سابق أُلغي ثم أُعيد اعتماده">
                          معدلة
                        </Chip>
                      ) : (
                        <Chip tone="rose" title={r.void_reason || ''}>
                          ملغاة
                        </Chip>
                      )}
                    </Td>
                    <Td className="font-mono text-[11px] text-slate-500">
                      {r.entry_no || '—'}
                    </Td>
                    <Td>
                      <div className="flex items-center gap-1">
                        {canManage && isLive && (
                          <>
                            <button
                              type="button"
                              onClick={() => onEdit(r)}
                              className="p-1.5 rounded hover:bg-slate-100 text-indigo-600"
                              title="تعديل الاعتماد (يُلغى الحالي ويُعاد اعتماده ذرّيًا)"
                            >
                              <Edit3 size={14} />
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                const reason = window.prompt(
                                  'سبب إلغاء الاعتماد (مطلوب):',
                                );
                                if (!reason || !reason.trim()) return;
                                voidMut.mutate({
                                  id: r.id,
                                  reason: reason.trim(),
                                });
                              }}
                              className="p-1.5 rounded hover:bg-rose-50 text-rose-600"
                              title="إلغاء الاعتماد — يبقى ظاهرًا في السجل بحالة ملغاة"
                            >
                              <XCircle size={14} />
                            </button>
                          </>
                        )}
                      </div>
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </SectionCard>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Wage approval modal — focused dialog (replaces the inline form)
 * ───────────────────────────────────────────────────────────────── */

export function WageApprovalModal({
  userId,
  fullName,
  dailyAmount,
  existing,
  onClose,
}: {
  userId: string;
  fullName: string;
  dailyAmount: number;
  /** When set, this is an EDIT — the backend's atomic void+repost
   *  (PR-25) will replace the existing accrual. The modal pre-fills
   *  from the existing row and shows a clear "تعديل" tone. */
  existing?: PayableDayRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isEdit = !!existing;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });

  const [workDate, setWorkDate] = useState<string>(existing?.work_date || today);
  const [overrideType, setOverrideType] = useState<
    'full_day' | 'calculated' | 'custom_amount'
  >(existing?.override_type ?? 'full_day');
  const [customAmount, setCustomAmount] = useState<string>(
    existing?.override_type === 'custom_amount'
      ? String(existing?.amount_accrued ?? '')
      : '',
  );
  const [approvalReason, setApprovalReason] = useState<string>(
    existing?.approval_reason || '',
  );
  const [reason, setReason] = useState<string>(
    isEdit ? `تعديل اعتماد سابق (${existing?.entry_no || '?'})` : '',
  );

  const calculated = Number(existing?.calculated_amount ?? dailyAmount);
  const previewAmount =
    overrideType === 'custom_amount'
      ? Number(customAmount || 0)
      : overrideType === 'calculated'
        ? calculated
        : dailyAmount;

  const customRequiresReason =
    overrideType === 'custom_amount' &&
    Math.abs(Number(customAmount || 0) - calculated) > 0.005;

  const mut = useMutation({
    mutationFn: () =>
      attendanceApi.adminApproveWageOverride({
        user_id: userId,
        work_date: workDate,
        override_type: overrideType,
        approved_amount:
          overrideType === 'custom_amount' ? Number(customAmount) : undefined,
        approval_reason:
          overrideType === 'custom_amount'
            ? approvalReason.trim() || undefined
            : undefined,
        reason: reason.trim(),
      }),
    onSuccess: () => {
      toast.success(
        isEdit
          ? 'تم تعديل الاعتماد ذرّيًا — القيد القديم ملغى، والجديد منشور (DR 521 / CR 213).'
          : 'تم اعتماد اليومية — DR 521 / CR 213 فقط، بدون أي حركة خزنة.',
      );
      invalidate(qc);
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل اعتماد اليومية'),
  });

  const canSubmit =
    !!workDate &&
    !!reason.trim() &&
    dailyAmount > 0 &&
    !(overrideType === 'custom_amount' && (!customAmount || Number(customAmount) <= 0)) &&
    !(customRequiresReason && !approvalReason.trim());

  return (
    <ModalShell
      title={isEdit ? 'تعديل اعتماد يومية' : 'اعتماد يومية'}
      subtitle={`${fullName} · يومية ${EGP(dailyAmount)}`}
      onClose={onClose}
    >
      {/* Strong visual reminder that approval is NOT payout. */}
      <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 flex items-start gap-2 text-sm text-violet-900">
        <ShieldCheck size={16} className="shrink-0 mt-0.5" />
        <div className="leading-relaxed">
          <div className="font-bold">هذا الإجراء يثبت مستحقًا للموظف فقط.</div>
          <div className="text-violet-900/80">
            لا يتم صرف أي نقد. لا يؤثر على الخزنة أو الوردية. الصرف يتم لاحقًا من زر
            <span className="font-bold"> صرف يومية / مستحقات </span>
            بشكل منفصل.
          </div>
        </div>
      </div>

      {isEdit && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 flex items-start gap-2 text-sm text-amber-900">
          <AlertTriangle size={16} className="shrink-0 mt-0.5" />
          <div className="leading-relaxed">
            <div className="font-bold">تعديل اعتماد قائم</div>
            <div className="text-amber-900/80">
              سيتم إلغاء الاعتماد الحالي ({existing?.entry_no || '?'} —{' '}
              {EGP(existing?.amount_accrued)}) وإعادة الاعتماد بالقيمة الجديدة في
              نفس المعاملة (تم تأمين الذرّية في PR #125). تعديل الاعتماد لا يعني
              صرف نقدي.
            </div>
          </div>
        </div>
      )}

      {/* Accounting preview */}
      <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
        <div className="text-xs font-bold text-slate-600 mb-2">
          القيد المحاسبي للاعتماد
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg bg-white border border-slate-200 p-3">
            <div className="text-[10px] font-bold text-emerald-700">DR 521</div>
            <div className="text-slate-600 text-xs mt-0.5">رواتب وأجور</div>
            <div className="font-mono tabular-nums font-black mt-1">
              {EGP(previewAmount)}
            </div>
          </div>
          <div className="rounded-lg bg-white border border-slate-200 p-3">
            <div className="text-[10px] font-bold text-blue-700">CR 213</div>
            <div className="text-slate-600 text-xs mt-0.5">مستحقات الموظفين</div>
            <div className="font-mono tabular-nums font-black mt-1">
              {EGP(previewAmount)}
            </div>
          </div>
        </div>
        <div className="text-[10px] text-slate-500 mt-2">
          لا cashbox · لا shift · يضيف مستحقًا للموظف فقط.
        </div>
      </div>

      {/* Form fields */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="التاريخ">
          <input
            type="date"
            value={workDate}
            onChange={(e) => setWorkDate(e.target.value)}
            className="input w-full"
            disabled={mut.isPending || isEdit}
          />
        </Field>
        <Field label="اليومية الأساسية">
          <input
            type="text"
            value={EGP(dailyAmount)}
            disabled
            className="input w-full bg-slate-50 text-slate-500"
          />
        </Field>
      </div>

      {/* Override type */}
      <fieldset className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
        <legend className="text-[11px] text-slate-500 px-1 font-bold">
          نوع الاعتماد
        </legend>
        <ModeRadio
          checked={overrideType === 'full_day'}
          onChange={() => setOverrideType('full_day')}
          title="يومية كاملة"
          subtitle={`المبلغ المعتمد = ${EGP(dailyAmount)}`}
          disabled={mut.isPending}
        />
        <ModeRadio
          checked={overrideType === 'calculated'}
          onChange={() => setOverrideType('calculated')}
          title="المبلغ المحسوب"
          subtitle={`= يومية × (ساعات فعلية / مستهدفة) = ${EGP(calculated)}`}
          disabled={mut.isPending}
        />
        <ModeRadio
          checked={overrideType === 'custom_amount'}
          onChange={() => setOverrideType('custom_amount')}
          title="مبلغ مخصص"
          subtitle="يدوي. يلزم سبب الاعتماد إذا اختلف عن المحسوب."
          disabled={mut.isPending}
        >
          {overrideType === 'custom_amount' && (
            <div className="mt-2 grid grid-cols-1 sm:grid-cols-2 gap-2">
              <input
                type="number"
                step="0.01"
                min="0"
                placeholder="المبلغ المعتمد"
                value={customAmount}
                onChange={(e) => setCustomAmount(e.target.value)}
                className="input"
                disabled={mut.isPending}
              />
              <input
                type="text"
                placeholder={
                  customRequiresReason
                    ? 'سبب الاعتماد (مطلوب)'
                    : 'سبب الاعتماد (اختياري)'
                }
                value={approvalReason}
                onChange={(e) => setApprovalReason(e.target.value)}
                className={`input ${
                  customRequiresReason && !approvalReason.trim()
                    ? 'border-rose-300 bg-rose-50/40'
                    : ''
                }`}
                disabled={mut.isPending}
              />
            </div>
          )}
        </ModeRadio>
      </fieldset>

      <Field label={isEdit ? 'سبب التعديل (يُسجَّل في الـ JE)' : 'سبب الاعتماد / الملاحظة'}>
        <input
          type="text"
          placeholder={isEdit ? 'مثلاً: تصحيح ساعات' : 'مثلاً: يوم عمل بدون بصمة'}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="input w-full"
          disabled={mut.isPending}
        />
      </Field>

      <div className="flex items-center justify-between gap-2 pt-2">
        <button
          type="button"
          onClick={onClose}
          className="px-4 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50"
          disabled={mut.isPending}
        >
          إلغاء
        </button>
        <button
          type="button"
          onClick={() => mut.mutate()}
          disabled={!canSubmit || mut.isPending}
          className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Receipt size={15} />
          {mut.isPending
            ? isEdit
              ? 'جارٍ التعديل…'
              : 'جارٍ الاعتماد…'
            : isEdit
              ? 'حفظ التعديل'
              : 'اعتماد اليومية'}
        </button>
      </div>
    </ModalShell>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Small UI helpers (kept local to this file)
 * ───────────────────────────────────────────────────────────────── */

function ModalShell({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto" onClick={onClose}>
      <div
        className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl my-6"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-black text-slate-800">{title}</h3>
            {subtitle && (
              <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
            title="إغلاق"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
      </div>
    </div>
  );
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <h4 className="text-sm font-black text-slate-800">{title}</h4>
        {subtitle && (
          <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>
        )}
      </div>
      <div>{children}</div>
    </div>
  );
}

function SmallStat({
  tone,
  icon,
  label,
  value,
  sub,
}: {
  tone: 'green' | 'orange' | 'red' | 'amber' | 'rose' | 'slate';
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  const map: Record<string, { fg: string; tile: string }> = {
    green:  { fg: 'text-emerald-700', tile: 'bg-emerald-100' },
    orange: { fg: 'text-amber-700',   tile: 'bg-amber-100' },
    red:    { fg: 'text-rose-700',    tile: 'bg-rose-100' },
    amber:  { fg: 'text-amber-700',   tile: 'bg-amber-100' },
    rose:   { fg: 'text-rose-700',    tile: 'bg-rose-100' },
    slate:  { fg: 'text-slate-600',   tile: 'bg-slate-100' },
  };
  const t = map[tone];
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 flex items-center justify-between gap-3 shadow-sm">
      <div className="min-w-0">
        <div className="text-[11px] font-bold text-slate-500">{label}</div>
        <div className={`text-lg font-black mt-1 ${t.fg} truncate`}>{value}</div>
        {sub && <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>}
      </div>
      <div className={`shrink-0 w-10 h-10 rounded-xl ${t.tile} ${t.fg} flex items-center justify-center`}>
        {icon}
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-right px-3 py-2.5 text-[11px] font-bold text-slate-500 bg-slate-50">
      {children}
    </th>
  );
}

function Td({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`px-3 py-2.5 text-xs text-slate-700 ${className}`}>{children}</td>;
}

function Chip({
  tone,
  children,
  title,
}: {
  tone: 'green' | 'amber' | 'rose' | 'blue' | 'slate';
  children: React.ReactNode;
  title?: string;
}) {
  const map: Record<string, string> = {
    green:  'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber:  'bg-amber-50   text-amber-800   border-amber-200',
    rose:   'bg-rose-50    text-rose-700    border-rose-200',
    blue:   'bg-blue-50    text-blue-700    border-blue-200',
    slate:  'bg-slate-50   text-slate-600   border-slate-200',
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold border ${map[tone]}`}
    >
      {children}
    </span>
  );
}

function OverrideTypeChip({ type }: { type?: string | null }) {
  const label =
    type === 'full_day'
      ? 'يومية كاملة'
      : type === 'calculated'
        ? 'محسوب'
        : type === 'custom_amount'
          ? 'مخصص'
          : '—';
  const tone =
    type === 'custom_amount'
      ? 'amber'
      : type === 'calculated'
        ? 'blue'
        : type === 'full_day'
          ? 'green'
          : 'slate';
  return <Chip tone={tone as any}>{label}</Chip>;
}

function EmptyRow({ message }: { message: string }) {
  return (
    <div className="text-center text-xs text-slate-400 py-8">{message}</div>
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
      <div className="text-[11px] font-bold text-slate-600 mb-1">{label}</div>
      {children}
    </label>
  );
}

function ModeRadio({
  checked,
  onChange,
  title,
  subtitle,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: () => void;
  title: string;
  subtitle: string;
  disabled?: boolean;
  children?: React.ReactNode;
}) {
  return (
    <label
      className={`flex items-start gap-2 rounded-lg p-2 cursor-pointer ${
        checked ? 'bg-violet-50 border border-violet-200' : 'hover:bg-slate-50'
      } ${disabled ? 'opacity-60' : ''}`}
    >
      <input
        type="radio"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="mt-1"
      />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-bold text-slate-800">{title}</div>
        <div className="text-[11px] text-slate-500">{subtitle}</div>
        {children}
      </div>
    </label>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Helpers
 * ───────────────────────────────────────────────────────────────── */

function monthBounds(): { from: string; to: string } {
  // Cairo-anchored YYYY-MM-DD bounds for the current month.
  const today = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(today);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${d}` };
}

function invalidate(qc: ReturnType<typeof useQueryClient>) {
  qc.invalidateQueries({ queryKey: ['payable-days'] });
  qc.invalidateQueries({ queryKey: ['attendance-employee-log'] });
  qc.invalidateQueries({ queryKey: ['attendance-employee-today'] });
  qc.invalidateQueries({ queryKey: ['employee-user-dashboard'] });
  qc.invalidateQueries({ queryKey: ['employees-team'] });
  qc.invalidateQueries({ queryKey: ['attendance-summary-today'] });
}
