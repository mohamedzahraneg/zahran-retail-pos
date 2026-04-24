/**
 * Payroll / حسابات الموظفين page.
 *
 * Balance semantics (DO NOT REGRESS):
 *   • `EmployeeBalance.net_balance` is the authoritative number.
 *     It comes from v_employee_balances_gl on the server — NEVER from a
 *     client-side sum of transactions.
 *   • net_balance > 0 → company owes employee (render GREEN).
 *   • net_balance < 0 → employee owes company (render RED).
 *   • net_balance = 0 → settled.
 *
 * Filter semantics (DO NOT REGRESS):
 *   • Employee filter + type filter are server-side (query params).
 *   • Search filter is client-side (substring match).
 *   • Keep all three in separate React state atoms — do NOT collapse into
 *     one object; that was the cause of the regression that silently
 *     broke filtering.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Wallet,
  Plus,
  Trash2,
  X,
  Users,
  Search,
} from 'lucide-react';
import {
  payrollApi,
  type EmpTxnType,
  type CreateEmpTxn,
  type CreatePayrollType,
  CREATE_TXN_TYPES,
  TXN_TYPE_LABELS,
  TXN_DIRECTION,
} from '@/api/payroll.api';
import { usersApi } from '@/api/users.api';
import { useAuthStore } from '@/stores/auth.store';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const TYPE_STYLES: Record<EmpTxnType, string> = {
  wage: 'bg-emerald-100 text-emerald-800 border-emerald-200',
  bonus: 'bg-indigo-100 text-indigo-800 border-indigo-200',
  deduction: 'bg-rose-100 text-rose-800 border-rose-200',
  advance: 'bg-purple-100 text-purple-800 border-purple-200',
  payout: 'bg-slate-200 text-slate-800 border-slate-300',
};

export default function Payroll() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  // Write-side gate — matches the backend PayrollController, which
  // enforces @Permissions('employee.deductions.manage') on POST /
  // PATCH / DELETE. Route visibility is gated separately on
  // `employee.team.view` (same permission that reveals /team and the
  // read endpoints — see App.tsx and Sidebar.tsx).
  const canManage = hasPermission('employee.deductions.manage');

  const qc = useQueryClient();
  const [addOpen, setAddOpen] = useState(false);
  const [selectedEmp, setSelectedEmp] = useState<string>('');
  const [filterType, setFilterType] = useState<'' | EmpTxnType>('');
  const [search, setSearch] = useState('');

  // Balances — sourced from the GL view (v_employee_balances_gl).
  // Every new HR mutation (bonus / deduction / advance / txn) posts to the
  // GL via a DB trigger, so this view is always current.
  const { data: balances = [] } = useQuery({
    queryKey: ['payroll-balances'],
    queryFn: () => payrollApi.balances(),
    refetchInterval: 30_000,
  });

  // Transaction list — server-side filter by employee + type. The search
  // box filters client-side (on whatever the server returned). All three
  // filters must remain independent — they were regressing when we
  // coupled them through a single state object; keep them separate.
  const { data: txns = [] } = useQuery({
    queryKey: ['payroll-list', selectedEmp, filterType],
    queryFn: () =>
      payrollApi.list({
        employee_id: selectedEmp || undefined,
        type: filterType || undefined,
        limit: 500,
      }),
    // Keep results stable while the user types in the search box — only
    // re-fetch when the employee or type filter actually changes.
    staleTime: 30_000,
  });

  const { data: employees = [] } = useQuery({
    queryKey: ['users-list'],
    queryFn: () => usersApi.list(),
    staleTime: 60_000,
  });

  const remove = useMutation({
    mutationFn: (id: string) => payrollApi.remove(id),
    onSuccess: () => {
      toast.success('تم حذف الحركة');
      qc.invalidateQueries({ queryKey: ['payroll-list'] });
      qc.invalidateQueries({ queryKey: ['payroll-balances'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحذف'),
  });

  const filteredTxns = useMemo(() => {
    if (!search) return txns;
    const q = search.toLowerCase();
    return txns.filter(
      (t) =>
        (t.employee_name || '').toLowerCase().includes(q) ||
        (t.description || '').toLowerCase().includes(q),
    );
  }, [txns, search]);

  // Totals for the header KPIs (filtered list).
  const totals = useMemo(() => {
    const t = { wages: 0, bonuses: 0, deductions: 0, advances: 0 };
    for (const r of filteredTxns) {
      const a = Number(r.amount);
      if (r.type === 'wage') t.wages += a;
      if (r.type === 'bonus') t.bonuses += a;
      if (r.type === 'deduction') t.deductions += a;
      if (r.type === 'advance') t.advances += a;
    }
    return t;
  }, [filteredTxns]);

  return (
    <div className="p-6 space-y-6" dir="rtl">
      <header className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-black flex items-center gap-2 text-slate-800">
            <Wallet className="w-7 h-7 text-brand-500" />
            حسابات الموظفين
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            سجل يوميات ومكافآت وخصومات ومصروفات وسلف لكل موظف — مع الرصيد
            المستحق.
          </p>
        </div>
        {canManage && (
          <button
            onClick={() => setAddOpen(true)}
            className="btn-primary flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> تسجيل حركة جديدة
          </button>
        )}
      </header>

      {/* Balances per employee */}
      <section className="card p-4">
        <div className="flex items-center gap-2 mb-3">
          <Users className="w-5 h-5 text-brand-500" />
          <h2 className="font-bold text-slate-800">أرصدة الموظفين</h2>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {balances.length === 0 && (
            <div className="col-span-full text-center text-slate-400 py-6">
              لا يوجد موظفون بعد
            </div>
          )}
          {balances.map((b) => {
            // Canonical headline — from v_employee_gl_balance (COA 1123
            // + 213, migration 075). Sign convention:
            //   glb > 0  →  employee owes company (rose)
            //   glb < 0  →  company owes employee (emerald)
            // Was reading source-derived `net_balance` with opposite
            // sign — switched for consistency with opening-balance
            // reset entries (PR #73).
            const glb = Number(b.gl_balance ?? 0);
            const liab = Number(b.liabilities);
            const recv = Number(b.receivables);
            return (
              <button
                key={b.employee_id}
                onClick={() => setSelectedEmp(b.employee_id)}
                className={`text-right border rounded-lg p-3 transition ${
                  selectedEmp === b.employee_id
                    ? 'border-brand-500 bg-brand-50 shadow'
                    : 'border-slate-200 hover:bg-slate-50'
                }`}
              >
                <div className="font-bold text-slate-800">
                  {b.full_name || b.username}
                </div>
                <div className="flex items-baseline justify-between mt-2">
                  <div
                    className={`text-xl font-black font-mono ${
                      glb > 0.01
                        ? 'text-rose-700'
                        : glb < -0.01
                          ? 'text-emerald-700'
                          : 'text-slate-600'
                    }`}
                  >
                    {EGP(Math.abs(glb))}
                  </div>
                  <div className="text-[11px] text-slate-500">
                    {glb > 0.01
                      ? 'مدين للشركة'
                      : glb < -0.01
                        ? 'مستحق للموظف'
                        : 'متوازن'}
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-slate-400 flex items-center justify-between">
                  <span>{b.txn_count} حركة</span>
                  <span>
                    {b.last_txn_date
                      ? new Date(b.last_txn_date).toLocaleDateString('en-GB')
                      : '—'}
                  </span>
                </div>
                <div className="mt-1 text-[10px] text-slate-500">
                  مستحقات {EGP(liab)} · سُلف {EGP(recv)}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Filters + totals */}
      <section className="card p-4 space-y-3">
        <div className="flex items-center gap-2 flex-wrap">
          <div className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2 flex-1 min-w-[220px]">
            <Search className="w-4 h-4 text-slate-400" />
            <input
              className="bg-transparent outline-none flex-1"
              placeholder="بحث…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <select
            className="input max-w-[200px]"
            value={selectedEmp}
            onChange={(e) => setSelectedEmp(e.target.value)}
          >
            <option value="">كل الموظفين</option>
            {employees.map((u: any) => (
              <option key={u.id} value={u.id}>
                {u.full_name || u.username}
              </option>
            ))}
          </select>
          <select
            className="input max-w-[160px]"
            value={filterType}
            onChange={(e) => setFilterType(e.target.value as any)}
          >
            <option value="">كل الأنواع</option>
            {Object.entries(TXN_TYPE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          {(selectedEmp || filterType || search) && (
            <button
              onClick={() => {
                setSelectedEmp('');
                setFilterType('');
                setSearch('');
              }}
              className="btn-ghost text-xs"
            >
              مسح
            </button>
          )}
        </div>

        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
          <MiniStat label="يوميات" value={EGP(totals.wages)} tone="emerald" />
          <MiniStat label="مكافآت" value={EGP(totals.bonuses)} tone="indigo" />
          <MiniStat label="خصومات" value={EGP(totals.deductions)} tone="rose" />
          <MiniStat label="سلف" value={EGP(totals.advances)} tone="purple" />
        </div>
      </section>

      {/* Ledger */}
      <section className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600 text-xs">
            <tr>
              <th className="p-3 text-right">التاريخ</th>
              <th className="p-3 text-right">الموظف</th>
              <th className="p-3 text-right">النوع</th>
              <th className="p-3 text-right">المبلغ</th>
              <th className="p-3 text-right">الوصف</th>
              <th className="p-3 text-right">أُضيفت بواسطة</th>
              <th className="p-3"></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {filteredTxns.length === 0 && (
              <tr>
                <td colSpan={7} className="p-8 text-center text-slate-400">
                  لا توجد حركات تطابق الفلتر
                </td>
              </tr>
            )}
            {filteredTxns.map((r) => {
              const dir = TXN_DIRECTION[r.type];
              const amt = Number(r.amount);
              return (
                <tr key={r.id} className="hover:bg-slate-50">
                  <td className="p-3 text-xs font-mono">
                    {new Date(r.txn_date).toLocaleDateString('en-GB')}
                  </td>
                  <td className="p-3 font-medium">
                    {r.employee_name || r.employee_username}
                  </td>
                  <td className="p-3">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full border text-[11px] font-bold ${TYPE_STYLES[r.type]}`}
                    >
                      {TXN_TYPE_LABELS[r.type]}
                    </span>
                  </td>
                  <td
                    className={`p-3 font-bold font-mono ${
                      dir > 0 ? 'text-emerald-700' : 'text-rose-700'
                    }`}
                  >
                    {dir > 0 ? '+ ' : '− '}
                    {EGP(amt)}
                  </td>
                  <td className="p-3 text-xs text-slate-600">
                    {r.description || '—'}
                  </td>
                  <td className="p-3 text-xs text-slate-500">
                    {r.created_by_name || '—'}
                  </td>
                  <td className="p-3">
                    {canManage && (
                      <button
                        onClick={() => {
                          if (window.confirm('حذف هذه الحركة؟')) {
                            remove.mutate(r.id);
                          }
                        }}
                        className="icon-btn text-rose-600"
                        title="حذف"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>

      {addOpen && (
        <AddTxnModal
          employees={employees}
          defaultEmployeeId={selectedEmp}
          onClose={() => setAddOpen(false)}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['payroll-list'] });
            qc.invalidateQueries({ queryKey: ['payroll-balances'] });
            setAddOpen(false);
          }}
        />
      )}
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'emerald' | 'indigo' | 'rose' | 'amber' | 'purple';
}) {
  const cls: Record<string, string> = {
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-800',
    rose: 'bg-rose-50 border-rose-200 text-rose-800',
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
    purple: 'bg-purple-50 border-purple-200 text-purple-800',
  };
  return (
    <div className={`border rounded-lg p-2 ${cls[tone]}`}>
      <div className="text-[10px] font-bold">{label}</div>
      <div className="font-mono font-black text-sm mt-0.5">{value}</div>
    </div>
  );
}

function AddTxnModal({
  employees,
  defaultEmployeeId,
  onClose,
  onSaved,
}: {
  employees: any[];
  defaultEmployeeId?: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<CreateEmpTxn>({
    employee_id: defaultEmployeeId || employees[0]?.id || '',
    type: 'wage',
    amount: 0,
    txn_date: new Date().toISOString().slice(0, 10),
    description: '',
  });

  const save = useMutation({
    mutationFn: () => payrollApi.create(form),
    onSuccess: () => {
      toast.success('تم تسجيل الحركة');
      onSaved();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="modal-panel w-full max-w-md space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-bold">تسجيل حركة جديدة</h2>
          <button onClick={onClose} className="icon-btn">
            <X className="w-5 h-5" />
          </button>
        </div>
        <div>
          <label className="label">الموظف *</label>
          <select
            className="input"
            value={form.employee_id}
            onChange={(e) =>
              setForm({ ...form, employee_id: e.target.value })
            }
          >
            <option value="">— اختر —</option>
            {employees.map((u: any) => (
              <option key={u.id} value={u.id}>
                {u.full_name || u.username}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="label">النوع *</label>
          <div className="grid grid-cols-2 gap-1">
            {CREATE_TXN_TYPES.map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setForm({ ...form, type: t })}
                className={`px-2 py-2 rounded-lg text-xs font-bold transition ${
                  form.type === t
                    ? `border ${TYPE_STYLES[t]}`
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200 border border-transparent'
                }`}
              >
                {TXN_TYPE_LABELS[t]}
              </button>
            ))}
          </div>
          <div className="text-[11px] text-slate-500 mt-1">
            {TXN_DIRECTION[form.type] > 0
              ? '➕ يُضاف لمستحقات الموظف'
              : '➖ يُقتطع من مستحقات الموظف'}
          </div>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">المبلغ *</label>
            <input
              type="number"
              step="0.01"
              className="input"
              value={form.amount || ''}
              onChange={(e) =>
                setForm({ ...form, amount: Number(e.target.value) || 0 })
              }
            />
          </div>
          <div>
            <label className="label">التاريخ</label>
            <input
              type="date"
              className="input"
              value={form.txn_date}
              onChange={(e) =>
                setForm({ ...form, txn_date: e.target.value })
              }
            />
          </div>
        </div>
        <div>
          <label className="label">الوصف</label>
          <textarea
            rows={2}
            className="input"
            placeholder="مثال: يومية 21 أبريل، خصم تأخير 30 دقيقة…"
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <button onClick={onClose} className="btn-ghost">
            إلغاء
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !form.employee_id || form.amount <= 0}
            className="btn-primary"
          >
            حفظ
          </button>
        </div>
      </div>
    </div>
  );
}
