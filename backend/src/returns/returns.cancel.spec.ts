/**
 * returns.cancel.spec.ts — PR-FIN-RETURNS-UX-1C
 *
 * Pins the contract of the admin-only POST /returns/:id/cancel write
 * path. The endpoint runs in a single DB transaction and:
 *
 *   1. Locks the return row, status-guards (approved/refunded only).
 *   2. Validates the typed confirmation token CANCEL_RETURN_<return_no>.
 *   3. Rejects non-cash refunds with the spec's Arabic diagnostic
 *      because `returns` has no `payment_account_id` linkage yet.
 *   4. Calls posting.reverseByReference('return', id, …) — the engine
 *      primitive that swaps DR/CR on the original JE and reverses the
 *      paired cashbox_transactions.
 *   5. For each back_to_stock=true return_item: UPDATE stock then
 *      INSERT stock_movements ... RETURNING id, then populate the
 *      return_cancellation_stock_movements linkage.
 *   6. Stamps cancelled_* fields on the return row.
 *   7. Best-effort activity-log write via AuditService.
 *
 * These tests stub the DataSource, AccountingPostingService and
 * AuditService so we can verify the entire orchestration without a DB.
 *
 * Defense-in-depth source-grep at the bottom asserts the cancel()
 * method body contains zero DELETE statements, no UPDATE on
 * journal_lines, and no direct cashboxes.current_balance mutation.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ReturnsService } from './returns.service';
import { ReturnEntity } from './entities/return.entity';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';
import { AuditService } from '../audit/audit.service';

type QueryCall = { sql: string; params: any[] };
type Route = {
  match: RegExp;
  rows?: any[];
  fn?: (params: any[]) => any[];
};

/**
 * SQL-router fake: matches each query against the first regex that
 * tests TRUE. More robust than an index-based queue when the cancel
 * flow makes many heterogeneous calls in a single transaction.
 */
function makeRouter(routes: Route[]) {
  const calls: QueryCall[] = [];
  const ds: any = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const route = routes.find((r) => r.match.test(sql));
      if (!route) {
        throw new Error(
          `unmocked SQL: ${sql.replace(/\s+/g, ' ').slice(0, 140)}`,
        );
      }
      return route.fn ? route.fn(params) : (route.rows ?? []);
    },
    transaction: async (cb: (em: any) => Promise<any>) => cb(ds),
  };
  return { ds, calls };
}

const RETURN_ID = '11111111-1111-1111-1111-111111111111';
const USER_ID = '22222222-2222-2222-2222-222222222222';
const RETURN_NO = 'RET-2026-000001';
const VARIANT_A = '33333333-3333-3333-3333-333333333333';
const VARIANT_B = '44444444-4444-4444-4444-444444444444';
const WAREHOUSE_ID = '55555555-5555-5555-5555-555555555555';
const CASHBOX_ID = '66666666-6666-6666-6666-666666666666';
const ORIG_JE_ID = '77777777-7777-7777-7777-777777777777';
const REVERSAL_JE_ID = '88888888-8888-8888-8888-888888888888';

function baseRetRow(over: Partial<any> = {}) {
  return {
    id: RETURN_ID,
    return_no: RETURN_NO,
    status: 'refunded',
    refund_method: 'cash',
    net_refund: '120.00',
    cashbox_id: CASHBOX_ID,
    warehouse_id: WAREHOUSE_ID,
    ...over,
  };
}

const TWO_BACK_ITEMS = [
  {
    id: 'ri-1',
    variant_id: VARIANT_A,
    quantity: 2,
    back_to_stock: true,
    condition: 'resellable',
    unit_cost: '50.00',
  },
  {
    id: 'ri-2',
    variant_id: VARIANT_B,
    quantity: 1,
    back_to_stock: true,
    condition: 'resellable',
    unit_cost: '40.00',
  },
];

const MIXED_BACK_ITEMS = [
  {
    id: 'ri-1',
    variant_id: VARIANT_A,
    quantity: 2,
    back_to_stock: true,
    condition: 'resellable',
    unit_cost: '50.00',
  },
];

function defaultRoutes(opts: {
  retRow: any;
  items?: any[];
  reversalCtId?: number | null;
}): Route[] {
  let smIdSeq = 9001;
  return [
    // 1. SELECT FOR UPDATE — header row (or empty if not found).
    {
      match: /SELECT[\s\S]*?FROM returns[\s\S]*?WHERE id\s*=\s*\$1[\s\S]*?FOR UPDATE/,
      rows: opts.retRow ? [opts.retRow] : [],
    },
    // 2. Reversal CT lookup (cash refund only).
    {
      match:
        /SELECT id::text AS id\s+FROM cashbox_transactions[\s\S]+category LIKE 'reversal_/,
      rows:
        opts.reversalCtId == null
          ? []
          : [{ id: String(opts.reversalCtId) }],
    },
    // 3. return_items WHERE back_to_stock = TRUE.
    {
      match:
        /FROM return_items ri[\s\S]+ri\.back_to_stock\s*=\s*TRUE/,
      rows: opts.items ?? [],
    },
    // 4. Stock UPDATE.
    { match: /^\s*UPDATE stock\b/i, rows: [] },
    // 5. INSERT stock_movements ... RETURNING id (synthetic id sequence).
    {
      match: /INSERT INTO stock_movements[\s\S]+RETURNING id/i,
      fn: () => [{ id: smIdSeq++ }],
    },
    // 6. Linkage table insert.
    {
      match: /INSERT INTO return_cancellation_stock_movements/,
      rows: [],
    },
    // 7. UPDATE returns SET status='cancelled'.
    {
      match:
        /UPDATE returns[\s\S]+status\s*=\s*'cancelled'[\s\S]+cancellation_entry_id/,
      rows: [],
    },
    // 8. findOne header — uses a CTE starting with `WITH base AS`.
    {
      match: /WITH base AS\s*\([\s\S]+FROM base\b/,
      rows: [{ ...(opts.retRow ?? {}), status: 'cancelled' }],
    },
    // 9. findOne items list — uses ri.* with product/variant joins.
    {
      match: /SELECT\s+ri\.\*[\s\S]+FROM return_items ri/,
      rows: [],
    },
  ];
}

async function buildService(opts: {
  ds: any;
  posting?: Partial<AccountingPostingService>;
  audit?: Partial<AuditService>;
}) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ReturnsService,
      { provide: DataSource, useValue: opts.ds },
      { provide: getRepositoryToken(ReturnEntity), useValue: {} },
      {
        provide: AccountingPostingService,
        useValue: opts.posting ?? {
          reverseByReference: jest.fn(async () => ({
            entry_id: REVERSAL_JE_ID,
            reversed_of: ORIG_JE_ID,
          })),
        },
      },
      { provide: FinancialEngineService, useValue: {} },
      {
        provide: AuditService,
        useValue: opts.audit ?? { writeActivity: jest.fn(async () => {}) },
      },
    ],
  }).compile();
  return moduleRef.get(ReturnsService);
}

const goodConfirm = `CANCEL_RETURN_${RETURN_NO}`;

// ─────────────────────────────────────────────────────────────────────
//  Group A — input validation & status guards
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsService.cancel — input validation', () => {
  it('rejects empty/whitespace reason with BadRequestException', async () => {
    const { ds } = makeRouter(defaultRoutes({ retRow: baseRetRow() }));
    const svc = await buildService({ ds });
    await expect(
      svc.cancel(RETURN_ID, { reason: '   ', confirm: goodConfirm }, USER_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when return id does not exist', async () => {
    const { ds } = makeRouter(defaultRoutes({ retRow: undefined as any }));
    const svc = await buildService({ ds });
    await expect(
      svc.cancel(RETURN_ID, { reason: 'wrong invoice', confirm: goodConfirm }, USER_ID),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('rejects pending status with ConflictException', async () => {
    const { ds } = makeRouter(
      defaultRoutes({ retRow: baseRetRow({ status: 'pending' }) }),
    );
    const svc = await buildService({ ds });
    await expect(
      svc.cancel(RETURN_ID, { reason: 'r', confirm: goodConfirm }, USER_ID),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects rejected status with ConflictException', async () => {
    const { ds } = makeRouter(
      defaultRoutes({ retRow: baseRetRow({ status: 'rejected' }) }),
    );
    const svc = await buildService({ ds });
    await expect(
      svc.cancel(RETURN_ID, { reason: 'r', confirm: goodConfirm }, USER_ID),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects already-cancelled status with ConflictException — idempotent 409', async () => {
    const { ds } = makeRouter(
      defaultRoutes({ retRow: baseRetRow({ status: 'cancelled' }) }),
    );
    const svc = await buildService({ ds });
    await expect(
      svc.cancel(RETURN_ID, { reason: 'r', confirm: goodConfirm }, USER_ID),
    ).rejects.toMatchObject({
      response: expect.objectContaining({
        statusCode: 409,
        message: expect.stringContaining('ملغى بالفعل'),
      }),
    });
  });

  it('rejects wrong confirm token with BadRequestException', async () => {
    const { ds } = makeRouter(defaultRoutes({ retRow: baseRetRow() }));
    const svc = await buildService({ ds });
    await expect(
      svc.cancel(RETURN_ID, { reason: 'r', confirm: 'CANCEL_RETURN_WRONG' }, USER_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('accepts the exact confirm token CANCEL_RETURN_<return_no>', async () => {
    const { ds } = makeRouter(
      defaultRoutes({
        retRow: baseRetRow(),
        items: [],
        reversalCtId: 245,
      }),
    );
    const svc = await buildService({ ds });
    await expect(
      svc.cancel(RETURN_ID, { reason: 'r', confirm: goodConfirm }, USER_ID),
    ).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Group B — non-cash refund rejection (no payment_account_id linkage)
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsService.cancel — non-cash refund safety', () => {
  for (const m of ['card', 'instapay', 'bank_transfer'] as const) {
    it(`rejects ${m} refunded return with the exact spec diagnostic`, async () => {
      const { ds } = makeRouter(
        defaultRoutes({
          retRow: baseRetRow({ refund_method: m }),
        }),
      );
      const svc = await buildService({ ds });
      await expect(
        svc.cancel(RETURN_ID, { reason: 'r', confirm: goodConfirm }, USER_ID),
      ).rejects.toMatchObject({
        message: 'إلغاء مرتجع غير نقدي يحتاج ربط حساب دفع غير متاح حالياً',
      });
    });
  }

  it('approved-but-not-refunded return (refund_method NULL) IS allowed', async () => {
    const { ds } = makeRouter(
      defaultRoutes({
        retRow: baseRetRow({ status: 'approved', refund_method: null }),
        items: [],
      }),
    );
    const svc = await buildService({ ds });
    await expect(
      svc.cancel(RETURN_ID, { reason: 'r', confirm: goodConfirm }, USER_ID),
    ).resolves.toBeDefined();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Group C — full reversal flow (cash refunded + back_to_stock items)
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsService.cancel — full cash refund reversal flow', () => {
  it('calls posting.reverseByReference with refType=return, refId=<return_id>', async () => {
    const reverseSpy = jest.fn(async () => ({
      entry_id: REVERSAL_JE_ID,
      reversed_of: ORIG_JE_ID,
    }));
    const { ds } = makeRouter(
      defaultRoutes({
        retRow: baseRetRow(),
        items: TWO_BACK_ITEMS,
        reversalCtId: 245,
      }),
    );
    const svc = await buildService({
      ds,
      posting: { reverseByReference: reverseSpy } as any,
    });
    await svc.cancel(
      RETURN_ID,
      { reason: 'مرتجع غير صحيح', confirm: goodConfirm },
      USER_ID,
    );
    expect(reverseSpy).toHaveBeenCalledTimes(1);
    const args = reverseSpy.mock.calls[0] as any[];
    expect(args[0]).toBe('return');
    expect(args[1]).toBe(RETURN_ID);
    // reason text threads through
    expect(args[2]).toMatch(/مرتجع غير صحيح/);
    // 4th arg = userId
    expect(args[3]).toBe(USER_ID);
  });

  it('inserts exactly one stock_movements row per back_to_stock item, with same variant_id and warehouse_id', async () => {
    const { ds, calls } = makeRouter(
      defaultRoutes({
        retRow: baseRetRow(),
        items: TWO_BACK_ITEMS,
        reversalCtId: 245,
      }),
    );
    const svc = await buildService({ ds });
    await svc.cancel(
      RETURN_ID,
      { reason: 'r', confirm: goodConfirm },
      USER_ID,
    );

    const inserts = calls.filter((c) =>
      /INSERT INTO stock_movements[\s\S]+RETURNING id/i.test(c.sql),
    );
    expect(inserts).toHaveLength(2);

    // First item — variant_id A, warehouse_id, qty=2, cost=50, return_id, notes prefix, userId
    expect(inserts[0].params.slice(0, 7)).toEqual([
      VARIANT_A,
      WAREHOUSE_ID,
      2,
      50,
      RETURN_ID,
      `return_cancel_stock_reversal:${RETURN_NO}`,
      USER_ID,
    ]);
    // Second item — variant_id B, warehouse_id, qty=1, cost=40
    expect(inserts[1].params.slice(0, 7)).toEqual([
      VARIANT_B,
      WAREHOUSE_ID,
      1,
      40,
      RETURN_ID,
      `return_cancel_stock_reversal:${RETURN_NO}`,
      USER_ID,
    ]);

    // SQL shape checks — adjustment_out, out, return entity_type
    expect(inserts[0].sql).toMatch(/'adjustment_out'::stock_movement_type/);
    expect(inserts[0].sql).toMatch(/'out'::txn_direction/);
    expect(inserts[0].sql).toMatch(/'return'::entity_type/);
  });

  it('does NOT insert stock_movements for items missing from the back_to_stock filter (filter is in SQL)', async () => {
    // Pass the SQL only TWO items (filtered query result). The service
    // never sees damaged/non-back-to-stock items because the WHERE
    // clause excludes them.
    const { ds, calls } = makeRouter(
      defaultRoutes({
        retRow: baseRetRow(),
        items: MIXED_BACK_ITEMS, // only one back_to_stock=true item
        reversalCtId: 245,
      }),
    );
    const svc = await buildService({ ds });
    await svc.cancel(
      RETURN_ID,
      { reason: 'r', confirm: goodConfirm },
      USER_ID,
    );

    const inserts = calls.filter((c) =>
      /INSERT INTO stock_movements[\s\S]+RETURNING id/i.test(c.sql),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params[0]).toBe(VARIANT_A);

    // The service-side SELECT must include the back_to_stock=TRUE
    // predicate so non-back-to-stock items never reach the loop.
    const itemSelect = calls.find((c) =>
      /FROM return_items ri/.test(c.sql),
    );
    expect(itemSelect).toBeDefined();
    expect(itemSelect!.sql).toMatch(/ri\.back_to_stock\s*=\s*TRUE/);
  });

  it('populates return_cancellation_stock_movements linkage for each reversal', async () => {
    const { ds, calls } = makeRouter(
      defaultRoutes({
        retRow: baseRetRow(),
        items: TWO_BACK_ITEMS,
        reversalCtId: 245,
      }),
    );
    const svc = await buildService({ ds });
    await svc.cancel(
      RETURN_ID,
      { reason: 'r', confirm: goodConfirm },
      USER_ID,
    );

    const linkInserts = calls.filter((c) =>
      /INSERT INTO return_cancellation_stock_movements/.test(c.sql),
    );
    expect(linkInserts).toHaveLength(2);
    // First insert links return_id to sm id 9001 (synthetic seq start).
    expect(linkInserts[0].params).toEqual([RETURN_ID, '9001']);
    expect(linkInserts[1].params).toEqual([RETURN_ID, '9002']);
    // ON CONFLICT guard — re-run safety.
    expect(linkInserts[0].sql).toMatch(
      /ON CONFLICT \(return_id, stock_movement_id\) DO NOTHING/,
    );
  });

  it('stamps cancelled_*, cancellation_entry_id, cancellation_cashbox_transaction_id on the return row', async () => {
    const { ds, calls } = makeRouter(
      defaultRoutes({
        retRow: baseRetRow(),
        items: [],
        reversalCtId: 245,
      }),
    );
    const svc = await buildService({ ds });
    await svc.cancel(
      RETURN_ID,
      { reason: 'wrong customer', confirm: goodConfirm },
      USER_ID,
    );

    const upd = calls.find((c) =>
      /UPDATE returns[\s\S]+status\s*=\s*'cancelled'/.test(c.sql),
    );
    expect(upd).toBeDefined();
    expect(upd!.sql).toMatch(/cancelled_at\s*=\s*NOW\(\)/);
    expect(upd!.sql).toMatch(/cancelled_by\s*=\s*\$2/);
    expect(upd!.sql).toMatch(/cancel_reason\s*=\s*\$3/);
    expect(upd!.sql).toMatch(/cancellation_entry_id\s*=\s*\$4/);
    expect(upd!.sql).toMatch(
      /cancellation_cashbox_transaction_id\s*=\s*\$5/,
    );
    expect(upd!.params).toEqual([
      RETURN_ID,
      USER_ID,
      'wrong customer',
      REVERSAL_JE_ID,
      '245',
    ]);
  });

  it('writes activity log with action=void, entity=return, kind=cancel_return in extra', async () => {
    const audit = { writeActivity: jest.fn(async () => {}) };
    const { ds } = makeRouter(
      defaultRoutes({
        retRow: baseRetRow(),
        items: TWO_BACK_ITEMS,
        reversalCtId: 245,
      }),
    );
    const svc = await buildService({ ds, audit: audit as any });
    await svc.cancel(
      RETURN_ID,
      { reason: 'مكرر', confirm: goodConfirm },
      USER_ID,
    );
    expect(audit.writeActivity).toHaveBeenCalledTimes(1);
    const arg = (audit.writeActivity.mock.calls[0] as any[])[0] as any;
    expect(arg).toMatchObject({
      user_id: USER_ID,
      action: 'void',
      entity: 'return',
      entity_id: RETURN_ID,
    });
    expect(arg.summary).toContain(RETURN_NO);
    expect(arg.summary).toContain('مكرر');
    expect(arg.extra).toMatchObject({
      kind: 'cancel_return',
      return_no: RETURN_NO,
      reason: 'مكرر',
      cancellation_entry_id: REVERSAL_JE_ID,
      cancellation_cashbox_transaction_id: '245',
      stock_movements_reversed: ['9001', '9002'],
    });
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Group D — engine-failure handling
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsService.cancel — failure modes', () => {
  it('aborts when posting.reverseByReference returns {error: …}', async () => {
    const reverseSpy = jest.fn(async () => ({ error: 'engine down' }));
    const { ds } = makeRouter(
      defaultRoutes({
        retRow: baseRetRow(),
        items: TWO_BACK_ITEMS,
      }),
    );
    const svc = await buildService({
      ds,
      posting: { reverseByReference: reverseSpy } as any,
    });
    await expect(
      svc.cancel(RETURN_ID, { reason: 'r', confirm: goodConfirm }, USER_ID),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('proceeds when posting.reverseByReference returns null (no live JE)', async () => {
    const reverseSpy = jest.fn(async () => null);
    const { ds, calls } = makeRouter(
      defaultRoutes({
        retRow: baseRetRow({ status: 'approved', refund_method: null }),
        items: [],
      }),
    );
    const svc = await buildService({
      ds,
      posting: { reverseByReference: reverseSpy } as any,
    });
    await svc.cancel(
      RETURN_ID,
      { reason: 'r', confirm: goodConfirm },
      USER_ID,
    );
    const upd = calls.find((c) =>
      /UPDATE returns[\s\S]+status\s*=\s*'cancelled'/.test(c.sql),
    );
    // cancellation_entry_id stays null when there was no JE to reverse.
    expect(upd!.params[3]).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Defense-in-depth — source grep on cancel() body
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsService.cancel — source-level safety contract', () => {
  const SRC = readFileSync(
    resolve(__dirname, './returns.service.ts'),
    'utf8',
  );

  function cancelBody(): string {
    const start = SRC.indexOf('async cancel(');
    expect(start).toBeGreaterThan(-1);
    // The next public method declaration is the boundary. We use a
    // generous slice that covers the whole cancel() body.
    return SRC.substring(start, start + 8000);
  }

  it('contains zero DELETE statements', () => {
    expect(cancelBody()).not.toMatch(/^\s*DELETE\s/im);
  });

  it('does not UPDATE journal_entries.debit/credit or journal_lines', () => {
    const body = cancelBody();
    expect(body).not.toMatch(/UPDATE\s+journal_lines/i);
    expect(body).not.toMatch(/UPDATE\s+journal_entries/i);
  });

  it('does not directly mutate cashboxes.current_balance', () => {
    expect(cancelBody()).not.toMatch(
      /UPDATE\s+cashboxes[\s\S]+current_balance/i,
    );
  });

  it('does not call fn_record_cashbox_txn directly (engine path only)', () => {
    expect(cancelBody()).not.toMatch(/fn_record_cashbox_txn/);
  });

  it('issues exactly one UPDATE on returns SET status = cancelled', () => {
    const body = cancelBody();
    const matches = body.match(
      /UPDATE returns[\s\S]+status\s*=\s*'cancelled'/g,
    );
    expect(matches?.length ?? 0).toBe(1);
  });

  it('uses inline INSERT INTO stock_movements ... RETURNING id (Option S1)', () => {
    expect(cancelBody()).toMatch(
      /INSERT INTO stock_movements[\s\S]+RETURNING id/,
    );
  });

  it('uses canonical posting.reverseByReference primitive (Option A)', () => {
    expect(cancelBody()).toMatch(/this\.posting[\s\S]*?\.reverseByReference\(/);
  });

  it('non-cash diagnostic message is the exact spec text', () => {
    expect(cancelBody()).toContain(
      'إلغاء مرتجع غير نقدي يحتاج ربط حساب دفع غير متاح حالياً',
    );
  });
});
