/**
 * CashboxDriftDetailPanel — PR-FIN-PAYACCT-4D-REPORTS-1A
 * (UX rewrite: PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX)
 * ────────────────────────────────────────────────────────────────────
 *
 * Read-only per-reference drilldown for a single cashbox's stored vs
 * GL drift. Originally rendered as a narrow inline panel beneath the
 * reconciliation card on `CashboxDetailsModal`; the UX-FIX promotes
 * it to a full-screen overlay modal so:
 *
 *   • The contributing-references table has room to breathe (sticky
 *     header, horizontal scroll only when truly needed).
 *   • Operators see the **cause** of the drift first — four summary
 *     cards + a "ما سبب الفرق؟" top-contributors block + a "ماذا
 *     أفعل؟" guidance block — before drilling into the raw rows.
 *   • Real economic drift rows and self-cancelling label-mismatch
 *     pairs are visually grouped so the operator never confuses the
 *     two.
 *
 * Strictly read-only — no write/edit primitives, no API write
 * methods. The accompanying spec verifies this at the source-code
 * level so a future regression that adds one fails CI before it
 * can ship.
 *
 * Optional Excel + Print/PDF buttons reuse the existing `exportToExcel`
 * + `printReport` helpers — no new dependency installed.
 */
import { useMemo, useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { X, FileSpreadsheet, Printer, AlertCircle, Info } from 'lucide-react';
import {
  cashDeskApi,
  type CashboxDriftCoverage,
  type CashboxDriftDetailRow,
} from '@/api/cash-desk.api';
import { formatArabicDate } from '@/lib/format-arabic-date';
import { exportToExcel, printReport } from '@/lib/exportExcel';
import { categorizeDrift, topContributors } from './cashboxDriftCategorize';
import {
  buildDriftExcelRows,
  buildDriftPrintHtml,
  buildDriftReportFilename,
  buildDriftReportTitle,
} from './cashboxDriftReportBuilder';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const SIGNED_EGP = (n: number | string) => {
  const num = Number(n || 0);
  return `${num > 0 ? '+' : ''}${EGP(num)}`;
};

const REFERENCE_TYPE_LABEL_AR: Record<string, string> = {
  invoice:              'فاتورة بيع',
  return:               'مرتجع',
  customer_payment:     'سند قبض من عميل',
  supplier_payment:     'سند صرف لمورد',
  expense:              'مصروف',
  purchase:             'فاتورة شراء',
  shift:                'وردية',
  shift_variance:       'فرق وردية',
  employee_settlement:  'تسوية موظف',
  other:                'أخرى',
};

const COVERAGE_BADGE: Record<
  CashboxDriftCoverage,
  { label: string; cls: string }
> = {
  CT_only: { label: 'في الخزنة فقط',       cls: 'bg-amber-100 text-amber-800 border-amber-200' },
  JE_only: { label: 'في الأستاذ العام فقط', cls: 'bg-sky-100   text-sky-800   border-sky-200'   },
  both:    { label: 'كلاهما (بفرق)',        cls: 'bg-rose-100  text-rose-800  border-rose-200'  },
};

export interface CashboxDriftDetailPanelProps {
  cashboxId: string;
  /** Closes the modal; the parent toggles the open state. */
  onClose: () => void;
}

export function CashboxDriftDetailPanel({
  cashboxId,
  onClose,
}: CashboxDriftDetailPanelProps) {
  const driftQuery = useQuery({
    queryKey: ['cashbox-drift-detail', cashboxId],
    queryFn: () => cashDeskApi.driftDetail(cashboxId),
    staleTime: 30_000,
  });

  const data    = driftQuery.data;
  const cashbox = data?.cashbox ?? null;
  const rows: CashboxDriftDetailRow[] = data?.rows ?? [];
  const totals  = data?.totals ?? {
    count: 0, total_ct: '0', total_je: '0', total_drift: '0',
  };

  // Categorize once per data update.
  const categorized = useMemo(() => categorizeDrift(rows), [rows]);
  const top         = useMemo(() => topContributors(categorized.real, 5), [categorized.real]);

  // Esc-to-close + body scroll lock while the overlay is mounted.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [onClose]);

  const canExport = !driftQuery.isLoading && rows.length > 0 && data !== undefined;

  function handleExportExcel() {
    if (!canExport || !data) return;
    exportToExcel(
      buildDriftReportFilename({ data }),
      buildDriftExcelRows({ data }),
      'تقرير الفجوة',
    );
  }

  function handlePrintReport() {
    if (!canExport || !data) return;
    printReport(
      buildDriftReportTitle({ data }),
      buildDriftPrintHtml({ data }),
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-900/40 flex items-center justify-center p-4 overflow-y-auto"
      data-testid="cashbox-drift-detail-overlay"
      onClick={(e) => {
        // Click on the dim backdrop (not the white card) closes.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl w-full max-w-6xl max-h-[92vh] flex flex-col"
        data-testid="cashbox-drift-detail-panel"
        role="dialog"
        aria-modal="true"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-3 p-5 border-b border-slate-200">
          <div className="min-w-0">
            <div className="font-bold text-base text-slate-800">
              تقرير فجوة الخزنة مع الأستاذ العام
            </div>
            <div
              className="text-[12px] text-slate-500 mt-0.5"
              data-testid="cashbox-drift-detail-cashbox-name"
            >
              {cashbox?.name ?? '—'}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportExcel}
              disabled={!canExport}
              className="text-[11px] px-3 py-1.5 rounded border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="cashbox-drift-detail-export-excel"
              title={canExport ? 'تصدير تقرير الفجوة Excel' : 'لا توجد بيانات للتصدير'}
            >
              <FileSpreadsheet size={12} />
              Excel
            </button>
            <button
              type="button"
              onClick={handlePrintReport}
              disabled={!canExport}
              className="text-[11px] px-3 py-1.5 rounded border border-slate-300 bg-slate-50 text-slate-800 hover:bg-slate-100 inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
              data-testid="cashbox-drift-detail-print-report"
              title={canExport ? 'فتح تقرير الفجوة في نافذة الطباعة' : 'لا توجد بيانات للتصدير'}
            >
              <Printer size={12} />
              طباعة / PDF
            </button>
            <button
              type="button"
              onClick={onClose}
              className="text-slate-400 hover:text-slate-700 p-1"
              aria-label="إغلاق التقرير"
              data-testid="cashbox-drift-detail-close"
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body — scrollable to keep header + footer fixed. */}
        <div className="flex-1 overflow-y-auto p-5 space-y-4">
          {/* Read-only contract — visible above the fold. */}
          <div
            className="text-[12px] text-slate-600 bg-slate-50 border border-slate-200 rounded-md p-2 flex items-start gap-1.5"
            data-testid="cashbox-drift-detail-readonly-note"
          >
            <Info size={14} className="text-slate-500 shrink-0 mt-0.5" />
            <span>هذه قراءة فقط؛ لا يتم إجراء أي تسوية تلقائية.</span>
          </div>

          {/* Summary cards */}
          <div
            className="grid grid-cols-2 md:grid-cols-4 gap-3"
            data-testid="cashbox-drift-detail-summary"
          >
            <SummaryCard
              label="إجمالي الفرق"
              value={SIGNED_EGP(totals.total_drift)}
              tone="rose"
              testId="cashbox-drift-detail-summary-total-drift"
            />
            <SummaryCard
              label="عدد المراجع"
              value={String(totals.count ?? 0)}
              tone="slate"
              testId="cashbox-drift-detail-summary-count"
            />
            <SummaryCard
              label="فروقات حقيقية"
              value={`${categorized.real.length} · ${SIGNED_EGP(categorized.realSum)}`}
              tone="rose"
              testId="cashbox-drift-detail-summary-real"
            />
            <SummaryCard
              label="اختلافات تلغي نفسها"
              value={`${categorized.selfCancelling.length} · ${SIGNED_EGP(categorized.selfCancellingSum)}`}
              tone="emerald"
              testId="cashbox-drift-detail-summary-self-cancelling"
            />
          </div>

          {/* Cashbox-level cross-check — keep the operator anchored. */}
          {cashbox && (
            <div
              className="text-[11px] text-slate-500 flex items-center justify-between gap-2 bg-slate-50 rounded-md px-3 py-1.5 border border-slate-100"
              data-testid="cashbox-drift-detail-totals-gl-drift"
            >
              <span>الفرق على مستوى الخزنة (للمقارنة)</span>
              <span className="font-mono font-bold text-rose-700">
                {SIGNED_EGP(cashbox.gl_drift)}
              </span>
            </div>
          )}

          {driftQuery.isLoading ? (
            <div
              className="text-[12px] text-slate-500 py-12 text-center"
              data-testid="cashbox-drift-detail-loading"
            >
              جارِ التحميل...
            </div>
          ) : rows.length === 0 ? (
            <div
              className="text-[13px] text-slate-500 py-16 text-center"
              data-testid="cashbox-drift-detail-empty"
            >
              لا توجد تفاصيل فجوة لهذه الخزنة
            </div>
          ) : (
            <>
              {/* Top contributors — "ما سبب الفرق؟" */}
              {top.length > 0 && (
                <section data-testid="cashbox-drift-detail-contributors">
                  <h4 className="font-bold text-sm text-slate-800 mb-2 flex items-center gap-1.5">
                    <AlertCircle size={14} className="text-rose-600" />
                    ما سبب الفرق؟
                  </h4>
                  <ul className="space-y-1">
                    {top.map((r) => (
                      <li
                        key={`top-${r.reference_type}:${r.reference_id}`}
                        className="flex items-center justify-between gap-2 text-[12px] bg-rose-50/40 border border-rose-100 rounded-md px-3 py-1.5"
                        data-testid={`cashbox-drift-detail-contributor-${r.reference_type}-${r.reference_id}`}
                      >
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-slate-800">
                            {REFERENCE_TYPE_LABEL_AR[r.reference_type] ?? r.reference_type}
                          </span>
                          <span className="font-mono text-slate-600">
                            {r.reference_no ?? r.reference_id.slice(0, 8) + '…'}
                          </span>
                        </div>
                        <span className="font-mono font-bold text-rose-800">
                          {SIGNED_EGP(r.drift_amount)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {/* Guidance — "ماذا أفعل؟" */}
              <section
                className="bg-amber-50/40 border border-amber-200 rounded-md p-3"
                data-testid="cashbox-drift-detail-guidance"
              >
                <h4 className="font-bold text-sm text-amber-900 mb-1.5">
                  ماذا أفعل؟
                </h4>
                <ul className="list-disc pr-5 space-y-1 text-[12px] text-amber-900">
                  <li>راجع الفواتير ذات الفرق أولاً.</li>
                  <li>
                    لا تقم بتسوية تلقائية قبل معرفة هل الحركة ناقصة في الخزنة
                    أم في الأستاذ.
                  </li>
                  <li>
                    إذا كان القيد ناقصًا: أنشئ تسوية محاسبية من شاشة التسويات
                    بعد موافقة المدير.
                  </li>
                  <li>
                    إذا كان الفرق بسبب تصنيف مرجع فقط: لا تحتاج قيد مالي،
                    تحتاج تصحيح مطابقة/تصنيف.
                  </li>
                </ul>
              </section>

              {/* Real economic drift rows */}
              <section data-testid="cashbox-drift-detail-real-section">
                <h4 className="font-bold text-sm text-slate-800 mb-2">
                  الفروقات المؤثرة على الرصيد ({categorized.real.length})
                </h4>
                <DriftRowsTable
                  rows={categorized.real}
                  badge="سبب رئيسي"
                  badgeTone="rose"
                  testIdPrefix="real"
                />
              </section>

              {/* Self-cancelling label-mismatch pairs */}
              <section data-testid="cashbox-drift-detail-self-section">
                <details className="group">
                  <summary className="cursor-pointer font-bold text-sm text-slate-700 mb-2 flex items-center gap-2">
                    اختلافات تصنيف لا تؤثر على الإجمالي ({categorized.selfCancelling.length})
                    <span className="text-[10px] text-slate-400 font-normal">
                      (انقر للعرض/الإخفاء)
                    </span>
                  </summary>
                  <div className="mt-2">
                    <DriftRowsTable
                      rows={categorized.selfCancelling}
                      badge="يلغي نفسه"
                      badgeTone="slate"
                      testIdPrefix="self"
                    />
                  </div>
                </details>
              </section>
            </>
          )}
        </div>

        {/* Footer — read-only contract reinforced. */}
        <div className="border-t border-slate-200 px-5 py-3 text-[11px] text-slate-500 bg-slate-50 rounded-b-2xl">
          هذه قراءة فقط؛ لا يتم إجراء أي تسوية تلقائية.
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * Sub-components
 * ──────────────────────────────────────────────────────────────────── */

function SummaryCard({
  label, value, tone, testId,
}: {
  label: string;
  value: string;
  tone: 'rose' | 'slate' | 'emerald';
  testId: string;
}) {
  const valueClass =
    tone === 'rose'    ? 'text-rose-800' :
    tone === 'emerald' ? 'text-emerald-700' :
                          'text-slate-800';
  const borderClass =
    tone === 'rose'    ? 'border-rose-200 bg-rose-50/40' :
    tone === 'emerald' ? 'border-emerald-200 bg-emerald-50/40' :
                          'border-slate-200 bg-slate-50';
  return (
    <div
      className={`rounded-lg border ${borderClass} p-3 text-center`}
      data-testid={testId}
    >
      <div className="text-[10px] text-slate-500">{label}</div>
      <div className={`text-base font-bold font-mono mt-1 ${valueClass}`}>{value}</div>
    </div>
  );
}

function DriftRowsTable({
  rows, badge, badgeTone, testIdPrefix,
}: {
  rows: CashboxDriftDetailRow[];
  badge: string;
  badgeTone: 'rose' | 'slate';
  testIdPrefix: string;
}) {
  if (rows.length === 0) {
    return (
      <div
        className="text-[12px] text-slate-500 py-6 text-center bg-slate-50 border border-dashed border-slate-200 rounded-md"
        data-testid={`cashbox-drift-detail-empty-${testIdPrefix}`}
      >
        لا توجد صفوف في هذه المجموعة.
      </div>
    );
  }
  const badgeCls =
    badgeTone === 'rose'
      ? 'bg-rose-100 text-rose-800 border-rose-200'
      : 'bg-slate-100 text-slate-700 border-slate-200';
  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table
          className="w-full text-[11px] border-collapse"
          data-testid={`cashbox-drift-detail-table-${testIdPrefix}`}
        >
          <thead className="text-slate-600 bg-slate-50 sticky top-0">
            <tr>
              <th className="text-right py-2 px-2 font-bold">نوع المرجع</th>
              <th className="text-right py-2 px-2 font-bold">رقم المرجع</th>
              <th className="text-right py-2 px-2 font-bold">التغطية</th>
              <th className="text-right py-2 px-2 font-bold">الخزنة (CT)</th>
              <th className="text-right py-2 px-2 font-bold">الأستاذ (JE)</th>
              <th className="text-right py-2 px-2 font-bold">الفرق</th>
              <th className="text-right py-2 px-2 font-bold">آخر ظهور</th>
              <th className="text-right py-2 px-2 font-bold">قيد عيني</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const cov = COVERAGE_BADGE[r.coverage] ?? {
                label: r.coverage,
                cls: 'bg-slate-100 text-slate-700 border-slate-200',
              };
              const refLabel =
                REFERENCE_TYPE_LABEL_AR[r.reference_type] ?? r.reference_type;
              const lastSeen = formatArabicDate(r.last_seen_at);
              const rowKey = `${r.reference_type}:${r.reference_id}`;
              return (
                <tr
                  key={rowKey}
                  className="border-b border-slate-100 hover:bg-slate-50"
                  data-testid={`cashbox-drift-detail-row-${r.reference_type}-${r.reference_id}`}
                >
                  <td className="py-2 px-2">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-slate-700">{refLabel}</span>
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] ${badgeCls}`}
                        data-testid={`cashbox-drift-detail-row-badge-${r.reference_type}-${r.reference_id}`}
                      >
                        {badge}
                      </span>
                    </div>
                  </td>
                  <td className="py-2 px-2 text-slate-700">
                    {r.reference_no ?? '—'}
                  </td>
                  <td className="py-2 px-2">
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] ${cov.cls}`}
                      data-testid={`cashbox-drift-detail-coverage-${r.reference_type}-${r.reference_id}`}
                    >
                      {cov.label}
                    </span>
                  </td>
                  <td className="py-2 px-2 font-mono text-slate-700">
                    {SIGNED_EGP(r.ct_signed_amount)}
                  </td>
                  <td className="py-2 px-2 font-mono text-slate-700">
                    {SIGNED_EGP(r.je_signed_amount)}
                  </td>
                  <td
                    className="py-2 px-2 font-mono font-bold text-rose-800"
                    data-testid={`cashbox-drift-detail-drift-${r.reference_type}-${r.reference_id}`}
                  >
                    {SIGNED_EGP(r.drift_amount)}
                  </td>
                  <td className="py-2 px-2 text-slate-500">{lastSeen}</td>
                  <td className="py-2 px-2 text-slate-500 font-mono">
                    {r.sample_entry_no ?? '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
