/**
 * DriftCleanupPreviewModal — PR-FIN-PAYACCT-4D-DRIFT-HISTORICAL-CLEANUP-1
 *
 * TEMPORARY operator-only diagnostic UI for previewing the historical
 * drift-cleanup plan. DRY RUN ONLY:
 *   • POSTs `{dryRun: true}` to /accounts/audit/drift-cleanup/historical
 *   • renders the JSON response in a readable Arabic summary
 *   • exposes a "نسخ JSON" button so the operator can paste the raw
 *     response back to engineering for review
 *
 * NON-GOALS:
 *   • No execute button — the UI physically cannot trigger the
 *     execute branch of the endpoint. Execution requires an
 *     out-of-band POST with the confirm token from a trusted
 *     operator session.
 *   • No confirm-token input field anywhere in this component.
 */

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { Copy, Loader2, AlertTriangle, X } from 'lucide-react';

import {
  accountsApi,
  type DriftCleanupPreview,
} from '@/api/accounts.api';

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

  // The query is the ONE network call this component ever makes.
  // No mutation, no execute path — the UI never POSTs the execute
  // branch (which the backend would only accept with a confirm token
  // anyway).
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
    if (!data) return;
    const text = JSON.stringify(data, null, 2);
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

          <div className="border-t border-slate-100 pt-3 text-[11px] text-slate-500 leading-relaxed">
            <p>
              هذه الواجهة <strong>للمعاينة فقط</strong> ولا تكتب أي شيء على قاعدة
              البيانات. لتنفيذ التنظيف فعليًا يجب إرسال طلب منفصل مع رمز التأكيد
              من جلسة مشغّل موثّقة — وهذا غير متاح من هذه الواجهة بأي حال.
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
