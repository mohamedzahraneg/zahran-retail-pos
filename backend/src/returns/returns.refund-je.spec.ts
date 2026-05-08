/**
 * returns.refund-je.spec.ts — PR-FIX-RETURN-JE-AT-REFUND
 *
 * Pins the fix that moves return GL posting from `approve()` to
 * `refund()`. Background: PR #260's cashbox/GL alignment guard
 * (2026-05-03) made the engine reject any cash-leg with `cashbox_id`
 * NULL on liquid GL codes. `r.cashbox_id` is only set during
 * `refund()`, so blind returns approved post-guard silently lost their
 * JE through a `.catch(() => undefined)` in `approve()` (observed:
 * RET-2026-000005 — CT existed, JE missing).
 *
 * What this spec pins:
 *   1. `approve()` no longer calls `posting.postReturn`.
 *   2. `refund()` calls `posting.postReturn` AFTER the UPDATE that
 *      writes `cashbox_id`, BEFORE the cashbox_transactions write.
 *   3. Blind cash refund → JE post sees the new cashbox_id.
 *   4. `postReturn` returning `{ error }` causes the refund
 *      transaction to throw + roll back (no CT created).
 *   5. `postReturn` returning `{ skipped: true }` (existing live JE
 *      → idempotent retry) does NOT throw; the refund continues
 *      normally.
 *   6. The fix uses the standard `postReturn` API — no
 *      `accounting_only` flag is passed and the cashbox_id requirement
 *      is not bypassed.
 *   7. Source-grep: `approve()` body has no `postReturn` call;
 *      `refund()` body has exactly one `postReturn` call.
 *
 * No DB. The DataSource and the AccountingPostingService /
 * FinancialEngineService dependencies are stubs.
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

describe('ReturnsService.refund — GL posted in refund txn', () => {
  it('blind cash refund: postReturn runs after the UPDATE that writes cashbox_id, before the cashbox CT', async () => {
    const { ds, calls } = makeRouter(baseRoutes(approvedRetRow()));
    const postReturn = jest.fn().mockResolvedValue({ ok: true, entry_id: 'je-1' });
    const recordCashOnlyMovement = jest
      .fn()
      .mockResolvedValue({ ok: true, transaction_id: 1 });
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

    // The UPDATE happens before postReturn, which happens before the CT.
    const updIdx = calls.findIndex((c) =>
      /UPDATE\s+returns\s+SET\s+status\s*=\s*'refunded'/i.test(c.sql),
    );
    expect(updIdx).toBeGreaterThanOrEqual(0);
    const postCall = postReturn.mock.invocationCallOrder[0];
    const ctCall = recordCashOnlyMovement.mock.invocationCallOrder[0];
    expect(postCall).toBeLessThan(ctCall); // JE before CT

    expect(postReturn).toHaveBeenCalledTimes(1);
    expect(postReturn).toHaveBeenCalledWith(RETURN_ID, USER_ID, ds);
    expect(recordCashOnlyMovement).toHaveBeenCalledTimes(1);
    expect(recordCashOnlyMovement.mock.calls[0][0]).toMatchObject({
      cashbox_id: CASHBOX_ID,
      direction: 'out',
      reference_type: 'return',
      reference_id: RETURN_ID,
    });
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

  it('non-cash refund still posts the JE (no CT side; engine cash-only is not called)', async () => {
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
  it('postReturn returning { error } makes refund() throw before the CT runs', async () => {
    const { ds } = makeRouter(baseRoutes(approvedRetRow()));
    const postReturn = jest.fn().mockResolvedValue({
      error: 'cash GL line on 1111 requires cashbox_id (return/x).',
    });
    const recordCashOnlyMovement = jest.fn().mockResolvedValue({ ok: true });
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

    // No CT must have been written.
    expect(recordCashOnlyMovement).not.toHaveBeenCalled();
  });

  it('postReturn throwing also fails the refund (no CT)', async () => {
    const { ds } = makeRouter(baseRoutes(approvedRetRow()));
    const postReturn = jest
      .fn()
      .mockRejectedValue(new Error('engine guard tripped'));
    const recordCashOnlyMovement = jest.fn().mockResolvedValue({ ok: true });
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
  it('postReturn returning { skipped: true } (live JE exists) does NOT throw and the refund continues', async () => {
    const { ds } = makeRouter(baseRoutes(approvedRetRow()));
    const postReturn = jest
      .fn()
      .mockResolvedValue({ skipped: true, entry_id: 'je-existing' });
    const recordCashOnlyMovement = jest.fn().mockResolvedValue({ ok: true });
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
    expect(recordCashOnlyMovement).toHaveBeenCalledTimes(1);
  });

  it('postReturn returning null (no-op) does NOT throw', async () => {
    const { ds } = makeRouter(baseRoutes(approvedRetRow()));
    const postReturn = jest.fn().mockResolvedValue(null);
    const recordCashOnlyMovement = jest.fn().mockResolvedValue({ ok: true });
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
    expect(recordCashOnlyMovement).toHaveBeenCalledTimes(1);
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

  it('refund() does NOT bypass the cashbox_id requirement', () => {
    // The fix moves posting INTO refund — the only intended flow is
    // the canonical postReturn call, no direct JE inserts.
    expect(src).not.toMatch(/INSERT\s+INTO\s+journal_entries/i);
    expect(src).not.toMatch(/INSERT\s+INTO\s+journal_lines/i);
  });

  it('approve() body has zero `postReturn` calls', () => {
    const approveStart = src.indexOf('async approve(');
    expect(approveStart).toBeGreaterThan(-1);
    // Slice up to the next top-level `async ` declaration.
    const tail = src.slice(approveStart);
    const nextMethod = tail.indexOf('\n  async ', 1);
    const approveBody =
      nextMethod > 0 ? tail.slice(0, nextMethod) : tail;
    expect(approveBody).not.toMatch(/postReturn\s*\(/);
  });

  it('refund() body has exactly one `postReturn` call', () => {
    const refundStart = src.indexOf('async refund(');
    expect(refundStart).toBeGreaterThan(-1);
    const tail = src.slice(refundStart);
    const nextMethod = tail.indexOf('\n  async ', 1);
    const refundBody =
      nextMethod > 0 ? tail.slice(0, nextMethod) : tail;
    const matches = refundBody.match(/postReturn\s*\(/g) ?? [];
    expect(matches).toHaveLength(1);
  });

  it('the silent `.catch(() => undefined)` swallow is gone from approve()', () => {
    const approveStart = src.indexOf('async approve(');
    const tail = src.slice(approveStart);
    const nextMethod = tail.indexOf('\n  async ', 1);
    const approveBody =
      nextMethod > 0 ? tail.slice(0, nextMethod) : tail;
    expect(approveBody).not.toMatch(/postReturn[\s\S]+\.catch\(\(\)\s*=>\s*undefined\)/);
  });
});
