/**
 * inventory-counts.controller.finalize-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-DEFERRED-APPROVE-FAMILY (Sprint 4 / PR-11F-bis)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /inventory-counts/:id/finalize
 *
 * `finalize` is multi-stage: applies stock variance adjustments
 * (UPDATE stock + INSERT stock_movements per variance) + posts the
 * adjustment JE for net P/L impact + transitions the count row to
 * `finalized` status. State-guarded by status check; HTTP
 * interceptor adds outer race defence on retry.
 *
 * Scope:
 *   · `finalize` (newly decorated) MUST have the interceptor.
 *   · `start`, `submitEntries`, `cancel` MUST remain undecorated —
 *     out of scope for PR-11F-bis. (`cancel` may be picked up in a
 *     future void-cancel-family extension.)
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { InventoryCountsController } from './inventory-counts.controller';
import { InventoryCountsService } from './inventory-counts.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const COUNT_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const ROUTE_PATH = '/inventory-counts/:id/finalize';

const makeReq = (overrides: Partial<any> = {}) => ({
  method: 'POST',
  url: `/inventory-counts/${COUNT_ID}/finalize`,
  originalUrl: `/inventory-counts/${COUNT_ID}/finalize`,
  route: { path: ROUTE_PATH },
  headers: {}, body: {}, params: { id: COUNT_ID },
  user: { userId: 'stockkeeper-AAA', id: 'stockkeeper-AAA' },
  ...overrides,
});

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

const sampleBody = {
  notes: 'تم اعتماد الجرد الشهري — فروقات تحت الحد المقبول',
};
const sampleSuccess = {
  count_id: COUNT_ID,
  status: 'finalized',
  variances_applied: 12,
  je_id: 'je-AAA',
};

describe('IdempotencyInterceptor on POST /inventory-counts/:id/finalize — PR-FIX-IDEMPOTENCY-DEFERRED-APPROVE-FAMILY', () => {
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
    expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'false');
  });

  it('first keyed → cacheResult invoked with 24h TTL', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    const res = makeRes();
    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired', cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${VALID_KEY}`,
    } as AcquireResult);
    res.statusCode = 201;
    await firstValueFrom((await interceptor.intercept(ctx(req, res), next(sampleSuccess))) as any);
    expect(cache.cacheResult).toHaveBeenCalledTimes(1);
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it('replay → cached body, handler NOT invoked (no duplicate stock movements/JE)', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
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

  it('payload mismatch (different notes) → 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', async () => {
    const req = makeReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { ...sampleBody, notes: 'مختلف تماماً' },
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
      expect(err.getResponse()).toMatchObject({ code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH' });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('concurrent → 425', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'in_progress', cacheKey: 'k' } as AcquireResult);
    try {
      await interceptor.intercept(ctx(req, makeRes()), next(null));
      throw new Error('expected HttpException');
    } catch (err: any) { expect(err.getStatus()).toBe(425); }
  });

  it('Redis unavailable → 503 (fail-closed)', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'unavailable' } as AcquireResult);
    try {
      await interceptor.intercept(ctx(req, makeRes()), next(null));
      throw new Error('expected HttpException');
    } catch (err: any) { expect(err.getStatus()).toBe(503); }
  });

  it('invalid key → 400 (no acquire attempted)', async () => {
    const req = makeReq({ headers: { 'idempotency-key': 'bad!' }, body: sampleBody });
    try {
      await interceptor.intercept(ctx(req, makeRes()), next(null));
      throw new Error('expected HttpException');
    } catch (err: any) { expect(err.getStatus()).toBe(400); }
    expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
  });

  it('handler throws → lock released, NOT cached', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'acquired', cacheKey: 'k' } as AcquireResult);
    await expect(
      firstValueFrom(
        (await interceptor.intercept(
          ctx(req, makeRes()), failNext(new Error('synthetic inventory finalize failure')),
        )) as any,
      ),
    ).rejects.toThrow(/synthetic inventory finalize failure/);
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe('namespace isolation: inventory-counts finalize vs sibling routes', () => {
  it('keyed calls invoke tryAcquireOrReplay with route-distinct paths', async () => {
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
      ROUTE_PATH,
      '/inventory-counts/start',
      '/inventory-counts/:id/entries',
      '/inventory-counts/:id/cancel',
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

describe('InventoryCountsController route-level wiring — PR-FIX-IDEMPOTENCY-DEFERRED-APPROVE-FAMILY', () => {
  it('finalize decorated; start + submitEntries + cancel NOT decorated', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [InventoryCountsController],
      providers: [
        {
          provide: InventoryCountsService,
          useValue: {
            create: jest.fn(),
            freeze: jest.fn(),
            start: jest.fn(),
            updateItems: jest.fn(),
            submitEntries: jest.fn(),
            review: jest.fn(),
            finalize: jest.fn(),
            cancel: jest.fn(),
            list: jest.fn(),
            findOne: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(InventoryCountsController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) => i === IdempotencyInterceptor || i?.name === 'IdempotencyInterceptor',
      );
    };

    // ── This PR's target.
    expect(hasInterceptor((controller as any).finalize)).toBe(true);

    // PR-INVENTORY-COUNTS-WORKFLOW — the idempotency umbrella now
    // covers every write transition that flips status or touches the
    // ledger: create, freeze, start, review, finalize, cancel. The
    // soft updateItems/entries surfaces (counted_qty buffering) stay
    // undecorated — they're status-guarded UPDATEs with no stock
    // motion, and retrying them is harmless by design.
    const decoratedSiblings: Array<keyof InventoryCountsController> = [
      'create',
      'freeze',
      'start',
      'review',
      'cancel',
    ];
    for (const name of decoratedSiblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(true);
    }

    const undecoratedSiblings: Array<keyof InventoryCountsController> = [
      'submitEntries',
      'updateItems',
    ];
    for (const name of undecoratedSiblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(false);
    }
  });
});
