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
import { useMemo } from 'react';
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
    <section
      className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3"
      data-testid={`audit-panel-${entity}`}
      dir="rtl"
    >
      {/* Header */}
      <div className="flex items-start gap-2 flex-wrap">
        <History size={18} className="text-slate-500 mt-0.5 shrink-0" />
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
          <p className="text-[11px] text-slate-500 mt-1">{subtitle}</p>
        </div>
      </div>

      {/* Admin-approval informational note (non-functional copy only) */}
      <div
        className="rounded-xl border border-indigo-200 bg-indigo-50/60 p-3 flex items-start gap-2"
        data-testid="audit-admin-approval-note"
      >
        <Info size={14} className="text-indigo-600 mt-0.5 shrink-0" />
        <div className="text-[11px] text-indigo-900 leading-relaxed">
          أي تعديل على مرتجع أو استبدال بعد الاعتماد أو الترحيل المالي سيُرسل
          كطلب تعديل وينتظر موافقة الأدمن.
        </div>
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
          className="rounded-xl border border-dashed border-slate-300 bg-slate-50/40 p-8 text-center"
          data-testid="audit-empty"
        >
          <Layers size={20} className="mx-auto text-slate-400" />
          <div className="mt-2 text-[12px] font-bold text-slate-700">
            لا توجد تعديلات مسجلة حتى الآن
          </div>
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
            <EditRequestEntry key={`req-${req.id}`} row={req} />
          ))}
          {/* Amendments (Phase-4 placeholder) */}
          {data.amendments.map((am) => (
            <AmendmentEntry key={`am-${am.id}`} row={am} />
          ))}
        </ul>
      )}

      {/* Phase-1 informational note: request creation UI is deferred. */}
      <div
        className="text-[11px] text-slate-500 italic"
        data-testid="audit-edit-request-deferred"
      >
        إنشاء طلب تعديل سيتم تفعيله في المرحلة التالية.
      </div>
    </section>
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
    label: 'تم اعتماد الطلب (لم يُطبَّق بعد)',
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

function EditRequestEntry({ row }: { row: AuditEditRequestRow }) {
  const pill = REQUEST_STATUS_PILL[row.status];
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
        <span className="text-indigo-700">{row.requested_action}</span>
        <span
          className={`ms-auto text-[10px] font-bold rounded-full px-2 py-0.5 ${pill.className}`}
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
        <span className="font-bold">سبب التعديل:</span> {row.reason_text}
      </div>
      {row.review_notes && (
        <div className="text-[11px] text-indigo-900 bg-white rounded-lg px-2 py-1.5 border border-indigo-100">
          <span className="font-bold">ملاحظات المراجعة:</span>{' '}
          {row.review_notes}
        </div>
      )}
      <details className="text-[11px]">
        <summary className="cursor-pointer text-indigo-700 font-bold">
          تفاصيل (قبل التعديل / التعديل المطلوب)
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
    </li>
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
