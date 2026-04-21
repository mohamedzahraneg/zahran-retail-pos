-- 040_employee_module.sql
-- -----------------------------------------------------------------------------
-- Employee dashboard / HR module.
--
-- Adds structured HR data on top of the existing `users` table:
--   * employee_no / job title / target hours / salary setup
--   * advance & deduction ledger (advances re-use `expenses` via a
--     new user_id column so they appear in both places automatically)
--   * request inbox (leave / advance / overtime-extension)
--   * bonuses & deductions records
--   * task assignments with acknowledgement tracking
-- -----------------------------------------------------------------------------

-- ── user-level HR profile fields ─────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS employee_no        VARCHAR(32)  UNIQUE,
  ADD COLUMN IF NOT EXISTS job_title          VARCHAR(120),
  ADD COLUMN IF NOT EXISTS hire_date          DATE,
  ADD COLUMN IF NOT EXISTS salary_amount      NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS salary_frequency   VARCHAR(10)
      CHECK (salary_frequency IN ('daily','weekly','monthly'))
      DEFAULT 'monthly',
  ADD COLUMN IF NOT EXISTS target_hours_day   NUMERIC(5,2)  DEFAULT 8,
  ADD COLUMN IF NOT EXISTS target_hours_week  NUMERIC(6,2)  DEFAULT 48,
  ADD COLUMN IF NOT EXISTS overtime_rate      NUMERIC(5,2)  DEFAULT 1.5;

-- ── link advances in expenses back to the employee who drew them ─────────────
ALTER TABLE expenses
  ADD COLUMN IF NOT EXISTS employee_user_id UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS is_advance       BOOLEAN DEFAULT FALSE;

CREATE INDEX IF NOT EXISTS ix_expenses_employee
  ON expenses(employee_user_id) WHERE employee_user_id IS NOT NULL;

-- ── bonuses (عمولات / حوافز / مكافآت يدوية) ────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_bonuses (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID       NOT NULL REFERENCES users(id),
  amount      NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  kind        VARCHAR(20) NOT NULL
              CHECK (kind IN ('bonus','incentive','overtime','other'))
              DEFAULT 'bonus',
  note        TEXT,
  bonus_date  DATE       NOT NULL DEFAULT CURRENT_DATE,
  created_by  UUID       REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_bonuses_user_date
  ON employee_bonuses(user_id, bonus_date DESC);

-- ── deductions (خصومات غير السلف — مخالفات/مواعيد/إلخ) ────────────────────
CREATE TABLE IF NOT EXISTS employee_deductions (
  id               BIGSERIAL PRIMARY KEY,
  user_id          UUID        NOT NULL REFERENCES users(id),
  amount           NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  reason           TEXT         NOT NULL,
  deduction_date   DATE         NOT NULL DEFAULT CURRENT_DATE,
  created_by       UUID         REFERENCES users(id),
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_deductions_user_date
  ON employee_deductions(user_id, deduction_date DESC);

-- ── employee requests (سلفة / إجازة / تمديد إضافي) ─────────────────────────
CREATE TABLE IF NOT EXISTS employee_requests (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES users(id),
  kind            VARCHAR(20) NOT NULL
                  CHECK (kind IN ('advance','leave','overtime_extension','other')),
  amount          NUMERIC(14,2),            -- for advances
  starts_at       TIMESTAMPTZ,              -- for leave / overtime
  ends_at         TIMESTAMPTZ,
  reason          TEXT,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by      UUID        REFERENCES users(id),
  decided_at      TIMESTAMPTZ,
  decision_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_emp_req_user
  ON employee_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_emp_req_pending
  ON employee_requests(status, created_at DESC)
  WHERE status = 'pending';

-- ── employee tasks (مهام من الإدارة) ────────────────────────────────────────
CREATE TABLE IF NOT EXISTS employee_tasks (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID        NOT NULL REFERENCES users(id),
  title           VARCHAR(200) NOT NULL,
  description     TEXT,
  priority        VARCHAR(10) NOT NULL DEFAULT 'normal'
                  CHECK (priority IN ('low','normal','high','urgent')),
  due_at          TIMESTAMPTZ,
  assigned_by     UUID        REFERENCES users(id),
  assigned_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  acknowledged_at TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  status          VARCHAR(20) NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','acknowledged','completed','cancelled'))
);
CREATE INDEX IF NOT EXISTS ix_emp_tasks_user
  ON employee_tasks(user_id, assigned_at DESC);
CREATE INDEX IF NOT EXISTS ix_emp_tasks_open
  ON employee_tasks(user_id, status)
  WHERE status IN ('pending','acknowledged');

-- ── seed a stable employee_no for existing users ───────────────────────────
UPDATE users u
   SET employee_no = 'EMP-' || LPAD(
         (ROW_NUMBER() OVER (ORDER BY u.created_at))::text, 4, '0')
  FROM (
    SELECT id, created_at,
           ROW_NUMBER() OVER (ORDER BY created_at) AS rn
      FROM users
  ) ord
 WHERE u.id = ord.id
   AND u.employee_no IS NULL;
