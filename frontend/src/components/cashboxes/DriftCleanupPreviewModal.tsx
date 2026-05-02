/**
 * DriftCleanupPreviewModal — PR-FIN-PAYACCT-4D-DRIFT-HISTORICAL-CLEANUP
 *
 * Operator-only UI for the historical drift cleanup. Two-phase flow:
 *
 *   1. PREVIEW (dry-run) — POSTs {dryRun: true} on mount and renders
 *      the candidate plan + before/after drift / balance projections
 *      in a readable Arabic summary.
 *
 *   2. EXECUTE (one-shot) — only after the dry-run loads AND the
 *      operator types the exact confirm token, the execute button
 *      appears. Clicking it issues a single POST with the hard-coded
 *      execute payload (no parameters) and renders the resulting
 *      ctVoidedIds / jlUpdatedIds / drift-after / rebuilt balance.
 *
 * Safety invariants:
 *   • Execute button is HIDDEN until the dry-run query has resolved.
 *   • Execute button is DISABLED until `confirm` input.trim() ===
 *     EXACT_CONFIRM_TOKEN ('DRIFT_HISTORICAL_CLEANUP_2026_05').
 *   • Execute fires AT MOST ONCE per modal lifetime — the button
 *     disables itself the moment the mutation starts and stays
 *     disabled forever after success.
 *   • Execute payload is hard-coded inside accountsApi.executeDriftCleanup
 *     — the FE has no way to send a different payload.
 *   • Backend gate is @Permissions('accounts.journal.post') AND its
 *     own server-side confirm-token check; this UI is defense-in-depth.
 */

import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Copy, Loader2, AlertTriangle, X, ShieldAlert, Check } from 'lucide-react';

import {
  accountsApi,
  type DriftCleanupExecuteResult,
  type DriftCleanupPreview,
} from '@/api/accounts.api';

/**
 * The literal the operator must type into the confirm input to enable
 * the execute button. Identical to the backend's EXECUTE_CONFIRM_TOKEN
 * (matched server-side; the FE check is defense-in-depth).
 */
const EXACT_CONFIRM_TOKEN = 'DRIFT_HISTORICAL_CLEANUP_2026_05';

const EGP = (n: number | string | null | undefined) => {
  const v = Number(n ?? 0);
  return new Intl.NumberFormat('ar-EG', {
    style: 'currency',
    currency: 'EGP',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(v);
};

const NUM = (n: number | string | null | undefined) =>
  new Intl.NumberFormat('ar-EG').format(Number(n ?? 0));

interface Props {
  onClose: () => void;
}

export function DriftCleanupPreviewModal({ onClose }: Props) {
  const [copied, setCopied] = useState(false);
  const [confirmInput, setConfirmInput] = useState('');
  // Synchronous one-shot guard: a `disabled` prop only takes effect on the
  // next React render, so rapid back-to-back clicks (or a stuck keypress)
  // can otherwise fire the mutation multiple times. This ref flips the
  // moment the click handler runs and is checked before mutate().
  const firedRef = useRef(false);

  // PHASE 1 — read-only dry-run on mount.
  const { data, isLoading, error, refetch } = useQuery<
    DriftCleanupPreview,
    Error
  >({
    queryKey: ['drift-cleanup-preview'],
    queryFn: () => accountsApi.previewDriftCleanup(),
    staleTime: 0,
    refetchOnWindowFocus: false,
    retry: false,
  });

  // PHASE 2 — gated execute. The mutation is wired but the button
  // that triggers it is hidden until the dry-run loads AND the
  // operator types the exact confirm token. The button is disabled
  // once the mutation starts and stays disabled forever after success
  // so it can fire at most once per modal lifetime.
  const executeMutation = useMutation<DriftCleanupExecuteResult, Error>({
    mutationFn: () => accountsApi.executeDriftCleanup(),
    onSuccess: () => {
      toast.success('تم تنفيذ التنظيف بنجاح');
    },
    onError: (e) => {
      toast.error(
        (e as any)?.response?.data?.message ||
          e.message ||
          'فشل تنفيذ التنظيف',
      );
    },
  });

  const dryRunReady = !isLoading && !error && !!data;
  const confirmMatches = confirmInput.trim() === EXACT_CONFIRM_TOKEN;
  const executeAlreadyFired =
    executeMutation.isPending || executeMutation.isSuccess;
  const canExecute = dryRunReady && confirmMatches && !executeAlreadyFired;

  useEffect(() => {
    if (error) {
      toast.error(
        (error as any)?.response?.data?.message ||
          (error as Error).message ||
          'تعذّر جلب معاينة التنظيف',
      );
    }
  }, [error]);

  function copyJson() {
    // After execute success the executed payload (with ctVoidedIds /
    // jlUpdatedIds) is the more useful thing to copy; otherwise copy
    // the dry-run plan.
    const payload = executeMutation.data ?? data;
    if (!payload) return;
    const text = JSON.stringify(payload, null, 2);
    navigator.clipboard
      .writeText(text)
      .then(() => {
        setCopied(true);
        toast.success('تم نسخ JSON');
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => {
        toast.error('تعذّر النسخ');
      });
  }

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4"
      data-testid="drift-cleanup-preview-modal"
    >
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-slate-100 sticky top-0 bg-white z-10">
          <div className="flex items-center gap-2">
            <h3 className="font-black text-lg text-slate-800">
              معاينة تنظيف فروقات الخزنة
            </h3>
            <span
              className="text-[10px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 font-bold"
              title="هذه معاينة فقط — لا تنفّذ أي تغييرات على قاعدة البيانات"
            >
              معاينة فقط (Dry-Run)
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-100 rounded"
            aria-label="إغلاق"
            data-testid="drift-cleanup-preview-close"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {isLoading && (
            <div
              className="flex items-center justify-center gap-2 py-12 text-slate-600"
              data-testid="drift-cleanup-preview-loading"
            >
              <Loader2 size={20} className="animate-spin" />
              <span className="text-sm font-bold">جاري حساب المرشّحين...</span>
            </div>
          )}

          {error && !isLoading && (
            <div
              className="border border-rose-200 bg-rose-50 rounded-xl p-4 flex items-start gap-3"
              data-testid="drift-cleanup-preview-error"
            >
              <AlertTriangle size={18} className="text-rose-600 mt-0.5 shrink-0" />
              <div className="flex-1">
                <div className="font-bold text-rose-800 text-sm mb-1">
                  تعذّر جلب المعاينة
                </div>
                <div className="text-xs text-rose-700">
                  {(error as any)?.response?.data?.message ||
                    (error as Error).message}
                </div>
                <button
                  type="button"
                  onClick={() => refetch()}
                  className="mt-2 px-3 py-1.5 rounded-md bg-rose-600 text-white text-xs font-bold hover:bg-rose-700"
                  data-testid="drift-cleanup-preview-retry"
                >
                  إعادة المحاولة
                </button>
              </div>
            </div>
          )}

          {data && !isLoading && !error && (
            <PreviewBody data={data} onCopy={copyJson} copied={copied} />
          )}

          {/* PHASE 2 — execute, gated. Hidden until dry-run loaded. */}
          {dryRunReady && !executeMutation.isSuccess && (
            <ExecuteSection
              confirmInput={confirmInput}
              onConfirmChange={setConfirmInput}
              expectedToken={EXACT_CONFIRM_TOKEN}
              canExecute={canExecute}
              isExecuting={executeMutation.isPending}
              onExecute={() => {
                if (firedRef.current || !canExecute) return;
                firedRef.current = true;
                executeMutation.mutate();
              }}
              executeError={executeMutation.error}
            />
          )}

          {/* PHASE 2 result — replaces the execute section once the
              mutation succeeds. */}
          {executeMutation.isSuccess && executeMutation.data && (
            <ExecuteResultSection result={executeMutation.data} />
          )}

          <div className="border-t border-slate-100 pt-3 text-[11px] text-slate-500 leading-relaxed">
            <p>
              المرحلة 1: المعاينة (قراءة فقط) تُحمَّل تلقائيًا عند فتح النافذة.
              المرحلة 2: لتفعيل زر التنفيذ يجب أن يكتمل تحميل المعاينة، ثم تكتب
              رمز التأكيد بالكامل في الحقل أدناه. زر التنفيذ يعمل لمرة واحدة فقط
              لكل فتح للنافذة. الواجهة الخلفية تتحقق من رمز التأكيد مرة أخرى من
              جانبها كطبقة دفاع إضافية.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────

function PreviewBody({
  data,
  onCopy,
  copied,
}: {
  data: DriftCleanupPreview;
  onCopy: () => void;
  copied: boolean;
}) {
  const totalDriftBefore = data.cashboxImpact.reduce(
    (acc, c) => acc + Number(c.drift_before),
    0,
  );
  const totalDriftAfter = data.cashboxImpact.reduce(
    (acc, c) => acc + Number(c.drift_after_expected),
    0,
  );

  const noWork =
    data.patternA.candidates.length === 0 &&
    data.patternB.candidates.length === 0 &&
    data.patternB.ambiguous.length === 0;

  return (
    <>
      {/* Top-line summary */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiTile
          label="فواتير Pattern A"
          value={NUM(data.patternA.candidates.length)}
          sub={`${NUM(data.patternA.rowsToVoidCount)} صف للإلغاء`}
          tone={data.patternA.candidates.length > 0 ? 'amber' : 'slate'}
          testId="kpi-pattern-a"
        />
        <KpiTile
          label="مرتجعات Pattern B"
          value={NUM(data.patternB.candidates.length)}
          sub={`${NUM(data.patternB.rowsToUpdateCount)} صف للتحديث`}
          tone={data.patternB.candidates.length > 0 ? 'amber' : 'slate'}
          testId="kpi-pattern-b"
        />
        <KpiTile
          label="الانحراف الحالي"
          value={EGP(totalDriftBefore)}
          sub="مجموع جميع الخزائن المتأثرة"
          tone={Math.abs(totalDriftBefore) > 0.005 ? 'rose' : 'emerald'}
          testId="kpi-drift-before"
        />
        <KpiTile
          label="الانحراف المتوقّع بعد التنظيف"
          value={EGP(totalDriftAfter)}
          sub="القيمة الافتراضية: ٠"
          tone={Math.abs(totalDriftAfter) < 0.005 ? 'emerald' : 'rose'}
          testId="kpi-drift-after"
        />
      </div>

      {noWork && (
        <div
          className="border border-emerald-200 bg-emerald-50 rounded-xl p-4 text-sm font-bold text-emerald-800"
          data-testid="drift-cleanup-preview-no-work"
        >
          لا توجد مرشّحات لتنظيف الفروقات التاريخية في الوقت الحالي. ✓
        </div>
      )}

      {/* Cashbox impact table */}
      {data.cashboxImpact.length > 0 && (
        <Section
          title="الأثر المتوقّع على الخزائن"
          testId="drift-cleanup-preview-cashbox-impact"
        >
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-600 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-start font-bold">الخزنة</th>
                  <th className="px-3 py-2 text-start font-bold">انحراف قبل</th>
                  <th className="px-3 py-2 text-start font-bold">انحراف متوقع بعد</th>
                  <th className="px-3 py-2 text-start font-bold">رصيد قبل</th>
                  <th className="px-3 py-2 text-start font-bold">رصيد متوقع بعد إعادة الحساب</th>
                </tr>
              </thead>
              <tbody>
                {data.cashboxImpact.map((c) => (
                  <tr key={c.cashbox_id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-mono text-xs text-slate-600">
                      {c.cashbox_id}
                    </td>
                    <td className="px-3 py-2 font-mono">{EGP(c.drift_before)}</td>
                    <td className="px-3 py-2 font-mono">
                      {EGP(c.drift_after_expected)}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {EGP(c.current_balance_before)}
                    </td>
                    <td className="px-3 py-2 font-mono">
                      {EGP(c.current_balance_after_expected)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Pattern A — duplicate sale CTs */}
      {data.patternA.candidates.length > 0 && (
        <Section
          title={`Pattern A — فواتير بصفوف مبيعات مكرّرة (${NUM(data.patternA.candidates.length)})`}
          testId="drift-cleanup-preview-pattern-a"
        >
          <p className="text-xs text-slate-500 mb-2">
            فواتير عُدّلت في الماضي وأنتجت أكثر من سطر بيع في حركات الخزنة.
            القاعدة: <strong>الإبقاء على أقدم سطر بيع لكل (فاتورة، خزنة)</strong>،
            وتعليم الباقي كملغي. صفوف <code>edit_reversal</code> و
            <code>edit_replay</code> لا يتم المساس بها.
          </p>

          {/* Aggregate per invoice */}
          <div className="overflow-x-auto mb-3">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-600 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-start font-bold">رقم الفاتورة</th>
                  <th className="px-3 py-2 text-start font-bold">عدد صفوف البيع</th>
                  <th className="px-3 py-2 text-start font-bold">مجموع الصفوف</th>
                  <th className="px-3 py-2 text-start font-bold">قيد JE النشط</th>
                  <th className="px-3 py-2 text-start font-bold">القيمة المكرّرة</th>
                </tr>
              </thead>
              <tbody>
                {data.patternA.candidates.map((c) => (
                  <tr key={c.invoice_id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-bold text-slate-800">{c.invoice_no}</td>
                    <td className="px-3 py-2 font-mono">{NUM(c.sale_ct_count)}</td>
                    <td className="px-3 py-2 font-mono">{EGP(c.sale_ct_total)}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">{c.active_entry_no}</td>
                    <td className="px-3 py-2 font-mono text-amber-700">
                      {EGP(c.duplicate_amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Per-row keep/void plan */}
          <details className="text-xs">
            <summary className="cursor-pointer font-bold text-slate-700">
              خطة كل صف ({NUM(data.patternA.rows.length)} صف · {NUM(data.patternA.rowsToVoidCount)} للإلغاء · {EGP(data.patternA.voidAmountTotal)} مجموع الإلغاء)
            </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full">
                <thead className="text-xs text-slate-600 bg-slate-50">
                  <tr>
                    <th className="px-2 py-1 text-start font-bold">CT ID</th>
                    <th className="px-2 py-1 text-start font-bold">الفاتورة</th>
                    <th className="px-2 py-1 text-start font-bold">المبلغ</th>
                    <th className="px-2 py-1 text-start font-bold">التاريخ</th>
                    <th className="px-2 py-1 text-start font-bold">الإجراء</th>
                  </tr>
                </thead>
                <tbody>
                  {data.patternA.rows.map((r) => (
                    <tr key={r.ct_id} className="border-t border-slate-100">
                      <td className="px-2 py-1 font-mono">{r.ct_id}</td>
                      <td className="px-2 py-1 text-slate-700">{r.invoice_no}</td>
                      <td className="px-2 py-1 font-mono">{EGP(r.amount)}</td>
                      <td className="px-2 py-1 text-slate-600">{r.created_at}</td>
                      <td className="px-2 py-1">
                        {r.action === 'keep' ? (
                          <span className="text-[11px] px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 font-bold">
                            إبقاء
                          </span>
                        ) : (
                          <span className="text-[11px] px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-bold">
                            إلغاء
                          </span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </Section>
      )}

      {/* Pattern B — refund cash leg cashbox_id missing */}
      {data.patternB.candidates.length > 0 && (
        <Section
          title={`Pattern B — مرتجعات بدون cashbox_id على سطر النقدية (${NUM(data.patternB.candidates.length)})`}
          testId="drift-cleanup-preview-pattern-b"
        >
          <p className="text-xs text-slate-500 mb-2">
            مرتجعات نقدية تاريخية حيث سطر النقدية في القيد المحاسبي لم يحمل
            <code> cashbox_id</code>. التنظيف يحدّث عمود واحد فقط على القيد:
            <code> journal_lines.cashbox_id</code>. مبالغ
            <code> debit/credit</code> لا تتغير.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-xs text-slate-600 bg-slate-50">
                <tr>
                  <th className="px-3 py-2 text-start font-bold">رقم المرتجع</th>
                  <th className="px-3 py-2 text-start font-bold">قيد JE</th>
                  <th className="px-3 py-2 text-start font-bold">سطر JL</th>
                  <th className="px-3 py-2 text-start font-bold">القيمة (دائن)</th>
                  <th className="px-3 py-2 text-start font-bold">cashbox_id المقترح</th>
                </tr>
              </thead>
              <tbody>
                {data.patternB.candidates.map((c) => (
                  <tr key={c.return_id} className="border-t border-slate-100">
                    <td className="px-3 py-2 font-bold text-slate-800">{c.return_no}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">{c.entry_no}</td>
                    <td className="px-3 py-2 font-mono text-[10px] text-slate-500">{c.jl_id}</td>
                    <td className="px-3 py-2 font-mono">{EGP(c.credit)}</td>
                    <td className="px-3 py-2 font-mono text-[10px] text-slate-500">
                      {c.proposed_jl_cashbox_id}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Section>
      )}

      {/* Ambiguous Pattern B — reported only, never modified */}
      {data.patternB.ambiguous.length > 0 && (
        <Section
          title={`متجاهَل — مرتجعات Pattern B مبهمة (${NUM(data.patternB.ambiguous.length)})`}
          testId="drift-cleanup-preview-ambiguous"
        >
          <p className="text-xs text-slate-500 mb-2">
            هذه المرتجعات تطابق أكثر من سطر نقدية محتمل ولن يتم تعديلها — تُعرض
            هنا للمراجعة فقط.
          </p>
          <ul className="space-y-1">
            {data.patternB.ambiguous.map((a) => (
              <li
                key={a.return_id}
                className="text-sm border-s-4 border-amber-300 ps-3 py-1"
              >
                <span className="font-bold text-slate-800">{a.return_no}</span>
                <span className="text-xs text-slate-500 mx-2">—</span>
                <span className="text-xs text-slate-600">{a.reason}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {/* Copy JSON */}
      <div className="flex items-center justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCopy}
          className="px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm font-bold text-slate-700 hover:bg-slate-50 inline-flex items-center gap-1.5"
          data-testid="drift-cleanup-preview-copy"
        >
          <Copy size={14} />
          {copied ? 'تم النسخ ✓' : 'نسخ JSON'}
        </button>
      </div>
    </>
  );
}

// ─── small primitives ────────────────────────────────────────────────

function KpiTile({
  label,
  value,
  sub,
  tone,
  testId,
}: {
  label: string;
  value: string;
  sub: string;
  tone: 'slate' | 'amber' | 'rose' | 'emerald';
  testId: string;
}) {
  const palette = {
    slate: 'border-slate-200 bg-slate-50 text-slate-700',
    amber: 'border-amber-200 bg-amber-50 text-amber-800',
    rose: 'border-rose-200 bg-rose-50 text-rose-800',
    emerald: 'border-emerald-200 bg-emerald-50 text-emerald-800',
  }[tone];
  return (
    <div className={`rounded-xl border p-3 ${palette}`} data-testid={testId}>
      <div className="text-[11px] font-bold opacity-80">{label}</div>
      <div className="text-lg font-black font-mono mt-1">{value}</div>
      <div className="text-[10px] opacity-70 mt-0.5">{sub}</div>
    </div>
  );
}

function Section({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <section
      className="border border-slate-200 rounded-xl p-4"
      data-testid={testId}
    >
      <h4 className="font-bold text-sm text-slate-800 mb-2">{title}</h4>
      {children}
    </section>
  );
}

// ─── Phase 2: execute (gated) ─────────────────────────────────────────

function ExecuteSection({
  confirmInput,
  onConfirmChange,
  expectedToken,
  canExecute,
  isExecuting,
  onExecute,
  executeError,
}: {
  confirmInput: string;
  onConfirmChange: (v: string) => void;
  expectedToken: string;
  canExecute: boolean;
  isExecuting: boolean;
  onExecute: () => void;
  executeError: Error | null;
}) {
  const matched = confirmInput.trim() === expectedToken;
  return (
    <section
      className="border border-rose-200 bg-rose-50/40 rounded-xl p-4"
      data-testid="drift-cleanup-execute-section"
    >
      <div className="flex items-center gap-2 mb-2">
        <ShieldAlert size={16} className="text-rose-700" />
        <h4 className="font-bold text-sm text-rose-800">
          المرحلة 2 — تنفيذ التنظيف (لا يمكن التراجع)
        </h4>
      </div>
      <p className="text-xs text-rose-700/90 mb-3 leading-relaxed">
        التنفيذ سيُلغي صفوف <code>cashbox_transactions</code> المحدّدة وسيُحدّث
        عمود <code>cashbox_id</code> فقط على صفوف <code>journal_lines</code>{' '}
        المحدّدة، ثم سيُعيد بناء رصيد الخزنة. لتفعيل الزر اكتب رمز التأكيد
        التالي بالضبط:{' '}
        <code className="px-1.5 py-0.5 bg-white border border-rose-200 rounded font-mono text-[11px]">
          {expectedToken}
        </code>
      </p>

      <label className="block mb-3">
        <span className="text-xs font-bold text-slate-700 mb-1 block">
          رمز التأكيد
        </span>
        <input
          type="text"
          value={confirmInput}
          onChange={(e) => onConfirmChange(e.target.value)}
          placeholder={expectedToken}
          autoComplete="off"
          spellCheck={false}
          className={`w-full px-3 py-2 rounded-md border text-sm font-mono ${
            matched
              ? 'border-emerald-400 bg-emerald-50 text-emerald-900'
              : 'border-slate-300 bg-white text-slate-800'
          }`}
          data-testid="drift-cleanup-execute-confirm-input"
        />
        {matched ? (
          <span className="text-[11px] text-emerald-700 font-bold mt-1 inline-flex items-center gap-1">
            <Check size={12} /> رمز صحيح — زر التنفيذ مُفعَّل
          </span>
        ) : (
          <span className="text-[11px] text-slate-500 mt-1 block">
            زر التنفيذ مُعطَّل حتى يطابق الرمز بالضبط.
          </span>
        )}
      </label>

      {executeError && (
        <div
          className="mb-3 border border-rose-300 bg-rose-100 text-rose-800 text-xs p-2 rounded"
          data-testid="drift-cleanup-execute-error"
        >
          {(executeError as any)?.response?.data?.message || executeError.message}
        </div>
      )}

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onExecute}
          disabled={!canExecute}
          className={`px-4 py-2 rounded-lg text-sm font-bold inline-flex items-center gap-1.5 ${
            canExecute
              ? 'bg-rose-600 text-white hover:bg-rose-700'
              : 'bg-slate-200 text-slate-500 cursor-not-allowed'
          }`}
          data-testid="drift-cleanup-execute-button"
        >
          {isExecuting && <Loader2 size={14} className="animate-spin" />}
          تنفيذ تنظيف الفروقات التاريخية
        </button>
      </div>
    </section>
  );
}

// ─── Phase 2 result ───────────────────────────────────────────────────

function ExecuteResultSection({ result }: { result: DriftCleanupExecuteResult }) {
  const totalRebuilt = result.cashboxBalanceRebuilt.reduce(
    (acc, b) => acc + Number(b.new_balance),
    0,
  );
  const allZero = result.driftAfterActual.every(
    (d) => Math.abs(Number(d.drift)) < 0.005,
  );
  return (
    <section
      className="border border-emerald-300 bg-emerald-50 rounded-xl p-4"
      data-testid="drift-cleanup-execute-result"
    >
      <div className="flex items-center gap-2 mb-3">
        <Check size={18} className="text-emerald-700" />
        <h4 className="font-bold text-sm text-emerald-800">
          تم تنفيذ التنظيف بنجاح
        </h4>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3 text-sm">
        <div className="bg-white rounded-md border border-emerald-200 p-3">
          <div className="text-[11px] font-bold text-emerald-700 mb-1">
            صفوف cashbox_transactions الملغاة
          </div>
          <div
            className="font-mono text-xs text-slate-800 break-all"
            data-testid="drift-cleanup-execute-result-ct-ids"
          >
            {result.ctVoidedIds.length === 0
              ? '— (no rows)'
              : result.ctVoidedIds.join(', ')}
          </div>
          <div className="text-[10px] text-emerald-700/80 mt-1">
            ({result.ctVoidedIds.length} صف)
          </div>
        </div>
        <div className="bg-white rounded-md border border-emerald-200 p-3">
          <div className="text-[11px] font-bold text-emerald-700 mb-1">
            صفوف journal_lines المُحدَّثة
          </div>
          <div
            className="font-mono text-[10px] text-slate-800 break-all"
            data-testid="drift-cleanup-execute-result-jl-ids"
          >
            {result.jlUpdatedIds.length === 0
              ? '— (no rows)'
              : result.jlUpdatedIds.join(', ')}
          </div>
          <div className="text-[10px] text-emerald-700/80 mt-1">
            ({result.jlUpdatedIds.length} صف)
          </div>
        </div>
      </div>

      <div className="bg-white rounded-md border border-emerald-200 p-3 mb-3">
        <div className="text-[11px] font-bold text-emerald-700 mb-1">
          الانحراف الفعلي بعد التنفيذ
        </div>
        <ul className="text-xs text-slate-700 space-y-0.5">
          {result.driftAfterActual.map((d) => (
            <li key={d.cashbox_id} className="font-mono">
              {d.cashbox_id} → {Number(d.drift).toFixed(2)}
            </li>
          ))}
        </ul>
        <div
          className={`text-[11px] font-bold mt-1 ${
            allZero ? 'text-emerald-700' : 'text-rose-700'
          }`}
        >
          {allZero
            ? '✓ جميع الانحرافات تساوي صفر'
            : '⚠ توجد انحرافات متبقية — راجع البيانات'}
        </div>
      </div>

      {result.cashboxBalanceRebuilt.length > 0 && (
        <div className="bg-white rounded-md border border-emerald-200 p-3">
          <div className="text-[11px] font-bold text-emerald-700 mb-1">
            رصيد الخزنة بعد إعادة الحساب
          </div>
          <ul className="text-xs text-slate-700 space-y-0.5">
            {result.cashboxBalanceRebuilt.map((b) => (
              <li key={b.cashbox_id} className="font-mono">
                {b.cashbox_id} → {Number(b.new_balance).toFixed(2)}
              </li>
            ))}
          </ul>
          <div className="text-[10px] text-emerald-700/80 mt-1">
            مجموع الأرصدة الجديدة: {totalRebuilt.toFixed(2)}
          </div>
        </div>
      )}
    </section>
  );
}
