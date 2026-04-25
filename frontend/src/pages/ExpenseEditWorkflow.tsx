/**
 * Edit-request workflow UI for the Daily Expenses register (PR-11).
 *
 * Three modals + one inbox badge, all theme-aware (light + dark) so
 * they render correctly whether the user is on the register tab
 * (light) or has flipped to dark via the analytics tab toggle.
 *
 * Components:
 *   · EditExpenseModal           — file an edit request
 *   · EditRequestApproveModal    — approve / reject one request
 *   · EditHistoryModal           — full audit history per expense
 *   · EditRequestsInboxBadge     — pending count chip + opens inbox
 *   · EditRequestsInboxModal     — list of pending requests
 *
 * Everything routes through `accountingApi.*EditRequest` — the
 * backend is the source of truth for both the void+repost accounting
 * correction and the audit log. No fake state on the client.
 */

import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Inbox,
  Pencil,
  History as HistoryIcon,
  X,
  XCircle,
} from 'lucide-react';
import {
  accountingApi,
  Expense,
  ExpenseCategory,
  ExpenseEditRequest,
  ExpenseEditableValues,
} from '@/api/accounting.api';
import { cashDeskApi } from '@/api/cash-desk.api';
import { usersApi } from '@/api/users.api';
import { useAuthStore } from '@/stores/auth.store';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const fmtDateOnly = (input: string | Date | null | undefined) => {
  if (!input) return '—';
  if (typeof input === 'string' && /^\d{4}-\d{2}-\d{2}/.test(input)) {
    const ymd = input.slice(0, 10);
    const [y, m, d] = ymd.split('-');
    return `${d}/${m}/${y}`;
  }
  const d = input instanceof Date ? input : new Date(input);
  if (isNaN(d.getTime())) return '—';
  const ymd = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(d)
    .split('-');
  return `${ymd[2]}/${ymd[1]}/${ymd[0]}`;
};

const fmtDateTime = (iso: string | null | undefined) => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return `${fmtDateOnly(iso)} ${d.toLocaleTimeString('en-GB', {
    timeZone: 'Africa/Cairo',
    hour: '2-digit',
    minute: '2-digit',
  })}`;
};

const STATUS_LABEL: Record<ExpenseEditRequest['status'], string> = {
  pending: 'قيد الانتظار',
  approved: 'تمت الموافقة',
  rejected: 'مرفوض',
  cancelled: 'ملغى',
};

const STATUS_TONE: Record<ExpenseEditRequest['status'], string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/15 dark:text-emerald-300 dark:border-emerald-500/30',
  rejected: 'bg-rose-50 text-rose-700 border-rose-200 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30',
  cancelled: 'bg-slate-100 text-slate-600 border-slate-200 dark:bg-slate-800/60 dark:text-slate-400 dark:border-slate-700/40',
};

/* ─── Modal scaffolding (matches PR-5 .modal-backdrop / .modal-panel) ── */

function ModalShell({
  title,
  icon,
  onClose,
  children,
  size = 'lg',
}: {
  title: string;
  icon?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const widths = {
    sm: 'max-w-md',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    xl: 'max-w-4xl',
  } as const;
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal-panel w-full ${widths[size]} space-y-3`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between sticky top-0 bg-white dark:bg-slate-900 z-10 -mx-1 px-1 pb-2 border-b border-slate-100 dark:border-slate-700/40">
          <h3 className="text-base font-bold flex items-center gap-2 text-slate-800 dark:text-white">
            {icon} {title}
          </h3>
          <button onClick={onClose} className="icon-btn dark:text-slate-300">
            <X className="w-5 h-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

/* ─── Field render helper ─── */

function ValueRow({
  label,
  oldValue,
  newValue,
  changed,
}: {
  label: string;
  oldValue: React.ReactNode;
  newValue?: React.ReactNode;
  changed?: boolean;
}) {
  return (
    <div className={`grid grid-cols-3 gap-2 py-1.5 text-xs items-center ${changed ? 'font-bold' : ''}`}>
      <span className="text-slate-500 dark:text-slate-400">{label}</span>
      <span className={changed ? 'text-rose-600 dark:text-rose-400 line-through' : 'text-slate-700 dark:text-slate-300'}>
        {oldValue ?? '—'}
      </span>
      <span className={changed ? 'text-emerald-600 dark:text-emerald-400' : 'text-slate-700 dark:text-slate-300'}>
        {newValue ?? oldValue ?? '—'}
      </span>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * 1. EditExpenseModal — file a new edit request
 * ──────────────────────────────────────────────────────────────────── */

export function EditExpenseModal({
  expense,
  onClose,
}: {
  expense: Expense;
  onClose: () => void;
}) {
  const qc = useQueryClient();

  // Local form state — initialised from the current expense values.
  const [categoryId, setCategoryId] = useState(expense.category_id || '');
  const [amount, setAmount] = useState(String(expense.amount ?? ''));
  const [cashboxId, setCashboxId] = useState(expense.cashbox_id ?? '');
  const [expenseDate, setExpenseDate] = useState(
    typeof expense.expense_date === 'string'
      ? expense.expense_date.slice(0, 10)
      : new Date(expense.expense_date).toISOString().slice(0, 10),
  );
  const [employeeId, setEmployeeId] = useState(expense.employee_user_id ?? '');
  const [paymentMethod, setPaymentMethod] = useState<
    'cash' | 'card' | 'transfer' | 'wallet' | 'mixed'
  >(expense.payment_method);
  const [description, setDescription] = useState(expense.description ?? '');
  const [reason, setReason] = useState('');

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

  // Compute the diff payload — only fields that actually changed.
  const diff: Partial<ExpenseEditableValues> = useMemo(() => {
    const out: Partial<ExpenseEditableValues> = {};
    if (categoryId !== (expense.category_id || '')) {
      out.category_id = categoryId || undefined as any;
    }
    if (Number(amount) !== Number(expense.amount)) {
      out.amount = Number(amount);
    }
    if ((cashboxId || null) !== (expense.cashbox_id ?? null)) {
      out.cashbox_id = (cashboxId || null) as any;
    }
    const expenseDateNorm =
      typeof expense.expense_date === 'string'
        ? expense.expense_date.slice(0, 10)
        : new Date(expense.expense_date).toISOString().slice(0, 10);
    if (expenseDate !== expenseDateNorm) {
      out.expense_date = expenseDate;
    }
    if ((employeeId || null) !== (expense.employee_user_id ?? null)) {
      out.employee_user_id = (employeeId || null) as any;
    }
    if (paymentMethod !== expense.payment_method) {
      out.payment_method = paymentMethod;
    }
    if ((description || '') !== (expense.description ?? '')) {
      out.description = description;
    }
    return out;
  }, [
    categoryId, amount, cashboxId, expenseDate,
    employeeId, paymentMethod, description, expense,
  ]);

  const accountingFields = ['category_id', 'amount', 'cashbox_id', 'expense_date', 'payment_method'] as const;
  const accountingChanged = accountingFields.some((k) => k in diff);
  const hasChanges = Object.keys(diff).length > 0;

  const submit = useMutation({
    mutationFn: () =>
      accountingApi.requestExpenseEdit(expense.id, {
        reason: reason.trim(),
        new_values: diff,
      }),
    onSuccess: () => {
      toast.success('تم تقديم طلب التعديل — في انتظار الموافقة');
      qc.invalidateQueries({ queryKey: ['daily-expenses-list'] });
      qc.invalidateQueries({ queryKey: ['expense-edit-history', expense.id] });
      qc.invalidateQueries({ queryKey: ['expense-edit-inbox'] });
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تقديم الطلب'),
  });

  const onSubmit = () => {
    if (!hasChanges) return toast.error('لا توجد تغييرات لتقديمها');
    if (reason.trim().length < 5) {
      return toast.error('سبب التعديل مطلوب (5 أحرف على الأقل)');
    }
    submit.mutate();
  };

  const selectedCategory = (categories as ExpenseCategory[]).find((c) => c.id === categoryId);
  const selectedCashbox = (cashboxes as any[]).find((c) => c.id === cashboxId);
  const selectedEmployee = (users as any[]).find((u) => u.id === employeeId);

  return (
    <ModalShell
      title={`تعديل مصروف — ${expense.expense_no}`}
      icon={<Pencil size={18} className="text-amber-600 dark:text-amber-400" />}
      onClose={onClose}
      size="lg"
    >
      {accountingChanged && (
        <div className="px-3 py-2.5 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:border-amber-500/30 dark:text-amber-300 text-xs flex items-start gap-2">
          <AlertTriangle size={14} className="shrink-0 mt-0.5" />
          <span>
            هذا التعديل يؤثر على القيد المحاسبي. عند الموافقة سيتم عكس القيد
            القديم وترحيل قيد جديد بالقيم المُصحَّحة (ميزان المراجعة لن يتأثر).
          </span>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
        <label className="block">
          <span className="block mb-1 font-bold text-slate-600 dark:text-slate-300">البند</span>
          <select
            className="input input-sm w-full"
            value={categoryId}
            onChange={(e) => setCategoryId(e.target.value)}
          >
            {(categories as ExpenseCategory[]).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name_ar}
                {c.account_code ? ` (${c.account_code})` : ''}
              </option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block mb-1 font-bold text-slate-600 dark:text-slate-300">المبلغ (ج.م)</span>
          <input
            type="number"
            min="0.01"
            step="0.01"
            className="input input-sm w-full font-mono tabular-nums"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </label>

        <label className="block">
          <span className="block mb-1 font-bold text-slate-600 dark:text-slate-300">التاريخ</span>
          <input
            type="date"
            className="input input-sm w-full"
            value={expenseDate}
            onChange={(e) => setExpenseDate(e.target.value)}
          />
        </label>

        <label className="block">
          <span className="block mb-1 font-bold text-slate-600 dark:text-slate-300">طريقة الدفع</span>
          <select
            className="input input-sm w-full"
            value={paymentMethod}
            onChange={(e) => setPaymentMethod(e.target.value as any)}
          >
            <option value="cash">نقدي</option>
            <option value="card">بطاقة</option>
            <option value="transfer">تحويل</option>
            <option value="wallet">محفظة</option>
            <option value="mixed">مختلط</option>
          </select>
        </label>

        <label className="block">
          <span className="block mb-1 font-bold text-slate-600 dark:text-slate-300">الخزنة</span>
          <select
            className="input input-sm w-full"
            value={cashboxId}
            onChange={(e) => setCashboxId(e.target.value)}
            disabled={paymentMethod !== 'cash'}
          >
            <option value="">— بدون —</option>
            {(cashboxes as any[]).map((cb) => (
              <option key={cb.id} value={cb.id}>{cb.name_ar}</option>
            ))}
          </select>
        </label>

        <label className="block">
          <span className="block mb-1 font-bold text-slate-600 dark:text-slate-300">الموظف المسؤول</span>
          <select
            className="input input-sm w-full"
            value={employeeId}
            onChange={(e) => setEmployeeId(e.target.value)}
          >
            <option value="">— غير محدد —</option>
            {(users as any[]).map((u) => (
              <option key={u.id} value={u.id}>{u.full_name || u.username}</option>
            ))}
          </select>
        </label>

        <label className="block md:col-span-2">
          <span className="block mb-1 font-bold text-slate-600 dark:text-slate-300">الوصف</span>
          <textarea
            rows={2}
            className="input input-sm w-full"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </label>
      </div>

      {/* Before / after preview */}
      {hasChanges && (
        <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 dark:bg-slate-950/40 dark:border-slate-700/40 p-3 space-y-1">
          <div className="grid grid-cols-3 gap-2 text-[10px] font-extrabold text-slate-500 dark:text-slate-400 pb-2 border-b border-slate-200 dark:border-slate-700/40">
            <span>الحقل</span>
            <span>القيمة الحالية</span>
            <span>القيمة الجديدة</span>
          </div>
          {'category_id' in diff && (
            <ValueRow label="البند" changed
              oldValue={expense.category_name || '—'}
              newValue={selectedCategory?.name_ar || categoryId} />
          )}
          {'amount' in diff && (
            <ValueRow label="المبلغ" changed
              oldValue={EGP(expense.amount)}
              newValue={EGP(amount)} />
          )}
          {'expense_date' in diff && (
            <ValueRow label="التاريخ" changed
              oldValue={fmtDateOnly(expense.expense_date)}
              newValue={fmtDateOnly(expenseDate)} />
          )}
          {'cashbox_id' in diff && (
            <ValueRow label="الخزنة" changed
              oldValue={expense.cashbox_name || '— بدون —'}
              newValue={selectedCashbox?.name_ar || '— بدون —'} />
          )}
          {'employee_user_id' in diff && (
            <ValueRow label="الموظف المسؤول" changed
              oldValue={expense.employee_name || expense.employee_username || '— غير محدد —'}
              newValue={selectedEmployee?.full_name || selectedEmployee?.username || '— غير محدد —'} />
          )}
          {'payment_method' in diff && (
            <ValueRow label="طريقة الدفع" changed
              oldValue={expense.payment_method}
              newValue={paymentMethod} />
          )}
          {'description' in diff && (
            <ValueRow label="الوصف" changed
              oldValue={expense.description || '—'}
              newValue={description || '—'} />
          )}
        </div>
      )}

      <label className="block mt-3">
        <span className="block mb-1 text-xs font-bold text-rose-600 dark:text-rose-400">
          سبب التعديل (مطلوب)
        </span>
        <textarea
          rows={2}
          className="input input-sm w-full"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="مثال: المبلغ تم إدخاله بشكل خاطئ بعد مراجعة الفاتورة"
        />
      </label>

      <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-700/40">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800/60 dark:text-slate-200 dark:hover:bg-slate-700/60"
          disabled={submit.isPending}
        >
          إلغاء
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={submit.isPending || !hasChanges || reason.trim().length < 5}
          className="px-4 py-1.5 rounded-lg text-xs font-bold bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {submit.isPending ? 'جارٍ الإرسال…' : 'تقديم طلب التعديل'}
        </button>
      </div>
    </ModalShell>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * 2. EditRequestApproveModal — approve or reject a pending request
 * ──────────────────────────────────────────────────────────────────── */

export function EditRequestApproveModal({
  request,
  expense,
  onClose,
}: {
  request: ExpenseEditRequest;
  /** Optional — if not passed, modal still shows old/new from request snapshot. */
  expense?: Expense;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [rejectReason, setRejectReason] = useState('');
  const [showReject, setShowReject] = useState(false);

  const approve = useMutation({
    mutationFn: () => accountingApi.approveEditRequest(request.id),
    onSuccess: (res) => {
      toast.success(
        res.accounting_corrected
          ? 'تمت الموافقة وترحيل التصحيح المحاسبي'
          : 'تمت الموافقة على التعديل',
      );
      invalidateAll(qc, request.expense_id);
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشلت الموافقة'),
  });

  const reject = useMutation({
    mutationFn: () =>
      accountingApi.rejectEditRequest(request.id, rejectReason.trim()),
    onSuccess: () => {
      toast.success('تم رفض الطلب');
      invalidateAll(qc, request.expense_id);
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الرفض'),
  });

  const oldV = request.old_values || {};
  const newV = request.new_values || {};
  const fields: Array<[keyof ExpenseEditableValues, string, (v: any) => string]> = [
    ['category_id', 'البند', (v) => String(v ?? '—')],
    ['amount', 'المبلغ', (v) => (v != null ? EGP(v) : '—')],
    ['expense_date', 'التاريخ', (v) => fmtDateOnly(v)],
    ['cashbox_id', 'الخزنة', (v) => String(v ?? '—')],
    ['employee_user_id', 'الموظف المسؤول', (v) => String(v ?? '—')],
    ['payment_method', 'طريقة الدفع', (v) => String(v ?? '—')],
    ['description', 'الوصف', (v) => String(v ?? '—')],
  ];

  return (
    <ModalShell
      title={`مراجعة طلب تعديل ${expense?.expense_no ? `— ${expense.expense_no}` : ''}`}
      icon={<CheckCircle2 size={18} className="text-emerald-600 dark:text-emerald-400" />}
      onClose={onClose}
      size="lg"
    >
      <div className="grid grid-cols-2 gap-3 text-xs">
        <InfoChip label="مقدّم الطلب" value={request.requested_by_name || '—'} />
        <InfoChip label="تاريخ الطلب" value={fmtDateTime(request.requested_at)} />
      </div>

      <div className="rounded-xl border border-amber-200 bg-amber-50 dark:bg-amber-500/10 dark:border-amber-500/30 p-3 text-xs">
        <div className="text-[10px] font-extrabold text-amber-700 dark:text-amber-300 mb-1">سبب التعديل</div>
        <div className="text-slate-700 dark:text-slate-200">{request.reason}</div>
      </div>

      <div className="rounded-xl border border-slate-200 dark:border-slate-700/40 bg-white dark:bg-slate-950/40 p-3">
        <div className="grid grid-cols-3 gap-2 text-[10px] font-extrabold text-slate-500 dark:text-slate-400 pb-2 border-b border-slate-200 dark:border-slate-700/40">
          <span>الحقل</span>
          <span>القيمة القديمة</span>
          <span>القيمة الجديدة</span>
        </div>
        {fields
          .filter(([k]) => k in newV)
          .map(([k, label, fmt]) => (
            <ValueRow key={k} label={label} changed
              oldValue={fmt((oldV as any)[k])}
              newValue={fmt((newV as any)[k])} />
          ))}
      </div>

      {showReject && (
        <label className="block mt-2">
          <span className="block mb-1 text-xs font-bold text-rose-600 dark:text-rose-400">
            سبب الرفض (مطلوب)
          </span>
          <textarea
            rows={2}
            className="input input-sm w-full"
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
          />
        </label>
      )}

      <div className="flex items-center justify-end gap-2 pt-3 border-t border-slate-100 dark:border-slate-700/40">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800/60 dark:text-slate-200 dark:hover:bg-slate-700/60"
          disabled={approve.isPending || reject.isPending}
        >
          إغلاق
        </button>
        {!showReject ? (
          <>
            <button
              type="button"
              onClick={() => setShowReject(true)}
              className="px-3 py-1.5 rounded-lg text-xs font-bold bg-rose-50 text-rose-700 border border-rose-200 hover:bg-rose-100 dark:bg-rose-500/15 dark:text-rose-300 dark:border-rose-500/30 dark:hover:bg-rose-500/25"
              disabled={approve.isPending}
            >
              <XCircle size={12} className="inline ml-1" /> رفض
            </button>
            <button
              type="button"
              onClick={() => approve.mutate()}
              disabled={approve.isPending}
              className="px-4 py-1.5 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {approve.isPending ? 'جارٍ الترحيل…' : 'موافقة وترحيل'}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={() => reject.mutate()}
            disabled={reject.isPending || rejectReason.trim().length < 3}
            className="px-4 py-1.5 rounded-lg text-xs font-bold bg-rose-600 text-white hover:bg-rose-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {reject.isPending ? 'جارٍ الرفض…' : 'تأكيد الرفض'}
          </button>
        )}
      </div>
    </ModalShell>
  );
}

function InfoChip({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 dark:border-slate-700/40 bg-slate-50 dark:bg-slate-950/40 px-3 py-2">
      <div className="text-[10px] text-slate-500 dark:text-slate-400 font-bold mb-0.5">{label}</div>
      <div className="text-xs text-slate-800 dark:text-slate-200 font-bold">{value}</div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * 3. EditHistoryModal — full audit history for one expense
 * ──────────────────────────────────────────────────────────────────── */

export function EditHistoryModal({
  expense,
  onClose,
}: {
  expense: Expense;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const authUser = useAuthStore((s) => s.user);
  const { data: history = [], isFetching } = useQuery({
    queryKey: ['expense-edit-history', expense.id],
    queryFn: () => accountingApi.listEditRequestsForExpense(expense.id),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => accountingApi.cancelEditRequest(id),
    onSuccess: () => {
      toast.success('تم إلغاء الطلب');
      invalidateAll(qc, expense.id);
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل الإلغاء'),
  });

  return (
    <ModalShell
      title={`سجل التعديلات — ${expense.expense_no}`}
      icon={<HistoryIcon size={18} className="text-indigo-600 dark:text-indigo-400" />}
      onClose={onClose}
      size="xl"
    >
      {isFetching ? (
        <div className="text-center text-xs text-slate-500 dark:text-slate-400 py-8">
          جارٍ التحميل…
        </div>
      ) : history.length === 0 ? (
        <div className="text-center text-xs text-slate-500 dark:text-slate-400 py-8">
          لا يوجد طلبات تعديل لهذا المصروف.
        </div>
      ) : (
        <div className="space-y-3">
          {history.map((r) => (
            <div
              key={r.id}
              className="rounded-xl border border-slate-200 dark:border-slate-700/40 bg-white dark:bg-slate-950/40 p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 text-xs">
                  <span className={`chip text-[10px] ${STATUS_TONE[r.status]}`}>
                    {STATUS_LABEL[r.status]}
                  </span>
                  <span className="text-slate-600 dark:text-slate-300 font-bold">
                    {r.requested_by_name || '—'}
                  </span>
                  <span className="text-slate-400 dark:text-slate-500">·</span>
                  <span className="text-slate-500 dark:text-slate-400 font-mono tabular-nums text-[11px]">
                    {fmtDateTime(r.requested_at)}
                  </span>
                </div>
                {r.status === 'pending' && authUser?.id === r.requested_by && (
                  <button
                    type="button"
                    onClick={() => cancel.mutate(r.id)}
                    disabled={cancel.isPending}
                    className="px-2 py-1 rounded-md text-[10px] font-bold bg-slate-100 text-slate-600 hover:bg-slate-200 dark:bg-slate-800/60 dark:text-slate-300 dark:hover:bg-slate-700/60"
                  >
                    إلغاء طلبي
                  </button>
                )}
              </div>

              <div className="text-[11px] text-slate-700 dark:text-slate-300 bg-slate-50 dark:bg-slate-900/40 px-2 py-1.5 rounded">
                <span className="font-extrabold text-slate-500 dark:text-slate-400">السبب: </span>
                {r.reason}
              </div>

              <div className="rounded border border-slate-200 dark:border-slate-700/40 px-2 py-1.5">
                <div className="grid grid-cols-3 gap-1 text-[10px] font-extrabold text-slate-500 dark:text-slate-400 mb-1 pb-1 border-b border-slate-100 dark:border-slate-700/40">
                  <span>الحقل</span>
                  <span>قبل</span>
                  <span>بعد</span>
                </div>
                {Object.keys(r.new_values || {}).map((k) => (
                  <div key={k} className="grid grid-cols-3 gap-1 text-[10.5px] py-0.5">
                    <span className="text-slate-600 dark:text-slate-400">{k}</span>
                    <span className="text-rose-600 dark:text-rose-400 line-through truncate">
                      {String((r.old_values as any)?.[k] ?? '—')}
                    </span>
                    <span className="text-emerald-600 dark:text-emerald-400 truncate">
                      {String((r.new_values as any)?.[k] ?? '—')}
                    </span>
                  </div>
                ))}
              </div>

              {(r.status === 'approved' || r.status === 'rejected' || r.status === 'cancelled') && (
                <div className="text-[11px] text-slate-600 dark:text-slate-400 flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span>
                    <span className="font-extrabold">القرار: </span>
                    {r.decided_by_name || '—'}
                  </span>
                  <span className="font-mono tabular-nums">{fmtDateTime(r.decided_at)}</span>
                  {r.rejection_reason && (
                    <span className="text-rose-600 dark:text-rose-400">
                      <span className="font-extrabold">السبب: </span>
                      {r.rejection_reason}
                    </span>
                  )}
                  {r.voided_je_no && (
                    <span className="font-mono">
                      <span className="font-extrabold">JE الملغى: </span>
                      {r.voided_je_no}
                    </span>
                  )}
                  {r.applied_je_no && (
                    <span className="font-mono">
                      <span className="font-extrabold">JE الجديد: </span>
                      {r.applied_je_no}
                    </span>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center justify-end pt-3 border-t border-slate-100 dark:border-slate-700/40">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg text-xs font-bold bg-slate-100 text-slate-700 hover:bg-slate-200 dark:bg-slate-800/60 dark:text-slate-200 dark:hover:bg-slate-700/60"
        >
          إغلاق
        </button>
      </div>
    </ModalShell>
  );
}

/* ────────────────────────────────────────────────────────────────────
 * 4. EditRequestsInboxBadge + EditRequestsInboxModal
 *    — quick access to the pending list for users who can approve
 * ──────────────────────────────────────────────────────────────────── */

export function EditRequestsInboxBadge({ onClick }: { onClick: () => void }) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canApprove = hasPermission('expenses.daily.edit.approve');
  const { data: inbox = [] } = useQuery({
    queryKey: ['expense-edit-inbox'],
    queryFn: () => accountingApi.editRequestsInbox(),
    enabled: canApprove,
    refetchInterval: 30_000,
  });
  if (!canApprove) return null;
  const count = inbox.length;
  return (
    <button
      type="button"
      onClick={onClick}
      className={`relative px-3 py-1.5 rounded-lg text-xs font-bold flex items-center gap-1.5 transition border ${
        count > 0
          ? 'bg-amber-50 text-amber-700 border-amber-200 hover:bg-amber-100 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30 dark:hover:bg-amber-500/25'
          : 'bg-slate-50 text-slate-500 border-slate-200 hover:bg-slate-100 dark:bg-slate-800/60 dark:text-slate-400 dark:border-slate-700/40 dark:hover:bg-slate-700/60'
      }`}
      title="طلبات تعديل بانتظار الموافقة"
    >
      <Inbox size={12} /> صندوق التعديلات
      {count > 0 && (
        <span className="inline-flex items-center justify-center min-w-[20px] h-5 px-1 rounded-full bg-rose-600 text-white text-[10px] font-extrabold tabular-nums">
          {count}
        </span>
      )}
    </button>
  );
}

export function EditRequestsInboxModal({ onClose }: { onClose: () => void }) {
  const { data: inbox = [], isFetching } = useQuery({
    queryKey: ['expense-edit-inbox'],
    queryFn: () => accountingApi.editRequestsInbox(),
    refetchInterval: 30_000,
  });
  const [active, setActive] = useState<ExpenseEditRequest | null>(null);

  return (
    <>
      <ModalShell
        title="طلبات تعديل المصروفات — قيد الانتظار"
        icon={<Inbox size={18} className="text-amber-600 dark:text-amber-400" />}
        onClose={onClose}
        size="xl"
      >
        {isFetching ? (
          <div className="text-center text-xs text-slate-500 dark:text-slate-400 py-8">
            جارٍ التحميل…
          </div>
        ) : inbox.length === 0 ? (
          <div className="text-center text-xs text-slate-500 dark:text-slate-400 py-8">
            لا توجد طلبات تعديل قيد الانتظار ✓
          </div>
        ) : (
          <div className="space-y-2">
            {inbox.map((r) => {
              const accountingFields = ['category_id', 'amount', 'cashbox_id', 'expense_date', 'payment_method'];
              const accountingChanged = Object.keys(r.new_values || {}).some(
                (k) => accountingFields.includes(k),
              );
              return (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => setActive(r)}
                  className="w-full text-right rounded-xl border border-slate-200 dark:border-slate-700/40 bg-white dark:bg-slate-950/40 p-3 hover:bg-slate-50 dark:hover:bg-slate-900/60 transition"
                >
                  <div className="flex items-center justify-between gap-2 mb-1.5">
                    <span className="font-mono text-xs font-bold text-slate-700 dark:text-slate-200">
                      {r.expense_no}
                    </span>
                    <span className="flex items-center gap-1.5 text-[10px]">
                      {accountingChanged && (
                        <span className="chip text-[10px] bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-300 dark:border-amber-500/30">
                          تأثير محاسبي
                        </span>
                      )}
                      <Clock size={11} className="text-slate-400" />
                      <span className="text-slate-500 dark:text-slate-400 tabular-nums">
                        {fmtDateTime(r.requested_at)}
                      </span>
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-600 dark:text-slate-300">
                    <span className="font-bold">{r.requested_by_name}</span>
                    <span className="mx-1.5 text-slate-400">·</span>
                    {Object.keys(r.new_values || {}).join(' / ')}
                    <span className="mx-1.5 text-slate-400">·</span>
                    <span className="text-rose-600 dark:text-rose-400">
                      {r.current_amount != null ? EGP(r.current_amount) : '—'}
                    </span>
                  </div>
                  <div className="text-[11px] text-slate-500 dark:text-slate-400 mt-1 truncate">
                    {r.reason}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </ModalShell>

      {active && (
        <EditRequestApproveModal
          request={active}
          onClose={() => setActive(null)}
        />
      )}
    </>
  );
}

/* ─── Cache invalidation helper ─── */

function invalidateAll(qc: ReturnType<typeof useQueryClient>, expenseId: string) {
  qc.invalidateQueries({ queryKey: ['daily-expenses-list'] });
  qc.invalidateQueries({ queryKey: ['expense-edit-history', expenseId] });
  qc.invalidateQueries({ queryKey: ['expense-edit-inbox'] });
  qc.invalidateQueries({ queryKey: ['daily-expenses-pnl'] });
  qc.invalidateQueries({ queryKey: ['daily-expenses-prev-list'] });
  qc.invalidateQueries({ queryKey: ['daily-expenses-prev-pnl'] });
}
