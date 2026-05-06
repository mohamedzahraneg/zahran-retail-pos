/**
 * expense-invariants.ts — PR-FIX-EXPENSES-APP-LEVEL-CASHBOX-GUARD
 *
 * Single application-level invariant for the expense write paths:
 * a CASH-paid expense MUST have a `cashbox_id`. Otherwise the engine
 * silently posts the credit side to Accounts Payable (210) instead of
 * the cashbox, producing an "approved" expense with NO cash actually
 * leaving any drawer — a violation of the system's core financial
 * contract.
 *
 * Why a shared helper (vs a private method on AccountingService):
 *   The same combo (`payment_method`, `cashbox_id`) is validated in
 *   FIVE distinct sites across THREE services:
 *
 *     · accounting.service.ts:createExpense        (already had inline
 *       guard since the original write — kept for backwards-compat)
 *     · accounting.service.ts:updateExpense        (gap A)
 *     · accounting.service.ts:approveExpense       (gap B)
 *     · accounting.service.ts:approveEditRequest   (gap C)
 *     · approval.service.ts:decide                 (gap D)
 *     · recurring-expenses.service.ts:runOne       (gap E)
 *
 *   Centralising the rule means the Arabic error message, the
 *   normalisation of `null|undefined → 'cash'`, and the strictness
 *   gate all live in ONE file. A future change (e.g. extending the
 *   rule to ewallet/check kinds, or relaxing it for direct-cashbox
 *   advances) only needs to touch this module.
 *
 * What this PR does NOT do:
 *   · No DB migration / CHECK constraint (deferred to PR-10B).
 *   · No engine weakening — the engine still has its existing fallback
 *     to AP for non-cash expenses without a cashbox; this guard fires
 *     BEFORE the engine is reached, so legitimate non-cash flows
 *     (bank/ewallet/check expense recorded against a vendor on
 *     account) are unaffected.
 *   · No formula changes — `assertExpenseInvariants` is a pure
 *     validator: it either throws or returns `void`.
 */

import { BadRequestException } from '@nestjs/common';

/**
 * Where the guard was called from. Used only for log/error
 * disambiguation — the Arabic user-facing message is identical
 * across contexts, so the operator sees the same fixable instruction
 * regardless of which write path tripped.
 */
export type ExpenseInvariantContext =
  | 'create'
  | 'update'
  | 'approve'
  | 'edit_approve'
  | 'multilevel_approve'
  | 'recurring';

/** Single Arabic message — kept verbatim across all 5 call sites. */
export const EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE =
  'مصروف نقدي يتطلب خزنة مفتوحة — افتح وردية أو حدد خزنة';

/**
 * Throw `BadRequestException` when `payment_method` resolves to cash
 * (either explicit `'cash'`, or null/undefined which the DB defaults
 * to `'cash'::payment_method_code`) AND `cashbox_id` is null/empty.
 *
 * Returns `void` on success — caller proceeds.
 *
 * @param payment_method  the merged payment_method (DTO override OR
 *                        stored value). null/undefined is treated as
 *                        cash to mirror the DB default.
 * @param cashbox_id      the merged cashbox_id (DTO override OR stored
 *                        value). null/undefined/empty-string ⇒ missing.
 * @param _context        which write path is calling. Currently used
 *                        only for documentation / future diagnostics —
 *                        the user-visible message does not vary.
 */
export function assertExpenseInvariants(
  payment_method: string | null | undefined,
  cashbox_id: string | null | undefined,
  _context: ExpenseInvariantContext,
): void {
  const pm = (payment_method ?? 'cash').toString().toLowerCase();
  const hasCashbox =
    cashbox_id !== null &&
    cashbox_id !== undefined &&
    String(cashbox_id).length > 0;
  if (pm === 'cash' && !hasCashbox) {
    throw new BadRequestException(EXPENSE_CASH_REQUIRES_CASHBOX_MESSAGE);
  }
}
