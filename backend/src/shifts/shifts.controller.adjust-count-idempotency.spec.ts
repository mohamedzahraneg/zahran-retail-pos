/**
 * shifts.controller.adjust-count-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-DIRECT-CT-WRITES (Sprint 4 / PR-11A)
 *
 * Pins the (already-shipped, generic) IdempotencyInterceptor on the
 * shift counted-cash adjustment route:
 *
 *   · POST /shifts/:id/adjust-count
 *
 * Why adjust-count specifically — the audit identified this as the
 * second of two P0 direct-CT writers (the other is
 * POST /cash-desk/deposit). `adjustCount` is a hand-rolled writer
 * that mutates `cashbox_transactions` directly, OUTSIDE the
 * `FinancialEngine.recordTransaction` path, so the engine-level
 * (reference_type, reference_id) idempotency guard does NOT cover
 * it. Operator double-clicks on the variance-correction button
 * could produce 2 CT rows + 2× cashbox balance moves before this PR.
 *
 * Strategy:
 *   · Mount the real ShiftsController with a stubbed ShiftsService.
 *   · Mount the real IdempotencyInterceptor.
 *   · Mock the IdempotencyCacheService (NOT a real Redis) so each
 *     test can control acquire / replay / in_progress / unavailable
 *     branches deterministically.
 *   · Use Express request/response stubs to assert headers + status
 *     without booting Nest's HTTP layer.
 *
 * Scope of THIS PR (adjust-count specifically):
 *   · `adjustCount` (newly decorated) MUST have the interceptor.
 *   · All other shifts handlers (`open`, `close`, `requestClose`,
 *     `approveClose`, `rejectClose`, list/summary GETs, etc.) do NOT
 *     carry the interceptor.
 *
 * Bodies in tests use a realistic adjust-count shape: a 75 EGP
 * counted-cash correction with a manager's reason. Tampering with
 * `new_actual_closing` produces a different payload hash → 409
 * payload-mismatch.
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { ShiftsController } from './shifts.controller';
import { ShiftsService } from './shifts.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // 36 chars
const SHIFT_ID = '99999999-9999-9999-9999-999999999999';
// `req.route.path` carries the parameterized form (`:id`), not the
// substituted UUID — the cache key namespace is route-level, not
// per-shift, which is the intended behavior.
const ROUTE_PATH = '/shifts/:id/adjust-count';

function makeMockReq(overrides: Partial<any> = {}) {
  return {
    method: 'POST',
    url: `/shifts/${SHIFT_ID}/adjust-count`,
    originalUrl: `/shifts/${SHIFT_ID}/adjust-count`,
    route: { path: ROUTE_PATH },
    headers: {},
    body: {},
    params: { id: SHIFT_ID },
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

describe('IdempotencyInterceptor on POST /shifts/:id/adjust-count — PR-FIX-IDEMPOTENCY-DIRECT-CT-WRITES', () => {
  let interceptor: IdempotencyInterceptor;
  let cache: jest.Mocked<IdempotencyCacheService>;

  // Realistic adjust-count body: a 75 EGP correction to the counted
  // closing amount with a manager's stated reason.
  const sampleBody = {
    new_actual_closing: 35075,
    reason: 'تصحيح عد بعد إعادة الفحص — تم العثور على 75 جنيه إضافي في الدرج',
  };

  // Realistic service response: the new variance + the new CT row id.
  const sampleSuccess = {
    shift_id: SHIFT_ID,
    new_actual_closing: 35075,
    new_variance: 75,
    adjustment_id: 'adj-AAA',
    txn_id: 'ct-BBB',
    adjusted_at: '2026-05-06T12:00:00.000Z',
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

  it('payload mismatch (same key + tampered new_actual_closing) → 409 conflict, handler NOT invoked', async () => {
    // Tampered closing amount → different body hash, same key.
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { ...sampleBody, new_actual_closing: 99999 },
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

  it('handler throws after lock acquired → lock released, error re-thrown, no cached result (failed adjustment does not poison the key)', async () => {
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
      new Error('synthetic adjust-count failure (e.g. shift not closed)'),
    );

    await expect(
      firstValueFrom((await interceptor.intercept(ctx, next)) as any),
    ).rejects.toThrow(/synthetic adjust-count failure/);

    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Cache-namespace isolation: keys for /shifts/:id/adjust-count must
 * not collide with the 6 previously protected routes (or with the
 * sibling /cash-desk/deposit route added in the same PR).
 */
describe('namespace isolation: /shifts/:id/adjust-count vs all previously protected routes', () => {
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
      '/shifts/:id/adjust-count',
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
 *   · `adjustCount` (newly decorated) MUST have the interceptor.
 *   · All other shifts handlers MUST NOT carry the interceptor —
 *     they're either pure GETs or POSTs with engine-level
 *     idempotency on (reference_type='shift_close', reference_id)
 *     etc. Phased PRs will add the interceptor selectively to the
 *     ones that benefit from request-replay caching (close,
 *     approveClose) — but those are out of scope for THIS PR.
 */
describe('ShiftsController route-level wiring — PR-FIX-IDEMPOTENCY-DIRECT-CT-WRITES (adjust-count)', () => {
  it('adjustCount has IdempotencyInterceptor; siblings do NOT', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ShiftsController],
      providers: [
        {
          provide: ShiftsService,
          useValue: {
            // This PR's target.
            adjustCount: jest.fn(),
            // Siblings — none should have the interceptor in this PR.
            open: jest.fn(),
            close: jest.fn(),
            requestClose: jest.fn(),
            pendingCloses: jest.fn(),
            approveClose: jest.fn(),
            rejectClose: jest.fn(),
            list: jest.fn(),
            getCurrent: jest.fn(),
            findOne: jest.fn(),
            getSummary: jest.fn(),
            aggregateDetail: jest.fn(),
            listLiveSummary: jest.fn(),
            listAdjustments: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(ShiftsController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) =>
          i === IdempotencyInterceptor ||
          i?.name === 'IdempotencyInterceptor',
      );
    };

    // ── This PR's target.
    expect(hasInterceptor((controller as any).adjustCount)).toBe(true);

    // ── All other shifts handlers MUST be undecorated in this PR.
    const undecoratedSiblings: Array<keyof ShiftsController> = [
      'open',
      'close',
      'requestClose',
      'approveClose',
      'rejectClose',
      'pendingCloses',
      'list',
      'current',
      'findOne',
      'summary',
      'aggregateDetail',
      'listLiveSummary',
      'listAdjustments',
    ];
    for (const name of undecoratedSiblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(false);
    }
  });
});
