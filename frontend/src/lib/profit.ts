/**
 * Profit/loss presentation helpers. Whenever the UI shows a value that can
 * swing negative (net profit, margin, balance, due amount), these helpers let
 * us label + color it consistently from the number's sign alone.
 *
 *   formatEGP(1234.5)      → "1,234.50 ج.م"
 *   profitLabel(-250, 'صافي الربح') → { label:'صافي الخسارة', ...,  isLoss:true }
 *   marginLabel(-3.2)       → { label:'هامش خسارة', ... }
 *
 * Rules the user set:
 *   - Positive (> 0)  → label: "ربح" / "ربح ..." + emerald color
 *   - Negative (< 0)  → label: "خسارة" / "خسارة ..." + rose color, show |n|
 *   - Zero            → neutral slate + "تعادل" style (no swap to loss)
 */

export const isLoss = (n: number | string | null | undefined) =>
  Number(n ?? 0) < 0;

export const isProfit = (n: number | string | null | undefined) =>
  Number(n ?? 0) > 0;

export const isBreakEven = (n: number | string | null | undefined) =>
  Number(n ?? 0) === 0;

export function formatEGP(n: number | string | null | undefined, opts?: { signed?: boolean }) {
  const v = Number(n || 0);
  const abs = Math.abs(v);
  const body = abs.toLocaleString('en-US', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const sign = v < 0 ? '- ' : opts?.signed && v > 0 ? '+ ' : '';
  return `${sign}${body} ج.م`;
}

export interface LabeledAmount {
  /** Replace-in label. e.g. "صافي الربح" → "صافي الخسارة" when negative. */
  label: string;
  /** Tailwind text-* color class. */
  color: string;
  /** Tailwind bg-* shade, for chips/badges. */
  bg: string;
  /** Matching border class. */
  border: string;
  /** Emoji for headline treatments. */
  icon: string;
  isLoss: boolean;
  isProfit: boolean;
  /** Pre-formatted absolute value with currency. */
  amount: string;
  /** Signed formatted value (e.g., "- 500.00 ج.م") for inline contexts. */
  signedAmount: string;
}

/**
 * Swap the profit/loss noun inside an Arabic label when the value is negative.
 * Examples:
 *   "صافي الربح"   → "صافي الخسارة"
 *   "مجمل الربح"   → "مجمل الخسارة"
 *   "ربح الشهر"    → "خسارة الشهر"
 *   "الأرباح"     → "الخسائر"
 */
function flipArLabel(label: string): string {
  return label
    .replace(/الأرباح/g, 'الخسائر')
    .replace(/أرباح/g, 'خسائر')
    .replace(/الربح/g, 'الخسارة')
    .replace(/ربح/g, 'خسارة');
}

export function profitLabel(
  value: number | string | null | undefined,
  baseLabel = 'صافي الربح',
): LabeledAmount {
  const n = Number(value || 0);
  const loss = n < 0;
  const zero = n === 0;
  return {
    label: loss ? flipArLabel(baseLabel) : baseLabel,
    color: loss
      ? 'text-rose-700'
      : zero
        ? 'text-slate-600'
        : 'text-emerald-700',
    bg: loss ? 'bg-rose-50' : zero ? 'bg-slate-50' : 'bg-emerald-50',
    border: loss
      ? 'border-rose-200'
      : zero
        ? 'border-slate-200'
        : 'border-emerald-200',
    icon: loss ? '📉' : zero ? '⚖️' : '📈',
    isLoss: loss,
    isProfit: n > 0,
    amount: formatEGP(Math.abs(n)),
    signedAmount: formatEGP(n),
  };
}

export function marginLabel(
  pct: number | string | null | undefined,
  baseLabel = 'هامش الربح',
): LabeledAmount {
  const n = Number(pct || 0);
  const loss = n < 0;
  const zero = n === 0;
  return {
    label: loss ? flipArLabel(baseLabel) : baseLabel,
    color: loss
      ? 'text-rose-700'
      : zero
        ? 'text-slate-600'
        : 'text-emerald-700',
    bg: loss ? 'bg-rose-50' : zero ? 'bg-slate-50' : 'bg-emerald-50',
    border: loss
      ? 'border-rose-200'
      : zero
        ? 'border-slate-200'
        : 'border-emerald-200',
    icon: loss ? '📉' : zero ? '⚖️' : '📈',
    isLoss: loss,
    isProfit: n > 0,
    amount: `${Math.abs(n).toFixed(1)}%`,
    signedAmount: `${n.toFixed(1)}%`,
  };
}

/**
 * Generic signed-amount helper for values that aren't specifically a "profit"
 * — e.g. a customer's balance, a supplier's remaining due. Positive stays
 * neutral (or "دائن"), negative becomes "مدين" / "خصم" style.
 */
export function balanceLabel(
  value: number | string | null | undefined,
): LabeledAmount {
  const n = Number(value || 0);
  const loss = n < 0;
  const zero = n === 0;
  return {
    label: loss ? 'مدين' : zero ? 'متعادل' : 'دائن',
    color: loss
      ? 'text-rose-700'
      : zero
        ? 'text-slate-600'
        : 'text-emerald-700',
    bg: loss ? 'bg-rose-50' : zero ? 'bg-slate-50' : 'bg-emerald-50',
    border: loss
      ? 'border-rose-200'
      : zero
        ? 'border-slate-200'
        : 'border-emerald-200',
    icon: loss ? '📉' : zero ? '⚖️' : '📈',
    isLoss: loss,
    isProfit: n > 0,
    amount: formatEGP(Math.abs(n)),
    signedAmount: formatEGP(n),
  };
}
