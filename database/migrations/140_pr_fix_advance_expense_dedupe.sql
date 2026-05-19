-- Migration 140 — PR-FIX-ADVANCE-EXPENSE-DEDUPE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Recording an employee advance creates one `expenses` row plus a paired
--   CT + JE through `engine.recordExpense` (DR 1123 Employee Receivable /
--   CR cashbox). When the operator double-clicks "Save", or the HTTP
--   request retries, the operation can produce TWO advance rows for the
--   same cash payout — doubling the cashbox debit and the employee
--   receivable.
--
--   The existing `source_employee_request_id` linkage (migration 117)
--   already guards the path where the disbursement is tied to an
--   approved self-service request — its partial unique index catches
--   the second attempt. But the legacy path (category-code → employee_no
--   auto-match) and any free-form advance entered without linking a
--   request remain unprotected.
--
-- Change
--
--   1. ADD COLUMN expenses.client_token UUID (nullable). The operator
--      UI generates one UUID per disbursement form-submit; both the
--      first request and any retry carry the same token.
--
--   2. CREATE UNIQUE INDEX uq_expenses_advance_client_token_live ON
--      expenses (client_token) WHERE is_advance = true AND
--      client_token IS NOT NULL — partial so legacy advance rows (token
--      NULL) and non-advance expenses (is_advance = false) stay
--      unconstrained, and so the index space stays bounded to the
--      protected slice.
--
--   The companion backend change (accounting.service.ts createExpense):
--     * fast-path SELECT pre-check by client_token returns the existing
--       row immediately — no second INSERT, no second engine call.
--     * race-safe INSERT … ON CONFLICT (client_token) WHERE … DO NOTHING
--       handles the rare concurrent retry that races past the pre-check.
--
-- Idempotency
--
--   IF NOT EXISTS on the ALTER COLUMN and the CREATE INDEX — safe to
--   re-run. No data backfill; existing rows keep client_token = NULL
--   (which the partial index ignores).
--
-- What this migration does NOT touch
--   * Any existing row — no UPDATE, no DELETE, no backfill.
--   * No JE / CT / cashbox balance change for historical advance pairs.
--     Cleanup of any past double-postings is a separate reconciliation.
--   * No change to source_employee_request_id semantics. The two
--     idempotency surfaces (linked-request + client_token) coexist —
--     a caller may supply either, both, or neither.
--   * No trigger added on expenses.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS client_token uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_expenses_advance_client_token_live
  ON public.expenses (client_token)
  WHERE is_advance = true
    AND client_token IS NOT NULL;

COMMENT ON COLUMN public.expenses.client_token IS
  'PR-FIX-ADVANCE-EXPENSE-DEDUPE: operator-supplied UUID per advance
   disbursement form-submit. Retries / double-clicks reuse the same
   token so the partial unique index
   `uq_expenses_advance_client_token_live` deduplicates at the DB
   level. Optional — legacy advances and non-advance expenses leave
   it NULL.';

COMMENT ON INDEX public.uq_expenses_advance_client_token_live IS
  'PR-FIX-ADVANCE-EXPENSE-DEDUPE: idempotency guard for advance
   disbursements. Partial so it only constrains live advance rows
   that opted into the client_token contract. Predicate matches the
   ON CONFLICT clause used by accounting.service.ts createExpense.';

COMMIT;
