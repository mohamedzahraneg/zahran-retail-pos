-- Migration 091 — Extend fn_post_employee_wage_accrual with approval metadata.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Pairs with migration 090 (schema additions). Adds optional approval
-- parameters to the canonical wage-accrual proc so the new "approve
-- wage override" admin endpoint can pass them through. Existing
-- callers (no new params) continue to work because the new args are
-- DEFAULTed.
--
-- New optional params (all positional defaults):
--
--   p_calculated_amount  numeric  DEFAULT NULL
--     Attendance-based formula result (daily_wage × min(worked/target, 1)).
--     If NULL, defaulted to p_amount inside the proc so legacy callers
--     get calculated == approved (Option A).
--
--   p_override_type      text     DEFAULT 'full_day'
--     'calculated' / 'full_day' / 'custom_amount'. Same CHECK as the
--     column; legacy callers default to 'full_day' (today's behaviour).
--
--   p_approval_reason    text     DEFAULT NULL
--     Required at the row level (CHECK constraint added in migration
--     090) when override_type='custom_amount' AND amount differs from
--     calculated. NULL is fine when calculated == approved.
--
--   p_approved_by        uuid     DEFAULT NULL
--     Who approved. Defaults to created_by inside the proc when NULL.
--
-- The proc keeps its single GL invariant:
--   * One DR 521 / CR 213 posting equal to p_amount.
--   * No cashbox movement.
--
-- The new metadata is recorded on employee_payable_days only — the JE
-- shape, account codes, and amount are unchanged. Existing tests
-- (attendance.service.spec.ts) continue to pass because the service
-- layer's call signature is widened (new params optional, default to
-- the same behaviour).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

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
    v_year          int;
    v_max           int;
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

    v_year := EXTRACT(YEAR FROM p_work_date)::int;
    SELECT COALESCE(MAX(SUBSTRING(entry_no FROM 'JE-[0-9]+-([0-9]+)')::int), 0)
      INTO v_max FROM journal_entries WHERE entry_no LIKE 'JE-' || v_year || '-%';
    v_entry_no := 'JE-' || v_year || '-' || lpad((v_max + 1)::text, 6, '0');

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
  'Canonical wage-accrual poster. Creates one employee_payable_days row + one posted JE (DR 521 / CR 213) tagged with the employee. Idempotent via partial unique index — second call for same (user, date) returns the existing payable_day.id. No cashbox movement. PR-3: optional p_calculated_amount / p_override_type / p_approval_reason / p_approved_by record approval metadata; legacy callers default to override_type=''full_day'' so behaviour is unchanged.';

COMMIT;
