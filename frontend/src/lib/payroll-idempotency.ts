/**
 * payroll-idempotency.ts — PR-FE-IDEM-PAYROLL-FAMILY
 *   (Sprint 5 / FE-IDEM PR 6)
 *
 * Seven sibling helpers in one module — covers the payroll/employee
 * financial routes already protected backend-side:
 *
 *   · POST /attendance/admin/approve-wage/:attendance_id  (BE: PR #312)
 *   · POST /attendance/admin/void-accrual/:payable_day_id (BE: PR #311)
 *   · POST /attendance/admin/approve-wage-override        (BE: PR #312)
 *   · POST /attendance/admin/pay-wage                     (BE: PR #312)
 *   · POST /employees/:id/bonuses                         (BE: PR #309)
 *   · POST /employees/:id/deductions                      (BE: PR #309)
 *   · POST /employees/:id/settlements                     (BE: PR #309)
 *
 * One module-scoped key per ACTION TYPE. Reasoning mirrors prior
 * multi-route helpers (reservations, returns, pos-invoice):
 *   1. Each action lives behind its own UI affordance — independent
 *      intents must not collide on the same key.
 *   2. The lifecycle reset on modal mount/unmount + per-click reset
 *      on row-button flows keeps each action a distinct intent.
 *   3. Within ONE intent, retries / 425 IN_PROGRESS auto-retries
 *      (PR #315) reuse the same axios config → same Idempotency-Key
 *      → BE replay.
 *
 * Note: `approve-wage/:id` has NO current FE caller (the canonical
 * approval path is `approve-wage-override`, per the comment at
 * AttendanceWageTab.tsx:22-27). The helper still gates the URL so
 * a future caller automatically gets the key without further
 * plumbing.
 *
 * Out of scope (intentionally NOT decorated):
 *   · POST /attendance/clock-in / clock-out               (employee state)
 *   · POST /attendance/admin/clock-in / clock-out         (admin state)
 *   · POST /attendance/admin/mark-payable-day             (state — JE only at approve-wage)
 *   · PATCH /attendance/:id                               (admin edit, state)
 *   · POST /employees/me/requests*                        (request flow, state)
 *   · POST /employees/requests/:id/decide                 (state flip)
 *   · POST /employees/me/tasks/:id/{acknowledge,complete} (UX)
 *   · POST /employees/tasks*                              (UX)
 *   · PATCH /employees/:id/profile                        (CRUD)
 *
 * Format: `crypto.randomUUID()` when available, 32-char hex
 * fallback. Both shapes satisfy the BE regex
 * /^[A-Za-z0-9_-]{8,128}$/.
 */

import type { InternalAxiosRequestConfig } from 'axios';

// Strict route patterns. The `:id` segment matches A-Za-z0-9 + `-`;
// we don't validate UUID shape — the BE rejects malformed IDs.
// Anchors guarantee disjoint coverage:
//   · /attendance/clock-in           → no match (state)
//   · /attendance/admin/clock-in     → no match (state)
//   · /attendance/admin/mark-payable-day → no match (state)
//   · /attendance/admin/approve-wage/:id/anything → no match (suffix attack)
//   · /employees/:id (PATCH /profile etc.) → no match (different verbs)
//   · /employees/me/requests*        → no match (no /bonuses or /deductions
//                                                or /settlements segment)
const ATTENDANCE_APPROVE_WAGE_RE =
  /^\/attendance\/admin\/approve-wage\/[A-Za-z0-9_-]+$/;
const ATTENDANCE_VOID_ACCRUAL_RE =
  /^\/attendance\/admin\/void-accrual\/[A-Za-z0-9_-]+$/;
const ATTENDANCE_APPROVE_WAGE_OVERRIDE_RE =
  /^\/attendance\/admin\/approve-wage-override$/;
const ATTENDANCE_PAY_WAGE_RE = /^\/attendance\/admin\/pay-wage$/;
const EMPLOYEES_BONUSES_RE =
  /^\/employees\/[A-Za-z0-9_-]+\/bonuses$/;
const EMPLOYEES_DEDUCTIONS_RE =
  /^\/employees\/[A-Za-z0-9_-]+\/deductions$/;
const EMPLOYEES_SETTLEMENTS_RE =
  /^\/employees\/[A-Za-z0-9_-]+\/settlements$/;

const HEADER_NAME = 'Idempotency-Key';

let approveWageKey: string | null = null;
let voidAccrualKey: string | null = null;
let approveWageOverrideKey: string | null = null;
let payWageKey: string | null = null;
let bonusKey: string | null = null;
let deductionKey: string | null = null;
let settlementKey: string | null = null;

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

// ─── Approve wage (per attendance_id) ────────────────────────────────
export function getOrCreatePayrollApproveWageIdempotencyKey(): string {
  if (!approveWageKey) approveWageKey = mintKey();
  return approveWageKey;
}
export function resetPayrollApproveWageIdempotencyKey(): void {
  approveWageKey = null;
}
export function _resetPayrollApproveWageIdempotencyKeyForTests(): void {
  approveWageKey = null;
}

// ─── Void accrual ────────────────────────────────────────────────────
export function getOrCreatePayrollVoidAccrualIdempotencyKey(): string {
  if (!voidAccrualKey) voidAccrualKey = mintKey();
  return voidAccrualKey;
}
export function resetPayrollVoidAccrualIdempotencyKey(): void {
  voidAccrualKey = null;
}
export function _resetPayrollVoidAccrualIdempotencyKeyForTests(): void {
  voidAccrualKey = null;
}

// ─── Approve wage override ───────────────────────────────────────────
export function getOrCreatePayrollApproveWageOverrideIdempotencyKey(): string {
  if (!approveWageOverrideKey) approveWageOverrideKey = mintKey();
  return approveWageOverrideKey;
}
export function resetPayrollApproveWageOverrideIdempotencyKey(): void {
  approveWageOverrideKey = null;
}
export function _resetPayrollApproveWageOverrideIdempotencyKeyForTests(): void {
  approveWageOverrideKey = null;
}

// ─── Pay wage ────────────────────────────────────────────────────────
export function getOrCreatePayrollPayWageIdempotencyKey(): string {
  if (!payWageKey) payWageKey = mintKey();
  return payWageKey;
}
export function resetPayrollPayWageIdempotencyKey(): void {
  payWageKey = null;
}
export function _resetPayrollPayWageIdempotencyKeyForTests(): void {
  payWageKey = null;
}

// ─── Employee bonus ──────────────────────────────────────────────────
export function getOrCreatePayrollBonusIdempotencyKey(): string {
  if (!bonusKey) bonusKey = mintKey();
  return bonusKey;
}
export function resetPayrollBonusIdempotencyKey(): void {
  bonusKey = null;
}
export function _resetPayrollBonusIdempotencyKeyForTests(): void {
  bonusKey = null;
}

// ─── Employee deduction ──────────────────────────────────────────────
export function getOrCreatePayrollDeductionIdempotencyKey(): string {
  if (!deductionKey) deductionKey = mintKey();
  return deductionKey;
}
export function resetPayrollDeductionIdempotencyKey(): void {
  deductionKey = null;
}
export function _resetPayrollDeductionIdempotencyKeyForTests(): void {
  deductionKey = null;
}

// ─── Employee settlement ─────────────────────────────────────────────
export function getOrCreatePayrollSettlementIdempotencyKey(): string {
  if (!settlementKey) settlementKey = mintKey();
  return settlementKey;
}
export function resetPayrollSettlementIdempotencyKey(): void {
  settlementKey = null;
}
export function _resetPayrollSettlementIdempotencyKeyForTests(): void {
  settlementKey = null;
}

/**
 * Pure helper used by the axios request interceptor in `client.ts`.
 * Inspects the URL, matches against the seven exact patterns, and
 * attaches the action-specific Idempotency-Key. No-op for any
 * other URL or method.
 *
 * Rules:
 *   · Method must be POST (case-insensitive).
 *   · URL must match exactly one of the seven patterns above.
 *   · A caller-provided Idempotency-Key (any casing) is preserved.
 *   · Routes intentionally NOT decorated (rejected by anchors):
 *       POST /attendance/clock-in / clock-out / admin/clock-* / admin/mark-payable-day
 *       PATCH /attendance/:id
 *       POST /employees/me/requests* / requests/:id/decide / me/tasks/* / tasks/*
 *       PATCH /employees/:id/profile
 *       GET on any /attendance/* or /employees/*
 */
export function attachPayrollIdempotencyKeyIfApplicable<
  T extends Pick<InternalAxiosRequestConfig, 'method' | 'url' | 'headers'>,
>(config: T): T {
  const method = String(config.method ?? '').toLowerCase();
  if (method !== 'post') return config;

  const url = config.url ?? '';
  let key: string | undefined;
  if (ATTENDANCE_APPROVE_WAGE_RE.test(url)) {
    key = getOrCreatePayrollApproveWageIdempotencyKey();
  } else if (ATTENDANCE_VOID_ACCRUAL_RE.test(url)) {
    key = getOrCreatePayrollVoidAccrualIdempotencyKey();
  } else if (ATTENDANCE_APPROVE_WAGE_OVERRIDE_RE.test(url)) {
    key = getOrCreatePayrollApproveWageOverrideIdempotencyKey();
  } else if (ATTENDANCE_PAY_WAGE_RE.test(url)) {
    key = getOrCreatePayrollPayWageIdempotencyKey();
  } else if (EMPLOYEES_BONUSES_RE.test(url)) {
    key = getOrCreatePayrollBonusIdempotencyKey();
  } else if (EMPLOYEES_DEDUCTIONS_RE.test(url)) {
    key = getOrCreatePayrollDeductionIdempotencyKey();
  } else if (EMPLOYEES_SETTLEMENTS_RE.test(url)) {
    key = getOrCreatePayrollSettlementIdempotencyKey();
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
