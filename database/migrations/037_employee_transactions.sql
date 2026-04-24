-- 037_employee_transactions.sql
-- Payroll-style ledger per employee: daily wages, bonuses, deductions,
-- reimbursable expenses, and advances. Each row is a single cash movement
-- attributed to one employee. A separate view gives the running balance
-- the payroll officer owes / is owed.

CREATE TABLE IF NOT EXISTS employee_transactions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    employee_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    txn_date       date NOT NULL DEFAULT CURRENT_DATE,
    type           text NOT NULL CHECK (type IN (
        'wage',       -- يومية / مرتب يومي — مستحق للموظف
        'bonus',      -- مكافأة — مستحق للموظف
        'deduction',  -- خصم — يُقتطع من مستحقات الموظف
        'expense',    -- مصروف أنفقه الموظف نيابة عن المحل — مستحق للموظف كتعويض
        'advance',    -- سلفة مدفوعة مقدّمًا للموظف — تُخصم من مستحقاته
        'payout'      -- صرف نهائي أو دورى من حساب الموظف
    )),
    amount         numeric(14,2) NOT NULL CHECK (amount >= 0),
    description    text,
    reference_type text,
    reference_id   uuid,
    cashbox_id     uuid REFERENCES cashboxes(id) ON DELETE SET NULL,
    shift_id       uuid REFERENCES shifts(id) ON DELETE SET NULL,
    created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_employee_txn_emp_date
    ON employee_transactions(employee_id, txn_date DESC);
CREATE INDEX IF NOT EXISTS idx_employee_txn_type
    ON employee_transactions(type);
CREATE INDEX IF NOT EXISTS idx_employee_txn_date
    ON employee_transactions(txn_date DESC);

-- Running-balance helper.
--   + (owed to employee): wage + bonus + expense
--   − (owed by employee): deduction + advance + payout
-- "balance" = net amount still owed to the employee.
CREATE OR REPLACE VIEW v_employee_balances AS
SELECT
    u.id   AS employee_id,
    u.full_name,
    u.username,
    COALESCE(SUM(CASE WHEN t.type IN ('wage','bonus','expense')
                      THEN t.amount ELSE 0 END), 0)::numeric(14,2) AS total_credit,
    COALESCE(SUM(CASE WHEN t.type IN ('deduction','advance','payout')
                      THEN t.amount ELSE 0 END), 0)::numeric(14,2) AS total_debit,
    COALESCE(SUM(CASE WHEN t.type IN ('wage','bonus','expense')
                      THEN t.amount
                      WHEN t.type IN ('deduction','advance','payout')
                      THEN -t.amount
                      ELSE 0 END), 0)::numeric(14,2) AS balance,
    COUNT(t.id)::int AS txn_count,
    MAX(t.txn_date) AS last_txn_date
  FROM users u
  LEFT JOIN employee_transactions t ON t.employee_id = u.id
 WHERE u.is_active = true
 GROUP BY u.id, u.full_name, u.username;

-- updated_at trigger
CREATE OR REPLACE FUNCTION fn_emp_txn_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_emp_txn_updated_at ON employee_transactions;
CREATE TRIGGER trg_emp_txn_updated_at
    BEFORE UPDATE ON employee_transactions
    FOR EACH ROW EXECUTE FUNCTION fn_emp_txn_updated_at();

-- Attach audit trigger
DROP TRIGGER IF EXISTS trg_audit_employee_txn ON employee_transactions;
CREATE TRIGGER trg_audit_employee_txn
    AFTER INSERT OR UPDATE OR DELETE ON employee_transactions
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
