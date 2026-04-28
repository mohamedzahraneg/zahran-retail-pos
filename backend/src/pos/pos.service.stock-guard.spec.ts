/**
 * pos.service.stock-guard.spec.ts — PR-POS-STOCK-1
 *
 * Focused unit tests for the new stock pre-validation step inside
 * `PosService.createInvoice`. The pre-check runs BEFORE
 * `INSERT INTO stock_movements` so the cashier sees a friendly Arabic
 * `BadRequestException` instead of the raw `stock_quantity_on_hand_check`
 * constraint string when reality has fewer units than the cart asked
 * for (race condition, offline replay, direct-curl misuse).
 *
 * What we're locking in:
 *   1. Over-stock → `BadRequestException` with the exact Arabic
 *      message format the frontend's `posStockGuard.formatOverStockLine`
 *      reproduces, so cashiers see the SAME sentence regardless of
 *      whether the client gate or the backend gate fired first.
 *   2. The trigger's CHECK constraint is NEVER reached when the
 *      pre-check rejects — i.e. `INSERT INTO stock_movements` is not
 *      issued. We verify that by asserting on the captured query
 *      sequence.
 *   3. The pre-check aggregates qty across multiple cart lines that
 *      share the same `variant_id` (a defensive case the FE doesn't
 *      typically produce but the API contract allows).
 *   4. Missing stock row for the (variant, warehouse) pair is treated
 *      as zero available — a fresh variant that has never been
 *      received should also be blocked, not silently allowed.
 */
import { BadRequestException } from '@nestjs/common';
import { PosService } from './pos.service';

interface QueryCall {
  sql: string;
  params: any[];
}

/**
 * Stateful fake DataSource. `dsResults` covers the queries issued via
 * `ds.query` BEFORE the transaction (in source order: open-shift,
 * vat-config, variant lookup). `emResults` covers queries inside the
 * transaction body (primary shift, invoice insert, invoice_items
 * inserts, stock pre-check, stock_movements inserts, …). Each entry
 * is consumed left-to-right; if the queue runs out we return `[]`
 * (which models a SELECT with no rows).
 */
function makeFakeDataSource(opts: {
  dsResults: any[][];
  emResults: any[][];
}): { ds: any; dsCalls: QueryCall[]; emCalls: QueryCall[] } {
  const dsCalls: QueryCall[] = [];
  const emCalls: QueryCall[] = [];
  let dsIdx = 0;
  let emIdx = 0;
  const em = {
    query: async (sql: string, params: any[]) => {
      emCalls.push({ sql, params });
      const next = opts.emResults[emIdx++];
      return next ?? [];
    },
  };
  const ds: any = {
    query: async (sql: string, params: any[]) => {
      dsCalls.push({ sql, params });
      const next = opts.dsResults[dsIdx++];
      return next ?? [];
    },
    transaction: async (cb: (em: any) => Promise<any>) => cb(em),
  };
  return { ds, dsCalls, emCalls };
}

/** Helper: build a DTO whose payment exactly matches grand_total so
 *  the `paid_total < grand_total` check (line 121) doesn't fire. */
const dtoFor = (lines: Array<{ variant_id: string; qty: number; unit_price?: number }>) => {
  const enriched = lines.map((l) => ({
    variant_id: l.variant_id,
    qty: l.qty,
    unit_price: l.unit_price ?? 100,
    discount: 0,
  }));
  const grand = enriched.reduce((s, l) => s + l.unit_price * l.qty, 0);
  return {
    warehouse_id: 'wh-1',
    customer_id: null,
    salesperson_id: 'sp-1',
    lines: enriched,
    payments: [{ payment_method: 'cash', amount: grand }],
    notes: null,
  } as any;
};

/** Standard ds.query queue: [open-shift, vat-config-disabled, variant-lookup]. */
const standardDsResults = (variants: any[]): any[][] => [
  [{ id: 'shift-1' }],            // (1) open-shift check
  [{ value: { enabled: false } }], // (2) vat config (disabled → no tax)
  variants,                        // (3) variant lookup for variantMap
];

/** Standard em.query queue prefix: [primaryShift, invoiceInsert, …
 *  invoice_items inserts]. The pre-check SELECT comes RIGHT AFTER all
 *  invoice_items have been inserted; tests append the stock row(s) for
 *  it as the next entry. */
const emQueuePrefix = (linesCount: number): any[][] => [
  [{ id: 'shift-1', cashbox_id: 'cb-1' }],            // primary shift
  [{ id: 'inv-1', invoice_no: 'INV-T-001' }],         // INSERT INTO invoices RETURNING *
  ...Array(linesCount).fill([]),                       // invoice_items INSERTs
];

describe('PosService.createInvoice — PR-POS-STOCK-1 stock pre-check', () => {
  it('throws BadRequestException with Arabic message when requested qty exceeds available_stock', async () => {
    const { ds, emCalls } = makeFakeDataSource({
      dsResults: standardDsResults([
        {
          id: 'v-1',
          sku: 'SKU-1',
          cost_price: 50,
          color_name: null,
          size_label: null,
          product_name: 'كوتش',
        },
      ]),
      emResults: [
        ...emQueuePrefix(1),
        // Stock pre-check returns 1 unit available for v-1.
        [
          {
            variant_id: 'v-1',
            quantity_on_hand: 1,
            product_name: 'كوتش',
          },
        ],
      ],
    });
    const service = new PosService({ findOne: async () => null } as any, ds);

    let thrown: unknown = null;
    try {
      await service.createInvoice(
        dtoFor([{ variant_id: 'v-1', qty: 3 }]),
        'user-1',
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as Error).message).toBe(
      'الرصيد غير كافٍ للصنف كوتش. المتاح 1 والمطلوب 3',
    );

    // Verify the trigger's CHECK constraint is NEVER reached: no
    // `INSERT INTO stock_movements` query was issued.
    const movementInserts = emCalls.filter((c) =>
      /INSERT\s+INTO\s+stock_movements/i.test(c.sql),
    );
    expect(movementInserts).toHaveLength(0);
  });

  it('aggregates qty across multiple lines that share the same variant_id', async () => {
    const { ds, emCalls } = makeFakeDataSource({
      dsResults: standardDsResults([
        {
          id: 'v-2',
          sku: 'SKU-2',
          cost_price: 30,
          color_name: null,
          size_label: null,
          product_name: 'بوت',
        },
      ]),
      emResults: [
        ...emQueuePrefix(2),
        // 4 units available — but we'll request 2 + 3 = 5 across two lines.
        [
          {
            variant_id: 'v-2',
            quantity_on_hand: 4,
            product_name: 'بوت',
          },
        ],
      ],
    });
    const service = new PosService({ findOne: async () => null } as any, ds);

    let thrown: unknown = null;
    try {
      await service.createInvoice(
        dtoFor([
          { variant_id: 'v-2', qty: 2 },
          { variant_id: 'v-2', qty: 3 },
        ]),
        'user-1',
      );
    } catch (e) {
      thrown = e;
    }
    expect((thrown as Error).message).toBe(
      'الرصيد غير كافٍ للصنف بوت. المتاح 4 والمطلوب 5',
    );

    // No stock_movements writes — pre-check intercepted before the trigger.
    expect(
      emCalls.filter((c) => /INSERT\s+INTO\s+stock_movements/i.test(c.sql)),
    ).toHaveLength(0);
  });

  it('blocks when stock row is missing for the warehouse (treats missing as 0 available)', async () => {
    const { ds } = makeFakeDataSource({
      dsResults: standardDsResults([
        {
          id: 'v-3',
          sku: 'SKU-3',
          cost_price: 10,
          color_name: null,
          size_label: null,
          product_name: 'حقيبة',
        },
      ]),
      emResults: [
        ...emQueuePrefix(1),
        [], // stock pre-check returns ZERO rows → variant has no stock entry
      ],
    });
    const service = new PosService({ findOne: async () => null } as any, ds);

    let thrown: unknown = null;
    try {
      await service.createInvoice(
        dtoFor([{ variant_id: 'v-3', qty: 1 }]),
        'user-1',
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);
    expect((thrown as Error).message).toBe(
      'الرصيد غير كافٍ للصنف حقيبة. المتاح 0 والمطلوب 1',
    );
  });

  it('issues the pre-check SELECT against `stock` joined to `product_variants` and `products` (not against the trigger)', async () => {
    const { ds, emCalls } = makeFakeDataSource({
      dsResults: standardDsResults([
        {
          id: 'v-4',
          sku: 'SKU-4',
          cost_price: 20,
          color_name: null,
          size_label: null,
          product_name: 'منتج',
        },
      ]),
      emResults: [
        ...emQueuePrefix(1),
        [{ variant_id: 'v-4', quantity_on_hand: 0, product_name: 'منتج' }],
      ],
    });
    const service = new PosService({ findOne: async () => null } as any, ds);

    let thrown: unknown = null;
    try {
      await service.createInvoice(
        dtoFor([{ variant_id: 'v-4', qty: 1 }]),
        'user-1',
      );
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(BadRequestException);

    const stockSelects = emCalls.filter(
      (c) =>
        /FROM\s+stock\s+s/i.test(c.sql) &&
        /JOIN\s+product_variants\s+v/i.test(c.sql) &&
        /JOIN\s+products\s+p/i.test(c.sql),
    );
    expect(stockSelects).toHaveLength(1);
    // Confirms warehouse_id and variant_id[] params are passed in.
    expect(stockSelects[0].params[0]).toBe('wh-1');
    expect(stockSelects[0].params[1]).toEqual(['v-4']);
  });
});
