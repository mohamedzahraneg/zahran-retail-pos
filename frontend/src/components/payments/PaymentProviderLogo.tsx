import { getPaymentLogo } from '@/lib/paymentLogos';

/**
 * PR-PAY-6 + PR-PAY-7 (Option C) — Renders a payment provider's
 * brand logo from one of two trusted sources only:
 *
 *   1. `logoDataUrl` — operator dragged-and-dropped a raster image
 *      file in Settings; stored as `data:image/(png|jpeg|webp);base64,…`
 *      in `payment_accounts.metadata.logo_data_url`. Works offline.
 *      Validated at upload time (LogoPicker) and again at render
 *      time (sanitizeImgSrc).
 *
 *   2. `logoKey` — bundled asset under
 *      `frontend/src/assets/payment-logos/{logoKey}.{svg|png|...}`
 *      resolved by `getPaymentLogo` to a Vite-hashed relative URL.
 *
 * Method group fallback (`wallet-other` / `card-other` / `bank-other`)
 * applies when `logoKey` doesn't resolve.
 *
 * If neither source produces a sanitized value, the component
 * renders a coloured initials avatar instead.
 *
 * NO external HTTP(S) URLs. NO `logoUrl` prop. NO hotlinks.
 *
 * Rendering style:
 *   • Naked image (no border, no background, `object-contain`) when a
 *     real source resolves.
 *   • Initials fallback keeps the chrome so the row stays scannable.
 *
 * Sizes:
 *   sm = 24px  (table rows, dropdown options)
 *   md = 36px  (card chips, modal selects)
 *   lg = 56px  (hero summary cards)
 */
export interface PaymentProviderLogoProps {
  /** Operator-uploaded base64 data URL (raster only, validated). */
  logoDataUrl?: string | null;
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
 * Sink-side sanitizer for the `<img src>` value.
 *
 * PR-PAY-7 / Option C — the URL paste field was removed from
 * LogoPicker entirely. Logos can ONLY come from two trusted sources:
 *
 *   1. Vite-bundled relative URLs (the placeholder/real catalog
 *      assets under `frontend/src/assets/payment-logos/`). Vite
 *      hashes the URL at build time, so the value is always a
 *      same-origin relative path like `/assets/instapay-abc.svg`.
 *
 *   2. Operator-uploaded raster image files, validated at upload
 *      time in LogoPicker (PNG/JPG/WebP/GIF only, MIME-checked,
 *      80KB cap), then encoded as `data:image/(png|jpe?g|webp);base64,…`.
 *
 * Anything else — http(s) URLs, javascript:, vbscript:, file:,
 * data:text/html, data:image/svg+xml, blob:, protocol-relative
 * `//host/...`, malformed strings — is rejected outright. The
 * consumer must fall through to the initials avatar instead of
 * binding the unsafe value to `<img src>`.
 *
 * No external image hosting is supported by design (operator
 * directive: "we don't want hotlinks; logos are local files only").
 */
const SAFE_DATA_URL =
  /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/i;

export function sanitizeImgSrc(
  candidate: string | null | undefined,
): string | null {
  if (typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;

  // Same-origin relative URL (Vite-bundled assets). Reject protocol-
  // relative `//host/...` which would resolve to an attacker domain.
  if (trimmed.startsWith('/') && !trimmed.startsWith('//')) {
    return trimmed;
  }

  // Data URL — only raster images, base64-encoded. Strict prefix
  // check covers MIME (no svg+xml/text/html/application/*) and
  // payload format (no `data:image/png,raw-bytes`). The URL
  // constructor isn't needed: we never accept any non-data
  // absolute URL, so there's no protocol comparison surface.
  if (SAFE_DATA_URL.test(trimmed)) {
    return trimmed;
  }

  // Anything else — http(s), javascript:, file:, blob:, etc. — is
  // rejected. The operator directive is "no external hotlinks".
  return null;
}

export function PaymentProviderLogo({
  logoDataUrl,
  logoKey,
  method,
  name,
  size = 'md',
  className,
  decorative,
}: PaymentProviderLogoProps) {
  // Resolution order — operator-uploaded data URL > catalog asset >
  // group fallback. Pass through `sanitizeImgSrc` so an attacker-
  // influenced data URL (e.g. SVG-with-script or text/html) can
  // never reach `<img src>`. Vite-bundled assets always pass.
  const candidate =
    (logoDataUrl && logoDataUrl.trim()) ||
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
