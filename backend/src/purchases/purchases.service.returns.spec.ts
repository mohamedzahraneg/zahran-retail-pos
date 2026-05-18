/**
 * purchases.service.returns.spec.ts — PR-P2.4A
 *
 * Covers the upgraded `PurchasesService` purchase-return methods —
 * `listReturns`, `getReturn`, `createReturn`, `cancelReturn`, and
 * `getReturnableItems`. The official API namespace is
 * `/purchases/returns*`; this PR did not introduce a second module.
 *
 * Coverage:
 *   · cross-field validation across all 4 settlement modes
 *   · returnable-qty enforcement (received − sum(posted))
 *   · write footprint per settlement (stock + supplier_ledger OR
 *     fn_record_cashbox_txn + postPurchaseReturn)
 *   · cancel reversals (stock + supplier OR cashbox + reverseByReference)
 *   · static source guardrails: no direct journal_entries/journal_lines
 *     /cashbox_transactions writes inside PurchasesService's return code
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PurchasesService } from './purchases.service';
import { CreatePurchaseReturnDto } from './dto/purchase-return.dto';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';

const SUPPLIER_ID = '11111111-1111-1111-1111-111111111111';
const WAREHOUSE_ID = '22222222-2222-2222-2222-222222222222';
const VARIANT_ID = '33333333-3333-3333-3333-333333333333';
const PURCHASE_ID = '44444444-4444-4444-4444-444444444444';
const PURCHASE_ITEM_ID = '55555555-5555-5555-5555-555555555555';
const CASHBOX_ID_CASH = '66666666-6666-6666-6666-666666666666';
const CASHBOX_ID_BANK = '77777777-7777-7777-7777-777777777777';
const RETURN_ID = '88888888-8888-8888-8888-888888888888';
const USER_ID = '99999999-9999-9999-9999-999999999999';

function makeDs(opts: {
  parentPurchase?: { id: string; status: string };
  cashboxes?: Record<string, { id: string; kind: string }>;
  purchaseItems?: Record<
    string,
    { id: string; purchase_id: string; variant_id: string; quantity: number }
  >;
  alreadyReturned?: Record<string, number>;
  stockOnHand?: number;
  supplierBalance?: number;
  insertedReturn?: any;
  returnRow?: any;
  returnItems?: any[];
}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const s = sql.replace(/\s+/g, ' ').trim();
      if (/FROM purchases WHERE id = \$1/i.test(s)) {
        return opts.parentPurchase ? [opts.parentPurchase] : [];
      }
      if (/SELECT id, kind FROM cashboxes/i.test(s)) {
        const cb = opts.cashboxes?.[params[0]];
        return cb ? [cb] : [];
      }
      if (/INSERT INTO purchase_returns/i.test(s)) {
        return opts.insertedReturn ? [opts.insertedReturn] : [];
      }
      if (/FROM purchase_items pi\s+WHERE pi\.id = \$1/i.test(s)) {
        const pi = opts.purchaseItems?.[params[0]];
        return pi ? [pi] : [];
      }
      if (/SUM\(pri\.quantity\)/i.test(s) && /FOR UPDATE/i.test(s) === false) {
        const k = params[0];
        return [{ already: String(opts.alreadyReturned?.[k] ?? 0) }];
      }
      if (/FROM stock WHERE variant_id = \$1/i.test(s)) {
        return [{ quantity_on_hand: opts.stockOnHand ?? 100 }];
      }
      if (/SELECT current_balance FROM suppliers/i.test(s)) {
        return [{ current_balance: opts.supplierBalance ?? 0 }];
      }
      if (/SELECT \* FROM purchase_returns WHERE id = \$1/i.test(s)) {
        return opts.returnRow ? [opts.returnRow] : [];
      }
      if (/FROM purchase_return_items WHERE purchase_return_id = \$1/i.test(s)) {
        return opts.returnItems ?? [];
      }
      // getReturn header projection (called at end of createReturn)
      if (/FROM purchase_returns pr\s+LEFT JOIN suppliers/i.test(s)) {
        return opts.insertedReturn ? [opts.insertedReturn] : [];
      }
      if (/FROM purchase_return_items pri\s+JOIN product_variants/i.test(s)) {
        return [];
      }
      return [];
    }),
    transaction: jest.fn(async (cb: any) => cb(ds)),
  };
  return { ds, calls };
}

async function buildService(opts: { ds: any; posting?: any }) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      PurchasesService,
      { provide: DataSource, useValue: opts.ds },
      {
        provide: AccountingPostingService,
        useValue: opts.posting ?? {
          postPurchaseReturn: jest.fn(async () => ({ entry_id: 'je-1' })),
          reverseByReference: jest.fn(async () => ({ ok: true })),
        },
      },
    ],
  }).compile();
  return moduleRef.get(PurchasesService);
}

function baseDto(
  overrides: Partial<CreatePurchaseReturnDto> = {},
): CreatePurchaseReturnDto {
  return {
    supplier_id: SUPPLIER_ID,
    warehouse_id: WAREHOUSE_ID,
    purchase_id: PURCHASE_ID,
    return_date: '2026-05-16',
    items: [
      {
        variant_id: VARIANT_ID,
        purchase_item_id: PURCHASE_ITEM_ID,
        quantity: 2,
        unit_cost: 100,
      },
    ],
    reason: 'بضاعة معيبة',
    settlement_type: 'supplier_credit',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  Cross-field validation
// ─────────────────────────────────────────────────────────────────────
describe('PurchasesService.createReturn — validation', () => {
  it('rejects cash_refund without cashbox_id', async () => {
    const { ds } = makeDs({});
    const svc = await buildService({ ds });
    await expect(
      svc.createReturn(
        baseDto({ settlement_type: 'cash_refund', refund_amount: 200 }),
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects cash_refund without refund_amount', async () => {
    const { ds } = makeDs({});
    const svc = await buildService({ ds });
    await expect(
      svc.createReturn(
        baseDto({
          settlement_type: 'cash_refund',
          cashbox_id: CASHBOX_ID_CASH,
        }),
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects cash_refund when refund_amount !== total_amount', async () => {
    const { ds } = makeDs({
      parentPurchase: { id: PURCHASE_ID, status: 'received' },
      cashboxes: { [CASHBOX_ID_CASH]: { id: CASHBOX_ID_CASH, kind: 'cash' } },
    });
    const svc = await buildService({ ds });
    await expect(
      svc.createReturn(
        baseDto({
          settlement_type: 'cash_refund',
          cashbox_id: CASHBOX_ID_CASH,
          refund_amount: 150,
        }),
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects supplier_credit when cashbox_id is supplied', async () => {
    const { ds } = makeDs({});
    const svc = await buildService({ ds });
    await expect(
      svc.createReturn(
        baseDto({
          settlement_type: 'supplier_credit',
          cashbox_id: CASHBOX_ID_CASH,
        }),
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects no_settlement when refund_amount is supplied', async () => {
    const { ds } = makeDs({});
    const svc = await buildService({ ds });
    await expect(
      svc.createReturn(
        baseDto({ settlement_type: 'no_settlement', refund_amount: 50 }),
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects reason shorter than 3 chars', async () => {
    const { ds } = makeDs({});
    const svc = await buildService({ ds });
    await expect(
      svc.createReturn(baseDto({ reason: 'ab' }), USER_ID),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects zero-value returns (total < 0.01)', async () => {
    const { ds } = makeDs({});
    const svc = await buildService({ ds });
    await expect(
      svc.createReturn(
        baseDto({
          items: [
            {
              variant_id: VARIANT_ID,
              purchase_item_id: PURCHASE_ITEM_ID,
              quantity: 0,
              unit_cost: 0,
            },
          ],
        }),
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects cash cashbox + bank_refund (type mismatch)', async () => {
    const { ds } = makeDs({
      parentPurchase: { id: PURCHASE_ID, status: 'received' },
      cashboxes: { [CASHBOX_ID_CASH]: { id: CASHBOX_ID_CASH, kind: 'cash' } },
    });
    const svc = await buildService({ ds });
    await expect(
      svc.createReturn(
        baseDto({
          settlement_type: 'bank_refund',
          cashbox_id: CASHBOX_ID_CASH,
          refund_amount: 200,
        }),
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects bank cashbox + cash_refund (type mismatch)', async () => {
    const { ds } = makeDs({
      parentPurchase: { id: PURCHASE_ID, status: 'received' },
      cashboxes: { [CASHBOX_ID_BANK]: { id: CASHBOX_ID_BANK, kind: 'bank' } },
    });
    const svc = await buildService({ ds });
    await expect(
      svc.createReturn(
        baseDto({
          settlement_type: 'cash_refund',
          cashbox_id: CASHBOX_ID_BANK,
          refund_amount: 200,
        }),
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects creating a return for a draft purchase', async () => {
    const { ds } = makeDs({
      parentPurchase: { id: PURCHASE_ID, status: 'draft' },
    });
    const svc = await buildService({ ds });
    await expect(svc.createReturn(baseDto(), USER_ID)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('rejects when returnable qty is exceeded', async () => {
    const { ds } = makeDs({
      parentPurchase: { id: PURCHASE_ID, status: 'received' },
      purchaseItems: {
        [PURCHASE_ITEM_ID]: {
          id: PURCHASE_ITEM_ID,
          purchase_id: PURCHASE_ID,
          variant_id: VARIANT_ID,
          quantity: 5,
        },
      },
      alreadyReturned: { [PURCHASE_ITEM_ID]: 4 },
      insertedReturn: { id: RETURN_ID, return_no: 'PR-1' },
    });
    const svc = await buildService({ ds });
    await expect(
      svc.createReturn(
        baseDto({
          items: [
            {
              variant_id: VARIANT_ID,
              purchase_item_id: PURCHASE_ITEM_ID,
              quantity: 2,
              unit_cost: 100,
            },
          ],
        }),
        USER_ID,
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Create — per-settlement write footprint
// ─────────────────────────────────────────────────────────────────────
describe('PurchasesService.createReturn — write footprint per settlement', () => {
  function commonOpts() {
    return {
      parentPurchase: { id: PURCHASE_ID, status: 'received' },
      purchaseItems: {
        [PURCHASE_ITEM_ID]: {
          id: PURCHASE_ITEM_ID,
          purchase_id: PURCHASE_ID,
          variant_id: VARIANT_ID,
          quantity: 10,
        },
      },
      alreadyReturned: {},
      stockOnHand: 50,
      supplierBalance: -200,
      insertedReturn: {
        id: RETURN_ID,
        return_no: 'PR-2026-1',
        purchase_id: PURCHASE_ID,
        supplier_id: SUPPLIER_ID,
        warehouse_id: WAREHOUSE_ID,
        total_amount: '200',
        status: 'posted',
        settlement_type: 'supplier_credit',
        refund_amount: null,
        cashbox_id: null,
      },
    };
  }

  it('supplier_credit: writes pr + pri + stock + sm + supplier balance + supplier_ledger; calls postPurchaseReturn', async () => {
    const postPurchaseReturn = jest.fn(async () => ({ entry_id: 'je-1' }));
    const { ds, calls } = makeDs(commonOpts());
    const svc = await buildService({
      ds,
      posting: { postPurchaseReturn, reverseByReference: jest.fn() },
    });
    await svc.createReturn(
      baseDto({ settlement_type: 'supplier_credit' }),
      USER_ID,
    );
    const sqls = calls.map((c) => c.sql);

    expect(sqls.some((s) => /INSERT INTO purchase_returns/i.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO purchase_return_items/i.test(s))).toBe(true);
    expect(sqls.some((s) => /UPDATE stock\b/i.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO stock_movements/i.test(s))).toBe(true);
    // PR-PURCHASES-P2.4A-FIX-ENUM: stock_movements row uses the
    // valid 'adjustment' enum value with direction='out'; the
    // purchase-return semantic lives on reference_type.
    const createSmCall = calls.find((c) =>
      /INSERT INTO stock_movements/i.test(c.sql),
    );
    expect(createSmCall?.sql).toMatch(/'adjustment','out'/);
    expect(createSmCall?.sql).toMatch(/'purchase_return'/);
    expect(createSmCall?.sql).not.toMatch(/'purchase_return','out'/);
    expect(sqls.some((s) => /UPDATE suppliers/i.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO supplier_ledger/i.test(s))).toBe(true);
    expect(sqls.some((s) => /fn_record_cashbox_txn/i.test(s))).toBe(false);
    expect(postPurchaseReturn).toHaveBeenCalledTimes(1);
    expect(postPurchaseReturn).toHaveBeenCalledWith(RETURN_ID, USER_ID, ds);
    expect(sqls.some((s) => /INSERT INTO journal_entries/i.test(s))).toBe(false);
    expect(sqls.some((s) => /INSERT INTO journal_lines/i.test(s))).toBe(false);
  });

  it('cash_refund: writes stock + sm + fn_record_cashbox_txn (in); calls postPurchaseReturn; no supplier writes', async () => {
    const postPurchaseReturn = jest.fn(async () => ({ entry_id: 'je-1' }));
    const opts = {
      ...commonOpts(),
      cashboxes: { [CASHBOX_ID_CASH]: { id: CASHBOX_ID_CASH, kind: 'cash' } },
      insertedReturn: {
        ...commonOpts().insertedReturn,
        settlement_type: 'cash_refund',
        refund_amount: '200',
        cashbox_id: CASHBOX_ID_CASH,
      },
    };
    const { ds, calls } = makeDs(opts);
    const svc = await buildService({
      ds,
      posting: { postPurchaseReturn, reverseByReference: jest.fn() },
    });
    await svc.createReturn(
      baseDto({
        settlement_type: 'cash_refund',
        cashbox_id: CASHBOX_ID_CASH,
        refund_amount: 200,
      }),
      USER_ID,
    );
    const sqls = calls.map((c) => c.sql);

    expect(sqls.some((s) => /UPDATE stock\b/i.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO stock_movements/i.test(s))).toBe(true);
    expect(sqls.some((s) => /fn_record_cashbox_txn/i.test(s))).toBe(true);
    const cashboxCall = calls.find((c) =>
      /fn_record_cashbox_txn/i.test(c.sql),
    );
    expect(cashboxCall?.sql).toMatch(/'in'::text/);
    expect(cashboxCall?.sql).toMatch(/'purchase_return'::text/);
    expect(cashboxCall?.params).toContain(CASHBOX_ID_CASH);
    expect(sqls.some((s) => /UPDATE suppliers/i.test(s))).toBe(false);
    expect(sqls.some((s) => /INSERT INTO supplier_ledger/i.test(s))).toBe(false);
    expect(postPurchaseReturn).toHaveBeenCalledTimes(1);
    expect(sqls.some((s) => /INSERT INTO journal_entries/i.test(s))).toBe(false);
    expect(sqls.some((s) => /INSERT INTO cashbox_transactions/i.test(s))).toBe(false);
  });

  it('bank_refund: same write set as cash_refund (different cashbox kind)', async () => {
    const postPurchaseReturn = jest.fn(async () => ({ entry_id: 'je-1' }));
    const opts = {
      ...commonOpts(),
      cashboxes: { [CASHBOX_ID_BANK]: { id: CASHBOX_ID_BANK, kind: 'bank' } },
      insertedReturn: {
        ...commonOpts().insertedReturn,
        settlement_type: 'bank_refund',
        refund_amount: '200',
        cashbox_id: CASHBOX_ID_BANK,
      },
    };
    const { ds, calls } = makeDs(opts);
    const svc = await buildService({
      ds,
      posting: { postPurchaseReturn, reverseByReference: jest.fn() },
    });
    await svc.createReturn(
      baseDto({
        settlement_type: 'bank_refund',
        cashbox_id: CASHBOX_ID_BANK,
        refund_amount: 200,
      }),
      USER_ID,
    );
    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => /fn_record_cashbox_txn/i.test(s))).toBe(true);
    expect(sqls.some((s) => /UPDATE suppliers/i.test(s))).toBe(false);
    expect(postPurchaseReturn).toHaveBeenCalledTimes(1);
  });

  it('no_settlement: only stock writes; no supplier, no cashbox, no GL', async () => {
    const postPurchaseReturn = jest.fn(async () => ({ entry_id: 'je-1' }));
    const opts = {
      ...commonOpts(),
      insertedReturn: {
        ...commonOpts().insertedReturn,
        settlement_type: 'no_settlement',
        refund_amount: null,
        cashbox_id: null,
      },
    };
    const { ds, calls } = makeDs(opts);
    const svc = await buildService({
      ds,
      posting: { postPurchaseReturn, reverseByReference: jest.fn() },
    });
    await svc.createReturn(
      baseDto({ settlement_type: 'no_settlement' }),
      USER_ID,
    );
    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => /UPDATE stock\b/i.test(s))).toBe(true);
    expect(sqls.some((s) => /INSERT INTO stock_movements/i.test(s))).toBe(true);
    expect(sqls.some((s) => /UPDATE suppliers/i.test(s))).toBe(false);
    expect(sqls.some((s) => /INSERT INTO supplier_ledger/i.test(s))).toBe(false);
    expect(sqls.some((s) => /fn_record_cashbox_txn/i.test(s))).toBe(false);
    expect(postPurchaseReturn).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Cancel — reversal footprint
// ─────────────────────────────────────────────────────────────────────
describe('PurchasesService.cancelReturn — reversal footprint', () => {
  function commonReturnRow(overrides: Record<string, any> = {}) {
    return {
      id: RETURN_ID,
      return_no: 'PR-2026-1',
      supplier_id: SUPPLIER_ID,
      warehouse_id: WAREHOUSE_ID,
      total_amount: '200',
      status: 'posted',
      settlement_type: 'supplier_credit',
      refund_amount: null,
      cashbox_id: null,
      ...overrides,
    };
  }

  const items = [{ variant_id: VARIANT_ID, quantity: '2', unit_cost: '100' }];

  it('supplier_credit cancel: reverses stock + supplier_ledger in + reverseByReference + status=cancelled', async () => {
    const reverseByReference = jest.fn(async () => ({ ok: true }));
    const { ds, calls } = makeDs({
      returnRow: commonReturnRow({ settlement_type: 'supplier_credit' }),
      returnItems: items,
      supplierBalance: 200,
    });
    const svc = await buildService({
      ds,
      posting: { postPurchaseReturn: jest.fn(), reverseByReference },
    });
    await svc.cancelReturn(RETURN_ID, USER_ID);

    const sqls = calls.map((c) => c.sql);
    expect(
      sqls.some((s) =>
        /UPDATE stock\s+SET quantity_on_hand = quantity_on_hand \+/i.test(s),
      ),
    ).toBe(true);
    const smCall = calls.find(
      (c) =>
        /INSERT INTO stock_movements/i.test(c.sql) && c.sql.includes("'in'"),
    );
    expect(smCall).toBeDefined();
    // PR-PURCHASES-P2.4A-FIX-ENUM: cancel reversal uses the valid
    // 'adjustment' enum value with direction='in'.
    expect(smCall?.sql).toMatch(/'adjustment','in'/);
    expect(smCall?.sql).toMatch(/'purchase_return'/);
    expect(smCall?.sql).not.toMatch(/'purchase_return','in'/);
    expect(sqls.some((s) => /UPDATE suppliers/i.test(s))).toBe(true);
    const ledgerCall = calls.find(
      (c) =>
        /INSERT INTO supplier_ledger/i.test(c.sql) && c.sql.includes("'in'"),
    );
    expect(ledgerCall).toBeDefined();
    expect(sqls.some((s) => /fn_record_cashbox_txn/i.test(s))).toBe(false);
    expect(reverseByReference).toHaveBeenCalledTimes(1);
    expect(reverseByReference).toHaveBeenCalledWith(
      'purchase_return',
      RETURN_ID,
      expect.any(String),
      USER_ID,
      ds,
    );
    expect(
      sqls.some(
        (s) =>
          /UPDATE purchase_returns/i.test(s) && /status = 'cancelled'/i.test(s),
      ),
    ).toBe(true);
  });

  it('cash_refund cancel: reverses stock + cashbox out + reverseByReference; no supplier writes', async () => {
    const reverseByReference = jest.fn(async () => ({ ok: true }));
    const { ds, calls } = makeDs({
      returnRow: commonReturnRow({
        settlement_type: 'cash_refund',
        refund_amount: '200',
        cashbox_id: CASHBOX_ID_CASH,
      }),
      returnItems: items,
    });
    const svc = await buildService({
      ds,
      posting: { postPurchaseReturn: jest.fn(), reverseByReference },
    });
    await svc.cancelReturn(RETURN_ID, USER_ID);
    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => /UPDATE suppliers/i.test(s))).toBe(false);
    expect(sqls.some((s) => /INSERT INTO supplier_ledger/i.test(s))).toBe(false);
    const cashboxCall = calls.find((c) =>
      /fn_record_cashbox_txn/i.test(c.sql),
    );
    expect(cashboxCall).toBeDefined();
    expect(cashboxCall?.sql).toMatch(/'out'::text/);
    expect(reverseByReference).toHaveBeenCalledTimes(1);
  });

  it('no_settlement cancel: only stock reversed; no cashbox, no supplier, no GL reversal', async () => {
    const reverseByReference = jest.fn(async () => ({ ok: true }));
    const { ds, calls } = makeDs({
      returnRow: commonReturnRow({ settlement_type: 'no_settlement' }),
      returnItems: items,
    });
    const svc = await buildService({
      ds,
      posting: { postPurchaseReturn: jest.fn(), reverseByReference },
    });
    await svc.cancelReturn(RETURN_ID, USER_ID);
    const sqls = calls.map((c) => c.sql);
    expect(
      sqls.some((s) =>
        /UPDATE stock\s+SET quantity_on_hand = quantity_on_hand \+/i.test(s),
      ),
    ).toBe(true);
    expect(sqls.some((s) => /UPDATE suppliers/i.test(s))).toBe(false);
    expect(sqls.some((s) => /fn_record_cashbox_txn/i.test(s))).toBe(false);
    expect(reverseByReference).not.toHaveBeenCalled();
  });

  it('rejects cancel on an already-cancelled return', async () => {
    const { ds } = makeDs({
      returnRow: commonReturnRow({ status: 'cancelled' }),
      returnItems: items,
    });
    const svc = await buildService({ ds });
    await expect(svc.cancelReturn(RETURN_ID, USER_ID)).rejects.toThrow(
      BadRequestException,
    );
  });

  it('throws NotFound if the return id does not exist', async () => {
    const { ds } = makeDs({ returnRow: undefined });
    const svc = await buildService({ ds });
    await expect(svc.cancelReturn(RETURN_ID, USER_ID)).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Static source guardrails — write-footprint regex scans
// ─────────────────────────────────────────────────────────────────────
describe('PurchasesService — purchase-return source guardrails (PR-P2.4A block)', () => {
  const RAW = readFileSync(
    resolve(__dirname, 'purchases.service.ts'),
    'utf8',
  );
  // Extract just the upgraded purchase-return block to scope the
  // guardrails (the rest of PurchasesService handles invoice/payment
  // flows that legitimately do other writes).
  const startMarker =
    '//  Purchase Returns (إرجاع للمورد) — PR-P2.4A';
  const endMarker = '//  Purchases P1 — read-only helpers';
  const startIdx = RAW.indexOf(startMarker);
  const endIdx = RAW.indexOf(endMarker, startIdx);
  expect(startIdx).toBeGreaterThan(-1);
  expect(endIdx).toBeGreaterThan(startIdx);
  const RETURN_BLOCK_RAW = RAW.slice(startIdx, endIdx);
  const RETURN_BLOCK = RETURN_BLOCK_RAW.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

  it('purchase-return block does not directly INSERT into journal_entries or journal_lines', () => {
    expect(RETURN_BLOCK).not.toMatch(/INSERT\s+INTO\s+journal_entries/i);
    expect(RETURN_BLOCK).not.toMatch(/INSERT\s+INTO\s+journal_lines/i);
  });

  it('purchase-return block does not directly INSERT into cashbox_transactions or update cashbox_balances', () => {
    expect(RETURN_BLOCK).not.toMatch(/INSERT\s+INTO\s+cashbox_transactions/i);
    expect(RETURN_BLOCK).not.toMatch(/UPDATE\s+cashbox_balances/i);
  });

  it('purchase-return block uses fn_record_cashbox_txn for cashbox refund-in', () => {
    expect(RETURN_BLOCK).toMatch(/fn_record_cashbox_txn/);
  });

  it('purchase-return block does not DELETE FROM or TRUNCATE purchase_returns / purchase_return_items', () => {
    expect(RETURN_BLOCK).not.toMatch(/DELETE\s+FROM\s+purchase_returns/i);
    expect(RETURN_BLOCK).not.toMatch(/DELETE\s+FROM\s+purchase_return_items/i);
    expect(RETURN_BLOCK).not.toMatch(/TRUNCATE\s+/i);
  });

  it('purchase-return block does not touch POS / sales returns / pricing tables', () => {
    expect(RETURN_BLOCK).not.toMatch(/INSERT\s+INTO\s+pos_/i);
    expect(RETURN_BLOCK).not.toMatch(/INSERT\s+INTO\s+invoices/i);
    expect(RETURN_BLOCK).not.toMatch(/INSERT\s+INTO\s+returns\b/i);
    expect(RETURN_BLOCK).not.toMatch(/UPDATE\s+invoices/i);
    expect(RETURN_BLOCK).not.toMatch(/UPDATE\s+returns\b/i);
    expect(RETURN_BLOCK).not.toMatch(/INSERT\s+INTO\s+price_lists/i);
    expect(RETURN_BLOCK).not.toMatch(/INSERT\s+INTO\s+inventory_cost_adjustments/i);
  });

  it('purchase-return block does not reference backend/src/provisioning/', () => {
    expect(RETURN_BLOCK).not.toMatch(/provisioning/i);
  });

  it('purchase-return block routes all 4 settlement_type branches', () => {
    expect(RETURN_BLOCK).toMatch(/'supplier_credit'/);
    expect(RETURN_BLOCK).toMatch(/'cash_refund'/);
    expect(RETURN_BLOCK).toMatch(/'bank_refund'/);
    expect(RETURN_BLOCK).toMatch(/'no_settlement'/);
  });

  it('PR-PURCHASES-P2.4A-FIX-ENUM: no stock_movements INSERT in the purchase-return block uses movement_type=\'purchase_return\'', () => {
    // 'purchase_return' is NOT a member of the stock_movement_type
    // enum — using it crashes with "invalid input value for enum
    // stock_movement_type". The valid values used by the rest of the
    // codebase are 'adjustment' / 'adjustment_in' / 'adjustment_out'.
    // This regression scans the purchase-return block for any
    // INSERT … stock_movements … 'purchase_return' value-position
    // shape and fails if reintroduced.
    //
    // NOTE: `reference_type='purchase_return'` IS still emitted by
    // this code — it writes to a column typed as the `entity_type`
    // enum (stock_movements / supplier_ledger / journal_entries /
    // cashbox_transactions all share that type). Migration 141 adds
    // 'purchase_return' to that enum so these writes succeed. The
    // migration-141 spec pins the schema side.
    expect(RETURN_BLOCK).not.toMatch(/'purchase_return'\s*,\s*'out'/);
    expect(RETURN_BLOCK).not.toMatch(/'purchase_return'\s*,\s*'in'/);
  });

  it('PR-PURCHASES-P2.4A-FIX-ENUM: createReturn uses adjustment/out + reference_type purchase_return', () => {
    // Find the create-path stock_movements INSERT (carries `returnId`
    // not `id, userId` — easiest discriminator is the lack of `notes`
    // column on the create path).
    expect(RETURN_BLOCK).toMatch(
      /INSERT INTO stock_movements[\s\S]*?VALUES\s*\(\$1,\$2,'adjustment','out',\s*\$3,\s*\$4,\s*'purchase_return',\s*\$5,\s*\$6\)/,
    );
  });

  it('PR-PURCHASES-P2.4A-FIX-ENUM: cancelReturn uses adjustment/in + reference_type purchase_return', () => {
    expect(RETURN_BLOCK).toMatch(
      /INSERT INTO stock_movements[\s\S]*?VALUES\s*\(\$1,\$2,'adjustment','in',\s*\$3,\s*\$4,\s*'purchase_return',/,
    );
  });

  it('purchase-return block uses reference_type=purchase_return on stock_movements + supplier_ledger + cashbox + posting', () => {
    const occurrences = RETURN_BLOCK.match(/'purchase_return'/g) ?? [];
    expect(occurrences.length).toBeGreaterThanOrEqual(6);
  });

  it('PR-PURCHASES-P2.4A-FIX-CB-NAME: getReturn detail query uses cb.name_ar (not cb.name)', () => {
    // `cashboxes` has no `name` column — its display columns are
    // `name_ar` (NOT NULL VARCHAR(120)) and `name_en` (nullable).
    // The detail SELECT in getReturn() must alias name_ar AS
    // cashbox_name to match the convention used by the sibling
    // warehouses join (w.name_ar AS warehouse_name) and the FE
    // type (PurchaseReturnDetails.cashbox_name).
    expect(RETURN_BLOCK).not.toMatch(/\bcb\.name\b(?!_)/);
    expect(RETURN_BLOCK).toMatch(/cb\.name_ar\s+AS\s+cashbox_name/);
  });

  it('PR-PURCHASES-P2.4A-FIX-CB-NAME: getReturn still LEFT JOINs cashboxes cb ON cb.id = pr.cashbox_id', () => {
    expect(RETURN_BLOCK).toMatch(
      /LEFT\s+JOIN\s+cashboxes\s+cb\s+ON\s+cb\.id\s*=\s*pr\.cashbox_id/i,
    );
  });

  it('PR-PURCHASES-P2.4A-FIX-ENUM-2: depends on migration 141 (entity_type += purchase_return)', () => {
    // The purchase-return block writes reference_type='purchase_return'
    // to columns typed `entity_type`. Migration 141 makes that value
    // valid in the enum. This test fails loudly if the migration is
    // missing or renamed, so the dependency cannot silently regress.
    const migrationPath = resolve(
      __dirname,
      '..',
      '..',
      '..',
      'database',
      'migrations',
      '141_entity_type_purchase_return.sql',
    );
    const migrationSql = readFileSync(migrationPath, 'utf8');
    expect(migrationSql).toMatch(
      /ALTER\s+TYPE\s+entity_type\s+ADD\s+VALUE\s+IF\s+NOT\s+EXISTS\s+'purchase_return'/i,
    );
  });
});
