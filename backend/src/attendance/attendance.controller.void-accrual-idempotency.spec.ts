/**
 * attendance.controller.void-accrual-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-DEFERRED-VOID-CANCEL-ROUTES (Sprint 4 / PR-11E-bis)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /attendance/admin/void-accrual/:payable_day_id
 *
 * `adminVoidWageAccrual` calls plpgsql
 * `fn_void_employee_wage_accrual` which voids the wage accrual +
 * posts a reversal JE inside the function. The function is presumed
 * idempotent on `payable_day_id` state, but a duplicate POST during
 * a network retry could race the state check. The HTTP-level
 * interceptor adds the outer race defence + cleaner UX on retry.
 *
 * Scope (audit-defined):
 *   · `adminVoidAccrual` (newly decorated) MUST have the interceptor.
 *   · ALL other AttendanceController POST/PATCH handlers (clockIn,
 *     clockOut, adjust, adminClockIn/Out, adminMarkPayableDay,
 *     adminApproveWage, adminApproveWageOverride, payWage) MUST
 *     remain undecorated — out of scope for this PR.
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { AttendanceController } from './attendance.controller';
import { AttendanceService } from './attendance.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const PAYABLE_DAY_ID = 'pdpdpdpd-pdpd-pdpd-pdpd-pdpdpdpdpdpd';
const ROUTE_PATH = '/attendance/admin/void-accrual/:payable_day_id';

const makeReq = (overrides: Partial<any> = {}) => ({
  method: 'POST',
  url: `/attendance/admin/void-accrual/${PAYABLE_DAY_ID}`,
  originalUrl: `/attendance/admin/void-accrual/${PAYABLE_DAY_ID}`,
  route: { path: ROUTE_PATH },
  headers: {}, body: {}, params: { payable_day_id: PAYABLE_DAY_ID },
  user: { userId: 'admin-AAA' },
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

const sampleBody = { reason: 'تصحيح خطأ في احتساب اليومية' };
const sampleSuccess = { payable_day_id: PAYABLE_DAY_ID };

describe('IdempotencyInterceptor on POST /attendance/admin/void-accrual/:payable_day_id — PR-FIX-IDEMPOTENCY-DEFERRED-VOID-CANCEL-ROUTES', () => {
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
    expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'true');
  });

  it('payload mismatch → 409', async () => {
    const req = makeReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { reason: 'سبب آخر مختلف' },
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
    } catch (err: any) {
      expect(err.getStatus()).toBe(425);
    }
  });

  it('Redis unavailable → 503', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'unavailable' } as AcquireResult);
    try {
      await interceptor.intercept(ctx(req, makeRes()), next(null));
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(503);
    }
  });

  it('invalid key → 400', async () => {
    const req = makeReq({ headers: { 'idempotency-key': 'bad!' }, body: sampleBody });
    try {
      await interceptor.intercept(ctx(req, makeRes()), next(null));
      throw new Error('expected HttpException');
    } catch (err: any) {
      expect(err.getStatus()).toBe(400);
    }
    expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
  });

  it('handler throws → lock released', async () => {
    const req = makeReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'acquired', cacheKey: 'k' } as AcquireResult);
    await expect(
      firstValueFrom(
        (await interceptor.intercept(
          ctx(req, makeRes()), failNext(new Error('synthetic void-accrual failure')),
        )) as any,
      ),
    ).rejects.toThrow(/synthetic void-accrual failure/);
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe('namespace isolation: void-accrual vs other attendance admin routes', () => {
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
      '/attendance/clock-in',
      '/attendance/clock-out',
      '/attendance/admin/clock-in',
      '/attendance/admin/clock-out',
      '/attendance/admin/mark-payable-day',
      '/attendance/admin/approve-wage/:attendance_id',
      '/attendance/admin/approve-wage-override',
      '/attendance/admin/pay-wage',
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

describe('AttendanceController route-level wiring — PR-FIX-IDEMPOTENCY-DEFERRED-VOID-CANCEL-ROUTES', () => {
  it('adminVoidAccrual decorated; ALL other AttendanceController POST/PATCH handlers do NOT', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AttendanceController],
      providers: [
        {
          provide: AttendanceService,
          useValue: {
            adminVoidWageAccrual: jest.fn(),
            // P2 / out-of-scope handlers
            clockIn: jest.fn(),
            clockOut: jest.fn(),
            myToday: jest.fn(),
            myPayableDays: jest.fn(),
            myList: jest.fn(),
            list: jest.fn(),
            summary: jest.fn(),
            adjust: jest.fn(),
            adminClockIn: jest.fn(),
            adminClockOut: jest.fn(),
            adminMarkPayableDay: jest.fn(),
            adminApproveWageFromAttendance: jest.fn(),
            adminApproveWageOverride: jest.fn(),
            payWage: jest.fn(),
            payableDays: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(AttendanceController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) => i === IdempotencyInterceptor || i?.name === 'IdempotencyInterceptor',
      );
    };

    // ── This PR's target.
    expect(hasInterceptor((controller as any).adminVoidAccrual)).toBe(true);

    // ── All other POST/PATCH handlers in AttendanceController MUST
    //    remain undecorated — out of scope per PR-11E-bis spec.
    const undecoratedSiblings: Array<keyof AttendanceController> = [
      'clockIn',
      'clockOut',
      'adjust',
      'adminClockIn',
      'adminClockOut',
      'adminMarkPayableDay',
      'adminApproveWage',
      'adminApproveWageOverride',
      'payWage',
    ];
    for (const name of undecoratedSiblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(false);
    }
  });
});
