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
import {
  shiftsApi,
  Shift,
  OpenShiftPayload,
  ShiftSummary,
} from '@/api/shifts.api';
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
                  <th className="text-right px-3 py-2">إجراءات</th>
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
                        : <span className="text-slate-400">— جارية</span>}
                    </td>
                    <td className="px-3 py-2 font-bold text-emerald-700">
                      {s.status === 'open'
                        ? <span className="text-slate-400">— جارية</span>
                        : EGP(s.total_sales)}
                    </td>
                    <td className="px-3 py-2 font-bold">
                      {s.status === 'closed' ? (
                        <DiffBadge
                          value={Number((s as any).variance ?? s.difference ?? 0)}
                        />
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <StatusBadge status={s.status} />
                    </td>
                    <td
                      className="px-3 py-2"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {s.status === 'open' ? (
                        <button
                          onClick={async () => {
                            const full = await shiftsApi.get(s.id);
                            setCloseTarget(full);
                          }}
                          className="px-2 py-1 text-xs rounded bg-rose-600 text-white hover:bg-rose-700 font-bold"
                        >
                          إغلاق
                        </button>
                      ) : (
                        <button
                          onClick={async () => {
                            const full = await shiftsApi.get(s.id);
                            setDetail(full);
                          }}
                          className="px-2 py-1 text-xs rounded bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold"
                        >
                          عرض
                        </button>
                      )}
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
  // Live summary — backend returns this inline on /current, but re-fetch every
  // 20s so the cashier sees running totals while they keep selling.
  const { data: summary } = useQuery({
    queryKey: ['shift-summary', shift.id],
    queryFn: () => shiftsApi.summary(shift.id),
    initialData: shift.summary,
    refetchInterval: 20_000,
  });

  const s = summary;
  const expected = s?.expected_closing ?? Number(shift.opening_balance || 0);
  const elapsed = (() => {
    const mins = Math.floor(
      (Date.now() - new Date(shift.opened_at).getTime()) / 60000,
    );
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return `${h}س ${m.toString().padStart(2, '0')}د`;
  })();

  return (
    <div className="card p-5 border-2 border-emerald-200 bg-emerald-50/40 space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <div className="font-black text-slate-800 flex items-center gap-2">
            <span className="inline-block w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
            وردية نشطة
          </div>
          <div className="text-xs text-slate-500 font-mono mt-1">
            {shift.shift_no} · {shift.cashbox_name || '—'} ·{' '}
            {shift.warehouse_name || '—'}
          </div>
        </div>
        <div className="text-xs text-slate-500 text-left">
          <div>منذ {new Date(shift.opened_at).toLocaleString('en-US')}</div>
          <div className="font-mono text-slate-700 mt-0.5">
            المدة: {elapsed}
          </div>
        </div>
      </div>

      {/* Row 1: opening, sales, cash in pocket */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Stat label="رصيد افتتاحي" value={EGP(shift.opening_balance)} />
        <Stat
          label="مبيعات الكاشير"
          value={EGP(s?.total_sales || 0)}
          color="text-emerald-700"
          hint={`${s?.invoice_count || 0} فاتورة`}
        />
        <Stat
          label="النقدية المتوقعة"
          value={EGP(expected)}
          color="text-indigo-700"
          hint="رصيد افتتاحي + حركات"
        />
        <Stat
          label="متبقي على العملاء"
          value={EGP(s?.remaining_receivable || 0)}
          color="text-amber-700"
          hint="فواتير جزئية"
        />
      </div>

      {/* Row 2: payment methods */}
      {s && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <MiniChip
            label="💵 كاش"
            amount={s.payment_breakdown.cash.amount}
            count={s.payment_breakdown.cash.count}
            tone="emerald"
          />
          <MiniChip
            label="💳 بطاقة"
            amount={s.payment_breakdown.card.amount}
            count={s.payment_breakdown.card.count}
            tone="indigo"
          />
          <MiniChip
            label="📱 إنستاباي"
            amount={s.payment_breakdown.instapay.amount}
            count={s.payment_breakdown.instapay.count}
            tone="purple"
          />
          <MiniChip
            label="🏦 تحويل"
            amount={s.payment_breakdown.bank_transfer.amount}
            count={s.payment_breakdown.bank_transfer.count}
            tone="slate"
          />
        </div>
      )}

      {/* Row 3: cash-flow summary */}
      {s && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-2 text-xs">
          <MiniChip
            label="📥 قبض عملاء"
            amount={s.customer_receipts}
            tone="emerald"
          />
          <MiniChip
            label="📤 دفع موردين"
            amount={-s.supplier_payments}
            tone="rose"
          />
          <MiniChip
            label="↩ مرتجعات"
            amount={-s.total_returns}
            count={s.return_count}
            tone="rose"
          />
          <MiniChip
            label="🧾 مصروفات"
            amount={-s.total_expenses}
            count={s.expense_count}
            tone="amber"
          />
          <MiniChip
            label="⚪ متفرقات"
            amount={s.other_cash_in - s.other_cash_out}
            tone="slate"
          />
        </div>
      )}
    </div>
  );
}

function MiniChip({
  label,
  amount,
  count,
  tone,
}: {
  label: string;
  amount: number;
  count?: number;
  tone: 'emerald' | 'indigo' | 'purple' | 'slate' | 'rose' | 'amber';
}) {
  const map: Record<string, string> = {
    emerald: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    indigo: 'bg-indigo-100 text-indigo-800 border-indigo-200',
    purple: 'bg-purple-100 text-purple-800 border-purple-200',
    slate: 'bg-slate-100 text-slate-700 border-slate-200',
    rose: 'bg-rose-100 text-rose-800 border-rose-200',
    amber: 'bg-amber-100 text-amber-800 border-amber-200',
  };
  return (
    <div className={`border rounded-lg px-2 py-2 ${map[tone]}`}>
      <div className="font-bold">{label}</div>
      <div className="font-mono text-[11px] mt-0.5">{EGP(amount)}</div>
      {count != null && (
        <div className="text-[10px] opacity-70 mt-0.5">{count} عملية</div>
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  color,
  small,
  hint,
}: {
  label: string;
  value: string;
  color?: string;
  small?: boolean;
  hint?: string;
}) {
  return (
    <div>
      <div className="text-xs text-slate-500">{label}</div>
      <div className={`font-black ${small ? 'text-sm' : 'text-xl'} ${color || 'text-slate-800'}`}>
        {value}
      </div>
      {hint && <div className="text-[11px] text-slate-400 mt-0.5">{hint}</div>}
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

// Egyptian currency denominations that a cashier would typically count.
const DENOMINATIONS = [200, 100, 50, 20, 10, 5, 1] as const;

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
  // denomination → count of bills/coins
  const [denom, setDenom] = useState<Record<number, number>>({});
  // Toggle between typing the total manually or using the denomination counter.
  const [useCounter, setUseCounter] = useState(true);

  // Fetch the freshest summary right now so the cashier sees the exact
  // expected number.
  const { data: s } = useQuery({
    queryKey: ['shift-summary', shift.id, 'close'],
    queryFn: () => shiftsApi.summary(shift.id),
    initialData: shift.summary,
  });

  const expected = s?.expected_closing ?? 0;

  // Sum across denominations (value × count) — replaces manual input when
  // useCounter is on.
  const counterTotal = DENOMINATIONS.reduce(
    (sum, v) => sum + v * (denom[v] || 0),
    0,
  );
  const billsCount = DENOMINATIONS.reduce((n, v) => n + (denom[v] || 0), 0);

  const actualNum = useCounter ? counterTotal : Number(actual) || 0;
  const liveVariance =
    (useCounter ? billsCount > 0 : !!actual) ? actualNum - expected : 0;
  const canSubmit =
    (useCounter && billsCount > 0) || (!useCounter && actual !== '');

  const mutation = useMutation({
    mutationFn: () =>
      shiftsApi.close(shift.id, {
        actual_closing: Number(actualNum),
        notes: notes || undefined,
        denominations: useCounter
          ? Object.fromEntries(
              Object.entries(denom).filter(([, c]) => Number(c) > 0),
            )
          : undefined,
      } as any),
    onSuccess: (result) => {
      const v =
        result.summary?.variance ??
        Number(result.actual_closing || 0) -
          Number(result.expected_closing || 0);
      if (Math.abs(v) < 0.01) {
        toast.success('تم إغلاق الوردية — مطابقة تامة');
      } else if (v > 0) {
        toast.success(`تم الإغلاق — زيادة ${EGP(v)}`);
      } else {
        toast.error(`تم الإغلاق — عجز ${EGP(Math.abs(v))}`);
      }
      onSuccess();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل إغلاق الوردية'),
  });

  return (
    <Modal title={`إغلاق الوردية ${shift.shift_no}`} onClose={onClose}>
      <div className="space-y-4">
        {/* Running tally pre-close */}
        <div className="bg-slate-50 rounded-lg p-3 space-y-1 text-sm">
          <Row label="رصيد افتتاحي" value={EGP(s?.opening_balance || 0)} />
          <Row
            label="مبيعات الكاشير (إجمالي)"
            value={EGP(s?.total_sales || 0)}
            color="text-emerald-700"
          />
          <div className="ms-4 space-y-0.5 text-xs">
            <Row
              label="— كاش"
              value={EGP(s?.payment_breakdown.cash.amount || 0)}
            />
            <Row
              label="— بطاقة"
              value={EGP(s?.payment_breakdown.card.amount || 0)}
            />
            <Row
              label="— إنستاباي"
              value={EGP(s?.payment_breakdown.instapay.amount || 0)}
            />
            <Row
              label="— تحويل بنكي"
              value={EGP(s?.payment_breakdown.bank_transfer.amount || 0)}
            />
          </div>
          <Row
            label="قبض من عملاء"
            value={EGP(s?.customer_receipts || 0)}
            color="text-emerald-700"
          />
          <Row
            label="دفع لموردين"
            value={'- ' + EGP(s?.supplier_payments || 0)}
            color="text-rose-600"
          />
          <Row
            label="مرتجعات"
            value={'- ' + EGP(s?.total_returns || 0)}
            color="text-rose-600"
          />
          <Row
            label={`مصروفات (${s?.expense_count || 0})`}
            value={'- ' + EGP(s?.total_expenses || 0)}
            color="text-rose-600"
          />
          <Row
            label="متفرقات"
            value={EGP(
              (s?.other_cash_in || 0) - (s?.other_cash_out || 0),
            )}
          />
          <div className="border-t border-slate-300 pt-2 mt-2">
            <Row
              label="الرصيد المتوقع في الدرج"
              value={EGP(expected)}
              color="text-indigo-700"
            />
          </div>
        </div>

        {/* Remaining receivable hint */}
        {s && s.remaining_receivable > 0 && (
          <div className="text-xs p-2 rounded bg-amber-50 border border-amber-200 text-amber-800">
            💡 متبقي على العملاء: {EGP(s.remaining_receivable)} (فواتير جزئية)
          </div>
        )}

        {/* Toggle between denomination counter and free-form entry */}
        <div className="flex items-center gap-2 text-xs">
          <span className="text-slate-600 font-bold">طريقة الإدخال:</span>
          <button
            type="button"
            onClick={() => setUseCounter(true)}
            className={`px-3 py-1 rounded-md font-bold ${
              useCounter
                ? 'bg-brand-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            عدّاد الفئات
          </button>
          <button
            type="button"
            onClick={() => setUseCounter(false)}
            className={`px-3 py-1 rounded-md font-bold ${
              !useCounter
                ? 'bg-brand-600 text-white'
                : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
            }`}
          >
            إجمالي يدوي
          </button>
        </div>

        {useCounter ? (
          <div className="bg-slate-50 rounded-lg p-3 space-y-2">
            <div className="text-xs font-bold text-slate-700 mb-1">
              عدّ الدرج حسب الفئة
            </div>
            <div className="grid grid-cols-2 gap-2">
              {DENOMINATIONS.map((v) => {
                const count = denom[v] || 0;
                const sub = v * count;
                return (
                  <div
                    key={v}
                    className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-2 py-1.5"
                  >
                    <span className="w-10 text-center font-black text-slate-700 shrink-0">
                      {v}
                    </span>
                    <span className="text-xs text-slate-400 shrink-0">×</span>
                    <input
                      type="number"
                      min={0}
                      className="w-14 border rounded px-1.5 py-1 text-sm text-center"
                      value={count || ''}
                      onChange={(e) => {
                        const n = Math.max(0, Number(e.target.value) || 0);
                        setDenom((d) => ({ ...d, [v]: n }));
                      }}
                      placeholder="0"
                    />
                    <span className="text-xs text-slate-400 shrink-0">=</span>
                    <span className="ms-auto font-bold font-mono text-sm tabular-nums text-emerald-700">
                      {sub ? sub.toLocaleString('en-US') : '—'}
                    </span>
                  </div>
                );
              })}
            </div>
            <div className="border-t border-slate-300 pt-2 mt-2 flex items-center justify-between">
              <span className="text-xs text-slate-500">
                {billsCount} قطعة نقدية
              </span>
              <span className="font-black text-lg text-brand-700">
                إجمالي الدرج: {EGP(counterTotal)}
              </span>
            </div>
          </div>
        ) : (
          <Field label="الرصيد الفعلي في الدرج (عدّ النقدية)">
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
        )}

        {/* Live variance preview before submit */}
        {canSubmit && (
          <div
            className={`rounded-lg p-3 text-center font-black ${
              Math.abs(liveVariance) < 0.01
                ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                : liveVariance > 0
                  ? 'bg-emerald-50 border border-emerald-200 text-emerald-800'
                  : 'bg-rose-50 border border-rose-200 text-rose-800'
            }`}
          >
            <div className="text-sm opacity-80 mb-1">
              الفعلي {EGP(actualNum)} − المتوقع {EGP(expected)} =
            </div>
            {Math.abs(liveVariance) < 0.01
              ? '✓ مطابقة تامة'
              : liveVariance > 0
                ? `زيادة: ${EGP(liveVariance)}`
                : `عجز: ${EGP(Math.abs(liveVariance))}`}
          </div>
        )}

        <Field label="ملاحظات">
          <textarea
            rows={2}
            className="input"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="سبب العجز / ملاحظات الإقفال…"
          />
        </Field>

        <div className="flex gap-2 pt-2">
          <button
            className="btn-primary flex-1 bg-rose-600 hover:bg-rose-700"
            disabled={mutation.isPending || !canSubmit}
            onClick={() => mutation.mutate()}
          >
            <Calculator size={18} /> إغلاق الوردية واحتساب الفروق
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
  const qc = useQueryClient();
  const [showClose, setShowClose] = useState(false);

  // Always fetch the live detail (includes summary + full invoice list) so the
  // modal is correct for both open and closed shifts — never rely on the row
  // columns alone.
  const { data: detail, isLoading } = useQuery({
    queryKey: ['shift-detail', shift.id],
    queryFn: () => shiftsApi.get(shift.id),
    refetchInterval: shift.status === 'open' ? 15_000 : false,
    initialData: shift,
  });

  const s: ShiftSummary | undefined = detail?.summary;
  const isOpen = detail?.status === 'open';

  return (
    <Modal
      title={`تفاصيل الوردية ${detail?.shift_no || shift.shift_no}`}
      onClose={onClose}
      size="lg"
    >
      {isLoading && !s ? (
        <div className="p-10 text-center text-slate-400">جاري التحميل…</div>
      ) : (
        <div className="space-y-4">
          {/* Top stats */}
          <div className="grid md:grid-cols-4 gap-3">
            <MiniStat
              label="رصيد افتتاحي"
              value={EGP(s?.opening_balance || detail?.opening_balance || 0)}
              icon={<DollarSign />}
            />
            <MiniStat
              label="مبيعات الكاشير"
              value={EGP(s?.total_sales || 0)}
              icon={<TrendingUp />}
              color="text-emerald-700"
            />
            <MiniStat
              label={isOpen ? 'النقدية المتوقعة' : 'الرصيد المتوقع'}
              value={EGP(s?.expected_closing || 0)}
              icon={<Calculator />}
              color="text-indigo-700"
            />
            <MiniStat
              label="عدد الفواتير"
              value={String(s?.invoice_count || 0)}
              icon={<FileText />}
            />
          </div>

          {/* Payment methods */}
          {s && (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
              <MiniChip
                label="💵 كاش"
                amount={s.payment_breakdown.cash.amount}
                count={s.payment_breakdown.cash.count}
                tone="emerald"
              />
              <MiniChip
                label="💳 بطاقة"
                amount={s.payment_breakdown.card.amount}
                count={s.payment_breakdown.card.count}
                tone="indigo"
              />
              <MiniChip
                label="📱 إنستاباي"
                amount={s.payment_breakdown.instapay.amount}
                count={s.payment_breakdown.instapay.count}
                tone="purple"
              />
              <MiniChip
                label="🏦 تحويل"
                amount={s.payment_breakdown.bank_transfer.amount}
                count={s.payment_breakdown.bank_transfer.count}
                tone="slate"
              />
            </div>
          )}

          {/* Cash flow breakdown */}
          {s && (
            <div className="card p-3 bg-slate-50 space-y-1 text-sm">
              <Row
                label="📥 قبض من عملاء"
                value={EGP(s.customer_receipts)}
                color="text-emerald-700"
              />
              <Row
                label="📤 توريد / دفع لموردين"
                value={'- ' + EGP(s.supplier_payments)}
                color="text-rose-600"
              />
              <Row
                label={`↩ مرتجعات (${s.return_count})`}
                value={'- ' + EGP(s.total_returns)}
                color="text-rose-600"
              />
              <Row
                label={`🧾 مصروفات (${s.expense_count})`}
                value={'- ' + EGP(s.total_expenses)}
                color="text-rose-600"
              />
              <Row label="⚪ داخل متفرقات" value={EGP(s.other_cash_in)} />
              <Row
                label="⚪ خارج متفرقات"
                value={'- ' + EGP(s.other_cash_out)}
                color="text-rose-600"
              />
              <div className="border-t border-slate-300 pt-1 mt-1">
                <Row
                  label="إجمالي الداخل"
                  value={EGP(s.total_cash_in)}
                  color="text-emerald-700"
                />
                <Row
                  label="إجمالي الخارج"
                  value={EGP(s.total_cash_out)}
                  color="text-rose-600"
                />
              </div>
            </div>
          )}

          {/* Expenses list */}
          {s && s.expenses.length > 0 && (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="bg-amber-50 p-3 text-sm font-bold text-amber-800">
                المصروفات ({s.expenses.length})
              </div>
              <div className="overflow-x-auto max-h-40 overflow-y-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="text-right px-3 py-2">التاريخ</th>
                      <th className="text-right px-3 py-2">التصنيف</th>
                      <th className="text-right px-3 py-2">الوصف</th>
                      <th className="text-right px-3 py-2">المبلغ</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.expenses.map((e) => (
                      <tr key={e.id} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-mono">
                          {new Date(e.expense_date).toLocaleDateString('en-GB')}
                        </td>
                        <td className="px-3 py-2">{e.category_name || '—'}</td>
                        <td className="px-3 py-2">{e.description || '—'}</td>
                        <td className="px-3 py-2 font-bold text-rose-600">
                          {EGP(Number(e.amount))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Close-time box */}
          {!isOpen && (
            <div className="card p-4 bg-slate-50">
              <div className="grid md:grid-cols-4 gap-3">
                <Row
                  label="الرصيد المتوقع"
                  value={EGP(s?.expected_closing || 0)}
                />
                <Row
                  label="الرصيد الفعلي (عُدّ)"
                  value={EGP(s?.actual_closing || detail?.actual_closing || 0)}
                />
                <div className="flex justify-between">
                  <span className="text-slate-600">الفرق</span>
                  <DiffBadge
                    value={Number(
                      s?.variance ??
                        Number(detail?.actual_closing || 0) -
                          Number(detail?.expected_closing || 0),
                    )}
                  />
                </div>
                <Row
                  label="وقت الإغلاق"
                  value={
                    detail?.closed_at
                      ? new Date(detail.closed_at).toLocaleString('en-US')
                      : '—'
                  }
                />
              </div>
            </div>
          )}

          {isOpen && (
            <div className="flex items-center justify-end pt-2">
              <button
                className="btn-primary bg-rose-600 hover:bg-rose-700"
                onClick={() => setShowClose(true)}
              >
                <Square size={16} /> إغلاق الوردية الآن
              </button>
            </div>
          )}

          {/* Invoice list */}
          {detail?.invoices && detail.invoices.length > 0 && (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="bg-slate-50 p-3 text-sm font-bold">
                فواتير الوردية ({detail.invoices.length})
              </div>
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
                    {detail.invoices.map((i) => (
                      <tr key={i.id} className="border-t border-slate-100">
                        <td className="px-3 py-2 font-mono">{i.invoice_no}</td>
                        <td className="px-3 py-2">
                          {new Date(
                            i.completed_at || (i as any).created_at,
                          ).toLocaleTimeString('en-US')}
                        </td>
                        <td className="px-3 py-2 font-bold">
                          {EGP(i.grand_total)}
                        </td>
                        <td className="px-3 py-2">{EGP(i.paid_amount)}</td>
                        <td className="px-3 py-2">
                          {i.status === 'paid' ? 'مدفوعة'
                            : i.status === 'partially_paid' ? 'جزئية'
                            : i.status === 'cancelled' ? 'ملغاة'
                            : i.status}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}

      {showClose && detail && (
        <CloseShiftModal
          shift={detail}
          onClose={() => setShowClose(false)}
          onSuccess={() => {
            setShowClose(false);
            qc.invalidateQueries({ queryKey: ['shift-current'] });
            qc.invalidateQueries({ queryKey: ['shifts'] });
            qc.invalidateQueries({ queryKey: ['shift-detail', shift.id] });
            qc.invalidateQueries({ queryKey: ['shift-summary', shift.id] });
            onClose();
          }}
        />
      )}
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
