import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  TrendingUp,
  Receipt,
  Wallet,
  Scale,
  BookOpen,
  Plus,
  CheckCircle2,
  Trash2,
  RefreshCw,
  AlertCircle,
  DollarSign,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { accountingApi, Expense, ExpenseCategory } from '@/api/accounting.api';
import { settingsApi } from '@/api/settings.api';
import { profitLabel, marginLabel, formatEGP } from '@/lib/profit';
import {
  PeriodSelector,
  resolvePeriod,
  type PeriodRange,
} from '@/components/common/PeriodSelector';

const EGP = (n: number | string) =>
  `${Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ج.م`;

type TabKey = 'expenses' | 'pl' | 'cashflow' | 'trial' | 'gl';

const TABS: { key: TabKey; label: string; icon: any }[] = [
  { key: 'expenses', label: 'المصروفات', icon: Receipt },
  { key: 'pl', label: 'الأرباح والخسائر', icon: TrendingUp },
  { key: 'cashflow', label: 'التدفق النقدي', icon: Wallet },
  { key: 'trial', label: 'ميزان المراجعة', icon: Scale },
  { key: 'gl', label: 'دفتر الأستاذ', icon: BookOpen },
];

export default function Accounting() {
  const todayISO = new Date().toISOString().slice(0, 10);
  const monthStart = todayISO.slice(0, 7) + '-01';

  const [tab, setTab] = useState<TabKey>('expenses');
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(todayISO);

  // Period selector drives the top KPI cards.
  const [period, setPeriod] = useState<PeriodRange>(() =>
    resolvePeriod('day'),
  );
  const periodNoun = {
    day: 'اليوم',
    week: 'الأسبوع',
    month: 'الشهر',
    year: 'السنة',
    custom: 'الفترة',
  }[period.key];

  // KPI cards now respect the period selector: pass from/to so expenses,
  // payments, invoice count etc. span the chosen range. Also auto-refresh
  // every 60 s and whenever the browser tab comes back into focus, so the
  // cards roll over to a fresh day without a manual reload.
  const kpis = useQuery({
    queryKey: ['accounting-kpis', period.from, period.to],
    queryFn: () =>
      accountingApi.kpis({ from: period.from, to: period.to }),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
    refetchOnMount: 'always',
  });

  // Period-scoped P&L powers the dynamic KPI cards (اليوم / الأسبوع / الشهر / السنة).
  const periodPL = useQuery({
    queryKey: ['accounting-pl-period', period.from, period.to],
    queryFn: () =>
      accountingApi.profitAndLoss({ from: period.from, to: period.to }),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  return (
    <div className="space-y-6">
      {/* Period switcher */}
      <div className="card p-3 flex items-center justify-between flex-wrap gap-3">
        <div className="text-sm font-bold text-slate-700">
          ملخص مالي: {periodNoun}
        </div>
        <PeriodSelector value={period} onChange={setPeriod} />
      </div>

      {/* KPIs — today snapshot with smart hints */}
      {(() => {
        const k = kpis.data as any;
        const todayRevenue = Number(k?.today?.revenue ?? 0);
        const todayProfit = Number(k?.today?.net_profit ?? 0);
        const todayExpenses =
          Number(k?.today?.operating_expenses ?? 0) +
          Number(k?.today?.allocated_expenses ?? 0);
        const todayMargin = Number(k?.today?.net_margin_pct ?? 0);
        const expenseRatio =
          todayRevenue > 0 ? (todayExpenses / todayRevenue) * 100 : 0;
        const invCount = Number(k?.today_invoice_count ?? 0);
        const expCount = Number(k?.today_expense_count ?? 0);
        const payAmt = Number(k?.today_payments ?? 0);
        const payCount = Number(k?.today_payments_count ?? 0);
        const shiftRem = Number(k?.today_shift_remaining ?? 0);
        const profitP = profitLabel(todayProfit, `أرباح ${periodNoun}`);
        return (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
            <KpiCard
              title={`إيرادات ${periodNoun}`}
              value={EGP(todayRevenue)}
              icon={TrendingUp}
              color="emerald"
              subtitle={`${invCount} فاتورة · ${
                invCount > 0
                  ? `متوسط ${EGP(todayRevenue / invCount)}`
                  : 'لا مبيعات'
              }`}
            />
            <KpiCard
              title={profitP.label}
              value={profitP.amount}
              icon={TrendingUp}
              color={profitP.isLoss ? 'rose' : 'indigo'}
              subtitle={`هامش ${todayMargin.toFixed(1)}% · COGS ${EGP(
                k?.today?.cogs ?? 0,
              )}`}
            />
            <KpiCard
              title={`مصروفات ${periodNoun}`}
              value={EGP(todayExpenses)}
              icon={Receipt}
              color="amber"
              subtitle={`${expCount} بند${
                expenseRatio > 0
                  ? ` · ${expenseRatio.toFixed(1)}% من الإيراد`
                  : ''
              }`}
            />
            <KpiCard
              title={`دفعات ${periodNoun}`}
              value={EGP(payAmt)}
              icon={Receipt}
              color="indigo"
              subtitle={`${payCount} عملية${
                k?.pending_amount
                  ? ` · معلّق ${EGP(k.pending_amount)}`
                  : ''
              }`}
            />
            <KpiCard
              title={`الباقي من ورديات ${periodNoun}`}
              value={EGP(shiftRem)}
              icon={AlertCircle}
              color={shiftRem < 0 ? 'rose' : 'emerald'}
              subtitle={
                shiftRem > 0
                  ? 'مستحق في الخزينة'
                  : shiftRem < 0
                    ? 'عجز في الخزينة'
                    : 'مطابقة تامة'
              }
            />
          </div>
        );
      })()}

      {/* Tabs */}
      <div className="bg-white rounded-xl shadow-sm border border-slate-200">
        <div className="flex flex-wrap gap-2 p-3 border-b border-slate-200">
          {TABS.map((t) => {
            const Icon = t.icon;
            const active = tab === t.key;
            return (
              <button
                key={t.key}
                onClick={() => setTab(t.key)}
                className={`px-4 py-2 rounded-lg font-medium text-sm flex items-center gap-2 transition ${
                  active
                    ? 'bg-indigo-600 text-white shadow'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                <Icon className="w-4 h-4" /> {t.label}
              </button>
            );
          })}
        </div>

        {/* Date range — used by PL/Cashflow/Trial/GL */}
        {tab !== 'expenses' && (
          <div className="flex items-center gap-3 p-4 border-b border-slate-200">
            <label className="text-sm text-slate-600">من</label>
            <input
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
            <label className="text-sm text-slate-600">إلى</label>
            <input
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
        )}

        <div className="p-4">
          {tab === 'expenses' && <ExpensesTab />}
          {tab === 'pl' && <PnLTab from={from} to={to} />}
          {tab === 'cashflow' && <CashflowTab from={from} to={to} />}
          {tab === 'trial' && <TrialTab from={from} to={to} />}
          {tab === 'gl' && <GLTab from={from} to={to} />}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
function KpiCard({
  title,
  value,
  icon: Icon,
  color,
  subtitle,
}: {
  title: string;
  value: string;
  icon: any;
  color: 'emerald' | 'indigo' | 'amber' | 'rose';
  subtitle?: string;
}) {
  const colors: Record<string, string> = {
    emerald: 'bg-emerald-50 text-emerald-700',
    indigo: 'bg-indigo-50 text-indigo-700',
    amber: 'bg-amber-50 text-amber-700',
    rose: 'bg-rose-50 text-rose-700',
  };
  return (
    <div className="bg-white rounded-xl p-5 border border-slate-200 shadow-sm">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-slate-500">{title}</span>
        <span className={`p-2 rounded-lg ${colors[color]}`}>
          <Icon className="w-5 h-5" />
        </span>
      </div>
      <div className="text-2xl font-bold text-slate-800">{value}</div>
      {subtitle && (
        <div className="text-xs text-slate-500 mt-1">{subtitle}</div>
      )}
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
function ExpensesTab() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<'all' | 'pending' | 'approved'>('all');
  const [showModal, setShowModal] = useState(false);
  const [editTarget, setEditTarget] = useState<Expense | null>(null);
  const [showCategories, setShowCategories] = useState(false);
  const [q, setQ] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');

  const list = useQuery({
    queryKey: ['expenses', status, q, fromDate, toDate],
    queryFn: () =>
      accountingApi.listExpenses({
        status,
        q: q || undefined,
        from: fromDate || undefined,
        to: toDate || undefined,
        limit: 200,
      }),
  });

  const approve = useMutation({
    mutationFn: (id: string) => accountingApi.approveExpense(id),
    onSuccess: () => {
      toast.success('تم الاعتماد');
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['accounting-kpis'] });
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => accountingApi.deleteExpense(id),
    onSuccess: () => {
      toast.success('تم الحذف');
      qc.invalidateQueries({ queryKey: ['expenses'] });
    },
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex gap-2">
          {(['all', 'pending', 'approved'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setStatus(s)}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
                status === s
                  ? 'bg-indigo-600 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
              }`}
            >
              {s === 'all' ? 'الكل' : s === 'pending' ? 'بانتظار الاعتماد' : 'معتمد'}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowCategories(true)}
            className="border border-slate-300 hover:bg-slate-50 text-slate-700 rounded-lg px-3 py-2 text-sm font-medium"
            title="إدارة بنود المصروفات (مرتبات، إيجار، كهرباء ...)"
          >
            📋 إدارة البنود
          </button>
          <button
            onClick={() => setShowModal(true)}
            className="bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2 text-sm font-medium flex items-center gap-2"
          >
            <Plus className="w-4 h-4" /> مصروف جديد
          </button>
        </div>
      </div>

      {/* Search + date filters */}
      <div className="bg-slate-50 rounded-xl p-3 grid md:grid-cols-4 gap-3">
        <div>
          <label className="text-xs text-slate-500 block mb-1">
            بحث (اسم / مورد / رقم)
          </label>
          <input
            className="input"
            placeholder="ابحث..."
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-slate-500 block mb-1">من تاريخ</label>
          <input
            type="date"
            className="input"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </div>
        <div>
          <label className="text-xs text-slate-500 block mb-1">إلى تاريخ</label>
          <input
            type="date"
            className="input"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </div>
        <div className="flex items-end">
          <button
            className="btn-ghost w-full"
            onClick={() => {
              setQ('');
              setFromDate('');
              setToDate('');
            }}
          >
            إعادة ضبط
          </button>
        </div>
      </div>

      {list.isLoading ? (
        <div className="text-center py-12 text-slate-400">جاري التحميل...</div>
      ) : !list.data?.items.length ? (
        <div className="text-center py-12 text-slate-400">لا توجد مصروفات</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-slate-600 text-right">
              <tr>
                <th className="px-3 py-2">رقم</th>
                <th className="px-3 py-2">التاريخ</th>
                <th className="px-3 py-2">التصنيف</th>
                <th className="px-3 py-2">المورد</th>
                <th className="px-3 py-2">الوصف</th>
                <th className="px-3 py-2 text-end">المبلغ</th>
                <th className="px-3 py-2">الحالة</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {list.data.items.map((e: Expense) => (
                <tr
                  key={e.id}
                  className="border-t border-slate-100 hover:bg-slate-50"
                >
                  <td className="px-3 py-2 font-mono text-xs">{e.expense_no}</td>
                  <td className="px-3 py-2">{e.expense_date}</td>
                  <td className="px-3 py-2">{e.category_name}</td>
                  <td className="px-3 py-2">{e.vendor_name || '—'}</td>
                  <td
                    className="px-3 py-2 max-w-xs truncate"
                    title={e.description || ''}
                  >
                    {e.description || '—'}
                  </td>
                  <td className="px-3 py-2 text-end font-semibold text-slate-800">
                    {EGP(e.amount)}
                  </td>
                  <td className="px-3 py-2">
                    {e.is_approved ? (
                      <span className="inline-flex items-center gap-1 text-emerald-700 bg-emerald-50 px-2 py-0.5 rounded-full text-xs">
                        <CheckCircle2 className="w-3 h-3" /> معتمد
                      </span>
                    ) : (
                      <span className="text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full text-xs">
                        بانتظار
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex gap-1 justify-end">
                      <button
                        onClick={() => setEditTarget(e)}
                        className="text-slate-600 hover:bg-slate-100 p-1 rounded"
                        title={e.is_approved ? 'عرض' : 'تعديل'}
                      >
                        {e.is_approved ? '👁️' : '✎'}
                      </button>
                      {!e.is_approved && (
                        <>
                          <button
                            onClick={() => approve.mutate(e.id)}
                            className="text-emerald-600 hover:bg-emerald-50 p-1 rounded"
                            title="اعتماد"
                          >
                            <CheckCircle2 className="w-4 h-4" />
                          </button>
                          <button
                            onClick={() => {
                              if (confirm('حذف المصروف؟')) del.mutate(e.id);
                            }}
                            className="text-rose-600 hover:bg-rose-50 p-1 rounded"
                            title="حذف"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot className="bg-slate-50 font-semibold">
              <tr>
                <td colSpan={5} className="px-3 py-2 text-end">
                  الإجمالي
                </td>
                <td className="px-3 py-2 text-end text-slate-800">
                  {EGP(list.data.total_amount)}
                </td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}

      {showModal && <ExpenseModal onClose={() => setShowModal(false)} />}
      {editTarget && (
        <ExpenseModal
          existing={editTarget}
          onClose={() => setEditTarget(null)}
        />
      )}
      {showCategories && (
        <CategoriesManagerModal onClose={() => setShowCategories(false)} />
      )}
    </div>
  );
}

function CategoriesManagerModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const list = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => accountingApi.categories(),
  });
  const [newCode, setNewCode] = useState('');
  const [newName, setNewName] = useState('');
  const [newFixed, setNewFixed] = useState(false);
  const [newCogs, setNewCogs] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');

  const create = useMutation({
    mutationFn: () =>
      accountingApi.createCategory({
        code: newCode.trim().toLowerCase(),
        name_ar: newName.trim(),
        is_fixed: newFixed,
        allocate_to_cogs: newCogs,
      }),
    onSuccess: () => {
      toast.success('تم إضافة البند');
      setNewCode('');
      setNewName('');
      setNewFixed(false);
      setNewCogs(false);
      qc.invalidateQueries({ queryKey: ['expense-categories'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإضافة'),
  });
  const update = useMutation({
    mutationFn: (body: { id: string; name_ar: string }) =>
      accountingApi.updateCategory(body.id, { name_ar: body.name_ar }),
    onSuccess: () => {
      toast.success('تم التعديل');
      setEditId(null);
      qc.invalidateQueries({ queryKey: ['expense-categories'] });
    },
  });
  const toggleFixed = useMutation({
    mutationFn: (body: { id: string; is_fixed: boolean }) =>
      accountingApi.updateCategory(body.id, { is_fixed: body.is_fixed }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expense-categories'] }),
  });
  const toggleCogs = useMutation({
    mutationFn: (body: { id: string; allocate_to_cogs: boolean }) =>
      accountingApi.updateCategory(body.id, {
        allocate_to_cogs: body.allocate_to_cogs,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expense-categories'] }),
  });
  const remove = useMutation({
    mutationFn: (id: string) => accountingApi.deleteCategory(id),
    onSuccess: () => {
      toast.success('تم الحذف');
      qc.invalidateQueries({ queryKey: ['expense-categories'] });
    },
    onError: (e: any) => toast.error(e?.response?.data?.message || 'فشل الحذف'),
  });

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
        <div className="p-5 border-b border-slate-100 flex items-center justify-between">
          <h3 className="font-black text-slate-800">إدارة بنود المصروفات</h3>
          <button onClick={onClose} className="p-1 hover:bg-slate-100 rounded">
            ✕
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Create */}
          <div className="bg-slate-50 rounded-lg p-4 border border-slate-200 space-y-3">
            <div className="font-bold text-slate-700 text-sm">
              إضافة بند جديد (مثال: مرتبات، كهرباء، زكاة، إيجار...)
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs text-slate-500 block mb-1">
                  الكود (إنجليزي) *
                </label>
                <input
                  className="input font-mono text-sm"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value)}
                  placeholder="salaries"
                />
              </div>
              <div>
                <label className="text-xs text-slate-500 block mb-1">
                  الاسم بالعربية *
                </label>
                <input
                  className="input"
                  value={newName}
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="مرتبات"
                />
              </div>
            </div>
            <div className="flex gap-4 text-sm">
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newFixed}
                  onChange={(e) => setNewFixed(e.target.checked)}
                />
                <span>مصروف ثابت (شهري متكرر)</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={newCogs}
                  onChange={(e) => setNewCogs(e.target.checked)}
                />
                <span>يُدرَج في تكلفة البضاعة</span>
              </label>
            </div>
            <button
              className="btn-primary text-sm"
              onClick={() => {
                if (!newCode.trim() || !newName.trim()) {
                  toast.error('الكود والاسم مطلوبان');
                  return;
                }
                create.mutate();
              }}
              disabled={create.isPending}
            >
              {create.isPending ? 'جاري الإضافة...' : '+ إضافة البند'}
            </button>
          </div>

          {/* List */}
          <div className="rounded-lg border border-slate-200 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-slate-600 text-xs">
                <tr>
                  <th className="text-right p-2">الكود</th>
                  <th className="text-right p-2">الاسم</th>
                  <th className="text-center p-2">ثابت</th>
                  <th className="text-center p-2">COGS</th>
                  <th className="text-left p-2">إجراءات</th>
                </tr>
              </thead>
              <tbody>
                {list.isLoading && (
                  <tr>
                    <td
                      colSpan={5}
                      className="p-4 text-center text-slate-400 text-sm"
                    >
                      جاري التحميل...
                    </td>
                  </tr>
                )}
                {list.data?.map((c) => (
                  <tr key={c.id} className="border-t border-slate-100">
                    <td className="p-2 font-mono text-xs">{c.code}</td>
                    <td className="p-2">
                      {editId === c.id ? (
                        <input
                          className="input text-sm"
                          value={editName}
                          autoFocus
                          onChange={(e) => setEditName(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter')
                              update.mutate({ id: c.id, name_ar: editName });
                            if (e.key === 'Escape') setEditId(null);
                          }}
                        />
                      ) : (
                        <span className="font-medium">{c.name_ar}</span>
                      )}
                    </td>
                    <td className="p-2 text-center">
                      <input
                        type="checkbox"
                        checked={c.is_fixed}
                        onChange={(e) =>
                          toggleFixed.mutate({
                            id: c.id,
                            is_fixed: e.target.checked,
                          })
                        }
                      />
                    </td>
                    <td className="p-2 text-center">
                      <input
                        type="checkbox"
                        checked={c.allocate_to_cogs}
                        onChange={(e) =>
                          toggleCogs.mutate({
                            id: c.id,
                            allocate_to_cogs: e.target.checked,
                          })
                        }
                      />
                    </td>
                    <td className="p-2 text-left">
                      <div className="flex gap-1 justify-end">
                        {editId === c.id ? (
                          <>
                            <button
                              className="px-2 py-1 text-xs text-emerald-600 hover:bg-emerald-50 rounded font-bold"
                              onClick={() =>
                                update.mutate({ id: c.id, name_ar: editName })
                              }
                            >
                              حفظ
                            </button>
                            <button
                              className="px-2 py-1 text-xs text-slate-500"
                              onClick={() => setEditId(null)}
                            >
                              إلغاء
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              className="p-1.5 text-slate-500 hover:bg-slate-100 rounded"
                              onClick={() => {
                                setEditId(c.id);
                                setEditName(c.name_ar);
                              }}
                              title="تعديل الاسم"
                            >
                              ✎
                            </button>
                            <button
                              className="p-1.5 text-rose-500 hover:bg-rose-50 rounded"
                              onClick={() => {
                                if (
                                  confirm(`هل أنت متأكد من حذف "${c.name_ar}"؟`)
                                )
                                  remove.mutate(c.id);
                              }}
                              title="حذف"
                            >
                              🗑️
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
                {list.data && list.data.length === 0 && (
                  <tr>
                    <td
                      colSpan={5}
                      className="p-4 text-center text-slate-400 text-sm"
                    >
                      لا توجد بنود — أضف أول بند من الأعلى.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div className="text-xs text-slate-500">
            💡 البنود التي لها مصاريف مسجّلة تُؤرشف بدلاً من الحذف للحفاظ على
            السجلات.
          </div>
        </div>
      </div>
    </div>
  );
}

function ExpenseModal({
  onClose,
  existing,
}: {
  onClose: () => void;
  existing?: Expense | null;
}) {
  const qc = useQueryClient();
  const isEdit = !!existing;
  const readOnly = !!(existing && existing.is_approved);
  const cats = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => accountingApi.categories(),
  });
  const warehouses = useQuery({
    queryKey: ['warehouses-all'],
    queryFn: () => settingsApi.listWarehouses(false),
    staleTime: 5 * 60_000,
  });

  const [form, setForm] = useState({
    category_id: existing?.category_id || '',
    amount: existing?.amount ? Number(existing.amount) : 0,
    payment_method:
      (existing?.payment_method as any) ||
      ('cash' as 'cash' | 'card' | 'transfer' | 'wallet' | 'mixed'),
    expense_date:
      existing?.expense_date?.slice(0, 10) ||
      new Date().toISOString().slice(0, 10),
    description: existing?.description || '',
    vendor_name: existing?.vendor_name || '',
  });

  const resolveWarehouseId = () => {
    const list = (warehouses.data || []) as any[];
    const main = list.find((w) => w.is_main) || list[0];
    return main?.id;
  };

  const create = useMutation({
    mutationFn: () => {
      const whId = resolveWarehouseId();
      if (!whId) throw new Error('لا يوجد فرع افتراضي');
      return accountingApi.createExpense({
        ...form,
        warehouse_id: whId,
      } as any);
    },
    onSuccess: () => {
      toast.success('تم إنشاء المصروف');
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['accounting-kpis'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || e?.message || 'فشل الحفظ'),
  });

  const update = useMutation({
    mutationFn: () =>
      accountingApi.updateExpense(existing!.id, form as any),
    onSuccess: () => {
      toast.success('تم التحديث');
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['accounting-kpis'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل التعديل'),
  });

  const save = () => (isEdit ? update.mutate() : create.mutate());

  return (
    <div className="fixed inset-0 bg-slate-900/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl w-full max-w-lg shadow-xl">
        <div className="flex items-center justify-between p-4 border-b border-slate-200">
          <h2 className="text-lg font-bold text-slate-800">
            {readOnly ? `عرض مصروف: ${existing!.expense_no}` :
             isEdit ? `تعديل: ${existing!.expense_no}` : 'مصروف جديد'}
          </h2>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-800">
            ✕
          </button>
        </div>
        {readOnly && (
          <div className="mx-4 mt-4 p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-sm text-emerald-800">
            هذا المصروف معتمد — غير قابل للتعديل.
          </div>
        )}
        <div className="p-4 space-y-3">
          <div>
            <label className="block text-sm text-slate-600 mb-1">التصنيف</label>
            <select
              disabled={readOnly}
              value={form.category_id}
              onChange={(e) => setForm({ ...form, category_id: e.target.value })}
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm disabled:bg-slate-50"
            >
              <option value="">— اختر —</option>
              {cats.data?.map((c: ExpenseCategory) => (
                <option key={c.id} value={c.id}>
                  {c.name_ar}
                </option>
              ))}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm text-slate-600 mb-1">المبلغ</label>
              <input
                type="number"
                step="0.01"
                value={form.amount}
                onChange={(e) =>
                  setForm({ ...form, amount: Number(e.target.value) })
                }
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-slate-600 mb-1">طريقة الدفع</label>
              <select
                value={form.payment_method}
                onChange={(e) =>
                  setForm({ ...form, payment_method: e.target.value as any })
                }
                className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              >
                <option value="cash">نقدي</option>
                <option value="card">بطاقة</option>
                <option value="transfer">تحويل</option>
                <option value="wallet">محفظة</option>
              </select>
            </div>
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1">التاريخ</label>
            <input
              type="date"
              value={form.expense_date}
              onChange={(e) =>
                setForm({ ...form, expense_date: e.target.value })
              }
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1">المورد (اختياري)</label>
            <input
              type="text"
              value={form.vendor_name}
              onChange={(e) =>
                setForm({ ...form, vendor_name: e.target.value })
              }
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm text-slate-600 mb-1">الوصف</label>
            <textarea
              value={form.description}
              onChange={(e) =>
                setForm({ ...form, description: e.target.value })
              }
              className="w-full border border-slate-300 rounded-lg px-3 py-2 text-sm"
              rows={3}
            />
          </div>
        </div>
        <div className="flex gap-2 p-4 border-t border-slate-200">
          <button
            onClick={onClose}
            className="flex-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg px-4 py-2 text-sm font-medium"
          >
            {readOnly ? 'إغلاق' : 'إلغاء'}
          </button>
          {!readOnly && (
            <button
              onClick={save}
              disabled={
                create.isPending ||
                update.isPending ||
                !form.category_id ||
                form.amount <= 0
              }
              className="flex-1 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg px-4 py-2 text-sm font-medium disabled:opacity-50"
            >
              {create.isPending || update.isPending
                ? 'جاري الحفظ...'
                : isEdit
                  ? 'حفظ التعديلات'
                  : 'حفظ'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
function PnLTab({ from, to }: { from: string; to: string }) {
  const pl = useQuery({
    queryKey: ['pl-analysis', from, to],
    queryFn: () => accountingApi.profitAndLossAnalysis({ from, to }),
  });

  if (pl.isLoading)
    return <div className="text-center py-12 text-slate-400">جاري التحميل...</div>;
  if (!pl.data) return null;

  const d = pl.data;
  const a = d.analysis;
  const Row = ({
    label,
    value,
    indent,
    bold,
    color,
  }: {
    label: string;
    value: number;
    indent?: boolean;
    bold?: boolean;
    color?: string;
  }) => (
    <div
      className={`flex items-center justify-between py-2 ${
        bold ? 'border-t border-slate-300 font-bold text-base' : 'text-sm'
      } ${indent ? 'pr-8' : ''}`}
    >
      <span className={color || 'text-slate-700'}>{label}</span>
      <span className={color || 'text-slate-800 tabular-nums'}>
        {EGP(value)}
      </span>
    </div>
  );

  const headlineClasses: Record<string, string> = {
    green: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    red: 'bg-rose-50 border-rose-200 text-rose-900',
    amber: 'bg-amber-50 border-amber-200 text-amber-900',
  };
  const sevClasses: Record<string, string> = {
    info: 'bg-slate-100 text-slate-700 border-slate-200',
    warning: 'bg-amber-100 text-amber-800 border-amber-200',
    critical: 'bg-rose-100 text-rose-800 border-rose-200',
  };

  return (
    <div className="space-y-6">
      {/* Smart analysis headline — tone ALWAYS follows the sign of net_profit */}
      <div
        className={`rounded-xl p-5 border-2 ${
          (() => {
            const p = profitLabel(d.net_profit);
            return p.isLoss
              ? headlineClasses.red
              : p.isProfit
                ? headlineClasses.green
                : headlineClasses.amber;
          })()
        }`}
      >
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <div className="text-xs uppercase opacity-70 font-bold tracking-wide">
              التحليل الذكي للفترة
            </div>
            <div className="text-3xl font-black mt-1">
              {(() => {
                const p = profitLabel(d.net_profit, 'صافي الربح');
                // Prefer the analyst's own headline when provided, but
                // ALWAYS reflect the actual sign of the number.
                if (p.isLoss) return 'خسارة صافية';
                if (p.isProfit) return 'ربح صافي';
                return 'تعادل';
              })()}
            </div>
            <div className="text-sm mt-1 opacity-80">
              {(() => {
                const p = profitLabel(d.net_profit, 'صافي الربح');
                const m = marginLabel(d.net_margin_pct, 'هامش الربح');
                return (
                  <>
                    {p.label}: <b className={p.color}>{p.amount}</b> ·{' '}
                    {m.label}: <b className={m.color}>{m.signedAmount}</b>
                  </>
                );
              })()}
            </div>
          </div>
          <div className="text-5xl">
            {profitLabel(d.net_profit).icon}
          </div>
        </div>

        {a?.reasons && a.reasons.length > 0 && (
          <div className="mt-4 space-y-2">
            <div className="text-sm font-bold opacity-80">الأسباب:</div>
            {a.reasons.map((r) => (
              <div
                key={r.code}
                className={`rounded-lg px-3 py-2 text-sm border ${
                  sevClasses[r.severity] || sevClasses.info
                }`}
              >
                {r.severity === 'critical' ? '⚠️ ' : r.severity === 'warning' ? '⚡ ' : 'ℹ️ '}
                {r.message}
              </div>
            ))}
          </div>
        )}

        {a?.suggestions && a.suggestions.length > 0 && (
          <div className="mt-4">
            <div className="text-sm font-bold opacity-80 mb-2">اقتراحات:</div>
            <ul className="text-sm space-y-1 list-disc pr-5">
              {a.suggestions.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-6">
      <div className="bg-slate-50 rounded-xl p-5 border border-slate-200">
        <h3 className="font-bold text-slate-800 mb-3">قائمة الدخل</h3>
        <Row label="الإيرادات" value={d.revenue} />
        <Row label="(−) المرتجعات" value={d.returns} indent color="text-rose-600" />
        <Row label="صافي الإيرادات" value={d.net_revenue} bold />
        <Row label="(−) تكلفة البضاعة (COGS)" value={d.cogs} indent color="text-amber-700" />
        <Row label="(−) مصاريف مخصصة للتكلفة" value={d.allocated_expenses} indent color="text-amber-700" />
        {(() => {
          const gp = profitLabel(d.gross_profit, 'مجمل الربح');
          return (
            <Row
              label={gp.label}
              value={d.gross_profit}
              bold
              color={gp.color}
            />
          );
        })()}
        <Row label="(−) المصاريف التشغيلية" value={d.operating_expenses} indent color="text-amber-700" />
        {(() => {
          const np = profitLabel(d.net_profit, 'صافي الربح');
          return (
            <Row
              label={np.label}
              value={d.net_profit}
              bold
              color={np.color}
            />
          );
        })()}
        <div className="mt-4 grid grid-cols-2 gap-3 text-sm">
          {(() => {
            const gm = marginLabel(d.gross_margin_pct, 'هامش الربح الإجمالي');
            return (
              <div className="bg-white rounded-lg p-3 border border-slate-200">
                <div className="text-slate-500">{gm.label}</div>
                <div className={`font-bold ${gm.color}`}>{gm.signedAmount}</div>
              </div>
            );
          })()}
          {(() => {
            const nm = marginLabel(d.net_margin_pct, 'صافي هامش الربح');
            return (
              <div className="bg-white rounded-lg p-3 border border-slate-200">
                <div className="text-slate-500">{nm.label}</div>
                <div className={`font-bold ${nm.color}`}>{nm.signedAmount}</div>
              </div>
            );
          })()}
        </div>
      </div>

      <div className="bg-slate-50 rounded-xl p-5 border border-slate-200">
        <h3 className="font-bold text-slate-800 mb-3">المصاريف حسب التصنيف</h3>
        {d.expenses_by_category.length === 0 ? (
          <p className="text-sm text-slate-500">لا توجد مصاريف في الفترة</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-slate-500 text-xs">
              <tr>
                <th className="text-right py-1">التصنيف</th>
                <th className="text-end py-1">المبلغ</th>
              </tr>
            </thead>
            <tbody>
              {d.expenses_by_category.map((c) => (
                <tr key={c.code} className="border-t border-slate-200">
                  <td className="py-2 text-slate-700">
                    {c.name_ar}
                    {c.is_fixed && (
                      <span className="text-xs text-indigo-600 mr-2">(ثابت)</span>
                    )}
                    {c.allocate_to_cogs && (
                      <span className="text-xs text-amber-600 mr-2">(تكلفة)</span>
                    )}
                  </td>
                  <td className="py-2 text-end font-medium tabular-nums">
                    {EGP(c.total)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
function CashflowTab({ from, to }: { from: string; to: string }) {
  const cf = useQuery({
    queryKey: ['cashflow', from, to],
    queryFn: () => accountingApi.cashflow({ from, to }),
  });

  if (cf.isLoading)
    return <div className="text-center py-12 text-slate-400">جاري التحميل...</div>;
  if (!cf.data) return null;

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4">
        <KpiCard
          title="الداخل"
          value={EGP(cf.data.inflow)}
          icon={DollarSign}
          color="emerald"
        />
        <KpiCard
          title="الخارج"
          value={EGP(cf.data.outflow)}
          icon={DollarSign}
          color="rose"
        />
        <KpiCard
          title="الصافي"
          value={EGP(cf.data.net)}
          icon={Wallet}
          color={cf.data.net >= 0 ? 'emerald' : 'rose'}
        />
      </div>
      <div className="overflow-x-auto bg-white rounded-xl border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-600">
            <tr>
              <th className="text-right p-3">التصنيف</th>
              <th className="text-right p-3">الاتجاه</th>
              <th className="text-end p-3">العدد</th>
              <th className="text-end p-3">الإجمالي</th>
            </tr>
          </thead>
          <tbody>
            {cf.data.breakdown.map((r, i) => (
              <tr key={i} className="border-t border-slate-100">
                <td className="p-3 font-medium">{r.category}</td>
                <td className="p-3">
                  <span
                    className={`inline-block px-2 py-0.5 rounded-full text-xs ${
                      r.direction === 'in'
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'bg-rose-50 text-rose-700'
                    }`}
                  >
                    {r.direction === 'in' ? 'داخل' : 'خارج'}
                  </span>
                </td>
                <td className="p-3 text-end">{r.count}</td>
                <td className="p-3 text-end font-semibold tabular-nums">
                  {EGP(r.total)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
function TrialTab({ from, to }: { from: string; to: string }) {
  const tb = useQuery({
    queryKey: ['trial-balance', from, to],
    queryFn: () => accountingApi.trialBalance({ from, to }),
  });

  if (tb.isLoading)
    return <div className="text-center py-12 text-slate-400">جاري التحميل...</div>;

  return (
    <div className="overflow-x-auto bg-white rounded-xl border border-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="text-right p-3">الخزينة</th>
            <th className="text-right p-3">المخزن</th>
            <th className="text-end p-3">رصيد الافتتاح</th>
            <th className="text-end p-3 text-emerald-600">داخل الفترة</th>
            <th className="text-end p-3 text-rose-600">خارج الفترة</th>
            <th className="text-end p-3">الرصيد الحالي</th>
          </tr>
        </thead>
        <tbody>
          {tb.data?.map((r) => {
            const opening =
              Number(r.opening_in) - Number(r.opening_out);
            return (
              <tr key={r.cashbox_id} className="border-t border-slate-100">
                <td className="p-3 font-medium">{r.cashbox_name}</td>
                <td className="p-3 text-slate-600">{r.warehouse_name}</td>
                <td className="p-3 text-end tabular-nums">{EGP(opening)}</td>
                <td className="p-3 text-end tabular-nums text-emerald-700">
                  {EGP(r.period_in)}
                </td>
                <td className="p-3 text-end tabular-nums text-rose-700">
                  {EGP(r.period_out)}
                </td>
                <td className="p-3 text-end tabular-nums font-bold">
                  {EGP(r.current_balance)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
function GLTab({ from, to }: { from: string; to: string }) {
  const gl = useQuery({
    queryKey: ['gl', from, to],
    queryFn: () =>
      accountingApi.generalLedger({ from, to, limit: 500 }),
  });

  if (gl.isLoading)
    return <div className="text-center py-12 text-slate-400">جاري التحميل...</div>;

  return (
    <div className="overflow-x-auto bg-white rounded-xl border border-slate-200">
      <table className="w-full text-sm">
        <thead className="bg-slate-50 text-slate-600">
          <tr>
            <th className="text-right p-3">التاريخ</th>
            <th className="text-right p-3">الخزينة</th>
            <th className="text-right p-3">التصنيف</th>
            <th className="text-right p-3">المستخدم</th>
            <th className="text-right p-3">ملاحظات</th>
            <th className="text-end p-3">المبلغ</th>
            <th className="text-end p-3">الرصيد بعد</th>
          </tr>
        </thead>
        <tbody>
          {gl.data?.map((r) => (
            <tr key={r.id} className="border-t border-slate-100">
              <td className="p-3 text-slate-600 text-xs">
                {new Date(r.created_at).toLocaleString('en-US')}
              </td>
              <td className="p-3">{r.cashbox_name}</td>
              <td className="p-3">{r.category}</td>
              <td className="p-3 text-slate-600">{r.user_name || '—'}</td>
              <td
                className="p-3 max-w-xs truncate text-slate-500"
                title={r.notes || ''}
              >
                {r.notes || '—'}
              </td>
              <td
                className={`p-3 text-end font-semibold tabular-nums ${
                  r.direction === 'in' ? 'text-emerald-700' : 'text-rose-700'
                }`}
              >
                {r.direction === 'in' ? '+' : '−'} {EGP(r.amount)}
              </td>
              <td className="p-3 text-end tabular-nums">
                {EGP(r.balance_after)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
