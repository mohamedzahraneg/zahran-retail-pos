/**
 * PaymentAccountDetailsPanel — PR-FIN-PAYACCT-4D-UX-FIX-2
 * ───────────────────────────────────────────────────────────────────
 *
 * Centered modal that opens when the operator clicks a payment-account
 * row (or its "عرض التفاصيل" action) on the unified treasury page.
 * Shows account identity, per-account totals, warnings, action buttons
 * (gated on `payment-accounts.manage`), and a paginated, filterable
 * list of operations specific to this account.
 *
 * The operations feed comes from `GET /payment-accounts/:id/movements`
 * — strictly filtered by `payment_account_id`. The panel never reads
 * shared GL bucket rows; that was the bug we're fixing.
 *
 * Reuses PR-4B components verbatim:
 *   • PaymentProviderLogo  — for the header avatar
 *
 * Modal centered (not a side drawer) per the approved decision so it
 * doesn't collide with the right rail in RTL.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  X,
  Star,
  PowerOff,
  Power,
  Edit3,
  Trash2,
  CheckCheck,
  AlertTriangle,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ExternalLink,
} from 'lucide-react';
import {
  paymentsApi,
  type PaymentAccountBalance,
  type PaymentAccountMovementRow,
  type PaymentAccountMovementType,
  type PaymentMethodCode,
  type PaymentProvider,
  METHOD_LABEL_AR,
} from '@/api/payments.api';
import type { Cashbox } from '@/api/cash-desk.api';
import { PaymentProviderLogo } from '@/components/payments/PaymentProviderLogo';
import {
  resolveSmartRange,
  SMART_RANGE_LABELS_AR,
  type SmartRangeKey,
} from '@/lib/smart-date-range';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

export interface PaymentAccountDetailsPanelProps {
  account: PaymentAccountBalance;
  provider: PaymentProvider | null;
  cashbox: Cashbox | null;
  /** Per-row warnings computed by the parent (no-cashbox-pin etc.). */
  warnings: string[];
  canManage: boolean;
  onClose: () => void;
  onEdit: () => void;
  onSetDefault: () => void;
  onToggleActive: () => void;
  onDelete: () => void;
}

export function PaymentAccountDetailsPanel({
  account,
  provider,
  cashbox,
  warnings,
  canManage,
  onClose,
  onEdit,
  onSetDefault,
  onToggleActive,
  onDelete,
}: PaymentAccountDetailsPanelProps) {
  // Filters
  // PR-FIN-PAYACCT-4D-UX-FIX-4 — smart-range chip + from/to inputs.
  // Picking a chip writes the resolved range into from/to and switches
  // `rangeKey`. 'custom' leaves the inputs free for the operator.
  const [rangeKey, setRangeKey] = useState<SmartRangeKey | null>(null);
  const [from, setFrom] = useState<string>('');
  const [to, setTo] = useState<string>('');
  const [type, setType] = useState<PaymentAccountMovementType | ''>('');
  const [q, setQ] = useState<string>('');

  function applyRange(k: SmartRangeKey) {
    setRangeKey(k);
    if (k === 'custom') return; // operator types from/to themselves
    const range = resolveSmartRange(k);
    setFrom(range.from);
    setTo(range.to);
    setPage(1);
  }
  // Pagination
  const [page, setPage] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(20);
  const offset = (page - 1) * pageSize;

  const movementsQuery = useQuery({
    queryKey: [
      'payment-account-movements',
      account.payment_account_id,
      from,
      to,
      type,
      q,
      pageSize,
      offset,
    ],
    queryFn: () =>
      paymentsApi.movements(account.payment_account_id, {
        from: from || undefined,
        to: to || undefined,
        type: (type || undefined) as PaymentAccountMovementType | undefined,
        q: q || undefined,
        limit: pageSize,
        offset,
      }),
    staleTime: 30_000,
  });

  const totalPages = useMemo(() => {
    const total = movementsQuery.data?.total ?? 0;
    return Math.max(1, Math.ceil(total / pageSize));
  }, [movementsQuery.data, pageSize]);

  function clearFilters() {
    setRangeKey(null);
    setFrom('');
    setTo('');
    setType('');
    setQ('');
    setPage(1);
  }

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      data-testid="payment-account-details-overlay"
    >
      <div
        className="bg-white rounded-2xl w-full max-w-4xl max-h-[92vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="payment-account-details-modal"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="flex items-center gap-3">
            <PaymentProviderLogo
              logoDataUrl={(account.metadata as any)?.logo_data_url}
              logoKey={provider?.logo_key}
              method={account.method as PaymentMethodCode}
              name={account.display_name}
              size="md"
              decorative
            />
            <div>
              <div className="font-black text-lg text-slate-900">{account.display_name}</div>
              <div className="text-[12px] text-slate-500">
                {provider?.name_ar ?? account.provider_key ?? '—'} ·{' '}
                {METHOD_LABEL_AR[account.method as PaymentMethodCode] ?? account.method}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 hover:bg-slate-100 rounded"
            aria-label="إغلاق"
            data-testid="details-close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Identity + totals */}
        <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-5 border-b border-slate-100">
          {/* Account identity */}
          <div data-testid="details-identity">
            <h3 className="font-bold text-sm text-slate-700 mb-2">بيانات الحساب</h3>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              <DetailRow label="المعرف" value={account.identifier ?? '—'} mono />
              <DetailRow label="حساب الأستاذ" value={`${account.gl_account_code} — ${account.gl_name_ar ?? ''}`} mono />
              <DetailRow label="الخزنة المرتبطة" value={cashbox ? cashbox.name_ar : '— غير مربوط —'} />
              <DetailRow label="الحالة" value={account.active ? 'نشط' : 'غير نشط'} tone={account.active ? 'emerald' : 'rose'} />
              <DetailRow label="الافتراضي" value={account.is_default ? 'نعم' : 'لا'} />
              <DetailRow
                label="آخر حركة"
                value={account.last_movement ?? '—'}
                tone={account.last_movement ? undefined : 'slate'}
              />
            </dl>
          </div>

          {/* Per-account totals (NOT shared bucket) */}
          <div data-testid="details-totals">
            <h3 className="font-bold text-sm text-slate-700 mb-2">إجماليات الحساب</h3>
            <ul className="space-y-1.5 text-sm">
              <SummaryRow label="إجمالي الداخل" value={EGP(account.total_in)} tone="emerald" testId="totals-in" />
              <SummaryRow label="إجمالي الخارج" value={EGP(account.total_out)} tone="rose"   testId="totals-out" />
              <SummaryRow label="صافي الحركة"  value={EGP(account.net_debit)}            testId="totals-net" />
              <SummaryRow label="عدد الحركات"  value={String(account.je_count)}          testId="totals-count" />
            </ul>
            {warnings.length > 0 && (
              <div className="mt-3 space-y-1" data-testid="details-warnings">
                {warnings.map((w) => (
                  <div
                    key={w}
                    className="text-[11px] font-bold bg-amber-100 text-amber-800 px-2 py-1 rounded inline-flex items-center gap-1"
                    data-testid={`details-warning-${w}`}
                  >
                    <AlertTriangle size={12} /> {w}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Action buttons */}
        {canManage && (
          <div className="p-4 border-b border-slate-100 flex flex-wrap gap-2" data-testid="details-actions">
            <button onClick={onEdit}         className="px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-sm font-bold hover:bg-slate-50 inline-flex items-center gap-1" data-testid="details-action-edit"><Edit3 size={14} /> تعديل</button>
            <button onClick={onSetDefault}   disabled={account.is_default} className="px-3 py-1.5 rounded-lg border border-amber-300 bg-amber-50 text-sm font-bold text-amber-800 hover:bg-amber-100 disabled:opacity-40 inline-flex items-center gap-1" data-testid="details-action-set-default"><CheckCheck size={14} /> تعيين افتراضي</button>
            <button onClick={onToggleActive} className="px-3 py-1.5 rounded-lg border border-sky-300 bg-sky-50 text-sm font-bold text-sky-800 hover:bg-sky-100 inline-flex items-center gap-1" data-testid="details-action-toggle-active">{account.active ? <><PowerOff size={14} /> تعطيل</> : <><Power size={14} /> تفعيل</>}</button>
            <button onClick={onDelete}       className="px-3 py-1.5 rounded-lg border border-rose-300 bg-rose-50 text-sm font-bold text-rose-700 hover:bg-rose-100 inline-flex items-center gap-1" data-testid="details-action-delete"><Trash2 size={14} /> حذف</button>
          </div>
        )}

        {/* Operations list */}
        <div className="p-5">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h3 className="font-bold text-sm text-slate-700">العمليات على هذا الحساب</h3>
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-slate-600 hover:underline inline-flex items-center gap-1"
              data-testid="details-clear-filters"
            >
              <X size={12} /> مسح الفلاتر
            </button>
          </div>

          {/* PR-FIN-PAYACCT-4D-UX-FIX-4 — smart-range chips */}
          <div className="flex flex-wrap gap-2 mb-3" data-testid="details-range-chips">
            {(['today', 'week', 'month', 'custom'] as SmartRangeKey[]).map((k) => {
              const active = rangeKey === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => applyRange(k)}
                  data-testid={`details-range-${k}`}
                  className={
                    active
                      ? 'px-3 py-1.5 rounded-lg bg-pink-600 text-white text-xs font-bold'
                      : 'px-3 py-1.5 rounded-lg border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 text-xs font-bold'
                  }
                >
                  {SMART_RANGE_LABELS_AR[k]}
                </button>
              );
            })}
          </div>

          {/* Filters */}
          <div
            className="grid grid-cols-1 md:grid-cols-4 gap-2 mb-3"
            data-testid="details-filters"
          >
            <div>
              <label className="text-[11px] font-bold text-slate-600 mb-1 block">من تاريخ</label>
              <input
                type="date"
                className="input"
                value={from}
                onChange={(e) => { setFrom(e.target.value); setPage(1); }}
                data-testid="details-filter-from"
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-600 mb-1 block">إلى تاريخ</label>
              <input
                type="date"
                className="input"
                value={to}
                onChange={(e) => { setTo(e.target.value); setPage(1); }}
                data-testid="details-filter-to"
              />
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-600 mb-1 block">نوع العملية</label>
              <select
                className="input"
                value={type}
                onChange={(e) => { setType(e.target.value as PaymentAccountMovementType | ''); setPage(1); }}
                data-testid="details-filter-type"
              >
                <option value="">الكل</option>
                <option value="invoice_payment">بيع</option>
                <option value="customer_payment">مقبوضة عميل</option>
                <option value="supplier_payment">دفع مورد</option>
              </select>
            </div>
            <div>
              <label className="text-[11px] font-bold text-slate-600 mb-1 block">بحث</label>
              <div className="relative">
                <Search size={14} className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400" />
                <input
                  type="text"
                  className="input pr-9"
                  placeholder="رقم المرجع أو الطرف..."
                  value={q}
                  onChange={(e) => { setQ(e.target.value); setPage(1); }}
                  data-testid="details-filter-q"
                />
              </div>
            </div>
          </div>

          {/* Operations table */}
          <OperationsTable
            isLoading={movementsQuery.isLoading}
            rows={movementsQuery.data?.rows ?? []}
          />

          {/* Pagination */}
          <Pagination
            total={movementsQuery.data?.total ?? 0}
            page={page}
            pageSize={pageSize}
            totalPages={totalPages}
            onPageChange={setPage}
            onPageSizeChange={(n) => { setPageSize(n); setPage(1); }}
          />
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * Sub-components
 * ──────────────────────────────────────────────────────────────────── */

function DetailRow({
  label, value, tone, mono,
}: {
  label: string;
  value: string;
  tone?: 'emerald' | 'rose' | 'slate';
  mono?: boolean;
}) {
  const cls =
    tone === 'emerald' ? 'text-emerald-700' :
    tone === 'rose'    ? 'text-rose-700' :
    tone === 'slate'   ? 'text-slate-500' : 'text-slate-800';
  return (
    <>
      <dt className="text-[11px] text-slate-500">{label}</dt>
      <dd className={`text-sm font-bold ${cls} ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </>
  );
}

function SummaryRow({
  label, value, tone, testId,
}: {
  label: string;
  value: string;
  tone?: 'emerald' | 'rose';
  testId?: string;
}) {
  const cls = tone === 'emerald' ? 'text-emerald-700' : tone === 'rose' ? 'text-rose-700' : 'text-slate-800';
  return (
    <li className="flex items-center justify-between" data-testid={testId}>
      <span className="text-slate-600">{label}</span>
      <span className={`font-mono font-bold ${cls}`}>{value}</span>
    </li>
  );
}

function OperationsTable({
  isLoading, rows,
}: {
  isLoading: boolean;
  rows: PaymentAccountMovementRow[];
}) {
  if (isLoading) {
    return (
      <div
        className="text-center text-slate-400 text-sm py-8"
        data-testid="details-loading"
      >
        جارٍ التحميل...
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div
        className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500"
        data-testid="details-empty"
      >
        لا توجد حركات على هذا الحساب
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs" data-testid="details-operations-table">
          <thead className="bg-slate-50 text-[10px] text-slate-600">
            <tr>
              <Th>التاريخ والوقت</Th>
              <Th>نوع العملية</Th>
              <Th>رقم المرجع</Th>
              <Th>الطرف</Th>
              <Th>طريقة الدفع</Th>
              <Th>الداخل</Th>
              <Th>الخارج</Th>
              <Th>صافي الحركة</Th>
              <Th>القيد المحاسبي</Th>
              <Th>المستخدم</Th>
              <Th>ملاحظات</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              const dt = new Date(r.occurred_at);
              return (
                <tr
                  key={r.id}
                  data-testid={`details-row-${r.id}`}
                  className="hover:bg-slate-50"
                >
                  <Td className="whitespace-nowrap text-slate-700">
                    {dt.toLocaleDateString('en-CA')}{' '}
                    <span className="text-[10px] text-slate-500">
                      {dt.toLocaleTimeString('ar-EG', { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </Td>
                  <Td>
                    <span className="px-1.5 py-0.5 rounded bg-slate-100 text-[10px] font-bold text-slate-700">
                      {r.operation_type_ar}
                    </span>
                  </Td>
                  <Td className="font-mono text-[11px]">{r.reference_no ?? '—'}</Td>
                  <Td className="text-slate-700">{r.counterparty_name ?? '—'}</Td>
                  <Td>
                    <span className="text-[10px] text-slate-500">
                      {METHOD_LABEL_AR[r.payment_method as PaymentMethodCode] ?? r.payment_method}
                    </span>
                  </Td>
                  <Td className="font-mono text-emerald-700">{Number(r.amount_in)  > 0 ? EGP(r.amount_in)  : '—'}</Td>
                  <Td className="font-mono text-rose-700">{Number(r.amount_out) > 0 ? EGP(r.amount_out) : '—'}</Td>
                  <Td className="font-mono">{EGP(r.net_amount)}</Td>
                  <Td>
                    {r.journal_entry_no ? (
                      <span className="font-mono text-[10px] text-slate-700 inline-flex items-center gap-1">
                        <ExternalLink size={10} /> {r.journal_entry_no}
                      </span>
                    ) : '—'}
                  </Td>
                  <Td className="text-slate-700">{r.user_name ?? '—'}</Td>
                  <Td className="text-slate-500 max-w-32 truncate">{r.notes ?? ''}</Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Pagination({
  total, page, pageSize, totalPages, onPageChange, onPageSizeChange,
}: {
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  onPageChange: (p: number) => void;
  onPageSizeChange: (n: number) => void;
}) {
  if (total === 0) return null;
  const from = (page - 1) * pageSize + 1;
  const to = Math.min(total, page * pageSize);
  return (
    <div
      className="flex items-center justify-between flex-wrap gap-2 mt-3"
      data-testid="details-pagination"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">عرض</span>
        <select
          className="input w-20 text-xs"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value) || 20)}
          data-testid="details-pagination-size"
        >
          <option value={20}>20</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </div>
      <div className="text-xs text-slate-600" data-testid="details-pagination-summary">
        عرض {from} إلى {to} من {total}
      </div>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => onPageChange(1)}            disabled={page <= 1}            className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40" data-testid="details-pagination-first"><ChevronsRight size={14} /></button>
        <button type="button" onClick={() => onPageChange(page - 1)}     disabled={page <= 1}            className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40" data-testid="details-pagination-prev"><ChevronRight size={14} /></button>
        <span className="text-xs text-slate-700 px-2 py-1 rounded bg-slate-100 font-bold" data-testid="details-pagination-page">{page}</span>
        <button type="button" onClick={() => onPageChange(page + 1)}     disabled={page >= totalPages}   className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40" data-testid="details-pagination-next"><ChevronLeft size={14} /></button>
        <button type="button" onClick={() => onPageChange(totalPages)}   disabled={page >= totalPages}   className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40" data-testid="details-pagination-last"><ChevronsLeft size={14} /></button>
      </div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="px-2 py-1.5 text-right font-bold whitespace-nowrap">{children}</th>;
}
function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return <td className={`px-2 py-1.5 text-right whitespace-nowrap ${className ?? ''}`}>{children}</td>;
}
