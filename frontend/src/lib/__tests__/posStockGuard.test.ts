/**
 * posStockGuard.test.ts — PR-POS-STOCK-1
 *
 * Pure-helper tests for the POS out-of-stock guard. No DOM, no
 * React Query, no cart store — these guard the rules every
 * add-to-cart path is required to follow.
 */

import { describe, it, expect } from 'vitest';
import {
  canAddOne,
  canBumpTo,
  findOverStockLines,
  formatOverStockLine,
  type StockGuardLine,
} from '../posStockGuard';

const cartLine = (
  qty: number,
  availableStock?: number,
  name = 'Test',
): StockGuardLine => ({
  variantId: 'v-1',
  qty,
  availableStock,
  name,
});

describe('canAddOne — Enter / scanner add path', () => {
  it('blocks when availableStock is exactly 0', () => {
    const r = canAddOne({ current: null, availableStock: 0 });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toMatch(/نفذ من المخزون/);
  });

  it('blocks when availableStock is negative (defensive: treated as 0)', () => {
    const r = canAddOne({ current: null, availableStock: -3 });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toMatch(/نفذ/);
  });

  it('blocks when availableStock is null', () => {
    const r = canAddOne({ current: null, availableStock: null });
    expect(r.ok).toBe(false);
  });

  it('blocks when availableStock is undefined (no annotation = treated as 0 for first add)', () => {
    const r = canAddOne({ current: null, availableStock: undefined });
    expect(r.ok).toBe(false);
  });

  it('blocks when NaN is passed (defensive coercion)', () => {
    const r = canAddOne({ current: null, availableStock: Number.NaN });
    expect(r.ok).toBe(false);
  });

  it('allows the first add when availableStock is 1', () => {
    const r = canAddOne({ current: null, availableStock: 1 });
    expect(r.ok).toBe(true);
  });

  it('blocks the second add when current.qty already equals availableStock', () => {
    const r = canAddOne({
      current: cartLine(1, 1),
      availableStock: 1,
    });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toMatch(/الرصيد المتاح 1 فقط/);
  });

  it('allows the second add when there is still headroom', () => {
    const r = canAddOne({
      current: cartLine(1, 5),
      availableStock: 5,
    });
    expect(r.ok).toBe(true);
  });

  it('uses the freshly-supplied availableStock (not the cart line snapshot) for the cap', () => {
    // Cart line says 5 but the live byBarcode response says 1 →
    // reality is 1, so re-add at qty=1 must block.
    const r = canAddOne({
      current: cartLine(1, 5),
      availableStock: 1,
    });
    expect(r.ok).toBe(false);
  });
});

describe('canBumpTo — cart "+1" / qty edit', () => {
  it('blocks when nextQty exceeds availableStock', () => {
    const r = canBumpTo({ line: cartLine(1, 1), nextQty: 2 });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toMatch(/الرصيد المتاح 1 فقط/);
  });

  it('allows when nextQty is exactly availableStock', () => {
    const r = canBumpTo({ line: cartLine(0, 5), nextQty: 5 });
    expect(r.ok).toBe(true);
  });

  it('allows when the line has no availableStock annotation (legacy / pre-PR)', () => {
    const r = canBumpTo({ line: cartLine(1, undefined), nextQty: 99 });
    expect(r.ok).toBe(true);
  });

  it('blocks when availableStock is 0 (line should never have been added)', () => {
    const r = canBumpTo({ line: cartLine(0, 0), nextQty: 1 });
    expect(r.ok).toBe(false);
    expect((r as any).reason).toMatch(/نفذ/);
  });

  it('rejects negative or NaN nextQty', () => {
    expect(canBumpTo({ line: cartLine(1, 5), nextQty: -1 }).ok).toBe(false);
    expect(canBumpTo({ line: cartLine(1, 5), nextQty: Number.NaN }).ok).toBe(false);
  });
});

describe('findOverStockLines — submit-time sweep', () => {
  it('returns empty when every line is within its availableStock snapshot', () => {
    const items: StockGuardLine[] = [
      cartLine(1, 5),
      cartLine(2, 2),
      cartLine(0, 0),
    ];
    expect(findOverStockLines(items)).toEqual([]);
  });

  it('returns lines whose qty exceeds their availableStock', () => {
    const items: StockGuardLine[] = [
      cartLine(1, 5),
      { ...cartLine(3, 2), variantId: 'over-1', name: 'Sneaker A' },
      { ...cartLine(99, 10), variantId: 'over-2', name: 'Bag B' },
    ];
    const over = findOverStockLines(items);
    expect(over).toHaveLength(2);
    expect(over.map((l) => l.variantId)).toEqual(['over-1', 'over-2']);
  });

  it('skips lines without an availableStock annotation (defensive default)', () => {
    const items: StockGuardLine[] = [
      { ...cartLine(99, undefined), variantId: 'legacy', name: 'Legacy' },
    ];
    expect(findOverStockLines(items)).toEqual([]);
  });
});

describe('formatOverStockLine', () => {
  it('produces the same Arabic sentence the backend emits', () => {
    const msg = formatOverStockLine({
      variantId: 'v-1',
      qty: 3,
      availableStock: 1,
      name: 'كوتش',
    });
    expect(msg).toBe('الرصيد غير كافٍ للصنف كوتش. المتاح 1 والمطلوب 3');
  });

  it('falls back to the variant id when no name is present', () => {
    const msg = formatOverStockLine({
      variantId: 'v-7',
      qty: 2,
      availableStock: 0,
    });
    expect(msg).toBe('الرصيد غير كافٍ للصنف v-7. المتاح 0 والمطلوب 2');
  });
});
