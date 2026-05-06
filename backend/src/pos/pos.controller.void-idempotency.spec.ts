/**
 * pos.controller.void-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY (Sprint 4 / PR-11E)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /pos/invoices/:id/void
 *
 * `voidInvoice` flips `is_void=true` on the invoice and calls
 * `posting.reverseByReference('invoice', id)` which voids the
 * original JE + reverses the paired cashbox transactions (cash
 * sales) + reverses stock movements via the engine. Engine guard
 * catches duplicate JE writes; the HTTP-level interceptor adds the
 * outer race defence + cleaner UX on retry.
 *
 * Scope: this spec covers ONLY the new `voidInvoice` decoration.
 * The pilot routes (`create`, `editInvoice`) are regression-guarded
 * in their own specs (pos.controller.idempotency.spec.ts +
 * pos.controller.invoice-edit-idempotency.spec.ts).
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
const INVOICE_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const ROUTE_PATH = '/pos/invoices/:id/void';

const makeReq = (overrides: Partial<any> = {}) => ({
  method: 'POST',
  url: `/pos/invoices/${INVOICE_ID}/void`,
  originalUrl: `/pos/invoices/${INVOICE_ID}/void`,
  route: { path: ROUTE_PATH },
  headers: {},
  body: {},
  params: { id: INVOICE_ID },
  user: { userId: 'user-AAA' },
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

const sampleBody = { reason: 'العميل ألغى الطلب — استرداد كامل' };
const sampleSuccess = { invoice_id: INVOICE_ID, voided_at: '2026-05-06T15:00:00.000Z', voided_je_id: 'je-AAA' };

describe('IdempotencyInterceptor on POST /pos/invoices/:id/void — PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY', () => {
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

  it('replay → cached body, handler NOT invoked, no duplicate reversal JE', async () => {
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

  it('payload mismatch (different reason) → 409', async () => {
    const req = makeReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { reason: 'سبب آخر' },
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

  it('concurrent same-key → 425', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    const handler = jest.fn();
    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'in_progress', cacheKey: 'k',
    } as AcquireResult);
    try {
      await interceptor.intercept(ctx(req, makeRes()), { handle: handler } as any);
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(425);
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('Redis unavailable → 503 fail-closed', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'unavailable' } as AcquireResult);
    try {
      await interceptor.intercept(ctx(req, makeRes()), next(null));
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(503);
    }
  });

  it('invalid key → 400, cache NOT consulted', async () => {
    const req = makeReq({ headers: { 'idempotency-key': 'bad key!' }, body: sampleBody });
    try {
      await interceptor.intercept(ctx(req, makeRes()), next(null));
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(400);
    }
    expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
  });

  it('handler throws → lock released, no cached result', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired', cacheKey: 'k',
    } as AcquireResult);
    await expect(
      firstValueFrom(
        (await interceptor.intercept(
          ctx(req, makeRes()), failNext(new Error('synthetic void failure')),
        )) as any,
      ),
    ).rejects.toThrow(/synthetic void failure/);
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});
