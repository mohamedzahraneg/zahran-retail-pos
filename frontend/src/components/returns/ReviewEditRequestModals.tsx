/**
 * ReviewEditRequestModals — Phase 2 admin-only review actions.
 *
 * Strict scope:
 *   · Calls ONLY the four review wrappers on `returnsApi`:
 *       - approveReturnEditRequest / rejectReturnEditRequest
 *       - approveExchangeEditRequest / rejectExchangeEditRequest
 *     All four hit `POST .../approve` or `POST .../reject` only.  The
 *     BE flips the row's `status` and never APPLIES the requested
 *     payload to the parent return / exchange / items / journal /
 *     cashbox / stock.  This UI mirrors that contract: a confirmation
 *     dialog with a clear "no changes are applied" warning, plus an
 *     optional / required review_notes field.
 *   · No PATCH / PUT / DELETE.
 *   · No amendment / apply / reverse / replay endpoints.
 *   · On success, the audit panel's `['audit', entity, parentId]`
 *     query is invalidated so the entry's status pill flips to
 *     approved / rejected without a page reload.
 *
 * Both modals render via `createPortal(document.body)` so they sit
 * above the parent details modal (which has backdrop-blur).
 */
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertTriangle, Info, XCircle } from 'lucide-react';
import {
  returnsApi,
  type AuditEditRequestRow,
  type LineChangesPayload,
  type ReviewEditRequestBody,
} from '@/api/returns.api';
import { isLineChangesPayload, LineChangesDiff } from './edit-request/diff';

// ── Shared types & helpers ────────────────────────────────────────

export interface ReviewModalProps {
  entity: 'return' | 'exchange';
  parentId: string;
  request: AuditEditRequestRow;
  onClose: () => void;
  onSuccess?: () => void;
}

// Friendly Arabic labels for the 7-value `requested_action` enum.
// Co-located so the modal renders the same way the audit panel does.
const ACTION_LABELS_AR: Record<string, string> = {
  update_header: 'تحديث بيانات عامة',
  update_item: 'تعديل بند',
  remove_item: 'حذف بند',
  replace_item: 'استبدال منتج',
  price_change: 'تعديل سعر',
  quantity_change: 'تعديل كمية',
  reason_change: 'تعديل السبب',
};

function RequestSummary({ request }: { request: AuditEditRequestRow }) {
  const structured: LineChangesPayload | null = isLineChangesPayload(
    request.requested_payload,
  )
    ? request.requested_payload
    : null;
  const actionLabel =
    ACTION_LABELS_AR[request.requested_action] ?? request.requested_action;
  return (
    <div className="space-y-2" data-testid="review-request-summary">
      <div className="flex items-center gap-2 flex-wrap text-[12px]">
        <span className="text-slate-500">نوع التعديل المطلوب:</span>
        <span className="font-bold text-slate-800">{actionLabel}</span>
        <span className="text-slate-300">·</span>
        <span className="text-slate-500">طلب بواسطة:</span>
        <span className="font-bold text-slate-800">
          {request.requested_by_name ?? '—'}
        </span>
      </div>
      {request.reason_text && (
        <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-[12px]">
          <span className="font-bold text-slate-700">سبب طلب التعديل: </span>
          <span className="text-slate-800">{request.reason_text}</span>
        </div>
      )}
      {structured && (
        <div className="rounded-lg border border-slate-200 bg-white p-2">
          <div className="text-[10px] font-bold text-slate-700 mb-2">
            ملخص التعديل المطلوب
          </div>
          <LineChangesDiff payload={structured} />
        </div>
      )}
    </div>
  );
}

function ModalShell({
  title,
  subtitle,
  onClose,
  testId,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return createPortal(
    <div
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onClick={onClose}
      data-testid={testId}
      dir="rtl"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-slate-100 px-6 py-4 flex items-center justify-between z-10">
          <div>
            <h3 className="text-lg font-black text-slate-900">{title}</h3>
            {subtitle && (
              <p className="text-[11px] text-slate-500 mt-0.5">{subtitle}</p>
            )}
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="إغلاق"
          >
            <XCircle size={22} />
          </button>
        </div>
        <div className="p-6 space-y-4">{children}</div>
      </div>
    </div>,
    document.body,
  );
}

// ── Approve modal ─────────────────────────────────────────────────

export function ApproveEditRequestModal({
  entity,
  parentId,
  request,
  onClose,
  onSuccess,
}: ReviewModalProps) {
  const qc = useQueryClient();
  const [reviewNotes, setReviewNotes] = useState('');

  const mut = useMutation({
    mutationFn: (body: ReviewEditRequestBody) =>
      entity === 'return'
        ? returnsApi.approveReturnEditRequest(parentId, request.id, body)
        : returnsApi.approveExchangeEditRequest(parentId, request.id, body),
    onSuccess: () => {
      toast.success(
        'تم اعتماد طلب التعديل. لم يتم تطبيق التعديل بعد.',
      );
      qc.invalidateQueries({ queryKey: ['audit', entity, parentId] });
      onSuccess?.();
      onClose();
    },
    onError: (e: any) => {
      const fallback = 'تعذّر اعتماد طلب التعديل';
      const candidates = [e?.response?.data?.message, e?.message];
      const picked = candidates.find(
        (c) => typeof c === 'string' && c.trim().length > 0,
      );
      toast.error(picked ?? fallback);
    },
  });

  function handleConfirm() {
    if (mut.isPending) return;
    const body: ReviewEditRequestBody = {};
    const trimmed = reviewNotes.trim();
    if (trimmed.length > 0) body.review_notes = trimmed;
    mut.mutate(body);
  }

  return (
    <ModalShell
      title="اعتماد طلب التعديل"
      subtitle={request.document_no ?? undefined}
      onClose={onClose}
      testId="approve-edit-request-modal"
    >
      <RequestSummary request={request} />

      {/* No-apply warning — must be visible per spec. */}
      <div
        className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] flex items-start gap-2"
        data-testid="approve-edit-request-warning"
      >
        <AlertTriangle
          size={14}
          className="text-amber-600 mt-0.5 shrink-0"
        />
        <div className="text-amber-900 leading-relaxed">
          اعتماد الطلب لا يطبق التعديل على المرتجع أو الاستبدال الآن. سيتم
          تغيير حالة الطلب فقط.
        </div>
      </div>

      <div>
        <label className="text-[11px] font-bold text-slate-700 block mb-1">
          ملاحظات الموافقة (اختياري)
        </label>
        <textarea
          value={reviewNotes}
          onChange={(e) => setReviewNotes(e.target.value)}
          rows={2}
          className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:bg-white focus:border-brand-300 w-full"
          data-testid="approve-edit-request-notes"
        />
      </div>

      <div className="flex items-start gap-1.5 text-[11px] text-slate-500">
        <Info size={12} className="mt-0.5 shrink-0" />
        <span>
          هذا الإجراء يحدّث حالة الطلب فقط ولا يقوم بأي عملية محاسبية أو
          مخزنية.
        </span>
      </div>

      <div className="flex gap-2 justify-end pt-2 border-t border-slate-100">
        <button
          type="button"
          onClick={onClose}
          className="text-[12px] font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 px-3 py-2 rounded-lg"
          data-testid="approve-edit-request-cancel"
        >
          إلغاء
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={mut.isPending}
          className="text-[12px] font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 rounded-lg"
          data-testid="approve-edit-request-confirm"
        >
          {mut.isPending ? 'جارٍ الإرسال…' : 'تأكيد الاعتماد'}
        </button>
      </div>
    </ModalShell>
  );
}

// ── Reject modal ──────────────────────────────────────────────────

export function RejectEditRequestModal({
  entity,
  parentId,
  request,
  onClose,
  onSuccess,
}: ReviewModalProps) {
  const qc = useQueryClient();
  const [reviewNotes, setReviewNotes] = useState('');

  const reasonError = useMemo(() => {
    if (reviewNotes.trim().length === 0) return null; // don't pre-error
    return reviewNotes.trim().length < 5
      ? 'سبب الرفض مطلوب ولا يقل عن 5 أحرف'
      : null;
  }, [reviewNotes]);

  const canSubmit = reviewNotes.trim().length >= 5;

  const mut = useMutation({
    mutationFn: (body: ReviewEditRequestBody) =>
      entity === 'return'
        ? returnsApi.rejectReturnEditRequest(parentId, request.id, body)
        : returnsApi.rejectExchangeEditRequest(parentId, request.id, body),
    onSuccess: () => {
      toast.success('تم رفض طلب التعديل');
      qc.invalidateQueries({ queryKey: ['audit', entity, parentId] });
      onSuccess?.();
      onClose();
    },
    onError: (e: any) => {
      const fallback = 'تعذّر رفض طلب التعديل';
      const candidates = [e?.response?.data?.message, e?.message];
      const picked = candidates.find(
        (c) => typeof c === 'string' && c.trim().length > 0,
      );
      toast.error(picked ?? fallback);
    },
  });

  function handleConfirm() {
    if (!canSubmit || mut.isPending) return;
    mut.mutate({ review_notes: reviewNotes.trim() });
  }

  return (
    <ModalShell
      title="رفض طلب التعديل"
      subtitle={request.document_no ?? undefined}
      onClose={onClose}
      testId="reject-edit-request-modal"
    >
      <RequestSummary request={request} />

      <div>
        <label className="text-[11px] font-bold text-slate-700 block mb-1">
          سبب الرفض
        </label>
        <textarea
          value={reviewNotes}
          onChange={(e) => setReviewNotes(e.target.value)}
          rows={3}
          className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:bg-white focus:border-brand-300 w-full"
          data-testid="reject-edit-request-notes"
        />
        {reasonError && (
          <div
            className="text-[11px] text-rose-700 mt-1"
            data-testid="reject-edit-request-notes-error"
          >
            {reasonError}
          </div>
        )}
      </div>

      <div className="flex items-start gap-1.5 text-[11px] text-slate-500">
        <Info size={12} className="mt-0.5 shrink-0" />
        <span>
          هذا الإجراء يحدّث حالة الطلب إلى مرفوض ولا يقوم بأي عملية محاسبية
          أو مخزنية.
        </span>
      </div>

      <div className="flex gap-2 justify-end pt-2 border-t border-slate-100">
        <button
          type="button"
          onClick={onClose}
          className="text-[12px] font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 px-3 py-2 rounded-lg"
          data-testid="reject-edit-request-cancel"
        >
          إلغاء
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!canSubmit || mut.isPending}
          className="text-[12px] font-bold text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 rounded-lg"
          data-testid="reject-edit-request-confirm"
        >
          {mut.isPending ? 'جارٍ الإرسال…' : 'تأكيد الرفض'}
        </button>
      </div>
    </ModalShell>
  );
}
