-- Migration 074 — Make employee_id and employee_user_id consistent on journal_lines.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   journal_lines carries two employee-dimension columns:
--     * employee_id       — migration 039, enforced by
--                           trg_guard_employee_gl_dimension (039c) on 1123/213.
--     * employee_user_id  — migration 071, read by v_employee_gl_balance.
--
--   Since PR #67 the FinancialEngine populates both (via mirror). But the
--   four payroll stored procedures defined in 039b and redefined in 039d
--   — fn_post_employee_txn, fn_post_employee_bonus,
--   fn_post_employee_deduction, fn_post_employee_advance — still INSERT
--   only employee_id. Any line posted through them (triggers on
--   employee_bonuses, employee_deductions, employee_transactions, and
--   the approved-employee_requests advance path) lands with
--   employee_user_id NULL.
--
--   Impact: v_employee_gl_balance joins on jl.employee_user_id and
--   silently omits these lines. Today that manifests on live as 213/521
--   rows from bonus+deduction posts — the payable side of an employee's
--   GL position never makes it into the view.
--
-- Change
--
--   1. CREATE OR REPLACE the four stored procedures so the
--      journal_lines INSERT writes employee_user_id alongside
--      employee_id (same UUID, same semantics). No account, amount,
--      direction, date, or description change.
--
--   2. One-time backfill: for the three employee-facing accounts
--      (1123, 213, 521), copy employee_id → employee_user_id when the
--      former is set and the latter is NULL. Only fills the gap;
--      does not overwrite anything.
--
-- What this migration does NOT touch
--
--   * FinancialEngine (already writes both since PR #67)
--   * employee_bonuses / _deductions / _settlements / _transactions /
--     _requests / expenses — no row rewritten
--   * any amount, debit, credit, cashbox, entry_date, or JE description
--   * v_employee_gl_balance definition (broadening its scope is
--     audit-item #3 read-side work, tracked separately)
--
-- Expected scope on live (pre-flight check, 2026-04-24):
--   1123 to_backfill=0  (already consistent — engine-written)
--   213  to_backfill=5
--   521  to_backfill=5
--   Total: 10 lines.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. fn_post_employee_txn ────────────────────────────────────────────────
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
         is_posted, created_by, created_at)
    VALUES (v_entry_no, t.txn_date, v_desc, 'employee_txn', t.id,
            false, t.created_by, NOW())
    RETURNING id INTO v_entry_id;

    -- employee_user_id mirrors employee_id so v_employee_gl_balance
    -- (migration 071) picks the line up.
    INSERT INTO journal_lines
        (entry_id, line_no, account_id, debit, credit, description,
         employee_id, employee_user_id)
    VALUES (v_entry_id, 1, v_dr_acct, t.amount, 0, v_desc, t.employee_id, t.employee_id),
           (v_entry_id, 2, v_cr_acct, 0, t.amount, v_desc, t.employee_id, t.employee_id);

    UPDATE journal_entries
       SET is_posted = true, posted_by = t.created_by, posted_at = NOW()
     WHERE id = v_entry_id;

    RETURN v_entry_id;
END;
$$;

-- ─── 2. fn_post_employee_bonus ─────────────────────────────────────────────
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
         is_posted, created_by, created_at)
    VALUES (v_entry_no, b.bonus_date, v_desc, 'employee_bonus', v_ref_id,
            false, b.created_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines
        (entry_id, line_no, account_id, debit, credit, description,
         employee_id, employee_user_id)
    VALUES (v_entry_id, 1, v_dr_acct, b.amount, 0, v_desc, b.user_id, b.user_id),
           (v_entry_id, 2, v_cr_acct, 0, b.amount, v_desc, b.user_id, b.user_id);

    UPDATE journal_entries SET is_posted = true, posted_by = b.created_by, posted_at = NOW()
     WHERE id = v_entry_id;
    RETURN v_entry_id;
END;
$$;

-- ─── 3. fn_post_employee_deduction ─────────────────────────────────────────
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
         is_posted, created_by, created_at)
    VALUES (v_entry_no, d.deduction_date, v_desc, 'employee_deduction', v_ref_id,
            false, d.created_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines
        (entry_id, line_no, account_id, debit, credit, description,
         employee_id, employee_user_id)
    VALUES (v_entry_id, 1, v_dr_acct, d.amount, 0, v_desc, d.user_id, d.user_id),
           (v_entry_id, 2, v_cr_acct, 0, d.amount, v_desc, d.user_id, d.user_id);

    UPDATE journal_entries SET is_posted = true, posted_by = d.created_by, posted_at = NOW()
     WHERE id = v_entry_id;
    UPDATE employee_deductions SET journal_entry_id = v_entry_id WHERE id = d.id;
    RETURN v_entry_id;
END;
$$;

-- ─── 4. fn_post_employee_advance ───────────────────────────────────────────
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
         is_posted, created_by, created_at)
    VALUES (v_entry_no, v_date, v_desc, 'employee_advance', v_ref_id,
            false, r.decided_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines
        (entry_id, line_no, account_id, debit, credit, description,
         employee_id, employee_user_id)
    VALUES (v_entry_id, 1, v_dr_acct, r.amount, 0, v_desc, r.user_id, r.user_id),
           (v_entry_id, 2, v_cr_acct, 0, r.amount, v_desc, r.user_id, r.user_id);

    UPDATE journal_entries SET is_posted = true, posted_by = r.decided_by, posted_at = NOW()
     WHERE id = v_entry_id;
    RETURN v_entry_id;
END;
$$;

-- ─── 5. One-time backfill ───────────────────────────────────────────────────
-- Copy employee_id → employee_user_id for the three employee-facing
-- accounts where the stored procs left employee_user_id NULL. Idempotent
-- (WHERE clause excludes rows already populated).
DO $$
DECLARE
    v_updated int;
BEGIN
    PERFORM set_config('app.engine_context', 'migration:074_payroll_procs_backfill', true);

    UPDATE journal_lines jl
       SET employee_user_id = jl.employee_id
      FROM chart_of_accounts coa
     WHERE coa.id = jl.account_id
       AND coa.code IN ('1123', '213', '521')
       AND jl.employee_id IS NOT NULL
       AND jl.employee_user_id IS NULL;
    GET DIAGNOSTICS v_updated = ROW_COUNT;
    RAISE NOTICE 'migration 074 backfill: % journal_lines updated (employee_user_id ← employee_id)', v_updated;
END $$;

COMMIT;
