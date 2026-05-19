/**
 * inventory-counts.api.ts — PR-INVENTORY-COUNTS-WORKFLOW
 *
 * Branch-aware stocktaking client. Status taxonomy (DB relaxed by
 * migration 146b):
 *   draft, open, counting, review, finalized, in_progress (legacy),
 *   completed (legacy), cancelled.
 *
 * The legacy `start` + `entries` endpoints stay so the old FE keeps
 * working; the new flow uses `create` → `freeze` → `updateItems` →
 * `review` → `finalize` (or `cancel`).
 */
import { api, unwrap } from './client';

export type CountStatus =
  | 'draft'
  | 'open'
  | 'counting'
  | 'review'
  | 'finalized'
  | 'in_progress'
  | 'completed'
  | 'cancelled';

export const COUNT_STATUSES: CountStatus[] = [
  'draft',
  'open',
  'counting',
  'review',
  'finalized',
  'in_progress',
  'completed',
  'cancelled',
];

export const COUNT_STATUS_LABELS_AR: Record<CountStatus, string> = {
  draft: 'مسودة',
  open: 'مفتوح',
  counting: 'قيد العدّ',
  review: 'مراجعة',
  finalized: 'مكتمل',
  in_progress: 'قيد التنفيذ',
  completed: 'مكتمل',
  cancelled: 'ملغى',
};

export interface CountItem {
  id: string;
  count_id: string;
  variant_id: string;
  system_qty: number;
  counted_qty: number | null;
  difference: number;
  notes: string | null;
  product_name?: string;
  product_sku?: string;
  variant_sku?: string;
  barcode?: string | null;
  color?: string;
  size?: string;
}

export interface CountBranchSummary {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  type: string;
}

export interface CountMovementRef {
  id: string;
  created_at: string;
  movement_type: string;
  direction: 'in' | 'out';
  quantity: number;
  source_action: string | null;
  balance_after_qty: number | null;
  warehouse_id: string;
  warehouse_name: string | null;
  variant_id: string;
  variant_sku: string | null;
}

export interface InventoryCount {
  id: string;
  count_no: string;
  warehouse_id: string;
  warehouse_name?: string;
  primary_branch?: CountBranchSummary | null;
  status: CountStatus;
  started_by?: string;
  started_by_name?: string;
  completed_by?: string | null;
  completed_by_name?: string | null;
  cancelled_by?: string | null;
  cancelled_by_name?: string | null;
  started_at: string;
  completed_at: string | null;
  finalized_at?: string | null;
  cancelled_at?: string | null;
  cancel_reason?: string | null;
  finalized_movement_count?: number;
  notes: string | null;
  items_total?: number;
  items_counted?: number;
  items_with_diff?: number;
  positive_diff_qty?: number;
  negative_diff_qty?: number;
  items?: CountItem[];
  movements?: CountMovementRef[];
}

export interface ListCountsFilters {
  status?: string;
  warehouse_id?: string;
  branch_id?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
}

export interface CreateCountPayload {
  warehouse_id: string;
  notes?: string;
}

export interface FreezeCountPayload {
  variant_ids?: string[];
  category_id?: string;
  brand_id?: string;
  group_id?: string;
  product_id?: string;
}

export interface StartCountPayload {
  warehouse_id: string;
  variant_ids?: string[];
  notes?: string;
}

export interface SubmitEntriesPayload {
  items: Array<{ item_id: string; counted_qty: number; notes?: string }>;
}

export interface CancelCountPayload {
  reason?: string;
}

function cleanParams<T extends object>(raw: T): Partial<T> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined) continue;
    if (typeof v === 'string' && v.trim() === '') continue;
    out[k] = v;
  }
  return out as Partial<T>;
}

export const inventoryCountsApi = {
  list: (params: ListCountsFilters = {}) =>
    unwrap<InventoryCount[]>(
      api.get('/inventory-counts', { params: cleanParams(params) }),
    ),

  get: (id: string) =>
    unwrap<InventoryCount>(api.get(`/inventory-counts/${id}`)),

  create: (payload: CreateCountPayload) =>
    unwrap<InventoryCount>(api.post('/inventory-counts', payload)),

  freeze: (id: string, payload: FreezeCountPayload = {}) =>
    unwrap<InventoryCount>(
      api.post(`/inventory-counts/${id}/freeze`, payload),
    ),

  // Legacy single-shot create + freeze.
  start: (payload: StartCountPayload) =>
    unwrap<InventoryCount>(api.post('/inventory-counts/start', payload)),

  updateItems: (id: string, payload: SubmitEntriesPayload) =>
    unwrap<InventoryCount>(
      api.patch(`/inventory-counts/${id}/items`, payload),
    ),

  // Legacy alias preserved on the server for the old FE.
  submitEntries: (id: string, payload: SubmitEntriesPayload) =>
    unwrap<InventoryCount>(
      api.post(`/inventory-counts/${id}/entries`, payload),
    ),

  review: (id: string) =>
    unwrap<InventoryCount>(api.post(`/inventory-counts/${id}/review`)),

  finalize: (id: string, notes?: string) =>
    unwrap<InventoryCount>(
      api.post(`/inventory-counts/${id}/finalize`, { notes }),
    ),

  cancel: (id: string, payload: CancelCountPayload = {}) =>
    unwrap<InventoryCount>(
      api.post(`/inventory-counts/${id}/cancel`, payload),
    ),
};
