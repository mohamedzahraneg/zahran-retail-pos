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
import { AlertTriangle, Info, Link as LinkIcon, Wallet } from 'lucide-react';
import {
  paymentsApi,
  METHOD_LABEL_AR,
  type PaymentMethodCode,
  type UnattachedSummaryRow,
} from '@/api/payments.api';
import { formatArabicDateRange } from '@/lib/format-arabic-date';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;

/**
 * PR-FIN-PAYACCT-4D-UX-FIX-14 — operator-facing Arabic labels for the
 * source-table column. The raw `invoice_payments` / `customer_payments`
 * / `supplier_payments` codes leak schema details into the UI; show the
 * business meaning instead.
 */
const SOURCE_TABLE_LABEL_AR: Record<UnattachedSummaryRow['source_table'], string> = {
  invoice_payments:  'فواتير البيع',
  customer_payments: 'قبض العملاء',
  supplier_payments: 'مدفوعات الموردين',
};

/**
 * PR-FIN-PAYACCT-4D-UX-FIX-14 — canonical Arabic copy for the cash
 * branch. Cash is intentionally cashbox-driven (no payment_account
 * exists or is expected; see FIX-9 + FIX-13). The BE may still send
 * its own `status_message`, but for cash we always render this exact
 * sentence so the operator sees a calm, definitive explanation —
 * never a noisy DB-shaped warning.
 */
const CASH_INFO_TITLE   = 'عمليات نقدية مسجلة عبر الخزنة';
const CASH_INFO_MESSAGE = 'النقدية تُسجَّل عبر الخزائن ولا تحتاج حساب دفع';

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

  // PR-FIN-PAYACCT-4D-UX-FIX-14 — visual tone follows whether ANY row
  // needs operator action. If every bucket is informational (today:
  // cash-only), drop the amber container so the panel reads as info
  // rather than warning. As soon as one actionable bucket appears
  // (e.g. future unattached InstaPay), the amber container returns.
  const hasActionableRow = rows.some(
    (r) => r.payment_method !== 'cash' && r.supported,
  );
  const containerClass = hasActionableRow
    ? 'rounded-2xl border border-amber-200 bg-amber-50/40 p-4 space-y-3'
    : 'rounded-2xl border border-slate-200 bg-slate-50/60 p-4 space-y-3';
  const headerIconClass = hasActionableRow ? 'text-amber-700' : 'text-slate-600';
  const headerTextClass = hasActionableRow ? 'text-amber-900' : 'text-slate-800';
  const headerTitle = hasActionableRow
    ? 'عمليات قديمة غير مرتبطة بحساب دفع'
    : 'سجلّ تاريخي للعمليات القديمة';

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
    <div className={containerClass} data-testid="unattached-panel">
      <div className="flex items-center gap-2">
        <AlertTriangle size={16} className={headerIconClass} />
        <h3 className={`font-bold text-sm ${headerTextClass}`}>
          {headerTitle}
        </h3>
      </div>
      <div className="space-y-2" data-testid="unattached-panel-rows">
        {rows.map((row) => {
          const key = `${row.source_table}:${row.payment_method}`;
          const methodLabel =
            METHOD_LABEL_AR[row.payment_method] ?? row.payment_method;
          const sourceLabel =
            SOURCE_TABLE_LABEL_AR[row.source_table] ?? row.source_table;
          const dateRange = formatArabicDateRange(row.earliest, row.latest);
          const isBusy = busyMethod === row.payment_method;
          const isCash = row.payment_method === 'cash';

          // PR-FIN-PAYACCT-4D-UX-FIX-14 — calm info-style card for cash
          // (cashbox-driven by design, never actionable). Non-cash rows
          // keep the existing amber-tinted "needs action" surface.
          const rowClass = isCash
            ? 'rounded-lg border border-slate-200 bg-white p-3 flex items-center gap-3 flex-wrap'
            : 'rounded-lg border border-amber-200 bg-amber-50/60 p-3 flex items-center gap-3 flex-wrap';
          const rowIcon = isCash
            ? <Info size={14} className="text-slate-500 shrink-0" data-testid={`unattached-row-icon-info-${row.source_table}-${row.payment_method}`} />
            : <Wallet size={14} className="text-amber-700 shrink-0" data-testid={`unattached-row-icon-warn-${row.source_table}-${row.payment_method}`} />;
          const rowTitle = isCash ? CASH_INFO_TITLE : methodLabel;
          // For cash we always render the canonical FE message — the
          // BE's `status_message` could drift; this stays definitive.
          const rowMessage = isCash ? CASH_INFO_MESSAGE : row.status_message;
          const messageClass = isCash
            ? 'text-[11px] text-slate-600 mt-0.5'
            : 'text-[11px] text-amber-800 mt-0.5';

          return (
            <div
              key={key}
              data-testid={`unattached-row-${row.source_table}-${row.payment_method}`}
              className={rowClass}
            >
              <div className="flex items-center gap-2 min-w-0 flex-1">
                {rowIcon}
                <div className="min-w-0">
                  <div className="text-sm font-bold text-slate-800 flex items-center gap-1.5 flex-wrap">
                    <span>{rowTitle}</span>
                    <span
                      className="inline-flex items-center px-1.5 py-0.5 rounded bg-slate-100 text-slate-600 text-[10px] font-normal"
                      data-testid={`unattached-source-badge-${row.source_table}-${row.payment_method}`}
                    >
                      {sourceLabel}
                    </span>
                    {isCash && (
                      <span className="text-[10px] text-slate-500 font-normal">
                        ({methodLabel})
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-600">
                    {row.row_count} عملية · إجمالي {EGP(row.total_amount)}
                    {dateRange && (
                      <span
                        className="text-slate-400"
                        data-testid={`unattached-date-range-${row.source_table}-${row.payment_method}`}
                      >
                        {' '}· الفترة: {dateRange}
                      </span>
                    )}
                  </div>
                  <div
                    className={messageClass}
                    data-testid={`unattached-status-${row.source_table}-${row.payment_method}`}
                  >
                    {rowMessage}
                  </div>
                </div>
              </div>
              {/* PR-FIN-PAYACCT-4D-UX-FIX-14 — defense in depth: cash
                  rows can NEVER render the action button, even if the
                  BE accidentally flips `supported` to TRUE for cash. */}
              {!isCash && row.supported && row.target_account && canManage && (
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
