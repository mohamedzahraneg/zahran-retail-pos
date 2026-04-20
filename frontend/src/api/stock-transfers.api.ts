import { api, unwrap } from './client';

export type TransferStatus = 'draft' | 'in_transit' | 'received' | 'cancelled';

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

export interface StockTransfer {
  id: string;
  transfer_no: string;
  from_warehouse_id: string;
  to_warehouse_id: string;
  from_warehouse_name?: string;
  to_warehouse_name?: string;
  status: TransferStatus;
  notes: string | null;
  requested_by?: string;
  requested_by_name?: string;
  approved_by?: string | null;
  approved_by_name?: string | null;
  received_by?: string | null;
  received_by_name?: string | null;
  requested_at: string;
  shipped_at: string | null;
  received_at: string | null;
  created_at: string;
  updated_at: string;
  items_count?: number;
  total_qty?: number;
  items?: TransferItem[];
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

export interface ReceiveTransferPayload {
  items: Array<{ item_id: string; quantity_received: number }>;
  notes?: string;
}

export const stockTransfersApi = {
  list: (params?: { status?: string; warehouse_id?: string }) =>
    unwrap<StockTransfer[]>(api.get('/stock-transfers', { params })),

  get: (id: string) =>
    unwrap<StockTransfer>(api.get(`/stock-transfers/${id}`)),

  create: (payload: CreateTransferPayload) =>
    unwrap<StockTransfer>(api.post('/stock-transfers', payload)),

  ship: (id: string) =>
    unwrap<StockTransfer>(api.post(`/stock-transfers/${id}/ship`)),

  receive: (id: string, payload: ReceiveTransferPayload) =>
    unwrap<StockTransfer>(api.post(`/stock-transfers/${id}/receive`, payload)),

  cancel: (id: string) =>
    unwrap<StockTransfer>(api.post(`/stock-transfers/${id}/cancel`)),
};
