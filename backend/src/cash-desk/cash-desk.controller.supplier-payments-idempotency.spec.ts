/**
 * cash-desk.controller.supplier-payments-idempotency.spec.ts
 * — PR-AUDIT-IDEMPOTENCY-CASH-DESK-SUPPLIER-PAYMENTS
 *
 * Pins the (already-shipped, generic) IdempotencyInterceptor on the
 * supplier-payment route:
 *
 *   · POST /cash-desk/supplier-payments
 *
 * Strategy:
 *   · Mount the real CashDeskController with a stubbed CashDeskService.
 *   · Mount the real IdempotencyInterceptor.
 *   · Mock the IdempotencyCacheService (NOT a real Redis) so each
 *     test can control acquire/replay/in_progress/unavailable
 *     branches deterministically.
 *   · Use Express request/response stubs to assert headers + status
 *     without booting Nest's HTTP layer.
 *
 * Scope of THIS PR: ONLY `pay()` is newly decorated. The wiring test
 * at the bottom asserts:
 *   · `pay` (this PR) carries the interceptor.
 *   · `receive` STILL carries it from PR #281.
 *   · `transfer` STILL carries it from PR #277.
 *   · The sibling `/suppliers/:id/pay` route lives in a DIFFERENT
 *     controller (suppliers.controller.ts) — out of scope; not even
 *     reachable from this CashDeskController.
 *   · All other cash-desk handlers (voids, reconciliation, cashbox
 *     CRUD) do NOT carry the interceptor. (`deposit` was undecorated
 *     when this spec shipped; PR-FIX-IDEMPOTENCY-DIRECT-CT-WRITES
 *     decorated it — this spec's regression assertion was updated
 *     accordingly.)
 *
 * Bodies in tests use a realistic supplier-payments shape including
 * the optional `allocations: [{invoice_id, amount}, ...]` array. Note
 * the DTO field is named `invoice_id` even though semantically (on
 * the supplier side) it stores `purchase_id` — that's a pre-existing
 * pattern; renaming is out of scope for this PR.
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { CashDeskController } from './cash-desk.controller';
import { CashDeskService } from './cash-desk.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // 36 chars, fits 8-128 alnum/-/_
const ROUTE_PATH = '/cash-desk/supplier-payments';

function makeMockReq(overrides: Partial<any> = {}) {
  return {
    method: 'POST',
    url: ROUTE_PATH,
    originalUrl: ROUTE_PATH,
    route: { path: ROUTE_PATH },
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

describe('IdempotencyInterceptor on POST /cash-desk/supplier-payments — PR-AUDIT-IDEMPOTENCY-CASH-DESK-SUPPLIER-PAYMENTS', () => {
  let interceptor: IdempotencyInterceptor;
  let cache: jest.Mocked<IdempotencyCacheService>;

  // Realistic supplier-payments body: cash payout of 1500 EGP to a
  // supplier settling two purchases. The DTO reuses
  // PaymentAllocationDto from the customer side, so the inner field
  // is `invoice_id` even though the supplier service writes it to
  // `supplier_payment_allocations.purchase_id` — pre-existing pattern.
  const sampleBody = {
    supplier_id: '11111111-1111-1111-1111-111111111111',
    cashbox_id: '22222222-2222-2222-2222-222222222222',
    payment_method: 'cash',
    amount: 1500,
    allocations: [
      {
        invoice_id: 'aaaaaaaa-1111-1111-1111-111111111111',
        amount: 900,
      },
      {
        invoice_id: 'bbbbbbbb-2222-2222-2222-222222222222',
        amount: 600,
      },
    ],
    notes: 'دفع نقدي',
  };

  const sampleSuccess = {
    id: 'sp-AAA',
    payment_no: 'SP-2026-000456',
    supplier_id: sampleBody.supplier_id,
    amount: 1500,
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

  it('no Idempotency-Key header → handler called, X-Idempotent-Replay=false, cache untouched', async () => {
    const req = makeMockReq();
    const res = makeMockRes();
    const next = makeNext(sampleSuccess);
    const ctx = makeExecutionContext(req, res);
    const result = await firstValueFrom(
      (await interceptor.intercept(ctx, next)) as any,
    );
    expect(result).toEqual(sampleSuccess);
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'false');
  });

  it('first keyed request → handler called, X-Idempotent-Replay=false, cacheResult invoked with 24h TTL', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: sampleBody,
    });
    const res = makeMockRes();
    const next = makeNext(sampleSuccess);
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${VALID_KEY}`,
    } as AcquireResult);

    res.statusCode = 201;
    const result = await firstValueFrom(
      (await interceptor.intercept(ctx, next)) as any,
    );

    expect(result).toEqual(sampleSuccess);
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(cache.cacheResult).toHaveBeenCalledTimes(1);
    expect(cache.cacheResult).toHaveBeenCalledWith(
      expect.stringContaining(VALID_KEY),
      expect.any(String), // payload hash
      201,
      sampleSuccess,
    );
    expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'false');
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  it('replay (same key + same payload) → returns cached body, X-Idempotent-Replay=true, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: sampleBody,
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    const cached: CachedResponse = {
      status: 201,
      body: sampleSuccess,
      payload_hash: 'will-be-overridden-by-mock',
      cached_at: '2026-05-05T12:00:00.000Z',
    };
    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'replay',
      cached,
    } as AcquireResult);

    const result = await firstValueFrom(
      (await interceptor.intercept(ctx, next)) as any,
    );
    expect(result).toEqual(sampleSuccess);
    expect(handler).not.toHaveBeenCalled();
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith('X-Idempotent-Replay', 'true');
    expect(res.status).toHaveBeenCalledWith(201);
  });

  it('payload mismatch (same key + different payload) → 409 conflict, handler NOT invoked', async () => {
    // Tampered amount → different body hash, same key.
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { ...sampleBody, amount: 9999 },
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    const cached: CachedResponse = {
      status: 201,
      body: sampleSuccess,
      payload_hash: 'different-hash',
      cached_at: '2026-05-05T12:00:00.000Z',
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
    const req = makeMockReq({
      headers: { 'idempotency-key': otherKey },
      body: sampleBody,
    });
    const res = makeMockRes();
    const next = makeNext(sampleSuccess);
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${otherKey}`,
    } as AcquireResult);

    res.statusCode = 201;
    const result = await firstValueFrom(
      (await interceptor.intercept(ctx, next)) as any,
    );
    expect(result).toEqual(sampleSuccess);
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(cache.tryAcquireOrReplay).toHaveBeenCalledTimes(1);
  });

  it('concurrent same-key (lock held by another request) → 425 Too Early, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: sampleBody,
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'in_progress',
      cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${VALID_KEY}`,
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
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: sampleBody,
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
    const req = makeMockReq({
      headers: { 'idempotency-key': 'has spaces & symbols!' },
      body: sampleBody,
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
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: sampleBody,
    });
    const res = makeMockRes();
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${VALID_KEY}`,
    } as AcquireResult);

    const next = makeFailingNext(
      new Error('synthetic supplier-payment failure'),
    );

    await expect(
      firstValueFrom((await interceptor.intercept(ctx, next)) as any),
    ).rejects.toThrow(/synthetic supplier-payment failure/);

    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Cache-namespace isolation: the new route must not collide with
 * any of the previously-protected routes. The interceptor forwards
 * `req.route.path`, so paths are structurally distinct in the cache.
 * Pin that for ALL SIX previously-protected routes plus the offline-
 * sync path the user explicitly listed.
 */
describe('namespace isolation: /cash-desk/supplier-payments vs all previously protected routes', () => {
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
      '/cash-desk/supplier-payments', // this PR
      '/cash-desk/customer-payments', // PR #281
      '/cash-desk/transfer',          // PR #277
      '/pos/invoices',                // PR #275
      '/accounting/expenses',         // PR #279
      '/accounting/expenses/daily',   // PR #279
      '/sync/push',                   // offline-sync (FE-only, listed for completeness)
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
        (await interceptor.intercept(
          makeExecutionContext(req, makeMockRes()),
          next,
        )) as any,
      );
    }

    expect(cache.tryAcquireOrReplay).toHaveBeenCalledTimes(distinctPaths.length);
    const invokedPaths = cache.tryAcquireOrReplay.mock.calls.map((c) => c[1]);
    expect(invokedPaths).toEqual(distinctPaths);
    expect(new Set(invokedPaths).size).toBe(distinctPaths.length);
  });
});

/**
 * Route-level wiring assertions.
 *
 * In this PR:
 *   · `pay` (newly decorated) MUST have the interceptor.
 *   · `receive` (decorated by PR #281) MUST STILL have the
 *     interceptor — guards against regression.
 *   · `transfer` (decorated by PR #277) MUST STILL have the
 *     interceptor — guards against regression.
 *   · All other cash-desk handlers (voids, reconciliation, cashbox
 *     CRUD) MUST NOT carry the interceptor. `deposit` was on this
 *     undecorated list when the spec shipped — PR-FIX-IDEMPOTENCY-
 *     DIRECT-CT-WRITES (Sprint 4 / PR-11A) decorated it; the
 *     assertion below is updated to a regression guard.
 */
describe('CashDeskController route-level wiring — PR-AUDIT-IDEMPOTENCY-CASH-DESK-SUPPLIER-PAYMENTS', () => {
  it('pay has IdempotencyInterceptor; receive + transfer retain it; siblings do NOT', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CashDeskController],
      providers: [
        {
          provide: CashDeskService,
          useValue: {
            // Supplier payments (this PR's target)
            payToSupplier: jest.fn(),
            listSupplierPayments: jest.fn(),
            voidSupplierPayment: jest.fn(),
            // Customer payments (decorated by PR #281)
            receiveFromCustomer: jest.fn(),
            listCustomerPayments: jest.fn(),
            voidCustomerPayment: jest.fn(),
            // Cash transfer (decorated by PR #277)
            transferBetweenCashboxes: jest.fn(),
            // Cashbox CRUD
            listCashboxes: jest.fn(),
            listInstitutions: jest.fn(),
            createCashbox: jest.fn(),
            updateCashbox: jest.fn(),
            removeCashbox: jest.fn(),
            // Reconciliation
            listReconciliation: jest.fn(),
            markReconciled: jest.fn(),
            unmarkReconciled: jest.fn(),
            autoMatchReconciliation: jest.fn(),
            // Reports / drift / movements
            cashflowToday: jest.fn(),
            getGlDrift: jest.fn(),
            getShiftVariances: jest.fn(),
            listMovements: jest.fn(),
            listCashboxMovementsUnified: jest.fn(),
            getCashboxDriftDetail: jest.fn(),
            // Manual deposit
            deposit: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(CashDeskController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) =>
          i === IdempotencyInterceptor ||
          i?.name === 'IdempotencyInterceptor',
      );
    };

    // ── This PR's target: pay (supplier-payments).
    expect(hasInterceptor((controller as any).pay)).toBe(true);

    // ── receive retained from PR #281 — guards against regression.
    expect(hasInterceptor(controller.receive)).toBe(true);

    // ── Transfer retained from PR #277 — guards against regression.
    expect(hasInterceptor(controller.transfer)).toBe(true);

    // ── Deposit — was undecorated when this spec shipped;
    //    PR-FIX-IDEMPOTENCY-DIRECT-CT-WRITES (Sprint 4 / PR-11A)
    //    decorated it. The new spec
    //    (cash-desk.controller.deposit-idempotency.spec.ts) owns
    //    the positive assertion. Updated here to a regression guard.
    expect(hasInterceptor((controller as any).deposit)).toBe(true);

    // ── voidCustomer + voidSupplier — both decorated by
    //    PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY (PR-11E).
    expect(hasInterceptor((controller as any).voidCustomer)).toBe(true);
    expect(hasInterceptor((controller as any).voidSupplier)).toBe(true);

    // ── All other cash-desk POST handlers MUST be undecorated.
    const undecoratedSiblings: Array<keyof CashDeskController> = [
      'cashboxes',
      'institutions',
      'createCashbox',
      'updateCashbox',
      'removeCashbox',
      'listReconciliation',
      'markReconciled',
      'unmarkReconciled',
      'autoMatch',
    ];
    for (const name of undecoratedSiblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(false);
    }
  });
});
