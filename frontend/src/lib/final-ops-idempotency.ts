/**
 * final-ops-idempotency.ts — PR-FE-IDEM-FINAL-OPS
 *   (Sprint 5 / FE-IDEM PR 8 — final FE idempotency PR)
 *
 * Five sibling helpers in one module — covers the last 5 BE-protected
 * routes that have a verified live FE caller and were not yet
 * decorated by the prior 13 helpers:
 *
 *   · POST   /recurring-expenses/:id/run             (BE: PR #313)
 *   · POST   /recurring-expenses/process-due         (BE: PR #313)
 *   · POST   /stock/adjust                           (BE: PR #307)
 *   · POST   /inventory-counts/:id/finalize          (BE: PR #313)
 *   · DELETE /payroll/:id                            (BE: PR #310)
 *
 * Method-aware gate — this is the FIRST helper to gate a DELETE
 * route. The BE `IdempotencyInterceptor` is method-agnostic, so a
 * key on DELETE is just as safe as on POST/PATCH.
 *
 * Out of scope for THIS PR (intentionally NOT covered, all four are
 * BE-protected but the FE wrapper is dead — no UI consumer):
 *
 *   · POST /cash-desk/customer-payments/:id/void   (no FE caller)
 *   · POST /cash-desk/supplier-payments/:id/void   (no FE caller)
 *   · POST /suppliers/:id/pay                      (FE Suppliers page
 *                                                   uses SupplierPayModal
 *                                                   → cashDeskApi.pay
 *                                                   instead, which goes
 *                                                   to /cash-desk/
 *                                                   supplier-payments,
 *                                                   already covered by
 *                                                   supplier-payment-
 *                                                   idempotency)
 *   · POST /payroll                                 (whole payrollApi
 *                                                   module has 0
 *                                                   importers)
 *
 * Out of scope by design (state-only, BE not protected):
 *   · POST /recurring-expenses/{:id, :id/pause, :id/resume}, DELETE
 *   · POST /inventory-counts/{start, :id/entries, :id/cancel}, GET
 *   · POST /payroll, PATCH /payroll/:id  (state — no JE/CT effect)
 *   · all stock read/list/sync routes
 *
 * One module-scoped key per ACTION TYPE. Reasoning mirrors prior
 * multi-route helpers — independent intents must not collide.
 *
 * Format: `crypto.randomUUID()` when available, 32-char hex
 * fallback. Both shapes satisfy the BE regex
 * /^[A-Za-z0-9_-]{8,128}$/.
 */

import type { InternalAxiosRequestConfig } from 'axios';

// Strict route patterns. Anchors guarantee disjoint coverage.
//
// Note `process-due` is checked BEFORE the generic `:id/run` pattern
// because both live under `/recurring-expenses/`. Anchored regex
// makes them fully disjoint, but ordering keeps a clean reading.
const RECURRING_PROCESS_DUE_RE = /^\/recurring-expenses\/process-due$/;
const RECURRING_RUN_RE = /^\/recurring-expenses\/[A-Za-z0-9_-]+\/run$/;
const STOCK_ADJUST_RE = /^\/stock\/adjust$/;
const INVENTORY_FINALIZE_RE =
  /^\/inventory-counts\/[A-Za-z0-9_-]+\/finalize$/;
const PAYROLL_VOID_RE = /^\/payroll\/[A-Za-z0-9_-]+$/;

const HEADER_NAME = 'Idempotency-Key';

let recurringRunKey: string | null = null;
let recurringProcessDueKey: string | null = null;
let stockAdjustKey: string | null = null;
let inventoryFinalizeKey: string | null = null;
let payrollVoidKey: string | null = null;

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

// ─── Recurring run ───────────────────────────────────────────────────
export function getOrCreateRecurringRunIdempotencyKey(): string {
  if (!recurringRunKey) recurringRunKey = mintKey();
  return recurringRunKey;
}
export function resetRecurringRunIdempotencyKey(): void {
  recurringRunKey = null;
}
export function _resetRecurringRunIdempotencyKeyForTests(): void {
  recurringRunKey = null;
}

// ─── Recurring process-due ───────────────────────────────────────────
export function getOrCreateRecurringProcessDueIdempotencyKey(): string {
  if (!recurringProcessDueKey) recurringProcessDueKey = mintKey();
  return recurringProcessDueKey;
}
export function resetRecurringProcessDueIdempotencyKey(): void {
  recurringProcessDueKey = null;
}
export function _resetRecurringProcessDueIdempotencyKeyForTests(): void {
  recurringProcessDueKey = null;
}

// ─── Stock adjust ────────────────────────────────────────────────────
export function getOrCreateStockAdjustIdempotencyKey(): string {
  if (!stockAdjustKey) stockAdjustKey = mintKey();
  return stockAdjustKey;
}
export function resetStockAdjustIdempotencyKey(): void {
  stockAdjustKey = null;
}
export function _resetStockAdjustIdempotencyKeyForTests(): void {
  stockAdjustKey = null;
}

// ─── Inventory-counts finalize ───────────────────────────────────────
export function getOrCreateInventoryFinalizeIdempotencyKey(): string {
  if (!inventoryFinalizeKey) inventoryFinalizeKey = mintKey();
  return inventoryFinalizeKey;
}
export function resetInventoryFinalizeIdempotencyKey(): void {
  inventoryFinalizeKey = null;
}
export function _resetInventoryFinalizeIdempotencyKeyForTests(): void {
  inventoryFinalizeKey = null;
}

// ─── Payroll void (DELETE) ───────────────────────────────────────────
export function getOrCreatePayrollVoidIdempotencyKey(): string {
  if (!payrollVoidKey) payrollVoidKey = mintKey();
  return payrollVoidKey;
}
export function resetPayrollVoidIdempotencyKey(): void {
  payrollVoidKey = null;
}
export function _resetPayrollVoidIdempotencyKeyForTests(): void {
  payrollVoidKey = null;
}

/**
 * Pure helper used by the axios request interceptor in `client.ts`.
 * Method-aware (POST + DELETE) since payroll void is the first
 * DELETE-gated route across all 14 idempotency helpers. Inspects URL
 * + method, matches against the five exact patterns, and attaches
 * the action-specific Idempotency-Key.
 *
 * Rules:
 *   · Method must match the per-route HTTP verb (POST or DELETE).
 *   · URL must match exactly one of the five patterns above.
 *   · A caller-provided Idempotency-Key (any casing) is preserved.
 *   · Routes intentionally NOT decorated (rejected by anchors):
 *       POST   /recurring-expenses                    (state CRUD)
 *       PATCH  /recurring-expenses/:id                (state)
 *       DELETE /recurring-expenses/:id                (state — but BE
 *                                                       not protected)
 *       POST   /recurring-expenses/:id/{pause,resume} (state)
 *       POST   /stock/{warehouses, adjustments,...}   (read-only)
 *       POST   /inventory-counts/{start, :id/entries,
 *                                 :id/cancel}         (BE not protected
 *                                                       on these legs)
 *       POST   /payroll                               (BE protected,
 *                                                       but FE wrapper
 *                                                       has no UI
 *                                                       consumer — see
 *                                                       header comment)
 *       PATCH  /payroll/:id                           (state)
 *       Any GET on the five target paths.
 *   · `/employees/:id/{bonuses,deductions,settlements}` are owned by
 *     the existing `payroll-idempotency` helper, NOT by this one.
 */
export function attachFinalOpsIdempotencyKeyIfApplicable<
  T extends Pick<InternalAxiosRequestConfig, 'method' | 'url' | 'headers'>,
>(config: T): T {
  const method = String(config.method ?? '').toLowerCase();
  const url = config.url ?? '';
  let key: string | undefined;

  if (method === 'post') {
    if (RECURRING_PROCESS_DUE_RE.test(url)) {
      // Order: most-specific first — process-due is a literal segment
      // and would otherwise NOT match the :id/run pattern, but the
      // regex anchors already disambiguate. Ordered explicitly here
      // for readability.
      key = getOrCreateRecurringProcessDueIdempotencyKey();
    } else if (RECURRING_RUN_RE.test(url)) {
      key = getOrCreateRecurringRunIdempotencyKey();
    } else if (STOCK_ADJUST_RE.test(url)) {
      key = getOrCreateStockAdjustIdempotencyKey();
    } else if (INVENTORY_FINALIZE_RE.test(url)) {
      key = getOrCreateInventoryFinalizeIdempotencyKey();
    } else {
      return config;
    }
  } else if (method === 'delete') {
    // DELETE-only routes — putting them in a separate branch makes
    // the method gate strict. A POST to /payroll/:id would not match
    // here (and BE expects DELETE for the void semantic).
    if (PAYROLL_VOID_RE.test(url)) {
      key = getOrCreatePayrollVoidIdempotencyKey();
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
