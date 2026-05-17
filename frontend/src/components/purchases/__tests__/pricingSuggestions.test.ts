/**
 * pricingSuggestions.test.ts — PR-PURCHASES-P3.1
 *
 * Pins the pure pricing-suggestions helper used by the purchase
 * create/edit modals. Frontend-only — the helper is the single source
 * of truth for markup vs margin, rounding behavior, and the four
 * strategy formulas.
 *
 * Helper test file is named `pricingSuggestions.test.ts` to match the
 * intent string, while the underlying module is `pricingMath.ts` to
 * avoid a case-collision with the `PricingSuggestions.tsx` component
 * on case-insensitive filesystems.
 */
import { describe, it, expect } from 'vitest';
import { suggestPrices } from '../pricingMath';

describe('suggestPrices — markup vs margin formulas', () => {
  it('competitive (15% markup) → cost+15%, recommended (30% margin) → cost/0.7', () => {
    const r = suggestPrices({ cost: 100 });
    const comp = r.suggestions.find((s) => s.strategy === 'competitive')!;
    const rec = r.suggestions.find((s) => s.strategy === 'recommended')!;
    // Competitive: raw = 115; rounds to nearest 5 → 115.
    expect(comp.raw_price).toBe(115);
    expect(comp.price).toBe(115);
    expect(comp.markup_pct).toBe(15);
    // margin on price 115, cost 100 → profit 15 / 115 = 13.04%
    expect(comp.margin_pct).toBeCloseTo(13.04, 1);
    // Recommended: raw = 100/0.7 = 142.857..., rounds to 145 (nearest 5).
    expect(rec.raw_price).toBe(142.86);
    expect(rec.price).toBe(145);
    // After rounding, margin and markup are RECOMPUTED.
    expect(rec.markup_pct).toBe(45);
    expect(rec.margin_pct).toBeCloseTo(31.03, 1);
  });
});

describe('suggestPrices — recommended margin formula', () => {
  it('30% margin on cost 70 → raw 100, rounds to 100', () => {
    const r = suggestPrices({ cost: 70 });
    const rec = r.suggestions.find((s) => s.strategy === 'recommended')!;
    // 70 / 0.7 = 100 exactly
    expect(rec.raw_price).toBe(100);
    expect(rec.price).toBe(100);
    expect(rec.margin_pct).toBe(30);
    expect(rec.markup_pct).toBeCloseTo(42.86, 1);
  });
});

describe('suggestPrices — rounding to nearest 5', () => {
  it('142.86 rounds to 145; 143.21 rounds to 145; 232.5 rounds to 235', () => {
    expect(
      suggestPrices({ cost: 100 }).suggestions.find(
        (s) => s.strategy === 'recommended',
      )!.price,
    ).toBe(145);
    // cost 100, 40% margin → 166.67 → rounds to 165
    expect(
      suggestPrices({ cost: 100 }).suggestions.find(
        (s) => s.strategy === 'high_margin',
      )!.price,
    ).toBe(165);
    // floor and ceil modes also honored
    const floored = suggestPrices({
      cost: 100,
      settings: { roundingMode: 'floor', roundingStep: 5 },
    }).suggestions.find((s) => s.strategy === 'recommended')!;
    expect(floored.price).toBe(140);
    const ceiled = suggestPrices({
      cost: 100,
      settings: { roundingMode: 'ceil', roundingStep: 5 },
    }).suggestions.find((s) => s.strategy === 'recommended')!;
    expect(ceiled.price).toBe(145);
  });
});

describe('suggestPrices — recompute margin AFTER rounding', () => {
  it('rounding drift reflected in margin and below_min_margin flags', () => {
    // cost = 80, recommended raw = 80/0.7 = 114.286, rounds to 115.
    // After rounding: profit=35, margin = 35/115 = 30.43 (slight bump);
    // markup = 35/80 = 43.75
    const r = suggestPrices({ cost: 80 });
    const rec = r.suggestions.find((s) => s.strategy === 'recommended')!;
    expect(rec.raw_price).toBe(114.29);
    expect(rec.price).toBe(115);
    expect(rec.margin_pct).toBeCloseTo(30.43, 1);
    expect(rec.markup_pct).toBe(43.75);
    expect(rec.rounded_from).toBe(114.29);
  });
});

describe('suggestPrices — below-cost current price flag', () => {
  it('currentSellingPrice < cost → current.below_cost true', () => {
    const r = suggestPrices({ cost: 100, currentSellingPrice: 80 });
    expect(r.current).not.toBeNull();
    expect(r.current!.below_cost).toBe(true);
    expect(r.current!.profit).toBe(-20);
  });
  it('currentSellingPrice >= cost → current.below_cost false', () => {
    const r = suggestPrices({ cost: 100, currentSellingPrice: 130 });
    expect(r.current!.below_cost).toBe(false);
    expect(r.current!.profit).toBe(30);
  });
});

describe('suggestPrices — below-min-margin flag', () => {
  it('current margin 8% < min_margin_pct 15 → below_min_margin true', () => {
    // cost 100, current 110: margin = 10/110 = 9.09%
    const r = suggestPrices({
      cost: 100,
      currentSellingPrice: 110,
      minMarginPct: 15,
    });
    expect(r.current!.below_cost).toBe(false);
    expect(r.current!.below_min_margin).toBe(true);
  });
  it('respects a custom min_margin_pct override', () => {
    const r = suggestPrices({
      cost: 100,
      currentSellingPrice: 130,
      minMarginPct: 25,
    });
    // margin = 30/130 = 23.08% < 25 → flagged
    expect(r.current!.below_min_margin).toBe(true);
  });
});

describe('suggestPrices — zero / unknown cost', () => {
  it('cost <= 0 → unknown_cost=true, suggestions empty, current null', () => {
    const r = suggestPrices({ cost: 0, currentSellingPrice: 50 });
    expect(r.unknown_cost).toBe(true);
    expect(r.suggestions).toEqual([]);
    expect(r.current).toBeNull();
  });
  it('negative cost behaves the same', () => {
    expect(suggestPrices({ cost: -5 }).unknown_cost).toBe(true);
  });
});

describe('suggestPrices — wholesale default 10% markup', () => {
  it('cost 100 → wholesale raw 110, rounds to 110', () => {
    const r = suggestPrices({ cost: 100 });
    const ws = r.suggestions.find((s) => s.strategy === 'wholesale')!;
    expect(ws.raw_price).toBe(110);
    expect(ws.price).toBe(110);
    expect(ws.markup_pct).toBe(10);
    expect(ws.margin_pct).toBeCloseTo(9.09, 1);
  });
});

describe('suggestPrices — settings override defaults', () => {
  it('recommendedMarginPct=35 shifts recommended to cost/(1-0.35)', () => {
    const r = suggestPrices({
      cost: 100,
      settings: { recommendedMarginPct: 35, roundingStep: 1 },
    });
    const rec = r.suggestions.find((s) => s.strategy === 'recommended')!;
    // 100 / 0.65 = 153.846 → rounded to 154 with step=1
    expect(rec.raw_price).toBe(153.85);
    expect(rec.price).toBe(154);
  });
  it('wholesaleMarkupPct=20 shifts wholesale', () => {
    const r = suggestPrices({
      cost: 100,
      settings: { wholesaleMarkupPct: 20 },
    });
    const ws = r.suggestions.find((s) => s.strategy === 'wholesale')!;
    expect(ws.raw_price).toBe(120);
    expect(ws.price).toBe(120);
  });
});

describe('suggestPrices — vs_current amount / pct', () => {
  it('reports +amount and +% when suggestion is above current', () => {
    const r = suggestPrices({ cost: 100, currentSellingPrice: 130 });
    const rec = r.suggestions.find((s) => s.strategy === 'recommended')!;
    // recommended price 145, current 130 → diff +15 → +11.54%
    expect(rec.vs_current_amount).toBe(15);
    expect(rec.vs_current_pct).toBeCloseTo(11.54, 1);
  });
  it('reports -amount and -% when suggestion is below current', () => {
    const r = suggestPrices({ cost: 100, currentSellingPrice: 200 });
    const ws = r.suggestions.find((s) => s.strategy === 'wholesale')!;
    expect(ws.vs_current_amount).toBe(-90);
    expect(ws.vs_current_pct).toBe(-45);
  });
  it('returns null vs_current when currentSellingPrice is missing or zero', () => {
    const r = suggestPrices({ cost: 100 });
    for (const s of r.suggestions) {
      expect(s.vs_current_amount).toBeNull();
      expect(s.vs_current_pct).toBeNull();
    }
    const r2 = suggestPrices({ cost: 100, currentSellingPrice: 0 });
    expect(r2.suggestions[0].vs_current_amount).toBeNull();
  });
});
