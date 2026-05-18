/**
 * purchases.service.p2.3b.spec.ts — PR-PURCHASES-P2.3B
 *
 * Pins the safe-edit replacement flow for received + unpaid
 * purchases:
 *
 *   1. received + unpaid happy path: fn_void_purchase + reverseByReference
 *      + create() + receive() + audit-link UPDATEs, in one transaction.
 *   2. The two new purchases.replaces_purchase_id /
 *      replaced_by_purchase_id columns are populated correctly.
 *   3. paid / partial / paid_amount > 0 are BLOCKED with the approved
 *      Arabic message, BEFORE any SQL write.
 *   4. cancelled remains blocked.
 *   5. draft path is unchanged (verified in p2.3a.spec.ts; this file
 *      pins the parts P2.3B added).
 *   6. Already-replaced rows reject.
 *   7. Allocator failure happens BEFORE the transaction (no rows written).
 *   8. reverseByReference failure ROLLS BACK (no .catch swallow).
 *   9. STATIC GUARDRAIL: the new edit() block writes ONLY through
 *      fn_void_purchase + reverseByReference + create() + receive() +
 *      the two link UPDATEs. No direct cashbox / journal / supplier
 *      writes. No backend/src/provisioning touch.
 *
 *  All tests use the same DataSource stub pattern as p2.3a.spec.ts:
 *  ds.query and the txn's inner em.query share one capture queue.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PurchasesService } from './purchases.service';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';

type QueryCall = { sql: string; params: any[] };

interface MakeServiceOpts {
  responses?: Array<any[]>;
  posting?: Partial<AccountingPostingService>;
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
  const postingMock = {
    reverseByReference: jest.fn(async () => null),
    postPurchase: jest.fn(async () => null),
    ...(opts.posting ?? {}),
  } as unknown as AccountingPostingService;
  const moduleRef = await Test.createTestingModule({
    providers: [
      PurchasesService,
      { provide: DataSource, useValue: ds },
      { provide: AccountingPostingService, useValue: postingMock },
    ],
  }).compile();
  const service = moduleRef.get(PurchasesService);
  return { service, calls, posting: postingMock as any };
}

const OLD = '00000000-0000-0000-0000-0000000000aa';
const NEW = '00000000-0000-0000-0000-0000000000bb';
const SUPPLIER = '11111111-1111-1111-1111-111111111111';
const WAREHOUSE = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';
const V1 = '44444444-4444-4444-4444-444444444444';
const V2 = '55555555-5555-5555-5555-555555555555';

function findAll(calls: QueryCall[], pat: RegExp): QueryCall[] {
  return calls.filter((c) => pat.test(c.sql));
}
function findOne(calls: QueryCall[], pat: RegExp): QueryCall | undefined {
  return calls.find((c) => pat.test(c.sql));
}

function receivedUnpaid(overrides: Record<string, any> = {}) {
  return {
    id: OLD,
    status: 'received',
    paid_amount: '0.00',
    replaced_by_purchase_id: null,
    supplier_id: SUPPLIER,
    warehouse_id: WAREHOUSE,
    notes: null,
    ...overrides,
  };
}

const STANDARD_DTO = {
  supplier_id: SUPPLIER,
  warehouse_id: WAREHOUSE,
  items: [{ variant_id: V1, quantity: 1, unit_cost: 100 }],
  edit_reason: 'تصحيح كمية',
};

/**
 * Happy-path response queue. The order mirrors what the service
 * actually issues:
 *   1. ds.query: SELECT * FROM purchases WHERE id            ← existing row
 *   2. em.query: SELECT … FOR UPDATE                          ← locked row
 *   3. em.query: SELECT fn_void_purchase                      ← no row
 *   4. em.query: INSERT INTO purchases (create body) RETURNING ← new row
 *   5. em.query: INSERT INTO purchase_items                   ← per-item
 *   6. em.query: SELECT … FOR UPDATE (receive body)           ← new row
 *   7. em.query: SELECT * FROM purchase_items                 ← items list
 *   8. em.query: INSERT INTO stock_movements                  ← per-item
 *   9. em.query: UPDATE product_variants SET cost_price       ← per-item
 *  10. em.query: UPDATE suppliers SET current_balance         ← supplier bump
 *  11. em.query: SELECT current_balance FROM suppliers        ← read back
 *  12. em.query: INSERT INTO supplier_ledger                  ← ledger row
 *  13. em.query: UPDATE purchases SET status='received'       ← receive flip
 *  14. em.query: UPDATE purchases SET edit_reason, replaced_by ← link OLD
 *  15. em.query: UPDATE purchases SET replaces_purchase_id    ← link NEW
 */
function happyResponses() {
  return [
    [receivedUnpaid()],                          // 1
    [{ id: OLD, status: 'received', paid_amount: '0.00', replaced_by_purchase_id: null }], // 2
    [],                                          // 3 fn_void_purchase
    [{ id: NEW, purchase_no: 'PO-2026-000999' }],// 4 create INSERT RETURNING
    [],                                          // 5 INSERT purchase_items
    [{ id: NEW, status: 'draft', warehouse_id: WAREHOUSE, grand_total: '100.00', supplier_id: SUPPLIER, purchase_no: 'PO-2026-000999' }], // 6 SELECT FOR UPDATE inside receive
    [{ variant_id: V1, quantity: 1, unit_cost: 100, warehouse_id: WAREHOUSE }], // 7 SELECT items
    [],                                          // 8 INSERT stock_movement
    [],                                          // 9 UPDATE product_variants
    [],                                          // 10 UPDATE suppliers
    [{ current_balance: '100.00' }],             // 11 SELECT current_balance
    [],                                          // 12 INSERT supplier_ledger
    [],                                          // 13 UPDATE purchases status='received'
    [],                                          // 14 UPDATE OLD link
    [],                                          // 15 UPDATE NEW link
  ];
}

describe('PurchasesService.edit — P2.3B safe replacement (received + unpaid)', () => {
  it('1. happy path: calls fn_void_purchase + reverseByReference + create + receive', async () => {
    const { service, calls, posting } = await makeService({
      responses: happyResponses(),
    });

    const res = await service.edit(
      OLD,
      STANDARD_DTO as any,
      USER,
      'controller-default-ignored',
    );

    expect(findAll(calls, /SELECT fn_void_purchase/)).toHaveLength(1);
    expect(posting.reverseByReference).toHaveBeenCalledWith(
      'purchase',
      OLD,
      'تصحيح كمية',
      USER,
      expect.anything(),
    );
    // create() INSERT and receive()'s status flip both ran inside the txn.
    expect(findAll(calls, /INSERT INTO purchases\b/)).toHaveLength(1);
    expect(
      findAll(calls, /UPDATE purchases\s+SET status\s*=\s*'received'/),
    ).toHaveLength(1);
    expect((res as any).replacement.new_purchase_id).toBe(NEW);
    expect((res as any).replacement.replaces_purchase_id).toBe(OLD);
    expect((res as any).replacement.edit_reason).toBe('تصحيح كمية');
  });

  it('2. populates replaces_purchase_id / replaced_by_purchase_id on both rows', async () => {
    const { service, calls } = await makeService({
      responses: happyResponses(),
    });

    await service.edit(OLD, STANDARD_DTO as any, USER, '');

    const linkOld = findOne(
      calls,
      /UPDATE purchases\s+SET\s+edit_reason\s*=\s*\$2,\s*replaced_by_purchase_id\s*=\s*\$3/,
    );
    expect(linkOld).toBeDefined();
    expect(linkOld!.params).toEqual([OLD, 'تصحيح كمية', NEW]);

    const linkNew = findOne(
      calls,
      /UPDATE purchases\s+SET\s+replaces_purchase_id\s*=\s*\$2/,
    );
    expect(linkNew).toBeDefined();
    expect(linkNew!.params).toEqual([NEW, OLD]);
  });

  it('3. SELECT … FOR UPDATE locks the row before any write', async () => {
    const { service, calls } = await makeService({
      responses: happyResponses(),
    });

    await service.edit(OLD, STANDARD_DTO as any, USER, '');

    const lockIdx = calls.findIndex((c) => /FOR UPDATE/.test(c.sql));
    const voidIdx = calls.findIndex((c) => /SELECT fn_void_purchase/.test(c.sql));
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(voidIdx).toBeGreaterThan(lockIdx);
  });

  it('4. paid status is blocked with the P2.3B Arabic message, no SQL write', async () => {
    const { service, calls } = await makeService({
      responses: [[receivedUnpaid({ status: 'paid' })]],
    });

    await expect(
      service.edit(OLD, STANDARD_DTO as any, USER, ''),
    ).rejects.toMatchObject({
      message:
        'الفاتورة مسددة جزئيًا أو كليًا. التعديل بعد بدء السداد يحتاج خطوة استرداد أو دفعة إضافية، وسيتم تنفيذه في المرحلة القادمة.',
    });

    expect(findAll(calls, /fn_void_purchase|INSERT INTO purchases\b/))
      .toHaveLength(0);
  });

  it('5. partial status is blocked with the P2.3B Arabic message', async () => {
    const { service } = await makeService({
      responses: [[receivedUnpaid({ status: 'partial' })]],
    });

    await expect(
      service.edit(OLD, STANDARD_DTO as any, USER, ''),
    ).rejects.toMatchObject({
      message:
        'الفاتورة مسددة جزئيًا أو كليًا. التعديل بعد بدء السداد يحتاج خطوة استرداد أو دفعة إضافية، وسيتم تنفيذه في المرحلة القادمة.',
    });
  });

  it('6. status="received" but paid_amount > 0 is blocked (defensive race guard)', async () => {
    const { service, calls } = await makeService({
      responses: [[receivedUnpaid({ paid_amount: '0.01' })]],
    });

    await expect(
      service.edit(OLD, STANDARD_DTO as any, USER, ''),
    ).rejects.toMatchObject({
      message:
        'الفاتورة مسددة جزئيًا أو كليًا. التعديل بعد بدء السداد يحتاج خطوة استرداد أو دفعة إضافية، وسيتم تنفيذه في المرحلة القادمة.',
    });
    expect(findAll(calls, /fn_void_purchase/)).toHaveLength(0);
  });

  it('7. cancelled is blocked', async () => {
    const { service } = await makeService({
      responses: [[{ id: OLD, status: 'cancelled' }]],
    });
    await expect(
      service.edit(OLD, STANDARD_DTO as any, USER, ''),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('8. already-replaced row is blocked', async () => {
    const { service, calls } = await makeService({
      responses: [[receivedUnpaid({ replaced_by_purchase_id: NEW })]],
    });
    await expect(
      service.edit(OLD, STANDARD_DTO as any, USER, ''),
    ).rejects.toMatchObject({
      message:
        'هذه الفاتورة تم تبديلها بفاتورة مصححة بالفعل. عدّل الفاتورة الأحدث في السلسلة.',
    });
    expect(findAll(calls, /fn_void_purchase|INSERT INTO purchases\b/))
      .toHaveLength(0);
  });

  it('9. edit_reason < 3 chars is rejected with the Arabic guard', async () => {
    const { service, calls } = await makeService({
      responses: [[receivedUnpaid()]],
    });

    await expect(
      service.edit(
        OLD,
        { ...STANDARD_DTO, edit_reason: 'ab' } as any,
        USER,
        '',
      ),
    ).rejects.toMatchObject({
      message: 'سبب التعديل مطلوب (3 أحرف على الأقل).',
    });
    expect(findAll(calls, /fn_void_purchase/)).toHaveLength(0);
  });

  it('10. missing edit_reason is rejected', async () => {
    const { service } = await makeService({
      responses: [[receivedUnpaid()]],
    });

    await expect(
      service.edit(
        OLD,
        { supplier_id: SUPPLIER, warehouse_id: WAREHOUSE, items: [{ variant_id: V1, quantity: 1, unit_cost: 100 }] } as any,
        USER,
        '',
      ),
    ).rejects.toMatchObject({
      message: 'سبب التعديل مطلوب (3 أحرف على الأقل).',
    });
  });

  it('11. allocator manual-allocation mismatch fires BEFORE the transaction (no rows written)', async () => {
    const { service, calls } = await makeService({
      responses: [[receivedUnpaid()]],
    });

    await expect(
      service.edit(
        OLD,
        {
          supplier_id: SUPPLIER,
          warehouse_id: WAREHOUSE,
          edit_reason: 'mismatch test',
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
        '',
      ),
    ).rejects.toMatchObject({
      message: 'إجمالي التوزيع اليدوي للمصاريف يجب أن يساوي قيمة المصروف.',
    });

    // No fn_void_purchase, no inserts.
    expect(findAll(calls, /fn_void_purchase/)).toHaveLength(0);
    expect(findAll(calls, /INSERT INTO purchases\b/)).toHaveLength(0);
  });

  it('12. reverseByReference failure rolls back (no swallow, no link writes)', async () => {
    const { service, calls } = await makeService({
      responses: [
        [receivedUnpaid()],
        [{ id: OLD, status: 'received', paid_amount: '0.00', replaced_by_purchase_id: null }],
        [], // fn_void_purchase
      ],
      posting: {
        reverseByReference: jest.fn(async () => {
          throw new Error('boom');
        }),
      },
    });

    await expect(
      service.edit(OLD, STANDARD_DTO as any, USER, ''),
    ).rejects.toThrow(/boom/);

    // No replacement insert, no audit-link UPDATEs.
    expect(findAll(calls, /INSERT INTO purchases\b/)).toHaveLength(0);
    expect(findAll(calls, /UPDATE purchases\s+SET\s+edit_reason/)).toHaveLength(0);
    expect(findAll(calls, /UPDATE purchases\s+SET\s+replaces_purchase_id/)).toHaveLength(0);
  });

  it('13. reverseByReference soft-error response also rolls back', async () => {
    const { service, calls } = await makeService({
      responses: [
        [receivedUnpaid()],
        [{ id: OLD, status: 'received', paid_amount: '0.00', replaced_by_purchase_id: null }],
        [], // fn_void_purchase
      ],
      posting: {
        reverseByReference: jest.fn(async () => ({ error: 'engine_unavailable' })),
      },
    });

    await expect(
      service.edit(OLD, STANDARD_DTO as any, USER, ''),
    ).rejects.toMatchObject({
      message: 'فشل عكس قيد المشتريات: engine_unavailable',
    });
    expect(findAll(calls, /INSERT INTO purchases\b/)).toHaveLength(0);
  });

  it('14. landed-cost extras on a received+unpaid edit are ALLOWED (the P2.3A unblock)', async () => {
    // Allocator allows extras; the queue mirrors happy-path but with
    // an extra INSERT for purchase_extra_costs and a second
    // purchase_items INSERT.
    const { service, calls } = await makeService({
      responses: [
        [receivedUnpaid()],
        [{ id: OLD, status: 'received', paid_amount: '0.00', replaced_by_purchase_id: null }],
        [], // fn_void_purchase
        [{ id: NEW, purchase_no: 'PO-2026-001000' }], // INSERT purchases
        [], // INSERT purchase_items (V1)
        [], // INSERT purchase_extra_costs
        // receive() inside the same txn:
        [{ id: NEW, status: 'draft', warehouse_id: WAREHOUSE, supplier_id: SUPPLIER, grand_total: '150.00', purchase_no: 'PO-2026-001000' }],
        [{ variant_id: V1, quantity: 1, unit_cost: 150, warehouse_id: WAREHOUSE }],
        [],
        [],
        [],
        [{ current_balance: '150.00' }],
        [],
        [],
        [], // link OLD
        [], // link NEW
      ],
    });

    await service.edit(
      OLD,
      {
        ...STANDARD_DTO,
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
      '',
    );

    // Replacement was created and an extra-cost row was persisted.
    expect(findAll(calls, /INSERT INTO purchase_extra_costs\b/)).toHaveLength(1);
  });
});

describe('STATIC GUARDRAIL — P2.3B edit() write footprint', () => {
  const SRC = readFileSync(join(__dirname, 'purchases.service.ts'), 'utf8');
  // Anchor on the IMPLEMENTATION block — the unique sentence in the
  // P2.3B `received + unpaid` branch. Regex-based to survive
  // unicode-dash differences across editors.
  const startMatch = SRC.match(/PR-PURCHASES-P2\.3B[^\n]*paid \/ partial/);
  const endMatch = SRC.match(/Purchase Returns/);
  const startIdx = startMatch?.index ?? -1;
  const endIdx = endMatch?.index ?? -1;
  const slice = startIdx >= 0 && endIdx > startIdx
    ? SRC.slice(startIdx, endIdx)
    : '';

  it('the P2.3B branch exists in the source', () => {
    expect(slice.length).toBeGreaterThan(500);
  });

  it('no direct cashbox / cashbox_balances writes', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(stripped).not.toMatch(/INSERT INTO\s+cashbox_transactions/i);
    expect(stripped).not.toMatch(/UPDATE\s+cashbox_transactions/i);
    expect(stripped).not.toMatch(/UPDATE\s+cashbox_balances/i);
    expect(stripped).not.toMatch(/fn_record_cashbox_txn\b/i);
  });

  it('no direct journal_entries / journal_lines writes', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(stripped).not.toMatch(/INSERT INTO\s+journal_entries/i);
    expect(stripped).not.toMatch(/UPDATE\s+journal_entries/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+journal_lines/i);
    expect(stripped).not.toMatch(/UPDATE\s+journal_lines/i);
    expect(stripped).not.toMatch(/recordTransaction\b/);
    expect(stripped).not.toMatch(/financialEngine/i);
  });

  it('no direct supplier_ledger / supplier_payments writes', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(stripped).not.toMatch(/INSERT INTO\s+supplier_ledger/i);
    expect(stripped).not.toMatch(/UPDATE\s+supplier_ledger/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+supplier_payments/i);
    expect(stripped).not.toMatch(/UPDATE\s+supplier_payments/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+supplier_payment_allocations/i);
    expect(stripped).not.toMatch(/UPDATE\s+supplier_payment_allocations/i);
  });

  it('no direct stock_movements / stock writes', () => {
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(stripped).not.toMatch(/INSERT INTO\s+stock_movements/i);
    expect(stripped).not.toMatch(/UPDATE\s+stock\b/i);
    expect(stripped).not.toMatch(/stock\.avg_cost/i);
    expect(stripped).not.toMatch(/avg_cost\s*=/i);
  });

  it('no purchase_items / purchase_extra_costs direct writes from edit() block (those happen via create() inside the same txn)', () => {
    // The P2.3B branch only UPDATEs `purchases` (audit links) and
    // CALLs create()/receive() which carry their own well-tested
    // INSERTs. The branch source itself must not contain bare
    // INSERT INTO purchase_items / purchase_extra_costs statements.
    const stripped = slice
      .split('\n')
      .filter((l) => !/^\s*(\/\/|\*)/.test(l))
      .join('\n');
    expect(stripped).not.toMatch(/INSERT INTO\s+purchase_items\b/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+purchase_extra_costs\b/i);
  });

  it('uses fn_void_purchase + reverseByReference + create() + receive()', () => {
    expect(slice).toMatch(/SELECT fn_void_purchase/);
    expect(slice).toMatch(/reverseByReference\(\s*'purchase',/);
    expect(slice).toMatch(/this\.create\(.*em\)/);
    expect(slice).toMatch(/this\.receive\(.*em\)/);
  });

  it('writes only the two audit-link UPDATEs to purchases', () => {
    const updates =
      slice.match(/UPDATE\s+purchases\b[\s\S]*?WHERE/gi) || [];
    // 2 UPDATEs expected: OLD (edit_reason + replaced_by_purchase_id)
    // and NEW (replaces_purchase_id). Anything else would be a leak.
    expect(updates).toHaveLength(2);
  });
});
