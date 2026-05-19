-- Migration 141 — PR-FIX-SETTLEMENT-DEDUPE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Recording an employee settlement creates one `employee_settlements`
--   row plus a paired CT + JE through `engine.recordTransaction`. The
--   engine's `uq_je_idempotent_engine_ref` (migration 119) protects the
--   journal_entries write, but its key is a `uuid_generate_v5` derived
--   from `employee_settlements.id` — and that BIGSERIAL id is fresh on
--   every retry. So two double-clicks of the operator's "Save" button
--   produce two settlement rows with two distinct ids, two distinct
--   engine reference_ids, and consequently TWO cashbox movements +
--   TWO JE entries for the same logical payout. Live cash leaves the
--   drawer twice.
--
--   The static audit (PR-FIX-SHIFT-SHORTAGE-DEDUPE audit pass) flagged
--   this as gap #A (highest risk). At the time of this migration the
--   table has 22 rows and zero duplicates — this fix is preventive
--   only, intercepting future double-click / retry / network-replay
--   storms before they touch the cashbox.
--
-- Change
--
--   1. ADD COLUMN employee_settlements.client_token UUID (nullable).
--      The operator UI mints one UUID per "Save" submit; both the
--      original request and any retry within that submit carry the
--      same token.
--
--   2. CREATE UNIQUE INDEX uq_employee_settlements_client_token_live
--      ON employee_settlements (client_token) WHERE client_token IS
--      NOT NULL AND is_void = false. Partial so legacy rows
--      (token NULL) and voided rows stay unconstrained, and so the
--      index space stays bounded to the protected slice. Voided
--      excluded so an admin can void + re-create without colliding.
--
--   The companion backend change (employees.service.ts
--   recordSettlement):
--     * fast-path SELECT pre-check by client_token returns the
--       existing row immediately — no second INSERT, no second
--       engine.recordTransaction, no second CT / JE.
--     * race-safe INSERT … ON CONFLICT (client_token) WHERE … DO
--       NOTHING handles the rare concurrent retry that races past
--       the pre-check.
--
-- Idempotency
--
--   IF NOT EXISTS on the ALTER COLUMN and the CREATE INDEX — safe to
--   re-run. No data backfill; existing 22 rows keep client_token =
--   NULL (which the partial index ignores).
--
-- What this migration does NOT touch
--   * Any existing row — no UPDATE, no DELETE, no backfill.
--   * journal_entries / journal_lines / cashbox_transactions for
--     historical settlement pairs. Cleanup of any past double-postings
--     would be a separate reconciliation; today there are none on
--     live (22 rows, zero shared client_token by construction).
--   * recordSettlement behaviour for callers that don't send a
--     client_token. The internal attendance.payWage path orchestrates
--     two settlement calls server-side and stays unchanged — it inherits
--     the outer endpoint's HTTP Idempotency-Key (`/attendance/admin/pay-wage`).
--   * Any trigger on employee_settlements.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.employee_settlements
  ADD COLUMN IF NOT EXISTS client_token uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_employee_settlements_client_token_live
  ON public.employee_settlements (client_token)
  WHERE client_token IS NOT NULL
    AND is_void = false;

COMMENT ON COLUMN public.employee_settlements.client_token IS
  'PR-FIX-SETTLEMENT-DEDUPE: operator-supplied UUID per settlement
   form-submit. Retries / double-clicks reuse the same token so the
   partial unique index `uq_employee_settlements_client_token_live`
   deduplicates at the DB level. Optional — legacy callers
   (attendance.payWage internal orchestration, historical rows) leave
   it NULL.';

COMMENT ON INDEX public.uq_employee_settlements_client_token_live IS
  'PR-FIX-SETTLEMENT-DEDUPE: idempotency guard for employee
   settlements. Partial so it only constrains live (non-voided)
   rows that opted into the client_token contract. Predicate matches
   the ON CONFLICT clause used by employees.service.ts
   recordSettlement.';

COMMIT;
