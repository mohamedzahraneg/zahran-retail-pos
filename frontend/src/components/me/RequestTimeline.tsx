/**
 * RequestTimeline — PR-ESS-2C-2
 * ────────────────────────────────────────────────────────────────────
 *
 * Reusable vertical timeline that visualizes one `employee_requests`
 * row's lifecycle. Used by:
 *   · /me MyRequestsCard (drawer when a row is clicked)
 *   · /team ApprovalsAuditTab "كل طلبات الموظف" section (same drawer)
 *
 * Events rendered (in order):
 *
 *   1. تم إنشاء الطلب          — always (created_at + user)
 *   2. تمت الموافقة / تم الرفض / تم الإلغاء — when status moved past pending
 *   3. بانتظار الصرف           — only when kind='advance_request' AND
 *                                 status='approved' AND no linked expense.
 *                                 NOT shown for legacy kind='advance' (per
 *                                 user spec — that path auto-posted
 *                                 historically; the legacy bug we fixed).
 *   4. تم الصرف                 — when a linked expense exists (or status='disbursed')
 *
 * Pure presentation. Reads enriched fields from the EmployeeRequest
 * payload. No mutations, no API calls of its own.
 */

import {
  CheckCircle2,
  XCircle,
  Hourglass,
  Banknote,
  PlusCircle,
  Ban,
} from 'lucide-react';
import { EmployeeRequest } from '@/api/employees.api';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const fmtDateTime = (iso?: string | null): string => {
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

interface TimelineEvent {
  key: string;
  Icon: React.ComponentType<{ size?: number | string; className?: string }>;
  iconWrap: string;        // tailwind classes for the dot wrapper
  title: string;
  detail: string | null;
  timestamp: string | null;
  testId: string;
}

function buildEvents(r: EmployeeRequest): TimelineEvent[] {
  const events: TimelineEvent[] = [];

  // 1) Submitted — always.
  events.push({
    key: 'submitted',
    Icon: PlusCircle,
    iconWrap: 'bg-slate-100 text-slate-600 border-slate-200',
    title: 'تم إنشاء الطلب',
    detail: r.user_name
      ? `بواسطة ${r.user_name}`
      : r.username
        ? `بواسطة ${r.username}`
        : null,
    timestamp: r.created_at,
    testId: 'timeline-event-submitted',
  });

  // 2) Decision — only when the request has moved past pending.
  if (r.status === 'approved' || r.status === 'disbursed') {
    events.push({
      key: 'approved',
      Icon: CheckCircle2,
      iconWrap: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      title: 'تمت الموافقة على الطلب',
      detail: r.decided_by_name ? `بواسطة ${r.decided_by_name}` : null,
      timestamp: r.decided_at ?? null,
      testId: 'timeline-event-approved',
    });
  } else if (r.status === 'rejected') {
    events.push({
      key: 'rejected',
      Icon: XCircle,
      iconWrap: 'bg-rose-50 text-rose-700 border-rose-200',
      title: 'تم رفض الطلب',
      detail: [
        r.decided_by_name ? `بواسطة ${r.decided_by_name}` : null,
        r.decision_reason ? `السبب: ${r.decision_reason}` : null,
      ]
        .filter(Boolean)
        .join(' · '),
      timestamp: r.decided_at ?? null,
      testId: 'timeline-event-rejected',
    });
  } else if (r.status === 'cancelled') {
    events.push({
      key: 'cancelled',
      Icon: Ban,
      iconWrap: 'bg-slate-100 text-slate-600 border-slate-200',
      title: 'تم إلغاء الطلب',
      detail: r.decision_reason ? `السبب: ${r.decision_reason}` : null,
      timestamp: r.decided_at ?? null,
      testId: 'timeline-event-cancelled',
    });
  }

  // 3) Awaiting disbursement — only for the safe `advance_request`
  //    kind, only when approved, only when no linked expense yet.
  //    Legacy `kind='advance'` historically auto-posted on approval
  //    (the cascade PR-ESS-2A-HOTFIX-1 closed off), so it has no
  //    "waiting" phase and we deliberately do not render this event
  //    for it.
  if (
    r.kind === 'advance_request' &&
    r.status === 'approved' &&
    !r.linked_expense_id
  ) {
    events.push({
      key: 'awaiting',
      Icon: Hourglass,
      iconWrap: 'bg-amber-50 text-amber-800 border-amber-200',
      title: 'بانتظار الصرف من قِبَل المحاسبة',
      detail:
        'سيتم تسجيل المصروف اليومي عبر الإجراء المعتاد، ويتغير الطلب إلى "تم الصرف" تلقائيًا.',
      timestamp: null,
      testId: 'timeline-event-awaiting',
    });
  }

  // 4) Disbursed — when a linked expense exists. We trust the join
  //    rather than just `status='disbursed'` so the event still
  //    surfaces even if the status flag drifted out of sync (defensive).
  if (r.linked_expense_id || r.status === 'disbursed') {
    const parts: string[] = [];
    if (r.linked_expense_no) {
      parts.push(`مصروف #${r.linked_expense_no}`);
    }
    if (r.linked_expense_amount != null) {
      parts.push(`بمبلغ ${EGP(r.linked_expense_amount)}`);
    }
    if (r.linked_expense_posted_by_name) {
      parts.push(`بواسطة ${r.linked_expense_posted_by_name}`);
    }
    events.push({
      key: 'disbursed',
      Icon: Banknote,
      iconWrap: 'bg-emerald-100 text-emerald-900 border-emerald-300',
      title: 'تم الصرف',
      detail: parts.length ? parts.join(' · ') : null,
      timestamp: r.linked_expense_posted_at ?? null,
      testId: 'timeline-event-disbursed',
    });
  }

  return events;
}

export interface RequestTimelineProps {
  request: EmployeeRequest;
}

export function RequestTimeline({ request }: RequestTimelineProps) {
  const events = buildEvents(request);

  return (
    <ol
      className="relative ms-3 border-s-2 border-slate-200 space-y-4"
      data-testid="request-timeline"
      dir="rtl"
    >
      {events.map((e) => {
        const Icon = e.Icon;
        return (
          <li key={e.key} className="ps-6 relative" data-testid={e.testId}>
            <span
              className={`absolute -start-[13px] top-0 w-6 h-6 rounded-full border flex items-center justify-center ${e.iconWrap}`}
              aria-hidden
            >
              <Icon size={12} />
            </span>
            <div className="text-sm font-bold text-slate-800">{e.title}</div>
            {e.timestamp && (
              <div className="text-[11px] text-slate-500 font-mono tabular-nums mt-0.5">
                {fmtDateTime(e.timestamp)}
              </div>
            )}
            {e.detail && (
              <div className="text-[11px] text-slate-600 mt-1 leading-relaxed">
                {e.detail}
              </div>
            )}
          </li>
        );
      })}
    </ol>
  );
}
