import { api, unwrap } from './client';

export type PaymentMethod = 'cash' | 'card' | 'instapay' | 'bank_transfer';
export type CustomerPaymentKind = 'settle_invoices' | 'deposit' | 'refund';

export interface Cashbox {
  id: string;
  name: string;
  warehouse_id: string | null;
  currency: string;
  current_balance: string;
  is_active: boolean;
}

export interface CashflowToday {
  cashbox_id: string;
  cashbox_name: string;
  current_balance: string;
  // New (post-migration 046)
  cash_in_today: string;
  cash_out_today: string;
  // Legacy aliases — same values, kept for backwards compatibility
  inflows_total: string;
  outflows_total: string;
  transactions_today: number;
}

export interface ShiftVariances {
  net_variance: string;
  total_surplus: string;
  total_deficit: string;
  surplus_count: number;
  deficit_count: number;
  matched_count: number;
}

export interface CashboxMovement {
  id: string;
  cashbox_id: string;
  cashbox_name: string | null;
  direction: 'in' | 'out';
  amount: string;
  category: string;
  reference_type: string;
  reference_id: string | null;
  reference_no: string | null;
  counterparty_name: string | null;
  balance_after: string;
  notes: string | null;
  user_id: string | null;
  user_name: string | null;
  kind_ar: string;
  created_at: string;
}

export interface CustomerPayment {
  id: string;
  doc_no: string;
  customer_id: string;
  cashbox_id: string;
  payment_method: PaymentMethod;
  amount: string;
  kind: CustomerPaymentKind;
  reference: string | null;
  notes: string | null;
  status: 'posted' | 'void';
  void_reason: string | null;
  received_by: string;
  created_at: string;
}

export interface SupplierPayment {
  id: string;
  doc_no: string;
  supplier_id: string;
  cashbox_id: string;
  payment_method: PaymentMethod;
  amount: string;
  reference: string | null;
  notes: string | null;
  status: 'posted' | 'void';
  paid_by: string;
  created_at: string;
}

export interface PaymentAllocation {
  invoice_id: string;
  amount: number;
}

export interface CreateCustomerPaymentPayload {
  customer_id: string;
  cashbox_id: string;
  payment_method: PaymentMethod;
  amount: number;
  kind?: CustomerPaymentKind;
  reference?: string;
  notes?: string;
  allocations?: PaymentAllocation[];
}

export interface CreateSupplierPaymentPayload {
  supplier_id: string;
  cashbox_id: string;
  payment_method: PaymentMethod;
  amount: number;
  reference?: string;
  notes?: string;
  allocations?: PaymentAllocation[];
}

export const cashDeskApi = {
  cashboxes: () => unwrap<Cashbox[]>(api.get('/cash-desk/cashboxes')),

  cashflowToday: () =>
    unwrap<CashflowToday[]>(api.get('/cash-desk/cashflow/today')),

  shiftVariances: () =>
    unwrap<ShiftVariances>(api.get('/cash-desk/shift-variances')),

  movements: (params?: {
    cashbox_id?: string;
    from?: string;
    to?: string;
    direction?: 'in' | 'out';
    category?: string;
    limit?: number;
    offset?: number;
  }) =>
    unwrap<CashboxMovement[]>(api.get('/cash-desk/movements', { params })),

  // Customer receipts
  receive: (payload: CreateCustomerPaymentPayload) =>
    unwrap<CustomerPayment>(api.post('/cash-desk/customer-payments', payload)),

  listCustomerPayments: (customer_id?: string) =>
    unwrap<CustomerPayment[]>(
      api.get('/cash-desk/customer-payments', {
        params: customer_id ? { customer_id } : undefined,
      }),
    ),

  voidCustomerPayment: (id: string, reason: string) =>
    unwrap<{ voided: boolean }>(
      api.post(`/cash-desk/customer-payments/${id}/void`, { reason }),
    ),

  // Supplier payments
  pay: (payload: CreateSupplierPaymentPayload) =>
    unwrap<SupplierPayment>(api.post('/cash-desk/supplier-payments', payload)),

  listSupplierPayments: (supplier_id?: string) =>
    unwrap<SupplierPayment[]>(
      api.get('/cash-desk/supplier-payments', {
        params: supplier_id ? { supplier_id } : undefined,
      }),
    ),

  // Manual deposit / withdrawal (opening balance, owner top-up, etc.)
  deposit: (payload: {
    cashbox_id: string;
    direction: 'in' | 'out';
    amount: number;
    category?: string;
    notes?: string;
    txn_date?: string; // YYYY-MM-DD
  }) =>
    unwrap<{ id: number; amount: string; balance_after: string; new_balance: number }>(
      api.post('/cash-desk/deposit', payload),
    ),
};
