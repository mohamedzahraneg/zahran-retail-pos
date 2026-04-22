import { useState } from 'react';
import { Banknote, Smartphone, FileCheck, Wallet } from 'lucide-react';

/**
 * Renders a bank / wallet / cashbox logo.
 *
 * - If we have a domain (from `financial_institutions.website_domain`) we
 *   pull the real brand logo from Clearbit's free logo CDN. No API key
 *   needed; they serve a clean transparent PNG for well-known domains.
 * - If Clearbit returns nothing or fails, we fall back to a colored chip
 *   with the institution's short code / initials.
 * - For a plain cash drawer we show a generic icon.
 */
export function InstitutionLogo({
  domain,
  kind,
  color,
  label,
  size = 'md',
}: {
  domain?: string | null;
  kind?: 'bank' | 'ewallet' | 'check' | 'cash' | 'check_issuer' | null;
  color?: string | null;
  label?: string | null;
  size?: 'sm' | 'md' | 'lg';
}) {
  const [failed, setFailed] = useState(false);
  const px = size === 'sm' ? 24 : size === 'lg' ? 48 : 32;

  const Fallback = () => {
    const bg = color || (
      kind === 'bank' ? '#4f46e5' :
      kind === 'ewallet' ? '#059669' :
      kind === 'check' || kind === 'check_issuer' ? '#0891b2' :
      '#64748b'
    );
    const Icon =
      kind === 'ewallet' ? Smartphone :
      kind === 'check' || kind === 'check_issuer' ? FileCheck :
      kind === 'cash' ? Wallet :
      Banknote;
    const initials = (label || '?')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0])
      .join('')
      .toUpperCase();
    return (
      <div
        className="flex items-center justify-center rounded-lg text-white font-black shrink-0"
        style={{
          width: px,
          height: px,
          backgroundColor: bg,
          fontSize: px * 0.4,
        }}
        title={label || ''}
      >
        {initials.length >= 2 ? (
          initials
        ) : (
          <Icon size={px * 0.5} />
        )}
      </div>
    );
  };

  if (!domain || failed) {
    return <Fallback />;
  }

  return (
    <img
      src={`https://logo.clearbit.com/${domain}?size=${px * 2}`}
      alt={label || domain}
      width={px}
      height={px}
      className="rounded-lg shrink-0 object-contain bg-white border border-slate-100"
      onError={() => setFailed(true)}
      loading="lazy"
    />
  );
}
