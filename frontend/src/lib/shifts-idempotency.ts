/**
 * shifts-idempotency.ts — PR-FE-IDEM-SHIFTS-OPS
 *   (Sprint 5 / FE-IDEM PR 7A)
 *
 * Three sibling helpers in one module — covers shift mutation routes
 * already protected backend-side:
 *
 *   · POST /shifts/:id/close          (BE: PR #312 / PR-11F)
 *   · POST /shifts/:id/approve-close  (BE: PR #312 / PR-11F)
 *   · POST /shifts/:id/adjust-count   (BE: PR #306 / PR-11A — direct CT writes)
 *
 * One module-scoped key per ACTION TYPE. Reasoning mirrors prior
 * multi-route helpers (reservations, returns, pos-invoice, payroll):
 *   1. Each action lives behind its own UI affordance — independent
 *      intents must not collide on the same key.
 *   2. The lifecycle reset on modal mount/unmount + per-click reset
 *      on row-button flows keeps each action a distinct intent.
 *   3. Within ONE intent, retries / 425 IN_PROGRESS auto-retries
 *      (PR #315) reuse the same axios config → same Idempotency-Key
 *      → BE replay.
 *
 * Out of scope (intentionally NOT decorated):
 *   · POST /shifts/:id/request-close (state — operator submits a
 *                                     close request, no JE/CT yet;
 *                                     CloseShiftModal can call this
 *                                     OR /close based on permission)
 *   · POST /shifts/:id/reject-close  (state flip — admin rejects a
 *                                     pending close, no JE/CT)
 *   · POST /shifts/open              (state — opens the shift)
 *   · GET  on any /shifts/* path     (read-only)
 *   · POST /shifts/reports/*         (read-only — aggregated reports)
 *
 * Format: `crypto.randomUUID()` when available, 32-char hex
 * fallback. Both shapes satisfy the BE regex
 * /^[A-Za-z0-9_-]{8,128}$/.
 */

import type { InternalAxiosRequestConfig } from 'axios';

// Strict route patterns. The `:id` segment matches A-Za-z0-9 + `-`;
// we don't validate UUID shape — the BE rejects malformed IDs.
// Anchors guarantee disjoint coverage:
//   · /shifts/open                  → no match (state)
//   · /shifts                       → no match (list)
//   · /shifts/:id                   → no match (get details)
//   · /shifts/:id/request-close     → no match (state — out of scope)
//   · /shifts/:id/reject-close      → no match (state — out of scope)
//   · /shifts/:id/close/anything    → no match (suffix attack)
//   · /shifts/reports/*             → no match (read-only)
const SHIFTS_CLOSE_RE = /^\/shifts\/[A-Za-z0-9_-]+\/close$/;
const SHIFTS_APPROVE_CLOSE_RE = /^\/shifts\/[A-Za-z0-9_-]+\/approve-close$/;
const SHIFTS_ADJUST_COUNT_RE = /^\/shifts\/[A-Za-z0-9_-]+\/adjust-count$/;

const HEADER_NAME = 'Idempotency-Key';

let closeKey: string | null = null;
let approveCloseKey: string | null = null;
let adjustCountKey: string | null = null;

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

// ─── Close (admin direct close) ──────────────────────────────────────
export function getOrCreateShiftsCloseIdempotencyKey(): string {
  if (!closeKey) closeKey = mintKey();
  return closeKey;
}
export function resetShiftsCloseIdempotencyKey(): void {
  closeKey = null;
}
export function _resetShiftsCloseIdempotencyKeyForTests(): void {
  closeKey = null;
}

// ─── Approve close (admin approves a pending close) ──────────────────
export function getOrCreateShiftsApproveCloseIdempotencyKey(): string {
  if (!approveCloseKey) approveCloseKey = mintKey();
  return approveCloseKey;
}
export function resetShiftsApproveCloseIdempotencyKey(): void {
  approveCloseKey = null;
}
export function _resetShiftsApproveCloseIdempotencyKeyForTests(): void {
  approveCloseKey = null;
}

// ─── Adjust count (admin tweaks the actual closing amount) ───────────
export function getOrCreateShiftsAdjustCountIdempotencyKey(): string {
  if (!adjustCountKey) adjustCountKey = mintKey();
  return adjustCountKey;
}
export function resetShiftsAdjustCountIdempotencyKey(): void {
  adjustCountKey = null;
}
export function _resetShiftsAdjustCountIdempotencyKeyForTests(): void {
  adjustCountKey = null;
}

/**
 * Pure helper used by the axios request interceptor in `client.ts`.
 * Inspects the URL, matches against the three exact patterns, and
 * attaches the action-specific Idempotency-Key. No-op for any
 * other URL or method.
 *
 * Rules:
 *   · Method must be POST (case-insensitive).
 *   · URL must match exactly one of the three patterns:
 *       /shifts/{id}/close
 *       /shifts/{id}/approve-close
 *       /shifts/{id}/adjust-count
 *   · A caller-provided Idempotency-Key (any casing) is preserved.
 *   · Routes intentionally NOT decorated (rejected by anchors):
 *       POST /shifts/{id}/request-close (state — out of scope)
 *       POST /shifts/{id}/reject-close  (state — out of scope)
 *       POST /shifts/open               (state)
 *       POST /shifts/reports/*          (read-only)
 *       GET  on any /shifts/*           (read-only)
 */
export function attachShiftsIdempotencyKeyIfApplicable<
  T extends Pick<InternalAxiosRequestConfig, 'method' | 'url' | 'headers'>,
>(config: T): T {
  const method = String(config.method ?? '').toLowerCase();
  if (method !== 'post') return config;

  const url = config.url ?? '';
  let key: string | undefined;
  if (SHIFTS_CLOSE_RE.test(url)) {
    key = getOrCreateShiftsCloseIdempotencyKey();
  } else if (SHIFTS_APPROVE_CLOSE_RE.test(url)) {
    key = getOrCreateShiftsApproveCloseIdempotencyKey();
  } else if (SHIFTS_ADJUST_COUNT_RE.test(url)) {
    key = getOrCreateShiftsAdjustCountIdempotencyKey();
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
