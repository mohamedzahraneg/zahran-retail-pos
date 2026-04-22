import { useMemo, useState } from 'react';
import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Target,
  Plus,
  X,
  Trash2,
  Edit3,
  Download,
  Building2,
  Save,
  ArrowLeft,
} from 'lucide-react';

import {
  accountsApi,
  Budget,
  BudgetDetail,
  BudgetVarianceRow,
  CostCenter,
  CreateCostCenterPayload,
} from '@/api/accounts.api';
import { exportToExcel } from '@/lib/exportExcel';
import { useAuthStore } from '@/stores/auth.store';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const MONTH_AR = [
  '',
  'يناير',
  'فبراير',
  'مارس',
  'أبريل',
  'مايو',
  'يونيو',
  'يوليو',
  'أغسطس',
  'سبتمبر',
  'أكتوبر',
  'نوفمبر',
  'ديسمبر',
];

type Tab = 'budgets' | 'cost-centers';

export default function Budgets() {
  const [tab, setTab] = useState<Tab>('budgets');

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-2xl font-black text-slate-800 flex items-center gap-2">
          <Target className="text-brand-600" /> الموازنات ومراكز التكلفة
        </h2>
        <p className="text-sm text-slate-500 mt-1">
          خطط سنوية للإيرادات والمصروفات + مقارنة مع الفعلي + تصنيف العمليات
          لمراكز التكلفة (الفروع / الأقسام)
        </p>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="flex flex-wrap gap-2 p-3 border-b border-slate-200">
          <TabBtn
            active={tab === 'budgets'}
            onClick={() => setTab('budgets')}
            icon={<Target className="w-4 h-4" />}
            label="الموازنات"
          />
          <TabBtn
            active={tab === 'cost-centers'}
            onClick={() => setTab('cost-centers')}
            icon={<Building2 className="w-4 h-4" />}
            label="مراكز التكلفة"
          />
        </div>
        <div className="p-4">
          {tab === 'budgets' && <BudgetsTab />}
          {tab === 'cost-centers' && <CostCentersTab />}
        </div>
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 transition ${
        active
          ? 'bg-indigo-600 text-white shadow'
          : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
      }`}
    >
      {icon}
      {label}
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Budgets tab
// ═══════════════════════════════════════════════════════════════════════

function BudgetsTab() {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canManage = hasPermission('accounts.budget');
  const [editing, setEditing] = useState<Budget | 'new' | null>(null);
  const [viewing, setViewing] = useState<Budget | null>(null);

  const { data: budgets = [], isLoading } = useQuery({
    queryKey: ['budgets'],
    queryFn: () => accountsApi.listBudgets(),
  });

  if (viewing) {
    return (
      <BudgetVarianceView
        budget={viewing}
        onBack={() => setViewing(null)}
        onEdit={() => {
          setEditing(viewing);
          setViewing(null);
        }}
      />
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="text-sm text-slate-600">
          {budgets.length} موازنة
        </div>
        {canManage && (
          <button
            className="btn-primary"
            onClick={() => setEditing('new')}
          >
            <Plus size={14} /> موازنة جديدة
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-slate-400">جارٍ التحميل...</div>
      ) : budgets.length === 0 ? (
        <div className="py-12 text-center text-slate-400 border border-dashed border-slate-200 rounded-lg">
          لم تُنشَأ موازنات بعد. ابدأ بإنشاء موازنة لسنة مالية
        </div>
      ) : (
        <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
          {budgets.map((b) => (
            <div
              key={b.id}
              className={`card p-4 border-2 transition cursor-pointer hover:border-brand-400 ${
                b.is_active
                  ? 'border-indigo-200 bg-indigo-50/40'
                  : 'border-slate-200 bg-slate-50 opacity-70'
              }`}
              onClick={() => setViewing(b)}
            >
              <div className="flex items-start justify-between">
                <div>
                  <div className="font-black text-slate-800">{b.name_ar}</div>
                  <div className="text-xs text-slate-500 mt-0.5">
                    سنة مالية {b.fiscal_year}
                  </div>
                </div>
                {b.is_active && (
                  <span className="chip bg-emerald-100 text-emerald-700 text-[10px]">
                    نشطة
                  </span>
                )}
              </div>
              <div className="mt-3 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-500">عدد البنود</span>
                  <span className="font-bold">{b.line_count}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-500">الإجمالي السنوي</span>
                  <span className="font-mono font-bold text-indigo-700">
                    {EGP(b.total_annual)}
                  </span>
                </div>
              </div>
              {canManage && (
                <div
                  className="flex gap-1 pt-3 mt-3 border-t border-slate-200"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => setEditing(b)}
                    className="flex-1 py-1.5 rounded bg-white hover:bg-slate-50 text-xs font-bold flex items-center justify-center gap-1"
                  >
                    <Edit3 size={12} /> تعديل
                  </button>
                  <button
                    onClick={() => setViewing(b)}
                    className="flex-1 py-1.5 rounded bg-white hover:bg-slate-50 text-xs font-bold"
                  >
                    مقارنة مع الفعلي
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {editing && (
        <BudgetEditor
          budget={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </div>
  );
}

function BudgetEditor({
  budget,
  onClose,
}: {
  budget: Budget | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const isNew = !budget;
  const [form, setForm] = useState({
    name_ar: budget?.name_ar || '',
    fiscal_year: budget?.fiscal_year || new Date().getFullYear(),
  });
  const [lines, setLines] = useState<
    Array<{ account_id: string; month: number; amount: number }>
  >([]);

  const { data: accounts = [] } = useQuery({
    queryKey: ['coa', false],
    queryFn: () => accountsApi.list(false),
  });
  const leaves = useMemo(
    () =>
      accounts.filter(
        (a) =>
          a.is_leaf &&
          a.is_active &&
          (a.account_type === 'revenue' || a.account_type === 'expense'),
      ),
    [accounts],
  );

  const { data: existing } = useQuery({
    queryKey: ['budget-detail', budget?.id],
    queryFn: () => accountsApi.getBudget(budget!.id),
    enabled: !!budget,
  });

  useMemo(() => {
    if (existing?.lines) {
      setLines(
        existing.lines.map((l) => ({
          account_id: l.account_id,
          month: l.month,
          amount: Number(l.amount),
        })),
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [existing?.id]);

  const saveMut = useMutation({
    mutationFn: () => {
      const payload = {
        name_ar: form.name_ar,
        fiscal_year: form.fiscal_year,
        lines: lines.filter((l) => l.account_id && l.amount > 0),
      };
      if (isNew) return accountsApi.createBudget(payload);
      return accountsApi.updateBudget(budget!.id, payload);
    },
    onSuccess: () => {
      toast.success('تم الحفظ');
      qc.invalidateQueries({ queryKey: ['budgets'] });
      qc.invalidateQueries({ queryKey: ['budget-detail'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  // Group lines by account for the editor grid.
  const grid = useMemo(() => {
    const map: Record<string, Record<number, number>> = {};
    for (const l of lines) {
      (map[l.account_id] ||= {})[l.month] = l.amount;
    }
    return map;
  }, [lines]);

  const setAmount = (accountId: string, month: number, amount: number) => {
    setLines((prev) => {
      const others = prev.filter(
        (l) => !(l.account_id === accountId && l.month === month),
      );
      if (amount > 0) {
        return [...others, { account_id: accountId, month, amount }];
      }
      return others;
    });
  };

  const selectedAccountIds = useMemo(
    () => Array.from(new Set(lines.map((l) => l.account_id))),
    [lines],
  );

  const addAccount = (accountId: string) => {
    if (!accountId || selectedAccountIds.includes(accountId)) return;
    // Insert a single zero-amount placeholder so the row shows.
    setLines((p) => [...p, { account_id: accountId, month: 1, amount: 0 }]);
  };

  const accountTotals = (accountId: string) => {
    let t = 0;
    for (let m = 1; m <= 12; m++) {
      t += grid[accountId]?.[m] || 0;
    }
    return t;
  };
  const monthTotals = (month: number) => {
    let t = 0;
    for (const id of selectedAccountIds) {
      t += grid[id]?.[month] || 0;
    }
    return t;
  };
  const grandTotal = selectedAccountIds.reduce(
    (s, id) => s + accountTotals(id),
    0,
  );

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-start justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-6xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-slate-100 sticky top-0 bg-white z-10">
          <h3 className="font-black text-lg text-slate-800">
            {isNew ? 'موازنة جديدة' : `تعديل ${budget?.name_ar}`}
          </h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-100 rounded"
          >
            <X size={20} />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div className="grid md:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-bold text-slate-600 mb-1 block">
                الاسم
              </span>
              <input
                className="input"
                value={form.name_ar}
                onChange={(e) =>
                  setForm({ ...form, name_ar: e.target.value })
                }
                placeholder="مثال: موازنة سنة ٢٠٢٦"
                autoFocus
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-600 mb-1 block">
                السنة المالية
              </span>
              <input
                type="number"
                min={2020}
                max={2100}
                className="input"
                value={form.fiscal_year}
                onChange={(e) =>
                  setForm({ ...form, fiscal_year: Number(e.target.value) })
                }
              />
            </label>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <select
              className="input flex-1 min-w-[240px]"
              defaultValue=""
              onChange={(e) => {
                addAccount(e.target.value);
                e.target.value = '';
              }}
            >
              <option value="">+ أضف حساب للموازنة</option>
              {leaves
                .filter((a) => !selectedAccountIds.includes(a.id))
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code} — {a.name_ar} ({a.account_type === 'revenue' ? 'إيراد' : 'مصروف'})
                  </option>
                ))}
            </select>
            <div className="text-sm font-bold text-slate-700">
              الإجمالي السنوي:{' '}
              <span className="text-indigo-700 font-mono">
                {EGP(grandTotal)}
              </span>
            </div>
          </div>

          {selectedAccountIds.length === 0 ? (
            <div className="py-10 text-center text-slate-400 border border-dashed border-slate-200 rounded-lg">
              أضف حساباً من القائمة أعلاه لبدء وضع المبالغ الشهرية
            </div>
          ) : (
            <div className="border border-slate-200 rounded-lg overflow-x-auto">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="sticky right-0 bg-slate-50 text-right px-3 py-2 min-w-[200px]">
                      الحساب
                    </th>
                    {MONTH_AR.slice(1).map((m, i) => (
                      <th key={i} className="px-2 py-2 text-center w-24">
                        {m}
                      </th>
                    ))}
                    <th className="px-3 py-2 text-center w-28 bg-indigo-50">
                      الإجمالي
                    </th>
                    <th className="w-10"></th>
                  </tr>
                </thead>
                <tbody>
                  {selectedAccountIds.map((accId) => {
                    const acc = leaves.find((a) => a.id === accId);
                    if (!acc) return null;
                    return (
                      <tr
                        key={accId}
                        className="border-t border-slate-100"
                      >
                        <td className="sticky right-0 bg-white px-3 py-1 font-bold">
                          <div className="text-xs">{acc.name_ar}</div>
                          <div className="text-[10px] font-mono text-slate-400">
                            {acc.code}
                          </div>
                        </td>
                        {Array.from({ length: 12 }).map((_, i) => {
                          const m = i + 1;
                          const val = grid[accId]?.[m] || 0;
                          return (
                            <td key={m} className="px-1 py-1">
                              <input
                                type="number"
                                min={0}
                                step="0.01"
                                className="w-20 px-1 py-1 border border-slate-200 rounded text-center text-xs"
                                value={val || ''}
                                onChange={(e) =>
                                  setAmount(
                                    accId,
                                    m,
                                    Number(e.target.value) || 0,
                                  )
                                }
                              />
                            </td>
                          );
                        })}
                        <td className="px-3 py-1 bg-indigo-50 font-mono font-bold text-indigo-700 text-center">
                          {EGP(accountTotals(accId))}
                        </td>
                        <td className="px-1">
                          <button
                            onClick={() =>
                              setLines((p) =>
                                p.filter((l) => l.account_id !== accId),
                              )
                            }
                            className="text-rose-500 hover:text-rose-700 p-1"
                          >
                            <Trash2 size={12} />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                  <tr className="border-t-2 border-slate-300 bg-slate-50 font-black">
                    <td className="sticky right-0 bg-slate-50 px-3 py-2">
                      المجاميع الشهرية
                    </td>
                    {Array.from({ length: 12 }).map((_, i) => (
                      <td
                        key={i}
                        className="px-1 py-2 text-center font-mono text-xs"
                      >
                        {EGP(monthTotals(i + 1))}
                      </td>
                    ))}
                    <td className="px-3 py-2 bg-indigo-100 text-center font-mono text-indigo-800">
                      {EGP(grandTotal)}
                    </td>
                    <td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          <div className="flex gap-2 pt-2 border-t border-slate-100">
            <button
              className="btn-primary flex-1"
              onClick={() => saveMut.mutate()}
              disabled={
                saveMut.isPending || !form.name_ar || !form.fiscal_year
              }
            >
              <Save size={14} /> حفظ
            </button>
            <button className="btn-secondary" onClick={onClose}>
              إلغاء
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function BudgetVarianceView({
  budget,
  onBack,
  onEdit,
}: {
  budget: Budget;
  onBack: () => void;
  onEdit: () => void;
}) {
  const [costCenter, setCostCenter] = useState<string>('');
  const { data: costCenters = [] } = useQuery({
    queryKey: ['cost-centers', false],
    queryFn: () => accountsApi.listCostCenters(),
  });
  const { data, isLoading } = useQuery({
    queryKey: ['budget-variance', budget.id, costCenter],
    queryFn: () =>
      accountsApi.budgetVariance(budget.id, {
        cost_center_id: costCenter || undefined,
      }),
  });

  const exportVariance = () => {
    if (!data) return;
    exportToExcel(
      `budget-variance-${budget.name_ar}-${budget.fiscal_year}`,
      data.rows.map((r) => ({
        الكود: r.code,
        الحساب: r.name_ar,
        النوع: r.account_type === 'revenue' ? 'إيراد' : 'مصروف',
        الموازنة: r.budget_total,
        الفعلي: r.actual_total,
        الفرق: r.variance,
        'نسبة الانحراف %': r.variance_pct ?? '',
      })),
    );
  };

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={onBack}>
            <ArrowLeft size={14} /> العودة
          </button>
          <h3 className="font-black text-lg">
            {budget.name_ar} — {budget.fiscal_year}
          </h3>
        </div>
        <div className="flex gap-2 flex-wrap">
          <select
            className="input w-56"
            value={costCenter}
            onChange={(e) => setCostCenter(e.target.value)}
          >
            <option value="">كل مراكز التكلفة</option>
            {costCenters.map((cc) => (
              <option key={cc.id} value={cc.id}>
                {cc.code} — {cc.name_ar}
              </option>
            ))}
          </select>
          <button className="btn-secondary" onClick={exportVariance}>
            <Download size={14} /> Excel
          </button>
          <button className="btn-primary" onClick={onEdit}>
            <Edit3 size={14} /> تعديل
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-slate-400">جارٍ التحميل...</div>
      ) : !data ? null : (
        <>
          <div className="grid md:grid-cols-4 gap-3">
            <KpiBox
              label="إجمالي الموازنة"
              value={EGP(data.totals.budget)}
              color="slate"
            />
            <KpiBox
              label="الفعلي حتى الآن"
              value={EGP(data.totals.actual)}
              color="indigo"
            />
            <KpiBox
              label={data.totals.variance >= 0 ? 'تجاوز' : 'توفير'}
              value={EGP(Math.abs(data.totals.variance))}
              color={data.totals.variance > 0 ? 'rose' : 'emerald'}
            />
            <KpiBox
              label="نسبة الإنجاز"
              value={`${
                data.totals.budget > 0
                  ? ((data.totals.actual / data.totals.budget) * 100).toFixed(1)
                  : '0'
              }%`}
              color="amber"
            />
          </div>

          <div className="border border-slate-200 rounded-lg overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 sticky top-0">
                <tr>
                  <th className="text-right px-3 py-2 min-w-[200px] sticky right-0 bg-slate-50">
                    الحساب
                  </th>
                  <th className="px-3 py-2 text-center">الموازنة</th>
                  <th className="px-3 py-2 text-center">الفعلي</th>
                  <th className="px-3 py-2 text-center">الفرق</th>
                  <th className="px-3 py-2 text-center">الانحراف %</th>
                  <th className="px-3 py-2 text-center min-w-[120px]">
                    التقدم
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <BudgetRow key={r.account_id} r={r} />
                ))}
                {data.rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      className="text-center py-10 text-slate-400"
                    >
                      لا توجد بنود في هذه الموازنة
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

function BudgetRow({ r }: { r: BudgetVarianceRow }) {
  const pctUsed =
    r.budget_total > 0 ? (r.actual_total / r.budget_total) * 100 : 0;
  const over = r.account_type === 'expense' && r.variance > 0;
  const under = r.account_type === 'revenue' && r.variance < 0;
  const good = (r.account_type === 'expense' && r.variance <= 0) ||
               (r.account_type === 'revenue' && r.variance >= 0);
  const varianceColor = good
    ? 'text-emerald-700'
    : over || under
      ? 'text-rose-700'
      : 'text-slate-700';
  const barColor = pctUsed > 100
    ? 'bg-rose-500'
    : pctUsed > 90
      ? 'bg-amber-500'
      : 'bg-emerald-500';
  return (
    <tr className="border-t border-slate-100 hover:bg-slate-50">
      <td className="sticky right-0 bg-white px-3 py-2">
        <div className="text-xs font-bold">{r.name_ar}</div>
        <div className="text-[10px] font-mono text-slate-400">
          {r.code} · {r.account_type === 'revenue' ? 'إيراد' : 'مصروف'}
        </div>
      </td>
      <td className="px-3 py-2 text-center font-mono">
        {EGP(r.budget_total)}
      </td>
      <td className="px-3 py-2 text-center font-mono font-bold">
        {EGP(r.actual_total)}
      </td>
      <td className={`px-3 py-2 text-center font-mono font-bold ${varianceColor}`}>
        {r.variance >= 0 ? '+' : '−'}
        {EGP(Math.abs(r.variance))}
      </td>
      <td className="px-3 py-2 text-center font-mono text-xs">
        {r.variance_pct !== null
          ? `${r.variance_pct >= 0 ? '+' : ''}${r.variance_pct.toFixed(1)}%`
          : '—'}
      </td>
      <td className="px-3 py-2">
        <div className="relative h-3 bg-slate-100 rounded-full overflow-hidden">
          <div
            className={`absolute top-0 right-0 bottom-0 ${barColor}`}
            style={{ width: `${Math.min(100, pctUsed)}%` }}
          />
          {pctUsed > 100 && (
            <div
              className="absolute top-0 left-0 bottom-0 bg-rose-700 opacity-60"
              style={{ width: `${Math.min(100, pctUsed - 100)}%` }}
            />
          )}
        </div>
        <div className="text-[10px] text-center text-slate-500 mt-1">
          {pctUsed.toFixed(0)}%
        </div>
      </td>
    </tr>
  );
}

function KpiBox({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: 'slate' | 'indigo' | 'rose' | 'emerald' | 'amber';
}) {
  const cls: Record<string, string> = {
    slate: 'bg-slate-50 border-slate-200 text-slate-800',
    indigo: 'bg-indigo-50 border-indigo-200 text-indigo-800',
    rose: 'bg-rose-50 border-rose-200 text-rose-800',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-800',
    amber: 'bg-amber-50 border-amber-200 text-amber-800',
  };
  return (
    <div className={`card p-3 border-2 ${cls[color]}`}>
      <div className="text-xs font-bold opacity-80">{label}</div>
      <div className="font-black text-xl font-mono mt-1">{value}</div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
//  Cost centers tab
// ═══════════════════════════════════════════════════════════════════════

function CostCentersTab() {
  const qc = useQueryClient();
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canManage = hasPermission('accounts.cost_centers');
  const [editing, setEditing] = useState<CostCenter | 'new' | null>(null);
  const [includeInactive, setIncludeInactive] = useState(false);

  const { data: centers = [], isLoading } = useQuery({
    queryKey: ['cost-centers', includeInactive],
    queryFn: () => accountsApi.listCostCenters(includeInactive),
  });

  const del = useMutation({
    mutationFn: (id: string) => accountsApi.removeCostCenter(id),
    onSuccess: (r: any) => {
      if (r?.soft_deleted) {
        toast.success('تم تعطيل مركز التكلفة (له حركات سابقة)');
      } else {
        toast.success('تم الحذف');
      }
      qc.invalidateQueries({ queryKey: ['cost-centers'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحذف'),
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeInactive}
            onChange={(e) => setIncludeInactive(e.target.checked)}
          />
          إظهار المعطّل
        </label>
        {canManage && (
          <button className="btn-primary" onClick={() => setEditing('new')}>
            <Plus size={14} /> مركز تكلفة
          </button>
        )}
      </div>

      {isLoading ? (
        <div className="py-12 text-center text-slate-400">جارٍ التحميل...</div>
      ) : centers.length === 0 ? (
        <div className="py-12 text-center text-slate-400 border border-dashed border-slate-200 rounded-lg">
          لم تُنشَأ مراكز تكلفة بعد
        </div>
      ) : (
        <div className="border border-slate-200 rounded-lg overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-50 text-xs font-bold text-slate-600">
              <tr>
                <th className="text-right px-3 py-2">الكود</th>
                <th className="text-right px-3 py-2">الاسم</th>
                <th className="text-right px-3 py-2">الأب</th>
                <th className="text-right px-3 py-2">المخزن</th>
                <th className="text-right px-3 py-2">الحالة</th>
                <th className="w-20"></th>
              </tr>
            </thead>
            <tbody>
              {centers.map((c) => (
                <tr
                  key={c.id}
                  className={`border-t border-slate-100 hover:bg-slate-50 ${
                    c.is_active ? '' : 'opacity-60'
                  }`}
                >
                  <td className="px-3 py-2 font-mono font-bold text-brand-700">
                    {c.code}
                  </td>
                  <td className="px-3 py-2 font-bold">{c.name_ar}</td>
                  <td className="px-3 py-2 text-xs">
                    {c.parent_name ? (
                      <span>
                        <span className="font-mono">{c.parent_code}</span>{' '}
                        {c.parent_name}
                      </span>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2 text-xs">
                    {c.warehouse_name || '—'}
                  </td>
                  <td className="px-3 py-2">
                    {c.is_active ? (
                      <span className="chip bg-emerald-100 text-emerald-700">
                        نشط
                      </span>
                    ) : (
                      <span className="chip bg-slate-100 text-slate-600">
                        معطّل
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {canManage && (
                      <div className="flex gap-1">
                        <button
                          onClick={() => setEditing(c)}
                          className="p-1 hover:bg-slate-200 rounded text-slate-500"
                        >
                          <Edit3 size={14} />
                        </button>
                        <button
                          onClick={() => {
                            if (confirm(`حذف "${c.name_ar}"؟`)) {
                              del.mutate(c.id);
                            }
                          }}
                          className="p-1 hover:bg-rose-100 rounded text-rose-600"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {editing && (
        <CostCenterEditor
          center={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          parents={centers.filter((c) => c.is_active)}
        />
      )}
    </div>
  );
}

function CostCenterEditor({
  center,
  onClose,
  parents,
}: {
  center: CostCenter | null;
  onClose: () => void;
  parents: CostCenter[];
}) {
  const qc = useQueryClient();
  const isNew = !center;
  const [form, setForm] = useState<CreateCostCenterPayload>({
    code: center?.code || '',
    name_ar: center?.name_ar || '',
    name_en: center?.name_en || '',
    parent_id: center?.parent_id || undefined,
    warehouse_id: center?.warehouse_id || undefined,
  });

  const mut = useMutation({
    mutationFn: () => {
      const payload = { ...form };
      // Strip empties
      if (!payload.parent_id) delete payload.parent_id;
      if (!payload.warehouse_id) delete payload.warehouse_id;
      if (!payload.name_en) delete payload.name_en;
      if (isNew) return accountsApi.createCostCenter(payload);
      return accountsApi.updateCostCenter(center!.id, payload);
    },
    onSuccess: () => {
      toast.success('تم الحفظ');
      qc.invalidateQueries({ queryKey: ['cost-centers'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الحفظ'),
  });

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b border-slate-100">
          <h3 className="font-black text-lg">
            {isNew ? 'مركز تكلفة جديد' : `تعديل ${center?.name_ar}`}
          </h3>
          <button
            onClick={onClose}
            className="p-1 hover:bg-slate-100 rounded"
          >
            <X size={20} />
          </button>
        </div>
        <div className="p-5 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <label className="block">
              <span className="text-xs font-bold text-slate-600 mb-1 block">
                الكود
              </span>
              <input
                className="input"
                value={form.code}
                onChange={(e) => setForm({ ...form, code: e.target.value })}
                placeholder="مثال: BR-MAADI"
              />
            </label>
            <label className="block">
              <span className="text-xs font-bold text-slate-600 mb-1 block">
                الاسم بالعربية
              </span>
              <input
                className="input"
                value={form.name_ar}
                onChange={(e) =>
                  setForm({ ...form, name_ar: e.target.value })
                }
                placeholder="مثال: فرع المعادي"
              />
            </label>
          </div>
          <label className="block">
            <span className="text-xs font-bold text-slate-600 mb-1 block">
              الاسم بالإنجليزية (اختياري)
            </span>
            <input
              className="input"
              value={form.name_en || ''}
              onChange={(e) => setForm({ ...form, name_en: e.target.value })}
            />
          </label>
          <label className="block">
            <span className="text-xs font-bold text-slate-600 mb-1 block">
              المركز الأب (اختياري)
            </span>
            <select
              className="input"
              value={form.parent_id || ''}
              onChange={(e) =>
                setForm({ ...form, parent_id: e.target.value || undefined })
              }
            >
              <option value="">— بدون أب —</option>
              {parents
                .filter((p) => p.id !== center?.id)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.code} — {p.name_ar}
                  </option>
                ))}
            </select>
          </label>
          <div className="flex gap-2 pt-2 border-t border-slate-100">
            <button
              className="btn-primary flex-1"
              onClick={() => mut.mutate()}
              disabled={mut.isPending || !form.code || !form.name_ar}
            >
              حفظ
            </button>
            <button className="btn-secondary" onClick={onClose}>
              إلغاء
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
