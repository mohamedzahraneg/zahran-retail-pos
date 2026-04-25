/**
 * Daily Expenses screen (migration 060 — Daily Expenses series PR-1).
 *
 * Records a daily expense, tied to a responsible employee. Behind the
 * scenes the API calls `POST /accounting/expenses/daily` which re-uses
 * the SAME expenses pipeline as the Cashboxes page — the journal entry
 * is built by FinancialEngineService, the cashbox ledger is moved
 * atomically, and the expense shows up automatically in the
 * employee's Financial Ledger tab.
 *
 * PR-1 changes:
 *   * Inline form converted to a centred modal (mobile-friendly +
 *     proper save/cancel UX).
 *   * Selected category renders an account preview ("سيتم ترحيل
 *     القيد: DR <code> <name> / CR <cashbox>") so admin sees exactly
 *     where the expense will land.
 *   * Submit blocks (frontend) when the chosen category has no
 *     `account_id`; backend (`createDailyExpense` strict mode) also
 *     rejects with a 400 if a request slips through, so silent
 *     fallback to 529 is impossible end-to-end.
 *   * "بند جديد" button opens a small inline modal that creates a
 *     category with a required COA leaf mapping; categories without
 *     a mapping won't reach the picker.
 *
 * No new module, no new posting engine, no duplicate cash-movement
 * logic — just a tighter UX layer over the same canonical pipeline.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  DollarSign,
  ListPlus,
  Plus,
  Receipt,
  Users,
  X,
} from 'lucide-react';
import { accountingApi, ExpenseCategory, Expense } from '@/api/accounting.api';
import { accountsApi } from '@/api/accounts.api';
import { usersApi } from '@/api/users.api';
import { cashDeskApi } from '@/api/cash-desk.api';
import { shiftsApi } from '@/api/shifts.api';
import { useAuthStore } from '@/stores/auth.store';

const DEFAULT_WAREHOUSE_ID = import.meta.env.VITE_DEFAULT_WAREHOUSE_ID as string;

const EGP = (n: number | string) =>
  `${Number(n).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

export default function DailyExpenses() {
  const today = new Date().toISOString().slice(0, 10);
  const [showAddExpense, setShowAddExpense] = useState(false);
  const [showAddCategory, setShowAddCategory] = useState(false);

  // Today's daily expenses — a simple feed at the bottom so the user
  // sees their recent bookings immediately after saving. PR-3 will
  // add date-range filters; for now we keep the today-only list to
  // limit PR-1 surface area.
  const { data: listing } = useQuery({
    queryKey: ['daily-expenses-list', today],
    queryFn: () =>
      accountingApi.listExpenses({
        from: today,
        to: today,
        limit: 50,
      }),
    refetchInterval: 20_000,
  });

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
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
        <div className="flex items-center gap-2">
          <button
            className="btn-ghost text-xs flex items-center gap-1.5"
            onClick={() => setShowAddCategory(true)}
            title="أضف بند مصروف جديد مرتبط بحساب محاسبي"
          >
            <ListPlus size={14} /> بند جديد
          </button>
          <button
            className="btn-primary text-xs flex items-center gap-1.5"
            onClick={() => setShowAddExpense(true)}
          >
            <Plus size={14} /> تسجيل مصروف
          </button>
        </div>
      </div>

      {/* ─── Today's expenses feed ─── */}
      <div className="card p-5">
        <h3 className="font-black text-slate-800 mb-3">مصروفات اليوم</h3>
        {!listing || listing.items.length === 0 ? (
          <div className="text-center text-slate-500 text-xs py-6">
            لم تُسجّل أي مصروفات اليوم بعد. اضغط «تسجيل مصروف» لإضافة أول
            مصروف.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-slate-50 text-slate-600 text-[11px]">
                  <th className="p-2 text-right">الوقت</th>
                  <th className="p-2 text-right">النوع</th>
                  <th className="p-2 text-right">الوصف</th>
                  <th className="p-2 text-center">الدفع</th>
                  <th className="p-2 text-center">المبلغ</th>
                </tr>
              </thead>
              <tbody>
                {listing.items.map((e: Expense) => (
                  <tr key={e.id} className="border-t border-slate-100">
                    <td className="p-2 font-mono tabular-nums">
                      {new Date(e.created_at).toLocaleTimeString('en-GB', {
                        timeZone: 'Africa/Cairo',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="p-2">{e.category_name || '—'}</td>
                    <td className="p-2 text-slate-700">{e.description || '—'}</td>
                    <td className="p-2 text-center text-slate-600">
                      {e.payment_method}
                    </td>
                    <td className="p-2 text-center font-bold tabular-nums text-rose-700">
                      {EGP(e.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-slate-200 bg-slate-50 font-black">
                  <td colSpan={4} className="p-2 text-right">
                    إجمالي اليوم
                  </td>
                  <td className="p-2 text-center tabular-nums text-rose-700">
                    {EGP(listing.total_amount || 0)}
                  </td>
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

/* ─── Add expense modal ─── */

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
  const [receiptUrl, setReceiptUrl] = useState('');
  const [expenseDate, setExpenseDate] = useState<string>(today);
  const [vendorName, setVendorName] = useState('');

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
  // cashbox dropdown renders. Resets on form remount (i.e. modal
  // close/reopen).
  useEffect(() => {
    if (!cashboxId && currentShift?.cashbox_id) {
      setCashboxId(String(currentShift.cashbox_id));
    }
  }, [currentShift, cashboxId]);

  const selectedCategory = useMemo<ExpenseCategory | null>(
    () =>
      (categories as ExpenseCategory[]).find((c) => c.id === categoryId) ??
      null,
    [categories, categoryId],
  );
  const selectedCashbox = useMemo<any>(
    () => (cashboxes as any[]).find((c) => c.id === cashboxId) ?? null,
    [cashboxes, cashboxId],
  );

  // Block submit when the category has no account mapping (mirror of
  // the backend strict-mode reject; gives a friendlier UX than waiting
  // for the 400).
  const categoryUnmapped =
    !!selectedCategory && !selectedCategory.account_id;

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
        receipt_url: receiptUrl || undefined,
        vendor_name: vendorName || undefined,
        employee_user_id: employeeId,
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
      return toast.error(
        'هذا البند غير مربوط بحساب محاسبي. اختر الحساب أولًا.',
      );
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
        className="modal-panel w-full max-w-2xl space-y-4"
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

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          {/* Category — with inline "add" button */}
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

          {/* Amount */}
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

          {/* Payment method */}
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

          <FieldLabel label="المورد / الجهة (اختياري)">
            <input
              className="input w-full"
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              disabled={create.isPending}
            />
          </FieldLabel>

          <FieldLabel label="الوصف">
            <input
              className="input w-full"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={create.isPending}
            />
          </FieldLabel>

          <FieldLabel label="رابط المرفق (اختياري)">
            <input
              className="input w-full"
              placeholder="https://..."
              value={receiptUrl}
              onChange={(e) => setReceiptUrl(e.target.value)}
              disabled={create.isPending}
            />
          </FieldLabel>
        </div>

        {/* Account preview — shows DR/CR before save so admin sees
            exactly where the expense lands. Refuses to render the
            "ready to post" preview when the category is unmapped. */}
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
                  <div className="text-[10px] mt-0.5 opacity-80">
                    افتح «بند جديد» لتعديل التصنيف وربطه بحساب من شجرة
                    الحسابات، أو استخدم بنداً مربوطاً بالفعل.
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

/* ─── Add category modal ─── */

function AddCategoryModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [accountId, setAccountId] = useState('');
  const [isFixed, setIsFixed] = useState(false);
  const [allocateToCogs, setAllocateToCogs] = useState(false);

  // Pull the COA so admin can pick a leaf account. Filter to
  // expense-side leaves (account_type='expense' OR for advances:
  // 1123 etc — but we keep it broad and let the user pick).
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

  // Filter to leaves only — the resolver requires a leaf for posting.
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
