import { api, unwrap } from './client';

export type ShiftStatus = 'open' | 'closed' | 'pending_close';

export type VarianceTreatment =
  | 'charge_employee'
  | 'company_loss'
  | 'revenue'
  | 'suspense';

export interface ApproveClosePayload {
  variance_treatment?: VarianceTreatment;
  variance_employee_id?: string;
  variance_notes?: string;
}

export interface PaymentBreakdown {
  cash: { amount: number; count: number };
  card: { amount: number; count: number };
  instapay: { amount: number; count: number };
  bank_transfer: { amount: number; count: number };
}

// PR-PAY-4 — Per-method + per-account roll-up surfaced alongside the
// legacy 4-key map. Cashier close-out reads this; the legacy shape is
// kept for any external integration that might still read it.
export interface PaymentBreakdownAccount {
  payment_account_id: string | null;
  display_name: string | null;
  identifier: string | null;
  provider_key: string | null;
  total_amount: number;
  invoice_count: number;
  payment_count: number;
}

export interface PaymentBreakdownMethod {
  method: string;
  method_label_ar: string;
  total_amount: number;
  invoice_count: number;
  payment_count: number;
  accounts: PaymentBreakdownAccount[];
}

export interface ShiftExpenseRow {
  id: string;
  expense_no: string | null;
  amount: number | string;
  description: string | null;
  category_name: string | null;
  expense_date: string;
  status: string;
  /** PR-14 — joined fields used by the cash-out section. */
  employee_name?: string | null;
  cashbox_name?: string | null;
  payment_method?: string;
  created_by_name?: string | null;
  je_entry_no?: string | null;
}

/** PR-14 — every cash row that left the drawer for an employee
 *  (settlement payout or expense flagged as advance). The shift
 *  closing renders these in their own "حركات موظفين نقدية" section
 *  so they're never confused with operating expenses. */
export interface EmployeeCashMovement {
  kind: 'settlement' | 'advance';
  id: string;
  movement_type: 'settlement' | 'advance';
  /** Arabic display label used by the table — صرف مستحقات / سلفة موظف. */
  type_label: string;
  employee_user_id: string | null;
  employee_name: string | null;
  amount: number;
  created_at: string;
  cashbox_id: string | null;
  cashbox_name: string | null;
  payment_method: string | null;
  description: string | null;
  je_entry_no: string | null;
  created_by_name: string | null;
  /** Friendly accounting impact label for the table cell.
   *  e.g. "DR 213 / CR الخزينة الرئيسية". */
  accounting_impact: string;
  /** explicit = row carries shift_id, derived = matched by
   *  cashbox_id + time window. */
  link_method: 'explicit' | 'derived';
}

/** PR-21 — one cashbox movement that came from a return refund or
 *  an exchange cash difference. Sourced from cashbox_transactions
 *  joined to returns/exchanges/journal_entries. */
export interface RefundCashMovement {
  id: string;
  kind: 'return' | 'exchange';
  /** Friendly Arabic label — مرتجع نقدي / فرق استبدال / مرتجع نقدي ملغي / عكس إلغاء مرتجع نقدي. */
  type_label: string;
  direction: 'in' | 'out';
  /** Friendly Arabic label — داخل / خارج. */
  direction_label: string;
  amount: number;
  reference_no: string | null;
  customer_name: string | null;
  cashbox_name: string | null;
  /** PR-R1 — shift number this row is attributed to (always the
   *  closing shift since direct-cashbox + cross-shift rows are
   *  excluded server-side). */
  shift_no?: string | null;
  created_at: string;
  created_by_name: string | null;
  je_entry_no: string | null;
  accounting_impact: string;
  link_method: 'derived' | 'explicit';
  // PR-FIN-RETURNS-SHIFT-CANCEL-AWARE — flags for cancellation-aware
  // rendering. `is_reversal=true` means this row is the cancellation
  // reversal (direction='in', category like reversal_*). When the
  // source return is cancelled, the original-out row carries
  // `source_return_status='cancelled'` so the FE can render a "ملغي"
  // badge AND match it to the reversal-in row.
  is_reversal?: boolean;
  source_return_status?:
    | 'pending'
    | 'approved'
    | 'refunded'
    | 'rejected'
    | 'cancelled'
    | null;
}

/** PR-B1 — one row in the shift counted-cash adjustment audit. */
export interface ShiftCountAdjustment {
  id: string;
  shift_id: string;
  old_actual_closing: number | string | null;
  new_actual_closing: number | string;
  old_expected_closing: number | string | null;
  new_expected_closing: number | string | null;
  old_difference: number | string | null;
  new_difference: number | string | null;
  reason: string;
  adjusted_by: string;
  adjusted_by_name?: string | null;
  adjusted_at: string;
}

/**
 * PR-FIX-SHIFTS-OPENING-BALANCE-ADJUST (migration 128) — one row in
 * the shift opening-balance adjustment audit.  Mirrors the
 * shape of `shift_opening_balance_adjustments`.
 */
export interface ShiftOpeningBalanceAdjustment {
  id: string;
  shift_id: string;
  old_opening_balance: number | string;
  new_opening_balance: number | string;
  old_expected_closing: number | string | null;
  new_expected_closing: number | string | null;
  shift_status_at_adjust: string;
  has_movements_at_adjust: boolean;
  reason: string;
  notes: string | null;
  adjusted_by: string;
  adjusted_by_name?: string | null;
  adjusted_at: string;
}

export interface ShiftSummary {
  shift_id: string;
  shift_no: string;
  status: ShiftStatus;
  opening_balance: number;
  opened_at: string;
  closed_at: string | null;

  // Sales
  total_sales: number;
  invoice_count: number;
  cancelled_count: number;
  total_cancelled: number;
  remaining_receivable: number;

  // Payment method split (legacy 4-key shape — kept for back-compat)
  payment_breakdown: PaymentBreakdown;

  // PR-PAY-4 — Structured per-method + per-account breakdown.
  // Source of truth for the new close-out section. Optional so older
  // backend deploys (not yet on PAY-4) keep this contract working.
  payment_breakdown_v2?: PaymentBreakdownMethod[];
  cash_total?: number;
  non_cash_total?: number;
  grand_payment_total?: number;

  // Cashbox flows
  customer_receipts: number;
  supplier_payments: number;
  other_cash_in: number;
  other_cash_out: number;

  // Returns + expenses
  total_returns: number;
  return_count: number;
  /** Sum of advances + operating expenses (legacy semantic). */
  total_expenses: number;
  expense_count: number;
  /** Operating expenses only (advances filtered out — PR-14). */
  expenses: ShiftExpenseRow[];

  // PR-14 — employee cash split (no schema changes)
  total_operating_expenses: number;
  operating_expense_count: number;
  total_employee_advances: number;
  employee_advance_count: number;
  total_employee_settlements: number;
  employee_settlement_count: number;
  total_employee_cash_out: number;
  employee_cash_movements: EmployeeCashMovement[];

  // PR-21 — Refund / exchange cash visibility (sourced from
  // cashbox_transactions where reference_type IN ('return','exchange'))
  // PR-FIN-RETURNS-SHIFT-CANCELLED-EXCLUDE-FROM-TOTALS — the totals
  // below now exclude cancelled+reversal pairs so the wardia "تم
  // صرف نقدي" / "تم استلام نقدي" displays reflect real cash
  // movement only. The audit-only `cancelled_return_*` fields surface
  // the cancelled-pair amounts for an informational footer.
  total_refund_cash_out: number;
  total_refund_cash_in: number;
  net_refund_cash_impact: number;
  /** Sum of original refund-out CTs whose source return is now
   *  `status='cancelled'`. Audit-only — NOT in `total_refund_cash_out`
   *  or `total_cash_out`. */
  cancelled_return_out_amount?: number;
  /** Sum of cancellation reversal-in CTs (paired with the above).
   *  Audit-only — NOT in `total_refund_cash_in` or `total_cash_in`. */
  cancelled_return_reversal_amount?: number;
  /** Always equals out − reversal; will be 0 in the steady state
   *  because each cancelled return has exactly one reversal CT. */
  cancelled_return_net?: number;
  refund_cash_movements: RefundCashMovement[];

  // Reconciliation
  total_cash_in: number;
  total_cash_out: number;
  expected_closing: number;
  actual_closing: number | null;
  variance: number | null;
}

export interface Shift {
  id: string;
  shift_no: string;
  cashbox_id: string;
  cashbox_name?: string;
  warehouse_id: string;
  warehouse_name?: string;
  opened_by: string;
  opened_by_name?: string;
  closed_by?: string | null;
  closed_by_name?: string | null;
  status: ShiftStatus;
  opening_balance: string | number;
  expected_closing: string | number;
  actual_closing: string | number | null;
  difference?: string | number;
  variance?: string | number;
  total_sales: string | number;
  total_returns: string | number;
  total_expenses: string | number;
  total_cash_in: string | number;
  total_cash_out: string | number;
  invoice_count: number;
  opened_at: string;
  closed_at: string | null;
  notes: string | null;
  // Pending-close request metadata (set while status='pending_close')
  close_requested_at?: string | null;
  close_requested_by?: string | null;
  close_requested_amount?: string | number | null;
  close_requested_notes?: string | null;
  close_approved_at?: string | null;
  close_approved_by?: string | null;
  close_rejection_reason?: string | null;
  // Variance treatment metadata (migration 060)
  variance_treatment?: VarianceTreatment | null;
  variance_employee_id?: string | null;
  variance_notes?: string | null;
  variance_journal_entry_id?: string | null;
  variance_amount?: number | string | null;
  variance_type?: 'shortage' | 'overage' | 'zero' | null;
  variance_approved_by?: string | null;
  variance_approved_at?: string | null;
  // Live values injected by /shifts/pending-close (not DB columns) —
  // present only on that endpoint's rows. See shifts.service.listPendingCloses.
  expected_closing_live?: number | null;
  variance_live?: number | null;
  invoices?: Array<{
    id: string;
    invoice_no: string;
    grand_total: string;
    paid_amount: string;
    status: string;
    completed_at: string;
  }>;
  /** Present on /current, /:id, and /:id/summary. */
  summary?: ShiftSummary;
}

export interface OpenShiftPayload {
  cashbox_id: string;
  warehouse_id: string;
  opening_balance: number;
  notes?: string;
}

// ─── PR-SHIFT-REPORTS-AGGREGATED-DETAIL-FE ──────────────────────────
// Types for the new POST /shifts/reports/aggregate-detail endpoint
// (added to BE in PR #288). Read-only consolidated report across N
// selected shifts (max 50).
// ────────────────────────────────────────────────────────────────────

export interface AggregateDetailFilters {
  /** YYYY-MM-DD (Cairo). */
  from?: string;
  to?: string;
  status?: 'open' | 'closed' | 'pending_close' | 'all';
  /** Cashier user_id (opened_by). */
  user_id?: string;
  cashbox_id?: string;
}

export interface AggregateDetailRequest {
  /**
   * Explicit selection. When provided AND non-empty, the BE ignores
   * `filters`. Wrapper enforces this in `aggregateDetail()` below.
   */
  shift_ids?: string[];
  filters?: AggregateDetailFilters;
}

/** Header-shifts row — per-shift metadata + cash-side reconciliation. */
export interface AggregateHeaderShift {
  id: string;
  shift_no: string;
  status: ShiftStatus;
  opened_at: string;
  closed_at: string | null;
  cashier_name: string | null;
  cashbox_name: string | null;

  // ── Cash-side reconciliation (LIVE single-shift summary fields) ──
  // Sourced from the LIVE `summary(id)` recompute — NOT from the
  // stored `shifts.expected_closing` column, which can be stale and
  // can include non-cash payments. This guarantees non-cash amounts
  // (InstaPay, wallet, bank transfer) NEVER inflate cash variance.
  opening_balance: number;
  /** Cash-only expected closing balance (= already includes opening). */
  expected_closing: number;
  /** Cash counted at close. NULL when shift is still open. */
  actual_closing: number | null;
  /** = `actual_closing − expected_closing` (cash only). NULL when open. */
  variance: number | null;
  /**
   * "الصافي" — per business definition equals `expected_closing` (the
   * cash-only expected closing balance, which already includes the
   * opening balance via the single-shift summary formula).
   */
  /**
   * "الصافي" — daily net cash movement during the shift
   * (`expected_closing − opening_balance`). Does NOT include the
   * opening balance. The expected closing balance is exposed
   * separately as `expected_closing`.
   */
  net_shift_amount: number;

  // ── Sales + payment breakdown (from summary) ──
  invoice_count: number;
  total_sales: number;
  total_collections: number;
  cash_total: number;
  non_cash_total: number;

  // ── Outgoing breakdown (matches single-shift card sections) ──
  total_operating_expenses: number;
  /** Sum of employee advances + employee settlements (cash leaving for employees). */
  total_employee_cash_out: number;
  /** Total cash out: operating + employee + supplier + other + refund_cash_out. */
  total_cash_out: number;
  /** Returns sourced from the legacy returns table (joined via invoices). */
  total_returns: number;
  /** Refund cash out sourced from cashbox_transactions (PR-21 semantics). */
  total_refund_cash_out: number;
}

export interface AggregateHeader {
  date_range: { from: string | null; to: string | null };
  shift_count: number;
  shifts: AggregateHeaderShift[];
  cashiers: Array<{ user_id: string; full_name: string | null }>;
  cashboxes: Array<{ cashbox_id: string; name_ar: string | null }>;
  selection_mode: 'explicit' | 'filters';
  generated_by: { user_id: string; full_name: string | null };
  /** Server-supplied ISO8601. */
  generated_at: string;
}

export interface AggregateTotals {
  opening_balance: number;
  total_sales: number;
  invoice_count: number;
  cancelled_count: number;
  total_cancelled: number;
  remaining_receivable: number;
  cash_total: number;
  non_cash_total: number;
  grand_payment_total: number;
  customer_receipts: number;
  supplier_payments: number;
  other_cash_in: number;
  other_cash_out: number;
  total_returns: number;
  return_count: number;
  total_expenses: number;
  expense_count: number;
  total_operating_expenses: number;
  operating_expense_count: number;
  total_employee_advances: number;
  employee_advance_count: number;
  total_employee_settlements: number;
  employee_settlement_count: number;
  total_employee_cash_out: number;
  total_refund_cash_out: number;
  total_refund_cash_in: number;
  net_refund_cash_impact: number;
  cancelled_return_out_amount: number;
  cancelled_return_reversal_amount: number;
  cancelled_return_net: number;
  total_cash_in: number;
  total_cash_out: number;
  expected_closing: number;
  /** Sum across closed shifts only; null when no shift is closed. */
  actual_closing: number | null;
  variance: number | null;
  closed_shift_count: number;
  /**
   * "صافي إجمالي الورديات" — sum of (expected_closing − opening_balance)
   * across selected shifts. Daily net cash movement, EXCLUDING opening
   * balances. The aggregate expected closing balance is exposed
   * separately as `expected_closing`.
   */
  net_shift_amount: number;
}

/** Per-row shift context attached by the BE aggregator. */
export interface ShiftContext {
  shift_id: string;
  shift_no: string;
  /** YYYY-MM-DD (Cairo). */
  shift_date: string | null;
  cashier_name: string | null;
  cashbox_name: string | null;
  /** ISO8601 of the underlying source row (CT.created_at, expense.created_at, adjustment.adjusted_at, …). */
  original_movement_at: string | null;
}

export type AggregateExpenseRow = ShiftExpenseRow & ShiftContext;
export type AggregateEmployeeMovementRow = EmployeeCashMovement & ShiftContext;
export type AggregateRefundMovementRow = RefundCashMovement & ShiftContext;
export type AggregateAdjustmentRow = ShiftCountAdjustment & ShiftContext;

export interface AggregateCashboxMovementRow extends ShiftContext {
  /** Composite synthetic id from the BE: `${shift_id}:${category}`. */
  id: string;
  category:
    | 'customer_receipts'
    | 'supplier_payments'
    | 'other_cash_in'
    | 'other_cash_out';
  amount: number;
}

export interface AggregateDetailResponse {
  header: AggregateHeader;
  totals: AggregateTotals;
  sections: {
    operating_expenses: AggregateExpenseRow[];
    employee_cash_movements: AggregateEmployeeMovementRow[];
    cashbox_movements: AggregateCashboxMovementRow[];
    payment_breakdown: PaymentBreakdownMethod[];
    refund_cash_movements: AggregateRefundMovementRow[];
    closing_adjustments: AggregateAdjustmentRow[];
  };
}

export const shiftsApi = {
  list: (params?: {
    status?: string;
    user_id?: string;
    cashbox_id?: string;
    /** YYYY-MM-DD — Cairo-local. Matches shifts overlapping the window. */
    from?: string;
    to?: string;
  }) => unwrap<Shift[]>(api.get('/shifts', { params })),

  current: () => unwrap<Shift | null>(api.get('/shifts/current')),

  get: (id: string) => unwrap<Shift>(api.get(`/shifts/${id}`)),

  summary: (id: string) => unwrap<ShiftSummary>(api.get(`/shifts/${id}/summary`)),

  // PR-B1 — counted-cash adjustment workflow
  adjustCount: (id: string, body: { new_actual_closing: number; reason: string }) =>
    unwrap<{ shift: Shift; adjustment: ShiftCountAdjustment }>(
      api.post(`/shifts/${id}/adjust-count`, body),
    ),
  listAdjustments: (id: string) =>
    unwrap<ShiftCountAdjustment[]>(api.get(`/shifts/${id}/adjustments`)),

  // PR-FIX-SHIFTS-OPENING-BALANCE-ADJUST (migration 128) — opening
  // balance correction on an OPEN shift.  Permission-gated
  // (shifts.opening_balance.adjust).  Pure metadata + audit; no JE/
  // CT/SM, no FinancialEngine call.
  adjustOpeningBalance: (
    id: string,
    body: {
      new_opening_balance: number;
      reason: string;
      notes?: string;
    },
  ) =>
    unwrap<{ shift: Shift; adjustment: ShiftOpeningBalanceAdjustment }>(
      api.post(`/shifts/${id}/adjust-opening-balance`, body),
    ),
  listOpeningBalanceAdjustments: (id: string) =>
    unwrap<ShiftOpeningBalanceAdjustment[]>(
      api.get(`/shifts/${id}/opening-balance-adjustments`),
    ),

  open: (payload: OpenShiftPayload) =>
    unwrap<Shift>(api.post('/shifts/open', payload)),

  close: (
    id: string,
    payload: {
      actual_closing: number;
      notes?: string;
      denominations?: Record<string, number>;
    },
  ) =>
    unwrap<Shift & { summary?: ShiftSummary }>(
      api.post(`/shifts/${id}/close`, payload),
    ),

  requestClose: (
    id: string,
    payload: { actual_closing: number; notes?: string },
  ) =>
    unwrap<
      | { pending: true; shift: Shift; variance: number; expected_closing: number }
      | { pending: false; auto_closed: true; shift: Shift & { summary?: ShiftSummary } }
    >(api.post(`/shifts/${id}/request-close`, payload)),

  pendingCloses: () =>
    unwrap<Array<Shift & { requested_by_name?: string }>>(
      api.get('/shifts/pending-close'),
    ),

  approveClose: (id: string, payload: ApproveClosePayload = {}) =>
    unwrap<{ approved: true; shift: Shift }>(
      api.post(`/shifts/${id}/approve-close`, payload),
    ),

  rejectClose: (id: string, reason: string) =>
    unwrap<{ rejected: true; shift: Shift }>(
      api.post(`/shifts/${id}/reject-close`, { reason }),
    ),

  // PR-FIX-SHIFTS-PAGE-BULK-LIVE-VARIANCE
  // Lightweight bulk LIVE summary for the main Shifts list page.
  // Replaces the per-row `summary(id)` fan-out that exhausted the
  // Supavisor pooler. Body capped at 100 ids server-side; the
  // wrapper enforces the same cap client-side so a buggy caller
  // can't send a 500-shift payload that would 422 anyway.
  listLiveSummary: (shift_ids: string[]) =>
    unwrap<
      Array<{
        shift_id: string;
        expected_closing: number;
        actual_closing: number | null;
        variance: number | null;
        cash_total: number;
        non_cash_total: number;
        invoice_count: number;
        total_sales: number;
        total_collections: number;
      }>
    >(
      api.post('/shifts/reports/list-live-summary', {
        shift_ids: shift_ids.slice(0, 100),
      }),
    ),

  // PR-SHIFT-REPORTS-AGGREGATED-DETAIL-FE
  // Wrapper around POST /shifts/reports/aggregate-detail. Enforces the
  // contract documented on the BE side: explicit selection wins over
  // filters. Caller passes `shift_ids` (preferred when present and
  // non-empty) and/or `filters`; the wrapper drops `filters` from the
  // body when selection is present so the intent is unambiguous on
  // the wire. Never sends `generated_by`/`generated_at` — the server
  // sources both from the JWT user and the server clock.
  aggregateDetail: (req: AggregateDetailRequest) => {
    const useSelection = !!(req.shift_ids && req.shift_ids.length > 0);
    const body: AggregateDetailRequest = useSelection
      ? { shift_ids: req.shift_ids }
      : { filters: req.filters ?? {} };
    return unwrap<AggregateDetailResponse>(
      api.post('/shifts/reports/aggregate-detail', body),
    );
  },
};
