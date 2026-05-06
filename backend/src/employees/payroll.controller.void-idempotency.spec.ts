/**
 * payroll.controller.void-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY (Sprint 4 / PR-11E)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · DELETE /payroll/:id   (`voidTxn` — dispatched void of
 *                             bonus/deduction/settlement/wage rows
 *                             via id-prefix → cascade triggers void
 *                             the matching JE + reverse paired CT)
 *
 * The state guard `WHERE NOT is_void` makes the void naturally
 * idempotent at the row level, but the HTTP interceptor adds outer
 * race defence + cleaner UX on retry.
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
const TXN_ID = 'bon:00000000-0000-0000-0000-000000000001';
const ROUTE_PATH = '/payroll/:id';

const makeReq = (overrides: Partial<any> = {}) => ({
  method: 'DELETE',
  url: `/payroll/${TXN_ID}`,
  originalUrl: `/payroll/${TXN_ID}`,
  route: { path: ROUTE_PATH },
  headers: {}, body: {}, params: { id: TXN_ID },
  user: { userId: 'user-AAA' },
  ...overrides,
});

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

// DELETE typically has no body, but the interceptor still hashes
// the (possibly empty) body — same matrix applies.
const sampleBody = {};
const sampleSuccess = { voided: true };

describe('IdempotencyInterceptor on DELETE /payroll/:id — PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY', () => {
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

  it('no header → handler called, replay false', async () => {
    const req = makeReq(), res = makeRes();
    const result = await firstValueFrom(
      (await interceptor.intercept(ctx(req, res), next(sampleSuccess))) as any,
    );
    expect(result).toEqual(sampleSuccess);
    expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
  });

  it('first keyed → cacheResult invoked', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    const res = makeRes();
    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired', cacheKey: `idempotency:v1:DELETE:${ROUTE_PATH}:${VALID_KEY}`,
    } as AcquireResult);
    res.statusCode = 200;
    await firstValueFrom((await interceptor.intercept(ctx(req, res), next(sampleSuccess))) as any);
    expect(cache.cacheResult).toHaveBeenCalledTimes(1);
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it('replay → cached body, handler NOT invoked', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
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

  it('payload mismatch → 409', async () => {
    const req = makeReq({
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

  it('concurrent → 425', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'in_progress', cacheKey: 'k' } as AcquireResult);
    try {
      await interceptor.intercept(ctx(req, makeRes()), next(null));
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(425);
    }
  });

  it('Redis unavailable → 503', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'unavailable' } as AcquireResult);
    try {
      await interceptor.intercept(ctx(req, makeRes()), next(null));
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(503);
    }
  });

  it('invalid key → 400', async () => {
    const req = makeReq({ headers: { 'idempotency-key': 'bad!' }, body: sampleBody });
    try {
      await interceptor.intercept(ctx(req, makeRes()), next(null));
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(400);
    }
    expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
  });

  it('handler throws → lock released', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'acquired', cacheKey: 'k' } as AcquireResult);
    await expect(
      firstValueFrom(
        (await interceptor.intercept(
          ctx(req, makeRes()), failNext(new Error('synthetic payroll void failure')),
        )) as any,
      ),
    ).rejects.toThrow(/synthetic payroll void failure/);
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe('namespace isolation — payroll create vs payroll void', () => {
  it('POST /payroll vs DELETE /payroll/:id produce distinct namespaces', async () => {
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
    // (method, path) tuples must be pairwise distinct in the cache
    // key (interceptor uses both — see idempotency-cache.service.ts).
    const reqs = [
      { method: 'POST', url: '/payroll', originalUrl: '/payroll', route: { path: '/payroll' }, headers: { 'idempotency-key': VALID_KEY }, body: { x: 1 } },
      { method: 'DELETE', url: `/payroll/${TXN_ID}`, originalUrl: `/payroll/${TXN_ID}`, route: { path: ROUTE_PATH }, headers: { 'idempotency-key': VALID_KEY }, body: {} },
    ];
    for (const req of reqs) {
      await firstValueFrom((await interceptor.intercept(ctx(req, makeRes()), next({ ok: true }))) as any);
    }
    expect(cache.tryAcquireOrReplay).toHaveBeenCalledTimes(2);
    // Different methods (POST vs DELETE) → distinct namespaces.
    const methods = cache.tryAcquireOrReplay.mock.calls.map((c) => c[0]);
    expect(methods).toEqual(['POST', 'DELETE']);
  });
});
