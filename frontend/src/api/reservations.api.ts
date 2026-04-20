import { api, unwrap } from './client';

export type ReservationStatus = 'active' | 'completed' | 'cancelled' | 'expired';
export type PaymentMethod = 'cash' | 'card' | 'instapay' | 'bank_transfer';
export type RefundPolicy = 'full' | 'partial' | 'none';

export interface ReservationListItem {
  id: string;
  reservation_no: string;
  status: ReservationStatus;
  customer_id: string;
  customer_name: string | null;
  customer_phone: string | null;
  warehouse_id: string;
  total_amount: string;
  paid_amount: string;
  refunded_amount: string;
  remaining_amount: string;
  reserved_at: string;
  expires_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  converted_invoice_id: string | null;
  items_count: number;
  units_count: number;
}

export interface ReservationItem {
  id: string;
  variant_id: string;
  product_name: string;
  sku: string;
  barcode: string | null;
  color: string | null;
  size: string | null;
  quantity: number;
  unit_price: string;
  discount_amount: string;
  line_total: string;
  notes: string | null;
}

export interface ReservationPayment {
  id: string;
  payment_method: PaymentMethod;
  amount: string;
  kind: 'deposit' | 'installment' | 'final';
  reference_number: string | null;
  received_by_name: string | null;
  paid_at: string;
  notes: string | null;
}

export interface ReservationRefund {
  id: string;
  payment_method: PaymentMethod;
  gross_amount: string;
  fee_amount: string;
  net_refund_amount: string;
  reason: string | null;
  refunded_by_name: string | null;
  refunded_at: string;
}

export interface ReservationDetails extends ReservationListItem {
  subtotal: string;
  discount_amount: string;
  deposit_required_pct: string;
  refund_policy: RefundPolicy;
  cancellation_fee_pct: string;
  cancellation_reason: string | null;
  warehouse_name: string | null;
  customer_email: string | null;
  created_by_name: string | null;
  completed_by_name: string | null;
  cancelled_by_name: string | null;
  notes: string | null;
  items: ReservationItem[];
  payments: ReservationPayment[];
  refunds: ReservationRefund[];
}

export interface CreateReservationPayload {
  customer_id: string;
  warehouse_id: string;
  items: Array<{
    variant_id: string;
    quantity: number;
    unit_price: number;
    discount_amount?: number;
    notes?: string;
  }>;
  payments: Array<{
    payment_method: PaymentMethod;
    amount: number;
    kind?: 'deposit' | 'installment' | 'final';
    reference_number?: string;
    notes?: string;
  }>;
  discount_amount?: number;
  deposit_required_pct?: number;
  expires_at?: string;
  refund_policy?: RefundPolicy;
  cancellation_fee_pct?: number;
  notes?: string;
}

export interface AddPaymentPayload {
  payment_method: PaymentMethod;
  amount: number;
  kind?: 'deposit' | 'installment' | 'final';
  reference_number?: string;
  notes?: string;
}

export interface CancelPayload {
  reason: string;
  refund_policy?: RefundPolicy;
  refund_method?: PaymentMethod;
}

export interface ConvertPayload {
  final_payments?: AddPaymentPayload[];
  notes?: string;
}

export const reservationsApi = {
  list: (params?: {
    status?: ReservationStatus;
    customer_id?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }) =>
    unwrap<ReservationListItem[]>(api.get('/reservations', { params })),

  get: (id: string) =>
    unwrap<ReservationDetails>(api.get(`/reservations/${id}`)),

  create: (payload: CreateReservationPayload) =>
    unwrap<{
      id: string;
      reservation_no: string;
      total_amount: number;
      paid_amount: number;
      remaining_amount: number;
      status: ReservationStatus;
    }>(api.post('/reservations', payload)),

  addPayment: (id: string, payload: AddPaymentPayload) =>
    unwrap<ReservationDetails>(
      api.post(`/reservations/${id}/payments`, payload),
    ),

  convert: (id: string, payload: ConvertPayload) =>
    unwrap<{
      reservation_id: string;
      invoice_id: string;
      doc_no: string;
      change_given: number;
    }>(api.post(`/reservations/${id}/convert`, payload)),

  cancel: (id: string, payload: CancelPayload) =>
    unwrap<{
      reservation_id: string;
      cancelled: boolean;
      refund: { policy: RefundPolicy; gross: number; fee: number; net: number };
    }>(api.post(`/reservations/${id}/cancel`, payload)),

  extend: (id: string, expires_at: string) =>
    unwrap<ReservationDetails>(
      api.patch(`/reservations/${id}/extend`, { expires_at }),
    ),
};
