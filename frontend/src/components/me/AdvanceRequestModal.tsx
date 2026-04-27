/**
 * AdvanceRequestModal — PR-ESS-2A
 * ────────────────────────────────────────────────────────────────────
 *
 * Self-service salary-advance REQUEST submission. Submits via
 * `POST /employees/me/requests/advance` (PR-ESS-2A dedicated endpoint).
 *
 * IMPORTANT — REQUEST-ONLY:
 *   · No money moves on submission OR on approval.
 *   · No GL entries, no cashbox transactions, no expense rows.
 *   · No FinancialEngineService call from request approval.
 *   · Approval is a status flip in `employee_requests` only.
 *
 * The actual disbursement remains the operator's separate Daily
 * Expenses step (`POST /accounting/expenses/daily` with
 * `is_advance=true`). PR-ESS-2B will add `source_employee_request_id`
 * so an approved request can be marked "disbursed" only after the
 * canonical FinancialEngine.recordExpense path completes. Until then
 * an approved advance is labelled "موافق عليه — بانتظار الصرف".
 */

import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Coins, X, ShieldAlert } from 'lucide-react';
import { employeesApi } from '@/api/employees.api';

export function AdvanceRequestModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');

  const mut = useMutation({
    mutationFn: () =>
      employeesApi.submitAdvanceRequest({
        amount: Number(amount),
        reason: reason.trim(),
        notes: notes.trim() || undefined,
      }),
    onSuccess: () => {
      toast.success(
        'تم إرسال طلب السلفة. ستتم مراجعته من قِبَل الإدارة. (لم يُصرف أي مبلغ بعد)',
      );
      qc.invalidateQueries({ queryKey: ['my-requests'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل إرسال الطلب'),
  });

  const amtNum = Number(amount || 0);
  const ready = amtNum > 0 && !!reason.trim() && !mut.isPending;

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
            <Coins size={18} className="text-violet-700" />
            <h3 className="text-lg font-black text-slate-800">
              تقديم طلب سلفة
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
          <div className="rounded-xl border border-violet-200 bg-violet-50 p-3 text-[12px] text-violet-900 leading-relaxed flex items-start gap-2">
            <ShieldAlert size={14} className="text-violet-700 shrink-0 mt-0.5" />
            <div>
              هذا{' '}
              <span className="font-bold">طلب سلفة فقط</span> — لا يتم
              تحريك أي أموال عند الإرسال أو حتى عند الموافقة. الصرف
              الفعلي يتم لاحقًا من قِبَل المحاسبة عبر صفحة المصروفات
              اليومية.
            </div>
          </div>

          <Field label="المبلغ المطلوب">
            <input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              className="input w-full"
              disabled={mut.isPending}
              placeholder="0.00"
            />
          </Field>

          <Field label="سبب طلب السلفة (مطلوب)">
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              rows={2}
              className="input w-full"
              disabled={mut.isPending}
              placeholder="مثلاً: ظرف طارئ في العائلة"
            />
          </Field>

          <Field label="ملاحظات إضافية (اختياري)">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              className="input w-full"
              disabled={mut.isPending}
              placeholder="مثلاً: يفضّل الصرف خلال يومين"
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
              disabled={!ready}
              className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-violet-600 text-white text-sm font-bold hover:bg-violet-700 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Coins size={15} />
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
