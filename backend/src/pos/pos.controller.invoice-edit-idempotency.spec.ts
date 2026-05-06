/**
 * pos.controller.invoice-edit-idempotency.spec.ts
 * — PR-FIX-IDEMPOTENCY-EXCHANGES-INVOICE-EDITS (Sprint 4 / PR-11C)
 *
 * Pins the existing Redis-backed IdempotencyInterceptor on:
 *
 *   · POST /pos/invoices/:id/edit
 *
 * `editInvoice` is one of the largest multi-stage write paths in
 * the system: it replaces `invoice_payments` rows, INSERTs a fresh
 * batch of `stock_movements` (one per line), refreshes the JE/CT
 * via the FinancialEngine, and (since PR #295) refreshes the
 * closed-shift snapshot when the parent shift is closed. A duplicate
 * POST during a network retry could partially apply some of these
 * stages before the engine guard catches the JE leg, leaving an
 * orphan invoice_payments / stock_movements pair that's hard to
 * reconcile. The Redis-backed interceptor's 60s lock + 24h replay
 * is the cleaner outer defence.
 *
 * Strategy:
 *   · Mount the real PosController with a stubbed PosService.
 *   · Mount the real IdempotencyInterceptor.
 *   · Mock IdempotencyCacheService so each test controls
 *     acquire / replay / in_progress / unavailable branches.
 *
 * Scope of THIS PR (this controller's contribution):
 *   · `editInvoice` (newly decorated) MUST have the interceptor.
 *   · `create` (the existing pilot from PR #275) MUST STILL
 *     carry the interceptor — guards against regression.
 *   · All other PosController POST handlers (void / edit-request /
 *     approve / reject) MUST NOT carry the interceptor — deferred
 *     to phased PRs (see PR-11 audit; void family is PR-11E).
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { PosController } from './pos.controller';
import { PosService } from './pos.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const INVOICE_ID = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee';
const ROUTE_PATH = '/pos/invoices/:id/edit';

function makeMockReq(overrides: Partial<any> = {}) {
  const url = `/pos/invoices/${INVOICE_ID}/edit`;
  return {
    method: 'POST',
    url,
    originalUrl: url,
    route: { path: ROUTE_PATH },
    headers: {},
    body: {},
    params: { id: INVOICE_ID },
    user: { userId: 'user-AAA', permissions: ['invoices.edit'] },
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

describe('IdempotencyInterceptor on POST /pos/invoices/:id/edit — PR-FIX-IDEMPOTENCY-EXCHANGES-INVOICE-EDITS', () => {
  let interceptor: IdempotencyInterceptor;
  let cache: jest.Mocked<IdempotencyCacheService>;

  // Realistic edit body: cashier swaps payment method from cash to
  // a wallet, adjusts an item quantity, and provides an edit reason.
  const sampleBody = {
    items: [
      { variant_id: '11111111-1111-1111-1111-111111111111', quantity: 2, unit_price: 100 },
    ],
    payments: [
      { payment_method: 'wallet', amount: 200, payment_account_id: '22222222-2222-2222-2222-222222222222' },
    ],
    edit_reason: 'العميل دفع بمحفظة بدلاً من النقد',
  };

  const sampleSuccess = {
    invoice_id: INVOICE_ID,
    invoice_no: 'INV-2026-0042',
    new_total: 200,
    je_id: 'je-AAA',
    movement_ids: ['mv-1'],
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

  it('no Idempotency-Key header → handler called, X-Idempotent-Replay=false (today\'s behavior preserved)', async () => {
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

  it('replay (same key + same body) → cached body, handler NOT invoked, X-Idempotent-Replay=true (no duplicate stages)', async () => {
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

  it('payload mismatch (same key + tampered amount) → 409, handler NOT invoked', async () => {
    const req = makeMockReq({
      headers: { 'idempotency-key': VALID_KEY },
      body: { ...sampleBody, payments: [{ ...sampleBody.payments[0], amount: 9999 }] },
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

  it('concurrent same-key → 425 IDEMPOTENCY_KEY_IN_PROGRESS, handler NOT invoked', async () => {
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
      expect(err.getResponse()).toMatchObject({ code: 'IDEMPOTENCY_KEY_IN_PROGRESS' });
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
      expect(err.getResponse()).toMatchObject({ code: 'IDEMPOTENCY_CACHE_UNAVAILABLE' });
    }
    expect(handler).not.toHaveBeenCalled();
  });

  it('invalid Idempotency-Key format → 400, cache NOT consulted', async () => {
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

  it('handler throws → lock released, error re-thrown, no cached result (failed edit does not poison the key)', async () => {
    const req = makeMockReq({ headers: { 'idempotency-key': VALID_KEY }, body: sampleBody });
    cache.tryAcquireOrReplay.mockResolvedValueOnce({
      kind: 'acquired',
      cacheKey: `idempotency:v1:POST:${ROUTE_PATH}:${VALID_KEY}`,
    } as AcquireResult);
    const next = makeFailingNext(new Error('synthetic invoice-edit failure'));
    await expect(
      firstValueFrom(
        (await interceptor.intercept(makeExecutionContext(req, makeMockRes()), next)) as any,
      ),
    ).rejects.toThrow(/synthetic invoice-edit failure/);
    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Cache-namespace isolation: the SAME Idempotency-Key sent to
 * `POST /pos/invoices` AND `POST /pos/invoices/:id/edit` must
 * produce DISTINCT cache namespaces. Otherwise a duplicate POST
 * to one route could spuriously match the cached response from the
 * other. The interceptor uses `req.route.path` (parameterized) so
 * the two paths are structurally distinct.
 */
describe('namespace isolation: /pos/invoices vs /pos/invoices/:id/edit', () => {
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
      '/pos/invoices',
      '/pos/invoices/:id/edit',
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

/**
 * Wiring assertions:
 *   · `editInvoice` (newly decorated) MUST have the interceptor.
 *   · `create` (PR #275 pilot) MUST STILL carry it.
 *   · All other PosController POST handlers MUST NOT carry it.
 */
describe('PosController route-level wiring — PR-FIX-IDEMPOTENCY-EXCHANGES-INVOICE-EDITS', () => {
  it('editInvoice has IdempotencyInterceptor; create retains it; siblings do NOT', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [PosController],
      providers: [
        {
          provide: PosService,
          useValue: {
            createInvoice: jest.fn(),
            listRecent: jest.fn(),
            findOne: jest.fn(),
            getReceipt: jest.fn(),
            voidInvoice: jest.fn(),
            editInvoice: jest.fn(),
            editHistory: jest.fn(),
            submitEditRequest: jest.fn(),
            editRequests: jest.fn(),
            pendingEditRequests: jest.fn(),
            approveEditRequest: jest.fn(),
            rejectEditRequest: jest.fn(),
          },
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(PosController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) => i === IdempotencyInterceptor || i?.name === 'IdempotencyInterceptor',
      );
    };

    // ── This PR's target.
    expect(hasInterceptor((controller as any).editInvoice)).toBe(true);

    // ── PR #275 pilot — MUST STILL carry the interceptor.
    expect(hasInterceptor((controller as any).create)).toBe(true);

    // ── voidInvoice — was undecorated when this spec shipped;
    //    PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY (PR-11E)
    //    decorated it. The new spec
    //    (pos.controller.void-idempotency.spec.ts) owns the
    //    positive assertion. Updated here to a regression guard.
    expect(hasInterceptor((controller as any).voidInvoice)).toBe(true);

    // ── approveEditRequest — undecorated when this spec shipped;
    //    PR-FIX-IDEMPOTENCY-APPROVE-FAMILY (PR-11F) decorated it.
    //    Dedicated spec
    //    (pos.controller.approve-edit-request-idempotency.spec.ts)
    //    owns the positive assertion; regression-guarded here.
    expect(hasInterceptor((controller as any).approveEditRequest)).toBe(true);

    // ── All other PosController POST handlers MUST NOT carry it
    //    in this PR. submitEditRequest is the request-only entry
    //    (P1 — pending row only); rejectEditRequest is P2.
    const undecoratedSiblings: Array<keyof PosController> = [
      'submitEditRequest',
      'rejectEditRequest',
    ];
    for (const name of undecoratedSiblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(false);
    }
  });
});
