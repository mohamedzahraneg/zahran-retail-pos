import { api, unwrap } from './client';

// PR-PAY-2 — Frontend client for the PR-PAY-1 backend.
// Mirrors backend/src/payments/* — keep enum + provider shape in sync.

export type PaymentMethodCode =
  | 'cash'
  | 'card_visa'
  | 'card_mastercard'
  | 'card_meeza'
  | 'instapay'
  | 'vodafone_cash'
  | 'orange_cash'
  | 'wallet'         // PR-PAY-3.1: generic wallet umbrella (WE Pay, Bank Wallet, …)
  | 'bank_transfer'
  | 'check'          // PR-FIN-PAYACCT-4B: cheque/check accounts
  | 'credit'
  | 'other';

export type ProviderGroup =
  | 'cash'
  | 'instapay'
  | 'wallet'
  | 'card'
  | 'bank';

export interface PaymentProvider {
  provider_key: string;
  method: PaymentMethodCode;
  name_ar: string;
  name_en: string;
  icon_name: string;
  /** PR-PAY-6 — frontend asset filename (without extension) under
   *  `frontend/src/assets/payment-logos/`. */
  logo_key: string;
  default_gl_account_code: '1111' | '1113' | '1114' | '1115' | '1121';
  group: ProviderGroup;
  requires_reference: boolean;
}

export interface PaymentAccount {
  id: string;
  method: PaymentMethodCode;
  provider_key: string | null;
  display_name: string;
  identifier: string | null;
  gl_account_code: string;
  /**
   * PR-FIN-PAYACCT-4A — optional pin to a physical cashbox so balance
   * queries can disambiguate accounts that share a `gl_account_code`.
   * NULL = balance lives at gl_account_code level only.
   */
  cashbox_id: string | null;
  is_default: boolean;
  active: boolean;
  sort_order: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  created_by: string | null;
  updated_by: string | null;
}

export interface CreatePaymentAccountInput {
  method: PaymentMethodCode;
  provider_key?: string;
  display_name: string;
  identifier?: string;
  gl_account_code: string;
  is_default?: boolean;
  active?: boolean;
  sort_order?: number;
  metadata?: Record<string, unknown>;
}

export type UpdatePaymentAccountInput = Partial<
  Omit<CreatePaymentAccountInput, 'method'>
>;

export const paymentsApi = {
  listProviders: () =>
    unwrap<PaymentProvider[]>(api.get('/payment-providers')),

  listAccounts: (filter?: { method?: PaymentMethodCode; active?: boolean }) =>
    unwrap<PaymentAccount[]>(
      api.get('/payment-accounts', {
        params: {
          method: filter?.method,
          active:
            filter?.active === undefined
              ? undefined
              : filter.active
                ? 'true'
                : 'false',
        },
      }),
    ),

  getAccount: (id: string) =>
    unwrap<PaymentAccount>(api.get(`/payment-accounts/${id}`)),

  createAccount: (body: CreatePaymentAccountInput) =>
    unwrap<PaymentAccount>(api.post('/payment-accounts', body)),

  updateAccount: (id: string, body: UpdatePaymentAccountInput) =>
    unwrap<PaymentAccount>(api.patch(`/payment-accounts/${id}`, body)),

  deactivate: (id: string) =>
    unwrap<PaymentAccount>(api.patch(`/payment-accounts/${id}/deactivate`)),

  setDefault: (id: string) =>
    unwrap<PaymentAccount>(api.patch(`/payment-accounts/${id}/set-default`)),

  // PR-FIN-PAYACCT-4C — symmetric flip; activating leaves is_default
  // alone, deactivating force-clears it. Backed by POST endpoint.
  toggleActive: (id: string) =>
    unwrap<PaymentAccount>(api.post(`/payment-accounts/${id}/toggle-active`)),

  // PR-FIN-PAYACCT-4C — safe delete: hard-delete if unused, soft if
  // referenced by any invoice/customer/supplier payment row. Returns
  // {id, mode: 'soft' | 'hard'}.
  deleteAccount: (id: string) =>
    unwrap<{ id: string; mode: 'soft' | 'hard' }>(
      api.delete(`/payment-accounts/${id}`),
    ),

  // PR-FIN-PAYACCT-4B — admin page balance + KPI source. Joins
  // payment_accounts × v_payment_account_balance. Inactive rows
  // returned with je_count=0 / last_movement=null.
  listBalances: (filter?: { method?: PaymentMethodCode; active?: boolean }) =>
    unwrap<PaymentAccountBalance[]>(
      api.get('/payment-accounts/balances', {
        params: {
          method: filter?.method,
          active:
            filter?.active === undefined
              ? undefined
              : filter.active
                ? 'true'
                : 'false',
        },
      }),
    ),
};

/**
 * PR-FIN-PAYACCT-4B — payment account row enriched with the
 * `v_payment_account_balance` columns. Used by the admin page.
 *
 * NOTE: the server SELECT aliases `pa.id::text AS payment_account_id`
 * (not `id`) so the FE row shape exposes `payment_account_id`. This
 * keeps the response unambiguous when both `cashbox_id` and the
 * account's primary key appear on the same row.
 */
export interface PaymentAccountBalance {
  payment_account_id: string;
  method: PaymentMethodCode;
  provider_key: string | null;
  display_name: string;
  identifier: string | null;
  gl_account_code: string;
  cashbox_id: string | null;
  is_default: boolean;
  active: boolean;
  sort_order: number;
  metadata: Record<string, unknown>;
  /** Arabic GL account name from chart_of_accounts (joined). */
  gl_name_ar: string | null;
  /** "debit" | "credit" — for sign-aware UI. */
  normal_balance: 'debit' | 'credit' | null;
  total_in: string;       // pg numeric → string
  total_out: string;
  net_debit: string;
  je_count: number;
  /** ISO date YYYY-MM-DD or null when no movements yet. */
  last_movement: string | null;
}

/**
 * PR-FIN-PAYACCT-4B — per-cashbox stored vs GL drift, used by the
 * admin page's accounting-alerts panel. Sourced from
 * `v_cashbox_gl_drift` via GET /cash-desk/gl-drift.
 */
export interface CashboxGlDrift {
  cashbox_id: string;
  cashbox_name: string;
  kind: 'cash' | 'bank' | 'ewallet' | 'check';
  is_active: boolean;
  stored_balance: string;
  gl_total_dr: string;
  gl_total_cr: string;
  gl_net: string;
  drift_amount: string;
}

// ────────────────────────────────────────────────────────────────────
// Display helpers shared by admin + (eventually) POS

export const METHOD_LABEL_AR: Record<PaymentMethodCode, string> = {
  cash: 'كاش',
  card_visa: 'فيزا',
  card_mastercard: 'ماستركارد',
  card_meeza: 'ميزة',
  instapay: 'إنستا باي',
  vodafone_cash: 'فودافون كاش',
  orange_cash: 'أورانج كاش',
  wallet: 'محفظة إلكترونية',  // PR-PAY-3.1
  bank_transfer: 'تحويل بنكي',
  check: 'شيكات',             // PR-FIN-PAYACCT-4B
  credit: 'آجل',
  other: 'أخرى',
};

export const GROUP_LABEL_AR: Record<ProviderGroup, string> = {
  cash: 'كاش',
  instapay: 'إنستا باي',
  wallet: 'محافظ إلكترونية',
  card: 'فيزا / كروت',
  bank: 'تحويلات بنكية',
};

/** Group accounts by their provider group (cash / instapay / wallet / card / bank). */
export function groupAccountsByProviderGroup(
  accounts: PaymentAccount[],
  providers: PaymentProvider[],
): Record<ProviderGroup, PaymentAccount[]> {
  const providerByMethod = new Map<PaymentMethodCode, PaymentProvider>();
  for (const p of providers) {
    if (!providerByMethod.has(p.method)) providerByMethod.set(p.method, p);
  }
  const out: Record<ProviderGroup, PaymentAccount[]> = {
    cash: [],
    instapay: [],
    wallet: [],
    card: [],
    bank: [],
  };
  for (const a of accounts) {
    const provider =
      providers.find((p) => p.provider_key === a.provider_key) ??
      providerByMethod.get(a.method);
    const group: ProviderGroup = provider?.group ?? methodFallbackGroup(a.method);
    out[group].push(a);
  }
  return out;
}

function methodFallbackGroup(method: PaymentMethodCode): ProviderGroup {
  if (method === 'cash') return 'cash';
  if (method === 'instapay') return 'instapay';
  if (method === 'vodafone_cash' || method === 'orange_cash') return 'wallet';
  if (method.startsWith('card_')) return 'card';
  if (method === 'bank_transfer') return 'bank';
  return 'wallet';
}
