/**
 * cash-desk.controller.deposit-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-DIRECT-CT-WRITES (Sprint 4 / PR-11A)
 *
 * Pins the (already-shipped, generic) IdempotencyInterceptor on the
 * manual deposit / withdrawal route:
 *
 *   · POST /cash-desk/deposit
 *
 * Why deposit specifically — the audit identified this as one of two
 * P0 direct-CT writers. Unlike `transfer` / `receive` / `pay`,
 * `deposit()` writes a `cashbox_transactions` row WITHOUT going
 * through `FinancialEngine.recordTransaction`, so the engine-level
 * (reference_type, reference_id) idempotency guard does NOT cover it.
 * Operator double-clicks could produce 2 CT rows + 2× cashbox
 * balance moves before this PR.
 *
 * Strategy:
 *   · Mount the real CashDeskController with a stubbed CashDeskService.
 *   · Mount the real IdempotencyInterceptor.
 *   · Mock the IdempotencyCacheService (NOT a real Redis) so each
 *     test can control acquire / replay / in_progress / unavailable
 *     branches deterministically.
 *   · Use Express request/response stubs to assert headers + status
 *     without booting Nest's HTTP layer.
 *
 * Scope of THIS PR (deposit specifically):
 *   · `deposit` (newly decorated) MUST have the interceptor.
 *   · `transfer` (PR #277), `receive` (PR #281), `pay` (PR #283)
 *     STILL carry the interceptor — guards against regression.
 *   · All other cash-desk handlers (voids, reconciliation, cashbox
 *     CRUD) do NOT carry the interceptor.
 *
 * Bodies in tests use a realistic deposit shape: a 1000 EGP top-up
 * to the main cash drawer with the optional `category` + `notes`
 * fields populated. The interceptor's canonicalizer hashes the shape
 * correctly; tampering with `amount` or `direction` produces a
 * different payload hash → 409 payload-mismatch.
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

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // 36 chars
const ROUTE_PATH = '/cash-desk/deposit';

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
  return { handle: jest.fn(() => throwError(() => err)) } as any;
}

describe('IdempotencyInterceptor on POST /cash-desk/deposit — PR-FIX-IDEMPOTENCY-DIRECT-CT-WRITES', () => {
  let interceptor: IdempotencyInterceptor;
  let cache: jest.Mocked<IdempotencyCacheService>;

  // Realistic deposit body: 1000 EGP top-up to the main cash drawer.
  const sampleBody = {
    cashbox_id: '22222222-2222-2222-2222-222222222222',
    direction: 'in' as const,
    amount: 1000,
    category: 'opening_balance',
    notes: 'إيداع افتتاحي للخزينة الرئيسية',
  };

  // Realistic service response: the engine writes a single CT row
  // and returns it with the new cashbox balance.
  const sampleSuccess = {
    txn_id: 'ct-AAA',
    cashbox_id: sampleBody.cashbox_id,
    direction: 'in',
    amount: 1000,
    new_balance: 35640,
    created_at: '2026-05-06T12:00:00.000Z',
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

  it('no Idempotency-Key header → handler called, X-Idempotent-Replay=false, cache untouched (today\'s behavior preserved)', async () => {
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

  it('first keyed request → handler called, cacheResult invoked with 24h TTL, X-Idempotent-Replay=false', async () => {
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

  it('replay (same key + same payload) → returns cached body, handler NOT invoked, X-Idempotent-Replay=true (no duplicate CT)', async () => {
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
      cached_at: '2026-05-06T12:00:00.000Z',
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

  it('payload mismatch (same key + tampered amount) → 409 conflict, handler NOT invoked', async () => {
    // Tampered amount → different body hash, same key.
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { ...sampleBody, amount: 9999 },
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    const cached: CachedResponse = {
      status: 201,
      body: sampleSuccess,
      payload_hash: 'different-hash',
      cached_at: '2026-05-06T12:00:00.000Z',
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

  it('payload mismatch (same key + flipped direction in→out) → 409 conflict, handler NOT invoked', async () => {
    // Flipping `direction` from 'in' to 'out' is a semantic-critical
    // change for a deposit/withdrawal — must produce a DIFFERENT
    // payload hash so the interceptor refuses the replay rather than
    // returning the original "in" cached response for an "out" call.
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { ...sampleBody, direction: 'out' as const },
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'payload_mismatch',
      cached: {
        status: 201,
        body: sampleSuccess,
        payload_hash: 'original-in-direction-hash',
        cached_at: '2026-05-06T12:00:00.000Z',
      },
    } as AcquireResult);

    try {
      await interceptor.intercept(ctx, next);
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({
        code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
      });
    }
    expect(handler).not.toHaveBeenCalled();
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

  it('concurrent same-key (lock held by another request) → 425 Too Early, handler NOT invoked (no double-click duplicate CT)', async () => {
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

  it('handler throws after lock acquired → lock released, error re-thrown, no cached result (deposit failure does not poison the key)', async () => {
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
      new Error('synthetic deposit failure (e.g. cashbox not found)'),
    );

    await expect(
      firstValueFrom((await interceptor.intercept(ctx, next)) as any),
    ).rejects.toThrow(/synthetic deposit failure/);

    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Cache-namespace isolation: confirm that POST /cash-desk/deposit's
 * keyed cache namespace doesn't collide with the 5 previously
 * protected cash-desk-or-related routes. Same Idempotency-Key sent
 * to /cash-desk/deposit AND /cash-desk/transfer (or any other
 * protected sibling) must invoke `tryAcquireOrReplay` with distinct
 * paths so the cache keys are pairwise distinct.
 */
describe('namespace isolation: /cash-desk/deposit vs all previously protected routes', () => {
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
      '/cash-desk/deposit',
      '/cash-desk/customer-payments',
      '/cash-desk/transfer',
      '/cash-desk/supplier-payments',
      '/pos/invoices',
      '/accounting/expenses',
      '/accounting/expenses/daily',
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
    const invokedPaths = cache.tryAcquireOrReplay.mock.calls.map((c) => c[1]);
    expect(invokedPaths).toEqual(distinctPaths);
    expect(new Set(invokedPaths).size).toBe(distinctPaths.length);
  });
});

/**
 * Route-level wiring assertions for THIS PR.
 *
 *   · `deposit` (newly decorated) MUST have the interceptor.
 *   · `transfer` (PR #277), `receive` (PR #281), `pay` (PR #283)
 *     MUST STILL carry the interceptor — guards against regression
 *     of the cash-desk pilot routes.
 *   · All other cash-desk handlers (voids, reconciliation, cashbox
 *     CRUD) MUST NOT carry the interceptor.
 */
describe('CashDeskController route-level wiring — PR-FIX-IDEMPOTENCY-DIRECT-CT-WRITES (deposit)', () => {
  it('deposit has IdempotencyInterceptor; transfer/receive/pay retain it; siblings do NOT', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CashDeskController],
      providers: [
        {
          provide: CashDeskService,
          useValue: {
            // This PR's target.
            deposit: jest.fn(),
            // Cash transfer (decorated by PR #277).
            transferBetweenCashboxes: jest.fn(),
            // Customer payments (decorated by PR #281).
            receiveFromCustomer: jest.fn(),
            listCustomerPayments: jest.fn(),
            voidCustomerPayment: jest.fn(),
            // Supplier payments (decorated by PR #283).
            payToSupplier: jest.fn(),
            listSupplierPayments: jest.fn(),
            voidSupplierPayment: jest.fn(),
            // Cashbox CRUD.
            listCashboxes: jest.fn(),
            listInstitutions: jest.fn(),
            createCashbox: jest.fn(),
            updateCashbox: jest.fn(),
            removeCashbox: jest.fn(),
            // Reconciliation.
            listReconciliation: jest.fn(),
            markReconciled: jest.fn(),
            unmarkReconciled: jest.fn(),
            autoMatchReconciliation: jest.fn(),
            // Reports / drift / movements.
            cashflowToday: jest.fn(),
            getGlDrift: jest.fn(),
            getShiftVariances: jest.fn(),
            listMovements: jest.fn(),
            listCashboxMovementsUnified: jest.fn(),
            getCashboxDriftDetail: jest.fn(),
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

    // ── This PR's target: deposit.
    expect(hasInterceptor((controller as any).deposit)).toBe(true);

    // ── Pilot routes from earlier PRs MUST still carry the interceptor.
    expect(hasInterceptor(controller.transfer)).toBe(true);
    expect(hasInterceptor(controller.receive)).toBe(true);
    expect(hasInterceptor((controller as any).pay)).toBe(true);

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
