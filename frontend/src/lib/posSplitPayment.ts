/**
 * posSplitPayment.ts — PR-POS-PAY-1
 * ────────────────────────────────────────────────────────────────────
 *
 * Pure validation + summary helpers for the POS split-payment flow.
 * Kept outside the React component so the math is testable in
 * isolation (no DOM, no providers, no cart store) — and so any
 * future refactor of `PaymentModal` can swap UI without breaking
 * the 1:N payment contract the backend already accepts.
 *
 * Backend contract: `POST /pos/invoices` already takes
 *   payments: InvoicePaymentDto[]
 * (see `backend/src/pos/dto/invoice.dto.ts`). This module just
 * makes the frontend match that contract correctly.
 */

import type { PaymentDraft } from '@/stores/cart.store';
import type { PaymentMethodCode } from '@/api/payments.api';

/**
 * UI-side row shape used by `PaymentModal`. Contains an extra `uid`
 * so React keys are stable as the cashier adds/removes rows.
 */
export interface SplitPaymentRow {
  uid: string;
  method: PaymentMethodCode;
  amount: number;
  payment_account_id: string | null;
  account_display_name?: string | null;
  reference?: string;
}

export interface SplitPaymentValidation {
  ok: boolean;
  /** Arabic reason for the operator. `null` only when `ok=true`. */
  reason: string | null;
}

export interface SplitPaymentSummary {
  /** Σ rows.amount, rounded to 2 decimals. */
  totalPaid: number;
  /** Σ cash-row amounts only — what hits the cash drawer. */
  cashPaid: number;
  /** Σ non-cash row amounts. Cannot exceed grand_total + EPSILON. */
  nonCashPaid: number;
  /** Math.max(0, grandTotal − totalPaid). Drives "آجل" / partial pay. */
  remaining: number;
  /** Math.max(0, totalPaid − grandTotal). Cash change to return. */
  change: number;
  /** True when grandTotal − totalPaid is within ±EPSILON. */
  isFullyPaid: boolean;
  /** True when totalPaid > grandTotal + EPSILON. */
  hasOverage: boolean;
}

/** 1-cent rounding tolerance for float-comparison. */
const EPSILON = 0.01;

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Caller-supplied predicate: returns true when the given non-cash
 * method requires an explicit `payment_account_id` selection. The
 * predicate is injected so the validator stays testable without
 * pulling in the full payment-accounts catalog. The current POS
 * rule: any non-cash method that has at least one active account
 * in the catalog requires a selection (matches the existing
 * `blockedNoAccount` UI gate).
 */
export type AccountRequiredPredicate = (m: PaymentMethodCode) => boolean;

/**
 * Validate a list of split-payment rows against the invoice grand
 * total. Returns the first violation found so the UI can surface a
 * focused error message.
 *
 * Rules (locked by PR-POS-PAY-1):
 *   1. At least one row.
 *   2. Each row has a method.
 *   3. Each row's amount > 0 (no zero, negative, or NaN).
 *   4. Non-cash methods that require an account must have one selected.
 *   5. Σ NON-cash amounts ≤ grand_total + 0.01. Cash overpay is
 *      allowed (the overage becomes change). Non-cash overpay isn't —
 *      we can't refund a card swipe by handing back cash.
 *   6. Partial pay is allowed (remaining > 0 → credit / آجل).
 */
export function validateSplitPayments(
  rows: SplitPaymentRow[],
  grandTotal: number,
  opts: { isAccountRequired: AccountRequiredPredicate },
): SplitPaymentValidation {
  if (!rows.length) {
    return { ok: false, reason: 'أضف وسيلة دفع واحدة على الأقل.' };
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r.method) {
      return { ok: false, reason: `سطر #${i + 1}: اختر وسيلة الدفع.` };
    }
    if (!Number.isFinite(r.amount) || r.amount <= 0) {
      return {
        ok: false,
        reason: `سطر #${i + 1}: المبلغ يجب أن يكون أكبر من صفر.`,
      };
    }
    if (
      r.method !== 'cash' &&
      opts.isAccountRequired(r.method) &&
      !r.payment_account_id
    ) {
      return {
        ok: false,
        reason: `سطر #${i + 1}: هذه الوسيلة تحتاج اختيار حساب الدفع.`,
      };
    }
  }
  const summary = summarizeSplitPayments(rows, grandTotal);
  // Non-cash overage is NOT allowed — we can't hand back cash for a
  // card swipe / wallet transfer surplus.
  if (summary.nonCashPaid > grandTotal + EPSILON) {
    return {
      ok: false,
      reason: 'مجموع المدفوعات غير النقدية أكبر من إجمالي الفاتورة.',
    };
  }
  return { ok: true, reason: null };
}

/**
 * Compute totals/remaining/change without validating. Useful for the
 * summary panel even when the form is in an invalid state.
 */
export function summarizeSplitPayments(
  rows: SplitPaymentRow[],
  grandTotal: number,
): SplitPaymentSummary {
  const cashPaid = round2(
    rows
      .filter((r) => r.method === 'cash')
      .reduce((s, r) => s + Math.max(0, Number(r.amount) || 0), 0),
  );
  const nonCashPaid = round2(
    rows
      .filter((r) => r.method !== 'cash')
      .reduce((s, r) => s + Math.max(0, Number(r.amount) || 0), 0),
  );
  const totalPaid = round2(cashPaid + nonCashPaid);
  const grand = round2(grandTotal);
  const remaining = round2(Math.max(0, grand - totalPaid));
  const change = round2(Math.max(0, totalPaid - grand));
  return {
    totalPaid,
    cashPaid,
    nonCashPaid,
    remaining,
    change,
    isFullyPaid: Math.abs(grand - totalPaid) <= EPSILON || totalPaid >= grand,
    hasOverage: totalPaid > grand + EPSILON,
  };
}

/**
 * Convert UI rows into the `PaymentDraft[]` shape the cart store +
 * backend `CreateInvoiceDto.payments` expects. Drops UI-only fields
 * (`uid`) and rounds amount to 2 decimals.
 */
export function rowsToPaymentDrafts(rows: SplitPaymentRow[]): PaymentDraft[] {
  return rows.map((r) => ({
    method: r.method,
    amount: round2(r.amount),
    payment_account_id: r.payment_account_id ?? null,
    account_display_name: r.account_display_name ?? undefined,
    reference: r.reference,
  }));
}

/**
 * Generate a stable-ish row uid. Not crypto-secure — we only need
 * uniqueness within a single PaymentModal session.
 */
let _rowCounter = 0;
export function makeRowUid(): string {
  _rowCounter += 1;
  return `pay-row-${Date.now().toString(36)}-${_rowCounter}`;
}
