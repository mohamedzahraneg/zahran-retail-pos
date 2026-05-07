/**
 * returns-idempotency.ts — PR-FE-IDEM-RETURNS
 *   (Sprint 5 / FE-IDEM PR 4)
 *
 * Four sibling helpers in one module — covers the four returns/
 * exchanges mutation routes that are already protected backend-side:
 *
 *   · POST /returns/:id/approve  (BE: PR #310 / PR-11E + PR #312 / PR-11F)
 *   · POST /returns/:id/refund   (BE: PR #310 / PR-11E)
 *   · POST /returns/:id/cancel   (BE: PR #310 / PR-11E)
 *   · POST /exchanges            (BE: PR #308 / PR-11C)
 *
 * One module-scoped key per ACTION TYPE (approve / refund / cancel /
 * exchange) — NOT one global key. Reasoning mirrors
 * reservation-idempotency.ts:
 *   1. Each action lives behind its own modal (ApproveModal,
 *      RefundModal, CancelReturnModal, CreateExchangeModal) which
 *      is an independent intent.
 *   2. A user could plausibly Approve return A, Refund return B,
 *      and Exchange return C in quick succession via different
 *      modal opens — distinct intents must not collide on the same
 *      key.
 *   3. The lifecycle reset on modal mount/unmount maps 1:1 to one
 *      reset per modal.
 *
 * Out of scope (intentionally NOT decorated):
 *   · POST /returns                 (create — protected by BE state guards)
 *   · POST /returns/:id/reject      (status flip, no JE/CT/stock)
 *   · GET  /returns* / /exchanges*  (read-only)
 *
 * The URL gate strictly excludes all of the above via regex
 * anchoring + a fixed alternation that does not include `reject`.
 *
 * Format: `crypto.randomUUID()` when available, 32-char hex
 * fallback. Both shapes satisfy the BE regex
 * /^[A-Za-z0-9_-]{8,128}$/.
 */

import type { InternalAxiosRequestConfig } from 'axios';

// Strict route patterns. The `:id` segment matches the same
// character class as a UUIDv4 (A-Za-z0-9 + `-`); we don't validate
// UUID shape — the BE rejects malformed IDs at controller validation.
// Anchors guarantee:
//   · /returns               → no match (create)
//   · /returns/abc-id        → no match (get details)
//   · /returns/abc-id/reject → no match (out of scope)
//   · /returns/abc-id/approve/anything → no match (suffix attack)
//   · /exchanges/abc-id      → no match (get details)
const RETURNS_APPROVE_RE =
  /^\/returns\/[A-Za-z0-9_-]+\/approve$/;
const RETURNS_REFUND_RE =
  /^\/returns\/[A-Za-z0-9_-]+\/refund$/;
const RETURNS_CANCEL_RE =
  /^\/returns\/[A-Za-z0-9_-]+\/cancel$/;
const EXCHANGES_RE = /^\/exchanges$/;

const HEADER_NAME = 'Idempotency-Key';

let approveKey: string | null = null;
let refundKey: string | null = null;
let cancelKey: string | null = null;
let exchangeKey: string | null = null;

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

// ─── Approve ─────────────────────────────────────────────────────────
export function getOrCreateReturnsApproveIdempotencyKey(): string {
  if (!approveKey) approveKey = mintKey();
  return approveKey;
}
export function resetReturnsApproveIdempotencyKey(): void {
  approveKey = null;
}
export function _resetReturnsApproveIdempotencyKeyForTests(): void {
  approveKey = null;
}

// ─── Refund ──────────────────────────────────────────────────────────
export function getOrCreateReturnsRefundIdempotencyKey(): string {
  if (!refundKey) refundKey = mintKey();
  return refundKey;
}
export function resetReturnsRefundIdempotencyKey(): void {
  refundKey = null;
}
export function _resetReturnsRefundIdempotencyKeyForTests(): void {
  refundKey = null;
}

// ─── Cancel ──────────────────────────────────────────────────────────
export function getOrCreateReturnsCancelIdempotencyKey(): string {
  if (!cancelKey) cancelKey = mintKey();
  return cancelKey;
}
export function resetReturnsCancelIdempotencyKey(): void {
  cancelKey = null;
}
export function _resetReturnsCancelIdempotencyKeyForTests(): void {
  cancelKey = null;
}

// ─── Exchange ────────────────────────────────────────────────────────
export function getOrCreateReturnsExchangeIdempotencyKey(): string {
  if (!exchangeKey) exchangeKey = mintKey();
  return exchangeKey;
}
export function resetReturnsExchangeIdempotencyKey(): void {
  exchangeKey = null;
}
export function _resetReturnsExchangeIdempotencyKeyForTests(): void {
  exchangeKey = null;
}

/**
 * Pure helper used by the axios request interceptor in `client.ts`.
 * Inspects the URL, matches against the four exact patterns, and
 * attaches the action-specific Idempotency-Key. No-op for any
 * other URL or method.
 *
 * Rules:
 *   · Method must be POST (case-insensitive).
 *   · URL must match exactly one of the four patterns:
 *       /returns/{id}/approve
 *       /returns/{id}/refund
 *       /returns/{id}/cancel
 *       /exchanges
 *   · A caller-provided Idempotency-Key (any casing) is preserved.
 *   · Routes intentionally NOT decorated:
 *       POST /returns               (create — out of scope)
 *       POST /returns/{id}/reject   (reject — out of scope)
 *       GET  any returns / exchanges read
 *       POST /exchanges/{id}/anything
 */
export function attachReturnsIdempotencyKeyIfApplicable<
  T extends Pick<InternalAxiosRequestConfig, 'method' | 'url' | 'headers'>,
>(config: T): T {
  const method = String(config.method ?? '').toLowerCase();
  if (method !== 'post') return config;

  const url = config.url ?? '';
  let key: string | undefined;
  if (RETURNS_APPROVE_RE.test(url)) {
    key = getOrCreateReturnsApproveIdempotencyKey();
  } else if (RETURNS_REFUND_RE.test(url)) {
    key = getOrCreateReturnsRefundIdempotencyKey();
  } else if (RETURNS_CANCEL_RE.test(url)) {
    key = getOrCreateReturnsCancelIdempotencyKey();
  } else if (EXCHANGES_RE.test(url)) {
    key = getOrCreateReturnsExchangeIdempotencyKey();
  } else {
    return config;
  }

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
  (config.headers as any)[HEADER_NAME] = key;
  return config;
}
