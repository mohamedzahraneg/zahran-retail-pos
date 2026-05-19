/**
 * advance-client-token.ts — PR-FIX-ADVANCE-EXPENSE-DEDUPE (FE)
 *
 * Mints + lifecycles the `client_token` body field that the advance
 * branch of `POST /accounting/expenses/daily` (and
 * `POST /accounting/expenses`) sends so the BE can deduplicate at the
 * DB level via the partial unique index
 * `uq_expenses_advance_client_token_live` (migration 140).
 *
 * Sibling of the HTTP-header `Idempotency-Key` system (Redis-backed,
 * 24h replay window) — both protections coexist:
 *
 *   · `Idempotency-Key` HEADER  →  expense-idempotency.ts
 *       module-level singleton, ONE key per open modal session,
 *       BE replay window in Redis.
 *
 *   · `client_token` BODY        →  this module
 *       per-submit-attempt token, lives in a useRef so it persists
 *       across React Query retries / double-clicks for the same
 *       submit. Reset after the mutation settles (success or error)
 *       so the operator's next attempt — e.g. after fixing a
 *       validation error — gets a fresh token and the BE treats it
 *       as a genuinely new request.
 *
 * Format: `crypto.randomUUID()` when available. The BE column is
 * `expenses.client_token uuid` and the DTO is `@IsUUID()`, so the
 * token must be a valid UUID string.
 */

import { useMemo, useRef } from 'react';

/**
 * Pure helper — mint one UUID. Exported separately so unit tests can
 * exercise it without React. Production code should prefer the
 * `useAdvanceClientToken` hook below, which adds the per-submit-
 * attempt lifecycle.
 */
export function mintAdvanceClientToken(): string {
  const c = (globalThis as any).crypto as Crypto | undefined;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  // RFC 4122 v4 fallback for SSR / older browsers without
  // crypto.randomUUID. class-validator's @IsUUID() on the BE DTO
  // accepts any version, so v4 is fine.
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  const run = (n: number) => Array.from({ length: n }, hex).join('');
  return `${run(8)}-${run(4)}-4${run(3)}-${
    (8 + Math.floor(Math.random() * 4)).toString(16)
  }${run(3)}-${run(12)}`;
}

export interface AdvanceClientTokenHandle {
  /**
   * Return the current submit's token, minting one on first call.
   * Stable across retries / React Query re-runs / double-clicks of
   * the SAME submit until `reset()` is called.
   */
  ensure: () => string;
  /**
   * Clear the token. Call from the mutation's `onSuccess` and
   * `onError` callbacks so the operator's next submit attempt
   * (after fixing an error, or on the next disbursement) gets a
   * fresh token and the BE treats it as a new request.
   */
  reset: () => void;
  /**
   * Peek the current token without minting one. Returns `null` when
   * no submit is in flight. Useful for tests.
   */
  peek: () => string | null;
}

/**
 * React hook — one `client_token` lifecycle per modal instance.
 *
 * Usage:
 *   const token = useAdvanceClientToken();
 *   const mut = useMutation({
 *     mutationFn: () => api.createDailyExpense({
 *       ...
 *       is_advance: true,
 *       client_token: token.ensure(),
 *     }),
 *     onSuccess: () => { token.reset(); ... },
 *     onError:   () => { token.reset(); ... },
 *   });
 *   // Defensive — reset on unmount too.
 *   useEffect(() => () => token.reset(), [token]);
 *
 * The returned handle is `useMemo`-stable across renders so it's
 * safe to include in dependency arrays.
 */
export function useAdvanceClientToken(): AdvanceClientTokenHandle {
  const ref = useRef<string | null>(null);
  return useMemo<AdvanceClientTokenHandle>(
    () => ({
      ensure() {
        if (!ref.current) {
          ref.current = mintAdvanceClientToken();
        }
        return ref.current;
      },
      reset() {
        ref.current = null;
      },
      peek() {
        return ref.current;
      },
    }),
    [],
  );
}
