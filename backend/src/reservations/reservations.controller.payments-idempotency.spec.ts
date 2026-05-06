/**
 * reservations.controller.payments-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-DEFERRED-APPROVE-FAMILY (Sprint 4 / PR-11F-bis)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /reservations/:id/payments
 *
 * `addPayment` is a multi-stage installment path: INSERTs a
 * `reservation_payments` row + posts JE + CT (cash/bank). Without
 * retry-safety, a duplicate POST creates 2 payment rows + 2 JEs +
 * 2 CTs (overcrediting customer remaining balance and double-
 * charging the cashbox/bank). Same risk profile as
 * `POST /suppliers/:id/pay` (PR-11F) and `POST /purchases/:id/pay`
 * (PR-11D).
 *
 * Module providers were already wired in PR-11E-bis (for `cancel`),
 * so this PR only adds the `@UseInterceptors` decorator on the
 * `addPayment` handler — no module change.
 *
 * Scope:
 *   · `addPayment` (newly decorated) MUST have the interceptor.
 *   · `cancel` MUST stay decorated (PR-11E-bis regression guard).
 *   · `create`, `convert`, `extend` MUST remain undecorated.
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { ReservationsController } from './reservations.controller';
import { ReservationsService } from './reservations.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const RES_ID = 'rsrsrsrs-rsrs-rsrs-rsrs-rsrsrsrsrsrs';
const ROUTE_PATH = '/reservations/:id/payments';

const makeReq = (overrides: Partial<any> = {}) => ({
  method: 'POST',
  url: `/reservations/${RES_ID}/payments`,
  originalUrl: `/reservations/${RES_ID}/payments`,
  route: { path: ROUTE_PATH },
  headers: {}, body: {}, params: { id: RES_ID },
  user: { userId: 'cashier-AAA', id: 'cashier-AAA' },
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
  amount: 500,
  payment_method: 'cash' as const,
  notes: 'قسط ثانٍ على الحجز',
};
const sampleSuccess = {
  reservation_id: RES_ID,
  payment_id: 'pay-AAA',
  je_id: 'je-AAA',
  remaining_balance: 1500,
};

describe('IdempotencyInterceptor on POST /reservations/:id/payments — PR-FIX-IDEMPOTENCY-DEFERRED-APPROVE-FAMILY', () => {
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

  it('replay → cached body, handler NOT invoked (no duplicate payment row/JE/CT)', async () => {
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

  it('payload mismatch (different amount) → 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', async () => {
    const req = makeReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { ...sampleBody, amount: 9999 },
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
          ctx(req, makeRes()), failNext(new Error('synthetic reservation addPayment failure')),
        )) as any,
      ),
    ).rejects.toThrow(/synthetic reservation addPayment failure/);
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe('namespace isolation: reservation payments vs other reservation routes', () => {
  it('keyed calls invoke tryAcquireOrReplay with route-distinct paths (payments NOT collide with cancel/create/convert/extend)', async () => {
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
      ROUTE_PATH,                          // payments (this PR)
      '/reservations/:id/cancel',          // PR-11E-bis
      '/reservations',                     // create
      '/reservations/:id/convert',
      '/reservations/:id/extend',
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

describe('ReservationsController route-level wiring — PR-FIX-IDEMPOTENCY-DEFERRED-APPROVE-FAMILY', () => {
  it('addPayment decorated (PR-11F-bis); cancel decorated (PR-11E-bis regression guard); convert decorated (PR-11G); create + extend NOT decorated', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ReservationsController],
      providers: [
        {
          provide: ReservationsService,
          useValue: {
            cancel: jest.fn(),
            create: jest.fn(),
            list: jest.fn(),
            findOne: jest.fn(),
            addPayment: jest.fn(),
            convert: jest.fn(),
            extend: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(ReservationsController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) => i === IdempotencyInterceptor || i?.name === 'IdempotencyInterceptor',
      );
    };

    // ── PR-11F-bis target.
    expect(hasInterceptor((controller as any).addPayment)).toBe(true);

    // ── Regression guard: cancel was decorated in PR-11E-bis and
    //    must remain decorated.
    expect(hasInterceptor((controller as any).cancel)).toBe(true);

    // ── PR-11G added decoration on convert (final true financial/
    //    stock idempotency gap closer per Sprint 4 rollup audit).
    //    Track here so this sibling-list test stays in sync; the
    //    dedicated convert spec pins the full interceptor contract.
    expect(hasInterceptor((controller as any).convert)).toBe(true);

    // ── Out-of-scope siblings stay undecorated. `create` only
    //    INSERTs reservation + items + deposit row without posting
    //    JE/CT (the deposit becomes JE/CT only at the now-protected
    //    `:id/payments` or `:id/convert` paths). `extend` is a
    //    date-field UPDATE only.
    const undecoratedSiblings: Array<keyof ReservationsController> = [
      'create', 'extend',
    ];
    for (const name of undecoratedSiblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(false);
    }
  });
});
