import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Check,
  X as XIcon,
  RefreshCw,
  Landmark,
  CheckSquare,
  Square,
} from 'lucide-react';

import { cashDeskApi, ReconciliationRow } from '@/api/cash-desk.api';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

/**
 * Bank reconciliation page.
 *
 * Pick a cashbox + date range, tick every transaction that appears on
 * the paper/PDF statement, and save. The summary panel shows
 * unreconciled totals so you can quickly spot missing entries.
 */
export default function BankReconciliation() {
  const qc = useQueryClient();
  const todayISO = new Date().toISOString().slice(0, 10);
  const monthStart = todayISO.slice(0, 7) + '-01';
  const [cashboxId, setCashboxId] = useState('');
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(todayISO);
  const [status, setStatus] = useState<'all' | 'reconciled' | 'open'>('open');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [statementRef, setStatementRef] = useState('');

  const { data: cashboxes = [] } = useQuery({
    queryKey: ['cashboxes', 'all'],
    queryFn: () => cashDeskApi.cashboxes(true),
  });

  // Only bank/wallet make sense for reconciliation.
  const reconcilable = cashboxes.filter(
    (c) => c.kind === 'bank' || c.kind === 'ewallet',
  );

  const { data, isLoading } = useQuery({
    queryKey: ['reconciliation', cashboxId, from, to, status],
    queryFn: () =>
      cashDeskApi.reconciliation({ cashbox_id: cashboxId, from, to, status }),
    enabled: !!cashboxId,
  });

  const rows = data?.rows || [];
  const summary = data?.summary;

  const markMut = useMutation({
    mutationFn: () =>
      cashDeskApi.markReconciled(
        Array.from(selected),
        statementRef || undefined,
      ),
    onSuccess: (r) => {
      toast.success(`تم تسوية ${r.updated} حركة`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['reconciliation'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل التسوية'),
  });

  const unmarkMut = useMutation({
    mutationFn: () => cashDeskApi.unmarkReconciled(Array.from(selected)),
    onSuccess: (r) => {
      toast.success(`تم إلغاء تسوية ${r.updated} حركة`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['reconciliation'] });
    },
  });

  const toggle = (id: string) => {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  };

  const selectedSum = useMemo(() => {
    let inSum = 0;
    let outSum = 0;
    for (const r of rows) {
      if (!selected.has(r.id)) continue;
      const amt = Number(r.amount || 0);
      if (r.direction === 'in') inSum += amt;
      else outSum += amt;
    }
    return { inSum, outSum };
  }, [rows, selected]);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
          <Landmark className="text-brand-600" /> التسوية البنكية
        </h2>
        <p className="text-sm text-slate-500 mt-1">
          قارن حركات الحساب البنكي/المحفظة مع كشف البنك وعلّم الحركات المطابقة
        </p>
      </div>

      <div className="card p-4 space-y-3">
        <div className="grid md:grid-cols-4 gap-3">
          <label className="block">
            <span className="text-xs font-bold text-slate-600 mb-1 block">
              الحساب
            </span>
            <select
              className="input"
              value={cashboxId}
              onChange={(e) => setCashboxId(e.target.value)}
            >
              <option value="">— اختر —</option>
              {reconcilable.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name_ar} ({c.kind === 'bank' ? 'بنك' : 'محفظة'})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600 mb-1 block">
              من
            </span>
            <input
              type="date"
              className="input"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600 mb-1 block">
              إلى
            </span>
            <input
              type="date"
              className="input"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600 mb-1 block">
              الحالة
            </span>
            <select
              className="input"
              value={status}
              onChange={(e) => setStatus(e.target.value as any)}
            >
              <option value="open">غير مُسواة</option>
              <option value="reconciled">مُسواة</option>
              <option value="all">الكل</option>
            </select>
          </label>
        </div>
      </div>

      {summary && (
        <div className="grid md:grid-cols-4 gap-3">
          <div className="card p-3 border border-emerald-200 bg-emerald-50">
            <div className="text-xs text-slate-500">داخل (النظام)</div>
            <div className="font-mono font-bold text-emerald-700">
              {EGP(summary.system_in)}
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              غير مسوّى: {EGP(summary.unreconciled_in)}
            </div>
          </div>
          <div className="card p-3 border border-rose-200 bg-rose-50">
            <div className="text-xs text-slate-500">خارج (النظام)</div>
            <div className="font-mono font-bold text-rose-700">
              {EGP(summary.system_out)}
            </div>
            <div className="text-[11px] text-slate-400 mt-1">
              غير مسوّى: {EGP(summary.unreconciled_out)}
            </div>
          </div>
          <div className="card p-3 border border-indigo-200 bg-indigo-50">
            <div className="text-xs text-slate-500">مسوّى داخل</div>
            <div className="font-mono font-bold text-indigo-700">
              {EGP(summary.reconciled_in)}
            </div>
          </div>
          <div className="card p-3 border border-indigo-200 bg-indigo-50">
            <div className="text-xs text-slate-500">مسوّى خارج</div>
            <div className="font-mono font-bold text-indigo-700">
              {EGP(summary.reconciled_out)}
            </div>
          </div>
        </div>
      )}

      {selected.size > 0 && (
        <div className="card p-3 border-2 border-brand-300 bg-brand-50 flex items-center gap-3 flex-wrap">
          <div className="text-sm font-bold">
            محدد: {selected.size} حركة ({EGP(selectedSum.inSum)} داخل ·{' '}
            {EGP(selectedSum.outSum)} خارج)
          </div>
          <input
            className="input flex-1 min-w-[200px]"
            placeholder="مرجع كشف الحساب (اختياري)"
            value={statementRef}
            onChange={(e) => setStatementRef(e.target.value)}
          />
          <button
            className="btn-primary"
            onClick={() => markMut.mutate()}
            disabled={markMut.isPending}
          >
            <Check size={14} /> تسوية المحدد
          </button>
          <button
            className="btn-secondary"
            onClick={() => unmarkMut.mutate()}
            disabled={unmarkMut.isPending}
          >
            <XIcon size={14} /> إلغاء تسوية
          </button>
          <button className="btn-ghost" onClick={() => setSelected(new Set())}>
            إلغاء التحديد
          </button>
        </div>
      )}

      {!cashboxId ? (
        <div className="py-12 text-center text-slate-400 border border-dashed border-slate-200 rounded-lg">
          اختر حساب بنكي أو محفظة أعلاه لبدء التسوية
        </div>
      ) : isLoading ? (
        <div className="py-12 text-center text-slate-400">
          <RefreshCw className="animate-spin mx-auto mb-2" /> جارٍ التحميل...
        </div>
      ) : (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs font-bold text-slate-600 sticky top-0">
              <tr>
                <th className="text-right px-3 py-2 w-12"></th>
                <th className="text-right px-3 py-2">التاريخ</th>
                <th className="text-right px-3 py-2">النوع</th>
                <th className="text-right px-3 py-2">داخل</th>
                <th className="text-right px-3 py-2">خارج</th>
                <th className="text-right px-3 py-2">الرصيد</th>
                <th className="text-right px-3 py-2">مرجع الكشف</th>
                <th className="text-right px-3 py-2">ملاحظات</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={8} className="text-center py-10 text-slate-400">
                    لا توجد حركات في هذه الفترة
                  </td>
                </tr>
              ) : (
                rows.map((r: ReconciliationRow) => {
                  const isSel = selected.has(r.id);
                  const isIn = r.direction === 'in';
                  return (
                    <tr
                      key={r.id}
                      className={`border-t border-slate-100 hover:bg-slate-50 cursor-pointer ${
                        r.is_reconciled ? 'bg-emerald-50/40' : ''
                      }`}
                      onClick={() => toggle(r.id)}
                    >
                      <td className="px-3 py-2">
                        {isSel ? (
                          <CheckSquare
                            size={18}
                            className="text-brand-600"
                          />
                        ) : (
                          <Square size={18} className="text-slate-300" />
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs font-mono">
                        {new Date(r.created_at).toLocaleString('en-GB', {
                          timeZone: 'Africa/Cairo',
                          day: '2-digit',
                          month: '2-digit',
                          year: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </td>
                      <td className="px-3 py-2 text-xs">{r.category}</td>
                      <td className="px-3 py-2 font-mono font-bold text-emerald-700">
                        {isIn ? EGP(r.amount) : '—'}
                      </td>
                      <td className="px-3 py-2 font-mono font-bold text-rose-700">
                        {isIn ? '—' : EGP(r.amount)}
                      </td>
                      <td className="px-3 py-2 font-mono">
                        {EGP(r.balance_after)}
                      </td>
                      <td className="px-3 py-2 text-xs font-mono">
                        {r.is_reconciled ? (
                          <span className="chip bg-emerald-100 text-emerald-700">
                            ✓ {r.statement_reference || 'مسوّاة'}
                          </span>
                        ) : (
                          '—'
                        )}
                      </td>
                      <td className="px-3 py-2 text-xs text-slate-500 max-w-xs truncate">
                        {r.notes || '—'}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
