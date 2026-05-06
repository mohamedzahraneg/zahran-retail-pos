/**
 * returns.controller.refund-cancel-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY (Sprint 4 / PR-11E)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /returns/:id/refund   (P0 — fresh JE + CT per call;
 *                                  engine guard exists but state-
 *                                  guard race is real)
 *   · POST /returns/:id/cancel   (P1 — multi-stage reversal; engine
 *                                  catches dup JE)
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
const RETURN_ID = 'rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr';

const ROUTE_REFUND = '/returns/:id/refund';
const ROUTE_CANCEL = '/returns/:id/cancel';

function makeReq(routePath: string, overrides: Partial<any> = {}) {
  const url = routePath.replace(':id', RETURN_ID);
  return {
    method: 'POST', url, originalUrl: url, route: { path: routePath },
    headers: {}, body: {}, params: { id: RETURN_ID },
    user: { userId: 'user-AAA', permissions: [] },
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
  [
    'refund',
    ROUTE_REFUND,
    { cashbox_id: 'cb-AAA', amount: 250 },
    { return_id: RETURN_ID, refund_amount: 250, je_id: 'je-AAA' },
  ],
  [
    'cancel',
    ROUTE_CANCEL,
    { confirmation_token: `CANCEL_RETURN_RTN-2026-0001` },
    { return_id: RETURN_ID, status: 'cancelled', reversal_je_id: 'je-BBB' },
  ],
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

    it(`[${label}] first keyed → cacheResult invoked with 24h TTL`, async () => {
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

    it(`[${label}] replay → cached body, handler NOT invoked`, async () => {
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
      expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'true');
    });

    it(`[${label}] payload mismatch → 409`, async () => {
      const req = makeReq(routePath, {
        headers: { 'idempotency-key': VALID_KEY },
        body: { ...(sampleBody as object), tampered: 'yes' },
      });
      const handler = jest.fn();
      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'payload_mismatch',
        cached: { status: 201, body: sampleSuccess, payload_hash: 'orig', cached_at: 't' } as CachedResponse,
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
      const req = makeReq(routePath, { headers: { 'idempotency-key': 'bad key!' }, body: sampleBody });
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

describe('namespace isolation — returns lifecycle (refund vs cancel vs reject)', () => {
  it('keyed calls produce route-distinct cache namespaces', async () => {
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
    // /returns/:id/reject is P2 (state-only) and intentionally
    // undecorated — included here only to verify its NAMESPACE is
    // distinct in case it's decorated in a future PR.
    const distinctPaths = [
      ROUTE_REFUND,
      ROUTE_CANCEL,
      '/returns/:id/reject',
      '/returns/:id/approve',
      '/returns',
      '/exchanges',
    ];
    for (const path of distinctPaths) {
      const req = { method: 'POST', url: path, originalUrl: path, route: { path }, headers: { 'idempotency-key': VALID_KEY }, body: { x: 1 } };
      await firstValueFrom((await interceptor.intercept(ctx(req, makeRes()), next({ ok: true }))) as any);
    }
    expect(cache.tryAcquireOrReplay).toHaveBeenCalledTimes(distinctPaths.length);
    const invokedPaths = cache.tryAcquireOrReplay.mock.calls.map((c) => c[1]);
    expect(invokedPaths).toEqual(distinctPaths);
    expect(new Set(invokedPaths).size).toBe(distinctPaths.length);
  });
});
