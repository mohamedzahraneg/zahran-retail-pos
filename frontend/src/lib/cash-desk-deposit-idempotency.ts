/**
 * cash-desk-deposit-idempotency.ts — PR-FE-IDEM-CASHDESK-DEPOSIT
 *   (Sprint 5 / FE-IDEM PR 2)
 *
 * Tiny module that mints (and recycles) one Idempotency-Key per
 * deposit/withdraw intent. Mirror of `transfer-idempotency.ts`,
 * scoped to the `POST /cash-desk/deposit` route — which serves
 * BOTH directions: deposit (`direction: 'in'`) and withdraw
 * (`direction: 'out'`) share the same backend endpoint and the
 * same `cashDeskApi.deposit()` wrapper, so a single helper covers
 * both flows.
 *
 * Intent boundary: ONE DepositModal session = ONE intent. The
 * modal is conditionally rendered (`{showDeposit && <DepositModal/>}`)
 * so it mounts on open and unmounts on close. We wire
 * `resetCashDeskDepositIdempotencyKey()` into a useEffect with a
 * cleanup return — clean slate on mount, defensive reset on
 * unmount. Within the open modal session, every retry of the same
 * submit (network blip, manual cashier retry, 425 IN_PROGRESS
 * auto-retry from PR-FE-IDEM-RESPONSE-INTERCEPTOR) reuses the
 * same key. Field tweaks within the modal do NOT reset — that's
 * intentional; payload-tamper safety is enforced BE-side via 409
 * IDEMPOTENCY_KEY_PAYLOAD_MISMATCH (handled centrally by the
 * shared response interceptor with its dedicated Arabic toast).
 *
 * Contract:
 *   · `getOrCreateCashDeskDepositIdempotencyKey()` — returns the
 *     active key, creating one on first call.
 *   · `resetCashDeskDepositIdempotencyKey()` — drops the active key
 *     so the next get() returns a fresh one.
 *   · `attachCashDeskDepositIdempotencyKeyIfApplicable(config)` —
 *     pure helper. Mutates the axios config to attach the header
 *     IFF the request is `POST /cash-desk/deposit` AND the caller
 *     has not already supplied an Idempotency-Key (any casing).
 *     No-op otherwise.
 *
 * Format: `crypto.randomUUID()` when available, 32-char hex
 * fallback. Both shapes satisfy the BE regex
 * /^[A-Za-z0-9_-]{8,128}$/ enforced by the BE
 * IdempotencyInterceptor.
 */

import type { InternalAxiosRequestConfig } from 'axios';

const CASH_DESK_DEPOSIT_PATH = '/cash-desk/deposit';
const HEADER_NAME = 'Idempotency-Key';

let currentKey: string | null = null;

function mintKey(): string {
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  // Fallback — old browsers / non-secure contexts. Not crypto-strong,
  // but the only requirement is uniqueness within one cashier device,
  // and shape compliance with the BE regex.
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

export function getOrCreateCashDeskDepositIdempotencyKey(): string {
  if (!currentKey) currentKey = mintKey();
  return currentKey;
}

export function resetCashDeskDepositIdempotencyKey(): void {
  currentKey = null;
}

/**
 * Test seam — equivalent to `resetCashDeskDepositIdempotencyKey` but
 * named separately so it's obvious in spec files. Kept under an
 * underscore prefix to discourage production imports.
 */
export function _resetCashDeskDepositIdempotencyKeyForTests(): void {
  currentKey = null;
}

/**
 * Pure helper used by the axios request interceptor in `client.ts`.
 * Attaches the Idempotency-Key header for `POST /cash-desk/deposit`,
 * preserving any caller-provided header.
 *
 * Rules:
 *   · Method must be POST (case-insensitive).
 *   · URL must be exactly `/cash-desk/deposit` (not a prefix match,
 *     so siblings like `/cash-desk/deposit/anything-else` are NOT
 *     decorated — guards against accidental scope creep).
 *   · A caller-provided Idempotency-Key (any casing) is preserved.
 */
export function attachCashDeskDepositIdempotencyKeyIfApplicable<
  T extends Pick<InternalAxiosRequestConfig, 'method' | 'url' | 'headers'>,
>(config: T): T {
  const method = String(config.method ?? '').toLowerCase();
  if (method !== 'post') return config;
  if (config.url !== CASH_DESK_DEPOSIT_PATH) return config;

  const headers = (config.headers ?? {}) as Record<string, unknown>;
  // Honor any casing of the caller-provided header. Avoid double-set.
  if (
    headers[HEADER_NAME] !== undefined ||
    headers['idempotency-key'] !== undefined ||
    headers['IDEMPOTENCY-KEY'] !== undefined
  ) {
    return config;
  }

  config.headers = headers as any;
  (config.headers as any)[HEADER_NAME] =
    getOrCreateCashDeskDepositIdempotencyKey();
  return config;
}
