import { api, unwrap } from './client';

export type ReturnStatus = 'pending' | 'approved' | 'refunded' | 'rejected';
export type ReturnReason =
  | 'defective'
  | 'wrong_size'
  | 'wrong_color'
  | 'customer_changed_mind'
  | 'not_as_described'
  | 'other';
export type ItemCondition = 'resellable' | 'damaged' | 'defective';
export type PaymentMethod = 'cash' | 'card' | 'instapay' | 'bank_transfer';

// ---- Invoice lookup -------------------------------------------------------
export interface InvoiceLookupItem {
  invoice_item_id: string;
  variant_id: string;
  product_name: string;
  sku: string;
  color: string | null;
  size: string | null;
  original_quantity: number;
  already_returned: number;
  available_to_return: number;
  unit_price: string;
  line_total: string;
}

export interface InvoiceLookup {
  invoice: {
    id: string;
    invoice_no: string;
    completed_at: string;
    grand_total: string;
    paid_amount: string;
    status: string;
    customer_id: string | null;
    customer_name: string | null;
    customer_phone: string | null;
    warehouse_id: string;
    warehouse_name: string | null;
  };
  items: InvoiceLookupItem[];
}

// ---- Return list/detail ---------------------------------------------------
export interface ReturnListItem {
  id: string;
  return_no: string;
  status: ReturnStatus;
  reason: ReturnReason;
  total_refund: string;
  restocking_fee: string;
  net_refund: string;
  refund_method: PaymentMethod | null;
  requested_at: string;
  approved_at: string | null;
  refunded_at: string | null;
  rejected_at: string | null;
  original_invoice_id: string;
  invoice_no: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  items_count: number;
  units_count: number;
}

export interface ReturnItem {
  id: string;
  original_invoice_item_id: string;
  variant_id: string;
  product_name: string;
  sku: string;
  color: string | null;
  size: string | null;
  quantity: number;
  unit_price: string;
  refund_amount: string;
  condition: ItemCondition;
  back_to_stock: boolean;
  notes: string | null;
}

export interface ReturnDetails extends ReturnListItem {
  reason_details: string | null;
  notes: string | null;
  warehouse_id: string;
  warehouse_name: string | null;
  invoice_date: string | null;
  requested_by_name: string | null;
  approved_by_name: string | null;
  refunded_by_name: string | null;
  items: ReturnItem[];
}

// ---- Create payloads ------------------------------------------------------
export interface CreateReturnPayload {
  original_invoice_id: string;
  items: Array<{
    original_invoice_item_id: string;
    variant_id: string;
    quantity: number;
    unit_price: number;
    refund_amount: number;
    condition?: ItemCondition;
    back_to_stock?: boolean;
    notes?: string;
  }>;
  reason?: ReturnReason;
  reason_details?: string;
  restocking_fee?: number;
  refund_method?: PaymentMethod;
  notes?: string;
}

export interface CreateExchangePayload {
  original_invoice_id: string;
  returned_items: Array<{
    variant_id: string;
    quantity: number;
    unit_price: number;
    condition?: ItemCondition;
    notes?: string;
  }>;
  new_items: Array<{
    variant_id: string;
    quantity: number;
    unit_price: number;
    condition?: ItemCondition;
    notes?: string;
  }>;
  payment_method?: PaymentMethod;
  refund_method?: PaymentMethod;
  reason?: ReturnReason;
  reason_details?: string;
  notes?: string;
}

// ---- Exchange list --------------------------------------------------------
export interface ExchangeListItem {
  id: string;
  exchange_no: string;
  status: 'pending' | 'completed' | 'cancelled';
  returned_value: string;
  new_items_value: string;
  price_difference: string;
  created_at: string;
  completed_at: string | null;
  original_invoice_no: string | null;
  new_invoice_no: string | null;
  customer_name: string | null;
  customer_phone: string | null;
}

// ---- API ------------------------------------------------------------------
export const returnsApi = {
  lookupInvoice: (invoiceNo: string) =>
    unwrap<InvoiceLookup>(api.get(`/returns/lookup/${invoiceNo}`)),

  createReturn: (payload: CreateReturnPayload) =>
    unwrap<{
      id: string;
      return_no: string;
      status: ReturnStatus;
      total_refund: number;
      net_refund: number;
    }>(api.post('/returns', payload)),

  list: (params?: {
    status?: ReturnStatus;
    customer_id?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }) => unwrap<ReturnListItem[]>(api.get('/returns', { params })),

  get: (id: string) => unwrap<ReturnDetails>(api.get(`/returns/${id}`)),

  approve: (id: string, notes?: string) =>
    unwrap<ReturnDetails>(api.post(`/returns/${id}/approve`, { notes })),

  refund: (id: string, payload: { refund_method: PaymentMethod; reference?: string; notes?: string }) =>
    unwrap<ReturnDetails>(api.post(`/returns/${id}/refund`, payload)),

  reject: (id: string, reason: string) =>
    unwrap<ReturnDetails>(api.post(`/returns/${id}/reject`, { reason })),

  // Exchanges
  exchange: (payload: CreateExchangePayload) =>
    unwrap<{
      exchange_id: string;
      exchange_no: string;
      new_invoice_id: string;
      new_invoice_no: string;
      returned_value: number;
      new_items_value: number;
      price_difference: number;
    }>(api.post('/exchanges', payload)),

  listExchanges: (params?: { q?: string; limit?: number; offset?: number }) =>
    unwrap<ExchangeListItem[]>(api.get('/exchanges', { params })),

  getExchange: (id: string) =>
    unwrap<any>(api.get(`/exchanges/${id}`)),
};
