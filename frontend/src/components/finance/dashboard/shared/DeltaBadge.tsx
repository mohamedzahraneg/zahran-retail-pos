/**
 * DeltaBadge — PR-FIN-2
 *
 * Small inline badge showing % delta vs previous period. Includes
 * an icon (never relies on color alone — accessibility for the dark
 * mode rollout per Q1).
 *
 *   tone = positive → emerald, ▲, "X.Y% عن الفترة السابقة"
 *   tone = negative → rose,    ▼, "X.Y% عن الفترة السابقة"
 *   tone = neutral  → slate,   •, "—"
 *
 * The "lower-is-better" prop flips polarity for COGS / expenses where
 * a decrease is positive.
 */
import { ArrowUp, ArrowDown, Minus } from 'lucide-react';

export interface DeltaBadgeProps {
  pct: number;
  /** Set true for COGS/expenses where a DROP is positive. */
  lowerIsBetter?: boolean;
  testId?: string;
}

export function DeltaBadge({
  pct,
  lowerIsBetter = false,
  testId,
}: DeltaBadgeProps) {
  if (!isFinite(pct) || pct === 0) {
    return (
      <span
        data-testid={testId}
        className="inline-flex items-center gap-1 text-[10px] text-slate-500 dark:text-slate-400"
      >
        <Minus size={10} aria-hidden />
        <span className="font-mono tabular-nums">0%</span>
        <span>عن الفترة السابقة</span>
      </span>
    );
  }
  const isUp = pct > 0;
  const isPositive = lowerIsBetter ? !isUp : isUp;
  const tone = isPositive
    ? 'text-emerald-700 dark:text-emerald-400'
    : 'text-rose-700 dark:text-rose-400';
  const Icon = isUp ? ArrowUp : ArrowDown;
  return (
    <span
      data-testid={testId}
      className={`inline-flex items-center gap-1 text-[10px] ${tone}`}
    >
      <Icon size={10} aria-hidden />
      <span className="font-mono tabular-nums font-bold">
        {Math.abs(pct).toFixed(1)}%
      </span>
      <span>عن الفترة السابقة</span>
    </span>
  );
}
