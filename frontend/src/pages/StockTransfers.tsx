import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Shuffle,
  Plus,
  Search,
  X,
  Truck,
  Package,
  CheckCircle2,
  XCircle,
  Clock,
  ArrowLeftRight,
  Warehouse as WarehouseIcon,
} from 'lucide-react';
import { api, unwrap } from '@/api/client';
import {
  stockTransfersApi,
  StockTransfer,
  TransferStatus,
} from '@/api/stock-transfers.api';

interface Warehouse {
  id: string;
  code: string;
  name_ar?: string;
  name?: string;
  is_active: boolean;
}

interface VariantSearch {
  variant_id: string;
  product_name: string;
  sku: string;
  color?: string;
  size?: string;
}

const warehousesApi = {
  list: () => unwrap<Warehouse[]>(api.get('/stock/warehouses')),
};

const fmtDate = (s?: string | null) =>
  s ? new Date(s).toLocaleString('en-US', { dateStyle: 'short', timeStyle: 'short' }) : '—';

const STATUS_LABEL: Record<TransferStatus, string> = {
  draft: 'مسودة',
  in_transit: 'في الطريق',
  received: 'مستلم',
  cancelled: 'ملغى',
};

const STATUS_COLOR: Record<TransferStatus, string> = {
  draft: 'bg-slate-100 text-slate-700',
  in_transit: 'bg-amber-100 text-amber-700',
  received: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-rose-100 text-rose-700',
};

export default function StockTransfers() {
  const [statusFilter, setStatusFilter] = useState<string>('');
  const [showCreate, setShowCreate] = useState(false);
  const [selected, setSelected] = useState<StockTransfer | null>(null);
  const qc = useQueryClient();

  const { data: transfers = [], isLoading } = useQuery({
    queryKey: ['stock-transfers', statusFilter],
    queryFn: () =>
      stockTransfersApi.list(
        statusFilter ? { status: statusFilter } : undefined,
      ),
  });

  const counts = useMemo(() => {
    const c = { draft: 0, in_transit: 0, received: 0, cancelled: 0, all: transfers.length };
    for (const t of transfers) c[t.status as TransferStatus]++;
    return c;
  }, [transfers]);

  const shipM = useMutation({
    mutationFn: (id: string) => stockTransfersApi.ship(id),
    onSuccess: () => {
      toast.success('تم شحن التحويل وخصم المخزون');
      qc.invalidateQueries({ queryKey: ['stock-transfers'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الشحن'),
  });

  const cancelM = useMutation({
    mutationFn: (id: string) => stockTransfersApi.cancel(id),
    onSuccess: () => {
      toast.success('تم إلغاء التحويل');
      qc.invalidateQueries({ queryKey: ['stock-transfers'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإلغاء'),
  });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Shuffle className="text-brand-600" /> التحويلات بين المخازن
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            نقل البضاعة من مخزن إلى آخر مع تتبع الحالة
          </p>
        </div>
        <button className="btn-primary" onClick={() => setShowCreate(true)}>
          <Plus size={18} /> تحويل جديد
        </button>
      </div>

      {/* Status tabs */}
      <div className="flex flex-wrap gap-2">
        <TabBtn active={!statusFilter} onClick={() => setStatusFilter('')}>
          الكل <Badge>{counts.all}</Badge>
        </TabBtn>
        <TabBtn
          active={statusFilter === 'draft'}
          onClick={() => setStatusFilter('draft')}
        >
          مسودات <Badge>{counts.draft}</Badge>
        </TabBtn>
        <TabBtn
          active={statusFilter === 'in_transit'}
          onClick={() => setStatusFilter('in_transit')}
        >
          في الطريق <Badge>{counts.in_transit}</Badge>
        </TabBtn>
        <TabBtn
          active={statusFilter === 'received'}
          onClick={() => setStatusFilter('received')}
        >
          مستلم <Badge>{counts.received}</Badge>
        </TabBtn>
        <TabBtn
          active={statusFilter === 'cancelled'}
          onClick={() => setStatusFilter('cancelled')}
        >
          ملغى <Badge>{counts.cancelled}</Badge>
        </TabBtn>
      </div>

      {/* Transfers table */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-slate-400">جاري التحميل…</div>
        ) : transfers.length === 0 ? (
          <div className="p-12 text-center">
            <Shuffle className="mx-auto text-slate-300 mb-3" size={48} />
            <p className="text-slate-500">لا توجد تحويلات</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  <Th>الرقم</Th>
                  <Th>من</Th>
                  <Th>إلى</Th>
                  <Th>عدد الأصناف</Th>
                  <Th>إجمالي الكمية</Th>
                  <Th>تاريخ الإنشاء</Th>
                  <Th>الحالة</Th>
                  <Th>إجراءات</Th>
                </tr>
              </thead>
              <tbody>
                {transfers.map((t) => (
                  <tr
                    key={t.id}
                    className="border-t hover:bg-slate-50 cursor-pointer"
                    onClick={() => setSelected(t)}
                  >
                    <Td className="font-mono font-bold text-brand-700">
                      {t.transfer_no}
                    </Td>
                    <Td>{t.from_warehouse_name}</Td>
                    <Td>{t.to_warehouse_name}</Td>
                    <Td>{t.items_count ?? '—'}</Td>
                    <Td className="font-bold">{t.total_qty ?? '—'}</Td>
                    <Td className="text-slate-500">{fmtDate(t.created_at)}</Td>
                    <Td>
                      <span
                        className={`px-2 py-1 rounded-lg text-xs font-bold ${STATUS_COLOR[t.status]}`}
                      >
                        {STATUS_LABEL[t.status]}
                      </span>
                    </Td>
                    <Td>
                      <div
                        className="flex gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {t.status === 'draft' && (
                          <button
                            className="p-1.5 rounded-lg hover:bg-amber-100 text-amber-700"
                            title="شحن"
                            onClick={() => shipM.mutate(t.id)}
                            disabled={shipM.isPending}
                          >
                            <Truck size={16} />
                          </button>
                        )}
                        {t.status === 'in_transit' && (
                          <button
                            className="p-1.5 rounded-lg hover:bg-emerald-100 text-emerald-700"
                            title="استلام"
                            onClick={() => setSelected(t)}
                          >
                            <Package size={16} />
                          </button>
                        )}
                        {(t.status === 'draft' ||
                          t.status === 'in_transit') && (
                          <button
                            className="p-1.5 rounded-lg hover:bg-rose-100 text-rose-700"
                            title="إلغاء"
                            onClick={() => {
                              if (confirm('تأكيد إلغاء التحويل؟')) {
                                cancelM.mutate(t.id);
                              }
                            }}
                          >
                            <XCircle size={16} />
                          </button>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showCreate && <CreateTransferModal onClose={() => setShowCreate(false)} />}
      {selected && (
        <TransferDetailModal
          transferId={selected.id}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  );
}

/* ---------------- Create Modal ---------------- */

function CreateTransferModal({ onClose }: { onClose: () => void }) {
  const [fromWh, setFromWh] = useState('');
  const [toWh, setToWh] = useState('');
  const [notes, setNotes] = useState('');
  const [items, setItems] = useState<
    Array<{ variant_id: string; product_name: string; sku: string; quantity_requested: number }>
  >([]);
  const [searchTerm, setSearchTerm] = useState('');
  const qc = useQueryClient();

  const { data: warehouses = [] } = useQuery({
    queryKey: ['warehouses'],
    queryFn: warehousesApi.list,
  });

  const { data: searchResults = [] } = useQuery({
    queryKey: ['variant-search', searchTerm],
    queryFn: async () => {
      if (!searchTerm || searchTerm.length < 2) return [] as VariantSearch[];
      try {
        const res = await unwrap<{ data: any[] }>(
          api.get('/products', { params: { q: searchTerm, limit: 10 } }),
        );
        const out: VariantSearch[] = [];
        for (const p of res.data || []) {
          // try to fetch variants if not included
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
      toast.success('تم إنشاء التحويل');
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
    if (fromWh === toWh) return toast.error('المخزنين يجب أن يكونا مختلفين');
    if (items.length === 0) return toast.error('أضف صنفاً واحداً على الأقل');
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
    <Modal title="تحويل مخزني جديد" onClose={onClose} wide>
      <div className="grid md:grid-cols-2 gap-4">
        <Field label="من مخزن">
          <select
            className="input"
            value={fromWh}
            onChange={(e) => setFromWh(e.target.value)}
          >
            <option value="">اختر المصدر</option>
            {warehouses.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name_ar || w.name || w.code}
              </option>
            ))}
          </select>
        </Field>
        <Field label="إلى مخزن">
          <select
            className="input"
            value={toWh}
            onChange={(e) => setToWh(e.target.value)}
          >
            <option value="">اختر الوجهة</option>
            {warehouses
              .filter((w) => w.id !== fromWh)
              .map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name_ar || w.name || w.code}
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
        />
      </Field>

      <Field label="بحث وإضافة أصناف">
        <div className="relative">
          <input
            className="input"
            placeholder="ابحث باسم المنتج أو الباركود…"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
          {searchResults.length > 0 && searchTerm && (
            <div className="absolute z-10 left-0 right-0 top-full mt-1 bg-white border border-slate-200 rounded-xl shadow-lg max-h-60 overflow-y-auto">
              {searchResults.map((v) => (
                <div
                  key={v.variant_id}
                  className="p-2 hover:bg-brand-50 cursor-pointer text-sm"
                  onClick={() => addItem(v)}
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
        <div className="card p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600">
              <tr>
                <Th>الصنف</Th>
                <Th>SKU</Th>
                <Th>الكمية</Th>
                <Th></Th>
              </tr>
            </thead>
            <tbody>
              {items.map((it, idx) => (
                <tr key={it.variant_id} className="border-t">
                  <Td>{it.product_name}</Td>
                  <Td className="font-mono text-xs">{it.sku}</Td>
                  <Td>
                    <input
                      type="number"
                      min={1}
                      className="input w-24 py-1"
                      value={it.quantity_requested}
                      onChange={(e) => {
                        const v = [...items];
                        v[idx].quantity_requested = Number(e.target.value) || 0;
                        setItems(v);
                      }}
                    />
                  </Td>
                  <Td>
                    <button
                      className="p-1 text-rose-600 hover:bg-rose-50 rounded"
                      onClick={() =>
                        setItems(items.filter((_, i) => i !== idx))
                      }
                    >
                      <X size={16} />
                    </button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex gap-2 justify-end pt-2">
        <button className="btn-ghost" onClick={onClose}>
          إلغاء
        </button>
        <button
          className="btn-primary"
          disabled={createM.isPending}
          onClick={submit}
        >
          {createM.isPending ? 'جاري الحفظ…' : 'حفظ كمسودة'}
        </button>
      </div>
    </Modal>
  );
}

/* ---------------- Detail + Receive Modal ---------------- */

function TransferDetailModal({
  transferId,
  onClose,
}: {
  transferId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: t, isLoading } = useQuery({
    queryKey: ['transfer', transferId],
    queryFn: () => stockTransfersApi.get(transferId),
  });

  const [receipts, setReceipts] = useState<Record<string, number>>({});
  const [notes, setNotes] = useState('');

  const receiveM = useMutation({
    mutationFn: (payload: any) =>
      stockTransfersApi.receive(transferId, payload),
    onSuccess: () => {
      toast.success('تم استلام التحويل وإضافة المخزون');
      qc.invalidateQueries({ queryKey: ['stock-transfers'] });
      qc.invalidateQueries({ queryKey: ['transfer', transferId] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الاستلام'),
  });

  if (isLoading || !t) {
    return (
      <Modal title="تفاصيل التحويل" onClose={onClose} wide>
        <div className="p-8 text-center text-slate-400">جاري التحميل…</div>
      </Modal>
    );
  }

  const canReceive = t.status === 'in_transit';

  const submitReceive = () => {
    const itemsPayload = (t.items || []).map((it) => ({
      item_id: it.id,
      quantity_received:
        receipts[it.id] !== undefined
          ? receipts[it.id]
          : it.quantity_requested,
    }));
    receiveM.mutate({ items: itemsPayload, notes: notes || undefined });
  };

  return (
    <Modal
      title={`تحويل ${t.transfer_no}`}
      onClose={onClose}
      wide
    >
      <div className="grid md:grid-cols-4 gap-3">
        <MiniStat
          icon={<ArrowLeftRight className="text-brand-600" />}
          title="الحالة"
          value={STATUS_LABEL[t.status]}
        />
        <MiniStat
          icon={<WarehouseIcon className="text-slate-600" />}
          title="من"
          value={t.from_warehouse_name || '—'}
        />
        <MiniStat
          icon={<WarehouseIcon className="text-emerald-600" />}
          title="إلى"
          value={t.to_warehouse_name || '—'}
        />
        <MiniStat
          icon={<Clock className="text-amber-600" />}
          title="تاريخ الشحن"
          value={fmtDate(t.shipped_at)}
        />
      </div>

      {t.notes && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm">
          <b>ملاحظات:</b> {t.notes}
        </div>
      )}

      <div className="card p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <Th>الصنف</Th>
              <Th>SKU</Th>
              <Th>المطلوب</Th>
              <Th>{canReceive ? 'الكمية المستلمة' : 'المستلم'}</Th>
              <Th>الفرق</Th>
            </tr>
          </thead>
          <tbody>
            {(t.items || []).map((it) => {
              const received = canReceive
                ? receipts[it.id] ?? it.quantity_requested
                : it.quantity_received;
              const diff = it.quantity_requested - received;
              return (
                <tr key={it.id} className="border-t">
                  <Td>
                    <div className="font-bold">{it.product_name}</div>
                    <div className="text-xs text-slate-500">
                      {it.color} {it.size}
                    </div>
                  </Td>
                  <Td className="font-mono text-xs">{it.variant_sku}</Td>
                  <Td className="font-bold">{it.quantity_requested}</Td>
                  <Td>
                    {canReceive ? (
                      <input
                        type="number"
                        min={0}
                        max={it.quantity_requested}
                        className="input w-20 py-1"
                        value={receipts[it.id] ?? it.quantity_requested}
                        onChange={(e) =>
                          setReceipts({
                            ...receipts,
                            [it.id]: Number(e.target.value) || 0,
                          })
                        }
                      />
                    ) : (
                      <span className="font-bold">{received}</span>
                    )}
                  </Td>
                  <Td>
                    {diff === 0 ? (
                      <span className="text-emerald-600 inline-flex items-center gap-1">
                        <CheckCircle2 size={14} /> مطابق
                      </span>
                    ) : diff > 0 ? (
                      <span className="text-rose-600">عجز {diff}</span>
                    ) : (
                      <span className="text-amber-600">زيادة {-diff}</span>
                    )}
                  </Td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {canReceive && (
        <>
          <Field label="ملاحظات الاستلام (اختياري)">
            <textarea
              className="input"
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </Field>
          <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-800">
            ⚠️ سيتم إضافة الكميات المستلمة إلى مخزن الوجهة، وإعادة أي عجز إلى المخزن المصدر تلقائياً.
          </div>
          <div className="flex gap-2 justify-end">
            <button className="btn-ghost" onClick={onClose}>
              إغلاق
            </button>
            <button
              className="btn-primary"
              disabled={receiveM.isPending}
              onClick={submitReceive}
            >
              {receiveM.isPending ? 'جاري الاستلام…' : 'تأكيد الاستلام'}
            </button>
          </div>
        </>
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
        className={`bg-white rounded-2xl shadow-2xl w-full ${wide ? 'max-w-4xl' : 'max-w-xl'} my-8`}
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

function Th({ children }: { children?: React.ReactNode }) {
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
