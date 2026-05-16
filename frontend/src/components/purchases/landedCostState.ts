/**
 * landedCostState.ts — PR-PURCHASES-P2.2
 *
 * State shape + factory for landed-cost extra rows. Kept in a non-
 * component module so `LandedCostsSection.tsx` can stay
 * component-only (Vite fast-refresh complains when a component file
 * also exports non-component values).
 */
import type { CreatePurchaseExtraCostPayload } from '@/api/purchases.api';

/**
 * Stable identity per row so React keys + manual sub-table refs don't
 * drift when the operator deletes a middle row. `_key` is stripped
 * before sending to the API.
 */
export interface ExtraCostRow extends CreatePurchaseExtraCostPayload {
  _key: string;
}

let _kctr = 0;
const nextKey = () => {
  _kctr += 1;
  return `ec-${Date.now()}-${_kctr}`;
};

export function createEmptyExtraCostRow(): ExtraCostRow {
  return {
    _key: nextKey(),
    cost_type: 'transport',
    label: '',
    amount: 0,
    capitalize_to_inventory: true,
    allocation_method: 'by_value',
    notes: '',
    sort_order: 0,
    manual_allocations: [],
  };
}
