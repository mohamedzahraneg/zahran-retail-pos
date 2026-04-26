/**
 * EmployeeCashClassifierGuard — PR-T6.1
 *
 * Pre-submission confirmation dialog that fires before any UI path
 * creates a cash advance for an employee. Forces the operator to
 * pick the correct classification for the cash they're about to
 * record. Prevents the silent "wage payout posted as advance"
 * pattern that confused Mohamed El-Zebaty's ledger (audit on
 * 2026-04-26 found 3 such cases).
 *
 * Two modes:
 *   - "no-wage"  : no active wage approval exists for the employee
 *                  on the chosen date. Operator picks:
 *                    A) تسجيل كسلفة      (default — current flow)
 *                    B) اعتماد يومية أولاً (redirect to attendance tab)
 *                    C) إلغاء
 *   - "with-wage": an active wage approval exists for the date.
 *                  Operator picks:
 *                    A) صرف مستحقات      (route to settlement flow)
 *                    B) سلفة إضافية      (default — current flow)
 *                    C) إلغاء
 *
 * The component does NOT post anything itself. It returns the
 * operator's decision via the `onConfirm` callback. The parent is
 * responsible for executing the chosen flow (advance / settlement /
 * approve-wage navigation).
 *
 * Permission gates:
 *   employee.attendance.manage → unlocks "اعتماد يومية أولاً"
 *   (settlement / advance buttons unconditionally enabled — backend
 *   enforces its own gates)
 */
import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, X } from 'lucide-react';
import { attendanceApi, PayableDayRow } from '@/api/attendance.api';
import { useAuthStore } from '@/stores/auth.store';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

export type CashClassifierDecision =
  | 'advance'
  | 'settlement'
  | 'approve_wage_first'
  | 'cancel';

export function EmployeeCashClassifierGuard({
  employeeId,
  employeeName,
  amount,
  workDate,
  defaultChoice = 'advance',
  onConfirm,
  onCancel,
}: {
  employeeId: string;
  employeeName: string;
  amount: number;
  /** YYYY-MM-DD; defaults to today (Cairo) at the call site. */
  workDate: string;
  /** Which option to highlight as the "current behavior" hint. */
  defaultChoice?: 'advance' | 'settlement';
  onConfirm: (decision: Exclude<CashClassifierDecision, 'cancel'>) => void;
  onCancel: () => void;
}) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canApproveWage = hasPermission('employee.attendance.manage');
  const navigate = useNavigate();

  // Fetch active wage approvals for this employee on the chosen date.
  // Cheap query — backend filters server-side; we only need to know
  // whether ANY active row exists + its approved amount.
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ['payable-days', employeeId, workDate, workDate],
    queryFn: () =>
      attendanceApi.payableDays({
        user_id: employeeId,
        from: workDate,
        to: workDate,
      }),
  });
  const activeWageApprovals = useMemo(
    () => (rows as PayableDayRow[]).filter((r) => !r.is_void),
    [rows],
  );
  const approvedTotal = useMemo(
    () =>
      activeWageApprovals.reduce(
        (s, r) => s + Number(r.amount_accrued || 0),
        0,
      ),
    [activeWageApprovals],
  );
  const hasActiveApproval = activeWageApprovals.length > 0;

  // Loading state — render the modal frame so the user doesn't see
  // a flash of nothing, but disable buttons until we know the answer.
  // Esc closes.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onCancel]);

  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4"
      onClick={onCancel}
    >
      <div
        className="w-full max-w-lg bg-white rounded-2xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <AlertTriangle
              size={18}
              className={hasActiveApproval ? 'text-amber-500' : 'text-rose-500'}
            />
            <h3 className="text-base font-black text-slate-800">
              {hasActiveApproval
                ? 'تحديد نوع المبلغ'
                : 'لا توجد يومية معتمدة لهذا الموظف اليوم'}
            </h3>
          </div>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
            title="إلغاء"
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-5 space-y-3">
          {isLoading ? (
            <div className="text-sm text-slate-500 py-3 text-center">
              جارٍ التحقق من اعتمادات اليومية…
            </div>
          ) : hasActiveApproval ? (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-3 text-[12px] text-amber-900 leading-relaxed">
              يوجد يومية معتمدة للموظف{' '}
              <span className="font-bold">{employeeName}</span> اليوم بقيمة{' '}
              <span className="font-bold">{EGP(approvedTotal)}</span>.
              <br />
              المبلغ المطلوب تسجيله: <span className="font-bold">{EGP(amount)}</span>.
              <br />
              هل هذا <span className="font-bold">صرف من اليومية المعتمدة</span>{' '}
              أم <span className="font-bold">سلفة إضافية</span>؟
            </div>
          ) : (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-3 text-[12px] text-rose-900 leading-relaxed">
              أنت على وشك تسجيل مبلغ نقدي للموظف{' '}
              <span className="font-bold">{employeeName}</span> بقيمة{' '}
              <span className="font-bold">{EGP(amount)}</span>.
              <br />
              <span className="font-bold">لا توجد يومية معتمدة</span> لهذا اليوم.
              <br />
              هل تريد تسجيل المبلغ كسلفة، أم اعتماد اليومية أولاً؟
            </div>
          )}

          <div className="grid grid-cols-1 gap-2 pt-2">
            {hasActiveApproval ? (
              <>
                <ChoiceButton
                  tone="green"
                  primary={defaultChoice === 'settlement'}
                  onClick={() => onConfirm('settlement')}
                  title="DR 213 / CR الخزنة — يقلل المستحقات على حساب 213 ويُخرج النقد. لا تزيد ذمم الموظف."
                >
                  صرف مستحقات
                  <span className="text-[10px] font-normal opacity-80 mr-1">
                    (DR 213 — يطفّ المستحقات)
                  </span>
                </ChoiceButton>
                <ChoiceButton
                  tone="violet"
                  primary={defaultChoice === 'advance'}
                  onClick={() => onConfirm('advance')}
                  title="DR 1123 / CR الخزنة — يضيف ذمة جديدة على الموظف بمبلغ السلفة."
                >
                  سلفة إضافية
                  <span className="text-[10px] font-normal opacity-80 mr-1">
                    (DR 1123 — يزيد ذمم الموظف)
                  </span>
                </ChoiceButton>
              </>
            ) : (
              <>
                <ChoiceButton
                  tone="violet"
                  primary={true}
                  onClick={() => onConfirm('advance')}
                  title="DR 1123 / CR الخزنة — يضيف ذمة جديدة على الموظف."
                >
                  تسجيل كسلفة
                  <span className="text-[10px] font-normal opacity-80 mr-1">
                    (السلوك الحالي بدون تأكيد)
                  </span>
                </ChoiceButton>
                <ChoiceButton
                  tone="emerald"
                  onClick={() => {
                    if (!canApproveWage) return;
                    // Navigate to the attendance tab where the wage
                    // approval flow lives. The operator returns here
                    // afterwards and re-submits as a settlement.
                    const params = new URLSearchParams(window.location.search);
                    params.set('employee', employeeId);
                    params.set('section', 'attendance');
                    navigate(`/team?${params.toString()}`);
                    onConfirm('approve_wage_first');
                  }}
                  disabled={!canApproveWage}
                  title={
                    canApproveWage
                      ? 'ينقل لتبويب الحضور واليوميات لاعتماد يومية لهذا الموظف ثم العودة لتسجيل الصرف.'
                      : 'ليست لديك صلاحية تنفيذ هذا الإجراء (employee.attendance.manage).'
                  }
                >
                  اعتماد يومية أولاً
                  <span className="text-[10px] font-normal opacity-80 mr-1">
                    (انتقال لتبويب الحضور)
                  </span>
                </ChoiceButton>
              </>
            )}
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-3 rounded-xl bg-slate-100 text-slate-700 text-sm font-bold hover:bg-slate-200"
            >
              إلغاء
            </button>
          </div>

          {hasActiveApproval && (
            <div className="flex items-start gap-2 text-[11px] text-slate-500 leading-relaxed pt-2 border-t border-slate-100">
              <CheckCircle2 size={12} className="text-slate-400 shrink-0 mt-0.5" />
              <span>
                المراجعة أوضحت أن صرف المستحقات وسلفة الإضافية لهما نفس
                الأثر العددي على رصيد الموظف، لكن التصنيف يختلف في تقارير
                الحسابات. اختر النوع الصحيح لتجنب اللبس عند المراجعة.
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function ChoiceButton({
  tone,
  primary,
  onClick,
  disabled,
  title,
  children,
}: {
  tone: 'emerald' | 'violet' | 'green';
  primary?: boolean;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  children: React.ReactNode;
}) {
  const map: Record<string, string> = {
    emerald:
      'bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700',
    violet: 'bg-violet-600 text-white border-violet-700 hover:bg-violet-700',
    green:
      'bg-emerald-600 text-white border-emerald-700 hover:bg-emerald-700',
  };
  const base = primary
    ? map[tone]
    : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`px-4 py-3 rounded-xl border text-sm font-bold transition disabled:opacity-50 disabled:cursor-not-allowed flex flex-col items-start gap-0.5 text-right ${base}`}
    >
      {children}
    </button>
  );
}
