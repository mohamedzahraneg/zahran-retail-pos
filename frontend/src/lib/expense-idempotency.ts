/**
 * expense-idempotency.ts — PR-AUDIT-IDEMPOTENCY-ACCOUNTING-EXPENSES-FE
 *
 * Tiny module that mints (and recycles) one Idempotency-Key per
 * expense modal intent. Sibling of `checkout-idempotency.ts` and
 * `transfer-idempotency.ts`, scoped to the two expense routes
 * shipped in BE PR #279:
 *
 *   · POST /accounting/expenses
 *   · POST /accounting/expenses/daily
 *
 * Intent boundary: ONE open expense modal session = ONE intent.
 * Two callers exist today:
 *   · `AddExpenseModal` in `frontend/src/pages/DailyExpenses.tsx`
 *   · `AdvanceModal` in `frontend/src/components/team/AccountsMovementsTab.tsx`
 * Both are conditional-rendered (`{flag && <Modal/>}`) so a
 * `useEffect(() => { reset(); return () => reset(); }, [])` inside
 * each modal yields a fresh key on mount and a defensive reset on
 * unmount. Field changes within an open modal do NOT reset.
 *
 * Both routes share ONE FE singleton — within an open modal the
 * cashier might (in principle) submit either route, and they form
 * a single logical intent. The BE namespace
 * `idempotency:v1:<METHOD>:<PATH>:<key>` keeps the two routes'
 * cache entries distinct on the BE side, so this is safe.
 *
 * Format: `crypto.randomUUID()` when available, 32-char hex fallback.
 * Both shapes satisfy the BE regex /^[A-Za-z0-9_-]{8,128}$/.
 */

import type { InternalAxiosRequestConfig } from 'axios';

const ACCOUNTING_EXPENSES_PATH = '/accounting/expenses';
const ACCOUNTING_EXPENSES_DAILY_PATH = '/accounting/expenses/daily';
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

export function getOrCreateExpenseIdempotencyKey(): string {
  if (!currentKey) currentKey = mintKey();
  return currentKey;
}

export function resetExpenseIdempotencyKey(): void {
  currentKey = null;
}

export function _resetExpenseIdempotencyKeyForTests(): void {
  currentKey = null;
}

/**
 * Pure helper used by the axios request interceptor in `client.ts`.
 * Attaches the Idempotency-Key header for the two expense routes,
 * preserving any caller-provided header.
 *
 * Rules:
 *   · Method must be POST (case-insensitive).
 *   · URL must be exactly `/accounting/expenses` OR exactly
 *     `/accounting/expenses/daily` (strict equality, not prefix).
 *     This guards against `/accounting/expenses/anything-else`,
 *     `/accounting/expenses/:id/approve`, etc., from accidentally
 *     receiving the header.
 *   · A caller-provided Idempotency-Key (any casing) is preserved.
 */
export function attachExpenseIdempotencyKeyIfApplicable<
  T extends Pick<InternalAxiosRequestConfig, 'method' | 'url' | 'headers'>,
>(config: T): T {
  const method = String(config.method ?? '').toLowerCase();
  if (method !== 'post') return config;
  if (
    config.url !== ACCOUNTING_EXPENSES_PATH &&
    config.url !== ACCOUNTING_EXPENSES_DAILY_PATH
  ) {
    return config;
  }

  const headers = (config.headers ?? {}) as Record<string, unknown>;
  if (
    headers[HEADER_NAME] !== undefined ||
    headers['idempotency-key'] !== undefined ||
    headers['IDEMPOTENCY-KEY'] !== undefined
  ) {
    return config;
  }

  config.headers = headers as any;
  (config.headers as any)[HEADER_NAME] =
    getOrCreateExpenseIdempotencyKey();
  return config;
}
