/**
 * stock-transfers.api.ts — PR-STOCK-TRANSFERS-WORKFLOW
 *
 * Branch-aware client for the new stock-transfer workflow:
 *   list / get / create / update / approve / ship / receive / cancel
 *
 * Status taxonomy (DB CHECK is relaxed by migration 145):
 *   draft, pending, approved, in_transit, partially_received,
 *   received, cancelled, rejected.
 *
 * The legacy `in_transit` value is retained as the post-ship state
 * (the FE labels it "تم الشحن" for the operator).
 */
import { api, unwrap } from './client';

export type TransferStatus =
  | 'draft'
  | 'pending'
  | 'approved'
  | 'in_transit'
  | 'partially_received'
  | 'received'
  | 'cancelled'
  | 'rejected';

export const TRANSFER_STATUSES: TransferStatus[] = [
  'draft',
  'pending',
  'approved',
  'in_transit',
  'partially_received',
  'received',
  'cancelled',
  'rejected',
];

export const TRANSFER_STATUS_LABELS_AR: Record<TransferStatus, string> = {
  draft: 'مسودة',
  pending: 'بانتظار الاعتماد',
  approved: 'مُعتمد',
  in_transit: 'تم الشحن',
  partially_received: 'استلام جزئي',
  received: 'مستلم',
  cancelled: 'ملغى',
  rejected: 'مرفوض',
};

export interface TransferItem {
  id: string;
  transfer_id: string;
  variant_id: string;
  quantity_requested: number;
  quantity_received: number;
  notes: string | null;
  product_name?: string;
  product_sku?: string;
  variant_sku?: string;
  color?: string;
  size?: string;
}

export interface TransferBranchSummary {
  id: string;
  code: string;
  name_ar: string;
  name_en: string | null;
  type: string;
}

export interface TransferMovementRef {
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

export interface StockTransfer {
  id: string;
  transfer_no: string;
  from_warehouse_id: string;
  to_warehouse_id: string;
  from_warehouse_name?: string;
  to_warehouse_name?: string;
  from_primary_branch?: TransferBranchSummary | null;
  to_primary_branch?: TransferBranchSummary | null;
  status: TransferStatus;
  notes: string | null;
  requested_by?: string;
  requested_by_name?: string;
  approved_by?: string | null;
  approved_by_name?: string | null;
  approved_at?: string | null;
  received_by?: string | null;
  received_by_name?: string | null;
  received_at?: string | null;
  cancelled_by?: string | null;
  cancelled_by_name?: string | null;
  cancelled_at?: string | null;
  requested_at: string;
  shipped_at: string | null;
  created_at: string;
  updated_at: string;
  items_count?: number;
  total_qty_requested?: number;
  total_qty_received?: number;
  items?: TransferItem[];
  movements?: TransferMovementRef[];
}

export interface ListTransfersFilters {
  status?: string;
  warehouse_id?: string;
  from_warehouse_id?: string;
  to_warehouse_id?: string;
  from_branch_id?: string;
  to_branch_id?: string;
  date_from?: string;
  date_to?: string;
  search?: string;
}

export interface CreateTransferPayload {
  from_warehouse_id: string;
  to_warehouse_id: string;
  notes?: string;
  items: Array<{
    variant_id: string;
    quantity_requested: number;
    notes?: string;
  }>;
}

export interface UpdateTransferPayload {
  from_warehouse_id?: string;
  to_warehouse_id?: string;
  status?: 'draft' | 'pending';
  notes?: string;
  items?: Array<{
    variant_id: string;
    quantity_requested: number;
    notes?: string;
  }>;
}

export interface ReceiveTransferPayload {
  items: Array<{ item_id: string; quantity_received: number }>;
  notes?: string;
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

export const stockTransfersApi = {
  list: (params: ListTransfersFilters = {}) =>
    unwrap<StockTransfer[]>(
      api.get('/stock-transfers', { params: cleanParams(params) }),
    ),

  get: (id: string) =>
    unwrap<StockTransfer>(api.get(`/stock-transfers/${id}`)),

  create: (payload: CreateTransferPayload) =>
    unwrap<StockTransfer>(api.post('/stock-transfers', payload)),

  update: (id: string, payload: UpdateTransferPayload) =>
    unwrap<StockTransfer>(api.patch(`/stock-transfers/${id}`, payload)),

  approve: (id: string) =>
    unwrap<StockTransfer>(api.post(`/stock-transfers/${id}/approve`)),

  ship: (id: string) =>
    unwrap<StockTransfer>(api.post(`/stock-transfers/${id}/ship`)),

  receive: (id: string, payload: ReceiveTransferPayload) =>
    unwrap<StockTransfer>(api.post(`/stock-transfers/${id}/receive`, payload)),

  cancel: (id: string) =>
    unwrap<StockTransfer>(api.post(`/stock-transfers/${id}/cancel`)),
};
