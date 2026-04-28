/**
 * SplitPaymentsEditor — PR-POS-PAY-2
 * ──────────────────────────────────────────────────────────────────
 *
 * Shared multi-row split-payments UI extracted from PR-POS-PAY-1's
 * PaymentModal. Used by:
 *
 *   1. `PaymentModal` (POS new-invoice flow)        — variant="dark"
 *   2. `InvoiceEditModal` (invoice-edit flow)       — variant="light"
 *
 * The editor is **presentation-only**: parents own the `rows` state
 * and pass `onChange`. The pure helpers in `lib/posSplitPayment.ts`
 * (validate, summarize, rowsToPaymentDrafts) drive the validation
 * banner + summary panel — both POS and the edit modal call those
 * same helpers independently when they need the validation result
 * for their own submit-button gating, so the two views always agree.
 *
 * Backend contract: `POST /pos/invoices` and `POST /pos/invoices/:id/edit`
 * both accept `payments: InvoicePaymentDto[]` (`backend/src/pos/dto/invoice.dto.ts`)
 * — this component just makes it easy for the UI to build that array.
 *
 * data-testid selectors are deliberately preserved from PR-POS-PAY-1
 * so the existing `POS.split-payment.test.tsx` regression net keeps
 * passing through the refactor without selector churn.
 */

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  paymentsApi,
  type PaymentAccount,
  type PaymentMethodCode,
  type PaymentProvider,
  METHOD_LABEL_AR,
} from '@/api/payments.api';
import { PaymentProviderLogo } from '@/components/payments/PaymentProviderLogo';
import {
  type SplitPaymentRow,
  summarizeSplitPayments,
  validateSplitPayments,
  makeRowUid,
} from '@/lib/posSplitPayment';

// Money formatter — same one POS uses, kept inline so the editor has
// no upward import on the POS page.
const EGP = (n: number) =>
  `${Number(n || 0).toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;

// PR-PAY-3 fix — the methods the cashier can actually USE. Cash is
// always shown; non-cash methods only appear if at least one active
// payment_account exists for them. Hidden methods become visible
// automatically when admin adds an active account, and disappear
// automatically on deactivation — no rebuild required.
//
// Re-exported here (PR-POS-PAY-2) and from `pages/POS.tsx` for
// backward compat with `pages/__tests__/POS.payment-visibility.test.ts`.
const POS_METHODS: PaymentMethodCode[] = [
  'cash',
  'instapay',
  'vodafone_cash',
  'orange_cash',
  'wallet', // PR-PAY-3.1: generic wallet umbrella (WE Pay, Bank Wallet, …)
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

/* ─────────────── Theme tokens (dark vs light) ─────────────── */

type Variant = 'dark' | 'light';

interface Theme {
  rowCard: string;
  rowSubdueText: string;
  removeBtn: string;
  amountInput: string;
  amountLabel: string;
  methodGridIdle: string;
  methodGridSelected: string;
  accountIdle: string;
  accountSelected: string;
  accountBlocked: string;
  accountManualHint: string;
  addRowBtn: string;
  summaryWrap: string;
  summaryMutedText: string;
  summaryGrand: string;
  summaryPaid: string;
  summaryRemaining: string;
  summaryChange: string;
  validation: string;
  grandBanner: string;
  grandBannerLabel: string;
  grandBannerValue: string;
}

const DARK: Theme = {
  rowCard:
    'rounded-xl border border-white/10 bg-white/5 p-3 space-y-2',
  rowSubdueText: 'text-[10px] font-bold text-slate-400',
  removeBtn:
    'text-rose-400 hover:text-rose-300 text-[11px] font-bold',
  amountInput:
    'w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-white text-lg font-bold',
  amountLabel: 'text-xs text-slate-400 block mb-1',
  methodGridIdle:
    'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10',
  methodGridSelected:
    'bg-emerald-500/20 border-emerald-500/50 text-emerald-300',
  accountIdle:
    'bg-white/5 border-white/10 text-slate-300 hover:bg-white/10',
  accountSelected:
    'bg-emerald-500/20 border-emerald-500/50 text-emerald-300',
  accountBlocked:
    'p-3 rounded-lg bg-amber-900/30 border border-amber-500/40 text-amber-200 text-sm',
  accountManualHint: 'text-[11px] text-amber-300 mt-1',
  addRowBtn:
    'w-full py-2 rounded-lg border border-dashed border-white/20 text-slate-300 text-sm font-bold hover:bg-white/5 hover:border-white/40 transition',
  summaryWrap: 'rounded-lg bg-white/5 p-3 space-y-1.5 text-sm',
  summaryMutedText: 'text-slate-400',
  summaryGrand: 'font-mono tabular-nums text-white',
  summaryPaid: 'font-mono tabular-nums text-emerald-400 font-bold',
  summaryRemaining: 'font-mono tabular-nums text-amber-400 font-bold',
  summaryChange: 'font-mono tabular-nums text-emerald-400 font-bold',
  validation:
    'rounded-lg bg-rose-500/10 border border-rose-500/30 px-3 py-2 text-[12px] text-rose-300 font-bold',
  grandBanner:
    'text-3xl font-black text-emerald-400 text-center py-2 bg-white/5 rounded-lg',
  grandBannerLabel: 'text-xs text-slate-400 block mb-1',
  grandBannerValue: '',
};

const LIGHT: Theme = {
  rowCard:
    'rounded-xl border border-slate-200 bg-white p-3 space-y-2 shadow-sm',
  rowSubdueText: 'text-[10px] font-bold text-slate-500',
  removeBtn:
    'text-rose-600 hover:text-rose-700 text-[11px] font-bold',
  amountInput:
    'w-full bg-white border border-slate-300 rounded-lg px-3 py-2 text-slate-900 text-lg font-bold focus:outline-none focus:border-emerald-500',
  amountLabel: 'text-xs text-slate-600 block mb-1',
  methodGridIdle:
    'bg-white border-slate-200 text-slate-700 hover:bg-slate-50',
  methodGridSelected:
    'bg-emerald-50 border-emerald-400 text-emerald-700',
  accountIdle: 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50',
  accountSelected: 'bg-emerald-50 border-emerald-400 text-emerald-700',
  accountBlocked:
    'p-3 rounded-lg bg-amber-50 border border-amber-300 text-amber-800 text-sm',
  accountManualHint: 'text-[11px] text-amber-700 mt-1',
  addRowBtn:
    'w-full py-2 rounded-lg border border-dashed border-slate-300 text-slate-600 text-sm font-bold hover:bg-slate-50 hover:border-slate-400 transition',
  summaryWrap: 'rounded-lg bg-slate-50 p-3 space-y-1.5 text-sm border border-slate-200',
  summaryMutedText: 'text-slate-600',
  summaryGrand: 'font-mono tabular-nums text-slate-900',
  summaryPaid: 'font-mono tabular-nums text-emerald-700 font-bold',
  summaryRemaining: 'font-mono tabular-nums text-amber-700 font-bold',
  summaryChange: 'font-mono tabular-nums text-emerald-700 font-bold',
  validation:
    'rounded-lg bg-rose-50 border border-rose-300 px-3 py-2 text-[12px] text-rose-700 font-bold',
  grandBanner:
    'text-3xl font-black text-emerald-700 text-center py-2 bg-emerald-50 rounded-lg border border-emerald-200',
  grandBannerLabel: 'text-xs text-slate-600 block mb-1',
  grandBannerValue: '',
};

const themeFor = (v: Variant): Theme => (v === 'light' ? LIGHT : DARK);

/* ─────────────── Public component ─────────────── */

export interface SplitPaymentsEditorProps {
  /** Controlled rows array. Parent owns this state. */
  rows: SplitPaymentRow[];
  /** Receives the new rows array (pure — never mutated in place). */
  onChange: (rows: SplitPaymentRow[]) => void;
  /** Invoice grand total — drives summary, validation, default-row amount. */
  grandTotal: number;
  /**
   * Optional theme. POS uses the dark variant (default); the
   * invoice-edit modal uses the light variant.
   */
  variant?: Variant;
  /**
   * When true, the editor does not render the grand-total banner
   * (caller is showing it elsewhere — e.g. the invoice-edit modal
   * already has its own subtotal/grand row above the editor).
   */
  hideGrandTotalBanner?: boolean;
}

/**
 * Multi-row split-payments editor.
 *
 * The editor:
 *   - mounts its own React Query subscriptions for
 *     `payment-providers` + `payment-accounts` (both queries are
 *     cached at the React-Query layer, so simultaneous mounts in
 *     POS + edit are free).
 *   - auto-snaps any row whose method has lost all active accounts
 *     back to cash (preserves PR-PAY-3 invariant per-row).
 *   - renders the row list, the "+ إضافة وسيلة دفع" button, the
 *     summary panel (paid / remaining / change) and the validation
 *     banner.
 *   - does NOT render a confirm/cancel button — that stays in the
 *     parent so each consumer can wire its own submit semantics.
 */
export function SplitPaymentsEditor({
  rows,
  onChange,
  grandTotal,
  variant = 'dark',
  hideGrandTotalBanner = false,
}: SplitPaymentsEditorProps) {
  const t = themeFor(variant);

  const providersQuery = useQuery({
    queryKey: ['payment-providers'],
    queryFn: () => paymentsApi.listProviders(),
  });
  const accountsQuery = useQuery({
    queryKey: ['payment-accounts', 'active'],
    queryFn: () => paymentsApi.listAccounts({ active: true }),
  });

  const providers = providersQuery.data ?? [];
  const accounts = accountsQuery.data ?? [];

  // Snap any row whose method is no longer visible (admin
  // deactivated its only account) back to cash. Mirrors the legacy
  // PR-PAY-3 behavior, applied per-row. Same logic as PaymentModal.
  useEffect(() => {
    if (!accountsQuery.dataUpdatedAt) return;
    const visible = visibleMethodsFor(accounts);
    let mutated = false;
    const next = rows.map((r) => {
      if (visible.includes(r.method)) return r;
      mutated = true;
      return { ...r, method: 'cash' as PaymentMethodCode, payment_account_id: null };
    });
    if (mutated) onChange(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsQuery.dataUpdatedAt]);

  const accountsForMethod = (m: PaymentMethodCode) =>
    accounts.filter((a) => a.method === m);

  const updateRow = (uid: string, patch: Partial<SplitPaymentRow>) => {
    onChange(
      rows.map((r) => {
        if (r.uid !== uid) return r;
        const next = { ...r, ...patch };
        // When the method changes, recompute the account selection
        // using the same auto-select logic the legacy single-row
        // modal had: prefer the default-active account, else the
        // unique active account, else leave blank.
        if (patch.method && patch.method !== r.method) {
          if (patch.method === 'cash') {
            next.payment_account_id = null;
            next.account_display_name = null;
          } else {
            const candidates = accountsForMethod(patch.method);
            const def = candidates.find((a) => a.is_default);
            const auto =
              def ?? (candidates.length === 1 ? candidates[0] : null);
            next.payment_account_id = auto?.id ?? null;
            next.account_display_name = auto?.display_name ?? null;
          }
        }
        return next;
      }),
    );
  };

  const addRow = () => {
    // New row defaults to cash for the remaining amount (or 0 if
    // already overpaid). Cashier can change method/amount in-place.
    const summary = summarizeSplitPayments(rows, grandTotal);
    onChange([
      ...rows,
      {
        uid: makeRowUid(),
        method: 'cash',
        amount: Math.max(0, summary.remaining),
        payment_account_id: null,
      },
    ]);
  };

  const removeRow = (uid: string) => {
    if (rows.length <= 1) return;
    onChange(rows.filter((r) => r.uid !== uid));
  };

  const summary = summarizeSplitPayments(rows, grandTotal);
  const isAccountRequired = (m: PaymentMethodCode) =>
    m !== 'cash' && accountsForMethod(m).length > 0;
  const validation = validateSplitPayments(rows, grandTotal, {
    isAccountRequired,
  });

  return (
    <div className="space-y-4" data-testid="split-payments-editor">
      {/* Grand total banner — POS uses it; edit modal hides it. */}
      {!hideGrandTotalBanner && (
        <div>
          <label className={t.grandBannerLabel}>الإجمالي المطلوب</label>
          <div className={t.grandBanner}>{EGP(grandTotal)}</div>
        </div>
      )}

      {/* Payment rows */}
      <div className="space-y-3" data-testid="payment-rows">
        {rows.map((row, idx) => (
          <PaymentRow
            key={row.uid}
            row={row}
            index={idx}
            providers={providers}
            accounts={accounts}
            isOnlyRow={rows.length === 1}
            theme={t}
            onChange={(patch) => updateRow(row.uid, patch)}
            onRemove={() => removeRow(row.uid)}
          />
        ))}
      </div>

      {/* Add another payment method */}
      <button
        type="button"
        onClick={addRow}
        data-testid="payment-add-row"
        className={t.addRowBtn}
      >
        + إضافة وسيلة دفع
      </button>

      {/* Summary panel */}
      <div className={t.summaryWrap} data-testid="payment-summary">
        <div className="flex justify-between">
          <span className={t.summaryMutedText}>إجمالي الفاتورة</span>
          <span className={t.summaryGrand}>{EGP(grandTotal)}</span>
        </div>
        <div
          className="flex justify-between"
          data-testid="payment-summary-paid"
        >
          <span className={t.summaryMutedText}>إجمالي المدفوع</span>
          <span className={t.summaryPaid}>{EGP(summary.totalPaid)}</span>
        </div>
        {summary.remaining > 0.001 && (
          <div
            className="flex justify-between"
            data-testid="payment-summary-remaining"
          >
            <span className={t.summaryMutedText}>المتبقي (آجل)</span>
            <span className={t.summaryRemaining}>
              {EGP(summary.remaining)}
            </span>
          </div>
        )}
        {summary.change > 0.001 && (
          <div
            className="flex justify-between"
            data-testid="payment-summary-change"
          >
            <span className={t.summaryMutedText}>الباقي للعميل</span>
            <span className={t.summaryChange}>{EGP(summary.change)}</span>
          </div>
        )}
      </div>

      {/* Validation banner */}
      {!validation.ok && (
        <div className={t.validation} data-testid="payment-validation-error">
          {validation.reason}
        </div>
      )}
    </div>
  );
}

/* ─────────────── Internal components ─────────────── */

function PaymentRow({
  row,
  index,
  providers,
  accounts,
  isOnlyRow,
  theme,
  onChange,
  onRemove,
}: {
  row: SplitPaymentRow;
  index: number;
  providers: PaymentProvider[];
  accounts: PaymentAccount[];
  isOnlyRow: boolean;
  theme: Theme;
  onChange: (patch: Partial<SplitPaymentRow>) => void;
  onRemove: () => void;
}) {
  const visibleMethods = visibleMethodsFor(accounts);
  const accountsForRow = accounts.filter((a) => a.method === row.method);
  const isCash = row.method === 'cash';
  const blockedNoAccount = !isCash && accountsForRow.length === 0;

  return (
    <div
      className={theme.rowCard}
      data-testid="payment-row"
      data-row-index={index}
    >
      <div className="flex items-center justify-between gap-2">
        <span className={theme.rowSubdueText}>سطر #{index + 1}</span>
        {!isOnlyRow && (
          <button
            type="button"
            onClick={onRemove}
            data-testid={`payment-row-remove-${index}`}
            aria-label="حذف سطر الدفع"
            className={theme.removeBtn}
          >
            حذف
          </button>
        )}
      </div>

      {/* Method picker */}
      <PaymentMethodGrid
        providers={providers}
        accounts={accounts}
        selected={row.method}
        theme={theme}
        onSelect={(m) => onChange({ method: m })}
      />

      {/* Account picker for non-cash methods */}
      {!isCash && visibleMethods.includes(row.method) && (
        <PaymentAccountPicker
          method={row.method}
          providers={providers}
          accounts={accountsForRow}
          selected={row.payment_account_id}
          theme={theme}
          blocked={blockedNoAccount}
          needsManualPick={
            !isCash && accountsForRow.length > 1 && !row.payment_account_id
          }
          onSelect={(id) => {
            const acct = accountsForRow.find((a) => a.id === id) ?? null;
            onChange({
              payment_account_id: id,
              account_display_name: acct?.display_name ?? null,
            });
          }}
        />
      )}

      {/* Amount input */}
      <div>
        <label className={theme.amountLabel}>المبلغ</label>
        <input
          type="number"
          className={theme.amountInput}
          value={row.amount}
          onChange={(e) =>
            onChange({ amount: parseFloat(e.target.value) || 0 })
          }
          data-testid={`payment-row-amount-${index}`}
        />
      </div>
    </div>
  );
}

function PaymentMethodGrid({
  providers,
  accounts,
  selected,
  theme,
  onSelect,
}: {
  providers: PaymentProvider[];
  accounts: PaymentAccount[];
  selected: PaymentMethodCode;
  theme: Theme;
  onSelect: (m: PaymentMethodCode) => void;
}) {
  const visible = visibleMethodsFor(accounts);
  return (
    <div className="grid grid-cols-2 gap-2">
      {visible.map((m) => {
        const provider = providers.find((p) => p.method === m);
        const isSelected = selected === m;
        return (
          <button
            key={m}
            type="button"
            onClick={() => onSelect(m)}
            className={`p-3 rounded-lg font-bold border text-right transition ${
              isSelected ? theme.methodGridSelected : theme.methodGridIdle
            }`}
          >
            <div className="flex items-center gap-2 justify-between">
              <div className="flex items-center gap-2">
                <PaymentProviderLogo
                  logoKey={provider?.logo_key}
                  method={m}
                  name={provider?.name_ar ?? METHOD_LABEL_AR[m]}
                  size="sm"
                  decorative
                />
                <span className="text-sm">{METHOD_LABEL_AR[m]}</span>
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

function PaymentAccountPicker({
  method,
  providers,
  accounts,
  selected,
  theme,
  blocked,
  needsManualPick,
  onSelect,
}: {
  method: PaymentMethodCode;
  providers: PaymentProvider[];
  accounts: PaymentAccount[];
  selected: string | null;
  theme: Theme;
  blocked: boolean;
  needsManualPick: boolean;
  onSelect: (id: string) => void;
}) {
  if (blocked) {
    return (
      <div className={theme.accountBlocked}>
        لا يوجد حساب مفعل لهذه الطريقة. أضفه من إعدادات وسائل الدفع.
      </div>
    );
  }
  return (
    <div>
      <label className={theme.amountLabel}>حساب التحصيل</label>
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
              onClick={() => onSelect(a.id)}
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
        <div className={theme.accountManualHint}>
          اختر حساب التحصيل قبل المتابعة.
        </div>
      )}
    </div>
  );
}
