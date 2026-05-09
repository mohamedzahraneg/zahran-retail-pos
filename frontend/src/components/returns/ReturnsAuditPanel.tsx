/**
 * ReturnsAuditPanel — read-only audit history for a single return /
 * exchange document.  Phase 1 of PR-FIN-RETURNS-EXCHANGES-AUDIT.
 *
 * Renders the unified output of `GET /returns/:id/audit` /
 * `GET /exchanges/:id/audit`:
 *   · document_changes — `audit_logs` row-diffs on the document
 *   · item_changes     — `audit_logs` row-diffs on the items
 *   · activity         — `activity_logs` high-level user actions
 *   · amendments       — Phase-4 placeholder, currently always []
 *
 * No mutation surface.  No edit buttons.  No modals.  No POST/PATCH/
 * DELETE network calls.  Only `useQuery` against the read-only audit
 * endpoint.  The "admin approval" copy below is an informational note
 * only — it announces the FUTURE flow but does NOT enable it.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  History,
  Info,
  Layers,
  ShieldAlert,
  User,
} from 'lucide-react';
import {
  returnsApi,
  type AuditActivityRow,
  type AuditAmendmentRow,
  type AuditChangeRow,
  type AuditEditRequestRow,
  type DocumentAuditResult,
} from '@/api/returns.api';
import {
  isLineChangesPayload,
  LineChangesDiff,
} from './edit-request/diff';
import {
  ApproveEditRequestModal,
  RejectEditRequestModal,
} from './ReviewEditRequestModals';
import { ApplyEditRequestModal } from './ApplyEditRequestModal';
import { useAuthStore } from '@/stores/auth.store';

const NOISY_FIELDS = new Set(['updated_at', 'id', 'created_at']);

const OP_LABEL: Record<'I' | 'U' | 'D', string> = {
  I: 'إضافة',
  U: 'تعديل',
  D: 'حذف',
};

function fmtTimestamp(iso?: string | null): {
  day: string;
  ymd: string;
  hms: string;
} | null {
  if (!iso) return null;
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    const day = new Intl.DateTimeFormat('ar-EG', { weekday: 'long' }).format(d);
    const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const hms = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
    return { day, ymd, hms };
  } catch {
    return null;
  }
}

/**
 * Inline triple — اليوم / التاريخ / الساعة — used by every entry kind.
 * Renders a placeholder em-dash if the timestamp is missing or unparseable.
 */
function Timestamp({
  iso,
  tone = 'slate',
}: {
  iso: string | null | undefined;
  tone?: 'slate' | 'amber';
}) {
  const ts = fmtTimestamp(iso);
  const labelClass =
    tone === 'amber' ? 'text-amber-600' : 'text-slate-500';
  const valueClass =
    tone === 'amber' ? 'text-amber-800' : 'text-slate-700';
  const sepClass = tone === 'amber' ? 'text-amber-300' : 'text-slate-300';
  if (!ts) {
    return <span className={valueClass}>—</span>;
  }
  return (
    <span
      className="inline-flex items-center gap-1 flex-wrap"
      data-testid="audit-timestamp"
    >
      <span className={`font-bold ${labelClass}`}>اليوم:</span>
      <span className={valueClass}>{ts.day}</span>
      <span className={sepClass}>·</span>
      <span className={`font-bold ${labelClass}`}>التاريخ:</span>
      <span className={`${valueClass} font-mono`}>{ts.ymd}</span>
      <span className={sepClass}>·</span>
      <span className={`font-bold ${labelClass}`}>الساعة:</span>
      <span className={`${valueClass} font-mono`}>{ts.hms}</span>
    </span>
  );
}

const sourceLabel = (source: 'audit' | 'activity' | 'amendment') =>
  source === 'audit'
    ? 'audit_logs'
    : source === 'activity'
    ? 'activity_logs'
    : 'amendment';

interface AuditPanelProps {
  entity: 'return' | 'exchange';
  id: string;
}

export function ReturnsAuditPanel({ entity, id }: AuditPanelProps) {
  const { data, isLoading, error } = useQuery<DocumentAuditResult, any>({
    queryKey: ['audit', entity, id],
    queryFn: () =>
      entity === 'return'
        ? returnsApi.getReturnAudit(id)
        : returnsApi.getExchangeAudit(id),
    staleTime: 15_000,
    retry: false,
  });

  const isPermissionError = useMemo(() => {
    if (!error) return false;
    const status = (error as any)?.response?.status;
    return status === 401 || status === 403;
  }, [error]);

  const subtitle =
    entity === 'return'
      ? 'يعرض التغييرات المسجلة على المرتجع وبنوده'
      : 'يعرض التغييرات المسجلة على الاستبدال وبنوده';

  const editRequests: AuditEditRequestRow[] = data?.edit_requests ?? [];

  const isEmpty =
    !!data &&
    data.document_changes.length === 0 &&
    data.item_changes.length === 0 &&
    data.activity.length === 0 &&
    data.amendments.length === 0 &&
    editRequests.length === 0;

  return (
    <details
      className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
      data-testid={`audit-panel-${entity}`}
      dir="rtl"
      open={!isEmpty}
    >
      {/* Header — collapsed-by-default when there are no entries; opens
          automatically once the BE returns any audit row.  Avoids the
          empty audit panel taking a full vertical card slot. */}
      <summary className="cursor-pointer list-none flex items-start gap-2 flex-wrap">
        <History size={14} className="text-slate-500 mt-0.5 shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-sm font-black text-slate-800">
              سجل التعديلات
            </h3>
            <span
              className="text-[10px] font-bold rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200 px-2 py-0.5"
              data-testid="audit-readonly-badge"
            >
              قراءة فقط
            </span>
          </div>
          <p className="text-[11px] text-slate-500 mt-0.5">{subtitle}</p>
        </div>
      </summary>
      <div className="mt-2 space-y-2">

      {/* Admin-approval informational note — compact form (smaller
          padding/icon, same literal Arabic copy as before). */}
      <div
        className="text-[11px] text-indigo-700 bg-indigo-50/60 border border-indigo-100 rounded-md px-2 py-1 flex items-start gap-1.5"
        data-testid="audit-admin-approval-note"
      >
        <Info size={12} className="text-indigo-500 mt-0.5 shrink-0" />
        <span className="leading-relaxed">
          أي تعديل على مرتجع أو استبدال بعد الاعتماد أو الترحيل المالي سيُرسل كطلب تعديل وينتظر موافقة الأدمن.
        </span>
      </div>

      {/* States */}
      {isLoading && !data && (
        <div
          className="rounded-xl border border-slate-100 bg-slate-50/40 p-6 text-center text-[12px] text-slate-600"
          data-testid="audit-loading"
        >
          جارٍ تحميل سجل التعديلات…
        </div>
      )}

      {isPermissionError && (
        <div
          className="rounded-xl border border-rose-200 bg-rose-50/60 p-4 flex items-start gap-2"
          data-testid="audit-permission-denied"
        >
          <ShieldAlert
            size={16}
            className="text-rose-600 mt-0.5 shrink-0"
          />
          <div className="text-[12px] text-rose-800">
            لا توجد صلاحية لعرض سجل التعديلات
          </div>
        </div>
      )}

      {error && !isPermissionError && (
        <div
          className="rounded-xl border border-rose-200 bg-rose-50/60 p-4 flex items-start gap-2"
          data-testid="audit-error"
        >
          <AlertTriangle
            size={16}
            className="text-rose-600 mt-0.5 shrink-0"
          />
          <div className="text-[12px] text-rose-800">
            تعذّر تحميل سجل التعديلات
          </div>
        </div>
      )}

      {data && isEmpty && (
        <div
          className="text-[11px] text-slate-500 italic flex items-center gap-1.5"
          data-testid="audit-empty"
        >
          <Layers size={12} className="text-slate-400 shrink-0" />
          <span>لا توجد تعديلات مسجلة حتى الآن</span>
        </div>
      )}

      {data && !isEmpty && (
        <ul className="space-y-2" data-testid="audit-entries">
          {/* Document changes (audit_logs) */}
          {data.document_changes.map((c) => (
            <ChangeEntry key={`doc-${c.id}`} row={c} kind="document" />
          ))}
          {/* Item changes (audit_logs) */}
          {data.item_changes.map((c) => (
            <ChangeEntry key={`item-${c.id}`} row={c} kind="item" />
          ))}
          {/* Activity (activity_logs) */}
          {data.activity.map((a) => (
            <ActivityEntry key={`act-${a.id}`} row={a} />
          ))}
          {/* Edit requests (Phase 1 — request + review only) */}
          {editRequests.map((req) => (
            <EditRequestEntry
              key={`req-${req.id}`}
              row={req}
              entity={entity}
              parentId={id}
            />
          ))}
          {/* Amendments (Phase-4 placeholder) */}
          {data.amendments.map((am) => (
            <AmendmentEntry key={`am-${am.id}`} row={am} />
          ))}
        </ul>
      )}

        {/* Phase-1 informational note: request entry lives on the
            details panel; admin approval is required before any
            payload is applied to the parent document. */}
        <div
          className="text-[11px] text-slate-500 italic"
          data-testid="audit-edit-request-deferred"
        >
          يمكنك إنشاء طلب تعديل من زر طلب تعديل، وسيظل بانتظار موافقة الأدمن.
        </div>
      </div>
    </details>
  );
}

// ─── change entry (audit_logs) ──────────────────────────────────────

function ChangeEntry({
  row,
  kind,
}: {
  row: AuditChangeRow;
  kind: 'document' | 'item';
}) {
  const opLabel = OP_LABEL[row.operation] ?? row.operation;
  const recordKind = kind === 'document' ? 'مستند' : 'بند';
  const reason = pickReason(row);

  return (
    <li
      className="rounded-xl border border-slate-100 bg-slate-50/40 p-3 space-y-2"
      data-testid={`audit-change-${row.id}`}
    >
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <span className="font-bold text-slate-700">نوع السجل:</span>
        <span className="text-slate-600">{recordKind}</span>
        <span className="text-slate-300">·</span>
        <span className="font-bold text-slate-700">نوع العملية:</span>
        <span className="text-slate-600">{opLabel}</span>
        <span className="text-slate-300">·</span>
        <User size={12} className="text-slate-400" />
        <span className="font-bold text-slate-700">تم بواسطة:</span>
        <span className="text-slate-600">
          {row.changed_by_name || row.changed_by_username || '—'}
        </span>
        <span className="ms-auto text-[10px] font-mono text-slate-400">
          {sourceLabel('audit')}
        </span>
      </div>
      <div className="text-[11px]">
        <Timestamp iso={row.changed_at} />
      </div>
      {reason && (
        <div className="text-[11px] text-slate-700 bg-white rounded-lg px-2 py-1.5 border border-slate-100">
          <span className="font-bold">سبب التعديل:</span> {reason}
        </div>
      )}
      <DiffGrid old={row.old_data} now={row.new_data} />
    </li>
  );
}

// ─── activity entry (activity_logs) ─────────────────────────────────

function ActivityEntry({ row }: { row: AuditActivityRow }) {
  return (
    <li
      className="rounded-xl border border-slate-100 bg-slate-50/40 p-3 space-y-2"
      data-testid={`audit-activity-${row.id}`}
    >
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <span className="font-bold text-slate-700">نوع السجل:</span>
        <span className="text-slate-600">نشاط</span>
        <span className="text-slate-300">·</span>
        <span className="font-bold text-slate-700">نوع العملية:</span>
        <span className="text-slate-600">{row.action}</span>
        <span className="text-slate-300">·</span>
        <User size={12} className="text-slate-400" />
        <span className="font-bold text-slate-700">تم بواسطة:</span>
        <span className="text-slate-600">
          {row.full_name || row.username || '—'}
        </span>
        <span className="ms-auto text-[10px] font-mono text-slate-400">
          {sourceLabel('activity')}
        </span>
      </div>
      <div className="text-[11px]">
        <Timestamp iso={row.created_at} />
      </div>
      {row.summary && (
        <div className="text-[12px] text-slate-700">{row.summary}</div>
      )}
      <ActivityMetaSummary metadata={row.metadata} />
    </li>
  );
}

/**
 * Surface the lifecycle event extras the BE writes (status_before /
 * status_after / reason / amount / refund_method / etc.) so users can
 * read the lifecycle without expanding raw JSON.
 */
function ActivityMetaSummary({ metadata }: { metadata: any }) {
  if (!metadata || typeof metadata !== 'object') return null;
  const md = metadata as Record<string, any>;
  const interesting: Array<{ label: string; value: string }> = [];
  if (md.kind) interesting.push({ label: 'نوع الحدث', value: String(md.kind) });
  if (md.status_before)
    interesting.push({ label: 'الحالة قبل', value: String(md.status_before) });
  if (md.status_after)
    interesting.push({ label: 'الحالة بعد', value: String(md.status_after) });
  if (md.reason) interesting.push({ label: 'سبب الإجراء', value: String(md.reason) });
  if (md.notes) interesting.push({ label: 'ملاحظات', value: String(md.notes) });
  if (md.refund_method)
    interesting.push({ label: 'طريقة الصرف', value: String(md.refund_method) });
  if (md.payment_method)
    interesting.push({ label: 'طريقة الدفع', value: String(md.payment_method) });
  if (md.net_refund !== undefined)
    interesting.push({ label: 'صافي المردود', value: String(md.net_refund) });
  if (md.price_difference !== undefined)
    interesting.push({ label: 'فرق السعر', value: String(md.price_difference) });
  if (interesting.length === 0) return null;
  return (
    <ul className="grid grid-cols-1 sm:grid-cols-2 gap-1 text-[11px]">
      {interesting.map((kv, i) => (
        <li key={i} className="flex items-baseline gap-2">
          <span className="font-bold text-slate-500">{kv.label}:</span>
          <span className="text-slate-700 break-all">{kv.value}</span>
        </li>
      ))}
    </ul>
  );
}

// ─── amendment entry (Phase-4 placeholder) ──────────────────────────

function AmendmentEntry({ row }: { row: AuditAmendmentRow }) {
  return (
    <li
      className="rounded-xl border border-amber-200 bg-amber-50/60 p-3 space-y-2"
      data-testid={`audit-amendment-${row.id}`}
    >
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <span className="font-bold text-amber-800">نوع السجل:</span>
        <span className="text-amber-700">تصحيح ({row.amendment_no})</span>
        <span className="text-amber-300">·</span>
        <span className="font-bold text-amber-800">نوع العملية:</span>
        <span className="text-amber-700">{row.amendment_kind}</span>
        <span className="text-amber-300">·</span>
        <User size={12} className="text-amber-500" />
        <span className="font-bold text-amber-800">تم بواسطة:</span>
        <span className="text-amber-700">{row.created_by_name || '—'}</span>
        <span className="ms-auto text-[10px] font-mono text-amber-500">
          {sourceLabel('amendment')}
        </span>
      </div>
      <div className="text-[11px]">
        <Timestamp iso={row.created_at} tone="amber" />
      </div>
      {row.reason_text && (
        <div className="text-[11px] text-amber-900 bg-white rounded-lg px-2 py-1.5 border border-amber-100">
          <span className="font-bold">سبب التعديل:</span> {row.reason_text}
        </div>
      )}
    </li>
  );
}

// ─── edit-request entry (Phase 1 — request + review only) ───────────

const REQUEST_STATUS_PILL: Record<
  AuditEditRequestRow['status'],
  { label: string; className: string }
> = {
  pending: {
    label: 'طلب تعديل ينتظر موافقة الأدمن',
    className:
      'bg-indigo-50 text-indigo-800 border border-indigo-200',
  },
  approved: {
    label: 'تم اعتماد الطلب - لم يتم تطبيق التعديل بعد',
    className:
      'bg-emerald-50 text-emerald-800 border border-emerald-200',
  },
  rejected: {
    label: 'تم رفض الطلب',
    className: 'bg-rose-50 text-rose-800 border border-rose-200',
  },
  cancelled: {
    label: 'تم إلغاء الطلب',
    className: 'bg-slate-50 text-slate-700 border border-slate-200',
  },
};

// Friendly Arabic labels for the 7-value `requested_action` enum.  We
// fall back to the raw value if a future BE adds a new action — the
// admin still sees something readable rather than a blank.
const ACTION_LABELS_AR: Record<string, string> = {
  update_header: 'تحديث بيانات عامة',
  update_item: 'تعديل بند',
  remove_item: 'حذف بند',
  replace_item: 'استبدال منتج',
  price_change: 'تعديل سعر',
  quantity_change: 'تعديل كمية',
  reason_change: 'تعديل السبب',
};

function EditRequestEntry({
  row,
  entity,
  parentId,
}: {
  row: AuditEditRequestRow;
  entity: 'return' | 'exchange';
  parentId: string;
}) {
  const pill = REQUEST_STATUS_PILL[row.status];
  const structured = isLineChangesPayload(row.requested_payload)
    ? row.requested_payload
    : null;
  const actionLabel =
    ACTION_LABELS_AR[row.requested_action] ?? row.requested_action;

  // PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS-REVIEW — admin-only review
  // actions.  The BE gates approve/reject with @Roles('admin') only;
  // we mirror that here so non-admin users never see the buttons.
  // The buttons just open confirm modals; they never apply the
  // requested payload to the parent document.
  const isAdmin = useAuthStore((s) => s.hasRole('admin'));
  const [reviewAction, setReviewAction] = useState<
    'approve' | 'reject' | null
  >(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const canReview = isAdmin && row.status === 'pending';
  // PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS-APPLY — admin can apply an
  // already-approved request that hasn't been applied yet.  Phase 2A
  // ships RETURN apply only; exchange shows a disabled "قيد الإعداد"
  // hint instead of the button.
  const isApproved = row.status === 'approved';
  const isApplied = Boolean(row.applied_at);
  const canApplyReturn =
    isAdmin && entity === 'return' && isApproved && !isApplied;
  const showExchangeApplyDeferred =
    entity === 'exchange' && isApproved && !isApplied;
  return (
    <li
      className="rounded-xl border border-indigo-200 bg-indigo-50/50 p-3 space-y-2"
      data-testid={`audit-edit-request-${row.id}`}
    >
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <span className="font-bold text-indigo-800">نوع السجل:</span>
        <span className="text-indigo-700">طلب تعديل</span>
        <span className="text-indigo-300">·</span>
        <span className="font-bold text-indigo-800">
          نوع التعديل المطلوب:
        </span>
        <span className="text-indigo-700">{actionLabel}</span>
        <span
          className={`ms-auto text-[10px] font-bold rounded-full px-2 py-0.5 ${pill.className}`}
          data-testid={`audit-edit-request-${row.id}-status-pill`}
        >
          {pill.label}
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
        <div className="rounded-lg border border-indigo-100 bg-white p-2">
          <div className="text-[10px] font-bold text-indigo-700 mb-1">
            طلب بواسطة
          </div>
          <div className="text-indigo-900">
            {row.requested_by_name || '—'}
          </div>
          <div className="mt-1">
            <Timestamp iso={row.requested_at} />
          </div>
        </div>
        <div className="rounded-lg border border-indigo-100 bg-white p-2">
          <div className="text-[10px] font-bold text-indigo-700 mb-1">
            راجع بواسطة
          </div>
          <div className="text-indigo-900">
            {row.reviewed_by_name || '—'}
          </div>
          <div className="mt-1">
            {row.reviewed_at ? (
              <Timestamp iso={row.reviewed_at} />
            ) : (
              <span className="text-indigo-400">لم تتم المراجعة بعد</span>
            )}
          </div>
        </div>
      </div>
      <div className="text-[11px] text-indigo-900 bg-white rounded-lg px-2 py-1.5 border border-indigo-100">
        <span className="font-bold">سبب طلب التعديل:</span> {row.reason_text}
      </div>
      {row.review_notes && (
        <div className="text-[11px] text-indigo-900 bg-white rounded-lg px-2 py-1.5 border border-indigo-100">
          <span className="font-bold">ملاحظات المراجعة:</span>{' '}
          {row.review_notes}
        </div>
      )}

      {/* PR-FIN-RETURNS-EXCHANGES-EDIT-REQUEST-GUIDED — when the request
          was filed through the new guided UI it ships with a structured
          `line_changes` payload, which we render as a friendly Arabic
          diff.  Legacy / unknown payloads fall back to the existing
          before/after JSON view inside a "تفاصيل تقنية" collapsible. */}
      {structured ? (
        <div
          className="rounded-lg border border-indigo-100 bg-white p-2"
          data-testid={`audit-edit-request-${row.id}-diff`}
        >
          <div className="text-[10px] font-bold text-indigo-700 mb-2">
            ملخص التعديل المطلوب
          </div>
          <LineChangesDiff payload={structured} showTotals />
        </div>
      ) : null}

      <details className="text-[11px]" data-testid={`audit-edit-request-${row.id}-raw`}>
        <summary className="cursor-pointer text-indigo-700 font-bold">
          تفاصيل تقنية
        </summary>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mt-1">
          <div className="rounded-lg border border-indigo-100 bg-white p-2">
            <div className="text-[10px] font-bold text-indigo-700 mb-1">
              قبل التعديل
            </div>
            <pre
              className="text-[10px] text-indigo-900 whitespace-pre-wrap break-all"
              dir="ltr"
            >
              {JSON.stringify(row.before_snapshot, null, 2)}
            </pre>
          </div>
          <div className="rounded-lg border border-indigo-100 bg-white p-2">
            <div className="text-[10px] font-bold text-indigo-700 mb-1">
              التعديل المطلوب
            </div>
            <pre
              className="text-[10px] text-indigo-900 whitespace-pre-wrap break-all"
              dir="ltr"
            >
              {JSON.stringify(row.requested_payload, null, 2)}
            </pre>
          </div>
        </div>
      </details>

      {/* PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS-REVIEW — admin actions
          on pending requests.  Hidden for non-admin users and for any
          status other than `pending` (BE re-checks both). */}
      {canReview && (
        <div
          className="flex gap-2 pt-2 border-t border-indigo-100"
          data-testid={`audit-edit-request-${row.id}-admin-actions`}
        >
          <button
            type="button"
            onClick={() => setReviewAction('approve')}
            className="text-[12px] font-bold text-emerald-800 bg-emerald-100 hover:bg-emerald-200 px-3 py-1.5 rounded-lg"
            data-testid={`audit-edit-request-${row.id}-approve`}
          >
            اعتماد الطلب
          </button>
          <button
            type="button"
            onClick={() => setReviewAction('reject')}
            className="text-[12px] font-bold text-rose-800 bg-rose-100 hover:bg-rose-200 px-3 py-1.5 rounded-lg"
            data-testid={`audit-edit-request-${row.id}-reject`}
          >
            رفض الطلب
          </button>
        </div>
      )}

      {/* PR-FIN-RETURNS-EXCHANGES-EDIT-REQUESTS-APPLY — admin button to
          apply an already-approved RETURN request.  Strong-warning
          styling because this is the financial side-effect step.
          Visibility: admin AND entity='return' AND status='approved'
          AND not yet applied. */}
      {canApplyReturn && (
        <div
          className="flex gap-2 pt-2 border-t border-indigo-100"
          data-testid={`audit-edit-request-${row.id}-apply-actions`}
        >
          <button
            type="button"
            onClick={() => setApplyOpen(true)}
            className="text-[12px] font-bold text-white bg-rose-600 hover:bg-rose-700 px-3 py-1.5 rounded-lg inline-flex items-center gap-1"
            data-testid={`audit-edit-request-${row.id}-apply`}
          >
            <AlertTriangle size={12} /> تطبيق التعديل
          </button>
        </div>
      )}

      {/* Phase 2A — exchange apply is intentionally not shipped.  Show
          a small disabled "قيد الإعداد" hint when an exchange request
          is approved but not applied. */}
      {showExchangeApplyDeferred && (
        <div
          className="text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5"
          data-testid={`audit-edit-request-${row.id}-apply-deferred`}
        >
          تطبيق تعديلات الاستبدال قيد الإعداد
        </div>
      )}

      {/* Applied-state — once applied_at is set, render the badge +
          summary + linked artifact ids so admins can trace the
          financial / inventory side-effects from the audit panel
          without leaving the page. */}
      {isApplied && (
        <AppliedBlock row={row} />
      )}

      {reviewAction === 'approve' && (
        <ApproveEditRequestModal
          entity={entity}
          parentId={parentId}
          request={row}
          onClose={() => setReviewAction(null)}
        />
      )}
      {reviewAction === 'reject' && (
        <RejectEditRequestModal
          entity={entity}
          parentId={parentId}
          request={row}
          onClose={() => setReviewAction(null)}
        />
      )}
      {applyOpen && (
        <ApplyEditRequestModal
          entity={entity}
          parentId={parentId}
          request={row}
          onClose={() => setApplyOpen(false)}
        />
      )}
    </li>
  );
}

// ─── Applied-state block (Phase 2A) ────────────────────────────────
// Renders when `row.applied_at` is set.  Shows the badge, who applied
// it and when, the apply_summary deltas, and the linked artifact ids
// (JE / CT / SM) so the trace surface is one click away.

function AppliedBlock({ row }: { row: AuditEditRequestRow }) {
  const summary = row.apply_summary ?? null;
  const jes = row.apply_journal_entry_ids ?? [];
  const cts = row.apply_cashbox_transaction_ids ?? [];
  const sms = row.apply_stock_movement_ids ?? [];
  return (
    <div
      className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-2"
      data-testid={`audit-edit-request-${row.id}-applied`}
    >
      <div className="flex items-center gap-2 flex-wrap text-[11px]">
        <span
          className="text-[10px] font-bold rounded-full px-2 py-0.5 bg-emerald-100 text-emerald-800 border border-emerald-300"
          data-testid={`audit-edit-request-${row.id}-applied-badge`}
        >
          ✓ تم تطبيق التعديل
        </span>
        {row.applied_by_name && (
          <>
            <span className="text-emerald-300">·</span>
            <span className="text-emerald-800">طُبِّق بواسطة:</span>
            <span className="font-bold text-emerald-900">
              {row.applied_by_name}
            </span>
          </>
        )}
        {row.applied_at && (
          <>
            <span className="text-emerald-300">·</span>
            <Timestamp iso={row.applied_at} />
          </>
        )}
      </div>

      {summary && (
        <div
          className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]"
          data-testid={`audit-edit-request-${row.id}-applied-summary`}
        >
          {(summary.lines_updated ?? 0) > 0 && (
            <div>
              <span className="text-emerald-700">عدد البنود المعدلة: </span>
              <span className="font-bold">{summary.lines_updated}</span>
            </div>
          )}
          {(summary.lines_removed ?? 0) > 0 && (
            <div>
              <span className="text-emerald-700">عدد البنود المحذوفة: </span>
              <span className="font-bold">{summary.lines_removed}</span>
            </div>
          )}
          {(summary.lines_added ?? 0) > 0 && (
            <div>
              <span className="text-emerald-700">عدد البنود المضافة: </span>
              <span className="font-bold">{summary.lines_added}</span>
            </div>
          )}
          {summary.delta_total_refund != null && (
            <div>
              <span className="text-emerald-700">فرق الإجمالي: </span>
              <span className="font-bold font-mono">
                {summary.delta_total_refund > 0 ? '+' : ''}
                {summary.delta_total_refund.toFixed(2)}
              </span>
            </div>
          )}
          {summary.delta_net_refund != null && (
            <div>
              <span className="text-emerald-700">فرق الصافي: </span>
              <span className="font-bold font-mono">
                {summary.delta_net_refund > 0 ? '+' : ''}
                {summary.delta_net_refund.toFixed(2)}
              </span>
            </div>
          )}
        </div>
      )}

      {(jes.length > 0 || cts.length > 0 || sms.length > 0) && (
        <div
          className="text-[11px] text-emerald-900 space-y-0.5"
          data-testid={`audit-edit-request-${row.id}-applied-artifacts`}
        >
          {jes.length > 0 && (
            <div>
              <span className="text-emerald-700">قيود محاسبية: </span>
              <span className="font-mono" dir="ltr">
                {jes.join(', ')}
              </span>
            </div>
          )}
          {cts.length > 0 && (
            <div>
              <span className="text-emerald-700">حركات خزنة: </span>
              <span className="font-mono" dir="ltr">
                {cts.join(', ')}
              </span>
            </div>
          )}
          {sms.length > 0 && (
            <div>
              <span className="text-emerald-700">حركات مخزون: </span>
              <span className="font-mono" dir="ltr">
                {sms.join(', ')}
              </span>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── diff renderer ──────────────────────────────────────────────────

function DiffGrid({
  old: oldData,
  now,
}: {
  old: Record<string, any> | null;
  now: Record<string, any> | null;
}) {
  const keys = useMemo(() => {
    const all = new Set<string>();
    if (oldData) Object.keys(oldData).forEach((k) => all.add(k));
    if (now) Object.keys(now).forEach((k) => all.add(k));
    NOISY_FIELDS.forEach((k) => all.delete(k));
    return Array.from(all).filter((k) => {
      const o = oldData?.[k];
      const n = now?.[k];
      // Hide unchanged keys when both old + new exist (UPDATE row).
      if (oldData && now) return !shallowEq(o, n);
      // For INSERT/DELETE rows, show every (non-noisy) key.
      return true;
    });
  }, [oldData, now]);

  if (keys.length === 0) return null;
  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
      <div className="rounded-lg border border-slate-100 bg-white p-2">
        <div className="text-[10px] font-bold text-slate-500 mb-1">
          قبل التعديل
        </div>
        {oldData ? (
          <KeyValueList row={oldData} keys={keys} />
        ) : (
          <div className="text-slate-400">—</div>
        )}
      </div>
      <div className="rounded-lg border border-slate-100 bg-white p-2">
        <div className="text-[10px] font-bold text-slate-500 mb-1">
          بعد التعديل
        </div>
        {now ? (
          <KeyValueList row={now} keys={keys} />
        ) : (
          <div className="text-slate-400">—</div>
        )}
      </div>
    </div>
  );
}

function KeyValueList({
  row,
  keys,
}: {
  row: Record<string, any>;
  keys: string[];
}) {
  return (
    <ul className="space-y-0.5">
      {keys.map((k) => (
        <li key={k} className="flex items-baseline gap-2">
          <span className="font-mono text-slate-500 text-[10px] shrink-0">
            {k}
          </span>
          <span className="text-slate-800 break-all">{renderVal(row[k])}</span>
        </li>
      ))}
    </ul>
  );
}

function renderVal(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function shallowEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    try {
      return JSON.stringify(a) === JSON.stringify(b);
    } catch {
      return false;
    }
  }
  return false;
}

function pickReason(row: AuditChangeRow): string | null {
  // Future-proof: when Phase 2+ writes reason text into one of these
  // common columns, surface it.  Today the BE doesn't carry it on
  // audit_logs, so this returns null.
  const candidate =
    (row.new_data && (row.new_data['reason_text'] || row.new_data['cancel_reason'])) ||
    (row.old_data && (row.old_data['reason_text'] || row.old_data['cancel_reason']));
  return typeof candidate === 'string' && candidate.length > 0
    ? candidate
    : null;
}
