/**
 * statements.api.ts — PR-FIN-3
 *
 * Typed client for the five statement endpoints under
 * /finance/statements/*. Each endpoint returns the unified
 * `StatementResponse` shape; the page renders all 7 tabs
 * (cash / bank / wallet share the cashbox endpoint).
 */

import { api, unwrap } from './client';

export type StatementType =
  | 'gl_account'
  | 'cashbox'
  | 'employee'
  | 'customer'
  | 'supplier';

export interface StatementRow {
  occurred_at: string;
  event_date: string;
  description: string;
  reference_type: string | null;
  reference_no: string | null;
  debit: number;
  credit: number;
  running_balance: number;
  counterparty: string | null;
  journal_entry_no: string | null;
  drilldown_url: string | null;
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
    data_source:
      | 'gl_lines'
      | 'cashbox_view'
      | 'employee_view'
      | 'customer_ledger'
      | 'supplier_ledger';
    note: string | null;
    context: Record<string, number> | null;
  };
  generated_at: string;
}

export interface StatementFilters {
  from?: string;
  to?: string;
  direction?: 'in' | 'out';
  include_voided?: boolean;
}

export const statementsApi = {
  glAccount: (accountId: string, f: StatementFilters = {}) =>
    unwrap<StatementResponse>(
      api.get(`/finance/statements/gl-account/${accountId}`, {
        params: {
          from: f.from,
          to: f.to,
          include_voided: f.include_voided ? 'true' : undefined,
        },
      }),
    ),

  cashbox: (cashboxId: string, f: StatementFilters = {}) =>
    unwrap<StatementResponse>(
      api.get(`/finance/statements/cashbox/${cashboxId}`, {
        params: { from: f.from, to: f.to, direction: f.direction },
      }),
    ),

  employee: (userId: string, f: StatementFilters = {}) =>
    unwrap<StatementResponse>(
      api.get(`/finance/statements/employee/${userId}`, {
        params: { from: f.from, to: f.to },
      }),
    ),

  customer: (customerId: string, f: StatementFilters = {}) =>
    unwrap<StatementResponse>(
      api.get(`/finance/statements/customer/${customerId}`, {
        params: { from: f.from, to: f.to },
      }),
    ),

  supplier: (supplierId: string, f: StatementFilters = {}) =>
    unwrap<StatementResponse>(
      api.get(`/finance/statements/supplier/${supplierId}`, {
        params: { from: f.from, to: f.to },
      }),
    ),
};
