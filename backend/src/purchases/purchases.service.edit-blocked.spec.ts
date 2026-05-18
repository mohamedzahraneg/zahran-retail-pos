/**
 * purchases.service.edit-blocked.spec.ts — PR-PURCHASES-P2.3C-FIX
 *
 * Pins the new edit() behavior after the P2.3B safe-replacement flow
 * was removed:
 *
 *   · DRAFT path remains in-place (positive coverage owned by p2.3a).
 *   · RECEIVED (paid_amount=0) is now BLOCKED with the new Arabic
 *     message — NO SQL writes, NO call to fn_void_purchase,
 *     reverseByReference, create(), or receive().
 *   · PARTIAL / PAID / paid_amount > 0 stays BLOCKED.
 *   · CANCELLED stays BLOCKED.
 *   · STATIC SOURCE GUARDRAILS on the edit() block:
 *       - no `fn_void_purchase` call
 *       - no `reverseByReference` call
 *       - no `replaces_purchase_id` / `replaced_by_purchase_id` writes
 *       - no `بديلة` / replacement language in the new code path
 *       - no `sp.purchase_id` SQL fragment anywhere in the service
 *         (regression for the migration-033 bug)
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
  const ds: any = {
    query: jest.fn(async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      return queue.length ? queue.shift() : [];
    }),
    transaction: jest.fn(async (cb: any) =>
      cb({
        query: jest.fn(async (sql: string, params: any[] = []) => {
          calls.push({ sql, params });
          return queue.length ? queue.shift() : [];
        }),
      }),
    ),
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
  return {
    service: moduleRef.get(PurchasesService),
    calls,
    posting: postingMock as any,
  };
}

const OLD = '00000000-0000-0000-0000-0000000000aa';
const SUPPLIER = '11111111-1111-1111-1111-111111111111';
const WAREHOUSE = '22222222-2222-2222-2222-222222222222';
const USER = '33333333-3333-3333-3333-333333333333';
const V1 = '44444444-4444-4444-4444-444444444444';

function baseDto(overrides: any = {}) {
  return {
    supplier_id: SUPPLIER,
    warehouse_id: WAREHOUSE,
    items: [
      {
        variant_id: V1,
        quantity: 2,
        base_unit_cost: 100,
        unit_cost: 100,
        discount: 0,
        tax: 0,
        line_total: 200,
      },
    ],
    extra_costs: [],
    edit_reason: 'تعديل قيمة فاتورة',
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────
//  RECEIVED + UNPAID is now blocked
// ─────────────────────────────────────────────────────────────────────
describe('PurchasesService.edit — RECEIVED is blocked (PR-PURCHASES-P2.3C-FIX)', () => {
  it('throws the new Arabic blocked message and writes ZERO rows', async () => {
    const { service, calls, posting } = await makeService({
      responses: [
        [
          {
            id: OLD,
            status: 'received',
            paid_amount: 0,
            supplier_id: SUPPLIER,
            warehouse_id: WAREHOUSE,
          },
        ],
      ],
    });
    await expect(service.edit(OLD, baseDto(), USER, 'reason')).rejects.toThrow(
      BadRequestException,
    );
    // Only the initial SELECT * FROM purchases WHERE id = $1 was issued.
    expect(calls).toHaveLength(1);
    expect(calls[0].sql).toMatch(/SELECT \* FROM purchases WHERE id = \$1/);
    expect(posting.reverseByReference).not.toHaveBeenCalled();
    expect(posting.postPurchase).not.toHaveBeenCalled();
  });

  it('blocked message uses the new approved Arabic text', async () => {
    const { service } = await makeService({
      responses: [
        [
          {
            id: OLD,
            status: 'received',
            paid_amount: 0,
            supplier_id: SUPPLIER,
            warehouse_id: WAREHOUSE,
          },
        ],
      ],
    });
    try {
      await service.edit(OLD, baseDto(), USER, 'reason');
      throw new Error('should have thrown');
    } catch (e: any) {
      expect(e).toBeInstanceOf(BadRequestException);
      const msg = e?.response?.message ?? e?.message ?? '';
      expect(msg).toContain('تعديل الفاتورة بعد الاستلام غير متاح حاليًا');
      expect(msg).toContain('مرتجع مشتريات');
      expect(msg).not.toMatch(/بديل/);
    }
  });

  it('does not call fn_void_purchase, reverseByReference, create(), or receive()', async () => {
    const { service, calls, posting } = await makeService({
      responses: [
        [
          {
            id: OLD,
            status: 'received',
            paid_amount: 0,
            supplier_id: SUPPLIER,
            warehouse_id: WAREHOUSE,
          },
        ],
      ],
    });
    await expect(service.edit(OLD, baseDto(), USER, 'reason')).rejects.toThrow(
      BadRequestException,
    );
    const sqls = calls.map((c) => c.sql);
    expect(sqls.some((s) => /fn_void_purchase/i.test(s))).toBe(false);
    expect(sqls.some((s) => /INSERT INTO purchases/i.test(s))).toBe(false);
    expect(sqls.some((s) => /UPDATE purchases.*replaced_by_purchase_id/i.test(s))).toBe(false);
    expect(sqls.some((s) => /UPDATE purchases.*replaces_purchase_id/i.test(s))).toBe(false);
    expect(posting.reverseByReference).not.toHaveBeenCalled();
    expect(posting.postPurchase).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  PARTIAL / PAID / paid_amount > 0 still blocked
// ─────────────────────────────────────────────────────────────────────
describe('PurchasesService.edit — partial/paid stay blocked', () => {
  for (const fixture of [
    { status: 'partial', paid_amount: 50 },
    { status: 'paid', paid_amount: 200 },
    { status: 'received', paid_amount: 50 }, // defensive: status mismatch but paid_amount>0
  ]) {
    it(`throws for status=${fixture.status} paid_amount=${fixture.paid_amount}`, async () => {
      const { service, calls } = await makeService({
        responses: [[{ id: OLD, ...fixture }]],
      });
      await expect(
        service.edit(OLD, baseDto(), USER, 'reason'),
      ).rejects.toThrow(BadRequestException);
      expect(calls).toHaveLength(1);
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
//  CANCELLED still blocked
// ─────────────────────────────────────────────────────────────────────
describe('PurchasesService.edit — cancelled stays blocked', () => {
  it('rejects without re-reading or writing anything else', async () => {
    const { service, calls } = await makeService({
      responses: [[{ id: OLD, status: 'cancelled', paid_amount: 0 }]],
    });
    await expect(
      service.edit(OLD, baseDto(), USER, 'reason'),
    ).rejects.toThrow(BadRequestException);
    expect(calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Static source guardrails on PurchasesService
// ─────────────────────────────────────────────────────────────────────
describe('PurchasesService — static source guardrails (PR-P2.3C-FIX)', () => {
  const RAW = readFileSync(resolve(__dirname, 'purchases.service.ts'), 'utf8');
  // Strip block + line comments before scanning.
  const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');

  // Extract the edit() method body. The method starts at `async edit(`
  // and ends at the next method declaration. We bound on the
  // `listReturns(filters?:` signature (first method of the P2.4A
  // purchase-returns block) so we do NOT falsely catch the
  // `reverseByReference` call inside cancelReturn (a legitimate
  // explicit-cancel path).
  function editBlock(): string {
    const start = SRC.indexOf('async edit(');
    expect(start).toBeGreaterThan(-1);
    const end = SRC.indexOf('listReturns(filters', start);
    return end > start ? SRC.slice(start, end) : SRC.slice(start);
  }

  it('edit() does NOT call fn_void_purchase', () => {
    expect(editBlock()).not.toMatch(/fn_void_purchase/);
  });

  it('edit() does NOT call reverseByReference', () => {
    expect(editBlock()).not.toMatch(/reverseByReference/);
  });

  it('edit() does NOT write replaces_purchase_id or replaced_by_purchase_id', () => {
    expect(editBlock()).not.toMatch(/replaces_purchase_id\s*=/);
    expect(editBlock()).not.toMatch(/replaced_by_purchase_id\s*=/);
  });

  it('edit() does NOT call this.create or this.receive (no replacement flow)', () => {
    expect(editBlock()).not.toMatch(/this\.create\s*\(/);
    expect(editBlock()).not.toMatch(/this\.receive\s*\(/);
  });

  it('edit() does NOT carry the "بديلة" replacement copy', () => {
    expect(editBlock()).not.toMatch(/بديلة/);
    expect(editBlock()).not.toMatch(/فاتورة بديلة/);
    expect(editBlock()).not.toMatch(/إصدار فاتورة بديلة/);
  });

  it('no part of PurchasesService references the invalid sp.purchase_id (migration-033 regression)', () => {
    // Scans the whole service source, not just edit(). cancel() calls
    // fn_void_purchase via SELECT but does not embed `sp.purchase_id`.
    expect(SRC).not.toMatch(/\bsp\.purchase_id\b/);
  });

  it('cancel() still calls fn_void_purchase + reverseByReference (unchanged)', () => {
    // Sanity guard so a future regression doesn't accidentally strip
    // the cancel reversal path along with edit's.
    expect(SRC).toMatch(/SELECT fn_void_purchase\(\$1, \$2, \$3\)/);
    expect(SRC).toMatch(/reverseByReference/);
  });
});
