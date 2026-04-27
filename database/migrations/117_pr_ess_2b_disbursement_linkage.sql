-- ────────────────────────────────────────────────────────────────────
-- Migration 117 — PR-ESS-2B
-- Disbursement linkage: link a posted advance daily-expense back to
-- the originating self-service `employee_requests` row, and add a
-- `disbursed` status so the employee's request card can flip from
-- "موافق عليه — بانتظار الصرف" to "تم الصرف" once the canonical
-- FinancialEngine.recordExpense path completes.
-- ────────────────────────────────────────────────────────────────────
--
-- Why this exists
-- ───────────────
-- After PR-ESS-2A-HOTFIX-1 (migration 114) introduced the safe
-- `kind='advance_request'` value, employees can submit advance
-- requests via /me and managers can approve them — but approval is a
-- pure status flip with no money movement. The actual disbursement
-- has to happen via the canonical Daily Expenses path
-- (`POST /accounting/expenses/daily` with `is_advance=true`), which
-- routes through FinancialEngineService.recordExpense (the only
-- place that writes both the GL pair AND a cashbox_transactions row
-- atomically).
--
-- Until now there was no way to tell, after the fact, whether an
-- approved advance request had actually been disbursed. This
-- migration closes that loop:
--
--   · `expenses.source_employee_request_id` (BIGINT NULL, FK to
--     employee_requests.id ON DELETE SET NULL) — when the operator
--     posts an advance daily expense AND specifies which request it
--     pays out, the linkage is preserved on the expense row.
--
--   · `employee_requests.status` CHECK widened to include 'disbursed'
--     so the backend service can flip an approved request to that
--     terminal state immediately AFTER the engine successfully posts
--     the linked expense (inside the same DB transaction). If the
--     engine fails the whole transaction rolls back and the request
--     stays 'approved'.
--
-- This migration is **schema-only**. It does NOT post journal
-- entries, does NOT touch cashbox_transactions, does NOT define new
-- triggers, and does NOT auto-disburse any existing approved
-- requests. Disbursement remains an operator-driven action through
-- the canonical Daily Expense flow.
--
-- Type note
-- ─────────
-- `employee_requests.id` is `bigint` (verified live: column type
-- bigint, default nextval(employee_requests_id_seq)). The new FK
-- column on `expenses` is therefore `BIGINT` — NOT UUID. An earlier
-- draft of this migration used UUID and would have failed the FK
-- constraint at apply time.
--
-- Idempotency
-- ───────────
-- Every DDL statement uses `IF NOT EXISTS` / `DROP CONSTRAINT IF
-- EXISTS` so re-running on a database that already has the column,
-- the FK, the index, or the widened CHECK is a no-op. The CHECK
-- constraint is rebuilt by name (only the named constraint is
-- dropped — unrelated CHECK constraints on `employee_requests`,
-- e.g. `employee_requests_kind_check`, are NOT touched).
--
-- Self-validation
-- ───────────────
-- A DO block at the end asserts:
--   1. `expenses.source_employee_request_id` exists as BIGINT NULL
--   2. FK `fk_expenses_source_employee_request` exists with the
--      expected target table + column + ON DELETE SET NULL action
--   3. Partial index `ix_expenses_source_employee_request_id` exists
--      on the new column with the expected predicate
--   4. `employee_requests_status_check` accepts each of:
--      'pending', 'approved', 'rejected', 'cancelled', 'disbursed'
--   5. (Defensive) Every existing row in `employee_requests` still
--      has a status value that the rebuilt constraint accepts (i.e.
--      the rebuild can't have orphaned rows).

-- Step 0 — engine context (same as migrations 114 / 116 — `migration:*`
-- is the silent-bypass key the GL guard accepts).
SELECT set_config('app.engine_context', 'migration:pr_ess_2b', true);

-- ── Step 1: expenses.source_employee_request_id (BIGINT NULL) ──────
ALTER TABLE public.expenses
  ADD COLUMN IF NOT EXISTS source_employee_request_id BIGINT NULL;

-- ── Step 2: FK, ON DELETE SET NULL ─────────────────────────────────
-- DROP-IF-EXISTS + ADD pattern keeps the migration idempotent even
-- if a previous partial run left the constraint in place.
ALTER TABLE public.expenses
  DROP CONSTRAINT IF EXISTS fk_expenses_source_employee_request;

ALTER TABLE public.expenses
  ADD CONSTRAINT fk_expenses_source_employee_request
  FOREIGN KEY (source_employee_request_id)
  REFERENCES public.employee_requests (id)
  ON DELETE SET NULL;

-- ── Step 3: partial index — only rows with a linkage ──────────────
CREATE INDEX IF NOT EXISTS ix_expenses_source_employee_request_id
  ON public.expenses (source_employee_request_id)
  WHERE source_employee_request_id IS NOT NULL;

-- ── Step 4: widen employee_requests.status CHECK ──────────────────
-- We drop ONLY the named status CHECK and re-add it with the
-- enlarged set. The kind CHECK (added in migration 114) is
-- intentionally untouched.
ALTER TABLE public.employee_requests
  DROP CONSTRAINT IF EXISTS employee_requests_status_check;

ALTER TABLE public.employee_requests
  ADD CONSTRAINT employee_requests_status_check
  CHECK (
    (status)::text = ANY (
      (ARRAY[
        'pending'::character varying,
        'approved'::character varying,
        'rejected'::character varying,
        'cancelled'::character varying,
        'disbursed'::character varying
      ])::text[]
    )
  );

-- ────────────────────────────────────────────────────────────────────
-- Self-validation
-- ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_col_type      text;
  v_col_nullable  text;

  v_fk_exists     boolean;
  v_fk_target     text;
  v_fk_action     text;

  v_index_def     text;

  v_status_def    text;

  v_orphan_count  bigint;
BEGIN
  -- 1) Column exists, BIGINT, NULL.
  SELECT data_type, is_nullable
    INTO v_col_type, v_col_nullable
  FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name='expenses'
    AND column_name='source_employee_request_id';

  IF v_col_type IS NULL THEN
    RAISE EXCEPTION 'self-validation 1 failed: expenses.source_employee_request_id not found';
  END IF;
  IF v_col_type <> 'bigint' THEN
    RAISE EXCEPTION 'self-validation 1 failed: expenses.source_employee_request_id is % (expected bigint)', v_col_type;
  END IF;
  IF v_col_nullable <> 'YES' THEN
    RAISE EXCEPTION 'self-validation 1 failed: expenses.source_employee_request_id is NOT NULL (expected NULL)';
  END IF;

  -- 2) FK exists with expected target + action.
  SELECT
    TRUE,
    pg_get_constraintdef(con.oid)
  INTO v_fk_exists, v_fk_action
  FROM pg_constraint con
  JOIN pg_class cls ON cls.oid = con.conrelid
  WHERE cls.relname = 'expenses'
    AND con.conname = 'fk_expenses_source_employee_request'
    AND con.contype = 'f';

  IF NOT COALESCE(v_fk_exists, FALSE) THEN
    RAISE EXCEPTION 'self-validation 2 failed: FK fk_expenses_source_employee_request not found';
  END IF;
  IF v_fk_action NOT LIKE '%REFERENCES employee_requests(id)%' THEN
    RAISE EXCEPTION 'self-validation 2 failed: FK target mismatch (got: %)', v_fk_action;
  END IF;
  IF v_fk_action NOT LIKE '%ON DELETE SET NULL%' THEN
    RAISE EXCEPTION 'self-validation 2 failed: FK ON DELETE action is not SET NULL (got: %)', v_fk_action;
  END IF;

  -- 3) Partial index exists with expected predicate.
  SELECT indexdef INTO v_index_def
  FROM pg_indexes
  WHERE schemaname='public'
    AND tablename='expenses'
    AND indexname='ix_expenses_source_employee_request_id';

  IF v_index_def IS NULL THEN
    RAISE EXCEPTION 'self-validation 3 failed: index ix_expenses_source_employee_request_id not found';
  END IF;
  IF v_index_def NOT LIKE '%source_employee_request_id IS NOT NULL%' THEN
    RAISE EXCEPTION 'self-validation 3 failed: index is not partial on (... IS NOT NULL) (got: %)', v_index_def;
  END IF;

  -- 4) status CHECK accepts every required value.
  SELECT pg_get_constraintdef(con.oid) INTO v_status_def
  FROM pg_constraint con
  JOIN pg_class cls ON cls.oid = con.conrelid
  WHERE cls.relname = 'employee_requests'
    AND con.conname = 'employee_requests_status_check';

  IF v_status_def IS NULL THEN
    RAISE EXCEPTION 'self-validation 4 failed: employee_requests_status_check not found';
  END IF;
  IF v_status_def NOT LIKE '%''pending''%'
     OR v_status_def NOT LIKE '%''approved''%'
     OR v_status_def NOT LIKE '%''rejected''%'
     OR v_status_def NOT LIKE '%''cancelled''%'
     OR v_status_def NOT LIKE '%''disbursed''%' THEN
    RAISE EXCEPTION 'self-validation 4 failed: status CHECK missing one or more required values (got: %)', v_status_def;
  END IF;

  -- 5) No existing row violates the rebuilt constraint.
  --    (Postgres validates the constraint when ADD CONSTRAINT runs,
  --    so reaching this point already means the universe was clean.
  --    This is a belt-and-braces check that catches truly catastrophic
  --    edge cases like a constraint that was added with NOT VALID.)
  SELECT COUNT(*) INTO v_orphan_count
  FROM employee_requests
  WHERE status NOT IN ('pending','approved','rejected','cancelled','disbursed');

  IF v_orphan_count > 0 THEN
    RAISE EXCEPTION 'self-validation 5 failed: % employee_requests rows have status outside the new allowed set', v_orphan_count;
  END IF;

  RAISE NOTICE 'PR-ESS-2B self-validation passed (5/5 invariants).';
  RAISE NOTICE '  expenses.source_employee_request_id: BIGINT NULL ✓';
  RAISE NOTICE '  FK fk_expenses_source_employee_request: ON DELETE SET NULL ✓';
  RAISE NOTICE '  Partial index ix_expenses_source_employee_request_id ✓';
  RAISE NOTICE '  status CHECK now accepts: pending / approved / rejected / cancelled / disbursed ✓';
  RAISE NOTICE '  No existing employee_requests row violates the new CHECK ✓';
END $$;
