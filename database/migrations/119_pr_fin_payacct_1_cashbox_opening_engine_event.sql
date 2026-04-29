-- ============================================================================
-- 119 — PR-FIN-PAYACCT-1: cashbox opening becomes a real engine event
-- ============================================================================
--
-- The pre-merge audit (`PR-FIN-PAYACCT-1` audit report) established that
-- `cashboxes.opening_balance` was being set verbatim at INSERT time
-- alongside `cashboxes.current_balance` with NO offsetting journal_entry
-- and NO `cashbox_transactions` row. Net effect for any cashbox created
-- with a non-zero opening: a one-sided amount of money would appear in
-- `current_balance` with no DR/CR pair against capital (code 31), and the
-- GL 1111/1113/1114/1115 buckets would understate by exactly that amount.
--
-- Production currently has 0 cashboxes with `opening_balance > 0` so the
-- bug has never fired, but the moment any tenant creates a bank/wallet
-- with an opening figure, the balance-vs-GL invariant breaks.
--
-- This migration is the DB-side half of the fix:
--
--   1. Add two nullable trace columns to `cashboxes` so each row links
--      back to the engine-posted opening JE and remembers when it was
--      posted. Both NULL on rows that never had an opening movement
--      (e.g. opening = 0) — that's the tell-tale.
--
--   2. Promote the engine's existing SELECT-then-INSERT idempotency
--      check on `(reference_type, reference_id)` to a real DB-enforced
--      partial unique index. Two retries from the same caller can no
--      longer race-condition their way to a duplicate posted JE.
--      Audit pre-check confirmed zero duplicates exist before this
--      migration so adding the index can never reject existing data.
--
-- The application-layer change (createCashbox writing
-- `current_balance=0, opening_balance=0` then calling
-- `engine.recordTransaction({reference_type:'cashbox_opening', ...})`)
-- ships in the same PR but lives in `backend/src/cash-desk/cash-desk.service.ts`.
--
-- Audit: /Users/mohamedzahran/Documents/Claude/Projects/Zahran (this repo,
-- chat: PR-FIN-PAYACCT-1 reconciliation chapter)
--
-- Read-only invariants this migration MUST preserve:
--   • trial balance balanced (verified before merge: DR=CR=1,466,574.40)
--   • v_cash_position drift = 0 for every existing cashbox
--   • engine_bypass_alerts: no new rows from this migration
--   • no cashbox row touched (only ALTER + CREATE INDEX, no UPDATEs)
-- ============================================================================

BEGIN;

-- ── Trace columns on cashboxes ────────────────────────────────────────────
-- Both NULL on rows that never had an opening movement. Populated at
-- create-time by the new application flow:
--   opening_journal_entry_id  ← entry_id returned by the engine
--   opening_posted_at         ← NOW() at the moment the engine call
--                                returned `ok:true` (NOT skipped:true)
-- For idempotent replays we leave them at their first-write values.

ALTER TABLE cashboxes
  ADD COLUMN IF NOT EXISTS opening_journal_entry_id uuid
    REFERENCES journal_entries(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS opening_posted_at timestamptz;

COMMENT ON COLUMN cashboxes.opening_journal_entry_id IS
  'PR-FIN-PAYACCT-1: link to the journal_entries row that posted this '
  'cashbox''s opening balance (reference_type=''cashbox_opening''). NULL '
  'on cashboxes created with opening=0 or before this migration.';

COMMENT ON COLUMN cashboxes.opening_posted_at IS
  'PR-FIN-PAYACCT-1: timestamp the opening JE was posted (set once on '
  'first successful engine write). NULL on cashboxes with no opening '
  'movement.';

-- ── DB-enforced engine idempotency on (reference_type, reference_id) ─────
-- The engine already guards retries via SELECT-then-INSERT inside
-- `recordTransaction`. This index is the second backstop: the unique
-- constraint guarantees no duplicate posted+non-void entry can land on
-- the same business reference even if two calls race past the SELECT
-- check (same connection pool, same micro-second).
--
-- Predicate matches the engine's idempotency clause exactly:
--   `WHERE is_posted = TRUE AND is_void = FALSE`
-- so reversed/voided entries don't block their replacements.
--
-- Pre-check (run as part of audit, 2026-04-29):
--   SELECT reference_type, reference_id, count(*)
--   FROM journal_entries
--   WHERE is_posted=TRUE AND is_void=FALSE
--     AND reference_type IS NOT NULL AND reference_id IS NOT NULL
--   GROUP BY 1,2 HAVING count(*) > 1;
--   → 0 rows. Index can be created without a backfill cleanup.

CREATE UNIQUE INDEX IF NOT EXISTS uq_je_idempotent_engine_ref
  ON journal_entries(reference_type, reference_id)
  WHERE is_posted = TRUE AND is_void = FALSE;

COMMENT ON INDEX uq_je_idempotent_engine_ref IS
  'PR-FIN-PAYACCT-1: DB-enforced engine idempotency. Promotes the '
  'service-layer SELECT-then-INSERT guard in '
  'FinancialEngineService.recordTransaction into a hard constraint so '
  'racing retries cannot post twice on the same business reference. '
  'Predicate matches the engine''s idempotency check.';

COMMIT;
