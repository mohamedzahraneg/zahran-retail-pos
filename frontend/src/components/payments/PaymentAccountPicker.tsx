/**
 * PaymentAccountPicker — PR-FIN-PAYACCT-4C
 * ───────────────────────────────────────────────────────────────────
 *
 * Shared picker for choosing a `payment_account` row when an operator
 * selects a non-cash payment method. Lifted from `SplitPaymentsEditor`
 * (PR-POS-PAY-2 internal component) so that:
 *
 *   1. POS split-payment rows (existing — variant="dark")
 *   2. Customer ReceiptModal (new — variant="light")
 *   3. Supplier SupplierPayModal (new — variant="light")
 *
 * all render the SAME picker, with the SAME auto-default logic, the
 * SAME blocked / needs-manual-pick states, and the SAME testid surface
 * for regression tests.
 *
 * Behavior is byte-for-byte preserved from the SplitPaymentsEditor
 * internal copy at the time of extraction; POS regression tests
 * (`POS.split-payment.test.tsx`) stay green.
 *
 * data-testid surface (preserved from SplitPaymentsEditor):
 *   - `payment-account-picker`            — outermost wrapper
 *   - `payment-account-blocked`           — "no active accounts" warning
 *   - `payment-account-row-${id}`         — each candidate account
 *   - `payment-account-needs-pick`        — multi-account hint
 */

import {
  type PaymentAccount,
  type PaymentMethodCode,
  type PaymentProvider,
  METHOD_LABEL_AR,
} from '@/api/payments.api';
import { PaymentProviderLogo } from '@/components/payments/PaymentProviderLogo';

export type PaymentAccountPickerVariant = 'dark' | 'light';

export interface PaymentAccountPickerTheme {
  amountLabel: string;        // label above the picker
  accountIdle: string;        // unselected account button
  accountSelected: string;    // selected account button
  accountBlocked: string;     // blocked banner ("no active accounts")
  accountManualHint: string;  // hint shown when multiple accounts and none picked
}

const THEME_LIGHT: PaymentAccountPickerTheme = {
  amountLabel: 'block text-xs font-bold text-slate-700 mb-1.5',
  accountIdle:
    'border-slate-200 bg-white text-slate-700 hover:bg-slate-50',
  accountSelected:
    'border-brand-500 bg-brand-50 text-slate-900 ring-2 ring-brand-200',
  accountBlocked:
    'p-3 rounded-lg border border-amber-300 bg-amber-50 text-amber-700 text-sm',
  accountManualHint:
    'mt-2 text-xs font-bold text-amber-600',
};

const THEME_DARK: PaymentAccountPickerTheme = {
  amountLabel: 'block text-xs font-bold text-slate-300 mb-1.5',
  accountIdle:
    'border-slate-700 bg-slate-800/40 text-slate-200 hover:bg-slate-700/50',
  accountSelected:
    'border-brand-400 bg-brand-500/20 text-white ring-2 ring-brand-400',
  accountBlocked:
    'p-3 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-300 text-sm',
  accountManualHint:
    'mt-2 text-xs font-bold text-amber-400',
};

export const PAYMENT_ACCOUNT_PICKER_THEMES: Record<
  PaymentAccountPickerVariant,
  PaymentAccountPickerTheme
> = { dark: THEME_DARK, light: THEME_LIGHT };

/**
 * Auto-default rule when an operator switches to a non-cash method:
 *   1. Prefer the `is_default` account (admin's pinned default).
 *   2. Else if there is exactly one candidate, pick it.
 *   3. Else leave selection empty so the operator must pick.
 *
 * Identical to the inline rule in SplitPaymentsEditor (PR-POS-PAY-2)
 * at the time of extraction. Kept as a pure helper so both POS and the
 * cash-desk modals can call it without duplicating the logic.
 */
export function autoSelectAccountForMethod(
  method: PaymentMethodCode,
  accounts: Pick<PaymentAccount, 'id' | 'method' | 'is_default' | 'display_name' | 'active'>[],
): { id: string | null; display_name: string | null } {
  if (method === 'cash') return { id: null, display_name: null };
  const candidates = accounts.filter((a) => a.method === method && a.active);
  const def = candidates.find((a) => a.is_default);
  const pick = def ?? (candidates.length === 1 ? candidates[0] : null);
  return {
    id: pick?.id ?? null,
    display_name: pick?.display_name ?? null,
  };
}

/**
 * The picker proper.
 *
 * Layout: a vertical stack of selectable account cards (logo + name +
 * provider + identifier + is_default badge). When `blocked=true` the
 * picker renders a single warning banner instead of the list. When
 * `needsManualPick=true` (multiple accounts, none selected) a footer
 * hint is rendered under the list.
 *
 * The component does NOT decide whether to render itself — the caller
 * does (typically: `method !== 'cash'`). This keeps the API tight: if
 * the picker is in the DOM, you intend to ask the operator for an
 * account.
 */
export function PaymentAccountPicker({
  method,
  providers,
  accounts,
  selected,
  blocked,
  needsManualPick,
  onSelect,
  variant = 'light',
  label = 'حساب التحصيل',
}: {
  method: PaymentMethodCode;
  providers: PaymentProvider[];
  accounts: PaymentAccount[];
  selected: string | null;
  blocked: boolean;
  needsManualPick: boolean;
  onSelect: (id: string, account: PaymentAccount | null) => void;
  variant?: PaymentAccountPickerVariant;
  /** Optional override for the field label (defaults to "حساب التحصيل" — receipt context). */
  label?: string;
}) {
  const theme = PAYMENT_ACCOUNT_PICKER_THEMES[variant];

  if (blocked) {
    return (
      <div
        data-testid="payment-account-picker"
        data-blocked="true"
      >
        <div className={theme.accountBlocked} data-testid="payment-account-blocked">
          لا يوجد حساب مفعل لهذه الطريقة. أضفه من إعدادات وسائل الدفع.
        </div>
      </div>
    );
  }

  return (
    <div data-testid="payment-account-picker">
      <label className={theme.amountLabel}>{label}</label>
      <div className="space-y-2 max-h-48 overflow-auto">
        {accounts.map((a) => {
          const provider = providers.find(
            (p) => p.provider_key === a.provider_key,
          );
          const isSelected = selected === a.id;
          return (
            <button
              key={a.id}
              type="button"
              onClick={() => onSelect(a.id, a)}
              data-testid={`payment-account-row-${a.id}`}
              className={`w-full text-right p-2.5 rounded-lg border transition flex items-start gap-2 ${
                isSelected ? theme.accountSelected : theme.accountIdle
              }`}
            >
              <PaymentProviderLogo
                logoDataUrl={(a.metadata as any)?.logo_data_url}
                logoKey={provider?.logo_key}
                method={a.method}
                name={a.display_name}
                size="md"
                decorative
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="font-bold text-sm truncate">
                    {a.display_name}
                  </span>
                  {a.is_default && (
                    <span className="text-[10px] font-bold bg-amber-500/20 text-amber-700 px-2 py-0.5 rounded shrink-0">
                      افتراضي
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5 truncate">
                  {provider?.name_ar ?? METHOD_LABEL_AR[method]}
                  {a.identifier ? ` · ${a.identifier}` : ''}
                </div>
              </div>
            </button>
          );
        })}
      </div>
      {needsManualPick && (
        <div
          className={theme.accountManualHint}
          data-testid="payment-account-needs-pick"
        >
          اختر حساب التحصيل قبل المتابعة.
        </div>
      )}
    </div>
  );
}

/**
 * Helper: compute the set of methods that should be visible in a
 * picker right now. `cash` is always visible. Non-cash methods only
 * appear when at least one active payment_account exists for them.
 *
 * Identical to `visibleMethodsFor` from SplitPaymentsEditor; re-exported
 * here so the cash-desk modals can compose with the same rule without
 * importing from the POS layer.
 */
const POS_METHODS: PaymentMethodCode[] = [
  'cash',
  'instapay',
  'vodafone_cash',
  'orange_cash',
  'wallet',
  'card_visa',
  'card_mastercard',
  'card_meeza',
  'bank_transfer',
];

export function visibleMethodsFor(
  accounts: Pick<PaymentAccount, 'method' | 'active'>[],
): PaymentMethodCode[] {
  const activeMethods = new Set(
    accounts.filter((a) => a.active).map((a) => a.method),
  );
  return POS_METHODS.filter((m) => m === 'cash' || activeMethods.has(m));
}
