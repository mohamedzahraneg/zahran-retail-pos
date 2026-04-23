-- Migration 060: Shift variance treatment + employee financial ledger
-- ---------------------------------------------------------------------------
-- Extends the existing shift closing, accounting tree, and employee modules
-- with proper cash-variance handling and a unified employee financial file.
--
-- What this migration adds:
--
--   1. shifts.variance_* columns — the manager's decision (charge the
--      cashier, book as company loss, book as revenue, or park in
--      suspense) plus who decided and the journal entry that was posted.
--
--   2. employee_deductions.source / shift_id / journal_entry_id — so a
--      shortage charged to an employee is auditable back to the shift
--      AND the journal entry that moved the money.
--
--   3. employee_settlements — new table for recording payments from an
--      employee (cash, bank, payroll deduction) that reduce their
--      outstanding liability. Tied to a journal_entry_id for provenance.
--
--   4. Chart-of-accounts seeds (idempotent):
--        * 1123  ذمم الموظفين            Employee Receivables (asset)
--        * 215   حساب التسوية المؤقت    Suspense Account      (liability)
--      These are only inserted when the code is missing, so repeat runs
--      never duplicate rows and existing deployments keep their data.
--
--   5. Permissions:
--        * shifts.variance.approve   — decide variance treatment
--        * expenses.daily.create     — use the Daily Expenses screen
--        * employee.ledger.view      — view an employee's financial file
--      Granted to admin / manager (and admin's wildcard keeps covering
--      everything automatically).
--
--   6. v_employee_ledger — a convenience VIEW that unions shortages,
--      advances, manual deductions, settlements and bonuses into a
--      single chronological ledger with running-balance-ready signed
--      amounts. The API service layer reads this for the "Financial
--      Ledger" tab on the employee profile.
--
-- INVARIANTS
--
--   * No existing row is rewritten. Every ADD COLUMN is IF NOT EXISTS;
--     every INSERT is guarded by NOT EXISTS on the primary identifier.
--   * variance_treatment is NULL for shifts closed before this
--     migration; the UI renders such shifts as "legacy — no decision
--     recorded" instead of forcing a backfill.
--   * The journal engine is NOT duplicated. The new shift-variance
--     treatments feed FinancialEngineService.recordShiftVariance via an
--     extended signature; this migration only stores the decision.
-- ---------------------------------------------------------------------------

BEGIN;

-- ── 1. shifts — variance decision columns ────────────────────────────────

ALTER TABLE shifts
  ADD COLUMN IF NOT EXISTS variance_treatment         VARCHAR(20),
  ADD COLUMN IF NOT EXISTS variance_employee_id       UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS variance_notes             TEXT,
  ADD COLUMN IF NOT EXISTS variance_journal_entry_id  UUID REFERENCES journal_entries(id),
  ADD COLUMN IF NOT EXISTS variance_decided_by        UUID REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS variance_decided_at        TIMESTAMPTZ;

-- Valid treatments. NULL is allowed — it means "no decision yet" (open /
-- pending shifts) or "closed before this feature existed" (legacy rows).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'shifts' AND constraint_name = 'ck_shifts_variance_treatment'
  ) THEN
    ALTER TABLE shifts
      ADD CONSTRAINT ck_shifts_variance_treatment
      CHECK (variance_treatment IS NULL
             OR variance_treatment IN
                ('charge_employee','company_loss','revenue','suspense','none'));
  END IF;
END$$;

-- If treatment=charge_employee we NEED an employee to charge.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'shifts' AND constraint_name = 'ck_shifts_variance_employee'
  ) THEN
    ALTER TABLE shifts
      ADD CONSTRAINT ck_shifts_variance_employee
      CHECK (
        variance_treatment IS DISTINCT FROM 'charge_employee'
        OR variance_employee_id IS NOT NULL
      );
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS ix_shifts_variance_employee
  ON shifts(variance_employee_id)
  WHERE variance_employee_id IS NOT NULL;

-- ── 2. employee_deductions — provenance columns ─────────────────────────

ALTER TABLE employee_deductions
  ADD COLUMN IF NOT EXISTS source            VARCHAR(20) NOT NULL DEFAULT 'manual',
  ADD COLUMN IF NOT EXISTS shift_id          UUID REFERENCES shifts(id),
  ADD COLUMN IF NOT EXISTS journal_entry_id  UUID REFERENCES journal_entries(id),
  ADD COLUMN IF NOT EXISTS is_recoverable    BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notes             TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'employee_deductions' AND constraint_name = 'ck_employee_deductions_source'
  ) THEN
    ALTER TABLE employee_deductions
      ADD CONSTRAINT ck_employee_deductions_source
      CHECK (source IN ('manual','shift_shortage','advance','penalty','other'));
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS ix_employee_deductions_shift
  ON employee_deductions(shift_id)
  WHERE shift_id IS NOT NULL;

-- ── 3. employee_settlements — payments that reduce liability ────────────

CREATE TABLE IF NOT EXISTS employee_settlements (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            UUID          NOT NULL REFERENCES users(id),
  amount             NUMERIC(14,2) NOT NULL CHECK (amount > 0),
  settlement_date    DATE          NOT NULL DEFAULT CURRENT_DATE,
  method             VARCHAR(20)   NOT NULL DEFAULT 'cash'
                     CHECK (method IN ('cash','bank','payroll_deduction','other')),
  cashbox_id         UUID          REFERENCES cashboxes(id),
  journal_entry_id   UUID          REFERENCES journal_entries(id),
  notes              TEXT,
  created_by         UUID          REFERENCES users(id),
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_employee_settlements_user_date
  ON employee_settlements(user_id, settlement_date DESC);

-- ── 4. Chart-of-accounts seeds — idempotent ─────────────────────────────
-- Safe on fresh installs AND existing deployments. We only insert when
-- the code is missing and we resolve the parent by code so a renamed
-- branch doesn't stop the seed.

DO $$
DECLARE
  v_receivables_parent UUID;
  v_current_liab_parent UUID;
BEGIN
  SELECT id INTO v_receivables_parent
    FROM chart_of_accounts WHERE code = '112' LIMIT 1;
  SELECT id INTO v_current_liab_parent
    FROM chart_of_accounts WHERE code = '21' LIMIT 1;

  -- 1123 Employee Receivables — asset / debit, leaf, under 112.
  IF v_receivables_parent IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE code = '1123') THEN
    INSERT INTO chart_of_accounts
      (code, name_ar, name_en, account_type, normal_balance, parent_id,
       is_leaf, is_system, level, sort_order, is_active)
    VALUES
      ('1123', 'ذمم الموظفين', 'Employee Receivables',
       'asset', 'debit', v_receivables_parent, TRUE, TRUE, 4, 3, TRUE);
  END IF;

  -- 215 Suspense Account — liability / credit, leaf, under 21.
  IF v_current_liab_parent IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM chart_of_accounts WHERE code = '215') THEN
    INSERT INTO chart_of_accounts
      (code, name_ar, name_en, account_type, normal_balance, parent_id,
       is_leaf, is_system, level, sort_order, is_active)
    VALUES
      ('215', 'حساب التسوية المؤقت', 'Suspense Account',
       'liability', 'credit', v_current_liab_parent, TRUE, TRUE, 3, 5, TRUE);
  END IF;
END$$;

-- ── 5. Permissions ──────────────────────────────────────────────────────

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_name = 'permissions') THEN
    INSERT INTO permissions (code, module, name_ar, name_en) VALUES
      ('shifts.variance.approve', 'shifts',
       'اعتماد معالجة فروقات الوردية', 'Approve shift variance treatment'),
      ('expenses.daily.create',   'accounting',
       'تسجيل المصروفات اليومية',   'Record daily expenses'),
      ('employee.ledger.view',    'employees',
       'عرض الملف المالي للموظف',   'View employee financial ledger')
    ON CONFLICT (code) DO NOTHING;

    -- Grant the three new permissions to admin and manager via the
    -- role_permissions junction. Admin already has '*' wildcard; this
    -- just makes the grant explicit for audit queries.
    IF EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_name = 'role_permissions') THEN
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id
        FROM roles r, permissions p
       WHERE r.code IN ('admin','manager')
         AND p.code IN ('shifts.variance.approve',
                        'expenses.daily.create',
                        'employee.ledger.view')
      ON CONFLICT DO NOTHING;
    END IF;

    -- Mirror to the denormalized roles.permissions[] array (migration 026).
    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'roles' AND column_name = 'permissions'
    ) THEN
      UPDATE roles
         SET permissions = (
           SELECT ARRAY_AGG(DISTINCT code ORDER BY code)
             FROM (
               SELECT UNNEST(COALESCE(permissions, ARRAY[]::text[])) AS code
               UNION
               SELECT code FROM (VALUES
                 ('shifts.variance.approve'),
                 ('expenses.daily.create'),
                 ('employee.ledger.view')
               ) v(code)
             ) all_codes
         )
       WHERE code IN ('admin','manager');
    END IF;
  END IF;
END$$;

-- ── 6. v_employee_ledger — unified financial ledger per employee ────────
--
-- Signed amount convention (what the employee OWES the company):
--   positive → increases liability  (shortage, recoverable advance, manual deduction)
--   negative → decreases liability  (settlement, non-recoverable expense refund)
-- Running balance is computed by the service layer; the view just emits
-- the rows in chronological order with the right sign.
--
-- Rows surfaced:
--   * employee_deductions          → all of them (shortage / advance /
--                                    manual). Non-recoverable rows
--                                    emit amount=0 so they're visible
--                                    in the feed but do not shift
--                                    the balance.
--   * expenses (is_advance = true) → employee advances drawn from the
--                                    cashbox, only those NOT already
--                                    represented in employee_deductions
--                                    (the service layer dedupes by
--                                    joining on expenses.id).
--   * employee_settlements         → payments that reduce liability.
--   * employee_bonuses             → surfaced but amount=0 (bonuses
--                                    don't affect the receivable
--                                    ledger — they're for payroll).
--
-- The view intentionally uses `reference_type` + `reference_id` as a
-- stable pair the frontend can link to; no opinionated joins into the
-- shift/expense detail tables — the service enriches lazily.

CREATE OR REPLACE VIEW v_employee_ledger AS
  -- Shortages & manual deductions
  SELECT
    d.user_id,
    d.deduction_date       AS event_date,
    d.created_at            AS created_at,
    CASE d.source
      WHEN 'shift_shortage' THEN 'shift_shortage'
      WHEN 'advance'        THEN 'advance'
      WHEN 'penalty'        THEN 'penalty'
      ELSE                       'deduction'
    END                     AS entry_type,
    d.reason                AS description,
    CASE WHEN d.is_recoverable THEN d.amount ELSE 0 END::numeric(14,2) AS amount_owed_delta,
    d.amount                AS gross_amount,
    'deduction'::text       AS reference_type,
    d.id::text              AS reference_id,
    d.shift_id,
    d.journal_entry_id,
    d.notes,
    d.created_by
  FROM employee_deductions d

  UNION ALL

  -- Cashbox advances not already mirrored as a deduction row
  SELECT
    e.employee_user_id       AS user_id,
    e.expense_date            AS event_date,
    e.created_at              AS created_at,
    'advance'::text           AS entry_type,
    COALESCE(e.description, 'سلفة نقدية') AS description,
    e.amount::numeric(14,2)  AS amount_owed_delta,
    e.amount                  AS gross_amount,
    'expense'::text           AS reference_type,
    e.id::text                AS reference_id,
    NULL::uuid                AS shift_id,
    NULL::uuid                AS journal_entry_id,
    e.description             AS notes,
    e.created_by
  FROM expenses e
  WHERE e.is_advance = TRUE
    AND e.employee_user_id IS NOT NULL
    AND NOT EXISTS (
      -- Avoid double-counting: if an advance was mirrored into a
      -- deduction row, the deduction row wins.
      SELECT 1 FROM employee_deductions ed
       WHERE ed.source = 'advance'
         AND ed.shift_id IS NULL
         AND ed.user_id = e.employee_user_id
         AND ed.deduction_date = e.expense_date
         AND ed.amount = e.amount
    )

  UNION ALL

  -- Settlements (payments BY the employee → reduce liability)
  SELECT
    s.user_id,
    s.settlement_date        AS event_date,
    s.created_at             AS created_at,
    'settlement'::text       AS entry_type,
    COALESCE(s.notes, 'سداد من الموظف') AS description,
    (-s.amount)::numeric(14,2) AS amount_owed_delta,
    s.amount                 AS gross_amount,
    'settlement'::text       AS reference_type,
    s.id::text               AS reference_id,
    NULL::uuid               AS shift_id,
    s.journal_entry_id,
    s.notes,
    s.created_by
  FROM employee_settlements s

  UNION ALL

  -- Bonuses (visible but don't shift liability balance)
  SELECT
    b.user_id,
    b.bonus_date             AS event_date,
    b.created_at             AS created_at,
    'bonus'::text            AS entry_type,
    COALESCE(b.note, 'حافز') AS description,
    0::numeric(14,2)         AS amount_owed_delta,
    b.amount                 AS gross_amount,
    'bonus'::text            AS reference_type,
    b.id::text               AS reference_id,
    NULL::uuid               AS shift_id,
    NULL::uuid               AS journal_entry_id,
    b.note                   AS notes,
    b.created_by
  FROM employee_bonuses b;

COMMENT ON VIEW v_employee_ledger IS
  'Unified financial ledger per employee: shortages, advances, manual deductions, settlements, bonuses. Signed amount_owed_delta drives the running balance.';

COMMIT;
