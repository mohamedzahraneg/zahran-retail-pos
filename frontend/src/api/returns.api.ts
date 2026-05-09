import { api, unwrap } from './client';

// PR-FIN-RETURNS-UX-0B — defensive list-shape adapter. The BE list
// endpoints currently return raw arrays wrapped in the global
// `{success, data, meta}` envelope, but historically the codebase has
// also seen `{rows, total}`, `{items}`, and bare `{data}` envelopes.
// `unwrap()` already strips the outer envelope; this normalizer
// guards against any inner-shape surprise so a future BE rewrite
// doesn't silently render the page blank.
//
// Returns `[]` (with a console.warn) if the payload cannot be
// recognized as any known shape — never throws, never crashes the
// caller. The page-level diagnostic banner reads `__shapeWarning`
// off the array to surface the issue to the user.
export function normalizeListResponse<T>(raw: unknown): T[] {
  if (Array.isArray(raw)) return raw as T[];
  if (raw && typeof raw === 'object') {
    const r = raw as Record<string, unknown>;
    if (Array.isArray(r.rows)) return r.rows as T[];
    if (Array.isArray(r.data)) return r.data as T[];
    if (Array.isArray(r.items)) return r.items as T[];
    if (Array.isArray(r.results)) return r.results as T[];
  }
  if (typeof console !== 'undefined' && console.warn) {
    console.warn(
      '[returns.api] normalizeListResponse: unexpected payload shape',
      raw,
    );
  }
  // Tag the empty array so the diagnostic banner can flag the issue.
  const out: any[] = [];
  Object.defineProperty(out, '__shapeWarning', {
    value: 'unexpected payload shape',
    enumerable: false,
  });
  return out as T[];
}

// PR-FIN-RETURNS-UX-0A — `'cancelled'` is added defensively after PR-1B
// extended the BE enum + PR-1C shipped the cancel endpoint. The FE has
// no cancel UI yet (that's PR 1E), but mapping/badging code must not
// crash if the BE legitimately returns a cancelled row.
export type ReturnStatus =
  | 'pending'
  | 'approved'
  | 'refunded'
  | 'rejected'
  | 'cancelled';
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
//
// PR-FIN-RETURNS-UX-1A added the read-side enrichment fields below to
// every list row + detail header. They are all optional/nullable so any
// older caller that only reads the legacy shape still compiles.
export type ReturnAccountingStatus =
  | 'matched'
  | 'je_missing'
  | 'cashbox_not_linked'
  | 'needs_review'
  | 'not_applicable';

export type ReturnInventoryStatus = 'restored' | 'not_applicable';

export type ReturnMatchStatus = 'matched' | 'needs_review' | 'pending';

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
  created_at?: string | null;
  updated_at?: string | null;
  original_invoice_id: string;
  invoice_no: string | null;
  customer_id: string | null;
  customer_name: string | null;
  customer_phone: string | null;
  items_count: number;
  units_count: number;
  // PR-FIN-RETURNS-UX-1A enrichment
  cashbox_id?: string | null;
  cashbox_name?: string | null;
  requested_by?: string | null;
  requested_by_name?: string | null;
  approved_by?: string | null;
  approved_by_name?: string | null;
  refunded_by?: string | null;
  refunded_by_name?: string | null;
  journal_entry_id?: string | null;
  journal_entry_no?: string | null;
  journal_entry_posted_at?: string | null;
  refund_cashbox_transaction_id?: number | null;
  has_unlinked_cash_leg?: boolean | null;
  accounting_status?: ReturnAccountingStatus;
  inventory_status?: ReturnInventoryStatus;
  match_status?: ReturnMatchStatus;
  restock_eligible_items?: number | null;
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
  /** PR-R1 — required when there is a non-zero cash difference (in
   *  either direction). Equal exchanges and non-cash differences omit
   *  both. Direct-cashbox refund direction additionally requires the
   *  returns.refund.direct_cashbox permission. */
  shift_id?: string;
  cashbox_id?: string;
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

  list: async (params?: {
    status?: ReturnStatus;
    customer_id?: string;
    q?: string;
    limit?: number;
    offset?: number;
    // PR-FIN-RETURNS-UX-0A — surface the read-side filters PR-1A added
    // on the backend so callers can pass them in a typed way. All
    // optional; the BE accepts them or omits them transparently.
    date_from?: string;
    date_to?: string;
    refund_method?: PaymentMethod;
    accounting_status?:
      | 'matched'
      | 'je_missing'
      | 'cashbox_not_linked'
      | 'needs_review'
      | 'not_applicable';
  }) => {
    // PR-FIN-RETURNS-UX-0B — pass payload through `normalizeListResponse`
    // so a future BE shape change (or transient `{rows, total}` style
    // envelope) cannot silently leave the page blank.
    const raw = await unwrap<unknown>(api.get('/returns', { params }));
    return normalizeListResponse<ReturnListItem>(raw);
  },

  get: (id: string) => unwrap<ReturnDetails>(api.get(`/returns/${id}`)),

  approve: (id: string, notes?: string) =>
    unwrap<ReturnDetails>(api.post(`/returns/${id}/approve`, { notes })),

  refund: (
    id: string,
    payload: {
      refund_method: PaymentMethod;
      reference?: string;
      notes?: string;
      /** PR-R1 — required when refund_method='cash'. Pass either
       *  shift_id (open/pending shift; cashbox is taken from it) or
       *  cashbox_id alone (direct cashbox; shift_id stays null and
       *  requires returns.refund.direct_cashbox permission). */
      shift_id?: string;
      cashbox_id?: string;
    },
  ) => unwrap<ReturnDetails>(api.post(`/returns/${id}/refund`, payload)),

  reject: (id: string, reason: string) =>
    unwrap<ReturnDetails>(api.post(`/returns/${id}/reject`, { reason })),

  // PR-FIN-RETURNS-UX-1E — admin cancellation. The BE shipped this in
  // PR-1C with @Roles('admin') + @Permissions('returns.cancel'). The
  // FE caller MUST gate visibility on the same surface so a non-admin
  // never sees the button. The `confirm` token must equal
  // `CANCEL_RETURN_<return_no>` exactly — the BE rejects mismatches
  // with HTTP 400. Non-cash refunded returns are rejected by the BE
  // with the spec'd Arabic diagnostic.
  cancelReturn: (
    id: string,
    payload: { reason: string; confirm: string },
  ) => unwrap<ReturnDetails>(api.post(`/returns/${id}/cancel`, payload)),

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

  listExchanges: async (params?: { q?: string; limit?: number; offset?: number }) => {
    // PR-FIN-RETURNS-UX-0B — same defensive normalization as `list()`.
    const raw = await unwrap<unknown>(api.get('/exchanges', { params }));
    return normalizeListResponse<ExchangeListItem>(raw);
  },

  getExchange: (id: string) =>
    unwrap<any>(api.get(`/exchanges/${id}`)),

  // ── Audit history (read-only, Phase 1) ──────────────────────────
  // GET /returns/:id/audit + GET /exchanges/:id/audit
  // Composes audit_logs row-diffs (DB-trigger captured) +
  // activity_logs (high-level user actions) + amendments
  // (Phase-4 placeholder, currently always []).
  getReturnAudit: (id: string) =>
    unwrap<DocumentAuditResult>(api.get(`/returns/${id}/audit`)),

  getExchangeAudit: (id: string) =>
    unwrap<DocumentAuditResult>(api.get(`/exchanges/${id}/audit`)),
};

// ── Audit response types (mirror the BE shape) ─────────────────────

export interface AuditChangeRow {
  id: string;
  table_name: string;
  record_id: string;
  operation: 'I' | 'U' | 'D';
  changed_by: string | null;
  changed_by_username: string | null;
  changed_by_name: string | null;
  old_data: Record<string, any> | null;
  new_data: Record<string, any> | null;
  changed_at: string;
}

export interface AuditActivityRow {
  id: string;
  user_id: string | null;
  username: string | null;
  full_name: string | null;
  action: string;
  entity: string;
  entity_id: string | null;
  summary: string | null;
  metadata: any;
  ip_address: string | null;
  created_at: string;
}

export interface AuditAmendmentRow {
  id: string;
  amendment_no: string;
  amendment_kind: string;
  reason_text: string;
  delta_summary: any;
  created_by: string | null;
  created_by_name: string | null;
  created_at: string;
}

export interface AuditEditRequestRow {
  id: string;
  parent_id: string;
  document_no: string | null;
  requested_action: string;
  requested_payload: Record<string, unknown>;
  before_snapshot: Record<string, unknown>;
  after_preview: Record<string, unknown> | null;
  reason_text: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  requested_by: string;
  requested_by_name: string | null;
  requested_at: string;
  reviewed_by: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  review_notes: string | null;
  source: 'edit_request';
}

export interface DocumentAuditResult {
  document_type: 'return' | 'exchange';
  document_id: string;
  document_changes: AuditChangeRow[];
  item_changes: AuditChangeRow[];
  activity: AuditActivityRow[];
  amendments: AuditAmendmentRow[];
  /** Phase 1 — request + review only.  No payload application. */
  edit_requests: AuditEditRequestRow[];
}
