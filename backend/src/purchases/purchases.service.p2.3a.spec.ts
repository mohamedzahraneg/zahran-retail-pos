/**
 * purchases.service.p2.3a.spec.ts — PR-PURCHASES-P2.3A
 *
 * Pins the draft-edit landed-cost rewrite + the non-draft block.
 *
 * Shape mirrors purchases.service.p2.spec.ts:
 *   · DataSource is stubbed; both ds.query and the transaction's inner
 *     query share one capture queue so we can assert the exact SQL +
 *     bound params for the UPDATE / DELETE / INSERT cascade.
 *   · queue.shift() returns canned rows in the order the service issues
 *     them (existing-purchase fetch, INSERT, etc.).
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { PurchasesService } from './purchases.service';

type QueryCall = { sql: string; params: any[] };

interface MakeServiceOpts {
  responses?: Array<any[]>;
}

async function makeService(opts: MakeServiceOpts = {}) {
  const queue = [...(opts.responses ?? [])];
  const calls: QueryCall[] = [];
  const innerQuery = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    return queue.length ? queue.shift() : [];
  });
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return queue.length ? queue.shift() : [];
    }),
    transaction: jest.fn(async (cb: any) => cb({ query: innerQuery })),
  };
  const moduleRef = await Test.createTestingModule({
    providers: [
      PurchasesService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  const service = moduleRef.get(PurchasesService);
  return { service, calls };
}

const PURCHASE = '00000000-0000-0000-0000-0000000000aa';
const SUPPLIER = '11111111-1111-1111-1111-111111111111';
const WAREHOUSE = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';
const V1 = '44444444-4444-4444-4444-444444444444';
const V2 = '55555555-5555-5555-5555-555555555555';

function findInsert(calls: QueryCall[], pat: RegExp): QueryCall | undefined {
  return calls.find((c) => pat.test(c.sql));
}
function findAllInserts(calls: QueryCall[], pat: RegExp): QueryCall[] {
  return calls.filter((c) => pat.test(c.sql));
}
function findAll(calls: QueryCall[], pat: RegExp): QueryCall[] {
  return calls.filter((c) => pat.test(c.sql));
}

function draftRow(overrides: Record<string, any> = {}) {
  return {
    id: PURCHASE,
    status: 'draft',
    supplier_id: SUPPLIER,
    warehouse_id: WAREHOUSE,
    notes: null,
    ...overrides,
  };
}

function receivedRow(overrides: Record<string, any> = {}) {
  return draftRow({ status: 'received', ...overrides });
}

describe('PurchasesService.edit — P2.3A draft landed-cost path', () => {
  it('1. adds a capitalized extra cost and recalculates landed unit_cost', async () => {
    const { service, calls } = await makeService({
      responses: [
        [draftRow()],            // SELECT * FROM purchases WHERE id
        [],                      // UPDATE purchases
        [],                      // DELETE FROM purchase_items
        [],                      // INSERT purchase_items (line 1)
        [],                      // INSERT purchase_items (line 2)
        [],                      // DELETE FROM purchase_extra_costs
        [],                      // INSERT purchase_extra_costs (extra 1)
        [{ id: PURCHASE, status: 'draft', grand_total: '11000.00' }], // SELECT *
      ],
    });

    await service.edit(
      PURCHASE,
      {
        supplier_id: SUPPLIER,
        warehouse_id: WAREHOUSE,
        items: [
          { variant_id: V1, quantity: 50, unit_cost: 100 }, // base 5000
          { variant_id: V2, quantity: 50, unit_cost: 100 }, // base 5000
        ],
        extra_costs: [
          {
            cost_type: 'transport',
            amount: 1000,
            capitalize_to_inventory: true,
            allocation_method: 'by_value',
          },
        ],
      } as any,
      USER,
      'تعديل تجريبي',
    );

    // Header UPDATE carries the recomputed totals (Phase-2.1 columns).
    // Param order: id, supplier_id, warehouse_id, notes, subtotal,
    //   shipping_cost, discount_amount, tax_amount, grand_total,
    //   extra_costs_capitalized, extra_costs_non_capitalized.
    const headerUpdate = findInsert(calls, /UPDATE purchases\b/);
    expect(headerUpdate).toBeDefined();
    expect(headerUpdate!.params[4]).toBe(10000); // subtotal = base
    expect(headerUpdate!.params[8]).toBe(11000); // grand_total
    expect(headerUpdate!.params[9]).toBe(1000); // extra_costs_capitalized
    expect(headerUpdate!.params[10]).toBe(0); // extra_costs_non_capitalized

    // Per-line INSERTs (base_unit_cost / allocated_*_total / unit_cost).
    const itemInserts = findAllInserts(calls, /INSERT INTO purchase_items\b/);
    expect(itemInserts).toHaveLength(2);
    // Either order is fine; line 1 and 2 each got 500 allocated (50%
    // by_value of 1000), so landed unit_cost = 100 + 10 = 110.
    for (const it of itemInserts) {
      expect(it.params[3]).toBe(100); // base_unit_cost
      expect(it.params[4]).toBe(500); // allocated_cost_total
      expect(it.params[5]).toBe(10); // allocated_cost_per_unit
      expect(it.params[6]).toBe(110); // unit_cost (landed)
      expect(it.params[10]).toBe(false); // manual_allocation
    }

    // Extra cost row persisted.
    const extraInsert = findInsert(calls, /INSERT INTO purchase_extra_costs\b/);
    expect(extraInsert).toBeDefined();
    expect(extraInsert!.params[1]).toBe('transport'); // cost_type
    expect(extraInsert!.params[3]).toBe(1000); // amount
    expect(extraInsert!.params[4]).toBe(true); // capitalize_to_inventory
    expect(extraInsert!.params[5]).toBe('by_value'); // allocation_method
  });

  it('2. changes allocation method from by_value to by_quantity', async () => {
    const { service, calls } = await makeService({
      responses: [
        [draftRow()],
        [], [], [], [], [], [],
        [{ id: PURCHASE }],
      ],
    });

    await service.edit(
      PURCHASE,
      {
        supplier_id: SUPPLIER,
        warehouse_id: WAREHOUSE,
        items: [
          { variant_id: V1, quantity: 80, unit_cost: 10 }, // base 800
          { variant_id: V2, quantity: 20, unit_cost: 100 }, // base 2000
        ],
        extra_costs: [
          {
            cost_type: 'labor',
            amount: 200,
            capitalize_to_inventory: true,
            allocation_method: 'by_quantity',
          },
        ],
      } as any,
      USER,
      'change method',
    );

    const itemInserts = findAllInserts(calls, /INSERT INTO purchase_items\b/);
    // by_quantity: 80/100 → 160; 20/100 → 40
    const byVariant = new Map(
      itemInserts.map((it) => [it.params[1] as string, it.params]),
    );
    expect(byVariant.get(V1)![4]).toBe(160); // allocated_cost_total
    expect(byVariant.get(V2)![4]).toBe(40);
  });

  it('3. manual mismatch rejects with the Arabic error and inserts nothing', async () => {
    const { service, calls } = await makeService({
      responses: [
        [draftRow()],
      ],
    });

    await expect(
      service.edit(
        PURCHASE,
        {
          supplier_id: SUPPLIER,
          warehouse_id: WAREHOUSE,
          items: [
            { variant_id: V1, quantity: 1, unit_cost: 100 },
            { variant_id: V2, quantity: 1, unit_cost: 100 },
          ],
          extra_costs: [
            {
              cost_type: 'customs',
              amount: 80,
              capitalize_to_inventory: true,
              allocation_method: 'manual',
              manual_allocations: [
                { variant_id: V1, amount: 30 },
                { variant_id: V2, amount: 40 }, // 70 ≠ 80
              ],
            },
          ],
        } as any,
        USER,
        'mismatch',
      ),
    ).rejects.toMatchObject({
      message: 'إجمالي التوزيع اليدوي للمصاريف يجب أن يساوي قيمة المصروف.',
    });

    // Nothing should have been written: no UPDATE, no INSERT.
    expect(findAll(calls, /UPDATE purchases\b/)).toHaveLength(0);
    expect(findAll(calls, /INSERT INTO purchase_items\b/)).toHaveLength(0);
    expect(findAll(calls, /INSERT INTO purchase_extra_costs\b/)).toHaveLength(0);
  });

  it('4. removes all extras and resets per-line allocations to zero', async () => {
    const { service, calls } = await makeService({
      responses: [
        [draftRow()],
        [], [], [],
        [],                       // DELETE FROM purchase_extra_costs
        [{ id: PURCHASE }],
      ],
    });

    await service.edit(
      PURCHASE,
      {
        supplier_id: SUPPLIER,
        warehouse_id: WAREHOUSE,
        items: [
          { variant_id: V1, quantity: 10, unit_cost: 100 },
        ],
        extra_costs: [], // explicit empty
      } as any,
      USER,
      'remove extras',
    );

    const headerUpdate = findInsert(calls, /UPDATE purchases\b/);
    expect(headerUpdate!.params[9]).toBe(0); // extra_costs_capitalized
    expect(headerUpdate!.params[10]).toBe(0); // extra_costs_non_capitalized
    expect(headerUpdate!.params[8]).toBe(1000); // grand_total = base only

    const itemInserts = findAllInserts(calls, /INSERT INTO purchase_items\b/);
    expect(itemInserts).toHaveLength(1);
    expect(itemInserts[0].params[4]).toBe(0); // allocated_cost_total
    expect(itemInserts[0].params[6]).toBe(100); // unit_cost == base

    // DELETE FROM purchase_extra_costs should be emitted, but no INSERT.
    expect(
      findAll(calls, /DELETE FROM purchase_extra_costs\b/),
    ).toHaveLength(1);
    expect(
      findAll(calls, /INSERT INTO purchase_extra_costs\b/),
    ).toHaveLength(0);
  });

  it('5. fills base_unit_cost on every purchase_items INSERT (P2.1 NOT NULL)', async () => {
    const { service, calls } = await makeService({
      responses: [
        [draftRow()],
        [], [], [], [],
        [{ id: PURCHASE }],
      ],
    });

    await service.edit(
      PURCHASE,
      {
        supplier_id: SUPPLIER,
        warehouse_id: WAREHOUSE,
        items: [
          { variant_id: V1, quantity: 2, unit_cost: 25 },
          { variant_id: V2, quantity: 4, unit_cost: 50 },
        ],
      } as any,
      USER,
      'no extras',
    );

    const itemInserts = findAllInserts(calls, /INSERT INTO purchase_items\b/);
    expect(itemInserts).toHaveLength(2);
    for (const it of itemInserts) {
      // Sanity: every INSERT carries a base_unit_cost (column index 3 in
      // the 11-param INSERT). Pre-P2.3A, the draft path used a 7-param
      // INSERT that omitted base_unit_cost entirely → NOT NULL fail.
      expect(it.params).toHaveLength(11);
      expect(it.params[3]).toBeGreaterThan(0); // base_unit_cost
    }
  });

  it('6. received purchase with existing extras blocks BEFORE fn_void_purchase', async () => {
    const { service, calls } = await makeService({
      responses: [
        [receivedRow()],            // SELECT * FROM purchases
        [{ has: 1 }],               // SELECT 1 FROM purchase_extra_costs
      ],
    });

    await expect(
      service.edit(
        PURCHASE,
        {
          supplier_id: SUPPLIER,
          warehouse_id: WAREHOUSE,
          items: [{ variant_id: V1, quantity: 1, unit_cost: 100 }],
        } as any,
        USER,
        'reason',
      ),
    ).rejects.toMatchObject({
      message:
        'لا يمكن تعديل مصاريف فاتورة مشتريات مستلمة أو مدفوعة حاليًا. أنشئ تسوية مخصصة أو تواصل مع المدير.',
    });

    // fn_void_purchase must NOT have run.
    expect(
      findAll(calls, /fn_void_purchase/),
    ).toHaveLength(0);
  });

  it('7. paid purchase with dto.extra_costs blocks BEFORE fn_void_purchase', async () => {
    const { service, calls } = await makeService({
      responses: [
        [receivedRow({ status: 'paid' })], // SELECT * FROM purchases
        [],                                // SELECT 1 FROM purchase_extra_costs (none)
      ],
    });

    await expect(
      service.edit(
        PURCHASE,
        {
          supplier_id: SUPPLIER,
          warehouse_id: WAREHOUSE,
          items: [{ variant_id: V1, quantity: 1, unit_cost: 100 }],
          extra_costs: [
            {
              cost_type: 'transport',
              amount: 50,
              capitalize_to_inventory: true,
              allocation_method: 'by_value',
            },
          ],
        } as any,
        USER,
        'reason',
      ),
    ).rejects.toMatchObject({
      message:
        'لا يمكن تعديل مصاريف فاتورة مشتريات مستلمة أو مدفوعة حاليًا. أنشئ تسوية مخصصة أو تواصل مع المدير.',
    });

    expect(findAll(calls, /fn_void_purchase/)).toHaveLength(0);
  });

  it('8. received purchase WITHOUT extras still uses legacy void+create path', async () => {
    const { service, calls } = await makeService({
      responses: [
        [receivedRow()],                     // SELECT * FROM purchases
        [],                                  // SELECT 1 FROM purchase_extra_costs (none)
        [],                                  // SELECT fn_void_purchase
        // create() path inside the same call:
        [{ id: 'new-pur', purchase_no: 'PO-2026-000099' }], // INSERT purchases
        [],                                  // INSERT purchase_items
      ],
    });

    await service.edit(
      PURCHASE,
      {
        supplier_id: SUPPLIER,
        warehouse_id: WAREHOUSE,
        items: [{ variant_id: V1, quantity: 1, unit_cost: 100 }],
      } as any,
      USER,
      'legacy non-extras edit',
    );

    // fn_void_purchase MUST have run (legacy path preserved).
    expect(findAll(calls, /SELECT fn_void_purchase/)).toHaveLength(1);
    // And create() inserted the replacement.
    expect(
      findAll(calls, /INSERT INTO purchases\b/),
    ).toHaveLength(1);
  });

  it('9. draft landed-cost edit does NOT call fn_void_purchase', async () => {
    const { service, calls } = await makeService({
      responses: [
        [draftRow()],
        [], [], [], [], [], [],
        [{ id: PURCHASE }],
      ],
    });

    await service.edit(
      PURCHASE,
      {
        supplier_id: SUPPLIER,
        warehouse_id: WAREHOUSE,
        items: [{ variant_id: V1, quantity: 1, unit_cost: 100 }],
        extra_costs: [
          {
            cost_type: 'transport',
            amount: 10,
            capitalize_to_inventory: true,
            allocation_method: 'by_value',
          },
        ],
      } as any,
      USER,
      'no void on draft',
    );

    expect(findAll(calls, /fn_void_purchase/)).toHaveLength(0);
  });

  it('10. cancelled purchase rejects regardless of extras (regression guard)', async () => {
    const { service } = await makeService({
      responses: [
        [{ id: PURCHASE, status: 'cancelled' }],
      ],
    });

    await expect(
      service.edit(
        PURCHASE,
        {
          supplier_id: SUPPLIER,
          warehouse_id: WAREHOUSE,
          items: [{ variant_id: V1, quantity: 1, unit_cost: 100 }],
        } as any,
        USER,
        'reason',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
