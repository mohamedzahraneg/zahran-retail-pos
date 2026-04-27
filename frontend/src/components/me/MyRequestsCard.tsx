/**
 * MyRequestsCard — PR-ESS-2A
 * ────────────────────────────────────────────────────────────────────
 *
 * Lists the current user's recent leave + advance requests on /me.
 * Reads from `GET /employees/me/requests` (already exists).
 *
 * Status semantics (PR-ESS-2A):
 *   pending   → "قيد المراجعة"
 *   approved  → "موافق عليه" + amber subtext "بانتظار الصرف من قِبَل
 *               المحاسبة" for advance requests (so the employee
 *               doesn't mistake the approval for a money movement).
 *               Leave requests just show "موافق عليه".
 *   rejected  → "مرفوض" + decision_reason if present
 *   cancelled → "ملغي"
 *
 * The "تم الصرف" badge is intentionally NOT introduced in this PR —
 * disbursement linkage (`expenses.source_employee_request_id`) is
 * deferred to PR-ESS-2B.
 */

import { useQuery } from '@tanstack/react-query';
import {
  CalendarRange,
  Coins,
  Hourglass,
  CheckCircle2,
  XCircle,
  Ban,
  Inbox,
} from 'lucide-react';
import { employeesApi, EmployeeRequest } from '@/api/employees.api';

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

export function MyRequestsCard() {
  const { data: requests = [], isFetching } = useQuery({
    queryKey: ['my-requests'],
    queryFn: () => employeesApi.myRequests(),
  });
  const list = requests as EmployeeRequest[];

  // PR-ESS-2A-HOTFIX-1 — both legacy `'advance'` and the new safe
  // `'advance_request'` render under "طلبات السلف". Only the new
  // value is emitted by the self-service endpoint, but pre-hotfix
  // rows still carry `'advance'` and need to display correctly.
  const advances = list.filter(
    (r) => r.kind === 'advance' || r.kind === 'advance_request',
  );
  const leaves = list.filter((r) => r.kind === 'leave');
  const others = list.filter(
    (r) =>
      r.kind !== 'advance' &&
      r.kind !== 'advance_request' &&
      r.kind !== 'leave',
  );

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Inbox size={16} className="text-slate-600" />
            <h4 className="text-sm font-black text-slate-800">طلباتي</h4>
          </div>
          <div className="text-[11px] text-slate-500">
            {list.length} طلب
          </div>
        </div>
      </div>

      {isFetching && list.length === 0 ? (
        <div className="text-center text-xs text-slate-400 py-8">
          جارٍ التحميل…
        </div>
      ) : list.length === 0 ? (
        <div className="text-center text-xs text-slate-400 py-8 px-4 leading-relaxed">
          لا توجد طلبات بعد. يمكنك تقديم طلب إجازة أو طلب سلفة من الأزرار
          في رأس الصفحة.
        </div>
      ) : (
        <div className="divide-y divide-slate-100">
          <Section title="طلبات السلف" rows={advances} kind="advance" />
          <Section title="طلبات الإجازة" rows={leaves} kind="leave" />
          {others.length > 0 && (
            <Section title="طلبات أخرى" rows={others} kind="other" />
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  title,
  rows,
  kind,
}: {
  title: string;
  rows: EmployeeRequest[];
  kind: 'advance' | 'leave' | 'other';
}) {
  if (rows.length === 0) return null;
  return (
    <div className="px-5 py-3">
      <div className="text-[11px] font-bold text-slate-500 mb-2">{title}</div>
      <ul className="space-y-2">
        {rows.map((r) => (
          <RequestRow key={r.id} request={r} kind={kind} />
        ))}
      </ul>
    </div>
  );
}

function RequestRow({
  request: r,
  kind,
}: {
  request: EmployeeRequest;
  kind: 'advance' | 'leave' | 'other';
}) {
  const Icon =
    kind === 'advance' ? Coins : kind === 'leave' ? CalendarRange : Inbox;

  const status = r.status;
  const StatusIcon =
    status === 'pending'
      ? Hourglass
      : status === 'approved'
        ? CheckCircle2
        : status === 'rejected'
          ? XCircle
          : Ban;

  const statusTone: Record<string, string> = {
    pending: 'bg-amber-50 text-amber-800 border-amber-200',
    approved: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    rejected: 'bg-rose-50 text-rose-800 border-rose-200',
    cancelled: 'bg-slate-100 text-slate-600 border-slate-200',
  };

  const statusLabel: Record<string, string> = {
    pending: 'قيد المراجعة',
    approved: 'موافق عليه',
    rejected: 'مرفوض',
    cancelled: 'ملغي',
  };

  // Headline differs per kind. For advance: "سلفة 250 ج.م".
  // For leave: "إجازة من DD/MM إلى DD/MM".
  const headline =
    kind === 'advance'
      ? `سلفة ${EGP(r.amount)}`
      : kind === 'leave'
        ? `إجازة من ${fmtDate(r.starts_at)} إلى ${fmtDate(r.ends_at)}`
        : (r.reason ?? 'طلب');

  // PR-ESS-2A — approved advance request must clearly say "بانتظار
  // الصرف" so neither operators nor employees mistake it for a money
  // movement. Disbursement linkage ships in PR-ESS-2B.
  const approvedAdvanceHint =
    kind === 'advance' && status === 'approved'
      ? 'بانتظار الصرف من قِبَل المحاسبة'
      : null;

  return (
    <li className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="flex items-start gap-3">
        <div className="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center shrink-0">
          <Icon size={14} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between flex-wrap gap-2">
            <div className="text-sm font-bold text-slate-800">{headline}</div>
            <span
              className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold border ${statusTone[status]}`}
            >
              <StatusIcon size={11} />
              {statusLabel[status]}
            </span>
          </div>
          {approvedAdvanceHint && (
            <div className="text-[11px] text-amber-800/90 mt-1">
              {approvedAdvanceHint}
            </div>
          )}
          {r.reason && (
            <div className="text-[11px] text-slate-500 mt-1 leading-relaxed line-clamp-3">
              {r.reason}
            </div>
          )}
          {r.decision_reason && status === 'rejected' && (
            <div className="text-[11px] text-rose-700 mt-1 leading-relaxed">
              سبب الرفض: {r.decision_reason}
            </div>
          )}
          <div className="text-[10px] text-slate-400 mt-1 tabular-nums">
            تاريخ الطلب: {fmtDate(r.created_at)}
            {r.decided_at ? ` · تم البتّ: ${fmtDate(r.decided_at)}` : null}
          </div>
        </div>
      </div>
    </li>
  );
}
