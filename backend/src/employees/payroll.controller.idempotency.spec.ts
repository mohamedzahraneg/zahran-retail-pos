/**
 * payroll.controller.idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-EMPLOYEE-PAYROLL-P0 (Sprint 4 / PR-11D)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /payroll
 *
 * `create` is a dispatched endpoint that delegates to:
 *   · `addBonus`        when `dto.type='bonus'`     → P0 (trigger JE)
 *   · `addDeduction`    when `dto.type='deduction'` → P0 (trigger JE)
 *   · `recordSettlement` when `dto.type='payout'`   → P0 (engine JE + CT)
 *   · throws 400        when `dto.type='wage'`      → no idempotency concern
 *
 * Every delegate path produces JEs without an application-level
 * (reference_type, reference_id) anchor that could survive a
 * duplicate POST, so the HTTP-level interceptor is the correct
 * outer defence.
 *
 * Strategy:
 *   · Mount the real PayrollController with stubbed DataSource +
 *     EmployeesService.
 *   · Mount the real IdempotencyInterceptor.
 *   · Mock IdempotencyCacheService deterministically.
 *
 * Scope (audit-defined):
 *   · `create` (newly decorated) MUST have the interceptor.
 *   · `update` (PATCH narrative-only) MUST NOT carry it — narrative
 *     UPDATEs are naturally idempotent.
 *   · `voidTxn` (DELETE) MUST NOT carry it — void/cancel family is
 *     deferred to PR-11E per the PR-11 audit master plan.
 *   · GET handlers (balances, list, byEmployee) MUST NOT carry it —
 *     read-only.
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { PayrollController } from './payroll.controller';
import { EmployeesService } from './employees.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ROUTE_PATH = '/payroll';

function makeMockReq(overrides: Partial<any> = {}) {
  return {
    method: 'POST',
    url: ROUTE_PATH,
    originalUrl: ROUTE_PATH,
    route: { path: ROUTE_PATH },
    headers: {},
    body: {},
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

describe('IdempotencyInterceptor on POST /payroll — PR-FIX-IDEMPOTENCY-EMPLOYEE-PAYROLL-P0', () => {
  let interceptor: IdempotencyInterceptor;
  let cache: jest.Mocked<IdempotencyCacheService>;

  // Realistic body: bonus payout (one of the 3 active dispatch
  // branches; the other 2 — deduction/payout — share identical
  // interceptor behaviour since the interceptor sits BEFORE the
  // dispatch).
  const sampleBody = {
    employee_id: 'eeeeeeee-1111-1111-1111-111111111111',
    type: 'bonus',
    amount: 250,
    description: 'حافز شهري',
    txn_date: '2026-05-06',
  };

  const sampleSuccess = {
    id: 'bon-AAA',
    user_id: sampleBody.employee_id,
    amount: 250,
    kind: 'bonus',
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

  it('no Idempotency-Key header → handler called, X-Idempotent-Replay=false', async () => {
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

  it('replay → cached body, handler NOT invoked (no duplicate bonus/deduction/settlement row)', async () => {
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

  it('payload mismatch (tampered amount or flipped type) → 409', async () => {
    // Flipping `type` from 'bonus' to 'deduction' is a semantic-
    // critical change — must NOT be replayed as the original bonus.
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { ...sampleBody, type: 'deduction' },
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

  it('concurrent same-key → 425 IDEMPOTENCY_KEY_IN_PROGRESS', async () => {
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
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('invalid key format → 400, cache NOT consulted', async () => {
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

  it('handler throws → lock released, no cached result', async () => {
    const req = makeMockReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${VALID_KEY}`,
    } as AcquireResult);
    const next = makeFailingNext(new Error('synthetic payroll create failure'));
    await expect(
      firstValueFrom(
        (await interceptor.intercept(makeExecutionContext(req, makeMockRes()), next)) as any,
      ),
    ).rejects.toThrow(/synthetic payroll create failure/);
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

describe('PayrollController route-level wiring — PR-FIX-IDEMPOTENCY-EMPLOYEE-PAYROLL-P0', () => {
  it('create has IdempotencyInterceptor; update + voidTxn + GETs do NOT', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PayrollController],
      providers: [
        { provide: DataSource, useValue: { query: jest.fn(), transaction: jest.fn() } },
        {
          provide: EmployeesService,
          useValue: {
            addBonus: jest.fn(),
            addDeduction: jest.fn(),
            recordSettlement: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(PayrollController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) => i === IdempotencyInterceptor || i?.name === 'IdempotencyInterceptor',
      );
    };

    // ── This PR's target: create.
    expect(hasInterceptor((controller as any).create)).toBe(true);

    // ── update — narrative-only PATCH; naturally idempotent.
    expect(hasInterceptor((controller as any).update)).toBe(false);

    // ── voidTxn (DELETE) — out of scope (PR-11E will handle the
    //    void/cancel family across controllers).
    expect(hasInterceptor((controller as any).voidTxn)).toBe(false);
  });
});
