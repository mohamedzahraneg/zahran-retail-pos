/**
 * pos-invoice-idempotency.ts — PR-FE-IDEM-POS-VOID-EDIT
 *   (Sprint 5 / FE-IDEM PR 5)
 *
 * Three sibling helpers in one module — covers POS invoice
 * mutation routes already protected backend-side:
 *
 *   · POST /pos/invoices/:id/void          (BE: PR #310 / PR-11E)
 *   · POST /pos/invoices/:id/edit          (BE: PR #308 / PR-11C)
 *   · POST /pos/edit-requests/:id/approve  (BE: PR #312 / PR-11F)
 *
 * One module-scoped key per ACTION TYPE. Reasoning mirrors
 * reservation-idempotency.ts and returns-idempotency.ts:
 *   1. Each action lives behind its own UI affordance
 *      (VoidConfirmModal, InvoiceEditModal, EditHistoryTab approve
 *      button). Independent intents must not collide on the same
 *      key.
 *   2. The lifecycle reset on modal mount/unmount + per-click
 *      reset on the row-button approve flow keeps each action a
 *      distinct intent.
 *   3. Within ONE intent (one modal session OR one row-click),
 *      retries / 425 IN_PROGRESS auto-retries (PR #315) reuse the
 *      same axios config → same Idempotency-Key → BE replay.
 *
 * Out of scope (intentionally NOT decorated):
 *   · POST /pos/invoices                       (create — protected via
 *                                                checkout-idempotency.ts;
 *                                                this helper rejects the
 *                                                URL by anchored regex)
 *   · POST /pos/invoices/:id/edit-request      (state-only — out of scope)
 *   · POST /pos/edit-requests/:id/reject       (state-only — out of scope)
 *   · GET  any /pos/* read path                (read-only)
 *
 * Format: `crypto.randomUUID()` when available, 32-char hex
 * fallback. Both shapes satisfy the BE regex
 * /^[A-Za-z0-9_-]{8,128}$/.
 */

import type { InternalAxiosRequestConfig } from 'axios';

// Strict route patterns. The `:id` segment matches A-Za-z0-9 + `-`;
// we don't validate UUID shape — the BE rejects malformed IDs.
// Anchors guarantee:
//   · /pos/invoices                 → no match (create)
//   · /pos/invoices/:id             → no match (get details)
//   · /pos/invoices/:id/edit-request → no match (state-only — out of scope)
//   · /pos/invoices/:id/void/anything → no match (suffix attack)
//   · /pos/edit-requests/:id/reject → no match (state-only — out of scope)
const POS_INVOICE_VOID_RE =
  /^\/pos\/invoices\/[A-Za-z0-9_-]+\/void$/;
const POS_INVOICE_EDIT_RE =
  /^\/pos\/invoices\/[A-Za-z0-9_-]+\/edit$/;
const POS_EDIT_REQUEST_APPROVE_RE =
  /^\/pos\/edit-requests\/[A-Za-z0-9_-]+\/approve$/;

const HEADER_NAME = 'Idempotency-Key';

let voidKey: string | null = null;
let editKey: string | null = null;
let editRequestApproveKey: string | null = null;

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

// ─── Void ────────────────────────────────────────────────────────────
export function getOrCreatePosInvoiceVoidIdempotencyKey(): string {
  if (!voidKey) voidKey = mintKey();
  return voidKey;
}
export function resetPosInvoiceVoidIdempotencyKey(): void {
  voidKey = null;
}
export function _resetPosInvoiceVoidIdempotencyKeyForTests(): void {
  voidKey = null;
}

// ─── Edit ────────────────────────────────────────────────────────────
export function getOrCreatePosInvoiceEditIdempotencyKey(): string {
  if (!editKey) editKey = mintKey();
  return editKey;
}
export function resetPosInvoiceEditIdempotencyKey(): void {
  editKey = null;
}
export function _resetPosInvoiceEditIdempotencyKeyForTests(): void {
  editKey = null;
}

// ─── Edit-request approve (per-click) ────────────────────────────────
// Note: unlike Void/Edit (modal-scoped), this key is per-CLICK on a
// pending-edit-requests row. The caller in EditHistoryTab MUST call
// `resetPosEditRequestApproveIdempotencyKey()` immediately before
// `approve.mutate(r.id)` so each click mints a fresh key. The button
// is `disabled={approve.isPending || reject.isPending}` so concurrent
// clicks within one session cannot race.
export function getOrCreatePosEditRequestApproveIdempotencyKey(): string {
  if (!editRequestApproveKey) editRequestApproveKey = mintKey();
  return editRequestApproveKey;
}
export function resetPosEditRequestApproveIdempotencyKey(): void {
  editRequestApproveKey = null;
}
export function _resetPosEditRequestApproveIdempotencyKeyForTests(): void {
  editRequestApproveKey = null;
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
 *       /pos/invoices/{id}/void
 *       /pos/invoices/{id}/edit
 *       /pos/edit-requests/{id}/approve
 *   · A caller-provided Idempotency-Key (any casing) is preserved.
 *   · Routes intentionally NOT decorated (rejected by anchors):
 *       POST /pos/invoices                       (create — uses
 *                                                  checkout-idempotency)
 *       POST /pos/invoices/{id}/edit-request     (state — out of scope)
 *       POST /pos/edit-requests/{id}/reject      (state — out of scope)
 *       GET  on any /pos/* path                  (read-only)
 */
export function attachPosInvoiceIdempotencyKeyIfApplicable<
  T extends Pick<InternalAxiosRequestConfig, 'method' | 'url' | 'headers'>,
>(config: T): T {
  const method = String(config.method ?? '').toLowerCase();
  if (method !== 'post') return config;

  const url = config.url ?? '';
  let key: string | undefined;
  if (POS_INVOICE_VOID_RE.test(url)) {
    key = getOrCreatePosInvoiceVoidIdempotencyKey();
  } else if (POS_INVOICE_EDIT_RE.test(url)) {
    key = getOrCreatePosInvoiceEditIdempotencyKey();
  } else if (POS_EDIT_REQUEST_APPROVE_RE.test(url)) {
    key = getOrCreatePosEditRequestApproveIdempotencyKey();
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
