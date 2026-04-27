/**
 * MyRequestsCard — PR-ESS-2C-2 (extends PR-ESS-2A / PR-ESS-2B)
 * ────────────────────────────────────────────────────────────────────
 *
 * Lists the current user's full request history on /me.
 *
 * PR-ESS-2C-2 changes:
 *   · Default view is the FULL history (was: recent only).
 *   · Filter strip on top: status tabs, kind dropdown, from/to dates.
 *     All filters round-trip to `GET /employees/me/requests`.
 *   · Each row is now click-to-open — opens a drawer rendering
 *     `<RequestTimeline />` for that request (Submitted →
 *     Approved/Rejected/Cancelled → Awaiting → Disbursed).
 *   · When a request is in the `disbursed` state we surface the linked
 *     `expense_no` inline (e.g. "تم الصرف · مصروف #EXP-2026-…").
 *
 * Status semantics (carried over from PR-ESS-2A / PR-ESS-2B):
 *   pending   → "قيد المراجعة"
 *   approved  → "موافق عليه" + amber "بانتظار الصرف من قِبَل المحاسبة"
 *               for advance requests.
 *   disbursed → "تم الصرف" + linked expense_no when present.
 *   rejected  → "مرفوض" + decision_reason if present.
 *   cancelled → "ملغي".
 */

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  CalendarRange,
  Coins,
  Hourglass,
  CheckCircle2,
  XCircle,
  Ban,
  Inbox,
  Banknote,
  ChevronLeft,
} from 'lucide-react';
import {
  employeesApi,
  EmployeeRequest,
  RequestFilters,
} from '@/api/employees.api';
import { RequestsFilterBar } from './RequestsFilterBar';
import { RequestTimelineDrawer } from './RequestTimelineDrawer';

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
  // Default = "all history" (no filters set). Server defaults
  // limit=50, offset=0; we simply omit filter keys until the user
  // touches the bar.
  const [filters, setFilters] = useState<RequestFilters>({});
  const [openRequest, setOpenRequest] = useState<EmployeeRequest | null>(null);

  const { data: requests = [], isFetching } = useQuery({
    queryKey: ['my-requests', filters],
    queryFn: () => employeesApi.myRequests(filters),
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
    <div
      className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden"
      data-testid="my-requests-card"
    >
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <Inbox size={16} className="text-slate-600" />
            <h4 className="text-sm font-black text-slate-800">طلباتي</h4>
          </div>
          <div className="text-[11px] text-slate-500" data-testid="my-requests-count">
            {list.length} طلب
          </div>
        </div>
      </div>

      <RequestsFilterBar
        filters={filters}
        onChange={setFilters}
        testIdPrefix="my-requests-filter"
      />

      {isFetching && list.length === 0 ? (
        <div className="text-center text-xs text-slate-400 py-8">
          جارٍ التحميل…
        </div>
      ) : list.length === 0 ? (
        <div
          className="text-center text-xs text-slate-400 py-8 px-4 leading-relaxed"
          data-testid="my-requests-empty"
        >
          لا توجد طلبات تطابق التصفية.
        </div>
      ) : (
        <div className="divide-y divide-slate-100">
          <Section
            title="طلبات السلف"
            rows={advances}
            kind="advance"
            onOpen={setOpenRequest}
          />
          <Section
            title="طلبات الإجازة"
            rows={leaves}
            kind="leave"
            onOpen={setOpenRequest}
          />
          {others.length > 0 && (
            <Section
              title="طلبات أخرى"
              rows={others}
              kind="other"
              onOpen={setOpenRequest}
            />
          )}
        </div>
      )}

      <RequestTimelineDrawer
        request={openRequest}
        onClose={() => setOpenRequest(null)}
      />
    </div>
  );
}

function Section({
  title,
  rows,
  kind,
  onOpen,
}: {
  title: string;
  rows: EmployeeRequest[];
  kind: 'advance' | 'leave' | 'other';
  onOpen: (r: EmployeeRequest) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <div className="px-5 py-3">
      <div className="text-[11px] font-bold text-slate-500 mb-2">{title}</div>
      <ul className="space-y-2">
        {rows.map((r) => (
          <RequestRow
            key={r.id}
            request={r}
            kind={kind}
            onOpen={() => onOpen(r)}
          />
        ))}
      </ul>
    </div>
  );
}

function RequestRow({
  request: r,
  kind,
  onOpen,
}: {
  request: EmployeeRequest;
  kind: 'advance' | 'leave' | 'other';
  onOpen: () => void;
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
          : status === 'disbursed'
            ? Banknote
            : Ban;

  // PR-ESS-2B — `disbursed` is the terminal "money has actually
  // moved" state. Distinct emerald tone (slightly stronger than
  // approved) so the operator/employee can tell at-a-glance that
  // the cash leg actually posted.
  const statusTone: Record<string, string> = {
    pending: 'bg-amber-50 text-amber-800 border-amber-200',
    approved: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    disbursed: 'bg-emerald-100 text-emerald-900 border-emerald-300',
    rejected: 'bg-rose-50 text-rose-800 border-rose-200',
    cancelled: 'bg-slate-100 text-slate-600 border-slate-200',
  };

  const statusLabel: Record<string, string> = {
    pending: 'قيد المراجعة',
    approved: 'موافق عليه',
    disbursed: 'تم الصرف',
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

  // PR-ESS-2C-1 — user-facing numeric request number.
  const displayNo = r.request_no ?? r.id;

  // PR-ESS-2A — approved advance hint (suppressed once disbursed).
  const approvedAdvanceHint =
    kind === 'advance' && status === 'approved'
      ? 'بانتظار الصرف من قِبَل المحاسبة'
      : null;

  // PR-ESS-2C-2 — once disbursed, surface the linked expense_no
  // inline so the employee sees exactly which expense represents
  // the cash that actually moved.
  const disbursedHint =
    status === 'disbursed' && r.linked_expense_no
      ? `مصروف #${r.linked_expense_no}`
      : null;

  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
        className="group w-full text-right rounded-xl border border-slate-200 bg-white p-3 hover:border-slate-300 hover:shadow-sm transition focus:outline-none focus:ring-2 focus:ring-slate-300"
        data-testid="request-row"
        data-request-id={r.id}
        data-request-no={displayNo}
      >
        <div className="flex items-start gap-3">
          <div className="w-8 h-8 rounded-lg bg-slate-100 text-slate-600 flex items-center justify-center shrink-0">
            <Icon size={14} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between flex-wrap gap-2">
              <div
                className="text-sm font-bold text-slate-800"
                data-testid="request-row-headline"
              >
                {headline}
              </div>
              <div className="flex items-center gap-1.5">
                <span
                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold border ${statusTone[status]}`}
                  data-testid="request-row-status"
                >
                  <StatusIcon size={11} />
                  {statusLabel[status]}
                </span>
                <ChevronLeft
                  size={14}
                  className="text-slate-300 group-hover:text-slate-500 transition"
                  aria-hidden
                />
              </div>
            </div>

            {/* PR-ESS-2C-1 — numeric request number (digits only). */}
            <div
              className="text-[11px] text-slate-500 mt-0.5 font-mono tabular-nums"
              data-testid="request-row-no"
            >
              رقم الطلب: {displayNo}
            </div>

            {disbursedHint && (
              <div
                className="text-[11px] text-emerald-800 mt-1 font-mono tabular-nums"
                data-testid="request-row-disbursed-link"
              >
                {disbursedHint}
                {r.linked_expense_amount != null
                  ? ` · ${EGP(r.linked_expense_amount)}`
                  : null}
              </div>
            )}

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
      </button>
    </li>
  );
}
