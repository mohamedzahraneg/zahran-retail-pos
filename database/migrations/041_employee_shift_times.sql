-- 041_employee_shift_times.sql
-- -----------------------------------------------------------------------------
-- Adds per-employee shift schedule so we can detect late-arrival and
-- early-departure at clock-in / clock-out time and surface warnings
-- on the employee dashboard.
--
-- Additive only — existing users default to NULL shift times, which
-- disables the warnings for them until the admin fills them in.
-- -----------------------------------------------------------------------------

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS shift_start_time TIME,
  ADD COLUMN IF NOT EXISTS shift_end_time   TIME,
  ADD COLUMN IF NOT EXISTS late_grace_min   INT NOT NULL DEFAULT 10;
