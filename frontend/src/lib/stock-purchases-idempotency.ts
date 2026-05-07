/**
 * stock-purchases-idempotency.ts — PR-FE-IDEM-STOCK-PURCHASES-OPS
 *   (Sprint 5 / FE-IDEM PR 7C)
 *
 * Eight sibling helpers in one module — covers stock-transfer +
 * purchase mutation routes already protected backend-side:
 *
 *   · POST  /stock-transfers                        (BE: PR #310/PR-11E)
 *   · POST  /stock-transfers/:id/ship               (BE: PR #310/PR-11E)
 *   · POST  /stock-transfers/:id/receive            (BE: PR #310/PR-11E)
 *   · POST  /stock-transfers/:id/cancel             (BE: PR #310/PR-11E)
 *   · POST  /purchases/:id/receive                  (BE: PR #310/PR-11E)
 *   · POST  /purchases/:id/pay                      (BE: PR #307/PR-11B)
 *   · PATCH /purchases/:id/cancel                   (BE: PR #310/PR-11E)
 *   · PATCH /purchases/returns/:id/cancel           (BE: PR #310/PR-11E)
 *
 * Note: the user's audit spec mentioned `POST /stock-transfers/:id/
 * finalize-shortage` — that route does NOT exist in the BE
 * StockTransfersController and is intentionally dropped from scope.
 * The actual BE-protected stock-transfer routes are 4 (create,
 * ship, receive, cancel), confirmed by inspecting both source and
 * compiled JS in the running api container.
 *
 * One module-scoped key per ACTION TYPE. Reasoning mirrors prior
 * multi-route helpers — independent intents must not collide.
 *
 * Note: `PATCH /purchases/returns/:id/cancel` (cancelReturn) has
 * NO current FE caller (no component imports purchasesApi.cancelReturn
 * — verified by grep). The helper still gates the URL so a future
 * caller automatically gets the key. Same pattern as approve-wage
 * in payroll-idempotency and expense-approve in accounting-ops.
 *
 * Out of scope (intentionally NOT decorated):
 *   · GET  on any /stock-transfers/* or /purchases/* path
 *   · POST /purchases (create) — state-only INSERT, no JE/CT
 *   · POST /purchases/:id/edit (state — out of scope)
 *   · POST /purchases/returns (createReturn — state)
 *   · POST /stock-transfers (read/list — but list is GET)
 *
 * Format: `crypto.randomUUID()` when available, 32-char hex
 * fallback. Both shapes satisfy the BE regex
 * /^[A-Za-z0-9_-]{8,128}$/.
 */

import type { InternalAxiosRequestConfig } from 'axios';

// Strict route patterns. Anchors guarantee disjoint coverage. Note
// the method-specific dispatch — the `cancel` routes are PATCH (not
// POST) because the BE PurchasesController declares them as
// `@Patch(':id/cancel')` and `@Patch('returns/:id/cancel')`.
const STOCK_TRANSFER_CREATE_RE = /^\/stock-transfers$/;
const STOCK_TRANSFER_SHIP_RE = /^\/stock-transfers\/[A-Za-z0-9_-]+\/ship$/;
const STOCK_TRANSFER_RECEIVE_RE =
  /^\/stock-transfers\/[A-Za-z0-9_-]+\/receive$/;
const STOCK_TRANSFER_CANCEL_RE =
  /^\/stock-transfers\/[A-Za-z0-9_-]+\/cancel$/;
const PURCHASE_RECEIVE_RE = /^\/purchases\/[A-Za-z0-9_-]+\/receive$/;
const PURCHASE_PAY_RE = /^\/purchases\/[A-Za-z0-9_-]+\/pay$/;
const PURCHASE_CANCEL_RE = /^\/purchases\/[A-Za-z0-9_-]+\/cancel$/;
const PURCHASE_RETURN_CANCEL_RE =
  /^\/purchases\/returns\/[A-Za-z0-9_-]+\/cancel$/;

const HEADER_NAME = 'Idempotency-Key';

let stockTransferCreateKey: string | null = null;
let stockTransferShipKey: string | null = null;
let stockTransferReceiveKey: string | null = null;
let stockTransferCancelKey: string | null = null;
let purchaseReceiveKey: string | null = null;
let purchasePayKey: string | null = null;
let purchaseCancelKey: string | null = null;
let purchaseReturnCancelKey: string | null = null;

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

// ─── Stock-transfer create ───────────────────────────────────────────
export function getOrCreateStockTransferCreateIdempotencyKey(): string {
  if (!stockTransferCreateKey) stockTransferCreateKey = mintKey();
  return stockTransferCreateKey;
}
export function resetStockTransferCreateIdempotencyKey(): void {
  stockTransferCreateKey = null;
}
export function _resetStockTransferCreateIdempotencyKeyForTests(): void {
  stockTransferCreateKey = null;
}

// ─── Stock-transfer ship ─────────────────────────────────────────────
export function getOrCreateStockTransferShipIdempotencyKey(): string {
  if (!stockTransferShipKey) stockTransferShipKey = mintKey();
  return stockTransferShipKey;
}
export function resetStockTransferShipIdempotencyKey(): void {
  stockTransferShipKey = null;
}
export function _resetStockTransferShipIdempotencyKeyForTests(): void {
  stockTransferShipKey = null;
}

// ─── Stock-transfer receive ──────────────────────────────────────────
export function getOrCreateStockTransferReceiveIdempotencyKey(): string {
  if (!stockTransferReceiveKey) stockTransferReceiveKey = mintKey();
  return stockTransferReceiveKey;
}
export function resetStockTransferReceiveIdempotencyKey(): void {
  stockTransferReceiveKey = null;
}
export function _resetStockTransferReceiveIdempotencyKeyForTests(): void {
  stockTransferReceiveKey = null;
}

// ─── Stock-transfer cancel ───────────────────────────────────────────
export function getOrCreateStockTransferCancelIdempotencyKey(): string {
  if (!stockTransferCancelKey) stockTransferCancelKey = mintKey();
  return stockTransferCancelKey;
}
export function resetStockTransferCancelIdempotencyKey(): void {
  stockTransferCancelKey = null;
}
export function _resetStockTransferCancelIdempotencyKeyForTests(): void {
  stockTransferCancelKey = null;
}

// ─── Purchase receive ────────────────────────────────────────────────
export function getOrCreatePurchaseReceiveIdempotencyKey(): string {
  if (!purchaseReceiveKey) purchaseReceiveKey = mintKey();
  return purchaseReceiveKey;
}
export function resetPurchaseReceiveIdempotencyKey(): void {
  purchaseReceiveKey = null;
}
export function _resetPurchaseReceiveIdempotencyKeyForTests(): void {
  purchaseReceiveKey = null;
}

// ─── Purchase pay ────────────────────────────────────────────────────
export function getOrCreatePurchasePayIdempotencyKey(): string {
  if (!purchasePayKey) purchasePayKey = mintKey();
  return purchasePayKey;
}
export function resetPurchasePayIdempotencyKey(): void {
  purchasePayKey = null;
}
export function _resetPurchasePayIdempotencyKeyForTests(): void {
  purchasePayKey = null;
}

// ─── Purchase cancel (PATCH) ─────────────────────────────────────────
export function getOrCreatePurchaseCancelIdempotencyKey(): string {
  if (!purchaseCancelKey) purchaseCancelKey = mintKey();
  return purchaseCancelKey;
}
export function resetPurchaseCancelIdempotencyKey(): void {
  purchaseCancelKey = null;
}
export function _resetPurchaseCancelIdempotencyKeyForTests(): void {
  purchaseCancelKey = null;
}

// ─── Purchase return cancel (PATCH, no current FE caller) ────────────
export function getOrCreatePurchaseReturnCancelIdempotencyKey(): string {
  if (!purchaseReturnCancelKey) purchaseReturnCancelKey = mintKey();
  return purchaseReturnCancelKey;
}
export function resetPurchaseReturnCancelIdempotencyKey(): void {
  purchaseReturnCancelKey = null;
}
export function _resetPurchaseReturnCancelIdempotencyKeyForTests(): void {
  purchaseReturnCancelKey = null;
}

/**
 * Pure helper used by the axios request interceptor in `client.ts`.
 * Method-aware (POST vs PATCH) since the BE declares some routes as
 * PATCH. Inspects URL + method, matches against the eight exact
 * patterns, and attaches the action-specific Idempotency-Key.
 *
 * Rules:
 *   · Method must match the per-route HTTP verb (POST or PATCH).
 *   · URL must match exactly one of the eight patterns above.
 *   · A caller-provided Idempotency-Key (any casing) is preserved.
 *   · Routes intentionally NOT decorated (rejected by anchors):
 *       POST /purchases (create)        — state INSERT, no JE/CT
 *       POST /purchases/:id/edit        — state edit
 *       POST /purchases/returns         — createReturn state
 *       GET  on any /stock-transfers/* or /purchases/* path
 */
export function attachStockPurchasesIdempotencyKeyIfApplicable<
  T extends Pick<InternalAxiosRequestConfig, 'method' | 'url' | 'headers'>,
>(config: T): T {
  const method = String(config.method ?? '').toLowerCase();
  const url = config.url ?? '';
  let key: string | undefined;

  if (method === 'post') {
    if (STOCK_TRANSFER_CREATE_RE.test(url)) {
      key = getOrCreateStockTransferCreateIdempotencyKey();
    } else if (STOCK_TRANSFER_SHIP_RE.test(url)) {
      key = getOrCreateStockTransferShipIdempotencyKey();
    } else if (STOCK_TRANSFER_RECEIVE_RE.test(url)) {
      key = getOrCreateStockTransferReceiveIdempotencyKey();
    } else if (STOCK_TRANSFER_CANCEL_RE.test(url)) {
      key = getOrCreateStockTransferCancelIdempotencyKey();
    } else if (PURCHASE_RECEIVE_RE.test(url)) {
      key = getOrCreatePurchaseReceiveIdempotencyKey();
    } else if (PURCHASE_PAY_RE.test(url)) {
      key = getOrCreatePurchasePayIdempotencyKey();
    } else {
      return config;
    }
  } else if (method === 'patch') {
    // PATCH-only routes — putting them in a separate branch makes
    // the method gate strict (a POST to /purchases/:id/cancel would
    // not match here, since the BE expects PATCH).
    if (PURCHASE_RETURN_CANCEL_RE.test(url)) {
      // Order: most-specific first to avoid shadowing — a generic
      // /purchases/:id/cancel would match before this one if we
      // checked it first.
      key = getOrCreatePurchaseReturnCancelIdempotencyKey();
    } else if (PURCHASE_CANCEL_RE.test(url)) {
      key = getOrCreatePurchaseCancelIdempotencyKey();
    } else {
      return config;
    }
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
