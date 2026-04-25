import { useState, useMemo, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { useAuthStore } from '@/stores/auth.store';
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
  ShiftCountAdjustment,
  VarianceTreatment,
  ApproveClosePayload,
} from '@/api/shifts.api';
import { cashDeskApi } from '@/api/cash-desk.api';
import { usersApi } from '@/api/users.api';

const EGP = (n: number | string) =>
  `${Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;

const DEFAULT_WAREHOUSE_ID = import.meta.env.VITE_DEFAULT_WAREHOUSE_ID as string;

export default function Shifts() {
  const [showOpen, setShowOpen] = useState(false);
  const [closeTarget, setCloseTarget] = useState<Shift | null>(null);
  const [detail, setDetail] = useState<Shift | null>(null);
  const [statusFilter, setStatusFilter] = useState<'' | 'open' | 'closed'>('');
  const qc = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  // PR-1: removed the silent auto-clock-in side-effect that used to
  // fire on every visit to /shifts. It bypassed the Cairo grace-window
  // logic and could double-tag a record when the page was reopened
  // mid-shift. Clock-in is now an explicit action only — handled by
  // the Employee Profile + Attendance pages, both of which broadcast
  // to all month-scoped query keys via invalidateMonthly().

  // /shifts?open=1 — auto-pop the "open shift" modal (used by the
  // session-start redirect from useShiftGate).
  useEffect(() => {
    if (searchParams.get('open') === '1') {
      setShowOpen(true);
      searchParams.delete('open');
      setSearchParams(searchParams, { replace: true });
    }
  }, [searchParams, setSearchParams]);

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

      {/* Pending close-out approvals — admin-only */}
      <PendingCloseInbox />

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
                      {fmtShiftTime(s.opened_at)}
                    </td>
                    <td className="px-3 py-2 text-xs">
                      {s.closed_at ? (
                        fmtShiftTime(s.closed_at)
                      ) : s.status === 'pending_close' ? (
                        <span className="text-amber-600">
                          طلب إقفال — تحت المراجعة
                        </span>
                      ) : (
                        <span className="text-slate-400">— جارية</span>
                      )}
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
  if (status === 'open') {
    return (
      <span className="chip bg-emerald-100 text-emerald-700">مفتوحة</span>
    );
  }
  if (status === 'pending_close') {
    return (
      <span className="chip bg-amber-100 text-amber-700 border border-amber-300">
        تحت المراجعة
      </span>
    );
  }
  return <span className="chip bg-slate-100 text-slate-700">مغلقة</span>;
}

/** Cairo-local timestamp with the full second precision. */
function fmtShiftTime(iso: string | null | undefined) {
  if (!iso) return '';
  const d = new Date(iso);
  const date = d.toLocaleDateString('en-GB', {
    timeZone: 'Africa/Cairo',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const time = d
    .toLocaleTimeString('en-GB', {
      timeZone: 'Africa/Cairo',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    })
    .replace(/\s?AM\s*$/i, ' ص')
    .replace(/\s?PM\s*$/i, ' م');
  return `${date} · ${time}`;
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
    queryFn: () => cashDeskApi.cashboxes(),
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

  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canDirectClose = hasPermission('shifts.close_approve');

  const mutation = useMutation({
    mutationFn: () => {
      const basePayload = {
        actual_closing: Number(actualNum),
        notes: notes || undefined,
      };
      const denominations = useCounter
        ? Object.fromEntries(
            Object.entries(denom).filter(([, c]) => Number(c) > 0),
          )
        : undefined;
      if (canDirectClose) {
        return shiftsApi.close(shift.id, {
          ...basePayload,
          denominations,
        } as any);
      }
      // Non-approvers submit a close request instead — the shift moves
      // to pending_close until an admin reviews it.
      return shiftsApi.requestClose(shift.id, basePayload) as any;
    },
    onSuccess: (result: any) => {
      // Non-admin path via requestClose may return either a true pending
      // review (variance != 0) OR an auto-close (variance == 0).
      if (!canDirectClose) {
        if (result?.pending) {
          const v = Number(result.variance || 0);
          toast.success(
            v > 0
              ? `تم إرسال طلب إقفال — زيادة ${EGP(v)} بانتظار الاعتماد`
              : `تم إرسال طلب إقفال — عجز ${EGP(Math.abs(v))} بانتظار الاعتماد`,
          );
          onSuccess();
          return;
        }
        if (result?.auto_closed) {
          toast.success('تم إغلاق الوردية تلقائياً — مطابقة تامة');
          onSuccess();
          return;
        }
      }
      const closed = result?.shift ?? result;
      const v =
        closed?.summary?.variance ??
        Number(closed?.actual_closing || 0) -
          Number(closed?.expected_closing || 0);
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

        {/* Clarifier: actual_closing must include opening balance */}
        <div className="text-xs p-2 rounded bg-indigo-50 border border-indigo-200 text-indigo-800">
          ℹ️ المطلوب: عُدّ <b>كل</b> النقدية الموجودة في الدرج الآن (الرصيد
          الافتتاحي + المبيعات الكاش + المقبوضات − المصروفات)، وليس فقط
          المبيعات الجديدة.
        </div>

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
  // PR-B1 — counted-cash adjustment modal state.
  const [showAdjust, setShowAdjust] = useState(false);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canAdjustCount = hasPermission('shifts.close.adjust');

  // Always fetch the live detail (includes summary + full invoice list) so the
  // modal is correct for both open and closed shifts — never rely on the row
  // columns alone.
  const { data: detail, isLoading } = useQuery({
    queryKey: ['shift-detail', shift.id],
    queryFn: () => shiftsApi.get(shift.id),
    refetchInterval: shift.status === 'open' ? 15_000 : false,
    initialData: shift,
  });

  // PR-B1 — pull adjustment history alongside the detail. Shown both
  // to the operator (read-only) and to admins (history under the
  // adjust button).
  const { data: adjustments = [] } = useQuery({
    queryKey: ['shift-adjustments', shift.id],
    queryFn: () => shiftsApi.listAdjustments(shift.id),
    staleTime: 30_000,
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
                {(() => {
                  const net = Number(s.total_cash_in) - Number(s.total_cash_out);
                  return (
                    <Row
                      label="الصافي (داخل − خارج)"
                      value={`${net >= 0 ? '' : '- '}${EGP(Math.abs(net))}`}
                      color={
                        net >= 0 ? 'text-emerald-700' : 'text-rose-600'
                      }
                    />
                  );
                })()}
              </div>
            </div>
          )}

          {/* Operating expenses (PR-14: advances are now in their own
           *  section below — this list shows operating expenses only). */}
          {s && s.expenses.length > 0 && (
            <div className="border border-slate-200 rounded-lg overflow-hidden">
              <div className="bg-amber-50 p-3 text-sm font-bold text-amber-800 flex items-center justify-between">
                <span>المصروفات التشغيلية ({s.expenses.length})</span>
                <span className="font-mono tabular-nums text-amber-900">
                  {EGP(s.total_operating_expenses)}
                </span>
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

          {/* PR-14 — Employee cash movements (settlements + advances).
           *  These are cash that left the drawer for an employee but
           *  are NOT operating expenses — settlement is DR 213 / CR cash,
           *  advance is DR 1123 / CR cash. They were previously invisible
           *  in shift closing because computeSummary only looked at the
           *  expenses table. */}
          {s && s.employee_cash_movements && s.employee_cash_movements.length > 0 && (
            <div className="border border-indigo-200 rounded-lg overflow-hidden">
              <div className="bg-indigo-50 p-3 text-sm font-bold text-indigo-800 flex items-center justify-between">
                <span>حركات موظفين نقدية ({s.employee_cash_movements.length})</span>
                <span className="font-mono tabular-nums text-indigo-900">
                  {EGP(s.total_employee_cash_out)}
                </span>
              </div>
              <div className="overflow-x-auto max-h-56 overflow-y-auto">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50">
                    <tr>
                      <th className="text-right px-2 py-2">التاريخ والوقت</th>
                      <th className="text-right px-2 py-2">الموظف المستلم</th>
                      <th className="text-right px-2 py-2">النوع</th>
                      <th className="text-right px-2 py-2">المبلغ</th>
                      <th className="text-right px-2 py-2">الخزنة</th>
                      <th className="text-right px-2 py-2">تمت بواسطة</th>
                      <th className="text-right px-2 py-2">رقم القيد</th>
                      <th className="text-right px-2 py-2">التأثير المحاسبي</th>
                      <th className="text-right px-2 py-2">حالة الربط</th>
                    </tr>
                  </thead>
                  <tbody>
                    {s.employee_cash_movements.map((m) => (
                      <tr key={`${m.kind}-${m.id}`} className="border-t border-slate-100">
                        <td className="px-2 py-1.5 font-mono tabular-nums whitespace-nowrap">
                          {new Date(m.created_at).toLocaleString('en-GB', {
                            timeZone: 'Africa/Cairo',
                            hour12: false,
                          })}
                        </td>
                        <td className="px-2 py-1.5">{m.employee_name || '—'}</td>
                        <td className="px-2 py-1.5">
                          <span
                            className={`chip text-[10px] ${
                              m.kind === 'settlement'
                                ? 'bg-rose-50 text-rose-700 border-rose-200'
                                : 'bg-amber-50 text-amber-700 border-amber-200'
                            }`}
                          >
                            {m.type_label}
                          </span>
                        </td>
                        <td className="px-2 py-1.5 font-bold tabular-nums text-rose-600">
                          {EGP(m.amount)}
                        </td>
                        <td className="px-2 py-1.5 text-slate-600">
                          {m.cashbox_name || '—'}
                        </td>
                        <td className="px-2 py-1.5 text-slate-600">
                          {m.created_by_name || '—'}
                        </td>
                        <td className="px-2 py-1.5 font-mono text-[10px] text-slate-500">
                          {m.je_entry_no || '—'}
                        </td>
                        <td className="px-2 py-1.5 text-slate-600 text-[11px]">
                          {m.accounting_impact}
                        </td>
                        <td className="px-2 py-1.5">
                          <span
                            className={`chip text-[10px] ${
                              m.link_method === 'explicit'
                                ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                                : 'bg-sky-50 text-sky-700 border-sky-200'
                            }`}
                            title={
                              m.link_method === 'explicit'
                                ? 'مرتبط مباشرة بالوردية عبر shift_id'
                                : 'مطابقة عبر الخزنة + توقيت الوردية (لا يوجد shift_id بعد)'
                            }
                          >
                            {m.link_method === 'explicit'
                              ? 'مرتبط بالوردية'
                              : 'مرتبط تلقائياً بالوردية'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* PR-14 — Cash-out summary block. Uses the same numbers as
           *  the expected_closing formula so the user can see exactly
           *  why the drawer is expected to be at this value. */}
          {s && (
            <div className="border border-slate-200 rounded-lg p-3 bg-slate-50">
              <div className="text-sm font-bold text-slate-800 mb-2">
                ملخص الخروج النقدي
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2 text-xs">
                <CashOutLine label="المصروفات التشغيلية" value={s.total_operating_expenses} />
                <CashOutLine label="سلف الموظفين" value={s.total_employee_advances} />
                <CashOutLine label="صرف مستحقات الموظفين" value={s.total_employee_settlements} />
                <CashOutLine label="مدفوعات للموردين" value={s.supplier_payments} />
                <CashOutLine label="خصومات / مرتجعات نقدية" value={s.total_returns} />
                <CashOutLine label="حركات نقدية أخرى" value={s.other_cash_out} />
              </div>
              <div className="border-t border-slate-300 mt-2 pt-2 flex items-center justify-between">
                <span className="text-sm font-bold text-slate-700">
                  إجمالي حركات الموظفين النقدية
                </span>
                <span className="font-mono tabular-nums font-bold text-indigo-700">
                  {EGP(s.total_employee_cash_out)}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm font-bold text-slate-800">
                  إجمالي الخروج النقدي من الدرج
                </span>
                <span className="font-mono tabular-nums font-black text-rose-700">
                  {EGP(s.total_cash_out)}
                </span>
              </div>
            </div>
          )}

          {/* Close-time / pending-review box */}
          {!isOpen && (() => {
            const isPending = detail?.status === 'pending_close';
            // Counted cash: when still pending we only have the cashier's
            // requested amount; once truly closed we store it on the row.
            const countedCash = Number(
              detail?.actual_closing ??
                s?.actual_closing ??
                detail?.close_requested_amount ??
                0,
            );
            const expected = Number(s?.expected_closing || 0);
            const variance = Number(s?.variance ?? countedCash - expected);

            return (
              <div
                className={`card p-4 ${
                  isPending
                    ? 'bg-amber-50 border border-amber-200'
                    : 'bg-slate-50'
                }`}
              >
                {isPending && (
                  <div className="mb-3 flex items-start gap-2 text-amber-800 bg-amber-100/60 border border-amber-200 rounded-lg px-3 py-2 text-xs">
                    <span className="font-bold">⏳ طلب إقفال تحت المراجعة</span>
                    <span>
                      — النقدية التي أدخلها الكاشير {EGP(countedCash)} لا
                      تطابق المتوقع؛ بانتظار اعتماد مدير النظام.
                    </span>
                  </div>
                )}
                <div className="grid md:grid-cols-4 gap-3">
                  <Row label="الرصيد المتوقع" value={EGP(expected)} />
                  <Row
                    label={
                      isPending
                        ? 'النقدية التي عدّها الكاشير'
                        : 'الرصيد الفعلي (عُدّ)'
                    }
                    value={EGP(countedCash)}
                  />
                  <div className="flex justify-between">
                    <span className="text-slate-600">الفرق</span>
                    <DiffBadge value={variance} />
                  </div>
                  <Row
                    label={isPending ? 'وقت طلب الإقفال' : 'وقت الإغلاق'}
                    value={
                      isPending
                        ? fmtShiftTime(detail?.close_requested_at) || '—'
                        : fmtShiftTime(detail?.closed_at) || '—'
                    }
                  />
                </div>
                {detail?.close_requested_notes && (
                  <div className="mt-3 text-xs text-slate-600 border-t border-slate-200 pt-2">
                    <span className="font-bold">ملاحظات الكاشير:</span>{' '}
                    {detail.close_requested_notes}
                  </div>
                )}
              </div>
            );
          })()}

          {/* PR-B1 — adjust counted cash (permission-gated). Only
           *  shown after the cashier submitted a count (so we have
           *  something to correct). Not an accounting transaction —
           *  see migration 096 header. */}
          {!isOpen && canAdjustCount && detail && (
            <div className="flex items-center justify-end pt-1">
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg text-xs font-bold bg-amber-50 text-amber-800 border border-amber-200 hover:bg-amber-100"
                onClick={() => setShowAdjust(true)}
              >
                ✎ تعديل مبلغ الإقفال
              </button>
            </div>
          )}

          {/* PR-B1 — adjustment history (always rendered when a shift
           *  has any adjustments, regardless of permission — anyone
           *  who can view the shift can see why the counted cash
           *  changed). */}
          {!isOpen && (
            <ShiftAdjustmentHistory adjustments={adjustments} />
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

          {/* PR-B1 — adjustment modal */}
          {showAdjust && detail && (
            <AdjustCountModal
              shift={detail}
              currentExpected={Number(s?.expected_closing || 0)}
              onClose={() => setShowAdjust(false)}
              onSaved={() => {
                qc.invalidateQueries({ queryKey: ['shift-detail', shift.id] });
                qc.invalidateQueries({ queryKey: ['shift-adjustments', shift.id] });
                qc.invalidateQueries({ queryKey: ['shifts'] });
                setShowAdjust(false);
              }}
            />
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
    <div className="p-3 bg-white border border-slate-200 rounded-lg min-w-0 h-full">
      <div className="text-xs text-slate-500 flex items-center gap-1 min-w-0">
        <span className="opacity-60 shrink-0">{icon}</span>
        <span className="break-words">{label}</span>
      </div>
      <div
        className={`font-black text-base sm:text-lg mt-1 break-words tabular-nums leading-tight ${color || 'text-slate-800'}`}
        title={value}
      >
        {value}
      </div>
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

/* ───────── Admin-only pending close-out inbox ───────── */

function PendingCloseInbox() {
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canDecide =
    hasPermission('shifts.close_approve') ||
    hasPermission('shifts.variance.approve');
  const [rejectTarget, setRejectTarget] = useState<Shift | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  // Shift currently being approved. When a pending shift has a non-zero
  // variance we open this dialog so the manager picks a treatment before
  // we POST /approve-close.
  const [approveTarget, setApproveTarget] = useState<Shift | null>(null);

  const { data: pending = [] } = useQuery({
    queryKey: ['shifts-pending-close'],
    queryFn: () => shiftsApi.pendingCloses(),
    enabled: canDecide,
    refetchInterval: 30_000,
  });

  const approve = useMutation({
    mutationFn: ({ id, payload }: { id: string; payload: ApproveClosePayload }) =>
      shiftsApi.approveClose(id, payload),
    onSuccess: () => {
      toast.success('تم اعتماد إقفال الوردية');
      qc.invalidateQueries({ queryKey: ['shifts-pending-close'] });
      qc.invalidateQueries({ queryKey: ['shifts'] });
      qc.invalidateQueries({ queryKey: ['shift-current'] });
      setApproveTarget(null);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الاعتماد'),
  });

  const reject = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      shiftsApi.rejectClose(id, reason),
    onSuccess: () => {
      toast.success('تم رفض طلب الإقفال — الوردية مفتوحة من جديد');
      qc.invalidateQueries({ queryKey: ['shifts-pending-close'] });
      qc.invalidateQueries({ queryKey: ['shifts'] });
      setRejectTarget(null);
      setRejectReason('');
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الرفض'),
  });

  if (!canDecide || pending.length === 0) return null;

  return (
    <div className="card p-4 border-2 border-amber-200 bg-amber-50/40">
      <div className="flex items-center gap-2 mb-3">
        <Square className="text-amber-600" size={16} />
        <h3 className="font-black text-amber-800">
          طلبات إقفال وردية بانتظار الاعتماد ({pending.length})
        </h3>
      </div>
      <div className="space-y-2">
        {pending.map((s: any) => (
          <div
            key={s.id}
            className="bg-white border border-amber-200 rounded-lg p-3 text-xs"
          >
            <div className="flex items-center justify-between flex-wrap gap-2 mb-1">
              <div className="flex items-center gap-2">
                <span className="font-mono font-bold">{s.shift_no}</span>
                <span className="chip bg-amber-100 text-amber-700 border-amber-200 text-[10px]">
                  قيمة المقدم: {EGP(s.close_requested_amount || 0)}
                </span>
                <span className="text-slate-700">
                  الكاشير: {s.requested_by_name || s.requested_by_username || '—'}
                </span>
              </div>
              <span className="text-slate-500 tabular-nums">
                {s.close_requested_at
                  ? new Date(s.close_requested_at).toLocaleString('ar-EG', {
                      timeZone: 'Africa/Cairo',
                    })
                  : ''}
              </span>
            </div>
            {s.close_requested_notes && (
              <div className="text-slate-600 mb-2">
                ملاحظات: {s.close_requested_notes}
              </div>
            )}
            <div className="flex gap-2">
              <button
                className="px-3 py-1.5 rounded bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-[11px]"
                onClick={() => {
                  // Same rule as the modal — prefer the live variance
                  // emitted by /shifts/pending-close. Using the stale
                  // stored column here would sometimes skip the
                  // treatment modal for a shift that actually has a
                  // non-zero live variance.
                  const expected = Number(
                    (s as any).expected_closing_live ?? s.expected_closing ?? 0,
                  );
                  const actual = Number(s.close_requested_amount || 0);
                  const variance = Number(
                    (s as any).variance_live ?? actual - expected,
                  );
                  if (Math.abs(variance) < 0.01) {
                    // No variance → no treatment needed, approve straight.
                    approve.mutate({ id: s.id, payload: {} });
                  } else {
                    setApproveTarget(s);
                  }
                }}
                disabled={approve.isPending || reject.isPending}
              >
                اعتماد الإقفال
              </button>
              <button
                className="px-3 py-1.5 rounded bg-rose-600 hover:bg-rose-700 text-white font-bold text-[11px]"
                onClick={() => {
                  setRejectTarget(s);
                  setRejectReason('');
                }}
                disabled={approve.isPending || reject.isPending}
              >
                رفض
              </button>
            </div>
          </div>
        ))}
      </div>

      {rejectTarget && (
        <div
          className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center p-4"
          onClick={() => {
            if (!reject.isPending) {
              setRejectTarget(null);
              setRejectReason('');
            }
          }}
        >
          <div
            className="bg-white rounded-2xl max-w-md w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h4 className="font-black text-slate-800 mb-2">رفض طلب الإقفال</h4>
            <p className="text-xs text-slate-500 mb-3">
              الوردية سترجع إلى حالة "مفتوحة" بعد الرفض.
            </p>
            <textarea
              rows={3}
              className="input w-full"
              placeholder="مثال: فرق في عدّ الدرج / تحتاج مراجعة المسموحات"
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value)}
              disabled={reject.isPending}
              autoFocus
            />
            <div className="flex justify-end gap-2 mt-3">
              <button
                className="btn-ghost"
                disabled={reject.isPending}
                onClick={() => {
                  setRejectTarget(null);
                  setRejectReason('');
                }}
              >
                إلغاء
              </button>
              <button
                className="px-4 py-2 rounded-lg bg-rose-600 text-white font-bold text-sm"
                disabled={reject.isPending}
                onClick={() => {
                  if (!rejectReason.trim()) {
                    toast.error('يجب كتابة سبب الرفض');
                    return;
                  }
                  reject.mutate({
                    id: rejectTarget.id,
                    reason: rejectReason.trim(),
                  });
                }}
              >
                تأكيد الرفض
              </button>
            </div>
          </div>
        </div>
      )}

      {approveTarget && (
        <ApproveVarianceDialog
          shift={approveTarget}
          onCancel={() => setApproveTarget(null)}
          onConfirm={(payload) =>
            approve.mutate({ id: approveTarget.id, payload })
          }
          pending={approve.isPending}
        />
      )}
    </div>
  );
}

/* ───────── Variance treatment dialog (migration 060) ─────────
   Shown when a shift has a non-zero variance and the manager
   presses "Approve Close". The manager must pick a treatment
   before the POST fires. Shortage → charge employee / company
   loss. Overage → revenue / suspense.
*/
function ApproveVarianceDialog({
  shift,
  onCancel,
  onConfirm,
  pending,
}: {
  shift: Shift;
  onCancel: () => void;
  onConfirm: (payload: ApproveClosePayload) => void;
  pending: boolean;
}) {
  // Prefer the LIVE figures returned by /shifts/pending-close over the
  // stored `shifts.expected_closing` column. The stored value was set
  // once at shift open (= opening_balance) and never refreshed during
  // pending_close for shifts opened before the backend fix — reading
  // it directly produced the "+1,035 fake surplus vs. real -7 shortage"
  // bug on SHF-2026-00004.
  const expected = Number(
    (shift as any).expected_closing_live ?? shift.expected_closing ?? 0,
  );
  const actual = Number(shift.close_requested_amount || 0);
  const variance = Number(
    (shift as any).variance_live ?? actual - expected,
  );
  const isShortage = variance < 0;

  const [treatment, setTreatment] = useState<VarianceTreatment>(
    isShortage ? 'company_loss' : 'revenue',
  );
  const [employeeId, setEmployeeId] = useState<string>(
    (shift as any).close_requested_by || '',
  );
  const [notes, setNotes] = useState('');

  const { data: users = [] } = useQuery({
    queryKey: ['users-pickable'],
    queryFn: () => usersApi.pickable(),
    enabled: isShortage, // only needed when we might charge an employee
    staleTime: 60_000,
  });

  const submit = () => {
    if (treatment === 'charge_employee' && !employeeId) {
      toast.error('اختر الموظف المسؤول');
      return;
    }
    onConfirm({
      variance_treatment: treatment,
      variance_employee_id:
        treatment === 'charge_employee' ? employeeId : undefined,
      variance_notes: notes.trim() || undefined,
    });
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 z-[65] flex items-center justify-center p-4"
      onClick={() => !pending && onCancel()}
    >
      <div
        className="bg-white rounded-2xl max-w-md w-full p-5 space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div>
          <h4 className="font-black text-slate-800">
            اعتماد الوردية — معالجة الفروقات
          </h4>
          <p className="text-xs text-slate-500">
            وردية {shift.shift_no} — فرق: {EGP(variance)} (
            {isShortage ? 'عجز' : 'زيادة'})
          </p>
        </div>

        <div className="text-xs space-y-2">
          <div className="font-bold text-slate-600 mb-1">طريقة المعالجة</div>
          {isShortage ? (
            <>
              <label className="flex items-start gap-2 cursor-pointer p-2 rounded border border-slate-200 hover:border-brand-400">
                <input
                  type="radio"
                  checked={treatment === 'charge_employee'}
                  onChange={() => setTreatment('charge_employee')}
                  disabled={pending}
                />
                <div>
                  <div className="font-bold">تحميل على الموظف (ذمة)</div>
                  <div className="text-slate-500">
                    Dr ذمم الموظفين 1123 · Cr الخزينة
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-2 cursor-pointer p-2 rounded border border-slate-200 hover:border-brand-400">
                <input
                  type="radio"
                  checked={treatment === 'company_loss'}
                  onChange={() => setTreatment('company_loss')}
                  disabled={pending}
                />
                <div>
                  <div className="font-bold">خسارة الشركة</div>
                  <div className="text-slate-500">
                    Dr عجز ورديات 531 · Cr الخزينة
                  </div>
                </div>
              </label>
            </>
          ) : (
            <>
              <label className="flex items-start gap-2 cursor-pointer p-2 rounded border border-slate-200 hover:border-brand-400">
                <input
                  type="radio"
                  checked={treatment === 'revenue'}
                  onChange={() => setTreatment('revenue')}
                  disabled={pending}
                />
                <div>
                  <div className="font-bold">إيراد زيادة وردية</div>
                  <div className="text-slate-500">
                    Dr الخزينة · Cr زيادة ورديات 421
                  </div>
                </div>
              </label>
              <label className="flex items-start gap-2 cursor-pointer p-2 rounded border border-slate-200 hover:border-brand-400">
                <input
                  type="radio"
                  checked={treatment === 'suspense'}
                  onChange={() => setTreatment('suspense')}
                  disabled={pending}
                />
                <div>
                  <div className="font-bold">حساب تسوية مؤقت</div>
                  <div className="text-slate-500">
                    Dr الخزينة · Cr التسوية المؤقتة 215
                  </div>
                </div>
              </label>
            </>
          )}
        </div>

        {isShortage && treatment === 'charge_employee' && (
          <div className="space-y-1">
            <label className="text-xs font-bold text-slate-600">
              الموظف المسؤول
            </label>
            <select
              className="input w-full"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              disabled={pending}
            >
              <option value="">اختر الموظف…</option>
              {users.map((u: any) => (
                <option key={u.id} value={u.id}>
                  {u.full_name} ({u.username})
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="space-y-1">
          <label className="text-xs font-bold text-slate-600">
            ملاحظات (اختياري)
          </label>
          <textarea
            rows={2}
            className="input w-full"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            disabled={pending}
          />
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-ghost" onClick={onCancel} disabled={pending}>
            إلغاء
          </button>
          <button
            className="px-4 py-2 rounded-lg bg-emerald-600 text-white font-bold text-sm disabled:opacity-60"
            onClick={submit}
            disabled={pending}
          >
            {pending ? 'جاري الاعتماد…' : 'اعتماد + ترحيل القيد'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* PR-14 — small one-line item used by the cash-out summary block. */
function CashOutLine({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-slate-600">{label}</span>
      <span className="font-mono tabular-nums text-slate-700">{EGP(value)}</span>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
 * PR-B1 — Counted-cash adjustment modal + history table.
 *
 * The adjustment is metadata-only: it UPDATEs shifts.actual_closing
 * and writes one audit row. shifts.difference is a generated column
 * so the new diff falls out automatically. NO journal_entries, NO
 * cashbox_transactions, NO cashbox balance change.
 * ────────────────────────────────────────────────────────────────── */

function AdjustCountModal({
  shift,
  currentExpected,
  onClose,
  onSaved,
}: {
  shift: Shift;
  currentExpected: number;
  onClose: () => void;
  onSaved: () => void;
}) {
  const currentActual = Number(
    (shift as any).actual_closing ??
      (shift as any).close_requested_amount ??
      0,
  );
  const currentDiff = currentActual - currentExpected;
  const [newActual, setNewActual] = useState<string>(
    currentActual ? String(currentActual) : '',
  );
  const [reason, setReason] = useState('');

  const newActualNum = Number(newActual || 0);
  const newDiff = newActualNum - currentExpected;
  const reasonValid = reason.trim().length >= 5;
  const amountValid =
    Number.isFinite(newActualNum) &&
    newActualNum >= 0 &&
    Math.abs(newActualNum - currentActual) > 0.005;
  const canSave = reasonValid && amountValid;

  const save = useMutation({
    mutationFn: () =>
      shiftsApi.adjustCount(shift.id, {
        new_actual_closing: newActualNum,
        reason: reason.trim(),
      }),
    onSuccess: () => {
      toast.success('تم تعديل مبلغ الإقفال');
      onSaved();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل التعديل'),
  });

  return (
    <Modal title={`تعديل مبلغ الإقفال — ${shift.shift_no}`} onClose={onClose}>
      <div className="space-y-4">
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[12px] text-amber-900">
          <span className="font-bold">ملاحظة محاسبية: </span>
          هذا التصحيح يعدّل المبلغ المُبلَّغ من الكاشير فقط — لا يتم إنشاء أي
          قيد محاسبي ولا حركة خزنة. الرصيد الفعلي للخزنة لا يتغير.
        </div>

        <div className="grid grid-cols-2 gap-3 text-sm">
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="text-[10px] text-slate-500 font-bold mb-1">
              الرصيد المتوقع
            </div>
            <div className="font-black tabular-nums text-slate-800">
              {EGP(currentExpected)}
            </div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
            <div className="text-[10px] text-slate-500 font-bold mb-1">
              المبلغ الحالي (المُبلَّغ)
            </div>
            <div className="font-black tabular-nums text-slate-800">
              {EGP(currentActual)}
            </div>
            <div
              className={`text-[10px] mt-1 tabular-nums ${
                currentDiff < -0.01
                  ? 'text-rose-600'
                  : currentDiff > 0.01
                    ? 'text-emerald-600'
                    : 'text-slate-500'
              }`}
            >
              الفرق: {EGP(currentDiff)}
            </div>
          </div>
        </div>

        <div>
          <label className="label">المبلغ الصحيح *</label>
          <input
            type="number"
            min="0"
            step="0.01"
            className="input"
            value={newActual}
            placeholder="0.00"
            onChange={(e) => setNewActual(e.target.value)}
            disabled={save.isPending}
          />
        </div>

        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2">
          <div className="text-[10px] text-emerald-700 font-bold mb-1">
            الفرق الجديد بعد التعديل
          </div>
          <div
            className={`font-black tabular-nums text-base ${
              newDiff < -0.01
                ? 'text-rose-600'
                : newDiff > 0.01
                  ? 'text-emerald-600'
                  : 'text-emerald-700'
            }`}
          >
            {newActual ? EGP(newDiff) : '—'}
          </div>
        </div>

        <div>
          <label className="label text-rose-600">سبب التعديل (مطلوب) *</label>
          <textarea
            className="input"
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="مثال: الكاشير أدخل 1500 بالخطأ بدلاً من 1050 — تم التحقق من العد يدوياً"
            disabled={save.isPending}
          />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-slate-200 pt-3">
          <button
            type="button"
            className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200"
            onClick={onClose}
            disabled={save.isPending}
          >
            إلغاء
          </button>
          <button
            type="button"
            className="px-4 py-1.5 rounded-lg text-xs font-bold bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
            onClick={() => save.mutate()}
            disabled={!canSave || save.isPending}
          >
            {save.isPending ? 'جارٍ الحفظ…' : 'حفظ التعديل'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

function ShiftAdjustmentHistory({
  adjustments,
}: {
  adjustments: ShiftCountAdjustment[];
}) {
  return (
    <div className="border border-slate-200 rounded-lg overflow-hidden">
      <div className="bg-slate-50 p-3 text-sm font-bold flex items-center justify-between">
        <span>سجل تعديلات مبلغ الإقفال</span>
        <span className="text-[11px] text-slate-500">
          {adjustments.length} تعديل
        </span>
      </div>
      {adjustments.length === 0 ? (
        <div className="text-center text-xs text-slate-500 py-6">
          لا توجد تعديلات على مبلغ الإقفال
        </div>
      ) : (
        <div className="overflow-x-auto max-h-56 overflow-y-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-100">
              <tr>
                <th className="text-right px-2 py-2">التاريخ والوقت</th>
                <th className="text-right px-2 py-2">من عدّل</th>
                <th className="text-right px-2 py-2">السبب</th>
                <th className="text-right px-2 py-2">المبلغ القديم</th>
                <th className="text-right px-2 py-2">المبلغ الجديد</th>
                <th className="text-right px-2 py-2">الفرق القديم</th>
                <th className="text-right px-2 py-2">الفرق الجديد</th>
              </tr>
            </thead>
            <tbody>
              {adjustments.map((a) => (
                <tr key={a.id} className="border-t border-slate-100">
                  <td className="px-2 py-1.5 font-mono tabular-nums whitespace-nowrap">
                    {new Date(a.adjusted_at).toLocaleString('en-GB', {
                      timeZone: 'Africa/Cairo',
                      hour12: false,
                    })}
                  </td>
                  <td className="px-2 py-1.5">{a.adjusted_by_name || '—'}</td>
                  <td className="px-2 py-1.5 text-slate-700 max-w-[260px] truncate" title={a.reason}>
                    {a.reason}
                  </td>
                  <td className="px-2 py-1.5 text-rose-600 font-mono tabular-nums">
                    {a.old_actual_closing == null ? '—' : EGP(Number(a.old_actual_closing))}
                  </td>
                  <td className="px-2 py-1.5 text-emerald-700 font-mono tabular-nums font-bold">
                    {EGP(Number(a.new_actual_closing))}
                  </td>
                  <td className="px-2 py-1.5 font-mono tabular-nums">
                    {a.old_difference == null ? '—' : EGP(Number(a.old_difference))}
                  </td>
                  <td className="px-2 py-1.5 font-mono tabular-nums">
                    {a.new_difference == null ? '—' : EGP(Number(a.new_difference))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
