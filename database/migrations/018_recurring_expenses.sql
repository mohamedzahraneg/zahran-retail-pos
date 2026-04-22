-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 018 : Recurring Expenses
--
--  Automates fixed/periodic payables (rent, salaries, utilities, subscriptions).
--  A recurring_expense template defines the schedule + default amounts/category,
--  and the scheduler/cron creates real expenses rows on the next due date.
-- ============================================================================

CREATE TYPE recurrence_frequency AS ENUM (
    'daily',
    'weekly',
    'biweekly',
    'monthly',
    'quarterly',
    'semiannual',
    'annual',
    'custom_days'
);

CREATE TYPE recurrence_status AS ENUM (
    'active',
    'paused',
    'ended'
);

-- ---------- Recurring expense templates ----------
CREATE TABLE recurring_expenses (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code                VARCHAR(40) UNIQUE NOT NULL,              -- e.g. RENT-CAIRO-01
    name_ar             VARCHAR(150) NOT NULL,
    name_en             VARCHAR(150),
    category_id         UUID NOT NULL REFERENCES expense_categories(id),
    warehouse_id        UUID NOT NULL REFERENCES warehouses(id),
    cashbox_id          UUID REFERENCES cashboxes(id),
    amount              NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
    payment_method      payment_method_code NOT NULL DEFAULT 'cash',
    vendor_name         VARCHAR(150),
    description         TEXT,

    -- Schedule
    frequency           recurrence_frequency NOT NULL,
    custom_interval_days INT,                                     -- for frequency = custom_days
    day_of_month        INT CHECK (day_of_month BETWEEN 1 AND 31),-- for monthly/quarterly (NULL = same day as start)
    start_date          DATE NOT NULL,
    end_date            DATE,                                     -- NULL = no end
    next_run_date       DATE NOT NULL,                            -- updated after each generation
    last_run_date       DATE,

    -- Auto-behavior
    auto_post           BOOLEAN NOT NULL DEFAULT TRUE,            -- if true, generated expenses are auto-approved
    auto_paid           BOOLEAN NOT NULL DEFAULT FALSE,           -- if true, immediately deducts from cashbox
    notify_days_before  INT NOT NULL DEFAULT 3,                   -- generate a reminder N days before due
    require_approval    BOOLEAN NOT NULL DEFAULT FALSE,

    -- State
    status              recurrence_status NOT NULL DEFAULT 'active',
    runs_count          INT NOT NULL DEFAULT 0,                   -- how many expenses generated so far
    last_error          TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rec_exp_next_run    ON recurring_expenses(next_run_date) WHERE status = 'active';
CREATE INDEX idx_rec_exp_status      ON recurring_expenses(status);
CREATE INDEX idx_rec_exp_category    ON recurring_expenses(category_id);
CREATE INDEX idx_rec_exp_warehouse   ON recurring_expenses(warehouse_id);

-- ---------- Generation log (one row per expense created) ----------
CREATE TABLE recurring_expense_runs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    recurring_id        UUID NOT NULL REFERENCES recurring_expenses(id) ON DELETE CASCADE,
    expense_id          UUID REFERENCES expenses(id) ON DELETE SET NULL,
    scheduled_for       DATE NOT NULL,
    generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    amount              NUMERIC(14,2) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'generated'
                        CHECK (status IN ('generated','skipped','failed','manual')),
    notes               TEXT,
    error_message       TEXT,
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_rec_exp_runs_recurring ON recurring_expense_runs(recurring_id, scheduled_for DESC);
CREATE INDEX idx_rec_exp_runs_expense   ON recurring_expense_runs(expense_id);

-- ---------- Helper: compute next run date ----------
CREATE OR REPLACE FUNCTION fn_recurring_next_run(
    p_freq recurrence_frequency,
    p_current DATE,
    p_day_of_month INT DEFAULT NULL,
    p_custom_days INT DEFAULT NULL
) RETURNS DATE AS $$
DECLARE
    next_d DATE;
BEGIN
    CASE p_freq
        WHEN 'daily'       THEN next_d := p_current + INTERVAL '1 day';
        WHEN 'weekly'      THEN next_d := p_current + INTERVAL '7 days';
        WHEN 'biweekly'    THEN next_d := p_current + INTERVAL '14 days';
        WHEN 'monthly'     THEN next_d := p_current + INTERVAL '1 month';
        WHEN 'quarterly'   THEN next_d := p_current + INTERVAL '3 months';
        WHEN 'semiannual'  THEN next_d := p_current + INTERVAL '6 months';
        WHEN 'annual'      THEN next_d := p_current + INTERVAL '1 year';
        WHEN 'custom_days' THEN next_d := p_current + (COALESCE(p_custom_days, 1) || ' days')::INTERVAL;
    END CASE;

    -- pin to configured day-of-month for monthly-ish frequencies
    IF p_day_of_month IS NOT NULL AND p_freq IN ('monthly','quarterly','semiannual','annual') THEN
        next_d := date_trunc('month', next_d)::DATE
                  + LEAST(p_day_of_month, EXTRACT(DAY FROM (date_trunc('month', next_d) + INTERVAL '1 month - 1 day'))::INT) - 1;
    END IF;

    RETURN next_d;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------- Trigger: set next_run_date on insert ----------
CREATE OR REPLACE FUNCTION fn_recurring_defaults() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.next_run_date IS NULL THEN
        NEW.next_run_date := NEW.start_date;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recurring_defaults BEFORE INSERT ON recurring_expenses
FOR EACH ROW EXECUTE FUNCTION fn_recurring_defaults();

CREATE TRIGGER trg_recurring_exp_updated BEFORE UPDATE ON recurring_expenses
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------- View: due now / overdue ----------
CREATE OR REPLACE VIEW v_recurring_expenses_due AS
SELECT
    re.id,
    re.code,
    re.name_ar,
    re.amount,
    re.frequency,
    re.next_run_date,
    re.warehouse_id,
    re.category_id,
    ec.name_ar   AS category_name,
    w.name_ar    AS warehouse_name,
    CASE
        WHEN re.next_run_date <= CURRENT_DATE THEN 'due'
        WHEN re.next_run_date <= CURRENT_DATE + (re.notify_days_before || ' days')::INTERVAL THEN 'upcoming'
        ELSE 'scheduled'
    END AS due_status,
    (CURRENT_DATE - re.next_run_date) AS days_overdue,
    re.runs_count,
    re.last_run_date
FROM recurring_expenses re
JOIN expense_categories ec ON ec.id = re.category_id
JOIN warehouses w          ON w.id  = re.warehouse_id
WHERE re.status = 'active';

-- ---------- Seed a couple of common templates (demo only) ----------
-- (Commented out by default; uncomment per deployment.)
--
-- INSERT INTO recurring_expenses (code, name_ar, category_id, warehouse_id, amount, frequency,
--                                  day_of_month, start_date, next_run_date, auto_post)
-- SELECT 'RENT-MAIN-01', 'إيجار الفرع الرئيسي',
--        (SELECT id FROM expense_categories WHERE code='rent'  LIMIT 1),
--        (SELECT id FROM warehouses         WHERE code='ZHR-01' LIMIT 1),
--        15000, 'monthly', 1, CURRENT_DATE, CURRENT_DATE, TRUE
-- WHERE EXISTS (SELECT 1 FROM expense_categories WHERE code='rent')
--   AND EXISTS (SELECT 1 FROM warehouses         WHERE code='ZHR-01');
