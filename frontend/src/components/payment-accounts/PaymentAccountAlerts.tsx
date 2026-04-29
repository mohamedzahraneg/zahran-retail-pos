/**
 * PaymentAccountAlerts — PR-FIN-PAYACCT-4B
 * ───────────────────────────────────────────────────────────────────
 *
 * Right-side accounting-alerts panel on the Payment Accounts admin
 * page. Computes warnings from real data:
 *
 *   • Cashbox stored vs GL drift (`v_cashbox_gl_drift` via /cash-desk/gl-drift)
 *   • Methods with active accounts but no `is_default=true` row
 *   • Accounts with no movement in the last 30 days
 *   • All-clear banner when nothing to flag
 *
 * No hardcoded warnings.
 */
import {
  ShieldAlert,
  ShieldCheck,
  CalendarDays,
  Link2Off,
  Archive,
  AlertTriangle,
} from 'lucide-react';
import {
  type PaymentAccount,
  type PaymentAccountBalance,
  type PaymentMethodCode,
  type CashboxGlDrift,
  METHOD_LABEL_AR,
} from '@/api/payments.api';

const DRIFT_THRESHOLD_EGP = 0.01;
const STALE_DAYS = 30;

/**
 * PR-FIN-PAYACCT-4D — methods where pinning a `cashbox_id` is
 * recommended for unambiguous balance attribution. Excludes `cash`
 * (it doesn't have payment_account rows in practice), `credit`, and
 * `other` (no physical mapping).
 */
const PIN_RECOMMENDED_METHODS = new Set<PaymentMethodCode>([
  'bank_transfer',
  'card_visa', 'card_mastercard', 'card_meeza',
  'instapay',
  'wallet', 'vodafone_cash', 'orange_cash',
  'check',
]);

function daysSince(iso: string | null): number | null {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  return Math.floor(ms / (1000 * 60 * 60 * 24));
}

export interface PaymentAccountAlertsProps {
  /** Full list of accounts (active and inactive). */
  accounts: PaymentAccount[];
  /** Per-account balance with last_movement (for stale-check). */
  balances?: PaymentAccountBalance[];
  /** Per-cashbox stored vs GL drift. */
  drifts?: CashboxGlDrift[];
}

export function PaymentAccountAlerts({
  accounts,
  balances = [],
  drifts = [],
}: PaymentAccountAlertsProps) {
  // 1. Drift alerts — cashboxes whose stored vs GL net differs by > threshold.
  const driftAlerts = drifts.filter(
    (d) => Math.abs(Number(d.drift_amount || 0)) > DRIFT_THRESHOLD_EGP,
  );

  // 2. No-default-per-method warnings.
  // A method that has at least one active account but none marked is_default.
  const activeByMethod = new Map<string, PaymentAccount[]>();
  for (const a of accounts) {
    if (!a.active) continue;
    const arr = activeByMethod.get(a.method) ?? [];
    arr.push(a);
    activeByMethod.set(a.method, arr);
  }
  const noDefaultMethods: string[] = [];
  for (const [method, arr] of activeByMethod.entries()) {
    if (!arr.some((a) => a.is_default)) noDefaultMethods.push(method);
  }

  // 3. Stale-account warnings — last_movement older than 30 days.
  const staleAccounts = balances.filter((b) => {
    if (!b.active) return false;
    const days = daysSince(b.last_movement);
    return days !== null && days > STALE_DAYS;
  });

  // 4. PR-FIN-PAYACCT-4D — inactive accounts that still carry historical
  //    movements. Not necessarily a problem (deactivation by design keeps
  //    the audit trail), but operators want this surfaced so they don't
  //    forget the row exists.
  const inactiveWithMovements = balances.filter(
    (b) => !b.active && Number(b.je_count || 0) > 0,
  );

  // 5. PR-FIN-PAYACCT-4D — active accounts on methods where pinning a
  //    `cashbox_id` is recommended but the pin is missing. This makes
  //    GL-vs-cashbox reconciliation ambiguous when multiple accounts
  //    share the same gl_account_code.
  const noCashboxPin = balances.filter(
    (b) =>
      b.active &&
      !b.cashbox_id &&
      PIN_RECOMMENDED_METHODS.has(b.method as PaymentMethodCode),
  );

  const allClear =
    driftAlerts.length === 0 &&
    noDefaultMethods.length === 0 &&
    staleAccounts.length === 0 &&
    inactiveWithMovements.length === 0 &&
    noCashboxPin.length === 0;

  return (
    <div
      className="rounded-2xl border border-slate-200 bg-white p-4 space-y-3"
      data-testid="payment-account-alerts"
    >
      <div className="flex items-center gap-2">
        <ShieldAlert size={16} className="text-rose-500" />
        <h3 className="font-bold text-sm text-slate-800">تنبيهات محاسبية</h3>
      </div>

      {/* Drift */}
      {driftAlerts.map((d) => (
        <div
          key={`drift-${d.cashbox_id}`}
          className="rounded-lg border border-rose-200 bg-rose-50 p-3"
          data-testid={`alert-drift-${d.cashbox_id}`}
        >
          <div className="flex items-start gap-2">
            <ShieldAlert size={14} className="text-rose-600 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-bold text-rose-700">
                فجوة بين الخزنة والأستاذ العام
              </div>
              <div className="text-xs text-rose-700 truncate">
                {d.cashbox_name}: {Number(d.drift_amount) > 0 ? '+' : ''}
                {Number(d.drift_amount).toLocaleString('en-US')} ج.م
              </div>
            </div>
          </div>
        </div>
      ))}

      {/* No default per method */}
      {noDefaultMethods.map((m) => (
        <div
          key={`nodef-${m}`}
          className="rounded-lg border border-amber-200 bg-amber-50 p-3"
          data-testid={`alert-no-default-${m}`}
        >
          <div className="flex items-start gap-2">
            <Link2Off size={14} className="text-amber-700 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-bold text-amber-800">
                طريقة دفع بلا حساب افتراضي نشط
              </div>
              <div className="text-xs text-amber-800 truncate">
                {METHOD_LABEL_AR[m as keyof typeof METHOD_LABEL_AR] ?? m}
              </div>
            </div>
          </div>
        </div>
      ))}

      {/* Stale accounts */}
      {staleAccounts.length > 0 && (
        <div
          className="rounded-lg border border-slate-200 bg-slate-50 p-3"
          data-testid="alert-stale-accounts"
        >
          <div className="flex items-start gap-2">
            <CalendarDays size={14} className="text-slate-600 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-bold text-slate-700">
                حسابات بلا حركة منذ 30 يوم
              </div>
              <div className="text-xs text-slate-700">
                {staleAccounts.length} حساب
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PR-FIN-PAYACCT-4D — inactive accounts with movements */}
      {inactiveWithMovements.length > 0 && (
        <div
          className="rounded-lg border border-slate-200 bg-slate-50 p-3"
          data-testid="alert-inactive-with-movements"
        >
          <div className="flex items-start gap-2">
            <Archive size={14} className="text-slate-600 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-bold text-slate-700">
                حسابات معطّلة بها حركات سابقة
              </div>
              <div className="text-xs text-slate-700">
                {inactiveWithMovements.length} حساب
              </div>
            </div>
          </div>
        </div>
      )}

      {/* PR-FIN-PAYACCT-4D — accounts without cashbox pin (where pinning is recommended) */}
      {noCashboxPin.length > 0 && (
        <div
          className="rounded-lg border border-amber-200 bg-amber-50 p-3"
          data-testid="alert-no-cashbox-pin"
        >
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="text-amber-700 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-bold text-amber-800">
                حسابات بلا ربط بخزنة
              </div>
              <div className="text-xs text-amber-800">
                {noCashboxPin.length} حساب — يُستحسن ربطه بخزنة محددة لفصل الأرصدة
              </div>
            </div>
          </div>
        </div>
      )}

      {/* All-clear banner */}
      {allClear && (
        <div
          className="rounded-lg border border-emerald-200 bg-emerald-50 p-3"
          data-testid="alert-all-clear"
        >
          <div className="flex items-start gap-2">
            <ShieldCheck size={14} className="text-emerald-700 mt-0.5 shrink-0" />
            <div className="flex-1 min-w-0">
              <div className="text-[11px] font-bold text-emerald-800">
                جميع الخزائن متطابقة
              </div>
              <div className="text-xs text-emerald-800">لا توجد فروقات</div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
