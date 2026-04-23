/**
 * Daily Expenses screen (migration 060).
 *
 * Thin form that records a daily expense, tied to a responsible
 * employee. Behind the scenes the API calls
 * `POST /accounting/expenses/daily` which re-uses the SAME
 * expenses pipeline as the Cashboxes page — the journal entry is
 * built by FinancialEngineService, the cashbox ledger is moved
 * atomically, and the expense shows up automatically in the
 * employee's Financial Ledger tab.
 *
 * There is no new module, no new posting engine, and no duplicate
 * cash-movement logic — just a screen that forces an explicit
 * `employee_user_id` on every row and filters the category dropdown
 * to COA expense accounts.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import { DollarSign, Plus, Receipt, Users } from 'lucide-react';
import { accountingApi, Expense } from '@/api/accounting.api';
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
  const qc = useQueryClient();
  const authUser = useAuthStore((s) => s.user);
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canPickOthers =
    hasPermission('employee.team.view') ||
    hasPermission('accounts.journal.post') ||
    hasPermission('*');

  const today = new Date().toISOString().slice(0, 10);

  // Form state
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

  // Data sources
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

  // Auto-pick the currently open shift's cashbox when the user opens
  // the form — cash-paid expenses are always easier to book against
  // whichever box the cashier is sitting on.
  const { data: currentShift } = useQuery({
    queryKey: ['shift-current-dex'],
    queryFn: () => shiftsApi.current(),
    staleTime: 60_000,
  });
  useMemo(() => {
    if (!cashboxId && currentShift?.cashbox_id) {
      setCashboxId(String(currentShift.cashbox_id));
    }
  }, [currentShift, cashboxId]);

  // Today's daily expenses — a simple feed at the bottom so the user
  // sees their recent bookings immediately after saving.
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
      // Reset the form but keep category + employee for fast repeat entries
      setAmount('');
      setDescription('');
      setReceiptUrl('');
      setVendorName('');
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تسجيل المصروف'),
  });

  const submit = () => {
    if (!categoryId) return toast.error('اختر نوع المصروف');
    if (!amount || Number(amount) <= 0) return toast.error('أدخل مبلغ صحيح');
    if (!employeeId) return toast.error('اختر الموظف المسؤول');
    if (paymentMethod === 'cash' && !cashboxId && !currentShift?.cashbox_id)
      return toast.error('اختر الخزنة أو افتح وردية أولًا');
    create.mutate();
  };

  return (
    <div className="space-y-5">
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

      {/* ─── Form ─── */}
      <div className="card p-5 space-y-4">
        <h3 className="font-black text-slate-800 flex items-center gap-2">
          <Plus size={16} /> تسجيل مصروف جديد
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          {/* Category */}
          <FieldLabel label="نوع المصروف (حساب)">
            <select
              className="input w-full"
              value={categoryId}
              onChange={(e) => setCategoryId(e.target.value)}
              disabled={create.isPending}
            >
              <option value="">اختر…</option>
              {categories
                .filter((c: any) => c.is_active !== false)
                .map((c: any) => (
                  <option key={c.id} value={c.id}>
                    {c.name_ar} ({c.code})
                  </option>
                ))}
            </select>
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

          {/* Cashbox (only for cash) */}
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

          {/* Date */}
          <FieldLabel label="التاريخ">
            <input
              type="date"
              className="input w-full"
              value={expenseDate}
              onChange={(e) => setExpenseDate(e.target.value)}
              disabled={create.isPending}
            />
          </FieldLabel>

          {/* Employee */}
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

          {/* Vendor */}
          <FieldLabel label="المورد / الجهة (اختياري)">
            <input
              className="input w-full"
              value={vendorName}
              onChange={(e) => setVendorName(e.target.value)}
              disabled={create.isPending}
            />
          </FieldLabel>

          {/* Description */}
          <FieldLabel label="الوصف">
            <input
              className="input w-full"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              disabled={create.isPending}
            />
          </FieldLabel>

          {/* Receipt */}
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

        <div className="flex justify-end gap-2 pt-2">
          <button
            className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-700 text-white font-bold text-sm disabled:opacity-60"
            onClick={submit}
            disabled={create.isPending}
          >
            <DollarSign size={14} className="inline -mt-0.5 me-1" />
            {create.isPending ? 'جارٍ الترحيل…' : 'تسجيل + ترحيل القيد'}
          </button>
        </div>
      </div>

      {/* ─── Today's expenses feed ─── */}
      <div className="card p-5">
        <h3 className="font-black text-slate-800 mb-3">مصروفات اليوم</h3>
        {!listing || listing.items.length === 0 ? (
          <div className="text-center text-slate-500 text-xs py-6">
            لم تُسجّل أي مصروفات اليوم بعد.
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
