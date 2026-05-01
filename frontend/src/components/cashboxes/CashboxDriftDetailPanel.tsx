/**
 * CashboxDriftDetailPanel — PR-FIN-PAYACCT-4D-REPORTS-1A
 * ────────────────────────────────────────────────────────────────────
 *
 * Read-only per-reference drilldown for a single cashbox's stored vs
 * GL drift. Renders inline beneath the reconciliation card on
 * `CashboxDetailsModal` when the operator clicks
 * "عرض تقرير الفجوة".
 *
 * Surfaces every contributing reference (`v_cashbox_drift_per_ref`)
 * with non-zero drift, alongside totals and the cashbox-level drift
 * for cross-checking. The panel imports zero write/edit primitives —
 * read-only by construction; the spec test verifies this at the
 * source-code level.
 *
 * The accompanying message
 *   "هذه قراءة فقط؛ لا يتم إجراء أي تسوية تلقائية"
 * sits inside the panel header so the read-only contract is anchored
 * directly in the operator's view.
 */
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import {
  cashDeskApi,
  type CashboxDriftCoverage,
  type CashboxDriftDetailRow,
} from '@/api/cash-desk.api';
import { formatArabicDate } from '@/lib/format-arabic-date';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const SIGNED_EGP = (n: number | string) => {
  const num = Number(n || 0);
  const prefix = num > 0 ? '+' : '';
  return `${prefix}${EGP(num)}`;
};

/** PR-FIN-PAYACCT-4D-REPORTS-1A — Arabic labels for the per-ref view. */
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
  /** Closes the inline panel; the parent toggles the open state. */
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

  return (
    <div
      className="rounded-lg border border-slate-200 bg-white p-3 mt-2 space-y-3"
      data-testid="cashbox-drift-detail-panel"
    >
      <div className="flex items-start justify-between gap-2">
        <div>
          <div className="font-bold text-sm text-slate-800">
            تقرير فجوة الخزنة مع الأستاذ العام
          </div>
          <div
            className="text-[11px] text-slate-500"
            data-testid="cashbox-drift-detail-cashbox-name"
          >
            {cashbox?.name ?? '—'}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="text-slate-400 hover:text-slate-700"
          aria-label="إغلاق التقرير"
          data-testid="cashbox-drift-detail-close"
        >
          <X size={16} />
        </button>
      </div>

      {/* Read-only contract — same wording as the parent card so the
          operator sees it whether the drilldown is open or closed. */}
      <div
        className="text-[11px] text-slate-500"
        data-testid="cashbox-drift-detail-readonly-note"
      >
        هذه قراءة فقط؛ لا يتم إجراء أي تسوية تلقائية.
      </div>

      {/* Totals + cashbox-level drift cross-check */}
      <dl
        className="text-[12px] text-slate-700 space-y-1"
        data-testid="cashbox-drift-detail-totals"
      >
        <div className="flex items-center justify-between gap-2">
          <dt>عدد المراجع المساهمة</dt>
          <dd
            className="font-mono"
            data-testid="cashbox-drift-detail-totals-count"
          >
            {String(totals.count ?? 0)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt>إجمالي الخزنة (CT)</dt>
          <dd
            className="font-mono"
            data-testid="cashbox-drift-detail-totals-ct"
          >
            {SIGNED_EGP(totals.total_ct)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2">
          <dt>إجمالي الأستاذ العام (JE)</dt>
          <dd
            className="font-mono"
            data-testid="cashbox-drift-detail-totals-je"
          >
            {SIGNED_EGP(totals.total_je)}
          </dd>
        </div>
        <div className="flex items-center justify-between gap-2 pt-1 mt-1 border-t border-slate-200">
          <dt className="font-bold text-rose-800">إجمالي الفرق</dt>
          <dd
            className="font-mono font-bold text-rose-800"
            data-testid="cashbox-drift-detail-totals-drift"
          >
            {SIGNED_EGP(totals.total_drift)}
          </dd>
        </div>
        {cashbox && (
          <div
            className="flex items-center justify-between gap-2 text-[11px] text-slate-500"
            data-testid="cashbox-drift-detail-totals-gl-drift"
          >
            <dt>الفرق على مستوى الخزنة (للمقارنة)</dt>
            <dd className="font-mono">{SIGNED_EGP(cashbox.gl_drift)}</dd>
          </div>
        )}
      </dl>

      {/* Rows */}
      {driftQuery.isLoading ? (
        <div
          className="text-[11px] text-slate-500 py-4 text-center"
          data-testid="cashbox-drift-detail-loading"
        >
          جارِ التحميل...
        </div>
      ) : rows.length === 0 ? (
        <div
          className="text-[11px] text-slate-500 py-4 text-center"
          data-testid="cashbox-drift-detail-empty"
        >
          لا توجد تفاصيل فجوة لهذه الخزنة
        </div>
      ) : (
        <div className="overflow-x-auto" data-testid="cashbox-drift-detail-rows">
          <table className="w-full text-[11px] border-collapse">
            <thead className="text-slate-500">
              <tr className="border-b border-slate-200">
                <th className="text-right py-1.5 px-1 font-bold">نوع المرجع</th>
                <th className="text-right py-1.5 px-1 font-bold">رقم المرجع</th>
                <th className="text-right py-1.5 px-1 font-bold">التغطية</th>
                <th className="text-right py-1.5 px-1 font-bold">الخزنة (CT)</th>
                <th className="text-right py-1.5 px-1 font-bold">الأستاذ (JE)</th>
                <th className="text-right py-1.5 px-1 font-bold">الفرق</th>
                <th className="text-right py-1.5 px-1 font-bold">آخر ظهور</th>
                <th className="text-right py-1.5 px-1 font-bold">قيد عيني</th>
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
                    className="border-b border-slate-100"
                    data-testid={`cashbox-drift-detail-row-${r.reference_type}-${r.reference_id}`}
                  >
                    <td className="py-1.5 px-1 text-slate-700">{refLabel}</td>
                    <td className="py-1.5 px-1 text-slate-700">
                      {r.reference_no ?? '—'}
                    </td>
                    <td className="py-1.5 px-1">
                      <span
                        className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] ${cov.cls}`}
                        data-testid={`cashbox-drift-detail-coverage-${r.reference_type}-${r.reference_id}`}
                      >
                        {cov.label}
                      </span>
                    </td>
                    <td className="py-1.5 px-1 font-mono text-slate-700">
                      {SIGNED_EGP(r.ct_signed_amount)}
                    </td>
                    <td className="py-1.5 px-1 font-mono text-slate-700">
                      {SIGNED_EGP(r.je_signed_amount)}
                    </td>
                    <td
                      className="py-1.5 px-1 font-mono font-bold text-rose-800"
                      data-testid={`cashbox-drift-detail-drift-${r.reference_type}-${r.reference_id}`}
                    >
                      {SIGNED_EGP(r.drift_amount)}
                    </td>
                    <td className="py-1.5 px-1 text-slate-500">{lastSeen}</td>
                    <td className="py-1.5 px-1 text-slate-500 font-mono">
                      {r.sample_entry_no ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
