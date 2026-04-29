/**
 * CashboxDetailsModal — PR-FIN-PAYACCT-4D-UX-FIX-4
 * ───────────────────────────────────────────────────────────────────
 *
 * Centered modal that opens when the operator clicks "عرض التفاصيل"
 * on a cashbox row/card. Shows:
 *
 *   • Header summary: name / kind / current_balance / GL code /
 *     active state / last movement / total in/out/net / count / drift.
 *   • Smart date filters (اليوم / هذا الأسبوع / هذا الشهر / مخصص)
 *     plus type filter and free-text search.
 *   • UNIFIED operations feed — sourced from the new
 *     `GET /cash-desk/cashboxes/:id/movements-unified` endpoint that
 *     unions cashbox_transactions with non-cash payment_account
 *     operations linked to this cashbox.
 *   • Linked-payment-accounts section: each account is clickable to
 *     drill into its own per-account details modal.
 *
 * Read-only. No mutations. The modal centers (avoids RTL collision
 * with the right rail), mirroring `PaymentAccountDetailsPanel`.
 */
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  X,
  Search,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Wallet,
  Building2,
  Smartphone,
  FileCheck,
  AlertTriangle,
  Star,
} from 'lucide-react';
import {
  cashDeskApi,
  type Cashbox,
  type CashboxMovementUnifiedRow,
  type CashboxMovementSource,
} from '@/api/cash-desk.api';
import {
  type CashboxGlDrift,
  type PaymentAccountBalance,
  type PaymentMethodCode,
  type PaymentProvider,
  METHOD_LABEL_AR,
} from '@/api/payments.api';
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

const KIND_LABEL: Record<Cashbox['kind'], string> = {
  cash: 'نقدي',
  bank: 'بنكي',
  ewallet: 'محفظة إلكترونية',
  check: 'شيكات',
};

const KIND_ICON: Record<Cashbox['kind'], any> = {
  cash: Wallet,
  bank: Building2,
  ewallet: Smartphone,
  check: FileCheck,
};

export interface CashboxDetailsModalProps {
  cashbox: Cashbox;
  /** All payment_account balances; we filter to those linked to this cashbox. */
  allBalances: PaymentAccountBalance[];
  /** Per-cashbox drift rows from `cashDeskApi.glDrift()` (optional). */
  drifts?: CashboxGlDrift[];
  /** Provider catalog for logo + Arabic name lookup in the linked-accounts section. */
  providers: PaymentProvider[];
  onClose: () => void;
  /** When the operator clicks a linked account, the parent opens its details panel. */
  onOpenLinkedAccount: (account: PaymentAccountBalance) => void;
}

export function CashboxDetailsModal({
  cashbox,
  allBalances,
  drifts = [],
  providers,
  onClose,
  onOpenLinkedAccount,
}: CashboxDetailsModalProps) {
  // ── Filters ────────────────────────────────────────────────────────
  const [rangeKey, setRangeKey] = useState<SmartRangeKey>('month');
  const [customFrom, setCustomFrom] = useState<string>('');
  const [customTo, setCustomTo] = useState<string>('');
  const [type, setType] = useState<CashboxMovementSource | ''>('');
  const [q, setQ] = useState<string>('');

  // ── Pagination ─────────────────────────────────────────────────────
  const [pageSize, setPageSize] = useState<number>(20);
  const [page, setPage] = useState<number>(1);
  const offset = (page - 1) * pageSize;

  // Resolve effective from/to from the smart-range preset (or custom).
  const range = useMemo(() => {
    if (rangeKey === 'custom') {
      return { from: customFrom || undefined, to: customTo || undefined };
    }
    return resolveSmartRange(rangeKey);
  }, [rangeKey, customFrom, customTo]);

  // ── Movements query ────────────────────────────────────────────────
  const movementsQuery = useQuery({
    queryKey: [
      'cashbox-movements-unified',
      cashbox.id,
      range.from ?? null,
      range.to ?? null,
      type,
      q,
      pageSize,
      offset,
    ],
    queryFn: () =>
      cashDeskApi.cashboxMovementsUnified(cashbox.id, {
        from: range.from,
        to: range.to,
        type: (type || undefined) as CashboxMovementSource | undefined,
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

  const totals = movementsQuery.data?.totals ?? { in: '0', out: '0', net: '0', count: 0 };

  // ── Linked payment accounts ────────────────────────────────────────
  const linkedAccounts = useMemo(
    () => allBalances.filter((b) => b.cashbox_id === cashbox.id),
    [allBalances, cashbox.id],
  );

  // ── Drift for this cashbox ─────────────────────────────────────────
  const drift = useMemo(
    () => drifts.find((d) => d.cashbox_id === cashbox.id) ?? null,
    [drifts, cashbox.id],
  );

  function clearFilters() {
    setRangeKey('month');
    setCustomFrom('');
    setCustomTo('');
    setType('');
    setQ('');
    setPage(1);
  }

  function changeRange(next: SmartRangeKey) {
    setRangeKey(next);
    setPage(1);
  }

  const KindIcon = KIND_ICON[cashbox.kind];

  return (
    <div
      className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4"
      onClick={onClose}
      data-testid="cashbox-details-overlay"
    >
      <div
        className="bg-white rounded-2xl w-full max-w-5xl max-h-[92vh] overflow-y-auto shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        data-testid="cashbox-details-modal"
      >
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between sticky top-0 bg-white z-10">
          <div className="flex items-center gap-3">
            <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${
              cashbox.kind === 'cash'    ? 'bg-emerald-50 text-emerald-700' :
              cashbox.kind === 'bank'    ? 'bg-indigo-50 text-indigo-700' :
              cashbox.kind === 'ewallet' ? 'bg-purple-50 text-purple-700' :
                                            'bg-amber-50 text-amber-700'
            }`}>
              <KindIcon size={20} />
            </div>
            <div>
              <div className="font-black text-lg text-slate-900">{cashbox.name_ar}</div>
              <div className="text-[12px] text-slate-500">
                {KIND_LABEL[cashbox.kind]}
                {cashbox.is_active ? '' : ' · غير نشطة'}
                {cashbox.institution_name ? ` · ${cashbox.institution_name}` : ''}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1 hover:bg-slate-100 rounded"
            aria-label="إغلاق"
            data-testid="cashbox-details-close"
          >
            <X size={18} />
          </button>
        </div>

        {/* Header summary */}
        <div className="p-5 grid grid-cols-1 md:grid-cols-3 gap-5 border-b border-slate-100">
          {/* Identity */}
          <div data-testid="cashbox-details-identity">
            <h3 className="font-bold text-sm text-slate-700 mb-2">بيانات الخزنة</h3>
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              <DetailRow label="العملة" value={cashbox.currency || '—'} />
              <DetailRow
                label="الرصيد الحالي"
                value={EGP(cashbox.current_balance)}
                tone="emerald"
                mono
              />
              {cashbox.account_number && (
                <DetailRow label="رقم الحساب" value={cashbox.account_number} mono />
              )}
              {cashbox.iban && (
                <DetailRow label="IBAN" value={cashbox.iban} mono />
              )}
              {cashbox.wallet_phone && (
                <DetailRow label="رقم المحفظة" value={cashbox.wallet_phone} mono />
              )}
              {cashbox.check_issuer_name && (
                <DetailRow label="جهة الإصدار" value={cashbox.check_issuer_name} />
              )}
            </dl>
          </div>

          {/* Period totals (from current filter) */}
          <div data-testid="cashbox-details-totals">
            <h3 className="font-bold text-sm text-slate-700 mb-2">إجماليات الفترة</h3>
            <ul className="space-y-1.5 text-sm">
              <SummaryRow label="إجمالي الداخل" value={EGP(totals.in)}  tone="emerald" testId="cashbox-totals-in" />
              <SummaryRow label="إجمالي الخارج" value={EGP(totals.out)} tone="rose"    testId="cashbox-totals-out" />
              <SummaryRow label="صافي الحركة"   value={EGP(totals.net)}                  testId="cashbox-totals-net" />
              <SummaryRow label="عدد الحركات"   value={String(totals.count)}             testId="cashbox-totals-count" />
            </ul>
          </div>

          {/* Drift + warnings */}
          <div data-testid="cashbox-details-flags">
            <h3 className="font-bold text-sm text-slate-700 mb-2">المراجعة المحاسبية</h3>
            {drift ? (
              <div
                className={`rounded-lg border p-3 ${
                  Math.abs(Number(drift.drift_amount || 0)) > 0.01
                    ? 'border-rose-200 bg-rose-50'
                    : 'border-emerald-200 bg-emerald-50'
                }`}
                data-testid="cashbox-details-drift"
              >
                <div className="text-[11px] font-bold mb-1">
                  {Math.abs(Number(drift.drift_amount || 0)) > 0.01
                    ? 'فجوة مع الأستاذ العام'
                    : 'مطابقة مع الأستاذ'}
                </div>
                <div className="font-mono text-sm">
                  مخزن: {EGP(drift.stored_balance)} · أستاذ: {EGP(drift.gl_net)}
                </div>
                <div className="font-mono text-sm font-bold">
                  الفرق: {Number(drift.drift_amount) > 0 ? '+' : ''}
                  {EGP(drift.drift_amount)}
                </div>
              </div>
            ) : (
              <div className="text-[11px] text-slate-500">
                لا توجد بيانات فروق متاحة لهذه الخزنة.
              </div>
            )}
          </div>
        </div>

        {/* Linked payment accounts */}
        <div className="p-5 border-b border-slate-100">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-sm text-slate-700">حسابات الدفع المرتبطة</h3>
            <span className="text-xs text-slate-500">{linkedAccounts.length} حساب</span>
          </div>
          {linkedAccounts.length === 0 ? (
            <div
              className="text-center text-slate-500 text-sm py-6 rounded-lg border border-dashed border-slate-200 bg-slate-50"
              data-testid="cashbox-details-linked-empty"
            >
              لا توجد حسابات دفع مربوطة بهذه الخزنة.
            </div>
          ) : (
            <ul className="divide-y divide-slate-100" data-testid="cashbox-details-linked-list">
              {linkedAccounts.map((b) => {
                const provider = providers.find((p) => p.provider_key === b.provider_key);
                return (
                  <li
                    key={b.payment_account_id}
                    className="py-2 flex items-center gap-3 cursor-pointer hover:bg-slate-50 px-2 rounded"
                    onClick={() => onOpenLinkedAccount(b)}
                    data-testid={`cashbox-linked-account-${b.payment_account_id}`}
                  >
                    <PaymentProviderLogo
                      logoDataUrl={(b.metadata as any)?.logo_data_url}
                      logoKey={provider?.logo_key}
                      method={b.method as PaymentMethodCode}
                      name={b.display_name}
                      size="sm"
                      decorative
                    />
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-sm text-slate-800 truncate">
                        {b.display_name}
                      </div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {provider?.name_ar ?? b.provider_key ?? '—'} ·{' '}
                        {METHOD_LABEL_AR[b.method as PaymentMethodCode] ?? b.method}
                        {b.identifier ? ` · ${b.identifier}` : ''}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      {b.is_default && (
                        <span className="text-[10px] font-bold bg-amber-500/20 text-amber-700 px-2 py-0.5 rounded inline-flex items-center gap-0.5">
                          <Star size={10} /> افتراضي
                        </span>
                      )}
                      {!b.active && (
                        <span className="text-[10px] font-bold bg-rose-100 text-rose-700 px-2 py-0.5 rounded">
                          غير نشط
                        </span>
                      )}
                      {Number(b.je_count || 0) === 0 && (
                        <span className="text-[10px] font-bold bg-amber-100 text-amber-800 px-2 py-0.5 rounded inline-flex items-center gap-1">
                          <AlertTriangle size={10} /> لا توجد حركات
                        </span>
                      )}
                    </div>
                    <div className="font-mono text-sm text-slate-800">{EGP(b.net_debit)}</div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* Smart filters */}
        <div className="p-5 border-b border-slate-100" data-testid="cashbox-details-filters">
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h3 className="font-bold text-sm text-slate-700">الفترة الزمنية</h3>
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-slate-600 hover:underline inline-flex items-center gap-1"
              data-testid="cashbox-details-clear-filters"
            >
              <X size={12} /> مسح الفلاتر
            </button>
          </div>

          <div className="flex flex-wrap gap-2 mb-3" data-testid="cashbox-details-range-chips">
            {(['today', 'week', 'month', 'custom'] as SmartRangeKey[]).map((k) => {
              const active = rangeKey === k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => changeRange(k)}
                  data-testid={`cashbox-range-${k}`}
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

          {rangeKey === 'custom' && (
            <div className="grid grid-cols-2 gap-3 mb-3" data-testid="cashbox-details-custom-range">
              <div>
                <label className="text-[11px] font-bold text-slate-600 mb-1 block">من تاريخ</label>
                <input
                  type="date"
                  className="input"
                  value={customFrom}
                  onChange={(e) => { setCustomFrom(e.target.value); setPage(1); }}
                  data-testid="cashbox-details-custom-from"
                />
              </div>
              <div>
                <label className="text-[11px] font-bold text-slate-600 mb-1 block">إلى تاريخ</label>
                <input
                  type="date"
                  className="input"
                  value={customTo}
                  onChange={(e) => { setCustomTo(e.target.value); setPage(1); }}
                  data-testid="cashbox-details-custom-to"
                />
              </div>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div>
              <label className="text-[11px] font-bold text-slate-600 mb-1 block">نوع العملية</label>
              <select
                className="input"
                value={type}
                onChange={(e) => { setType(e.target.value as CashboxMovementSource | ''); setPage(1); }}
                data-testid="cashbox-details-filter-type"
              >
                <option value="">الكل</option>
                <option value="cashbox_txn">حركات الخزنة المباشرة</option>
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
                  data-testid="cashbox-details-filter-q"
                />
              </div>
            </div>
          </div>
        </div>

        {/* Operations table */}
        <div className="p-5">
          <h3 className="font-bold text-sm text-slate-700 mb-3">حركات الخزنة</h3>
          <OperationsTable
            isLoading={movementsQuery.isLoading}
            rows={movementsQuery.data?.rows ?? []}
          />

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
  rows: CashboxMovementUnifiedRow[];
}) {
  if (isLoading) {
    return (
      <div className="text-center text-slate-400 text-sm py-8" data-testid="cashbox-details-loading">
        جارٍ التحميل...
      </div>
    );
  }
  if (rows.length === 0) {
    return (
      <div
        className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-6 text-center text-sm text-slate-500"
        data-testid="cashbox-details-empty"
      >
        لا توجد حركات على هذه الخزنة
      </div>
    );
  }
  return (
    <div className="rounded-lg border border-slate-200 overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-xs" data-testid="cashbox-details-operations-table">
          <thead className="bg-slate-50 text-[10px] text-slate-600">
            <tr>
              <Th>التاريخ والوقت</Th>
              <Th>نوع العملية</Th>
              <Th>رقم المرجع</Th>
              <Th>الطرف</Th>
              <Th>الداخل</Th>
              <Th>الخارج</Th>
              <Th>الرصيد بعد</Th>
              <Th>طريقة الدفع</Th>
              <Th>الحساب المرتبط</Th>
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
                  key={`${r.source}-${r.id}`}
                  data-testid={`cashbox-details-row-${r.source}-${r.id}`}
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
                      {r.kind_ar}
                    </span>
                    {r.source !== 'cashbox_txn' && (
                      <span className="block text-[9px] text-slate-400 mt-0.5">
                        من حساب دفع مرتبط
                      </span>
                    )}
                  </Td>
                  <Td className="font-mono text-[11px]">{r.reference_no ?? '—'}</Td>
                  <Td className="text-slate-700">{r.counterparty_name ?? '—'}</Td>
                  <Td className="font-mono text-emerald-700">
                    {Number(r.amount_in) > 0 ? EGP(r.amount_in) : '—'}
                  </Td>
                  <Td className="font-mono text-rose-700">
                    {Number(r.amount_out) > 0 ? EGP(r.amount_out) : '—'}
                  </Td>
                  <Td className="font-mono text-[11px]">
                    {r.balance_after !== null && r.balance_after !== undefined
                      ? EGP(r.balance_after)
                      : '—'}
                  </Td>
                  <Td>
                    {r.payment_method ? (
                      <span className="text-[10px] text-slate-500">
                        {METHOD_LABEL_AR[r.payment_method as PaymentMethodCode] ?? r.payment_method}
                      </span>
                    ) : '—'}
                  </Td>
                  <Td className="text-[10px] text-slate-500">
                    {r.payment_account_id ? r.payment_account_id.slice(0, 8) + '…' : '—'}
                  </Td>
                  <Td>
                    {r.journal_entry_no ? (
                      <span className="font-mono text-[10px] text-slate-700">{r.journal_entry_no}</span>
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
      data-testid="cashbox-details-pagination"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs text-slate-500">عرض</span>
        <select
          className="input w-20 text-xs"
          value={pageSize}
          onChange={(e) => onPageSizeChange(Number(e.target.value) || 20)}
          data-testid="cashbox-details-pagination-size"
        >
          <option value={20}>20</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
      </div>
      <div className="text-xs text-slate-600">عرض {from} إلى {to} من {total}</div>
      <div className="flex items-center gap-1">
        <button type="button" onClick={() => onPageChange(1)}            disabled={page <= 1}            className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40" data-testid="cashbox-details-pagination-first"><ChevronsRight size={14} /></button>
        <button type="button" onClick={() => onPageChange(page - 1)}     disabled={page <= 1}            className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40" data-testid="cashbox-details-pagination-prev"><ChevronRight size={14} /></button>
        <span className="text-xs text-slate-700 px-2 py-1 rounded bg-slate-100 font-bold">{page}</span>
        <button type="button" onClick={() => onPageChange(page + 1)}     disabled={page >= totalPages}   className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40" data-testid="cashbox-details-pagination-next"><ChevronLeft size={14} /></button>
        <button type="button" onClick={() => onPageChange(totalPages)}   disabled={page >= totalPages}   className="p-1.5 rounded border border-slate-200 hover:bg-slate-50 disabled:opacity-40" data-testid="cashbox-details-pagination-last"><ChevronsLeft size={14} /></button>
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
