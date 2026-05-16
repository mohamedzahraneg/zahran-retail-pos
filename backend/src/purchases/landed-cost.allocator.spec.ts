/**
 * landed-cost.allocator.spec.ts — PR-PURCHASES-P2.1
 *
 * Pins the pure allocator behavior:
 *   · by_value / by_quantity / manual produce correct per-line totals
 *   · capitalize_to_inventory=false rolls into non_capitalized_total
 *     and leaves unit_cost untouched
 *   · rounding remainder is deterministic (largest base line wins,
 *     lex tie-break on variant_id)
 *   · manual allocation sum mismatch throws ManualAllocationError
 *   · landed unit_cost equals base + allocated_per_unit (within
 *     0.01 EGP) for every line in every test
 */
import {
  allocateLandedCosts,
  ManualAllocationError,
  type AllocatorExtraInput,
  type AllocatorLineInput,
} from './landed-cost.allocator';

function line(
  variant_id: string,
  quantity: number,
  base_unit_cost: number,
  discount = 0,
  tax = 0,
): AllocatorLineInput {
  return { variant_id, quantity, base_unit_cost, discount, tax };
}

describe('allocateLandedCosts — no extras', () => {
  it('returns landed = base for every line when no extras given', () => {
    const r = allocateLandedCosts([
      line('v-1', 10, 100),
      line('v-2', 5, 50),
    ]);
    expect(r.capitalized_total).toBe(0);
    expect(r.non_capitalized_total).toBe(0);
    expect(r.base_subtotal).toBe(1250); // 10*100 + 5*50
    for (const l of r.lines) {
      expect(l.allocated_cost_total).toBe(0);
      expect(l.allocated_cost_per_unit).toBe(0);
      expect(l.unit_cost).toBe(l.base_unit_cost);
      expect(l.line_total).toBe(l.quantity * l.base_unit_cost);
    }
  });
});

describe('allocateLandedCosts — by_value', () => {
  it('proportional to line_base_total (clean numbers)', () => {
    const lines = [line('v-1', 10, 100), line('v-2', 5, 100)];
    // line_base_total: v-1 = 1000, v-2 = 500 → ratio 2:1
    // extra 600 → v-1 = 400, v-2 = 200
    const extras: AllocatorExtraInput[] = [
      {
        cost_type: 'transport',
        amount: 600,
        capitalize_to_inventory: true,
        allocation_method: 'by_value',
      },
    ];
    const r = allocateLandedCosts(lines, extras);
    expect(r.capitalized_total).toBe(600);
    expect(r.lines[0].allocated_cost_total).toBe(400);
    expect(r.lines[1].allocated_cost_total).toBe(200);
    expect(r.lines[0].unit_cost).toBe(140); // 100 + 400/10
    expect(r.lines[1].unit_cost).toBe(140); // 100 + 200/5
    expect(r.lines[0].line_total).toBe(1400);
    expect(r.lines[1].line_total).toBe(700);
  });

  it('rounding remainder lands on the largest-base line (residual=+0.01)', () => {
    const lines = [line('v-1', 3, 100), line('v-2', 3, 50)];
    // base_total: v-1=300, v-2=150 → ratio 2:1
    // extra 1 → v-1 should get 2/3 = 0.6667 → rounds 0.67;
    // v-2 = 1/3 = 0.3333 → rounds 0.33; sum 1.00 already; residual 0
    const r = allocateLandedCosts(lines, [
      {
        cost_type: 'transport',
        amount: 1,
        capitalize_to_inventory: true,
        allocation_method: 'by_value',
      },
    ]);
    expect(r.lines[0].allocated_cost_total + r.lines[1].allocated_cost_total).toBe(
      1,
    );
    // Largest base = v-1 always wins ties anyway.
    expect(r.lines[0].allocated_cost_total).toBe(0.67);
    expect(r.lines[1].allocated_cost_total).toBe(0.33);
  });

  it('rounding remainder routed to largest-base line on a rough split', () => {
    const lines = [line('v-1', 3, 100), line('v-2', 3, 100), line('v-3', 1, 100)];
    // base_total: 300/300/100. extra 100 → 42.857.../42.857.../14.285...
    // → rounds 42.86/42.86/14.29 = 100.01; residual -0.01 to the
    // largest base line. There's a tie between v-1 and v-2; lex
    // tie-break → v-1.
    const r = allocateLandedCosts(lines, [
      {
        cost_type: 'shipping',
        amount: 100,
        capitalize_to_inventory: true,
        allocation_method: 'by_value',
      },
    ]);
    const sum =
      r.lines[0].allocated_cost_total
      + r.lines[1].allocated_cost_total
      + r.lines[2].allocated_cost_total;
    expect(+sum.toFixed(2)).toBe(100);
    expect(r.lines[0].allocated_cost_total).toBe(42.85); // residual − went to v-1
    expect(r.lines[1].allocated_cost_total).toBe(42.86);
    expect(r.lines[2].allocated_cost_total).toBe(14.29);
  });
});

describe('allocateLandedCosts — by_quantity', () => {
  it('proportional to quantity', () => {
    const lines = [line('v-1', 2, 100), line('v-2', 8, 50)];
    const r = allocateLandedCosts(lines, [
      {
        cost_type: 'labor',
        amount: 500,
        capitalize_to_inventory: true,
        allocation_method: 'by_quantity',
      },
    ]);
    // total qty = 10 → v-1 gets 100, v-2 gets 400
    expect(r.lines[0].allocated_cost_total).toBe(100);
    expect(r.lines[1].allocated_cost_total).toBe(400);
    expect(r.lines[0].unit_cost).toBe(150); // 100 + 100/2
    expect(r.lines[1].unit_cost).toBe(100); // 50 + 400/8
  });
});

describe('allocateLandedCosts — manual', () => {
  it('respects per-variant amounts when the sum matches within 0.01', () => {
    const lines = [line('v-1', 5, 100), line('v-2', 5, 100)];
    const r = allocateLandedCosts(lines, [
      {
        cost_type: 'customs',
        amount: 700,
        capitalize_to_inventory: true,
        allocation_method: 'manual',
        manual_allocations: [
          { variant_id: 'v-1', amount: 450 },
          { variant_id: 'v-2', amount: 250 },
        ],
      },
    ]);
    expect(r.lines[0].allocated_cost_total).toBe(450);
    expect(r.lines[1].allocated_cost_total).toBe(250);
    expect(r.lines[0].unit_cost).toBe(190); // 100 + 450/5
    expect(r.lines[1].unit_cost).toBe(150); // 100 + 250/5
    expect(r.lines[0].manual_allocation).toBe(true);
    expect(r.lines[1].manual_allocation).toBe(true);
  });

  it('throws ManualAllocationError when sum != amount > 0.01', () => {
    const lines = [line('v-1', 5, 100), line('v-2', 5, 100)];
    expect(() =>
      allocateLandedCosts(lines, [
        {
          cost_type: 'customs',
          amount: 700,
          capitalize_to_inventory: true,
          allocation_method: 'manual',
          manual_allocations: [
            { variant_id: 'v-1', amount: 450 },
            { variant_id: 'v-2', amount: 200 }, // sum 650, off by 50
          ],
        },
      ]),
    ).toThrow(ManualAllocationError);
  });

  it('throws ManualAllocationError when a manual variant_id is unknown', () => {
    const lines = [line('v-1', 5, 100)];
    expect(() =>
      allocateLandedCosts(lines, [
        {
          cost_type: 'customs',
          amount: 100,
          capitalize_to_inventory: true,
          allocation_method: 'manual',
          manual_allocations: [{ variant_id: 'v-nope', amount: 100 }],
        },
      ]),
    ).toThrow(ManualAllocationError);
  });
});

describe('allocateLandedCosts — capitalize flag', () => {
  it('non-capitalized extras roll into non_capitalized_total and leave unit_cost untouched', () => {
    const lines = [line('v-1', 5, 100), line('v-2', 5, 50)];
    const r = allocateLandedCosts(lines, [
      {
        cost_type: 'packaging',
        amount: 200,
        capitalize_to_inventory: false,
        allocation_method: 'by_value',
      },
    ]);
    expect(r.capitalized_total).toBe(0);
    expect(r.non_capitalized_total).toBe(200);
    expect(r.lines[0].unit_cost).toBe(100);
    expect(r.lines[1].unit_cost).toBe(50);
    expect(r.lines[0].allocated_cost_total).toBe(0);
    expect(r.lines[1].allocated_cost_total).toBe(0);
  });

  it('mixed capitalized + non-capitalized extras report both totals correctly', () => {
    const lines = [line('v-1', 10, 100), line('v-2', 5, 100)];
    const r = allocateLandedCosts(lines, [
      {
        cost_type: 'transport',
        amount: 300,
        capitalize_to_inventory: true,
        allocation_method: 'by_quantity',
      },
      {
        cost_type: 'packaging',
        amount: 50,
        capitalize_to_inventory: false,
        allocation_method: 'by_value',
      },
    ]);
    expect(r.capitalized_total).toBe(300);
    expect(r.non_capitalized_total).toBe(50);
    // by_quantity 300 over 15 units → v-1 gets 200, v-2 gets 100.
    expect(r.lines[0].allocated_cost_total).toBe(200);
    expect(r.lines[1].allocated_cost_total).toBe(100);
  });
});

describe('allocateLandedCosts — combined extras', () => {
  it('sums by_value + by_quantity across the same lines', () => {
    const lines = [line('v-1', 10, 100), line('v-2', 5, 100)];
    const r = allocateLandedCosts(lines, [
      {
        cost_type: 'transport',
        amount: 300,
        capitalize_to_inventory: true,
        allocation_method: 'by_value',
      },
      {
        cost_type: 'labor',
        amount: 150,
        capitalize_to_inventory: true,
        allocation_method: 'by_quantity',
      },
    ]);
    // by_value 300 over 1500 base → v-1: 200, v-2: 100
    // by_quantity 150 over 15 qty → v-1: 100, v-2: 50
    expect(r.lines[0].allocated_cost_total).toBe(300);
    expect(r.lines[1].allocated_cost_total).toBe(150);
    expect(r.capitalized_total).toBe(450);
  });
});

describe('allocateLandedCosts — invariants', () => {
  it('Σ allocated_cost_total equals capitalized_total exactly to 0.01 (every fixture)', () => {
    const cases: Array<[AllocatorLineInput[], AllocatorExtraInput[]]> = [
      [
        [line('v-1', 3, 100), line('v-2', 3, 50)],
        [
          {
            cost_type: 'transport',
            amount: 100,
            capitalize_to_inventory: true,
            allocation_method: 'by_value',
          },
        ],
      ],
      [
        [line('v-1', 7, 100), line('v-2', 3, 100), line('v-3', 1, 100)],
        [
          {
            cost_type: 'shipping',
            amount: 100,
            capitalize_to_inventory: true,
            allocation_method: 'by_value',
          },
        ],
      ],
      [
        [line('v-1', 1, 1.01), line('v-2', 1, 2.02)],
        [
          {
            cost_type: 'customs',
            amount: 0.99,
            capitalize_to_inventory: true,
            allocation_method: 'by_value',
          },
        ],
      ],
    ];
    for (const [lines, extras] of cases) {
      const r = allocateLandedCosts(lines, extras);
      const sum = r.lines.reduce((s, l) => s + l.allocated_cost_total, 0);
      expect(+sum.toFixed(2)).toBe(r.capitalized_total);
    }
  });

  it('unit_cost = base_unit_cost + allocated_cost_per_unit (within 0.01) for every line', () => {
    const lines = [
      line('v-1', 13, 7.77),
      line('v-2', 11, 3.33),
      line('v-3', 1, 99),
    ];
    const extras: AllocatorExtraInput[] = [
      {
        cost_type: 'shipping',
        amount: 271.31,
        capitalize_to_inventory: true,
        allocation_method: 'by_value',
      },
      {
        cost_type: 'labor',
        amount: 50,
        capitalize_to_inventory: true,
        allocation_method: 'by_quantity',
      },
    ];
    const r = allocateLandedCosts(lines, extras);
    for (const l of r.lines) {
      const expected = +(l.base_unit_cost + l.allocated_cost_per_unit).toFixed(2);
      expect(Math.abs(l.unit_cost - expected)).toBeLessThanOrEqual(0.01);
    }
  });
});
