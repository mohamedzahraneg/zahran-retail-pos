/**
 * gl-codes.constants.ts — PR-AUDIT-LIQUID-CODES-CONST
 *
 * Single source of truth for the four "liquid asset" GL account codes
 * the financial engine, finance dashboard, analytics, and posting
 * service all rely on.
 *
 * Scope: backend executable code only. UI-facing strings (e.g. the
 * Finance Dashboard's "(GL 1111)" suffix introduced in PR #269/#270)
 * are intentionally LEFT as literals on the frontend so a future GL
 * code rename never silently changes a label the operator already
 * learned.
 *
 * Adding a new liquid code:
 *   1. Add it as a named export below (e.g. `GL_DIGITAL_WALLET = '1116'`)
 *   2. Add it to `LIQUID_GL_CODES` in the canonical sort order
 *   3. The `LIQUID_CODES_SQL_LIST` derived constant + every consumer
 *      that destructures `LIQUID_GL_CODES` updates automatically
 *   4. Add a row to `gl-codes.constants.spec.ts` to pin the new value
 *   5. Update FE labels separately if user-facing
 */

/** Cash drawer / الخزينة الرئيسية. */
export const GL_CASH = '1111';

/** Bank accounts / البنوك. */
export const GL_BANK = '1113';

/** Electronic wallets / المحافظ الإلكترونية (InstaPay, WE Pay, etc.). */
export const GL_WALLET = '1114';

/** Checks under collection / الشيكات تحت التحصيل. */
export const GL_CHECKS = '1115';

/* ──────────────────────────────────────────────────────────────────
 * Non-liquid GL codes — PR-AUDIT-NON-LIQUID-GL-PHASE-A
 *
 * Read-only SELECT/reporting sites only. Posting/engine/line-creation
 * paths still use literals deliberately (Phase B work — out of scope
 * here). The forward-prevention spec is NOT extended in this phase;
 * adding broad non-liquid scanning is a separate follow-up.
 * ──────────────────────────────────────────────────────────────────*/

/** Employee receivables / advances — ذمم الموظفين. */
export const GL_EMPLOYEE_RECEIVABLE = '1123';

/** Employee payables / accruals — مستحقات الموظفين. */
export const GL_EMPLOYEE_PAYABLE = '213';

/** Supplier payable — الموردون والدائنون. */
export const GL_SUPPLIER_PAYABLE = '211';

/**
 * The four liquid-asset GL codes in canonical sort order. Used by
 * Finance Dashboard, Analytics, and the FinancialEngine guard to
 * compute "السيولة المحاسبية" / cash-on-hand totals.
 *
 * Iteration order is stable: cash → bank → wallet → checks.
 */
export const LIQUID_GL_CODES = [
  GL_CASH,
  GL_BANK,
  GL_WALLET,
  GL_CHECKS,
] as const;

/** Type union of the four liquid codes (compile-time safety). */
export type LiquidGlCode = typeof LIQUID_GL_CODES[number];

/**
 * SQL-quoted comma-separated list of the four liquid codes — ready
 * to interpolate into a `WHERE coa.code IN (...)` clause.
 *
 * Example:
 *   `WHERE coa.code IN (${LIQUID_CODES_SQL_LIST})`
 *
 * The values are static string literals (not user input) so this is
 * safe to interpolate without parameterization.
 */
export const LIQUID_CODES_SQL_LIST = LIQUID_GL_CODES
  .map((c) => `'${c}'`)
  .join(',');

/**
 * Cashbox-kind → liquid GL code map. Used by `posting.cashboxAccountId`
 * and `financial-engine.cashboxAccountId` as the canonical fallback
 * when a cashbox row has no explicit `cashbox_id` link on the COA.
 */
export const CASHBOX_KIND_TO_GL_CODE = {
  cash:    GL_CASH,
  bank:    GL_BANK,
  ewallet: GL_WALLET,
  check:   GL_CHECKS,
} as const;

export type CashboxKindForGl = keyof typeof CASHBOX_KIND_TO_GL_CODE;

/**
 * PR-AUDIT-CASHBOX-KIND-MAP-CENTRALIZE (Sprint 3 / PR-8)
 *
 * Strict resolver: maps a cashbox `kind` to its canonical liquid GL
 * code, or returns `null` when the kind is missing or not one of the
 * four supported values.
 *
 *   cashboxKindToGlCode('cash')     → '1111'
 *   cashboxKindToGlCode('bank')     → '1113'
 *   cashboxKindToGlCode('ewallet')  → '1114'
 *   cashboxKindToGlCode('check')    → '1115'
 *   cashboxKindToGlCode(null)       → null
 *   cashboxKindToGlCode(undefined)  → null
 *   cashboxKindToGlCode('unknown')  → null
 *
 * When to use this helper vs the raw `CASHBOX_KIND_TO_GL_CODE` map:
 *
 *   · Use `cashboxKindToGlCode(kind)` when the caller can SAFELY
 *     handle a null result — typically read paths / reporting code
 *     that wants to skip rather than guess for unrecognised rows.
 *
 *   · Use `CASHBOX_KIND_TO_GL_CODE[...] || GL_CASH` (the existing
 *     pattern in `financial-engine.service.ts` /
 *     `posting.service.ts`) when the caller MUST resolve to a real
 *     account id and falling back to the cash drawer is the
 *     canonical safety net (the GL `accountIdByCode` lookup
 *     downstream cannot accept a null code). This PR intentionally
 *     leaves those 2 sites unchanged — the `|| GL_CASH` fallback
 *     there is load-bearing engine behavior, not a duplicated map.
 */
export function cashboxKindToGlCode(
  kind: string | null | undefined,
): LiquidGlCode | null {
  if (kind == null) return null;
  if (!(kind in CASHBOX_KIND_TO_GL_CODE)) return null;
  return CASHBOX_KIND_TO_GL_CODE[kind as CashboxKindForGl];
}
