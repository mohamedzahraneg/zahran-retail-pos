/**
 * landedCostMath.ts — PR-PURCHASES-P2.2
 *
 * Pure preview helper that mirrors the backend allocator
 * (`backend/src/purchases/landed-cost.allocator.ts`) so the operator
 * sees the same per-line landed cost the server will compute on save.
 *
 * IMPORTANT — backend is the source of truth. The frontend NEVER
 * sends final landed unit_cost to the API. Operators type a BASE
 * unit_cost per line; this helper turns that into a preview of what
 * the server will produce. The server re-runs the same math at save
 * time and that's what gets persisted.
 *
 * Mirrored backend rules:
 *   · by_value      share = line_base_total / total_base_subtotal
 *                   line_base_total = qty × base_unit_cost − discount + tax
 *   · by_quantity   share = qty / total_qty
 *   · manual        operator-supplied per-variant amounts; helper
 *                   validates Σ == amount within 0.01 EGP
 *   · capitalized=false → contributes to non_capitalized_total only,
 *                   leaves unit_cost untouched
 *   · rounding remainder → assigned to the largest base-line; tie
 *                   broken lexicographically on variant_id (same as
 *                   backend so the preview never disagrees on the
 *                   pennies)
 */

import type {
  AllocationMethod,
  ExtraCostType,
  ManualAllocationPayload,
} from '@/api/purchases.api';

export interface LandedLineInput {
  variant_id: string;
  quantity: number;
  /** Operator-entered base unit cost (what the API receives as items[].unit_cost). */
  base_unit_cost: number;
  discount?: number;
  tax?: number;
}

export interface LandedExtraInput {
  cost_type: ExtraCostType;
  amount: number;
  capitalize_to_inventory: boolean;
  allocation_method: AllocationMethod;
  manual_allocations?: ManualAllocationPayload[];
}

export interface LandedLineOutput {
  variant_id: string;
  quantity: number;
  base_unit_cost: number;
  base_line_total: number;
  allocated_cost_total: number;
  allocated_cost_per_unit: number;
  final_unit_cost: number;
  final_line_total: number;
  manual_allocation: boolean;
}

export interface LandedMathResult {
  lines: LandedLineOutput[];
  products_base_subtotal: number;
  extra_costs_capitalized: number;
  extra_costs_non_capitalized: number;
  /** Inventory value after capitalizing extras (= base + capitalized). */
  final_inventory_total: number;
  /** Validation errors keyed by extra index; empty when all valid. */
  errors: Record<number, string>;
}

const round2 = (n: number) =>
  Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
const round4 = (n: number) =>
  Math.round((Number.isFinite(n) ? n : 0) * 10000) / 10000;

export interface ComputeLandedArgs {
  lines: LandedLineInput[];
  extras: LandedExtraInput[];
  /** Invoice-level shipping (legacy field, not allocated; passed through). */
  shipping_cost?: number;
  /** Invoice-level discount (legacy field). */
  discount_amount?: number;
  /** Invoice-level tax (legacy field). */
  tax_amount?: number;
}

export interface LandedMathTotals extends LandedMathResult {
  grand_total_preview: number;
  shipping_cost: number;
  discount_amount: number;
  tax_amount: number;
}

/**
 * Main entry. Returns per-line preview + aggregate totals + per-extra
 * validation errors. Never throws — invalid manual allocations surface
 * via `errors[i]` so the UI can disable the save button + show a
 * targeted message without breaking the rest of the preview.
 */
export function computeLandedPreview(
  args: ComputeLandedArgs,
): LandedMathTotals {
  const errors: Record<number, string> = {};
  interface Work {
    variant_id: string;
    quantity: number;
    base_unit_cost: number;
    discount: number;
    tax: number;
    base_line_total: number;
    alloc: number;
    manual: boolean;
  }
  const work: Work[] = args.lines.map((l) => {
    const qty = Number(l.quantity || 0);
    const base = Number(l.base_unit_cost || 0);
    const discount = Number(l.discount ?? 0);
    const tax = Number(l.tax ?? 0);
    return {
      variant_id: l.variant_id,
      quantity: qty,
      base_unit_cost: base,
      discount,
      tax,
      base_line_total: qty * base - discount + tax,
      alloc: 0,
      manual: false,
    };
  });
  const variantIndex = new Map<string, number>();
  work.forEach((w, i) => variantIndex.set(w.variant_id, i));

  const baseSubtotal = round2(
    work.reduce((s, w) => s + w.base_line_total, 0),
  );
  const totalQty = work.reduce((s, w) => s + w.quantity, 0);

  let capitalizedTotal = 0;
  let nonCapitalizedTotal = 0;

  args.extras.forEach((extra, idx) => {
    const amount = Number(extra.amount || 0);
    if (!(amount > 0)) return;

    if (!extra.capitalize_to_inventory) {
      nonCapitalizedTotal += amount;
      return;
    }
    capitalizedTotal += amount;

    if (extra.allocation_method === 'manual') {
      const manual = extra.manual_allocations ?? [];
      if (manual.length === 0) {
        errors[idx] =
          'يجب إضافة صنف واحد على الأقل قبل توزيع المصاريف.';
        // Roll back this extra's contribution to the capitalized total
        // so the residual logic below doesn't dump the full amount onto
        // a single line.
        capitalizedTotal -= amount;
        return;
      }
      let sum = 0;
      let bad = false;
      for (const m of manual) {
        const targetIdx = variantIndex.get(m.variant_id);
        if (targetIdx == null) continue; // line was removed; skip
        const a = Number(m.amount);
        if (!(a > 0) && a !== 0) {
          bad = true;
          break;
        }
        sum += a;
        if (a > 0) {
          work[targetIdx].alloc += a;
          work[targetIdx].manual = true;
        }
      }
      if (bad) {
        errors[idx] =
          'إجمالي التوزيع اليدوي للمصاريف يجب أن يساوي قيمة المصروف.';
        for (const m of manual) {
          const targetIdx = variantIndex.get(m.variant_id);
          if (targetIdx == null) continue;
          work[targetIdx].alloc -= Number(m.amount || 0);
          work[targetIdx].manual = false;
        }
        capitalizedTotal -= amount;
        return;
      }
      if (Math.abs(round2(sum) - round2(amount)) > 0.01) {
        errors[idx] =
          'إجمالي التوزيع اليدوي للمصاريف يجب أن يساوي قيمة المصروف.';
        for (const m of manual) {
          const targetIdx = variantIndex.get(m.variant_id);
          if (targetIdx == null) continue;
          work[targetIdx].alloc -= Number(m.amount || 0);
          work[targetIdx].manual = false;
        }
        capitalizedTotal -= amount;
      }
      return;
    }

    if (extra.allocation_method === 'by_value') {
      if (baseSubtotal <= 0) {
        if (totalQty <= 0) return;
        for (const w of work) {
          w.alloc += (amount * w.quantity) / totalQty;
        }
        return;
      }
      for (const w of work) {
        w.alloc += (amount * w.base_line_total) / baseSubtotal;
      }
      return;
    }

    if (extra.allocation_method === 'by_quantity') {
      if (totalQty <= 0) return;
      for (const w of work) {
        w.alloc += (amount * w.quantity) / totalQty;
      }
      return;
    }
  });

  // Round per-line allocations to 2 decimals and assign the residual
  // to the line with the largest base_line_total. Tie-break is
  // lexicographic on variant_id — same convention as the backend so
  // the preview matches to the penny.
  const rounded = work.map((w) => round2(w.alloc));
  let summed = round2(rounded.reduce((s, n) => s + n, 0));
  const target = round2(capitalizedTotal);
  let residual = round2(target - summed);
  if (Math.abs(residual) >= 0.005 && work.length > 0) {
    let pickIdx = 0;
    for (let i = 1; i < work.length; i++) {
      const w = work[i];
      const p = work[pickIdx];
      if (w.base_line_total > p.base_line_total) pickIdx = i;
      else if (
        w.base_line_total === p.base_line_total
        && w.variant_id < p.variant_id
      ) {
        pickIdx = i;
      }
    }
    rounded[pickIdx] = round2(rounded[pickIdx] + residual);
    summed = round2(rounded.reduce((s, n) => s + n, 0));
    residual = round2(target - summed);
  }

  const lines: LandedLineOutput[] = work.map((w, i) => {
    const allocatedTotal = round2(rounded[i]);
    const perUnit =
      w.quantity > 0 ? round4(allocatedTotal / w.quantity) : 0;
    const finalUnitCost = round2(w.base_unit_cost + perUnit);
    const finalLineTotal = round2(
      w.quantity * finalUnitCost - w.discount + w.tax,
    );
    return {
      variant_id: w.variant_id,
      quantity: w.quantity,
      base_unit_cost: round2(w.base_unit_cost),
      base_line_total: round2(w.base_line_total),
      allocated_cost_total: allocatedTotal,
      allocated_cost_per_unit: perUnit,
      final_unit_cost: finalUnitCost,
      final_line_total: finalLineTotal,
      manual_allocation: w.manual,
    };
  });

  const shipping = Math.max(0, Number(args.shipping_cost ?? 0));
  const invDiscount = Math.max(0, Number(args.discount_amount ?? 0));
  const invTax = Math.max(0, Number(args.tax_amount ?? 0));
  const capitalized = round2(capitalizedTotal);
  const nonCap = round2(nonCapitalizedTotal);
  const finalInventoryTotal = round2(baseSubtotal + capitalized);
  const grandTotalPreview = round2(
    baseSubtotal
    - invDiscount
    + invTax
    + shipping
    + capitalized
    + nonCap,
  );

  return {
    lines,
    products_base_subtotal: baseSubtotal,
    extra_costs_capitalized: capitalized,
    extra_costs_non_capitalized: nonCap,
    final_inventory_total: finalInventoryTotal,
    grand_total_preview: grandTotalPreview,
    shipping_cost: round2(shipping),
    discount_amount: round2(invDiscount),
    tax_amount: round2(invTax),
    errors,
  };
}
