/**
 * accounting.controller.idempotency.spec.ts — PR-AUDIT-IDEMPOTENCY-ACCOUNTING-EXPENSES
 *
 * Pins the (already-shipped, generic) IdempotencyInterceptor on the
 * two protected accounting endpoints in this PR:
 *
 *   · POST /accounting/expenses
 *   · POST /accounting/expenses/daily
 *
 * Strategy:
 *   · Mount the real AccountingController with stubbed services.
 *   · Mount the real IdempotencyInterceptor.
 *   · Mock the IdempotencyCacheService (NOT a real Redis) so each
 *     test can control acquire/replay/in_progress/unavailable
 *     branches deterministically.
 *   · Use Express request/response stubs to assert headers + status
 *     without booting Nest's HTTP layer.
 *
 * Scope of this PR: ONLY `createExpense` + `createDailyExpense` are
 * decorated. The wiring test at the bottom asserts the interceptor
 * is attached to both targets and to NO other accounting handler —
 * guards against accidental scope creep onto category CRUD, approval
 * actions, edit-request workflow, reports, etc.
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { AccountingController } from './accounting.controller';
import { AccountingService } from './accounting.service';
import { ExpenseApprovalService } from './approval.service';
import { CostAccountResolver } from './cost-account-resolver.service';
import { CostReconciliationService } from './cost-reconciliation.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // 36 chars, fits 8-128 alnum/-/_

function makeMockReq(path: string, overrides: Partial<any> = {}) {
  return {
    method: 'POST',
    url: path,
    originalUrl: path,
    route: { path },
    headers: {},
    body: {},
    ...overrides,
  };
}

function makeMockRes() {
  const headers: Record<string, string> = {};
  let statusCode = 201;
  return {
    headers,
    get statusCode() {
      return statusCode;
    },
    set statusCode(v: number) {
      statusCode = v;
    },
    setHeader: jest.fn((name: string, val: string) => {
      headers[name] = val;
    }),
    status: jest.fn(function (this: any, code: number) {
      statusCode = code;
      return this;
    }),
  };
}

function makeExecutionContext(req: any, res: any): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
    }),
  } as any;
}

function makeNext(value: unknown): CallHandler {
  return { handle: jest.fn(() => of(value)) } as any;
}

function makeFailingNext(err: Error): CallHandler {
  return {
    handle: jest.fn(() => throwError(() => err)),
  } as any;
}

// ─── Behavior matrix is identical for BOTH routes — parameterize ──────────
type RouteCase = {
  label: string;
  path: string;
  successBody: unknown;
};

const routes: RouteCase[] = [
  {
    label: 'POST /accounting/expenses',
    path: '/accounting/expenses',
    successBody: {
      id: 'exp-AAA',
      expense_no: 'EXP/2026-05-04/1',
      amount: 250,
    },
  },
  {
    label: 'POST /accounting/expenses/daily',
    path: '/accounting/expenses/daily',
    successBody: {
      id: 'exp-BBB',
      expense_no: 'EXP/2026-05-04/2',
      amount: 50,
      employee_user_id: 'emp-1',
    },
  },
];

describe.each(routes)(
  'IdempotencyInterceptor on $label — PR-AUDIT-IDEMPOTENCY-ACCOUNTING-EXPENSES',
  ({ path, successBody }) => {
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

    it('no Idempotency-Key header → handler called, X-Idempotent-Replay=false, cache untouched', async () => {
      const req = makeMockReq(path);
      const res = makeMockRes();
      const next = makeNext(successBody);
      const ctx = makeExecutionContext(req, res);
      const result = await firstValueFrom(
        (await interceptor.intercept(ctx, next)) as any,
      );
      expect(result).toEqual(successBody);
      expect(next.handle).toHaveBeenCalledTimes(1);
      expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
      expect(cache.cacheResult).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'false');
    });

    it('first keyed request → handler called, X-Idempotent-Replay=false, cacheResult invoked with 24h TTL', async () => {
      const req = makeMockReq(path, {
        headers: { 'idempotency-key': VALID_KEY },
        body: {
          warehouse_id: '11111111-1111-1111-1111-111111111111',
          category_id: '22222222-2222-2222-2222-222222222222',
          amount: 250,
          payment_method: 'cash',
          cashbox_id: '33333333-3333-3333-3333-333333333333',
        },
      });
      const res = makeMockRes();
      const next = makeNext(successBody);
      const ctx = makeExecutionContext(req, res);

      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'acquired',
        cacheKey: `idempotency:v1:POST:${path}:${VALID_KEY}`,
      } as AcquireResult);

      res.statusCode = 201;
      const result = await firstValueFrom(
        (await interceptor.intercept(ctx, next)) as any,
      );

      expect(result).toEqual(successBody);
      expect(next.handle).toHaveBeenCalledTimes(1);
      expect(cache.cacheResult).toHaveBeenCalledTimes(1);
      expect(cache.cacheResult).toHaveBeenCalledWith(
        expect.stringContaining(VALID_KEY),
        expect.any(String), // payload hash
        201,
        successBody,
      );
      expect(res.setHeader).toHaveBeenCalledWith(
        'X-Idempotent-Replay',
        'false',
      );
      expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
    });

    it('replay (same key + same payload) → returns cached body, X-Idempotent-Replay=true, handler NOT invoked', async () => {
      const req = makeMockReq(path, {
        headers: { 'idempotency-key': VALID_KEY },
        body: { amount: 250, category_id: 'c-1' },
      });
      const res = makeMockRes();
      const handler = jest.fn();
      const next = { handle: handler } as any;
      const ctx = makeExecutionContext(req, res);

      const cached: CachedResponse = {
        status: 201,
        body: successBody,
        payload_hash: 'will-be-overridden-by-mock',
        cached_at: '2026-05-04T12:00:00.000Z',
      };
      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'replay',
        cached,
      } as AcquireResult);

      const result = await firstValueFrom(
        (await interceptor.intercept(ctx, next)) as any,
      );
      expect(result).toEqual(successBody);
      expect(handler).not.toHaveBeenCalled();
      expect(cache.cacheResult).not.toHaveBeenCalled();
      expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'true');
      expect(res.status).toHaveBeenCalledWith(201);
    });

    it('payload mismatch (same key + different payload) → 409 conflict, handler NOT invoked', async () => {
      const req = makeMockReq(path, {
        headers: { 'idempotency-key': VALID_KEY },
        body: { amount: 999, category_id: 'c-1' },
      });
      const res = makeMockRes();
      const handler = jest.fn();
      const next = { handle: handler } as any;
      const ctx = makeExecutionContext(req, res);

      const cached: CachedResponse = {
        status: 201,
        body: { id: 'exp-original' },
        payload_hash: 'different-hash',
        cached_at: '2026-05-04T12:00:00.000Z',
      };
      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'payload_mismatch',
        cached,
      } as AcquireResult);

      let caught: any;
      try {
        await interceptor.intercept(ctx, next);
        throw new Error('expected HttpException');
      } catch (err: any) {
        caught = err;
      }
      expect(caught.getStatus()).toBe(409);
      expect(caught.getResponse()).toMatchObject({
        code: 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
      });
      expect(handler).not.toHaveBeenCalled();
      expect(cache.cacheResult).not.toHaveBeenCalled();
    });

    it('different key with same payload → handler invoked again (no cross-key dedupe)', async () => {
      const otherKey = 'ffffffff-1111-2222-3333-444444444444';
      const req = makeMockReq(path, {
        headers: { 'idempotency-key': otherKey },
        body: { amount: 250, category_id: 'c-1' },
      });
      const res = makeMockRes();
      const next = makeNext(successBody);
      const ctx = makeExecutionContext(req, res);

      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'acquired',
        cacheKey: `idempotency:v1:POST:${path}:${otherKey}`,
      } as AcquireResult);

      res.statusCode = 201;
      const result = await firstValueFrom(
        (await interceptor.intercept(ctx, next)) as any,
      );
      expect(result).toEqual(successBody);
      expect(next.handle).toHaveBeenCalledTimes(1);
      expect(cache.tryAcquireOrReplay).toHaveBeenCalledTimes(1);
    });

    it('concurrent same-key (lock held by another request) → 425 Too Early, handler NOT invoked', async () => {
      const req = makeMockReq(path, {
        headers: { 'idempotency-key': VALID_KEY },
        body: { amount: 250, category_id: 'c-1' },
      });
      const res = makeMockRes();
      const handler = jest.fn();
      const next = { handle: handler } as any;
      const ctx = makeExecutionContext(req, res);

      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'in_progress',
        cacheKey: `idempotency:v1:POST:${path}:${VALID_KEY}`,
      } as AcquireResult);

      try {
        await interceptor.intercept(ctx, next);
        throw new Error('expected HttpException');
      } catch (err: any) {
        expect(err.getStatus()).toBe(425);
        expect(err.getResponse()).toMatchObject({
          code: 'IDEMPOTENCY_KEY_IN_PROGRESS',
        });
      }
      expect(handler).not.toHaveBeenCalled();
      expect(cache.cacheResult).not.toHaveBeenCalled();
    });

    it('Redis unavailable for keyed request → 503 fail-closed, handler NOT invoked', async () => {
      const req = makeMockReq(path, {
        headers: { 'idempotency-key': VALID_KEY },
        body: { amount: 250 },
      });
      const res = makeMockRes();
      const handler = jest.fn();
      const next = { handle: handler } as any;
      const ctx = makeExecutionContext(req, res);

      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'unavailable',
      } as AcquireResult);

      try {
        await interceptor.intercept(ctx, next);
        throw new Error('expected HttpException');
      } catch (err: any) {
        expect(err.getStatus()).toBe(503);
        expect(err.getResponse()).toMatchObject({
          code: 'IDEMPOTENCY_CACHE_UNAVAILABLE',
        });
      }
      expect(handler).not.toHaveBeenCalled();
      expect(cache.cacheResult).not.toHaveBeenCalled();
    });

    it('invalid Idempotency-Key format → 400, handler NOT invoked, cache NOT consulted', async () => {
      const req = makeMockReq(path, {
        headers: { 'idempotency-key': 'has spaces & symbols!' },
        body: {},
      });
      const res = makeMockRes();
      const handler = jest.fn();
      const next = { handle: handler } as any;
      const ctx = makeExecutionContext(req, res);

      try {
        await interceptor.intercept(ctx, next);
        throw new Error('expected HttpException');
      } catch (err: any) {
        expect(err.getStatus()).toBe(400);
        expect(err.getResponse()).toMatchObject({
          code: 'IDEMPOTENCY_KEY_INVALID',
        });
      }
      expect(handler).not.toHaveBeenCalled();
      expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
    });

    it('handler throws after lock acquired → lock released, error re-thrown, no cached result', async () => {
      const req = makeMockReq(path, {
        headers: { 'idempotency-key': VALID_KEY },
        body: { amount: 250 },
      });
      const res = makeMockRes();
      const ctx = makeExecutionContext(req, res);

      cache.tryAcquireOrReplay.mockResolvedValueOnce({
        kind: 'acquired',
        cacheKey: `idempotency:v1:POST:${path}:${VALID_KEY}`,
      } as AcquireResult);

      const next = makeFailingNext(new Error('synthetic expense failure'));

      await expect(
        firstValueFrom((await interceptor.intercept(ctx, next)) as any),
      ).rejects.toThrow(/synthetic expense failure/);

      expect(cache.cacheResult).not.toHaveBeenCalled();
      expect(cache.releaseLock).toHaveBeenCalledTimes(1);
    });
  },
);

/**
 * Cache-namespace isolation: the user explicitly required that the
 * two routes' cache entries cannot collide. The interceptor delegates
 * key construction to the cache service, but it forwards `req.route.path`
 * (the route path) which is path-distinct between `/accounting/expenses`
 * and `/accounting/expenses/daily`. We assert that both keyed calls
 * are issued against the cache with their respective paths included.
 */
describe('namespace isolation between /accounting/expenses and /accounting/expenses/daily', () => {
  it('keyed calls on the two routes invoke tryAcquireOrReplay with route-distinct paths', async () => {
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

    const reqA = makeMockReq('/accounting/expenses', {
      headers: { 'idempotency-key': VALID_KEY },
      body: { amount: 100 },
    });
    const reqB = makeMockReq('/accounting/expenses/daily', {
      headers: { 'idempotency-key': VALID_KEY },
      body: { amount: 100 },
    });
    const next = makeNext({ ok: true });

    await firstValueFrom(
      (await interceptor.intercept(
        makeExecutionContext(reqA, makeMockRes()),
        next,
      )) as any,
    );
    await firstValueFrom(
      (await interceptor.intercept(
        makeExecutionContext(reqB, makeMockRes()),
        next,
      )) as any,
    );

    expect(cache.tryAcquireOrReplay).toHaveBeenCalledTimes(2);
    const [callA, callB] = cache.tryAcquireOrReplay.mock.calls;
    // Args are (method, path, key, payloadHash). Path is the second arg.
    expect(callA[1]).toBe('/accounting/expenses');
    expect(callB[1]).toBe('/accounting/expenses/daily');
    // Same key string, same payload, but different paths → cache will
    // namespace them apart in `buildCacheKey(method, path, key)`. Even
    // an identical payload hash on both routes maps to two distinct
    // cache entries because the path is part of the key.
    expect(callA[1]).not.toBe(callB[1]);
  });
});

/**
 * End-to-end-ish: the controller is wired with the interceptor on
 * `createExpense()` AND `createDailyExpense()` ONLY. Any accidental
 * scope creep onto a sibling accounting handler (categories, edit
 * requests, approvals, reports, etc.) would fail this test loudly.
 */
describe('AccountingController route-level wiring', () => {
  it('createExpense and createDailyExpense have IdempotencyInterceptor; sibling handlers do NOT', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [AccountingController],
      providers: [
        {
          provide: AccountingService,
          useValue: {
            createExpense: jest.fn(),
            createDailyExpense: jest.fn(),
            updateExpense: jest.fn(),
            approveExpense: jest.fn(),
            deleteExpense: jest.fn(),
            listExpenses: jest.fn(),
            createCategory: jest.fn(),
            updateCategory: jest.fn(),
            deleteCategory: jest.fn(),
            listCategories: jest.fn(),
            requestExpenseEdit: jest.fn(),
            listEditRequestsForExpense: jest.fn(),
            editRequestsInbox: jest.fn(),
            editRequestsStats: jest.fn(),
            approveEditRequest: jest.fn(),
            rejectEditRequest: jest.fn(),
            cancelEditRequest: jest.fn(),
            profitAndLoss: jest.fn(),
            profitAndLossAnalysis: jest.fn(),
            cashflow: jest.fn(),
            trialBalance: jest.fn(),
            generalLedger: jest.fn(),
            kpis: jest.fn(),
          },
        },
        {
          provide: ExpenseApprovalService,
          useValue: {
            listApprovalRules: jest.fn(),
            createApprovalRule: jest.fn(),
            updateApprovalRule: jest.fn(),
            removeApprovalRule: jest.fn(),
            approvalInbox: jest.fn(),
            approve: jest.fn(),
            reject: jest.fn(),
            approvalsForExpense: jest.fn(),
          },
        },
        {
          provide: CostAccountResolver,
          useValue: {
            costMappings: jest.fn(),
            unifiedLedger: jest.fn(),
          },
        },
        {
          provide: CostReconciliationService,
          useValue: {
            runReconciliation: jest.fn(),
            reconciliationHistory: jest.fn(),
            reconciliationDetail: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    })
      .overrideGuard(JwtAuthGuard)
      .useValue({ canActivate: () => true })
      .overrideGuard(RolesGuard)
      .useValue({ canActivate: () => true })
      .compile();
    const controller = moduleRef.get(AccountingController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) =>
          i === IdempotencyInterceptor ||
          i?.name === 'IdempotencyInterceptor',
      );
    };

    // ── Decorated targets ──
    expect(hasInterceptor(controller.createExpense)).toBe(true);
    expect(hasInterceptor(controller.createDailyExpense)).toBe(true);

    // ── Approve-family routes were undecorated when this spec
    //    shipped; PR-FIX-IDEMPOTENCY-APPROVE-FAMILY (PR-11F)
    //    decorated all 3. Their dedicated spec
    //    (accounting.controller.approve-family-idempotency.spec.ts)
    //    owns the positive assertions; updated here to regression
    //    guards.
    expect(hasInterceptor(controller.approve)).toBe(true);
    expect(hasInterceptor(controller.approveExpense)).toBe(true);
    expect(hasInterceptor(controller.approveEditRequest)).toBe(true);

    // ── Sibling handlers MUST NOT carry the interceptor in this PR.
    const siblings: Array<keyof AccountingController> = [
      // Cost reconciliation
      'runReconciliation',
      // Approval rules
      'createApprovalRule',
      'updateApprovalRule',
      'removeApprovalRule',
      // Approvals workflow — reject is P2 (state-only)
      'reject',
      // Categories
      'createCategory',
      'updateCategory',
      'deleteCategory',
      // Expense lifecycle (mutations OTHER than create)
      'updateExpense',
      'deleteExpense',
      // Expense edit-request workflow — reject + cancel are P2
      'requestExpenseEdit',
      'rejectEditRequest',
      'cancelEditRequest',
    ];
    for (const name of siblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(false);
    }
  });
});
