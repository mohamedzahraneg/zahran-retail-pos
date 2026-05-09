/**
 * Payload + requested_action derivation for the guided edit-request UI.
 *
 * Strict scope:
 *   · Pure functions only — no side effects, no React, no API calls.
 *   · The output is what the modal sends as `requested_payload` +
 *     `requested_action` to the existing POST create endpoint.
 *   · Phase 1 contract still applies: the BE never APPLIES this
 *     payload to the parent document; admin review is required.
 *
 * The action-derivation rules mirror the spec:
 *   · header-only changes → 'update_header'
 *   · only one line removed → 'remove_item'
 *   · only one line whose product (variant_id/sku/name) changed → 'replace_item'
 *   · only one line whose unit_price changed → 'price_change'
 *   · only one line whose quantity changed → 'quantity_change'
 *   · everything else (incl. mixed, multiple, or new lines) → 'update_item'
 */
import type {
  HeaderEdit,
  ItemSnapshot,
  LineChangeAdded,
  LineChangeRemoved,
  LineChangeUpdated,
  LineChangesPayload,
  RequestedAction,
} from '@/api/returns.api';

export interface BuilderState {
  /**
   * Existing lines, keyed by item_id.  Each carries the immutable
   * `before` snapshot captured at modal open + the editable `after`
   * + flags for editing/removed.
   */
  existing: Record<
    string,
    {
      item_id: string;
      before: ItemSnapshot;
      after: ItemSnapshot;
      removed: boolean;
    }
  >;
  /** New lines the user added (no item_id yet — temp client id only). */
  added: Array<{ temp_id: string; after: ItemSnapshot }>;
  /** Optional header edits — undefined fields == "no change". */
  header: HeaderEdit;
  /**
   * Captured at modal open so the diff can show old_total even when
   * every existing line gets removed.
   */
  before_header: HeaderEdit;
}

/** True iff `a` and `b` differ in any user-meaningful field. */
export function snapshotEqual(a: ItemSnapshot, b: ItemSnapshot): boolean {
  return (
    (a.variant_id ?? null) === (b.variant_id ?? null) &&
    (a.sku ?? null) === (b.sku ?? null) &&
    (a.name ?? null) === (b.name ?? null) &&
    a.quantity === b.quantity &&
    a.unit_price === b.unit_price &&
    (a.notes ?? null) === (b.notes ?? null)
  );
}

/** True iff product identity (variant_id/sku/name) differs. */
export function productChanged(a: ItemSnapshot, b: ItemSnapshot): boolean {
  return (
    (a.variant_id ?? null) !== (b.variant_id ?? null) ||
    (a.sku ?? null) !== (b.sku ?? null) ||
    (a.name ?? null) !== (b.name ?? null)
  );
}

/**
 * True iff the user has explicitly requested any header-level change.
 *
 * `state.header` is a sparse OVERLAY object: a field is present iff
 * the user picked a value for it.  We deliberately do NOT compare
 * against the original document's header values — comparing an empty
 * overlay against a populated baseline would falsely fire "every field
 * is being cleared", which is not what an empty overlay means.
 *
 * Empty strings (from blank text inputs) are coerced to null upstream
 * by the modal's onChange handlers, so `reason_details: ''` won't
 * sneak through as "user wants to clear it".
 */
export function headerChanged(after: HeaderEdit): boolean {
  return Boolean(
    after.reason ||
      after.refund_method ||
      (typeof after.reason_details === 'string' &&
        after.reason_details.trim().length > 0) ||
      (typeof after.notes === 'string' && after.notes.trim().length > 0),
  );
}

/** Sum of `quantity * unit_price` for an array of snapshots. */
export function lineTotal(items: ItemSnapshot[]): number {
  return items.reduce(
    (acc, it) => acc + (it.quantity || 0) * (it.unit_price || 0),
    0,
  );
}

/** Round to 2 dp without floating-point lint noise. */
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Build the `requested_payload` object the BE will store verbatim.
 * Returns `null` when the user has produced no actual change — the
 * modal uses this to keep submit disabled.
 */
export function buildPayload(state: BuilderState): LineChangesPayload | null {
  const updated: LineChangeUpdated[] = [];
  const removed: LineChangeRemoved[] = [];
  const added: LineChangeAdded[] = state.added.map((row) => ({ ...row.after }));

  for (const row of Object.values(state.existing)) {
    if (row.removed) {
      removed.push({ item_id: row.item_id, before: row.before });
      continue;
    }
    if (!snapshotEqual(row.before, row.after)) {
      updated.push({
        item_id: row.item_id,
        before: row.before,
        after: row.after,
      });
    }
  }

  const headerEdit = headerChanged(state.header) ? state.header : undefined;

  if (
    updated.length === 0 &&
    removed.length === 0 &&
    added.length === 0 &&
    !headerEdit
  ) {
    return null;
  }

  // Old total = sum of every "before" snapshot (including removed and
  // updated lines, but excluding added).  New total = sum of every
  // remaining line (kept lines' after + added rows).
  const beforeAll: ItemSnapshot[] = Object.values(state.existing).map(
    (r) => r.before,
  );
  const afterAll: ItemSnapshot[] = [
    ...Object.values(state.existing)
      .filter((r) => !r.removed)
      .map((r) => r.after),
    ...added,
  ];
  const old_total = round2(lineTotal(beforeAll));
  const new_total = round2(lineTotal(afterAll));
  const delta = round2(new_total - old_total);

  return {
    kind: 'line_changes',
    lines: { updated, removed, added },
    ...(headerEdit ? { header: headerEdit } : {}),
    summary: { old_total, new_total, delta },
  };
}

/**
 * Pick the most-specific `requested_action` for the BE allowlist.
 * The BE accepts any of the 7 enumerated values; this is a UX-only
 * classification so the request shows up under the right label.
 */
export function deriveAction(
  payload: LineChangesPayload,
): RequestedAction {
  const { updated, removed, added } = payload.lines;
  const totalLineMutations = updated.length + removed.length + added.length;

  // Header-only change.
  if (totalLineMutations === 0 && payload.header) return 'update_header';

  // Single removal → remove_item.
  if (totalLineMutations === 1 && removed.length === 1) return 'remove_item';

  // Single update with only one dimension changed → narrowest label.
  if (totalLineMutations === 1 && updated.length === 1) {
    const u = updated[0]!;
    const productSwap = productChanged(u.before, u.after);
    const priceDiff = u.before.unit_price !== u.after.unit_price;
    const qtyDiff = u.before.quantity !== u.after.quantity;
    const dims = [productSwap, priceDiff, qtyDiff].filter(Boolean).length;
    if (dims === 1) {
      if (productSwap) return 'replace_item';
      if (priceDiff) return 'price_change';
      if (qtyDiff) return 'quantity_change';
    }
    // Single line, multiple dimensions changed → general update_item.
    return 'update_item';
  }

  // Anything else (multi-line, additions, mixed) → update_item.
  return 'update_item';
}
