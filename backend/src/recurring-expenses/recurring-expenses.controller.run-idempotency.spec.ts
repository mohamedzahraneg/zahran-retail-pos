/**
 * recurring-expenses.controller.run-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-DEFERRED-APPROVE-FAMILY (Sprint 4 / PR-11F-bis)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /recurring-expenses/:id/run        (single template)
 *   · POST /recurring-expenses/process-due    (batch — all due)
 *
 * Both materialize one or more `expenses` rows from a recurring
 * template + (when auto_post=true) post a JE + (when auto_paid=true)
 * cash transaction. Without retry-safety, a duplicate POST creates
 * doubled expense rows + doubled JEs + doubled CTs. Same risk
 * profile as `POST /expenses/:id/approve` (already protected in
 * PR-11F).
 *
 * Tests are parametrized via `describe.each` so both routes share
 * the full interceptor contract (acquire, replay, mismatch=409,
 * concurrent=425, redis-down=503, invalid=400, throw→release).
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { RecurringExpensesController } from './recurring-expenses.controller';
import { RecurringExpensesService } from './recurring-expenses.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const TPL_ID = 'tttttttt-tttt-tttt-tttt-tttttttttttt';

const makeReq = (path: string, url: string, params: any, overrides: Partial<any> = {}) => ({
  method: 'POST',
  url,
  originalUrl: url,
  route: { path },
  headers: {}, body: {}, params,
  user: { userId: 'user-AAA', id: 'user-AAA' },
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

type RouteCase = {
  label: string;
  routePath: string;
  url: string;
  params: any;
  body: unknown;
  success: unknown;
  altBody: unknown;
};

const cases: RouteCase[] = [
  {
    label: 'POST /recurring-expenses/:id/run',
    routePath: '/recurring-expenses/:id/run',
    url: `/recurring-expenses/${TPL_ID}/run`,
    params: { id: TPL_ID },
    body: { dry_run: false },
    success: { expense_id: 'exp-AAA', je_id: 'je-AAA', ct_id: 'ct-AAA' },
    altBody: { dry_run: true },
  },
  {
    label: 'POST /recurring-expenses/process-due',
    routePath: '/recurring-expenses/process-due',
    url: `/recurring-expenses/process-due`,
    params: {},
    body: { limit: 25 },
    success: { processed: 7, expense_ids: ['exp-1', 'exp-2'] },
    altBody: { limit: 50 },
  },
];

describe.each(cases)(
  'IdempotencyInterceptor on $label — PR-FIX-IDEMPOTENCY-DEFERRED-APPROVE-FAMILY',
  ({ routePath, url, params, body, success, altBody }) => {
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
      const req = makeReq(routePath, url, params), res = makeRes();
      const result = await firstValueFrom(
        (await interceptor.intercept(ctx(req, res), next(success))) as any,
      );
      expect(result).toEqual(success);
      expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'false');
    });

    it('first keyed → cacheResult invoked with 24h TTL', async () => {
      const req = makeReq(routePath, url, params, { headers: { 'idempotency-key': VALID_KEY }, body });
      const res = makeRes();
      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'acquired', cacheKey: `idempotency:v1:POST:${routePath}:${VALID_KEY}`,
      } as AcquireResult);
      res.statusCode = 201;
      await firstValueFrom((await interceptor.intercept(ctx(req, res), next(success))) as any);
      expect(cache.cacheResult).toHaveBeenCalledTimes(1);
      expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
    });

    it('replay → cached body, handler NOT invoked (no duplicate expense/JE/CT)', async () => {
      const req = makeReq(routePath, url, params, { headers: { 'idempotency-key': VALID_KEY }, body });
      const res = makeRes();
      const handler = jest.fn();
      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'replay',
        cached: { status: 201, body: success, payload_hash: 'h', cached_at: 't' } as CachedResponse,
      } as AcquireResult);
      const result = await firstValueFrom(
        (await interceptor.intercept(ctx(req, res), { handle: handler } as any)) as any,
      );
      expect(result).toEqual(success);
      expect(handler).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'true');
    });

    it('payload mismatch → 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', async () => {
      const req = makeReq(routePath, url, params, {
        headers: { 'idempotency-key': VALID_KEY },
        body: altBody,
      });
      const handler = jest.fn();
      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'payload_mismatch',
        cached: { status: 201, body: success, payload_hash: 'orig', cached_at: 't' } as CachedResponse,
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
      const req = makeReq(routePath, url, params, { headers: { 'idempotency-key': VALID_KEY }, body });
      cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'in_progress', cacheKey: 'k' } as AcquireResult);
      try {
        await interceptor.intercept(ctx(req, makeRes()), next(null));
        throw new Error('expected HttpException');
      } catch (err: any) { expect(err.getStatus()).toBe(425); }
    });

    it('Redis unavailable → 503 (fail-closed)', async () => {
      const req = makeReq(routePath, url, params, { headers: { 'idempotency-key': VALID_KEY }, body });
      cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'unavailable' } as AcquireResult);
      try {
        await interceptor.intercept(ctx(req, makeRes()), next(null));
        throw new Error('expected HttpException');
      } catch (err: any) { expect(err.getStatus()).toBe(503); }
    });

    it('invalid key → 400 (no acquire attempted)', async () => {
      const req = makeReq(routePath, url, params, { headers: { 'idempotency-key': 'bad!' }, body });
      try {
        await interceptor.intercept(ctx(req, makeRes()), next(null));
        throw new Error('expected HttpException');
      } catch (err: any) { expect(err.getStatus()).toBe(400); }
      expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
    });

    it('handler throws → lock released, NOT cached', async () => {
      const req = makeReq(routePath, url, params, { headers: { 'idempotency-key': VALID_KEY }, body });
      cache.tryAcquireOrReplay.mockResolvedValueOnce({ kind: 'acquired', cacheKey: 'k' } as AcquireResult);
      await expect(
        firstValueFrom(
          (await interceptor.intercept(
            ctx(req, makeRes()), failNext(new Error('synthetic recurring-expenses run failure')),
          )) as any,
        ),
      ).rejects.toThrow(/synthetic recurring-expenses run failure/);
      expect(cache.cacheResult).not.toHaveBeenCalled();
      expect(cache.releaseLock).toHaveBeenCalledTimes(1);
    });
  },
);

describe('namespace isolation: recurring-expenses run/process-due vs sibling routes', () => {
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
    // Both new routes vs the read/CRUD siblings on the same controller.
    const distinctPaths = [
      '/recurring-expenses/:id/run',
      '/recurring-expenses/process-due',
      '/recurring-expenses',
      '/recurring-expenses/:id',
      '/recurring-expenses/:id/pause',
      '/recurring-expenses/:id/resume',
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

describe('RecurringExpensesController route-level wiring — PR-FIX-IDEMPOTENCY-DEFERRED-APPROVE-FAMILY', () => {
  it('runOne + processDue decorated; CRUD/state siblings NOT decorated', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [RecurringExpensesController],
      providers: [
        {
          provide: RecurringExpensesService,
          useValue: {
            list: jest.fn(),
            stats: jest.fn(),
            get: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
            pause: jest.fn(),
            resume: jest.fn(),
            runOne: jest.fn(),
            processDue: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(RecurringExpensesController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) => i === IdempotencyInterceptor || i?.name === 'IdempotencyInterceptor',
      );
    };

    // ── This PR's targets.
    expect(hasInterceptor((controller as any).runOne)).toBe(true);
    expect(hasInterceptor((controller as any).processDue)).toBe(true);

    // ── CRUD + state-transition siblings remain undecorated.
    //    `pause` / `resume` are status flips (no JE/CT), and the
    //    CRUD methods don't post — out of scope per PR-11F-bis spec.
    const undecoratedSiblings: Array<keyof RecurringExpensesController> = [
      'list', 'stats', 'get', 'create', 'update', 'remove', 'pause', 'resume',
    ];
    for (const name of undecoratedSiblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(false);
    }
  });
});
