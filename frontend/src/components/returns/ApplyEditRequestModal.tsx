/**
 * ApplyEditRequestModal — admin action that EXECUTES an
 * already-approved edit request.
 *
 * Phase 2A: returns.   Calls `returnsApi.applyReturnEditRequest`.
 * Phase 2B: exchanges. Calls `returnsApi.applyExchangeEditRequest`.
 *
 * Strict scope (mirrors the BE service contract):
 *   · Calls ONLY the matching `apply*EditRequest` POST.
 *   · NEVER calls approve / reject / amendment / reverse / replay
 *     endpoints from the FE.
 *   · No PATCH / PUT / DELETE.
 *   · No direct cache mutation — only `qc.invalidateQueries(...)`.
 *
 * Phase 2B exchange scope:
 *   · The BE rejects edits to `kind='new'` exchange lines with the
 *     literal Phase 2C marker copy.  The modal does not pre-validate
 *     this — it relays the BE error message to the toast.
 *
 * Confirmation phrase guard:
 *   The confirm button stays disabled until the admin types the
 *   exact Arabic phrase `"تطبيق التعديل"` into the verification
 *   input.  This is in addition to the role gate (admin only) on
 *   the BE side.  The phrase is not a secret — it's a typo guard
 *   that forces the admin to acknowledge the financial side effect
 *   before the request fires.
 */
import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertTriangle, Info, XCircle } from 'lucide-react';
import {
  returnsApi,
  type ApplyEditRequestBody,
  type AuditEditRequestRow,
  type LineChangesPayload,
} from '@/api/returns.api';
import { isLineChangesPayload, LineChangesDiff } from './edit-request/diff';

const CONFIRM_PHRASE = 'تطبيق التعديل';

const ACTION_LABELS_AR: Record<string, string> = {
  update_header: 'تحديث بيانات عامة',
  update_item: 'تعديل بند',
  remove_item: 'حذف بند',
  replace_item: 'استبدال منتج',
  price_change: 'تعديل سعر',
  quantity_change: 'تعديل كمية',
  reason_change: 'تعديل السبب',
};

export interface ApplyEditRequestModalProps {
  entity: 'return' | 'exchange';
  parentId: string;
  request: AuditEditRequestRow;
  onClose: () => void;
  onSuccess?: () => void;
}

export function ApplyEditRequestModal({
  entity,
  parentId,
  request,
  onClose,
  onSuccess,
}: ApplyEditRequestModalProps) {
  const qc = useQueryClient();
  const [notes, setNotes] = useState('');
  const [phrase, setPhrase] = useState('');
  const phraseOk = phrase.trim() === CONFIRM_PHRASE;

  const structured: LineChangesPayload | null = isLineChangesPayload(
    request.requested_payload,
  )
    ? request.requested_payload
    : null;
  const actionLabel =
    ACTION_LABELS_AR[request.requested_action] ?? request.requested_action;

  const mut = useMutation({
    mutationFn: (body: ApplyEditRequestBody) =>
      entity === 'exchange'
        ? returnsApi.applyExchangeEditRequest(parentId, request.id, body)
        : returnsApi.applyReturnEditRequest(parentId, request.id, body),
    onSuccess: () => {
      toast.success('تم تطبيق طلب التعديل بنجاح');
      // Refetch the audit panel so the entry flips to "applied" with
      // the artifact ids visible.  Audit query key is keyed off the
      // entity so return + exchange views invalidate independently.
      qc.invalidateQueries({ queryKey: ['audit', entity, parentId] });
      // The parent record's totals + items have changed too, so the
      // details panel + list need a refetch.  Same query keys the
      // existing Approve / Refund flows use after a status flip.
      qc.invalidateQueries({ queryKey: [entity, parentId] });
      qc.invalidateQueries({ queryKey: [entity === 'exchange' ? 'exchanges' : 'returns'] });
      onSuccess?.();
      onClose();
    },
    onError: (e: any) => {
      const fallback = 'تعذّر تطبيق طلب التعديل';
      const candidates = [e?.response?.data?.message, e?.message];
      const picked = candidates.find(
        (c) => typeof c === 'string' && c.trim().length > 0,
      );
      toast.error(picked ?? fallback);
    },
  });

  const canConfirm = phraseOk && !mut.isPending;

  function handleConfirm() {
    if (!canConfirm) return;
    const body: ApplyEditRequestBody = {};
    const trimmed = notes.trim();
    if (trimmed.length > 0) body.notes = trimmed;
    mut.mutate(body);
  }

  const isExchange = entity === 'exchange';
  const warningCopy = isExchange
    ? 'سيتم تعديل عملية الاستبدال فعليًا وإعادة احتساب فرق السعر النقدي والأثر المخزني. لا يمكن تنفيذ هذه الخطوة مرتين.'
    : 'سيتم تعديل المرتجع فعليًا وتسجيل الأثر المخزني والمحاسبي. لا يمكن تنفيذ هذه الخطوة مرتين.';
  const infoCopy = isExchange
    ? 'سيتم عكس الحركة النقدية القديمة (إن وُجدت) وإعادة قيدها بالقيم الجديدة، وكذلك تعديل أثر المخزون عند الحاجة. هذه العملية تتم في معاملة واحدة. لا يدعم هذا الإصدار تعديل البنود الجديدة في الاستبدال.'
    : 'سيتم عكس القيد المالي القديم وإعادة قيده بالقيم الجديدة، وكذلك تعديل أثر المخزون عند الحاجة. هذه العملية تتم في معاملة واحدة.';

  return (
    <ModalShell
      title="تطبيق طلب التعديل"
      subtitle={request.document_no ?? undefined}
      onClose={onClose}
      testId="apply-edit-request-modal"
    >
      {/* Strong-warning banner */}
      <div
        className="rounded-lg border-2 border-rose-300 bg-rose-50 px-3 py-2.5 text-[12px] flex items-start gap-2"
        data-testid="apply-edit-request-warning"
      >
        <AlertTriangle
          size={16}
          className="text-rose-700 mt-0.5 shrink-0"
        />
        <div className="text-rose-900 leading-relaxed font-bold">
          {warningCopy}
        </div>
      </div>

      {/* Request summary */}
      <div className="space-y-2" data-testid="apply-edit-request-summary">
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

      {/* Optional notes */}
      <div>
        <label className="text-[11px] font-bold text-slate-700 block mb-1">
          ملاحظات التطبيق (اختياري)
        </label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:bg-white focus:border-brand-300 w-full"
          data-testid="apply-edit-request-notes"
        />
      </div>

      {/* Confirmation phrase guard */}
      <div>
        <label className="text-[11px] font-bold text-rose-800 block mb-1">
          اكتب الجملة التالية للتأكيد:{' '}
          <span className="font-mono bg-rose-100 px-2 py-0.5 rounded">
            تطبيق التعديل
          </span>
        </label>
        <input
          type="text"
          value={phrase}
          onChange={(e) => setPhrase(e.target.value)}
          className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:bg-white focus:border-rose-300 w-full"
          data-testid="apply-edit-request-confirm-phrase"
          autoComplete="off"
        />
      </div>

      <div className="flex items-start gap-1.5 text-[11px] text-slate-500">
        <Info size={12} className="mt-0.5 shrink-0" />
        <span>{infoCopy}</span>
      </div>

      <div className="flex gap-2 justify-end pt-2 border-t border-slate-100">
        <button
          type="button"
          onClick={onClose}
          className="text-[12px] font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 px-3 py-2 rounded-lg"
          data-testid="apply-edit-request-cancel"
        >
          إلغاء
        </button>
        <button
          type="button"
          onClick={handleConfirm}
          disabled={!canConfirm}
          className="text-[12px] font-bold text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 rounded-lg"
          data-testid="apply-edit-request-confirm"
        >
          {mut.isPending ? 'جارٍ التطبيق…' : 'تأكيد تطبيق التعديل'}
        </button>
      </div>
    </ModalShell>
  );
}

// ── Shared modal shell ────────────────────────────────────────────

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
