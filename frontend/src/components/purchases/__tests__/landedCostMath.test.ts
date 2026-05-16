/**
 * landedCostMath.test.ts — PR-PURCHASES-P2.2
 *
 * Pins the frontend preview helper that mirrors the backend allocator
 * (`backend/src/purchases/landed-cost.allocator.ts`). Same formulas, same
 * deterministic remainder assignment, same Arabic error message —
 * any drift here would mean the operator sees different pennies from
 * what the server persists.
 */
import { describe, it, expect } from 'vitest';
import { computeLandedPreview } from '../landedCostMath';

describe('computeLandedPreview — no extras passthrough', () => {
  it('returns base totals and zeroed extras when no extras are present', () => {
    const result = computeLandedPreview({
      lines: [
        { variant_id: 'v1', quantity: 4, base_unit_cost: 25 },
        { variant_id: 'v2', quantity: 2, base_unit_cost: 50 },
      ],
      extras: [],
    });
    expect(result.products_base_subtotal).toBe(200);
    expect(result.extra_costs_capitalized).toBe(0);
    expect(result.extra_costs_non_capitalized).toBe(0);
    expect(result.final_inventory_total).toBe(200);
    expect(result.grand_total_preview).toBe(200);
    expect(result.lines[0].final_unit_cost).toBe(25);
    expect(result.lines[1].final_unit_cost).toBe(50);
    expect(result.lines[0].allocated_cost_total).toBe(0);
    expect(result.lines[1].allocated_cost_total).toBe(0);
    expect(Object.keys(result.errors)).toHaveLength(0);
  });
});

describe('computeLandedPreview — by_value allocation', () => {
  it('distributes extras proportional to line base totals', () => {
    const result = computeLandedPreview({
      lines: [
        { variant_id: 'a', quantity: 1, base_unit_cost: 100 },
        { variant_id: 'b', quantity: 1, base_unit_cost: 300 },
      ],
      extras: [
        {
          cost_type: 'transport',
          amount: 40,
          capitalize_to_inventory: true,
          allocation_method: 'by_value',
        },
      ],
    });
    // 100/400 = 25% → 10, 300/400 = 75% → 30
    expect(result.lines[0].allocated_cost_total).toBe(10);
    expect(result.lines[1].allocated_cost_total).toBe(30);
    expect(result.lines[0].final_unit_cost).toBe(110);
    expect(result.lines[1].final_unit_cost).toBe(330);
    expect(result.extra_costs_capitalized).toBe(40);
    expect(result.final_inventory_total).toBe(440);
  });

  it('falls back to by_quantity when total base subtotal is zero', () => {
    const result = computeLandedPreview({
      lines: [
        { variant_id: 'a', quantity: 2, base_unit_cost: 0 },
        { variant_id: 'b', quantity: 3, base_unit_cost: 0 },
      ],
      extras: [
        {
          cost_type: 'transport',
          amount: 50,
          capitalize_to_inventory: true,
          allocation_method: 'by_value',
        },
      ],
    });
    expect(result.lines[0].allocated_cost_total).toBe(20);
    expect(result.lines[1].allocated_cost_total).toBe(30);
  });
});

describe('computeLandedPreview — by_quantity allocation', () => {
  it('distributes extras proportional to piece counts', () => {
    const result = computeLandedPreview({
      lines: [
        { variant_id: 'a', quantity: 4, base_unit_cost: 10 },
        { variant_id: 'b', quantity: 6, base_unit_cost: 100 },
      ],
      extras: [
        {
          cost_type: 'labor',
          amount: 100,
          capitalize_to_inventory: true,
          allocation_method: 'by_quantity',
        },
      ],
    });
    expect(result.lines[0].allocated_cost_total).toBe(40);
    expect(result.lines[1].allocated_cost_total).toBe(60);
    expect(result.lines[0].allocated_cost_per_unit).toBe(10);
    expect(result.lines[1].allocated_cost_per_unit).toBe(10);
  });
});

describe('computeLandedPreview — manual allocation', () => {
  it('accepts an exact manual split and reports no error', () => {
    const result = computeLandedPreview({
      lines: [
        { variant_id: 'a', quantity: 1, base_unit_cost: 100 },
        { variant_id: 'b', quantity: 1, base_unit_cost: 100 },
      ],
      extras: [
        {
          cost_type: 'customs',
          amount: 80,
          capitalize_to_inventory: true,
          allocation_method: 'manual',
          manual_allocations: [
            { variant_id: 'a', amount: 30 },
            { variant_id: 'b', amount: 50 },
          ],
        },
      ],
    });
    expect(result.errors[0]).toBeUndefined();
    expect(result.lines[0].allocated_cost_total).toBe(30);
    expect(result.lines[1].allocated_cost_total).toBe(50);
    expect(result.lines[0].manual_allocation).toBe(true);
    expect(result.lines[1].manual_allocation).toBe(true);
  });

  it('flags a manual sum mismatch with the Arabic error and rolls back allocations', () => {
    const result = computeLandedPreview({
      lines: [
        { variant_id: 'a', quantity: 1, base_unit_cost: 100 },
        { variant_id: 'b', quantity: 1, base_unit_cost: 100 },
      ],
      extras: [
        {
          cost_type: 'customs',
          amount: 80,
          capitalize_to_inventory: true,
          allocation_method: 'manual',
          manual_allocations: [
            { variant_id: 'a', amount: 30 },
            { variant_id: 'b', amount: 40 }, // 70 ≠ 80
          ],
        },
      ],
    });
    expect(result.errors[0]).toBe(
      'إجمالي التوزيع اليدوي للمصاريف يجب أن يساوي قيمة المصروف.',
    );
    expect(result.lines[0].allocated_cost_total).toBe(0);
    expect(result.lines[1].allocated_cost_total).toBe(0);
    expect(result.lines[0].manual_allocation).toBe(false);
  });
});

describe('computeLandedPreview — capitalized vs non-capitalized', () => {
  it('splits capitalized and non-capitalized totals correctly', () => {
    const result = computeLandedPreview({
      lines: [{ variant_id: 'a', quantity: 1, base_unit_cost: 100 }],
      extras: [
        {
          cost_type: 'transport',
          amount: 30,
          capitalize_to_inventory: true,
          allocation_method: 'by_value',
        },
        {
          cost_type: 'other',
          amount: 25,
          capitalize_to_inventory: false,
          allocation_method: 'by_value',
        },
      ],
    });
    expect(result.extra_costs_capitalized).toBe(30);
    expect(result.extra_costs_non_capitalized).toBe(25);
    expect(result.final_inventory_total).toBe(130);
    // Grand total = base 100 + capitalized 30 + non-cap 25 = 155
    expect(result.grand_total_preview).toBe(155);
    // Only the capitalized portion lands on the unit cost.
    expect(result.lines[0].final_unit_cost).toBe(130);
  });

  it('non-capitalized extras do not change unit cost', () => {
    const result = computeLandedPreview({
      lines: [{ variant_id: 'a', quantity: 2, base_unit_cost: 50 }],
      extras: [
        {
          cost_type: 'other',
          amount: 100,
          capitalize_to_inventory: false,
          allocation_method: 'by_value',
        },
      ],
    });
    expect(result.lines[0].allocated_cost_total).toBe(0);
    expect(result.lines[0].final_unit_cost).toBe(50);
    expect(result.extra_costs_non_capitalized).toBe(100);
  });
});

describe('computeLandedPreview — deterministic rounding remainder', () => {
  it('assigns rounding residual to the largest base line (tie-broken lex on variant_id)', () => {
    // 10 EGP split by_value over three equal-base lines should give
    // 3.33 / 3.33 / 3.33 = 9.99 — residual 0.01 lands on the
    // alphabetically smallest variant_id ("a") because all base_line_totals tie.
    const result = computeLandedPreview({
      lines: [
        { variant_id: 'c', quantity: 1, base_unit_cost: 100 },
        { variant_id: 'a', quantity: 1, base_unit_cost: 100 },
        { variant_id: 'b', quantity: 1, base_unit_cost: 100 },
      ],
      extras: [
        {
          cost_type: 'transport',
          amount: 10,
          capitalize_to_inventory: true,
          allocation_method: 'by_value',
        },
      ],
    });
    const sumAllocated = result.lines.reduce(
      (s, l) => s + l.allocated_cost_total,
      0,
    );
    expect(Math.round(sumAllocated * 100) / 100).toBe(10);
    // The alphabetically smallest variant_id absorbs the residual penny.
    const byVid = Object.fromEntries(
      result.lines.map((l) => [l.variant_id, l.allocated_cost_total]),
    );
    expect(byVid.a).toBe(3.34);
    expect(byVid.b).toBe(3.33);
    expect(byVid.c).toBe(3.33);
  });
});

describe('computeLandedPreview — grand total preserves invoice fields', () => {
  it('rolls shipping/discount/tax into grand_total_preview', () => {
    const result = computeLandedPreview({
      lines: [{ variant_id: 'a', quantity: 1, base_unit_cost: 100 }],
      extras: [
        {
          cost_type: 'transport',
          amount: 20,
          capitalize_to_inventory: true,
          allocation_method: 'by_value',
        },
      ],
      shipping_cost: 15,
      discount_amount: 10,
      tax_amount: 5,
    });
    // base 100 - disc 10 + tax 5 + ship 15 + cap 20 + non-cap 0 = 130
    expect(result.grand_total_preview).toBe(130);
    expect(result.shipping_cost).toBe(15);
    expect(result.discount_amount).toBe(10);
    expect(result.tax_amount).toBe(5);
  });
});
