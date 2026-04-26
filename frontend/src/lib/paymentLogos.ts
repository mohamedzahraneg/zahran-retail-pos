/**
 * PR-PAY-6 — Frontend resolver for payment provider logos.
 *
 * Maps a stable `logo_key` (e.g. "vodafone-cash", "we-pay", "visa")
 * to a Vite-imported asset URL. The asset itself lives under
 * `frontend/src/assets/payment-logos/{logo_key}.svg`. Vite hashes the
 * URL at build time, so swapping the file is a frame-perfect
 * replacement — no code change needed.
 *
 * The 22 entries cover every provider in the backend
 * `providers.catalog.ts` plus generic fallbacks (wallet-other,
 * card-other, bank-other) for unknown providers and a `cash` badge.
 *
 * Strategy when the key is missing or unmapped:
 *   1. Try the requested key.
 *   2. Try the group-fallback (`wallet-other`, `card-other`,
 *      `bank-other`) inferred from the method.
 *   3. Return null — the consumer renders initials/icon instead.
 *
 * NEVER hotlink remote URLs and NEVER bundle third-party copyrighted
 * art. The current set is placeholder badges (brand colour + initials);
 * real licensed assets can replace them by overwriting the file.
 */

import cash from '@/assets/payment-logos/cash.svg';
import instapay from '@/assets/payment-logos/instapay.svg';
import vodafoneCash from '@/assets/payment-logos/vodafone-cash.svg';
import orangeCash from '@/assets/payment-logos/orange-cash.svg';
import etisalatCash from '@/assets/payment-logos/etisalat-cash.svg';
import wePay from '@/assets/payment-logos/we-pay.svg';
import bankWallet from '@/assets/payment-logos/bank-wallet.svg';
import walletOther from '@/assets/payment-logos/wallet-other.svg';
import visa from '@/assets/payment-logos/visa.svg';
import mastercard from '@/assets/payment-logos/mastercard.svg';
import meeza from '@/assets/payment-logos/meeza.svg';
import posTerminal from '@/assets/payment-logos/pos-terminal.svg';
import cardOther from '@/assets/payment-logos/card-other.svg';
import nbe from '@/assets/payment-logos/nbe.svg';
import banqueMisr from '@/assets/payment-logos/banque-misr.svg';
import cib from '@/assets/payment-logos/cib.svg';
import qnb from '@/assets/payment-logos/qnb.svg';
import alexbank from '@/assets/payment-logos/alexbank.svg';
import banqueDuCaire from '@/assets/payment-logos/banque-du-caire.svg';
import aaib from '@/assets/payment-logos/aaib.svg';
import adib from '@/assets/payment-logos/adib.svg';
import bankOther from '@/assets/payment-logos/bank-other.svg';

const PAYMENT_LOGOS: Record<string, string> = {
  cash,
  instapay,
  'vodafone-cash': vodafoneCash,
  'orange-cash': orangeCash,
  'etisalat-cash': etisalatCash,
  'we-pay': wePay,
  'bank-wallet': bankWallet,
  'wallet-other': walletOther,
  visa,
  mastercard,
  meeza,
  'pos-terminal': posTerminal,
  'card-other': cardOther,
  nbe,
  'banque-misr': banqueMisr,
  cib,
  qnb,
  alexbank,
  'banque-du-caire': banqueDuCaire,
  aaib,
  adib,
  'bank-other': bankOther,
};

/** Method → group fallback `logo_key` when the provider's own key is missing. */
const METHOD_GROUP_FALLBACK: Record<string, string> = {
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

export function getPaymentLogo(
  logoKey?: string | null,
  method?: string | null,
): string | null {
  if (logoKey && PAYMENT_LOGOS[logoKey]) return PAYMENT_LOGOS[logoKey];
  const fallback = method ? METHOD_GROUP_FALLBACK[method] : undefined;
  if (fallback && PAYMENT_LOGOS[fallback]) return PAYMENT_LOGOS[fallback];
  return null;
}

/** Lower-cased deduped list of all known logo keys — used by tests + admin UI hints. */
export const KNOWN_LOGO_KEYS = Object.keys(PAYMENT_LOGOS);
