/**
 * CashSourceSelector — reusable picker used by every cash-out form
 * (PR-15 / PR-A).
 *
 * Two modes:
 *
 *   1. "من وردية مفتوحة" — operator picks one of the currently
 *      open/pending shifts. The selector emits both `shift_id` and
 *      the shift's `cashbox_id` so the parent form can post a
 *      strongly-linked cash-out.
 *
 *   2. "من خزنة مباشرة" — operator picks a cashbox directly.
 *      `shift_id` stays null. A clear warning is rendered:
 *      "هذه الحركة غير مرتبطة بوردية ولن تظهر داخل إقفال وردية إلا
 *       كتسوية غير مربوطة."
 *
 * Default mode: when the current user has exactly one open shift on
 * any cashbox, default to that shift. Otherwise the operator must
 * choose explicitly.
 */

import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, Clock, Wallet } from 'lucide-react';
import { shiftsApi, Shift } from '@/api/shifts.api';
import { cashDeskApi } from '@/api/cash-desk.api';
import { useAuthStore } from '@/stores/auth.store';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

export type CashSource =
  | { mode: 'open_shift'; shift_id: string; cashbox_id: string }
  // PR-EMP-ADVANCE-PAY-1 — `cashbox_id` can be `null` while the
  // operator is still picking. The selector renders the cashbox
  // dropdown immediately on mode flip so they can choose; the parent
  // form gates submit on `cashbox_id != null`.
  | { mode: 'direct_cashbox'; shift_id: null; cashbox_id: string | null }
  | { mode: 'unset'; shift_id: null; cashbox_id: null };

export interface CashSourceSelectorProps {
  value: CashSource;
  onChange: (next: CashSource) => void;
  /** Optional — restrict the cashbox dropdown to this set (e.g. when
   *  a parent form already filtered to active boxes). */
  cashboxFilter?: (cb: any) => boolean;
  /** Disable the whole control (e.g. when a mutation is pending). */
  disabled?: boolean;
}

export function CashSourceSelector({
  value,
  onChange,
  cashboxFilter,
  disabled,
}: CashSourceSelectorProps) {
  const authUser = useAuthStore((s) => s.user);

  // Open shifts (open + pending_close) — anyone can pick from any
  // currently-active drawer, not just their own. This matches the
  // operational reality: a manager often pays out of a cashier's
  // open shift on the cashier's behalf.
  const { data: shifts = [], isFetching: isShiftsFetching } = useQuery({
    queryKey: ['cash-source-open-shifts'],
    queryFn: () => shiftsApi.list({ status: 'open' }),
    staleTime: 30_000,
  });

  const openShifts = useMemo(
    () =>
      (shifts as Shift[]).filter(
        (s) => s.status === 'open' || s.status === 'pending_close',
      ),
    [shifts],
  );

  const { data: cashboxes = [] } = useQuery({
    queryKey: ['cashboxes', 'active'],
    queryFn: () => cashDeskApi.cashboxes(false),
    staleTime: 60_000,
  });

  const filteredCashboxes = useMemo(() => {
    const list = (cashboxes as any[]) || [];
    return cashboxFilter ? list.filter(cashboxFilter) : list;
  }, [cashboxes, cashboxFilter]);

  // Default behaviour — when the current user has exactly one open
  // shift, pre-select that shift on first render. Don't override an
  // explicit pick.
  useEffect(() => {
    if (value.mode !== 'unset') return;
    if (!openShifts.length || !authUser?.id) return;
    const mine = openShifts.filter((s) => s.opened_by === authUser.id);
    if (mine.length === 1) {
      onChange({
        mode: 'open_shift',
        shift_id: mine[0].id,
        cashbox_id: mine[0].cashbox_id,
      });
    }
  }, [openShifts, authUser?.id, value.mode, onChange]);

  const setMode = (mode: 'open_shift' | 'direct_cashbox') => {
    if (mode === value.mode) return;
    if (mode === 'open_shift') {
      // Keep the previously-picked cashbox if it matches an open shift,
      // otherwise the operator picks again.
      const match = openShifts.find((s) => s.cashbox_id === value.cashbox_id);
      if (match) {
        onChange({
          mode: 'open_shift',
          shift_id: match.id,
          cashbox_id: match.cashbox_id,
        });
      } else {
        onChange({ mode: 'unset', shift_id: null, cashbox_id: null });
      }
    } else {
      // PR-EMP-ADVANCE-PAY-1 — flip to direct_cashbox IMMEDIATELY,
      // even if no cashbox is currently selected. Previously this
      // branch fell back to `mode: 'unset'` when `cashbox_id` was
      // null, which hid the cashbox dropdown entirely (line 246
      // only renders it when `mode === 'direct_cashbox'`). The
      // operator's only escape was to first pick a shift to seed
      // `cashbox_id`, then flip back to direct — which is exactly
      // the path that mis-attributed advance EXP-2026-000031 to a
      // shift. Now the dropdown shows up on the first click and
      // the operator picks the cashbox directly.
      onChange({
        mode: 'direct_cashbox',
        shift_id: null,
        cashbox_id: value.cashbox_id ?? null,
      });
    }
  };

  const onPickShift = (shiftId: string) => {
    const s = openShifts.find((x) => x.id === shiftId);
    if (!s) return;
    onChange({
      mode: 'open_shift',
      shift_id: s.id,
      cashbox_id: s.cashbox_id,
    });
  };

  const onPickCashbox = (cashboxId: string) => {
    onChange({
      mode: 'direct_cashbox',
      shift_id: null,
      cashbox_id: cashboxId,
    });
  };

  const fmtTime = (iso: string) =>
    new Date(iso).toLocaleString('en-GB', {
      timeZone: 'Africa/Cairo',
      hour12: false,
    });

  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700/40 bg-slate-50/60 dark:bg-slate-950/40 p-3 space-y-3">
      <div className="text-xs font-bold text-slate-700 dark:text-slate-200">
        مصدر الصرف
      </div>

      {/* Mode toggle */}
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setMode('open_shift')}
          className={`px-3 py-2 rounded-lg text-xs font-bold border transition flex items-center justify-center gap-1.5 ${
            value.mode === 'open_shift'
              ? 'bg-emerald-600 text-white border-emerald-700'
              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100 dark:bg-slate-900/60 dark:text-slate-200 dark:border-slate-700/40'
          }`}
        >
          <Clock size={12} /> من وردية مفتوحة
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => setMode('direct_cashbox')}
          className={`px-3 py-2 rounded-lg text-xs font-bold border transition flex items-center justify-center gap-1.5 ${
            value.mode === 'direct_cashbox'
              ? 'bg-amber-600 text-white border-amber-700'
              : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-100 dark:bg-slate-900/60 dark:text-slate-200 dark:border-slate-700/40'
          }`}
        >
          <Wallet size={12} /> من خزنة مباشرة
        </button>
      </div>

      {/* Open-shift picker */}
      {value.mode !== 'direct_cashbox' && (
        <div>
          {isShiftsFetching ? (
            <div className="text-[11px] text-slate-500">جارٍ تحميل الورديات…</div>
          ) : openShifts.length === 0 ? (
            <div className="px-3 py-2 rounded-lg border border-amber-200 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:border-amber-500/30 dark:text-amber-200 text-[11px]">
              لا توجد ورديات مفتوحة حالياً — استخدم "من خزنة مباشرة" أو افتح وردية.
            </div>
          ) : (
            <>
              <label className="block text-[11px] text-slate-600 dark:text-slate-400 mb-1 font-bold">
                اختر الوردية
              </label>
              <select
                disabled={disabled}
                className="input input-sm w-full"
                value={value.mode === 'open_shift' ? value.shift_id : ''}
                onChange={(e) => onPickShift(e.target.value)}
              >
                <option value="">— اختر وردية —</option>
                {openShifts.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.shift_no} · {s.opened_by_name || '—'} · {s.cashbox_name || '—'}
                    {' · فتحت '}
                    {fmtTime(s.opened_at)}
                  </option>
                ))}
              </select>
              {value.mode === 'open_shift' && (() => {
                const s = openShifts.find((x) => x.id === value.shift_id);
                if (!s) return null;
                return (
                  <div className="mt-2 px-3 py-2 rounded-lg bg-emerald-50 dark:bg-emerald-500/10 border border-emerald-200 dark:border-emerald-500/30 text-[11px] text-emerald-900 dark:text-emerald-200">
                    سيتم الصرف من <span className="font-bold">{s.shift_no}</span>
                    {' / '}
                    خزنة <span className="font-bold">{s.cashbox_name || '—'}</span>
                    {' · '}
                    الرصيد المتوقع{' '}
                    <span className="font-bold tabular-nums">
                      {EGP(s.expected_closing)}
                    </span>
                  </div>
                );
              })()}
            </>
          )}
        </div>
      )}

      {/* Direct-cashbox picker */}
      {value.mode === 'direct_cashbox' && (
        <div>
          <label className="block text-[11px] text-slate-600 dark:text-slate-400 mb-1 font-bold">
            اختر الخزنة
          </label>
          <select
            disabled={disabled}
            className="input input-sm w-full"
            value={value.cashbox_id || ''}
            onChange={(e) => onPickCashbox(e.target.value)}
          >
            <option value="">— اختر خزنة —</option>
            {filteredCashboxes.map((cb) => (
              <option key={cb.id} value={cb.id}>
                {cb.name_ar}
              </option>
            ))}
          </select>
          <div className="mt-2 px-3 py-2 rounded-lg bg-amber-50 dark:bg-amber-500/10 border border-amber-200 dark:border-amber-500/30 text-[11px] text-amber-900 dark:text-amber-200 flex items-start gap-2">
            <AlertTriangle size={13} className="shrink-0 mt-0.5" />
            <span>
              هذه الحركة غير مرتبطة بوردية ولن تظهر داخل إقفال وردية إلا كتسوية
              غير مربوطة.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
