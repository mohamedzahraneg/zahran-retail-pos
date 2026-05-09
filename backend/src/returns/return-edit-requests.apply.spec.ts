/**
 * return-edit-requests.apply.spec.ts — PR-FIN-RETURNS-EXCHANGES-EDIT-
 * REQUESTS-APPLY (Phase 2A).
 *
 * Behavioral pins for `applyApprovedReturn`:
 *   1.  Cannot apply when request status is not 'approved'.
 *   2.  Cannot apply twice (applied_at IS NOT NULL → 409).
 *   3.  Cannot apply when parent return status is 'cancelled' /
 *       'rejected'.
 *   4.  Non-refunded approved return: items + totals updated, NO
 *       reverseByReference, NO postReturn, NO new SM rows.
 *   5.  Refunded return reverse-and-replay: posting.reverseByReference
 *       called once + posting.postReturn called once.
 *   6.  Product replacement on a back_to_stock line writes 1 SM
 *       reversal row and 1 SM application row.
 *   7.  Price change on a refunded return updates totals and the
 *       repost is computed from the new live row.
 *   8.  Added line with null/empty variant_id → 400.
 *   9.  Engine error from reverseByReference is NOT swallowed —
 *       throws BadRequestException with engine message.
 *  10.  Engine error from postReturn is NOT swallowed.
 *  11.  Exchange apply endpoint surface throws NotImplemented (501).
 *  12.  applyApprovedExchange (called by controller) returns the
 *       Phase-2A 501 message.
 *
 * No DB.  DataSource is a stubbed SQL-router fake; posting + audit
 * are jest mocks.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  NotImplementedException,
} from '@nestjs/common';

import { ReturnEditRequestsService } from './return-edit-requests.service';
import { AuditService } from '../audit/audit.service';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';

type QueryCall = { sql: string; params: any[] };
type Route = {
  match: RegExp;
  rows?: any[];
  fn?: (params: any[]) => any[] | undefined;
};

function makeRouter(routes: Route[]) {
  const calls: QueryCall[] = [];
  const ds: any = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const route = routes.find((r) => r.match.test(sql));
      const out = route ? (route.fn ? route.fn(params) : route.rows) : undefined;
      return out ?? [];
    },
    transaction: async (cb: (em: any) => Promise<any>) => cb(ds),
  };
  return { ds, calls };
}

async function buildSvc(
  ds: any,
  posting: Partial<AccountingPostingService>,
  audit: any = { writeActivity: jest.fn() },
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ReturnEditRequestsService,
      { provide: DataSource, useValue: ds },
      { provide: AuditService, useValue: audit },
      { provide: AccountingPostingService, useValue: posting },
    ],
  }).compile();
  return moduleRef.get(ReturnEditRequestsService);
}

const RET_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const REQ_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const VAR_OLD = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const VAR_NEW = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const ITEM_ID = '11111111-1111-1111-1111-111111111111';
const WAREHOUSE_ID = '22222222-2222-2222-2222-222222222222';

function pendingPayload() {
  return {
    kind: 'line_changes',
    lines: {
      updated: [
        {
          item_id: ITEM_ID,
          before: {
            variant_id: VAR_OLD,
            sku: 'SKU-OLD',
            name: 'منتج قديم',
            quantity: 1,
            unit_price: 450,
          },
          after: {
            variant_id: VAR_OLD,
            sku: 'SKU-OLD',
            name: 'منتج قديم',
            quantity: 1,
            unit_price: 400,
          },
        },
      ],
      removed: [],
      added: [],
    },
    summary: { old_total: 450, new_total: 400, delta: -50 },
  };
}

function approvedRequestRow(overrides: Record<string, any> = {}) {
  return {
    id: REQ_ID,
    return_id: RET_ID,
    return_no: 'RET-2026-EDIT-1',
    requested_action: 'price_change',
    requested_payload: pendingPayload(),
    before_snapshot: {},
    reason_text: 'تخفيض السعر بعد المراجعة',
    status: 'approved',
    requested_by: USER_ID,
    requested_at: '2026-05-09T13:00:00Z',
    reviewed_by: USER_ID,
    reviewed_at: '2026-05-09T13:30:00Z',
    review_notes: null,
    applied_at: null,
    applied_by: null,
    apply_journal_entry_ids: null,
    apply_cashbox_transaction_ids: null,
    apply_stock_movement_ids: null,
    apply_summary: null,
    idempotency_key: null,
    created_at: '2026-05-09T13:00:00Z',
    updated_at: '2026-05-09T13:00:00Z',
    ...overrides,
  };
}

function returnRow(overrides: Record<string, any> = {}) {
  return {
    id: RET_ID,
    return_no: 'RET-2026-EDIT-1',
    status: 'approved',
    refund_method: 'cash',
    total_refund: '450.00',
    restocking_fee: '0.00',
    net_refund: '450.00',
    cashbox_id: 'cashbox-1',
    warehouse_id: WAREHOUSE_ID,
    ...overrides,
  };
}

function existingItemRow(overrides: Record<string, any> = {}) {
  return {
    id: ITEM_ID,
    return_id: RET_ID,
    variant_id: VAR_OLD,
    quantity: 1,
    unit_price: '450.00',
    refund_amount: '450.00',
    condition: 'resellable',
    back_to_stock: true,
    notes: null,
    original_invoice_item_id: 'oii-1',
    ...overrides,
  };
}

// Common SQL routes shared across tests.  Tests can override / extend
// by passing additional routes BEFORE the catch-all.
function baseRoutes(opts: {
  request?: any;
  ret?: any;
  items?: any[];
  variantExists?: boolean;
}): Route[] {
  return [
    // Edit-request lock + load
    {
      match: /SELECT\s+\*\s+FROM\s+return_edit_requests[\s\S]+FOR\s+UPDATE/i,
      rows: opts.request === null ? [] : [opts.request ?? approvedRequestRow()],
    },
    // Parent return lock + load
    {
      match: /SELECT[\s\S]+FROM\s+returns[\s\S]+FOR\s+UPDATE/i,
      rows: opts.ret === null ? [] : [opts.ret ?? returnRow()],
    },
    // Existing items (BEFORE state)
    {
      match: /SELECT\s+\*\s+FROM\s+return_items\s+WHERE\s+return_id\s*=/i,
      rows: opts.items ?? [existingItemRow()],
    },
    // Variant existence check (for added rows)
    {
      match: /SELECT\s+id\s+FROM\s+product_variants\s+WHERE\s+id\s*=/i,
      rows: opts.variantExists === false ? [] : [{ id: VAR_NEW }],
    },
    // Cost lookup for stock reversal
    {
      match: /SELECT\s+COALESCE\([\s\S]+ii\.unit_cost[\s\S]+AS\s+cost/i,
      rows: [{ cost: '100.00' }],
    },
    // Stock UPDATE — return rows aren't read; use any
    {
      match: /UPDATE\s+stock\s+SET/i,
      rows: [],
    },
    // Stock-movement INSERT — generate a fake id from the params
    {
      match: /INSERT\s+INTO\s+stock_movements[\s\S]+RETURNING\s+id/i,
      fn: () => [{ id: `sm-${Math.floor(Math.random() * 1e9)}` }],
    },
    // Cashbox-transaction lookups
    {
      match: /FROM\s+cashbox_transactions[\s\S]+reference_type::text\s*=\s*'other'/i,
      rows: [{ id: '101' }],
    },
    {
      match: /FROM\s+cashbox_transactions[\s\S]+reference_type::text\s*=\s*'return'/i,
      rows: [{ id: '202' }],
    },
    // ON CONFLICT stock upsert (post-replay)
    {
      match: /INSERT\s+INTO\s+stock\s+\([\s\S]+ON\s+CONFLICT/i,
      rows: [],
    },
    // Items AFTER mutation (for replay stock posting)
    {
      match: /SELECT[\s\S]+ri\.back_to_stock[\s\S]+FROM\s+return_items\s+ri[\s\S]+back_to_stock\s*=\s*TRUE/i,
      rows: [
        {
          id: ITEM_ID,
          variant_id: VAR_OLD,
          quantity: 1,
          back_to_stock: true,
          unit_cost: '100.00',
        },
      ],
    },
    // return_items mutations
    {
      match: /UPDATE\s+return_items\s+SET/i,
      rows: [],
    },
    {
      match: /DELETE\s+FROM\s+return_items/i,
      rows: [],
    },
    {
      match: /INSERT\s+INTO\s+return_items/i,
      rows: [],
    },
    // Total recompute
    {
      match: /SELECT\s+COALESCE\(SUM\(refund_amount\)/i,
      rows: [{ total_refund: '400.00' }],
    },
    // Returns total update
    {
      match: /UPDATE\s+returns\s+SET[\s\S]+total_refund/i,
      rows: [],
    },
    // Final stamp
    {
      match: /UPDATE\s+return_edit_requests[\s\S]+applied_at\s*=\s*NOW\(\)/i,
      fn: (params) => [
        approvedRequestRow({
          applied_at: '2026-05-09T13:45:00Z',
          applied_by: params[1],
          apply_journal_entry_ids: ['je-rev', 'je-new'],
          apply_cashbox_transaction_ids: ['101', '202'],
          apply_stock_movement_ids: ['sm-1', 'sm-2'],
          apply_summary: { lines_updated: 1 },
        }),
      ],
    },
  ];
}

describe('applyApprovedReturn — guards', () => {
  it('throws NotFound when the edit request row is missing', async () => {
    const { ds } = makeRouter(baseRoutes({ request: null }));
    const posting: any = {
      reverseByReference: jest.fn(),
      postReturn: jest.fn(),
    };
    const svc = await buildSvc(ds, posting);
    await expect(
      svc.applyApprovedReturn({
        entity: 'return',
        parent_id: RET_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(NotFoundException);
    expect(posting.reverseByReference).not.toHaveBeenCalled();
    expect(posting.postReturn).not.toHaveBeenCalled();
  });

  it('throws Conflict when the request status is not approved', async () => {
    const { ds } = makeRouter(
      baseRoutes({ request: approvedRequestRow({ status: 'pending' }) }),
    );
    const posting: any = {
      reverseByReference: jest.fn(),
      postReturn: jest.fn(),
    };
    const svc = await buildSvc(ds, posting);
    await expect(
      svc.applyApprovedReturn({
        entity: 'return',
        parent_id: RET_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(ConflictException);
    expect(posting.reverseByReference).not.toHaveBeenCalled();
  });

  it('throws Conflict when the request was already applied', async () => {
    const { ds } = makeRouter(
      baseRoutes({
        request: approvedRequestRow({
          applied_at: '2026-05-09T13:45:00Z',
          applied_by: USER_ID,
        }),
      }),
    );
    const posting: any = {
      reverseByReference: jest.fn(),
      postReturn: jest.fn(),
    };
    const svc = await buildSvc(ds, posting);
    await expect(
      svc.applyApprovedReturn({
        entity: 'return',
        parent_id: RET_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(ConflictException);
    expect(posting.reverseByReference).not.toHaveBeenCalled();
  });

  it('throws Conflict when the parent return is cancelled', async () => {
    const { ds } = makeRouter(
      baseRoutes({ ret: returnRow({ status: 'cancelled' }) }),
    );
    const posting: any = {
      reverseByReference: jest.fn(),
      postReturn: jest.fn(),
    };
    const svc = await buildSvc(ds, posting);
    await expect(
      svc.applyApprovedReturn({
        entity: 'return',
        parent_id: RET_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(ConflictException);
    expect(posting.reverseByReference).not.toHaveBeenCalled();
  });

  it('throws Conflict when the parent return is rejected', async () => {
    const { ds } = makeRouter(
      baseRoutes({ ret: returnRow({ status: 'rejected' }) }),
    );
    const posting: any = {
      reverseByReference: jest.fn(),
      postReturn: jest.fn(),
    };
    const svc = await buildSvc(ds, posting);
    await expect(
      svc.applyApprovedReturn({
        entity: 'return',
        parent_id: RET_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(ConflictException);
    expect(posting.reverseByReference).not.toHaveBeenCalled();
  });

  it('rejects added line without a real variant_id (empty/null)', async () => {
    const reqWithBadAdd = approvedRequestRow({
      requested_payload: {
        kind: 'line_changes',
        lines: {
          updated: [],
          removed: [],
          added: [
            {
              variant_id: null,
              sku: 'BAD',
              name: 'fake',
              quantity: 1,
              unit_price: 100,
            },
          ],
        },
        summary: { old_total: 0, new_total: 100, delta: 100 },
      },
    });
    const { ds } = makeRouter(baseRoutes({ request: reqWithBadAdd }));
    const posting: any = {
      reverseByReference: jest.fn(),
      postReturn: jest.fn(),
    };
    const svc = await buildSvc(ds, posting);
    await expect(
      svc.applyApprovedReturn({
        entity: 'return',
        parent_id: RET_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(BadRequestException);
    expect(posting.reverseByReference).not.toHaveBeenCalled();
  });

  it('rejects added line whose variant_id is not in the database', async () => {
    const reqWithGhostVariant = approvedRequestRow({
      requested_payload: {
        kind: 'line_changes',
        lines: {
          updated: [],
          removed: [],
          added: [
            {
              variant_id: 'ghost-variant',
              sku: 'GHOST',
              name: 'ghost',
              quantity: 1,
              unit_price: 100,
            },
          ],
        },
        summary: { old_total: 0, new_total: 100, delta: 100 },
      },
    });
    const { ds } = makeRouter(
      baseRoutes({
        request: reqWithGhostVariant,
        variantExists: false,
      }),
    );
    const posting: any = {
      reverseByReference: jest.fn(),
      postReturn: jest.fn(),
    };
    const svc = await buildSvc(ds, posting);
    await expect(
      svc.applyApprovedReturn({
        entity: 'return',
        parent_id: RET_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects payloads that are not kind="line_changes"', async () => {
    const { ds } = makeRouter(
      baseRoutes({
        request: approvedRequestRow({
          requested_payload: { kind: 'free_form', anything: 1 },
        }),
      }),
    );
    const posting: any = {
      reverseByReference: jest.fn(),
      postReturn: jest.fn(),
    };
    const svc = await buildSvc(ds, posting);
    await expect(
      svc.applyApprovedReturn({
        entity: 'return',
        parent_id: RET_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('applyApprovedReturn — non-refunded approved return', () => {
  it('updates items + totals, never calls posting, never inserts SM rows', async () => {
    const { ds, calls } = makeRouter(
      baseRoutes({
        ret: returnRow({ status: 'approved', refund_method: null }),
      }),
    );
    const posting: any = {
      reverseByReference: jest.fn(),
      postReturn: jest.fn(),
    };
    const svc = await buildSvc(ds, posting);
    const result = await svc.applyApprovedReturn({
      entity: 'return',
      parent_id: RET_ID,
      request_id: REQ_ID,
      user_id: USER_ID,
    });

    expect(posting.reverseByReference).not.toHaveBeenCalled();
    expect(posting.postReturn).not.toHaveBeenCalled();
    // No stock_movements INSERT happens for the non-refunded path.
    const smInserts = calls.filter((c) =>
      /INSERT\s+INTO\s+stock_movements/i.test(c.sql),
    );
    expect(smInserts).toHaveLength(0);
    // return_items UPDATE was issued for the line price change.
    const itemUpdates = calls.filter((c) =>
      /UPDATE\s+return_items\s+SET/i.test(c.sql),
    );
    expect(itemUpdates.length).toBeGreaterThanOrEqual(1);
    // returns header total update issued.
    const returnUpdates = calls.filter((c) =>
      /UPDATE\s+returns\s+SET[\s\S]+total_refund/i.test(c.sql),
    );
    expect(returnUpdates).toHaveLength(1);
    // applied_at stamp succeeded.
    expect(result.applied_at).not.toBeNull();
    expect(result.applied_by).toBe(USER_ID);
  });
});

describe('applyApprovedReturn — refunded reverse-and-replay', () => {
  it('calls reverseByReference, mutates items, then calls postReturn — exactly once each', async () => {
    const { ds } = makeRouter(
      baseRoutes({ ret: returnRow({ status: 'refunded' }) }),
    );
    const posting: any = {
      reverseByReference: jest
        .fn()
        .mockResolvedValue({ entry_id: 'je-rev', reversed_of: 'je-orig' }),
      postReturn: jest
        .fn()
        .mockResolvedValue({ ok: true, entry_id: 'je-new' }),
    };
    const svc = await buildSvc(ds, posting);
    const result = await svc.applyApprovedReturn({
      entity: 'return',
      parent_id: RET_ID,
      request_id: REQ_ID,
      user_id: USER_ID,
    });

    expect(posting.reverseByReference).toHaveBeenCalledTimes(1);
    expect(posting.reverseByReference).toHaveBeenCalledWith(
      'return',
      RET_ID,
      expect.stringContaining('تطبيق طلب تعديل'),
      USER_ID,
      expect.anything(),
    );
    expect(posting.postReturn).toHaveBeenCalledTimes(1);
    expect(posting.postReturn).toHaveBeenCalledWith(
      RET_ID,
      USER_ID,
      expect.anything(),
    );
    expect(result.applied_at).not.toBeNull();
  });

  it('writes a stock_movements reversal row + a stock_movements application row for back_to_stock items', async () => {
    const { ds, calls } = makeRouter(
      baseRoutes({ ret: returnRow({ status: 'refunded' }) }),
    );
    const posting: any = {
      reverseByReference: jest
        .fn()
        .mockResolvedValue({ entry_id: 'je-rev' }),
      postReturn: jest.fn().mockResolvedValue({ ok: true, entry_id: 'je-new' }),
    };
    const svc = await buildSvc(ds, posting);
    await svc.applyApprovedReturn({
      entity: 'return',
      parent_id: RET_ID,
      request_id: REQ_ID,
      user_id: USER_ID,
    });

    const smInserts = calls.filter((c) =>
      /INSERT\s+INTO\s+stock_movements/i.test(c.sql),
    );
    // One reversal (adjustment_out) + one re-apply (adjustment_in).
    expect(smInserts).toHaveLength(2);
    const reversal = smInserts.find((c) =>
      /edit_request_apply_stock_reversal/.test(c.params.join(' ')),
    );
    expect(reversal).toBeDefined();
    expect(reversal!.sql).toMatch(/adjustment_out/);
    const application = smInserts.find((c) =>
      /edit_request_apply_stock\b/.test(c.params.join(' ')),
    );
    expect(application).toBeDefined();
    expect(application!.sql).toMatch(/adjustment_in/);
    // Both keyed off return reference for the trace.
    for (const sm of smInserts) {
      expect(sm.sql).toMatch(/'return'::entity_type/);
    }
  });

  it('does not swallow engine error from reverseByReference', async () => {
    const { ds } = makeRouter(
      baseRoutes({ ret: returnRow({ status: 'refunded' }) }),
    );
    const posting: any = {
      reverseByReference: jest
        .fn()
        .mockResolvedValue({ error: 'GUARD_A_VIOLATION' }),
      postReturn: jest.fn(),
    };
    const svc = await buildSvc(ds, posting);
    await expect(
      svc.applyApprovedReturn({
        entity: 'return',
        parent_id: RET_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(BadRequestException);
    // postReturn must NOT have been called after reverse failed.
    expect(posting.postReturn).not.toHaveBeenCalled();
  });

  it('does not swallow engine error from postReturn', async () => {
    const { ds } = makeRouter(
      baseRoutes({ ret: returnRow({ status: 'refunded' }) }),
    );
    const posting: any = {
      reverseByReference: jest
        .fn()
        .mockResolvedValue({ entry_id: 'je-rev' }),
      postReturn: jest
        .fn()
        .mockResolvedValue({ ok: false, error: 'unbalanced entry' }),
    };
    const svc = await buildSvc(ds, posting);
    await expect(
      svc.applyApprovedReturn({
        entity: 'return',
        parent_id: RET_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('applyApprovedReturn — payload coverage', () => {
  it('product replacement updates the return_items variant_id (not just qty/price)', async () => {
    const reqWithReplacement = approvedRequestRow({
      requested_payload: {
        kind: 'line_changes',
        lines: {
          updated: [
            {
              item_id: ITEM_ID,
              before: {
                variant_id: VAR_OLD,
                sku: 'SKU-OLD',
                name: 'old',
                quantity: 1,
                unit_price: 450,
              },
              after: {
                variant_id: VAR_NEW,
                sku: 'SKU-NEW',
                name: 'new',
                quantity: 1,
                unit_price: 450,
              },
            },
          ],
          removed: [],
          added: [],
        },
        summary: { old_total: 450, new_total: 450, delta: 0 },
      },
    });
    const { ds, calls } = makeRouter(baseRoutes({ request: reqWithReplacement }));
    const posting: any = {
      reverseByReference: jest.fn(),
      postReturn: jest.fn(),
    };
    const svc = await buildSvc(ds, posting);
    await svc.applyApprovedReturn({
      entity: 'return',
      parent_id: RET_ID,
      request_id: REQ_ID,
      user_id: USER_ID,
    });

    // The UPDATE that includes variant_id swap must have run.
    const updateWithVariant = calls.find(
      (c) =>
        /UPDATE\s+return_items\s+SET/i.test(c.sql) &&
        /variant_id\s*=\s*\$2/.test(c.sql),
    );
    expect(updateWithVariant).toBeDefined();
    expect(updateWithVariant!.params).toContain(VAR_NEW);
  });

  it('removed line issues a DELETE on return_items', async () => {
    const reqWithRemoval = approvedRequestRow({
      requested_payload: {
        kind: 'line_changes',
        lines: {
          updated: [],
          removed: [
            {
              item_id: ITEM_ID,
              before: {
                variant_id: VAR_OLD,
                sku: 'SKU-OLD',
                name: 'old',
                quantity: 1,
                unit_price: 450,
              },
            },
          ],
          added: [],
        },
        summary: { old_total: 450, new_total: 0, delta: -450 },
      },
    });
    const { ds, calls } = makeRouter(baseRoutes({ request: reqWithRemoval }));
    const posting: any = {
      reverseByReference: jest.fn(),
      postReturn: jest.fn(),
    };
    const svc = await buildSvc(ds, posting);
    await svc.applyApprovedReturn({
      entity: 'return',
      parent_id: RET_ID,
      request_id: REQ_ID,
      user_id: USER_ID,
    });
    const deletes = calls.filter((c) =>
      /DELETE\s+FROM\s+return_items/i.test(c.sql),
    );
    expect(deletes).toHaveLength(1);
  });

  it('added line issues an INSERT INTO return_items with the resolved variant_id', async () => {
    const reqWithAdd = approvedRequestRow({
      requested_payload: {
        kind: 'line_changes',
        lines: {
          updated: [],
          removed: [],
          added: [
            {
              variant_id: VAR_NEW,
              sku: 'SKU-NEW',
              name: 'new',
              quantity: 2,
              unit_price: 100,
            },
          ],
        },
        summary: { old_total: 450, new_total: 650, delta: 200 },
      },
    });
    const { ds, calls } = makeRouter(baseRoutes({ request: reqWithAdd }));
    const posting: any = {
      reverseByReference: jest.fn(),
      postReturn: jest.fn(),
    };
    const svc = await buildSvc(ds, posting);
    await svc.applyApprovedReturn({
      entity: 'return',
      parent_id: RET_ID,
      request_id: REQ_ID,
      user_id: USER_ID,
    });
    const inserts = calls.filter((c) =>
      /INSERT\s+INTO\s+return_items/i.test(c.sql),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toContain(VAR_NEW);
  });
});

describe('applyApprovedExchange — Phase 2A scope guard', () => {
  it('throws NotImplemented (501) regardless of input', async () => {
    const { ds } = makeRouter([]);
    const posting: any = {
      reverseByReference: jest.fn(),
      postReturn: jest.fn(),
    };
    const svc = await buildSvc(ds, posting);
    await expect(
      svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: 'exch-1',
        request_id: 'req-1',
        user_id: USER_ID,
      }),
    ).rejects.toThrow(NotImplementedException);
    expect(posting.reverseByReference).not.toHaveBeenCalled();
    expect(posting.postReturn).not.toHaveBeenCalled();
  });

  it('applyApprovedReturn called with entity="exchange" also throws 501 (defense in depth)', async () => {
    const { ds } = makeRouter([]);
    const posting: any = {
      reverseByReference: jest.fn(),
      postReturn: jest.fn(),
    };
    const svc = await buildSvc(ds, posting);
    await expect(
      svc.applyApprovedReturn({
        entity: 'exchange',
        parent_id: 'exch-1',
        request_id: 'req-1',
        user_id: USER_ID,
      }),
    ).rejects.toThrow(NotImplementedException);
  });
});

// ─── Migration 126 — static + idempotency checks ──────────────────

describe('migration 126 — additive + idempotent', () => {
  const rawSql = require('node:fs')
    .readFileSync(
      require('node:path').resolve(
        __dirname,
        '../../../database/migrations/126_pr_returns_exchanges_edit_requests_apply.sql',
      ),
      'utf-8',
    ) as string;
  // Strip SQL line-comments (`-- ...`) before grepping so the
  // rollback documentation block at the bottom of the file (which
  // contains commented-out DROP statements for human-reference) does
  // not false-positive the destructive-DDL check.
  const sql = rawSql.replace(/--[^\n]*/g, '');

  it('only ADDs columns, constraints, and indexes (no destructive DDL)', () => {
    expect(sql).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX)\b/i);
    expect(sql).not.toMatch(/\bTRUNCATE\b/i);
    expect(sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(sql).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
  });

  it('every column add and index uses IF NOT EXISTS (idempotent replay)', () => {
    // No bare ADD COLUMN — every one is gated.
    const addColumns = sql.match(/ADD\s+COLUMN[^,;]*/gi) ?? [];
    expect(addColumns.length).toBeGreaterThan(0);
    for (const a of addColumns) {
      expect(a).toMatch(/IF\s+NOT\s+EXISTS/i);
    }
    const createIndexes = sql.match(/CREATE\s+INDEX[^;]*/gi) ?? [];
    for (const c of createIndexes) {
      expect(c).toMatch(/IF\s+NOT\s+EXISTS/i);
    }
  });

  it('CHECK constraints are guarded by pg_constraint lookup (idempotent)', () => {
    // Both new constraints are wrapped in DO-blocks that pre-check
    // pg_constraint, so a replay is a no-op.
    expect(sql).toMatch(/conname\s*=\s*'chk_rer_applied_status'/);
    expect(sql).toMatch(/conname\s*=\s*'chk_rer_applied_pair'/);
    expect(sql).toMatch(/conname\s*=\s*'chk_eer_applied_status'/);
    expect(sql).toMatch(/conname\s*=\s*'chk_eer_applied_pair'/);
  });

  it('does not touch existing financial / parent-doc tables', () => {
    expect(sql).not.toMatch(
      /\b(returns|return_items|exchanges|exchange_items|journal_entries|journal_lines|cashbox_transactions|stock_movements)\b\s*\(/i,
    );
    expect(sql).not.toMatch(/ALTER\s+TABLE\s+(returns|return_items|exchanges|exchange_items|journal_entries|journal_lines|cashbox_transactions|stock_movements)\b/i);
  });

  it('adds applied_at + applied_by to BOTH edit-request tables', () => {
    expect(sql).toMatch(
      /ALTER\s+TABLE\s+return_edit_requests[\s\S]+applied_at[\s\S]+applied_by/i,
    );
    expect(sql).toMatch(
      /ALTER\s+TABLE\s+exchange_edit_requests[\s\S]+applied_at[\s\S]+applied_by/i,
    );
  });
});
