/**
 * posStockGuard.ts — PR-POS-STOCK-1
 * ────────────────────────────────────────────────────────────────────
 *
 * Pure validation helpers for the POS out-of-stock guard. Kept outside
 * the POS page so the math is testable in isolation (no DOM, no React
 * Query, no cart store) and so all three add-to-cart paths (Enter /
 * scanner / click) share one decision function.
 *
 * The frontend gate is the FIRST line of defence — it makes the toast
 * appear at scan time instead of at submit time. The DB CHECK
 * constraint (`stock_quantity_on_hand_check` from migration 004) and
 * the backend pre-check inside `pos.service.ts::createInvoice` are
 * the LAST line of defence (race conditions, offline-replay, direct
 * curl). Both layers stay in place.
 *
 * Arabic error strings are returned by these helpers so the UI doesn't
 * have to translate decisions into messages — keeps the i18n surface
 * close to the rules.
 */

/** Minimal cart-line shape this module needs. Pluggable so the cart
 *  store schema can change without breaking the guard's contract. */
export interface StockGuardLine {
  variantId: string;
  qty: number;
  /** Snapshot of `stock.quantity_on_hand` for the cart's warehouse at
   *  the moment the line was added. `undefined` means "we never
   *  captured stock for this line" — defensive: treat as unbounded so
   *  legacy lines that pre-date PR-POS-STOCK-1 still submit. The
   *  backend's pre-check is the authoritative gate for those. */
  availableStock?: number;
  /** Optional human label for richer error messages on the submit
   *  gate (which scans many lines at once). */
  name?: string;
}

export type StockGuardResult =
  | { ok: true }
  | { ok: false; reason: string };

/* ──────────────────────────────────────────────────────────────────
 * Helpers
 * ────────────────────────────────────────────────────────────────── */

/** Defensive coercion: treats `null`, `undefined`, `NaN`, negatives
 *  as 0. Anything finite ≥ 0 passes through. */
const safeStock = (n: number | null | undefined): number => {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return 0;
  return v;
};

/* ──────────────────────────────────────────────────────────────────
 * canAddOne — Enter / scanner / image-scan path
 *
 * Decides whether a single-unit add should fire. Caller passes:
 *   - `current`: the existing cart line for this variant, if any.
 *   - `availableStock`: the warehouse-scoped stock figure freshly
 *      returned by the byBarcode call.
 *
 * Rules:
 *   1. availableStock <= 0 → block ("نفذ").
 *   2. (current?.qty ?? 0) + 1 > availableStock → block (already at
 *      cap → re-Enter must not bump past it).
 *   3. otherwise → allow.
 * ────────────────────────────────────────────────────────────────── */
export function canAddOne(args: {
  current: StockGuardLine | null;
  availableStock: number | null | undefined;
}): StockGuardResult {
  const available = safeStock(args.availableStock);
  if (available <= 0) {
    return { ok: false, reason: 'هذا المنتج نفذ من المخزون' };
  }
  const currentQty = Math.max(0, Number(args.current?.qty ?? 0) || 0);
  if (currentQty + 1 > available) {
    return { ok: false, reason: `الرصيد المتاح ${available} فقط` };
  }
  return { ok: true };
}

/* ──────────────────────────────────────────────────────────────────
 * canBumpTo — cart "+1" / qty edit
 *
 * Decides whether changing a cart line's qty to `nextQty` is allowed.
 * Lines without an `availableStock` annotation are treated as
 * unbounded by THIS guard — the backend pre-check is the authority
 * for those (defensive default keeps legacy invoices editable).
 * ────────────────────────────────────────────────────────────────── */
export function canBumpTo(args: {
  line: StockGuardLine;
  nextQty: number;
}): StockGuardResult {
  const next = Number(args.nextQty);
  if (!Number.isFinite(next) || next < 0) {
    return { ok: false, reason: 'الكمية غير صحيحة' };
  }
  if (args.line.availableStock === undefined) {
    // No annotation → don't second-guess the cashier; the backend will
    // reject if reality differs.
    return { ok: true };
  }
  const available = safeStock(args.line.availableStock);
  if (available <= 0) {
    return { ok: false, reason: 'هذا المنتج نفذ من المخزون' };
  }
  if (next > available) {
    return { ok: false, reason: `الرصيد المتاح ${available} فقط` };
  }
  return { ok: true };
}

/* ──────────────────────────────────────────────────────────────────
 * findOverStockLines — submit-time sweep
 *
 * Returns every cart line whose qty exceeds its `availableStock`
 * snapshot. Used by the POS submit handler to abort BEFORE issuing
 * `createInvoice` so the cashier never sees the raw DB error from a
 * race that crept in between the scan and the submit.
 *
 * Lines with `availableStock === undefined` are skipped (defensive:
 * the backend will validate them on submit).
 * ────────────────────────────────────────────────────────────────── */
export function findOverStockLines(items: StockGuardLine[]): StockGuardLine[] {
  return items.filter((i) => {
    if (i.availableStock === undefined) return false;
    const available = safeStock(i.availableStock);
    return Math.max(0, Number(i.qty) || 0) > available;
  });
}

/* ──────────────────────────────────────────────────────────────────
 * formatOverStockLine — human-readable bullet for submit-time toast.
 *
 * Mirrors the backend's exception text (`pos.service.ts::createInvoice`)
 * so cashiers see the same sentence regardless of which layer caught
 * the over-stock condition. Falls back to the variant id when no
 * `name` is available on the line.
 * ────────────────────────────────────────────────────────────────── */
export function formatOverStockLine(line: StockGuardLine): string {
  const label = line.name?.trim() || line.variantId;
  const available = safeStock(line.availableStock);
  return `الرصيد غير كافٍ للصنف ${label}. المتاح ${available} والمطلوب ${line.qty}`;
}
