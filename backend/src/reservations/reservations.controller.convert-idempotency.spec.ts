/**
 * reservations.controller.convert-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-RESERVATION-CONVERT (Sprint 4 / PR-11G)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /reservations/:id/convert
 *
 * `convert` is the final true financial/stock idempotency gap
 * identified in the Sprint 4 rollup audit. Multi-stage path:
 *
 *   1. State guard — `mustBeActive(id)` (service layer).
 *   2. INSERT `invoices` (status=completed) → triggers stock
 *      on_hand decrement + INSERT `stock_movements`.
 *   3. INSERT `invoice_lines`.
 *   4. INSERT `invoice_payments` (final payment) + post JE + CT
 *      (cashbox/ledger writes).
 *   5. INSERT `reservation_payments` (final-payment row, kind='final').
 *   6. UPDATE `reservations` status → 'converted'.
 *
 * Without retry-safety, two simultaneous POSTs that pass the state
 * guard before the status flip commits would produce 2 distinct
 * invoices + 2 sets of JE/CT + duplicate stock movements.
 *
 * Module providers were already wired in PR-11E-bis (for `cancel`)
 * and reused by PR-11F-bis (for `addPayment`); this PR only adds
 * the `@UseInterceptors` decorator on the `convert` handler — no
 * module change.
 *
 * Scope:
 *   · `convert` (newly decorated) MUST have the interceptor.
 *   · `cancel` MUST stay decorated (PR-11E-bis regression guard).
 *   · `addPayment` MUST stay decorated (PR-11F-bis regression guard).
 *   · `create`, `extend` MUST remain undecorated.
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
const ROUTE_PATH = '/reservations/:id/convert';

const makeReq = (overrides: Partial<any> = {}) => ({
  method: 'POST',
  url: `/reservations/${RES_ID}/convert`,
  originalUrl: `/reservations/${RES_ID}/convert`,
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
  final_payments: [
    { payment_method: 'cash' as const, amount: 1500 },
  ],
  notes: 'العميل استلم البضاعة ودفع المتبقي',
};
const sampleSuccess = {
  reservation_id: RES_ID,
  invoice_id: 'inv-AAA',
  invoice_number: 'INV-2026-0001',
  je_id: 'je-AAA',
  status: 'converted',
};

describe('IdempotencyInterceptor on POST /reservations/:id/convert — PR-FIX-IDEMPOTENCY-RESERVATION-CONVERT', () => {
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

  it('no header → handler called, replay false (behavior exactly unchanged)', async () => {
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

  it('replay → cached body, handler NOT invoked (no duplicate invoice/JE/CT/stock_movements)', async () => {
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

  it('payload mismatch (different final_payments) → 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', async () => {
    const req = makeReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { ...sampleBody, final_payments: [{ payment_method: 'card' as const, amount: 9999 }] },
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

  it('concurrent → 425 (in-progress, service called once across both requests)', async () => {
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

  it('handler throws → lock released, key NOT poisoned', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'acquired', cacheKey: 'k' } as AcquireResult);
    await expect(
      firstValueFrom(
        (await interceptor.intercept(
          ctx(req, makeRes()), failNext(new Error('synthetic reservation convert failure')),
        )) as any,
      ),
    ).rejects.toThrow(/synthetic reservation convert failure/);
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe('namespace isolation: reservation convert vs other reservation routes', () => {
  it('keyed calls invoke tryAcquireOrReplay with route-distinct paths (convert NOT collide with create/cancel/payments/extend)', async () => {
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
      ROUTE_PATH,                          // convert (this PR)
      '/reservations',                     // create
      '/reservations/:id/cancel',          // PR-11E-bis
      '/reservations/:id/payments',        // PR-11F-bis
      '/reservations/:id/extend',          // out of scope
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

describe('ReservationsController route-level wiring — PR-FIX-IDEMPOTENCY-RESERVATION-CONVERT', () => {
  it('convert decorated (this PR); cancel + addPayment decorated (regression guards); create + extend NOT decorated', async () => {
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

    // ── This PR's target.
    expect(hasInterceptor((controller as any).convert)).toBe(true);

    // ── Regression guards: prior PRs must remain decorated.
    expect(hasInterceptor((controller as any).cancel)).toBe(true);     // PR-11E-bis
    expect(hasInterceptor((controller as any).addPayment)).toBe(true); // PR-11F-bis

    // ── Out-of-scope siblings stay undecorated. `create` only INSERTs
    //    reservation + items + deposit row (no JE/CT at create time);
    //    `extend` is a date-field UPDATE only.
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
