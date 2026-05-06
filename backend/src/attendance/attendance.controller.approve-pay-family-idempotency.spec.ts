/**
 * attendance.controller.approve-pay-family-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-APPROVE-FAMILY (Sprint 4 / PR-11F)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /attendance/admin/approve-wage/:attendance_id   (P1)
 *   · POST /attendance/admin/approve-wage-override         (P0 multi-stage)
 *   · POST /attendance/admin/pay-wage                       (P0 settlement+JE+CT)
 *
 * `payWage` shares the same BIGSERIAL bypass risk as PR-11D's
 * `POST /employees/:id/settlements` — both call EmployeesService.
 * recordSettlement which derives reference_id from the BIGSERIAL
 * settlement id, so duplicate POSTs produce 2 rows + 2 JEs + 2 CTs.
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
const ATT_ID = 'aaaaaaaa-bbbb-cccc-dddd-attatatattat';
const USER_ID = '11111111-1111-1111-1111-111111111111';

const ROUTE_APPROVE_WAGE          = '/attendance/admin/approve-wage/:attendance_id';
const ROUTE_APPROVE_WAGE_OVERRIDE = '/attendance/admin/approve-wage-override';
const ROUTE_PAY_WAGE              = '/attendance/admin/pay-wage';

function makeReq(routePath: string, overrides: Partial<any> = {}) {
  // Substitute :attendance_id when present
  const url = routePath.replace(':attendance_id', ATT_ID);
  return {
    method: 'POST', url, originalUrl: url, route: { path: routePath },
    headers: {}, body: {},
    params: routePath.includes(':attendance_id') ? { attendance_id: ATT_ID } : {},
    user: { userId: 'admin-AAA', permissions: [] },
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
  [
    'adminApproveWage',
    ROUTE_APPROVE_WAGE,
    {},
    { payable_day_id: 'pd-AAA', je_id: 'je-AAA' },
  ],
  [
    'adminApproveWageOverride',
    ROUTE_APPROVE_WAGE_OVERRIDE,
    {
      user_id: USER_ID,
      work_date: '2026-05-06',
      override_type: 'full_day' as const,
      approved_amount: 200,
      approval_reason: 'الموظف عمل اليوم بالكامل وفق ساعات العمل العادية',
    },
    { payable_day_id: 'pd-BBB', je_id: 'je-BBB' },
  ],
  [
    'payWage',
    ROUTE_PAY_WAGE,
    {
      user_id: USER_ID,
      amount: 1500,
      cashbox_id: 'cb-AAA',
      excess_handling: 'advance' as const,
    },
    { settlement_id: 1, je_id: 'je-CCC' },
  ],
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

    it(`[${label}] no header → handler called`, async () => {
      const req = makeReq(routePath), res = makeRes();
      const result = await firstValueFrom(
        (await interceptor.intercept(ctx(req, res), next(sampleSuccess))) as any,
      );
      expect(result).toEqual(sampleSuccess);
      expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
    });

    it(`[${label}] first keyed → cacheResult invoked`, async () => {
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
      } catch (err: any) { expect(err.getStatus()).toBe(409); }
      expect(handler).not.toHaveBeenCalled();
    });

    it(`[${label}] concurrent → 425`, async () => {
      const req = makeReq(routePath, { headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
      cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'in_progress', cacheKey: 'k' } as AcquireResult);
      try {
        await interceptor.intercept(ctx(req, makeRes()), next(null));
        throw new Error('expected HttpException');
      } catch (err: any) { expect(err.getStatus()).toBe(425); }
    });

    it(`[${label}] Redis unavailable → 503`, async () => {
      const req = makeReq(routePath, { headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
      cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'unavailable' } as AcquireResult);
      try {
        await interceptor.intercept(ctx(req, makeRes()), next(null));
        throw new Error('expected HttpException');
      } catch (err: any) { expect(err.getStatus()).toBe(503); }
    });

    it(`[${label}] invalid key → 400`, async () => {
      const req = makeReq(routePath, { headers: { 'idempotency-key': 'bad!' }, body: sampleBody });
      try {
        await interceptor.intercept(ctx(req, makeRes()), next(null));
        throw new Error('expected HttpException');
      } catch (err: any) { expect(err.getStatus()).toBe(400); }
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

describe('namespace isolation — attendance approve-wage vs override vs pay-wage vs void-accrual', () => {
  it('all 4 paths produce distinct cache namespaces', async () => {
    const cache = {
      tryAcquireOrReplay: jest.fn().mockResolvedValue({ kind: 'acquired', cacheKey: 'k' } as AcquireResult),
      cacheResult: jest.fn(), releaseLock: jest.fn(),
      isAvailable: jest.fn(), buildCacheKey: jest.fn(),
      onModuleInit: jest.fn(), onModuleDestroy: jest.fn(), setClientForTesting: jest.fn(),
    } as any as jest.Mocked<IdempotencyCacheService>;
    const interceptor = new IdempotencyInterceptor(cache);
    const distinctPaths = [
      ROUTE_APPROVE_WAGE,
      ROUTE_APPROVE_WAGE_OVERRIDE,
      ROUTE_PAY_WAGE,
      '/attendance/admin/void-accrual/:payable_day_id',
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
