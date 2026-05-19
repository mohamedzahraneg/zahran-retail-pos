/**
 * StockTransfers.tsx — PR-STOCK-TRANSFERS-WORKFLOW
 *
 * Branch-aware transfer workflow page. Surface:
 *   · Header + 6 summary cards (count totals from the page rows).
 *   · Filters: search, status, from/to warehouse, from/to branch,
 *     date range. Active chips + clear button.
 *   · Table with branch chips + per-status action set + a detail
 *     drawer that surfaces items, movement references, and the
 *     receive form (delta-aware) — the actual receive write goes
 *     through stockTransfersApi.receive which is idempotent
 *     server-side.
 *
 * No direct stock writes; every action goes through the API client.
 */
import { Fragment, useEffect, useMemo, useState } from 'react';
import {
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  resetStockTransferCreateIdempotencyKey,
  resetStockTransferShipIdempotencyKey,
  resetStockTransferReceiveIdempotencyKey,
  resetStockTransferCancelIdempotencyKey,
} from '@/lib/stock-purchases-idempotency';
import {
  Shuffle,
  Plus,
  Search,
  X,
  Truck,
  Package,
  Calendar,
  Building2,
  Warehouse as WarehouseIcon,
  Filter,
  ListChecks,
  Clock,
  CheckCircle2,
  XCircle,
  Activity,
  ShieldCheck,
  ArrowRight,
  History,
  type LucideIcon,
} from 'lucide-react';
import { api, unwrap } from '@/api/client';
import {
  stockTransfersApi,
  TRANSFER_STATUSES,
  TRANSFER_STATUS_LABELS_AR,
  type TransferStatus,
  type ListTransfersFilters,
  type ReceiveTransferPayload,
} from '@/api/stock-transfers.api';
import { settingsApi, type Warehouse } from '@/api/settings.api';
import { branchesApi, type Branch } from '@/api/branches.api';

interface VariantSearch {
  variant_id: string;
  product_name: string;
  sku: string;
  color?: string;
  size?: string;
}

const STATUS_COLOR: Record<TransferStatus, string> = {
  draft: 'bg-slate-100 text-slate-700 border-slate-200',
  pending: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  approved: 'bg-sky-50 text-sky-700 border-sky-200',
  in_transit: 'bg-amber-50 text-amber-700 border-amber-200',
  partially_received: 'bg-purple-50 text-purple-700 border-purple-200',
  received: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  cancelled: 'bg-rose-50 text-rose-700 border-rose-200',
  rejected: 'bg-rose-50 text-rose-700 border-rose-200',
};

function fmtDate(s?: string | null): string {
  if (!s) return '—';
  try {
    return new Date(s).toLocaleString('ar-EG', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
  } catch {
    return s;
  }
}

function fmtNumber(n: number | string | null | undefined): string {
  const v = Number(n ?? 0);
  return Number.isFinite(v) ? v.toLocaleString('en-EG') : '0';
}

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function StockTransfers() {
  const qc = useQueryClient();

  // ── filters ──────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounced(searchInput);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [fromWh, setFromWh] = useState('');
  const [toWh, setToWh] = useState('');
  const [fromBranch, setFromBranch] = useState('');
  const [toBranch, setToBranch] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // ── modals ───────────────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ── reference data ───────────────────────────────────────────
  const { data: warehouses = [] } = useQuery({
    queryKey: ['stock-transfers-warehouses'],
    queryFn: () => settingsApi.listWarehouses(true),
    staleTime: 5 * 60_000,
  });
  const { data: branches = [] } = useQuery({
    queryKey: ['stock-transfers-branches'],
    queryFn: () => branchesApi.list(),
    staleTime: 5 * 60_000,
  });

  // ── list query ───────────────────────────────────────────────
  const filters: ListTransfersFilters = useMemo(
    () => ({
      status: statusFilter || undefined,
      from_warehouse_id: fromWh || undefined,
      to_warehouse_id: toWh || undefined,
      from_branch_id: fromBranch || undefined,
      to_branch_id: toBranch || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      search: search.trim() || undefined,
    }),
    [
      statusFilter,
      fromWh,
      toWh,
      fromBranch,
      toBranch,
      dateFrom,
      dateTo,
      search,
    ],
  );

  const { data: transfers = [], isLoading } = useQuery({
    queryKey: ['stock-transfers', filters],
    queryFn: () => stockTransfersApi.list(filters),
    placeholderData: (prev) => prev,
  });

  // ── derived totals for the summary cards (current page only) ─
  const summary = useMemo(() => {
    const base = {
      total: transfers.length,
      pending: 0,
      shipped: 0, // in_transit
      partially: 0,
      received: 0,
      cancelled: 0,
    };
    for (const t of transfers) {
      if (t.status === 'pending' || t.status === 'approved' || t.status === 'draft')
        base.pending += 1;
      if (t.status === 'in_transit') base.shipped += 1;
      if (t.status === 'partially_received') base.partially += 1;
      if (t.status === 'received') base.received += 1;
      if (t.status === 'cancelled' || t.status === 'rejected')
        base.cancelled += 1;
    }
    return base;
  }, [transfers]);

  // ── active filter chips ──────────────────────────────────────
  const warehouseById = (id: string) =>
    (warehouses as Warehouse[]).find((w) => w.id === id);
  const branchById = (id: string) =>
    (branches as Branch[]).find((b) => b.id === id);

  const activeChips: Array<{ key: string; label: string; onClear: () => void }> = [];
  if (search.trim()) {
    activeChips.push({
      key: 'search',
      label: `بحث: ${search.trim()}`,
      onClear: () => setSearchInput(''),
    });
  }
  if (statusFilter) {
    activeChips.push({
      key: 'status',
      label: `الحالة: ${TRANSFER_STATUS_LABELS_AR[statusFilter as TransferStatus] || statusFilter}`,
      onClear: () => setStatusFilter(''),
    });
  }
  if (fromWh) {
    activeChips.push({
      key: 'from-warehouse',
      label: `من مخزن: ${warehouseById(fromWh)?.name_ar || fromWh}`,
      onClear: () => setFromWh(''),
    });
  }
  if (toWh) {
    activeChips.push({
      key: 'to-warehouse',
      label: `إلى مخزن: ${warehouseById(toWh)?.name_ar || toWh}`,
      onClear: () => setToWh(''),
    });
  }
  if (fromBranch) {
    activeChips.push({
      key: 'from-branch',
      label: `من فرع: ${branchById(fromBranch)?.name_ar || fromBranch}`,
      onClear: () => setFromBranch(''),
    });
  }
  if (toBranch) {
    activeChips.push({
      key: 'to-branch',
      label: `إلى فرع: ${branchById(toBranch)?.name_ar || toBranch}`,
      onClear: () => setToBranch(''),
    });
  }
  if (dateFrom) {
    activeChips.push({
      key: 'date-from',
      label: `من: ${dateFrom}`,
      onClear: () => setDateFrom(''),
    });
  }
  if (dateTo) {
    activeChips.push({
      key: 'date-to',
      label: `إلى: ${dateTo}`,
      onClear: () => setDateTo(''),
    });
  }

  const clearAllFilters = () => {
    setSearchInput('');
    setStatusFilter('');
    setFromWh('');
    setToWh('');
    setFromBranch('');
    setToBranch('');
    setDateFrom('');
    setDateTo('');
  };

  // ── mutations ────────────────────────────────────────────────
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['stock-transfers'] });
    if (selectedId) {
      qc.invalidateQueries({ queryKey: ['stock-transfer', selectedId] });
    }
  };

  const approveM = useMutation({
    mutationFn: (id: string) => stockTransfersApi.approve(id),
    onSuccess: () => {
      toast.success('تم اعتماد التحويل');
      invalidate();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الاعتماد'),
  });

  const shipM = useMutation({
    mutationFn: (id: string) => stockTransfersApi.ship(id),
    onSuccess: () => {
      toast.success('تم شحن التحويل وخصم المخزون');
      invalidate();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الشحن'),
  });

  const cancelM = useMutation({
    mutationFn: (id: string) => stockTransfersApi.cancel(id),
    onSuccess: () => {
      toast.success('تم إلغاء التحويل');
      invalidate();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإلغاء'),
  });

  // ── render ───────────────────────────────────────────────────
  return (
    <div className="space-y-4" dir="rtl" data-testid="stock-transfers-page">
      {/* Header */}
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
            <Shuffle className="w-5 h-5 text-indigo-600" />
            التحويلات بين المخازن
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            مسار: مسودة → بانتظار الاعتماد → معتمد → تم الشحن → استلام جزئي → مستلم.
            كل تحريك مخزون يتم عبر <code>fn_adjust_stock_v2</code> فقط.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setShowCreate(true)}
          data-testid="transfers-create-button"
        >
          <Plus size={16} /> تحويل جديد
        </button>
      </header>

      {/* Summary cards */}
      <section
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2"
        data-testid="transfers-summary"
      >
        <SummaryCard
          icon={ListChecks}
          label="إجمالي الصفحة"
          value={fmtNumber(summary.total)}
          tone="default"
        />
        <SummaryCard
          icon={Clock}
          label="بانتظار الاعتماد/الشحن"
          value={fmtNumber(summary.pending)}
          tone="default"
        />
        <SummaryCard
          icon={Truck}
          label="تم الشحن"
          value={fmtNumber(summary.shipped)}
          tone="amber"
        />
        <SummaryCard
          icon={Activity}
          label="استلام جزئي"
          value={fmtNumber(summary.partially)}
          tone="purple"
        />
        <SummaryCard
          icon={CheckCircle2}
          label="مستلم"
          value={fmtNumber(summary.received)}
          tone="emerald"
        />
        <SummaryCard
          icon={XCircle}
          label="ملغى/مرفوض"
          value={fmtNumber(summary.cancelled)}
          tone="rose"
        />
      </section>

      {/* Filters */}
      <section
        className="card p-3 space-y-2"
        data-testid="transfers-filters"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
          <label className="flex items-center gap-2 input">
            <Search size={14} className="text-slate-400" />
            <input
              type="text"
              placeholder="بحث برقم التحويل أو الملاحظات…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="flex-1 bg-transparent outline-none text-sm"
              data-testid="transfers-search"
            />
          </label>

          <select
            className="input"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            data-testid="transfers-status-filter"
          >
            <option value="">كل الحالات</option>
            {TRANSFER_STATUSES.map((s) => (
              <option key={s} value={s}>
                {TRANSFER_STATUS_LABELS_AR[s]}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={fromBranch}
            onChange={(e) => setFromBranch(e.target.value)}
            data-testid="transfers-from-branch-filter"
          >
            <option value="">كل الفروع (المصدر)</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                من فرع: {b.name_ar}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={toBranch}
            onChange={(e) => setToBranch(e.target.value)}
            data-testid="transfers-to-branch-filter"
          >
            <option value="">كل الفروع (الوجهة)</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                إلى فرع: {b.name_ar}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={fromWh}
            onChange={(e) => setFromWh(e.target.value)}
            data-testid="transfers-from-warehouse-filter"
          >
            <option value="">كل المخازن (المصدر)</option>
            {(warehouses as Warehouse[]).map((w) => (
              <option key={w.id} value={w.id}>
                من: {w.name_ar}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={toWh}
            onChange={(e) => setToWh(e.target.value)}
            data-testid="transfers-to-warehouse-filter"
          >
            <option value="">كل المخازن (الوجهة)</option>
            {(warehouses as Warehouse[]).map((w) => (
              <option key={w.id} value={w.id}>
                إلى: {w.name_ar}
              </option>
            ))}
          </select>

          <label className="flex items-center gap-2 input">
            <Calendar size={14} className="text-slate-400" />
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="flex-1 bg-transparent outline-none text-sm"
              data-testid="transfers-date-from"
            />
          </label>
          <label className="flex items-center gap-2 input">
            <Calendar size={14} className="text-slate-400" />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="flex-1 bg-transparent outline-none text-sm"
              data-testid="transfers-date-to"
            />
          </label>

          <button
            type="button"
            className="btn btn-sm"
            onClick={clearAllFilters}
            disabled={activeChips.length === 0}
            data-testid="transfers-clear-filters"
          >
            <X size={13} /> مسح الفلاتر
          </button>
        </div>

        {activeChips.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1 pt-1"
            data-testid="transfers-active-chips"
          >
            <Filter size={12} className="text-slate-400" />
            <span className="text-[10px] text-slate-500">فلاتر نشطة:</span>
            {activeChips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.onClear}
                className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                data-testid={`transfers-chip-${chip.key}`}
              >
                {chip.label} <X size={10} />
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Table */}
      <section
        className="card overflow-x-auto"
        data-testid="transfers-table"
      >
        {isLoading ? (
          <div className="p-6 text-center text-sm text-slate-400">
            جاري التحميل…
          </div>
        ) : transfers.length === 0 ? (
          <div className="p-10 text-center">
            <Shuffle className="mx-auto text-slate-300 mb-2" size={36} />
            <div className="text-sm text-slate-500">لا توجد تحويلات.</div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="text-right px-3 py-2">الرقم</th>
                <th className="text-right px-3 py-2">من</th>
                <th className="text-right px-3 py-2">إلى</th>
                <th className="text-center px-3 py-2">الحالة</th>
                <th className="text-left px-3 py-2">الأصناف</th>
                <th className="text-left px-3 py-2">طلب/استلام</th>
                <th className="text-right px-3 py-2">تاريخ الطلب</th>
                <th className="text-right px-3 py-2">تاريخ الشحن</th>
                <th className="text-right px-3 py-2">تاريخ الاستلام</th>
                <th className="text-center px-3 py-2">إجراءات</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {transfers.map((t) => (
                <tr
                  key={t.id}
                  data-testid="transfer-row"
                  className="hover:bg-slate-50 cursor-pointer"
                  onClick={() => setSelectedId(t.id)}
                >
                  <td className="px-3 py-2 font-bold text-indigo-700 tabular-nums">
                    {t.transfer_no}
                  </td>
                  <td className="px-3 py-2">
                    <WarehouseBranchCell
                      warehouseName={t.from_warehouse_name}
                      branch={t.from_primary_branch}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <WarehouseBranchCell
                      warehouseName={t.to_warehouse_name}
                      branch={t.to_primary_branch}
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <StatusBadge status={t.status} />
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums">
                    {fmtNumber(t.items_count)}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                    {fmtNumber(t.total_qty_received)} /{' '}
                    {fmtNumber(t.total_qty_requested)}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                    {fmtDate(t.requested_at)}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                    {fmtDate(t.shipped_at)}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                    {fmtDate(t.received_at)}
                  </td>
                  <td
                    className="px-3 py-2"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div
                      className="flex items-center justify-center gap-1"
                      data-testid="transfer-row-actions"
                    >
                      {(t.status === 'draft' || t.status === 'pending') && (
                        <ActionBtn
                          icon={ShieldCheck}
                          title="اعتماد"
                          tone="sky"
                          loading={approveM.isPending}
                          testid="transfer-action-approve"
                          onClick={() => approveM.mutate(t.id)}
                        />
                      )}
                      {(t.status === 'draft' ||
                        t.status === 'pending' ||
                        t.status === 'approved') && (
                        <ActionBtn
                          icon={Truck}
                          title="شحن"
                          tone="amber"
                          loading={shipM.isPending}
                          testid="transfer-action-ship"
                          onClick={() => {
                            if (!confirm('تأكيد شحن التحويل وخصم المخزون؟'))
                              return;
                            resetStockTransferShipIdempotencyKey();
                            shipM.mutate(t.id);
                          }}
                        />
                      )}
                      {(t.status === 'in_transit' ||
                        t.status === 'partially_received') && (
                        <ActionBtn
                          icon={Package}
                          title="استلام"
                          tone="emerald"
                          loading={false}
                          testid="transfer-action-receive"
                          onClick={() => setSelectedId(t.id)}
                        />
                      )}
                      {(t.status === 'draft' ||
                        t.status === 'pending' ||
                        t.status === 'approved') && (
                        <ActionBtn
                          icon={XCircle}
                          title="إلغاء"
                          tone="rose"
                          loading={cancelM.isPending}
                          testid="transfer-action-cancel"
                          onClick={() => {
                            if (!confirm('تأكيد إلغاء التحويل؟')) return;
                            resetStockTransferCancelIdempotencyKey();
                            cancelM.mutate(t.id);
                          }}
                        />
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {showCreate && (
        <CreateTransferModal
          warehouses={warehouses as Warehouse[]}
          onClose={() => setShowCreate(false)}
        />
      )}
      {selectedId && (
        <TransferDetailModal
          transferId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// ─── Sub-components ───────────────────────────────────────────────
function SummaryCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone: 'default' | 'amber' | 'emerald' | 'rose' | 'purple';
}) {
  const toneMap: Record<typeof tone, string> = {
    default: 'border-slate-200 bg-white',
    amber: 'border-amber-200 bg-amber-50/60',
    emerald: 'border-emerald-200 bg-emerald-50/60',
    rose: 'border-rose-200 bg-rose-50/60',
    purple: 'border-purple-200 bg-purple-50/60',
  };
  const iconColor: Record<typeof tone, string> = {
    default: 'text-indigo-600',
    amber: 'text-amber-600',
    emerald: 'text-emerald-600',
    rose: 'text-rose-600',
    purple: 'text-purple-600',
  };
  return (
    <div
      className={`card p-2.5 border ${toneMap[tone]}`}
      data-testid="transfers-summary-card"
    >
      <div className="flex items-center gap-2 text-[11px] text-slate-500">
        <Icon size={13} className={iconColor[tone]} />
        {label}
      </div>
      <div className="text-sm font-black text-slate-800 tabular-nums mt-1">
        {value}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: TransferStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${STATUS_COLOR[status]}`}
      data-testid="transfer-status-badge"
      data-status={status}
    >
      {TRANSFER_STATUS_LABELS_AR[status] || status}
    </span>
  );
}

function WarehouseBranchCell({
  warehouseName,
  branch,
}: {
  warehouseName?: string;
  branch?: { name_ar: string } | null;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 text-slate-800 text-xs font-medium truncate">
        <WarehouseIcon size={12} className="text-slate-400" />
        {warehouseName || '—'}
      </div>
      {branch && (
        <div className="flex items-center gap-1 text-[10px] text-slate-500 truncate">
          <Building2 size={10} className="text-indigo-400" />
          {branch.name_ar}
        </div>
      )}
    </div>
  );
}

function ActionBtn({
  icon: Icon,
  title,
  tone,
  loading,
  onClick,
  testid,
}: {
  icon: LucideIcon;
  title: string;
  tone: 'sky' | 'amber' | 'emerald' | 'rose';
  loading: boolean;
  onClick: () => void;
  testid: string;
}) {
  const toneMap: Record<typeof tone, string> = {
    sky: 'hover:bg-sky-50 text-sky-700',
    amber: 'hover:bg-amber-50 text-amber-700',
    emerald: 'hover:bg-emerald-50 text-emerald-700',
    rose: 'hover:bg-rose-50 text-rose-700',
  };
  return (
    <button
      type="button"
      className={`icon-btn ${toneMap[tone]}`}
      onClick={onClick}
      disabled={loading}
      title={title}
      aria-label={title}
      data-testid={testid}
    >
      <Icon size={13} />
    </button>
  );
}

// ─── Create modal ────────────────────────────────────────────────
function CreateTransferModal({
  warehouses,
  onClose,
}: {
  warehouses: Warehouse[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [fromWh, setFromWh] = useState('');
  const [toWh, setToWh] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<
    Array<{
      variant_id: string;
      product_name: string;
      sku: string;
      quantity_requested: number;
    }>
  >([]);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    resetStockTransferCreateIdempotencyKey();
    return () => resetStockTransferCreateIdempotencyKey();
  }, []);

  const { data: searchResults = [] } = useQuery({
    queryKey: ['transfer-variant-search', searchTerm],
    queryFn: async () => {
      if (!searchTerm || searchTerm.length < 2) return [] as VariantSearch[];
      try {
        const res = await unwrap<{ data: any[] }>(
          api.get('/products', { params: { q: searchTerm, limit: 10 } }),
        );
        const out: VariantSearch[] = [];
        for (const p of res.data || []) {
          const full = await unwrap<any>(api.get(`/products/${p.id}`));
          for (const v of full.variants || []) {
            out.push({
              variant_id: v.id,
              product_name: p.name_ar,
              sku: v.sku,
              color: v.color,
              size: v.size,
            });
          }
        }
        return out;
      } catch {
        return [] as VariantSearch[];
      }
    },
    enabled: searchTerm.length >= 2,
  });

  const createM = useMutation({
    mutationFn: (payload: any) => stockTransfersApi.create(payload),
    onSuccess: () => {
      toast.success('تم إنشاء التحويل (مسودة)');
      qc.invalidateQueries({ queryKey: ['stock-transfers'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإنشاء'),
  });

  const addItem = (v: VariantSearch) => {
    if (items.some((i) => i.variant_id === v.variant_id)) {
      toast.error('الصنف مُضاف بالفعل');
      return;
    }
    setItems([
      ...items,
      {
        variant_id: v.variant_id,
        product_name: `${v.product_name} — ${v.color ?? ''} ${v.size ?? ''}`.trim(),
        sku: v.sku,
        quantity_requested: 1,
      },
    ]);
    setSearchTerm('');
  };

  const submit = () => {
    if (!fromWh || !toWh) return toast.error('اختر المخزنين');
    if (fromWh === toWh) return toast.error('المخزنان يجب أن يكونا مختلفين');
    if (items.length === 0)
      return toast.error('أضف صنفًا واحدًا على الأقل');
    if (items.some((i) => i.quantity_requested < 1))
      return toast.error('كل الكميات يجب أن تكون أكبر من 0');
    createM.mutate({
      from_warehouse_id: fromWh,
      to_warehouse_id: toWh,
      notes: notes || undefined,
      items: items.map((i) => ({
        variant_id: i.variant_id,
        quantity_requested: i.quantity_requested,
      })),
    });
  };

  return (
    <Modal
      title="تحويل مخزني جديد"
      onClose={onClose}
      wide
      testid="create-transfer-modal"
    >
      <div className="grid md:grid-cols-2 gap-3">
        <Field label="من مخزن">
          <select
            className="input"
            value={fromWh}
            onChange={(e) => setFromWh(e.target.value)}
            data-testid="create-from-warehouse"
          >
            <option value="">اختر المصدر</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name_ar || w.code}
              </option>
            ))}
          </select>
        </Field>
        <Field label="إلى مخزن">
          <select
            className="input"
            value={toWh}
            onChange={(e) => setToWh(e.target.value)}
            data-testid="create-to-warehouse"
          >
            <option value="">اختر الوجهة</option>
            {warehouses
              .filter((w) => w.id !== fromWh)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name_ar || w.code}
                </option>
              ))}
          </select>
        </Field>
      </div>

      <Field label="ملاحظات (اختياري)">
        <textarea
          className="input"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          data-testid="create-notes"
        />
      </Field>

      <Field label="بحث وإضافة أصناف">
        <div className="relative">
          <input
            className="input"
            placeholder="ابحث باسم المنتج أو الباركود…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            data-testid="create-variant-search"
          />
          {searchResults.length > 0 && searchTerm && (
            <div className="absolute z-10 left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-60 overflow-y-auto">
              {searchResults.map((v) => (
                <div
                  key={v.variant_id}
                  className="p-2 hover:bg-indigo-50 cursor-pointer text-sm"
                  onClick={() => addItem(v)}
                  data-testid="create-variant-option"
                >
                  <div className="font-bold">{v.product_name}</div>
                  <div className="text-xs text-slate-500">
                    SKU: {v.sku} — {v.color} {v.size}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Field>

      {items.length > 0 && (
        <div className="card overflow-x-auto" data-testid="create-items">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="text-right px-3 py-2">الصنف</th>
                <th className="text-right px-3 py-2">SKU</th>
                <th className="text-right px-3 py-2">الكمية</th>
                <th className="text-right px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={it.variant_id} className="border-t">
                  <td className="px-3 py-2">{it.product_name}</td>
                  <td className="px-3 py-2 font-mono text-xs">{it.sku}</td>
                  <td className="px-3 py-2">
                    <input
                      type="number"
                      min={1}
                      className="input w-24"
                      value={it.quantity_requested}
                      onChange={(e) => {
                        const v = [...items];
                        v[idx].quantity_requested =
                          Number(e.target.value) || 0;
                        setItems(v);
                      }}
                    />
                  </td>
                  <td className="px-3 py-2">
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() =>
                        setItems(items.filter((_, i) => i !== idx))
                      }
                    >
                      <X size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
        <button
          type="button"
          className="btn"
          onClick={onClose}
          disabled={createM.isPending}
        >
          إلغاء
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={submit}
          disabled={createM.isPending}
          data-testid="create-submit"
        >
          {createM.isPending ? 'جاري الحفظ…' : 'حفظ كمسودة'}
        </button>
      </div>
    </Modal>
  );
}

// ─── Detail + receive modal ──────────────────────────────────────
function TransferDetailModal({
  transferId,
  onClose,
}: {
  transferId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: t, isLoading } = useQuery({
    queryKey: ['stock-transfer', transferId],
    queryFn: () => stockTransfersApi.get(transferId),
  });

  // Local receive input map: itemId → cumulative quantity_received
  // the operator wants to record. Defaults to the persisted value
  // when status=partially_received (top-up) or to quantity_requested
  // when status=in_transit (initial full receive).
  const [receipts, setReceipts] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState('');

  useEffect(() => {
    resetStockTransferReceiveIdempotencyKey();
    return () => resetStockTransferReceiveIdempotencyKey();
  }, []);

  useEffect(() => {
    if (!t?.items) return;
    const next: Record<string, number> = {};
    for (const it of t.items) {
      next[it.id] =
        t.status === 'partially_received'
          ? it.quantity_received
          : it.quantity_requested;
    }
    setReceipts(next);
    // We deliberately key on (id, status) only; re-keying on t.items
    // would clobber the operator's edits on every refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t?.id, t?.status]);

  const receiveM = useMutation({
    mutationFn: (payload: ReceiveTransferPayload) =>
      stockTransfersApi.receive(transferId, payload),
    onSuccess: () => {
      toast.success('تم تسجيل الاستلام (delta فقط)');
      qc.invalidateQueries({ queryKey: ['stock-transfers'] });
      qc.invalidateQueries({ queryKey: ['stock-transfer', transferId] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الاستلام'),
  });

  if (isLoading || !t) {
    return (
      <Modal title="تفاصيل التحويل" onClose={onClose} wide>
        <div className="p-6 text-center text-sm text-slate-400">
          جاري التحميل…
        </div>
      </Modal>
    );
  }

  const canReceive =
    t.status === 'in_transit' || t.status === 'partially_received';

  const submitReceive = () => {
    const payloadItems = (t.items || []).map((it) => ({
      item_id: it.id,
      quantity_received: receipts[it.id] ?? it.quantity_received,
    }));
    receiveM.mutate({ items: payloadItems, notes: notes || undefined });
  };

  return (
    <Modal
      title={`تحويل ${t.transfer_no}`}
      onClose={onClose}
      wide
      testid="transfer-detail-modal"
    >
      <div className="grid md:grid-cols-4 gap-2 text-xs">
        <MiniStat
          icon={<History size={14} className="text-indigo-600" />}
          title="الحالة"
          value={TRANSFER_STATUS_LABELS_AR[t.status] || t.status}
        />
        <MiniStat
          icon={<WarehouseIcon size={14} className="text-slate-600" />}
          title="من"
          value={t.from_warehouse_name || '—'}
          sub={t.from_primary_branch?.name_ar || ''}
        />
        <MiniStat
          icon={<ArrowRight size={14} className="text-emerald-600" />}
          title="إلى"
          value={t.to_warehouse_name || '—'}
          sub={t.to_primary_branch?.name_ar || ''}
        />
        <MiniStat
          icon={<Clock size={14} className="text-amber-600" />}
          title="آخر تحديث"
          value={fmtDate(t.updated_at)}
        />
      </div>

      {t.notes && (
        <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs">
          <b>ملاحظات:</b> {t.notes}
        </div>
      )}

      <div className="card overflow-x-auto" data-testid="detail-items">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="text-right px-3 py-2">الصنف</th>
              <th className="text-right px-3 py-2">SKU</th>
              <th className="text-left px-3 py-2">المطلوب</th>
              <th className="text-left px-3 py-2">المستلم سابقًا</th>
              <th className="text-left px-3 py-2">
                {canReceive ? 'الكمية المستلمة (تراكمي)' : 'المستلم'}
              </th>
              <th className="text-left px-3 py-2">المتبقي</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {(t.items || []).map((it) => {
              const persisted = it.quantity_received;
              const requested = it.quantity_requested;
              const inputVal = receipts[it.id] ?? persisted;
              const remaining = Math.max(0, requested - inputVal);
              return (
                <tr key={it.id} data-testid="detail-item-row">
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-800">
                      {it.product_name}
                    </div>
                    <div className="text-[10px] text-slate-500">
                      {it.color} {it.size}
                    </div>
                  </td>
                  <td className="px-3 py-2 font-mono text-xs">
                    {it.variant_sku}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums font-bold">
                    {fmtNumber(requested)}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums text-slate-500">
                    {fmtNumber(persisted)}
                  </td>
                  <td className="px-3 py-2 text-left">
                    {canReceive ? (
                      <input
                        type="number"
                        min={persisted}
                        max={requested}
                        className="input w-24"
                        value={inputVal}
                        onChange={(e) =>
                          setReceipts({
                            ...receipts,
                            [it.id]: Number(e.target.value) || 0,
                          })
                        }
                        data-testid="detail-receive-input"
                      />
                    ) : (
                      <span className="font-bold tabular-nums">
                        {fmtNumber(persisted)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums text-slate-500">
                    {fmtNumber(remaining)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Movement references trail (read-only) */}
      {(t.movements?.length ?? 0) > 0 && (
        <div className="card overflow-x-auto" data-testid="detail-movements">
          <div className="px-4 py-2 border-b border-slate-100 font-bold text-slate-800 text-xs flex items-center gap-2">
            <History size={13} className="text-indigo-600" />
            حركات المخزون المرتبطة
          </div>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] text-slate-500">
              <tr>
                <th className="text-right px-3 py-2">التاريخ</th>
                <th className="text-right px-3 py-2">المخزن</th>
                <th className="text-right px-3 py-2">المتغير</th>
                <th className="text-right px-3 py-2">الإجراء</th>
                <th className="text-left px-3 py-2">الكمية</th>
                <th className="text-left px-3 py-2">الرصيد بعدها</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(t.movements || []).map((m) => (
                <tr key={m.id} data-testid="detail-movement-row">
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                    {fmtDate(m.created_at)}
                  </td>
                  <td className="px-3 py-2">{m.warehouse_name || '—'}</td>
                  <td className="px-3 py-2 font-mono">{m.variant_sku || '—'}</td>
                  <td className="px-3 py-2 text-slate-600">
                    {m.source_action || m.movement_type}
                  </td>
                  <td
                    className={`px-3 py-2 text-left tabular-nums font-bold ${
                      m.direction === 'in' ? 'text-emerald-700' : 'text-rose-700'
                    }`}
                  >
                    {m.direction === 'in' ? '+' : '-'}
                    {fmtNumber(m.quantity)}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                    {m.balance_after_qty == null
                      ? '—'
                      : fmtNumber(m.balance_after_qty)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canReceive && (
        <Fragment>
          <Field label="ملاحظات الاستلام (اختياري)">
            <textarea
              className="input"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              data-testid="detail-receive-notes"
            />
          </Field>
          <div className="bg-indigo-50 border border-indigo-100 rounded p-2 text-[11px] text-indigo-800">
            سيتم خصم/إضافة الفرق فقط (delta) في حركات المخزون.
            الإرسال مرة ثانية بنفس الكميات لن يُكرر أي حركة.
          </div>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              className="btn"
              onClick={onClose}
              disabled={receiveM.isPending}
            >
              إغلاق
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={submitReceive}
              disabled={receiveM.isPending}
              data-testid="detail-receive-submit"
            >
              {receiveM.isPending ? 'جاري التسجيل…' : 'تسجيل الاستلام'}
            </button>
          </div>
        </Fragment>
      )}
    </Modal>
  );
}

// ─── Primitives ───────────────────────────────────────────────────
function Modal({
  title,
  onClose,
  wide,
  children,
  testid,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
  testid?: string;
}) {
  return (
    <div className="fixed inset-0 bg-slate-900/40 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div
        className={`bg-white rounded-xl shadow-xl w-full ${wide ? 'max-w-5xl' : 'max-w-xl'} my-6`}
        data-testid={testid}
      >
        <div className="flex items-center justify-between p-3 border-b">
          <h3 className="font-bold text-slate-800">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="icon-btn"
            aria-label="إغلاق"
          >
            <X size={14} />
          </button>
        </div>
        <div className="p-3 space-y-3">{children}</div>
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
    <div className="space-y-1">
      <label className="block text-xs font-bold text-slate-700">
        {label}
      </label>
      {children}
    </div>
  );
}

function MiniStat({
  icon,
  title,
  value,
  sub,
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="card p-2 border border-slate-200">
      <div className="flex items-center gap-2 text-[10px] text-slate-500">
        {icon}
        {title}
      </div>
      <div className="font-bold text-sm text-slate-800 truncate">{value}</div>
      {sub && <div className="text-[10px] text-slate-500 truncate">{sub}</div>}
    </div>
  );
}
