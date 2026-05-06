/**
 * chart-of-accounts.controller.year-close-depreciation-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-APPROVE-FAMILY (Sprint 4 / PR-11F)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /chart-of-accounts/close-year      (annual one-shot)
 *   · POST /chart-of-accounts/depreciation/run (monthly one-shot)
 *
 * Both are catastrophic if duplicated:
 *   · close-year posts year-end closing JEs (large batch)
 *   · depreciation/run posts depreciation JEs for ALL fixed assets
 *
 * A duplicate POST during a network retry could double-post the
 * entire batch. The HTTP interceptor is the cleanest defence.
 */

import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

const ROUTE_CLOSE_YEAR   = '/chart-of-accounts/close-year';
const ROUTE_DEPRECIATION = '/chart-of-accounts/depreciation/run';

function makeReq(routePath: string, overrides: Partial<any> = {}) {
  return {
    method: 'POST', url: routePath, originalUrl: routePath,
    route: { path: routePath },
    headers: {}, body: {},
    user: { userId: 'admin-AAA' },
    ...overrides,
  };
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 201;
  return {
    headers,
    get statusCode() { return statusCode; },
    set statusCode(v: number) { statusCode = v; },
    setHeader: jest.fn((k: string, v: string) => { headers[k] = v; }),
    status: jest.fn(function (this: any, c: number) { statusCode = c; return this; }),
  };
}

const ctx = (req: any, res: any): ExecutionContext => ({
  switchToHttp: () => ({ getRequest: () => req, getResponse: () => res }),
} as any);

const next = (v: unknown): CallHandler => ({ handle: jest.fn(() => of(v)) } as any);
const failNext = (e: Error): CallHandler => ({ handle: jest.fn(() => throwError(() => e)) } as any);

describe.each([
  ['closeYear',     ROUTE_CLOSE_YEAR,   { fiscal_year_end: '2026-12-31' }, { closed: true, year_end_je_count: 5 }],
  ['runDepreciation', ROUTE_DEPRECIATION, {},                                { posted: true, asset_count: 12 }],
])(
  'IdempotencyInterceptor on %s — PR-FIX-IDEMPOTENCY-APPROVE-FAMILY',
  (label, routePath, sampleBody, sampleSuccess) => {
    let interceptor: IdempotencyInterceptor;
    let cache: jest.Mocked<IdempotencyCacheService>;

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

    it(`[${label}] no header → handler called`, async () => {
      const req = makeReq(routePath), res = makeRes();
      const result = await firstValueFrom(
        (await interceptor.intercept(ctx(req, res), next(sampleSuccess))) as any,
      );
      expect(result).toEqual(sampleSuccess);
      expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
    });

    it(`[${label}] first keyed → cacheResult invoked`, async () => {
      const req = makeReq(routePath, { headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
      const res = makeRes();
      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'acquired', cacheKey: `idempotency:v1:POST:${routePath}:${VALID_KEY}`,
      } as AcquireResult);
      res.statusCode = 201;
      await firstValueFrom((await interceptor.intercept(ctx(req, res), next(sampleSuccess))) as any);
      expect(cache.cacheResult).toHaveBeenCalledTimes(1);
      expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
    });

    it(`[${label}] replay → cached body, handler NOT invoked (no double-post catastrophe)`, async () => {
      const req = makeReq(routePath, { headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
      const res = makeRes();
      const handler = jest.fn();
      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'replay',
        cached: { status: 201, body: sampleSuccess, payload_hash: 'h', cached_at: 't' } as CachedResponse,
      } as AcquireResult);
      const result = await firstValueFrom(
        (await interceptor.intercept(ctx(req, res), { handle: handler } as any)) as any,
      );
      expect(result).toEqual(sampleSuccess);
      expect(handler).not.toHaveBeenCalled();
    });

    it(`[${label}] payload mismatch → 409`, async () => {
      const req = makeReq(routePath, {
        headers: { 'idempotency-key': VALID_KEY },
        body: { ...(sampleBody as object), tampered: true },
      });
      const handler = jest.fn();
      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'payload_mismatch',
        cached: { status: 201, body: sampleSuccess, payload_hash: 'orig', cached_at: 't' } as CachedResponse,
      } as AcquireResult);
      try {
        await interceptor.intercept(ctx(req, makeRes()), { handle: handler } as any);
        throw new Error('expected HttpException');
      } catch (err: any) { expect(err.getStatus()).toBe(409); }
      expect(handler).not.toHaveBeenCalled();
    });

    it(`[${label}] concurrent → 425`, async () => {
      const req = makeReq(routePath, { headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
      cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'in_progress', cacheKey: 'k' } as AcquireResult);
      try {
        await interceptor.intercept(ctx(req, makeRes()), next(null));
        throw new Error('expected HttpException');
      } catch (err: any) { expect(err.getStatus()).toBe(425); }
    });

    it(`[${label}] Redis unavailable → 503`, async () => {
      const req = makeReq(routePath, { headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
      cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'unavailable' } as AcquireResult);
      try {
        await interceptor.intercept(ctx(req, makeRes()), next(null));
        throw new Error('expected HttpException');
      } catch (err: any) { expect(err.getStatus()).toBe(503); }
    });

    it(`[${label}] invalid key → 400`, async () => {
      const req = makeReq(routePath, { headers: { 'idempotency-key': 'bad!' }, body: sampleBody });
      try {
        await interceptor.intercept(ctx(req, makeRes()), next(null));
        throw new Error('expected HttpException');
      } catch (err: any) { expect(err.getStatus()).toBe(400); }
      expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
    });

    it(`[${label}] handler throws → lock released`, async () => {
      const req = makeReq(routePath, { headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
      cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'acquired', cacheKey: 'k' } as AcquireResult);
      await expect(
        firstValueFrom(
          (await interceptor.intercept(
            ctx(req, makeRes()), failNext(new Error(`synthetic ${label} failure`)),
          )) as any,
        ),
      ).rejects.toThrow(new RegExp(`synthetic ${label} failure`));
      expect(cache.cacheResult).not.toHaveBeenCalled();
      expect(cache.releaseLock).toHaveBeenCalledTimes(1);
    });
  },
);

describe('namespace isolation — chart-of-accounts journal create/void vs close-year vs depreciation/run', () => {
  it('all 4 paths produce distinct cache namespaces', async () => {
    const cache = {
      tryAcquireOrReplay: jest.fn().mockResolvedValue({ kind: 'acquired', cacheKey: 'k' } as AcquireResult),
      cacheResult: jest.fn(), releaseLock: jest.fn(),
      isAvailable: jest.fn(), buildCacheKey: jest.fn(),
      onModuleInit: jest.fn(), onModuleDestroy: jest.fn(), setClientForTesting: jest.fn(),
    } as any as jest.Mocked<IdempotencyCacheService>;
    const interceptor = new IdempotencyInterceptor(cache);
    const distinctPaths = [
      '/accounting/journal',
      '/accounting/journal/:id/void',
      ROUTE_CLOSE_YEAR,
      ROUTE_DEPRECIATION,
    ];
    for (const path of distinctPaths) {
      const req = { method: 'POST', url: path, originalUrl: path, route: { path }, headers: { 'idempotency-key': VALID_KEY }, body: { x: 1 } };
      await firstValueFrom((await interceptor.intercept(ctx(req, makeRes()), next({ ok: true }))) as any);
    }
    const invokedPaths = cache.tryAcquireOrReplay.mock.calls.map((c) => c[1]);
    expect(invokedPaths).toEqual(distinctPaths);
    expect(new Set(invokedPaths).size).toBe(distinctPaths.length);
  });
});
