/**
 * pricingSuggestions.ts — PR-PURCHASES-P3.1
 *
 * Pure pricing-suggestion helper for the purchase flow. Given a final
 * landed unit cost (and optionally the variant's current selling
 * price), returns four ranked strategies — competitive / recommended
 * / high-margin / wholesale — with profit, margin %, markup %,
 * rounding info, and below-cost / below-min-margin flags.
 *
 * Frontend-only: no API calls, no DB writes. The consuming component
 * (PricingSuggestions.tsx) just renders the result, and the parent
 * purchase modal keeps a LOCAL pending-prices marker — P3.1 never
 * propagates the selection anywhere. P3.2 will introduce an explicit
 * apply endpoint with audit history.
 *
 * Formulas (intentionally exposed in the UI so operators can't mistake
 * markup for margin):
 *   profit      = price - cost
 *   markup_pct  = (price - cost) / cost  * 100
 *   margin_pct  = (price - cost) / price * 100
 *
 * Strategies (with default settings):
 *   competitive : price = cost × (1 + 0.15)
 *   recommended : price = cost / (1 - 0.30)
 *   high_margin : price = cost / (1 - 0.40)
 *   wholesale   : price = cost × (1 + 0.10)
 *
 * Rounding: raw price is snapped to the nearest `roundingStep` (5 EGP
 * by default) and ALL downstream numbers (profit, margin, markup) are
 * recomputed from the rounded price so the operator sees what they
 * actually get.
 */

export type PricingStrategy =
  | 'competitive'
  | 'recommended'
  | 'high_margin'
  | 'wholesale';

export type RoundingMode = 'nearest' | 'floor' | 'ceil';

export interface PricingSuggestionsSettings {
  competitiveMarkupPct?: number;
  recommendedMarginPct?: number;
  highMarginPct?: number;
  wholesaleMarkupPct?: number;
  roundingStep?: number;
  roundingMode?: RoundingMode;
}

export interface PricingSuggestionsInput {
  cost: number;
  currentSellingPrice?: number;
  minMarginPct?: number;
  settings?: PricingSuggestionsSettings;
}

export interface PricingSuggestion {
  strategy: PricingStrategy;
  label_ar: string;
  explanation_ar: string;
  /** Exact computed price before rounding. */
  raw_price: number;
  /** Rounded price the operator will see / apply. */
  price: number;
  /** Same as raw_price — explicit alias so the UI can show drift. */
  rounded_from: number;
  profit: number;
  margin_pct: number;
  markup_pct: number;
  vs_current_amount: number | null;
  vs_current_pct: number | null;
  below_cost: boolean;
  below_min_margin: boolean;
}

export interface PricingCurrent {
  price: number;
  profit: number;
  margin_pct: number;
  markup_pct: number;
  below_cost: boolean;
  below_min_margin: boolean;
}

export interface PricingSuggestionsResult {
  unknown_cost: boolean;
  cost: number;
  min_margin_pct: number;
  current: PricingCurrent | null;
  suggestions: PricingSuggestion[];
}

const STRATEGY_LABEL_AR: Record<PricingStrategy, string> = {
  competitive: 'اقتصادي / منافس',
  recommended: 'موصى به',
  high_margin: 'هامش عالي',
  wholesale: 'جملة',
};

const STRATEGY_EXPLANATION_AR: Record<PricingStrategy, string> = {
  competitive:
    'سعر منافس بزيادة بسيطة على التكلفة — يحرّك المخزون بسرعة بربح منخفض.',
  recommended:
    'هامش متوازن يحمي ربحية البضاعة دون رفع السعر فوق السوق.',
  high_margin:
    'سعر بهامش مرتفع — مناسب للأصناف ذات الطلب الثابت أو المتميزة.',
  wholesale:
    'سعر بهامش منخفض للبيع بالجملة لعميل معروف.',
};

const STRATEGY_ORDER: PricingStrategy[] = [
  'competitive',
  'recommended',
  'high_margin',
  'wholesale',
];

const DEFAULTS: Required<PricingSuggestionsSettings> = {
  competitiveMarkupPct: 15,
  recommendedMarginPct: 30,
  highMarginPct: 40,
  wholesaleMarkupPct: 10,
  roundingStep: 5,
  roundingMode: 'nearest',
};

const DEFAULT_MIN_MARGIN_PCT = 15;

const round2 = (n: number) =>
  Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;

export function applyRounding(
  price: number,
  step: number,
  mode: RoundingMode,
): number {
  if (!(step > 0)) return round2(price);
  const ratio = price / step;
  let snapped: number;
  switch (mode) {
    case 'floor':
      snapped = Math.floor(ratio) * step;
      break;
    case 'ceil':
      snapped = Math.ceil(ratio) * step;
      break;
    default:
      snapped = Math.round(ratio) * step;
  }
  return round2(snapped);
}

function buildSuggestion(
  strategy: PricingStrategy,
  rawPrice: number,
  cost: number,
  currentSellingPrice: number | undefined,
  minMarginPct: number,
  settings: Required<PricingSuggestionsSettings>,
): PricingSuggestion {
  const price = applyRounding(
    rawPrice,
    settings.roundingStep,
    settings.roundingMode,
  );
  const profit = round2(price - cost);
  const markup_pct = cost > 0 ? round2((profit / cost) * 100) : 0;
  const margin_pct = price > 0 ? round2((profit / price) * 100) : 0;
  const below_cost = price < cost;
  const below_min_margin = margin_pct < minMarginPct;
  const hasCurrent =
    currentSellingPrice != null && currentSellingPrice > 0;
  const vs_current_amount = hasCurrent
    ? round2(price - (currentSellingPrice as number))
    : null;
  const vs_current_pct = hasCurrent
    ? round2(
        ((price - (currentSellingPrice as number)) /
          (currentSellingPrice as number)) *
          100,
      )
    : null;
  const rawRounded = round2(rawPrice);
  return {
    strategy,
    label_ar: STRATEGY_LABEL_AR[strategy],
    explanation_ar: STRATEGY_EXPLANATION_AR[strategy],
    raw_price: rawRounded,
    price,
    rounded_from: rawRounded,
    profit,
    markup_pct,
    margin_pct,
    vs_current_amount,
    vs_current_pct,
    below_cost,
    below_min_margin,
  };
}

function buildCurrent(
  cost: number,
  currentSellingPrice: number,
  minMarginPct: number,
): PricingCurrent {
  const profit = round2(currentSellingPrice - cost);
  const markup_pct = cost > 0 ? round2((profit / cost) * 100) : 0;
  const margin_pct =
    currentSellingPrice > 0
      ? round2((profit / currentSellingPrice) * 100)
      : 0;
  return {
    price: round2(currentSellingPrice),
    profit,
    markup_pct,
    margin_pct,
    below_cost: currentSellingPrice < cost,
    below_min_margin: margin_pct < minMarginPct,
  };
}

export function suggestPrices(
  input: PricingSuggestionsInput,
): PricingSuggestionsResult {
  const cost = Number(input.cost || 0);
  const minMarginPct = Number(
    input.minMarginPct ?? DEFAULT_MIN_MARGIN_PCT,
  );
  const settings: Required<PricingSuggestionsSettings> = {
    ...DEFAULTS,
    ...(input.settings ?? {}),
  };

  // Unknown / non-positive cost → no suggestions (operator must enter
  // a base unit cost first). We surface the flag so the UI can render
  // a neutral message instead of zero-margin cards.
  if (!(cost > 0)) {
    return {
      unknown_cost: true,
      cost: 0,
      min_margin_pct: minMarginPct,
      current: null,
      suggestions: [],
    };
  }

  const recommendedMarginFrac = settings.recommendedMarginPct / 100;
  const highMarginFrac = settings.highMarginPct / 100;
  const rawByStrategy: Record<PricingStrategy, number> = {
    competitive: cost * (1 + settings.competitiveMarkupPct / 100),
    // Guard against margins >= 100% (division by zero / negative). Fall
    // back to the cost itself; the resulting card will be flagged
    // below_min_margin so the operator sees the issue.
    recommended:
      recommendedMarginFrac < 1
        ? cost / (1 - recommendedMarginFrac)
        : cost,
    high_margin:
      highMarginFrac < 1 ? cost / (1 - highMarginFrac) : cost,
    wholesale: cost * (1 + settings.wholesaleMarkupPct / 100),
  };

  const suggestions = STRATEGY_ORDER.map((s) =>
    buildSuggestion(
      s,
      rawByStrategy[s],
      cost,
      input.currentSellingPrice,
      minMarginPct,
      settings,
    ),
  );

  return {
    unknown_cost: false,
    cost: round2(cost),
    min_margin_pct: minMarginPct,
    current:
      input.currentSellingPrice != null && input.currentSellingPrice > 0
        ? buildCurrent(cost, input.currentSellingPrice, minMarginPct)
        : null,
    suggestions,
  };
}
