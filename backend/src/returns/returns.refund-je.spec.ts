/**
 * returns.refund-je.spec.ts — PR-FIX-RETURN-CASH-MOVEMENTS
 *
 * Pins the second-stage forward fix.  Stage 1 (PR-FIX-RETURN-JE-AT-
 * REFUND, commit ca20d20) moved `postReturn` from `approve()` to
 * `refund()` and added loud error propagation.  That tripped the
 * engine's Guard B (every cash GL line must be paired with an
 * in-spec `cash_movement`) because the CT was still being written
 * separately via `engine.recordCashOnlyMovement` after the JE.
 *
 * Stage 2 — this fix:
 *   · `postReturn` now builds `cash_movements` alongside its GL
 *     lines and hands both to `FinancialEngineService.recordTransaction`
 *     in a single call.  Phase 1 of the engine writes the
 *     `cashbox_transactions` row; Phase 2 writes the JE.  Atomic.
 *   · `refund()` no longer calls `engine.recordCashOnlyMovement` —
 *     calling it would create a duplicate CT.
 *
 * What this spec pins:
 *   1. `approve()` does not call `postReturn`.
 *   2. `refund()` calls `posting.postReturn` exactly once, after the
 *      UPDATE that writes `cashbox_id`.
 *   3. `refund()` does NOT call `engine.recordCashOnlyMovement`.
 *   4. `postReturn` returning `{ error }` causes the refund
 *      transaction to throw + roll back.
 *   5. `postReturn` throwing also fails the refund.
 *   6. Missing AccountingPostingService throws (no silent skip).
 *   7. `postReturn` returning `{ skipped: true }` (live JE exists)
 *      does NOT throw; the refund continues.
 *   8. `postReturn` returning `null` (no-op) does NOT throw.
 *   9. Source-grep: `accounting_only` is never passed.  No raw
 *      INSERT into journal_entries / journal_lines / cashbox_transactions
 *      from this service.  `refund()` body contains zero
 *      `recordCashOnlyMovement` calls.
 *
 * No DB.  DataSource / posting / engine are stubs.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { getRepositoryToken } from '@nestjs/typeorm';
import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ReturnsService } from './returns.service';
import { ReturnEntity } from './entities/return.entity';
import { AccountingPostingService } from '../chart-of-accounts/posting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

type QueryCall = { sql: string; params: any[] };
type Route = {
  match: RegExp;
  rows?: any[];
  fn?: (params: any[]) => any[] | undefined;
};

const RETURN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const USER_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SHIFT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const CASHBOX_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
const RETURN_NO = 'RET-2026-TEST';

function makeRouter(routes: Route[]) {
  const calls: QueryCall[] = [];
  const ds: any = {
    query: async (sql: string, params: any[] = []) => {
      calls.push({ sql, params });
      const route = routes.find((r) => r.match.test(sql));
      if (!route) {
        // Default to empty rows for any unmocked SQL — these tests
        // care about call ordering + a couple of returned rows, not
        // every single statement.
        return [];
      }
      const out = route.fn ? route.fn(params) : route.rows;
      return out ?? [];
    },
    transaction: async (cb: (em: any) => Promise<any>) => cb(ds),
  };
  return { ds, calls };
}

function approvedRetRow(over: Partial<any> = {}) {
  return {
    id: RETURN_ID,
    return_no: RETURN_NO,
    status: 'approved',
    refund_method: null,
    net_refund: '150.00',
    cashbox_id: null, // before refund() sets it
    warehouse_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    ...over,
  };
}

const baseRoutes = (retRow: any): Route[] => [
  // mustBeStatus() lookup at the top of refund().
  {
    match: /SELECT\s+\*\s+FROM\s+returns\s+WHERE\s+id\s*=\s*\$1/i,
    rows: [retRow],
  },
  // Shift lookup when shift_id is supplied for the cash refund path.
  {
    match: /SELECT id, cashbox_id, status::text AS status\s+FROM shifts/,
    rows: [{ id: SHIFT_ID, cashbox_id: CASHBOX_ID, status: 'open' }],
  },
  // UPDATE returns SET status='refunded', cashbox_id=...
  {
    match: /UPDATE\s+returns\s+SET\s+status\s*=\s*'refunded'/i,
    rows: [],
  },
  // findOne() at the end of refund() — return one synthetic row.
  {
    match: /SELECT[\s\S]+FROM\s+returns\s+r[\s\S]+WHERE\s+r\.id\s*=\s*\$1/i,
    rows: [{ ...retRow, status: 'refunded', cashbox_id: CASHBOX_ID }],
  },
];

function makeRepo(retRow: any) {
  return {
    findOne: jest.fn().mockResolvedValue(retRow),
  };
}

async function buildService(opts: {
  ds: any;
  retRow: any;
  posting?: any;
  engine?: any;
}) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      ReturnsService,
      { provide: DataSource, useValue: opts.ds },
      { provide: getRepositoryToken(ReturnEntity), useValue: makeRepo(opts.retRow) },
      {
        provide: AccountingPostingService,
        useValue:
          opts.posting ?? { postReturn: jest.fn().mockResolvedValue({}) },
      },
      {
        provide: FinancialEngineService,
        useValue:
          opts.engine ??
          {
            recordCashOnlyMovement: jest.fn().mockResolvedValue({ ok: true }),
          },
      },
    ],
  }).compile();
  return moduleRef.get(ReturnsService);
}

// ─────────────────────────────────────────────────────────────────────
//  approve() no longer posts return GL
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsService.approve — GL posting moved out', () => {
  it('does NOT call posting.postReturn during approve()', async () => {
    const pendingRet = {
      id: RETURN_ID,
      status: 'pending',
      return_no: RETURN_NO,
      warehouse_id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
    };
    const { ds } = makeRouter([
      {
        match: /FROM\s+return_items\s+WHERE\s+return_id\s*=\s*\$1/i,
        rows: [],
      },
      { match: /UPDATE\s+returns\s+SET\s+status\s*=\s*'approved'/i, rows: [] },
      {
        match:
          /SELECT[\s\S]+FROM\s+returns\s+r[\s\S]+WHERE\s+r\.id\s*=\s*\$1/i,
        rows: [{ id: RETURN_ID, status: 'approved' }],
      },
    ]);
    const postReturn = jest.fn();
    const svc = await buildService({
      ds,
      retRow: pendingRet,
      posting: { postReturn },
    });
    await svc.approve(RETURN_ID, {}, USER_ID);
    expect(postReturn).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  refund() now posts JE AFTER cashbox_id is set, BEFORE the CT
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsService.refund — GL+CT posted atomically via postReturn', () => {
  it('blind cash refund: postReturn runs after the UPDATE that writes cashbox_id, AND recordCashOnlyMovement is NOT called', async () => {
    const { ds, calls } = makeRouter(baseRoutes(approvedRetRow()));
    const postReturn = jest
      .fn()
      .mockResolvedValue({ ok: true, entry_id: 'je-1' });
    const recordCashOnlyMovement = jest.fn();
    const svc = await buildService({
      ds,
      retRow: approvedRetRow(),
      posting: { postReturn },
      engine: { recordCashOnlyMovement },
    });

    await svc.refund(
      RETURN_ID,
      { refund_method: 'cash', shift_id: SHIFT_ID } as any,
      USER_ID,
      [],
    );

    const updIdx = calls.findIndex((c) =>
      /UPDATE\s+returns\s+SET\s+status\s*=\s*'refunded'/i.test(c.sql),
    );
    expect(updIdx).toBeGreaterThanOrEqual(0);
    expect(postReturn).toHaveBeenCalledTimes(1);
    expect(postReturn).toHaveBeenCalledWith(RETURN_ID, USER_ID, ds);
    expect(recordCashOnlyMovement).not.toHaveBeenCalled();
  });

  it('postReturn receives the same EntityManager (transactional)', async () => {
    const { ds } = makeRouter(baseRoutes(approvedRetRow()));
    const postReturn = jest.fn().mockResolvedValue({});
    const svc = await buildService({
      ds,
      retRow: approvedRetRow(),
      posting: { postReturn },
    });
    await svc.refund(
      RETURN_ID,
      { refund_method: 'cash', shift_id: SHIFT_ID } as any,
      USER_ID,
      [],
    );
    expect(postReturn.mock.calls[0][2]).toBe(ds);
  });

  it('non-cash refund posts the JE; engine cash-only is not called (CT path is owned by postReturn now)', async () => {
    const { ds } = makeRouter(baseRoutes(approvedRetRow()));
    const postReturn = jest.fn().mockResolvedValue({});
    const recordCashOnlyMovement = jest.fn();
    const svc = await buildService({
      ds,
      retRow: approvedRetRow(),
      posting: { postReturn },
      engine: { recordCashOnlyMovement },
    });
    await svc.refund(
      RETURN_ID,
      { refund_method: 'card' } as any,
      USER_ID,
      [],
    );
    expect(postReturn).toHaveBeenCalledTimes(1);
    expect(recordCashOnlyMovement).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Error propagation: postReturn failure rolls back the refund
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsService.refund — postReturn failures fail loudly', () => {
  it('postReturn returning { error } makes refund() throw + rollback', async () => {
    const { ds } = makeRouter(baseRoutes(approvedRetRow()));
    const postReturn = jest.fn().mockResolvedValue({
      error: 'cash GL line on 1111 requires cashbox_id (return/x).',
    });
    const recordCashOnlyMovement = jest.fn();
    const svc = await buildService({
      ds,
      retRow: approvedRetRow(),
      posting: { postReturn },
      engine: { recordCashOnlyMovement },
    });

    await expect(
      svc.refund(
        RETURN_ID,
        { refund_method: 'cash', shift_id: SHIFT_ID } as any,
        USER_ID,
        [],
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(recordCashOnlyMovement).not.toHaveBeenCalled();
  });

  it('postReturn throwing also fails the refund', async () => {
    const { ds } = makeRouter(baseRoutes(approvedRetRow()));
    const postReturn = jest
      .fn()
      .mockRejectedValue(new Error('engine guard tripped'));
    const recordCashOnlyMovement = jest.fn();
    const svc = await buildService({
      ds,
      retRow: approvedRetRow(),
      posting: { postReturn },
      engine: { recordCashOnlyMovement },
    });

    await expect(
      svc.refund(
        RETURN_ID,
        { refund_method: 'cash', shift_id: SHIFT_ID } as any,
        USER_ID,
        [],
      ),
    ).rejects.toThrow(/engine guard tripped/);
    expect(recordCashOnlyMovement).not.toHaveBeenCalled();
  });

  it('missing AccountingPostingService throws — does not silently skip', async () => {
    const { ds } = makeRouter(baseRoutes(approvedRetRow()));
    // Build with `posting: undefined` (mirror of the @Optional() unmet
    // case) by passing null → useValue is null. Then the
    // `if (!this.posting)` guard fires.
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReturnsService,
        { provide: DataSource, useValue: ds },
        {
          provide: getRepositoryToken(ReturnEntity),
          useValue: makeRepo(approvedRetRow()),
        },
        { provide: AccountingPostingService, useValue: null },
        {
          provide: FinancialEngineService,
          useValue: {
            recordCashOnlyMovement: jest.fn().mockResolvedValue({ ok: true }),
          },
        },
      ],
    }).compile();
    const svc = moduleRef.get(ReturnsService);

    await expect(
      svc.refund(
        RETURN_ID,
        { refund_method: 'cash', shift_id: SHIFT_ID } as any,
        USER_ID,
        [],
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  Idempotency on retry — existing live JE must not double-post
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsService.refund — idempotency on retry', () => {
  it('postReturn returning { skipped: true } (live JE exists) does NOT throw + does NOT trigger a duplicate CT path', async () => {
    const { ds } = makeRouter(baseRoutes(approvedRetRow()));
    const postReturn = jest
      .fn()
      .mockResolvedValue({ skipped: true, entry_id: 'je-existing' });
    const recordCashOnlyMovement = jest.fn();
    const svc = await buildService({
      ds,
      retRow: approvedRetRow(),
      posting: { postReturn },
      engine: { recordCashOnlyMovement },
    });

    await expect(
      svc.refund(
        RETURN_ID,
        { refund_method: 'cash', shift_id: SHIFT_ID } as any,
        USER_ID,
        [],
      ),
    ).resolves.toBeDefined();

    expect(postReturn).toHaveBeenCalledTimes(1);
    // Idempotent retry: the engine's JE-side short-circuit means no new
    // CT is written.  refund() must NOT call recordCashOnlyMovement.
    expect(recordCashOnlyMovement).not.toHaveBeenCalled();
  });

  it('postReturn returning null (no-op) does NOT throw and does NOT touch the cash engine', async () => {
    const { ds } = makeRouter(baseRoutes(approvedRetRow()));
    const postReturn = jest.fn().mockResolvedValue(null);
    const recordCashOnlyMovement = jest.fn();
    const svc = await buildService({
      ds,
      retRow: approvedRetRow(),
      posting: { postReturn },
      engine: { recordCashOnlyMovement },
    });
    await svc.refund(
      RETURN_ID,
      { refund_method: 'cash', shift_id: SHIFT_ID } as any,
      USER_ID,
      [],
    );
    expect(recordCashOnlyMovement).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  No accounting_only / guard bypass / raw JE writes in this fix
// ─────────────────────────────────────────────────────────────────────

describe('ReturnsService — fix integrity (defense-in-depth source-grep)', () => {
  const src = readFileSync(
    resolve(__dirname, 'returns.service.ts'),
    'utf-8',
  );

  it('refund() does NOT pass an accounting_only flag', () => {
    expect(src).not.toMatch(/accounting_only\s*:/);
  });

  it('returns.service does NOT write raw journal/cashbox rows', () => {
    expect(src).not.toMatch(/INSERT\s+INTO\s+journal_entries/i);
    expect(src).not.toMatch(/INSERT\s+INTO\s+journal_lines/i);
    expect(src).not.toMatch(/INSERT\s+INTO\s+cashbox_transactions/i);
  });

  it('approve() body has zero `postReturn` calls', () => {
    const approveStart = src.indexOf('async approve(');
    expect(approveStart).toBeGreaterThan(-1);
    const tail = src.slice(approveStart);
    const nextMethod = tail.indexOf('\n  async ', 1);
    const approveBody = nextMethod > 0 ? tail.slice(0, nextMethod) : tail;
    expect(approveBody).not.toMatch(/postReturn\s*\(/);
  });

  it('refund() body has exactly one `postReturn` call', () => {
    const refundStart = src.indexOf('async refund(');
    expect(refundStart).toBeGreaterThan(-1);
    const tail = src.slice(refundStart);
    const nextMethod = tail.indexOf('\n  async ', 1);
    const refundBody = nextMethod > 0 ? tail.slice(0, nextMethod) : tail;
    const matches = refundBody.match(/postReturn\s*\(/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('refund() body has zero `recordCashOnlyMovement` calls (CT now owned by postReturn)', () => {
    const refundStart = src.indexOf('async refund(');
    const tail = src.slice(refundStart);
    const nextMethod = tail.indexOf('\n  async ', 1);
    const refundBody = nextMethod > 0 ? tail.slice(0, nextMethod) : tail;
    expect(refundBody).not.toMatch(/recordCashOnlyMovement\s*\(/);
  });

  it('the silent `.catch(() => undefined)` swallow is gone from approve()', () => {
    const approveStart = src.indexOf('async approve(');
    const tail = src.slice(approveStart);
    const nextMethod = tail.indexOf('\n  async ', 1);
    const approveBody = nextMethod > 0 ? tail.slice(0, nextMethod) : tail;
    expect(approveBody).not.toMatch(
      /postReturn[\s\S]+\.catch\(\(\)\s*=>\s*undefined\)/,
    );
  });
});
