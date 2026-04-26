import { getPaymentLogo } from '@/lib/paymentLogos';

/**
 * PR-PAY-6 + PR-PAY-7 — Renders a payment provider's brand logo.
 *
 * Resolution order (first hit wins):
 *   1. `logoDataUrl` — operator dragged-and-dropped a custom file in
 *      Settings; stored as base64 data URL in
 *      payment_accounts.metadata.logo_data_url. Wins so receipts can
 *      render offline.
 *   2. `logoUrl` — operator pasted a remote URL in Settings; stored
 *      in payment_accounts.metadata.logo_url. Subject to network
 *      reachability.
 *   3. `logoKey` — bundled asset under
 *      `frontend/src/assets/payment-logos/{logoKey}.{svg|png|...}`
 *      resolved by `getPaymentLogo`.
 *   4. Method group fallback — `wallet-other` / `card-other` /
 *      `bank-other` based on `method`.
 *   5. Coloured initials avatar — when nothing else is available.
 *
 * Rendering style:
 *   • When a real image is available (any of 1-3), the component
 *     renders the image NAKED — no border, no background, just
 *     `object-contain` inside the requested box. This matches the
 *     operator's spec: "تتكيف على مساحة واضحة بدون إطار ولا خلفية".
 *   • Initials fallback (5) keeps the coloured rounded chrome so the
 *     row stays scannable when no logo is available.
 *
 * Sizes:
 *   sm = 24px  (table rows, dropdown options)
 *   md = 36px  (card chips, modal selects)
 *   lg = 56px  (hero summary cards)
 */
export interface PaymentProviderLogoProps {
  /** PR-PAY-7 — operator-uploaded base64 data URL (highest priority). */
  logoDataUrl?: string | null;
  /** PR-PAY-7 — operator-pasted remote URL (second priority). */
  logoUrl?: string | null;
  /** Stable key into `frontend/src/assets/payment-logos/`. */
  logoKey?: string | null;
  /** Used for the group-fallback when other sources are missing. */
  method?: string | null;
  /** Display name — alt text + initials fallback. */
  name?: string | null;
  size?: 'sm' | 'md' | 'lg';
  /** Optional className for additional styling on the wrapper. */
  className?: string;
  /** Hide the alt text from screen readers (decorative use). */
  decorative?: boolean;
}

const SIZE_PX: Record<'sm' | 'md' | 'lg', number> = {
  sm: 24,
  md: 36,
  lg: 56,
};

const FONT_SIZE: Record<'sm' | 'md' | 'lg', string> = {
  sm: '10px',
  md: '12px',
  lg: '16px',
};

function initials(name?: string | null): string {
  if (!name) return '•';
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => Array.from(p)[0] ?? '').join('') || '•';
}

/**
 * Sink-side allow-list for the `<img src>` value.
 *
 * The `src` flows in from props that originate at DOM-text sources
 * (FileReader result for drag-dropped files, `<input>` value for
 * URL paste). The LogoPicker already validates at the source — this
 * is defense-in-depth at the sink, also makes the dataflow explicit
 * for CodeQL's `js/xss-through-dom` analysis.
 *
 * Allowed:
 *   • Vite-bundled relative URLs (`/assets/...`, `/payment-logos/...`)
 *   • absolute http(s) URLs the operator pasted
 *   • base64 data URLs ONLY for raster image formats (no SVG, no
 *     `data:text/html`, no `javascript:`)
 *
 * Anything else returns `null` — the component falls through to the
 * initials avatar instead of binding the unsafe value to img.src.
 */
const SAFE_IMG_SRC =
  /^(\/|https?:\/\/|data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$)/i;

function sanitizeImgSrc(candidate: string | null | undefined): string | null {
  if (!candidate) return null;
  return SAFE_IMG_SRC.test(candidate) ? candidate : null;
}

export function PaymentProviderLogo({
  logoDataUrl,
  logoUrl,
  logoKey,
  method,
  name,
  size = 'md',
  className,
  decorative,
}: PaymentProviderLogoProps) {
  // Resolution order — dataUrl > url > catalog > group fallback.
  // Pass through `sanitizeImgSrc` so an attacker-influenced value
  // (e.g. `javascript:` or SVG-with-script data URL) can never reach
  // <img src>. Vite-bundled assets (relative URLs) always pass.
  const candidate =
    (logoDataUrl && logoDataUrl.trim()) ||
    (logoUrl && logoUrl.trim()) ||
    getPaymentLogo(logoKey, method);
  const src = sanitizeImgSrc(candidate);

  const px = SIZE_PX[size];
  const wrapperStyle: React.CSSProperties = {
    width: px,
    height: px,
    minWidth: px,
    minHeight: px,
  };

  if (src) {
    // Naked render — no border, no background. The image fills the
    // box via object-contain, blends into whatever surrounds it.
    return (
      <span
        className={`inline-flex items-center justify-center shrink-0 ${className ?? ''}`}
        style={wrapperStyle}
      >
        <img
          src={src}
          alt={decorative ? '' : (name ?? '')}
          aria-hidden={decorative || undefined}
          className="block w-full h-full object-contain"
          loading="lazy"
          draggable={false}
        />
      </span>
    );
  }

  // Initials fallback keeps the chrome so the row remains scannable.
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md bg-slate-100 text-slate-700 border border-slate-200 font-bold shrink-0 ${className ?? ''}`}
      style={{ ...wrapperStyle, fontSize: FONT_SIZE[size] }}
      aria-label={decorative ? undefined : (name ?? 'payment provider')}
      role={decorative ? undefined : 'img'}
    >
      {initials(name)}
    </span>
  );
}
