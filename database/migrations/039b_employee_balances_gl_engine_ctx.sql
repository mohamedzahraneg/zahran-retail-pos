-- 039b — Set app.engine_context before journal writes (financial integrity guard).
--
-- Migration 068 (strict guard) requires any write to journal_entries to happen
-- under a recognised engine context. Our HR posting functions were written
-- before that guard existed; this migration re-defines them to set
-- `app.engine_context='engine:payroll'` locally before the INSERT.

CREATE OR REPLACE FUNCTION public.fn_post_employee_txn(p_txn_id uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    t              employee_transactions%ROWTYPE;
    v_entry_id     uuid;
    v_entry_no     text;
    v_year         int;
    v_max          int;
    v_dr_acct      uuid;
    v_cr_acct      uuid;
    v_desc         text;
    v_emp_name     text;
BEGIN
    SELECT * INTO t FROM employee_transactions WHERE id = p_txn_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    CASE t.type
        WHEN 'wage', 'bonus' THEN
            v_dr_acct := fn_account_id('521');  v_cr_acct := fn_account_id('213');
        WHEN 'expense' THEN
            v_dr_acct := fn_account_id('529');  v_cr_acct := fn_account_id('213');
        WHEN 'deduction' THEN
            v_dr_acct := fn_account_id('213');  v_cr_acct := fn_account_id('521');
        WHEN 'advance' THEN
            v_dr_acct := fn_account_id('1123'); v_cr_acct := fn_account_id('1111');
        WHEN 'payout' THEN
            v_dr_acct := fn_account_id('213');  v_cr_acct := fn_account_id('1111');
        ELSE RETURN NULL;
    END CASE;
    IF v_dr_acct IS NULL OR v_cr_acct IS NULL THEN RETURN NULL; END IF;

    -- Satisfy the strict financial guard (migration 068).
    PERFORM set_config('app.engine_context', 'engine:payroll', true);

    SELECT full_name INTO v_emp_name FROM users WHERE id = t.employee_id;
    v_desc := format('%s — %s%s',
        CASE t.type
            WHEN 'wage' THEN 'يومية' WHEN 'bonus' THEN 'مكافأة'
            WHEN 'expense' THEN 'مصروف نيابة' WHEN 'deduction' THEN 'خصم'
            WHEN 'advance' THEN 'سلفة' WHEN 'payout' THEN 'صرف'
            ELSE t.type END,
        COALESCE(v_emp_name, 'موظف'),
        CASE WHEN t.description IS NOT NULL AND t.description <> ''
             THEN ' — ' || t.description ELSE '' END);

    v_year := EXTRACT(YEAR FROM t.txn_date)::int;
    SELECT COALESCE(MAX(SUBSTRING(entry_no FROM 'JE-[0-9]+-([0-9]+)')::int), 0)
      INTO v_max FROM journal_entries WHERE entry_no LIKE 'JE-' || v_year || '-%';
    v_entry_no := 'JE-' || v_year || '-' || lpad((v_max + 1)::text, 6, '0');

    INSERT INTO journal_entries
        (entry_no, entry_date, description, reference_type, reference_id,
         is_posted, posted_by, posted_at, created_by, created_at)
    VALUES (v_entry_no, t.txn_date, v_desc, 'employee_txn', t.id,
            true, t.created_by, NOW(), t.created_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, description, employee_id)
    VALUES (v_entry_id, 1, v_dr_acct, t.amount, 0, v_desc, t.employee_id),
           (v_entry_id, 2, v_cr_acct, 0, t.amount, v_desc, t.employee_id);
    RETURN v_entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_post_employee_bonus(p_bonus_id bigint)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    b              employee_bonuses%ROWTYPE;
    v_entry_id     uuid;
    v_entry_no     text;
    v_year         int;
    v_max          int;
    v_dr_acct      uuid;
    v_cr_acct      uuid;
    v_desc         text;
    v_emp_name     text;
    v_ref_id       uuid;
BEGIN
    SELECT * INTO b FROM employee_bonuses WHERE id = p_bonus_id;
    IF NOT FOUND OR b.is_void THEN RETURN NULL; END IF;

    v_dr_acct := fn_account_id('521');
    v_cr_acct := fn_account_id('213');
    IF v_dr_acct IS NULL OR v_cr_acct IS NULL THEN RETURN NULL; END IF;

    PERFORM set_config('app.engine_context', 'engine:payroll', true);

    SELECT full_name INTO v_emp_name FROM users WHERE id = b.user_id;
    v_desc := format('مكافأة (%s) — %s%s',
        b.kind, COALESCE(v_emp_name, 'موظف'),
        CASE WHEN b.note IS NOT NULL AND b.note <> '' THEN ' — ' || b.note ELSE '' END);

    v_year := EXTRACT(YEAR FROM b.bonus_date)::int;
    SELECT COALESCE(MAX(SUBSTRING(entry_no FROM 'JE-[0-9]+-([0-9]+)')::int), 0)
      INTO v_max FROM journal_entries WHERE entry_no LIKE 'JE-' || v_year || '-%';
    v_entry_no := 'JE-' || v_year || '-' || lpad((v_max + 1)::text, 6, '0');
    v_ref_id := uuid_generate_v5(uuid_ns_oid(), b.id::text);

    INSERT INTO journal_entries
        (entry_no, entry_date, description, reference_type, reference_id,
         is_posted, posted_by, posted_at, created_by, created_at)
    VALUES (v_entry_no, b.bonus_date, v_desc, 'employee_bonus', v_ref_id,
            true, b.created_by, NOW(), b.created_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, description, employee_id)
    VALUES (v_entry_id, 1, v_dr_acct, b.amount, 0, v_desc, b.user_id),
           (v_entry_id, 2, v_cr_acct, 0, b.amount, v_desc, b.user_id);
    RETURN v_entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_post_employee_deduction(p_id bigint)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    d              employee_deductions%ROWTYPE;
    v_entry_id     uuid;
    v_entry_no     text;
    v_year         int;
    v_max          int;
    v_dr_acct      uuid;
    v_cr_acct      uuid;
    v_desc         text;
    v_emp_name     text;
    v_ref_id       uuid;
BEGIN
    SELECT * INTO d FROM employee_deductions WHERE id = p_id;
    IF NOT FOUND OR d.is_void THEN RETURN NULL; END IF;

    v_dr_acct := fn_account_id('213');
    v_cr_acct := fn_account_id('521');
    IF v_dr_acct IS NULL OR v_cr_acct IS NULL THEN RETURN NULL; END IF;

    PERFORM set_config('app.engine_context', 'engine:payroll', true);

    SELECT full_name INTO v_emp_name FROM users WHERE id = d.user_id;
    v_desc := format('خصم — %s — %s', COALESCE(v_emp_name, 'موظف'), d.reason);

    v_year := EXTRACT(YEAR FROM d.deduction_date)::int;
    SELECT COALESCE(MAX(SUBSTRING(entry_no FROM 'JE-[0-9]+-([0-9]+)')::int), 0)
      INTO v_max FROM journal_entries WHERE entry_no LIKE 'JE-' || v_year || '-%';
    v_entry_no := 'JE-' || v_year || '-' || lpad((v_max + 1)::text, 6, '0');
    v_ref_id := uuid_generate_v5(uuid_ns_oid(), d.id::text);

    INSERT INTO journal_entries
        (entry_no, entry_date, description, reference_type, reference_id,
         is_posted, posted_by, posted_at, created_by, created_at)
    VALUES (v_entry_no, d.deduction_date, v_desc, 'employee_deduction', v_ref_id,
            true, d.created_by, NOW(), d.created_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, description, employee_id)
    VALUES (v_entry_id, 1, v_dr_acct, d.amount, 0, v_desc, d.user_id),
           (v_entry_id, 2, v_cr_acct, 0, d.amount, v_desc, d.user_id);

    UPDATE employee_deductions SET journal_entry_id = v_entry_id WHERE id = d.id;
    RETURN v_entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_post_employee_advance(p_id bigint)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    r              employee_requests%ROWTYPE;
    v_entry_id     uuid;
    v_entry_no     text;
    v_year         int;
    v_max          int;
    v_dr_acct      uuid;
    v_cr_acct      uuid;
    v_desc         text;
    v_emp_name     text;
    v_date         date;
    v_ref_id       uuid;
BEGIN
    SELECT * INTO r FROM employee_requests WHERE id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF r.kind <> 'advance' OR r.status <> 'approved' OR r.amount IS NULL THEN
        RETURN NULL;
    END IF;

    v_dr_acct := fn_account_id('1123');
    v_cr_acct := fn_account_id('1111');
    IF v_dr_acct IS NULL OR v_cr_acct IS NULL THEN RETURN NULL; END IF;

    PERFORM set_config('app.engine_context', 'engine:payroll', true);

    SELECT full_name INTO v_emp_name FROM users WHERE id = r.user_id;
    v_desc := format('سلفة — %s%s',
        COALESCE(v_emp_name, 'موظف'),
        CASE WHEN r.reason IS NOT NULL AND r.reason <> '' THEN ' — ' || r.reason ELSE '' END);

    v_date := COALESCE(r.decided_at::date, r.created_at::date);
    v_year := EXTRACT(YEAR FROM v_date)::int;
    SELECT COALESCE(MAX(SUBSTRING(entry_no FROM 'JE-[0-9]+-([0-9]+)')::int), 0)
      INTO v_max FROM journal_entries WHERE entry_no LIKE 'JE-' || v_year || '-%';
    v_entry_no := 'JE-' || v_year || '-' || lpad((v_max + 1)::text, 6, '0');
    v_ref_id := uuid_generate_v5(uuid_ns_oid(), r.id::text);

    INSERT INTO journal_entries
        (entry_no, entry_date, description, reference_type, reference_id,
         is_posted, posted_by, posted_at, created_by, created_at)
    VALUES (v_entry_no, v_date, v_desc, 'employee_advance', v_ref_id,
            true, r.decided_by, NOW(), r.decided_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, description, employee_id)
    VALUES (v_entry_id, 1, v_dr_acct, r.amount, 0, v_desc, r.user_id),
           (v_entry_id, 2, v_cr_acct, 0, r.amount, v_desc, r.user_id);
    RETURN v_entry_id;
END;
$$;

-- Retry backfill now that the guard is satisfied.
DO $$
DECLARE r record;
BEGIN
    PERFORM set_config('app.engine_context', 'migration:039b_payroll_gl', true);

    -- Backfill bonuses.
    FOR r IN
        SELECT b.id FROM employee_bonuses b
         WHERE b.is_void = false
           AND NOT EXISTS (
             SELECT 1 FROM journal_entries je
              WHERE je.reference_type = 'employee_bonus'
                AND je.reference_id = uuid_generate_v5(uuid_ns_oid(), b.id::text)
           )
    LOOP PERFORM fn_post_employee_bonus(r.id); END LOOP;

    FOR r IN
        SELECT d.id FROM employee_deductions d
         WHERE d.is_void = false
           AND NOT EXISTS (
             SELECT 1 FROM journal_entries je
              WHERE je.reference_type = 'employee_deduction'
                AND je.reference_id = uuid_generate_v5(uuid_ns_oid(), d.id::text)
           )
    LOOP PERFORM fn_post_employee_deduction(r.id); END LOOP;

    FOR r IN
        SELECT q.id FROM employee_requests q
         WHERE q.kind = 'advance' AND q.status = 'approved' AND q.amount IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM journal_entries je
              WHERE je.reference_type = 'employee_advance'
                AND je.reference_id = uuid_generate_v5(uuid_ns_oid(), q.id::text)
           )
    LOOP PERFORM fn_post_employee_advance(r.id); END LOOP;

    -- Also re-post employee_transactions so employee_id gets populated on
    -- journal_lines (they were posted by the v1 function which didn't set
    -- the counterparty dimension).
    FOR r IN
        SELECT et.id FROM employee_transactions et
         WHERE NOT EXISTS (
             SELECT 1 FROM journal_entries je
              WHERE je.reference_type = 'employee_txn' AND je.reference_id = et.id
         )
    LOOP PERFORM fn_post_employee_txn(r.id); END LOOP;
END $$;
