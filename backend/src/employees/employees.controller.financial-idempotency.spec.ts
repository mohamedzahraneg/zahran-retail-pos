/**
 * employees.controller.financial-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-EMPLOYEE-PAYROLL-P0 (Sprint 4 / PR-11D)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on the 3
 * P0 financial routes in EmployeesController:
 *
 *   · POST /employees/:id/bonuses     — INSERT employee_bonuses →
 *                                       trigger → JE
 *   · POST /employees/:id/deductions  — INSERT employee_deductions →
 *                                       trigger → JE
 *   · POST /employees/:id/settlements — INSERT employee_settlements
 *                                       (BIGSERIAL) → engine.
 *                                       recordTransaction → JE + CT
 *                                       (cash/bank). Engine guard
 *                                       BYPASSED because the
 *                                       reference_id is derived from
 *                                       the BIGSERIAL id which is
 *                                       fresh on every POST.
 *
 * Strategy:
 *   · Mount the real EmployeesController with a stubbed
 *     EmployeesService.
 *   · Mount the real IdempotencyInterceptor.
 *   · Mock IdempotencyCacheService so each test controls the cache
 *     branch deterministically.
 *
 * Scope (audit-defined):
 *   · `addBonus`, `addDeduction`, `addSettlement` (newly decorated)
 *     MUST have the interceptor.
 *   · The 2 P1 request routes (`submitRequest`,
 *     `submitAdvanceRequest`) MUST NOT carry the interceptor —
 *     deferred per the PR-11 audit (P1 cosmetic, no financial
 *     double-write).
 *   · The P2 routes (`decide`, `updateProfile`) MUST NOT carry the
 *     interceptor — naturally state-guarded.
 *   · GET handlers + read-only routes MUST NOT carry the interceptor.
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const EMP_ID = 'eeeeeeee-1111-1111-1111-111111111111';

const ROUTE_BONUS      = '/employees/:id/bonuses';
const ROUTE_DEDUCTION  = '/employees/:id/deductions';
const ROUTE_SETTLEMENT = '/employees/:id/settlements';

function makeMockReq(routePath: string, overrides: Partial<any> = {}) {
  const url = routePath.replace(':id', EMP_ID);
  return {
    method: 'POST',
    url,
    originalUrl: url,
    route: { path: routePath },
    headers: {},
    body: {},
    params: { id: EMP_ID },
    user: { userId: 'user-AAA', permissions: [] },
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
 * Per-route interceptor matrix. The 3 routes share the same
 * interceptor logic, so we run the full matrix once each via
 * describe.each, with realistic per-route sample bodies.
 * ──────────────────────────────────────────────────────────────────── */

describe.each([
  [
    'addBonus',
    ROUTE_BONUS,
    { amount: 250, kind: 'bonus', note: 'حافز شهر مايو', bonus_date: '2026-05-06' },
    { id: 'bon-AAA', user_id: EMP_ID, amount: 250, kind: 'bonus' },
  ],
  [
    'addDeduction',
    ROUTE_DEDUCTION,
    { amount: 100, reason: 'تأخير', deduction_date: '2026-05-06' },
    { id: 'ded-AAA', user_id: EMP_ID, amount: 100, reason: 'تأخير' },
  ],
  [
    'addSettlement',
    ROUTE_SETTLEMENT,
    {
      amount: 500,
      method: 'cash',
      cashbox_id: 'cb-AAA',
      settlement_date: '2026-05-06',
      notes: 'تسوية شهرية',
    },
    { id: 1, user_id: EMP_ID, amount: 500, method: 'cash', journal_entry_id: 'je-AAA' },
  ],
])(
  'IdempotencyInterceptor on %s — PR-FIX-IDEMPOTENCY-EMPLOYEE-PAYROLL-P0',
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

    it(`[${label}] payload mismatch (tampered amount) → 409, handler NOT invoked`, async () => {
      const req = makeMockReq(routePath, {
        headers: { 'idempotency-key': VALID_KEY },
        body: { ...(sampleBody as object), amount: 9999 },
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
 * Cache-namespace isolation across the 4 P0 employee/payroll routes.
 * ──────────────────────────────────────────────────────────────────── */

describe('namespace isolation: employee/payroll P0 routes', () => {
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
      ROUTE_BONUS,
      ROUTE_DEDUCTION,
      ROUTE_SETTLEMENT,
      '/payroll',
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

/* ────────────────────────────────────────────────────────────────────
 * Wiring assertions:
 *   · 3 P0 financial routes decorated.
 *   · 2 P1 request routes (submitRequest, submitAdvanceRequest) NOT
 *     decorated — deferred per audit.
 *   · P2 routes (decide, updateProfile) NOT decorated.
 *   · Read-only / task / dashboard routes NOT decorated.
 * ──────────────────────────────────────────────────────────────────── */

describe('EmployeesController route-level wiring — PR-FIX-IDEMPOTENCY-EMPLOYEE-PAYROLL-P0', () => {
  it('addBonus + addDeduction + addSettlement decorated; P1 request + P2 decide/profile + GETs NOT decorated', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EmployeesController],
      providers: [
        {
          provide: EmployeesService,
          useValue: {
            // P0 — this PR's targets
            addBonus: jest.fn(),
            addDeduction: jest.fn(),
            recordSettlement: jest.fn(),
            // P1 — must remain undecorated (deferred)
            submitRequest: jest.fn(),
            submitAdvanceRequest: jest.fn(),
            // P2 — naturally state-guarded
            decideRequest: jest.fn(),
            updateProfile: jest.fn(),
            // Other non-financial mutating routes
            createTask: jest.fn(),
            cancelTask: jest.fn(),
            // Read paths (sample)
            myDashboard: jest.fn(),
            myTasks: jest.fn(),
            ackTask: jest.fn(),
            completeTask: jest.fn(),
            myRequests: jest.fn(),
            teamOverview: jest.fn(),
            listPendingRequests: jest.fn(),
            listDisbursableAdvanceRequests: jest.fn(),
            listBonuses: jest.fn(),
            listDeductions: jest.fn(),
            financialLedger: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(EmployeesController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) => i === IdempotencyInterceptor || i?.name === 'IdempotencyInterceptor',
      );
    };

    // ── This PR's 3 P0 targets.
    expect(hasInterceptor((controller as any).addBonus)).toBe(true);
    expect(hasInterceptor((controller as any).addDeduction)).toBe(true);
    expect(hasInterceptor((controller as any).addSettlement)).toBe(true);

    // ── P1 request routes — explicitly excluded by PR-11D scope.
    //    They only create pending request rows (no financial side
    //    effect until manager approves + accountant disburses), so
    //    duplicates are cosmetic. Will be addressed in a later PR.
    expect(hasInterceptor((controller as any).submitRequest)).toBe(false);
    expect(hasInterceptor((controller as any).submitAdvanceRequest)).toBe(false);

    // ── P2 — naturally state-guarded; no interceptor needed.
    expect(hasInterceptor((controller as any).decide)).toBe(false);
    expect(hasInterceptor((controller as any).updateProfile)).toBe(false);

    // ── Non-financial mutating routes — out of scope.
    expect(hasInterceptor((controller as any).createTask)).toBe(false);
    expect(hasInterceptor((controller as any).cancelTask)).toBe(false);

    // ── GET handlers — read-only, never decorated.
    const readOnlyHandlers: Array<keyof EmployeesController> = [
      'myDashboard',
      'myTasks',
      'myRequests',
      'team',
      'pending',
      'listDisbursableAdvanceRequests',
      'bonuses',
      'deductions',
      'userDashboard',
      'myLedger',
      'ledger',
    ];
    for (const name of readOnlyHandlers) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(false);
    }
  });
});
