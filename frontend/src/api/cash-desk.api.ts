import { api, unwrap } from './client';
import type { PaymentMethodCode } from './payments.api';

/**
 * PR-FIN-PAYACCT-4C — the cash-desk API now accepts the FULL set of
 * payment methods (`PaymentMethodCode`) so customer receipts and
 * supplier payments can pick a specific provider (InstaPay handle,
 * card network, wallet) the same way POS does. Backwards compat: the
 * legacy 4 values ('cash','card','instapay','bank_transfer') are still
 * accepted by the backend DTO, but the frontend canonical type is now
 * the full enum minus 'credit'/'other' (which don't make sense for
 * cash-desk operations).
 */
export type PaymentMethod = Exclude<PaymentMethodCode, 'credit' | 'other'>;
export type CustomerPaymentKind = 'settle_invoices' | 'deposit' | 'refund';

export type CashboxKind = 'cash' | 'bank' | 'ewallet' | 'check';

export interface Cashbox {
  id: string;
  name: string;
  name_ar: string;
  warehouse_id: string | null;
  currency: string;
  current_balance: string;
  opening_balance?: string;
  is_active: boolean;

  // Type + linked institution (null for plain cash)
  kind: CashboxKind;
  institution_code: string | null;
  institution_name: string | null;
  institution_name_en: string | null;
  institution_domain: string | null;
  institution_color: string | null;
  institution_kind: 'bank' | 'ewallet' | 'check_issuer' | null;

  // Bank fields
  bank_branch: string | null;
  account_number: string | null;
  iban: string | null;
  swift_code: string | null;
  account_holder_name: string | null;
  account_manager_name: string | null;
  account_manager_phone: string | null;
  account_manager_email: string | null;

  // Wallet fields
  wallet_phone: string | null;
  wallet_owner_name: string | null;

  // Check field
  check_issuer_name: string | null;

  color: string | null;
  notes?: string | null;
}

export interface FinancialInstitution {
  code: string;
  kind: 'bank' | 'ewallet' | 'check_issuer';
  name_ar: string;
  name_en: string;
  short_code: string | null;
  website_domain: string | null;
  color_hex: string | null;
  sort_order: number;
  is_active: boolean;
  is_system: boolean;
}

export interface CreateCashboxPayload {
  name_ar: string;
  kind: CashboxKind;
  warehouse_id?: string;
  currency?: string;
  opening_balance?: number;
  color?: string;
  institution_code?: string;
  bank_branch?: string;
  account_number?: string;
  iban?: string;
  swift_code?: string;
  account_holder_name?: string;
  account_manager_name?: string;
  account_manager_phone?: string;
  account_manager_email?: string;
  wallet_phone?: string;
  wallet_owner_name?: string;
  check_issuer_name?: string;
  notes?: string;
}

export type UpdateCashboxPayload = Partial<CreateCashboxPayload> & {
  is_active?: boolean;
};

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

export interface ReconciliationRow {
  id: string;
  cashbox_id: string;
  direction: 'in' | 'out';
  amount: string;
  category: string;
  balance_after: string;
  notes: string | null;
  created_at: string;
  is_reconciled: boolean;
  reconciled_at: string | null;
  statement_reference: string | null;
}

/**
 * PR-FIN-PAYACCT-4D-UX-FIX-4 — discriminator on a unified-movement row.
 * `cashbox_txn` = direct cash flow recorded in cashbox_transactions.
 * The other 3 = non-cash account flows surfaced for cashboxes whose
 * PAs are linked.
 */
export type CashboxMovementSource =
  | 'cashbox_txn'
  | 'invoice_payment'
  | 'customer_payment'
  | 'supplier_payment';

export interface CashboxMovementUnifiedRow {
  source: CashboxMovementSource;
  id: string;
  direction: 'in' | 'out';
  amount_in: string;       // pg numeric → string
  amount_out: string;
  net_amount: string;
  kind_ar: string;         // Arabic operation label
  reference_type: string | null;
  reference_id: string | null;
  reference_no: string | null;
  counterparty_name: string | null;
  payment_account_id: string | null;
  payment_method: string | null;
  balance_after: string | null;
  user_id: string | null;
  user_name: string | null;
  journal_entry_id: string | null;
  journal_entry_no: string | null;
  occurred_at: string;
  notes: string | null;
}

export interface CashboxMovementsUnifiedResponse {
  rows: CashboxMovementUnifiedRow[];
  total: number;
  totals: {
    in: string;
    out: string;
    net: string;
    count: number;
  };
}

/**
 * PR-FIN-PAYACCT-4D-REPORTS-1A — coverage flag from
 * `v_cashbox_drift_per_ref`. Indicates whether the per-reference
 * row appears in `cashbox_transactions` only, `journal_lines` only,
 * or both (with a numeric difference).
 */
export type CashboxDriftCoverage = 'CT_only' | 'JE_only' | 'both';

/**
 * PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX-2 — explanation taxonomy for
 * the per-row "شرح السبب" expandable. Backend computes the code +
 * Arabic phrase + recommended review action so the FE just renders.
 */
export type CashboxDriftExplanationCode =
  | 'invoice_ct_inflated_by_edit_replay'
  | 'invoice_ct_more_than_je_cash'
  | 'invoice_je_more_than_ct'
  | 'return_je_missing_cashbox_link'
  | 'return_ct_only_no_je'
  | 'ref_label_mismatch'
  | 'unknown_review_required';

/**
 * PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX-2 — one entry of an invoice's
 * payment breakdown. Surfaces the per-method roll-up so the operator
 * sees how much of the invoice was paid in cash vs other methods.
 */
export interface CashboxDriftPaymentBreakdownEntry {
  method: PaymentMethodCode | string;
  amount: string;
}

/**
 * PR-FIN-PAYACCT-4D-REPORTS-1A — one row of the per-reference drift
 * drilldown. Money columns arrive as PG-numeric strings to preserve
 * precision (formatted on the FE with EGP). Read-only.
 *
 * UX-FIX-2 added the per-row enrichment fields (`invoice_*`,
 * `return_*`, `je_*`, `expected_cashbox_amount`, `explanation_*`,
 * `recommended_review_action_ar`). All optional/nullable so an older
 * BE without the enrichment still parses cleanly.
 */
export interface CashboxDriftDetailRow {
  cashbox_id: string;
  cashbox_name: string;
  reference_type: string;
  reference_id: string;
  /** Resolved invoice_no / payment_no / expense_no / purchase_no. Null for shifts/other refs. */
  reference_no: string | null;
  coverage: CashboxDriftCoverage;
  ct_count: number;
  je_line_count: number;
  ct_signed_amount: string;
  je_signed_amount: string;
  drift_amount: string;
  first_seen_at: string | null;
  last_seen_at: string | null;
  /** A representative entry_no from `journal_entries` (if any JE side). */
  sample_entry_no: string | null;

  // ── PR-FIN-PAYACCT-4D-REPORTS-1A-UX-FIX-2 enrichment ───────────────
  /** Invoice grand_total (numeric string). null when ref isn't an invoice. */
  invoice_grand_total?: string | null;
  /** Invoice paid_amount (numeric string). null when ref isn't an invoice. */
  invoice_paid_amount?: string | null;
  /** Sum of cash invoice_payments. null when ref isn't an invoice. */
  invoice_cash_paid?: string | null;
  /** Sum of non-cash invoice_payments (instapay/wallet/card/etc). */
  invoice_non_cash_paid?: string | null;
  /** Per-method breakdown of invoice_payments (rolled up). */
  invoice_payment_breakdown?: CashboxDriftPaymentBreakdownEntry[] | null;
  /** Return total_refund (numeric string). null when ref isn't a return. */
  return_total_refund?: string | null;
  /** Return refund_method (cash / wallet / etc). */
  return_refund_method?: string | null;
  /** TRUE when ANY non-void JE exists for this reference_id. */
  je_exists?: boolean;
  /** TRUE when at least one JE line links to this cashbox (directly or via COA). */
  je_has_cashbox_link?: boolean;
  /**
   * The amount the cashbox SHOULD show for this reference, as
   * computed from the source document (cash-paid for invoices,
   * -refund for returns). Operator-facing reference value.
   */
  expected_cashbox_amount?: string | null;
  /** Explanation enum (see `CashboxDriftExplanationCode`). */
  explanation_code?: CashboxDriftExplanationCode;
  /** Short Arabic phrase summarizing the cause of the drift. */
  explanation_ar?: string;
  /** Read-only suggested next step (never an automatic action). */
  recommended_review_action_ar?: string;
}

/**
 * PR-FIN-PAYACCT-4D-REPORTS-1A — full drift-detail response.
 *   • `cashbox`  → matching `v_cashbox_gl_drift` row, or null when the
 *                  cashbox isn't in the view yet.
 *   • `rows`     → contributing references with `ABS(drift) > 0.01`,
 *                  ordered by ABS(drift) DESC.
 *   • `totals`   → signed sums + count over the same filter — the FE
 *                  can compare `totals.total_drift` to
 *                  `cashbox.gl_drift` to verify the breakdown sums.
 */
export interface CashboxDriftDetailResponse {
  cashbox: {
    id: string;
    name: string;
    kind: CashboxKind;
    is_active: boolean;
    stored_balance: string;
    gl_net: string;
    gl_drift: string;
  } | null;
  rows: CashboxDriftDetailRow[];
  totals: {
    count: number;
    total_ct: string;
    total_je: string;
    total_drift: string;
  };
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
  /**
   * PR-FIN-PAYACCT-4C — REQUIRED when method ≠ 'cash' AND at least one
   * active payment_account exists for the chosen method. The backend
   * service freezes a snapshot at INSERT time and the posting service
   * routes the JE's DR leg to `snapshot.gl_account_code` (instead of
   * the cashbox-GL fallback).
   */
  payment_account_id?: string | null;
}

export interface CreateSupplierPaymentPayload {
  supplier_id: string;
  cashbox_id: string;
  payment_method: PaymentMethod;
  amount: number;
  reference?: string;
  notes?: string;
  allocations?: PaymentAllocation[];
  /**
   * PR-FIN-PAYACCT-4C — mirror of CreateCustomerPaymentPayload.
   * REQUIRED when method ≠ 'cash' AND at least one active
   * payment_account exists for the chosen method.
   */
  payment_account_id?: string | null;
}

export const cashDeskApi = {
  cashboxes: (includeInactive = false) =>
    unwrap<Cashbox[]>(
      api.get('/cash-desk/cashboxes', {
        params: includeInactive ? { include_inactive: 'true' } : undefined,
      }),
    ),

  institutions: (kind?: 'bank' | 'ewallet' | 'check_issuer') =>
    unwrap<FinancialInstitution[]>(
      api.get('/cash-desk/institutions', {
        params: kind ? { kind } : undefined,
      }),
    ),

  createCashbox: (payload: CreateCashboxPayload) =>
    unwrap<Cashbox>(api.post('/cash-desk/cashboxes', payload)),

  updateCashbox: (id: string, payload: UpdateCashboxPayload) =>
    unwrap<Cashbox>(api.post(`/cash-desk/cashboxes/${id}`, payload)),

  removeCashbox: (id: string) =>
    unwrap<{ deleted?: boolean; soft_deleted?: boolean; reason?: string }>(
      api.post(`/cash-desk/cashboxes/${id}/delete`, {}),
    ),

  transfer: (payload: {
    from_cashbox_id: string;
    to_cashbox_id: string;
    amount: number;
    notes?: string;
  }) =>
    unwrap<{
      transferred: true;
      amount: number;
      from_balance: number;
      to_balance: number;
    }>(api.post('/cash-desk/transfer', payload)),

  voidSupplierPayment: (id: string, reason: string) =>
    unwrap<{ voided: boolean }>(
      api.post(`/cash-desk/supplier-payments/${id}/void`, { reason }),
    ),

  // Bank reconciliation
  reconciliation: (params: {
    cashbox_id: string;
    from?: string;
    to?: string;
    status?: 'all' | 'reconciled' | 'open';
  }) =>
    unwrap<{
      rows: ReconciliationRow[];
      summary: {
        system_in: number;
        system_out: number;
        reconciled_in: number;
        reconciled_out: number;
        unreconciled_in: number;
        unreconciled_out: number;
      };
    }>(api.get('/cash-desk/reconciliation', { params })),

  markReconciled: (txn_ids: string[], reference?: string) =>
    unwrap<{ updated: number }>(
      api.post('/cash-desk/reconciliation/mark', { txn_ids, reference }),
    ),

  unmarkReconciled: (txn_ids: string[]) =>
    unwrap<{ updated: number }>(
      api.post('/cash-desk/reconciliation/unmark', { txn_ids }),
    ),

  autoMatchStatement: (payload: {
    cashbox_id: string;
    lines: Array<{
      date: string;
      amount: number;
      direction: 'in' | 'out';
      reference?: string;
    }>;
  }) =>
    unwrap<{
      matched: number;
      ambiguous: number;
      unmatched: number;
      results: Array<{
        statement_line: any;
        matched_id: string | null;
        status: 'matched' | 'ambiguous' | 'unmatched';
        candidates?: number;
      }>;
    }>(api.post('/cash-desk/reconciliation/auto-match', payload)),

  cashflowToday: () =>
    unwrap<CashflowToday[]>(api.get('/cash-desk/cashflow/today')),

  // PR-FIN-PAYACCT-4B — per-cashbox stored vs GL drift; used by the
  // Payment Accounts admin page accounting-alerts panel.
  glDrift: () =>
    unwrap<import('./payments.api').CashboxGlDrift[]>(
      api.get('/cash-desk/gl-drift'),
    ),

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

  // PR-FIN-PAYACCT-4D-UX-FIX-4 — unified per-cashbox movements feed.
  // Reads from cashbox_transactions PLUS invoice/customer/supplier
  // payments routed through PAs linked to this cashbox. SELECT-only;
  // never reads gl_account_code alone.
  cashboxMovementsUnified: (
    cashboxId: string,
    filter: {
      from?: string;
      to?: string;
      type?: CashboxMovementSource;
      q?: string;
      limit?: number;
      offset?: number;
    } = {},
  ) =>
    unwrap<CashboxMovementsUnifiedResponse>(
      api.get(`/cash-desk/cashboxes/${cashboxId}/movements-unified`, {
        params: {
          from: filter.from,
          to: filter.to,
          type: filter.type,
          q: filter.q,
          limit: filter.limit,
          offset: filter.offset,
        },
      }),
    ),

  // PR-FIN-PAYACCT-4D-REPORTS-1A — read-only per-reference drilldown
  // for a single cashbox's stored vs GL drift. Returns the cashbox-
  // level header (from `v_cashbox_gl_drift`) plus every contributing
  // reference (from `v_cashbox_drift_per_ref`) with non-zero drift,
  // plus signed-sum totals over the same filter. Pure SELECT — the
  // BE method is `getDriftDetail` and contains no INSERT/UPDATE/DELETE.
  driftDetail: (cashboxId: string) =>
    unwrap<CashboxDriftDetailResponse>(
      api.get(`/cash-desk/cashboxes/${cashboxId}/drift-detail`),
    ),

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
