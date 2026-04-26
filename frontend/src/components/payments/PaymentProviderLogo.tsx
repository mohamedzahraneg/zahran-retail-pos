import { getPaymentLogo } from '@/lib/paymentLogos';

/**
 * PR-PAY-6 — Renders a payment provider's brand logo, falling back to
 * Arabic-friendly initials inside a coloured circle when the logo
 * isn't bundled. Used everywhere a payment method/account is shown
 * (Settings → حسابات التحصيل, POS payment grid + account picker,
 * Shift-close cards, Dashboard channel chips, Receipt).
 *
 * Sizes:
 *   sm = 24px  (table rows, dropdown options)
 *   md = 36px  (card chips, modal selects)
 *   lg = 56px  (hero summary cards)
 */
export interface PaymentProviderLogoProps {
  /** Stable key into `frontend/src/assets/payment-logos/`. Optional —
   *  when missing, the resolver falls back to the method group default
   *  (wallet-other / card-other / bank-other). */
  logoKey?: string | null;
  /** Used for the group-fallback when logoKey is missing. */
  method?: string | null;
  /** Display name — used as the alt text and for initials fallback. */
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
  // Take the first 2 graphemes of the first 1-2 words.
  const parts = name.trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => Array.from(p)[0] ?? '').join('') || '•';
}

export function PaymentProviderLogo({
  logoKey,
  method,
  name,
  size = 'md',
  className,
  decorative,
}: PaymentProviderLogoProps) {
  const url = getPaymentLogo(logoKey, method);
  const px = SIZE_PX[size];
  const wrapperStyle: React.CSSProperties = {
    width: px,
    height: px,
    minWidth: px,
    minHeight: px,
  };

  if (url) {
    return (
      <span
        className={`inline-flex items-center justify-center rounded-md bg-white border border-slate-200 overflow-hidden shrink-0 ${className ?? ''}`}
        style={wrapperStyle}
      >
        <img
          src={url}
          alt={decorative ? '' : (name ?? '')}
          aria-hidden={decorative || undefined}
          className="block w-full h-full object-contain p-0.5"
          loading="lazy"
          draggable={false}
        />
      </span>
    );
  }

  // Fallback: coloured initials avatar so the row is still scannable
  // when no logo is bundled for the requested key.
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
