/**
 * client.idempotency.spec.ts
 * — PR-FE-IDEM-RESPONSE-INTERCEPTOR (Sprint 5 / FE-IDEM PR 1)
 *
 * Pins the shared frontend handling for the four idempotency-specific
 * BE responses + the success replay header. The logic under test
 * lives at the bottom of `frontend/src/api/client.ts` as the exported
 * helpers `_handleIdempotencyReplay` / `_handleIdempotencyError`.
 *
 * Why direct-call tests (not full-stack interceptor tests):
 *   · The interceptor closures in `client.ts` are thin wrappers that
 *     delegate to the helpers. Driving the helpers with synthetic
 *     AxiosError / AxiosResponse objects lets us pin the exact toast
 *     calls + retry semantics without spinning up a real network
 *     mock and without introducing a new test dependency
 *     (`axios-mock-adapter` is not in package.json today).
 *   · The interceptor wiring itself is one line and visually
 *     reviewable in client.ts; if the wiring breaks, every existing
 *     api test plus the full-FE jest suite catches it.
 *
 * Existing 401-refresh + 403-silent + generic-toast behavior is NOT
 * exercised here directly — those code paths are unchanged, and the
 * helper returns `{ kind: 'unhandled' }` for any non-idempotency
 * status (asserted explicitly), which is exactly what causes the
 * existing flow to fire. The full-FE suite re-validates the rest.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { AxiosError, AxiosResponse } from 'axios';

// ─── Mock react-hot-toast BEFORE importing client.ts so the toast
//     calls inside the helpers route to our spies. ──────────────────
vi.mock('react-hot-toast', () => {
  const error = vi.fn();
  const loading = vi.fn();
  const success = vi.fn();
  const fn: any = vi.fn();
  fn.error = error;
  fn.loading = loading;
  fn.success = success;
  return { default: fn };
});

// Stub the auth store so `client.ts` doesn't try to read a real Zustand
// store at import time (it would fail in jsdom without a provider).
vi.mock('@/stores/auth.store', () => ({
  useAuthStore: {
    getState: () => ({ accessToken: null, refresh: vi.fn(), logout: vi.fn() }),
  },
}));

import toast from 'react-hot-toast';
import {
  IDEMPOTENCY_MESSAGES,
  IDEMPOTENCY_RETRY_DELAY_MS,
  _handleIdempotencyError,
  _handleIdempotencyReplay,
} from '../client';

const toastError = toast.error as unknown as ReturnType<typeof vi.fn>;
const toastLoading = toast.loading as unknown as ReturnType<typeof vi.fn>;

const makeError = (
  status: number,
  code?: string,
  configOverrides: Record<string, unknown> = {},
): AxiosError<any> =>
  ({
    isAxiosError: true,
    config: { url: '/cash-desk/transfer', method: 'post', headers: {}, ...configOverrides },
    response: {
      status,
      data: code ? { code, message: 'be-msg' } : { message: 'be-msg' },
      headers: {},
      statusText: '',
      config: {} as any,
    },
    message: 'request failed',
    name: 'AxiosError',
    toJSON: () => ({}),
  }) as unknown as AxiosError<any>;

const makeResponse = (
  headers: Record<string, string> = {},
): AxiosResponse =>
  ({
    status: 200,
    data: { ok: true },
    headers,
    statusText: 'OK',
    config: {} as any,
  }) as unknown as AxiosResponse;

beforeEach(() => {
  toastError.mockReset();
  toastLoading.mockReset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('_handleIdempotencyReplay — success-side', () => {
  it('attaches __isIdempotentReplay = true when X-Idempotent-Replay: true', () => {
    const res = makeResponse({ 'x-idempotent-replay': 'true' });
    const out = _handleIdempotencyReplay(res);
    expect((out as any).__isIdempotentReplay).toBe(true);
  });

  it('also honors uppercase header casing (defensive)', () => {
    const res = makeResponse({ 'X-Idempotent-Replay': 'true' });
    const out = _handleIdempotencyReplay(res);
    expect((out as any).__isIdempotentReplay).toBe(true);
  });

  it('does NOT attach the flag when header absent', () => {
    const res = makeResponse({});
    const out = _handleIdempotencyReplay(res);
    expect((out as any).__isIdempotentReplay).toBeUndefined();
  });

  it('does NOT attach the flag when header is anything other than "true"', () => {
    const res = makeResponse({ 'x-idempotent-replay': 'false' });
    const out = _handleIdempotencyReplay(res);
    expect((out as any).__isIdempotentReplay).toBeUndefined();
  });

  it('does NOT trigger any toast (success path is silent)', () => {
    _handleIdempotencyReplay(makeResponse({ 'x-idempotent-replay': 'true' }));
    expect(toastError).not.toHaveBeenCalled();
    expect(toastLoading).not.toHaveBeenCalled();
  });

  it('returns the same response object (no mutation aside from the flag)', () => {
    const res = makeResponse({ 'x-idempotent-replay': 'true' });
    const out = _handleIdempotencyReplay(res);
    expect(out).toBe(res);
    expect(out.data).toEqual({ ok: true });
  });
});

describe('_handleIdempotencyError — 409 IDEMPOTENCY_KEY_PAYLOAD_MISMATCH', () => {
  it('shows the exact PAYLOAD_MISMATCH Arabic message and returns rejected', async () => {
    const retry = vi.fn();
    const result = await _handleIdempotencyError(
      makeError(409, 'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH'),
      retry,
    );
    expect(result).toEqual({ kind: 'rejected' });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(
      IDEMPOTENCY_MESSAGES.PAYLOAD_MISMATCH,
    );
    expect(retry).not.toHaveBeenCalled();
  });

  it('does NOT trigger on a generic 409 (different code)', async () => {
    const result = await _handleIdempotencyError(
      makeError(409, 'UNIQUE_CONSTRAINT_VIOLATION'),
      vi.fn(),
    );
    expect(result).toEqual({ kind: 'unhandled' });
    expect(toastError).not.toHaveBeenCalled();
  });

  it('does NOT trigger on a generic 409 with no code at all', async () => {
    const result = await _handleIdempotencyError(makeError(409), vi.fn());
    expect(result).toEqual({ kind: 'unhandled' });
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('_handleIdempotencyError — 425 IDEMPOTENCY_KEY_IN_PROGRESS auto-retry', () => {
  it('first 425: shows IN_PROGRESS_RETRY toast, waits 1.5 s, calls retry with the SAME config', async () => {
    const sameConfig = {
      url: '/cash-desk/transfer',
      method: 'post',
      headers: { 'idempotency-key': 'same-key-aaa' },
      data: '{"amount":100}',
    };
    const retry = vi.fn().mockResolvedValue({
      status: 200, data: { ok: true }, headers: {}, statusText: 'OK', config: {},
    });
    const err = makeError(425, 'IDEMPOTENCY_KEY_IN_PROGRESS', sameConfig);

    const promise = _handleIdempotencyError(err, retry);
    // Advance through the 1.5 s wait without real time passing.
    await vi.advanceTimersByTimeAsync(IDEMPOTENCY_RETRY_DELAY_MS);
    const result = await promise;

    expect(toastLoading).toHaveBeenCalledTimes(1);
    expect(toastLoading).toHaveBeenCalledWith(
      IDEMPOTENCY_MESSAGES.IN_PROGRESS_RETRY,
      expect.objectContaining({ duration: IDEMPOTENCY_RETRY_DELAY_MS }),
    );
    expect(result.kind).toBe('retry');
    expect(retry).toHaveBeenCalledTimes(1);
    // Same config object (same Idempotency-Key, same body) handed to retry.
    expect(retry.mock.calls[0][0]).toBe(err.config);
    expect(retry.mock.calls[0][0].headers['idempotency-key']).toBe('same-key-aaa');
  });

  it('marks the config so a SECOND 425 cannot loop', async () => {
    // `makeError` spreads its overrides into a fresh config object,
    // so we read the marker back via err.config (which is the actual
    // reference handed to the helper) rather than our local input.
    const err = makeError(425, 'IDEMPOTENCY_KEY_IN_PROGRESS', {
      url: '/x', method: 'post', headers: {},
    });
    const retry = vi.fn().mockResolvedValue({} as any);
    const promise = _handleIdempotencyError(err, retry);
    await vi.advanceTimersByTimeAsync(IDEMPOTENCY_RETRY_DELAY_MS);
    await promise;
    expect((err.config as any)._idempotencyRetried).toBe(true);
  });

  it('second 425 (config already marked): shows IN_PROGRESS_FINAL and returns rejected', async () => {
    const retry = vi.fn();
    const result = await _handleIdempotencyError(
      makeError(425, 'IDEMPOTENCY_KEY_IN_PROGRESS', {
        url: '/x', method: 'post', headers: {}, _idempotencyRetried: true,
      }),
      retry,
    );
    expect(result).toEqual({ kind: 'rejected' });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(
      IDEMPOTENCY_MESSAGES.IN_PROGRESS_FINAL,
    );
    expect(toastLoading).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('does NOT trigger on 425 with a different code', async () => {
    const result = await _handleIdempotencyError(
      makeError(425, 'SOMETHING_ELSE'),
      vi.fn(),
    );
    expect(result).toEqual({ kind: 'unhandled' });
    expect(toastLoading).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('_handleIdempotencyError — 503 IDEMPOTENCY_CACHE_UNAVAILABLE', () => {
  it('shows the exact CACHE_UNAVAILABLE Arabic message and returns rejected', async () => {
    const retry = vi.fn();
    const result = await _handleIdempotencyError(
      makeError(503, 'IDEMPOTENCY_CACHE_UNAVAILABLE'),
      retry,
    );
    expect(result).toEqual({ kind: 'rejected' });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(
      IDEMPOTENCY_MESSAGES.CACHE_UNAVAILABLE,
    );
    expect(retry).not.toHaveBeenCalled();
  });

  it('does NOT trigger on a generic 503 (different/missing code)', async () => {
    const r1 = await _handleIdempotencyError(
      makeError(503, 'GATEWAY_DOWN'),
      vi.fn(),
    );
    const r2 = await _handleIdempotencyError(makeError(503), vi.fn());
    expect(r1).toEqual({ kind: 'unhandled' });
    expect(r2).toEqual({ kind: 'unhandled' });
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('_handleIdempotencyError — 400 IDEMPOTENCY_KEY_INVALID', () => {
  it('shows the exact KEY_INVALID Arabic message and returns rejected', async () => {
    const retry = vi.fn();
    const result = await _handleIdempotencyError(
      makeError(400, 'IDEMPOTENCY_KEY_INVALID'),
      retry,
    );
    expect(result).toEqual({ kind: 'rejected' });
    expect(toastError).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith(IDEMPOTENCY_MESSAGES.KEY_INVALID);
    expect(retry).not.toHaveBeenCalled();
  });

  it('does NOT trigger on a generic 400 (different code or none)', async () => {
    const r1 = await _handleIdempotencyError(
      makeError(400, 'VALIDATION_ERROR'),
      vi.fn(),
    );
    const r2 = await _handleIdempotencyError(makeError(400), vi.fn());
    expect(r1).toEqual({ kind: 'unhandled' });
    expect(r2).toEqual({ kind: 'unhandled' });
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('_handleIdempotencyError — non-idempotency statuses fall through unchanged', () => {
  // These are the statuses the existing client.ts interceptor handles
  // separately (401 refresh-token, 403 silent, generic 4xx/5xx toast).
  // The new helper MUST return `unhandled` for all of them so the
  // existing flow is preserved.
  it.each([
    [401, undefined],
    [401, 'INVALID_TOKEN'],
    [403, undefined],
    [403, 'FORBIDDEN'],
    [404, 'NOT_FOUND'],
    [422, 'VALIDATION_ERROR'],
    [500, undefined],
    [502, 'BAD_GATEWAY'],
  ])('status %s + code %s → unhandled, no toast', async (status, code) => {
    const retry = vi.fn();
    const result = await _handleIdempotencyError(
      makeError(status, code),
      retry,
    );
    expect(result).toEqual({ kind: 'unhandled' });
    expect(toastError).not.toHaveBeenCalled();
    expect(toastLoading).not.toHaveBeenCalled();
    expect(retry).not.toHaveBeenCalled();
  });

  it('network error (no response) → unhandled, no toast', async () => {
    const err = {
      isAxiosError: true,
      config: { url: '/x', method: 'post', headers: {} },
      response: undefined,
      message: 'Network Error',
      name: 'AxiosError',
      toJSON: () => ({}),
    } as unknown as AxiosError<any>;
    const result = await _handleIdempotencyError(err, vi.fn());
    expect(result).toEqual({ kind: 'unhandled' });
    expect(toastError).not.toHaveBeenCalled();
  });
});

describe('IDEMPOTENCY_MESSAGES — exact Arabic strings (regression guard)', () => {
  // If product wants to wordsmith these later, the test will fail
  // loudly so we re-verify the contract with translation/ops.
  it('PAYLOAD_MISMATCH', () => {
    expect(IDEMPOTENCY_MESSAGES.PAYLOAD_MISMATCH).toBe(
      'تم استخدام هذا الطلب من قبل ببيانات مختلفة. أعد فتح النافذة وحاول مرة أخرى.',
    );
  });
  it('IN_PROGRESS_RETRY', () => {
    expect(IDEMPOTENCY_MESSAGES.IN_PROGRESS_RETRY).toBe(
      'الطلب الأصلي قيد المعالجة، جاري الانتظار...',
    );
  });
  it('IN_PROGRESS_FINAL', () => {
    expect(IDEMPOTENCY_MESSAGES.IN_PROGRESS_FINAL).toBe(
      'الطلب لا يزال قيد المعالجة. حدّث الصفحة بعد لحظات.',
    );
  });
  it('CACHE_UNAVAILABLE', () => {
    expect(IDEMPOTENCY_MESSAGES.CACHE_UNAVAILABLE).toBe(
      'خدمة الحماية من التكرار غير متوفرة الآن. حاول مرة أخرى بعد قليل.',
    );
  });
  it('KEY_INVALID', () => {
    expect(IDEMPOTENCY_MESSAGES.KEY_INVALID).toBe(
      'خطأ تقني في مفتاح منع التكرار. أعد المحاولة.',
    );
  });
  it('IDEMPOTENCY_RETRY_DELAY_MS is in the user-spec 1–2 s window', () => {
    expect(IDEMPOTENCY_RETRY_DELAY_MS).toBeGreaterThanOrEqual(1000);
    expect(IDEMPOTENCY_RETRY_DELAY_MS).toBeLessThanOrEqual(2000);
  });
});
