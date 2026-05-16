/**
 * cartonMath.test.ts — PR-PURCHASES-P1
 *
 * Pins the purchase-line piece/carton math. Backend stores piece-level
 * `quantity` + `unit_cost` only — the helpers in `cartonMath.ts` make
 * sure the UI's carton workflow lands on backend-compatible numbers.
 */
import { describe, it, expect } from 'vitest';
import { computeLine, toBackendItem } from '../cartonMath';

describe('computeLine — piece mode', () => {
  it('total_pieces = quantity, line_total = qty × unit_cost', () => {
    const r = computeLine({ mode: 'piece', quantity: 5, unit_cost: 12.5 });
    expect(r.total_pieces).toBe(5);
    expect(r.unit_piece_cost).toBe(12.5);
    expect(r.line_total).toBe(62.5);
  });

  it('subtracts line discount and adds line tax', () => {
    const r = computeLine({
      mode: 'piece',
      quantity: 10,
      unit_cost: 50,
      discount: 25,
      tax: 5,
    });
    // 10 × 50 − 25 + 5 = 480
    expect(r.line_total).toBe(480);
  });

  it('treats negative inputs as zero', () => {
    const r = computeLine({
      mode: 'piece',
      quantity: -3 as any,
      unit_cost: -2 as any,
    });
    expect(r.total_pieces).toBe(0);
    expect(r.unit_piece_cost).toBe(0);
    expect(r.line_total).toBe(0);
  });

  it('uses pieces_per_carton hint only to derive carton_price preview', () => {
    const r = computeLine({
      mode: 'piece',
      quantity: 6,
      unit_cost: 10,
      pieces_per_carton: 12,
    });
    expect(r.total_pieces).toBe(6);
    expect(r.unit_piece_cost).toBe(10);
    expect(r.carton_price).toBe(120); // 10 × 12 hint
    expect(r.line_total).toBe(60); // line stays piece-driven
  });
});

describe('computeLine — carton mode', () => {
  it('total_pieces = cartons × pieces_per_carton', () => {
    const r = computeLine({
      mode: 'carton',
      cartons: 3,
      pieces_per_carton: 24,
      carton_cost: 480,
    });
    expect(r.total_pieces).toBe(72);
  });

  it('unit_piece_cost = carton_cost / pieces_per_carton', () => {
    const r = computeLine({
      mode: 'carton',
      cartons: 2,
      pieces_per_carton: 10,
      carton_cost: 250,
    });
    expect(r.unit_piece_cost).toBe(25);
  });

  it('line_total = cartons × carton_cost (minus discount, plus tax)', () => {
    const r = computeLine({
      mode: 'carton',
      cartons: 4,
      pieces_per_carton: 12,
      carton_cost: 100,
      discount: 50,
      tax: 10,
    });
    // 4 × 100 − 50 + 10 = 360
    expect(r.line_total).toBe(360);
  });

  it('clamps pieces_per_carton to ≥ 1 to avoid division by zero', () => {
    const r = computeLine({
      mode: 'carton',
      cartons: 1,
      pieces_per_carton: 0 as any,
      carton_cost: 100,
    });
    expect(r.total_pieces).toBe(1);
    expect(r.unit_piece_cost).toBe(100);
  });

  it('rounds unit_piece_cost to 2 decimals (the backend constraint)', () => {
    // 333 / 7 = 47.5714... → 47.57
    const r = computeLine({
      mode: 'carton',
      cartons: 1,
      pieces_per_carton: 7,
      carton_cost: 333,
    });
    expect(r.unit_piece_cost).toBe(47.57);
  });
});

describe('toBackendItem — payload shape', () => {
  it('emits piece-level quantity + unit_cost only (carton metadata stripped)', () => {
    const payload = toBackendItem({
      variant_id: 'v-1',
      mode: 'carton',
      cartons: 2,
      pieces_per_carton: 12,
      carton_cost: 240,
    });
    expect(payload).toEqual({
      variant_id: 'v-1',
      quantity: 24, // 2 × 12 pieces
      unit_cost: 20, // 240 / 12
      discount: undefined,
      tax: undefined,
    });
  });

  it('forwards discount + tax when positive', () => {
    const payload = toBackendItem({
      variant_id: 'v-1',
      mode: 'piece',
      quantity: 5,
      unit_cost: 10,
      discount: 3,
      tax: 1,
    });
    expect(payload).toMatchObject({
      variant_id: 'v-1',
      quantity: 5,
      unit_cost: 10,
      discount: 3,
      tax: 1,
    });
  });

  it('omits discount/tax fields when zero/negative (backend treats undefined as default)', () => {
    const payload = toBackendItem({
      variant_id: 'v-1',
      mode: 'piece',
      quantity: 1,
      unit_cost: 10,
      discount: 0,
      tax: -5 as any,
    });
    expect(payload.discount).toBeUndefined();
    expect(payload.tax).toBeUndefined();
  });
});
