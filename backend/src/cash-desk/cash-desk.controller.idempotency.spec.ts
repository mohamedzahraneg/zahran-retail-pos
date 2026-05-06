/**
 * cash-desk.controller.idempotency.spec.ts — PR-AUDIT-IDEMPOTENCY-CASH-DESK-TRANSFER
 *
 * Pins the 7 required behaviors of the (already-shipped, generic)
 * IdempotencyInterceptor on the second protected endpoint:
 * `POST /cash-desk/transfer`.
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
 * Scope: this PR only decorates `transfer()`. The wiring test at the
 * bottom asserts the interceptor is attached to that handler and to
 * NO other cash-desk handler — guards against accidental scope creep.
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

function makeMockReq(overrides: Partial<any> = {}) {
  return {
    method: 'POST',
    url: '/cash-desk/transfer',
    originalUrl: '/cash-desk/transfer',
    route: { path: '/cash-desk/transfer' },
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

describe('IdempotencyInterceptor on POST /cash-desk/transfer — PR-AUDIT-IDEMPOTENCY-CASH-DESK-TRANSFER', () => {
  let interceptor: IdempotencyInterceptor;
  let cache: jest.Mocked<IdempotencyCacheService>;

  beforeEach(async () => {
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

  // ─── Behavior 5: no key = service called normally ──────────────
  it('no Idempotency-Key header → handler called, X-Idempotent-Replay=false, cache untouched', async () => {
    const req = makeMockReq();
    const res = makeMockRes();
    const next = makeNext({ transferred: true, amount: 500 });
    const ctx = makeExecutionContext(req, res);
    const result = await firstValueFrom(
      (await interceptor.intercept(ctx, next)) as any,
    );
    expect(result).toEqual({ transferred: true, amount: 500 });
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(cache.tryAcquireOrReplay).not.toHaveBeenCalled();
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Idempotent-Replay',
      'false',
    );
  });

  // ─── Behavior 1: first keyed request = service called once and cached ──────────────
  it('first keyed request → handler called, X-Idempotent-Replay=false, cacheResult invoked with 24h TTL', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: {
        from_cashbox_id: '11111111-1111-1111-1111-111111111111',
        to_cashbox_id: '22222222-2222-2222-2222-222222222222',
        amount: 500,
      },
    });
    const res = makeMockRes();
    const next = makeNext({
      transferred: true,
      amount: 500,
      from_balance: 1500,
      to_balance: 800,
    });
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: 'idempotency:v1:POST:/cash-desk/transfer:' + VALID_KEY,
    } as AcquireResult);

    res.statusCode = 201;
    const result = await firstValueFrom(
      (await interceptor.intercept(ctx, next)) as any,
    );

    expect(result).toEqual({
      transferred: true,
      amount: 500,
      from_balance: 1500,
      to_balance: 800,
    });
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(cache.cacheResult).toHaveBeenCalledTimes(1);
    expect(cache.cacheResult).toHaveBeenCalledWith(
      expect.stringContaining(VALID_KEY),
      expect.any(String), // payload hash
      201,
      {
        transferred: true,
        amount: 500,
        from_balance: 1500,
        to_balance: 800,
      },
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Idempotent-Replay',
      'false',
    );
    expect(IDEMPOTENCY_TTL_SECONDS).toBe(24 * 60 * 60);
  });

  // ─── Behavior 2: replay same key/body = cached response, handler NOT called ──────────────
  it('replay (same key + same payload) → returns cached body, X-Idempotent-Replay=true, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: {
        from_cashbox_id: '11111111-1111-1111-1111-111111111111',
        to_cashbox_id: '22222222-2222-2222-2222-222222222222',
        amount: 500,
      },
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    const cachedBody = {
      transferred: true,
      amount: 500,
      from_balance: 1500,
      to_balance: 800,
    };
    const cached: CachedResponse = {
      status: 201,
      body: cachedBody,
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
    expect(result).toEqual(cachedBody);
    expect(handler).not.toHaveBeenCalled();
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Idempotent-Replay',
      'true',
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  // ─── Behavior 3: same key + different body = 409 ──────────────
  it('payload mismatch (same key + different payload) → 409 conflict, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: {
        from_cashbox_id: '11111111-1111-1111-1111-111111111111',
        to_cashbox_id: '22222222-2222-2222-2222-222222222222',
        // Tampered amount → different hash, same key.
        amount: 999,
      },
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    const cached: CachedResponse = {
      status: 201,
      body: { transferred: true, amount: 500 },
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

  // ─── Behavior 4: different key + same body = service called again ──────────────
  it('different key with same payload → handler invoked again (no cross-key dedupe)', async () => {
    const otherKey = 'ffffffff-1111-2222-3333-444444444444';
    const req = makeMockReq({
      headers: { 'idempotency-key': otherKey },
      body: {
        from_cashbox_id: '11111111-1111-1111-1111-111111111111',
        to_cashbox_id: '22222222-2222-2222-2222-222222222222',
        amount: 500,
      },
    });
    const res = makeMockRes();
    const next = makeNext({ transferred: true, amount: 500 });
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: 'idempotency:v1:POST:/cash-desk/transfer:' + otherKey,
    } as AcquireResult);

    res.statusCode = 201;
    const result = await firstValueFrom(
      (await interceptor.intercept(ctx, next)) as any,
    );
    expect(result).toEqual({ transferred: true, amount: 500 });
    expect(next.handle).toHaveBeenCalledTimes(1);
    expect(cache.tryAcquireOrReplay).toHaveBeenCalledTimes(1);
  });

  // ─── Behavior 6: concurrent same-key = service called once only (425) ──────────────
  it('concurrent same-key (lock held by another request) → 425 Too Early, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { from_cashbox_id: 'a', to_cashbox_id: 'b', amount: 500 },
    });
    const res = makeMockRes();
    const handler = jest.fn();
    const next = { handle: handler } as any;
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'in_progress',
      cacheKey: 'idempotency:v1:POST:/cash-desk/transfer:' + VALID_KEY,
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

  // ─── Behavior 7: Redis unavailable (keyed) = fail-closed 503, handler NOT invoked ──────────────
  it('Redis unavailable for keyed request → 503 fail-closed, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { from_cashbox_id: 'a', to_cashbox_id: 'b', amount: 500 },
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

  // ─── Defense: bad key format ──────────────
  it('invalid Idempotency-Key format → 400, handler NOT invoked, cache NOT consulted', async () => {
    const req = makeMockReq({
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

  // ─── Defense: handler error releases the lock so a retry can proceed ──────────────
  it('handler throws after lock acquired → lock released, error re-thrown, no cached result', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { from_cashbox_id: 'a', to_cashbox_id: 'b', amount: 500 },
    });
    const res = makeMockRes();
    const ctx = makeExecutionContext(req, res);

    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: 'idempotency:v1:POST:/cash-desk/transfer:' + VALID_KEY,
    } as AcquireResult);

    const next = makeFailingNext(new Error('synthetic transfer failure'));

    await expect(
      firstValueFrom((await interceptor.intercept(ctx, next)) as any),
    ).rejects.toThrow(/synthetic transfer failure/);

    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

/**
 * End-to-end-ish: the controller is wired with the interceptor on
 * `transfer()` ONLY. Any accidental scope creep onto a sibling
 * cash-desk handler would fail this test loudly.
 */
describe('CashDeskController route-level wiring', () => {
  it('CashDeskController.transfer has IdempotencyInterceptor; sibling handlers do NOT', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [CashDeskController],
      providers: [
        {
          provide: CashDeskService,
          useValue: {
            transferBetweenCashboxes: jest.fn(),
            listCashboxes: jest.fn(),
            listInstitutions: jest.fn(),
            createCashbox: jest.fn(),
            updateCashbox: jest.fn(),
            removeCashbox: jest.fn(),
            cashflowToday: jest.fn(),
            getGlDrift: jest.fn(),
            getShiftVariances: jest.fn(),
            listMovements: jest.fn(),
            listCashboxMovementsUnified: jest.fn(),
            getCashboxDriftDetail: jest.fn(),
            createCustomerPayment: jest.fn(),
            listCustomerPayments: jest.fn(),
            voidCustomerPayment: jest.fn(),
            voidSupplierPayment: jest.fn(),
            createSupplierPayment: jest.fn(),
            listSupplierPayments: jest.fn(),
            deposit: jest.fn(),
            listReconciliation: jest.fn(),
            markReconciled: jest.fn(),
            unmarkReconciled: jest.fn(),
            autoMatchReconciliation: jest.fn(),
            receiveFromCustomer: jest.fn(),
            payToSupplier: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(CashDeskController);

    // The decorated handler.
    const transferMeta = Reflect.getMetadata(
      '__interceptors__',
      controller.transfer,
    );
    expect(transferMeta).toBeDefined();
    expect(
      transferMeta.some(
        (i: any) =>
          i === IdempotencyInterceptor ||
          i?.name === 'IdempotencyInterceptor',
      ),
    ).toBe(true);

    // Sibling handlers — sample a representative selection that
    // covers Get + Post and span the controller. None should carry
    // the interceptor in this PR (pilot scope).
    const siblings: Array<keyof CashDeskController> = [
      'cashboxes',
      'institutions',
      'createCashbox',
      'updateCashbox',
      'removeCashbox',
      // 'deposit' was undecorated when PR #277 shipped; PR-FIX-
      // IDEMPOTENCY-DIRECT-CT-WRITES (Sprint 4 / PR-11A) now
      // decorates it and re-asserts its decoration in its own
      // dedicated spec (cash-desk.controller.deposit-idempotency.
      // spec.ts). Removed here so this PR-#277 wiring assertion
      // stays scoped to the transfer-only contract that PR
      // established.
      // 'receive' was undecorated when PR #277 shipped; PR-AUDIT-
      // IDEMPOTENCY-CASH-DESK-CUSTOMER-PAYMENTS now decorates it
      // and re-asserts its decoration in its own dedicated spec
      // (cash-desk.controller.customer-payments-idempotency.spec.ts).
      // Removed here so this PR-#277 wiring assertion stays scoped
      // to the transfer-only contract that PR established.
      'voidCustomer',
      // 'pay' was undecorated when PR #277 shipped; PR-AUDIT-
      // IDEMPOTENCY-CASH-DESK-SUPPLIER-PAYMENTS now decorates it
      // and re-asserts its decoration in its own dedicated spec
      // (cash-desk.controller.supplier-payments-idempotency.spec.ts).
      // Removed here so this PR-#277 wiring assertion stays scoped
      // to the transfer-only contract that PR established.
      'voidSupplier',
      'listReconciliation',
      'markReconciled',
      'unmarkReconciled',
      'autoMatch',
    ];
    for (const name of siblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      const meta = Reflect.getMetadata('__interceptors__', target);
      if (meta) {
        expect(
          meta.some(
            (i: any) =>
              i === IdempotencyInterceptor ||
              i?.name === 'IdempotencyInterceptor',
          ),
        ).toBe(false);
      }
    }
  });
});
