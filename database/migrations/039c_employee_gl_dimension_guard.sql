-- 039c — Regression protection: when a journal_line is posted to an
-- employee-facing account (213 liability or 1123 receivable), the
-- employee_id dimension MUST be set. Without it the
-- v_employee_balances_gl view can't attribute the line to anyone and
-- the balance becomes silently wrong.
--
-- This is a BEFORE INSERT trigger that RAISES if the invariant is
-- violated. It is intentionally strict — a legitimate posting to 213
-- or 1123 is ALWAYS tied to an employee.

CREATE OR REPLACE FUNCTION public.fn_guard_employee_gl_dimension()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_code text;
BEGIN
    SELECT code INTO v_code FROM chart_of_accounts WHERE id = NEW.account_id;
    IF v_code IN ('213', '1123') AND NEW.employee_id IS NULL THEN
        RAISE EXCEPTION
            'journal_lines: account % requires employee_id (regression guard 039c). '
            'Every posting to مستحقات الموظفين (213) or ذمم الموظفين (1123) '
            'must carry the counterparty employee — otherwise v_employee_balances_gl '
            'silently drops the line.', v_code;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_employee_gl_dimension ON journal_lines;
CREATE TRIGGER trg_guard_employee_gl_dimension
    BEFORE INSERT ON journal_lines
    FOR EACH ROW EXECUTE FUNCTION fn_guard_employee_gl_dimension();
