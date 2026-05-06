/**
 * purchases.controller.cancel-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY (Sprint 4 / PR-11E)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · PATCH /purchases/:id/cancel        (P1 — UPDATE status +
 *                                          reverseByReference for
 *                                          cash payments)
 *   · PATCH /purchases/returns/:id/cancel (P0 — multi-stage stock
 *                                          rebuild + reversing
 *                                          stock_movements + JE
 *                                          reversal)
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
const PURCHASE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const ROUTE_CANCEL_PURCHASE = '/purchases/:id/cancel';
const ROUTE_CANCEL_RETURN = '/purchases/returns/:id/cancel';

function makeReq(routePath: string, overrides: Partial<any> = {}) {
  const url = routePath.replace(':id', PURCHASE_ID);
  return {
    method: 'PATCH', url, originalUrl: url, route: { path: routePath },
    headers: {}, body: {}, params: { id: PURCHASE_ID },
    user: { userId: 'user-AAA', id: 'user-AAA' },
    ...overrides,
  };
}

function makeRes() {
  const headers: Record<string, string> = {};
  let statusCode = 200;
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
  ['cancel', ROUTE_CANCEL_PURCHASE, {}, { cancelled: true, reversed: true }],
  ['cancelReturn', ROUTE_CANCEL_RETURN, {}, { return_id: PURCHASE_ID, status: 'cancelled' }],
])(
  'IdempotencyInterceptor on %s — PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY',
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

    it(`[${label}] no header → handler called, replay false`, async () => {
      const req = makeReq(routePath), res = makeRes();
      const result = await firstValueFrom(
        (await interceptor.intercept(ctx(req, res), next(sampleSuccess))) as any,
      );
      expect(result).toEqual(sampleSuccess);
      expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'false');
    });

    it(`[${label}] first keyed → cacheResult invoked`, async () => {
      const req = makeReq(routePath, { headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
      const res = makeRes();
      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'acquired', cacheKey: `idempotency:v1:PATCH:${routePath}:${VALID_KEY}`,
      } as AcquireResult);
      res.statusCode = 200;
      await firstValueFrom((await interceptor.intercept(ctx(req, res), next(sampleSuccess))) as any);
      expect(cache.cacheResult).toHaveBeenCalledTimes(1);
      expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
    });

    it(`[${label}] replay → cached body, handler NOT invoked`, async () => {
      const req = makeReq(routePath, { headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
      const res = makeRes();
      const handler = jest.fn();
      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'replay',
        cached: { status: 200, body: sampleSuccess, payload_hash: 'h', cached_at: 't' } as CachedResponse,
      } as AcquireResult);
      const result = await firstValueFrom(
        (await interceptor.intercept(ctx(req, res), { handle: handler } as any)) as any,
      );
      expect(result).toEqual(sampleSuccess);
      expect(handler).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'true');
    });

    it(`[${label}] payload mismatch → 409`, async () => {
      const req = makeReq(routePath, {
        headers: { 'idempotency-key': VALID_KEY },
        body: { tampered: true },
      });
      const handler = jest.fn();
      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'payload_mismatch',
        cached: { status: 200, body: sampleSuccess, payload_hash: 'orig', cached_at: 't' } as CachedResponse,
      } as AcquireResult);
      try {
        await interceptor.intercept(ctx(req, makeRes()), { handle: handler } as any);
        throw new Error('expected HttpException');
      } catch (err: any) {
        expect(err.getStatus()).toBe(409);
      }
      expect(handler).not.toHaveBeenCalled();
    });

    it(`[${label}] concurrent → 425`, async () => {
      const req = makeReq(routePath, { headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
      cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'in_progress', cacheKey: 'k' } as AcquireResult);
      try {
        await interceptor.intercept(ctx(req, makeRes()), next(null));
        throw new Error('expected HttpException');
      } catch (err: any) {
        expect(err.getStatus()).toBe(425);
      }
    });

    it(`[${label}] Redis unavailable → 503`, async () => {
      const req = makeReq(routePath, { headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
      cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'unavailable' } as AcquireResult);
      try {
        await interceptor.intercept(ctx(req, makeRes()), next(null));
        throw new Error('expected HttpException');
      } catch (err: any) {
        expect(err.getStatus()).toBe(503);
      }
    });

    it(`[${label}] invalid key → 400`, async () => {
      const req = makeReq(routePath, { headers: { 'idempotency-key': 'bad!' }, body: sampleBody });
      try {
        await interceptor.intercept(ctx(req, makeRes()), next(null));
        throw new Error('expected HttpException');
      } catch (err: any) {
        expect(err.getStatus()).toBe(400);
      }
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

describe('namespace isolation — purchases receive vs cancel vs purchase-return cancel', () => {
  it('all 3 paths produce distinct cache namespaces', async () => {
    const cache = {
      tryAcquireOrReplay: jest.fn().mockResolvedValue({ kind: 'acquired', cacheKey: 'k' } as AcquireResult),
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
      '/purchases/:id/receive',
      ROUTE_CANCEL_PURCHASE,
      ROUTE_CANCEL_RETURN,
      '/purchases/returns',
      '/purchases',
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
