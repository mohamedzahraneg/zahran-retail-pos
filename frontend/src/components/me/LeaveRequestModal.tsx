/**
 * LeaveRequestModal — PR-ESS-2A
 * ────────────────────────────────────────────────────────────────────
 *
 * Self-service leave-request modal opened from the /me header.
 * Submits via the existing `POST /employees/me/requests` endpoint with
 * `kind='leave'` (no money movement, no GL/cashbox writes).
 *
 * Leave-balance accrual is intentionally NOT implemented — the parent
 * profile shows "رصيد الإجازات: غير مفعل حاليًا" until a leave-balance
 * engine ships in a follow-up PR. This modal is request-submission
 * only; the manager-side approval flow (POST /employees/requests/:id/
 * decide) flips status without any side effects.
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { CalendarRange, X } from 'lucide-react';
import { employeesApi } from '@/api/employees.api';

export function LeaveRequestModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [startsAt, setStartsAt] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('');

  const mut = useMutation({
    mutationFn: () =>
      employeesApi.submitRequest({
        kind: 'leave',
        starts_at: startsAt || undefined,
        ends_at: endsAt || undefined,
        reason: reason.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success('تم إرسال طلب الإجازة. ستتم مراجعته من قِبَل الإدارة.');
      qc.invalidateQueries({ queryKey: ['my-requests'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل إرسال الطلب'),
  });

  const ready = !!startsAt && !!endsAt && !mut.isPending;
  const dateOrderInvalid =
    startsAt && endsAt && new Date(endsAt) < new Date(startsAt);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md bg-white rounded-2xl shadow-2xl my-6"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <CalendarRange size={18} className="text-emerald-700" />
            <h3 className="text-lg font-black text-slate-800">
              تقديم طلب إجازة
            </h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
            title="إغلاق"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 text-[12px] text-emerald-900 leading-relaxed">
            هذا طلب فقط — لا يتم تسجيل أي حركة مالية. يتم اعتماده أو
            رفضه من قِبَل الإدارة.
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="من تاريخ">
              <input
                type="date"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
                className="input w-full"
                disabled={mut.isPending}
              />
            </Field>
            <Field label="إلى تاريخ">
              <input
                type="date"
                value={endsAt}
                onChange={(e) => setEndsAt(e.target.value)}
                className="input w-full"
                disabled={mut.isPending}
              />
            </Field>
          </div>

          {dateOrderInvalid && (
            <div className="text-[11px] text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-3 py-2">
              تاريخ النهاية لا يمكن أن يكون قبل تاريخ البداية.
            </div>
          )}

          <Field label="السبب (اختياري)">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={3}
              className="input w-full"
              disabled={mut.isPending}
              placeholder="مثلاً: إجازة عائلية"
            />
          </Field>

          <div className="flex items-center justify-between gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50"
            >
              إلغاء
            </button>
            <button
              type="button"
              onClick={() => mut.mutate()}
              disabled={!ready || !!dateOrderInvalid}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-emerald-600 text-white text-sm font-bold hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <CalendarRange size={15} />
              {mut.isPending ? 'جارٍ الإرسال…' : 'إرسال الطلب'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-[11px] font-bold text-slate-600 mb-1">{label}</div>
      {children}
    </label>
  );
}
