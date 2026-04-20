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
  opening_balance: string;
  inflows_total: string;
  outflows_total: string;
  current_balance: string;
  invoices_cash: string;
  customer_receipts: string;
  supplier_payments: string;
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
};
