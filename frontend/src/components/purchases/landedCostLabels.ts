/**
 * landedCostLabels.ts — PR-PURCHASES-P2.2
 *
 * Arabic display labels for landed-cost types and allocation methods.
 * Kept in a constants-only module so `LandedCostsSection.tsx` can stay
 * a pure-component file (Vite fast-refresh complains when component
 * files export non-component values).
 */
import type {
  AllocationMethod,
  ExtraCostType,
} from '@/api/purchases.api';

export const COST_TYPE_LABEL: Record<ExtraCostType, string> = {
  transport: 'نقل',
  labor: 'عمالة',
  shipping: 'شحن',
  customs: 'جمارك',
  packaging: 'تغليف',
  other: 'أخرى',
};

export const ALLOC_METHOD_LABEL: Record<AllocationMethod, string> = {
  by_value: 'حسب قيمة المنتجات',
  by_quantity: 'حسب الكمية',
  manual: 'يدوي',
};

export const COST_TYPE_OPTIONS: ExtraCostType[] = [
  'transport',
  'labor',
  'shipping',
  'customs',
  'packaging',
  'other',
];

export const ALLOC_METHOD_OPTIONS: AllocationMethod[] = [
  'by_value',
  'by_quantity',
  'manual',
];
