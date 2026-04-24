-- Migration 083 — fn_post_employee_wage_accrual + fn_void_employee_wage_accrual.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Migration 082 created employee_payable_days. These two procedures
--   are the *only* sanctioned path to create or void a wage accrual:
--
--     DR 521 رواتب وأجور  / CR 213 مستحقات الموظفين   (accrual)
--     DR 213 / CR 521                                   (void)
--
--   Both run under engine-prefixed context so migration 068's
--   enforcement trigger accepts the INSERT/UPDATE on journal_entries
--   (valid prefixes are 'engine:*', 'service:*', 'migration:*' — see
--   migration 070 + PR #85 for the canonical `engine:admin_void_*`
--   pattern this reuses).
--
--   No cashbox movement. Ever. Settlement (paying the employee from
--   cash) is the existing employee_settlements path.
--
-- Idempotency
--
--   fn_post_employee_wage_accrual uses the partial UNIQUE index
--   uq_payable_day_user_date_live (user_id, work_date where NOT
--   is_void AND kind='wage_accrual'). A second call for the same
--   (user, date) returns the existing payable_day.id and is a no-op.
--   Voiding the row unblocks a fresh accrual for that same date.
--
-- Strict rules
--
--   * amount must be > 0 (wage_accrual with zero amount is senseless
--     and would create a zero-value JE that confuses audit tools).
--   * attendance_record_id is optional but validated: if supplied it
--     must belong to the same user and the same work_date.
--   * source='admin_manual' requires reason (enforced both here and
--     by the table CHECK).
--   * Voiding reverses the JE via a new pair of journal_lines rather
--     than updating the original (keeps the audit trail append-only).
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. fn_post_employee_wage_accrual ─────────────────────────────────────
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
    p_created_by           uuid
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

    -- ── Insert the payable_day row first so we have a reference_id ────
    INSERT INTO employee_payable_days
        (user_id, work_date, kind, source, attendance_record_id,
         worked_minutes, daily_wage_snapshot, target_minutes_snapshot,
         amount_accrued, reason, created_by)
    VALUES
        (p_user_id, p_work_date, 'wage_accrual', p_source, p_attendance_record_id,
         p_worked_minutes, p_daily_wage_snapshot, p_target_minutes_snap,
         p_amount, p_reason, p_created_by)
    RETURNING id INTO v_payable_id;

    -- ── Build JE ──────────────────────────────────────────────────────
    SELECT full_name INTO v_emp_name FROM users WHERE id = p_user_id;
    v_desc := format('استحقاق يومية — %s%s',
        COALESCE(v_emp_name, 'موظف'),
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
    uuid, date, numeric, text, uuid, int, numeric, int, text, uuid) IS
  'Canonical wage-accrual poster. Creates one employee_payable_days row + one posted JE (DR 521 / CR 213) tagged with the employee. Idempotent via partial unique index — second call for same (user, date) returns the existing payable_day.id. No cashbox movement.';

-- ─── 2. fn_void_employee_wage_accrual ─────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_void_employee_wage_accrual(
    p_payable_day_id uuid,
    p_reason         text,
    p_voided_by      uuid
) RETURNS uuid
LANGUAGE plpgsql AS $$
DECLARE
    d              employee_payable_days%ROWTYPE;
    v_entry_id     uuid;
    v_entry_no     text;
    v_year         int;
    v_max          int;
    v_dr_acct      uuid;
    v_cr_acct      uuid;
    v_desc         text;
    v_emp_name     text;
BEGIN
    IF p_reason IS NULL OR length(btrim(p_reason)) = 0 THEN
        RAISE EXCEPTION 'void_wage_accrual: reason is required';
    END IF;
    IF p_voided_by IS NULL THEN
        RAISE EXCEPTION 'void_wage_accrual: voided_by is required';
    END IF;

    SELECT * INTO d FROM employee_payable_days
     WHERE id = p_payable_day_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'void_wage_accrual: payable_day % not found', p_payable_day_id;
    END IF;
    IF d.is_void THEN
        RETURN d.id; -- already voided → idempotent no-op
    END IF;
    IF d.journal_entry_id IS NULL THEN
        RAISE EXCEPTION 'void_wage_accrual: payable_day % has no JE to reverse', d.id;
    END IF;

    -- Engine context so migration 068 guards accept the UPDATE on journal_entries
    -- and the new reversal INSERT. Canonical prefix (PR #85 pattern).
    PERFORM set_config('app.engine_context', 'engine:admin_void_wage_accrual', true);

    v_dr_acct := fn_account_id('213');  -- reverse side: DR 213
    v_cr_acct := fn_account_id('521');  -- CR 521
    IF v_dr_acct IS NULL OR v_cr_acct IS NULL THEN
        RAISE EXCEPTION 'void_wage_accrual: COA 213/521 missing';
    END IF;

    -- Mark original JE voided (preserves the audit row — does not delete).
    UPDATE journal_entries
       SET is_void = TRUE
     WHERE id = d.journal_entry_id
       AND is_void = FALSE;

    -- Post an explicit reversal JE so the timeline shows the void as its
    -- own entry. Uses the same pattern as deduction/bonus void in
    -- migration 074 — the reversal is independent and auditable.
    SELECT full_name INTO v_emp_name FROM users WHERE id = d.user_id;
    v_desc := format('إلغاء استحقاق يومية — %s — %s',
        COALESCE(v_emp_name, 'موظف'), p_reason);

    v_year := EXTRACT(YEAR FROM CURRENT_DATE)::int;
    SELECT COALESCE(MAX(SUBSTRING(entry_no FROM 'JE-[0-9]+-([0-9]+)')::int), 0)
      INTO v_max FROM journal_entries WHERE entry_no LIKE 'JE-' || v_year || '-%';
    v_entry_no := 'JE-' || v_year || '-' || lpad((v_max + 1)::text, 6, '0');

    INSERT INTO journal_entries
        (entry_no, entry_date, description, reference_type, reference_id,
         is_posted, created_by, created_at)
    VALUES (v_entry_no, CURRENT_DATE, v_desc,
            'employee_wage_accrual_void', d.id,
            false, p_voided_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines
        (entry_id, line_no, account_id, debit, credit, description,
         employee_id, employee_user_id)
    VALUES
        (v_entry_id, 1, v_dr_acct, d.amount_accrued, 0, v_desc, d.user_id, d.user_id),
        (v_entry_id, 2, v_cr_acct, 0, d.amount_accrued, v_desc, d.user_id, d.user_id);

    UPDATE journal_entries
       SET is_posted = true, posted_by = p_voided_by, posted_at = NOW()
     WHERE id = v_entry_id;

    UPDATE employee_payable_days
       SET is_void     = TRUE,
           void_reason = p_reason,
           voided_at   = NOW(),
           voided_by   = p_voided_by
     WHERE id = d.id;

    RETURN d.id;
END;
$$;

COMMENT ON FUNCTION public.fn_void_employee_wage_accrual(uuid, text, uuid) IS
  'Admin-only reversal for a wage accrual. Marks the original JE voided and posts an explicit reversal entry (DR 213 / CR 521). Idempotent — calling it twice returns the same payable_day_id. Reason is mandatory.';

COMMIT;
