/**
 * customer-payment-idempotency.ts
 * — PR-AUDIT-IDEMPOTENCY-CASH-DESK-CUSTOMER-PAYMENTS-FE
 *
 * Tiny module that mints (and recycles) one Idempotency-Key per
 * ReceiptModal session. Sibling of the existing helpers
 * (checkout / transfer / expense), scoped to the customer-receipt
 * route shipped in BE PR #281:
 *
 *   · POST /cash-desk/customer-payments
 *
 * Intent boundary: ONE open ReceiptModal session = ONE intent. The
 * single FE caller (`ReceiptModal` in
 * `frontend/src/components/cash-desk/ReceiptModal.tsx`) is mounted
 * conditionally from `Customers.tsx` — `{receiptTarget && <ReceiptModal/>}`
 * — so a `useEffect(() => { reset(); return () => reset(); }, [])`
 * inside the modal yields a fresh key on mount and a defensive
 * reset on unmount. Field changes within an open modal do NOT
 * reset.
 *
 * The companion concern — sorting `allocations` by invoice_id so
 * the BE's body-hash is stable across legitimate retries — lives
 * separately in `cashDeskApi.receive` (see canonicalizeReceivePayload
 * in `frontend/src/api/cash-desk.api.ts`). It is intentionally NOT
 * in this module, which is solely about the HEADER.
 *
 * Format: `crypto.randomUUID()` when available, 32-char hex fallback.
 * Both shapes satisfy the BE regex /^[A-Za-z0-9_-]{8,128}$/.
 */

import type { InternalAxiosRequestConfig } from 'axios';

const CASH_DESK_CUSTOMER_PAYMENTS_PATH = '/cash-desk/customer-payments';
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

export function getOrCreateCustomerPaymentIdempotencyKey(): string {
  if (!currentKey) currentKey = mintKey();
  return currentKey;
}

export function resetCustomerPaymentIdempotencyKey(): void {
  currentKey = null;
}

export function _resetCustomerPaymentIdempotencyKeyForTests(): void {
  currentKey = null;
}

/**
 * Pure helper used by the axios request interceptor in `client.ts`.
 * Attaches the Idempotency-Key header for `POST /cash-desk/customer-payments`,
 * preserving any caller-provided header.
 *
 * Rules:
 *   · Method must be POST (case-insensitive).
 *   · URL must be exactly `/cash-desk/customer-payments` (strict
 *     equality, NOT prefix). Guards against the `:id/void` route
 *     and any future suffix routes from accidentally receiving
 *     the header.
 *   · A caller-provided Idempotency-Key (any casing) is preserved.
 */
export function attachCustomerPaymentIdempotencyKeyIfApplicable<
  T extends Pick<InternalAxiosRequestConfig, 'method' | 'url' | 'headers'>,
>(config: T): T {
  const method = String(config.method ?? '').toLowerCase();
  if (method !== 'post') return config;
  if (config.url !== CASH_DESK_CUSTOMER_PAYMENTS_PATH) return config;

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
    getOrCreateCustomerPaymentIdempotencyKey();
  return config;
}
