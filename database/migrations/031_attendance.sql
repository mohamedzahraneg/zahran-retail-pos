-- 031_attendance.sql
-- Employee attendance (clock-in / clock-out) tracking.
--
-- Model:
--   attendance_records: one row per day per user. clock_in is set on first
--   check-in, clock_out is set on the last check-out. Duration is derived.
--   Additional breaks can be logged in attendance_events for granular timing.

CREATE TABLE IF NOT EXISTS attendance_records (
    id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    work_date    date NOT NULL,
    clock_in     timestamptz,
    clock_out    timestamptz,
    duration_min integer GENERATED ALWAYS AS (
        CASE
            WHEN clock_in IS NOT NULL AND clock_out IS NOT NULL
            THEN EXTRACT(EPOCH FROM (clock_out - clock_in))::int / 60
            ELSE NULL
        END
    ) STORED,
    note         text,
    ip_in        inet,
    ip_out       inet,
    device_in    jsonb,
    device_out   jsonb,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id, work_date)
);

CREATE INDEX IF NOT EXISTS idx_attendance_user_date ON attendance_records(user_id, work_date DESC);
CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance_records(work_date DESC);

-- updated_at trigger
CREATE OR REPLACE FUNCTION fn_attendance_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

DROP TRIGGER IF EXISTS trg_attendance_updated_at ON attendance_records;
CREATE TRIGGER trg_attendance_updated_at
    BEFORE UPDATE ON attendance_records
    FOR EACH ROW EXECUTE FUNCTION fn_attendance_updated_at();

-- attach audit trigger (uses existing fn_audit_row)
DROP TRIGGER IF EXISTS trg_audit_attendance ON attendance_records;
CREATE TRIGGER trg_audit_attendance
    AFTER INSERT OR UPDATE OR DELETE ON attendance_records
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
