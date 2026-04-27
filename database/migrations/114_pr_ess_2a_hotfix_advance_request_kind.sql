-- ────────────────────────────────────────────────────────────────────
-- Migration 114 — PR-ESS-2A-HOTFIX-1
-- Add safe `advance_request` kind to employee_requests.
-- ────────────────────────────────────────────────────────────────────
--
-- Why this exists
-- ───────────────
-- PR-ESS-2A shipped /me/requests/advance using the existing CHECK-allowed
-- kind 'advance' on `employee_requests`. The pre-implementation audit
-- verified the CHECK constraint accepts that value but missed an
-- existing legacy trigger chain on the table:
--
--   employee_requests (UPDATE status='approved')
--   └── trg_mirror_advance_to_txn  → fn_mirror_advance_to_txn
--        └── INSERT INTO employee_transactions (type='advance', ...)
--             └── trg_employee_txn_post → fn_post_employee_txn
--                  └── set_config('app.engine_context','engine:payroll',true)
--                  └── INSERT INTO journal_entries  (DR 1123 / CR 1111)
--                  └── INSERT INTO journal_lines  × 2
--
-- The session-context bypass means the journal_entries guard from
-- migration 063 doesn't reject the write and `engine_bypass_alerts`
-- isn't tripped — so the auto-post is silent. Net effect when a
-- manager approves a self-service advance REQUEST: the employee's GL
-- balance immediately shows them owing the amount even though no cash
-- moved. PR-ESS-2A's contract was that approval is a status flip
-- only; the trigger violates that contract.
--
-- We don't want to delete the legacy trigger — it's still the
-- canonical path for any historical writers that POST to
-- `employee_requests` with kind='advance' (none in current code, but
-- preserving the side-effect keeps the audit story honest).
--
-- Fix: introduce a SEPARATE kind value `'advance_request'` that the
-- new self-service endpoint inserts. The trigger function literal-
-- matches `NEW.kind = 'advance'`, so it stays inert for the new value
-- and approval is a pure status flip — exactly as documented in
-- backend/src/employees/employees.service.ts:submitAdvanceRequest.
--
-- Idempotency
-- ───────────
-- The migration drops the old CHECK by name (DROP CONSTRAINT IF
-- EXISTS) and adds the new one with all five values. Re-running it on
-- a database that already has the wider constraint is a no-op (the
-- DROP IF EXISTS removes whichever variant is currently named
-- `employee_requests_kind_check`, then adds the same wider variant
-- back).
--
-- Self-validation
-- ───────────────
-- A DO block at the end asserts the constraint is present, the literal
-- 'advance_request' is allowed, and the legacy 'advance' is still
-- allowed. Any deviation raises an exception, failing the migration.
--
-- No data backfill (existing rows with kind='advance' stay as-is).
-- No trigger changes.
-- No row-level mutation.

ALTER TABLE public.employee_requests
  DROP CONSTRAINT IF EXISTS employee_requests_kind_check;

ALTER TABLE public.employee_requests
  ADD CONSTRAINT employee_requests_kind_check
  CHECK (
    (kind)::text = ANY (
      (ARRAY[
        'advance'::character varying,
        'advance_request'::character varying,
        'leave'::character varying,
        'overtime_extension'::character varying,
        'other'::character varying
      ])::text[]
    )
  );

-- Self-validation. Asserts:
--   1. The constraint exists with the expected name.
--   2. The literal 'advance_request' is accepted (a temp INSERT into a
--      throwaway clone would be too invasive — instead we evaluate the
--      check expression against a synthetic value via a SELECT).
--   3. The legacy 'advance' literal is still accepted.
DO $$
DECLARE
  v_check_def text;
BEGIN
  SELECT pg_get_constraintdef(con.oid)
    INTO v_check_def
    FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
   WHERE cls.relname = 'employee_requests'
     AND con.conname = 'employee_requests_kind_check';

  IF v_check_def IS NULL THEN
    RAISE EXCEPTION 'Migration 114 failed: employee_requests_kind_check not found';
  END IF;

  IF v_check_def NOT LIKE '%advance_request%' THEN
    RAISE EXCEPTION 'Migration 114 failed: advance_request literal missing from CHECK (got: %)', v_check_def;
  END IF;

  IF v_check_def NOT LIKE '%''advance''%' THEN
    RAISE EXCEPTION 'Migration 114 failed: legacy advance literal missing from CHECK (got: %)', v_check_def;
  END IF;

  IF v_check_def NOT LIKE '%''leave''%'
     OR v_check_def NOT LIKE '%overtime_extension%'
     OR v_check_def NOT LIKE '%''other''%' THEN
    RAISE EXCEPTION 'Migration 114 failed: a non-advance kind dropped from CHECK (got: %)', v_check_def;
  END IF;
END $$;
