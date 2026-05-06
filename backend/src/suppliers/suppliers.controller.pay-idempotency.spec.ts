/**
 * suppliers.controller.pay-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-APPROVE-FAMILY (Sprint 4 / PR-11F)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /suppliers/:id/pay
 *
 * `payGeneral` is a general supplier payment (not tied to a specific
 * invoice — different from `POST /purchases/:id/pay` which IS
 * invoice-tied, and from `POST /cash-desk/supplier-payments` which
 * was protected since PR #283). INSERTs `supplier_payments` row +
 * posts JE + CT (cash/bank). Same risk as the other two pay paths.
 *
 * This is a NEW controller for the idempotency family — PR-11F adds
 * the providers to suppliers.module.ts.
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { SuppliersController } from './suppliers.controller';
import { SuppliersService } from './suppliers.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SUPPLIER_ID = 'sssssssss-sss-sss-sss-sssssssssssss'.slice(0, 36);
const ROUTE_PATH = '/suppliers/:id/pay';

const makeReq = (overrides: Partial<any> = {}) => ({
  method: 'POST',
  url: `/suppliers/${SUPPLIER_ID}/pay`,
  originalUrl: `/suppliers/${SUPPLIER_ID}/pay`,
  route: { path: ROUTE_PATH },
  headers: {}, body: {}, params: { id: SUPPLIER_ID },
  user: { userId: 'admin-AAA', id: 'admin-AAA' },
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
  amount: 3000,
  payment_method: 'cash' as const,
  notes: 'دفعة على الحساب',
};
const sampleSuccess = { payment_id: 'pay-AAA', je_id: 'je-AAA' };

describe('IdempotencyInterceptor on POST /suppliers/:id/pay — PR-FIX-IDEMPOTENCY-APPROVE-FAMILY', () => {
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

  it('no header → handler called', async () => {
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
      kind: 'acquired', cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${VALID_KEY}`,
    } as AcquireResult);
    res.statusCode = 201;
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
      cached: { status: 201, body: sampleSuccess, payload_hash: 'h', cached_at: 't' } as CachedResponse,
    } as AcquireResult);
    const result = await firstValueFrom(
      (await interceptor.intercept(ctx(req, res), { handle: handler } as any)) as any,
    );
    expect(result).toEqual(sampleSuccess);
    expect(handler).not.toHaveBeenCalled();
  });

  it('payload mismatch → 409', async () => {
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
    } catch (err: any) { expect(err.getStatus()).toBe(409); }
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

  it('Redis unavailable → 503', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'unavailable' } as AcquireResult);
    try {
      await interceptor.intercept(ctx(req, makeRes()), next(null));
      throw new Error('expected HttpException');
    } catch (err: any) { expect(err.getStatus()).toBe(503); }
  });

  it('invalid key → 400', async () => {
    const req = makeReq({ headers: { 'idempotency-key': 'bad!' }, body: sampleBody });
    try {
      await interceptor.intercept(ctx(req, makeRes()), next(null));
      throw new Error('expected HttpException');
    } catch (err: any) { expect(err.getStatus()).toBe(400); }
    expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
  });

  it('handler throws → lock released', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'acquired', cacheKey: 'k' } as AcquireResult);
    await expect(
      firstValueFrom(
        (await interceptor.intercept(
          ctx(req, makeRes()), failNext(new Error('synthetic suppliers pay failure')),
        )) as any,
      ),
    ).rejects.toThrow(/synthetic suppliers pay failure/);
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe('SuppliersController route-level wiring — PR-FIX-IDEMPOTENCY-APPROVE-FAMILY', () => {
  it('pay decorated; CRUD siblings NOT decorated', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [SuppliersController],
      providers: [
        {
          provide: SuppliersService,
          useValue: {
            payGeneral: jest.fn(),
            list: jest.fn(),
            outstanding: jest.fn(),
            analytics: jest.fn(),
            upcomingPayments: jest.fn(),
            find: jest.fn(),
            ledger: jest.fn(),
            summary: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
            supplierPayments: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(SuppliersController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) => i === IdempotencyInterceptor || i?.name === 'IdempotencyInterceptor',
      );
    };

    // ── This PR's target.
    expect(hasInterceptor((controller as any).pay)).toBe(true);

    // ── CRUD/read siblings remain undecorated.
    const undecoratedSiblings: Array<keyof SuppliersController> = [
      'list', 'find', 'create', 'update', 'remove', 'payments',
    ];
    for (const name of undecoratedSiblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(false);
    }
  });
});
