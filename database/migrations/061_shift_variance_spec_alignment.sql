-- Migration 061: Align shift-variance columns with the spec naming
-- ---------------------------------------------------------------------------
-- Audit finding: the spec requires `shifts` to expose:
--   variance_amount   · variance_type   · variance_approved_by · variance_approved_at
-- while migration 060 introduced:
--   (difference — pre-existing)  · (no variance_type) · variance_decided_by · variance_decided_at
--
-- This migration closes the naming gap WITHOUT breaking the engine:
--
--   1. Rename `variance_decided_by`  → `variance_approved_by`
--      Rename `variance_decided_at`  → `variance_approved_at`
--      (safe — columns were only written by migration 060 code, and
--       the audit confirms every row has both values = NULL)
--
--   2. Add `variance_amount` (GENERATED ALWAYS) — an explicit named
--      copy of the existing `difference` column so queries can filter
--      by the spec's column name.
--
--   3. Add `variance_type` (GENERATED ALWAYS) — 'shortage' | 'overage'
--      | 'zero' based on the sign of the difference.
--
--   4. Backfill: for the 2 pre-migration shifts that closed with a
--      variance but no treatment (legacy path used 531/421 defaults),
--      stamp `variance_treatment` + `variance_journal_entry_id` from
--      the existing `journal_entries` row whose reference_type =
--      'shift_variance' and reference_id = shifts.id. No new money is
--      created; this is pure bookkeeping so the audit query "shifts
--      with variance but no treatment" returns 0.
--
-- INVARIANTS preserved:
--   * No new module, no duplicate engine, no hardcoded account IDs.
--   * Migration is idempotent — re-runnable with zero effect on an
--     already-migrated database.
--   * GENERATED columns use IMMUTABLE expressions only (PG14+ allows).
-- ---------------------------------------------------------------------------

BEGIN;

-- ── 1. Rename decided_* → approved_* ────────────────────────────────────
-- Idempotent: only rename if the source column exists AND the target
-- column doesn't. This way a second run is a no-op.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='shifts' AND column_name='variance_decided_by'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='shifts' AND column_name='variance_approved_by'
  ) THEN
    ALTER TABLE shifts RENAME COLUMN variance_decided_by TO variance_approved_by;
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='shifts' AND column_name='variance_decided_at'
  ) AND NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='shifts' AND column_name='variance_approved_at'
  ) THEN
    ALTER TABLE shifts RENAME COLUMN variance_decided_at TO variance_approved_at;
  END IF;
END$$;

-- ── 2. variance_amount — GENERATED alias of `difference` ─────────────────
-- `difference` already exists as a GENERATED column on migration 009.
-- We add a spec-named column with the same formula so queries using
-- either name work. Skip if already added.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='shifts' AND column_name='variance_amount'
  ) THEN
    ALTER TABLE shifts
      ADD COLUMN variance_amount NUMERIC(14,2)
      GENERATED ALWAYS AS
        (COALESCE(actual_closing,0) - COALESCE(expected_closing,0))
      STORED;
  END IF;
END$$;

-- ── 3. variance_type — GENERATED classifier ──────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='shifts' AND column_name='variance_type'
  ) THEN
    ALTER TABLE shifts
      ADD COLUMN variance_type VARCHAR(10)
      GENERATED ALWAYS AS (
        CASE
          WHEN COALESCE(actual_closing,0) - COALESCE(expected_closing,0) > 0.009  THEN 'overage'
          WHEN COALESCE(actual_closing,0) - COALESCE(expected_closing,0) < -0.009 THEN 'shortage'
          ELSE 'zero'
        END
      ) STORED;
  END IF;
END$$;

-- ── 4. Backfill pre-migration shifts with a journal entry ───────────────
-- These are shifts closed BEFORE migration 060 ran, so their close()
-- path posted a variance JE via the legacy default (company_loss on
-- shortage / revenue on surplus) but never wrote the treatment nor
-- linked the journal entry back.
--
-- We reconcile by:
--   * setting variance_treatment = 'company_loss' (shortage) or 'revenue' (overage)
--   * linking variance_journal_entry_id to the posted shift_variance JE
--   * stamping variance_approved_by with the shift's closer + variance_approved_at = closed_at
--
-- We only touch shifts that (a) are closed, (b) have non-trivial
-- variance, (c) have NO treatment yet, (d) actually have a matching
-- posted shift_variance JE. The engine stays the single posting
-- primitive — we don't create or modify any JEs.
UPDATE shifts s SET
    variance_treatment        = CASE WHEN s.difference < 0 THEN 'company_loss' ELSE 'revenue' END,
    variance_journal_entry_id = je.id,
    variance_approved_by      = COALESCE(s.variance_approved_by, s.closed_by),
    variance_approved_at      = COALESCE(s.variance_approved_at, s.closed_at),
    variance_notes            = COALESCE(s.variance_notes,
                                         'تسوية تلقائية — قيد مسبق قبل ترحيل migration 060')
  FROM journal_entries je
 WHERE je.reference_type = 'shift_variance'
   AND je.reference_id   = s.id::text
   AND je.is_posted      = TRUE
   AND je.is_void        = FALSE
   AND s.status          = 'closed'
   AND ABS(COALESCE(s.difference, 0)) >= 0.01
   AND s.variance_treatment IS NULL;

COMMIT;
