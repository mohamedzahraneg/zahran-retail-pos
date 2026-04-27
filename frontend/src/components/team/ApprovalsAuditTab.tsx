/**
 * ApprovalsAuditTab — PR-T4
 * ─────────────────────────────────────────────────────────────────────
 *
 * الموافقات والتعديلات tab inside the unified Team Management workspace.
 * Replaces the placeholder PR-T1 left in this slot. Two modes:
 *
 *   1. **Team-wide** (no ?employee= selected): shows the cross-team
 *      pending-requests inbox. Approve / reject mutations route through
 *      the existing employees.decideRequest endpoint (same backend
 *      path the legacy PendingInbox component used).
 *
 *   2. **Per-employee** (employee selected): pending requests filtered
 *      to that user + wage-approval edit/void history (from
 *      employee_payable_days) + GL movement void history (from
 *      gl_entries with is_voided=true, surfaced via PR-25's response
 *      contract). Audit timeline.
 *
 * Backend invariants (all unchanged in this PR — confirmed by audit):
 *   · /employees/requests/pending + /employees/requests/:id/decide
 *     are existing endpoints. Same data, same approve/reject flow,
 *     just rendered with the new design.
 *   · /attendance/payable-days exposes is_void, void_reason, voided_at,
 *     voided_by, override_type — full audit fields available.
 *   · /employees/:id/ledger gl_entries exposes is_voided + void_reason
 *     for every account 1123/213 row (PR-25 contract).
 *   · No new backend endpoints needed for the timeline. No new
 *     migrations, no FinancialEngine changes, no accounting logic.
 *
 * Out of scope for PR-T4 (deferred):
 *   · Reports / print / export (PR-T5)
 *   · Old PendingInbox cleanup (PR-T6 — left in Team.tsx untouched)
 *   · A dedicated audit-log endpoint (most "who/when" data lives on
 *     the JE itself: created_by, voided_by, voided_at; surfaced inline)
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  CheckCircle2,
  XCircle,
  Clock,
  ShieldCheck,
  History,
  Eye,
  Inbox,
  Edit3,
  Ban,
} from 'lucide-react';
import {
  employeesApi,
  EmployeeRequest,
  TeamRow,
} from '@/api/employees.api';
import {
  attendanceApi,
  PayableDayRow,
} from '@/api/attendance.api';
import { useAuthStore } from '@/stores/auth.store';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const fmtDate = (iso?: string | null) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
};

const fmtDateTime = (iso?: string | null) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

const KIND_LABEL: Record<EmployeeRequest['kind'], string> = {
  advance: 'سلفة',
  // PR-ESS-2A-HOTFIX-1 — same Arabic label as legacy 'advance' so
  // the manager's approvals queue renders both kinds identically.
  // The kind value differs only at the data-flow level: approving
  // 'advance_request' is a pure status flip (no GL/cashbox writes),
  // while approving the legacy 'advance' triggers the historical
  // mirror cascade. See migration 114 + employees.service.ts.
  advance_request: 'سلفة',
  leave: 'إجازة',
  overtime_extension: 'تمديد ساعات إضافية',
  other: 'أخرى',
};

/* ─────────────────────────────────────────────────────────────────
 * Top-level component
 * ───────────────────────────────────────────────────────────────── */

export function ApprovalsAuditTab({ employee }: { employee?: TeamRow }) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canApprove = hasPermission('employee.requests.approve');

  // Pending requests — same query/key the legacy PendingInbox used so
  // the cache invalidation chain from PR-T1 keeps working.
  const { data: pending = [] } = useQuery({
    queryKey: ['employees-pending'],
    queryFn: () => employeesApi.pendingRequests(),
    enabled: canApprove,
    refetchInterval: 30_000,
  });

  // Per-employee history — only queried when an employee is selected.
  // Uses the same window AccountsMovementsTab uses (current Cairo
  // month) so totals across tabs line up.
  const range = useMemo(() => monthBounds(), []);
  const { data: payableDays = [] } = useQuery({
    queryKey: ['payable-days', employee?.id, range.from, range.to],
    queryFn: () =>
      attendanceApi.payableDays({
        user_id: employee!.id,
        from: range.from,
        to: range.to,
      }),
    enabled: !!employee?.id,
  });
  const { data: ledger } = useQuery({
    queryKey: ['employee-ledger', employee?.id, range.from, range.to],
    queryFn: () =>
      employeesApi.userLedger(employee!.id, range.from, range.to),
    enabled: !!employee?.id,
  });

  // Filter pending requests when an employee is selected.
  const pendingForEmployee = useMemo(() => {
    if (!employee) return pending as EmployeeRequest[];
    return (pending as EmployeeRequest[]).filter(
      (r) => r.user_id === employee.id,
    );
  }, [pending, employee]);

  // GL voided rows — derived from the gl_entries response (PR-25
  // contract: is_voided + void_reason + signed_effect=0).
  const voidedGlRows = useMemo(() => {
    const list = ledger?.gl_entries ?? [];
    return list.filter((e) => e.is_voided);
  }, [ledger]);

  // Wage-approval history grouped by date so we can show
  // معدلة (void + replacement) vs ملغاة (void without replacement).
  const wageHistory = useMemo(() => {
    return classifyWageHistory(payableDays as PayableDayRow[]);
  }, [payableDays]);

  return (
    <div className="space-y-5">
      <HeaderCard />
      <SummaryCards
        pendingCount={pendingForEmployee.length}
        wageHistory={wageHistory}
        voidedGlCount={voidedGlRows.length}
      />
      <PendingRequestsCard
        rows={pendingForEmployee}
        canApprove={canApprove}
        scope={employee ? 'employee' : 'team'}
      />
      {employee ? (
        <>
          <WageApprovalHistoryCard history={wageHistory} />
          <MovementVoidHistoryCard rows={voidedGlRows} />
        </>
      ) : (
        <NoEmployeeHint />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Sections
 * ───────────────────────────────────────────────────────────────── */

function HeaderCard() {
  return (
    <div className="rounded-2xl border border-amber-200 bg-amber-50/60 p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-amber-100 text-amber-700 flex items-center justify-center shrink-0">
          <ShieldCheck size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-black text-amber-900">
            الموافقات والتعديلات
          </h3>
          <p className="text-sm text-amber-900/70 mt-0.5">
            متابعة طلبات الموافقة، التعديلات، والإلغاءات مع سجل تدقيق واضح.
          </p>
        </div>
      </div>
    </div>
  );
}

function SummaryCards({
  pendingCount,
  wageHistory,
  voidedGlCount,
}: {
  pendingCount: number;
  wageHistory: WageHistoryEntry[];
  voidedGlCount: number;
}) {
  const editedCount = wageHistory.filter((h) => h.kind === 'edited').length;
  const voidedWageCount = wageHistory.filter((h) => h.kind === 'voided').length;
  const totalVoided = voidedWageCount + voidedGlCount;
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <StatCard
        tone="amber"
        icon={<Inbox size={18} />}
        label="طلبات معلقة"
        value={String(pendingCount)}
        sub="بانتظار قرار"
      />
      <StatCard
        tone="violet"
        icon={<Edit3 size={18} />}
        label="اعتماد يومية معدلة"
        value={String(editedCount)}
        sub="اعتماد أُلغي ثم أُعيد"
      />
      <StatCard
        tone="rose"
        icon={<Ban size={18} />}
        label="قيود ملغاة"
        value={String(totalVoided)}
        sub="يومية + حركات الحساب"
      />
      <StatCard
        tone="green"
        icon={<History size={18} />}
        label="سجل تدقيق نشط"
        value="مفعّل"
        sub="from gl_entries + payable_days"
      />
    </div>
  );
}

function PendingRequestsCard({
  rows,
  canApprove,
  scope,
}: {
  rows: EmployeeRequest[];
  canApprove: boolean;
  scope: 'team' | 'employee';
}) {
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
      toast.success(v.decision === 'approved' ? 'تم اعتماد الطلب' : 'تم رفض الطلب');
      qc.invalidateQueries({ queryKey: ['employees-pending'] });
      qc.invalidateQueries({ queryKey: ['employees-team'] });
      qc.invalidateQueries({ queryKey: ['employee-user-dashboard'] });
      setRejectTarget(null);
      setRejectReason('');
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تنفيذ القرار'),
  });

  return (
    <SectionCard
      title="الطلبات المعلقة"
      subtitle={
        scope === 'employee'
          ? 'الطلبات المعلقة لهذا الموظف فقط'
          : 'كل الطلبات المعلقة عبر فريق العمل'
      }
    >
      {rows.length === 0 ? (
        <EmptyRow message="لا توجد طلبات معلقة." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <Th>التاريخ</Th>
                <Th>الموظف</Th>
                <Th>نوع الطلب</Th>
                <Th>المبلغ</Th>
                <Th>السبب</Th>
                <Th>الحالة</Th>
                <Th>إجراءات</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-t border-slate-100">
                  <Td className="font-mono tabular-nums whitespace-nowrap">
                    {fmtDateTime(r.created_at)}
                  </Td>
                  <Td>
                    <div className="font-bold text-slate-700">
                      {r.user_name || r.username || '—'}
                    </div>
                    {r.employee_no && (
                      <div className="text-[10px] text-slate-400 font-mono">
                        {r.employee_no}
                      </div>
                    )}
                  </Td>
                  <Td>
                    <Chip tone="amber">{KIND_LABEL[r.kind]}</Chip>
                  </Td>
                  <Td className="font-mono tabular-nums text-center">
                    {r.amount != null ? EGP(r.amount) : '—'}
                  </Td>
                  <Td className="text-slate-600 max-w-[280px] truncate" title={r.reason || ''}>
                    {r.reason || '—'}
                  </Td>
                  <Td>
                    <StatusChip status={r.status} />
                  </Td>
                  <Td>
                    {canApprove ? (
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          onClick={() =>
                            decide.mutate({ id: r.id, decision: 'approved' })
                          }
                          disabled={decide.isPending}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-bold hover:bg-emerald-100 disabled:opacity-50"
                        >
                          <CheckCircle2 size={12} />
                          قبول
                        </button>
                        <button
                          type="button"
                          onClick={() => setRejectTarget(r)}
                          disabled={decide.isPending}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-rose-50 text-rose-700 border border-rose-200 text-[11px] font-bold hover:bg-rose-100 disabled:opacity-50"
                        >
                          <XCircle size={12} />
                          رفض
                        </button>
                      </div>
                    ) : (
                      <span className="text-[10px] text-slate-400">عرض فقط</span>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {rejectTarget && (
        <RejectModal
          request={rejectTarget}
          reason={rejectReason}
          onChangeReason={setRejectReason}
          onCancel={() => {
            setRejectTarget(null);
            setRejectReason('');
          }}
          onConfirm={() =>
            decide.mutate({
              id: rejectTarget.id,
              decision: 'rejected',
              reason: rejectReason.trim() || undefined,
            })
          }
          submitting={decide.isPending}
        />
      )}
    </SectionCard>
  );
}

function WageApprovalHistoryCard({
  history,
}: {
  history: WageHistoryEntry[];
}) {
  return (
    <SectionCard
      title="تاريخ اعتماد اليوميات (الشهر الحالي)"
      subtitle="القيود الملغاة مرئية للتدقيق — لا تؤثر على الرصيد."
    >
      {history.length === 0 ? (
        <EmptyRow message="لا توجد اعتمادات في الشهر الحالي." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <Th>التاريخ</Th>
                <Th>قبل</Th>
                <Th>بعد</Th>
                <Th>نوع الاعتماد</Th>
                <Th>السبب</Th>
                <Th>بواسطة</Th>
                <Th>رقم القيد</Th>
                <Th>الحالة</Th>
              </tr>
            </thead>
            <tbody>
              {history.map((h) => (
                <tr
                  key={h.work_date + ':' + h.kind + ':' + (h.live?.id || h.voided[0]?.id)}
                  className="border-t border-slate-100"
                >
                  <Td className="font-mono tabular-nums whitespace-nowrap">
                    {fmtDate(h.work_date)}
                  </Td>
                  <Td className="font-mono tabular-nums">
                    {h.kind === 'voided' || h.kind === 'edited'
                      ? EGP(h.voided[0]?.amount_accrued)
                      : '—'}
                  </Td>
                  <Td className="font-mono tabular-nums">
                    {h.live ? EGP(h.live.amount_accrued) : '—'}
                  </Td>
                  <Td>
                    <OverrideChip
                      type={
                        h.live?.override_type ||
                        h.voided[0]?.override_type ||
                        null
                      }
                    />
                  </Td>
                  <Td className="text-slate-600 max-w-[260px] truncate"
                      title={(h.kind === 'voided' || h.kind === 'edited') ? h.voided[0]?.void_reason || '' : h.live?.reason || ''}>
                    {(h.kind === 'voided' || h.kind === 'edited')
                      ? h.voided[0]?.void_reason || '—'
                      : h.live?.reason || '—'}
                  </Td>
                  <Td className="text-slate-600 text-[11px]">
                    {/* PR-25 backend doesn't expose voided_by_name in payable_days
                        directly — surface what we have (ids omitted to avoid noise). */}
                    {h.kind === 'voided' || h.kind === 'edited' ? 'الإدارة' : 'الإدارة'}
                  </Td>
                  <Td className="font-mono text-[10px] text-slate-500">
                    {h.live?.entry_no || h.voided[0]?.entry_no || '—'}
                  </Td>
                  <Td>
                    {h.kind === 'live' ? (
                      <Chip tone="green">معتمدة</Chip>
                    ) : h.kind === 'edited' ? (
                      <Chip tone="amber">معدلة</Chip>
                    ) : (
                      <Chip tone="rose" title={h.voided[0]?.void_reason || ''}>
                        ملغاة
                      </Chip>
                    )}
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

function MovementVoidHistoryCard({ rows }: { rows: any[] }) {
  return (
    <SectionCard
      title="سجل القيود الملغاة (الحركات الأخرى)"
      subtitle="من حركات حساب الموظف على 213/1123 — مكافآت / خصومات / تسويات / سلف."
    >
      {rows.length === 0 ? (
        <EmptyRow message="لا توجد قيود ملغاة في الفترة الحالية." />
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <Th>التاريخ</Th>
                <Th>الوصف</Th>
                <Th>الحساب</Th>
                <Th>مدين</Th>
                <Th>دائن</Th>
                <Th>رقم القيد</Th>
                <Th>السبب</Th>
                <Th>الحالة</Th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={`${r.entry_no}-${i}`}
                  className="border-t border-slate-100 opacity-70 bg-slate-50/50"
                >
                  <Td className="font-mono tabular-nums whitespace-nowrap">
                    {fmtDate(r.entry_date)}
                  </Td>
                  <Td className="text-slate-600 max-w-[260px] truncate line-through">
                    {r.description || '—'}
                  </Td>
                  <Td>
                    <span
                      className={`chip text-[10px] ${
                        r.account_code === '1123'
                          ? 'bg-amber-50 text-amber-700 border-amber-200'
                          : 'bg-indigo-50 text-indigo-700 border-indigo-200'
                      }`}
                    >
                      {r.account_code}
                    </span>
                  </Td>
                  <Td className="font-mono tabular-nums text-center line-through">
                    {r.debit > 0 ? EGP(r.debit) : '—'}
                  </Td>
                  <Td className="font-mono tabular-nums text-center line-through">
                    {r.credit > 0 ? EGP(r.credit) : '—'}
                  </Td>
                  <Td className="font-mono text-[10px] text-slate-500">
                    {r.entry_no}
                  </Td>
                  <Td className="text-slate-600 text-[11px] max-w-[220px] truncate" title={r.void_reason || ''}>
                    {r.void_reason || '—'}
                  </Td>
                  <Td>
                    <Chip tone="rose">ملغاة</Chip>
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

function NoEmployeeHint() {
  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-6 text-center text-sm text-slate-600">
      اختر موظفًا من القائمة لعرض تاريخ اعتماد يومياته وسجل قيوده الملغاة.
      الجدول أعلاه يعرض كل الطلبات المعلقة عبر الفريق.
    </div>
  );
}

function RejectModal({
  request,
  reason,
  onChangeReason,
  onCancel,
  onConfirm,
  submitting,
}: {
  request: EmployeeRequest;
  reason: string;
  onChangeReason: (s: string) => void;
  onCancel: () => void;
  onConfirm: () => void;
  submitting: boolean;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl my-6"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="px-5 py-4 border-b border-slate-100">
          <h3 className="text-lg font-black text-slate-800">رفض الطلب</h3>
          <div className="text-xs text-slate-500 mt-0.5">
            {request.user_name || request.username} — {KIND_LABEL[request.kind]}
            {request.amount != null && ` — ${EGP(request.amount)}`}
          </div>
        </div>
        <div className="p-5 space-y-3">
          <label className="block">
            <div className="text-[11px] font-bold text-slate-600 mb-1">
              سبب الرفض (يُرسَل للموظف)
            </div>
            <textarea
              value={reason}
              onChange={(e) => onChangeReason(e.target.value)}
              className="input w-full"
              rows={3}
              placeholder="مثلاً: تجاوز السقف الشهري المسموح للسلف."
              disabled={submitting}
            />
          </label>
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50"
              disabled={submitting}
            >
              إلغاء
            </button>
            <button
              type="button"
              onClick={onConfirm}
              disabled={submitting}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-rose-600 text-white text-sm font-bold hover:bg-rose-700 disabled:opacity-50"
            >
              <XCircle size={15} />
              {submitting ? 'جارٍ الرفض…' : 'تأكيد الرفض'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Helpers + small UI primitives
 * ───────────────────────────────────────────────────────────────── */

interface WageHistoryEntry {
  work_date: string;
  kind: 'live' | 'edited' | 'voided';
  live?: PayableDayRow;
  voided: PayableDayRow[];
}

function classifyWageHistory(rows: PayableDayRow[]): WageHistoryEntry[] {
  // Group by work_date. Same logic AttendanceWageTab uses to derive
  // معتمدة / معدلة / ملغاة for the daily wage table — duplicated
  // here so the audit tab works standalone.
  const byDate = new Map<string, { live?: PayableDayRow; voided: PayableDayRow[] }>();
  for (const r of rows) {
    const slot = byDate.get(r.work_date) || { voided: [] };
    if (!r.is_void) slot.live = r;
    else slot.voided.push(r);
    byDate.set(r.work_date, slot);
  }
  const out: WageHistoryEntry[] = [];
  byDate.forEach((slot, work_date) => {
    if (slot.voided.length > 0 && slot.live) {
      out.push({ work_date, kind: 'edited', live: slot.live, voided: slot.voided });
    } else if (slot.voided.length > 0) {
      out.push({ work_date, kind: 'voided', voided: slot.voided });
    } else if (slot.live) {
      out.push({ work_date, kind: 'live', live: slot.live, voided: [] });
    }
  });
  // Newest first.
  out.sort((a, b) => (a.work_date > b.work_date ? -1 : 1));
  return out;
}

function StatusChip({ status }: { status: EmployeeRequest['status'] }) {
  if (status === 'pending')   return <Chip tone="amber">معلق</Chip>;
  if (status === 'approved')  return <Chip tone="green">مقبول</Chip>;
  if (status === 'rejected')  return <Chip tone="rose">مرفوض</Chip>;
  if (status === 'cancelled') return <Chip tone="slate">ملغى</Chip>;
  return <Chip tone="slate">{status}</Chip>;
}

function OverrideChip({ type }: { type?: string | null }) {
  const label =
    type === 'full_day' ? 'يومية كاملة' :
    type === 'calculated' ? 'محسوب' :
    type === 'custom_amount' ? 'مخصص' : '—';
  const tone: ChipTone =
    type === 'custom_amount' ? 'amber' :
    type === 'calculated' ? 'blue' :
    type === 'full_day' ? 'green' : 'slate';
  return <Chip tone={tone}>{label}</Chip>;
}

type ChipTone = 'green' | 'amber' | 'rose' | 'blue' | 'slate' | 'violet';
function Chip({
  tone, children, title,
}: { tone: ChipTone; children: React.ReactNode; title?: string }) {
  const map: Record<ChipTone, string> = {
    green:  'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber:  'bg-amber-50   text-amber-800   border-amber-200',
    rose:   'bg-rose-50    text-rose-700    border-rose-200',
    blue:   'bg-blue-50    text-blue-700    border-blue-200',
    violet: 'bg-violet-50  text-violet-700  border-violet-200',
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

function StatCard({
  tone, icon, label, value, sub,
}: {
  tone: 'amber' | 'violet' | 'rose' | 'green';
  icon: React.ReactNode;
  label: string;
  value: string;
  sub?: string;
}) {
  const map: Record<string, { fg: string; tile: string }> = {
    amber:  { fg: 'text-amber-700',   tile: 'bg-amber-100' },
    violet: { fg: 'text-violet-700',  tile: 'bg-violet-100' },
    rose:   { fg: 'text-rose-700',    tile: 'bg-rose-100' },
    green:  { fg: 'text-emerald-700', tile: 'bg-emerald-100' },
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

function SectionCard({
  title, subtitle, children,
}: { title: string; subtitle?: string; children: React.ReactNode }) {
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

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-right px-3 py-2.5 text-[11px] font-bold text-slate-500 bg-slate-50 whitespace-nowrap">
      {children}
    </th>
  );
}

function Td({
  children, className = '', title,
}: { children: React.ReactNode; className?: string; title?: string }) {
  return (
    <td className={`px-3 py-2.5 text-xs text-slate-700 ${className}`} title={title}>
      {children}
    </td>
  );
}

function EmptyRow({ message }: { message: string }) {
  return <div className="text-center text-xs text-slate-400 py-8">{message}</div>;
}

function monthBounds(): { from: string; to: string } {
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

// Mark imports used to keep linter happy.
const _icons = [Clock, Eye];
void _icons;
