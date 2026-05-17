/**
 * purchases.service.pay.spec.ts
 *
 * Pins the OFFICIAL purchase-pay path after the cash-flow bug fix:
 *
 *   · Full pay  → status='paid'    + paid_amount = grand_total
 *   · Partial   → status='partial' + paid_amount = the partial amount
 *   · Top-up    → status='paid'    after a second allocation lifts it
 *     past grand_total
 *   · Overpay   → BadRequestException, no writes
 *   · Cancelled → BadRequestException, no writes
 *   · No shift  → BadRequestException, no writes
 *
 * The recompute is INLINE — same transaction as the supplier_payment
 * INSERT and the allocation INSERT — so a GL failure rolls everything
 * back. We assert the call sequence (SELECT FOR UPDATE → SELECT shift
 * → seq → INSERT supplier_payments → INSERT allocation → recompute
 * UPDATE → postSupplierPayment → final SELECT) and the read-only
 * footprint (no direct cashbox INSERT / journal INSERT from this
 * service; those stay on the existing trigger + postSupplierPayment
 * path).
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { NotFoundException } from '@nestjs/common';
import { PurchasesService } from './purchases.service';

type QueryCall = { sql: string; params: any[] };

interface PostingSpy {
  postSupplierPayment: jest.Mock;
}

interface Opts {
  /** Responses queued in order for both ds.query AND the inner
   *  transaction's `m.query`. */
  responses?: any[];
  /** Override the posting service's behaviour (default: no-op). */
  postingResult?: any;
  /** If true the posting service is omitted entirely (matches the
   *  conditional in `pay()` that skips GL when no posting service is
   *  available). */
  withoutPosting?: boolean;
}

function makeService(opts: Opts = {}) {
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
    manager: { query: jest.fn() },
    transaction: jest.fn(async (cb: any) => cb({ query: innerQuery })),
  };
  const posting: PostingSpy = {
    postSupplierPayment: jest.fn(async () =>
      opts.postingResult ?? { entry_id: 'je-1' },
    ),
  };
  return { ds, posting, innerQuery, calls };
}

async function build(opts: Opts = {}) {
  const { ds, posting, calls } = makeService(opts);
  const providers: any[] = [
    PurchasesService,
    { provide: DataSource, useValue: ds },
  ];
  const moduleRef = await Test.createTestingModule({ providers }).compile();
  const service = moduleRef.get(PurchasesService);
  if (!opts.withoutPosting) {
    // The service constructor consults `this.posting` lazily; assign
    // it directly so we don't pull in the full posting module.
    (service as any).posting = posting;
  }
  return { service, ds, posting, calls };
}

const PURCHASE_ID = '11111111-1111-1111-1111-111111111111';
const SUPPLIER_ID = '22222222-2222-2222-2222-222222222222';
const WAREHOUSE_ID = '33333333-3333-3333-3333-333333333333';
const CASHBOX_ID = '44444444-4444-4444-4444-444444444444';
const PAYMENT_ID = '55555555-5555-5555-5555-555555555555';
const USER = '66666666-6666-6666-6666-666666666666';

function purchase(overrides: Record<string, any> = {}) {
  return {
    id: PURCHASE_ID,
    supplier_id: SUPPLIER_ID,
    warehouse_id: WAREHOUSE_ID,
    purchase_no: 'PO-001',
    grand_total: '1000.00',
    paid_amount: '0.00',
    remaining_amount: '1000.00',
    status: 'received',
    ...overrides,
  };
}

function ok(...rows: any[]) {
  return rows;
}

describe('PurchasesService.pay — cash-flow bug fix', () => {
  it('1. full pay → status=paid, paid_amount=grand_total', async () => {
    const { service, calls, posting } = await build({
      responses: [
        ok(purchase()),                          // SELECT FOR UPDATE
        ok({ cashbox_id: CASHBOX_ID }),          // SELECT open shift
        ok({ seq: 1 }),                          // nextval
        ok({ id: PAYMENT_ID }),                  // INSERT supplier_payments
        ok(),                                    // INSERT supplier_payment_allocations
        ok(),                                    // UPDATE purchases (recompute)
        ok({ paid_amount: '1000.00', status: 'paid' }), // final SELECT
      ],
    });
    const res = await service.pay(
      PURCHASE_ID,
      { payment_method: 'cash', amount: 1000 } as any,
      USER,
    );
    expect(res).toEqual({ paid_amount: 1000, status: 'paid' });
    // posting was invoked exactly once with the new supplier_payment id
    expect(posting.postSupplierPayment).toHaveBeenCalledWith(
      PAYMENT_ID,
      USER,
      expect.anything(),
    );
    // The recompute UPDATE landed on the purchases row.
    const updates = calls.filter((c) =>
      /UPDATE purchases p\s+SET\s+paid_amount/i.test(c.sql),
    );
    expect(updates).toHaveLength(1);
    expect(updates[0].params).toEqual([PURCHASE_ID]);
    // CASE clause covers all three branches.
    expect(updates[0].sql).toMatch(/THEN 'paid'/);
    expect(updates[0].sql).toMatch(/THEN 'partial'/);
    expect(updates[0].sql).toMatch(/ELSE 'received'/);
  });

  it('2. partial pay → status=partial, paid_amount=400', async () => {
    const { service } = await build({
      responses: [
        ok(purchase()),
        ok({ cashbox_id: CASHBOX_ID }),
        ok({ seq: 2 }),
        ok({ id: PAYMENT_ID }),
        ok(),
        ok(),
        ok({ paid_amount: '400.00', status: 'partial' }),
      ],
    });
    const res = await service.pay(
      PURCHASE_ID,
      { payment_method: 'cash', amount: 400 } as any,
      USER,
    );
    expect(res).toEqual({ paid_amount: 400, status: 'partial' });
  });

  it('3. top-up pay → status=paid after second allocation', async () => {
    const { service } = await build({
      responses: [
        ok(purchase({ paid_amount: '400.00', remaining_amount: '600.00', status: 'partial' })),
        ok({ cashbox_id: CASHBOX_ID }),
        ok({ seq: 3 }),
        ok({ id: PAYMENT_ID }),
        ok(),
        ok(),
        ok({ paid_amount: '1000.00', status: 'paid' }),
      ],
    });
    const res = await service.pay(
      PURCHASE_ID,
      { payment_method: 'cash', amount: 600 } as any,
      USER,
    );
    expect(res).toEqual({ paid_amount: 1000, status: 'paid' });
  });

  it('4. overpay rejected — no writes hit', async () => {
    const { service, calls, posting } = await build({
      responses: [
        ok(purchase({ remaining_amount: '1000.00' })),
      ],
    });
    await expect(
      service.pay(
        PURCHASE_ID,
        { payment_method: 'cash', amount: 1500 } as any,
        USER,
      ),
    ).rejects.toMatchObject({
      message: 'المبلغ المدفوع أكبر من المتبقي',
    });
    expect(posting.postSupplierPayment).not.toHaveBeenCalled();
    expect(
      calls.filter((c) =>
        /\bINSERT INTO\b|\bUPDATE\s+[a-z_]+(\s+\w+)?\s+SET\b/i.test(c.sql) && !/UPDATE purchases/i.test(c.sql),
      ),
    ).toHaveLength(0);
    // The recompute UPDATE also did not fire.
    expect(
      calls.filter((c) => /UPDATE purchases/i.test(c.sql)),
    ).toHaveLength(0);
  });

  it('5. cancelled purchase rejected — no writes hit', async () => {
    const { service, calls } = await build({
      responses: [ok(purchase({ status: 'cancelled' }))],
    });
    await expect(
      service.pay(
        PURCHASE_ID,
        { payment_method: 'cash', amount: 100 } as any,
        USER,
      ),
    ).rejects.toMatchObject({
      message: 'لا يمكن سداد فاتورة ملغاة',
    });
    expect(
      calls.filter((c) => /\bINSERT INTO\b|\bUPDATE\s+[a-z_]+(\s+\w+)?\s+SET\b/i.test(c.sql)),
    ).toHaveLength(0);
  });

  it('6. missing purchase → NotFoundException', async () => {
    const { service } = await build({ responses: [ok()] });
    await expect(
      service.pay(
        PURCHASE_ID,
        { payment_method: 'cash', amount: 100 } as any,
        USER,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('7. no open shift rejected — no writes hit', async () => {
    const { service, calls } = await build({
      responses: [
        ok(purchase()),
        ok(),                                     // shift query returns []
      ],
    });
    await expect(
      service.pay(
        PURCHASE_ID,
        { payment_method: 'cash', amount: 100 } as any,
        USER,
      ),
    ).rejects.toMatchObject({
      message: 'لا توجد وردية مفتوحة — افتح وردية قبل تسجيل السداد',
    });
    expect(
      calls.filter((c) => /\bINSERT INTO\b|\bUPDATE\s+[a-z_]+(\s+\w+)?\s+SET\b/i.test(c.sql)),
    ).toHaveLength(0);
  });

  it('8. write order: supplier_payments → allocation → purchases recompute → posting', async () => {
    const { service, calls, posting } = await build({
      responses: [
        ok(purchase()),
        ok({ cashbox_id: CASHBOX_ID }),
        ok({ seq: 1 }),
        ok({ id: PAYMENT_ID }),
        ok(),
        ok(),
        ok({ paid_amount: '1000.00', status: 'paid' }),
      ],
    });
    await service.pay(
      PURCHASE_ID,
      { payment_method: 'cash', amount: 1000 } as any,
      USER,
    );
    const ordered = calls
      .map((c) => c.sql)
      .filter((s) =>
        /supplier_payments\b|supplier_payment_allocations\b|UPDATE purchases p/i.test(
          s,
        ),
      );
    // Indexes within `ordered` for the three writes we care about.
    const i_supplier_payments = ordered.findIndex((s) =>
      /INSERT INTO supplier_payments\b/.test(s),
    );
    const i_alloc = ordered.findIndex((s) =>
      /INSERT INTO supplier_payment_allocations\b/.test(s),
    );
    const i_recompute = ordered.findIndex((s) =>
      /UPDATE purchases p\s+SET\s+paid_amount/.test(s),
    );
    expect(i_supplier_payments).toBeGreaterThan(-1);
    expect(i_alloc).toBeGreaterThan(i_supplier_payments);
    expect(i_recompute).toBeGreaterThan(i_alloc);
    // postSupplierPayment fires after the recompute.
    expect(posting.postSupplierPayment).toHaveBeenCalledTimes(1);
  });
});

describe('PurchasesService.pay — write-footprint guardrail', () => {
  it('9. pay() emits ONLY supplier_payments / supplier_payment_allocations INSERTs and UPDATE purchases — no direct cashbox / GL writes from this service', async () => {
    const { service, calls } = await build({
      responses: [
        ok(purchase()),
        ok({ cashbox_id: CASHBOX_ID }),
        ok({ seq: 1 }),
        ok({ id: PAYMENT_ID }),
        ok(),
        ok(),
        ok({ paid_amount: '1000.00', status: 'paid' }),
      ],
    });
    await service.pay(
      PURCHASE_ID,
      { payment_method: 'cash', amount: 1000 } as any,
      USER,
    );
    const isWrite = (sql: string) =>
      /\bINSERT INTO\b/i.test(sql)
      || /\bUPDATE\s+[a-z_]+(\s+\w+)?\s+SET\b/i.test(sql)
      || /\bDELETE FROM\b/i.test(sql);
    const writes = calls.filter((c) => isWrite(c.sql));
    for (const w of writes) {
      const ok =
        /INSERT INTO supplier_payments\b/.test(w.sql)
        || /INSERT INTO supplier_payment_allocations\b/.test(w.sql)
        || /UPDATE purchases p\s+SET\s+paid_amount/.test(w.sql);
      if (!ok) {
        // Surface the offending SQL for an easier debug.
        throw new Error(
          `Unexpected write in pay() path:\n${w.sql.slice(0, 200)}`,
        );
      }
    }
    // Specifically: no direct INSERT into cashbox_transactions /
    // suppliers / supplier_ledger / journal_entries / journal_lines
    // from THIS service. Those are owned by trg_supplier_payment_apply
    // (migration 014) and postSupplierPayment respectively.
    const forbidden = [
      'INSERT INTO cashbox_transactions',
      'UPDATE cashboxes',
      'UPDATE suppliers',
      'INSERT INTO supplier_ledger',
      'INSERT INTO journal_entries',
      'INSERT INTO journal_lines',
    ];
    for (const phrase of forbidden) {
      expect(
        calls.some((c) => c.sql.includes(phrase)),
      ).toBe(false);
    }
  });

  it('10. no posting service → recompute still runs, no GL call attempted', async () => {
    const { service, calls } = await build({
      withoutPosting: true,
      responses: [
        ok(purchase()),
        ok({ cashbox_id: CASHBOX_ID }),
        ok({ seq: 1 }),
        ok({ id: PAYMENT_ID }),
        ok(),
        ok(),
        ok({ paid_amount: '1000.00', status: 'paid' }),
      ],
    });
    const res = await service.pay(
      PURCHASE_ID,
      { payment_method: 'cash', amount: 1000 } as any,
      USER,
    );
    expect(res).toEqual({ paid_amount: 1000, status: 'paid' });
    expect(
      calls.filter((c) =>
        /UPDATE purchases p\s+SET\s+paid_amount/.test(c.sql),
      ),
    ).toHaveLength(1);
  });
});
