/**
 * StockCount.tsx — PR-INVENTORY-COUNTS-WORKFLOW
 *
 * Branch-aware stocktaking page. Surface:
 *   · Header + 6 summary cards (current-page totals).
 *   · Filters: search, status, branch, warehouse, date range +
 *     active chips + clear button.
 *   · Table with per-status action set + detail drawer.
 *   · Detail drawer exposes the full workflow: freeze (only on
 *     drafts created via the new pure-header endpoint), update
 *     counted quantities (PATCH /items), review, finalize, cancel.
 *
 * All stock motion happens server-side via fn_adjust_stock_v2 at
 * finalize. The page never imports a stock client — enforced by
 * the source-level guard in the spec.
 */
import { useEffect, useMemo, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { resetInventoryFinalizeIdempotencyKey } from '@/lib/final-ops-idempotency';
import {
  ClipboardCheck,
  Plus,
  X,
  CheckCircle2,
  XCircle,
  Clock,
  Warehouse as WarehouseIcon,
  Building2,
  Search,
  Calendar,
  Filter,
  ListChecks,
  Save,
  Snowflake,
  ScrollText,
  ShieldCheck,
  TrendingUp,
  TrendingDown,
  History,
  type LucideIcon,
} from 'lucide-react';
import {
  inventoryCountsApi,
  COUNT_STATUSES,
  COUNT_STATUS_LABELS_AR,
  type CountStatus,
  type InventoryCount,
  type ListCountsFilters,
} from '@/api/inventory-counts.api';
import { settingsApi, type Warehouse } from '@/api/settings.api';
import { branchesApi, type Branch } from '@/api/branches.api';

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

const STATUS_BADGE_CLASS: Record<CountStatus, string> = {
  draft: 'bg-slate-100 text-slate-700 border-slate-200',
  open: 'bg-sky-50 text-sky-700 border-sky-200',
  counting: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  review: 'bg-amber-50 text-amber-700 border-amber-200',
  finalized: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  in_progress: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  cancelled: 'bg-rose-50 text-rose-700 border-rose-200',
};

function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}

export default function StockCount() {
  const qc = useQueryClient();

  // ── filters ──────────────────────────────────────────────────
  const [searchInput, setSearchInput] = useState('');
  const search = useDebounced(searchInput);
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [warehouseId, setWarehouseId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');

  // ── modals ───────────────────────────────────────────────────
  const [showCreate, setShowCreate] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // ── reference data ───────────────────────────────────────────
  const { data: warehouses = [] } = useQuery({
    queryKey: ['stock-count-warehouses'],
    queryFn: () => settingsApi.listWarehouses(true),
    staleTime: 5 * 60_000,
  });
  const { data: branches = [] } = useQuery({
    queryKey: ['stock-count-branches'],
    queryFn: () => branchesApi.list(),
    staleTime: 5 * 60_000,
  });

  // ── list query ───────────────────────────────────────────────
  const filters: ListCountsFilters = useMemo(
    () => ({
      status: statusFilter || undefined,
      warehouse_id: warehouseId || undefined,
      branch_id: branchId || undefined,
      date_from: dateFrom || undefined,
      date_to: dateTo || undefined,
      search: search.trim() || undefined,
    }),
    [statusFilter, warehouseId, branchId, dateFrom, dateTo, search],
  );

  const { data: counts = [], isLoading } = useQuery({
    queryKey: ['inventory-counts', filters],
    queryFn: () => inventoryCountsApi.list(filters),
    placeholderData: (prev) => prev,
  });

  // ── summary (page-level) ─────────────────────────────────────
  const summary = useMemo(() => {
    const acc = {
      total: counts.length,
      open: 0,
      counting: 0,
      review: 0,
      finalized: 0,
      cancelled: 0,
      positive_diff: 0,
      negative_diff: 0,
    };
    for (const c of counts) {
      if (c.status === 'draft' || c.status === 'open') acc.open += 1;
      if (c.status === 'counting' || c.status === 'in_progress')
        acc.counting += 1;
      if (c.status === 'review') acc.review += 1;
      if (c.status === 'finalized' || c.status === 'completed')
        acc.finalized += 1;
      if (c.status === 'cancelled') acc.cancelled += 1;
      acc.positive_diff += Number(c.positive_diff_qty ?? 0);
      acc.negative_diff += Number(c.negative_diff_qty ?? 0);
    }
    return acc;
  }, [counts]);

  // ── active filter chips ──────────────────────────────────────
  const warehouseById = (id: string) =>
    (warehouses as Warehouse[]).find((w) => w.id === id);
  const branchById = (id: string) =>
    (branches as Branch[]).find((b) => b.id === id);

  const chips: Array<{ key: string; label: string; onClear: () => void }> = [];
  if (search.trim()) {
    chips.push({
      key: 'search',
      label: `بحث: ${search.trim()}`,
      onClear: () => setSearchInput(''),
    });
  }
  if (statusFilter) {
    chips.push({
      key: 'status',
      label: `الحالة: ${
        COUNT_STATUS_LABELS_AR[statusFilter as CountStatus] || statusFilter
      }`,
      onClear: () => setStatusFilter(''),
    });
  }
  if (warehouseId) {
    chips.push({
      key: 'warehouse',
      label: `المخزن: ${warehouseById(warehouseId)?.name_ar || warehouseId}`,
      onClear: () => setWarehouseId(''),
    });
  }
  if (branchId) {
    chips.push({
      key: 'branch',
      label: `الفرع: ${branchById(branchId)?.name_ar || branchId}`,
      onClear: () => setBranchId(''),
    });
  }
  if (dateFrom) {
    chips.push({
      key: 'date-from',
      label: `من: ${dateFrom}`,
      onClear: () => setDateFrom(''),
    });
  }
  if (dateTo) {
    chips.push({
      key: 'date-to',
      label: `إلى: ${dateTo}`,
      onClear: () => setDateTo(''),
    });
  }

  const clearAllFilters = () => {
    setSearchInput('');
    setStatusFilter('');
    setWarehouseId('');
    setBranchId('');
    setDateFrom('');
    setDateTo('');
  };

  return (
    <div className="space-y-4" dir="rtl" data-testid="stock-count-page">
      {/* Header */}
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-xl font-black text-slate-800 flex items-center gap-2">
            <ClipboardCheck className="w-5 h-5 text-indigo-600" />
            الجرد الفعلي
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            مسار الجرد: مسودة ← تجميد رصيد النظام ← إدخال العدّ الفعلي ← مراجعة ← اعتماد الفروقات عبر <code>fn_adjust_stock_v2</code> فقط.
          </p>
        </div>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => setShowCreate(true)}
          data-testid="counts-create-button"
        >
          <Plus size={16} /> جرد جديد
        </button>
      </header>

      {/* Summary cards */}
      <section
        className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2"
        data-testid="counts-summary"
      >
        <SummaryCard
          icon={ListChecks}
          label="إجمالي الصفحة"
          value={fmtNumber(summary.total)}
          tone="default"
        />
        <SummaryCard
          icon={Snowflake}
          label="مسودات/مفتوحة"
          value={fmtNumber(summary.open)}
          tone="default"
        />
        <SummaryCard
          icon={Clock}
          label="قيد العدّ"
          value={fmtNumber(summary.counting)}
          tone="amber"
        />
        <SummaryCard
          icon={ScrollText}
          label="مراجعة"
          value={fmtNumber(summary.review)}
          tone="amber"
        />
        <SummaryCard
          icon={CheckCircle2}
          label="معتمدة"
          value={fmtNumber(summary.finalized)}
          tone="emerald"
        />
        <SummaryCard
          icon={XCircle}
          label="ملغاة"
          value={fmtNumber(summary.cancelled)}
          tone="rose"
        />
      </section>

      {/* Variance summary (positive / negative — current page) */}
      <section className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <VarianceCard
          icon={TrendingUp}
          label="فروقات موجبة (زيادة على النظام)"
          value={fmtNumber(summary.positive_diff)}
          tone="emerald"
        />
        <VarianceCard
          icon={TrendingDown}
          label="فروقات سالبة (نقص عن النظام)"
          value={fmtNumber(summary.negative_diff)}
          tone="rose"
        />
      </section>

      {/* Filters */}
      <section
        className="card p-3 space-y-2"
        data-testid="counts-filters"
      >
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-2">
          <label className="flex items-center gap-2 input">
            <Search size={14} className="text-slate-400" />
            <input
              type="text"
              placeholder="بحث برقم الجرد أو الملاحظات…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="flex-1 bg-transparent outline-none text-sm"
              data-testid="counts-search"
            />
          </label>

          <select
            className="input"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            data-testid="counts-status-filter"
          >
            <option value="">كل الحالات</option>
            {COUNT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {COUNT_STATUS_LABELS_AR[s]}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={branchId}
            onChange={(e) => setBranchId(e.target.value)}
            data-testid="counts-branch-filter"
          >
            <option value="">كل الفروع</option>
            {branches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name_ar}
              </option>
            ))}
          </select>

          <select
            className="input"
            value={warehouseId}
            onChange={(e) => setWarehouseId(e.target.value)}
            data-testid="counts-warehouse-filter"
          >
            <option value="">كل المخازن</option>
            {(warehouses as Warehouse[]).map((w) => (
              <option key={w.id} value={w.id}>
                {w.name_ar}
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
              data-testid="counts-date-from"
            />
          </label>
          <label className="flex items-center gap-2 input">
            <Calendar size={14} className="text-slate-400" />
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="flex-1 bg-transparent outline-none text-sm"
              data-testid="counts-date-to"
            />
          </label>

          <button
            type="button"
            className="btn btn-sm"
            onClick={clearAllFilters}
            disabled={chips.length === 0}
            data-testid="counts-clear-filters"
          >
            <X size={13} /> مسح الفلاتر
          </button>
        </div>

        {chips.length > 0 && (
          <div
            className="flex flex-wrap items-center gap-1 pt-1"
            data-testid="counts-active-chips"
          >
            <Filter size={12} className="text-slate-400" />
            <span className="text-[10px] text-slate-500">فلاتر نشطة:</span>
            {chips.map((chip) => (
              <button
                key={chip.key}
                type="button"
                onClick={chip.onClear}
                className="inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                data-testid={`counts-chip-${chip.key}`}
              >
                {chip.label} <X size={10} />
              </button>
            ))}
          </div>
        )}
      </section>

      {/* Table */}
      <section className="card overflow-x-auto" data-testid="counts-table">
        {isLoading ? (
          <div className="p-6 text-center text-sm text-slate-400">
            جاري التحميل…
          </div>
        ) : counts.length === 0 ? (
          <div className="p-10 text-center">
            <ClipboardCheck
              className="mx-auto text-slate-300 mb-2"
              size={36}
            />
            <div className="text-sm text-slate-500">لا توجد عمليات جرد.</div>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-xs text-slate-500">
              <tr>
                <th className="text-right px-3 py-2">رقم الجرد</th>
                <th className="text-right px-3 py-2">المخزن</th>
                <th className="text-center px-3 py-2">الحالة</th>
                <th className="text-left px-3 py-2">الأصناف</th>
                <th className="text-left px-3 py-2">معدودة</th>
                <th className="text-left px-3 py-2">بها فرق</th>
                <th className="text-right px-3 py-2">بدأ</th>
                <th className="text-right px-3 py-2">انتهى</th>
                <th className="text-right px-3 py-2">بدأ بواسطة</th>
                <th className="text-right px-3 py-2">أنهى بواسطة</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {counts.map((c) => (
                <tr
                  key={c.id}
                  data-testid="count-row"
                  className="hover:bg-slate-50 cursor-pointer"
                  onClick={() => setSelectedId(c.id)}
                >
                  <td className="px-3 py-2 font-bold text-indigo-700 tabular-nums">
                    {c.count_no}
                  </td>
                  <td className="px-3 py-2">
                    <WarehouseBranchCell
                      warehouseName={c.warehouse_name}
                      branch={c.primary_branch}
                    />
                  </td>
                  <td className="px-3 py-2 text-center">
                    <StatusBadge status={c.status} />
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums">
                    {fmtNumber(c.items_total)}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums">
                    {fmtNumber(c.items_counted)}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums text-slate-600">
                    {fmtNumber(c.items_with_diff)}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                    {fmtDate(c.started_at)}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500 whitespace-nowrap">
                    {fmtDate(c.completed_at)}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {c.started_by_name || '—'}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {c.completed_by_name || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {showCreate && (
        <CreateCountModal
          warehouses={warehouses as Warehouse[]}
          onClose={() => setShowCreate(false)}
          onCreated={(c) => {
            setShowCreate(false);
            qc.invalidateQueries({ queryKey: ['inventory-counts'] });
            setSelectedId(c.id);
          }}
        />
      )}
      {selectedId && (
        <CountDetailDrawer
          countId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// ─── Summary card ────────────────────────────────────────────────
function SummaryCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone: 'default' | 'amber' | 'emerald' | 'rose';
}) {
  const toneMap: Record<typeof tone, string> = {
    default: 'border-slate-200 bg-white',
    amber: 'border-amber-200 bg-amber-50/60',
    emerald: 'border-emerald-200 bg-emerald-50/60',
    rose: 'border-rose-200 bg-rose-50/60',
  };
  const iconColor: Record<typeof tone, string> = {
    default: 'text-indigo-600',
    amber: 'text-amber-600',
    emerald: 'text-emerald-600',
    rose: 'text-rose-600',
  };
  return (
    <div
      className={`card p-2.5 border ${toneMap[tone]}`}
      data-testid="counts-summary-card"
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

function VarianceCard({
  icon: Icon,
  label,
  value,
  tone,
}: {
  icon: LucideIcon;
  label: string;
  value: string;
  tone: 'emerald' | 'rose';
}) {
  const toneMap: Record<typeof tone, string> = {
    emerald: 'border-emerald-200 bg-emerald-50/60 text-emerald-800',
    rose: 'border-rose-200 bg-rose-50/60 text-rose-800',
  };
  return (
    <div
      className={`card p-3 border ${toneMap[tone]}`}
      data-testid="counts-variance-card"
    >
      <div className="flex items-center gap-2 text-xs">
        <Icon size={14} />
        {label}
      </div>
      <div className="text-base font-black tabular-nums mt-1">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: CountStatus }) {
  return (
    <span
      className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full border ${STATUS_BADGE_CLASS[status]}`}
      data-testid="count-status-badge"
      data-status={status}
    >
      {COUNT_STATUS_LABELS_AR[status] || status}
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

// ─── Create modal ────────────────────────────────────────────────
function CreateCountModal({
  warehouses,
  onClose,
  onCreated,
}: {
  warehouses: Warehouse[];
  onClose: () => void;
  onCreated: (c: InventoryCount) => void;
}) {
  const [warehouseId, setWarehouseId] = useState('');
  const [notes, setNotes] = useState('');
  const [autoFreeze, setAutoFreeze] = useState(true);

  const createM = useMutation({
    mutationFn: async () => {
      const created = await inventoryCountsApi.create({
        warehouse_id: warehouseId,
        notes: notes || undefined,
      });
      if (autoFreeze) {
        return inventoryCountsApi.freeze(created.id, {});
      }
      return created;
    },
    onSuccess: (c) => {
      toast.success('تم إنشاء جلسة الجرد');
      onCreated(c);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإنشاء'),
  });

  const submit = () => {
    if (!warehouseId) {
      toast.error('اختر المخزن');
      return;
    }
    createM.mutate();
  };

  return (
    <Modal
      title="جرد جديد"
      onClose={onClose}
      testid="counts-create-modal"
    >
      <Field label="المخزن">
        <select
          className="input"
          value={warehouseId}
          onChange={(e) => setWarehouseId(e.target.value)}
          data-testid="counts-create-warehouse"
        >
          <option value="">اختر المخزن</option>
          {warehouses
            .filter((w) => w.is_active)
            .map((w) => (
              <option key={w.id} value={w.id}>
                {w.name_ar || w.code}
              </option>
            ))}
        </select>
      </Field>
      <Field label="ملاحظات (اختياري)">
        <textarea
          className="input"
          rows={2}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          data-testid="counts-create-notes"
        />
      </Field>
      <label className="flex items-center gap-2 text-xs text-slate-700">
        <input
          type="checkbox"
          checked={autoFreeze}
          onChange={(e) => setAutoFreeze(e.target.checked)}
          data-testid="counts-create-auto-freeze"
        />
        تجميد رصيد النظام فورًا (مفعّل افتراضيًا)
      </label>
      <div className="text-[11px] text-slate-500">
        نطاق الجرد (تصنيف/علامة/مجموعة/منتج محدد) سيُتاح لاحقًا — حاليًا يتم
        تجميد كل أصناف المخزن مرة واحدة.
      </div>
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
          data-testid="counts-create-submit"
        >
          {createM.isPending ? 'جاري الإنشاء…' : 'إنشاء الجرد'}
        </button>
      </div>
    </Modal>
  );
}

// ─── Detail drawer ───────────────────────────────────────────────
function CountDetailDrawer({
  countId,
  onClose,
}: {
  countId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: c, isLoading } = useQuery({
    queryKey: ['inventory-count', countId],
    queryFn: () => inventoryCountsApi.get(countId),
  });

  const [edits, setEdits] = useState<Record<string, number>>({});
  const [finalizeNotes, setFinalizeNotes] = useState('');

  useEffect(() => {
    resetInventoryFinalizeIdempotencyKey();
    return () => resetInventoryFinalizeIdempotencyKey();
  }, []);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['inventory-counts'] });
    qc.invalidateQueries({ queryKey: ['inventory-count', countId] });
  };

  const freezeM = useMutation({
    mutationFn: () => inventoryCountsApi.freeze(countId, {}),
    onSuccess: () => {
      toast.success('تم تجميد رصيد النظام');
      invalidate();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل التجميد'),
  });

  const saveCountsM = useMutation({
    mutationFn: (
      items: Array<{ item_id: string; counted_qty: number }>,
    ) => inventoryCountsApi.updateItems(countId, { items }),
    onSuccess: () => {
      toast.success('تم حفظ الكميات');
      setEdits({});
      invalidate();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  const reviewM = useMutation({
    mutationFn: () => inventoryCountsApi.review(countId),
    onSuccess: () => {
      toast.success('تم نقل الجرد إلى المراجعة');
      invalidate();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل النقل إلى المراجعة'),
  });

  const finalizeM = useMutation({
    mutationFn: (notes?: string) =>
      inventoryCountsApi.finalize(countId, notes),
    onSuccess: () => {
      toast.success('تم اعتماد الجرد وتطبيق الفروقات');
      setFinalizeNotes('');
      invalidate();
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الاعتماد'),
  });

  const cancelM = useMutation({
    mutationFn: (reason?: string) =>
      inventoryCountsApi.cancel(countId, { reason }),
    onSuccess: () => {
      toast.success('تم إلغاء الجرد');
      invalidate();
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإلغاء'),
  });

  if (isLoading || !c) {
    return (
      <Modal
        title="تفاصيل الجرد"
        onClose={onClose}
        wide
        testid="count-detail-modal"
      >
        <div className="p-6 text-center text-sm text-slate-400">
          جاري التحميل…
        </div>
      </Modal>
    );
  }

  const canFreeze = c.status === 'draft';
  const canEditItems =
    c.status === 'open' ||
    c.status === 'counting' ||
    c.status === 'in_progress';
  const canReview =
    c.status === 'counting' ||
    c.status === 'open' ||
    c.status === 'in_progress';
  const canFinalize =
    c.status === 'review' ||
    c.status === 'counting' ||
    c.status === 'in_progress';
  const canCancel =
    c.status !== 'finalized' &&
    c.status !== 'completed' &&
    c.status !== 'cancelled';

  const items = c.items ?? [];
  const itemCounted = (id: string, persisted: number | null) =>
    edits[id] !== undefined ? edits[id] : (persisted ?? null);

  const totals = (() => {
    let pos = 0;
    let neg = 0;
    let missing = 0;
    for (const it of items) {
      const cur = itemCounted(it.id, it.counted_qty);
      if (cur == null) {
        missing += 1;
        continue;
      }
      const diff = Number(cur) - Number(it.system_qty);
      if (diff > 0) pos += diff;
      if (diff < 0) neg += -diff;
    }
    return { pos, neg, missing };
  })();

  const submitCountsAndMaybeReview = () => {
    const toSave = Object.entries(edits)
      .filter(([_, v]) => v != null && !Number.isNaN(v))
      .map(([item_id, v]) => ({ item_id, counted_qty: Number(v) }));
    if (toSave.length === 0) {
      toast('لا توجد تعديلات لحفظها');
      return;
    }
    saveCountsM.mutate(toSave);
  };

  return (
    <Modal
      title={`جرد ${c.count_no}`}
      onClose={onClose}
      wide
      testid="count-detail-modal"
    >
      <div className="grid md:grid-cols-4 gap-2 text-xs">
        <MiniStat
          icon={<History size={14} className="text-indigo-600" />}
          title="الحالة"
          value={COUNT_STATUS_LABELS_AR[c.status] || c.status}
        />
        <MiniStat
          icon={<WarehouseIcon size={14} className="text-slate-600" />}
          title="المخزن"
          value={c.warehouse_name || '—'}
          sub={c.primary_branch?.name_ar || ''}
        />
        <MiniStat
          icon={<Clock size={14} className="text-amber-600" />}
          title="بدأ"
          value={fmtDate(c.started_at)}
          sub={c.started_by_name || ''}
        />
        <MiniStat
          icon={<CheckCircle2 size={14} className="text-emerald-600" />}
          title="انتهى"
          value={fmtDate(c.completed_at)}
          sub={c.completed_by_name || ''}
        />
      </div>

      <div
        className="grid md:grid-cols-3 gap-2 text-xs"
        data-testid="count-detail-variance"
      >
        <VarianceCard
          icon={TrendingUp}
          label="إجمالي الزيادة"
          value={fmtNumber(totals.pos)}
          tone="emerald"
        />
        <VarianceCard
          icon={TrendingDown}
          label="إجمالي النقص"
          value={fmtNumber(totals.neg)}
          tone="rose"
        />
        <div
          className="card p-3 border border-amber-200 bg-amber-50/60 text-amber-800"
          data-testid="count-detail-missing"
        >
          <div className="flex items-center gap-2 text-xs">
            <ListChecks size={14} />
            عناصر غير معدودة
          </div>
          <div className="text-base font-black tabular-nums mt-1">
            {fmtNumber(totals.missing)}
          </div>
        </div>
      </div>

      {c.notes && (
        <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs">
          <b>ملاحظات:</b> {c.notes}
        </div>
      )}

      {/* Items table */}
      <div
        className="card overflow-x-auto"
        data-testid="count-detail-items"
      >
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-xs text-slate-500">
            <tr>
              <th className="text-right px-3 py-2">المنتج</th>
              <th className="text-right px-3 py-2">SKU / باركود</th>
              <th className="text-right px-3 py-2">اللون / المقاس</th>
              <th className="text-left px-3 py-2">رصيد النظام</th>
              <th className="text-left px-3 py-2">
                {canEditItems ? 'الكمية الفعلية (إدخال)' : 'الكمية الفعلية'}
              </th>
              <th className="text-left px-3 py-2">الفرق</th>
              <th className="text-right px-3 py-2">ملاحظات</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {items.map((it) => {
              const persisted = it.counted_qty;
              const inputVal =
                edits[it.id] !== undefined ? edits[it.id] : persisted ?? '';
              const display =
                edits[it.id] !== undefined ? edits[it.id] : persisted;
              const diff =
                display == null
                  ? null
                  : Number(display) - Number(it.system_qty);
              return (
                <tr key={it.id} data-testid="count-detail-item-row">
                  <td className="px-3 py-2">
                    <div className="font-medium text-slate-800">
                      {it.product_name}
                    </div>
                    <div className="text-[10px] text-slate-400">
                      {it.product_sku}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-xs font-mono">
                    <div>{it.variant_sku}</div>
                    {it.barcode && (
                      <div className="text-[10px] text-slate-400">
                        {it.barcode}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-600">
                    {[it.color, it.size].filter(Boolean).join(' · ') || '—'}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums font-bold text-slate-800">
                    {fmtNumber(it.system_qty)}
                  </td>
                  <td className="px-3 py-2 text-left">
                    {canEditItems ? (
                      <input
                        type="number"
                        min={0}
                        className="input w-24"
                        value={inputVal as any}
                        onChange={(e) =>
                          setEdits((prev) => ({
                            ...prev,
                            [it.id]: Number(e.target.value),
                          }))
                        }
                        data-testid="count-detail-input"
                      />
                    ) : (
                      <span className="tabular-nums font-bold">
                        {persisted == null ? '—' : fmtNumber(persisted)}
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-left tabular-nums">
                    {diff == null ? (
                      <span className="text-slate-300">—</span>
                    ) : diff > 0 ? (
                      <span className="text-emerald-700 font-bold">
                        +{fmtNumber(diff)}
                      </span>
                    ) : diff < 0 ? (
                      <span className="text-rose-700 font-bold">
                        {fmtNumber(diff)}
                      </span>
                    ) : (
                      <span className="text-slate-500">0</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs text-slate-500">
                    {it.notes || '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Linked movements (read-only) */}
      {(c.movements?.length ?? 0) > 0 && (
        <div
          className="card overflow-x-auto"
          data-testid="count-detail-movements"
        >
          <div className="px-4 py-2 border-b border-slate-100 font-bold text-slate-800 text-xs flex items-center gap-2">
            <History size={13} className="text-indigo-600" />
            حركات المخزون الناتجة عن الاعتماد
          </div>
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-[10px] text-slate-500">
              <tr>
                <th className="text-right px-3 py-2">التاريخ</th>
                <th className="text-right px-3 py-2">المتغير</th>
                <th className="text-right px-3 py-2">الإجراء</th>
                <th className="text-left px-3 py-2">الكمية</th>
                <th className="text-left px-3 py-2">الرصيد بعدها</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(c.movements || []).map((m) => (
                <tr key={m.id} data-testid="count-detail-movement-row">
                  <td className="px-3 py-2 text-slate-500 whitespace-nowrap">
                    {fmtDate(m.created_at)}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {m.variant_sku || '—'}
                  </td>
                  <td className="px-3 py-2 text-slate-600">
                    {m.source_action || m.movement_type}
                  </td>
                  <td
                    className={`px-3 py-2 text-left tabular-nums font-bold ${
                      m.direction === 'in'
                        ? 'text-emerald-700'
                        : 'text-rose-700'
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

      {(canFinalize || canReview) && (
        <Field label="ملاحظات الاعتماد (اختياري)">
          <textarea
            className="input"
            rows={2}
            value={finalizeNotes}
            onChange={(e) => setFinalizeNotes(e.target.value)}
            data-testid="count-detail-finalize-notes"
          />
        </Field>
      )}

      {/* Action bar */}
      <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-slate-100">
        {canFreeze && (
          <button
            type="button"
            className="btn"
            onClick={() => freezeM.mutate()}
            disabled={freezeM.isPending}
            data-testid="count-action-freeze"
          >
            <Snowflake size={14} />
            تجميد رصيد النظام
          </button>
        )}
        {canEditItems && (
          <button
            type="button"
            className="btn"
            onClick={submitCountsAndMaybeReview}
            disabled={saveCountsM.isPending}
            data-testid="count-action-save"
          >
            <Save size={14} />
            حفظ الكميات
          </button>
        )}
        {canReview && (
          <button
            type="button"
            className="btn"
            onClick={() => reviewM.mutate()}
            disabled={reviewM.isPending}
            data-testid="count-action-review"
          >
            <ScrollText size={14} />
            نقل إلى المراجعة
          </button>
        )}
        {canFinalize && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              if (
                !confirm(
                  'تأكيد اعتماد الجرد؟ سيتم تطبيق الفروقات على المخزون.',
                )
              ) {
                return;
              }
              resetInventoryFinalizeIdempotencyKey();
              finalizeM.mutate(finalizeNotes || undefined);
            }}
            disabled={finalizeM.isPending}
            data-testid="count-action-finalize"
          >
            <ShieldCheck size={14} />
            اعتماد الجرد
          </button>
        )}
        {canCancel && (
          <button
            type="button"
            className="btn"
            onClick={() => {
              if (!confirm('تأكيد إلغاء الجرد؟')) return;
              cancelM.mutate(undefined);
            }}
            disabled={cancelM.isPending}
            data-testid="count-action-cancel"
          >
            <XCircle size={14} />
            إلغاء الجرد
          </button>
        )}
      </div>
    </Modal>
  );
}

// ─── Primitives ──────────────────────────────────────────────────
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
