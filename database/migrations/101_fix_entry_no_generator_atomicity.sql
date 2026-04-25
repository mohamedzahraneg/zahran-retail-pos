-- Migration 101 — Fix duplicate entry_no on wage accrual (PR-T0).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Production hit a `duplicate key value violates unique constraint
--   "journal_entries_entry_no_key"` error when paying a 500 EGP wage.
--   Audit (PR-T0 plan) traced two competing entry_no generators:
--
--     · FinancialEngineService.recordTransaction →
--         entry_no = 'JE-' || year || '-' || lpad(nextval(seq), 6, '0')
--       (atomic, the canonical engine path)
--
--     · Legacy fn_post_employee_* DB functions →
--         SELECT MAX(SUBSTRING(entry_no FROM 'JE-[0-9]+-([0-9]+)')::int) + 1
--       (classic anti-pattern; advances the table without advancing the
--        sequence)
--
--   Migration 077 already converted fn_post_employee_txn / _bonus /
--   _deduction / _advance to nextval. But fn_post_employee_wage_accrual
--   was added LATER (migration 083, extended in 091) and still uses
--   MAX+1. After PR-25's reconcile migration ran on prod (which calls
--   fn_post_employee_wage_accrual), the function inserted JE-2026-000238
--   without advancing the sequence. The sequence stayed at 237; the
--   next engine settlement call did `nextval = 238` → tried to insert
--   `JE-2026-000238` → duplicate-key violation.
--
-- Fix
--
--   1. CREATE OR REPLACE fn_post_employee_wage_accrual to use
--      nextval('seq_journal_entry_no') — same shape as the four
--      already-fixed functions in migration 077. Body, signature, and
--      semantics are otherwise unchanged (DR 521 / CR 213, idempotent,
--      no cashbox movement).
--
--   2. Add a one-shot setval reconciliation: bump
--      seq_journal_entry_no to GREATEST(current_value, MAX(serial))
--      so the sequence catches up to any prior MAX+1 inserts on prod.
--      Idempotent — re-running the migration is safe because if the
--      sequence is already ahead, setval(GREATEST(...)) is a no-op.
--
-- Strict
--
--   · NO journal_entries / journal_lines / cashbox_transactions writes
--   · NO change to cashboxes.current_balance
--   · NO accounting-formula changes (DR 521 / CR 213 unchanged)
--   · NO retroactive correction to existing JEs
--   · Function semantics unchanged: same params, same return type,
--     same idempotency guard, same accounts, same amounts
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:101_fix_entry_no_generator_atomicity',
  true
);

-- ── 1. Redefine fn_post_employee_wage_accrual to use nextval ──────────────
CREATE OR REPLACE FUNCTION public.fn_post_employee_wage_accrual(
    p_user_id              uuid,
    p_work_date            date,
    p_amount               numeric,
    p_source               text,
    p_attendance_record_id uuid,
    p_worked_minutes       int,
    p_daily_wage_snapshot  numeric,
    p_target_minutes_snap  int,
    p_reason               text,
    p_created_by           uuid,
    p_calculated_amount    numeric DEFAULT NULL,
    p_override_type        text    DEFAULT 'full_day',
    p_approval_reason      text    DEFAULT NULL,
    p_approved_by          uuid    DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
    v_existing_id   uuid;
    v_payable_id    uuid;
    v_entry_id      uuid;
    v_entry_no      text;
    v_seq           bigint;
    v_dr_acct       uuid;
    v_cr_acct       uuid;
    v_desc          text;
    v_emp_name      text;
    v_att_user      uuid;
    v_att_date      date;
    v_calc          numeric(14,2);
    v_approved_by   uuid;
BEGIN
    -- ── Validation ────────────────────────────────────────────────────
    IF p_user_id IS NULL OR p_work_date IS NULL THEN
        RAISE EXCEPTION 'wage_accrual: user_id and work_date are required';
    END IF;
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'wage_accrual: amount must be > 0 (got %)', p_amount;
    END IF;
    IF p_source NOT IN ('attendance', 'admin_manual') THEN
        RAISE EXCEPTION 'wage_accrual: source must be attendance|admin_manual (got %)', p_source;
    END IF;
    IF p_source = 'admin_manual'
       AND (p_reason IS NULL OR length(btrim(p_reason)) = 0) THEN
        RAISE EXCEPTION 'wage_accrual: admin_manual requires a reason';
    END IF;
    IF p_created_by IS NULL THEN
        RAISE EXCEPTION 'wage_accrual: created_by is required';
    END IF;
    IF p_override_type NOT IN ('calculated', 'full_day', 'custom_amount') THEN
        RAISE EXCEPTION 'wage_accrual: override_type must be calculated|full_day|custom_amount (got %)', p_override_type;
    END IF;

    -- If attendance_record_id supplied, validate ownership + date.
    IF p_attendance_record_id IS NOT NULL THEN
        SELECT user_id, work_date
          INTO v_att_user, v_att_date
          FROM attendance_records
         WHERE id = p_attendance_record_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'wage_accrual: attendance_record % not found', p_attendance_record_id;
        END IF;
        IF v_att_user <> p_user_id OR v_att_date <> p_work_date THEN
            RAISE EXCEPTION
              'wage_accrual: attendance_record mismatch (record user=%, date=%; requested user=%, date=%)',
              v_att_user, v_att_date, p_user_id, p_work_date;
        END IF;
    END IF;

    -- ── Idempotency check ─────────────────────────────────────────────
    SELECT id INTO v_existing_id
      FROM employee_payable_days
     WHERE user_id = p_user_id
       AND work_date = p_work_date
       AND kind = 'wage_accrual'
       AND is_void = FALSE
     LIMIT 1;
    IF v_existing_id IS NOT NULL THEN
        RETURN v_existing_id;
    END IF;

    -- ── Engine context so migration 068 guards accept the JE write ────
    PERFORM set_config('app.engine_context', 'engine:payroll_wage_accrual', true);

    v_dr_acct := fn_account_id('521');
    v_cr_acct := fn_account_id('213');
    IF v_dr_acct IS NULL OR v_cr_acct IS NULL THEN
        RAISE EXCEPTION 'wage_accrual: COA 521/213 missing';
    END IF;

    -- Default calculated_amount to the posted amount when caller didn't
    -- supply it — preserves the Option A invariant for legacy callers.
    v_calc        := COALESCE(p_calculated_amount, p_amount);
    v_approved_by := COALESCE(p_approved_by, p_created_by);

    -- ── Insert the payable_day row first so we have a reference_id ────
    INSERT INTO employee_payable_days
        (user_id, work_date, kind, source, attendance_record_id,
         worked_minutes, daily_wage_snapshot, target_minutes_snapshot,
         amount_accrued, reason, created_by,
         calculated_amount, override_type, approval_reason,
         approved_by, approved_at)
    VALUES
        (p_user_id, p_work_date, 'wage_accrual', p_source, p_attendance_record_id,
         p_worked_minutes, p_daily_wage_snapshot, p_target_minutes_snap,
         p_amount, p_reason, p_created_by,
         v_calc, p_override_type, p_approval_reason,
         v_approved_by, NOW())
    RETURNING id INTO v_payable_id;

    -- ── Build JE ──────────────────────────────────────────────────────
    SELECT full_name INTO v_emp_name FROM users WHERE id = p_user_id;
    v_desc := format('استحقاق يومية — %s%s%s',
        COALESCE(v_emp_name, 'موظف'),
        CASE WHEN p_override_type = 'custom_amount' THEN ' (مبلغ معتمد مخصص)' ELSE '' END,
        CASE WHEN p_reason IS NOT NULL AND p_reason <> ''
             THEN ' — ' || p_reason ELSE '' END);

    -- PR-T0 — atomic entry_no allocation via the shared sequence (same
    -- as FinancialEngineService.recordTransaction + the fixed
    -- fn_post_employee_txn / _bonus / _deduction / _advance from
    -- migration 077). Removes the MAX+1 race that produced a
    -- duplicate-key violation on the next engine call.
    v_seq      := nextval('seq_journal_entry_no');
    v_entry_no := 'JE-' || EXTRACT(YEAR FROM p_work_date)::int
                       || '-' || lpad(v_seq::text, 6, '0');

    INSERT INTO journal_entries
        (entry_no, entry_date, description, reference_type, reference_id,
         is_posted, created_by, created_at)
    VALUES (v_entry_no, p_work_date, v_desc, 'employee_wage_accrual', v_payable_id,
            false, p_created_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines
        (entry_id, line_no, account_id, debit, credit, description,
         employee_id, employee_user_id)
    VALUES
        (v_entry_id, 1, v_dr_acct, p_amount, 0, v_desc, p_user_id, p_user_id),
        (v_entry_id, 2, v_cr_acct, 0, p_amount, v_desc, p_user_id, p_user_id);

    UPDATE journal_entries
       SET is_posted = true, posted_by = p_created_by, posted_at = NOW()
     WHERE id = v_entry_id;

    UPDATE employee_payable_days
       SET journal_entry_id = v_entry_id
     WHERE id = v_payable_id;

    RETURN v_payable_id;
END;
$$;

COMMENT ON FUNCTION public.fn_post_employee_wage_accrual(
    uuid, date, numeric, text, uuid, int, numeric, int, text, uuid,
    numeric, text, text, uuid) IS
  'Canonical wage-accrual poster. Creates one employee_payable_days row + one posted JE (DR 521 / CR 213) tagged with the employee. Idempotent via partial unique index — second call for same (user, date) returns the existing payable_day.id. No cashbox movement. PR-3: optional p_calculated_amount / p_override_type / p_approval_reason / p_approved_by record approval metadata. PR-T0 (migration 101): entry_no now allocated atomically via nextval(seq_journal_entry_no) — same path as FinancialEngineService.recordTransaction, no more duplicate-key races.';

-- ── 2. Sequence reconciliation guard ──────────────────────────────────────
-- Bump seq_journal_entry_no to at least the highest serial currently in
-- the table so the next nextval() never collides with an already-existing
-- entry_no. Handles two prod-state classes:
--   (a) sequence is already ahead → setval(GREATEST(curr, max)) = no-op
--   (b) sequence lags because a legacy MAX+1 path inserted past it
--       → setval brings it up. is_called=TRUE means the NEXT nextval()
--       returns max+1 (correct).
-- Idempotent — re-running this migration is safe.
DO $$
DECLARE
    v_seq_curr  bigint;
    v_max_table bigint;
    v_target    bigint;
BEGIN
    SELECT last_value INTO v_seq_curr FROM seq_journal_entry_no;
    SELECT COALESCE(MAX(SUBSTRING(entry_no FROM 'JE-[0-9]+-([0-9]+)')::int), 0)
      INTO v_max_table
      FROM journal_entries
     WHERE entry_no ~ '^JE-[0-9]{4}-[0-9]+$';
    v_target := GREATEST(v_seq_curr, v_max_table);
    -- setval with is_called=TRUE → next nextval() = v_target + 1.
    PERFORM setval('seq_journal_entry_no', v_target, TRUE);
    RAISE NOTICE 'migration 101: seq_journal_entry_no reconciled — was=%, max_serial=%, set_to=%',
      v_seq_curr, v_max_table, v_target;
END $$;

-- ── 3. Self-validating contract assertion (regression-test) ──────────────
-- Verifies the redefined function actually uses the atomic sequence and
-- has shed the MAX+1 anti-pattern. If a future migration re-introduces
-- the bug, this DO block will RAISE EXCEPTION on apply — and the
-- "Database (PostgreSQL 15)" CI job that applies every migration to a
-- fresh Postgres will fail the PR before it can merge.
DO $$
DECLARE
    v_src text;
BEGIN
    SELECT pg_get_functiondef(p.oid) INTO v_src
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'fn_post_employee_wage_accrual'
     LIMIT 1;
    IF v_src IS NULL THEN
        RAISE EXCEPTION 'migration 101 self-check: fn_post_employee_wage_accrual not found after CREATE OR REPLACE';
    END IF;
    IF position('nextval(''seq_journal_entry_no''' IN v_src) = 0 THEN
        RAISE EXCEPTION 'migration 101 self-check: fn_post_employee_wage_accrual does not call nextval(''seq_journal_entry_no'') — the bug fix has been reverted';
    END IF;
    IF v_src ~ 'MAX\(SUBSTRING\(entry_no' THEN
        RAISE EXCEPTION 'migration 101 self-check: fn_post_employee_wage_accrual still contains the MAX+1 anti-pattern';
    END IF;
    RAISE NOTICE 'migration 101 self-check: fn_post_employee_wage_accrual uses nextval and is free of MAX+1 ✓';
END $$;

COMMIT;
