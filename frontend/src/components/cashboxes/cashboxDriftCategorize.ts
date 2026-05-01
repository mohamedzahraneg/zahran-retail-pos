/**
 * cashboxDriftCategorize.ts — PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX
 *
 * Pure categorization of `v_cashbox_drift_per_ref` rows into:
 *   • "real economic" — rows where the per-`reference_id` net drift
 *     is non-zero (i.e. the cashbox and the GL really disagree on
 *     this reference).
 *   • "self-cancelling label-mismatch" — rows where the same
 *     `reference_id` appears 2+ times across CT/JE under different
 *     `reference_type` codes and the per-`reference_id` net is 0.
 *     These are cosmetic: shifts logged as `reference_type='shift'`
 *     in cashbox_transactions but as `reference_type='shift_variance'`
 *     in journal_entries, etc. Net economic effect at the cashbox
 *     total: zero.
 *
 * The split lets the UI show operators the real culprits without
 * burying them under noise pairs that always add to zero.
 *
 * Pure function, no fetches, no DOM, no mutations. Re-export from
 * the panel so the test can import the same logic the UI uses.
 */
import type { CashboxDriftDetailRow } from '@/api/cash-desk.api';

export interface CategorizedDrift {
  /** Subset where the per-`reference_id` net drift ≠ 0. */
  real: CashboxDriftDetailRow[];
  /** Subset where the per-`reference_id` net drift = 0 (paired). */
  selfCancelling: CashboxDriftDetailRow[];
  /** Sum of `drift_amount` over `real`. Should equal the cashbox-level drift. */
  realSum: number;
  /** Sum of `drift_amount` over `selfCancelling`. Should equal 0. */
  selfCancellingSum: number;
}

/** Tolerance used to decide whether a per-ref-id net is "zero". */
const ZERO_EPSILON = 0.01;

export function categorizeDrift(
  rows: CashboxDriftDetailRow[],
): CategorizedDrift {
  // 1. Sum drift per reference_id.
  const netByRefId = new Map<string, number>();
  for (const r of rows) {
    const prev = netByRefId.get(r.reference_id) ?? 0;
    netByRefId.set(r.reference_id, prev + Number(r.drift_amount || 0));
  }
  // 2. Partition.
  const real:           CashboxDriftDetailRow[] = [];
  const selfCancelling: CashboxDriftDetailRow[] = [];
  for (const r of rows) {
    const net = netByRefId.get(r.reference_id) ?? 0;
    if (Math.abs(net) > ZERO_EPSILON) real.push(r);
    else                              selfCancelling.push(r);
  }
  // 3. Sums (sanity for the UI — `realSum` should equal the
  //    cashbox-level drift; `selfCancellingSum` should equal 0).
  const sum = (xs: CashboxDriftDetailRow[]) =>
    xs.reduce((s, r) => s + Number(r.drift_amount || 0), 0);
  return {
    real,
    selfCancelling,
    realSum: sum(real),
    selfCancellingSum: sum(selfCancelling),
  };
}

/**
 * Top contributors view: real-economic rows ordered by absolute
 * drift desc. Used by the "ما سبب الفرق؟" section.
 */
export function topContributors(
  rows: CashboxDriftDetailRow[],
  limit = 5,
): CashboxDriftDetailRow[] {
  return [...rows]
    .sort(
      (a, b) =>
        Math.abs(Number(b.drift_amount || 0)) -
        Math.abs(Number(a.drift_amount || 0)),
    )
    .slice(0, Math.max(0, limit));
}
