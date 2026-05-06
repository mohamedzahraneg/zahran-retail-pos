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

/* ──────────────────────────────────────────────────────────────────
 * Sensitive accounting control accounts — PR-AUDIT-GL-CODE-CONSTANTS
 * (Sprint 3 / PR-9)
 *
 * Names below match the chart_of_accounts row text (verified
 * against production at audit time, 2026-05-06). The user-facing PR
 * spec proposed `GL_VAT_PAYABLE = '421'` and `GL_CASH_VARIANCE =
 * '531'` — both names contradict the actual ledger:
 *   · '421' is "فروق ورديات (زيادة) / Shift Surplus" (revenue)
 *     — NOT VAT. The actual VAT/Tax payable account is '214'.
 *   · '531' is specifically "فروق ورديات (عجز) / Shift Deficit"
 *     (expense) — NOT a generic cash variance. Its companion is 421.
 * The names below match the actual semantics so the constant is
 * never misleading at the call site.
 * ──────────────────────────────────────────────────────────────────*/

/** Merchandise sales revenue — مبيعات السلع. */
export const GL_SALES_REVENUE = '411';

/** Tax payable (incl. VAT) — ضرائب مستحقة. Used on POS invoice tax credit. */
export const GL_TAX_PAYABLE = '214';

/**
 * Suspense / temporary settlement account — حساب التسوية المؤقت.
 * Credit side of a positive shift variance when the manager defers
 * the classification (treatment === 'suspense'); the surplus parks
 * here until reclassified.
 */
export const GL_VAT_SUSPENSE = '215';

/**
 * Shift surplus revenue — فروق ورديات (زيادة).
 * Credit side of a positive shift variance when the manager treats
 * the surplus as revenue (treatment === 'revenue').
 */
export const GL_SHIFT_SURPLUS = '421';

/** Cost of goods sold (COGS) — تكلفة البضاعة المباعة (LEAF account). */
export const GL_COGS = '51';

/**
 * Operating expenses parent — المصروفات التشغيلية (NON-LEAF).
 * Concrete sub-accounts (521 salaries, 522 rent, 523 utilities, 524
 * telecom, 525 shipping, 526 marketing, 529 misc) live under this
 * prefix and are resolved by `CostAccountResolver.HINT_MAP`. Use
 * this constant only when matching the prefix range, never as a
 * direct posting target (it's not a leaf).
 */
export const GL_OPERATING_EXPENSES_PREFIX = '52';

/**
 * Shift deficit expense — فروق ورديات (عجز).
 * Debit side of a negative shift variance when the manager treats
 * the deficit as a company loss (treatment === 'company_loss'). The
 * 'charge_employee' branch routes the debit to GL_EMPLOYEE_RECEIVABLE
 * instead.
 */
export const GL_SHIFT_DEFICIT = '531';

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
