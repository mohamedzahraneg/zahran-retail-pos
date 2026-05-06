/**
 * accounting.controller.approve-family-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-APPROVE-FAMILY (Sprint 4 / PR-11F)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /accounting/expenses/:id/approve              (P1)
 *   · POST /accounting/expenses/edit-requests/:id/approve (P0)
 *   · POST /accounting/approvals/:id/approve              (P0)
 *
 * All three approve paths produce JE/CT side effects:
 *   · approveExpense: postViaEngine → JE + CT
 *   · approveEditRequest: void old JE + reverse old CT + post new JE + new CT
 *   · approval.decide('approved'): when LAST pending approval flips,
 *     calls engine.recordExpense → JE + CT
 *
 * PR-10A added `assertExpenseInvariants` guards at all 3 service
 * entries; the HTTP interceptor adds outer race defence.
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
const ENTITY_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';

const ROUTE_APPROVE_EXPENSE      = '/accounting/expenses/:id/approve';
const ROUTE_APPROVE_EDIT_REQUEST = '/accounting/expenses/edit-requests/:id/approve';
const ROUTE_APPROVAL_APPROVE     = '/accounting/approvals/:id/approve';

function makeReq(routePath: string, overrides: Partial<any> = {}) {
  const url = routePath.replace(':id', ENTITY_ID);
  return {
    method: 'POST', url, originalUrl: url, route: { path: routePath },
    headers: {}, body: {}, params: { id: ENTITY_ID },
    user: { userId: 'admin-AAA', sub: 'admin-AAA', id: 'admin-AAA', permissions: [] },
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
  ['approveExpense',     ROUTE_APPROVE_EXPENSE,      {},                                { id: ENTITY_ID, is_approved: true, je_id: 'je-AAA' }],
  ['approveEditRequest', ROUTE_APPROVE_EDIT_REQUEST, {},                                { request_id: ENTITY_ID, voided_je_id: 'je-OLD', applied_je_id: 'je-NEW' }],
  ['approval.approve',   ROUTE_APPROVAL_APPROVE,     { note: 'موافق على الاعتماد' },    { status: 'approved', remaining_pending: 0, expense_id: 'exp-AAA' }],
])(
  'IdempotencyInterceptor on %s — PR-FIX-IDEMPOTENCY-APPROVE-FAMILY',
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
        body: { ...(sampleBody as object), tampered: true },
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
      const req = makeReq(routePath, { headers: { 'idempotency-key': 'bad!' }, body: sampleBody });
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

describe('namespace isolation — accounting expense approve vs edit-request approve vs approval approve/reject', () => {
  it('keyed calls produce distinct cache namespaces across the approve family', async () => {
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
      ROUTE_APPROVE_EXPENSE,
      ROUTE_APPROVE_EDIT_REQUEST,
      ROUTE_APPROVAL_APPROVE,
      '/accounting/approvals/:id/reject',
      '/accounting/expenses/edit-requests/:id/reject',
      '/accounting/expenses/edit-requests/:id/cancel',
      '/accounting/expenses',
      '/accounting/expenses/daily',
    ];
    for (const path of distinctPaths) {
      const req = { method: 'POST', url: path, originalUrl: path, route: { path }, headers: { 'idempotency-key': VALID_KEY }, body: { x: 1 } };
      await firstValueFrom((await interceptor.intercept(ctx(req, makeRes()), next({ ok: true }))) as any);
    }
    const invokedPaths = cache.tryAcquireOrReplay.mock.calls.map((c) => c[1]);
    expect(invokedPaths).toEqual(distinctPaths);
    expect(new Set(invokedPaths).size).toBe(distinctPaths.length);
  });
});
