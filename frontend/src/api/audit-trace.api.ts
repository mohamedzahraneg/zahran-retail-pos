/**
 * audit-trace.api.ts — read-only client for
 * `GET /audit/financial-movements/trace`.
 *
 * Single GET endpoint. NEVER mutates. Returns a structured trace of a
 * single financial movement (source + journal entries + journal lines
 * + cashbox transactions + stock movements + diagnostic flags +
 * summary).
 *
 * Permission gate: `audit.view` (handled at the BE controller level
 * via `@Permissions('audit.view')`).
 */
import { api, unwrap } from './client';

export type TraceReferenceType =
  | 'invoice'
  | 'return'
  | 'purchase'
  | 'expense'
  | 'shift'
  | 'customer_payment'
  | 'supplier_payment'
  | 'journal_entry';

export interface TraceSourceRow {
  type: TraceReferenceType;
  id: string;
  number: string | null;
  date: string | null;
  user_id: string | null;
  user_name: string | null;
  customer_id?: string | null;
  customer_name?: string | null;
  supplier_id?: string | null;
  supplier_name?: string | null;
  total: string | null;
  paid: string | null;
  status: string | null;
  warehouse_id?: string | null;
  cashbox_id?: string | null;
  notes?: string | null;
}

export interface TraceJournalEntry {
  id: string;
  entry_no: string;
  entry_date: string;
  description: string | null;
  reference_type: string | null;
  reference_id: string | null;
  is_posted: boolean;
  is_void: boolean;
  void_reason: string | null;
  reversal_of: string | null;
  posted_by_name: string | null;
  voided_by_name: string | null;
  total_debit: string;
  total_credit: string;
  is_balanced: boolean;
}

export interface TraceJournalLine {
  id: string;
  entry_id: string;
  line_no: number;
  account_id: string;
  account_code: string | null;
  account_name: string | null;
  debit: string;
  credit: string;
  description: string | null;
  cashbox_id: string | null;
  cashbox_name_ar: string | null;
  warehouse_id: string | null;
}

export interface TraceCashboxTxn {
  id: number;
  cashbox_id: string;
  cashbox_name_ar: string | null;
  direction: 'in' | 'out';
  amount: string;
  category: string;
  reference_type: string | null;
  reference_id: string | null;
  balance_after: string;
  notes: string | null;
  user_id: string | null;
  user_name: string | null;
  created_at: string;
}

export interface TraceStockMovement {
  id: number;
  variant_id: string;
  variant_sku: string | null;
  product_name_ar: string | null;
  warehouse_id: string;
  warehouse_name_ar: string | null;
  movement_type: string;
  direction: 'in' | 'out';
  quantity: number;
  unit_cost: string;
  reference_type: string | null;
  reference_id: string | null;
  notes: string | null;
  user_id: string | null;
  user_name: string | null;
  created_at: string;
}

export type TraceFlagSeverity = 'info' | 'warning' | 'error';
export interface TraceFlag {
  code: string;
  severity: TraceFlagSeverity;
  message_ar: string;
}

export interface TraceSummary {
  hasJournal: boolean;
  hasCashboxTransaction: boolean;
  hasStockMovement: boolean;
  journalBalanced: boolean | null;
  cashMatched: boolean | null;
  stockMatched: boolean | null;
  source_total: string | null;
  journal_cash_total: string | null;
  cashbox_signed_total: string | null;
}

export interface TraceResult {
  source: TraceSourceRow | null;
  journalEntries: TraceJournalEntry[];
  journalLines: TraceJournalLine[];
  cashboxTransactions: TraceCashboxTxn[];
  stockMovements: TraceStockMovement[];
  idempotency: Array<{ key: string; note_ar: string }>;
  flags: TraceFlag[];
  summary: TraceSummary;
}

export interface TraceParams {
  reference_type?: TraceReferenceType | '';
  reference_id?: string;
  q?: string;
  idempotency_key?: string;
}

export const auditTraceApi = {
  /**
   * Fire a read-only trace query. The endpoint is GET so axios won't
   * trigger any of the mutation-side interceptors (idempotency-key
   * helpers gate on POST/PATCH/DELETE methods only).
   */
  trace: (params: TraceParams) =>
    unwrap<TraceResult>(
      api.get('/audit/financial-movements/trace', {
        params: {
          reference_type: params.reference_type || undefined,
          reference_id: params.reference_id || undefined,
          q: params.q || undefined,
          idempotency_key: params.idempotency_key || undefined,
        },
      }),
    ),
};
