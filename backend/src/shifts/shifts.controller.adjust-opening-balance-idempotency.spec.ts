/**
 * shifts.controller.adjust-opening-balance-idempotency.spec.ts
 * — PR-FIX-SHIFTS-OPENING-BALANCE-ADJUST (migration 128)
 *
 * Pins the (already-shipped, generic) IdempotencyInterceptor on the
 * NEW opening-balance adjustment route:
 *
 *   · POST /shifts/:id/adjust-opening-balance
 *
 * The full interceptor branch behavior (acquire / replay / payload-
 * mismatch / in-progress / unavailable) is already covered by the
 * generic interceptor specs and by the parallel adjust-count spec
 * shipped with PR-11A.  This spec is intentionally focused on the
 * single most important contract:
 *
 *   1. Source-grep — the controller method has both `@Permissions(
 *      'shifts.opening_balance.adjust')` AND
 *      `@UseInterceptors(IdempotencyInterceptor)` directly above it.
 *   2. Behavior — a successful first call returns the service result
 *      and sets `X-Idempotent-Replay=false`.  The interceptor acquires
 *      the cache lock and stores the response.
 *   3. Behavior — replay (same key + same body) returns the cached
 *      body, the handler is NOT invoked, and `X-Idempotent-Replay=true`.
 *      This is the double-click protection the FE relies on for the
 *      "حفظ التعديل" button.
 *
 * Replay invariant proves we will not write two audit rows + two
 * activity_logs rows for the same operator double-click on the modal.
 */

import { firstValueFrom, of } from 'rxjs';
import { CallHandler, ExecutionContext } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { IdempotencyInterceptor } from '../common/interceptors/idempotency.interceptor';
import {
  AcquireResult,
  CachedResponse,
  IdempotencyCacheService,
} from '../common/cache/idempotency-cache.service';

const VALID_KEY = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'; // 36 chars
const SHIFT_ID = '99999999-9999-9999-9999-999999999999';
const ROUTE_PATH = '/shifts/:id/adjust-opening-balance';

function makeMockReq(overrides: Partial<any> = {}) {
  return {
    method: 'POST',
    url: `/shifts/${SHIFT_ID}/adjust-opening-balance`,
    originalUrl: `/shifts/${SHIFT_ID}/adjust-opening-balance`,
    route: { path: ROUTE_PATH },
    headers: {},
    body: {},
    params: { id: SHIFT_ID },
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

describe('IdempotencyInterceptor on POST /shifts/:id/adjust-opening-balance — PR-FIX-SHIFTS-OPENING-BALANCE-ADJUST', () => {
  let interceptor: IdempotencyInterceptor;
  let cache: jest.Mocked<IdempotencyCacheService>;

  // Realistic body — a 500 → 1000 EGP correction with a manager's
  // stated reason.  No movements (the cashier just opened the shift
  // and immediately fixed the typo).
  const sampleBody = {
    new_opening_balance: 1000,
    reason: 'الكاشير أدخل 500 بدلاً من 1000 — تم العدّ يدويًا',
    notes: 'تم التحقق من الدرج بحضور المدير',
  };

  // Realistic service response: the updated shift row + the new audit row.
  const sampleSuccess = {
    shift: {
      id: SHIFT_ID,
      shift_no: 'SHF-2026-00099',
      status: 'open',
      opening_balance: '1000.00',
      expected_closing: '1000.00',
    },
    adjustment: {
      id: 'adj-AAA',
      shift_id: SHIFT_ID,
      old_opening_balance: 500,
      new_opening_balance: 1000,
      reason: sampleBody.reason,
      adjusted_at: '2026-05-10T08:00:00.000Z',
    },
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

  // ─── 1. Source-grep — decorators present on the new endpoint ────

  it("controller method is decorated with @Permissions('shifts.opening_balance.adjust') AND @UseInterceptors(IdempotencyInterceptor)", () => {
    const SRC = readFileSync(
      resolve(__dirname, './shifts.controller.ts'),
      'utf-8',
    );
    // The decorator stack must precede the method declaration in the
    // exact order documented by the brief: @Post → @Permissions →
    // @ApiOperation → @UseInterceptors → method.
    expect(SRC).toMatch(
      /@Post\([\'"]:id\/adjust-opening-balance[\'"]\)[\s\S]*?@Permissions\([\'"]shifts\.opening_balance\.adjust[\'"]\)[\s\S]*?@UseInterceptors\(IdempotencyInterceptor\)[\s\S]*?adjustOpeningBalance/,
    );
  });

  it('GET /:id/opening-balance-adjustments has NO IdempotencyInterceptor (read-only listing)', () => {
    const SRC = readFileSync(
      resolve(__dirname, './shifts.controller.ts'),
      'utf-8',
    );
    // Pull the slice between the @Get('opening-balance-adjustments')
    // decorator and the next @Post / @Get / end-of-file boundary.
    const idx = SRC.indexOf(
      "@Get(':id/opening-balance-adjustments')",
    );
    expect(idx).toBeGreaterThan(-1);
    // Method body window — until the closing `}` of the listing
    // method.  It must NOT carry @UseInterceptors anywhere inside.
    const slice = SRC.substring(idx, idx + 600);
    expect(slice).not.toMatch(/@UseInterceptors\(IdempotencyInterceptor\)/);
  });

  // ─── 2. Behavior — first keyed request acquires + caches ────────

  it('first keyed request → handler called, cacheResult invoked, X-Idempotent-Replay=false', async () => {
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
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Idempotent-Replay',
      'false',
    );
  });

  // ─── 3. Behavior — replay returns cached body, handler skipped ──

  it('replay (same key + same body) → cached body, handler NOT invoked, X-Idempotent-Replay=true (no duplicate audit row)', async () => {
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
      cached_at: '2026-05-10T08:00:00.000Z',
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
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Idempotent-Replay',
      'true',
    );
    expect(res.status).toHaveBeenCalledWith(201);
  });

  // ─── No-key request — today's behaviour preserved ───────────────

  it("no Idempotency-Key header → handler called, X-Idempotent-Replay=false, cache untouched (today's behavior preserved)", async () => {
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
    expect(res.setHeader).toHaveBeenCalledWith(
      'X-Idempotent-Replay',
      'false',
    );
  });
});
