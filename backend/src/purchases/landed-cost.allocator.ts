/**
 * landed-cost.allocator.ts — PR-PURCHASES-P2.1
 *
 * Pure, side-effect-free allocation of per-invoice extra costs across
 * purchase lines. The caller hands in the raw lines + extras DTO and
 * gets back per-line landed unit cost + per-line allocated share. No
 * DataSource, no engine, no I/O — testable in isolation.
 *
 * Allocation methods:
 *   · by_value     — proportional to line_base_total
 *                    line_base_total = qty × base_unit_cost − discount + tax
 *   · by_quantity  — proportional to qty
 *   · manual       — operator supplies per-variant amounts; the
 *                    summator validates they match within 0.01
 *
 * Capitalization:
 *   Only `capitalize_to_inventory=true` extras flow into the per-line
 *   `allocated_cost_total`. Non-capitalized extras are summed into
 *   `non_capitalized_total` so the caller can route them to expense GL
 *   (529) at postPurchase time without touching line costs.
 *
 * Rounding:
 *   Per-line `allocated_cost_total` is rounded to 2 decimals AFTER
 *   summing across all extras (not per-extra). The residual
 *     residual = capitalized_total − Σ rounded_line_totals
 *   is assigned to the line with the largest `line_base_total`, with a
 *   lexicographic tie-break on `variant_id`. After the residual fix
 *   Σ rounded_line_totals = capitalized_total exactly (to 0.01).
 *
 * `allocated_cost_per_unit` is stored at 4-decimal precision so the
 * computed landed unit_cost (= base_unit_cost + allocated_cost_per_unit,
 * stored at 2 decimals) absorbs rounding drift cleanly. Computed by
 * dividing the rounded `allocated_cost_total` by `quantity`.
 */

export type ExtraCostType =
  | 'transport'
  | 'labor'
  | 'shipping'
  | 'customs'
  | 'packaging'
  | 'other';

export type AllocationMethod = 'by_value' | 'by_quantity' | 'manual';

export interface AllocatorLineInput {
  variant_id: string;
  quantity: number;
  base_unit_cost: number;
  discount?: number;
  tax?: number;
}

export interface AllocatorExtraInput {
  cost_type: ExtraCostType;
  amount: number;
  capitalize_to_inventory: boolean;
  allocation_method: AllocationMethod;
  manual_allocations?: Array<{ variant_id: string; amount: number }>;
}

export interface AllocatorLineOutput {
  variant_id: string;
  quantity: number;
  base_unit_cost: number;
  discount: number;
  tax: number;
  /** Sum of capitalized shares routed to this line. 2 decimals. */
  allocated_cost_total: number;
  /** allocated_cost_total / quantity. 4 decimals. */
  allocated_cost_per_unit: number;
  /** Final landed price per piece. 2 decimals. */
  unit_cost: number;
  /** quantity × unit_cost − discount + tax. 2 decimals. */
  line_total: number;
  /** TRUE when any capitalized extra reaching this line used manual mode. */
  manual_allocation: boolean;
}

export interface AllocatorResult {
  lines: AllocatorLineOutput[];
  /** Sum of capitalized extra amounts (2 decimals). */
  capitalized_total: number;
  /** Sum of non-capitalized extra amounts (2 decimals). */
  non_capitalized_total: number;
  /** subtotal of base × qty − discount + tax across lines (2 decimals). */
  base_subtotal: number;
}

const round2 = (n: number) =>
  Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
const round4 = (n: number) =>
  Math.round((Number.isFinite(n) ? n : 0) * 10000) / 10000;

function lineBaseTotal(l: AllocatorLineInput): number {
  return (
    Number(l.quantity || 0) * Number(l.base_unit_cost || 0)
    - Number(l.discount ?? 0)
    + Number(l.tax ?? 0)
  );
}

/**
 * Validate the manual_allocations payload of a single extra cost.
 * Throws when the sum does not match `extra.amount` within 0.01, when
 * a variant_id is unknown, or when an amount is non-positive.
 *
 * The thrown Error carries a Boolean `manualAllocationError` marker so
 * the service layer can wrap it in a BadRequestException with the
 * canonical Arabic message.
 */
export class ManualAllocationError extends Error {
  readonly manualAllocationError = true;
  constructor(
    message: string,
    readonly reason:
      | 'sum_mismatch'
      | 'unknown_variant'
      | 'non_positive_amount'
      | 'missing_lines',
  ) {
    super(message);
    this.name = 'ManualAllocationError';
  }
}

/**
 * Main entry. Returns per-line landed costs + aggregate totals.
 *
 * Pure: never mutates inputs, never reads the DB.
 */
export function allocateLandedCosts(
  lines: AllocatorLineInput[],
  extras: AllocatorExtraInput[] = [],
): AllocatorResult {
  // Normalize line inputs — narrow `discount` / `tax` to definite
  // numbers via the explicit ?? 0 fallbacks below.
  interface WorkLine {
    variant_id: string;
    quantity: number;
    base_unit_cost: number;
    discount: number;
    tax: number;
    _base_total: number;
    _alloc: number;
    _manual: boolean;
  }
  const work: WorkLine[] = lines.map((l) => {
    const lt = lineBaseTotal(l);
    return {
      variant_id: l.variant_id,
      quantity: Number(l.quantity || 0),
      base_unit_cost: Number(l.base_unit_cost || 0),
      discount: Number(l.discount ?? 0),
      tax: Number(l.tax ?? 0),
      _base_total: lt,
      _alloc: 0,
      _manual: false,
    };
  });
  const variantIndex = new Map<string, number>();
  work.forEach((w, i) => variantIndex.set(w.variant_id, i));

  const baseSubtotal = round2(
    work.reduce((s, w) => s + w._base_total, 0),
  );
  const totalQty = work.reduce((s, w) => s + w.quantity, 0);

  let capitalizedTotal = 0;
  let nonCapitalizedTotal = 0;

  for (const extra of extras) {
    const amount = Number(extra.amount || 0);
    if (!(amount > 0)) continue;

    if (!extra.capitalize_to_inventory) {
      nonCapitalizedTotal += amount;
      continue;
    }
    capitalizedTotal += amount;

    if (extra.allocation_method === 'manual') {
      const manual = extra.manual_allocations ?? [];
      if (manual.length === 0) {
        throw new ManualAllocationError(
          'manual allocation requires at least one line',
          'missing_lines',
        );
      }
      let sum = 0;
      for (const m of manual) {
        const idx = variantIndex.get(m.variant_id);
        if (idx == null) {
          throw new ManualAllocationError(
            `manual allocation references unknown variant ${m.variant_id}`,
            'unknown_variant',
          );
        }
        const a = Number(m.amount);
        if (!(a > 0)) {
          throw new ManualAllocationError(
            `manual allocation amount must be > 0 (got ${m.amount})`,
            'non_positive_amount',
          );
        }
        sum += a;
        work[idx]._alloc += a;
        work[idx]._manual = true;
      }
      if (Math.abs(round2(sum) - round2(amount)) > 0.01) {
        throw new ManualAllocationError(
          `manual allocation sum ${round2(sum)} != amount ${round2(amount)}`,
          'sum_mismatch',
        );
      }
      continue;
    }

    if (extra.allocation_method === 'by_value') {
      // Empty/zero subtotal → fall back to by_quantity. The classifier
      // is a UX/edge guard; an invoice with zero base subtotal can
      // only come from zero-priced lines and shouldn't ever happen in
      // practice, but defaulting to qty prevents NaN propagation.
      if (baseSubtotal <= 0) {
        if (totalQty <= 0) continue;
        for (const w of work) {
          w._alloc += (amount * w.quantity) / totalQty;
        }
        continue;
      }
      for (const w of work) {
        w._alloc += (amount * w._base_total) / baseSubtotal;
      }
      continue;
    }

    if (extra.allocation_method === 'by_quantity') {
      if (totalQty <= 0) continue;
      for (const w of work) {
        w._alloc += (amount * w.quantity) / totalQty;
      }
      continue;
    }
  }

  // Round per-line allocated totals to 2 decimals and assign the
  // residual to the largest-base line (tie-break: lex smallest
  // variant_id) so the rounded sum equals capitalized_total exactly.
  const rounded = work.map((w) => round2(w._alloc));
  let summed = round2(rounded.reduce((s, n) => s + n, 0));
  const target = round2(capitalizedTotal);
  let residual = round2(target - summed);
  if (Math.abs(residual) >= 0.005 && work.length > 0) {
    // Find the line with the largest _base_total; tie-break
    // lexicographically on variant_id.
    let pickIdx = 0;
    for (let i = 1; i < work.length; i++) {
      const w = work[i];
      const p = work[pickIdx];
      if (w._base_total > p._base_total) pickIdx = i;
      else if (
        w._base_total === p._base_total
        && w.variant_id < p.variant_id
      ) {
        pickIdx = i;
      }
    }
    rounded[pickIdx] = round2(rounded[pickIdx] + residual);
    summed = round2(rounded.reduce((s, n) => s + n, 0));
    residual = round2(target - summed);
  }

  const outLines: AllocatorLineOutput[] = work.map((w, i) => {
    const allocatedTotal = round2(rounded[i]);
    const perUnit =
      w.quantity > 0 ? round4(allocatedTotal / w.quantity) : 0;
    const unitCost = round2(w.base_unit_cost + perUnit);
    const lineTotal = round2(w.quantity * unitCost - w.discount + w.tax);
    return {
      variant_id: w.variant_id,
      quantity: w.quantity,
      base_unit_cost: round2(w.base_unit_cost),
      discount: round2(w.discount),
      tax: round2(w.tax),
      allocated_cost_total: allocatedTotal,
      allocated_cost_per_unit: perUnit,
      unit_cost: unitCost,
      line_total: lineTotal,
      manual_allocation: w._manual,
    };
  });

  return {
    lines: outLines,
    capitalized_total: round2(capitalizedTotal),
    non_capitalized_total: round2(nonCapitalizedTotal),
    base_subtotal: baseSubtotal,
  };
}
