/**
 * transfer-idempotency.ts — PR-AUDIT-IDEMPOTENCY-CASH-DESK-TRANSFER-FE
 *
 * Tiny module that mints (and recycles) one Idempotency-Key per
 * cash-desk transfer intent. Mirror of `checkout-idempotency.ts`,
 * scoped to the `POST /cash-desk/transfer` route.
 *
 * Intent boundary: ONE TransferModal session = ONE intent. The
 * modal is conditionally rendered (`{showTransfer && <TransferModal/>}`)
 * so it mounts on open and unmounts on close. We wire
 * `resetTransferIdempotencyKey()` into a useEffect with a cleanup
 * return — clean slate on mount, defensive reset on unmount. Within
 * the open modal session, every retry of the same submit (network
 * blip, manual retry) reuses the same key.
 *
 * Contract:
 *   · `getOrCreateTransferIdempotencyKey()` — returns the active key,
 *     creating one on first call.
 *   · `resetTransferIdempotencyKey()` — drops the active key so the
 *     next get() returns a fresh one.
 *   · `attachTransferIdempotencyKeyIfApplicable(config)` — pure helper.
 *     Mutates the axios config to attach the header IFF the request
 *     is `POST /cash-desk/transfer` AND the caller has not already
 *     supplied an Idempotency-Key (any casing). No-op otherwise.
 *
 * Format: `crypto.randomUUID()` when available, 32-char hex fallback.
 * Both shapes satisfy the BE regex /^[A-Za-z0-9_-]{8,128}$/.
 */

import type { InternalAxiosRequestConfig } from 'axios';

const CASH_DESK_TRANSFER_PATH = '/cash-desk/transfer';
const HEADER_NAME = 'Idempotency-Key';

let currentKey: string | null = null;

function mintKey(): string {
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === 'function') {
    return c.randomUUID();
  }
  let out = '';
  for (let i = 0; i < 32; i++) {
    out += Math.floor(Math.random() * 16).toString(16);
  }
  return out;
}

export function getOrCreateTransferIdempotencyKey(): string {
  if (!currentKey) currentKey = mintKey();
  return currentKey;
}

export function resetTransferIdempotencyKey(): void {
  currentKey = null;
}

export function _resetTransferIdempotencyKeyForTests(): void {
  currentKey = null;
}

/**
 * Pure helper used by the axios request interceptor in `client.ts`.
 * Attaches the Idempotency-Key header for `POST /cash-desk/transfer`,
 * preserving any caller-provided header.
 *
 * Rules:
 *   · Method must be POST (case-insensitive).
 *   · URL must be exactly `/cash-desk/transfer` (not a prefix match,
 *     so siblings like `/cash-desk/transfer/anything-else` are NOT
 *     decorated — guards against accidental scope creep).
 *   · A caller-provided Idempotency-Key (any casing) is preserved.
 */
export function attachTransferIdempotencyKeyIfApplicable<
  T extends Pick<InternalAxiosRequestConfig, 'method' | 'url' | 'headers'>,
>(config: T): T {
  const method = String(config.method ?? '').toLowerCase();
  if (method !== 'post') return config;
  if (config.url !== CASH_DESK_TRANSFER_PATH) return config;

  const headers = (config.headers ?? {}) as Record<string, unknown>;
  if (
    headers[HEADER_NAME] !== undefined ||
    headers['idempotency-key'] !== undefined ||
    headers['IDEMPOTENCY-KEY'] !== undefined
  ) {
    return config;
  }

  config.headers = headers as any;
  (config.headers as any)[HEADER_NAME] = getOrCreateTransferIdempotencyKey();
  return config;
}
