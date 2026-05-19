/**
 * settlement-client-token.ts — PR-FIX-SETTLEMENT-DEDUPE (FE)
 *
 * Per-submit `client_token` UUID for POST /employees/:id/settlements.
 * Sibling of `advance-client-token.ts` — same lifecycle semantics
 * (UUID minted once on the FIRST `ensure()` of a submit attempt,
 * stable across retries / double-clicks of THAT attempt, reset by
 * the mutation's `onSuccess` / `onError`), different BE table:
 *
 *   · BE column: `employee_settlements.client_token uuid`
 *   · BE guard:  partial unique index
 *                `uq_employee_settlements_client_token_live`
 *                (migration 141)
 *   · BE service: employees.service.ts `recordSettlement`
 *
 * Implementation reuses the generic UUID + useRef hook from
 * `advance-client-token` — re-exported under settlement names so
 * the import at the call site reads cleanly and so the two flows
 * (advance disbursement vs. employee settlement) own distinct
 * conceptual lifecycles even though they share the same primitive.
 */
export {
  mintAdvanceClientToken as mintSettlementClientToken,
  useAdvanceClientToken as useSettlementClientToken,
  type AdvanceClientTokenHandle as SettlementClientTokenHandle,
} from './advance-client-token';
