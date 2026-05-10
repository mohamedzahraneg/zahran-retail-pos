/**
 * return-edit-requests.apply-exchange.spec.ts — PR-FIX-RETURNS-EXCHANGES-
 * EDIT-REQUEST-APPLY-PHASE-2B.
 *
 * Behavioral pins for `applyApprovedExchange` — the Phase 2B
 * implementation that replaces the Phase 2A 501 stub.  Mirrors the
 * shape of `return-edit-requests.apply.spec.ts` for the return path,
 * with three exchange-specific differences:
 *
 *   · No JE is posted at exchange creation, so `apply_journal_entry_ids`
 *     is always `[]` and `posting.reverseByReference` / `postReturn`
 *     are NEVER called.  Cash-leg reverse + replay both run through
 *     `engine.recordCashOnlyMovement` — same primitive used by
 *     `createExchange` itself.
 *   · Stock effects only target the RETURNED side (resellable) — the
 *     NEW side's stock came from the linked sales-invoice flow at
 *     creation time and is intentionally untouched on apply.
 *   · The Phase-2B SCOPE GUARD rejects any payload that touches a
 *     `kind='new'` line with the spec'd Arabic message:
 *     "تعديل البنود الجديدة في الاستبدال غير مدعوم في هذه المرحلة — Phase 2C".
 *
 * Hard guarantees pinned by source-grep at the bottom of this file:
 *   · No raw INSERT/UPDATE/DELETE on journal_entries / journal_lines /
 *     cashbox_transactions inside the new method body.
 *   · No UPDATE/DELETE on stock_movements; new SM rows only.
 *   · No `accounting_only`.
 *   · No engine-error swallowing (every `recordCashOnlyMovement`
 *     return value is checked).
 *
 * No DB.  DataSource is stubbed; engine + posting + audit are jest
 * mocks.
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ReturnEditRequestsService } from './return-edit-requests.service';
import { AuditService } from '../audit/audit.service';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

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

function makeEngineOk(): {
  engine: any;
  recordCashOnlyMovementMock: jest.Mock;
} {
  const recordCashOnlyMovementMock = jest.fn(async (..._args: any[]) => ({
    ok: true,
    cashbox_transaction_id: 'ct-mock',
  }));
  return {
    engine: { recordCashOnlyMovement: recordCashOnlyMovementMock },
    recordCashOnlyMovementMock,
  };
}

async function buildSvc(
  ds: any,
  engine?: Partial<FinancialEngineService>,
  posting: Partial<AccountingPostingService> = {
    reverseByReference: jest.fn(),
    postReturn: jest.fn(),
  },
  audit: any = { writeActivity: jest.fn() },
) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ReturnEditRequestsService,
      { provide: DataSource, useValue: ds },
      { provide: AuditService, useValue: audit },
      { provide: AccountingPostingService, useValue: posting },
      { provide: FinancialEngineService, useValue: engine ?? {} },
    ],
  }).compile();
  return moduleRef.get(ReturnEditRequestsService);
}

const EXC_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const REQ_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const USER_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ITEM_RETURNED = '11111111-1111-1111-1111-111111111111';
const ITEM_NEW = '22222222-2222-2222-2222-222222222222';
const VAR_OLD = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const VAR_NEW = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const WAREHOUSE_ID = '33333333-3333-3333-3333-333333333333';
const CASHBOX_ID = '44444444-4444-4444-4444-444444444444';
const ORIG_CT_ID = '999';

function approvedRequestRow(overrides: Record<string, any> = {}) {
  return {
    id: REQ_ID,
    exchange_id: EXC_ID,
    exchange_no: 'EXC-2026-000001',
    requested_action: 'price_change',
    requested_payload: {
      kind: 'line_changes',
      lines: {
        updated: [
          {
            item_id: ITEM_RETURNED,
            after: {
              variant_id: VAR_OLD,
              quantity: 1,
              unit_price: 400,
            },
          },
        ],
        removed: [],
        added: [],
      },
    },
    before_snapshot: {},
    reason_text: 'تخفيض سعر البند المرتجع',
    status: 'approved',
    requested_by: USER_ID,
    requested_at: '2026-05-09T13:00:00Z',
    reviewed_by: USER_ID,
    reviewed_at: '2026-05-09T13:30:00Z',
    review_notes: null,
    applied_at: null,
    applied_by: null,
    created_at: '2026-05-09T13:00:00Z',
    updated_at: '2026-05-09T13:30:00Z',
    ...overrides,
  };
}

function exchangeRow(overrides: Record<string, any> = {}) {
  return {
    id: EXC_ID,
    exchange_no: 'EXC-2026-000001',
    status: 'completed',
    returned_value: '450.00',
    new_items_value: '500.00',
    price_difference: '50.00',
    payment_method: 'cash',
    refund_method: null,
    cashbox_id: CASHBOX_ID,
    shift_id: null,
    warehouse_id: WAREHOUSE_ID,
    ...overrides,
  };
}

function returnedItemRow(overrides: Record<string, any> = {}) {
  return {
    id: ITEM_RETURNED,
    exchange_id: EXC_ID,
    variant_id: VAR_OLD,
    kind: 'returned',
    quantity: 1,
    unit_price: '450.00',
    line_total: '450.00',
    condition: 'resellable',
    notes: null,
    ...overrides,
  };
}
function newItemRow(overrides: Record<string, any> = {}) {
  return {
    id: ITEM_NEW,
    exchange_id: EXC_ID,
    variant_id: VAR_NEW,
    kind: 'new',
    quantity: 1,
    unit_price: '500.00',
    line_total: '500.00',
    condition: 'resellable',
    notes: null,
    ...overrides,
  };
}

// Default totals route — returns the new totals after mutation.
function totalsRoute(returned: number, newSide: number): Route {
  return {
    match: /COALESCE\(SUM\(CASE WHEN kind='returned'/,
    rows: [
      {
        rv: returned.toFixed(2),
        nv: newSide.toFixed(2),
      },
    ],
  };
}

// ─── Validation guards ──────────────────────────────────────────────

describe('applyApprovedExchange — validation guards', () => {
  it('throws when called with entity!=exchange (defense in depth)', async () => {
    const { ds } = makeRouter([]);
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await expect(
      svc.applyApprovedExchange({
        entity: 'return',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequest when FinancialEngineService is unavailable', async () => {
    const { ds } = makeRouter([]);
    // Build with engine = undefined explicitly.
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReturnEditRequestsService,
        { provide: DataSource, useValue: ds },
        { provide: AuditService, useValue: { writeActivity: jest.fn() } },
        {
          provide: AccountingPostingService,
          useValue: {
            reverseByReference: jest.fn(),
            postReturn: jest.fn(),
          },
        },
      ],
    }).compile();
    const svc = moduleRef.get(ReturnEditRequestsService);
    let caught: any;
    try {
      await svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.message).toMatch(/FinancialEngineService/);
  });

  it('throws NotFound when the edit request row is missing', async () => {
    const { ds } = makeRouter([
      { match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/, rows: [] },
    ]);
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await expect(
      svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws Conflict when the request status is not approved', async () => {
    const { ds } = makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [approvedRequestRow({ status: 'pending' })],
      },
    ]);
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await expect(
      svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('throws Conflict when the request was already applied', async () => {
    const { ds } = makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [
          approvedRequestRow({ applied_at: '2026-05-09T22:00:00Z' }),
        ],
      },
    ]);
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await expect(
      svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(ConflictException);
  });

  it('rejects payloads that are not kind="line_changes"', async () => {
    const { ds } = makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [approvedRequestRow({ requested_payload: { kind: 'something_else' } })],
      },
    ]);
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await expect(
      svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects empty payloads (no updated/removed/added)', async () => {
    const { ds } = makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [
          approvedRequestRow({
            requested_payload: {
              kind: 'line_changes',
              lines: { updated: [], removed: [], added: [] },
            },
          }),
        ],
      },
    ]);
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    let caught: any;
    try {
      await svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.message).toMatch(/payload فارغ/);
  });

  it('throws NotFound when the exchange is missing', async () => {
    const { ds } = makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [approvedRequestRow()],
      },
      { match: /FROM exchanges[\s\S]+FOR UPDATE/, rows: [] },
    ]);
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await expect(
      svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(NotFoundException);
  });
});

// ─── Phase 2B scope guard — kind='new' rejected ─────────────────────

describe('applyApprovedExchange — Phase 2B scope guard', () => {
  it('rejects updated payload that targets a kind="new" line with the spec\'d Arabic message', async () => {
    const { ds } = makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [
          approvedRequestRow({
            requested_payload: {
              kind: 'line_changes',
              lines: {
                updated: [
                  {
                    item_id: ITEM_NEW, // ← targets a kind='new' line
                    after: { variant_id: VAR_OLD, quantity: 1, unit_price: 600 },
                  },
                ],
                removed: [],
                added: [],
              },
            },
          }),
        ],
      },
      { match: /FROM exchanges[\s\S]+FOR UPDATE/, rows: [exchangeRow()] },
      {
        match: /FROM exchange_items WHERE exchange_id/,
        rows: [returnedItemRow(), newItemRow()],
      },
    ]);
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    let caught: any;
    try {
      await svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.message).toBe(
      'تعديل البنود الجديدة في الاستبدال غير مدعوم في هذه المرحلة — Phase 2C',
    );
  });

  it('rejects removed payload that targets a kind="new" line', async () => {
    const { ds } = makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [
          approvedRequestRow({
            requested_payload: {
              kind: 'line_changes',
              lines: {
                updated: [],
                removed: [{ item_id: ITEM_NEW }],
                added: [],
              },
            },
          }),
        ],
      },
      { match: /FROM exchanges[\s\S]+FOR UPDATE/, rows: [exchangeRow()] },
      {
        match: /FROM exchange_items WHERE exchange_id/,
        rows: [returnedItemRow(), newItemRow()],
      },
    ]);
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    let caught: any;
    try {
      await svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.message).toBe(
      'تعديل البنود الجديدة في الاستبدال غير مدعوم في هذه المرحلة — Phase 2C',
    );
  });

  it('rejects updated payload whose item_id does not exist on the exchange', async () => {
    const { ds } = makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [
          approvedRequestRow({
            requested_payload: {
              kind: 'line_changes',
              lines: {
                updated: [
                  {
                    item_id: '99999999-9999-9999-9999-999999999999',
                    after: { variant_id: VAR_OLD, quantity: 1, unit_price: 600 },
                  },
                ],
                removed: [],
                added: [],
              },
            },
          }),
        ],
      },
      { match: /FROM exchanges[\s\S]+FOR UPDATE/, rows: [exchangeRow()] },
      {
        match: /FROM exchange_items WHERE exchange_id/,
        rows: [returnedItemRow(), newItemRow()],
      },
    ]);
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await expect(
      svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

// ─── Variant + finite-number guards ─────────────────────────────────

describe('applyApprovedExchange — variant + finite-number guards', () => {
  function setupRouter(payload: any) {
    return makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [approvedRequestRow({ requested_payload: payload })],
      },
      { match: /FROM exchanges[\s\S]+FOR UPDATE/, rows: [exchangeRow()] },
      {
        match: /FROM exchange_items WHERE exchange_id/,
        rows: [returnedItemRow(), newItemRow()],
      },
      {
        match: /SELECT id FROM product_variants WHERE id/,
        rows: [],
      },
    ]);
  }

  it('rejects added line whose variant_id is not UUID-shaped', async () => {
    const { ds } = setupRouter({
      kind: 'line_changes',
      lines: {
        updated: [],
        removed: [],
        added: [
          { variant_id: '1640-not-a-uuid', quantity: 1, unit_price: 100 },
        ],
      },
    });
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await expect(
      svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects added line whose UUID variant does not exist in product_variants', async () => {
    const { ds } = makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [
          approvedRequestRow({
            requested_payload: {
              kind: 'line_changes',
              lines: {
                updated: [],
                removed: [],
                added: [
                  { variant_id: VAR_NEW, quantity: 1, unit_price: 100 },
                ],
              },
            },
          }),
        ],
      },
      { match: /FROM exchanges[\s\S]+FOR UPDATE/, rows: [exchangeRow()] },
      {
        match: /FROM exchange_items WHERE exchange_id/,
        rows: [returnedItemRow(), newItemRow()],
      },
      // product_variants lookup returns empty → "variant not in DB"
      {
        match: /SELECT id FROM product_variants WHERE id/,
        rows: [],
      },
    ]);
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await expect(
      svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects updated line whose after.quantity is Infinity', async () => {
    const { ds } = setupRouter({
      kind: 'line_changes',
      lines: {
        updated: [
          {
            item_id: ITEM_RETURNED,
            after: { variant_id: VAR_OLD, quantity: Number.POSITIVE_INFINITY, unit_price: 400 },
          },
        ],
        removed: [],
        added: [],
      },
    });
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await expect(
      svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects updated line whose after.unit_price is NaN', async () => {
    const { ds } = setupRouter({
      kind: 'line_changes',
      lines: {
        updated: [
          {
            item_id: ITEM_RETURNED,
            after: { variant_id: VAR_OLD, quantity: 1, unit_price: Number.NaN },
          },
        ],
        removed: [],
        added: [],
      },
    });
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await expect(
      svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects added line with negative price', async () => {
    const { ds } = makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [
          approvedRequestRow({
            requested_payload: {
              kind: 'line_changes',
              lines: {
                updated: [],
                removed: [],
                added: [{ variant_id: VAR_NEW, quantity: 1, unit_price: -10 }],
              },
            },
          }),
        ],
      },
      { match: /FROM exchanges[\s\S]+FOR UPDATE/, rows: [exchangeRow()] },
      {
        match: /FROM exchange_items WHERE exchange_id/,
        rows: [returnedItemRow(), newItemRow()],
      },
    ]);
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await expect(
      svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

// ─── Happy-path tests — actual mutations ────────────────────────────

describe('applyApprovedExchange — happy paths', () => {
  /**
   * Builds a full SQL-router walking one apply transaction end-to-end.
   * `payload` is the request payload; `newTotals` is what the post-
   * mutation totals query returns.
   */
  function happyRouter(opts: {
    payload?: any;
    newTotals?: { rv: number; nv: number };
    exchange?: any;
    items?: any[];
    origCt?: any | null;
    productVariantHits?: boolean;
  }) {
    const items = opts.items ?? [returnedItemRow(), newItemRow()];
    const newTotals = opts.newTotals ?? { rv: 400, nv: 500 };
    const origCt = opts.origCt;
    const stamped = approvedRequestRow({
      applied_at: '2026-05-10T03:00:00Z',
      applied_by: USER_ID,
      apply_summary: { kind: 'mocked' },
      apply_journal_entry_ids: [],
      apply_cashbox_transaction_ids: [],
      apply_stock_movement_ids: [],
    });
    const updated = opts.exchange ?? exchangeRow({
      returned_value: newTotals.rv.toFixed(2),
      new_items_value: newTotals.nv.toFixed(2),
      price_difference: (newTotals.nv - newTotals.rv).toFixed(2),
    });
    return makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [
          approvedRequestRow({
            requested_payload: opts.payload ?? approvedRequestRow().requested_payload,
          }),
        ],
      },
      {
        match: /FROM exchanges[\s\S]+FOR UPDATE/,
        rows: [opts.exchange ?? exchangeRow()],
      },
      {
        match: /FROM exchange_items WHERE exchange_id/,
        rows: items,
      },
      // product_variants existence check (added lines).  Hits if
      // explicitly opted in.
      {
        match: /SELECT id FROM product_variants WHERE id/,
        rows: opts.productVariantHits === false ? [] : [{ id: VAR_NEW }],
      },
      // Original cash CT lookup — controls reverse path.
      {
        match: /FROM cashbox_transactions[\s\S]+reference_type::text = 'exchange'/,
        rows: origCt === null ? [] : [origCt ?? {
          id: ORIG_CT_ID,
          cashbox_id: CASHBOX_ID,
          direction: 'in',
          amount: '50.00',
          category: 'refund',
          notes: 'تحصيل فرق استبدال — EXC-2026-000001',
        }],
      },
      // cost_price lookup for the unit_cost
      {
        match: /^SELECT cost_price FROM product_variants/,
        rows: [{ cost_price: '100.00' }],
      },
      // Stock UPDATE for reversal — empty result
      { match: /UPDATE stock\s+SET quantity_on_hand = quantity_on_hand - /, rows: [] },
      // Stock movements INSERT for reversal — RETURNING id
      {
        match: /INSERT INTO stock_movements[\s\S]+adjustment_out[\s\S]+RETURNING id/,
        rows: [{ id: '1001' }],
      },
      // exchange_items mutation routes
      { match: /UPDATE exchange_items[\s\S]+SET variant_id/, rows: [] },
      { match: /UPDATE exchange_items[\s\S]+SET quantity/, rows: [] },
      { match: /DELETE FROM exchange_items/, rows: [] },
      { match: /INSERT INTO exchange_items/, rows: [] },
      // Recompute totals
      totalsRoute(newTotals.rv, newTotals.nv),
      // Update exchanges
      { match: /UPDATE exchanges[\s\S]+SET returned_value/, rows: [] },
      // Replay items SELECT (resellable returned items in AFTER state)
      {
        match: /SELECT ei\.id, ei\.variant_id[\s\S]+kind = 'returned'[\s\S]+condition = 'resellable'/,
        rows: items
          .filter((x) => x.kind === 'returned' && x.condition === 'resellable')
          .map((x) => ({
            id: x.id,
            variant_id: x.variant_id,
            quantity: x.quantity,
            condition: x.condition,
            unit_cost: '100.00',
          })),
      },
      // Stock INSERT/UPSERT for replay
      { match: /INSERT INTO stock\s+\(variant_id/, rows: [] },
      // Stock movements INSERT for replay — RETURNING id
      {
        match: /INSERT INTO stock_movements[\s\S]+adjustment_in[\s\S]+RETURNING id/,
        rows: [{ id: '1002' }],
      },
      // Stamp UPDATE — RETURNING the stamped row
      {
        match: /UPDATE exchange_edit_requests[\s\S]+SET applied_at[\s\S]+RETURNING/,
        rows: [stamped],
      },
    ]);
  }

  it('updates a returned line, recomputes totals, reverses + replays cash, returns ApplyResult', async () => {
    const payload = {
      kind: 'line_changes',
      lines: {
        updated: [
          {
            item_id: ITEM_RETURNED,
            after: {
              variant_id: VAR_OLD,
              quantity: 1,
              unit_price: 400,
            },
          },
        ],
        removed: [],
        added: [],
      },
    };
    const { ds, calls } = happyRouter({ payload, newTotals: { rv: 400, nv: 500 } });
    const { engine, recordCashOnlyMovementMock } = makeEngineOk();
    const audit = { writeActivity: jest.fn() };
    const svc = await buildSvc(ds, engine, undefined, audit);

    const out = await svc.applyApprovedExchange({
      entity: 'exchange',
      parent_id: EXC_ID,
      request_id: REQ_ID,
      user_id: USER_ID,
    });

    expect(out.applied_at).not.toBeNull();
    // Reverse + replay cash legs both went through engine.
    expect(recordCashOnlyMovementMock).toHaveBeenCalledTimes(2);
    const [reverseCall, replayCall] = recordCashOnlyMovementMock.mock.calls;
    expect(reverseCall[0].category).toBe('reversal_refund');
    expect(reverseCall[0].reference_type).toBe('other');
    expect(reverseCall[0].reference_id).toBe(ORIG_CT_ID);
    expect(replayCall[0].category).toBe('refund');
    expect(replayCall[0].reference_type).toBe('exchange');
    expect(replayCall[0].reference_id).toBe(EXC_ID);
    // Activity log written.
    expect(audit.writeActivity).toHaveBeenCalledTimes(1);
    const activityCall = audit.writeActivity.mock.calls[0][0];
    expect(activityCall.entity).toBe('exchange');
    expect(activityCall.extra.kind).toBe('edit_request_apply');
    // No raw posting service calls.
    // (The mock `posting` is a no-op object; absence of crash already
    // proves we didn't call reverseByReference / postReturn.)

    // Stamping UPDATE used $5::bigint[] cast (regression for the
    // RET-2026-000006 live error).
    const stampCall = calls.find((c) =>
      /UPDATE exchange_edit_requests[\s\S]+SET applied_at/.test(c.sql),
    );
    expect(stampCall).toBeDefined();
    expect(stampCall!.sql).toMatch(/apply_stock_movement_ids\s+=\s+\$5::bigint\[\]/);
    // apply_journal_entry_ids is always [] for exchanges.
    expect(stampCall!.params[2]).toEqual([]);
  });

  it('removes a returned line and emits a DELETE', async () => {
    const payload = {
      kind: 'line_changes',
      lines: {
        updated: [],
        removed: [{ item_id: ITEM_RETURNED }],
        added: [],
      },
    };
    const { ds, calls } = happyRouter({ payload, newTotals: { rv: 0, nv: 500 } });
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await svc.applyApprovedExchange({
      entity: 'exchange',
      parent_id: EXC_ID,
      request_id: REQ_ID,
      user_id: USER_ID,
    });
    const del = calls.find((c) => /DELETE FROM exchange_items/.test(c.sql));
    expect(del).toBeDefined();
    expect(del!.sql).toMatch(/AND kind = 'returned'/);
  });

  it('adds a new returned line and emits an INSERT with kind=returned', async () => {
    const payload = {
      kind: 'line_changes',
      lines: {
        updated: [],
        removed: [],
        added: [{ variant_id: VAR_NEW, quantity: 2, unit_price: 100 }],
      },
    };
    const { ds, calls } = happyRouter({ payload, newTotals: { rv: 650, nv: 500 } });
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await svc.applyApprovedExchange({
      entity: 'exchange',
      parent_id: EXC_ID,
      request_id: REQ_ID,
      user_id: USER_ID,
    });
    const ins = calls.find((c) => /INSERT INTO exchange_items/.test(c.sql));
    expect(ins).toBeDefined();
    expect(ins!.sql).toMatch(/'returned'/);
  });

  it('captures cash CT ids into apply_cashbox_transaction_ids', async () => {
    const payload = approvedRequestRow().requested_payload;
    const { ds, calls } = happyRouter({ payload, newTotals: { rv: 400, nv: 500 } });
    const reverseRet = { ok: true, cashbox_transaction_id: 'ct-rev' };
    const replayRet = { ok: true, cashbox_transaction_id: 'ct-rep' };
    const recordCashOnlyMovementMock = jest
      .fn()
      .mockResolvedValueOnce(reverseRet)
      .mockResolvedValueOnce(replayRet);
    const engine = { recordCashOnlyMovement: recordCashOnlyMovementMock };
    const svc = await buildSvc(ds, engine);
    await svc.applyApprovedExchange({
      entity: 'exchange',
      parent_id: EXC_ID,
      request_id: REQ_ID,
      user_id: USER_ID,
    });
    const stampCall = calls.find((c) =>
      /UPDATE exchange_edit_requests[\s\S]+SET applied_at/.test(c.sql),
    );
    // params[3] = ctIds.map(Number) from the stamping UPDATE.
    expect(stampCall!.params[3]).toEqual([Number('ct-rev'), Number('ct-rep')]);
  });

  it('captures stock_movement ids into apply_stock_movement_ids', async () => {
    const payload = approvedRequestRow().requested_payload;
    const { ds, calls } = happyRouter({ payload, newTotals: { rv: 400, nv: 500 } });
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await svc.applyApprovedExchange({
      entity: 'exchange',
      parent_id: EXC_ID,
      request_id: REQ_ID,
      user_id: USER_ID,
    });
    const stampCall = calls.find((c) =>
      /UPDATE exchange_edit_requests[\s\S]+SET applied_at/.test(c.sql),
    );
    // params[4] = allSmIds.  Both reverse SM (1001) and replay SM
    // (1002) come from the router-mocked RETURNING id rows.
    expect(stampCall!.params[4]).toEqual(['1001', '1002']);
  });
});

// ─── Cash leg coverage ──────────────────────────────────────────────

describe('applyApprovedExchange — cash leg branches', () => {
  function noCtRouter(opts: { payload: any; newTotals: { rv: number; nv: number } }) {
    return makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [approvedRequestRow({ requested_payload: opts.payload })],
      },
      { match: /FROM exchanges[\s\S]+FOR UPDATE/, rows: [exchangeRow()] },
      {
        match: /FROM exchange_items WHERE exchange_id/,
        rows: [returnedItemRow(), newItemRow()],
      },
      {
        match: /SELECT id FROM product_variants WHERE id/,
        rows: [{ id: VAR_NEW }],
      },
      // No original CT — old exchange had no cash leg.
      {
        match: /FROM cashbox_transactions[\s\S]+reference_type::text = 'exchange'/,
        rows: [],
      },
      { match: /^SELECT cost_price FROM product_variants/, rows: [{ cost_price: '100.00' }] },
      { match: /UPDATE stock\s+SET quantity_on_hand = quantity_on_hand - /, rows: [] },
      {
        match: /INSERT INTO stock_movements[\s\S]+adjustment_out[\s\S]+RETURNING id/,
        rows: [{ id: '2001' }],
      },
      { match: /UPDATE exchange_items[\s\S]+SET variant_id/, rows: [] },
      { match: /UPDATE exchange_items[\s\S]+SET quantity/, rows: [] },
      { match: /DELETE FROM exchange_items/, rows: [] },
      { match: /INSERT INTO exchange_items/, rows: [] },
      totalsRoute(opts.newTotals.rv, opts.newTotals.nv),
      { match: /UPDATE exchanges[\s\S]+SET returned_value/, rows: [] },
      {
        match: /SELECT ei\.id, ei\.variant_id[\s\S]+kind = 'returned'/,
        rows: [],
      },
      {
        match: /UPDATE exchange_edit_requests[\s\S]+SET applied_at/,
        rows: [approvedRequestRow({ applied_at: '2026-05-10T04:00:00Z' })],
      },
    ]);
  }

  it('old equal + new cash IN: only replay (no reverse) calls recordCashOnlyMovement once', async () => {
    const payload = approvedRequestRow().requested_payload;
    const { ds } = noCtRouter({ payload, newTotals: { rv: 400, nv: 500 } });
    const { engine, recordCashOnlyMovementMock } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await svc.applyApprovedExchange({
      entity: 'exchange',
      parent_id: EXC_ID,
      request_id: REQ_ID,
      user_id: USER_ID,
    });
    expect(recordCashOnlyMovementMock).toHaveBeenCalledTimes(1);
    const [replayCall] = recordCashOnlyMovementMock.mock.calls;
    expect(replayCall[0].category).toBe('refund');
    expect(replayCall[0].reference_type).toBe('exchange');
    expect(replayCall[0].direction).toBe('in'); // 500-400=+100 → customer pays more → IN
  });

  it('old cash + new equal: only reverse (no replay) calls recordCashOnlyMovement once', async () => {
    const payload = approvedRequestRow().requested_payload;
    // Same router but original CT exists; new totals make price_diff = 0.
    const { ds } = makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [approvedRequestRow({ requested_payload: payload })],
      },
      { match: /FROM exchanges[\s\S]+FOR UPDATE/, rows: [exchangeRow()] },
      {
        match: /FROM exchange_items WHERE exchange_id/,
        rows: [returnedItemRow(), newItemRow()],
      },
      { match: /SELECT id FROM product_variants WHERE id/, rows: [{ id: VAR_NEW }] },
      {
        match: /FROM cashbox_transactions[\s\S]+reference_type::text = 'exchange'/,
        rows: [
          {
            id: ORIG_CT_ID,
            cashbox_id: CASHBOX_ID,
            direction: 'in',
            amount: '50.00',
            category: 'refund',
            notes: 'old',
          },
        ],
      },
      { match: /^SELECT cost_price FROM product_variants/, rows: [{ cost_price: '100.00' }] },
      { match: /UPDATE stock\s+SET quantity_on_hand = quantity_on_hand - /, rows: [] },
      {
        match: /INSERT INTO stock_movements[\s\S]+adjustment_out[\s\S]+RETURNING id/,
        rows: [{ id: '3001' }],
      },
      { match: /UPDATE exchange_items[\s\S]+SET variant_id/, rows: [] },
      { match: /UPDATE exchange_items[\s\S]+SET quantity/, rows: [] },
      { match: /DELETE FROM exchange_items/, rows: [] },
      { match: /INSERT INTO exchange_items/, rows: [] },
      totalsRoute(500, 500), // new price_diff = 0
      { match: /UPDATE exchanges[\s\S]+SET returned_value/, rows: [] },
      { match: /SELECT ei\.id, ei\.variant_id/, rows: [] },
      {
        match: /UPDATE exchange_edit_requests[\s\S]+SET applied_at/,
        rows: [approvedRequestRow({ applied_at: '2026-05-10T05:00:00Z' })],
      },
    ]);
    const { engine, recordCashOnlyMovementMock } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await svc.applyApprovedExchange({
      entity: 'exchange',
      parent_id: EXC_ID,
      request_id: REQ_ID,
      user_id: USER_ID,
    });
    expect(recordCashOnlyMovementMock).toHaveBeenCalledTimes(1);
    const [reverseCall] = recordCashOnlyMovementMock.mock.calls;
    expect(reverseCall[0].category).toBe('reversal_refund');
  });

  it('rejects when new cash leg required but exchange.cashbox_id is null', async () => {
    const payload = approvedRequestRow().requested_payload;
    const { ds } = makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [approvedRequestRow({ requested_payload: payload })],
      },
      // exchange row has cashbox_id=null
      {
        match: /FROM exchanges[\s\S]+FOR UPDATE/,
        rows: [exchangeRow({ cashbox_id: null })],
      },
      {
        match: /FROM exchange_items WHERE exchange_id/,
        rows: [returnedItemRow(), newItemRow()],
      },
      { match: /SELECT id FROM product_variants WHERE id/, rows: [{ id: VAR_NEW }] },
      {
        match: /FROM cashbox_transactions[\s\S]+reference_type::text = 'exchange'/,
        rows: [],
      },
      { match: /^SELECT cost_price FROM product_variants/, rows: [{ cost_price: '100.00' }] },
      { match: /UPDATE stock\s+SET quantity_on_hand = quantity_on_hand - /, rows: [] },
      {
        match: /INSERT INTO stock_movements[\s\S]+adjustment_out[\s\S]+RETURNING id/,
        rows: [{ id: '4001' }],
      },
      { match: /UPDATE exchange_items[\s\S]+SET variant_id/, rows: [] },
      { match: /UPDATE exchange_items[\s\S]+SET quantity/, rows: [] },
      { match: /DELETE FROM exchange_items/, rows: [] },
      { match: /INSERT INTO exchange_items/, rows: [] },
      totalsRoute(400, 500), // price_diff = 100 → cash IN required
      { match: /UPDATE exchanges[\s\S]+SET returned_value/, rows: [] },
      { match: /SELECT ei\.id, ei\.variant_id/, rows: [] },
    ]);
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    let caught: any;
    try {
      await svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.message).toMatch(/الخزنة غير محددة/);
  });

  it('does not swallow engine error from recordCashOnlyMovement (reverse path)', async () => {
    const payload = approvedRequestRow().requested_payload;
    const { ds } = makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [approvedRequestRow({ requested_payload: payload })],
      },
      { match: /FROM exchanges[\s\S]+FOR UPDATE/, rows: [exchangeRow()] },
      {
        match: /FROM exchange_items WHERE exchange_id/,
        rows: [returnedItemRow(), newItemRow()],
      },
      { match: /SELECT id FROM product_variants WHERE id/, rows: [{ id: VAR_NEW }] },
      {
        match: /FROM cashbox_transactions[\s\S]+reference_type::text = 'exchange'/,
        rows: [
          {
            id: ORIG_CT_ID,
            cashbox_id: CASHBOX_ID,
            direction: 'in',
            amount: '50.00',
            category: 'refund',
            notes: 'old',
          },
        ],
      },
    ]);
    const recordCashOnlyMovementMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, error: 'engine_locked' });
    const engine = { recordCashOnlyMovement: recordCashOnlyMovementMock };
    const svc = await buildSvc(ds, engine);
    let caught: any;
    try {
      await svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    expect(caught.message).toMatch(/engine_locked/);
  });
});

// ─── Idempotency / race protection ─────────────────────────────────

describe('applyApprovedExchange — idempotency', () => {
  it('throws Conflict when the stamping UPDATE returns no row (concurrent stamp)', async () => {
    const payload = approvedRequestRow().requested_payload;
    const { ds } = makeRouter([
      {
        match: /FROM exchange_edit_requests[\s\S]+FOR UPDATE/,
        rows: [approvedRequestRow({ requested_payload: payload })],
      },
      { match: /FROM exchanges[\s\S]+FOR UPDATE/, rows: [exchangeRow()] },
      {
        match: /FROM exchange_items WHERE exchange_id/,
        rows: [returnedItemRow(), newItemRow()],
      },
      { match: /SELECT id FROM product_variants WHERE id/, rows: [{ id: VAR_NEW }] },
      {
        match: /FROM cashbox_transactions[\s\S]+reference_type::text = 'exchange'/,
        rows: [],
      },
      { match: /^SELECT cost_price FROM product_variants/, rows: [{ cost_price: '100.00' }] },
      { match: /UPDATE stock\s+SET quantity_on_hand = quantity_on_hand - /, rows: [] },
      {
        match: /INSERT INTO stock_movements[\s\S]+adjustment_out[\s\S]+RETURNING id/,
        rows: [{ id: '5001' }],
      },
      { match: /UPDATE exchange_items[\s\S]+SET variant_id/, rows: [] },
      { match: /UPDATE exchange_items[\s\S]+SET quantity/, rows: [] },
      { match: /DELETE FROM exchange_items/, rows: [] },
      { match: /INSERT INTO exchange_items/, rows: [] },
      totalsRoute(500, 500), // price_diff = 0 (skip both cash branches)
      { match: /UPDATE exchanges[\s\S]+SET returned_value/, rows: [] },
      { match: /SELECT ei\.id, ei\.variant_id/, rows: [] },
      // Stamping UPDATE returns NO row → concurrent stamp.
      {
        match: /UPDATE exchange_edit_requests[\s\S]+SET applied_at/,
        rows: [],
      },
    ]);
    const { engine } = makeEngineOk();
    const svc = await buildSvc(ds, engine);
    await expect(
      svc.applyApprovedExchange({
        entity: 'exchange',
        parent_id: EXC_ID,
        request_id: REQ_ID,
        user_id: USER_ID,
      }),
    ).rejects.toThrow(ConflictException);
  });
});

// ─── Source-grep guards ─────────────────────────────────────────────

describe('applyApprovedExchange — source-grep contract', () => {
  const SRC = readFileSync(
    resolve(__dirname, './return-edit-requests.service.ts'),
    'utf-8',
  );
  const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /(^|[^:])\/\/[^\n]*/g,
    '$1',
  );

  function methodBody(name: string): string {
    const idx = CODE.indexOf(`async ${name}(`);
    expect(idx).toBeGreaterThan(-1);
    // Walk forward to the next method declaration so the grep is
    // scoped to ONLY this method's body.
    const after = CODE.slice(idx + 1);
    const nextMatch = after.search(/\n  (?:async |private |public )/);
    return nextMatch === -1 ? CODE.slice(idx) : after.slice(0, nextMatch);
  }

  it('applyApprovedExchange body has zero raw INSERT/UPDATE/DELETE on journal_entries / journal_lines', () => {
    const body = methodBody('applyApprovedExchange');
    expect(body).not.toMatch(/INSERT\s+INTO\s+journal_entries/i);
    expect(body).not.toMatch(/UPDATE\s+journal_entries\b/i);
    expect(body).not.toMatch(/DELETE\s+FROM\s+journal_entries/i);
    expect(body).not.toMatch(/INSERT\s+INTO\s+journal_lines/i);
    expect(body).not.toMatch(/UPDATE\s+journal_lines\b/i);
    expect(body).not.toMatch(/DELETE\s+FROM\s+journal_lines/i);
  });

  it('applyApprovedExchange body has zero raw INSERT INTO cashbox_transactions', () => {
    const body = methodBody('applyApprovedExchange');
    expect(body).not.toMatch(/INSERT\s+INTO\s+cashbox_transactions/i);
    expect(body).not.toMatch(/UPDATE\s+cashbox_transactions\b/i);
    expect(body).not.toMatch(/DELETE\s+FROM\s+cashbox_transactions/i);
  });

  it('applyApprovedExchange body has zero UPDATE/DELETE on stock_movements (insert-only)', () => {
    const body = methodBody('applyApprovedExchange');
    expect(body).not.toMatch(/UPDATE\s+stock_movements\b/i);
    expect(body).not.toMatch(/DELETE\s+FROM\s+stock_movements/i);
    // INSERT INTO stock_movements IS allowed (reverse + replay).
    expect(body).toMatch(/INSERT\s+INTO\s+stock_movements/i);
  });

  it('applyApprovedExchange body does not use accounting_only or reach posting.postReturn / postExchange', () => {
    const body = methodBody('applyApprovedExchange');
    expect(body).not.toMatch(/\baccounting_only\b/);
    expect(body).not.toMatch(/this\.posting\./);
    expect(body).not.toMatch(/postReturn/);
    expect(body).not.toMatch(/postExchange/);
    expect(body).not.toMatch(/reverseByReference/);
  });

  it('applyApprovedExchange uses engine.recordCashOnlyMovement for both reverse and replay legs', () => {
    const body = methodBody('applyApprovedExchange');
    // Two separate calls in the body — reverse + replay branches.
    const matches = body.match(/this\.engine!\.recordCashOnlyMovement\(/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it('stamping UPDATE casts apply_stock_movement_ids to ::bigint[] (regression for the live RET-2026-000006 error)', () => {
    const body = methodBody('applyApprovedExchange');
    expect(body).toMatch(/apply_stock_movement_ids\s+=\s+\$5::bigint\[\]/);
  });

  it('Phase-2B scope guard message is present verbatim', () => {
    const body = methodBody('applyApprovedExchange');
    expect(body).toContain(
      'تعديل البنود الجديدة في الاستبدال غير مدعوم في هذه المرحلة — Phase 2C',
    );
  });
});
