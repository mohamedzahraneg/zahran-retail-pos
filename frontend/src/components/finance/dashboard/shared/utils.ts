/**
 * Formatting helpers shared across all dashboard components.
 * Centralized so the entire dashboard renders numbers identically.
 */
export const fmtEGP = (n: number | string | null | undefined): string => {
  const x = Number(n ?? 0);
  if (!isFinite(x)) return '0.00 ج.م';
  return `${x.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ج.م`;
};

export const fmtNumber = (n: number | string | null | undefined): string => {
  const x = Number(n ?? 0);
  if (!isFinite(x)) return '0';
  return x.toLocaleString('en-US', { maximumFractionDigits: 0 });
};

export const fmtPct = (n: number | string | null | undefined): string => {
  const x = Number(n ?? 0);
  if (!isFinite(x)) return '0%';
  return `${x.toFixed(1)}%`;
};

export const fmtDateTime = (iso?: string | null): string => {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-GB', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
};

export const fmtDate = (iso?: string | null): string => {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-GB', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
};

/**
 * Default range = current Cairo month, day-1 → today. Mirrors the
 * server-side default so initial UI numbers match the first request.
 */
export function defaultDateRange(): { from: string; to: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === 'year')!.value;
  const m = parts.find((p) => p.type === 'month')!.value;
  const d = parts.find((p) => p.type === 'day')!.value;
  return { from: `${y}-${m}-01`, to: `${y}-${m}-${d}` };
}
