import { useState, useMemo } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Clock,
  Play,
  Square,
  X,
  DollarSign,
  TrendingUp,
  TrendingDown,
  FileText,
  Calculator,
  RefreshCw,
} from 'lucide-react';
import { shiftsApi, Shift, OpenShiftPayload } from '@/api/shifts.api';
import { cashDeskApi } from '@/api/cash-desk.api';

const EGP = (n: number | string) =>
  `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;

const DEFAULT_WAREHOUSE_ID = import.meta.env.VITE_DEFAULT_WAREHOUSE_ID as string;

export default function Shifts() {
  const [showOpen, setShowOpen] = useState(false);
  const [closeTarget, setCloseTarget] = useState<Shift | null>(null);
  const [detail, setDetail] = useState<Shift | null>(null);
  const [statusFilter, setStatusFilter] = useState<'' | 'open' | 'closed'>('');
  const qc = useQueryClient();

  const { data: current } = useQuery({
    queryKey: ['shift-current'],
    queryFn: shiftsApi.current,
  });

  const { data: shifts = [], isLoading } = useQuery({
    queryKey: ['shifts', statusFilter],
    queryFn: () =>
      shiftsApi.list({ status: statusFilter || undefined }),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
            <Clock className="text-brand-600" /> الورديات
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            فتح وإغلاق ورديات الكاشير مع احتساب الفروقات
          </p>
        </div>

        <div className="flex gap-2">
          {current ? (
            <>
              <div className="chip bg-emerald-100 text-emerald-700 font-bold">
                وردية نشطة: {current.shift_no}
              </div>
              <button
                className="btn-primary bg-rose-600 hover:bg-rose-700"
                onClick={() => setCloseTarget(current)}
              >
                <Square size={16} /> إغلاق الوردية
              </button>
            </>
          ) : (
            <button className="btn-primary" onClick={() => setShowOpen(true)}>
              <Play size={16} /> فتح وردية جديدة
            </button>
          )}
        </div>
      </div>

      {/* Current shift summary */}
      {current && <CurrentShiftCard shift={current} />}

      {/* Filter */}
      <div className="card p-4">
        <div className="flex items-center gap-2">
          {(['', 'open', 'closed'] as const).map((s) => (
            <button
              key={s || 'all'}
              onClick={() => setStatusFilter(s)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold ${
                statusFilter === s
                  ? 'bg-brand-600 text-white'
                  : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              {s === '' ? 'الكل' : s === 'open' ? 'مفتوحة' : 'مغلقة'}
            </button>
          ))}
        </div>
      </div>

      {/* List */}
      <div className="card overflow-hidden">
        {isLoading ? (
          <div className="text-center py-12 text-slate-400">
            <RefreshCw className="animate-spin mx-auto mb-2" /> جارٍ التحميل...
          </div>
        ) : !shifts.length ? (
          <div className="text-center py-12 text-slate-400">لا توجد ورديات</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead className="bg-slate-50/60 text-slate-600 text-xs font-bold">
                <tr>
                  <th className="text-right px-3 py-2">رقم الوردية</th>
                  <th className="text-right px-3 py-2">الكاشير</th>
                  <th className="text-right px-3 py-2">الخزينة</th>
                  <th className="text-right px-3 py-2">الفتح</th>
                  <th className="text-right px-3 py-2">الإغلاق</th>
                  <th className="text-right px-3 py-2">المبيعات</th>
                  <th className="text-right px-3 py-2">الفرق</th>
                  <th className="text-right px-3 py-2">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {shifts.map((s) => (
                  <tr
                    key={s.id}
                    className="border-t border-slate-100 hover:bg-slate-50/60 cursor-pointer"
                    onClick={async () => {
                      const full = await shiftsApi.get(s.id);
                      setDetail(full);
                    }}
                  >
                    <td className="px-3 py-2 font-mono font-bold text-brand-700">
                      {s.shift_no}
                    </td>
                    <td className="px-3 py-2">{s.opened_by_name || '—'}</td>
                    <td className="px-3 py-2 text-xs text-slate-600">
                      {s.cashbox_name || '—'}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {new Date(s.opened_at).toLocaleString('en-US')}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {s.closed_at
                        ? new Date(s.closed_at).toLocaleString('en-US')
                        : '—'}
                    </td>
                    <td className="px-3 py-2 font-bold text-emerald-700">
                      {EGP(s.total_sales)}
                    </td>
                    <td className="px-3 py-2 font-bold">
                      {s.status === 'closed' ? (
                        <DiffBadge value={Number(s.difference)} />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={s.status} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {showOpen && (
        <OpenShiftModal
          onClose={() => setShowOpen(false)}
          onSuccess={() => {
            setShowOpen(false);
            qc.invalidateQueries({ queryKey: ['shift-current'] });
            qc.invalidateQueries({ queryKey: ['shifts'] });
          }}
        />
      )}

      {closeTarget && (
        <CloseShiftModal
          shift={closeTarget}
          onClose={() => setCloseTarget(null)}
          onSuccess={() => {
            setCloseTarget(null);
            qc.invalidateQueries({ queryKey: ['shift-current'] });
            qc.invalidateQueries({ queryKey: ['shifts'] });
          }}
        />
      )}

      {detail && <ShiftDetailModal shift={detail} onClose={() => setDetail(null)} />}
    </div>
  );
}

function CurrentShiftCard({ shift }: { shift: Shift }) {
  return (
    <div className="card p-5 border-2 border-emerald-200 bg-emerald-50/40">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="font-black text-slate-800">وردية نشطة</div>
          <div className="text-xs text-slate-500 font-mono">{shift.shift_no}</div>
        </div>
        <div className="text-xs text-slate-500">
          منذ {new Date(shift.opened_at).toLocaleString('en-US')}
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="رصيد افتتاحي" value={EGP(shift.opening_balance)} />
        <Stat label="خزينة" value={shift.cashbox_name || '—'} small />
        <Stat label="مخزن" value={shift.warehouse_name || '—'} small />
        <Stat label="حالة" value="مفتوحة" color="text-emerald-600" />
      </div>
    </div>
  );
}

function Stat({
  label,
  value,
  color,
  small,
}: {
  label: string;
  value: string;
  color?: string;
  small?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`font-black ${small ? 'text-sm' : 'text-xl'} ${color || 'text-slate-800'}`}>
        {value}
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const cls =
    status === 'open'
      ? 'bg-emerald-100 text-emerald-700'
      : 'bg-slate-100 text-slate-700';
  const label = status === 'open' ? 'مفتوحة' : 'مغلقة';
  return <span className={`chip ${cls}`}>{label}</span>;
}

function DiffBadge({ value }: { value: number }) {
  if (Math.abs(value) < 0.01) {
    return <span className="text-emerald-600">مطابقة ✓</span>;
  }
  if (value > 0) {
    return <span className="text-emerald-700">زيادة {EGP(value)}</span>;
  }
  return <span className="text-rose-700">عجز {EGP(Math.abs(value))}</span>;
}

// ─── Modals ──────────────────────────────────────────────────────────────

function Modal({
  title,
  onClose,
  children,
  size = 'md',
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  size?: 'md' | 'lg';
}) {
  const w = size === 'lg' ? 'max-w-3xl' : 'max-w-xl';
  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className={`bg-white rounded-2xl w-full ${w} max-h-[90vh] overflow-y-auto`}>
        <div className="flex items-center justify-between p-5 border-b border-slate-100 sticky top-0 bg-white z-10">
          <h3 className="font-black text-lg text-slate-800">{title}</h3>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            <X size={20} />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

function OpenShiftModal({
  onClose,
  onSuccess,
}: {
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [cashboxId, setCashboxId] = useState('');
  const [openingBalance, setOpeningBalance] = useState('');
  const [notes, setNotes] = useState('');

  const { data: cashboxes = [] } = useQuery({
    queryKey: ['cashboxes'],
    queryFn: cashDeskApi.cashboxes,
  });

  const mutation = useMutation({
    mutationFn: (p: OpenShiftPayload) => shiftsApi.open(p),
    onSuccess: () => {
      toast.success('تم فتح الوردية');
      onSuccess();
    },
  });

  return (
    <Modal title="فتح وردية جديدة" onClose={onClose}>
      <div className="space-y-3">
        <Field label="الخزينة">
          <select
            className="input"
            value={cashboxId}
            onChange={(e) => setCashboxId(e.target.value)}
          >
            <option value="">-- اختر --</option>
            {cashboxes.map((cb) => (
              <option key={cb.id} value={cb.id}>
                {cb.name} ({EGP(cb.current_balance)})
              </option>
            ))}
          </select>
        </Field>

        <Field label="الرصيد الافتتاحي (نقدية في الدرج)">
          <input
            type="number"
            step="0.01"
            className="input"
            value={openingBalance}
            onChange={(e) => setOpeningBalance(e.target.value)}
            placeholder="0.00"
            autoFocus
          />
        </Field>

        <Field label="ملاحظات">
          <textarea
            rows={2}
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        <div className="flex gap-2 pt-2">
          <button
            className="btn-primary flex-1"
            disabled={mutation.isPending}
            onClick={() => {
              if (!cashboxId) return toast.error('اختر الخزينة');
              // Derive warehouse from the selected cashbox — every cashbox
              // belongs to exactly one warehouse. Fallback to env var then
              // to the first known warehouse id.
              const cb = cashboxes.find((x: any) => x.id === cashboxId);
              const warehouseId =
                cb?.warehouse_id ||
                DEFAULT_WAREHOUSE_ID ||
                (cashboxes[0] as any)?.warehouse_id;
              if (!warehouseId) {
                return toast.error(
                  'تعذّر تحديد الفرع — راجع بيانات الخزينة',
                );
              }
              mutation.mutate({
                cashbox_id: cashboxId,
                warehouse_id: warehouseId,
                opening_balance: Number(openingBalance) || 0,
                notes: notes || undefined,
              });
            }}
          >
            <Play size={18} /> فتح
          </button>
          <button className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function CloseShiftModal({
  shift,
  onClose,
  onSuccess,
}: {
  shift: Shift;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [actual, setActual] = useState('');
  const [notes, setNotes] = useState('');

  const mutation = useMutation({
    mutationFn: () =>
      shiftsApi.close(shift.id, {
        actual_closing: Number(actual),
        notes: notes || undefined,
      }),
    onSuccess: (result) => {
      const diff = Number(result.difference);
      if (Math.abs(diff) < 0.01) {
        toast.success('تم إغلاق الوردية — مطابقة تامة');
      } else if (diff > 0) {
        toast.success(`تم الإغلاق — زيادة ${EGP(diff)}`);
      } else {
        toast.error(`تم الإغلاق — عجز ${EGP(Math.abs(diff))}`);
      }
      onSuccess();
    },
  });

  return (
    <Modal title={`إغلاق الوردية ${shift.shift_no}`} onClose={onClose}>
      <div className="space-y-3">
        <div className="bg-slate-50 rounded-lg p-3 space-y-1 text-sm">
          <Row label="رصيد افتتاحي" value={EGP(shift.opening_balance)} />
          <Row label="مبيعات تقديرية" value={EGP(shift.total_sales || 0)} color="text-emerald-700" />
          <Row label="مرتجعات" value={EGP(shift.total_returns || 0)} color="text-rose-600" />
          <Row label="مصروفات" value={EGP(shift.total_expenses || 0)} color="text-rose-600" />
        </div>

        <Field label="الرصيد الفعلي (عدّ النقدية)">
          <input
            autoFocus
            type="number"
            step="0.01"
            className="input text-lg font-bold"
            value={actual}
            onChange={(e) => setActual(e.target.value)}
            placeholder="0.00"
          />
        </Field>

        <Field label="ملاحظات">
          <textarea
            rows={2}
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </Field>

        <div className="flex gap-2 pt-2">
          <button
            className="btn-primary flex-1 bg-rose-600 hover:bg-rose-700"
            disabled={mutation.isPending || !actual}
            onClick={() => mutation.mutate()}
          >
            <Calculator size={18} /> إغلاق واحتساب
          </button>
          <button className="btn-secondary" onClick={onClose}>
            إلغاء
          </button>
        </div>
      </div>
    </Modal>
  );
}

function Row({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div className="flex justify-between">
      <span className="text-slate-600">{label}</span>
      <span className={`font-bold ${color || 'text-slate-800'}`}>{value}</span>
    </div>
  );
}

function ShiftDetailModal({ shift, onClose }: { shift: Shift; onClose: () => void }) {
  return (
    <Modal title={`تفاصيل الوردية ${shift.shift_no}`} onClose={onClose} size="lg">
      <div className="space-y-4">
        <div className="grid md:grid-cols-4 gap-3">
          <MiniStat label="رصيد افتتاحي" value={EGP(shift.opening_balance)} icon={<DollarSign />} />
          <MiniStat
            label="مبيعات"
            value={EGP(shift.total_sales)}
            icon={<TrendingUp />}
            color="text-emerald-700"
          />
          <MiniStat
            label="مرتجعات"
            value={EGP(shift.total_returns)}
            icon={<TrendingDown />}
            color="text-rose-600"
          />
          <MiniStat label="عدد الفواتير" value={String(shift.invoice_count)} icon={<FileText />} />
        </div>

        {shift.status === 'closed' && (
          <div className="card p-4 bg-slate-50">
            <div className="grid md:grid-cols-3 gap-3">
              <Row label="متوقع الإغلاق" value={EGP(shift.expected_closing)} />
              <Row label="فعلي الإغلاق" value={EGP(shift.actual_closing || 0)} />
              <div className="flex justify-between">
                <span className="text-slate-600">الفرق</span>
                <DiffBadge value={Number(shift.difference)} />
              </div>
            </div>
          </div>
        )}

        {shift.invoices && shift.invoices.length > 0 && (
          <div className="border border-slate-200 rounded-lg overflow-hidden">
            <div className="bg-slate-50 p-3 text-sm font-bold">فواتير الوردية</div>
            <div className="overflow-x-auto max-h-60 overflow-y-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-100">
                  <tr>
                    <th className="text-right px-3 py-2">رقم</th>
                    <th className="text-right px-3 py-2">الوقت</th>
                    <th className="text-right px-3 py-2">الإجمالي</th>
                    <th className="text-right px-3 py-2">المدفوع</th>
                    <th className="text-right px-3 py-2">الحالة</th>
                  </tr>
                </thead>
                <tbody>
                  {shift.invoices.map((i) => (
                    <tr key={i.id} className="border-t border-slate-100">
                      <td className="px-3 py-2 font-mono">{i.invoice_no}</td>
                      <td className="px-3 py-2">
                        {new Date(i.completed_at).toLocaleTimeString('en-US')}
                      </td>
                      <td className="px-3 py-2 font-bold">{EGP(i.grand_total)}</td>
                      <td className="px-3 py-2">{EGP(i.paid_amount)}</td>
                      <td className="px-3 py-2">{i.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function MiniStat({
  label,
  value,
  icon,
  color,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  color?: string;
}) {
  return (
    <div className="p-3 bg-white border border-slate-200 rounded-lg">
      <div className="text-xs text-slate-500 flex items-center gap-1">
        <span className="opacity-60">{icon}</span> {label}
      </div>
      <div className={`font-black text-lg mt-1 ${color || 'text-slate-800'}`}>{value}</div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-slate-600 mb-1 block">{label}</span>
      {children}
    </label>
  );
}
