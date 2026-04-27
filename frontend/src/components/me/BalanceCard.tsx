/**
 * BalanceCard — PR-ESS-2A-UI-1
 * ────────────────────────────────────────────────────────────────────
 *
 * Self-service "الرصيد الحالي" card on the /me top dashboard row.
 *
 * Source of truth
 * ───────────────
 * Reads `EmployeeDashboard.gl.live_snapshot` from `/employees/me/dashboard`.
 * That number comes from the canonical `v_employee_gl_balance` view —
 * the same source already used by:
 *   · `Team Management → Accounts → الرصيد النهائي` SummaryCard
 *     (frontend/src/components/team/AccountsMovementsTab.tsx:241-274)
 *   · `MyProfile.tsx`'s synthetic TeamRow construction
 *     (frontend/src/pages/MyProfile.tsx:teamRowFromDashboard)
 *
 * No new balance formula is invented here — we mirror the established
 * sign convention exactly so the same number can never disagree
 * between the manager's Team view and the employee's /me view.
 *
 * Sign convention (matches AccountsMovementsTab.SummaryCards)
 * ───────────────────────────────────────────────────────────
 *   balance < -0.01  → company owes the employee  → "له"     → GREEN
 *   balance > +0.01  → employee owes the company  → "عليه"   → RED
 *   |balance| ≤ 0.01 → balanced                    → "متوازن" → NEUTRAL
 *
 * The user-facing magnitude is `Math.abs(balance)`; the sign drives
 * tone + label only. This keeps the displayed number always positive
 * and leaves no room for sign confusion in Arabic-locale formatting.
 *
 * Side effects
 * ────────────
 * READ-ONLY display. No accounting writes, no migrations, no
 * FinancialEngine call. Approving an advance request via the safe
 * `kind='advance_request'` path (PR-ESS-2A-HOTFIX-1) does NOT change
 * `gl.live_snapshot` — it's a status flip on `employee_requests` and
 * the v_employee_gl_balance view excludes it. This card therefore
 * tracks ONLY actual financial movements (settlements, posted
 * advances via Daily Expenses, bonuses, deductions, wage accruals).
 */

import { Wallet, ArrowUpRight, ArrowDownLeft, CircleDot } from 'lucide-react';

const EGP = (n: number | string | null | undefined) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

export interface BalanceCardProps {
  /**
   * `dash.gl.live_snapshot` from `/employees/me/dashboard`. The parent
   * fetches the dashboard once and threads it down so this card and
   * sibling consumers share the same React Query result without
   * duplicate network calls.
   */
  glLiveSnapshot: number | null | undefined;
  /**
   * Optional loading flag — when true the card renders a skeleton in
   * place of the value. The parent owns the source query.
   */
  loading?: boolean;
}

type Tone = 'emerald' | 'rose' | 'slate';

interface BalanceState {
  tone: Tone;
  label: string;
  detail: string;
  Icon: React.ComponentType<{ size?: number | string; className?: string }>;
}

function classify(balance: number): BalanceState {
  if (balance < -0.01) {
    return {
      tone: 'emerald',
      label: 'له',
      detail: 'الشركة مدينة لك بهذا المبلغ',
      Icon: ArrowDownLeft,
    };
  }
  if (balance > 0.01) {
    return {
      tone: 'rose',
      label: 'عليه',
      detail: 'أنت مدين للشركة بهذا المبلغ',
      Icon: ArrowUpRight,
    };
  }
  return {
    tone: 'slate',
    label: 'متوازن',
    detail: 'لا توجد فروق متبقية',
    Icon: CircleDot,
  };
}

const TONE_CLASSES: Record<Tone, { wrap: string; chip: string; value: string; sub: string }> = {
  emerald: {
    wrap: 'border-emerald-200 bg-emerald-50/70',
    chip: 'bg-emerald-100 text-emerald-800 border-emerald-200',
    value: 'text-emerald-700',
    sub: 'text-emerald-900/70',
  },
  rose: {
    wrap: 'border-rose-200 bg-rose-50/70',
    chip: 'bg-rose-100 text-rose-800 border-rose-200',
    value: 'text-rose-700',
    sub: 'text-rose-900/70',
  },
  slate: {
    wrap: 'border-slate-200 bg-slate-50/70',
    chip: 'bg-slate-100 text-slate-700 border-slate-200',
    value: 'text-slate-700',
    sub: 'text-slate-700/70',
  },
};

export function BalanceCard({ glLiveSnapshot, loading }: BalanceCardProps) {
  const balance = Number(glLiveSnapshot ?? 0);
  const state = classify(balance);
  const cls = TONE_CLASSES[state.tone];
  const Icon = state.Icon;

  return (
    <div
      className={`rounded-2xl border p-4 shadow-sm flex flex-col gap-2 ${cls.wrap}`}
      data-testid="balance-card"
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[12px] font-bold text-slate-700">
          <Wallet size={14} />
          <span>الرصيد الحالي</span>
        </div>
        <span
          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold border ${cls.chip}`}
          data-testid="balance-card-label"
        >
          <Icon size={11} />
          {state.label}
        </span>
      </div>

      <div
        className={`text-2xl font-black tabular-nums ${cls.value}`}
        data-testid="balance-card-value"
      >
        {loading ? '…' : EGP(Math.abs(balance))}
      </div>

      <div className={`text-[11px] leading-relaxed ${cls.sub}`}>
        {state.detail}
      </div>
    </div>
  );
}
