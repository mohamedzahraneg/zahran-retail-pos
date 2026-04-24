-- Migration 082 — Employee payable-days table + wage-accrual scaffolding.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Today's Employee Profile shows "مستحق حتى الآن" as a pure
--   service-side calculation: `days_present × daily_wage`. It has no
--   row in any table and no GL posting, so:
--     * recomputing it can silently drift from the numbers a user saw
--       yesterday;
--     * voiding an individual wage day is impossible;
--     * the canonical GL balance (v_employee_gl_balance) never reflects
--       earned-but-unpaid wages.
--
--   New workflow:
--     attendance_records  →  employee_payable_days (wage_accrual row)
--                         →  journal_entries (DR 521 / CR 213)
--     settlement (pay)    →  employee_settlements (DR 213 / CR cashbox)
--
--   This migration creates the payable-days table. The stored procs
--   that post GL and the admin endpoints that call them land in
--   migrations 083–084 and the backend patch.
--
-- Strict rules (baked into the schema)
--
--   * One live wage_accrual row per (user_id, work_date) — partial
--     UNIQUE WHERE NOT is_void. A voided row can be re-created.
--   * source='admin_manual' MUST carry a reason.
--   * amount_accrued must be non-negative.
--   * journal_entry_id is set by fn_post_employee_wage_accrual and
--     must never be NULL for a live row — enforced as a CHECK.
--   * void fields come together: either all NULL or all set.
--
-- What this migration does NOT touch
--
--   * attendance_records, employee_bonuses, employee_deductions,
--     employee_settlements, employee_transactions, expenses,
--     journal_entries, journal_lines
--   * FinancialEngine or any engine-context guard
--   * Any balance / cashbox / trial aggregate
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.employee_payable_days (
    id                       uuid        PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id                  uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    work_date                date        NOT NULL,
    kind                     text        NOT NULL DEFAULT 'wage_accrual'
                                         CHECK (kind IN ('wage_accrual')),
    source                   text        NOT NULL
                                         CHECK (source IN ('attendance','admin_manual')),
    attendance_record_id     uuid        NULL REFERENCES attendance_records(id) ON DELETE SET NULL,
    worked_minutes           int         NULL CHECK (worked_minutes IS NULL OR worked_minutes >= 0),
    daily_wage_snapshot      numeric(14,2) NOT NULL CHECK (daily_wage_snapshot >= 0),
    target_minutes_snapshot  int         NULL CHECK (target_minutes_snapshot IS NULL OR target_minutes_snapshot > 0),
    amount_accrued           numeric(14,2) NOT NULL CHECK (amount_accrued >= 0),
    journal_entry_id         uuid        NULL REFERENCES journal_entries(id) ON DELETE RESTRICT,
    reason                   text        NULL,
    is_void                  boolean     NOT NULL DEFAULT FALSE,
    void_reason              text        NULL,
    voided_at                timestamptz NULL,
    voided_by                uuid        NULL REFERENCES users(id) ON DELETE SET NULL,
    created_by               uuid        NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    created_at               timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT chk_payable_day_admin_manual_reason
      CHECK (source <> 'admin_manual' OR (reason IS NOT NULL AND length(btrim(reason)) > 0)),

    CONSTRAINT chk_payable_day_void_fields_together
      CHECK (
        (is_void = FALSE AND void_reason IS NULL AND voided_at IS NULL AND voided_by IS NULL)
        OR
        (is_void = TRUE  AND void_reason IS NOT NULL AND voided_at IS NOT NULL AND voided_by IS NOT NULL)
      )
);

-- One live wage_accrual per (user, date). Voided rows are ignored so
-- admin can void + re-create.
CREATE UNIQUE INDEX IF NOT EXISTS uq_payable_day_user_date_live
  ON public.employee_payable_days (user_id, work_date)
  WHERE is_void = FALSE AND kind = 'wage_accrual';

CREATE INDEX IF NOT EXISTS ix_payable_day_user_date
  ON public.employee_payable_days (user_id, work_date DESC);

CREATE INDEX IF NOT EXISTS ix_payable_day_work_date
  ON public.employee_payable_days (work_date DESC);

CREATE INDEX IF NOT EXISTS ix_payable_day_attendance
  ON public.employee_payable_days (attendance_record_id)
  WHERE attendance_record_id IS NOT NULL;

COMMENT ON TABLE  public.employee_payable_days IS
  'One row per employee/work-date/kind. Records a day earned by the employee (wage_accrual today) and links it to the GL posting (journal_entry_id) that moved DR 521 / CR 213. Settlement payouts live in employee_settlements, not here.';
COMMENT ON COLUMN public.employee_payable_days.source IS
  '"attendance" = created from a real attendance_records row. "admin_manual" = admin marked a payable day without attendance, reason required.';
COMMENT ON COLUMN public.employee_payable_days.amount_accrued IS
  'EGP credited to the employee for this day. Full-day rule (current): equals daily_wage_snapshot. Pro-rating by worked_hours/target_hours is intentionally not applied.';

-- Audit trigger reusing the generic audit function (mirrors migration 031's pattern).
DROP TRIGGER IF EXISTS trg_audit_employee_payable_days ON public.employee_payable_days;
CREATE TRIGGER trg_audit_employee_payable_days
AFTER INSERT OR UPDATE OR DELETE ON public.employee_payable_days
FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

COMMIT;
