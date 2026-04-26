/**
 * PR-PAY-6 — Frontend resolver for payment provider logos.
 *
 * Maps a stable `logo_key` (e.g. "vodafone-cash", "we-pay", "visa")
 * to a Vite-bundled asset URL.
 *
 * Drop-in contract (post-iteration with the operator):
 *   • Drop any file at `frontend/src/assets/payment-logos/{logo_key}.{ext}`
 *     where `{ext}` ∈ { svg, png, jpg, jpeg, webp }.
 *   • If both a placeholder SVG and a real PNG exist for the same key,
 *     the real raster wins (PRIORITY rule below) — so dropping
 *     `vodafone-cash.png` next to `vodafone-cash.svg` immediately
 *     replaces the placeholder on the next build with **no code change
 *     required**.
 *   • Strategy when the key has no asset at all:
 *       1) Try the requested key.
 *       2) Try the group-fallback (`wallet-other`, `card-other`,
 *          `bank-other`) inferred from the method.
 *       3) Return null — the consumer renders initials/icon.
 *
 * Strict rules (held since the original PR):
 *   • Never hotlink remote URLs.
 *   • Never bundle third-party copyrighted art.
 *   • Placeholders are first-party SVGs (brand colour + initials).
 */

// Vite build-time discovery — every file in the directory is captured
// at build time. New files appear automatically on next build; deletions
// disappear; replacements get re-hashed URLs.
const modules = import.meta.glob(
  '@/assets/payment-logos/*.{svg,png,jpg,jpeg,webp}',
  { eager: true, query: '?url', import: 'default' },
);

// Higher rank wins when multiple extensions exist for the same key.
// The intent: real assets the operator drops in (typically PNG/WEBP)
// override the bundled placeholder SVGs without removing the SVG.
const EXT_PRIORITY: Record<string, number> = {
  png: 5,
  webp: 4,
  jpg: 3,
  jpeg: 3,
  svg: 1,
};

function buildLogoMap(): Record<string, string> {
  const tmp: Record<string, { url: string; rank: number }> = {};
  for (const [path, asset] of Object.entries(modules)) {
    const fname = path.split('/').pop();
    if (!fname) continue;
    const dot = fname.lastIndexOf('.');
    if (dot <= 0) continue;
    const key = fname.slice(0, dot);
    const ext = fname.slice(dot + 1).toLowerCase();
    const rank = EXT_PRIORITY[ext] ?? 0;
    if (!tmp[key] || rank > tmp[key].rank) {
      tmp[key] = { url: asset as string, rank };
    }
  }
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(tmp)) out[k] = v.url;
  return out;
}

const PAYMENT_LOGOS: Record<string, string> = buildLogoMap();

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

/** Sorted list of all known logo keys — used by tests + admin UI hints. */
export const KNOWN_LOGO_KEYS = Object.keys(PAYMENT_LOGOS).sort();
