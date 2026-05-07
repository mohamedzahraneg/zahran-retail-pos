/**
 * reservation-idempotency.ts — PR-FE-IDEM-RESERVATIONS
 *   (Sprint 5 / FE-IDEM PR 3)
 *
 * Three sibling helpers in one module — covers the three reservation
 * mutation routes that are already protected backend-side:
 *
 *   · POST /reservations/:id/cancel     (PR #311 BE)
 *   · POST /reservations/:id/payments   (PR #313 BE)
 *   · POST /reservations/:id/convert    (PR #314 BE)
 *
 * One module-scoped key per ACTION TYPE (cancel / payment / convert)
 * — NOT one global key. Three reasons:
 *   1. The three actions live behind three distinct modals
 *      (CancelModal / AddPaymentModal / ConvertModal in
 *      pages/Reservations.tsx) which are independent intents.
 *   2. A user could plausibly cancel reservation A and convert
 *      reservation B in quick succession — distinct intents must
 *      not collide.
 *   3. Keeping the keys separate makes the modal lifecycle
 *      `useEffect` reset hooks a 1:1 mapping (one reset per modal).
 *
 * Note: per-RESERVATION-id is intentionally NOT used as a key
 * dimension. The lifecycle reset on modal mount/unmount already
 * gives one-key-per-modal-session, and reservation-id changes
 * always go through a modal close/reopen cycle in the existing UI.
 *
 * Out of scope: `POST /reservations` (create) and `PATCH
 * /reservations/:id/extend` — these are intentionally unprotected
 * per the Sprint 5 audit. The URL gate excludes them via strict
 * regex anchoring.
 *
 * Format: `crypto.randomUUID()` when available, 32-char hex
 * fallback. Both shapes satisfy the BE regex
 * /^[A-Za-z0-9_-]{8,128}$/.
 */

import type { InternalAxiosRequestConfig } from 'axios';

// Strict route patterns. The `:id` segment matches the same
// character class as a UUIDv4 (A-Za-z0-9 + `-`); we don't validate
// UUID shape here — the BE rejects malformed IDs at controller
// validation time. The `^…$` anchors guarantee:
//   · /reservations               → no match (create)
//   · /reservations/abc-id        → no match (get details)
//   · /reservations/abc-id/extend → no match (extend out of scope)
//   · /reservations/abc-id/cancel/anything-else → no match (suffix)
const RESERVATION_CANCEL_RE =
  /^\/reservations\/[A-Za-z0-9_-]+\/cancel$/;
const RESERVATION_PAYMENT_RE =
  /^\/reservations\/[A-Za-z0-9_-]+\/payments$/;
const RESERVATION_CONVERT_RE =
  /^\/reservations\/[A-Za-z0-9_-]+\/convert$/;

const HEADER_NAME = 'Idempotency-Key';

let cancelKey: string | null = null;
let paymentKey: string | null = null;
let convertKey: string | null = null;

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

// ─── Cancel ──────────────────────────────────────────────────────────
export function getOrCreateReservationCancelIdempotencyKey(): string {
  if (!cancelKey) cancelKey = mintKey();
  return cancelKey;
}
export function resetReservationCancelIdempotencyKey(): void {
  cancelKey = null;
}
export function _resetReservationCancelIdempotencyKeyForTests(): void {
  cancelKey = null;
}

// ─── Payment ─────────────────────────────────────────────────────────
export function getOrCreateReservationPaymentIdempotencyKey(): string {
  if (!paymentKey) paymentKey = mintKey();
  return paymentKey;
}
export function resetReservationPaymentIdempotencyKey(): void {
  paymentKey = null;
}
export function _resetReservationPaymentIdempotencyKeyForTests(): void {
  paymentKey = null;
}

// ─── Convert ─────────────────────────────────────────────────────────
export function getOrCreateReservationConvertIdempotencyKey(): string {
  if (!convertKey) convertKey = mintKey();
  return convertKey;
}
export function resetReservationConvertIdempotencyKey(): void {
  convertKey = null;
}
export function _resetReservationConvertIdempotencyKeyForTests(): void {
  convertKey = null;
}

/**
 * Pure helper used by the axios request interceptor in `client.ts`.
 * Inspects the URL, matches against the three exact patterns, and
 * attaches the action-specific Idempotency-Key. No-op for any
 * other URL or method.
 *
 * Rules:
 *   · Method must be POST (case-insensitive).
 *   · URL must match exactly one of the three regex patterns:
 *       /reservations/{id}/cancel
 *       /reservations/{id}/payments
 *       /reservations/{id}/convert
 *   · A caller-provided Idempotency-Key (any casing) is preserved.
 *   · Routes intentionally NOT decorated:
 *       POST /reservations             (create — out of scope)
 *       PATCH /reservations/{id}/extend (extend — out of scope)
 *       GET  /reservations*            (any read)
 */
export function attachReservationIdempotencyKeyIfApplicable<
  T extends Pick<InternalAxiosRequestConfig, 'method' | 'url' | 'headers'>,
>(config: T): T {
  const method = String(config.method ?? '').toLowerCase();
  if (method !== 'post') return config;

  const url = config.url ?? '';
  let key: string | undefined;
  if (RESERVATION_CANCEL_RE.test(url)) {
    key = getOrCreateReservationCancelIdempotencyKey();
  } else if (RESERVATION_PAYMENT_RE.test(url)) {
    key = getOrCreateReservationPaymentIdempotencyKey();
  } else if (RESERVATION_CONVERT_RE.test(url)) {
    key = getOrCreateReservationConvertIdempotencyKey();
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
