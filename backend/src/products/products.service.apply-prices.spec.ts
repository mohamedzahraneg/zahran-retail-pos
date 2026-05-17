/**
 * products.service.apply-prices.spec.ts — PR-PURCHASES-P3.2
 *
 * Pins the manual sale-price apply flow. Stubs the DataSource so we
 * can capture the exact SQL the service emits and assert:
 *   · UPDATE product_variants.selling_price + INSERT variant_price_
 *     history happen inside ONE transaction, per changed item
 *   · price-equal items are skipped (no INSERT)
 *   · missing variants throw NotFound (rolls back the whole txn)
 *   · invalid prices throw BadRequest BEFORE the txn opens
 *   · source_purchase_id + source_purchase_no get persisted
 *   · no accounting / cashbox / stock / posting calls escape this
 *     code path
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProductsService } from './products.service';
import { ProductEntity } from './entities/product.entity';
import { VariantEntity } from './entities/variant.entity';

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
      ProductsService,
      { provide: DataSource, useValue: ds },
      { provide: getRepositoryToken(ProductEntity), useValue: {} },
      { provide: getRepositoryToken(VariantEntity), useValue: {} },
    ],
  }).compile();
  const service = moduleRef.get(ProductsService);
  return { service, calls, ds };
}

const V1 = '11111111-1111-1111-1111-111111111111';
const V2 = '22222222-2222-2222-2222-222222222222';
const V3 = '33333333-3333-3333-3333-333333333333';
const USER = '44444444-4444-4444-4444-444444444444';
const PURCHASE = '55555555-5555-5555-5555-555555555555';

function findAll(calls: QueryCall[], pat: RegExp): QueryCall[] {
  return calls.filter((c) => pat.test(c.sql));
}

describe('ProductsService.applyVariantPrices — P3.2', () => {
  it('1. updates selling_price + inserts variant_price_history in one txn', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: V1, selling_price: '100.00' }], // SELECT current
        [],                                    // UPDATE selling_price
        [{ id: 'hist-1' }],                    // INSERT history RETURNING id
      ],
    });

    const res = await service.applyVariantPrices(
      { items: [{ variant_id: V1, new_selling_price: 145 }] },
      USER,
    );
    expect(res.updated).toBe(1);
    expect(res.skipped).toBe(0);
    expect(res.items[0]).toMatchObject({
      variant_id: V1,
      old_selling_price: 100,
      new_selling_price: 145,
      skipped: false,
      history_id: 'hist-1',
    });
    expect(findAll(calls, /UPDATE product_variants\b/)).toHaveLength(1);
    expect(findAll(calls, /INSERT INTO variant_price_history\b/)).toHaveLength(1);
  });

  it('2. equal price (within 0.01) skips and does NOT insert history', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: V1, selling_price: '145.005' }], // basically the same
      ],
    });
    const res = await service.applyVariantPrices(
      { items: [{ variant_id: V1, new_selling_price: 145 }] },
      USER,
    );
    expect(res.updated).toBe(0);
    expect(res.skipped).toBe(1);
    expect(res.items[0].skipped).toBe(true);
    expect(res.items[0].history_id).toBeNull();
    expect(findAll(calls, /UPDATE product_variants\b/)).toHaveLength(0);
    expect(findAll(calls, /INSERT INTO variant_price_history\b/)).toHaveLength(0);
  });

  it('3. invalid price rejects BEFORE the transaction opens', async () => {
    const { service, ds } = await makeService();
    await expect(
      service.applyVariantPrices(
        { items: [{ variant_id: V1, new_selling_price: 0 }] },
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ds.transaction).not.toHaveBeenCalled();
  });

  it('4. empty items rejects', async () => {
    const { service } = await makeService();
    await expect(
      service.applyVariantPrices({ items: [] } as any, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('5. missing variant throws NotFound (transaction rolls back)', async () => {
    const { service, calls } = await makeService({
      responses: [
        // First item OK
        [{ id: V1, selling_price: '100.00' }],
        [], // UPDATE
        [{ id: 'hist-1' }], // INSERT history
        // Second item: variant not found
        [], // empty SELECT current
      ],
    });
    await expect(
      service.applyVariantPrices(
        {
          items: [
            { variant_id: V1, new_selling_price: 145 },
            { variant_id: V2, new_selling_price: 200 },
          ],
        },
        USER,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    // The UPDATE + INSERT for V1 still ran inside the transaction; the
    // throw causes TypeORM to roll the whole transaction back, so the
    // test's stub having received the calls is fine (they're recorded
    // for shape inspection but never committed).
    expect(findAll(calls, /UPDATE product_variants\b/)).toHaveLength(1);
  });

  it('6. source_purchase_id + source_purchase_no stored on every row', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ purchase_no: 'PO-2026-000099' }],   // SELECT purchase_no outside txn
        [{ id: V1, selling_price: '100.00' }], // SELECT current
        [],                                    // UPDATE
        [{ id: 'hist-1' }],                    // INSERT history
      ],
    });
    await service.applyVariantPrices(
      {
        source_purchase_id: PURCHASE,
        reason: 'تطبيق من فاتورة شراء',
        items: [{ variant_id: V1, new_selling_price: 145 }],
      },
      USER,
    );
    const insertHistory = calls.find((c) =>
      /INSERT INTO variant_price_history\b/.test(c.sql),
    )!;
    // params order: variant_id, old, new, source_purchase_id,
    // source_purchase_no, reason, changed_by, metadata
    expect(insertHistory.params[3]).toBe(PURCHASE);
    expect(insertHistory.params[4]).toBe('PO-2026-000099');
    expect(insertHistory.params[5]).toBe('تطبيق من فاتورة شراء');
    expect(insertHistory.params[6]).toBe(USER);
  });

  it('7. multiple variants update + insert history per change', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: V1, selling_price: '100.00' }],
        [],
        [{ id: 'hist-1' }],
        [{ id: V2, selling_price: '200.00' }],
        [],
        [{ id: 'hist-2' }],
        [{ id: V3, selling_price: '50.00' }], // unchanged — skipped
      ],
    });
    const res = await service.applyVariantPrices(
      {
        items: [
          { variant_id: V1, new_selling_price: 145 },
          { variant_id: V2, new_selling_price: 250 },
          { variant_id: V3, new_selling_price: 50 }, // equal → skip
        ],
      },
      USER,
    );
    expect(res.updated).toBe(2);
    expect(res.skipped).toBe(1);
    expect(findAll(calls, /UPDATE product_variants\b/)).toHaveLength(2);
    expect(findAll(calls, /INSERT INTO variant_price_history\b/)).toHaveLength(2);
  });

  it('8. never touches accounting / cashbox / stock / posting SQL', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: V1, selling_price: '100.00' }],
        [],
        [{ id: 'hist-1' }],
      ],
    });
    await service.applyVariantPrices(
      { items: [{ variant_id: V1, new_selling_price: 145 }] },
      USER,
    );
    const allSql = calls.map((c) => c.sql).join('\n');
    expect(allSql).not.toMatch(/journal_entries|journal_lines/i);
    expect(allSql).not.toMatch(/cashbox_transactions|cashbox\b/i);
    expect(allSql).not.toMatch(/stock_movements|inventory_layers/i);
    expect(allSql).not.toMatch(/supplier_ledger|supplier_payments\b/i);
    expect(allSql).not.toMatch(/purchase_items|purchase_extra_costs/i);
    expect(allSql).not.toMatch(/cost_price\s*=/i);
    expect(allSql).not.toMatch(/postPurchase|reverseByReference/i);
  });

  it('9. no source_purchase_id → source columns stored as null', async () => {
    const { service, calls } = await makeService({
      responses: [
        [{ id: V1, selling_price: '100.00' }],
        [],
        [{ id: 'hist-1' }],
      ],
    });
    await service.applyVariantPrices(
      { items: [{ variant_id: V1, new_selling_price: 145 }] },
      USER,
    );
    const insertHistory = calls.find((c) =>
      /INSERT INTO variant_price_history\b/.test(c.sql),
    )!;
    expect(insertHistory.params[3]).toBeNull(); // source_purchase_id
    expect(insertHistory.params[4]).toBeNull(); // source_purchase_no
    expect(insertHistory.params[5]).toBeNull(); // reason
  });

  it('10. negative new_selling_price is rejected as BadRequest', async () => {
    const { service, ds } = await makeService();
    await expect(
      service.applyVariantPrices(
        { items: [{ variant_id: V1, new_selling_price: -1 }] },
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(ds.transaction).not.toHaveBeenCalled();
  });
});
