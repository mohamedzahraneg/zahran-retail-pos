/**
 * stock.controller.adjust-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS (Sprint 4 / PR-11B)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /stock/adjust
 *
 * `adjust` writes a `stock_movements` row (via `fn_adjust_stock`) +
 * a JE for the inventory-adjustment side. The engine-level
 * `(reference_type, reference_id)` guard exists for the JE leg, but
 * a duplicate POST with a fresh `adjustment_id` per call would slip
 * past it. Operator double-click + network retry are both realistic
 * attack vectors for this route.
 *
 * Strategy:
 *   · Mount the real StockController with a stubbed StockService.
 *   · Mount the real IdempotencyInterceptor.
 *   · Mock the IdempotencyCacheService (NOT a real Redis) so each
 *     test can control acquire / replay / in_progress / unavailable
 *     branches deterministically.
 *
 * Scope of THIS PR (this controller's contribution):
 *   · `adjust` (newly decorated) MUST have the interceptor.
 *   · All other StockController handlers (the GETs) do NOT carry
 *     the interceptor — they're read-only.
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { StockController } from './stock.controller';
import { StockService } from './stock.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // 36 chars
const ROUTE_PATH = '/stock/adjust';

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

function makeNext(value: unknown): CallHandler {
  return { handle: jest.fn(() => of(value)) } as any;
}

function makeFailingNext(err: Error): CallHandler {
  return { handle: jest.fn(() => throwError(() => err)) } as any;
}

describe('IdempotencyInterceptor on POST /stock/adjust — PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS', () => {
  let interceptor: IdempotencyInterceptor;
  let cache: jest.Mocked<IdempotencyCacheService>;

  // Realistic adjust body: stock-keeper correcting +5 units on a
  // variant after a recount.
  const sampleBody = {
    variant_id: '11111111-1111-1111-1111-111111111111',
    warehouse_id: '22222222-2222-2222-2222-222222222222',
    delta: 5,
    reason: 'تصحيح بعد جرد',
    unit_cost: 25,
  };

  const sampleSuccess = {
    adjustment_id: 'adj-AAA',
    movement_id: 'mv-BBB',
    new_qty: 47,
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
    const result = await firstValueFrom(
      (await interceptor.intercept(makeExecutionContext(req, res), next)) as any,
    );
    expect(result).toEqual(sampleSuccess);
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(cache.cacheResult).toHaveBeenCalledTimes(1);
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it('replay (same key + same payload) → cached body, handler NOT invoked, X-Idempotent-Replay=true (no duplicate stock_movement)', async () => {
    const req = makeMockReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'replay',
      cached: {
        status: 201,
        body: sampleSuccess,
        payload_hash: 'hash',
        cached_at: '2026-05-06T12:00:00.000Z',
      } as CachedResponse,
    } as AcquireResult);

    const result = await firstValueFrom(
      (await interceptor.intercept(makeExecutionContext(req, res), next)) as any,
    );
    expect(result).toEqual(sampleSuccess);
    expect(handler).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'true');
  });

  it('payload mismatch (same key + tampered delta) → 409, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { ...sampleBody, delta: 999 },
    });
    const handler = jest.fn();
    const next = { handle: handler } as any;

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'payload_mismatch',
      cached: {
        status: 201,
        body: sampleSuccess,
        payload_hash: 'orig-hash',
        cached_at: '2026-05-06T12:00:00.000Z',
      } as CachedResponse,
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
      expect(err.getResponse()).toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS' });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('Redis unavailable + key → 503 fail-closed, handler NOT invoked', async () => {
    const req = makeMockReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    const handler = jest.fn();
    const next = { handle: handler } as any;

    cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'unavailable' } as AcquireResult);

    try {
      await interceptor.intercept(makeExecutionContext(req, makeMockRes()), next);
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(503);
      expect(err.getResponse()).toMatchObject({ code: 'IDEMPOTENCY_CACHE_UNAVAILABLE' });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('invalid Idempotency-Key format → 400, cache NOT consulted', async () => {
    const req = makeMockReq({ headers: { 'idempotency-key': 'has spaces!' }, body: sampleBody });
    const handler = jest.fn();
    const next = { handle: handler } as any;

    try {
      await interceptor.intercept(makeExecutionContext(req, makeMockRes()), next);
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(400);
      expect(err.getResponse()).toMatchObject({ code: 'IDEMPOTENCY_KEY_INVALID' });
    }
    expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
  });

  it('handler throws after lock acquired → lock released, error re-thrown, no cached result', async () => {
    const req = makeMockReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${VALID_KEY}`,
    } as AcquireResult);

    const next = makeFailingNext(new Error('synthetic stock-adjust failure'));
    await expect(
      firstValueFrom(
        (await interceptor.intercept(
          makeExecutionContext(req, makeMockRes()), next,
        )) as any,
      ),
    ).rejects.toThrow(/synthetic stock-adjust failure/);

    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe('StockController route-level wiring — PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS', () => {
  it('adjust has IdempotencyInterceptor; GET handlers do NOT', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [StockController],
      providers: [
        {
          provide: StockService,
          useValue: {
            adjust: jest.fn(),
            listWarehouses: jest.fn(),
            getStockFor: jest.fn(),
            variantsWithStock: jest.fn(),
            listAdjustments: jest.fn(),
            lowStock: jest.fn(),
            reorderSuggestions: jest.fn(),
            deadStock: jest.fn(),
            lossWarnings: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(StockController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) => i === IdempotencyInterceptor || i?.name === 'IdempotencyInterceptor',
      );
    };

    expect(hasInterceptor((controller as any).adjust)).toBe(true);

    // Read-only GETs MUST NOT carry the interceptor.
    const undecoratedSiblings: Array<keyof StockController> = [
      'warehouses',
      'forVariant',
      'byProduct',
      'listAdjustments',
      'lowStock',
      'reorder',
      'dead',
      'loss',
    ];
    for (const name of undecoratedSiblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(false);
    }
  });
});
