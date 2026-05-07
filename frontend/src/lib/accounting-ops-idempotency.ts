/**
 * accounting-ops-idempotency.ts — PR-FE-IDEM-ACCOUNTING-OPS
 *   (Sprint 5 / FE-IDEM PR 7B)
 *
 * Seven sibling helpers in one module — covers accounting + chart-
 * of-accounts mutation routes already protected backend-side:
 *
 *   · POST /accounting/approvals/:id/approve              (BE: PR #312)
 *   · POST /accounting/expenses/:id/approve               (BE: PR #312)
 *   · POST /accounting/expenses/edit-requests/:id/approve (BE: PR #312)
 *   · POST /accounts/journal                              (BE: PR #312)
 *   · POST /accounts/journal/:id/void                     (BE: PR #312)
 *   · POST /accounts/close-year                           (BE: PR #312)
 *   · POST /accounts/depreciation/run                     (BE: PR #312)
 *
 * URL note: the BE chart-of-accounts controller is
 * `@Controller('accounts')` — the deployed route prefix is
 * `/accounts/*`, NOT `/chart-of-accounts/*`. The filename
 * `chart-of-accounts.controller.ts` is the source-tree convention
 * but doesn't drive the URL.
 *
 * One module-scoped key per ACTION TYPE. Reasoning mirrors prior
 * multi-route helpers (reservations, returns, pos-invoice,
 * payroll, shifts):
 *   1. Each action lives behind its own UI affordance.
 *   2. The lifecycle reset on modal mount/unmount + per-click
 *      reset on row-button flows keeps each action a distinct
 *      intent.
 *   3. Within ONE intent, retries / 425 IN_PROGRESS auto-retries
 *      (PR #315) reuse the same axios config → same key → BE
 *      replay.
 *
 * Note: `expenses/:id/approve` has NO current FE caller (the
 * approval flow goes through `approvals/:id/approve` in the
 * generic inbox). The helper still gates the URL so a future
 * caller automatically gets the key without further plumbing —
 * same pattern as `approve-wage` in payroll-idempotency.
 *
 * Out of scope (intentionally NOT decorated):
 *   · POST /accounting/expenses              (create — owned by
 *                                              expense-idempotency)
 *   · POST /accounting/expenses/daily        (daily expense — owned
 *                                              by expense-idempotency)
 *   · POST /accounting/approvals/:id/reject  (state flip)
 *   · POST /accounting/expenses/edit-requests/:id/reject  (state)
 *   · POST /accounting/expenses/edit-requests/:id/cancel  (state)
 *   · POST /accounting/approvals/rules*      (CRUD)
 *   · POST /accounting/categories*           (CRUD)
 *   · POST /accounts/chart, /accounts/fixed-assets,
 *     /accounts/budgets, /accounts/cost-centers, /accounts/fx/*,
 *     /accounts/audit/*, /accounts/journal/backfill (CRUD/admin)
 *   · GET on any accounting/accounts path
 *
 * Format: `crypto.randomUUID()` when available, 32-char hex
 * fallback. Both shapes satisfy the BE regex
 * /^[A-Za-z0-9_-]{8,128}$/.
 */

import type { InternalAxiosRequestConfig } from 'axios';

// Strict route patterns. Anchors guarantee disjoint coverage:
//   · /accounting/expenses                → no match (create — expense helper)
//   · /accounting/expenses/daily          → no match (daily — expense helper)
//   · /accounting/approvals/:id/reject    → no match (state)
//   · /accounting/expenses/edit-requests/:id/reject|cancel → no match
//   · /accounts/chart|fixed-assets|budgets|cost-centers|fx|audit|journal/backfill → no match
//   · /accounts/journal/:id/void/anything → no match (suffix attack)
const ACCOUNTING_APPROVAL_APPROVE_RE =
  /^\/accounting\/approvals\/[A-Za-z0-9_-]+\/approve$/;
const ACCOUNTING_EXPENSE_APPROVE_RE =
  /^\/accounting\/expenses\/[A-Za-z0-9_-]+\/approve$/;
const ACCOUNTING_EDIT_REQUEST_APPROVE_RE =
  /^\/accounting\/expenses\/edit-requests\/[A-Za-z0-9_-]+\/approve$/;
const ACCOUNTS_JOURNAL_CREATE_RE = /^\/accounts\/journal$/;
const ACCOUNTS_JOURNAL_VOID_RE =
  /^\/accounts\/journal\/[A-Za-z0-9_-]+\/void$/;
const ACCOUNTS_CLOSE_YEAR_RE = /^\/accounts\/close-year$/;
const ACCOUNTS_DEPRECIATION_RUN_RE = /^\/accounts\/depreciation\/run$/;

const HEADER_NAME = 'Idempotency-Key';

let approvalApproveKey: string | null = null;
let expenseApproveKey: string | null = null;
let editRequestApproveKey: string | null = null;
let journalCreateKey: string | null = null;
let journalVoidKey: string | null = null;
let closeYearKey: string | null = null;
let runDepreciationKey: string | null = null;

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

// ─── Approval inbox approve ──────────────────────────────────────────
export function getOrCreateAccountingOpsApprovalApproveIdempotencyKey(): string {
  if (!approvalApproveKey) approvalApproveKey = mintKey();
  return approvalApproveKey;
}
export function resetAccountingOpsApprovalApproveIdempotencyKey(): void {
  approvalApproveKey = null;
}
export function _resetAccountingOpsApprovalApproveIdempotencyKeyForTests(): void {
  approvalApproveKey = null;
}

// ─── Expense approve (no current FE caller; URL gate only) ───────────
export function getOrCreateAccountingOpsExpenseApproveIdempotencyKey(): string {
  if (!expenseApproveKey) expenseApproveKey = mintKey();
  return expenseApproveKey;
}
export function resetAccountingOpsExpenseApproveIdempotencyKey(): void {
  expenseApproveKey = null;
}
export function _resetAccountingOpsExpenseApproveIdempotencyKeyForTests(): void {
  expenseApproveKey = null;
}

// ─── Edit-request approve ────────────────────────────────────────────
export function getOrCreateAccountingOpsEditRequestApproveIdempotencyKey(): string {
  if (!editRequestApproveKey) editRequestApproveKey = mintKey();
  return editRequestApproveKey;
}
export function resetAccountingOpsEditRequestApproveIdempotencyKey(): void {
  editRequestApproveKey = null;
}
export function _resetAccountingOpsEditRequestApproveIdempotencyKeyForTests(): void {
  editRequestApproveKey = null;
}

// ─── Manual journal create ───────────────────────────────────────────
export function getOrCreateAccountingOpsJournalCreateIdempotencyKey(): string {
  if (!journalCreateKey) journalCreateKey = mintKey();
  return journalCreateKey;
}
export function resetAccountingOpsJournalCreateIdempotencyKey(): void {
  journalCreateKey = null;
}
export function _resetAccountingOpsJournalCreateIdempotencyKeyForTests(): void {
  journalCreateKey = null;
}

// ─── Journal void ────────────────────────────────────────────────────
export function getOrCreateAccountingOpsJournalVoidIdempotencyKey(): string {
  if (!journalVoidKey) journalVoidKey = mintKey();
  return journalVoidKey;
}
export function resetAccountingOpsJournalVoidIdempotencyKey(): void {
  journalVoidKey = null;
}
export function _resetAccountingOpsJournalVoidIdempotencyKeyForTests(): void {
  journalVoidKey = null;
}

// ─── Close year ──────────────────────────────────────────────────────
export function getOrCreateAccountingOpsCloseYearIdempotencyKey(): string {
  if (!closeYearKey) closeYearKey = mintKey();
  return closeYearKey;
}
export function resetAccountingOpsCloseYearIdempotencyKey(): void {
  closeYearKey = null;
}
export function _resetAccountingOpsCloseYearIdempotencyKeyForTests(): void {
  closeYearKey = null;
}

// ─── Depreciation run ────────────────────────────────────────────────
export function getOrCreateAccountingOpsRunDepreciationIdempotencyKey(): string {
  if (!runDepreciationKey) runDepreciationKey = mintKey();
  return runDepreciationKey;
}
export function resetAccountingOpsRunDepreciationIdempotencyKey(): void {
  runDepreciationKey = null;
}
export function _resetAccountingOpsRunDepreciationIdempotencyKeyForTests(): void {
  runDepreciationKey = null;
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
 *       POST /accounting/expenses + /accounting/expenses/daily
 *         (owned by expense-idempotency, NOT this helper)
 *       POST /accounting/approvals/:id/reject (state)
 *       POST /accounting/expenses/edit-requests/:id/{reject,cancel} (state)
 *       POST /accounting/{approvals/rules,categories}* (CRUD)
 *       POST /accounts/{chart,fixed-assets,budgets,cost-centers,
 *         fx/*,audit/*,journal/backfill} (CRUD/admin)
 *       GET  on any accounting/accounts path
 */
export function attachAccountingOpsIdempotencyKeyIfApplicable<
  T extends Pick<InternalAxiosRequestConfig, 'method' | 'url' | 'headers'>,
>(config: T): T {
  const method = String(config.method ?? '').toLowerCase();
  if (method !== 'post') return config;

  const url = config.url ?? '';
  let key: string | undefined;
  // Order: most-specific patterns first to avoid shadowing.
  if (ACCOUNTING_EDIT_REQUEST_APPROVE_RE.test(url)) {
    key = getOrCreateAccountingOpsEditRequestApproveIdempotencyKey();
  } else if (ACCOUNTING_APPROVAL_APPROVE_RE.test(url)) {
    key = getOrCreateAccountingOpsApprovalApproveIdempotencyKey();
  } else if (ACCOUNTING_EXPENSE_APPROVE_RE.test(url)) {
    key = getOrCreateAccountingOpsExpenseApproveIdempotencyKey();
  } else if (ACCOUNTS_JOURNAL_VOID_RE.test(url)) {
    key = getOrCreateAccountingOpsJournalVoidIdempotencyKey();
  } else if (ACCOUNTS_JOURNAL_CREATE_RE.test(url)) {
    key = getOrCreateAccountingOpsJournalCreateIdempotencyKey();
  } else if (ACCOUNTS_CLOSE_YEAR_RE.test(url)) {
    key = getOrCreateAccountingOpsCloseYearIdempotencyKey();
  } else if (ACCOUNTS_DEPRECIATION_RUN_RE.test(url)) {
    key = getOrCreateAccountingOpsRunDepreciationIdempotencyKey();
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
