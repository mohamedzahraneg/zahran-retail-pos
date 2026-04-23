-- Migration 067: drop the leftover DEFERRABLE unique constraint on financial_anomalies
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Migration 066 tried to drop the original DEFERRABLE UNIQUE on
-- financial_anomalies but guessed the constraint name wrong:
--   guessed:      financial_anomalies_anomaly_type_affected_entity_reference_key
--   actual name:  financial_anomalies_anomaly_type_affected_entity_reference__key
--                 (PG auto-truncates to 63 chars and adds __key with double underscore
--                  when the natural name would exceed the identifier length limit)
--
-- The IF EXISTS check silently returned false → the DROP was skipped →
-- 066 only ADDED the new `ux_anomalies_open_slot` UNIQUE. Now both
-- constraints coexist and ON CONFLICT still picks the DEFERRABLE one
-- as arbiter, re-raising the original error.
--
-- This migration finishes the job: drop ANY deferrable UNIQUE on the
-- anomaly dedup columns, regardless of name.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT conname
      FROM pg_constraint
     WHERE conrelid = 'financial_anomalies'::regclass
       AND contype  = 'u'
       AND condeferrable = TRUE
  LOOP
    EXECUTE format('ALTER TABLE financial_anomalies DROP CONSTRAINT %I', r.conname);
    RAISE NOTICE 'dropped deferrable unique: %', r.conname;
  END LOOP;
END$$;

COMMIT;
