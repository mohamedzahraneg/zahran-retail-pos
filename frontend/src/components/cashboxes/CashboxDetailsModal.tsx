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
  ArrowDown,
  ArrowUp,
  ArrowUpDown,
  FileSpreadsheet,
  Printer,
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
import { CashboxDriftDetailPanel } from './CashboxDriftDetailPanel';
import { formatArabicDateTime } from '@/lib/format-arabic-date';
import { exportToExcel, printReport } from '@/lib/exportExcel';
import {
  buildExcelFilename,
  buildExcelRows,
  buildPrintHtml,
  buildReportTitle,
} from './cashboxReportBuilder';

/**
 * PR-FIN-PAYACCT-4D-REPORTS-1B — sortable columns for the operations
 * table. Default sort is `occurred_at DESC` (newest first), matching
 * the BE feed's natural order. The keys map directly onto fields of
 * `CashboxMovementUnifiedRow`.
 */
type SortKey =
  | 'occurred_at'
  | 'kind_ar'
  | 'reference_no'
  | 'counterparty_name'
  | 'amount_in'
  | 'amount_out'
  | 'net_amount'
  | 'user_name';
type SortDir = 'asc' | 'desc';

/** Numeric vs text columns determine the default direction on a fresh click. */
const NUMERIC_SORT_KEYS = new Set<SortKey>([
  'occurred_at', 'amount_in', 'amount_out', 'net_amount',
]);

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

  // PR-FIN-PAYACCT-4D-REPORTS-1A — inline drilldown toggle. The panel
  // only mounts (and only fires its query) when the operator opens it,
  // so the modal's default render cost is unchanged.
  const [showDriftDetail, setShowDriftDetail] = useState(false);

  // PR-FIN-PAYACCT-4D-REPORTS-1B — client-side sort over the currently
  // loaded page. The BE already orders newest-first server-side, so
  // the default state is a no-op render.
  const [sortKey, setSortKey] = useState<SortKey>('occurred_at');
  const [sortDir, setSortDir] = useState<SortDir>('desc');

  /** Apply current sort to the loaded rows. Pure; never mutates the source array. */
  const sortedRows = useMemo(() => {
    const rows = movementsQuery.data?.rows ?? [];
    if (rows.length === 0) return rows;
    const out = [...rows];
    out.sort((a, b) => compareRows(a, b, sortKey, sortDir));
    return out;
  }, [movementsQuery.data, sortKey, sortDir]);

  function handleSort(key: SortKey) {
    if (key === sortKey) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      // Numeric/date columns get DESC by default (biggest/newest first);
      // text columns get ASC so alphabetical reading is natural.
      setSortDir(NUMERIC_SORT_KEYS.has(key) ? 'desc' : 'asc');
    }
  }

  // PR-FIN-PAYACCT-4D-REPORTS-1B — Excel + Print/PDF wiring. Exports
  // the currently-sorted-and-loaded page only; totals come from the
  // backend response so they always match the on-screen table.
  function handleExportExcel() {
    if (sortedRows.length === 0) return;
    const input = {
      cashbox: {
        name: cashbox.name,
        name_ar: cashbox.name_ar,
        kind: cashbox.kind,
        currency: cashbox.currency,
      },
      range: { from: range.from, to: range.to },
      rows: sortedRows,
      totals,
    };
    exportToExcel(buildExcelFilename(input), buildExcelRows(input), 'حركات الخزنة');
  }

  function handlePrintReport() {
    if (sortedRows.length === 0) return;
    const input = {
      cashbox: {
        name: cashbox.name,
        name_ar: cashbox.name_ar,
        kind: cashbox.kind,
        currency: cashbox.currency,
      },
      range: { from: range.from, to: range.to },
      rows: sortedRows,
      totals,
    };
    printReport(buildReportTitle(input), buildPrintHtml(input));
  }

  const canExport = sortedRows.length > 0 && !movementsQuery.isLoading;

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

          {/* PR-FIN-PAYACCT-4D-UX-FIX-15 — accounting reconciliation card.
              Read-only. The earlier inline "مخزن: ... · أستاذ: ..." line
              fragmented under RTL because of mixed Latin numerals and
              Arabic colons. Replace with a clean three-row layout that
              keeps each label and money value on its own row, and add
              an explicit "read-only" footer so the operator never
              mistakes this card for an action surface.

              Tones:
                • |drift| > 0.01 → rose (warning) — surfaces the gap.
                • |drift| ≤ 0.01 → emerald (calm) — "لا توجد فروقات محاسبية".
              No drift data → neutral slate explanatory line. */}
          <div data-testid="cashbox-details-flags">
            <h3 className="font-bold text-sm text-slate-700 mb-2">المراجعة المحاسبية</h3>
            {drift ? (() => {
              const driftNum = Number(drift.drift_amount || 0);
              const hasGap   = Math.abs(driftNum) > 0.01;
              const cardClass = hasGap
                ? 'rounded-lg border border-rose-200 bg-rose-50 p-3 space-y-2'
                : 'rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-2';
              const headerClass = hasGap ? 'text-rose-700' : 'text-emerald-700';
              const dividerClass = hasGap ? 'border-rose-200' : 'border-emerald-200';
              const totalClass   = hasGap ? 'text-rose-800'   : 'text-emerald-800';
              const headerText = hasGap
                ? 'فجوة مع الأستاذ العام'
                : 'لا توجد فروقات محاسبية';
              const driftPrefix = driftNum > 0 ? '+' : '';
              return (
                <div className={cardClass} data-testid="cashbox-details-drift">
                  <div
                    className={`text-[12px] font-bold ${headerClass}`}
                    data-testid="cashbox-details-drift-header"
                  >
                    {headerText}
                  </div>
                  <dl className="text-[12px] text-slate-700 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <dt>رصيد الخزنة</dt>
                      <dd
                        className="font-mono"
                        data-testid="cashbox-details-drift-stored"
                      >
                        {EGP(drift.stored_balance)}
                      </dd>
                    </div>
                    <div className="flex items-center justify-between gap-2">
                      <dt>رصيد الأستاذ العام</dt>
                      <dd
                        className="font-mono"
                        data-testid="cashbox-details-drift-gl"
                      >
                        {EGP(drift.gl_net)}
                      </dd>
                    </div>
                    <div className={`pt-1 mt-1 border-t ${dividerClass} flex items-center justify-between gap-2`}>
                      <dt className={`font-bold ${totalClass}`}>الفرق</dt>
                      <dd
                        className={`font-mono font-bold ${totalClass}`}
                        data-testid="cashbox-details-drift-amount"
                      >
                        {driftPrefix}{EGP(drift.drift_amount)}
                      </dd>
                    </div>
                  </dl>
                  <div
                    className="text-[10px] text-slate-500 pt-1"
                    data-testid="cashbox-details-drift-readonly-note"
                  >
                    هذه قراءة فقط؛ لا يتم إجراء أي تسوية تلقائية.
                  </div>
                  {/* PR-FIN-PAYACCT-4D-REPORTS-1A — drilldown toggle.
                      Only rendered when there's a real gap to investigate;
                      the matched-state card stays minimal. */}
                  {hasGap && !showDriftDetail && (
                    <button
                      type="button"
                      onClick={() => setShowDriftDetail(true)}
                      className="text-[11px] px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-700 text-white font-bold inline-flex items-center gap-1"
                      data-testid="cashbox-details-drift-show-report"
                    >
                      عرض تقرير الفجوة
                    </button>
                  )}
                </div>
              );
            })() : (
              <div className="text-[11px] text-slate-500">
                لا توجد بيانات فروق متاحة لهذه الخزنة.
              </div>
            )}
            {/* PR-FIN-PAYACCT-4D-REPORTS-1A — inline read-only drilldown. */}
            {showDriftDetail && (
              <CashboxDriftDetailPanel
                cashboxId={cashbox.id}
                onClose={() => setShowDriftDetail(false)}
              />
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
          <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
            <h3 className="font-bold text-sm text-slate-700">حركات الخزنة</h3>
            {/* PR-FIN-PAYACCT-4D-REPORTS-1B — report toolbar.
                Excel + Print/PDF use the existing `lib/exportExcel.ts`
                helpers (no new deps). Buttons are disabled when there
                are no rows to export so the empty-state never produces
                an empty workbook or a blank print window. */}
            <div
              className="flex items-center gap-2"
              data-testid="cashbox-details-report-toolbar"
            >
              <button
                type="button"
                onClick={handleExportExcel}
                disabled={!canExport}
                className="text-[11px] px-3 py-1.5 rounded border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100 inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="cashbox-details-export-excel"
                title={canExport ? 'تصدير الصفوف الحالية إلى Excel' : 'لا توجد حركات للتصدير'}
              >
                <FileSpreadsheet size={12} />
                Excel
              </button>
              <button
                type="button"
                onClick={handlePrintReport}
                disabled={!canExport}
                className="text-[11px] px-3 py-1.5 rounded border border-slate-300 bg-slate-50 text-slate-800 hover:bg-slate-100 inline-flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="cashbox-details-print-report"
                title={canExport ? 'فتح التقرير في نافذة الطباعة' : 'لا توجد حركات للتصدير'}
              >
                <Printer size={12} />
                طباعة / PDF
              </button>
              {!canExport && !movementsQuery.isLoading && (
                <span
                  className="text-[10px] text-slate-500"
                  data-testid="cashbox-details-export-empty-msg"
                >
                  لا توجد حركات للتصدير
                </span>
              )}
            </div>
          </div>
          <OperationsTable
            isLoading={movementsQuery.isLoading}
            rows={sortedRows}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
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
  isLoading, rows, sortKey, sortDir, onSort,
}: {
  isLoading: boolean;
  rows: CashboxMovementUnifiedRow[];
  sortKey: SortKey;
  sortDir: SortDir;
  onSort: (k: SortKey) => void;
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
              <SortableTh sortKey="occurred_at"        label="التاريخ والوقت" current={sortKey} dir={sortDir} onSort={onSort} />
              <SortableTh sortKey="kind_ar"            label="نوع العملية"   current={sortKey} dir={sortDir} onSort={onSort} />
              <SortableTh sortKey="reference_no"       label="رقم المرجع"    current={sortKey} dir={sortDir} onSort={onSort} />
              <SortableTh sortKey="counterparty_name"  label="الطرف"          current={sortKey} dir={sortDir} onSort={onSort} />
              <SortableTh sortKey="amount_in"          label="الداخل"         current={sortKey} dir={sortDir} onSort={onSort} />
              <SortableTh sortKey="amount_out"         label="الخارج"         current={sortKey} dir={sortDir} onSort={onSort} />
              <SortableTh sortKey="net_amount"         label="الصافي"          current={sortKey} dir={sortDir} onSort={onSort} />
              <Th>الرصيد بعد</Th>
              <Th>طريقة الدفع</Th>
              <Th>الحساب المرتبط</Th>
              <Th>القيد المحاسبي</Th>
              <SortableTh sortKey="user_name"          label="المستخدم"       current={sortKey} dir={sortDir} onSort={onSort} />
              <Th>ملاحظات</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((r) => {
              return (
                <tr
                  key={`${r.source}-${r.id}`}
                  data-testid={`cashbox-details-row-${r.source}-${r.id}`}
                  className="hover:bg-slate-50"
                >
                  <Td className="whitespace-nowrap text-slate-700 font-mono text-[11px]">
                    {/* PR-FIN-PAYACCT-4D-REPORTS-1B — operator-spec
                        compact format `DD/MM/YYYY HH:mm:ss` with seconds. */}
                    {formatArabicDateTime(r.occurred_at)}
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

/**
 * PR-FIN-PAYACCT-4D-REPORTS-1B — sortable column header. Click toggles
 * direction; clicking a different column resets to that column's
 * default direction. Stable test ids (`sort-th-<key>`) so the spec
 * can drive sort interactions without coupling to RTL DOM order.
 */
function SortableTh({
  sortKey, label, current, dir, onSort,
}: {
  sortKey: SortKey;
  label: string;
  current: SortKey;
  dir: SortDir;
  onSort: (k: SortKey) => void;
}) {
  const active = sortKey === current;
  const Icon = !active ? ArrowUpDown : dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <th
      className="px-2 py-1.5 text-right font-bold whitespace-nowrap"
      data-testid={`cashbox-details-sort-th-${sortKey}`}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={`inline-flex items-center gap-1 hover:text-slate-900 ${active ? 'text-slate-900' : ''}`}
        data-testid={`cashbox-details-sort-btn-${sortKey}`}
        aria-sort={active ? (dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      >
        {label}
        <Icon size={10} className={active ? '' : 'opacity-40'} />
      </button>
    </th>
  );
}

/**
 * PR-FIN-PAYACCT-4D-REPORTS-1B — pure comparator over the unified-row
 * shape. Numerics are compared as numbers (handles BE string-numerics
 * cleanly); dates fall back to lexicographic comparison of the raw ISO
 * string when both sides parse — that's identical to numeric Date
 * comparison and avoids `new Date(...)` allocation per pair.
 *
 * `null`/missing values sort last regardless of direction so the
 * operator always sees populated rows first.
 */
function compareRows(
  a: CashboxMovementUnifiedRow,
  b: CashboxMovementUnifiedRow,
  key: SortKey,
  dir: SortDir,
): number {
  const sign = dir === 'asc' ? 1 : -1;
  const av = (a as any)[key];
  const bv = (b as any)[key];
  // Push nullish values to the end no matter the direction.
  const aNull = av === null || av === undefined || av === '';
  const bNull = bv === null || bv === undefined || bv === '';
  if (aNull && bNull) return 0;
  if (aNull) return 1;
  if (bNull) return -1;
  if (NUMERIC_SORT_KEYS.has(key)) {
    if (key === 'occurred_at') {
      // Lexicographic ISO compare matches Date.getTime() ordering and
      // is allocation-free.
      return sign * (String(av) < String(bv) ? -1 : String(av) > String(bv) ? 1 : 0);
    }
    return sign * (Number(av) - Number(bv));
  }
  return sign * String(av).localeCompare(String(bv), 'ar-EG');
}
