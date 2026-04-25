/**
 * Daily Expenses screen (migration 060 — Daily Expenses series PR-4).
 *
 * Records a daily expense, tied to a responsible employee. The
 * canonical `POST /accounting/expenses/daily` builds the JE through
 * FinancialEngineService and moves the cashbox atomically — this page
 * is a UX layer over that pipeline.
 *
 * Series milestones:
 *   PR-1 — strict category mapping (no silent 529 fallback) +
 *          form-to-modal conversion + add-category modal.
 *   PR-2 — captures expenses.shift_id + open-shift banner + register
 *          shows shift/cashbox/employee/account.
 *   PR-3 — full filter bar (today/week/month/year/custom +
 *          employee + category + cashbox + shift + status), 14-column
 *          register with JE entry_no + Arabic day, Excel + print
 *          (PDF) export buttons that mirror the active filters.
 *   PR-4 (this PR) — Smart Expense Analytics section under the
 *          register: 5 headline KPIs, by-category / employee / shift /
 *          cashbox breakdowns, top-5 individual expenses, daily trend
 *          bar chart, and a revenue/profit linkage card. All
 *          breakdowns derive from the same `items` array driving the
 *          register so totals match exactly. Revenue/profit come from
 *          `/accounting/reports/profit-and-loss` (period-only —
 *          employee/cashbox/shift filters narrow the expense side
 *          only).
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  BarChart3,
  DollarSign,
  Download,
  FileText,
  Hash,
  ListPlus,
  PieChart as PieIcon,
  Plus,
  Receipt,
  Sparkles,
  TrendingDown,
  TrendingUp,
  Users,
  Wallet,
  X,
} from 'lucide-react';
import { Bar, Doughnut } from 'react-chartjs-2';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
} from 'chart.js';
import { accountingApi, ExpenseCategory, Expense } from '@/api/accounting.api';
import { accountsApi } from '@/api/accounts.api';
import { usersApi } from '@/api/users.api';
import { cashDeskApi } from '@/api/cash-desk.api';
import { shiftsApi } from '@/api/shifts.api';
import { useAuthStore } from '@/stores/auth.store';
import { exportToExcel, printReport } from '@/lib/exportExcel';

ChartJS.register(
  CategoryScale,
  LinearScale,
  BarElement,
  ArcElement,
  Title,
  Tooltip,
  Legend,
);

const DEFAULT_WAREHOUSE_ID = import.meta.env.VITE_DEFAULT_WAREHOUSE_ID as string;

const EGP = (n: number | string) =>
  `${Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

/* ─── Date helpers (Cairo TZ) ───────────────────────────────────────
 *
 * Backend returns `expense_date` as a Postgres `date` column. node-pg
 * deserializes it into a JS Date at the server's local midnight, which
 * then gets JSON-stringified to a UTC ISO timestamp like
 * "2026-04-24T21:00:00.000Z" (= 2026-04-25 midnight Cairo). Several
 * earlier helpers naïvely concatenated `+ 'T00:00:00'` onto that
 * string → `Invalid Date`. The helpers below normalise any
 * date-shaped input back to a Cairo `YYYY-MM-DD`.
 * ──────────────────────────────────────────────────────────────────── */

const _ymdParts = (d: Date) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  return {
    y: parts.find((p) => p.type === 'year')!.value,
    m: parts.find((p) => p.type === 'month')!.value,
    d: parts.find((p) => p.type === 'day')!.value,
  };
};

function todayCairo(): string {
  const { y, m, d } = _ymdParts(new Date());
  return `${y}-${m}-${d}`;
}

/** Normalise "YYYY-MM-DD", a full ISO timestamp, or a Date into the
 *  Cairo calendar-day `YYYY-MM-DD`. Returns '' on bad input. */
function toCairoYMD(input: string | Date | null | undefined): string {
  if (!input) return '';
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(input)) {
    return input;
  }
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '';
  const { y, m, d: dd } = _ymdParts(d);
  return `${y}-${m}-${dd}`;
}

function shiftDate(iso: string, deltaDays: number): string {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return d.toISOString().slice(0, 10);
}

function startOfMonth(iso: string): string {
  return iso.slice(0, 7) + '-01';
}

function startOfYear(iso: string): string {
  return iso.slice(0, 4) + '-01-01';
}

/** Render any expense date field as `dd/mm/yyyy` in Cairo TZ. */
const fmtDateDMY = (input: string | Date | null | undefined) => {
  const ymd = toCairoYMD(input);
  if (!ymd) return '—';
  const [y, m, d] = ymd.split('-');
  return `${d}/${m}/${y}`;
};

/** Arabic weekday (Cairo TZ) for any date input. Never returns
 *  "Invalid Date" — falls back to '—'. */
const fmtArabicDay = (input: string | Date | null | undefined) => {
  const ymd = toCairoYMD(input);
  if (!ymd) return '—';
  // Anchor at noon UTC so the weekday stays stable across DST.
  const d = new Date(ymd + 'T12:00:00Z');
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('ar-EG', {
    timeZone: 'Africa/Cairo',
    weekday: 'long',
  });
};

const fmtTimeHMS = (iso: string | Date | null | undefined) => {
  if (!iso) return '—';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('en-GB', {
    timeZone: 'Africa/Cairo',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
};

/** Numeric tail of an expense_no string ("EXP-2026-000025" → "25"). */
const expenseSeqDisplay = (no: string | null | undefined): string => {
  if (!no) return '—';
  const m = String(no).match(/(\d+)\s*$/);
  if (!m) return String(no);
  return String(parseInt(m[1], 10) || 0);
};

type RangePreset = 'day' | 'week' | 'month' | 'year' | 'custom';

function presetRange(p: RangePreset): { from: string; to: string } {
  const today = todayCairo();
  switch (p) {
    case 'day':
      return { from: today, to: today };
    case 'week':
      return { from: shiftDate(today, -6), to: today };
    case 'month':
      return { from: startOfMonth(today), to: today };
    case 'year':
      return { from: startOfYear(today), to: today };
    default:
      return { from: today, to: today };
  }
}

/* ─── Page ─── */

export default function DailyExpenses() {
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [showAddCategory, setShowAddCategory] = useState(false);

  // Filter state — default = TODAY (per PR-5 directive). Previous
  // default 'month' silently widened the result set and confused
  // operators who expected "today's expenses" on page open.
  const [preset, setPreset] = useState<RangePreset>('day');
  const initial = useMemo(() => presetRange('day'), []);
  const [from, setFrom] = useState<string>(initial.from);
  const [to, setTo] = useState<string>(initial.to);
  const [employeeId, setEmployeeId] = useState<string>('');
  const [categoryId, setCategoryId] = useState<string>('');
  const [cashboxId, setCashboxId] = useState<string>('');
  const [shiftId, setShiftId] = useState<string>('');
  const [status, setStatus] = useState<'all' | 'approved' | 'pending'>('all');

  const setRangePreset = (p: RangePreset) => {
    setPreset(p);
    if (p !== 'custom') {
      const r = presetRange(p);
      setFrom(r.from);
      setTo(r.to);
    }
  };

  /** Restore every filter to its pristine default — today + كل الموظفين/البنود/etc. */
  const resetFilters = () => {
    const r = presetRange('day');
    setPreset('day');
    setFrom(r.from);
    setTo(r.to);
    setEmployeeId('');
    setCategoryId('');
    setCashboxId('');
    setShiftId('');
    setStatus('all');
  };

  const filtersDirty =
    preset !== 'day' ||
    !!employeeId ||
    !!categoryId ||
    !!cashboxId ||
    !!shiftId ||
    status !== 'all';

  // Picker data (shared with the Add Expense modal — react-query
  // dedups requests via the keys).
  const { data: categories = [] } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => accountingApi.categories(),
  });
  const { data: cashboxes = [] } = useQuery({
    queryKey: ['cashboxes'],
    queryFn: () => cashDeskApi.cashboxes(),
  });
  const { data: users = [] } = useQuery({
    queryKey: ['users-pickable-dex'],
    queryFn: () => usersApi.pickable(),
  });
  const { data: shifts = [] } = useQuery({
    queryKey: ['shifts-pickable-dex'],
    queryFn: () => shiftsApi.list({ status: undefined }),
  });

  const listingParams = {
    from,
    to,
    employee_user_id: employeeId || undefined,
    category_id: categoryId || undefined,
    cashbox_id: cashboxId || undefined,
    shift_id: shiftId || undefined,
    status: status === 'all' ? undefined : status,
    limit: 500,
  };

  const { data: listing, isFetching } = useQuery({
    queryKey: ['daily-expenses-list', listingParams],
    queryFn: () => accountingApi.listExpenses(listingParams),
    refetchInterval: 30_000,
  });

  const items: Expense[] = listing?.items ?? [];
  const totalAmount = listing?.total_amount ?? 0;

  /* ── Exports — both use the active backend-filtered dataset ── */

  const filterSummary = useMemo(() => {
    const parts: string[] = [];
    parts.push(`${fmtDateDMY(from)} → ${fmtDateDMY(to)}`);
    if (employeeId) {
      const u = (users as any[]).find((x) => x.id === employeeId);
      if (u) parts.push(`موظف: ${u.full_name || u.username}`);
    }
    if (categoryId) {
      const c = (categories as ExpenseCategory[]).find((x) => x.id === categoryId);
      if (c) parts.push(`بند: ${c.name_ar}`);
    }
    if (cashboxId) {
      const cb = (cashboxes as any[]).find((x) => x.id === cashboxId);
      if (cb) parts.push(`خزنة: ${cb.name_ar}`);
    }
    if (shiftId) {
      const sh = (shifts as any[]).find((x) => x.id === shiftId);
      if (sh) parts.push(`وردية: ${sh.shift_no}`);
    }
    if (status !== 'all') parts.push(`الحالة: ${status === 'approved' ? 'معتمد' : 'معلّق'}`);
    return parts.join(' · ');
  }, [from, to, employeeId, categoryId, cashboxId, shiftId, status, users, categories, cashboxes, shifts]);

  const authUser = useAuthStore((s) => s.user);

  const handleExportExcel = () => {
    if (!items.length) return toast.error('لا توجد سجلات لتصديرها');
    const rows: Record<string, any>[] = items.map((e) => ({
      'تسلسل المصروف': expenseSeqDisplay(e.expense_no),
      'رقم المصروف الكامل': e.expense_no,
      التاريخ: fmtDateDMY(e.expense_date),
      الوقت: fmtTimeHMS(e.created_at),
      اليوم: fmtArabicDay(e.expense_date),
      البند: e.category_name || '',
      'كود الحساب': e.account_code || '',
      'اسم الحساب': e.account_name_ar || '',
      المبلغ: Number(e.amount),
      'طريقة الدفع': e.payment_method,
      'الموظف المسؤول': e.employee_name || e.employee_username || '',
      'تمت بواسطة': e.created_by_name || '',
      الخزنة: e.cashbox_name || '',
      الوردية: e.shift_no || '',
      'رقم القيد': e.je_entry_no || '',
      الحالة:
        e.je_is_void
          ? 'ملغي'
          : e.is_approved
            ? 'معتمد'
            : 'معلّق',
      الوصف: e.description || '',
    }));
    rows.push({
      'تسلسل المصروف': '',
      'رقم المصروف الكامل': '',
      التاريخ: '',
      الوقت: '',
      اليوم: '',
      البند: 'إجمالي المصروفات',
      'كود الحساب': '',
      'اسم الحساب': '',
      المبلغ: Number(totalAmount),
      'طريقة الدفع': '',
      'الموظف المسؤول': '',
      'تمت بواسطة': '',
      الخزنة: '',
      الوردية: '',
      'رقم القيد': '',
      الحالة: '',
      الوصف: filterSummary + (authUser ? ` · مُصدِّر: ${authUser.full_name || authUser.username}` : ''),
    });
    exportToExcel(`daily-expenses-${from}-to-${to}`, rows, 'المصروفات');
  };

  const handleExportPdf = () => {
    if (!items.length) return toast.error('لا توجد سجلات لتصديرها');
    const rowsHtml = items
      .map(
        (e) => `
      <tr>
        <td style="font-family: monospace;" title="${escapeHtml(e.expense_no)}">${escapeHtml(expenseSeqDisplay(e.expense_no))}</td>
        <td>${escapeHtml(fmtDateDMY(e.expense_date))} ${escapeHtml(fmtTimeHMS(e.created_at))}</td>
        <td>${escapeHtml(fmtArabicDay(e.expense_date))}</td>
        <td>${escapeHtml(e.category_name || '')}</td>
        <td style="font-family: monospace;">${escapeHtml(`${e.account_code || ''} ${e.account_name_ar || ''}`.trim())}</td>
        <td style="text-align: left;">${EGP(e.amount)}</td>
        <td>${escapeHtml(e.employee_name || e.employee_username || '')}</td>
        <td>${escapeHtml(e.cashbox_name || '')}</td>
        <td style="font-family: monospace;">${escapeHtml(e.shift_no || '')}</td>
        <td style="font-family: monospace;">${escapeHtml(e.je_entry_no || '')}</td>
      </tr>`,
      )
      .join('');
    const html = `
      <div class="muted">${escapeHtml(filterSummary)}${authUser ? ' · مُصدِّر: ' + escapeHtml(authUser.full_name || authUser.username || '') : ''}</div>
      <table>
        <thead>
          <tr>
            <th>تسلسل</th>
            <th>التاريخ والوقت</th>
            <th>اليوم</th>
            <th>البند</th>
            <th>الحساب</th>
            <th class="right">المبلغ</th>
            <th>المسؤول</th>
            <th>الخزنة</th>
            <th>الوردية</th>
            <th>رقم القيد</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot>
          <tr style="background:#f8fafc; font-weight:bold;">
            <td colspan="5" style="text-align:right;">إجمالي المصروفات</td>
            <td class="right">${EGP(totalAmount)}</td>
            <td colspan="4"></td>
          </tr>
        </tfoot>
      </table>`;
    printReport('تقرير المصروفات اليومية', html);
  };

  return (
    <div className="space-y-5">
      {/* ─── 1. Page header ─── */}
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-xl bg-amber-100 text-amber-700">
          <Receipt size={20} />
        </div>
        <div>
          <h1 className="text-xl font-black text-slate-800">المصروفات اليومية</h1>
          <p className="text-xs text-slate-500">
            تسجيل مصروف يومي مرتبط بالموظف المسؤول — يُرحَّل القيد تلقائيًا
          </p>
        </div>
      </div>

      {/* ─── 2. Smart Expense Analytics (PR-4, repositioned in PR-5) ─── */}
      <AnalyticsSection items={items} from={from} to={to} totalAmount={Number(totalAmount)} />

      {/* ─── 3. Filter bar ─── */}
      <div className="card p-3 space-y-3">
        <div className="flex items-center gap-1 flex-wrap">
          {(['day', 'week', 'month', 'year', 'custom'] as const).map((p) => {
            const label = { day: 'اليوم', week: 'الأسبوع', month: 'الشهر', year: 'السنة', custom: 'مخصص' }[p];
            return (
              <button
                key={p}
                type="button"
                onClick={() => setRangePreset(p)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold transition ${
                  preset === p
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-100 text-slate-700 hover:bg-slate-200'
                }`}
              >
                {label}
              </button>
            );
          })}
          <span className="text-[10px] text-slate-400 mx-2 hidden sm:inline">
            {fmtDateDMY(from)} → {fmtDateDMY(to)}
          </span>
          <button
            type="button"
            onClick={resetFilters}
            disabled={!filtersDirty}
            title="استعادة الفلاتر الافتراضية (اليوم + كل الموظفين/البنود/الخزن/الورديات)"
            className={`mr-auto px-3 py-1.5 rounded-lg text-xs font-bold transition flex items-center gap-1 ${
              filtersDirty
                ? 'bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100'
                : 'bg-slate-50 text-slate-400 border border-slate-200 cursor-not-allowed'
            }`}
          >
            <X size={12} /> مسح الفلاتر
          </button>
        </div>

        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2 text-xs">
          {preset === 'custom' && (
            <>
              <label className="block">
                <span className="block text-[10px] text-slate-500 mb-0.5">من</span>
                <input
                  type="date"
                  className="input input-sm w-full"
                  value={from}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label className="block">
                <span className="block text-[10px] text-slate-500 mb-0.5">إلى</span>
                <input
                  type="date"
                  className="input input-sm w-full"
                  value={to}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </>
          )}
          <label className="block">
            <span className="block text-[10px] text-slate-500 mb-0.5">المسؤول</span>
            <select
              className="input input-sm w-full"
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
            >
              <option value="">— كل الموظفين —</option>
              {(users as any[]).map((u) => (
                <option key={u.id} value={u.id}>
                  {u.full_name || u.username}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[10px] text-slate-500 mb-0.5">البند</span>
            <select
              className="input input-sm w-full"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
            >
              <option value="">— كل البنود —</option>
              {(categories as ExpenseCategory[]).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name_ar}
                  {c.account_code ? ` (${c.account_code})` : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[10px] text-slate-500 mb-0.5">الخزنة</span>
            <select
              className="input input-sm w-full"
              value={cashboxId}
              onChange={(e) => setCashboxId(e.target.value)}
            >
              <option value="">— كل الخزن —</option>
              {(cashboxes as any[]).map((cb) => (
                <option key={cb.id} value={cb.id}>
                  {cb.name_ar}
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[10px] text-slate-500 mb-0.5">الوردية</span>
            <select
              className="input input-sm w-full"
              value={shiftId}
              onChange={(e) => setShiftId(e.target.value)}
            >
              <option value="">— كل الورديات —</option>
              {(shifts as any[]).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.shift_no} ({s.status === 'open' ? 'مفتوحة' : 'مغلقة'})
                </option>
              ))}
            </select>
          </label>
          <label className="block">
            <span className="block text-[10px] text-slate-500 mb-0.5">الحالة</span>
            <select
              className="input input-sm w-full"
              value={status}
              onChange={(e) => setStatus(e.target.value as any)}
            >
              <option value="all">— الكل —</option>
              <option value="approved">معتمد</option>
              <option value="pending">معلّق</option>
            </select>
          </label>
        </div>
      </div>

      {/* ─── 4. Action buttons row ─── */}
      <div className="flex items-center justify-end gap-2 flex-wrap">
        <button className="btn-ghost text-xs flex items-center gap-1.5" onClick={handleExportExcel}>
          <Download size={14} /> تصدير Excel
        </button>
        <button className="btn-ghost text-xs flex items-center gap-1.5" onClick={handleExportPdf}>
          <FileText size={14} /> تصدير PDF
        </button>
        <button
          className="btn-ghost text-xs flex items-center gap-1.5"
          onClick={() => setShowAddCategory(true)}
          title="أضف بند مصروف جديد مرتبط بحساب محاسبي"
        >
          <ListPlus size={14} /> إضافة بند
        </button>
        <button
          className="btn-primary text-xs flex items-center gap-1.5"
          onClick={() => setShowAddExpense(true)}
        >
          <Plus size={14} /> إضافة مصروف
        </button>
      </div>

      {/* ─── 5. Register ─── */}
      <div className="card p-5">
        <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
          <h3 className="font-black text-slate-800">سجل المصروفات</h3>
          <div className="text-[11px] text-slate-500">
            {isFetching ? 'جارٍ التحميل…' : `${items.length} سجل · إجمالي ${EGP(totalAmount)}`}
          </div>
        </div>
        {items.length === 0 ? (
          <div className="text-center text-slate-500 text-xs py-8">
            لا توجد سجلات تطابق الفلتر الحالي.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-[11px]">
                  <th className="p-2 text-right">تسلسل</th>
                  <th className="p-2 text-right">التاريخ</th>
                  <th className="p-2 text-right">الوقت</th>
                  <th className="p-2 text-right">اليوم</th>
                  <th className="p-2 text-right">البند</th>
                  <th className="p-2 text-right">الحساب</th>
                  <th className="p-2 text-center">المبلغ</th>
                  <th className="p-2 text-right">المسؤول</th>
                  <th className="p-2 text-right">تمت بواسطة</th>
                  <th className="p-2 text-right">الخزنة</th>
                  <th className="p-2 text-right">الوردية</th>
                  <th className="p-2 text-right">رقم القيد</th>
                  <th className="p-2 text-center">الدفع</th>
                  <th className="p-2 text-center">الحالة</th>
                </tr>
              </thead>
              <tbody>
                {items.map((e) => (
                  <tr key={e.id} className="border-t border-slate-100">
                    <td
                      className="p-2 font-mono text-[11px] text-slate-700 tabular-nums"
                      title={e.expense_no}
                    >
                      {expenseSeqDisplay(e.expense_no)}
                    </td>
                    <td className="p-2 font-mono tabular-nums">{fmtDateDMY(e.expense_date)}</td>
                    <td className="p-2 font-mono tabular-nums">{fmtTimeHMS(e.created_at)}</td>
                    <td className="p-2 text-slate-700">{fmtArabicDay(e.expense_date)}</td>
                    <td className="p-2">{e.category_name || '—'}</td>
                    <td className="p-2 text-slate-600 text-[10px] font-mono">
                      {e.account_code ? `${e.account_code} ${e.account_name_ar || ''}`.trim() : '—'}
                    </td>
                    <td className="p-2 text-center font-bold tabular-nums text-rose-700">
                      {EGP(e.amount)}
                    </td>
                    <td className="p-2 text-slate-700 text-[11px]">
                      {e.employee_name || e.employee_username || '—'}
                    </td>
                    <td className="p-2 text-slate-600 text-[11px]">
                      {e.created_by_name || '—'}
                    </td>
                    <td className="p-2 text-slate-700 text-[11px]">{e.cashbox_name || '—'}</td>
                    <td className="p-2 text-slate-600 font-mono text-[10px]">{e.shift_no || '—'}</td>
                    <td className="p-2 text-slate-600 font-mono text-[10px]">
                      {e.je_entry_no || '—'}
                    </td>
                    <td className="p-2 text-center text-slate-600">{e.payment_method}</td>
                    <td className="p-2 text-center">
                      <span
                        className={`chip text-[10px] ${
                          e.je_is_void
                            ? 'bg-rose-50 text-rose-700 border-rose-200'
                            : e.is_approved
                              ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                              : 'bg-amber-50 text-amber-700 border-amber-200'
                        }`}
                      >
                        {e.je_is_void ? 'ملغي' : e.is_approved ? 'معتمد' : 'معلّق'}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-200 bg-slate-50 font-black">
                  <td colSpan={6} className="p-2 text-right">
                    الإجمالي
                  </td>
                  <td className="p-2 text-center tabular-nums text-rose-700">
                    {EGP(totalAmount)}
                  </td>
                  <td colSpan={7}></td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {showAddExpense && (
        <AddExpenseModal
          onClose={() => setShowAddExpense(false)}
          onSaved={() => setShowAddExpense(false)}
          onAddCategory={() => setShowAddCategory(true)}
        />
      )}
      {showAddCategory && (
        <AddCategoryModal onClose={() => setShowAddCategory(false)} />
      )}
    </div>
  );
}

/* ─── HTML escape for the print export ─── */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ─── Add expense modal — short and operational (PR-3) ─── */

function AddExpenseModal({
  onClose,
  onSaved,
  onAddCategory,
}: {
  onClose: () => void;
  onSaved: () => void;
  onAddCategory: () => void;
}) {
  const qc = useQueryClient();
  const authUser = useAuthStore((s) => s.user);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canPickOthers =
    hasPermission('employee.team.view') ||
    hasPermission('accounts.journal.post') ||
    hasPermission('*');

  const today = new Date().toISOString().slice(0, 10);
  const [amount, setAmount] = useState('');
  const [categoryId, setCategoryId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<
    'cash' | 'card' | 'transfer' | 'wallet' | 'mixed'
  >('cash');
  const [cashboxId, setCashboxId] = useState('');
  const [description, setDescription] = useState('');
  const [employeeId, setEmployeeId] = useState<string>(authUser?.id || '');
  const [expenseDate, setExpenseDate] = useState<string>(today);

  const { data: categories = [] } = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => accountingApi.categories(),
  });
  const { data: cashboxes = [] } = useQuery({
    queryKey: ['cashboxes'],
    queryFn: () => cashDeskApi.cashboxes(),
  });
  const { data: users = [] } = useQuery({
    queryKey: ['users-pickable-dex'],
    queryFn: () => usersApi.pickable(),
    enabled: canPickOthers,
  });
  const { data: currentShift } = useQuery({
    queryKey: ['shift-current-dex'],
    queryFn: () => shiftsApi.current(),
    staleTime: 60_000,
  });

  // Auto-pick the currently open shift's cashbox the first time the
  // cashbox dropdown renders. PR-2 also captures shift_id server-side.
  useEffect(() => {
    if (!cashboxId && currentShift?.cashbox_id) {
      setCashboxId(String(currentShift.cashbox_id));
    }
  }, [currentShift, cashboxId]);

  const hasOpenShift = !!(currentShift?.id && currentShift?.cashbox_id);

  const selectedCategory = useMemo<ExpenseCategory | null>(
    () =>
      (categories as ExpenseCategory[]).find((c) => c.id === categoryId) ?? null,
    [categories, categoryId],
  );
  const selectedCashbox = useMemo<any>(
    () => (cashboxes as any[]).find((c) => c.id === cashboxId) ?? null,
    [cashboxes, cashboxId],
  );

  const categoryUnmapped = !!selectedCategory && !selectedCategory.account_id;

  const create = useMutation({
    mutationFn: () =>
      accountingApi.createDailyExpense({
        warehouse_id: DEFAULT_WAREHOUSE_ID,
        cashbox_id: paymentMethod === 'cash' ? cashboxId || undefined : undefined,
        category_id: categoryId,
        amount: Number(amount),
        payment_method: paymentMethod,
        expense_date: expenseDate,
        description: description || undefined,
        employee_user_id: employeeId,
        // vendor_name + receipt_url removed from form per PR-3 directive;
        // backend DTO still accepts them so legacy callers stay valid.
      }),
    onSuccess: () => {
      toast.success('تم تسجيل المصروف + ترحيل القيد');
      qc.invalidateQueries({ queryKey: ['daily-expenses-list'] });
      qc.invalidateQueries({ queryKey: ['employee-ledger'] });
      onSaved();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تسجيل المصروف'),
  });

  const submit = () => {
    if (!categoryId) return toast.error('اختر نوع المصروف');
    if (categoryUnmapped) {
      return toast.error('هذا البند غير مربوط بحساب محاسبي. اختر الحساب أولًا.');
    }
    if (!amount || Number(amount) <= 0) return toast.error('أدخل مبلغ صحيح');
    if (!employeeId) return toast.error('اختر الموظف المسؤول');
    if (paymentMethod === 'cash' && !cashboxId && !currentShift?.cashbox_id)
      return toast.error('اختر الخزنة أو افتح وردية أولًا');
    create.mutate();
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel w-full max-w-lg space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between sticky top-0 bg-white z-10 -mx-1 px-1 pb-2 border-b border-slate-100">
          <h3 className="text-lg font-bold flex items-center gap-2">
            <Receipt size={18} className="text-amber-600" />
            تسجيل مصروف جديد
          </h3>
          <button onClick={onClose} className="icon-btn" disabled={create.isPending}>
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Open-shift status banner (PR-2 behaviour). */}
        <div
          className={`rounded-lg border px-3 py-2 text-[11px] leading-relaxed ${
            hasOpenShift
              ? 'border-emerald-200 bg-emerald-50 text-emerald-900'
              : 'border-amber-200 bg-amber-50 text-amber-900'
          }`}
        >
          {hasOpenShift ? (
            <span>
              مرتبط بالوردية المفتوحة:{' '}
              <span className="font-bold font-mono">
                {(currentShift as any)?.shift_no || (currentShift as any)?.id}
              </span>
              {' '}— الخزنة محسومة تلقائيًا من الوردية.
            </span>
          ) : (
            <span>
              لا توجد وردية مفتوحة لك حالياً — اختر الخزنة والموظف
              المسؤول يدوياً.
            </span>
          )}
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <FieldLabel label="نوع المصروف (حساب)">
            <div className="flex items-stretch gap-1">
              <select
                className="input w-full"
                value={categoryId}
                onChange={(e) => setCategoryId(e.target.value)}
                disabled={create.isPending}
              >
                <option value="">اختر…</option>
                {(categories as ExpenseCategory[])
                  .filter((c) => c.is_active !== false)
                  .map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name_ar} ({c.code})
                      {c.account_code ? ` — ${c.account_code}` : ' — غير مربوط'}
                    </option>
                  ))}
              </select>
              <button
                type="button"
                className="btn-ghost px-2 text-[11px] shrink-0"
                onClick={onAddCategory}
                disabled={create.isPending}
                title="إضافة بند جديد"
              >
                + بند
              </button>
            </div>
          </FieldLabel>

          <FieldLabel label="المبلغ (ج.م)">
            <input
              type="number"
              step="0.01"
              min="0"
              className="input w-full tabular-nums"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={create.isPending}
            />
          </FieldLabel>

          <FieldLabel label="طريقة الدفع">
            <select
              className="input w-full"
              value={paymentMethod}
              onChange={(e) =>
                setPaymentMethod(
                  e.target.value as
                    | 'cash'
                    | 'card'
                    | 'transfer'
                    | 'wallet'
                    | 'mixed',
                )
              }
              disabled={create.isPending}
            >
              <option value="cash">نقدي (Cash)</option>
              <option value="transfer">تحويل بنكي</option>
              <option value="card">بطاقة</option>
              <option value="wallet">محفظة إلكترونية</option>
              <option value="mixed">مختلط</option>
            </select>
          </FieldLabel>

          {paymentMethod === 'cash' && (
            <FieldLabel label="الخزنة">
              <select
                className="input w-full"
                value={cashboxId}
                onChange={(e) => setCashboxId(e.target.value)}
                disabled={create.isPending}
              >
                <option value="">اختر…</option>
                {(cashboxes as any[]).map((cb: any) => (
                  <option key={cb.id} value={cb.id}>
                    {cb.name_ar} — رصيد {EGP(cb.current_balance || 0)}
                  </option>
                ))}
              </select>
            </FieldLabel>
          )}

          <FieldLabel label="التاريخ">
            <input
              type="date"
              className="input w-full"
              value={expenseDate}
              onChange={(e) => setExpenseDate(e.target.value)}
              disabled={create.isPending}
            />
          </FieldLabel>

          <FieldLabel
            label={
              <span className="flex items-center gap-1">
                <Users size={12} /> الموظف المسؤول
              </span>
            }
          >
            {canPickOthers ? (
              <select
                className="input w-full"
                value={employeeId}
                onChange={(e) => setEmployeeId(e.target.value)}
                disabled={create.isPending}
              >
                <option value="">اختر…</option>
                {users.map((u: any) => (
                  <option key={u.id} value={u.id}>
                    {u.full_name} ({u.username})
                  </option>
                ))}
              </select>
            ) : (
              <input
                className="input w-full bg-slate-50 text-slate-600"
                value={authUser?.full_name || authUser?.username || ''}
                disabled
              />
            )}
          </FieldLabel>

          <div className="md:col-span-2">
            <FieldLabel label="الوصف">
              <input
                className="input w-full"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                disabled={create.isPending}
              />
            </FieldLabel>
          </div>
        </div>

        {/* Account preview — DR mapped expense / CR cashbox. */}
        {selectedCategory && (
          <div
            className={`rounded-lg border-2 px-3 py-2 text-[11px] leading-relaxed ${
              categoryUnmapped
                ? 'border-rose-300 bg-rose-50 text-rose-900'
                : 'border-emerald-200 bg-emerald-50 text-emerald-900'
            }`}
          >
            {categoryUnmapped ? (
              <div className="flex items-start gap-2">
                <AlertTriangle className="text-rose-600 shrink-0 mt-0.5" size={14} />
                <div>
                  <div className="font-bold">
                    هذا البند غير مربوط بحساب محاسبي. اختر الحساب أولًا.
                  </div>
                </div>
              </div>
            ) : (
              <>
                <div className="font-bold mb-0.5">سيتم ترحيل القيد:</div>
                <div className="font-mono tabular-nums leading-tight">
                  DR {selectedCategory.account_code}{' '}
                  <span className="opacity-80">
                    ({selectedCategory.account_name_ar})
                  </span>
                  {amount && Number(amount) > 0 && (
                    <span className="opacity-90"> {EGP(Number(amount))}</span>
                  )}
                </div>
                <div className="font-mono tabular-nums leading-tight">
                  CR{' '}
                  {paymentMethod === 'cash' && selectedCashbox
                    ? `الخزنة ${selectedCashbox.name_ar}`
                    : paymentMethod === 'cash'
                      ? '— اختر الخزنة'
                      : '210 الموردون (مدين على الحساب)'}
                  {amount && Number(amount) > 0 && (
                    <span className="opacity-90"> {EGP(Number(amount))}</span>
                  )}
                </div>
              </>
            )}
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
          <button
            className="btn-ghost text-xs"
            onClick={onClose}
            disabled={create.isPending}
          >
            إلغاء
          </button>
          <button
            className="btn-primary text-xs flex items-center gap-1.5"
            onClick={submit}
            disabled={create.isPending || categoryUnmapped}
          >
            <DollarSign size={14} />
            {create.isPending ? 'جارٍ الترحيل…' : 'تسجيل + ترحيل القيد'}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ─── Add category modal (unchanged from PR-1) ─── */

function AddCategoryModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [accountId, setAccountId] = useState('');
  const [isFixed, setIsFixed] = useState(false);
  const [allocateToCogs, setAllocateToCogs] = useState(false);

  const { data: accounts = [] } = useQuery({
    queryKey: ['coa-leaves-for-category'],
    queryFn: () => accountsApi.list(),
  });

  const create = useMutation({
    mutationFn: () =>
      accountingApi.createCategory({
        code: code.trim(),
        name_ar: nameAr.trim(),
        is_fixed: isFixed,
        allocate_to_cogs: allocateToCogs,
        account_id: accountId,
      } as any),
    onSuccess: () => {
      toast.success('تمت إضافة البند');
      qc.invalidateQueries({ queryKey: ['expense-categories'] });
      onClose();
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.message;
      toast.error(
        Array.isArray(msg)
          ? msg.join(' · ')
          : msg || 'فشل إضافة البند (تحقق أن الكود غير مكرر)',
      );
    },
  });

  const canSubmit =
    code.trim().length > 0 &&
    nameAr.trim().length > 0 &&
    accountId.length > 0 &&
    !create.isPending;

  const leaves = (accounts as any[])
    .filter((a) => a.is_active && a.is_leaf)
    .sort((a, b) => String(a.code).localeCompare(String(b.code)));

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal-panel w-full max-w-md space-y-3"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-bold flex items-center gap-2">
            <ListPlus size={16} className="text-indigo-600" />
            إضافة بند مصروف
          </h3>
          <button onClick={onClose} className="icon-btn">
            <X className="w-4 h-4" />
          </button>
        </div>

        <FieldLabel label="الكود (مختصر — لا يقبل التكرار)">
          <input
            className="input w-full font-mono text-xs"
            placeholder="مثال: rent, electricity, salaries"
            value={code}
            onChange={(e) => setCode(e.target.value)}
            disabled={create.isPending}
          />
        </FieldLabel>

        <FieldLabel label="الاسم بالعربية">
          <input
            className="input w-full"
            placeholder="مثال: إيجار المحل"
            value={nameAr}
            onChange={(e) => setNameAr(e.target.value)}
            disabled={create.isPending}
          />
        </FieldLabel>

        <FieldLabel label="الحساب المحاسبي (مطلوب)">
          <select
            className="input w-full"
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
            disabled={create.isPending}
          >
            <option value="">اختر حساباً من شجرة الحسابات…</option>
            {leaves.map((a) => (
              <option key={a.id} value={a.id}>
                {a.code} — {a.name_ar}
              </option>
            ))}
          </select>
        </FieldLabel>

        <div className="flex items-center gap-4 text-xs text-slate-700">
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={isFixed}
              onChange={(e) => setIsFixed(e.target.checked)}
              disabled={create.isPending}
            />
            مصروف ثابت
          </label>
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={allocateToCogs}
              onChange={(e) => setAllocateToCogs(e.target.checked)}
              disabled={create.isPending}
            />
            ضمن تكلفة المبيعات (COGS)
          </label>
        </div>

        <div className="text-[10px] text-slate-500 leading-relaxed">
          البند بدون حساب لن يظهر صالحاً في نموذج المصروفات اليومية —
          إضافة الحساب إلزامية لمنع الترحيل التلقائي إلى مصروفات متفرقة
          (529).
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
          <button onClick={onClose} className="btn-ghost text-xs" disabled={create.isPending}>
            إلغاء
          </button>
          <button
            className="btn-primary text-xs"
            disabled={!canSubmit}
            onClick={() => create.mutate()}
          >
            {create.isPending ? 'جارٍ الحفظ…' : 'حفظ البند'}
          </button>
        </div>
      </div>
    </div>
  );
}

function FieldLabel({
  label,
  children,
}: {
  label: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="text-xs font-bold text-slate-600 mb-1 block">
        {label}
      </span>
      {children}
    </label>
  );
}

/* ─── PR-4 · Smart Expense Analytics ──────────────────────────────────
 *
 * One section, twelve cards/charts. All expense numbers come from the
 * same `items` array driving the register, so totals match exactly.
 * Revenue + profit come from /accounting/reports/profit-and-loss using
 * period-only (from/to) — employee/cashbox/shift filters from PR-3
 * intentionally do NOT narrow revenue (the period sales total isn't
 * sliced by an expense's responsible employee or cashbox; pretending
 * otherwise would invent data).
 * ──────────────────────────────────────────────────────────────────── */

function AnalyticsSection({
  items,
  from,
  to,
  totalAmount,
}: {
  items: Expense[];
  from: string;
  to: string;
  totalAmount: number;
}) {
  const { data: pnl } = useQuery({
    queryKey: ['daily-expenses-pnl', from, to],
    queryFn: () => accountingApi.profitAndLoss({ from, to }),
    staleTime: 60_000,
  });

  const stats = useMemo(() => {
    const count = items.length;
    const total = items.reduce((s, e) => s + Number(e.amount || 0), 0);
    const avg = count > 0 ? total / count : 0;

    const groupBy = (key: (e: Expense) => string) => {
      const m = new Map<string, { label: string; total: number; count: number }>();
      items.forEach((e) => {
        const k = key(e);
        const cur = m.get(k) || { label: k, total: 0, count: 0 };
        cur.total += Number(e.amount || 0);
        cur.count += 1;
        m.set(k, cur);
      });
      return Array.from(m.values()).sort((a, b) => b.total - a.total);
    };

    const byCategory = groupBy((e) => e.category_name || '— غير محدد —');
    const byEmployee = groupBy(
      (e) => e.employee_name || e.employee_username || '— غير محدد —',
    );
    const byCashbox = groupBy((e) => e.cashbox_name || '— بدون خزنة —');
    const byShift = groupBy((e) => e.shift_no || '— بدون وردية —');

    const topN = items
      .slice()
      .sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0))
      .slice(0, 5);

    // Daily trend — always per-day granularity (per PR-4 spec). Bucket
    // by Cairo calendar day so a Cairo-evening expense doesn't drift
    // into the previous bar.
    const dailyMap = new Map<string, number>();
    items.forEach((e) => {
      const d = toCairoYMD(e.expense_date);
      if (!d) return;
      dailyMap.set(d, (dailyMap.get(d) || 0) + Number(e.amount || 0));
    });
    const dailyTrend = Array.from(dailyMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, total]) => ({ date, label: fmtDateDMY(date), total }));

    return {
      count,
      total,
      avg,
      byCategory,
      byEmployee,
      byCashbox,
      byShift,
      topN,
      dailyTrend,
    };
  }, [items]);

  const periodRevenue = Number(pnl?.net_revenue || 0);
  const periodNetProfit = Number(pnl?.net_profit || 0);
  const periodOpEx = Number(pnl?.operating_expenses || 0);
  const expensesAsPctOfRevenue =
    periodRevenue > 0 ? (stats.total / periodRevenue) * 100 : 0;

  // Sanity: register total vs computed total should be equal (both
  // come from `items`). Show as a footnote if off (would only happen
  // on a bug).
  const totalDrift = Math.abs(stats.total - totalAmount);

  if (items.length === 0) {
    return (
      <div className="card p-5 text-center text-xs text-slate-500">
        <Sparkles size={20} className="mx-auto mb-2 text-slate-300" />
        لا توجد بيانات كافية للتحليل في الفترة الحالية.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <Sparkles size={18} className="text-indigo-600" />
        <h3 className="font-black text-slate-800 text-sm">تحليل ذكي للمصروفات</h3>
        <span className="text-[10px] text-slate-400">
          {fmtDateDMY(from)} → {fmtDateDMY(to)}
        </span>
        {totalDrift > 0.01 && (
          <span className="chip text-[10px] bg-rose-50 text-rose-700 border-rose-200">
            تنبيه: فرق {EGP(totalDrift)} بين الإجمالي والتفصيل
          </span>
        )}
      </div>

      {/* ─── Headline KPIs (5) ─── */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <KpiCard
          icon={<DollarSign size={16} />}
          tone="rose"
          label="إجمالي المصروفات"
          value={EGP(stats.total)}
          hint={`${stats.count} سجل`}
        />
        <KpiCard
          icon={<Hash size={16} />}
          tone="slate"
          label="عدد المصروفات"
          value={stats.count.toLocaleString('en-US')}
          hint="ضمن الفلتر"
        />
        <KpiCard
          icon={<BarChart3 size={16} />}
          tone="indigo"
          label="متوسط المصروف"
          value={EGP(stats.avg)}
          hint="إجمالي ÷ عدد"
        />
        <KpiCard
          icon={<TrendingDown size={16} />}
          tone="amber"
          label="نسبة من الإيرادات"
          value={
            periodRevenue > 0
              ? `${expensesAsPctOfRevenue.toFixed(1)}%`
              : '—'
          }
          hint={periodRevenue > 0 ? `إيراد الفترة ${EGP(periodRevenue)}` : 'لا توجد إيرادات'}
        />
        <KpiCard
          icon={periodNetProfit >= 0 ? <TrendingUp size={16} /> : <TrendingDown size={16} />}
          tone={periodNetProfit >= 0 ? 'emerald' : 'rose'}
          label="صافي ربح الفترة"
          value={EGP(periodNetProfit)}
          hint="من تقرير الأرباح"
        />
      </div>

      {/* ─── Daily trend chart + Revenue linkage ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <div className="card p-4 lg:col-span-2">
          <div className="flex items-center justify-between mb-2">
            <h4 className="text-xs font-black text-slate-700 flex items-center gap-1.5">
              <BarChart3 size={14} /> الاتجاه اليومي للمصروفات
            </h4>
            <span className="text-[10px] text-slate-400">
              {stats.dailyTrend.length} يوم
            </span>
          </div>
          <div style={{ height: 220 }}>
            <Bar
              data={{
                labels: stats.dailyTrend.map((d) => d.label),
                datasets: [
                  {
                    label: 'مصروفات اليوم',
                    data: stats.dailyTrend.map((d) => d.total),
                    backgroundColor: 'rgba(244, 63, 94, 0.7)',
                    borderColor: 'rgba(190, 18, 60, 1)',
                    borderWidth: 1,
                    borderRadius: 4,
                  },
                ],
              }}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: { display: false },
                  tooltip: {
                    callbacks: {
                      label: (ctx) => EGP(Number(ctx.parsed.y || 0)),
                    },
                  },
                },
                scales: {
                  x: { ticks: { font: { size: 10 } } },
                  y: {
                    beginAtZero: true,
                    ticks: {
                      font: { size: 10 },
                      callback: (v) => `${Number(v).toLocaleString('en-US')}`,
                    },
                  },
                },
              }}
            />
          </div>
        </div>

        <div className="card p-4 space-y-3">
          <h4 className="text-xs font-black text-slate-700 flex items-center gap-1.5">
            <TrendingUp size={14} /> ارتباط الإيرادات والربح
          </h4>
          <div className="space-y-2 text-xs">
            <RevenueRow label="إيراد الفترة" value={EGP(periodRevenue)} tone="emerald" />
            <RevenueRow
              label="مصروفات تشغيل (P&L)"
              value={EGP(periodOpEx)}
              tone="rose"
            />
            <RevenueRow
              label="صافي الربح"
              value={EGP(periodNetProfit)}
              tone={periodNetProfit >= 0 ? 'emerald' : 'rose'}
            />
            <div className="border-t border-slate-100 pt-2 mt-2">
              <RevenueRow
                label="مصروفات الفلتر الحالي"
                value={EGP(stats.total)}
                tone="slate"
              />
              <p className="text-[10px] text-slate-400 mt-1.5 leading-relaxed">
                الإيراد والربح تُحسب لكامل الفترة ({fmtDateDMY(from)} → {fmtDateDMY(to)}).
                فلاتر الموظف/الخزنة/الوردية تخص المصروفات فقط.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* ─── Breakdowns (4) ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <BreakdownCard
          title="حسب البند"
          icon={<PieIcon size={14} />}
          rows={stats.byCategory}
          total={stats.total}
        />
        <BreakdownCard
          title="حسب الموظف المسؤول"
          icon={<Users size={14} />}
          rows={stats.byEmployee}
          total={stats.total}
        />
        <BreakdownCard
          title="حسب الخزنة"
          icon={<Wallet size={14} />}
          rows={stats.byCashbox}
          total={stats.total}
        />
        <BreakdownCard
          title="حسب الوردية"
          icon={<Hash size={14} />}
          rows={stats.byShift}
          total={stats.total}
        />
      </div>

      {/* ─── Top-5 individual expenses ─── */}
      <div className="card p-4">
        <h4 className="text-xs font-black text-slate-700 mb-3 flex items-center gap-1.5">
          <TrendingUp size={14} /> أعلى 5 مصروفات
        </h4>
        {stats.topN.length === 0 ? (
          <div className="text-center text-slate-500 text-xs py-4">لا توجد سجلات.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-[11px]">
                  <th className="p-2 text-right">#</th>
                  <th className="p-2 text-right">التاريخ</th>
                  <th className="p-2 text-right">البند</th>
                  <th className="p-2 text-right">المسؤول</th>
                  <th className="p-2 text-center">المبلغ</th>
                  <th className="p-2 text-right">الوصف</th>
                </tr>
              </thead>
              <tbody>
                {stats.topN.map((e, i) => (
                  <tr key={e.id} className="border-t border-slate-100">
                    <td className="p-2 font-mono text-[10px] text-slate-500">{i + 1}</td>
                    <td className="p-2 font-mono tabular-nums">{fmtDateDMY(e.expense_date)}</td>
                    <td className="p-2">{e.category_name || '—'}</td>
                    <td className="p-2 text-slate-700 text-[11px]">
                      {e.employee_name || e.employee_username || '—'}
                    </td>
                    <td className="p-2 text-center font-bold tabular-nums text-rose-700">
                      {EGP(e.amount)}
                    </td>
                    <td className="p-2 text-slate-600 text-[11px] truncate max-w-xs">
                      {e.description || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Small UI helpers used only by AnalyticsSection ─── */

function KpiCard({
  icon,
  tone,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  tone: 'rose' | 'emerald' | 'indigo' | 'amber' | 'slate';
  label: string;
  value: string;
  hint?: string;
}) {
  const toneMap = {
    rose: 'bg-rose-50 text-rose-700',
    emerald: 'bg-emerald-50 text-emerald-700',
    indigo: 'bg-indigo-50 text-indigo-700',
    amber: 'bg-amber-50 text-amber-700',
    slate: 'bg-slate-100 text-slate-700',
  } as const;
  return (
    <div className="card p-3 space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-500 font-bold">{label}</span>
        <span className={`p-1 rounded ${toneMap[tone]}`}>{icon}</span>
      </div>
      <div className="text-base font-black text-slate-800 tabular-nums">{value}</div>
      {hint && <div className="text-[10px] text-slate-400">{hint}</div>}
    </div>
  );
}

function RevenueRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: 'rose' | 'emerald' | 'slate';
}) {
  const toneMap = {
    rose: 'text-rose-700',
    emerald: 'text-emerald-700',
    slate: 'text-slate-700',
  } as const;
  return (
    <div className="flex items-center justify-between">
      <span className="text-slate-600">{label}</span>
      <span className={`font-black tabular-nums ${toneMap[tone]}`}>{value}</span>
    </div>
  );
}

function BreakdownCard({
  title,
  icon,
  rows,
  total,
}: {
  title: string;
  icon: React.ReactNode;
  rows: Array<{ label: string; total: number; count: number }>;
  total: number;
}) {
  // Group rows past the top-6 into "أخرى" so the doughnut stays
  // legible. The list below the chart still shows everything.
  const TOP = 6;
  const top = rows.slice(0, TOP);
  const rest = rows.slice(TOP);
  const restTotal = rest.reduce((s, r) => s + r.total, 0);
  const chartLabels = [
    ...top.map((r) => r.label),
    ...(rest.length > 0 ? [`أخرى (${rest.length})`] : []),
  ];
  const chartData = [
    ...top.map((r) => r.total),
    ...(rest.length > 0 ? [restTotal] : []),
  ];

  // Cycled palette — keeps cards visually distinct without pulling in
  // a colour library.
  const palette = [
    '#6366f1', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
    '#06b6d4', '#94a3b8',
  ];

  return (
    <div className="card p-4">
      <h4 className="text-xs font-black text-slate-700 mb-3 flex items-center gap-1.5">
        {icon} {title}
      </h4>
      {rows.length === 0 ? (
        <div className="text-center text-slate-500 text-xs py-4">لا توجد بيانات.</div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 items-center">
          <div style={{ height: 180 }}>
            <Doughnut
              data={{
                labels: chartLabels,
                datasets: [
                  {
                    data: chartData,
                    backgroundColor: chartLabels.map((_, i) => palette[i % palette.length]),
                    borderWidth: 1,
                    borderColor: '#fff',
                  },
                ],
              }}
              options={{
                responsive: true,
                maintainAspectRatio: false,
                plugins: {
                  legend: { display: false },
                  tooltip: {
                    callbacks: {
                      label: (ctx) => {
                        const v = Number(ctx.parsed) || 0;
                        const pct = total > 0 ? ((v / total) * 100).toFixed(1) : '0.0';
                        return `${ctx.label}: ${EGP(v)} (${pct}%)`;
                      },
                    },
                  },
                },
                cutout: '60%',
              }}
            />
          </div>
          <div className="space-y-1.5 max-h-[180px] overflow-y-auto pr-1">
            {rows.slice(0, 8).map((r, i) => {
              const pct = total > 0 ? (r.total / total) * 100 : 0;
              return (
                <div key={r.label + i} className="flex items-center justify-between text-[11px]">
                  <span className="flex items-center gap-1.5 truncate max-w-[55%]">
                    <span
                      className="w-2 h-2 rounded-sm shrink-0"
                      style={{ background: palette[i % palette.length] }}
                    />
                    <span className="truncate">{r.label}</span>
                  </span>
                  <span className="text-slate-700 font-bold tabular-nums">
                    {EGP(r.total)}{' '}
                    <span className="text-[9px] text-slate-400">{pct.toFixed(1)}%</span>
                  </span>
                </div>
              );
            })}
            {rows.length > 8 && (
              <div className="text-[10px] text-slate-400 text-center pt-1">
                +{rows.length - 8} عناصر أخرى
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
