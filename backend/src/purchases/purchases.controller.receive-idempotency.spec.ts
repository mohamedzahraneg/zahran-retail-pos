/**
 * purchases.controller.receive-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS (Sprint 4 / PR-11B)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /purchases/:id/receive
 *
 * `receive` writes one stock_movements row per item + a JE for the
 * inventory side via the FinancialEngine. Engine-level
 * `(reference_type='purchase', reference_id)` guard is in place,
 * but a duplicate POST during a network retry could still race the
 * pre-INSERT SELECT. The Redis-backed interceptor's 60s lock is
 * the cleaner outer defence.
 *
 * Strategy:
 *   · Mount the real PurchasesController with a stubbed PurchasesService.
 *   · Mount the real IdempotencyInterceptor.
 *   · Mock IdempotencyCacheService to control acquire / replay /
 *     in_progress / unavailable branches.
 *
 * Scope of THIS PR (this controller's contribution):
 *   · `receive` (newly decorated) MUST have the interceptor.
 *   · All other PurchasesController handlers (list, getOne, create,
 *     pay, cancel, edit, returns CRUD) do NOT carry the interceptor —
 *     deferred to phased PRs (see PR-11 audit).
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { PurchasesController } from './purchases.controller';
import { PurchasesService } from './purchases.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PURCHASE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ROUTE_PATH = '/purchases/:id/receive';

function makeMockReq(overrides: Partial<any> = {}) {
  return {
    method: 'POST',
    url: `/purchases/${PURCHASE_ID}/receive`,
    originalUrl: `/purchases/${PURCHASE_ID}/receive`,
    route: { path: ROUTE_PATH },
    headers: {},
    body: {},
    params: { id: PURCHASE_ID },
    user: { userId: 'user-AAA', id: 'user-AAA' },
    ...overrides,
  };
}

function makeMockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 201;
  return {
    headers,
    get statusCode() { return statusCode; },
    set statusCode(v: number) { statusCode = v; },
    setHeader: jest.fn((name: string, val: string) => { headers[name] = val; }),
    status: jest.fn(function (this: any, code: number) {
      statusCode = code;
      return this;
    }),
  };
}

function makeExecutionContext(req: any, res: any): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
  } as any;
}

const makeNext = (value: unknown): CallHandler => ({ handle: jest.fn(() => of(value)) } as any);
const makeFailingNext = (err: Error): CallHandler => ({ handle: jest.fn(() => throwError(() => err)) } as any);

describe('IdempotencyInterceptor on POST /purchases/:id/receive — PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS', () => {
  let interceptor: IdempotencyInterceptor;
  let cache: jest.Mocked<IdempotencyCacheService>;

  // /purchases/:id/receive takes no body — the receive action is
  // route-anchored on the purchase id. Empty body still hashes
  // deterministically.
  const sampleBody = {};
  const sampleSuccess = {
    purchase_id: PURCHASE_ID,
    items_received: 12,
    movement_ids: ['mv-1', 'mv-2', 'mv-3'],
    je_id: 'je-AAA',
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

  it('no Idempotency-Key header → handler called, X-Idempotent-Replay=false', async () => {
    const req = makeMockReq();
    const res = makeMockRes();
    const next = makeNext(sampleSuccess);
    const result = await firstValueFrom(
      (await interceptor.intercept(makeExecutionContext(req, res), next)) as any,
    );
    expect(result).toEqual(sampleSuccess);
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'false');
  });

  it('first keyed request → handler called, cacheResult invoked with 24h TTL', async () => {
    const req = makeMockReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    const res = makeMockRes();
    const next = makeNext(sampleSuccess);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${VALID_KEY}`,
    } as AcquireResult);

    res.statusCode = 201;
    await firstValueFrom(
      (await interceptor.intercept(makeExecutionContext(req, res), next)) as any,
    );
    expect(cache.cacheResult).toHaveBeenCalledTimes(1);
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it('replay → cached body, handler NOT invoked, X-Idempotent-Replay=true (no duplicate stock_movements)', async () => {
    const req = makeMockReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'replay',
      cached: { status: 201, body: sampleSuccess, payload_hash: 'h', cached_at: 't' } as CachedResponse,
    } as AcquireResult);

    const result = await firstValueFrom(
      (await interceptor.intercept(makeExecutionContext(req, res), next)) as any,
    );
    expect(result).toEqual(sampleSuccess);
    expect(handler).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'true');
  });

  it('payload mismatch → 409, handler NOT invoked', async () => {
    // The receive endpoint accepts no body, but a hostile/buggy
    // client sending a body with a different shape would still
    // trip payload-mismatch protection.
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { unexpected: 'payload' },
    });
    const handler = jest.fn();
    const next = { handle: handler } as any;

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'payload_mismatch',
      cached: { status: 201, body: sampleSuccess, payload_hash: 'orig', cached_at: 't' } as CachedResponse,
    } as AcquireResult);

    try {
      await interceptor.intercept(makeExecutionContext(req, makeMockRes()), next);
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(409);
      expect(err.getResponse()).toMatchObject({ code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('concurrent same-key → 425 IDEMPOTENCY_KEY_IN_PROGRESS, handler NOT invoked', async () => {
    const req = makeMockReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    const handler = jest.fn();
    const next = { handle: handler } as any;

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'in_progress',
      cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${VALID_KEY}`,
    } as AcquireResult);

    try {
      await interceptor.intercept(makeExecutionContext(req, makeMockRes()), next);
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(425);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('Redis unavailable + key → 503 fail-closed', async () => {
    const req = makeMockReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    const handler = jest.fn();
    const next = { handle: handler } as any;

    cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'unavailable' } as AcquireResult);

    try {
      await interceptor.intercept(makeExecutionContext(req, makeMockRes()), next);
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(503);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('invalid Idempotency-Key format → 400, cache NOT consulted', async () => {
    const req = makeMockReq({ headers: { 'idempotency-key': 'bad key!' }, body: sampleBody });
    const handler = jest.fn();
    const next = { handle: handler } as any;

    try {
      await interceptor.intercept(makeExecutionContext(req, makeMockRes()), next);
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(400);
    }
    expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
  });

  it('handler throws → lock released, no cached result', async () => {
    const req = makeMockReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${VALID_KEY}`,
    } as AcquireResult);
    const next = makeFailingNext(new Error('synthetic receive failure'));
    await expect(
      firstValueFrom(
        (await interceptor.intercept(makeExecutionContext(req, makeMockRes()), next)) as any,
      ),
    ).rejects.toThrow(/synthetic receive failure/);
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe('PurchasesController route-level wiring — PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS', () => {
  it('receive has IdempotencyInterceptor; siblings do NOT', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PurchasesController],
      providers: [
        {
          provide: PurchasesService,
          useValue: {
            list: jest.fn(),
            getOne: jest.fn(),
            create: jest.fn(),
            receive: jest.fn(),
            pay: jest.fn(),
            cancel: jest.fn(),
            edit: jest.fn(),
            createReturn: jest.fn(),
            cancelReturn: jest.fn(),
            listReturns: jest.fn(),
            getReturn: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(PurchasesController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) => i === IdempotencyInterceptor || i?.name === 'IdempotencyInterceptor',
      );
    };

    expect(hasInterceptor((controller as any).receive)).toBe(true);

    // ── cancel + cancelReturn — undecorated when this spec shipped;
    //    PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY (PR-11E)
    //    decorated them. Their dedicated spec
    //    (purchases.controller.cancel-idempotency.spec.ts) owns the
    //    positive assertions. Updated here to regression guards.
    expect(hasInterceptor((controller as any).cancel)).toBe(true);
    expect(hasInterceptor((controller as any).cancelReturn)).toBe(true);

    // All other PurchasesController POST handlers MUST be undecorated
    // in this PR. The PR-11 audit defers them to phased follow-ups.
    const undecoratedSiblings: Array<keyof PurchasesController> = [
      'list',
      'getOne',
      'create',
      'pay',
      'edit',
      'createReturn',
      'listReturns',
      'getReturn',
    ];
    for (const name of undecoratedSiblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(false);
    }
  });
});
