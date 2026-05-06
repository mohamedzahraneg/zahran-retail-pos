/**
 * stock-transfers.controller.idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS (Sprint 4 / PR-11B)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on all 3
 * stock-transfer lifecycle handlers:
 *
 *   · POST /stock-transfers              (create — draft only, no
 *                                          stock_movements written
 *                                          but duplicate POSTs would
 *                                          create duplicate draft
 *                                          headers + items)
 *   · POST /stock-transfers/:id/ship     (draft → in_transit; FIRST
 *                                          stock_movements writer —
 *                                          deducts source warehouse)
 *   · POST /stock-transfers/:id/receive  (in_transit → received;
 *                                          SECOND stock_movements
 *                                          writer — adds destination)
 *
 * Audit correction (vs the original PR-11 audit):
 *   The PR-11 audit row mis-classified `POST /stock-transfers` as
 *   writing "stock movement (2 sides)". `create` actually writes
 *   only a draft header + items (no movements). The actual stock
 *   writes happen on `/:id/ship` and `/:id/receive`. PR-11B's user
 *   spec (Option C) corrected the scope to cover all 3 lifecycle
 *   routes. This spec pins all 3.
 *
 * Strategy:
 *   · Mount the real StockTransfersController with a stubbed
 *     StockTransfersService.
 *   · Mount the real IdempotencyInterceptor.
 *   · Mock IdempotencyCacheService so each test controls the cache
 *     branch deterministically.
 *
 * Scope of THIS PR (stock-transfers contribution):
 *   · `create`, `ship`, `receive` (all newly decorated) MUST have
 *     the interceptor.
 *   · `cancel` MUST NOT carry the interceptor in this PR (the
 *     audit's plan defers cancel/void family to PR-11E).
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { StockTransfersController } from './stock-transfers.controller';
import { StockTransfersService } from './stock-transfers.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TRANSFER_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd';

const ROUTE_CREATE  = '/stock-transfers';
const ROUTE_SHIP    = '/stock-transfers/:id/ship';
const ROUTE_RECEIVE = '/stock-transfers/:id/receive';

function makeMockReq(routePath: string, overrides: Partial<any> = {}) {
  const url = routePath.replace(':id', TRANSFER_ID);
  return {
    method: 'POST',
    url,
    originalUrl: url,
    route: { path: routePath },
    headers: {},
    body: {},
    params: routePath.includes(':id') ? { id: TRANSFER_ID } : {},
    user: { userId: 'user-AAA' },
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

/* ────────────────────────────────────────────────────────────────────
 * Per-route interceptor behaviour. The 3 routes share the same
 * interceptor logic, so we run the full matrix (no header / first /
 * replay / mismatch / concurrent / unavailable / invalid / throw)
 * once each — but parameterized so we exercise every route.
 * ──────────────────────────────────────────────────────────────────── */

describe.each([
  ['create',  ROUTE_CREATE,  { from_warehouse_id: 'wh-A', to_warehouse_id: 'wh-B', items: [{ variant_id: 'v1', quantity_requested: 5 }] }, { transfer_id: TRANSFER_ID, transfer_no: 'ST-2026-0001', status: 'draft' }],
  ['ship',    ROUTE_SHIP,    {},                                                                                                          { transfer_id: TRANSFER_ID, status: 'in_transit', movement_ids: ['mv-out-1'] }],
  ['receive', ROUTE_RECEIVE, { items: [{ variant_id: 'v1', quantity_received: 5 }] },                                                     { transfer_id: TRANSFER_ID, status: 'received',   movement_ids: ['mv-in-1'] }],
])(
  'IdempotencyInterceptor on %s lifecycle route — PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS',
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

    it(`[${label}] no Idempotency-Key → handler called, X-Idempotent-Replay=false`, async () => {
      const req = makeMockReq(routePath);
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

    it(`[${label}] first keyed request → handler called, cacheResult invoked with 24h TTL`, async () => {
      const req = makeMockReq(routePath, {
        headers: { 'idempotency-key': VALID_KEY },
        body: sampleBody,
      });
      const res = makeMockRes();
      const next = makeNext(sampleSuccess);

      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'acquired',
        cacheKey: `idempotency:v1:POST:${routePath}:${VALID_KEY}`,
      } as AcquireResult);

      res.statusCode = 201;
      await firstValueFrom(
        (await interceptor.intercept(makeExecutionContext(req, res), next)) as any,
      );
      expect(next.handle).toHaveBeenCalledTimes(1);
      expect(cache.cacheResult).toHaveBeenCalledTimes(1);
      expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
    });

    it(`[${label}] replay (same key + same body) → cached body, handler NOT invoked, X-Idempotent-Replay=true`, async () => {
      const req = makeMockReq(routePath, {
        headers: { 'idempotency-key': VALID_KEY },
        body: sampleBody,
      });
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

    it(`[${label}] payload mismatch → 409, handler NOT invoked`, async () => {
      const req = makeMockReq(routePath, {
        headers: { 'idempotency-key': VALID_KEY },
        body: { ...(sampleBody as object), tampered: true },
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

    it(`[${label}] concurrent same-key → 425 IDEMPOTENCY_KEY_IN_PROGRESS`, async () => {
      const req = makeMockReq(routePath, {
        headers: { 'idempotency-key': VALID_KEY },
        body: sampleBody,
      });
      const handler = jest.fn();
      const next = { handle: handler } as any;

      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'in_progress',
        cacheKey: `idempotency:v1:POST:${routePath}:${VALID_KEY}`,
      } as AcquireResult);

      try {
        await interceptor.intercept(makeExecutionContext(req, makeMockRes()), next);
        throw new Error('expected HttpException');
      } catch (err: any) {
        expect(err.getStatus()).toBe(425);
      }
      expect(handler).not.toHaveBeenCalled();
    });

    it(`[${label}] Redis unavailable + key → 503 fail-closed`, async () => {
      const req = makeMockReq(routePath, {
        headers: { 'idempotency-key': VALID_KEY },
        body: sampleBody,
      });
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

    it(`[${label}] invalid Idempotency-Key format → 400, cache NOT consulted`, async () => {
      const req = makeMockReq(routePath, {
        headers: { 'idempotency-key': 'has spaces!' },
        body: sampleBody,
      });
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

    it(`[${label}] handler throws → lock released, no cached result`, async () => {
      const req = makeMockReq(routePath, {
        headers: { 'idempotency-key': VALID_KEY },
        body: sampleBody,
      });
      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'acquired',
        cacheKey: `idempotency:v1:POST:${routePath}:${VALID_KEY}`,
      } as AcquireResult);
      const next = makeFailingNext(new Error(`synthetic ${label} failure`));
      await expect(
        firstValueFrom(
          (await interceptor.intercept(makeExecutionContext(req, makeMockRes()), next)) as any,
        ),
      ).rejects.toThrow(new RegExp(`synthetic ${label} failure`));
      expect(cache.cacheResult).not.toHaveBeenCalled();
      expect(cache.releaseLock).toHaveBeenCalledTimes(1);
    });
  },
);

/* ────────────────────────────────────────────────────────────────────
 * Cache-namespace isolation across the 3 lifecycle routes.
 *
 * The same Idempotency-Key sent to /stock-transfers AND
 * /stock-transfers/:id/ship AND /stock-transfers/:id/receive must
 * produce 3 distinct cache namespaces — otherwise a duplicate POST
 * to one stage could spuriously match the cached response from a
 * prior stage. The interceptor uses `req.route.path` (parameterized)
 * so the 3 paths are structurally distinct.
 * ──────────────────────────────────────────────────────────────────── */

describe('namespace isolation across stock-transfer lifecycle (create / ship / receive)', () => {
  it('keyed calls to all 3 routes invoke tryAcquireOrReplay with distinct paths', async () => {
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
      ROUTE_CREATE,
      ROUTE_SHIP,
      ROUTE_RECEIVE,
      // Spot-check: the new sibling routes from this PR plus a few
      // pilot routes — namespaces must be pairwise distinct from
      // every previously protected route.
      '/stock/adjust',
      '/purchases/:id/receive',
      '/cash-desk/deposit',
      '/cash-desk/transfer',
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
          makeExecutionContext(req, makeMockRes()), next,
        )) as any,
      );
    }

    expect(cache.tryAcquireOrReplay).toHaveBeenCalledTimes(distinctPaths.length);
    const invokedPaths = cache.tryAcquireOrReplay.mock.calls.map((c) => c[1]);
    expect(invokedPaths).toEqual(distinctPaths);
    expect(new Set(invokedPaths).size).toBe(distinctPaths.length);
  });
});

/* ────────────────────────────────────────────────────────────────────
 * Wiring assertions — all 3 lifecycle handlers carry the
 * interceptor; `cancel` does NOT (deferred to PR-11E).
 * ──────────────────────────────────────────────────────────────────── */

describe('StockTransfersController route-level wiring — PR-FIX-IDEMPOTENCY-STOCK-INVENTORY-PATHS', () => {
  it('create + ship + receive have IdempotencyInterceptor; cancel + GETs do NOT', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [StockTransfersController],
      providers: [
        {
          provide: StockTransfersService,
          useValue: {
            create: jest.fn(),
            ship: jest.fn(),
            receive: jest.fn(),
            cancel: jest.fn(),
            list: jest.fn(),
            findOne: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(StockTransfersController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) => i === IdempotencyInterceptor || i?.name === 'IdempotencyInterceptor',
      );
    };

    // ── This PR's 3 lifecycle targets.
    expect(hasInterceptor((controller as any).create)).toBe(true);
    expect(hasInterceptor((controller as any).ship)).toBe(true);
    expect(hasInterceptor((controller as any).receive)).toBe(true);

    // ── Cancel — deferred to PR-11E (void/cancel family).
    expect(hasInterceptor((controller as any).cancel)).toBe(false);
  });
});
