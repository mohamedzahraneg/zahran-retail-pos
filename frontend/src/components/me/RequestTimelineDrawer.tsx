/**
 * RequestTimelineDrawer — PR-ESS-2C-2
 * ────────────────────────────────────────────────────────────────────
 *
 * Lightweight modal/drawer that wraps `<RequestTimeline />` with a
 * header showing the request_no + headline. Used by both
 * MyRequestsCard (employee view) and ApprovalsAuditTab (manager view)
 * so the click-through experience is identical.
 *
 * Pure presentation. No fetching of its own — caller passes the
 * already-loaded `EmployeeRequest`. Backdrop click + Esc both close.
 */
import { useEffect } from 'react';
import { X } from 'lucide-react';
import { EmployeeRequest } from '@/api/employees.api';
import { RequestTimeline } from './RequestTimeline';

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

function headlineFor(r: EmployeeRequest): string {
  if (r.kind === 'advance' || r.kind === 'advance_request') {
    return `سلفة ${EGP(r.amount)}`;
  }
  if (r.kind === 'leave') {
    return `إجازة من ${fmtDate(r.starts_at)} إلى ${fmtDate(r.ends_at)}`;
  }
  return r.reason ?? 'طلب';
}

export interface RequestTimelineDrawerProps {
  request: EmployeeRequest | null;
  onClose: () => void;
}

export function RequestTimelineDrawer({
  request,
  onClose,
}: RequestTimelineDrawerProps) {
  useEffect(() => {
    if (!request) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [request, onClose]);

  if (!request) return null;

  const displayNo = request.request_no ?? request.id;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/40 backdrop-blur-[2px]"
      onClick={onClose}
      data-testid="request-timeline-drawer-backdrop"
      role="dialog"
      aria-modal="true"
    >
      <div
        className="relative w-full max-w-md rounded-2xl bg-white shadow-xl border border-slate-200 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
        data-testid="request-timeline-drawer"
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <div className="text-sm font-bold text-slate-800">
              {headlineFor(request)}
            </div>
            <div
              className="text-[11px] text-slate-500 font-mono tabular-nums mt-0.5"
              data-testid="request-timeline-drawer-no"
            >
              رقم الطلب: {displayNo}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 rounded-lg text-slate-500 hover:text-slate-800 hover:bg-slate-100 flex items-center justify-center"
            aria-label="إغلاق"
            data-testid="request-timeline-drawer-close"
          >
            <X size={14} />
          </button>
        </div>

        <div className="px-5 py-4 max-h-[70vh] overflow-y-auto">
          <RequestTimeline request={request} />
        </div>
      </div>
    </div>
  );
}
