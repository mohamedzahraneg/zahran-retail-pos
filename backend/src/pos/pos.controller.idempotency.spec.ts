/**
 * pos.controller.idempotency.spec.ts — PR-AUDIT-IDEMPOTENCY-INTERCEPTOR-POS-INVOICE
 *
 * Pins the 7 required behaviors of the Idempotency-Key interceptor on
 * `POST /pos/invoices` (the pilot endpoint).
 *
 * Strategy:
 *   · Mount the real PosController with a stubbed PosService.
 *   · Mount the real IdempotencyInterceptor.
 *   · Mock the IdempotencyCacheService (NOT a real Redis) so each
 *     test can control acquire/replay/in_progress/unavailable
 *     branches deterministically.
 *   · Use Express request/response stubs to assert headers + status
 *     without booting Nest's HTTP layer.
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // 36 chars, fits 8-128 alnum/-/_

function makeMockReq(overrides: Partial<any> = {}) {
  return {
    method: 'POST',
    url: '/pos/invoices',
    originalUrl: '/pos/invoices',
    route: { path: '/pos/invoices' },
    headers: {},
    body: {},
    ...overrides,
  };
}

function makeMockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 201; // controller's default for POST is typically 201
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
  // Return an observable that errors so the interceptor's pipe(catchError)
  // sees it (which is how Nest handlers actually surface failures —
  // controllers throw inside an Observable, never synchronously).
  return {
    handle: jest.fn(() => throwError(() => err)),
  } as any;
}

describe('IdempotencyInterceptor on POST /pos/invoices — PR-AUDIT-IDEMPOTENCY-INTERCEPTOR-POS-INVOICE', () => {
  let interceptor: IdempotencyInterceptor;
  let cache: jest.Mocked<IdempotencyCacheService>;

  beforeEach(async () => {
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

  // ─── Behavior 5: no key = service called normally ──────────────
  it('no Idempotency-Key header → handler called, X-Idempotent-Replay=false, cache untouched', async () => {
    const req = makeMockReq();
    const res = makeMockRes();
    const next = makeNext({ id: 'inv-123' });
    const ctx = makeExecutionContext(req, res);
    const result = await firstValueFrom(
      (await interceptor.intercept(ctx, next)) as any,
    );
    expect(result).toEqual({ id: 'inv-123' });
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Idempotent-Replay',
      'false',
    );
  });

  // ─── Behavior 1: first keyed request = service called once and cached ──────────────
  it('first keyed request → handler called, X-Idempotent-Replay=false, cacheResult invoked with 24h TTL', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { customer_id: 'c-1', lines: [{ qty: 1, variant_id: 'v-1' }] },
    });
    const res = makeMockRes();
    const next = makeNext({ id: 'inv-123', invoice_no: 'INV-2026-000099' });
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: 'idempotency:v1:POST:/pos/invoices:' + VALID_KEY,
    } as AcquireResult);

    res.statusCode = 201;
    const result = await firstValueFrom(
      (await interceptor.intercept(ctx, next)) as any,
    );

    expect(result).toEqual({
      id: 'inv-123',
      invoice_no: 'INV-2026-000099',
    });
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(cache.cacheResult).toHaveBeenCalledTimes(1);
    expect(cache.cacheResult).toHaveBeenCalledWith(
      expect.stringContaining(VALID_KEY),
      expect.any(String), // payload hash
      201,
      { id: 'inv-123', invoice_no: 'INV-2026-000099' },
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Idempotent-Replay',
      'false',
    );
    // Confirm the cache TTL constant matches the user-required 24h.
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  // ─── Behavior 2: replay same key/body = cached response, handler NOT called ──────────────
  it('replay (same key + same payload) → returns cached body, X-Idempotent-Replay=true, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { customer_id: 'c-1', lines: [{ qty: 1, variant_id: 'v-1' }] },
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    const cachedBody = {
      id: 'inv-123',
      invoice_no: 'INV-2026-000099',
    };
    const cached: CachedResponse = {
      status: 201,
      body: cachedBody,
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
    expect(result).toEqual(cachedBody);
    expect(handler).not.toHaveBeenCalled();
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Idempotent-Replay',
      'true',
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  // ─── Behavior 3: same key + different body = 409 ──────────────
  it('payload mismatch (same key + different payload) → 409 conflict, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { customer_id: 'c-2', lines: [{ qty: 99, variant_id: 'v-99' }] },
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    const cached: CachedResponse = {
      status: 201,
      body: { id: 'inv-original' },
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

  // ─── Behavior 4: different key + same body = service called again ──────────────
  it('different key with same payload → handler invoked again (no cross-key dedupe)', async () => {
    const otherKey = 'ffffffff-1111-2222-3333-444444444444';
    const req = makeMockReq({
      headers: { 'idempotency-key': otherKey },
      body: { customer_id: 'c-1', lines: [{ qty: 1, variant_id: 'v-1' }] },
    });
    const res = makeMockRes();
    const next = makeNext({ id: 'inv-456' });
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: 'idempotency:v1:POST:/pos/invoices:' + otherKey,
    } as AcquireResult);

    res.statusCode = 201;
    const result = await firstValueFrom(
      (await interceptor.intercept(ctx, next)) as any,
    );
    expect(result).toEqual({ id: 'inv-456' });
    expect(next.handle).toHaveBeenCalledTimes(1);
    // Acquire was called once with the OTHER key; we don't enforce
    // the exact cacheKey shape here — just that no replay happened.
    expect(cache.tryAcquireOrReplay).toHaveBeenCalledTimes(1);
  });

  // ─── Behavior 6: concurrent same-key = service called once only (425) ──────────────
  it('concurrent same-key (lock held by another request) → 425 Too Early, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { customer_id: 'c-1' },
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'in_progress',
      cacheKey: 'idempotency:v1:POST:/pos/invoices:' + VALID_KEY,
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

  // ─── Behavior 7: Redis unavailable (keyed) = fail-closed 503, handler NOT invoked ──────────────
  it('Redis unavailable for keyed request → 503 fail-closed, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { customer_id: 'c-1' },
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

  // ─── Defense: bad key format ──────────────
  it('invalid Idempotency-Key format → 400, handler NOT invoked, cache NOT consulted', async () => {
    const req = makeMockReq({
      // Contains spaces + punctuation → fails the [A-Za-z0-9_-]{8,128} pattern.
      headers: { 'idempotency-key': 'has spaces & symbols!' },
      body: {},
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

  // ─── Defense: handler error releases the lock so a retry can proceed ──────────────
  it('handler throws after lock acquired → lock released, error re-thrown, no cached result', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { customer_id: 'c-1' },
    });
    const res = makeMockRes();
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: 'idempotency:v1:POST:/pos/invoices:' + VALID_KEY,
    } as AcquireResult);

    const next = makeFailingNext(new Error('synthetic handler failure'));

    await expect(
      firstValueFrom((await interceptor.intercept(ctx, next)) as any),
    ).rejects.toThrow(/synthetic handler failure/);

    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

/**
 * End-to-end-ish: the controller is wired with the interceptor.
 * Confirms the `@UseInterceptors(IdempotencyInterceptor)` decorator is
 * present on the create() method specifically (not on list/void/etc.).
 */
describe('PosController route-level wiring', () => {
  it('PosController.create has IdempotencyInterceptor applied (and only create)', async () => {
    // Discover via Reflect metadata what NestJS uses internally.
    const moduleRef = await Test.createTestingModule({
      controllers: [PosController],
      providers: [
        { provide: PosService, useValue: { createInvoice: jest.fn() } },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(PosController);
    // Method-level interceptors are attached as a metadata array on
    // the prototype method via Nest's decorator machinery.
    const createMeta = Reflect.getMetadata(
      '__interceptors__',
      controller.create,
    );
    expect(createMeta).toBeDefined();
    expect(createMeta.some((i: any) => i === IdempotencyInterceptor || i?.name === 'IdempotencyInterceptor')).toBe(true);

    // The list endpoint should NOT have the interceptor (pilot scope).
    const listMeta = Reflect.getMetadata(
      '__interceptors__',
      (controller as any).list,
    );
    if (listMeta) {
      expect(listMeta.some((i: any) => i === IdempotencyInterceptor || i?.name === 'IdempotencyInterceptor')).toBe(false);
    }
  });
});
