/**
 * advance-client-token.spec.ts — PR-FIX-ADVANCE-EXPENSE-DEDUPE (FE)
 *
 * Pins the lifecycle of the per-submit `client_token` UUID that the
 * advance branch of `POST /accounting/expenses/daily` sends. Test
 * surface:
 *
 *   1. `mintAdvanceClientToken()` returns a UUID-shaped string and
 *      different calls produce different strings.
 *   2. Fallback path (no `crypto.randomUUID`) still produces a
 *      UUID-shaped string that the BE's class-validator `@IsUUID()`
 *      accepts.
 *   3. `useAdvanceClientToken()` hook:
 *      · first `ensure()` mints, repeated `ensure()` returns same
 *        token until `reset()`.
 *      · after `reset()`, next `ensure()` mints a NEW token.
 *      · `peek()` reports the current token without minting.
 *      · the handle is stable (referential identity preserved
 *        across re-renders), so depending on it in a useEffect is
 *        safe.
 *   4. A "double-click during loading" scenario — two consecutive
 *      `ensure()` calls inside one logical submit reuse the same
 *      token; only after `reset()` does the second submit attempt
 *      get a fresh token.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  mintAdvanceClientToken,
  useAdvanceClientToken,
} from './advance-client-token';

// Matches RFC 4122 / class-validator @IsUUID() — any version, hex
// digits in 8-4-4-4-12 with hyphens. We don't constrain the version
// because the BE accepts any.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('mintAdvanceClientToken — pure helper', () => {
  it('returns a UUID-shaped string', () => {
    const token = mintAdvanceClientToken();
    expect(token).toMatch(UUID_PATTERN);
  });

  it('two calls produce different tokens', () => {
    const a = mintAdvanceClientToken();
    const b = mintAdvanceClientToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(UUID_PATTERN);
    expect(b).toMatch(UUID_PATTERN);
  });

  it('falls back to a UUID-shaped string when crypto.randomUUID is unavailable', () => {
    const realCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: { ...realCrypto, randomUUID: undefined },
        configurable: true,
      });
      const token = mintAdvanceClientToken();
      expect(token).toMatch(UUID_PATTERN);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: realCrypto,
        configurable: true,
      });
    }
  });
});

describe('useAdvanceClientToken — per-submit lifecycle', () => {
  it('ensure() mints on first call, returns SAME token on subsequent calls', () => {
    const { result } = renderHook(() => useAdvanceClientToken());
    const a = result.current.ensure();
    const b = result.current.ensure();
    const c = result.current.ensure();
    expect(a).toMatch(UUID_PATTERN);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('peek() returns null before ensure() mints', () => {
    const { result } = renderHook(() => useAdvanceClientToken());
    expect(result.current.peek()).toBeNull();
    result.current.ensure();
    expect(result.current.peek()).toMatch(UUID_PATTERN);
  });

  it('reset() clears the token; next ensure() mints a NEW one', () => {
    const { result } = renderHook(() => useAdvanceClientToken());
    const first = result.current.ensure();
    expect(result.current.peek()).toBe(first);

    act(() => {
      result.current.reset();
    });
    expect(result.current.peek()).toBeNull();

    const second = result.current.ensure();
    expect(second).toMatch(UUID_PATTERN);
    expect(second).not.toBe(first);
  });

  it('the handle is referentially stable across re-renders', () => {
    const { result, rerender } = renderHook(() => useAdvanceClientToken());
    const handleA = result.current;
    rerender();
    const handleB = result.current;
    expect(handleA).toBe(handleB);
    expect(handleA.ensure).toBe(handleB.ensure);
    expect(handleA.reset).toBe(handleB.reset);
  });

  // ────────────────────────────────────────────────────────────────
  // Double-click / retry contract
  //
  // While a submit is "in flight" (in real code: between
  // `mutate()` being called and `onSuccess`/`onError` running),
  // any second call MUST receive the same token. Only after the
  // mutation settles and reset() runs does a fresh token get
  // minted.
  // ────────────────────────────────────────────────────────────────
  it('two ensure() calls within the SAME submit attempt return the SAME token', () => {
    const { result } = renderHook(() => useAdvanceClientToken());
    // Simulates two rapid mutationFn invocations from a double-click
    // before either response settles.
    const firstClickToken = result.current.ensure();
    const secondClickToken = result.current.ensure();
    expect(firstClickToken).toBe(secondClickToken);
  });

  it('separate submit attempts (reset between) produce different tokens', () => {
    const { result } = renderHook(() => useAdvanceClientToken());

    // First attempt — mutationFn → response → onSuccess/onError calls reset.
    const a = result.current.ensure();
    act(() => result.current.reset());

    // Second attempt — fresh mutationFn run.
    const b = result.current.ensure();
    act(() => result.current.reset());

    // Third attempt — fresh again.
    const c = result.current.ensure();

    expect(a).toMatch(UUID_PATTERN);
    expect(b).toMatch(UUID_PATTERN);
    expect(c).toMatch(UUID_PATTERN);
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });

  // ────────────────────────────────────────────────────────────────
  // Negative case — non-advance flows MUST not call ensure().
  // The hook itself can't enforce this (it's caller responsibility),
  // but `peek()` should report null so wiring tests can assert that
  // no token was minted when the caller decided is_advance=false.
  // ────────────────────────────────────────────────────────────────
  it('peek() stays null when caller never invokes ensure() (non-advance path)', () => {
    const { result } = renderHook(() => useAdvanceClientToken());
    expect(result.current.peek()).toBeNull();
    // Simulate a full non-advance submit that finishes without ever
    // calling ensure() — peek() must still be null.
    act(() => result.current.reset()); // defensive reset is a no-op
    expect(result.current.peek()).toBeNull();
  });
});
