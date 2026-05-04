/**
 * checkout-idempotency.ts — PR-AUDIT-IDEMPOTENCY-POS-INVOICE-FE
 *
 * Tiny module that mints (and recycles) one Idempotency-Key per
 * checkout intent for the POS create-invoice flow. The BE side
 * (PR #275) treats this header as opt-in: without it, the previous
 * unprotected behavior is preserved.
 *
 * Contract:
 *   · `getOrCreateCheckoutIdempotencyKey()` — returns the active key,
 *     creating one on first call.
 *   · `resetCheckoutIdempotencyKey()` — drops the active key so the
 *     next get() returns a fresh one. Wired to `cart.clear()` so a
 *     successful sale (or any explicit cart reset) starts a new
 *     intent. Customer/warehouse changes do NOT reset.
 *   · `attachCheckoutIdempotencyKeyIfApplicable(config)` — the only
 *     call site of this module from the axios layer. Mutates the
 *     passed axios request config to attach the header IFF the
 *     request is `POST /pos/invoices` AND the caller has not already
 *     supplied an Idempotency-Key (any casing). Returns the config
 *     unchanged otherwise.
 *
 * Format: keys are produced by `crypto.randomUUID()` when available
 * (UUID v4, 36 chars from [0-9a-f-]) and fall back to a 32-char hex
 * string. Both shapes satisfy the BE regex /^[A-Za-z0-9_-]{8,128}$/.
 */

import type { InternalAxiosRequestConfig } from 'axios';

const POS_CREATE_INVOICE_PATH = '/pos/invoices';
const HEADER_NAME = 'Idempotency-Key';

let currentKey: string | null = null;

/**
 * Mint a new key. UUID v4 when the runtime exposes
 * `crypto.randomUUID`, otherwise a 32-char hex fallback.
 */
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

export function getOrCreateCheckoutIdempotencyKey(): string {
  if (!currentKey) currentKey = mintKey();
  return currentKey;
}

export function resetCheckoutIdempotencyKey(): void {
  currentKey = null;
}

/**
 * Test seam — equivalent to `resetCheckoutIdempotencyKey` but named
 * separately so it's obvious in spec files. Kept under an underscore
 * prefix to discourage production imports.
 */
export function _resetCheckoutIdempotencyKeyForTests(): void {
  currentKey = null;
}

/**
 * Pure helper used by the axios request interceptor in `client.ts`.
 * Decides whether the request should carry the Idempotency-Key
 * header and attaches it if so.
 *
 * Rules (matching the user's required behavior):
 *   · Method must be POST (case-insensitive).
 *   · URL must be exactly `/pos/invoices` (not `/pos/invoices/:id/...`).
 *   · A caller-provided Idempotency-Key (any casing) is preserved.
 */
export function attachCheckoutIdempotencyKeyIfApplicable<
  T extends Pick<InternalAxiosRequestConfig, 'method' | 'url' | 'headers'>,
>(config: T): T {
  const method = String(config.method ?? '').toLowerCase();
  if (method !== 'post') return config;
  if (config.url !== POS_CREATE_INVOICE_PATH) return config;

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
  (config.headers as any)[HEADER_NAME] = getOrCreateCheckoutIdempotencyKey();
  return config;
}
