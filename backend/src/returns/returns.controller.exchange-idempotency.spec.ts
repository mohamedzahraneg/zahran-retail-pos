/**
 * returns.controller.exchange-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-EXCHANGES-INVOICE-EDITS (Sprint 4 / PR-11C)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /exchanges
 *
 * Exchanges have the LARGEST blast radius of any single route in
 * the system: a single POST writes a `returns` row + `return_items`,
 * a new `invoices` row + `invoice_items` + `invoice_payments`, and
 * BOTH inbound (return) and outbound (sale) `stock_movements`. The
 * engine then posts a JE for the refund leg AND a JE for the new
 * sale leg, plus the matching `cashbox_transactions` rows. A
 * duplicate POST during a network retry could partially apply some
 * of these stages before the engine guard catches the JE leg,
 * leaving a tangled return + invoice pair pointing at the same
 * physical goods. The Redis-backed interceptor's 60s lock + 24h
 * replay is the cleaner outer defence.
 *
 * Strategy:
 *   · Mount the real ReturnsController with a stubbed ReturnsService.
 *   · Mount the real IdempotencyInterceptor.
 *   · Mock IdempotencyCacheService to control branches.
 *
 * Scope of THIS PR (this controller's contribution):
 *   · `exchange` (newly decorated) MUST have the interceptor.
 *   · All other ReturnsController POST handlers (`create`,
 *     `approve`, `refund`, `reject`, `cancel`) MUST NOT carry the
 *     interceptor — deferred to phased PRs (see PR-11 audit).
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { ReturnsController } from './returns.controller';
import { ReturnsService } from './returns.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ROUTE_PATH = '/exchanges';

function makeMockReq(overrides: Partial<any> = {}) {
  return {
    method: 'POST',
    url: ROUTE_PATH,
    originalUrl: ROUTE_PATH,
    route: { path: ROUTE_PATH },
    headers: {},
    body: {},
    user: { userId: 'user-AAA', permissions: ['returns.create'] },
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

describe('IdempotencyInterceptor on POST /exchanges — PR-FIX-IDEMPOTENCY-EXCHANGES-INVOICE-EDITS', () => {
  let interceptor: IdempotencyInterceptor;
  let cache: jest.Mocked<IdempotencyCacheService>;

  // Realistic exchange body: customer returns one item and exchanges
  // it for another, paying the price difference in cash.
  const sampleBody = {
    original_invoice_id: 'oooooooo-oooo-oooo-oooo-oooooooooooo',
    return_items: [
      { original_invoice_item_id: 'rrrrrrrr-rrrr-rrrr-rrrr-rrrrrrrrrrrr', quantity: 1, refund_amount: 150 },
    ],
    new_invoice_items: [
      { variant_id: 'nnnnnnnn-nnnn-nnnn-nnnn-nnnnnnnnnnnn', quantity: 1, unit_price: 200 },
    ],
    customer_id: 'cccccccc-cccc-cccc-cccc-cccccccccccc',
    warehouse_id: 'wwwwwwww-wwww-wwww-wwww-wwwwwwwwwwww',
    cashbox_id: 'kkkkkkkk-kkkk-kkkk-kkkk-kkkkkkkkkkkk',
    payment_method: 'cash',
    notes: 'استبدال مع فرق نقدي',
  };

  const sampleSuccess = {
    exchange_id: 'ex-AAA',
    return_id: 'ret-BBB',
    new_invoice_id: 'inv-CCC',
    price_difference: 50,
    status: 'completed',
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

  it('no Idempotency-Key header → handler called, X-Idempotent-Replay=false (today\'s behavior preserved)', async () => {
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

  it('replay (same key + same body) → cached body, handler NOT invoked, X-Idempotent-Replay=true (no duplicate return + invoice + stock + JE + CT)', async () => {
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

  it('payload mismatch (same key + tampered refund_amount) → 409, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: {
        ...sampleBody,
        return_items: [{ ...sampleBody.return_items[0], refund_amount: 9999 }],
      },
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
      expect(err.getResponse()).toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS' });
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
    }
    expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
  });

  it('handler throws → lock released, error re-thrown, no cached result', async () => {
    const req = makeMockReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${VALID_KEY}`,
    } as AcquireResult);
    const next = makeFailingNext(new Error('synthetic exchange failure'));
    await expect(
      firstValueFrom(
        (await interceptor.intercept(makeExecutionContext(req, makeMockRes()), next)) as any,
      ),
    ).rejects.toThrow(/synthetic exchange failure/);
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Cache-namespace isolation: the SAME Idempotency-Key sent to
 * `POST /exchanges` AND any of the returns/POS routes must produce
 * DISTINCT cache namespaces. The interceptor uses `req.route.path`
 * so paths are structurally distinct.
 */
describe('namespace isolation: /exchanges vs returns + POS routes', () => {
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
      '/exchanges',
      '/returns',
      '/returns/:id/refund',
      '/returns/:id/approve',
      '/returns/:id/reject',
      '/returns/:id/cancel',
      '/pos/invoices',
      '/pos/invoices/:id/edit',
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
        (await interceptor.intercept(makeExecutionContext(req, makeMockRes()), next)) as any,
      );
    }

    expect(cache.tryAcquireOrReplay).toHaveBeenCalledTimes(distinctPaths.length);
    const invokedPaths = cache.tryAcquireOrReplay.mock.calls.map((c) => c[1]);
    expect(invokedPaths).toEqual(distinctPaths);
    expect(new Set(invokedPaths).size).toBe(distinctPaths.length);
  });
});

/**
 * Wiring assertions: only `exchange` carries the interceptor in
 * this PR. All other ReturnsController POST handlers MUST NOT
 * carry it — deferred to phased PRs.
 */
describe('ReturnsController route-level wiring — PR-FIX-IDEMPOTENCY-EXCHANGES-INVOICE-EDITS', () => {
  it('exchange has IdempotencyInterceptor; siblings do NOT', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ReturnsController],
      providers: [
        {
          provide: ReturnsService,
          useValue: {
            lookupInvoice: jest.fn(),
            create: jest.fn(),
            list: jest.fn(),
            findOne: jest.fn(),
            approve: jest.fn(),
            refund: jest.fn(),
            reject: jest.fn(),
            cancel: jest.fn(),
            createExchange: jest.fn(),
            listExchanges: jest.fn(),
            getExchange: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(ReturnsController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) => i === IdempotencyInterceptor || i?.name === 'IdempotencyInterceptor',
      );
    };

    // ── This PR's target.
    expect(hasInterceptor((controller as any).exchange)).toBe(true);

    // ── refund + cancel — were undecorated when this spec shipped;
    //    PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY (PR-11E)
    //    decorated them. Their dedicated spec
    //    (returns.controller.refund-cancel-idempotency.spec.ts)
    //    owns the positive assertions. Updated here to regression
    //    guards.
    expect(hasInterceptor((controller as any).refund)).toBe(true);
    expect(hasInterceptor((controller as any).cancel)).toBe(true);

    // ── All other ReturnsController POST handlers MUST NOT carry
    //    the interceptor in this PR. (P2: reject is state-only.)
    const undecoratedSiblings: Array<keyof ReturnsController> = [
      'create',
      'approve',
      'reject',
    ];
    for (const name of undecoratedSiblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(false);
    }
  });
});
