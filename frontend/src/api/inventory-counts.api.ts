import { api, unwrap } from './client';

export type CountStatus = 'in_progress' | 'completed' | 'cancelled';

export interface CountItem {
  id: string;
  count_id: string;
  variant_id: string;
  system_qty: number;
  counted_qty: number | null;
  difference: number;
  notes: string | null;
  product_name?: string;
  variant_sku?: string;
  color?: string;
  size?: string;
}

export interface InventoryCount {
  id: string;
  count_no: string;
  warehouse_id: string;
  warehouse_name?: string;
  status: CountStatus;
  started_by?: string;
  started_by_name?: string;
  completed_by?: string | null;
  completed_by_name?: string | null;
  started_at: string;
  completed_at: string | null;
  notes: string | null;
  items_total?: number;
  items_counted?: number;
  items_with_diff?: number;
  total_abs_diff?: number;
  items?: CountItem[];
}

export interface StartCountPayload {
  warehouse_id: string;
  variant_ids?: string[];
  notes?: string;
}

export interface SubmitEntriesPayload {
  items: Array<{ item_id: string; counted_qty: number; notes?: string }>;
}

export const inventoryCountsApi = {
  list: (params?: { status?: string; warehouse_id?: string }) =>
    unwrap<InventoryCount[]>(api.get('/inventory-counts', { params })),

  get: (id: string) =>
    unwrap<InventoryCount>(api.get(`/inventory-counts/${id}`)),

  start: (payload: StartCountPayload) =>
    unwrap<InventoryCount>(api.post('/inventory-counts/start', payload)),

  submitEntries: (id: string, payload: SubmitEntriesPayload) =>
    unwrap<InventoryCount>(
      api.post(`/inventory-counts/${id}/entries`, payload),
    ),

  finalize: (id: string, notes?: string) =>
    unwrap<InventoryCount>(
      api.post(`/inventory-counts/${id}/finalize`, { notes }),
    ),

  cancel: (id: string) =>
    unwrap<InventoryCount>(api.post(`/inventory-counts/${id}/cancel`)),
};
