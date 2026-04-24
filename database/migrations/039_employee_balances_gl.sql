-- 039_employee_balances_gl.sql
-- PHASE 3 — Move employee balance calculation to the GL.
--
-- ROOT CAUSE: previously `v_employee_balances` read directly from
-- `employee_transactions` only, ignoring the legacy HR tables
-- (`employee_bonuses`, `employee_deductions`, `employee_requests`) that
-- carry most historical activity. That view is now legacy — the
-- authoritative balance lives in `v_employee_balances_gl`.
--
-- Contract:
--   • Every HR mutation posts a double-entry journal row tagged with
--     the employee via `journal_lines.employee_id` (new dimension).
--   • `v_employee_balances_gl` aggregates only posted, non-void entries
--     on accounts 213 (مستحقات الموظفين — liability) and 1123 (ذمم
--     الموظفين — asset/receivable).
--
-- Balance math (per employee):
--   liability  = credit(213) - debit(213)      ← company owes employee
--   receivable = debit(1123) - credit(1123)    ← employee owes company
--   net        = liability - receivable
--      > 0 → company owes employee  (GREEN in UI)
--      < 0 → employee owes company  (RED in UI)

-- ─── 1. journal_lines.employee_id — new counterparty dimension ──────────
ALTER TABLE journal_lines
    ADD COLUMN IF NOT EXISTS employee_id uuid REFERENCES users(id);

CREATE INDEX IF NOT EXISTS idx_jl_employee ON journal_lines(employee_id)
    WHERE employee_id IS NOT NULL;

-- ─── 2. Rewrite fn_post_employee_txn to set employee_id on each line ────
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
        (entry_no, entry_date, description,
         reference_type, reference_id,
         is_posted, posted_by, posted_at, created_by, created_at)
    VALUES
        (v_entry_no, t.txn_date, v_desc,
         'employee_txn', t.id,
         true, t.created_by, NOW(), t.created_by, NOW())
    RETURNING id INTO v_entry_id;

    -- Each journal line now carries the employee_id dimension so the
    -- GL-sourced balance view can aggregate without joining back.
    INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, description, employee_id)
    VALUES
        (v_entry_id, 1, v_dr_acct, t.amount, 0, v_desc, t.employee_id),
        (v_entry_id, 2, v_cr_acct, 0, t.amount, v_desc, t.employee_id);

    RETURN v_entry_id;
END;
$$;

-- Also backfill employee_id on any existing journal_lines that originated
-- from employee_transactions, so historical rows are queryable too.
UPDATE journal_lines jl
   SET employee_id = et.employee_id
  FROM journal_entries je
  JOIN employee_transactions et ON et.id = je.reference_id
 WHERE jl.entry_id = je.id
   AND je.reference_type = 'employee_txn'
   AND jl.employee_id IS NULL;

-- ─── 3. GL posting for employee_bonuses (legacy HR stack) ────────────────
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
BEGIN
    SELECT * INTO b FROM employee_bonuses WHERE id = p_bonus_id;
    IF NOT FOUND OR b.is_void THEN RETURN NULL; END IF;

    v_dr_acct := fn_account_id('521');   -- رواتب وأجور (expense)
    v_cr_acct := fn_account_id('213');   -- مستحقات الموظفين (liability)
    IF v_dr_acct IS NULL OR v_cr_acct IS NULL THEN RETURN NULL; END IF;

    SELECT full_name INTO v_emp_name FROM users WHERE id = b.user_id;
    v_desc := format('مكافأة (%s) — %s%s',
        b.kind, COALESCE(v_emp_name, 'موظف'),
        CASE WHEN b.note IS NOT NULL AND b.note <> ''
             THEN ' — ' || b.note ELSE '' END);

    v_year := EXTRACT(YEAR FROM b.bonus_date)::int;
    SELECT COALESCE(MAX(SUBSTRING(entry_no FROM 'JE-[0-9]+-([0-9]+)')::int), 0)
      INTO v_max FROM journal_entries WHERE entry_no LIKE 'JE-' || v_year || '-%';
    v_entry_no := 'JE-' || v_year || '-' || lpad((v_max + 1)::text, 6, '0');

    INSERT INTO journal_entries
        (entry_no, entry_date, description,
         reference_type, reference_id,
         is_posted, posted_by, posted_at, created_by, created_at)
    VALUES
        (v_entry_no, b.bonus_date, v_desc,
         'employee_bonus', (uuid_generate_v5(uuid_ns_oid(), b.id::text)),
         true, b.created_by, NOW(), b.created_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, description, employee_id)
    VALUES
        (v_entry_id, 1, v_dr_acct, b.amount, 0, v_desc, b.user_id),
        (v_entry_id, 2, v_cr_acct, 0, b.amount, v_desc, b.user_id);
    RETURN v_entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_trg_employee_bonus_post()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.is_void = false THEN
        PERFORM fn_post_employee_bonus(NEW.id);
    ELSIF TG_OP = 'UPDATE' AND NEW.is_void = true AND OLD.is_void = false THEN
        -- Void posting: mark the matching GL entry void.
        UPDATE journal_entries SET is_void = true, voided_at = NOW(),
               void_reason = COALESCE(void_reason, NEW.void_reason, 'bonus voided')
         WHERE reference_type = 'employee_bonus'
           AND reference_id = uuid_generate_v5(uuid_ns_oid(), NEW.id::text);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_bonus_post ON employee_bonuses;
CREATE TRIGGER trg_employee_bonus_post
    AFTER INSERT OR UPDATE ON employee_bonuses
    FOR EACH ROW EXECUTE FUNCTION fn_trg_employee_bonus_post();

-- ─── 4. GL posting for employee_deductions ──────────────────────────────
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
BEGIN
    SELECT * INTO d FROM employee_deductions WHERE id = p_id;
    IF NOT FOUND OR d.is_void THEN RETURN NULL; END IF;

    -- Deduction = reduce what company owes employee.
    --   DR 213 (reduce liability) / CR 521 (reverse wage expense).
    v_dr_acct := fn_account_id('213');
    v_cr_acct := fn_account_id('521');
    IF v_dr_acct IS NULL OR v_cr_acct IS NULL THEN RETURN NULL; END IF;

    SELECT full_name INTO v_emp_name FROM users WHERE id = d.user_id;
    v_desc := format('خصم — %s — %s', COALESCE(v_emp_name, 'موظف'), d.reason);

    v_year := EXTRACT(YEAR FROM d.deduction_date)::int;
    SELECT COALESCE(MAX(SUBSTRING(entry_no FROM 'JE-[0-9]+-([0-9]+)')::int), 0)
      INTO v_max FROM journal_entries WHERE entry_no LIKE 'JE-' || v_year || '-%';
    v_entry_no := 'JE-' || v_year || '-' || lpad((v_max + 1)::text, 6, '0');

    INSERT INTO journal_entries
        (entry_no, entry_date, description,
         reference_type, reference_id,
         is_posted, posted_by, posted_at, created_by, created_at)
    VALUES
        (v_entry_no, d.deduction_date, v_desc,
         'employee_deduction', uuid_generate_v5(uuid_ns_oid(), d.id::text),
         true, d.created_by, NOW(), d.created_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, description, employee_id)
    VALUES
        (v_entry_id, 1, v_dr_acct, d.amount, 0, v_desc, d.user_id),
        (v_entry_id, 2, v_cr_acct, 0, d.amount, v_desc, d.user_id);

    -- Link the GL entry back to the deduction row.
    UPDATE employee_deductions SET journal_entry_id = v_entry_id WHERE id = d.id;
    RETURN v_entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_trg_employee_deduction_post()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.is_void = false THEN
        PERFORM fn_post_employee_deduction(NEW.id);
    ELSIF TG_OP = 'UPDATE' AND NEW.is_void = true AND OLD.is_void = false THEN
        UPDATE journal_entries SET is_void = true, voided_at = NOW(),
               void_reason = COALESCE(void_reason, NEW.void_reason, 'deduction voided')
         WHERE reference_type = 'employee_deduction'
           AND reference_id = uuid_generate_v5(uuid_ns_oid(), NEW.id::text);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_deduction_post ON employee_deductions;
CREATE TRIGGER trg_employee_deduction_post
    AFTER INSERT OR UPDATE ON employee_deductions
    FOR EACH ROW EXECUTE FUNCTION fn_trg_employee_deduction_post();

-- ─── 5. GL posting for approved employee_requests (kind='advance') ──────
-- An advance is cash paid to the employee that they'll repay later:
--   DR 1123 ذمم الموظفين (asset)  /  CR 1111 الخزينة الرئيسية (asset)
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
BEGIN
    SELECT * INTO r FROM employee_requests WHERE id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF r.kind <> 'advance' OR r.status <> 'approved' OR r.amount IS NULL THEN
        RETURN NULL;
    END IF;

    v_dr_acct := fn_account_id('1123');
    v_cr_acct := fn_account_id('1111');
    IF v_dr_acct IS NULL OR v_cr_acct IS NULL THEN RETURN NULL; END IF;

    SELECT full_name INTO v_emp_name FROM users WHERE id = r.user_id;
    v_desc := format('سلفة — %s%s',
        COALESCE(v_emp_name, 'موظف'),
        CASE WHEN r.reason IS NOT NULL AND r.reason <> ''
             THEN ' — ' || r.reason ELSE '' END);

    v_date := COALESCE(r.decided_at::date, r.created_at::date);
    v_year := EXTRACT(YEAR FROM v_date)::int;
    SELECT COALESCE(MAX(SUBSTRING(entry_no FROM 'JE-[0-9]+-([0-9]+)')::int), 0)
      INTO v_max FROM journal_entries WHERE entry_no LIKE 'JE-' || v_year || '-%';
    v_entry_no := 'JE-' || v_year || '-' || lpad((v_max + 1)::text, 6, '0');

    INSERT INTO journal_entries
        (entry_no, entry_date, description,
         reference_type, reference_id,
         is_posted, posted_by, posted_at, created_by, created_at)
    VALUES
        (v_entry_no, v_date, v_desc,
         'employee_advance', uuid_generate_v5(uuid_ns_oid(), r.id::text),
         true, r.decided_by, NOW(), r.decided_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, description, employee_id)
    VALUES
        (v_entry_id, 1, v_dr_acct, r.amount, 0, v_desc, r.user_id),
        (v_entry_id, 2, v_cr_acct, 0, r.amount, v_desc, r.user_id);
    RETURN v_entry_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_trg_employee_advance_post()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Fire when an advance transitions into approved.
    IF NEW.kind = 'advance' AND NEW.status = 'approved'
       AND (OLD IS NULL OR OLD.status IS DISTINCT FROM NEW.status) THEN
        PERFORM fn_post_employee_advance(NEW.id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_advance_post ON employee_requests;
CREATE TRIGGER trg_employee_advance_post
    AFTER INSERT OR UPDATE ON employee_requests
    FOR EACH ROW EXECUTE FUNCTION fn_trg_employee_advance_post();

-- ─── 6. Backfill GL entries for every existing HR row ───────────────────
DO $$
DECLARE r record;
BEGIN
    -- Bonuses missing a GL post
    FOR r IN
        SELECT b.id FROM employee_bonuses b
         WHERE b.is_void = false
           AND NOT EXISTS (
             SELECT 1 FROM journal_entries je
              WHERE je.reference_type = 'employee_bonus'
                AND je.reference_id = uuid_generate_v5(uuid_ns_oid(), b.id::text)
           )
    LOOP PERFORM fn_post_employee_bonus(r.id); END LOOP;

    -- Deductions missing a GL post
    FOR r IN
        SELECT d.id FROM employee_deductions d
         WHERE d.is_void = false
           AND NOT EXISTS (
             SELECT 1 FROM journal_entries je
              WHERE je.reference_type = 'employee_deduction'
                AND je.reference_id = uuid_generate_v5(uuid_ns_oid(), d.id::text)
           )
    LOOP PERFORM fn_post_employee_deduction(r.id); END LOOP;

    -- Approved advances missing a GL post
    FOR r IN
        SELECT q.id FROM employee_requests q
         WHERE q.kind = 'advance' AND q.status = 'approved' AND q.amount IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM journal_entries je
              WHERE je.reference_type = 'employee_advance'
                AND je.reference_id = uuid_generate_v5(uuid_ns_oid(), q.id::text)
           )
    LOOP PERFORM fn_post_employee_advance(r.id); END LOOP;
END $$;

-- ─── 7. The authoritative balance view ───────────────────────────────────
--
-- NEVER bypass this view for balances. Every screen that reports what the
-- company owes/is owed for an employee must read from here.
DROP VIEW IF EXISTS v_employee_balances_gl CASCADE;
CREATE OR REPLACE VIEW v_employee_balances_gl AS
WITH liability_213 AS (
    SELECT jl.employee_id,
           COALESCE(SUM(jl.credit), 0)::numeric(14,2) AS credit_213,
           COALESCE(SUM(jl.debit),  0)::numeric(14,2) AS debit_213
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      JOIN chart_of_accounts coa ON coa.id = jl.account_id
     WHERE je.is_posted = true AND je.is_void = false
       AND jl.employee_id IS NOT NULL
       AND coa.code = '213'
     GROUP BY jl.employee_id
),
receivable_1123 AS (
    SELECT jl.employee_id,
           COALESCE(SUM(jl.debit),  0)::numeric(14,2) AS debit_1123,
           COALESCE(SUM(jl.credit), 0)::numeric(14,2) AS credit_1123
      FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
      JOIN chart_of_accounts coa ON coa.id = jl.account_id
     WHERE je.is_posted = true AND je.is_void = false
       AND jl.employee_id IS NOT NULL
       AND coa.code = '1123'
     GROUP BY jl.employee_id
)
SELECT
    u.id                                  AS employee_id,
    u.full_name,
    u.username,
    COALESCE(l.credit_213 - l.debit_213,    0)::numeric(14,2) AS liabilities,
    COALESCE(r.debit_1123 - r.credit_1123,  0)::numeric(14,2) AS receivables,
    (COALESCE(l.credit_213 - l.debit_213, 0)
     - COALESCE(r.debit_1123 - r.credit_1123, 0))::numeric(14,2) AS net_balance,
    (SELECT COUNT(*)::int FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
     WHERE jl.employee_id = u.id AND je.is_posted = true AND je.is_void = false
    ) AS gl_line_count,
    (SELECT MAX(je.entry_date) FROM journal_lines jl
      JOIN journal_entries je ON je.id = jl.entry_id
     WHERE jl.employee_id = u.id AND je.is_posted = true AND je.is_void = false
    ) AS last_entry_date
  FROM users u
  LEFT JOIN liability_213  l ON l.employee_id = u.id
  LEFT JOIN receivable_1123 r ON r.employee_id = u.id
 WHERE u.is_active = true;

COMMENT ON VIEW v_employee_balances_gl IS
    'AUTHORITATIVE employee balance view. Sourced ONLY from posted, non-void GL entries on accounts 213 + 1123. Positive net = company owes employee; negative = employee owes company. Do not bypass.';
