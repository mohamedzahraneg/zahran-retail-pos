/**
 * TypedConfirmDialog — destructive-action confirmation primitive.
 *
 * A modal whose primary button stays disabled until the user types
 * `confirmWord` verbatim into the inline input.  Optional `reason`
 * mode adds a textarea that must reach `minReasonLen` characters
 * after trim — used for the reverse-period flow where the backend
 * requires a non-empty reason.
 *
 * PR-FE-B.1 hard scope reminder:
 *   * This component is plumbing.  No mounted page imports it in
 *     FE-B.1.  Wiring lands in FE-B.2 (delete-draft, clear-lines)
 *     and FE-B.4 (reverse-approved).
 *   * The component knows nothing about expense allocations — it's
 *     a generic confirm dialog that takes the word and the reason
 *     copy from props.  Live under `components/common/` so future
 *     destructive flows can re-use it without dragging in the
 *     allocations module.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, X } from 'lucide-react';

type BaseProps = {
  open: boolean;
  title: string;
  body: React.ReactNode;
  /** The exact word the user must type, trimmed.  Examples: حذف / مسح / عكس. */
  confirmWord: string;
  /** Label for the primary destructive button. */
  confirmLabel: string;
  onClose: () => void;
  /** When true, the dialog disables interactive elements and shows
   *  a "جاري التنفيذ…" label on the primary button.  Caller toggles
   *  this from the surrounding useMutation state in FE-B.2+. */
  isSubmitting?: boolean;
  /** Visual treatment.  `danger` = rose, anything else = amber. */
  danger?: boolean;
};

type NoReasonProps = BaseProps & {
  requireReason?: false;
  onConfirm: () => void | Promise<void>;
};

type ReasonProps = BaseProps & {
  requireReason: true;
  /** Label above the reason textarea.  Defaults to "السبب". */
  reasonLabel?: string;
  /** Placeholder inside the textarea. */
  reasonPlaceholder?: string;
  /** Min char count after trim.  Default 3; backend min is 1. */
  minReasonLen?: number;
  onConfirm: (args: { reason: string }) => void | Promise<void>;
};

export type TypedConfirmDialogProps = NoReasonProps | ReasonProps;

export function TypedConfirmDialog(props: TypedConfirmDialogProps) {
  const {
    open,
    title,
    body,
    confirmWord,
    confirmLabel,
    onClose,
    isSubmitting,
    danger = true,
  } = props;

  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');

  // Reset the controlled inputs whenever the dialog re-opens so a
  // previous cancel doesn't leak typed state into the next attempt.
  useEffect(() => {
    if (open) {
      setTyped('');
      setReason('');
    }
  }, [open]);

  if (!open) return null;

  const requireReason =
    'requireReason' in props && props.requireReason === true;
  const minReasonLen = requireReason
    ? (props as ReasonProps).minReasonLen ?? 3
    : 0;

  const wordMatches = typed.trim() === confirmWord;
  const reasonOk = !requireReason || reason.trim().length >= minReasonLen;
  const canSubmit = wordMatches && reasonOk && !isSubmitting;

  const handleSubmit = async () => {
    if (!canSubmit) return;
    if (requireReason) {
      await (props as ReasonProps).onConfirm({ reason: reason.trim() });
    } else {
      await (props as NoReasonProps).onConfirm();
    }
  };

  const headerBg = danger
    ? 'border-rose-100 bg-rose-50'
    : 'border-amber-100 bg-amber-50';
  const iconBg = danger
    ? 'bg-rose-100 text-rose-700'
    : 'bg-amber-100 text-amber-700';
  const submitBg = danger
    ? 'bg-rose-600 hover:bg-rose-700'
    : 'bg-amber-600 hover:bg-amber-700';

  return (
    <div
      dir="rtl"
      className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 p-4"
      onClick={isSubmitting ? undefined : onClose}
      role="dialog"
      aria-modal="true"
      aria-label={title}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-2xl bg-white shadow-xl"
      >
        <div
          className={`flex items-start gap-3 border-b px-5 py-4 ${headerBg}`}
        >
          <div className={`mt-0.5 rounded-full p-2 ${iconBg}`}>
            <AlertTriangle className="h-4 w-4" />
          </div>
          <h3 className="flex-1 text-base font-semibold text-slate-900">
            {title}
          </h3>
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            aria-label="إغلاق"
            className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-50"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 px-5 py-4 text-sm text-slate-700">
          <div>{body}</div>

          {requireReason && (
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-slate-700">
                {(props as ReasonProps).reasonLabel ?? 'السبب'}
              </span>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={(props as ReasonProps).reasonPlaceholder ?? ''}
                rows={3}
                maxLength={500}
                disabled={isSubmitting}
                className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none disabled:bg-slate-50"
              />
              {reason.length > 0 &&
                reason.trim().length < minReasonLen && (
                  <span className="mt-1 block text-xs text-rose-600">
                    السبب يجب أن يكون {minReasonLen} حرفًا على الأقل.
                  </span>
                )}
            </label>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-medium text-slate-700">
              للتأكيد، اكتب «
              <span className="font-semibold text-slate-900">
                {confirmWord}
              </span>
              »:
            </span>
            <input
              type="text"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              disabled={isSubmitting}
              className="w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:border-slate-400 focus:outline-none disabled:bg-slate-50"
              dir="rtl"
            />
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-100 px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-md border border-slate-200 px-3 py-1.5 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50"
          >
            إلغاء
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className={`rounded-md px-3 py-1.5 text-sm font-medium text-white disabled:cursor-not-allowed disabled:opacity-50 ${submitBg}`}
          >
            {isSubmitting ? 'جاري التنفيذ…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
