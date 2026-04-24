-- 038_employee_txn_gl_posting.sql
-- Auto-post journal entries for employee transactions.
--
-- Mapping:
--   wage      : DR 521 رواتب وأجور        / CR 213 مستحقات الموظفين
--   bonus     : DR 521 رواتب وأجور        / CR 213 مستحقات الموظفين
--   expense   : DR 529 مصروفات متفرقة     / CR 213 مستحقات الموظفين
--   deduction : DR 213 مستحقات الموظفين   / CR 521 رواتب وأجور (reverses expense)
--   advance   : DR 1123 ذمم الموظفين      / CR 1111 الخزينة الرئيسية (cash paid out)
--   payout    : DR 213 مستحقات الموظفين   / CR 1111 الخزينة الرئيسية (settle balance in cash)
--
-- On DELETE of an employee_transactions row, we mark the posted entry
-- `is_void = true` rather than deleting it — this keeps the audit trail.

-- Helper — fetch the UUID of an account by its numeric code.
CREATE OR REPLACE FUNCTION public.fn_account_id(p_code text)
RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT id FROM chart_of_accounts WHERE code = p_code AND is_leaf = true LIMIT 1;
$$;

-- Core: create a two-line journal entry for one employee txn.
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
    IF NOT FOUND THEN
        RAISE EXCEPTION 'employee_transaction % not found', p_txn_id;
    END IF;

    -- Pick the account pair for this txn type.
    CASE t.type
        WHEN 'wage', 'bonus' THEN
            v_dr_acct := fn_account_id('521');
            v_cr_acct := fn_account_id('213');
        WHEN 'expense' THEN
            v_dr_acct := fn_account_id('529');
            v_cr_acct := fn_account_id('213');
        WHEN 'deduction' THEN
            v_dr_acct := fn_account_id('213');
            v_cr_acct := fn_account_id('521');
        WHEN 'advance' THEN
            v_dr_acct := fn_account_id('1123');
            v_cr_acct := fn_account_id('1111');
        WHEN 'payout' THEN
            v_dr_acct := fn_account_id('213');
            v_cr_acct := fn_account_id('1111');
        ELSE
            RAISE EXCEPTION 'unknown employee txn type: %', t.type;
    END CASE;

    IF v_dr_acct IS NULL OR v_cr_acct IS NULL THEN
        -- Required accounts missing — skip GL posting silently.
        RETURN NULL;
    END IF;

    SELECT full_name INTO v_emp_name FROM users WHERE id = t.employee_id;
    v_desc := format(
        '%s — %s%s',
        CASE t.type
            WHEN 'wage'      THEN 'يومية'
            WHEN 'bonus'     THEN 'مكافأة'
            WHEN 'expense'   THEN 'مصروف نيابة'
            WHEN 'deduction' THEN 'خصم'
            WHEN 'advance'   THEN 'سلفة'
            WHEN 'payout'    THEN 'صرف'
            ELSE t.type
        END,
        COALESCE(v_emp_name, 'موظف'),
        CASE WHEN t.description IS NOT NULL AND t.description <> ''
             THEN ' — ' || t.description
             ELSE ''
        END
    );

    -- Allocate entry_no "JE-YYYY-NNNNNN".
    v_year := EXTRACT(YEAR FROM t.txn_date)::int;
    SELECT COALESCE(MAX(SUBSTRING(entry_no FROM 'JE-[0-9]+-([0-9]+)')::int), 0)
      INTO v_max
      FROM journal_entries
     WHERE entry_no LIKE 'JE-' || v_year || '-%';
    v_entry_no := 'JE-' || v_year || '-' || lpad((v_max + 1)::text, 6, '0');

    INSERT INTO journal_entries
        (entry_no, entry_date, description,
         reference_type, reference_id,
         is_posted, posted_by, posted_at,
         created_by, created_at)
    VALUES
        (v_entry_no, t.txn_date, v_desc,
         'employee_txn', t.id,
         true, t.created_by, NOW(),
         t.created_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, description)
    VALUES
        (v_entry_id, 1, v_dr_acct, t.amount, 0, v_desc),
        (v_entry_id, 2, v_cr_acct, 0, t.amount, v_desc);

    RETURN v_entry_id;
END;
$$;

-- Trigger: AFTER INSERT on employee_transactions → post journal entry.
CREATE OR REPLACE FUNCTION public.fn_trg_employee_txn_post()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        PERFORM fn_post_employee_txn(NEW.id);
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        -- Void any journal entries that reference this txn.
        UPDATE journal_entries
           SET is_void = true,
               voided_at = NOW(),
               void_reason = COALESCE(void_reason, 'employee_txn deleted')
         WHERE reference_type = 'employee_txn'
           AND reference_id = OLD.id
           AND is_void = false;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_employee_txn_post ON employee_transactions;
CREATE TRIGGER trg_employee_txn_post
    AFTER INSERT OR DELETE ON employee_transactions
    FOR EACH ROW EXECUTE FUNCTION fn_trg_employee_txn_post();

-- Backfill: post GL entries for any existing employee_transactions rows
-- that don't already have a matching entry.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT t.id FROM employee_transactions t
         WHERE NOT EXISTS (
           SELECT 1 FROM journal_entries je
            WHERE je.reference_type = 'employee_txn' AND je.reference_id = t.id
         )
    LOOP
        PERFORM fn_post_employee_txn(r.id);
    END LOOP;
END $$;
