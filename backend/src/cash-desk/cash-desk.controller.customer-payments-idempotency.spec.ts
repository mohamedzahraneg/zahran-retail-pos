/**
 * cash-desk.controller.customer-payments-idempotency.spec.ts
 * — PR-AUDIT-IDEMPOTENCY-CASH-DESK-CUSTOMER-PAYMENTS
 *
 * Pins the (already-shipped, generic) IdempotencyInterceptor on the
 * customer-receipt route:
 *
 *   · POST /cash-desk/customer-payments
 *
 * Strategy:
 *   · Mount the real CashDeskController with a stubbed CashDeskService.
 *   · Mount the real IdempotencyInterceptor.
 *   · Mock the IdempotencyCacheService (NOT a real Redis) so each
 *     test can control acquire/replay/in_progress/unavailable
 *     branches deterministically.
 *   · Use Express request/response stubs to assert headers + status
 *     without booting Nest's HTTP layer.
 *
 * Scope of THIS PR: ONLY `receive()` is newly decorated. The wiring
 * test at the bottom asserts:
 *   · `receive` (this PR) carries the interceptor.
 *   · `transfer` STILL carries the interceptor from PR #277.
 *   · `pay` (supplier-payments) does NOT carry the interceptor —
 *     deliberately deferred to a future phased PR.
 *   · All other cash-desk handlers (voids, reconciliation, cashbox
 *     CRUD) do NOT carry the interceptor. (`deposit` was undecorated
 *     when this spec shipped; PR-FIX-IDEMPOTENCY-DIRECT-CT-WRITES
 *     decorated it — this spec's regression assertion was updated
 *     accordingly.)
 *
 * Bodies in tests use a realistic customer-payments shape including
 * the optional `allocations: [{invoice_id, amount}, ...]` array.
 * The interceptor's canonicalizer (sorted-key recursion) hashes the
 * shape correctly; array element ORDER is preserved (not normalized),
 * which is the FE PR's responsibility to handle.
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { CashDeskController } from './cash-desk.controller';
import { CashDeskService } from './cash-desk.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // 36 chars, fits 8-128 alnum/-/_
const ROUTE_PATH = '/cash-desk/customer-payments';

function makeMockReq(overrides: Partial<any> = {}) {
  return {
    method: 'POST',
    url: ROUTE_PATH,
    originalUrl: ROUTE_PATH,
    route: { path: ROUTE_PATH },
    headers: {},
    body: {},
    ...overrides,
  };
}

function makeMockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 201;
  return {
    headers,
    get statusCode() {
      return statusCode;
    },
    set statusCode(v: number) {
      statusCode = v;
    },
    setHeader: jest.fn((name: string, val: string) => {
      headers[name] = val;
    }),
    status: jest.fn(function (this: any, code: number) {
      statusCode = code;
      return this;
    }),
  };
}

function makeExecutionContext(req: any, res: any): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as any;
}

function makeNext(value: unknown): CallHandler {
  return { handle: jest.fn(() => of(value)) } as any;
}

function makeFailingNext(err: Error): CallHandler {
  return {
    handle: jest.fn(() => throwError(() => err)),
  } as any;
}

describe('IdempotencyInterceptor on POST /cash-desk/customer-payments — PR-AUDIT-IDEMPOTENCY-CASH-DESK-CUSTOMER-PAYMENTS', () => {
  let interceptor: IdempotencyInterceptor;
  let cache: jest.Mocked<IdempotencyCacheService>;

  // Realistic customer-payments body: cash receipt of 500 EGP from a
  // customer settling two invoices.
  const sampleBody = {
    customer_id: '11111111-1111-1111-1111-111111111111',
    cashbox_id: '22222222-2222-2222-2222-222222222222',
    payment_method: 'cash',
    amount: 500,
    kind: 'settle_invoices',
    allocations: [
      {
        invoice_id: 'aaaaaaaa-1111-1111-1111-111111111111',
        amount: 300,
      },
      {
        invoice_id: 'bbbbbbbb-2222-2222-2222-222222222222',
        amount: 200,
      },
    ],
    notes: 'تحصيل نقدي',
  };

  const sampleSuccess = {
    id: 'pay-AAA',
    payment_no: 'CP-2026-000123',
    customer_id: sampleBody.customer_id,
    amount: 500,
  };

  beforeEach(() => {
    cache = {
      tryAcquireOrReplay: jest.fn(),
      cacheResult: jest.fn(),
      releaseLock: jest.fn(),
      isAvailable: jest.fn(),
      buildCacheKey: jest.fn(),
      onModuleInit: jest.fn(),
      onModuleDestroy: jest.fn(),
      setClientForTesting: jest.fn(),
    } as any;
    interceptor = new IdempotencyInterceptor(cache);
  });

  it('no Idempotency-Key header → handler called, X-Idempotent-Replay=false, cache untouched', async () => {
    const req = makeMockReq();
    const res = makeMockRes();
    const next = makeNext(sampleSuccess);
    const ctx = makeExecutionContext(req, res);
    const result = await firstValueFrom(
      (await interceptor.intercept(ctx, next)) as any,
    );
    expect(result).toEqual(sampleSuccess);
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'false');
  });

  it('first keyed request → handler called, X-Idempotent-Replay=false, cacheResult invoked with 24h TTL', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: sampleBody,
    });
    const res = makeMockRes();
    const next = makeNext(sampleSuccess);
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${VALID_KEY}`,
    } as AcquireResult);

    res.statusCode = 201;
    const result = await firstValueFrom(
      (await interceptor.intercept(ctx, next)) as any,
    );

    expect(result).toEqual(sampleSuccess);
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(cache.cacheResult).toHaveBeenCalledTimes(1);
    expect(cache.cacheResult).toHaveBeenCalledWith(
      expect.stringContaining(VALID_KEY),
      expect.any(String), // payload hash
      201,
      sampleSuccess,
    );
    expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'false');
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it('replay (same key + same payload) → returns cached body, X-Idempotent-Replay=true, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: sampleBody,
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    const cached: CachedResponse = {
      status: 201,
      body: sampleSuccess,
      payload_hash: 'will-be-overridden-by-mock',
      cached_at: '2026-05-04T12:00:00.000Z',
    };
    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'replay',
      cached,
    } as AcquireResult);

    const result = await firstValueFrom(
      (await interceptor.intercept(ctx, next)) as any,
    );
    expect(result).toEqual(sampleSuccess);
    expect(handler).not.toHaveBeenCalled();
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'true');
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('payload mismatch (same key + different payload) → 409 conflict, handler NOT invoked', async () => {
    // Tampered amount → different body hash, same key.
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { ...sampleBody, amount: 999 },
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    const cached: CachedResponse = {
      status: 201,
      body: sampleSuccess,
      payload_hash: 'different-hash',
      cached_at: '2026-05-04T12:00:00.000Z',
    };
    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'payload_mismatch',
      cached,
    } as AcquireResult);

    let caught: any;
    try {
      await interceptor.intercept(ctx, next);
      throw new Error('expected HttpException');
    } catch (err: any) {
      caught = err;
    }
    expect(caught.getStatus()).toBe(409);
    expect(caught.getResponse()).toMatchObject({
      code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
    });
    expect(handler).not.toHaveBeenCalled();
    expect(cache.cacheResult).not.toHaveBeenCalled();
  });

  it('different key with same payload → handler invoked again (no cross-key dedupe)', async () => {
    const otherKey = 'ffffffff-1111-2222-3333-444444444444';
    const req = makeMockReq({
      headers: { 'idempotency-key': otherKey },
      body: sampleBody,
    });
    const res = makeMockRes();
    const next = makeNext(sampleSuccess);
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${otherKey}`,
    } as AcquireResult);

    res.statusCode = 201;
    const result = await firstValueFrom(
      (await interceptor.intercept(ctx, next)) as any,
    );
    expect(result).toEqual(sampleSuccess);
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(cache.tryAcquireOrReplay).toHaveBeenCalledTimes(1);
  });

  it('concurrent same-key (lock held by another request) → 425 Too Early, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: sampleBody,
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'in_progress',
      cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${VALID_KEY}`,
    } as AcquireResult);

    try {
      await interceptor.intercept(ctx, next);
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(425);
      expect(err.getResponse()).toMatchObject({
        code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
      });
    }
    expect(handler).not.toHaveBeenCalled();
    expect(cache.cacheResult).not.toHaveBeenCalled();
  });

  it('Redis unavailable for keyed request → 503 fail-closed, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: sampleBody,
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'unavailable',
    } as AcquireResult);

    try {
      await interceptor.intercept(ctx, next);
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(503);
      expect(err.getResponse()).toMatchObject({
        code: 'IDEMPOTENCY_CACHE_UNAVAILABLE',
      });
    }
    expect(handler).not.toHaveBeenCalled();
    expect(cache.cacheResult).not.toHaveBeenCalled();
  });

  it('invalid Idempotency-Key format → 400, handler NOT invoked, cache NOT consulted', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': 'has spaces & symbols!' },
      body: sampleBody,
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    try {
      await interceptor.intercept(ctx, next);
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(400);
      expect(err.getResponse()).toMatchObject({
        code: 'IDEMPOTENCY_KEY_INVALID',
      });
    }
    expect(handler).not.toHaveBeenCalled();
    expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
  });

  it('handler throws after lock acquired → lock released, error re-thrown, no cached result', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: sampleBody,
    });
    const res = makeMockRes();
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${VALID_KEY}`,
    } as AcquireResult);

    const next = makeFailingNext(
      new Error('synthetic customer-payment failure'),
    );

    await expect(
      firstValueFrom((await interceptor.intercept(ctx, next)) as any),
    ).rejects.toThrow(/synthetic customer-payment failure/);

    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Cache-namespace isolation: per the user's explicit requirement,
 * the new route must not collide with previously protected routes.
 * The interceptor forwards `req.route.path`, so paths are
 * structurally distinct in the cache. Pin that for ALL FIVE
 * already-protected routes plus the future supplier-payments path.
 */
describe('namespace isolation: /cash-desk/customer-payments vs all previously protected routes', () => {
  it('keyed calls invoke tryAcquireOrReplay with route-distinct paths', async () => {
    const cache = {
      tryAcquireOrReplay: jest.fn().mockResolvedValue({
        kind: 'acquired',
        cacheKey: 'will-be-set-per-call',
      } as AcquireResult),
      cacheResult: jest.fn(),
      releaseLock: jest.fn(),
      isAvailable: jest.fn(),
      buildCacheKey: jest.fn(),
      onModuleInit: jest.fn(),
      onModuleDestroy: jest.fn(),
      setClientForTesting: jest.fn(),
    } as any as jest.Mocked<IdempotencyCacheService>;
    const interceptor = new IdempotencyInterceptor(cache);

    const distinctPaths = [
      '/cash-desk/customer-payments',
      '/cash-desk/transfer',
      '/pos/invoices',
      '/accounting/expenses',
      '/accounting/expenses/daily',
      '/cash-desk/supplier-payments', // future path; namespace must already be distinct
    ];

    for (const path of distinctPaths) {
      const req = {
        method: 'POST',
        url: path,
        originalUrl: path,
        route: { path },
        headers: { 'idempotency-key': VALID_KEY },
        body: { sample: true },
      };
      const next = makeNext({ ok: true });
      await firstValueFrom(
        (await interceptor.intercept(
          makeExecutionContext(req, makeMockRes()),
          next,
        )) as any,
      );
    }

    expect(cache.tryAcquireOrReplay).toHaveBeenCalledTimes(distinctPaths.length);
    // Each invocation's path arg (2nd arg) MUST be the path we sent.
    // Since all 6 paths are distinct strings, the cache keys derived
    // from `idempotency:v1:POST:<path>:<key>` are pairwise distinct
    // even when the key + payload are identical across the calls.
    const invokedPaths = cache.tryAcquireOrReplay.mock.calls.map((c) => c[1]);
    expect(invokedPaths).toEqual(distinctPaths);
    expect(new Set(invokedPaths).size).toBe(distinctPaths.length);
  });
});

/**
 * Route-level wiring assertions.
 *
 * In this PR:
 *   · `receive` (newly decorated) MUST have the interceptor.
 *   · `transfer` (decorated by PR #277) MUST STILL have the
 *     interceptor — guards against accidental regressions.
 *   · `pay` (supplier-payments) MUST NOT carry the interceptor —
 *     out of scope for this PR; will get its own phased PR.
 *   · All other cash-desk handlers (voids, reconciliation, cashbox
 *     CRUD) MUST NOT carry the interceptor. `deposit` was on this
 *     undecorated list when the spec shipped — PR-FIX-IDEMPOTENCY-
 *     DIRECT-CT-WRITES (Sprint 4 / PR-11A) decorated it; the
 *     assertion below now pins that as a regression guard.
 */
describe('CashDeskController route-level wiring — PR-AUDIT-IDEMPOTENCY-CASH-DESK-CUSTOMER-PAYMENTS', () => {
  it('receive has IdempotencyInterceptor; transfer retains it; pay + siblings do NOT', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CashDeskController],
      providers: [
        {
          provide: CashDeskService,
          useValue: {
            // Customer payments (this PR's target)
            receiveFromCustomer: jest.fn(),
            listCustomerPayments: jest.fn(),
            voidCustomerPayment: jest.fn(),
            // Cash transfer (already decorated by PR #277)
            transferBetweenCashboxes: jest.fn(),
            // Supplier payments (deferred to a future PR)
            payToSupplier: jest.fn(),
            listSupplierPayments: jest.fn(),
            voidSupplierPayment: jest.fn(),
            // Cashbox CRUD
            listCashboxes: jest.fn(),
            listInstitutions: jest.fn(),
            createCashbox: jest.fn(),
            updateCashbox: jest.fn(),
            removeCashbox: jest.fn(),
            // Reconciliation workflow
            listReconciliation: jest.fn(),
            markReconciled: jest.fn(),
            unmarkReconciled: jest.fn(),
            autoMatchReconciliation: jest.fn(),
            // Reports / drift / movements
            cashflowToday: jest.fn(),
            getGlDrift: jest.fn(),
            getShiftVariances: jest.fn(),
            listMovements: jest.fn(),
            listCashboxMovementsUnified: jest.fn(),
            getCashboxDriftDetail: jest.fn(),
            // Manual deposit
            deposit: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(CashDeskController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) =>
          i === IdempotencyInterceptor ||
          i?.name === 'IdempotencyInterceptor',
      );
    };

    // ── This PR's target: receive (customer-payments).
    expect(hasInterceptor(controller.receive)).toBe(true);

    // ── Transfer retained from PR #277 — guards against regression.
    expect(hasInterceptor(controller.transfer)).toBe(true);

    // ── Supplier-payments handler — was undecorated when PR #281
    //    shipped; PR-AUDIT-IDEMPOTENCY-CASH-DESK-SUPPLIER-PAYMENTS
    //    now decorates it. The new spec
    //    (cash-desk.controller.supplier-payments-idempotency.spec.ts)
    //    owns the positive assertion. Updated here to a regression
    //    guard so PR #281's contract STILL pins that pay carries
    //    the interceptor.
    expect(hasInterceptor((controller as any).pay)).toBe(true);

    // ── Deposit — was undecorated when this spec shipped;
    //    PR-FIX-IDEMPOTENCY-DIRECT-CT-WRITES (Sprint 4 / PR-11A)
    //    decorated it. The new spec
    //    (cash-desk.controller.deposit-idempotency.spec.ts) owns
    //    the positive assertion. Updated here to a regression guard.
    expect(hasInterceptor((controller as any).deposit)).toBe(true);

    // ── All other cash-desk POST handlers MUST be undecorated.
    const undecoratedSiblings: Array<keyof CashDeskController> = [
      'cashboxes',
      'institutions',
      'createCashbox',
      'updateCashbox',
      'removeCashbox',
      'voidCustomer',
      'voidSupplier',
      'listReconciliation',
      'markReconciled',
      'unmarkReconciled',
      'autoMatch',
    ];
    for (const name of undecoratedSiblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(false);
    }
  });
});
