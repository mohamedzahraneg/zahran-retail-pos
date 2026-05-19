/**
 * settlement-client-token.spec.ts — PR-FIX-SETTLEMENT-DEDUPE (FE)
 *
 * Pins the lifecycle of the per-submit `client_token` UUID that the
 * settlement modal in AccountsMovementsTab sends with
 * `POST /employees/:id/settlements`. Test surface:
 *
 *   1. `mintSettlementClientToken()` returns a UUID-shaped string
 *      that the BE's class-validator `@IsUUID()` will accept.
 *
 *   2. `useSettlementClientToken()` hook:
 *      · first `ensure()` mints, repeated `ensure()` returns same
 *        token until `reset()`.
 *      · `reset()` clears; next `ensure()` mints a NEW token.
 *      · `peek()` reports the current token without minting.
 *      · two `ensure()` calls within the SAME submit attempt
 *        (double-click during pending) return the SAME token —
 *        the BE will dedupe.
 *      · the handle is referentially stable across re-renders.
 *
 *   3. Two distinct hook instances mint INDEPENDENT tokens — so
 *      AdvanceModal's advanceToken and settlementMut's
 *      settlementToken in the same open modal do NOT collide.
 *
 * The settlement module re-exports the shared UUID + useRef hook
 * from `advance-client-token`. This spec is a sibling pin so the
 * settlement contract can't drift even if the upstream module
 * changes — both modules' contracts are documented here.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  mintSettlementClientToken,
  useSettlementClientToken,
} from './settlement-client-token';

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('mintSettlementClientToken — pure helper', () => {
  it('returns a UUID-shaped string accepted by BE @IsUUID()', () => {
    const token = mintSettlementClientToken();
    expect(token).toMatch(UUID_PATTERN);
  });

  it('two calls produce different tokens', () => {
    const a = mintSettlementClientToken();
    const b = mintSettlementClientToken();
    expect(a).not.toBe(b);
  });
});

describe('useSettlementClientToken — per-submit lifecycle', () => {
  it('ensure() mints on first call, returns SAME token on subsequent calls', () => {
    const { result } = renderHook(() => useSettlementClientToken());
    const a = result.current.ensure();
    const b = result.current.ensure();
    expect(a).toMatch(UUID_PATTERN);
    expect(a).toBe(b);
  });

  it('peek() returns null before ensure() mints', () => {
    const { result } = renderHook(() => useSettlementClientToken());
    expect(result.current.peek()).toBeNull();
    result.current.ensure();
    expect(result.current.peek()).toMatch(UUID_PATTERN);
  });

  it('reset() clears the token; next ensure() mints a NEW one', () => {
    const { result } = renderHook(() => useSettlementClientToken());
    const first = result.current.ensure();

    act(() => result.current.reset());
    expect(result.current.peek()).toBeNull();

    const second = result.current.ensure();
    expect(second).toMatch(UUID_PATTERN);
    expect(second).not.toBe(first);
  });

  it('handle is referentially stable across re-renders', () => {
    const { result, rerender } = renderHook(() => useSettlementClientToken());
    const handleA = result.current;
    rerender();
    const handleB = result.current;
    expect(handleA).toBe(handleB);
    expect(handleA.ensure).toBe(handleB.ensure);
    expect(handleA.reset).toBe(handleB.reset);
  });

  // ────────────────────────────────────────────────────────────────
  // Double-click contract — two rapid calls in the SAME submit
  // attempt must produce the SAME token. Behaviour observed at
  // runtime: settlementMut.mutate() is called twice before the
  // first response settles, both mutationFn runs read the same
  // ref → same token → BE dedupes via the partial unique index.
  // ────────────────────────────────────────────────────────────────
  it('two ensure() calls within the SAME submit attempt return the SAME token', () => {
    const { result } = renderHook(() => useSettlementClientToken());
    const firstClick = result.current.ensure();
    const secondClick = result.current.ensure();
    expect(firstClick).toBe(secondClick);
  });

  it('separate submit attempts (reset between) produce different tokens', () => {
    const { result } = renderHook(() => useSettlementClientToken());

    const a = result.current.ensure();
    act(() => result.current.reset());

    const b = result.current.ensure();
    expect(a).toMatch(UUID_PATTERN);
    expect(b).toMatch(UUID_PATTERN);
    expect(a).not.toBe(b);
  });
});

// ────────────────────────────────────────────────────────────────
// Cross-hook isolation — settlement vs. advance tokens in the SAME
// open modal must NOT collide. AccountsMovementsTab's AdvanceModal
// owns BOTH advanceToken and settlementToken; the guard dialog
// routes the operator to either the advance path or the settlement
// path, and the two tokens must remain independent.
// ────────────────────────────────────────────────────────────────
describe('cross-hook isolation — settlement vs. advance independence', () => {
  it('two hook instances (settlement + advance) mint independent tokens', async () => {
    const { useAdvanceClientToken } = await import('./advance-client-token');
    const { result: settlement } = renderHook(() =>
      useSettlementClientToken(),
    );
    const { result: advance } = renderHook(() => useAdvanceClientToken());

    const settlementToken = settlement.current.ensure();
    const advanceToken = advance.current.ensure();

    expect(settlementToken).toMatch(UUID_PATTERN);
    expect(advanceToken).toMatch(UUID_PATTERN);
    // Two distinct UUIDs — neither hook leaked the other's token.
    expect(settlementToken).not.toBe(advanceToken);

    // Resetting one does NOT clear the other.
    act(() => settlement.current.reset());
    expect(settlement.current.peek()).toBeNull();
    expect(advance.current.peek()).toBe(advanceToken);
  });
});
