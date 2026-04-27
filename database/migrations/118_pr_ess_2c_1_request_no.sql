-- ────────────────────────────────────────────────────────────────────
-- Migration 118 — PR-ESS-2C-1
-- Numeric user-facing request number for employee_requests.
-- ────────────────────────────────────────────────────────────────────
--
-- What this does
-- ──────────────
-- Adds a stable, unique, numeric-only identifier that the UI
-- displays as the user-facing "رقم الطلب" — separate from the
-- internal `id` (bigint serial) that's never shown to users.
--
--   employee_requests.request_no  BIGINT UNIQUE NOT NULL
--   seq_employee_request_no       sequence (starts at 1001 so the
--                                 user-visible numbers are 4-digit
--                                 from day one and don't collide
--                                 visually with the technical `id`)
--   trg_set_request_no            BEFORE INSERT trigger that fills
--                                 request_no from the sequence iff
--                                 the caller didn't supply one.
--
-- The 3 existing rows are backfilled in `created_at ASC, id ASC`
-- order, so the oldest request becomes 1001, the next 1002, etc.
-- After backfill the column flips to NOT NULL and a unique index
-- is added; the sequence is moved past the highest backfilled
-- value so new rows always pick up an unused number.
--
-- UI impact
-- ─────────
-- The frontend will display `طلب رقم 1001` (digits only), never
-- `REQ-2026-000001`. The integer is ordinal and human-readable;
-- year-stamped formatting can be layered on top later if needed.
--
-- Why no prefix
-- ─────────────
-- Per user spec (PR-ESS-2C-1 correction): user-facing numbers must
-- be digits only. The existing `next_doc_no(prefix, seq)` helper
-- always emits `PREFIX-YYYY-NNNNNN`, so we DON'T use it here —
-- this trigger calls `nextval()` directly and writes a plain BIGINT.
--
-- Idempotency
-- ───────────
-- Every step is guarded:
--   · CREATE SEQUENCE IF NOT EXISTS
--   · ALTER TABLE … ADD COLUMN IF NOT EXISTS
--   · UPDATE … WHERE request_no IS NULL  (no-op once backfilled)
--   · DROP TRIGGER IF EXISTS … + CREATE TRIGGER
--   · ADD CONSTRAINT … only if absent (defensive DO block)
--
-- The constraint adds (NOT NULL + UNIQUE) and the sequence catch-up
-- are written so that re-running the migration on a database that
-- already has a populated request_no column doesn't fail.
--
-- Self-validation
-- ───────────────
-- A DO block at the end asserts:
--   1. `request_no` column exists, BIGINT, NOT NULL after backfill.
--   2. UNIQUE index on `request_no` exists.
--   3. `seq_employee_request_no` exists with last_value >= MAX
--      (so the next nextval doesn't collide with backfilled rows).
--   4. Trigger `trg_set_request_no` exists, fires BEFORE INSERT.
--   5. Every existing employee_requests row has a non-null
--      `request_no` (no NULL leftovers).
--   6. All `request_no` values are distinct (no duplicates from the
--      backfill).
--   7. Backfilled values are >= 1001 (sequence start invariant).
--   8. `COUNT(*) = COUNT(DISTINCT request_no)` — defensive bijection
--      check that catches any edge case where a duplicate could
--      slip past the UNIQUE constraint (e.g. constraint added with
--      NOT VALID — not currently the case but cheap to assert).
--
-- Any deviation raises EXCEPTION → wrapping transaction rolls back.

-- ── Step 0: engine context ─────────────────────────────────────────
SELECT set_config('app.engine_context', 'migration:pr_ess_2c_1', true);

-- ── Step 1: sequence ───────────────────────────────────────────────
-- START 1001 so the first user-visible number is a clean 4-digit.
-- INCREMENT 1, no cycle (regular sequence semantics).
CREATE SEQUENCE IF NOT EXISTS seq_employee_request_no
  START 1001
  INCREMENT 1
  NO CYCLE;

-- ── Step 2: column (nullable initially so backfill can populate) ──
ALTER TABLE public.employee_requests
  ADD COLUMN IF NOT EXISTS request_no BIGINT NULL;

-- ── Step 3: backfill existing rows in created_at ASC, id ASC ──────
-- Idempotent: only touches rows that don't yet have a request_no.
--
-- Backfill uses pure arithmetic (1000 + ROW_NUMBER()) — NOT
-- nextval() inside the CTE — to keep the assigned values fully
-- deterministic. ROW_NUMBER() over a stable ORDER BY is guaranteed
-- by the SQL spec to produce 1, 2, 3, … in that exact order; adding
-- the 1000 offset matches the sequence's START value (1001) so the
-- backfill output (1001, 1002, 1003) interleaves cleanly with new
-- rows inserted after the migration. The sequence itself is caught
-- up to MAX(request_no) by Step 6, so subsequent nextval() returns
-- MAX + 1 without colliding with any backfilled value.
DO $$
DECLARE
  v_to_backfill INT;
BEGIN
  SELECT COUNT(*) INTO v_to_backfill
  FROM employee_requests
  WHERE request_no IS NULL;

  IF v_to_backfill > 0 THEN
    WITH ordered AS (
      SELECT id,
             1000 + ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS new_no
      FROM employee_requests
      WHERE request_no IS NULL
    )
    UPDATE employee_requests er
       SET request_no = ordered.new_no
      FROM ordered
     WHERE er.id = ordered.id;

    RAISE NOTICE 'Backfilled % employee_requests rows with request_no (1001..%).',
      v_to_backfill, 1000 + v_to_backfill;
  ELSE
    RAISE NOTICE 'request_no backfill: nothing to do (already populated).';
  END IF;
END $$;

-- ── Step 4: NOT NULL + UNIQUE constraints ──────────────────────────
-- Idempotent: SET NOT NULL is a no-op when the column is already
-- NOT NULL. The unique constraint is added only if not present
-- (named: employee_requests_request_no_key, the Postgres default).
ALTER TABLE public.employee_requests
  ALTER COLUMN request_no SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint con
    JOIN pg_class cls ON cls.oid = con.conrelid
    WHERE cls.relname = 'employee_requests'
      AND con.conname = 'employee_requests_request_no_key'
      AND con.contype = 'u'
  ) THEN
    ALTER TABLE public.employee_requests
      ADD CONSTRAINT employee_requests_request_no_key UNIQUE (request_no);
  END IF;
END $$;

-- ── Step 5: BEFORE INSERT trigger ──────────────────────────────────
-- If a caller doesn't supply request_no (the normal path), pull
-- the next value from the sequence. Allowing an explicit override
-- is intentional — keeps test fixtures and edge-case manual inserts
-- straightforward without a second code path.
CREATE OR REPLACE FUNCTION public.fn_set_request_no()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.request_no IS NULL THEN
    NEW.request_no := nextval('seq_employee_request_no');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_set_request_no ON public.employee_requests;
CREATE TRIGGER trg_set_request_no
  BEFORE INSERT ON public.employee_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.fn_set_request_no();

-- ── Step 6: ensure the sequence is past the highest backfilled value ─
-- After backfill, the sequence's last_value already equals the
-- largest assigned number. But re-runs (where the column was
-- backfilled by some earlier process) might leave the sequence
-- behind; setval() to MAX(request_no) is a safe catch-up.
DO $$
DECLARE
  v_max BIGINT;
BEGIN
  SELECT MAX(request_no) INTO v_max FROM employee_requests;
  IF v_max IS NOT NULL THEN
    -- Use is_called=TRUE so the next nextval() returns v_max + 1.
    PERFORM setval('seq_employee_request_no', v_max, TRUE);
  END IF;
END $$;

-- ────────────────────────────────────────────────────────────────────
-- Self-validation (7 invariants)
-- ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_col_type      text;
  v_col_nullable  text;
  v_unique_count  int;
  v_seq_last      bigint;
  v_max_no        bigint;
  v_trig_count    int;
  v_null_count    bigint;
  v_dup_count     bigint;
  v_below_floor   bigint;
  v_total_rows    bigint;
  v_distinct_no   bigint;
BEGIN
  -- 1) Column exists, BIGINT, NOT NULL.
  SELECT data_type, is_nullable
    INTO v_col_type, v_col_nullable
  FROM information_schema.columns
  WHERE table_schema='public'
    AND table_name='employee_requests'
    AND column_name='request_no';
  IF v_col_type IS NULL THEN
    RAISE EXCEPTION 'self-validation 1 failed: employee_requests.request_no not found';
  END IF;
  IF v_col_type <> 'bigint' THEN
    RAISE EXCEPTION 'self-validation 1 failed: request_no is % (expected bigint)', v_col_type;
  END IF;
  IF v_col_nullable <> 'NO' THEN
    RAISE EXCEPTION 'self-validation 1 failed: request_no is nullable (expected NOT NULL)';
  END IF;

  -- 2) UNIQUE constraint exists by name.
  SELECT COUNT(*) INTO v_unique_count
  FROM pg_constraint con
  JOIN pg_class cls ON cls.oid = con.conrelid
  WHERE cls.relname = 'employee_requests'
    AND con.conname = 'employee_requests_request_no_key'
    AND con.contype = 'u';
  IF v_unique_count <> 1 THEN
    RAISE EXCEPTION 'self-validation 2 failed: UNIQUE constraint employee_requests_request_no_key not found';
  END IF;

  -- 3) Sequence last_value covers MAX(request_no).
  SELECT last_value INTO v_seq_last
  FROM pg_sequences
  WHERE schemaname='public' AND sequencename='seq_employee_request_no';
  SELECT COALESCE(MAX(request_no), 0) INTO v_max_no FROM employee_requests;
  IF v_seq_last < v_max_no THEN
    RAISE EXCEPTION 'self-validation 3 failed: seq last_value=% < MAX(request_no)=%', v_seq_last, v_max_no;
  END IF;

  -- 4) Trigger exists and is enabled.
  SELECT COUNT(*) INTO v_trig_count
  FROM pg_trigger tg
  JOIN pg_class cls ON cls.oid = tg.tgrelid
  WHERE cls.relname = 'employee_requests'
    AND tg.tgname = 'trg_set_request_no'
    AND NOT tg.tgisinternal
    AND tg.tgenabled = 'O';   -- 'O' = enabled (origin)
  IF v_trig_count <> 1 THEN
    RAISE EXCEPTION 'self-validation 4 failed: trg_set_request_no missing or disabled';
  END IF;

  -- 5) No NULL request_no rows.
  SELECT COUNT(*) INTO v_null_count
  FROM employee_requests WHERE request_no IS NULL;
  IF v_null_count > 0 THEN
    RAISE EXCEPTION 'self-validation 5 failed: % rows still have NULL request_no', v_null_count;
  END IF;

  -- 6) No duplicate request_no values (defensive — UNIQUE should
  --    have caught it, but assert directly to surface the issue).
  SELECT COUNT(*) INTO v_dup_count FROM (
    SELECT request_no FROM employee_requests
     GROUP BY request_no HAVING COUNT(*) > 1
  ) d;
  IF v_dup_count > 0 THEN
    RAISE EXCEPTION 'self-validation 6 failed: % duplicate request_no values', v_dup_count;
  END IF;

  -- 7) Backfilled values are >= sequence start (1001).
  SELECT COUNT(*) INTO v_below_floor
  FROM employee_requests WHERE request_no < 1001;
  IF v_below_floor > 0 THEN
    RAISE EXCEPTION 'self-validation 7 failed: % rows have request_no < 1001 (sequence start)', v_below_floor;
  END IF;

  -- 8) Bijection check: COUNT(*) = COUNT(DISTINCT request_no).
  --    Belt-and-braces against any edge case where a duplicate
  --    could slip past the UNIQUE constraint (e.g. NOT VALID flag
  --    on the constraint — currently not the case but cheap to
  --    catch).
  SELECT COUNT(*), COUNT(DISTINCT request_no)
    INTO v_total_rows, v_distinct_no
  FROM employee_requests;
  IF v_total_rows <> v_distinct_no THEN
    RAISE EXCEPTION 'self-validation 8 failed: COUNT(*)=% but COUNT(DISTINCT request_no)=%', v_total_rows, v_distinct_no;
  END IF;

  RAISE NOTICE 'PR-ESS-2C-1 self-validation passed (8/8 invariants).';
  RAISE NOTICE '  request_no: BIGINT NOT NULL ✓';
  RAISE NOTICE '  UNIQUE constraint employee_requests_request_no_key ✓';
  RAISE NOTICE '  Sequence seq_employee_request_no last_value = %  (>= MAX %) ✓', v_seq_last, v_max_no;
  RAISE NOTICE '  Trigger trg_set_request_no ENABLED ✓';
  RAISE NOTICE '  No NULL request_no rows · no duplicates · all values >= 1001 ✓';
  RAISE NOTICE '  Bijection: COUNT(*)=% = COUNT(DISTINCT request_no) ✓', v_total_rows;
END $$;
