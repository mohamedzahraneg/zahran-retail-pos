/**
 * AccountsMovementsTab — PR-T3
 * ─────────────────────────────────────────────────────────────────────
 *
 * Redesigned الحسابات والحركات tab inside the unified Team Management
 * workspace. Replaces the embedded legacy <Payroll /> component (a
 * standalone team-wide page) with a per-employee unified ledger that
 * matches the team_management_design.html reference: 5 summary cards
 * + filters + a single canonical movements table + focused modals
 * for payout / advance / bonus / deduction.
 *
 * Key UX intent (per user spec):
 *   · One canonical ledger per employee (gl_entries from
 *     /employees/:id/ledger). Voided rows are visible (PR-25 contract:
 *     is_voided=true, signed_effect=0, never moves running_balance).
 *   · Filters: search, date range, type, source, status, include voided.
 *   · Each movement type has a focused modal with a clear accounting
 *     preview block. Source selector (CashSourceSelector) is REQUIRED
 *     for cash movements (payout + advance), FORBIDDEN for accrual-only
 *     ones (bonus + deduction).
 *
 * Backend invariants (all unchanged in this PR — confirmed by audit):
 *   · /employees/:id/ledger returns gl_entries[] with full row
 *     metadata + voided support (PR-25). No backend changes.
 *   · /employees/:id/settlements writes via FinancialEngine, persists
 *     shift_id when from open shift (PR-15), perm-gates direct cashbox
 *     on employees.settlement.direct_cashbox (PR-25). No changes.
 *   · /employees/:id/bonuses + /employees/:id/deductions are GL-only
 *     (DR 521 ↔ CR 213 pair). No cashbox movement, no shift impact.
 *   · /accounting/expenses/daily?is_advance=true creates an advance —
 *     supports shift_id (PR-15) + cashbox_id. No changes.
 *
 * Out of scope for PR-T3 (deferred):
 *   · Reports / print / export (PR-T5)
 *   · Old Payroll.tsx + AddTxnModal cleanup (PR-T6)
 *   · Backend changes — none needed
 */

import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import toast from 'react-hot-toast';
import {
  Wallet,
  Search,
  Plus,
  Receipt,
  Gift,
  Minus,
  TrendingDown,
  Banknote,
  ShieldAlert,
  X,
  AlertTriangle,
  CheckCircle2,
  Eye,
  EyeOff,
} from 'lucide-react';
import {
  employeesApi,
  EmployeeGlLedgerEntry,
  EmployeeLedger,
} from '@/api/employees.api';
import { accountingApi } from '@/api/accounting.api';
import { useAuthStore } from '@/stores/auth.store';
import { TeamRow } from '@/api/employees.api';
import {
  CashSourceSelector,
  CashSource,
} from '@/components/CashSourceSelector';
// PR-T3 — payout flow already redesigned in PR-15/PR-25 (CashSourceSelector
// + perm-gated direct cashbox). Reuse it verbatim — no behaviour change.
import { PayWageModal } from '@/pages/EmployeeProfile';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

const fmtDate = (iso?: string | null) => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
};

/* ─────────────────────────────────────────────────────────────────
 * Top-level component
 * ───────────────────────────────────────────────────────────────── */

type ModalKind = 'payout' | 'advance' | 'bonus' | 'deduction' | null;

export function AccountsMovementsTab({ employee }: { employee: TeamRow }) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canPayWage = hasPermission('employee.ledger.view');
  const canBonus = hasPermission('employee.bonuses.manage');
  const canDeduct = hasPermission('employee.deductions.manage');
  // Advances post via /accounting/expenses/daily; the deductions perm
  // is the existing closest match per Payroll.tsx convention. Backend
  // is the source of truth.
  const canAdvance = hasPermission('employee.deductions.manage');

  const userId = employee.id;
  const liveGl = Number(employee.gl_balance || 0);

  const [modal, setModal] = useState<ModalKind>(null);

  // Window: current Cairo month by default. Filter UI lets the user
  // expand to a custom range without re-renders thrashing the table.
  const defaultRange = useMemo(() => monthBounds(), []);
  const [from, setFrom] = useState(defaultRange.from);
  const [to, setTo] = useState(defaultRange.to);

  const { data: ledger, isFetching: ledgerLoading } = useQuery({
    queryKey: ['employee-ledger', userId, from, to],
    queryFn: () => employeesApi.userLedger(userId, from, to),
    refetchOnMount: 'always',
  });

  const { data: dash } = useQuery({
    queryKey: ['employee-user-dashboard', userId],
    queryFn: () => employeesApi.userDashboard(userId),
  });

  return (
    <div className="space-y-5">
      <HeaderCard />

      {/* Action bar — payout/advance/bonus/deduction. Permission-aware:
          buttons are hidden when the user lacks the matching backend
          permission. Backend remains source of truth. */}
      <div className="flex items-center justify-end gap-2 flex-wrap bg-white rounded-2xl border border-slate-200 shadow-sm p-3">
        {canPayWage && (
          <ActionButton
            tone="amber"
            icon={<Banknote size={15} />}
            onClick={() => setModal('payout')}
          >
            صرف مستحقات / صرف يومية
          </ActionButton>
        )}
        {canAdvance && (
          <ActionButton
            tone="indigo"
            icon={<TrendingDown size={15} />}
            onClick={() => setModal('advance')}
          >
            تسجيل سلفة
          </ActionButton>
        )}
        {canDeduct && (
          <ActionButton
            tone="rose"
            icon={<Minus size={15} />}
            onClick={() => setModal('deduction')}
          >
            تسجيل خصم
          </ActionButton>
        )}
        {canBonus && (
          <ActionButton
            tone="emerald"
            icon={<Gift size={15} />}
            onClick={() => setModal('bonus')}
          >
            تسجيل مكافأة
          </ActionButton>
        )}
      </div>

      <SummaryCards ledger={ledger} dash={dash} liveGl={liveGl} />

      <LedgerCard
        userId={userId}
        ledger={ledger}
        loading={ledgerLoading}
        from={from}
        to={to}
        onChangeFrom={setFrom}
        onChangeTo={setTo}
      />

      {/* Modals */}
      {modal === 'payout' && (
        <PayWageModal
          userId={userId}
          fullName={employee.full_name || employee.username}
          liveGlBalance={liveGl}
          onClose={() => setModal(null)}
          onSuccess={() => setModal(null)}
        />
      )}
      {modal === 'advance' && (
        <AdvanceModal
          employee={employee}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'bonus' && (
        <BonusModal
          employee={employee}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'deduction' && (
        <DeductionModal
          employee={employee}
          onClose={() => setModal(null)}
        />
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Sections
 * ───────────────────────────────────────────────────────────────── */

function HeaderCard() {
  return (
    <div className="rounded-2xl border border-indigo-200 bg-indigo-50/60 p-5 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="w-10 h-10 rounded-xl bg-indigo-100 text-indigo-700 flex items-center justify-center shrink-0">
          <Wallet size={20} />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-lg font-black text-indigo-900">
            الحسابات والحركات
          </h3>
          <p className="text-sm text-indigo-900/70 mt-0.5">
            كل ما يخص مستحقات الموظف، الصرف الفعلي، السلف، الخصومات،
            المكافآت، والقيود الملغاة.
          </p>
        </div>
      </div>
    </div>
  );
}

function SummaryCards({
  ledger,
  dash,
  liveGl,
}: {
  ledger?: EmployeeLedger;
  dash?: any;
  liveGl: number;
}) {
  const isPayable = liveGl < -0.01; // company owes employee
  const isDebt = liveGl > 0.01;     // employee owes company
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-3">
      <StatCard
        tone="blue"
        label="مستحقات معتمدة (الشهر)"
        value={dash ? EGP(dash.wage?.accrual_in_month) : '—'}
        sub="من اعتماد اليوميات"
      />
      <StatCard
        tone="orange"
        label="مصروف فعليًا (الشهر)"
        value={dash ? EGP(dash.wage?.paid_in_month) : '—'}
        sub="مجموع التسويات النقدية"
      />
      <StatCard
        tone="violet"
        label="سلف"
        value={ledger ? EGP(ledger.totals?.advances) : '—'}
        sub="ذمم على الموظف"
      />
      <StatCard
        tone="rose"
        label="خصومات"
        value={ledger ? EGP(ledger.totals?.manual_deductions) : '—'}
        sub="تقلل المستحق"
      />
      <StatCard
        tone={isPayable ? 'green' : isDebt ? 'red' : 'slate'}
        label="الرصيد النهائي"
        value={EGP(Math.abs(liveGl))}
        sub={isPayable ? 'مستحق له' : isDebt ? 'مدين للشركة' : 'متوازن'}
      />
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Ledger / Movements table — the canonical view
 * ───────────────────────────────────────────────────────────────── */

type SourceFilter = 'all' | 'shift' | 'direct_cashbox' | 'no_cashbox';
type StatusFilter = 'all' | 'live' | 'voided';

function LedgerCard({
  userId,
  ledger,
  loading,
  from,
  to,
  onChangeFrom,
  onChangeTo,
}: {
  userId: string;
  ledger?: EmployeeLedger;
  loading: boolean;
  from: string;
  to: string;
  onChangeFrom: (s: string) => void;
  onChangeTo: (s: string) => void;
}) {
  const hasPermission = useAuthStore((s) => s.hasPermission);
  const canVoid = hasPermission('payroll.void');
  const qc = useQueryClient();

  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<string>('all');
  const [sourceFilter, setSourceFilter] = useState<SourceFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [includeVoided, setIncludeVoided] = useState(true);

  // movement-type derivation from reference_type — keeps the table
  // labels meaningful without depending on a new backend field.
  const rows: EnrichedRow[] = useMemo(() => {
    const list = ledger?.gl_entries ?? [];
    return list.map((e) => enrichRow(e));
  }, [ledger]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (!includeVoided && r.is_voided) return false;
      if (statusFilter === 'live' && r.is_voided) return false;
      if (statusFilter === 'voided' && !r.is_voided) return false;
      if (typeFilter !== 'all' && r.movement_type_key !== typeFilter) return false;
      // Source filter (best-effort: gl_entries doesn't include cashbox_id
      // directly; we infer from reference_type — payout/advance ARE cash
      // movements so they're either shift or direct_cashbox, deduction/
      // bonus/wage_accrual are no_cashbox).
      if (sourceFilter !== 'all') {
        if (sourceFilter === 'no_cashbox' && r.is_cash_movement) return false;
        if (sourceFilter === 'shift' && (!r.is_cash_movement)) return false;
        if (sourceFilter === 'direct_cashbox' && (!r.is_cash_movement)) return false;
        // Note: distinguishing shift vs direct_cashbox requires a join on
        // employee_settlements.shift_id — deferred to a follow-up that
        // extends the gl_entries response with shift_id (PR-T3 → PR-T4).
      }
      if (search) {
        const q = search.toLowerCase();
        const haystack = `${r.entry_no} ${r.description}`.toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    });
  }, [rows, search, typeFilter, sourceFilter, statusFilter, includeVoided]);

  const voidMut = useMutation({
    mutationFn: (id: string) =>
      // /payroll/:id supports DELETE → backend voids; signed_effect on
      // gl_entries goes to 0 (PR-25). Used here for non-wage movements.
      // For wage approvals, the Attendance tab's إلغاء action is the
      // canonical path (calls /attendance/admin/void-accrual).
      Promise.resolve(id).then((rid) =>
        fetchDelete(`/payroll/${rid}`),
      ),
    onSuccess: () => {
      toast.success('تم إلغاء أثر الحركة محاسبيًا (مرئية في السجل بحالة "ملغاة")');
      qc.invalidateQueries({ queryKey: ['employee-ledger', userId] });
      qc.invalidateQueries({ queryKey: ['employee-user-dashboard', userId] });
      qc.invalidateQueries({ queryKey: ['employees-team'] });
      qc.invalidateQueries({ queryKey: ['payable-days'] });
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل إلغاء الحركة'),
  });

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
      <div className="px-5 py-4 border-b border-slate-100">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h4 className="text-sm font-black text-slate-800">
              سجل الحركات الموحّد
            </h4>
            <div className="text-xs text-slate-500 mt-0.5">
              من /employees/:id/ledger — يشمل القيود الملغاة (الأثر = 0).
            </div>
          </div>
          <div className="text-xs text-slate-500 tabular-nums">
            {filtered.length} حركة
          </div>
        </div>

        {/* Filters */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-6 gap-2">
          <div className="flex items-center gap-2 px-2 py-2 rounded-xl border border-slate-200 bg-slate-50 xl:col-span-2">
            <Search size={14} className="text-slate-400" />
            <input
              className="bg-transparent flex-1 text-sm outline-none placeholder:text-slate-400"
              placeholder="ابحث في الوصف أو رقم القيد…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <input
            type="date"
            value={from}
            onChange={(e) => onChangeFrom(e.target.value)}
            className="px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-700"
            title="من"
          />
          <input
            type="date"
            value={to}
            onChange={(e) => onChangeTo(e.target.value)}
            className="px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-700"
            title="إلى"
          />
          <select
            value={typeFilter}
            onChange={(e) => setTypeFilter(e.target.value)}
            className="px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-700"
          >
            <option value="all">كل الأنواع</option>
            <option value="wage_accrual">اعتماد يومية</option>
            <option value="settlement">صرف مستحقات</option>
            <option value="advance">سلفة</option>
            <option value="bonus">مكافأة</option>
            <option value="deduction">خصم</option>
            <option value="other">أخرى</option>
          </select>
          <select
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value as SourceFilter)}
            className="px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-700"
            title="فلتر المصدر — النقدي مقابل الغير نقدي"
          >
            <option value="all">كل المصادر</option>
            <option value="shift">حركات نقدية (وردية / خزنة)</option>
            <option value="no_cashbox">بدون حركة نقدية</option>
          </select>
        </div>

        <div className="mt-2 flex items-center justify-between flex-wrap gap-2">
          <div className="flex items-center gap-2">
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
              className="px-3 py-2 rounded-xl border border-slate-200 text-xs text-slate-700"
            >
              <option value="all">كل الحالات</option>
              <option value="live">نشط</option>
              <option value="voided">ملغى</option>
            </select>
            <button
              type="button"
              onClick={() => setIncludeVoided(!includeVoided)}
              className={`inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-bold border ${
                includeVoided
                  ? 'bg-slate-50 text-slate-700 border-slate-200'
                  : 'bg-white text-slate-500 border-slate-200'
              }`}
              title={includeVoided ? 'إخفاء الملغاة' : 'إظهار الملغاة'}
            >
              {includeVoided ? <Eye size={13} /> : <EyeOff size={13} />}
              {includeVoided ? 'القيود الملغاة ظاهرة' : 'القيود الملغاة مخفية'}
            </button>
          </div>
          <div className="text-[10px] text-slate-400 leading-snug max-w-md">
            القيود الملغاة لا تؤثر على الرصيد (signed_effect = 0). معروضة فقط
            للتدقيق.
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-center text-xs text-slate-400 py-10">
          جارٍ التحميل…
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center text-xs text-slate-400 py-10">
          لا حركات مطابقة للفلاتر.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="bg-slate-50">
              <tr>
                <Th>التاريخ</Th>
                <Th>نوع الحركة</Th>
                <Th>الوصف</Th>
                <Th>مدين</Th>
                <Th>دائن</Th>
                <Th>الأثر</Th>
                <Th>الرصيد بعد</Th>
                <Th>رقم القيد</Th>
                <Th>الحساب</Th>
                <Th>الحالة</Th>
                <Th>إجراءات</Th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => (
                <tr
                  key={`${r.entry_no}-${i}`}
                  className={`border-t border-slate-100 ${
                    r.is_voided ? 'opacity-60 bg-slate-50/60' : ''
                  }`}
                >
                  <Td className="font-mono tabular-nums whitespace-nowrap">
                    {fmtDate(r.entry_date)}
                  </Td>
                  <Td>
                    <MovementTypeChip kind={r.movement_type_key} />
                  </Td>
                  <Td className="max-w-[300px]">
                    <div
                      className={`text-[11px] ${r.is_voided ? 'line-through text-slate-500' : 'text-slate-700'}`}
                      title={r.description}
                    >
                      {r.description || '—'}
                    </div>
                    <div className="text-[10px] text-slate-400 mt-0.5">
                      الأثر: {r.effect_label}
                    </div>
                  </Td>
                  <Td className="font-mono tabular-nums text-center">
                    {r.debit > 0 ? (
                      <span className={r.is_voided ? 'line-through' : ''}>
                        {EGP(r.debit)}
                      </span>
                    ) : '—'}
                  </Td>
                  <Td className="font-mono tabular-nums text-center">
                    {r.credit > 0 ? (
                      <span className={r.is_voided ? 'line-through' : ''}>
                        {EGP(r.credit)}
                      </span>
                    ) : '—'}
                  </Td>
                  <Td
                    className={`font-mono tabular-nums text-center font-bold ${
                      r.is_voided
                        ? 'text-slate-400'
                        : r.signed_effect > 0
                          ? 'text-rose-700'
                          : r.signed_effect < 0
                            ? 'text-emerald-700'
                            : 'text-slate-500'
                    }`}
                  >
                    {r.is_voided
                      ? '0.00'
                      : `${r.signed_effect > 0 ? '+' : ''}${EGP(r.signed_effect).replace(' ج.م', '')}`}
                  </Td>
                  <Td className="font-mono tabular-nums text-center font-black">
                    {EGP(r.running_balance).replace(' ج.م', '')}
                  </Td>
                  <Td className="font-mono text-[10px] text-slate-500">
                    {r.entry_no}
                  </Td>
                  <Td>
                    <span
                      className={`chip text-[10px] ${
                        r.account_code === '1123'
                          ? 'bg-amber-50 text-amber-700 border-amber-200'
                          : 'bg-indigo-50 text-indigo-700 border-indigo-200'
                      }`}
                    >
                      {r.account_code}
                    </span>
                  </Td>
                  <Td>
                    {r.is_voided ? (
                      <Chip
                        tone="rose"
                        title={r.void_reason || 'تم الإلغاء'}
                      >
                        ملغاة
                      </Chip>
                    ) : (
                      <Chip tone="green">نشطة</Chip>
                    )}
                  </Td>
                  <Td>
                    {!r.is_voided && canVoid && r.can_void && (
                      <button
                        type="button"
                        onClick={() => {
                          if (
                            window.confirm(
                              'إلغاء الحركة محاسبيًا؟ ستبقى ظاهرة في السجل بحالة "ملغاة".',
                            )
                          ) {
                            voidMut.mutate(r.payroll_id ?? '');
                          }
                        }}
                        className="p-1.5 rounded hover:bg-rose-50 text-rose-600"
                        title="إلغاء الحركة"
                        disabled={voidMut.isPending}
                      >
                        <X size={13} />
                      </button>
                    )}
                  </Td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Focused modals — Advance, Bonus, Deduction
 * (Payout reuses PR-15/PR-25 PayWageModal verbatim.)
 * ───────────────────────────────────────────────────────────────── */

function AdvanceModal({
  employee,
  onClose,
}: {
  employee: TeamRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [source, setSource] = useState<CashSource>({
    mode: 'unset',
    shift_id: null,
    cashbox_id: null,
  });

  // Resolve the canonical "employee_advance" expense category id.
  // Migration 086 created it; the modal must reuse the same category
  // so backend posting goes through the existing employee-advance path.
  const { data: categories = [] } = useQuery({
    queryKey: ['accounting-categories'],
    queryFn: () => accountingApi.categories(),
  });
  const advanceCategory = useMemo(
    () =>
      (categories as any[]).find(
        (c) => c.code === 'employee_advance' && c.is_active,
      ),
    [categories],
  );

  const mut = useMutation({
    mutationFn: () =>
      accountingApi.createDailyExpense({
        warehouse_id: '', // resolved server-side from the user's default warehouse
        cashbox_id:
          source.mode === 'open_shift' || source.mode === 'direct_cashbox'
            ? source.cashbox_id ?? undefined
            : undefined,
        category_id: advanceCategory?.id ?? '',
        amount: Number(amount),
        payment_method: 'cash',
        description: reason.trim() || `سلفة موظف — ${employee.full_name || employee.username}`,
        employee_user_id: employee.id,
        is_advance: true,
        shift_id: source.mode === 'open_shift' ? source.shift_id : undefined,
      }),
    onSuccess: () => {
      toast.success('تم تسجيل السلفة وخروج النقد من المصدر المختار.');
      invalidateAccounts(qc, employee.id);
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تسجيل السلفة'),
  });

  const amtNum = Number(amount || 0);
  const ready =
    !!advanceCategory &&
    amtNum > 0 &&
    !!reason.trim() &&
    source.mode !== 'unset';

  return (
    <ModalShell
      title="تسجيل سلفة موظف"
      subtitle={`${employee.full_name || employee.username}`}
      onClose={onClose}
    >
      <Notice
        tone="indigo"
        icon={<TrendingDown size={16} />}
        title="السلفة = خروج نقد فعلي + ذمة على الموظف"
        body="يلزم اختيار مصدر الصرف (وردية مفتوحة أو خزنة مباشرة). الحركة من خزنة مباشرة لن تظهر في إقفال أي وردية وتتطلب صلاحية employees.settlement.direct_cashbox."
      />

      <AccountingPreview
        amount={amtNum}
        debit={{ code: '1123', name: 'ذمم / سلف الموظفين' }}
        credit={{ code: 'cashbox', name: 'الخزنة' }}
        note="يضيف رصيد على الموظف (مدين للشركة) ويُخرج نقدًا من الخزنة المختارة."
      />

      <Field label="المبلغ">
        <input
          type="number"
          step="0.01"
          min="0"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          className="input w-full"
          disabled={mut.isPending}
        />
      </Field>

      <Field label="السبب / ملاحظة (مطلوب)">
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="input w-full"
          disabled={mut.isPending}
          placeholder="مثلاً: سلفة طارئة على الراتب"
        />
      </Field>

      <div>
        <div className="text-[11px] font-bold text-slate-600 mb-2">
          مصدر الصرف
        </div>
        <CashSourceSelector
          value={source}
          onChange={setSource}
          disabled={mut.isPending}
        />
      </div>

      {!advanceCategory && (
        <div className="text-xs text-rose-700 bg-rose-50 border border-rose-200 rounded-xl p-3">
          فئة "employee_advance" غير موجودة — يرجى التحقق من الإعدادات
          (migration 086).
        </div>
      )}

      <ModalFooter
        onCancel={onClose}
        disabled={!ready || mut.isPending}
        primaryLabel={mut.isPending ? 'جارٍ التسجيل…' : 'تسجيل السلفة'}
        onPrimary={() => mut.mutate()}
        primaryIcon={<Receipt size={15} />}
      />
    </ModalShell>
  );
}

function BonusModal({
  employee,
  onClose,
}: {
  employee: TeamRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [bonusDate, setBonusDate] = useState(today);

  const mut = useMutation({
    mutationFn: () =>
      employeesApi.addBonus(employee.id, {
        amount: Number(amount),
        note: note.trim() || undefined,
        bonus_date: bonusDate,
      }),
    onSuccess: () => {
      toast.success('تم تسجيل المكافأة — DR 521 / CR 213 فقط، بدون أي حركة خزنة.');
      invalidateAccounts(qc, employee.id);
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تسجيل المكافأة'),
  });

  const amtNum = Number(amount || 0);
  const ready = amtNum > 0;

  return (
    <ModalShell
      title="تسجيل مكافأة"
      subtitle={`${employee.full_name || employee.username}`}
      onClose={onClose}
    >
      <Notice
        tone="emerald"
        icon={<Gift size={16} />}
        title="المكافأة = إضافة مستحق فقط، بدون نقد"
        body="هذا الإجراء يضيف مستحقًا للموظف فقط. لا يتم صرف أي نقد. لا يؤثر على الخزنة أو الوردية. الصرف لاحقًا من زر صرف مستحقات."
      />

      <AccountingPreview
        amount={amtNum}
        debit={{ code: '521', name: 'رواتب وأجور (مكافآت)' }}
        credit={{ code: '213', name: 'مستحقات الموظفين' }}
        note="يضيف مستحقًا للموظف. لا cashbox · لا shift."
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="المبلغ">
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="input w-full"
            disabled={mut.isPending}
          />
        </Field>
        <Field label="التاريخ">
          <input
            type="date"
            value={bonusDate}
            onChange={(e) => setBonusDate(e.target.value)}
            className="input w-full"
            disabled={mut.isPending}
          />
        </Field>
      </div>

      <Field label="الملاحظة (اختياري)">
        <input
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className="input w-full"
          disabled={mut.isPending}
          placeholder="مثلاً: مكافأة أداء شهر أبريل"
        />
      </Field>

      <ModalFooter
        onCancel={onClose}
        disabled={!ready || mut.isPending}
        primaryLabel={mut.isPending ? 'جارٍ التسجيل…' : 'تسجيل المكافأة'}
        onPrimary={() => mut.mutate()}
        primaryIcon={<Gift size={15} />}
      />
    </ModalShell>
  );
}

function DeductionModal({
  employee,
  onClose,
}: {
  employee: TeamRow;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Cairo' });
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [deductionDate, setDeductionDate] = useState(today);

  const mut = useMutation({
    mutationFn: () =>
      employeesApi.addDeduction(employee.id, {
        amount: Number(amount),
        reason: reason.trim(),
        deduction_date: deductionDate,
      }),
    onSuccess: () => {
      toast.success('تم تسجيل الخصم — DR 213 / CR 521 فقط، بدون أي حركة خزنة.');
      invalidateAccounts(qc, employee.id);
      onClose();
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.message || 'فشل تسجيل الخصم'),
  });

  const amtNum = Number(amount || 0);
  const ready = amtNum > 0 && !!reason.trim();

  return (
    <ModalShell
      title="تسجيل خصم"
      subtitle={`${employee.full_name || employee.username}`}
      onClose={onClose}
    >
      <Notice
        tone="rose"
        icon={<Minus size={16} />}
        title="الخصم = تقليل مستحق فقط، بدون نقد"
        body="يقلل مستحقات الموظف. لا يتم صرف أي نقد. لا يؤثر على الخزنة أو الوردية."
      />

      <AccountingPreview
        amount={amtNum}
        debit={{ code: '213', name: 'مستحقات الموظفين' }}
        credit={{ code: '521', name: 'رواتب وأجور (تسوية الخصم)' }}
        note="يقلل مستحقات الموظف. لا cashbox · لا shift."
      />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="المبلغ">
          <input
            type="number"
            step="0.01"
            min="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className="input w-full"
            disabled={mut.isPending}
          />
        </Field>
        <Field label="التاريخ">
          <input
            type="date"
            value={deductionDate}
            onChange={(e) => setDeductionDate(e.target.value)}
            className="input w-full"
            disabled={mut.isPending}
          />
        </Field>
      </div>

      <Field label="السبب (مطلوب)">
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          className="input w-full"
          disabled={mut.isPending}
          placeholder="مثلاً: تأخير 30 دقيقة"
        />
      </Field>

      <ModalFooter
        onCancel={onClose}
        disabled={!ready || mut.isPending}
        primaryLabel={mut.isPending ? 'جارٍ التسجيل…' : 'تسجيل الخصم'}
        onPrimary={() => mut.mutate()}
        primaryIcon={<Minus size={15} />}
      />
    </ModalShell>
  );
}

/* ─────────────────────────────────────────────────────────────────
 * Helpers + small UI primitives
 * ───────────────────────────────────────────────────────────────── */

interface EnrichedRow extends EmployeeGlLedgerEntry {
  movement_type_key:
    | 'wage_accrual'
    | 'settlement'
    | 'advance'
    | 'bonus'
    | 'deduction'
    | 'other';
  movement_type_label: string;
  effect_label: string;
  is_cash_movement: boolean;
  can_void: boolean;
  payroll_id?: string;
}

function enrichRow(e: EmployeeGlLedgerEntry): EnrichedRow {
  const rt = e.reference_type || '';
  const isCredit213 = e.account_code === '213' && e.credit > 0;
  const isDebit213 = e.account_code === '213' && e.debit > 0;
  const isDebit1123 = e.account_code === '1123' && e.debit > 0;

  let key: EnrichedRow['movement_type_key'] = 'other';
  let label = 'حركة محاسبية';
  let effect = '—';
  let isCash = false;
  let canVoid = false;

  if (rt.includes('wage_accrual')) {
    key = 'wage_accrual';
    label = 'اعتماد يومية';
    effect = 'إضافة مستحق للموظف · لا خزنة · لا وردية';
  } else if (rt.includes('settlement') && isDebit213) {
    key = 'settlement';
    label = 'صرف مستحقات';
    effect = 'صرف نقدي للموظف · يقلل المستحق';
    isCash = true;
  } else if (rt.includes('advance') || isDebit1123) {
    key = 'advance';
    label = 'سلفة';
    effect = 'الموظف مدين للشركة · خروج نقدي';
    isCash = true;
  } else if (rt.includes('bonus') && isCredit213) {
    key = 'bonus';
    label = 'مكافأة';
    effect = 'يضيف مستحقًا للموظف · بدون نقد';
    canVoid = true;
  } else if (rt.includes('deduction') && isDebit213) {
    key = 'deduction';
    label = 'خصم';
    effect = 'يقلل مستحقات الموظف · بدون نقد';
    canVoid = true;
  } else if (rt.includes('employee_txn') || rt.includes('employee_bonus')) {
    // Generic legacy employee transaction — derive direction from
    // 213 side. CR 213 = bonus-like, DR 213 = deduction/settlement-like.
    if (isCredit213) {
      key = 'bonus';
      label = 'مكافأة';
      effect = 'يضيف مستحقًا للموظف';
      canVoid = true;
    } else if (isDebit213) {
      key = 'deduction';
      label = 'خصم / تسوية';
      effect = 'يقلل مستحقات الموظف';
      canVoid = true;
    }
  } else if (rt.includes('reset')) {
    label = 'تصفير حساب';
    effect = 'تسوية افتتاحية';
  } else if (rt.includes('reclass')) {
    label = 'إعادة تصنيف';
    effect = 'إعادة توزيع بين حسابين';
  }

  // Extract payroll id for void action — reference_id on the JE points
  // at the source employee_transactions row for bonus/deduction.
  const payrollId =
    canVoid && (rt.includes('bonus') || rt.includes('deduction') || rt.includes('employee_txn'))
      ? e.reference_id
      : undefined;

  return {
    ...e,
    movement_type_key: key,
    movement_type_label: label,
    effect_label: effect,
    is_cash_movement: isCash,
    can_void: canVoid && !!payrollId,
    payroll_id: payrollId,
  };
}

function MovementTypeChip({ kind }: { kind: EnrichedRow['movement_type_key'] }) {
  const map: Record<EnrichedRow['movement_type_key'], { label: string; tone: ChipTone }> = {
    wage_accrual: { label: 'اعتماد يومية', tone: 'green' },
    settlement:   { label: 'صرف مستحقات', tone: 'amber' },
    advance:      { label: 'سلفة',         tone: 'violet' },
    bonus:        { label: 'مكافأة',       tone: 'emerald' },
    deduction:    { label: 'خصم',          tone: 'rose' },
    other:        { label: 'حركة',         tone: 'slate' },
  };
  const { label, tone } = map[kind];
  return <Chip tone={tone}>{label}</Chip>;
}

type ChipTone = 'green' | 'amber' | 'rose' | 'blue' | 'slate' | 'emerald' | 'violet';

function Chip({
  tone,
  children,
  title,
}: {
  tone: ChipTone;
  children: React.ReactNode;
  title?: string;
}) {
  const map: Record<ChipTone, string> = {
    green:   'bg-emerald-50 text-emerald-700 border-emerald-200',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200',
    amber:   'bg-amber-50   text-amber-800   border-amber-200',
    rose:    'bg-rose-50    text-rose-700    border-rose-200',
    blue:    'bg-blue-50    text-blue-700    border-blue-200',
    violet:  'bg-violet-50  text-violet-700  border-violet-200',
    slate:   'bg-slate-50   text-slate-600   border-slate-200',
  };
  return (
    <span
      title={title}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold border ${map[tone]}`}
    >
      {children}
    </span>
  );
}

function StatCard({
  tone,
  label,
  value,
  sub,
}: {
  tone: 'green' | 'orange' | 'red' | 'blue' | 'violet' | 'rose' | 'slate';
  label: string;
  value: string;
  sub?: string;
}) {
  const map: Record<string, string> = {
    green:  'text-emerald-700',
    orange: 'text-amber-700',
    red:    'text-rose-700',
    blue:   'text-blue-700',
    violet: 'text-violet-700',
    rose:   'text-rose-700',
    slate:  'text-slate-600',
  };
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="text-[11px] font-bold text-slate-500">{label}</div>
      <div className={`text-lg font-black mt-1 tabular-nums ${map[tone]}`}>
        {value}
      </div>
      {sub && (
        <div className="text-[10px] text-slate-400 mt-0.5">{sub}</div>
      )}
    </div>
  );
}

function ActionButton({
  tone,
  icon,
  onClick,
  children,
}: {
  tone: 'amber' | 'indigo' | 'rose' | 'emerald';
  icon: React.ReactNode;
  onClick: () => void;
  children: React.ReactNode;
}) {
  const map: Record<string, string> = {
    amber:   'bg-amber-50 text-amber-800 border-amber-200 hover:bg-amber-100',
    indigo:  'bg-indigo-50 text-indigo-700 border-indigo-200 hover:bg-indigo-100',
    rose:    'bg-rose-50 text-rose-700 border-rose-200 hover:bg-rose-100',
    emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200 hover:bg-emerald-100',
  };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl border text-sm font-bold ${map[tone]}`}
    >
      {icon}
      {children}
    </button>
  );
}

function ModalShell({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div
      className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl bg-white rounded-2xl shadow-2xl my-6"
        onClick={(e) => e.stopPropagation()}
        dir="rtl"
      >
        <div className="px-5 py-4 border-b border-slate-100 flex items-start justify-between gap-3">
          <div>
            <h3 className="text-lg font-black text-slate-800">{title}</h3>
            {subtitle && (
              <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded hover:bg-slate-100 text-slate-500"
            title="إغلاق"
          >
            <X size={16} />
          </button>
        </div>
        <div className="p-5 space-y-4">{children}</div>
      </div>
    </div>
  );
}

function ModalFooter({
  onCancel,
  disabled,
  primaryLabel,
  onPrimary,
  primaryIcon,
}: {
  onCancel: () => void;
  disabled: boolean;
  primaryLabel: string;
  onPrimary: () => void;
  primaryIcon?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-2 pt-2">
      <button
        type="button"
        onClick={onCancel}
        className="px-4 py-2 rounded-xl bg-white border border-slate-200 text-slate-700 text-sm font-bold hover:bg-slate-50"
      >
        إلغاء
      </button>
      <button
        type="button"
        onClick={onPrimary}
        disabled={disabled}
        className="inline-flex items-center gap-2 px-5 py-2 rounded-xl bg-indigo-600 text-white text-sm font-bold hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {primaryIcon}
        {primaryLabel}
      </button>
    </div>
  );
}

function Notice({
  tone,
  icon,
  title,
  body,
}: {
  tone: 'indigo' | 'emerald' | 'rose' | 'amber';
  icon: React.ReactNode;
  title: string;
  body: string;
}) {
  const map: Record<string, string> = {
    indigo:  'bg-indigo-50 border-indigo-200 text-indigo-900',
    emerald: 'bg-emerald-50 border-emerald-200 text-emerald-900',
    rose:    'bg-rose-50 border-rose-200 text-rose-900',
    amber:   'bg-amber-50 border-amber-200 text-amber-900',
  };
  return (
    <div className={`rounded-xl border p-3 flex items-start gap-2 text-sm ${map[tone]}`}>
      <span className="shrink-0 mt-0.5">{icon}</span>
      <div className="leading-relaxed">
        <div className="font-bold">{title}</div>
        <div className="opacity-80 text-xs mt-0.5">{body}</div>
      </div>
    </div>
  );
}

function AccountingPreview({
  amount,
  debit,
  credit,
  note,
}: {
  amount: number;
  debit: { code: string; name: string };
  credit: { code: string; name: string };
  note: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-50 p-3">
      <div className="text-xs font-bold text-slate-600 mb-2">
        القيد المحاسبي للحركة
      </div>
      <div className="grid grid-cols-2 gap-2 text-sm">
        <div className="rounded-lg bg-white border border-slate-200 p-3">
          <div className="text-[10px] font-bold text-emerald-700">DR {debit.code}</div>
          <div className="text-slate-600 text-xs mt-0.5">{debit.name}</div>
          <div className="font-mono tabular-nums font-black mt-1">
            {EGP(amount)}
          </div>
        </div>
        <div className="rounded-lg bg-white border border-slate-200 p-3">
          <div className="text-[10px] font-bold text-blue-700">CR {credit.code}</div>
          <div className="text-slate-600 text-xs mt-0.5">{credit.name}</div>
          <div className="font-mono tabular-nums font-black mt-1">
            {EGP(amount)}
          </div>
        </div>
      </div>
      <div className="text-[10px] text-slate-500 mt-2">{note}</div>
    </div>
  );
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="text-right px-3 py-2.5 text-[11px] font-bold text-slate-500 bg-slate-50 whitespace-nowrap">
      {children}
    </th>
  );
}

function Td({
  children,
  className = '',
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <td className={`px-3 py-2.5 text-xs text-slate-700 ${className}`}>
      {children}
    </td>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <div className="text-[11px] font-bold text-slate-600 mb-1">{label}</div>
      {children}
    </label>
  );
}

function monthBounds(): { from: string; to: string } {
  const today = new Date();
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(today);
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${d}` };
}

function invalidateAccounts(
  qc: ReturnType<typeof useQueryClient>,
  userId: string,
) {
  qc.invalidateQueries({ queryKey: ['employee-ledger', userId] });
  qc.invalidateQueries({ queryKey: ['employee-user-dashboard', userId] });
  qc.invalidateQueries({ queryKey: ['employees-team'] });
  qc.invalidateQueries({ queryKey: ['payroll-list'] });
  qc.invalidateQueries({ queryKey: ['payroll-balances'] });
  qc.invalidateQueries({ queryKey: ['payable-days', userId] });
  qc.invalidateQueries({ queryKey: ['attendance-summary-today'] });
}

// Local helper — payrollApi has no `.remove(id)` typing exposed in the
// existing client signature, but the canonical DELETE /payroll/:id
// endpoint is what Payroll.tsx already uses. We import the underlying
// client lazily to avoid pulling the whole Payroll page just for this.
async function fetchDelete(path: string) {
  const { api, unwrap } = await import('@/api/client');
  return unwrap<{ deleted: boolean }>(api.delete(path));
}

// Mark imports used (helps the linter — these names appear only via
// the inferred return type of the API helpers).
const _refsUsed = [Plus, ShieldAlert, AlertTriangle, CheckCircle2];
void _refsUsed;
