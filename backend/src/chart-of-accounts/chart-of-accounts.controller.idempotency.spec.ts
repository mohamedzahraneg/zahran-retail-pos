/**
 * chart-of-accounts.controller.idempotency.spec.ts
 * — PR-AUDIT-IDEMPOTENCY-JOURNAL-CREATE
 *
 * Pins the (already-shipped, generic) IdempotencyInterceptor on the
 * manual journal-entry-creation route:
 *
 *   · POST /accounts/journal
 *
 * This is the only direct manual-JE creation path in the system —
 * every other JE write reaches the financial engine via a parent
 * entity (invoice, expense, transfer, payment) whose UUID anchors
 * the engine's `(reference_type, reference_id)` idempotency check.
 * Manual journal entries auto-generate a fresh reference per call,
 * so duplicate submission today produces 2 independent posted JEs
 * with different `entry_no` values but identical line amounts.
 *
 * Strategy:
 *   · Mount the real ChartOfAccountsController with stubbed services.
 *   · Mount the real IdempotencyInterceptor.
 *   · Mock the IdempotencyCacheService (NOT a real Redis).
 *   · Use Express request/response stubs to assert headers + status
 *     without booting Nest's HTTP layer.
 *
 * Scope of THIS PR: ONLY `createJournal()` is newly decorated. The
 * wiring test at the bottom asserts:
 *   · `createJournal` (this PR) carries the interceptor.
 *   · `voidJournal` (out of scope per spec) does NOT — naturally
 *     idempotent today via `is_void` status flag.
 *   · `backfill` does NOT — engine-level idempotency on each
 *     parent entity already protects.
 *   · `closeYear` and other one-shot bootstrap actions do NOT.
 *   · All other chart-of-accounts handlers (chart CRUD, reports,
 *     fixed assets, analytics, budgets, cost centers, FX, etc.)
 *     do NOT carry the interceptor.
 */

import { Test } from '@nestjs/testing';
import { firstValueFrom, of, throwError } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { ChartOfAccountsController } from './chart-of-accounts.controller';
import { ChartOfAccountsService } from './chart-of-accounts.service';
import { JournalService } from './journal.service';
import { AccountingPostingService } from './posting.service';
import { AccountingReportsService } from './reports.service';
import { FixedAssetsService } from './fixed-assets.service';
import { AccountingAnalyticsService } from './analytics.service';
import { BudgetsService } from './budgets.service';
import { CostCentersService } from './cost-centers.service';
import { FxService } from './fx.service';
import { ReconciliationService } from './reconciliation.service';
import { DriftHistoricalCleanupService } from './drift-historical-cleanup.service';
import { MigrationsService } from '../database/migrations.service';
import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
  IDEMPOTENCY_TTL_SECONDS,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // 36 chars, fits 8-128 alnum/-/_
const ROUTE_PATH = '/accounts/journal';

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

describe('IdempotencyInterceptor on POST /accounts/journal — PR-AUDIT-IDEMPOTENCY-JOURNAL-CREATE', () => {
  let interceptor: IdempotencyInterceptor;
  let cache: jest.Mocked<IdempotencyCacheService>;

  // Realistic manual JE body: an end-of-period accountant adjustment
  // posting a balanced 2-line entry.
  const sampleBody = {
    entry_date: '2026-05-31',
    description: 'تسوية نهاية الفترة — مصاريف مستحقة',
    lines: [
      {
        account_code: '5210',
        debit: 1000,
        credit: 0,
        description: 'مصروف إيجار شهر مايو',
      },
      {
        account_code: '2110',
        debit: 0,
        credit: 1000,
        description: 'مستحق دفع',
      },
    ],
  };

  const sampleSuccess = {
    id: 'je-AAA',
    entry_no: 'JE-2026-001234',
    entry_date: '2026-05-31',
    is_posted: true,
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
      body: {
        ...sampleBody,
        lines: [
          { ...sampleBody.lines[0], debit: 9999 },
          { ...sampleBody.lines[1], credit: 9999 },
        ],
      },
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
      new Error('synthetic journal-create failure'),
    );

    await expect(
      firstValueFrom((await interceptor.intercept(ctx, next)) as any),
    ).rejects.toThrow(/synthetic journal-create failure/);

    expect(cache.cacheResult).not.toHaveBeenCalled();
    expect(cache.releaseLock).toHaveBeenCalledTimes(1);
  });
});

/**
 * Cache-namespace isolation: the new route must not collide with
 * any of the previously-protected routes. The interceptor forwards
 * `req.route.path`, so paths are structurally distinct in the cache.
 * Pin that for ALL SIX previously-protected routes plus the offline-
 * sync path the user explicitly listed in their scope.
 */
describe('namespace isolation: /accounts/journal vs all previously protected routes', () => {
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
      '/accounts/journal',                  // this PR
      '/cash-desk/supplier-payments',       // PR #283
      '/cash-desk/customer-payments',       // PR #281
      '/cash-desk/transfer',                // PR #277
      '/pos/invoices',                      // PR #275
      '/accounting/expenses',               // PR #279
      '/accounting/expenses/daily',         // PR #279
      '/sync/push',                         // offline-sync (FE-only, listed for completeness)
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
 *   · `createJournal` (newly decorated) MUST have the interceptor.
 *   · ALL other ChartOfAccountsController handlers MUST NOT carry
 *     the interceptor — explicitly pinned to guard against scope creep.
 *
 * Out-of-scope handlers in this controller that MUST stay undecorated:
 *   - `voidJournal` — naturally idempotent today via is_void status flag
 *     and engine reverseByReference idempotency.
 *   - `backfill` — engine-level idempotency on each parent entity already
 *     protects re-runs.
 *   - `closeYear`, `runDepreciation` — one-shot bootstrap actions, status-
 *     guarded; deferred.
 *   - Chart CRUD, fixed-assets CRUD, budgets, cost centers, FX, reports,
 *     analytics — read-only or non-JE mutations.
 */
describe('ChartOfAccountsController route-level wiring — PR-AUDIT-IDEMPOTENCY-JOURNAL-CREATE', () => {
  it('createJournal has IdempotencyInterceptor; no other handler in this controller does', async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [ChartOfAccountsController],
      providers: [
        // Stub every service this controller consumes. The wiring test
        // only inspects metadata via Reflect; service methods are never
        // called.
        {
          provide: ChartOfAccountsService,
          useValue: {
            list: jest.fn(),
            trialBalance: jest.fn(),
            get: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
            accountLedger: jest.fn(),
            closeYear: jest.fn(),
          },
        },
        {
          provide: JournalService,
          useValue: {
            list: jest.fn(),
            get: jest.fn(),
            create: jest.fn(),
            void: jest.fn(),
            backfill: jest.fn(),
          },
        },
        {
          provide: AccountingPostingService,
          useValue: {},
        },
        {
          provide: AccountingReportsService,
          useValue: {
            incomeStatement: jest.fn(),
            balanceSheet: jest.fn(),
            aging: jest.fn(),
            customerLedger: jest.fn(),
            supplierLedger: jest.fn(),
          },
        },
        {
          provide: FixedAssetsService,
          useValue: {
            list: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
            runDepreciation: jest.fn(),
          },
        },
        {
          provide: AccountingAnalyticsService,
          useValue: {
            dailyPerformance: jest.fn(),
            hourlyHeatmap: jest.fn(),
            topProducts: jest.fn(),
            topCustomers: jest.fn(),
            topSalespeople: jest.fn(),
            expenseBreakdown: jest.fn(),
            indicators: jest.fn(),
            recommendations: jest.fn(),
            cashflowWaterfall: jest.fn(),
            vatReturn: jest.fn(),
            trialBalanceComparison: jest.fn(),
          },
        },
        {
          provide: BudgetsService,
          useValue: {
            list: jest.fn(),
            get: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
            removeLine: jest.fn(),
            variance: jest.fn(),
          },
        },
        {
          provide: CostCentersService,
          useValue: {
            list: jest.fn(),
            create: jest.fn(),
            update: jest.fn(),
            remove: jest.fn(),
          },
        },
        {
          provide: FxService,
          useValue: {
            list: jest.fn(),
            upsert: jest.fn(),
            remove: jest.fn(),
            revalue: jest.fn(),
          },
        },
        {
          provide: ReconciliationService,
          useValue: {},
        },
        {
          provide: DriftHistoricalCleanupService,
          useValue: {},
        },
        {
          provide: MigrationsService,
          useValue: {},
        },
        { provide: IdempotencyCacheService, useValue: {} },
        IdempotencyInterceptor,
      ],
    }).compile();
    const controller = moduleRef.get(ChartOfAccountsController);

    const hasInterceptor = (handler: unknown): boolean => {
      const meta = Reflect.getMetadata('__interceptors__', handler as any);
      if (!Array.isArray(meta)) return false;
      return meta.some(
        (i: any) =>
          i === IdempotencyInterceptor ||
          i?.name === 'IdempotencyInterceptor',
      );
    };

    // ── This PR's target: createJournal.
    expect(hasInterceptor((controller as any).createJournal)).toBe(true);

    // ── voidJournal — was undecorated when this spec shipped;
    //    PR-FIX-IDEMPOTENCY-VOID-CANCEL-REFUND-FAMILY (PR-11E)
    //    decorated it. The new dedicated spec
    //    (chart-of-accounts.controller.journal-void-idempotency.spec.ts)
    //    owns the positive assertion. Updated here to a regression
    //    guard.
    expect(hasInterceptor((controller as any).voidJournal)).toBe(true);

    // ── All other handlers in the controller MUST be undecorated.
    //    Includes backfill (engine-protected), closeYear /
    //    runDepreciation (status-guarded), and every read-only /
    //    metadata route.
    const undecoratedSiblings = [
      // Chart of Accounts CRUD
      'list',
      'trialBalance',
      'get',
      'create',
      'update',
      'remove',
      // Journal entries (other than createJournal + voidJournal)
      'listJournal',
      'getJournal',
      'backfill',
      // Ledger / reports
      'accountLedger',
      'incomeStatement',
      'balanceSheet',
      'aging',
      'customerLedger',
      'supplierLedger',
      // One-shot bootstrap actions
      'closeYear',
      'runDepreciation',
      // Fixed assets CRUD
      'listFixedAssets',
      'createFixedAsset',
      'updateFixedAsset',
      'removeFixedAsset',
      // Analytics (read-only)
      'dailyPerformance',
      'hourlyHeatmap',
      'topProducts',
      'topCustomers',
      'topSalespeople',
      'expenseBreakdown',
      'indicators',
      // Budgets
      'listBudgets',
      'getBudget',
      'createBudget',
      'updateBudget',
      'removeBudget',
      // Cost centers
      'listCostCenters',
      'createCostCenter',
      'updateCostCenter',
      'removeCostCenter',
      // FX
      'listRates',
      'upsertRate',
      'removeRate',
    ];
    for (const name of undecoratedSiblings) {
      const target = (controller as any)[name];
      if (typeof target !== 'function') continue;
      expect(hasInterceptor(target)).toBe(false);
    }
  });
});
