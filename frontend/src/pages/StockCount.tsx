import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  ClipboardCheck,
  Plus,
  X,
  Save,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Warehouse as WarehouseIcon,
  Search,
} from 'lucide-react';
import { api, unwrap } from '@/api/client';
import {
  inventoryCountsApi,
  InventoryCount,
  CountItem,
  CountStatus,
} from '@/api/inventory-counts.api';

interface Warehouse {
  id: string;
  code: string;
  name_ar?: string;
  name?: string;
  is_active: boolean;
}

const warehousesApi = {
  list: () => unwrap<Warehouse[]>(api.get('/stock/warehouses')),
};

const fmtDate = (s?: string | null) =>
  s
    ? new Date(s).toLocaleString('en-US', {
        dateStyle: 'short',
        timeStyle: 'short',
      })
    : '—';

const STATUS_LABEL: Record<CountStatus, string> = {
  in_progress: 'جارٍ',
  completed: 'مكتمل',
  cancelled: 'ملغى',
};

const STATUS_COLOR: Record<CountStatus, string> = {
  in_progress: 'bg-amber-100 text-amber-700',
  completed: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-rose-100 text-rose-700',
};

export default function StockCount() {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [showStart, setShowStart] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const { data: counts = [], isLoading } = useQuery({
    queryKey: ['inventory-counts', statusFilter],
    queryFn: () =>
      inventoryCountsApi.list(
        statusFilter ? { status: statusFilter } : undefined,
      ),
  });

  const grouped = useMemo(() => {
    const c = { in_progress: 0, completed: 0, cancelled: 0, all: counts.length };
    for (const t of counts) c[t.status]++;
    return c;
  }, [counts]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <ClipboardCheck className="text-brand-600" /> الجرد الفعلي
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            تجميد أرصدة النظام، إدخال الكميات الفعلية، وتطبيق الفروقات تلقائياً
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowStart(true)}>
          <Plus size={18} /> جرد جديد
        </button>
      </div>

      {/* Status tabs */}
      <div className="flex flex-wrap gap-2">
        <TabBtn active={!statusFilter} onClick={() => setStatusFilter('')}>
          الكل <Badge>{grouped.all}</Badge>
        </TabBtn>
        <TabBtn
          active={statusFilter === 'in_progress'}
          onClick={() => setStatusFilter('in_progress')}
        >
          جارٍ <Badge>{grouped.in_progress}</Badge>
        </TabBtn>
        <TabBtn
          active={statusFilter === 'completed'}
          onClick={() => setStatusFilter('completed')}
        >
          مكتمل <Badge>{grouped.completed}</Badge>
        </TabBtn>
        <TabBtn
          active={statusFilter === 'cancelled'}
          onClick={() => setStatusFilter('cancelled')}
        >
          ملغى <Badge>{grouped.cancelled}</Badge>
        </TabBtn>
      </div>

      {/* Counts table */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-slate-400">جاري التحميل…</div>
        ) : counts.length === 0 ? (
          <div className="p-12 text-center">
            <ClipboardCheck
              className="mx-auto text-slate-300 mb-3"
              size={48}
            />
            <p className="text-slate-500">لا توجد عمليات جرد</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <Th>الرقم</Th>
                  <Th>المخزن</Th>
                  <Th>التقدم</Th>
                  <Th>عناصر بفروقات</Th>
                  <Th>إجمالي الفرق</Th>
                  <Th>تاريخ البدء</Th>
                  <Th>الحالة</Th>
                </tr>
              </thead>
              <tbody>
                {counts.map((c) => (
                  <tr
                    key={c.id}
                    className="border-t hover:bg-slate-50 cursor-pointer"
                    onClick={() => setSelectedId(c.id)}
                  >
                    <Td className="font-mono font-bold text-brand-700">
                      {c.count_no}
                    </Td>
                    <Td>{c.warehouse_name}</Td>
                    <Td>
                      <span className="font-bold">{c.items_counted ?? 0}</span>
                      <span className="text-slate-400">
                        {' '}
                        / {c.items_total ?? 0}
                      </span>
                    </Td>
                    <Td>
                      {(c.items_with_diff ?? 0) > 0 ? (
                        <span className="text-amber-700 font-bold inline-flex items-center gap-1">
                          <AlertTriangle size={14} /> {c.items_with_diff}
                        </span>
                      ) : (
                        <span className="text-slate-400">0</span>
                      )}
                    </Td>
                    <Td className="font-bold">{c.total_abs_diff ?? 0}</Td>
                    <Td className="text-slate-500">{fmtDate(c.started_at)}</Td>
                    <Td>
                      <span
                        className={`px-2 py-1 rounded-lg text-xs font-bold ${STATUS_COLOR[c.status]}`}
                      >
                        {STATUS_LABEL[c.status]}
                      </span>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showStart && <StartCountModal onClose={() => setShowStart(false)} />}
      {selectedId && (
        <CountDetailModal
          countId={selectedId}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

/* ---------------- Start Count Modal ---------------- */

function StartCountModal({ onClose }: { onClose: () => void }) {
  const [warehouseId, setWarehouseId] = useState('');
  const [notes, setNotes] = useState('');
  const qc = useQueryClient();

  const { data: warehouses = [] } = useQuery({
    queryKey: ['warehouses'],
    queryFn: warehousesApi.list,
  });

  const startM = useMutation({
    mutationFn: inventoryCountsApi.start,
    onSuccess: () => {
      toast.success('تم بدء الجرد');
      qc.invalidateQueries({ queryKey: ['inventory-counts'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل بدء الجرد'),
  });

  return (
    <Modal title="بدء جرد جديد" onClose={onClose}>
      <Field label="المخزن">
        <select
          className="input"
          value={warehouseId}
          onChange={(e) => setWarehouseId(e.target.value)}
        >
          <option value="">اختر المخزن</option>
          {warehouses.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name_ar || w.name || w.code}
            </option>
          ))}
        </select>
      </Field>

      <Field label="ملاحظات (اختياري)">
        <textarea
          className="input"
          rows={3}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>

      <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
        ⚠️ سيتم تجميد كميات النظام الحالية لكل الأصناف في هذا المخزن كقاعدة للمقارنة.
      </div>

      <div className="flex gap-2 justify-end pt-2">
        <button className="btn-ghost" onClick={onClose}>
          إلغاء
        </button>
        <button
          className="btn-primary"
          disabled={!warehouseId || startM.isPending}
          onClick={() =>
            startM.mutate({
              warehouse_id: warehouseId,
              notes: notes || undefined,
            })
          }
        >
          {startM.isPending ? 'جاري البدء…' : 'بدء الجرد'}
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- Count Detail / Entry Modal ---------------- */

function CountDetailModal({
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

  const [entries, setEntries] = useState<Record<string, number>>({});
  const [search, setSearch] = useState('');
  const [showOnlyDiff, setShowOnlyDiff] = useState(false);

  const submitM = useMutation({
    mutationFn: (payload: any) =>
      inventoryCountsApi.submitEntries(countId, payload),
    onSuccess: () => {
      toast.success('تم حفظ الكميات');
      qc.invalidateQueries({ queryKey: ['inventory-count', countId] });
      qc.invalidateQueries({ queryKey: ['inventory-counts'] });
      setEntries({});
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  const finalizeM = useMutation({
    mutationFn: () => inventoryCountsApi.finalize(countId),
    onSuccess: () => {
      toast.success('تم إنهاء الجرد وتطبيق الفروقات');
      qc.invalidateQueries({ queryKey: ['inventory-counts'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإنهاء'),
  });

  const cancelM = useMutation({
    mutationFn: () => inventoryCountsApi.cancel(countId),
    onSuccess: () => {
      toast.success('تم إلغاء الجرد');
      qc.invalidateQueries({ queryKey: ['inventory-counts'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإلغاء'),
  });

  const items = useMemo(() => c?.items || [], [c]);

  const filteredItems = useMemo(
    () =>
      items.filter((it: any) => {
        if (search) {
          const s = search.toLowerCase();
          if (
            !it.product_name?.toLowerCase().includes(s) &&
            !it.variant_sku?.toLowerCase().includes(s)
          )
            return false;
        }
        if (showOnlyDiff) {
          const current =
            entries[it.id] !== undefined ? entries[it.id] : it.counted_qty;
          if (current === null || current === undefined) return true;
          if (Number(current) === Number(it.system_qty)) return false;
        }
        return true;
      }),
    [items, search, showOnlyDiff, entries],
  );

  const totals = useMemo(() => {
    let counted = 0,
      withDiff = 0,
      totalAbs = 0;
    for (const it of items) {
      const cur =
        entries[it.id] !== undefined ? entries[it.id] : it.counted_qty;
      if (cur !== null && cur !== undefined) {
        counted++;
        const diff = Number(cur) - Number(it.system_qty);
        if (diff !== 0) {
          withDiff++;
          totalAbs += Math.abs(diff);
        }
      }
    }
    return { counted, total: items.length, withDiff, totalAbs };
  }, [items, entries]);

  if (isLoading || !c) {
    return (
      <Modal title="تفاصيل الجرد" onClose={onClose} wide>
        <div className="p-8 text-center text-slate-400">جاري التحميل…</div>
      </Modal>
    );
  }

  const editable = c.status === 'in_progress';

  const saveEntries = () => {
    const list = Object.entries(entries).map(([item_id, counted_qty]) => ({
      item_id,
      counted_qty,
    }));
    if (list.length === 0) {
      toast('لا توجد تعديلات لحفظها');
      return;
    }
    submitM.mutate({ items: list });
  };

  return (
    <Modal title={`جرد ${c.count_no}`} onClose={onClose} wide>
      <div className="grid md:grid-cols-4 gap-3">
        <MiniStat
          icon={<WarehouseIcon className="text-brand-600" />}
          title="المخزن"
          value={c.warehouse_name || '—'}
        />
        <MiniStat
          icon={<ClipboardCheck className="text-emerald-600" />}
          title="التقدم"
          value={`${totals.counted} / ${totals.total}`}
        />
        <MiniStat
          icon={<AlertTriangle className="text-amber-600" />}
          title="عناصر بفروقات"
          value={String(totals.withDiff)}
        />
        <MiniStat
          icon={<Clock className="text-slate-600" />}
          title="تاريخ البدء"
          value={fmtDate(c.started_at)}
        />
      </div>

      {/* Filters */}
      {editable && (
        <div className="flex gap-2 items-center flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search
              size={16}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400"
            />
            <input
              className="input pr-10"
              placeholder="بحث بالصنف أو SKU…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input
              type="checkbox"
              checked={showOnlyDiff}
              onChange={(e) => setShowOnlyDiff(e.target.checked)}
            />
            الفروقات فقط
          </label>
        </div>
      )}

      {/* Items table */}
      <div className="card p-0 overflow-hidden max-h-[400px] overflow-y-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 sticky top-0">
            <tr>
              <Th>الصنف</Th>
              <Th>SKU</Th>
              <Th>كمية النظام</Th>
              <Th>الكمية الفعلية</Th>
              <Th>الفرق</Th>
            </tr>
          </thead>
          <tbody>
            {filteredItems.map((it: CountItem) => {
              const current =
                entries[it.id] !== undefined ? entries[it.id] : it.counted_qty;
              const diff =
                current !== null && current !== undefined
                  ? Number(current) - Number(it.system_qty)
                  : null;
              return (
                <tr key={it.id} className="border-t">
                  <Td>
                    <div className="font-bold">{it.product_name}</div>
                    <div className="text-xs text-slate-500">
                      {it.color} {it.size}
                    </div>
                  </Td>
                  <Td className="font-mono text-xs">{it.variant_sku}</Td>
                  <Td className="font-bold">{it.system_qty}</Td>
                  <Td>
                    {editable ? (
                      <input
                        type="number"
                        min={0}
                        className="input w-20 py-1"
                        value={current ?? ''}
                        onChange={(e) => {
                          const v = e.target.value;
                          setEntries({
                            ...entries,
                            [it.id]: v === '' ? (null as any) : Number(v),
                          });
                        }}
                      />
                    ) : (
                      <span className="font-bold">{it.counted_qty ?? '—'}</span>
                    )}
                  </Td>
                  <Td>
                    {diff === null ? (
                      <span className="text-slate-400">—</span>
                    ) : diff === 0 ? (
                      <span className="text-emerald-600 inline-flex items-center gap-1">
                        <CheckCircle2 size={14} /> مطابق
                      </span>
                    ) : diff > 0 ? (
                      <span className="text-emerald-700 font-bold">
                        +{diff}
                      </span>
                    ) : (
                      <span className="text-rose-700 font-bold">{diff}</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editable && (
        <div className="flex gap-2 justify-between items-center pt-2 flex-wrap">
          <button
            className="btn-ghost text-rose-600"
            onClick={() => {
              if (confirm('تأكيد إلغاء الجرد؟')) cancelM.mutate();
            }}
            disabled={cancelM.isPending}
          >
            <XCircle size={16} /> إلغاء الجرد
          </button>
          <div className="flex gap-2">
            <button
              className="btn-ghost"
              onClick={saveEntries}
              disabled={submitM.isPending}
            >
              <Save size={16} /> حفظ مسودة
            </button>
            <button
              className="btn-primary"
              onClick={() => {
                if (
                  confirm(
                    `سيتم تطبيق ${totals.withDiff} فرق على المخزون. هل أنت متأكد؟`,
                  )
                ) {
                  finalizeM.mutate();
                }
              }}
              disabled={finalizeM.isPending}
            >
              <CheckCircle2 size={16} />{' '}
              {finalizeM.isPending ? 'جاري الإنهاء…' : 'إنهاء وتطبيق الفروقات'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

/* ---------------- Primitives ---------------- */

function Modal({
  title,
  onClose,
  wide,
  children,
}: {
  title: string;
  onClose: () => void;
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div
        className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? 'max-w-5xl' : 'max-w-xl'} my-8`}
      >
        <div className="flex items-center justify-between p-4 border-b">
          <h3 className="text-lg font-bold">{title}</h3>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-slate-100"
          >
            <X size={18} />
          </button>
        </div>
        <div className="p-4 space-y-3">{children}</div>
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
    <div>
      <label className="block text-sm font-bold text-slate-700 mb-1">
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
}: {
  icon: React.ReactNode;
  title: string;
  value: string;
}) {
  return (
    <div className="card p-3 flex items-center gap-3">
      <div className="p-2 bg-slate-50 rounded-lg">{icon}</div>
      <div className="flex-1 min-w-0">
        <div className="text-xs text-slate-500">{title}</div>
        <div className="font-bold text-sm truncate">{value}</div>
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      className={`px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2 ${
        active
          ? 'bg-brand-600 text-white shadow'
          : 'bg-white text-slate-700 hover:bg-slate-50'
      }`}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span className="bg-white/20 text-xs px-1.5 py-0.5 rounded-md">
      {children}
    </span>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return <th className="text-right font-bold text-xs p-3">{children}</th>;
}
function Td({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <td className={`p-3 ${className}`}>{children}</td>;
}
