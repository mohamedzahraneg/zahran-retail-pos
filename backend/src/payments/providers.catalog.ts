/**
 * PR-PAY-1 — Static provider catalog.
 *
 * Each entry is a "kind of channel an admin might create an account
 * for" — InstaPay, Vodafone Cash, a Visa POS terminal, NBE bank
 * transfer, etc. The frontend (PAY-2 admin / PAY-3 POS) reads this
 * via `GET /payment-providers` to render rich pickers.
 *
 * Strict rules baked in:
 *   • method matches the existing `payment_method_code` enum exactly.
 *     We do NOT extend the enum here; if a provider has no good fit
 *     today (e.g. "wallet umbrella"), we map it to the closest
 *     existing value.
 *   • default_gl_account_code uses ONLY accounts already present in
 *     chart_of_accounts (1111 cash, 1113 bank/card, 1114 e-wallet,
 *     1115 check). We do not invent codes.
 *   • icon_name is a Lucide-react identifier the frontend resolves
 *     locally — no external logo URLs, no copyrighted assets bundled.
 *     Admins can later upload custom logos via PAY-2; the metadata
 *     column on payment_accounts can carry a logo_url then.
 */

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
  | 'check'          // PR-FIN-PAYACCT-4B: cheque/check accounts in admin UI
  | 'credit'
  | 'other';

export interface PaymentProvider {
  provider_key: string;
  method: PaymentMethodCode;
  name_ar: string;
  name_en: string;
  icon_name: string;
  /**
   * PR-PAY-6 — Stable key into `frontend/src/assets/payment-logos/{logo_key}.svg`.
   * The asset itself is loaded by the frontend resolver. Backend never
   * loads the file; it just propagates the key into responses (and into
   * `payment_account_snapshot` for invoice receipts).
   */
  logo_key: string;
  default_gl_account_code: '1111' | '1113' | '1114' | '1115' | '1121';
  /** UI grouping hint — "cash" / "instapay" / "wallet" / "card" / "bank". */
  group: 'cash' | 'instapay' | 'wallet' | 'card' | 'bank';
  /**
   * Whether the POS UI should ask the cashier for a per-payment
   * reference (handle, transaction id, last-4, IBAN snippet).
   */
  requires_reference: boolean;
}

export const PAYMENT_PROVIDERS: PaymentProvider[] = [
  // Cash
  {
    provider_key: 'cash',
    logo_key: 'cash',
    method: 'cash',
    name_ar: 'كاش',
    name_en: 'Cash',
    icon_name: 'Banknote',
    default_gl_account_code: '1111',
    group: 'cash',
    requires_reference: false,
  },

  // InstaPay (single provider, multiple admin-defined accounts)
  {
    provider_key: 'instapay',
    logo_key: 'instapay',
    method: 'instapay',
    name_ar: 'إنستا باي',
    name_en: 'InstaPay',
    icon_name: 'Smartphone',
    default_gl_account_code: '1114',
    group: 'instapay',
    requires_reference: true,
  },

  // Wallets
  {
    provider_key: 'vodafone_cash',
    logo_key: 'vodafone-cash',
    method: 'vodafone_cash',
    name_ar: 'فودافون كاش',
    name_en: 'Vodafone Cash',
    icon_name: 'Wallet',
    default_gl_account_code: '1114',
    group: 'wallet',
    requires_reference: true,
  },
  {
    provider_key: 'orange_cash',
    logo_key: 'orange-cash',
    method: 'orange_cash',
    name_ar: 'أورانج كاش',
    name_en: 'Orange Cash',
    icon_name: 'Wallet',
    default_gl_account_code: '1114',
    group: 'wallet',
    requires_reference: true,
  },
  // PR-PAY-3.1 — Non-telco wallets now route to the generic `wallet`
  // enum value (added by migration 113). Vodafone Cash and Orange
  // Cash keep their dedicated enum values for backward compat with
  // historical invoice_payments rows. New cashier sales for any of
  // the three wallets below land on payment_method='wallet' and
  // GL 1114.
  {
    provider_key: 'etisalat_cash',
    logo_key: 'etisalat-cash',
    method: 'wallet',
    name_ar: 'اتصالات كاش',
    name_en: 'Etisalat Cash',
    icon_name: 'Wallet',
    default_gl_account_code: '1114',
    group: 'wallet',
    requires_reference: true,
  },
  {
    provider_key: 'we_pay',
    logo_key: 'we-pay',
    method: 'wallet',
    name_ar: 'WE Pay',
    name_en: 'WE Pay',
    icon_name: 'Wallet',
    default_gl_account_code: '1114',
    group: 'wallet',
    requires_reference: true,
  },
  {
    provider_key: 'bank_wallet',
    logo_key: 'bank-wallet',
    method: 'wallet',
    name_ar: 'محفظة بنكية',
    name_en: 'Bank Wallet',
    icon_name: 'Wallet',
    default_gl_account_code: '1114',
    group: 'wallet',
    requires_reference: true,
  },

  // Cards / POS terminals
  {
    provider_key: 'visa',
    logo_key: 'visa',
    method: 'card_visa',
    name_ar: 'فيزا',
    name_en: 'Visa',
    icon_name: 'CreditCard',
    default_gl_account_code: '1113',
    group: 'card',
    requires_reference: true,
  },
  {
    provider_key: 'mastercard',
    logo_key: 'mastercard',
    method: 'card_mastercard',
    name_ar: 'ماستركارد',
    name_en: 'MasterCard',
    icon_name: 'CreditCard',
    default_gl_account_code: '1113',
    group: 'card',
    requires_reference: true,
  },
  {
    provider_key: 'meeza',
    logo_key: 'meeza',
    method: 'card_meeza',
    name_ar: 'ميزة',
    name_en: 'Meeza',
    icon_name: 'CreditCard',
    default_gl_account_code: '1113',
    group: 'card',
    requires_reference: true,
  },
  {
    provider_key: 'pos_terminal',
    logo_key: 'pos-terminal',
    method: 'card_visa',
    name_ar: 'ماكينة POS',
    name_en: 'POS Terminal',
    icon_name: 'CreditCard',
    default_gl_account_code: '1113',
    group: 'card',
    requires_reference: true,
  },

  // Banks (bank_transfer)
  {
    provider_key: 'nbe',
    logo_key: 'nbe',
    method: 'bank_transfer',
    name_ar: 'البنك الأهلي المصري',
    name_en: 'National Bank of Egypt',
    icon_name: 'Landmark',
    default_gl_account_code: '1113',
    group: 'bank',
    requires_reference: true,
  },
  {
    provider_key: 'banque_misr',
    logo_key: 'banque-misr',
    method: 'bank_transfer',
    name_ar: 'بنك مصر',
    name_en: 'Banque Misr',
    icon_name: 'Landmark',
    default_gl_account_code: '1113',
    group: 'bank',
    requires_reference: true,
  },
  {
    provider_key: 'cib',
    logo_key: 'cib',
    method: 'bank_transfer',
    name_ar: 'البنك التجاري الدولي (CIB)',
    name_en: 'CIB',
    icon_name: 'Landmark',
    default_gl_account_code: '1113',
    group: 'bank',
    requires_reference: true,
  },
  {
    provider_key: 'qnb',
    logo_key: 'qnb',
    method: 'bank_transfer',
    name_ar: 'QNB الأهلي',
    name_en: 'QNB Al-Ahli',
    icon_name: 'Landmark',
    default_gl_account_code: '1113',
    group: 'bank',
    requires_reference: true,
  },
  {
    provider_key: 'alex_bank',
    logo_key: 'alexbank',
    method: 'bank_transfer',
    name_ar: 'بنك الإسكندرية',
    name_en: 'AlexBank',
    icon_name: 'Landmark',
    default_gl_account_code: '1113',
    group: 'bank',
    requires_reference: true,
  },
  {
    provider_key: 'banque_du_caire',
    logo_key: 'banque-du-caire',
    method: 'bank_transfer',
    name_ar: 'بنك القاهرة',
    name_en: 'Banque du Caire',
    icon_name: 'Landmark',
    default_gl_account_code: '1113',
    group: 'bank',
    requires_reference: true,
  },
  {
    provider_key: 'aaib',
    logo_key: 'aaib',
    method: 'bank_transfer',
    name_ar: 'البنك العربي الأفريقي الدولي',
    name_en: 'AAIB',
    icon_name: 'Landmark',
    default_gl_account_code: '1113',
    group: 'bank',
    requires_reference: true,
  },
  {
    provider_key: 'adib',
    logo_key: 'adib',
    method: 'bank_transfer',
    name_ar: 'مصرف أبو ظبي الإسلامي',
    name_en: 'ADIB',
    icon_name: 'Landmark',
    default_gl_account_code: '1113',
    group: 'bank',
    requires_reference: true,
  },
  // PR-FIN-PAYACCT-4B — cheque/check accounts. The Admin UI ships a
  // generic "شيكات" provider so operators can create cheque-account
  // rows in payment_accounts (DTO method 'check', GL 1115). Specific
  // bank-as-cheque-issuer providers will be added in PR-FIN-PAYACCT-4E
  // with explicit per-source approval for each official logo. Today
  // the FE renders the initials-avatar fallback when `logo_key` does
  // not have an asset on disk — that's expected for `check_other`
  // until an approved cheque logo source lands.
  {
    provider_key: 'check_other',
    logo_key: 'check_other',
    method: 'check',
    name_ar: 'شيكات',
    name_en: 'Cheques',
    icon_name: 'FileCheck',
    default_gl_account_code: '1115',
    group: 'bank',           // closest existing group; check has no dedicated group on the FE side yet
    requires_reference: true, // cheque book number / serial is required
  },
];

/**
 * Method → default GL code map. Exhaustive over `payment_method_code`
 * — every enum value is present, so the posting service can lookup by
 * method without a silent fallback. `credit` lands on 1121 receivables
 * (the same account the existing unpaid-portion logic uses).
 *
 * `other` is intentionally NOT in this map — posting must throw if a
 * payment row with method=other arrives without an explicit
 * payment_account.gl_account_code.
 */
export const METHOD_DEFAULT_GL_CODE: Record<
  Exclude<PaymentMethodCode, 'other'>,
  string
> = {
  cash: '1111',
  card_visa: '1113',
  card_mastercard: '1113',
  card_meeza: '1113',
  instapay: '1114',
  vodafone_cash: '1114',
  orange_cash: '1114',
  wallet: '1114',         // PR-PAY-3.1: generic wallet umbrella
  bank_transfer: '1113',
  check: '1115',          // PR-FIN-PAYACCT-4B: الشيكات تحت التحصيل
  credit: '1121',
};

/** Methods that move physical cash and therefore require a CT row. */
export const CASH_METHODS: ReadonlySet<PaymentMethodCode> = new Set(['cash']);

export function isCashMethod(method: string): boolean {
  return CASH_METHODS.has(method as PaymentMethodCode);
}

/**
 * PR-PAY-6 — Method → group-fallback `logo_key` when a payment_account
 * has no `provider_key` (or its provider isn't in the catalog). Mirrors
 * the frontend resolver's METHOD_GROUP_FALLBACK so snapshots written by
 * the backend resolve to the same image the cashier saw at sale time.
 */
const METHOD_LOGO_FALLBACK: Record<string, string> = {
  cash: 'cash',
  instapay: 'instapay',
  vodafone_cash: 'wallet-other',
  orange_cash: 'wallet-other',
  wallet: 'wallet-other',
  card_visa: 'card-other',
  card_mastercard: 'card-other',
  card_meeza: 'card-other',
  bank_transfer: 'bank-other',
  credit: 'card-other',
  other: 'wallet-other',
};

/**
 * Resolve the `logo_key` to snapshot for a given (provider_key, method).
 * Looks up the provider catalog first; falls back to method-level group
 * default when provider_key is missing or unknown. Returns null when
 * neither matches — caller should leave the snapshot field absent.
 */
export function resolveLogoKey(
  providerKey: string | null | undefined,
  method: string | null | undefined,
): string | null {
  if (providerKey) {
    const hit = PAYMENT_PROVIDERS.find((p) => p.provider_key === providerKey);
    if (hit) return hit.logo_key;
  }
  if (method && METHOD_LOGO_FALLBACK[method]) {
    return METHOD_LOGO_FALLBACK[method];
  }
  return null;
}
