/**
 * statements.types.ts — PR-FIN-3
 * ────────────────────────────────────────────────────────────────────
 *
 * Unified read-only response shape for the seven statement types
 * exposed under /finance/statements/*. The frontend renders all 7
 * tabs from this single contract; each statement carries its
 * opening / debit / credit / running / closing semantics derived
 * from the same fields regardless of the underlying source.
 *
 * Sources (all read-only, no writes anywhere):
 *   · gl-account  → journal_entries × journal_lines filtered by account
 *   · cashbox     → v_cashbox_movements (cash / bank / wallet — same view)
 *   · employee    → v_employee_ledger
 *   · customer    → customer_ledger
 *   · supplier    → supplier_ledger
 *
 * The `confidence` block lets the UI render an honest empty state
 * when the underlying sub-ledger is genuinely unpopulated (e.g.
 * customer_ledger is empty even though invoices exist).
 */

export type StatementType =
  | 'gl_account'
  | 'cashbox'
  | 'employee'
  | 'customer'
  | 'supplier';

export interface StatementFilters {
  from?: string; // YYYY-MM-DD
  to?: string;   // YYYY-MM-DD
  /** Cashbox only: restrict to in-only / out-only movements. */
  direction?: 'in' | 'out';
  /** GL only: include voided JE rows (rendered struck-through). Default false. */
  include_voided?: boolean;
}

export interface StatementRow {
  occurred_at: string;            // ISO timestamp
  event_date: string;             // YYYY-MM-DD (Cairo)
  description: string;
  reference_type: string | null;
  reference_no: string | null;    // INV-… / EXP-… / JE-…
  debit: number;
  credit: number;
  running_balance: number;
  counterparty: string | null;
  journal_entry_no: string | null;
  /**
   * PR-FIN-3 — drilldown links are stubbed null until PR-FIN-4
   * ships the audit-trail page that consumes them.
   */
  drilldown_url: string | null;
  /** True when the underlying record is voided (struck-through). */
  is_voided: boolean;
}

export interface StatementResponse {
  entity: {
    type: StatementType;
    id: string;
    code: string | null;
    name_ar: string;
    name_en: string | null;
    extra: Record<string, string | number | boolean | null> | null;
  };
  range: { from: string; to: string };
  opening_balance: number;
  closing_balance: number;
  totals: {
    debit: number;
    credit: number;
    net: number;
    lines: number;
  };
  rows: StatementRow[];
  confidence: {
    has_data: boolean;
    /** Which underlying source produced the rows. */
    data_source:
      | 'gl_lines'
      | 'cashbox_view'
      | 'employee_view'
      | 'customer_ledger'
      | 'supplier_ledger';
    /** Free-text Arabic note for the UI footer. Null when rows are present. */
    note: string | null;
    /**
     * Optional context numbers the UI can interpolate into the empty-state
     * note (e.g. "X من أصل Y فاتورة في الفترة غير مرتبطة بعميل"). Counts
     * come from the actual DB at request time — never hardcoded.
     */
    context: Record<string, number> | null;
  };
  generated_at: string;
}
