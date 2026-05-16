/**
 * purchases.service.p2.spec.ts — PR-PURCHASES-P2.1
 *
 * Integration-style pin for the landed-cost wiring in
 * PurchasesService.create() and AccountingPostingService.postPurchase().
 *
 * The DataSource is stubbed so we can assert the exact SQL the service
 * emits + the parameters it binds — same proven pattern from
 * `purchases.service.p1.spec.ts` and other purchase specs.
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
  // The transaction manager mirrors ds.query so we can capture both
  // outer-list reads and inside-transaction writes from a single
  // queue.
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

describe('PurchasesService.create — Phase 2.1 landed costs', () => {
  it('without extra_costs: backward compatible (subtotal = base, extras = 0)', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: 'pur-1', purchase_no: 'PO-2026-000001' }], // INSERT purchases RETURNING *
        [], // INSERT purchase_items
      ],
    });

    await service.create(
      {
        supplier_id: SUPPLIER,
        warehouse_id: WAREHOUSE,
        items: [
          { variant_id: V1, quantity: 10, unit_cost: 100 },
        ],
      } as any,
      USER,
    );

    const headerInsert = findInsert(calls, /INSERT INTO purchases\b/);
    expect(headerInsert).toBeDefined();
    // params order: supplier_id, warehouse_id, invoice_date, due_date,
    //   supplier_ref, subtotal, discount, tax, shipping, grand_total,
    //   extra_costs_capitalized, extra_costs_non_capitalized,
    //   notes, created_by
    const p = headerInsert!.params;
    expect(p[5]).toBe(1000); // subtotal = 10 × 100
    expect(p[9]).toBe(1000); // grand_total
    expect(p[10]).toBe(0); // extra_costs_capitalized
    expect(p[11]).toBe(0); // extra_costs_non_capitalized

    const itemInsert = findInsert(calls, /INSERT INTO purchase_items\b/);
    expect(itemInsert).toBeDefined();
    // (purchase_id, variant_id, quantity, base_unit_cost,
    //  allocated_cost_total, allocated_cost_per_unit, unit_cost,
    //  discount, tax, line_total, manual_allocation)
    expect(itemInsert!.params[2]).toBe(10); // quantity
    expect(itemInsert!.params[3]).toBe(100); // base_unit_cost
    expect(itemInsert!.params[4]).toBe(0); // allocated_cost_total
    expect(itemInsert!.params[5]).toBe(0); // allocated_cost_per_unit
    expect(itemInsert!.params[6]).toBe(100); // unit_cost (= base)
    expect(itemInsert!.params[9]).toBe(1000); // line_total
    expect(itemInsert!.params[10]).toBe(false); // manual_allocation

    // No extras insert.
    expect(findAllInserts(calls, /INSERT INTO purchase_extra_costs\b/)).toHaveLength(0);
  });

  it('by_value capitalized extra: products 10000 + transport 1000', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: 'pur-2', purchase_no: 'PO-2026-000002' }],
        [], [], // 2 item INSERTs
        [],     // 1 extra INSERT
      ],
    });

    await service.create(
      {
        supplier_id: SUPPLIER,
        warehouse_id: WAREHOUSE,
        items: [
          { variant_id: V1, quantity: 50, unit_cost: 100 }, // base 5000
          { variant_id: V2, quantity: 25, unit_cost: 200 }, // base 5000
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
    );

    // Header
    const header = findInsert(calls, /INSERT INTO purchases\b/)!;
    expect(header.params[5]).toBe(10000); // subtotal (base products)
    expect(header.params[9]).toBe(11000); // grand_total
    expect(header.params[10]).toBe(1000); // extra_costs_capitalized
    expect(header.params[11]).toBe(0); // extra_costs_non_capitalized

    // Items — equal value split → 500 each
    const items = findAllInserts(calls, /INSERT INTO purchase_items\b/);
    expect(items).toHaveLength(2);
    const v1 = items.find((i) => i.params[1] === V1)!;
    const v2 = items.find((i) => i.params[1] === V2)!;
    expect(v1.params[4]).toBe(500); // allocated_cost_total
    expect(v2.params[4]).toBe(500);
    expect(v1.params[6]).toBe(110); // unit_cost (100 + 500/50)
    expect(v2.params[6]).toBe(220); // unit_cost (200 + 500/25)

    // Extra row persisted
    const extras = findAllInserts(calls, /INSERT INTO purchase_extra_costs\b/);
    expect(extras).toHaveLength(1);
    expect(extras[0].params[1]).toBe('transport');
    expect(extras[0].params[3]).toBe(1000); // amount
    expect(extras[0].params[4]).toBe(true); // capitalize
  });

  it('by_quantity capitalized extra: 5 vs 15 units', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: 'pur-3', purchase_no: 'PO-2026-000003' }],
        [], [], [],
      ],
    });

    await service.create(
      {
        supplier_id: SUPPLIER,
        warehouse_id: WAREHOUSE,
        items: [
          { variant_id: V1, quantity: 5, unit_cost: 200 }, // 1000
          { variant_id: V2, quantity: 15, unit_cost: 100 }, // 1500
        ],
        extra_costs: [
          {
            cost_type: 'labor',
            amount: 400,
            capitalize_to_inventory: true,
            allocation_method: 'by_quantity',
          },
        ],
      } as any,
      USER,
    );

    const items = findAllInserts(calls, /INSERT INTO purchase_items\b/);
    const v1 = items.find((i) => i.params[1] === V1)!;
    const v2 = items.find((i) => i.params[1] === V2)!;
    // by_quantity: 5/(5+15)=0.25, 15/20=0.75 → 100, 300
    expect(v1.params[4]).toBe(100);
    expect(v2.params[4]).toBe(300);
    expect(v1.params[6]).toBe(220); // 200 + 100/5
    expect(v2.params[6]).toBe(120); // 100 + 300/15
  });

  it('combined extras: by_value + by_quantity totals sum correctly', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: 'pur-4', purchase_no: 'PO-2026-000004' }],
        [], [], [], [],
      ],
    });

    await service.create(
      {
        supplier_id: SUPPLIER,
        warehouse_id: WAREHOUSE,
        items: [
          { variant_id: V1, quantity: 10, unit_cost: 100 }, // base 1000
          { variant_id: V2, quantity: 5, unit_cost: 100 }, //  base 500
        ],
        extra_costs: [
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
        ],
      } as any,
      USER,
    );

    const header = findInsert(calls, /INSERT INTO purchases\b/)!;
    expect(header.params[10]).toBe(450); // extras_capitalized
    expect(header.params[9]).toBe(1950); // grand_total = 1500 + 450
    const items = findAllInserts(calls, /INSERT INTO purchase_items\b/);
    // v-1: by_value 200 + by_qty 100 = 300; v-2: by_value 100 + by_qty 50 = 150
    expect(items.find((i) => i.params[1] === V1)!.params[4]).toBe(300);
    expect(items.find((i) => i.params[1] === V2)!.params[4]).toBe(150);
  });

  it('manual allocation: exact sum persists per-line amounts', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: 'pur-5', purchase_no: 'PO-2026-000005' }],
        [], [], [],
      ],
    });

    await service.create(
      {
        supplier_id: SUPPLIER,
        warehouse_id: WAREHOUSE,
        items: [
          { variant_id: V1, quantity: 10, unit_cost: 100 },
          { variant_id: V2, quantity: 5, unit_cost: 100 },
        ],
        extra_costs: [
          {
            cost_type: 'customs',
            amount: 600,
            capitalize_to_inventory: true,
            allocation_method: 'manual',
            manual_allocations: [
              { variant_id: V1, amount: 400 },
              { variant_id: V2, amount: 200 },
            ],
          },
        ],
      } as any,
      USER,
    );

    const items = findAllInserts(calls, /INSERT INTO purchase_items\b/);
    const v1 = items.find((i) => i.params[1] === V1)!;
    const v2 = items.find((i) => i.params[1] === V2)!;
    expect(v1.params[4]).toBe(400);
    expect(v2.params[4]).toBe(200);
    expect(v1.params[10]).toBe(true); // manual_allocation flag
    expect(v2.params[10]).toBe(true);
  });

  it('manual allocation mismatch: rejects with Arabic error and inserts nothing', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: 'unreachable' }],
      ],
    });

    let thrown: unknown = null;
    try {
      await service.create(
        {
          supplier_id: SUPPLIER,
          warehouse_id: WAREHOUSE,
          items: [
            { variant_id: V1, quantity: 10, unit_cost: 100 },
            { variant_id: V2, quantity: 5, unit_cost: 100 },
          ],
          extra_costs: [
            {
              cost_type: 'customs',
              amount: 600,
              capitalize_to_inventory: true,
              allocation_method: 'manual',
              manual_allocations: [
                { variant_id: V1, amount: 400 },
                { variant_id: V2, amount: 100 }, // off by 100
              ],
            },
          ],
        } as any,
        USER,
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as Error).message).toContain(
      'إجمالي التوزيع اليدوي للمصاريف يجب أن يساوي قيمة المصروف.',
    );

    // No purchase / items / extras inserted (the transaction wasn't even
    // entered — allocation runs first).
    expect(findAllInserts(calls, /INSERT INTO purchases\b/)).toHaveLength(0);
    expect(findAllInserts(calls, /INSERT INTO purchase_items\b/)).toHaveLength(0);
    expect(findAllInserts(calls, /INSERT INTO purchase_extra_costs\b/)).toHaveLength(0);
  });

  it('non-capitalized extras: do not change line unit_cost; do update grand_total + aggregate', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: 'pur-6', purchase_no: 'PO-2026-000006' }],
        [], [],
      ],
    });

    await service.create(
      {
        supplier_id: SUPPLIER,
        warehouse_id: WAREHOUSE,
        items: [
          { variant_id: V1, quantity: 10, unit_cost: 100 },
        ],
        extra_costs: [
          {
            cost_type: 'packaging',
            amount: 75,
            capitalize_to_inventory: false,
            allocation_method: 'by_value',
          },
        ],
      } as any,
      USER,
    );

    const header = findInsert(calls, /INSERT INTO purchases\b/)!;
    expect(header.params[5]).toBe(1000); // subtotal (base)
    expect(header.params[10]).toBe(0); // extras_capitalized
    expect(header.params[11]).toBe(75); // extras_non_capitalized
    expect(header.params[9]).toBe(1075); // grand_total

    const item = findInsert(calls, /INSERT INTO purchase_items\b/)!;
    expect(item.params[3]).toBe(100); // base_unit_cost
    expect(item.params[4]).toBe(0); // allocated_cost_total
    expect(item.params[6]).toBe(100); // unit_cost UNCHANGED (= base)
  });

  it('rounding remainder: 3 lines with uneven split end with sum exactly == capitalized_total', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: 'pur-7', purchase_no: 'PO-2026-000007' }],
        [], [], [], [],
      ],
    });

    await service.create(
      {
        supplier_id: SUPPLIER,
        warehouse_id: WAREHOUSE,
        items: [
          { variant_id: V1, quantity: 3, unit_cost: 100 }, // base 300
          { variant_id: V2, quantity: 3, unit_cost: 100 }, // base 300
          {
            variant_id: '66666666-6666-6666-6666-666666666666',
            quantity: 1,
            unit_cost: 100,
          }, // base 100
        ],
        extra_costs: [
          {
            cost_type: 'shipping',
            amount: 100,
            capitalize_to_inventory: true,
            allocation_method: 'by_value',
          },
        ],
      } as any,
      USER,
    );

    const items = findAllInserts(calls, /INSERT INTO purchase_items\b/);
    const sum = items.reduce(
      (s, it) => s + Number(it.params[4] || 0),
      0,
    );
    // Exactly equal to the capitalized total (100) to 0.01 EGP.
    expect(+sum.toFixed(2)).toBe(100);
  });
});

describe('PurchasesService.create — invariants', () => {
  it('subtotal preserved as BASE products subtotal even with extras', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: 'pur-8' }],
        [], [], [],
      ],
    });
    await service.create(
      {
        supplier_id: SUPPLIER,
        warehouse_id: WAREHOUSE,
        items: [
          { variant_id: V1, quantity: 10, unit_cost: 100 },
          { variant_id: V2, quantity: 5, unit_cost: 50 },
        ],
        extra_costs: [
          {
            cost_type: 'transport',
            amount: 500,
            capitalize_to_inventory: true,
            allocation_method: 'by_value',
          },
        ],
      } as any,
      USER,
    );
    const header = findInsert(calls, /INSERT INTO purchases\b/)!;
    expect(header.params[5]).toBe(1250); // BASE subtotal, NOT 1750
  });

  it('grand_total = subtotal + capitalized + non_capitalized − discount + tax + shipping', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: 'pur-9' }],
        [], [], [],
      ],
    });
    await service.create(
      {
        supplier_id: SUPPLIER,
        warehouse_id: WAREHOUSE,
        shipping_cost: 50,
        discount_amount: 20,
        tax_amount: 30,
        items: [
          { variant_id: V1, quantity: 10, unit_cost: 100 },
        ],
        extra_costs: [
          {
            cost_type: 'transport',
            amount: 100,
            capitalize_to_inventory: true,
            allocation_method: 'by_value',
          },
          {
            cost_type: 'packaging',
            amount: 40,
            capitalize_to_inventory: false,
            allocation_method: 'by_value',
          },
        ],
      } as any,
      USER,
    );
    const header = findInsert(calls, /INSERT INTO purchases\b/)!;
    // 1000 + 100 + 40 - 20 + 30 + 50 = 1200
    expect(header.params[9]).toBe(1200);
  });
});
