/**
 * KpiCard — PR-FIN-2
 *
 * Reusable card primitive used by Row 1 (6 KPI cards) and Row 2
 * (9 profit summary cards). Stays close to the dashboard image:
 *   · white surface · rounded-2xl · subtle border + shadow
 *   · tone-tinted icon tile in the corner
 *   · title (Arabic) + optional row list inside
 *
 * Forward-compatible with dark mode (Tailwind `dark:` variants are
 * dual-classed throughout). PR-FIN-2 ships these classes; the actual
 * dark toggle wiring lives in a separate PR-FIN-DARK per Q1 of the
 * approved plan.
 */
import { ReactNode } from 'react';

export type KpiTone =
  | 'slate'
  | 'emerald'
  | 'rose'
  | 'amber'
  | 'indigo'
  | 'sky'
  | 'violet'
  | 'pink';

export interface KpiCardProps {
  title: string;
  icon?: ReactNode;
  tone?: KpiTone;
  children: ReactNode;
  /** test id forwarded to the card root */
  testId?: string;
}

const TONE_STYLES: Record<KpiTone, { tile: string; border: string }> = {
  slate:   { tile: 'bg-slate-100 text-slate-600 dark:bg-slate-700 dark:text-slate-300', border: 'border-slate-200 dark:border-slate-700' },
  emerald: { tile: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300', border: 'border-slate-200 dark:border-slate-700' },
  rose:    { tile: 'bg-rose-50 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300', border: 'border-slate-200 dark:border-slate-700' },
  amber:   { tile: 'bg-amber-50 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300', border: 'border-slate-200 dark:border-slate-700' },
  indigo:  { tile: 'bg-indigo-50 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300', border: 'border-slate-200 dark:border-slate-700' },
  sky:     { tile: 'bg-sky-50 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300', border: 'border-slate-200 dark:border-slate-700' },
  violet:  { tile: 'bg-violet-50 text-violet-700 dark:bg-violet-900/40 dark:text-violet-300', border: 'border-slate-200 dark:border-slate-700' },
  pink:    { tile: 'bg-pink-50 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300', border: 'border-slate-200 dark:border-slate-700' },
};

export function KpiCard({
  title,
  icon,
  tone = 'slate',
  children,
  testId,
}: KpiCardProps) {
  const t = TONE_STYLES[tone];
  return (
    <div
      data-testid={testId}
      className={`rounded-2xl border bg-white dark:bg-slate-900 ${t.border} shadow-sm p-4 flex flex-col gap-3`}
    >
      <div className="flex items-start justify-between gap-2">
        <h4 className="text-sm font-bold text-slate-700 dark:text-slate-200">
          {title}
        </h4>
        {icon && (
          <div
            className={`shrink-0 w-9 h-9 rounded-xl ${t.tile} flex items-center justify-center`}
            aria-hidden
          >
            {icon}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-1.5 text-sm">{children}</div>
    </div>
  );
}

/**
 * KpiRow — a single label/value row inside a KpiCard. Numbers use
 * tabular-nums + font-mono for nice column alignment.
 */
export function KpiRow({
  label,
  value,
  emphasis,
  tone,
  testId,
}: {
  label: string;
  value: ReactNode;
  emphasis?: boolean;
  tone?: 'positive' | 'negative' | 'neutral';
  testId?: string;
}) {
  const valueClass =
    tone === 'positive'
      ? 'text-emerald-700 dark:text-emerald-400'
      : tone === 'negative'
        ? 'text-rose-700 dark:text-rose-400'
        : 'text-slate-800 dark:text-slate-100';
  return (
    <div
      className="flex items-center justify-between gap-3"
      data-testid={testId}
    >
      <span className="text-[12px] text-slate-500 dark:text-slate-400">
        {label}
      </span>
      <span
        className={`font-mono tabular-nums ${valueClass} ${emphasis ? 'text-base font-black' : 'text-sm font-bold'}`}
      >
        {value}
      </span>
    </div>
  );
}
