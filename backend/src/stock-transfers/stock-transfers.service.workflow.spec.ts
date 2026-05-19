/**
 * stock-transfers.service.workflow.spec.ts — PR-STOCK-TRANSFERS-WORKFLOW
 *
 * Pins the new lifecycle behaviour:
 *   · create / approve never move stock.
 *   · ship calls fn_adjust_stock_v2 once per item with the
 *     transfer reference and source_action='ship'.
 *   · repeated ship throws (no double-deduct).
 *   · receive calls fn_adjust_stock_v2 once per item with
 *     source_action='receive' and a DELTA quantity (idempotent
 *     against a re-submit with the same quantities).
 *   · partial receive flips status to `partially_received`.
 *   · cancel before ship moves no stock.
 *   · cancel after ship is rejected (no auto-reversal).
 *   · branch filters use `warehouse_branches` via EXISTS.
 *   · static guard: zero `UPDATE stock` / `INSERT INTO stock` in
 *     the service source (the trigger owns those writes).
 */
import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { StockTransfersService } from './stock-transfers.service';

type QueryCall = { sql: string; params: any[] };

interface Route {
  match: RegExp;
  rows?: any[];
  /** Optional factory that produces rows + can mutate call-state. */
  resolver?: (sql: string, params: any[]) => any[];
}

function makeRouter(routes: Route[]) {
  const calls: QueryCall[] = [];
  const handler = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    const r = routes.find((x) => x.match.test(sql));
    if (!r) return [];
    if (r.resolver) return r.resolver(sql, params);
    return r.rows ?? [];
  });
  return { calls, handler };
}

async function buildService(handler: jest.Mock) {
  const ds: any = {
    query: handler,
    manager: { query: handler },
    transaction: jest.fn(async (cb: any) =>
      cb({ query: handler }),
    ),
  };
  const mod = await Test.createTestingModule({
    providers: [
      StockTransfersService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  return { svc: mod.get(StockTransfersService), ds };
}

// ── Common UUIDs ──────────────────────────────────────────────────
const TID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const ITEM1 = 'cccccccc-cccc-cccc-cccc-cccccccccc01';
const ITEM2 = 'cccccccc-cccc-cccc-cccc-cccccccccc02';
const FROM_WH = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';
const TO_WH = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb2';
const VAR1 = 'dddddddd-dddd-dddd-dddd-dddddddddd01';
const VAR2 = 'dddddddd-dddd-dddd-dddd-dddddddddd02';
const USER = '99999999-9999-9999-9999-999999999999';

function transferRow(status: string, overrides: Record<string, any> = {}) {
  return {
    id: TID,
    transfer_no: 'TRF-2026-00001',
    from_warehouse_id: FROM_WH,
    to_warehouse_id: TO_WH,
    status,
    items: [],
    movements: [],
    ...overrides,
  };
}

function itemRow(opts: {
  id: string;
  variant_id: string;
  requested: number;
  received?: number;
}) {
  return {
    id: opts.id,
    transfer_id: TID,
    variant_id: opts.variant_id,
    quantity_requested: opts.requested,
    quantity_received: opts.received ?? 0,
  };
}

// ──────────────────────────────────────────────────────────────────
// create — no stock side-effect
// ──────────────────────────────────────────────────────────────────
describe('StockTransfersService.create', () => {
  it('inserts a draft transfer + items WITHOUT calling fn_adjust_stock_v2', async () => {
    const { calls, handler } = makeRouter([
      // nextTransferNo COALESCE(MAX(...))
      { match: /COALESCE\(MAX/, rows: [{ max: 0 }] },
      // warehouse active checks
      {
        match: /SELECT id, is_active FROM warehouses/,
        rows: [
          { id: FROM_WH, is_active: true },
          { id: TO_WH, is_active: true },
        ],
      },
      // INSERT INTO stock_transfers RETURNING *
      {
        match: /INSERT INTO stock_transfers/i,
        rows: [transferRow('draft')],
      },
      // INSERT INTO stock_transfer_items
      { match: /INSERT INTO stock_transfer_items/i, rows: [] },
      // findOneTx SELECTs
      { match: /FROM stock_transfers t/i, rows: [transferRow('draft')] },
      { match: /FROM stock_transfer_items ti/i, rows: [] },
      { match: /FROM stock_movements sm/i, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await svc.create(
      {
        from_warehouse_id: FROM_WH,
        to_warehouse_id: TO_WH,
        notes: null as any,
        items: [{ variant_id: VAR1, quantity_requested: 5 }],
      } as any,
      USER,
    );
    // No v2 / stock write of any kind.
    expect(calls.find((c) => /fn_adjust_stock_v2/.test(c.sql))).toBeUndefined();
    expect(calls.find((c) => /INSERT INTO stock\b(?!_)/i.test(c.sql))).toBeUndefined();
    expect(calls.find((c) => /UPDATE stock\b(?!_)/i.test(c.sql))).toBeUndefined();
  });

  it('rejects when from_warehouse_id === to_warehouse_id', async () => {
    const { handler } = makeRouter([]);
    const { svc } = await buildService(handler);
    await expect(
      svc.create(
        {
          from_warehouse_id: FROM_WH,
          to_warehouse_id: FROM_WH,
          items: [{ variant_id: VAR1, quantity_requested: 1 }],
        } as any,
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when a warehouse is inactive', async () => {
    const { handler } = makeRouter([
      { match: /COALESCE\(MAX/, rows: [{ max: 0 }] },
      {
        match: /SELECT id, is_active FROM warehouses/,
        rows: [
          { id: FROM_WH, is_active: false },
          { id: TO_WH, is_active: true },
        ],
      },
    ]);
    const { svc } = await buildService(handler);
    await expect(
      svc.create(
        {
          from_warehouse_id: FROM_WH,
          to_warehouse_id: TO_WH,
          items: [{ variant_id: VAR1, quantity_requested: 1 }],
        } as any,
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ──────────────────────────────────────────────────────────────────
// approve — no stock side-effect
// ──────────────────────────────────────────────────────────────────
describe('StockTransfersService.approve', () => {
  it('promotes draft → approved without writing any stock_movements', async () => {
    const { calls, handler } = makeRouter([
      { match: /SELECT \* FROM stock_transfers WHERE id = \$1 FOR UPDATE/, rows: [transferRow('draft')] },
      { match: /SELECT COUNT\(\*\)::int AS n FROM stock_transfer_items/, rows: [{ n: 1 }] },
      { match: /UPDATE stock_transfers SET\s+status\s*=\s*'approved'/i, rows: [] },
      // findOneTx
      { match: /FROM stock_transfers t/i, rows: [transferRow('approved')] },
      { match: /FROM stock_transfer_items ti/i, rows: [] },
      { match: /FROM stock_movements sm/i, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await svc.approve(TID, USER);
    expect(calls.find((c) => /fn_adjust_stock_v2/.test(c.sql))).toBeUndefined();
  });

  it('rejects approve on already-approved transfer (idempotent guard)', async () => {
    const { handler } = makeRouter([
      { match: /SELECT \* FROM stock_transfers/, rows: [transferRow('approved')] },
    ]);
    const { svc } = await buildService(handler);
    await expect(svc.approve(TID, USER)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects approve on a transfer with no items', async () => {
    const { handler } = makeRouter([
      { match: /SELECT \* FROM stock_transfers/, rows: [transferRow('draft')] },
      { match: /SELECT COUNT\(\*\)::int AS n FROM stock_transfer_items/, rows: [{ n: 0 }] },
    ]);
    const { svc } = await buildService(handler);
    await expect(svc.approve(TID, USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// ship — one v2 call per item, idempotent
// ──────────────────────────────────────────────────────────────────
describe('StockTransfersService.ship', () => {
  it('calls fn_adjust_stock_v2 once per item with the stock_transfer reference and source_action=ship', async () => {
    const items = [
      itemRow({ id: ITEM1, variant_id: VAR1, requested: 3 }),
      itemRow({ id: ITEM2, variant_id: VAR2, requested: 5 }),
    ];
    const { calls, handler } = makeRouter([
      { match: /SELECT \* FROM stock_transfers WHERE id = \$1 FOR UPDATE/, rows: [transferRow('approved')] },
      { match: /SELECT \* FROM stock_transfer_items WHERE transfer_id = \$1\s*$/, rows: items },
      // availability check via v_stock_unified — return plenty of stock
      {
        match: /FROM v_stock_unified/,
        resolver: () => [{ quantity_on_hand: 100 }],
      },
      // v2 calls
      { match: /fn_adjust_stock_v2/, rows: [] },
      // status UPDATE
      { match: /UPDATE stock_transfers SET\s+status\s*=\s*'in_transit'/i, rows: [] },
      // findOneTx
      { match: /FROM stock_transfers t/i, rows: [transferRow('in_transit')] },
      { match: /FROM stock_transfer_items ti/i, rows: [] },
      { match: /FROM stock_movements sm/i, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await svc.ship(TID, USER);

    const v2Calls = calls.filter((c) => /fn_adjust_stock_v2/.test(c.sql));
    expect(v2Calls).toHaveLength(2); // one per item
    for (const c of v2Calls) {
      // Reference type + source module + source action embedded as params.
      expect(c.params).toContain('stock_transfer');
      expect(c.params).toContain('stock_transfers');
      expect(c.params).toContain('ship');
      expect(c.params).toContain('transfer_out');
      // Reference id is the transfer id.
      expect(c.params).toContain(TID);
    }
    // Source warehouse is the from warehouse.
    expect(v2Calls[0].params[1]).toBe(FROM_WH);
    // Delta is NEGATIVE (out).
    expect(v2Calls[0].params[2]).toBe(-3);
    expect(v2Calls[1].params[2]).toBe(-5);
  });

  it('repeated ship on in_transit transfer throws — no stock motion the second time', async () => {
    const { handler } = makeRouter([
      { match: /SELECT \* FROM stock_transfers/, rows: [transferRow('in_transit')] },
    ]);
    const { svc } = await buildService(handler);
    await expect(svc.ship(TID, USER)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('rejects ship if availability is insufficient', async () => {
    const items = [itemRow({ id: ITEM1, variant_id: VAR1, requested: 10 })];
    const { handler } = makeRouter([
      { match: /SELECT \* FROM stock_transfers/, rows: [transferRow('approved')] },
      { match: /SELECT \* FROM stock_transfer_items WHERE transfer_id = \$1\s*$/, rows: items },
      { match: /FROM v_stock_unified/, rows: [{ quantity_on_hand: 2 }] },
    ]);
    const { svc } = await buildService(handler);
    await expect(svc.ship(TID, USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('accepts ship from draft, pending, and approved (backward-compatible)', async () => {
    for (const initial of ['draft', 'pending', 'approved']) {
      const { handler } = makeRouter([
        { match: /SELECT \* FROM stock_transfers/, rows: [transferRow(initial)] },
        { match: /SELECT \* FROM stock_transfer_items WHERE transfer_id = \$1\s*$/, rows: [itemRow({ id: ITEM1, variant_id: VAR1, requested: 1 })] },
        { match: /FROM v_stock_unified/, rows: [{ quantity_on_hand: 10 }] },
        { match: /fn_adjust_stock_v2/, rows: [] },
        { match: /UPDATE stock_transfers SET/, rows: [] },
        { match: /FROM stock_transfers t/, rows: [transferRow('in_transit')] },
        { match: /FROM stock_transfer_items ti/, rows: [] },
        { match: /FROM stock_movements sm/, rows: [] },
      ]);
      const { svc } = await buildService(handler);
      await expect(svc.ship(TID, USER)).resolves.toBeTruthy();
    }
  });
});

// ──────────────────────────────────────────────────────────────────
// receive — delta-only writes, partial status, idempotent
// ──────────────────────────────────────────────────────────────────
describe('StockTransfersService.receive', () => {
  it('emits one v2 call per item with positive delta and source_action=receive', async () => {
    const items = [
      itemRow({ id: ITEM1, variant_id: VAR1, requested: 5, received: 0 }),
      itemRow({ id: ITEM2, variant_id: VAR2, requested: 3, received: 0 }),
    ];
    const { calls, handler } = makeRouter([
      { match: /SELECT \* FROM stock_transfers/, rows: [transferRow('in_transit')] },
      { match: /SELECT \* FROM stock_transfer_items WHERE transfer_id = \$1 FOR UPDATE/, rows: items },
      { match: /fn_adjust_stock_v2/, rows: [] },
      { match: /UPDATE stock_transfer_items/, rows: [] },
      {
        match: /SELECT quantity_requested, quantity_received\s+FROM stock_transfer_items/,
        rows: [
          { quantity_requested: 5, quantity_received: 5 },
          { quantity_requested: 3, quantity_received: 3 },
        ],
      },
      { match: /UPDATE stock_transfers SET/, rows: [] },
      { match: /FROM stock_transfers t/, rows: [transferRow('received')] },
      { match: /FROM stock_transfer_items ti/, rows: [] },
      { match: /FROM stock_movements sm/, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await svc.receive(
      TID,
      { items: [{ item_id: ITEM1, quantity_received: 5 }, { item_id: ITEM2, quantity_received: 3 }] } as any,
      USER,
    );

    const v2Calls = calls.filter((c) => /fn_adjust_stock_v2/.test(c.sql));
    expect(v2Calls).toHaveLength(2);
    for (const c of v2Calls) {
      expect(c.params).toContain('receive');
      expect(c.params).toContain('transfer_in');
      expect(c.params).toContain(TID);
      // Destination warehouse on the in-leg.
      expect(c.params[1]).toBe(TO_WH);
    }
    // Status flipped to received.
    const statusUpdate = calls.find((c) =>
      /UPDATE stock_transfers SET[\s\S]+received/i.test(c.sql),
    );
    expect(statusUpdate).toBeDefined();
  });

  it('partial receive sets status to partially_received', async () => {
    const items = [itemRow({ id: ITEM1, variant_id: VAR1, requested: 10, received: 0 })];
    const { calls, handler } = makeRouter([
      { match: /SELECT \* FROM stock_transfers/, rows: [transferRow('in_transit')] },
      { match: /SELECT \* FROM stock_transfer_items WHERE transfer_id = \$1 FOR UPDATE/, rows: items },
      { match: /fn_adjust_stock_v2/, rows: [] },
      { match: /UPDATE stock_transfer_items/, rows: [] },
      {
        match: /SELECT quantity_requested, quantity_received\s+FROM stock_transfer_items/,
        // After this receive, 8 of 10 are received — partial.
        rows: [{ quantity_requested: 10, quantity_received: 8 }],
      },
      { match: /UPDATE stock_transfers SET/, rows: [] },
      { match: /FROM stock_transfers t/, rows: [transferRow('partially_received')] },
      { match: /FROM stock_transfer_items ti/, rows: [] },
      { match: /FROM stock_movements sm/, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await svc.receive(
      TID,
      { items: [{ item_id: ITEM1, quantity_received: 8 }] } as any,
      USER,
    );
    const statusUpdate = calls.find((c) =>
      /UPDATE stock_transfers SET/i.test(c.sql),
    );
    expect(statusUpdate?.params).toContain('partially_received');
  });

  it('repeated receive with the same quantities emits ZERO v2 calls (idempotent delta=0)', async () => {
    const items = [itemRow({ id: ITEM1, variant_id: VAR1, requested: 5, received: 5 })];
    const { calls, handler } = makeRouter([
      { match: /SELECT \* FROM stock_transfers/, rows: [transferRow('partially_received')] },
      { match: /SELECT \* FROM stock_transfer_items WHERE transfer_id = \$1 FOR UPDATE/, rows: items },
      { match: /UPDATE stock_transfer_items/, rows: [] },
      {
        match: /SELECT quantity_requested, quantity_received\s+FROM stock_transfer_items/,
        rows: [{ quantity_requested: 5, quantity_received: 5 }],
      },
      { match: /UPDATE stock_transfers SET/, rows: [] },
      { match: /FROM stock_transfers t/, rows: [transferRow('received')] },
      { match: /FROM stock_transfer_items ti/, rows: [] },
      { match: /FROM stock_movements sm/, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await svc.receive(
      TID,
      { items: [{ item_id: ITEM1, quantity_received: 5 }] } as any,
      USER,
    );
    expect(calls.find((c) => /fn_adjust_stock_v2/.test(c.sql))).toBeUndefined();
  });

  it('top-up receive emits ONLY the delta (8 → 10 ⇒ v2 with +2)', async () => {
    const items = [itemRow({ id: ITEM1, variant_id: VAR1, requested: 10, received: 8 })];
    const { calls, handler } = makeRouter([
      { match: /SELECT \* FROM stock_transfers/, rows: [transferRow('partially_received')] },
      { match: /SELECT \* FROM stock_transfer_items WHERE transfer_id = \$1 FOR UPDATE/, rows: items },
      { match: /fn_adjust_stock_v2/, rows: [] },
      { match: /UPDATE stock_transfer_items/, rows: [] },
      {
        match: /SELECT quantity_requested, quantity_received\s+FROM stock_transfer_items/,
        rows: [{ quantity_requested: 10, quantity_received: 10 }],
      },
      { match: /UPDATE stock_transfers SET/, rows: [] },
      { match: /FROM stock_transfers t/, rows: [transferRow('received')] },
      { match: /FROM stock_transfer_items ti/, rows: [] },
      { match: /FROM stock_movements sm/, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await svc.receive(
      TID,
      { items: [{ item_id: ITEM1, quantity_received: 10 }] } as any,
      USER,
    );
    const v2 = calls.find((c) => /fn_adjust_stock_v2/.test(c.sql));
    expect(v2).toBeDefined();
    expect(v2!.params[2]).toBe(2);
  });

  it('rejects receive payload that reduces an already-received quantity', async () => {
    const items = [itemRow({ id: ITEM1, variant_id: VAR1, requested: 10, received: 5 })];
    const { handler } = makeRouter([
      { match: /SELECT \* FROM stock_transfers/, rows: [transferRow('partially_received')] },
      { match: /SELECT \* FROM stock_transfer_items WHERE transfer_id = \$1 FOR UPDATE/, rows: items },
    ]);
    const { svc } = await buildService(handler);
    await expect(
      svc.receive(
        TID,
        { items: [{ item_id: ITEM1, quantity_received: 3 }] } as any,
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects receive payload over quantity_requested', async () => {
    const items = [itemRow({ id: ITEM1, variant_id: VAR1, requested: 5 })];
    const { handler } = makeRouter([
      { match: /SELECT \* FROM stock_transfers/, rows: [transferRow('in_transit')] },
      { match: /SELECT \* FROM stock_transfer_items WHERE transfer_id = \$1 FOR UPDATE/, rows: items },
    ]);
    const { svc } = await buildService(handler);
    await expect(
      svc.receive(
        TID,
        { items: [{ item_id: ITEM1, quantity_received: 6 }] } as any,
        USER,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects receive on a non-receivable status (no movement emitted)', async () => {
    const { calls, handler } = makeRouter([
      { match: /SELECT \* FROM stock_transfers/, rows: [transferRow('draft')] },
    ]);
    const { svc } = await buildService(handler);
    await expect(
      svc.receive(
        TID,
        { items: [{ item_id: ITEM1, quantity_received: 1 }] } as any,
        USER,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(calls.find((c) => /fn_adjust_stock_v2/.test(c.sql))).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────
// cancel — pre-ship only, never reverses stock
// ──────────────────────────────────────────────────────────────────
describe('StockTransfersService.cancel', () => {
  it.each(['draft', 'pending', 'approved'])(
    'cancels %s without writing any stock movement',
    async (initial) => {
      const { calls, handler } = makeRouter([
        { match: /SELECT \* FROM stock_transfers/, rows: [transferRow(initial)] },
        { match: /UPDATE stock_transfers SET/, rows: [] },
        { match: /FROM stock_transfers t/, rows: [transferRow('cancelled')] },
        { match: /FROM stock_transfer_items ti/, rows: [] },
        { match: /FROM stock_movements sm/, rows: [] },
      ]);
      const { svc } = await buildService(handler);
      await svc.cancel(TID, USER);
      expect(calls.find((c) => /fn_adjust_stock_v2/.test(c.sql))).toBeUndefined();
    },
  );

  it.each(['in_transit', 'partially_received', 'received', 'cancelled', 'rejected'])(
    'rejects cancel on %s (no reverse movement is invented)',
    async (initial) => {
      const { calls, handler } = makeRouter([
        { match: /SELECT \* FROM stock_transfers/, rows: [transferRow(initial)] },
      ]);
      const { svc } = await buildService(handler);
      await expect(svc.cancel(TID, USER)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(calls.find((c) => /fn_adjust_stock_v2/.test(c.sql))).toBeUndefined();
    },
  );

  it('throws 404 when the transfer does not exist', async () => {
    const { handler } = makeRouter([
      { match: /SELECT \* FROM stock_transfers/, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await expect(svc.cancel(TID, USER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// list — branch filters use warehouse_branches EXISTS
// ──────────────────────────────────────────────────────────────────
describe('StockTransfersService.list — filters', () => {
  it('from_branch_id + to_branch_id both add EXISTS sub-queries against warehouse_branches', async () => {
    const { calls, handler } = makeRouter([{ match: /./, rows: [] }]);
    const { svc } = await buildService(handler);
    await svc.list({
      from_branch_id: '11111111-1111-1111-1111-111111111111',
      to_branch_id:   '22222222-2222-2222-2222-222222222222',
    } as any);
    const listCall = calls.find((c) => /FROM stock_transfers t/i.test(c.sql));
    expect(listCall).toBeDefined();
    expect(listCall!.sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM warehouse_branches wb_f[\s\S]+wb_f\.warehouse_id\s*=\s*t\.from_warehouse_id/i,
    );
    expect(listCall!.sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM warehouse_branches wb_t[\s\S]+wb_t\.warehouse_id\s*=\s*t\.to_warehouse_id/i,
    );
    // EXISTS — never a row-multiplying JOIN.
    expect(listCall!.sql).not.toMatch(
      /JOIN\s+warehouse_branches\s+wb\s+ON/i,
    );
    expect(listCall!.params).toContain(
      '11111111-1111-1111-1111-111111111111',
    );
    expect(listCall!.params).toContain(
      '22222222-2222-2222-2222-222222222222',
    );
  });

  it('passes date_from / date_to / search / from_warehouse_id / to_warehouse_id through', async () => {
    const { calls, handler } = makeRouter([{ match: /./, rows: [] }]);
    const { svc } = await buildService(handler);
    await svc.list({
      date_from: '2026-01-01',
      date_to: '2026-12-31',
      search: 'TRF-2026',
      from_warehouse_id: FROM_WH,
      to_warehouse_id: TO_WH,
      status: 'in_transit',
    } as any);
    const listCall = calls.find((c) => /FROM stock_transfers t/i.test(c.sql));
    expect(listCall!.sql).toMatch(/t\.created_at\s*>=/);
    expect(listCall!.sql).toMatch(/INTERVAL\s+'1 day'/);
    expect(listCall!.sql).toMatch(/ILIKE/);
    expect(listCall!.sql).toMatch(/t\.from_warehouse_id\s*=\s*\$/);
    expect(listCall!.sql).toMatch(/t\.to_warehouse_id\s*=\s*\$/);
    expect(listCall!.params).toContain('in_transit');
    expect(listCall!.params).toContain('%TRF-2026%');
  });
});

// ──────────────────────────────────────────────────────────────────
// static guardrail — service never writes to stock directly
// ──────────────────────────────────────────────────────────────────
describe('StockTransfersService — static guardrail (no direct stock writes)', () => {
  const SRC = readFileSync(
    join(__dirname, 'stock-transfers.service.ts'),
    'utf8',
  );
  // Strip comments so doc lines mentioning forbidden patterns don't
  // trip the guard.
  const stripped = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /\/\/[^\n]*/g,
    '',
  );

  it('no INSERT INTO stock (only stock_transfers + stock_transfer_items)', () => {
    expect(stripped).not.toMatch(/INSERT INTO\s+stock\b(?!_)/i);
    expect(stripped).not.toMatch(/INSERT INTO\s+stock_movements/i);
    const inserts = stripped.match(/INSERT INTO\s+(\w+)/gi) ?? [];
    for (const ins of inserts) {
      expect(ins).toMatch(
        /INSERT INTO\s+(stock_transfers|stock_transfer_items)\b/i,
      );
    }
  });

  it('no UPDATE stock SET …  (only stock_transfers + stock_transfer_items)', () => {
    expect(stripped).not.toMatch(/UPDATE\s+stock\b(?!_)/i);
    const updates = stripped.match(/UPDATE\s+\w+\s+SET/gi) ?? [];
    for (const upd of updates) {
      expect(upd).toMatch(
        /UPDATE\s+(stock_transfers|stock_transfer_items)\s+SET/i,
      );
    }
  });

  it('no DELETE FROM stock / stock_movements', () => {
    const deletes = stripped.match(/DELETE FROM\s+(\w+)/gi) ?? [];
    for (const del of deletes) {
      // The only DELETE in the service targets stock_transfer_items
      // (when an operator updates a draft transfer's item list).
      expect(del).toMatch(/DELETE FROM\s+stock_transfer_items\b/i);
    }
  });

  it('no manual quantity_on_hand / balance_after_qty assignments', () => {
    expect(stripped).not.toMatch(/\bquantity_on_hand\s*=/);
    expect(stripped).not.toMatch(/\bbalance_after_qty\s*=/);
  });

  it('does not touch GL / cashbox / supplier / payment surfaces', () => {
    for (const pat of [
      /journal_entries/i,
      /journal_lines/i,
      /cashbox_transactions/i,
      /cashbox_balances/i,
      /supplier_ledger/i,
      /supplier_payments/i,
      /payment_allocations/i,
    ]) {
      expect(stripped).not.toMatch(pat);
    }
  });
});
