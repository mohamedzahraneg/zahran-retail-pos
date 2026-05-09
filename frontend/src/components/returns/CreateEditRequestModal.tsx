/**
 * CreateEditRequestModal — Phase 1 UI: create an edit request only.
 *
 * Strict scope:
 *   · Calls ONLY `returnsApi.createReturnEditRequest` /
 *     `createExchangeEditRequest` (POST).  No PATCH/PUT/DELETE.
 *   · Does NOT call approve / reject / amendment / apply endpoints.
 *   · Does NOT touch returns / return_items / exchanges /
 *     exchange_items / journal_entries / journal_lines /
 *     cashbox_transactions / stock_movements.
 *   · A successful submit invalidates `['audit', entity, id]` so the
 *     existing audit panel refetches and shows the new request inline.
 *
 * Validation (client-side, mirrors the BE DTO):
 *   · `requested_action` is one of 7 allowlisted values.
 *   · `requested_payload` must parse as a JSON OBJECT (not array, not
 *     scalar, not null).
 *   · `reason_text` ≥ 5 characters.
 *
 * The modal renders via `createPortal(document.body)` so it sits above
 * the parent details modal even when an ancestor establishes a
 * containing block (backdrop-blur etc.) — same pattern as the
 * existing ApproveModal / RefundModal in `Returns.tsx`.
 */
import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertTriangle, Info, XCircle } from 'lucide-react';
import {
  returnsApi,
  type CreateEditRequestBody,
  type RequestedAction,
} from '@/api/returns.api';

interface ActionOption {
  value: RequestedAction;
  label: string;
}

const ACTION_OPTIONS: ActionOption[] = [
  { value: 'update_header', label: 'تحديث بيانات عامة' },
  { value: 'update_item', label: 'تعديل بند' },
  { value: 'remove_item', label: 'حذف بند' },
  { value: 'replace_item', label: 'استبدال منتج' },
  { value: 'price_change', label: 'تعديل سعر' },
  { value: 'quantity_change', label: 'تعديل كمية' },
  { value: 'reason_change', label: 'تعديل السبب' },
];

const PAYLOAD_PLACEHOLDER = `اكتب التعديل المطلوب بصيغة واضحة، مثال:
{"field":"unit_price","item_id":"...","new_value":150}`;

export interface CreateEditRequestModalProps {
  entity: 'return' | 'exchange';
  parentId: string;
  documentNo?: string | null;
  onClose: () => void;
  onSuccess?: () => void;
}

export function CreateEditRequestModal({
  entity,
  parentId,
  documentNo,
  onClose,
  onSuccess,
}: CreateEditRequestModalProps) {
  const qc = useQueryClient();
  const [action, setAction] = useState<RequestedAction>('update_item');
  const [payloadText, setPayloadText] = useState('');
  const [reason, setReason] = useState('');

  const reasonError = useMemo(() => {
    if (reason.trim().length === 0) return null; // don't pre-error before typing
    return reason.trim().length < 5
      ? 'سبب طلب التعديل مطلوب ولا يقل عن 5 أحرف'
      : null;
  }, [reason]);

  const payloadParsed = useMemo<{
    ok: true;
    value: Record<string, unknown>;
  } | { ok: false; error: string } | null>(() => {
    if (payloadText.trim().length === 0) return null;
    try {
      const parsed = JSON.parse(payloadText);
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        return { ok: false, error: 'صيغة تفاصيل التعديل غير صحيحة' };
      }
      return { ok: true, value: parsed as Record<string, unknown> };
    } catch {
      return { ok: false, error: 'صيغة تفاصيل التعديل غير صحيحة' };
    }
  }, [payloadText]);

  const canSubmit =
    reason.trim().length >= 5 &&
    payloadParsed !== null &&
    payloadParsed.ok === true;

  const mut = useMutation({
    mutationFn: (body: CreateEditRequestBody) =>
      entity === 'return'
        ? returnsApi.createReturnEditRequest(parentId, body)
        : returnsApi.createExchangeEditRequest(parentId, body),
    onSuccess: () => {
      toast.success('تم إرسال طلب التعديل وينتظر موافقة الأدمن');
      qc.invalidateQueries({ queryKey: ['audit', entity, parentId] });
      onSuccess?.();
      onClose();
    },
    onError: (e: any) => {
      const fallback = 'تعذّر إرسال طلب التعديل';
      const candidates = [e?.response?.data?.message, e?.message];
      const picked = candidates.find(
        (c) => typeof c === 'string' && c.trim().length > 0,
      );
      toast.error(picked ?? fallback);
    },
  });

  const handleSubmit = () => {
    if (!canSubmit || mut.isPending) return;
    if (payloadParsed?.ok !== true) return; // narrow type
    mut.mutate({
      requested_action: action,
      requested_payload: payloadParsed.value,
      reason_text: reason.trim(),
    });
  };

  const headerSubtitle = documentNo
    ? `${entity === 'return' ? 'مرتجع' : 'استبدال'} ${documentNo}`
    : entity === 'return'
      ? 'مرتجع'
      : 'استبدال';

  return createPortal(
    <div
      className="fixed inset-0 bg-slate-900/50 backdrop-blur-sm z-[60] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-label="إنشاء طلب تعديل"
      onClick={onClose}
      data-testid="create-edit-request-modal"
      dir="rtl"
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-slate-100 px-6 py-4 flex items-center justify-between">
          <div>
            <h3 className="text-lg font-black text-slate-900">
              إنشاء طلب تعديل
            </h3>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {headerSubtitle}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-700"
            aria-label="إغلاق"
          >
            <XCircle size={22} />
          </button>
        </div>

        <div className="p-6 space-y-4">
          {/* Warning banner — non-functional informational copy */}
          <div
            className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] flex items-start gap-2"
            data-testid="create-edit-request-warning"
          >
            <AlertTriangle
              size={14}
              className="text-amber-600 mt-0.5 shrink-0"
            />
            <div className="text-amber-900 leading-relaxed">
              هذا الطلب لا يغيّر المرتجع أو الاستبدال الآن. سيتم إرساله
              للمراجعة وينتظر موافقة الأدمن.
            </div>
          </div>

          {/* requested_action select */}
          <div>
            <label className="text-[11px] font-bold text-slate-700 block mb-1">
              نوع التعديل المطلوب
            </label>
            <select
              value={action}
              onChange={(e) =>
                setAction(e.target.value as RequestedAction)
              }
              className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:bg-white focus:border-brand-300 w-full"
              data-testid="create-edit-request-action"
            >
              {ACTION_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

          {/* requested_payload JSON textarea */}
          <div>
            <label className="text-[11px] font-bold text-slate-700 block mb-1">
              تفاصيل التعديل المطلوب
            </label>
            <textarea
              value={payloadText}
              onChange={(e) => setPayloadText(e.target.value)}
              placeholder={PAYLOAD_PLACEHOLDER}
              rows={5}
              className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-[12px] text-slate-700 font-mono outline-none focus:bg-white focus:border-brand-300 w-full"
              data-testid="create-edit-request-payload"
              dir="ltr"
            />
            {payloadParsed && payloadParsed.ok === false && (
              <div
                className="text-[11px] text-rose-700 mt-1"
                data-testid="create-edit-request-payload-error"
              >
                {payloadParsed.error}
              </div>
            )}
          </div>

          {/* reason_text textarea */}
          <div>
            <label className="text-[11px] font-bold text-slate-700 block mb-1">
              سبب طلب التعديل
            </label>
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-700 outline-none focus:bg-white focus:border-brand-300 w-full"
              data-testid="create-edit-request-reason"
            />
            {reasonError && (
              <div
                className="text-[11px] text-rose-700 mt-1"
                data-testid="create-edit-request-reason-error"
              >
                {reasonError}
              </div>
            )}
          </div>

          {/* Footer reminder */}
          <div className="flex items-start gap-1.5 text-[11px] text-slate-500">
            <Info size={12} className="mt-0.5 shrink-0" />
            <span>لا يتم تطبيق أي تعديل قبل موافقة الأدمن.</span>
          </div>

          {/* Buttons */}
          <div className="flex gap-2 justify-end pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={onClose}
              className="text-[12px] font-bold text-slate-700 bg-slate-100 hover:bg-slate-200 px-3 py-2 rounded-lg"
              data-testid="create-edit-request-cancel"
            >
              إلغاء
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={!canSubmit || mut.isPending}
              className="text-[12px] font-bold text-white bg-brand-600 hover:bg-brand-700 disabled:opacity-50 disabled:cursor-not-allowed px-3 py-2 rounded-lg"
              data-testid="create-edit-request-submit"
            >
              {mut.isPending ? 'جارٍ الإرسال…' : 'إرسال طلب التعديل'}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
