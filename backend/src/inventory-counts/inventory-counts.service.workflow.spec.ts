/**
 * inventory-counts.service.workflow.spec.ts
 * — PR-INVENTORY-COUNTS-WORKFLOW
 *
 * Pins the new lifecycle behaviour for the stocktaking module.
 *   · create / freeze / updateItems / review never touch stock.
 *   · freeze is idempotent (`ON CONFLICT DO NOTHING`).
 *   · finalize calls fn_adjust_stock_v2 ONCE per variance with the
 *     correct reference_type / reference_id / source_module /
 *     source_action / movement_type direction.
 *   · finalize is idempotent — an EXISTS check on stock_movements
 *     stops a second call from re-emitting movements.
 *   · cancel only works pre-finalize; post-finalize cancel is rejected.
 *   · branch filter goes through warehouse_branches via EXISTS.
 *   · static guard: zero `INSERT INTO stock` / `UPDATE stock` /
 *     stock_movements writes anywhere in this service file (only
 *     `inventory_counts` + `inventory_count_items` are written).
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
import { InventoryCountsService } from './inventory-counts.service';

type QueryCall = { sql: string; params: any[] };

interface Route {
  match: RegExp;
  rows?: any[];
  resolver?: (sql: string, params: any[]) => any[];
}

function makeRouter(routes: Route[]) {
  const calls: QueryCall[] = [];
  const handler = jest.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    const r = routes.find((x) => x.match.test(sql));
    if (!r) return [];
    return r.resolver ? r.resolver(sql, params) : (r.rows ?? []);
  });
  return { calls, handler };
}

async function buildService(handler: jest.Mock) {
  const ds: any = {
    query: handler,
    manager: { query: handler },
    transaction: jest.fn(async (cb: any) => cb({ query: handler })),
  };
  const mod = await Test.createTestingModule({
    providers: [
      InventoryCountsService,
      { provide: DataSource, useValue: ds },
    ],
  }).compile();
  return { svc: mod.get(InventoryCountsService), ds };
}

const CID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WH = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbb1';
const ITEM1 = 'cccccccc-cccc-cccc-cccc-cccccccccc01';
const VAR1 = 'dddddddd-dddd-dddd-dddd-dddddddddd01';
const USER = '99999999-9999-9999-9999-999999999999';

function countRow(status: string, extras: Record<string, any> = {}) {
  return {
    id: CID,
    count_no: 'CNT-2026-00001',
    warehouse_id: WH,
    status,
    ...extras,
  };
}

// ──────────────────────────────────────────────────────────────────
// create — no stock side-effect
// ──────────────────────────────────────────────────────────────────
describe('InventoryCountsService.create', () => {
  it('inserts a draft header WITHOUT touching stock', async () => {
    const { calls, handler } = makeRouter([
      { match: /SELECT id, is_active FROM warehouses/, rows: [{ id: WH, is_active: true }] },
      { match: /COALESCE\(MAX/, rows: [{ max: 0 }] },
      { match: /INSERT INTO inventory_counts/, rows: [countRow('draft')] },
      // findOneTx
      { match: /FROM inventory_counts c/, rows: [countRow('draft')] },
      { match: /FROM inventory_count_items ci/, rows: [] },
      { match: /FROM stock_movements sm/, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await svc.create({ warehouse_id: WH } as any, USER);
    expect(calls.find((c) => /fn_adjust_stock_v2/.test(c.sql))).toBeUndefined();
    expect(calls.find((c) => /INSERT INTO stock\b(?!_)/i.test(c.sql))).toBeUndefined();
    expect(calls.find((c) => /UPDATE stock\b(?!_)/i.test(c.sql))).toBeUndefined();
    // INSERT goes into inventory_counts only.
    const insert = calls.find((c) => /INSERT INTO inventory_counts/i.test(c.sql));
    expect(insert).toBeDefined();
  });

  it('rejects creation against an inactive warehouse', async () => {
    const { handler } = makeRouter([
      { match: /SELECT id, is_active FROM warehouses/, rows: [{ id: WH, is_active: false }] },
    ]);
    const { svc } = await buildService(handler);
    await expect(
      svc.create({ warehouse_id: WH } as any, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ──────────────────────────────────────────────────────────────────
// freeze — idempotent snapshot
// ──────────────────────────────────────────────────────────────────
describe('InventoryCountsService.freeze', () => {
  it('snapshots stock into inventory_count_items with ON CONFLICT DO NOTHING (idempotent)', async () => {
    const { calls, handler } = makeRouter([
      { match: /SELECT \* FROM inventory_counts WHERE id = \$1 FOR UPDATE/, rows: [countRow('draft')] },
      // snapshot insert
      { match: /INSERT INTO inventory_count_items/, rows: [] },
      // status flip to open
      { match: /UPDATE inventory_counts SET status = 'open'/, rows: [] },
      // findOneTx
      { match: /FROM inventory_counts c/, rows: [countRow('open')] },
      { match: /FROM inventory_count_items ci/, rows: [] },
      { match: /FROM stock_movements sm/, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await svc.freeze(CID, {} as any, USER);

    const snapshot = calls.find((c) =>
      /INSERT INTO inventory_count_items/i.test(c.sql),
    );
    expect(snapshot).toBeDefined();
    expect(snapshot!.sql).toMatch(/ON CONFLICT \(count_id, variant_id\) DO NOTHING/i);
    // No stock movement at any point.
    expect(calls.find((c) => /fn_adjust_stock_v2/.test(c.sql))).toBeUndefined();
  });

  it('second freeze on an already-frozen count is a safe no-op (no error, ON CONFLICT DO NOTHING)', async () => {
    const { calls, handler } = makeRouter([
      { match: /SELECT \* FROM inventory_counts WHERE id = \$1 FOR UPDATE/, rows: [countRow('open')] },
      { match: /INSERT INTO inventory_count_items/, rows: [] },
      { match: /FROM inventory_counts c/, rows: [countRow('open')] },
      { match: /FROM inventory_count_items ci/, rows: [] },
      { match: /FROM stock_movements sm/, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await expect(svc.freeze(CID, {} as any, USER)).resolves.toBeTruthy();
    expect(calls.find((c) => /fn_adjust_stock_v2/.test(c.sql))).toBeUndefined();
    // ON CONFLICT guard still present.
    expect(
      calls.find((c) => /INSERT INTO inventory_count_items/i.test(c.sql))!.sql,
    ).toMatch(/ON CONFLICT/i);
  });
});

// ──────────────────────────────────────────────────────────────────
// updateItems — counted_qty + difference, no stock motion
// ──────────────────────────────────────────────────────────────────
describe('InventoryCountsService.updateItems', () => {
  it('updates counted_qty / notes via UPDATE inventory_count_items only', async () => {
    const { calls, handler } = makeRouter([
      { match: /SELECT \* FROM inventory_counts/, rows: [countRow('open')] },
      { match: /UPDATE inventory_count_items SET/, rows: [{ id: ITEM1 }] },
      { match: /SELECT COUNT\(\*\)::int AS counted/, rows: [{ counted: 1 }] },
      { match: /UPDATE inventory_counts SET status = 'counting'/, rows: [] },
      { match: /FROM inventory_counts c/, rows: [countRow('counting')] },
      { match: /FROM inventory_count_items ci/, rows: [] },
      { match: /FROM stock_movements sm/, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await svc.updateItems(
      CID,
      { items: [{ item_id: ITEM1, counted_qty: 4 }] } as any,
      USER,
    );
    expect(calls.find((c) => /fn_adjust_stock_v2/.test(c.sql))).toBeUndefined();
    expect(calls.find((c) => /UPDATE stock\b(?!_)/i.test(c.sql))).toBeUndefined();
  });

  it('rejects updates against a finalized count', async () => {
    const { handler } = makeRouter([
      { match: /SELECT \* FROM inventory_counts/, rows: [countRow('finalized')] },
    ]);
    const { svc } = await buildService(handler);
    await expect(
      svc.updateItems(CID, { items: [{ item_id: ITEM1, counted_qty: 1 }] } as any, USER),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('rejects negative counted_qty', async () => {
    const { handler } = makeRouter([
      { match: /SELECT \* FROM inventory_counts/, rows: [countRow('open')] },
    ]);
    const { svc } = await buildService(handler);
    await expect(
      svc.updateItems(CID, { items: [{ item_id: ITEM1, counted_qty: -1 }] } as any, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ──────────────────────────────────────────────────────────────────
// review — gate on all items counted
// ──────────────────────────────────────────────────────────────────
describe('InventoryCountsService.review', () => {
  it('rejects review when any item is missing counted_qty', async () => {
    const { handler } = makeRouter([
      { match: /SELECT \* FROM inventory_counts/, rows: [countRow('counting')] },
      { match: /SELECT COUNT\(\*\)::int AS missing/, rows: [{ missing: 3 }] },
    ]);
    const { svc } = await buildService(handler);
    await expect(svc.review(CID, USER)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('promotes counting → review when everything is counted (no stock motion)', async () => {
    const { calls, handler } = makeRouter([
      { match: /SELECT \* FROM inventory_counts/, rows: [countRow('counting')] },
      { match: /SELECT COUNT\(\*\)::int AS missing/, rows: [{ missing: 0 }] },
      { match: /UPDATE inventory_counts SET status = 'review'/, rows: [] },
      { match: /FROM inventory_counts c/, rows: [countRow('review')] },
      { match: /FROM inventory_count_items ci/, rows: [] },
      { match: /FROM stock_movements sm/, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await svc.review(CID, USER);
    expect(calls.find((c) => /fn_adjust_stock_v2/.test(c.sql))).toBeUndefined();
  });
});

// ──────────────────────────────────────────────────────────────────
// finalize — v2 per variance, idempotent EXISTS check
// ──────────────────────────────────────────────────────────────────
describe('InventoryCountsService.finalize', () => {
  it('calls fn_adjust_stock_v2 once per variance with reference_type=inventory_count', async () => {
    const items = [
      { id: ITEM1, variant_id: VAR1, system_qty: 5, counted_qty: 7, difference: 2 },
      { id: 'i2', variant_id: 'v2', system_qty: 3, counted_qty: 2, difference: -1 },
      { id: 'i3', variant_id: 'v3', system_qty: 4, counted_qty: 4, difference: 0 },
    ];
    const { calls, handler } = makeRouter([
      { match: /SELECT \* FROM inventory_counts/, rows: [countRow('review')] },
      { match: /SELECT COUNT\(\*\)::int AS missing/, rows: [{ missing: 0 }] },
      { match: /SELECT COUNT\(\*\)::int AS existing/, rows: [{ existing: 0 }] },
      { match: /SELECT id, variant_id, system_qty, counted_qty/, rows: items },
      { match: /SELECT COALESCE\(cost_price/, rows: [{ cp: '10.00' }] },
      { match: /fn_adjust_stock_v2/, rows: [] },
      { match: /UPDATE inventory_counts SET\s+status\s*=\s*'finalized'/, rows: [] },
      { match: /FROM inventory_counts c/, rows: [countRow('finalized')] },
      { match: /FROM inventory_count_items ci/, rows: [] },
      { match: /FROM stock_movements sm/, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await svc.finalize(CID, {} as any, USER);

    const v2Calls = calls.filter((c) => /fn_adjust_stock_v2/.test(c.sql));
    // Two non-zero diffs, ignoring the diff=0 row.
    expect(v2Calls).toHaveLength(2);
    for (const c of v2Calls) {
      expect(c.params).toContain('inventory_count');
      expect(c.params).toContain('inventory_counts');
      expect(c.params).toContain('finalize');
      expect(c.params).toContain(CID);
    }
    // Movement types: +2 → adjustment_in, -1 → adjustment_out.
    expect(v2Calls[0].params).toContain('adjustment_in');
    expect(v2Calls[1].params).toContain('adjustment_out');
  });

  it('repeated finalize on the SAME count emits ZERO new v2 calls (EXISTS check)', async () => {
    const { calls, handler } = makeRouter([
      { match: /SELECT \* FROM inventory_counts/, rows: [countRow('review')] },
      { match: /SELECT COUNT\(\*\)::int AS missing/, rows: [{ missing: 0 }] },
      // existing > 0 → fast path
      { match: /SELECT COUNT\(\*\)::int AS existing/, rows: [{ existing: 5 }] },
      { match: /UPDATE inventory_counts SET\s+status\s*=\s*'finalized'/, rows: [] },
      { match: /FROM inventory_counts c/, rows: [countRow('finalized')] },
      { match: /FROM inventory_count_items ci/, rows: [] },
      { match: /FROM stock_movements sm/, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await svc.finalize(CID, {} as any, USER);
    expect(calls.find((c) => /fn_adjust_stock_v2/.test(c.sql))).toBeUndefined();
  });

  it('finalize on already-finalized status is a no-op (no error, no v2 calls)', async () => {
    const { calls, handler } = makeRouter([
      { match: /SELECT \* FROM inventory_counts/, rows: [countRow('finalized')] },
      { match: /FROM inventory_counts c/, rows: [countRow('finalized')] },
      { match: /FROM inventory_count_items ci/, rows: [] },
      { match: /FROM stock_movements sm/, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await expect(svc.finalize(CID, {} as any, USER)).resolves.toBeTruthy();
    expect(calls.find((c) => /fn_adjust_stock_v2/.test(c.sql))).toBeUndefined();
  });

  it('rejects finalize when any item is missing counted_qty', async () => {
    const { handler } = makeRouter([
      { match: /SELECT \* FROM inventory_counts/, rows: [countRow('counting')] },
      { match: /SELECT COUNT\(\*\)::int AS missing/, rows: [{ missing: 2 }] },
    ]);
    const { svc } = await buildService(handler);
    await expect(
      svc.finalize(CID, {} as any, USER),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects finalize from non-finalizable status (e.g. draft)', async () => {
    const { handler } = makeRouter([
      { match: /SELECT \* FROM inventory_counts/, rows: [countRow('draft')] },
    ]);
    const { svc } = await buildService(handler);
    await expect(
      svc.finalize(CID, {} as any, USER),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});

// ──────────────────────────────────────────────────────────────────
// cancel — pre-finalize only
// ──────────────────────────────────────────────────────────────────
describe('InventoryCountsService.cancel', () => {
  it.each(['draft', 'open', 'counting', 'review', 'in_progress'])(
    'cancels %s without writing stock',
    async (initial) => {
      const { calls, handler } = makeRouter([
        { match: /SELECT \* FROM inventory_counts/, rows: [countRow(initial)] },
        { match: /UPDATE inventory_counts SET[\s\S]*cancelled/, rows: [] },
        { match: /FROM inventory_counts c/, rows: [countRow('cancelled')] },
        { match: /FROM inventory_count_items ci/, rows: [] },
        { match: /FROM stock_movements sm/, rows: [] },
      ]);
      const { svc } = await buildService(handler);
      await svc.cancel(CID, {} as any, USER);
      expect(calls.find((c) => /fn_adjust_stock_v2/.test(c.sql))).toBeUndefined();
    },
  );

  it.each(['finalized', 'completed', 'cancelled'])(
    'rejects cancel on %s',
    async (initial) => {
      const { handler } = makeRouter([
        { match: /SELECT \* FROM inventory_counts/, rows: [countRow(initial)] },
      ]);
      const { svc } = await buildService(handler);
      await expect(svc.cancel(CID, {} as any, USER)).rejects.toBeInstanceOf(
        ConflictException,
      );
    },
  );

  it('throws 404 on missing count', async () => {
    const { handler } = makeRouter([
      { match: /SELECT \* FROM inventory_counts/, rows: [] },
    ]);
    const { svc } = await buildService(handler);
    await expect(svc.cancel(CID, {} as any, USER)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});

// ──────────────────────────────────────────────────────────────────
// list — branch filter uses warehouse_branches EXISTS
// ──────────────────────────────────────────────────────────────────
describe('InventoryCountsService.list', () => {
  it('branch_id filter goes through EXISTS over warehouse_branches', async () => {
    const { calls, handler } = makeRouter([{ match: /./, rows: [] }]);
    const { svc } = await buildService(handler);
    await svc.list({
      branch_id: '11111111-1111-1111-1111-111111111111',
    } as any);

    const listCall = calls.find((c) => /FROM inventory_counts c/i.test(c.sql));
    expect(listCall).toBeDefined();
    expect(listCall!.sql).toMatch(
      /EXISTS\s*\(\s*SELECT 1 FROM warehouse_branches wb[\s\S]+wb\.warehouse_id\s*=\s*c\.warehouse_id/i,
    );
    expect(listCall!.sql).not.toMatch(
      /JOIN\s+warehouse_branches\s+wb\s+ON/i,
    );
    expect(listCall!.params).toContain(
      '11111111-1111-1111-1111-111111111111',
    );
  });

  it('search / date_from / date_to / status / warehouse_id all forward into the WHERE clause', async () => {
    const { calls, handler } = makeRouter([{ match: /./, rows: [] }]);
    const { svc } = await buildService(handler);
    await svc.list({
      status: 'review',
      warehouse_id: WH,
      date_from: '2026-05-01',
      date_to: '2026-05-31',
      search: 'CNT-2026',
    } as any);
    const listCall = calls.find((c) => /FROM inventory_counts c/i.test(c.sql));
    expect(listCall!.sql).toMatch(/c\.status\s*=\s*\$/);
    expect(listCall!.sql).toMatch(/c\.warehouse_id\s*=\s*\$/);
    expect(listCall!.sql).toMatch(/c\.started_at\s*>=/);
    expect(listCall!.sql).toMatch(/INTERVAL\s+'1 day'/);
    expect(listCall!.sql).toMatch(/ILIKE/);
    expect(listCall!.params).toContain('review');
    expect(listCall!.params).toContain('%CNT-2026%');
  });
});

// ──────────────────────────────────────────────────────────────────
// Static guardrail — module never writes to stock directly
// ──────────────────────────────────────────────────────────────────
describe('InventoryCountsService — static guardrail (no direct stock writes)', () => {
  const SRC = readFileSync(
    join(__dirname, 'inventory-counts.service.ts'),
    'utf8',
  );
  // Strip comments so doc strings mentioning forbidden tables don't
  // trip the guard.
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(
    /\/\/[^\n]*/g,
    '',
  );

  it('no INSERT INTO stock / stock_movements', () => {
    expect(code).not.toMatch(/INSERT INTO\s+stock\b(?!_)/i);
    expect(code).not.toMatch(/INSERT INTO\s+stock_movements/i);
    const inserts = code.match(/INSERT INTO\s+(\w+)/gi) ?? [];
    for (const ins of inserts) {
      expect(ins).toMatch(
        /INSERT INTO\s+(inventory_counts|inventory_count_items)\b/i,
      );
    }
  });

  it('no UPDATE stock SET … (only inventory_counts + inventory_count_items)', () => {
    expect(code).not.toMatch(/UPDATE\s+stock\b(?!_)/i);
    const updates = code.match(/UPDATE\s+\w+\s+SET/gi) ?? [];
    for (const upd of updates) {
      expect(upd).toMatch(
        /UPDATE\s+(inventory_counts|inventory_count_items)\s+SET/i,
      );
    }
  });

  it('no DELETE FROM stock / stock_movements / inventory_count_items', () => {
    const deletes = code.match(/DELETE FROM\s+\w+/gi) ?? [];
    expect(deletes).toEqual([]);
  });

  it('no manual quantity_on_hand / balance_after_qty assignments', () => {
    expect(code).not.toMatch(/\bquantity_on_hand\s*=(?!=)/);
    expect(code).not.toMatch(/\bbalance_after_qty\s*=(?!=)/);
  });

  it('finalize uses fn_adjust_stock_v2 (not the legacy v1 helper)', () => {
    expect(code).not.toMatch(/\bfn_adjust_stock\s*\(/);
    const v2 = code.match(/fn_adjust_stock_v2\s*\(/g) ?? [];
    expect(v2.length).toBe(1); // exactly one call site inside finalize
  });
});
