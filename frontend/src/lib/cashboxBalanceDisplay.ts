/**
 * cashboxBalanceDisplay.ts — PR-FIN-PAYMENTS-WALLET-DISPLAY-BALANCE
 * ─────────────────────────────────────────────────────────────────────
 * Single source of truth for "which balance does this cashbox show".
 *
 * Cashbox kind matrix
 * ===================
 *   cash    → `current_balance` (canonical physical-drawer figure;
 *             updated only by `cashbox_transactions` rows + the
 *             sanctioned rebuild path).
 *
 *   bank    → `accounting_balance` (GL net derived server-side from
 *   ewallet   account 1113 / 1114 / 1115 via the kind→code map).
 *   check     The stored `current_balance` for these kinds stays at
 *             0 forever because non-cash payments deliberately don't
 *             write CTs (see posting.service.ts:260 for the rule).
 *
 * The returned `kind` lets callers decorate the figure with an
 * appropriate badge — "كاش" stays neutral, accounting figures get a
 * small "محاسبي / GL" pill so the operator never confuses an
 * aggregate GL net with a per-drawer cash figure.
 *
 * Aggregation caveat (carried in the badge tooltip): GL accounts
 * 1113/1114/1115 are shared across every cashbox of the same `kind`
 * AND every payment_account that bucket-maps to the same code. If
 * two ewallet cashboxes existed in production, both would show the
 * same `accounting_balance`. The badge surfaces this honestly.
 */

export type DisplayBalanceKind = 'cash' | 'accounting' | 'unlinked';

export interface CashboxBalanceDisplay {
  /** Numeric value to render (already coerced; defaults to 0 if absent). */
  amount: number;
  /** Source bucket — drives label + tone in the consumer. */
  kind: DisplayBalanceKind;
  /** GL account code if `kind === 'accounting'`, else null. */
  glCode: string | null;
}

/**
 * Pick the right balance figure for a cashbox row.
 *
 * @param cb — partial cashbox row. Tolerant of either the
 *   settings-API `Cashbox` shape (numeric `current_balance`) or the
 *   cash-desk-API `Cashbox` shape (string `current_balance`). Tolerant
 *   of `accounting_balance` being missing entirely (older API).
 */
export function displayCashboxBalance(cb: {
  kind?: 'cash' | 'bank' | 'ewallet' | 'check' | string | null;
  current_balance?: string | number | null;
  accounting_balance?: string | number | null;
  accounting_gl_code?: string | null;
}): CashboxBalanceDisplay {
  const k = (cb.kind ?? 'cash') as
    | 'cash'
    | 'bank'
    | 'ewallet'
    | 'check'
    | string;
  if (k === 'cash') {
    return {
      amount: Number(cb.current_balance ?? 0) || 0,
      kind: 'cash',
      glCode: null,
    };
  }
  // Non-cash kind. Fall back to current_balance (which will be 0 in
  // the steady state) if the BE hasn't shipped accounting_balance yet
  // — degrades to the legacy display, never throws.
  if (cb.accounting_balance == null) {
    return {
      amount: Number(cb.current_balance ?? 0) || 0,
      kind: 'cash',
      glCode: null,
    };
  }
  // GL-derived. If the cashbox isn't linked to any GL account
  // (kind not in {bank, ewallet, check} → glCode would be null
  // server-side), surface the "unlinked" state so the FE can render
  // a "غير مربوط بحساب محاسبي" warning instead of pretending it has
  // a balance.
  if (!cb.accounting_gl_code) {
    return {
      amount: Number(cb.accounting_balance ?? 0) || 0,
      kind: 'unlinked',
      glCode: null,
    };
  }
  return {
    amount: Number(cb.accounting_balance ?? 0) || 0,
    kind: 'accounting',
    glCode: cb.accounting_gl_code,
  };
}
