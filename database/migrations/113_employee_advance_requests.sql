-- Migration 113 — Employee-facing salary-advance request workflow.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   The Employee Self-Service Portal (ESS) needs an in-app way for an
--   employee to *request* a salary advance. The existing kind='advance'
--   on employee_requests is intentionally fenced off from the self-
--   service controller (see employees.controller.ts RequestDto, audit
--   #4): on approval the trigger fn_mirror_advance_to_txn writes
--   employee_transactions → journal_lines, while a separate human-driven
--   POST /accounting/expenses (is_advance=true) call also moves cash via
--   FinancialEngineService. The two paths together silently double-post
--   the GL and drift the cashbox, which is what audit #4 fixed by
--   removing 'advance' from the self-service DTO.
--
--   The user-facing request UX still has to exist — employees need a
--   way to ask. The clean separation is:
--
--     · Employee submits a *request* (informational, no money moves).
--     · Manager approves the request (still no money moves).
--     · HR / Finance later posts the actual disbursement through the
--       canonical POST /accounting/expenses (is_advance=true) flow,
--       which routes through FinancialEngineService and updates both GL
--       and cashbox atomically. The expense row links back to the
--       originating request via expenses.source_employee_request_id, so
--       the request UI can show "processed → expense #1234".
--
--   Net effect: one money-moving path (FinancialEngineService via
--   expenses) remains the single source of truth. The new request kind
--   never reaches the existing fn_mirror_advance_to_txn trigger because
--   that trigger guards `IF NEW.kind = 'advance'`, and the new kind is
--   spelled 'advance_request' (distinct from the legacy 'advance').
--
-- What this migration adds
--
--   1. ALTER TABLE employee_requests — extend the `kind` CHECK constraint
--      to allow 'advance_request' alongside the existing values.
--   2. ALTER TABLE expenses ADD COLUMN source_employee_request_id BIGINT
--      (nullable) REFERENCES employee_requests(id). Lets HR's expense
--      record point back to the approved request that prompted it.
--   3. INSERT a new permission code `employee.advance.request` so the
--      action can be granted independently of the broader
--      `employee.requests.submit`. (employee.requests.submit grants leave
--      / overtime / other only — keeps the advance request gate explicit
--      so per-employee opt-in is possible.)
--
-- Strict scope (preserves audit #4 invariants)
--
--   · NO new tables. NO new triggers. NO trigger changes.
--   · NO touch on the existing fn_mirror_advance_to_txn function.
--     Verified that trigger fires only for kind='advance'; the new
--     'advance_request' kind is a no-op for it.
--   · NO automatic posting on approval — decideRequest just flips
--     status. Money still moves only through POST /accounting/expenses.
--   · Backward-compatible: existing rows untouched, source_employee_
--     request_id is nullable and stays NULL on every historical expense.
--
-- Idempotent
--
--   Marker: existence of 'advance_request' inside the kind CHECK
--   constraint definition. Re-runs are safe — ALTER COLUMN drops &
--   re-adds the CHECK; ADD COLUMN uses IF NOT EXISTS; INSERT uses
--   ON CONFLICT DO NOTHING.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:113_emp_advance_request',
  true
);

-- ─── 1) employee_requests.kind — allow 'advance_request' ────────────────
-- We need to drop the existing CHECK constraint and add a wider one.
-- The original (migration 040, line 68-69) was unnamed so Postgres
-- assigned an auto-generated name we can't hard-code.
--
-- Match precisely instead of broadly:
--   · scope by table  (conrelid = employee_requests)
--   · scope by kind=c (CHECK constraint)
--   · scope by column (constraint references the `kind` column ONLY)
--   · scope by definition shape — must be a kind IN (...) check that
--     contains every existing legacy value AND no other column refs
--
-- Multiple safety filters mean an unrelated future CHECK that just
-- happens to mention the word "kind" cannot be dropped by accident.
DO $$
DECLARE
  v_conname text;
  v_kind_attnum smallint;
BEGIN
  -- Resolve attnum for the kind column once; lets us match only
  -- constraints that reference exactly this column (conkey = {attnum}).
  SELECT attnum INTO v_kind_attnum
    FROM pg_attribute
   WHERE attrelid = 'public.employee_requests'::regclass
     AND attname  = 'kind'
     AND NOT attisdropped;

  IF v_kind_attnum IS NULL THEN
    RAISE EXCEPTION '113: employee_requests.kind column not found';
  END IF;

  SELECT conname INTO v_conname
    FROM pg_constraint
   WHERE conrelid = 'public.employee_requests'::regclass
     AND contype  = 'c'
     -- Exactly one referenced column == kind
     AND conkey   = ARRAY[v_kind_attnum]::int2[]
     -- IN-list shape: must contain every legacy value (so we know it's
     -- the kind enumeration, not some unrelated check on the same col)
     AND pg_get_constraintdef(oid) LIKE '%''advance''%'
     AND pg_get_constraintdef(oid) LIKE '%''leave''%'
     AND pg_get_constraintdef(oid) LIKE '%''overtime_extension''%'
     AND pg_get_constraintdef(oid) LIKE '%''other''%'
     -- Skip if it already covers advance_request — that's our new
     -- constraint from a previous run of this migration; leave it
     -- alone and rely on the ADD CONSTRAINT IF NOT EXISTS-equivalent
     -- below (we guard add separately).
     AND pg_get_constraintdef(oid) NOT LIKE '%''advance_request''%';
  IF v_conname IS NOT NULL THEN
    EXECUTE format('ALTER TABLE employee_requests DROP CONSTRAINT %I', v_conname);
  END IF;
END $$;

-- Idempotent ADD: drop our own named constraint if it exists from a
-- prior run, then create it fresh. Postgres has no
-- ADD CONSTRAINT IF NOT EXISTS for CHECK, so we handle it manually.
ALTER TABLE employee_requests
  DROP CONSTRAINT IF EXISTS employee_requests_kind_check;
ALTER TABLE employee_requests
  ADD CONSTRAINT employee_requests_kind_check
  CHECK (kind IN ('advance','advance_request','leave','overtime_extension','other'));

COMMENT ON CONSTRAINT employee_requests_kind_check ON employee_requests IS
  'Migration 113: extends kind to include advance_request — the employee-'
  'facing salary-advance request that has no GL/cashbox impact on approval. '
  'The legacy ''advance'' value is preserved for historical rows and the '
  'fn_mirror_advance_to_txn trigger which still guards on kind=''advance''.';

-- ─── 2) expenses.source_employee_request_id — link disbursement back ────
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS source_employee_request_id BIGINT
    REFERENCES employee_requests(id);

CREATE INDEX IF NOT EXISTS ix_expenses_source_emp_request
  ON expenses(source_employee_request_id)
  WHERE source_employee_request_id IS NOT NULL;

COMMENT ON COLUMN expenses.source_employee_request_id IS
  'Migration 113: optional FK back to the employee_requests row that '
  'prompted this expense. Set when HR posts a salary-advance disbursement '
  '(is_advance=true) that fulfills an approved advance_request. Lets the '
  'request inbox show "processed → expense #N" without dual-write.';

-- ─── 3) Seed the new permission code ────────────────────────────────────
-- Permissions table schema (migration 002): code (PK), module, name_ar,
-- name_en, description.
INSERT INTO permissions (code, module, name_ar, name_en, description)
VALUES (
  'employee.advance.request',
  'employee',
  'تقديم طلب سلفة',
  'Request salary advance',
  'Allows the employee to submit a salary-advance request from the self-service portal. '
  'Approval has NO financial impact — money moves later via POST /accounting/expenses (is_advance=true).'
)
ON CONFLICT (code) DO NOTHING;

-- Grant the new permission to any role that already holds
-- employee.requests.submit, so existing employees inherit the ability
-- to ask for an advance without manual per-role re-grants.
-- role_permissions joins on permission_id (UUID), not the code.
INSERT INTO role_permissions (role_id, permission_id)
SELECT rp.role_id, p_new.id
  FROM role_permissions rp
  JOIN permissions p_old ON p_old.id = rp.permission_id
                        AND p_old.code = 'employee.requests.submit'
  CROSS JOIN LATERAL (
    SELECT id FROM permissions WHERE code = 'employee.advance.request'
  ) p_new
ON CONFLICT DO NOTHING;

-- ─── 4) Self-validating contract ────────────────────────────────────────
DO $$
DECLARE
  v_kind_ok    boolean;
  v_col_exists boolean;
  v_perm_ok    boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'public.employee_requests'::regclass
       AND c.contype  = 'c'
       AND pg_get_constraintdef(c.oid) ILIKE '%advance_request%'
  ) INTO v_kind_ok;
  IF NOT v_kind_ok THEN
    RAISE EXCEPTION '113 post: employee_requests.kind CHECK does not include advance_request';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='expenses'
       AND column_name='source_employee_request_id'
  ) INTO v_col_exists;
  IF NOT v_col_exists THEN
    RAISE EXCEPTION '113 post: expenses.source_employee_request_id missing';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM permissions WHERE code = 'employee.advance.request'
  ) INTO v_perm_ok;
  IF NOT v_perm_ok THEN
    RAISE EXCEPTION '113 post: permission employee.advance.request not seeded';
  END IF;

  RAISE NOTICE '113 post OK: advance_request kind allowed, expenses.source_employee_request_id present, permission seeded';
END $$;

COMMIT;
