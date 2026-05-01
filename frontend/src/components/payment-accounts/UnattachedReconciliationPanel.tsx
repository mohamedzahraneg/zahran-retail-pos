/**
 * UnattachedReconciliationPanel — PR-FIN-PAYACCT-4D-UX-FIX-9
 * ────────────────────────────────────────────────────────────────────
 *
 * Operator-facing surface for historical payments where
 * `payment_account_id IS NULL`. Surfaces one row per
 * (source_table, payment_method) bucket from the
 * `/payment-accounts/unattached-summary` endpoint, with a guarded
 * "ربط ..." action button when the backend reports the bucket is
 * `supported` (today: instapay invoice_payments only).
 *
 * Design contract:
 *   • READ-ONLY by default — the dry-run summary is fetched on mount.
 *   • Cash buckets render with the explanatory message and NO action
 *     (cash flows via cashbox; no PA tagging needed by design).
 *   • Backfill action requires explicit `window.confirm` with the
 *     dry-run counts BEFORE the request fires with `dryRun: false`.
 *   • Success invalidates `payment-accounts-balances` so the synthetic
 *     unattached row on /cashboxes disappears on next refresh.
 *   • Component is silent (returns null) when there are no unattached
 *     rows at all — keeps the page clean once the backfill is done.
 */
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { AlertTriangle, Link as LinkIcon, Wallet } from 'lucide-react';
import {
  paymentsApi,
  METHOD_LABEL_AR,
  type PaymentMethodCode,
  type UnattachedSummaryRow,
} from '@/api/payments.api';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;

export interface UnattachedReconciliationPanelProps {
  /**
   * When false the action buttons are hidden (read-only display for
   * operators without `payment-accounts.manage`). The panel still
   * renders so all operators see the cash explanation + counts.
   */
  canManage: boolean;
}

export function UnattachedReconciliationPanel({
  canManage,
}: UnattachedReconciliationPanelProps) {
  const qc = useQueryClient();
  const [busyMethod, setBusyMethod] = useState<PaymentMethodCode | null>(null);

  const summaryQuery = useQuery({
    queryKey: ['unattached-summary'],
    queryFn: () => paymentsApi.unattachedSummary(),
    staleTime: 30_000,
  });

  const backfillMutation = useMutation({
    mutationFn: (method: PaymentMethodCode) =>
      paymentsApi.backfillUnattached({ method, dryRun: false }),
    onSuccess: (res) => {
      // PR-FIN-PAYACCT-4D-UX-FIX-11 — never claim success when nothing
      // actually moved. Earlier code raised a green toast even when the
      // backend returned `dryRun=true` or `updatedCount=0`, which masked
      // the real bug (BE rolled back the tx after a column-name error
      // in the audit INSERT). Distinguish three response shapes:
      //
      //   1. dryRun=true                 → BE didn't write. Surface as
      //                                     warning so operator knows
      //                                     to click again with intent.
      //   2. dryRun=false, updatedCount=0 → no rows matched. Surface as
      //                                      warning — already linked, or
      //                                      a silent BE rollback.
      //   3. dryRun=false, updatedCount>0 → real success.
      if (res.dryRun) {
        toast(
          `العملية رجعت كمحاكاة (dryRun) — لم يتم تعديل أي بيانات. ` +
            `أعد المحاولة وتأكد من ظهور رسالة نجاح حقيقية.`,
          { icon: '⚠️', duration: 6000 },
        );
        return;
      }
      if (res.updatedCount === 0) {
        toast(
          `لم يتم ربط أي عملية — قد تكون مرتبطة بالفعل أو تم التراجع عن العملية في الخادم. ` +
            `راجع القائمة بعد التحديث.`,
          { icon: '⚠️', duration: 6000 },
        );
      } else {
        toast.success(
          `تم ربط ${res.updatedCount} عملية بحساب "${res.targetAccount.display_name}"`,
        );
      }
      qc.invalidateQueries({ queryKey: ['unattached-summary'] });
      qc.invalidateQueries({ queryKey: ['payment-accounts-balances'] });
    },
    onError: (e: any) => {
      const msg =
        e?.response?.data?.message ||
        e?.message ||
        'فشل ربط العمليات التاريخية';
      toast.error(typeof msg === 'string' ? msg : 'فشل ربط العمليات التاريخية');
    },
    onSettled: () => setBusyMethod(null),
  });

  const rows = summaryQuery.data ?? [];
  if (summaryQuery.isLoading) {
    return (
      <div
        className="rounded-2xl border border-slate-200 bg-white p-4"
        data-testid="unattached-panel-loading"
      >
        <div className="text-sm text-slate-500">جارِ التحميل...</div>
      </div>
    );
  }
  if (!rows.length) return null;

  const handleBackfill = (row: UnattachedSummaryRow) => {
    if (!row.target_account) return;
    const confirmMsg =
      `سيتم ربط ${row.row_count} عملية ${METHOD_LABEL_AR[row.payment_method] ?? row.payment_method} ` +
      `(إجمالي ${EGP(row.total_amount)}) ` +
      `بالحساب الافتراضي "${row.target_account.display_name}".\n\n` +
      `لن يتم تعديل القيود المحاسبية أو حركات الخزنة. ` +
      `هل أنت متأكد؟`;
    if (!window.confirm(confirmMsg)) return;
    setBusyMethod(row.payment_method);
    backfillMutation.mutate(row.payment_method);
  };

  return (
    <div
      className="rounded-2xl border border-amber-200 bg-amber-50/40 p-4 space-y-3"
      data-testid="unattached-panel"
    >
      <div className="flex items-center gap-2">
        <AlertTriangle size={16} className="text-amber-700" />
        <h3 className="font-bold text-sm text-amber-900">
          عمليات قديمة غير مرتبطة بحساب دفع
        </h3>
      </div>
      <div className="space-y-2" data-testid="unattached-panel-rows">
        {rows.map((row) => {
          const key = `${row.source_table}:${row.payment_method}`;
          const methodLabel =
            METHOD_LABEL_AR[row.payment_method] ?? row.payment_method;
          const isBusy = busyMethod === row.payment_method;
          return (
            <div
              key={key}
              data-testid={`unattached-row-${row.source_table}-${row.payment_method}`}
              className="rounded-lg border border-slate-200 bg-white p-3 flex items-center gap-3 flex-wrap"
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <Wallet size={14} className="text-slate-500 shrink-0" />
                <div className="min-w-0">
                  <div className="text-sm font-bold text-slate-800">
                    {methodLabel}
                    <span className="text-[10px] text-slate-500 font-normal mr-1">
                      ({row.source_table})
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-600 truncate">
                    {row.row_count} عملية · إجمالي {EGP(row.total_amount)}
                    {row.earliest && row.latest && (
                      <span className="text-slate-400">
                        {' '}· من {row.earliest} إلى {row.latest}
                      </span>
                    )}
                  </div>
                  <div
                    className="text-[11px] text-amber-800 mt-0.5"
                    data-testid={`unattached-status-${row.source_table}-${row.payment_method}`}
                  >
                    {row.status_message}
                  </div>
                </div>
              </div>
              {row.supported && row.target_account && canManage && (
                <button
                  type="button"
                  disabled={isBusy}
                  onClick={() => handleBackfill(row)}
                  className="text-[11px] px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold inline-flex items-center gap-1 disabled:opacity-50"
                  data-testid={`unattached-action-${row.payment_method}`}
                >
                  <LinkIcon size={12} />
                  {isBusy
                    ? 'جارِ الربط...'
                    : row.payment_method === 'instapay'
                      ? 'ربط عمليات InstaPay التاريخية'
                      : `ربط بـ ${row.target_account.display_name}`}
                </button>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
