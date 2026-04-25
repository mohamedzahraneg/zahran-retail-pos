-- Migration 095 — Add employee_settlements.shift_id (PR-15 / PR-A).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Mirrors migration 093 which added expenses.shift_id. Today an
--   employee settlement (DR 213 / CR cashbox) physically leaves the
--   drawer but carries no shift reference, so shift-closing has to
--   *derive* the linkage from (cashbox_id + created_at window) — see
--   shifts.service.ts.computeSummary's settlement query added in
--   PR-14. That works when exactly one shift was open on the cashbox
--   at the time, but fails ambiguously when two shifts overlap. With
--   an explicit column the link badge becomes "مرتبط بالوردية"
--   (explicit) instead of "مرتبط تلقائياً بالوردية" (derived).
--
-- Change
--
--   1. ADD COLUMN employee_settlements.shift_id UUID NULL
--      REFERENCES shifts(id) ON DELETE SET NULL — soft FK so deleting
--      a shift in dev doesn't cascade-orphan settlement history.
--   2. CREATE INDEX ix_employee_settlements_shift on (shift_id) for
--      the per-shift summary query. Partial — only rows with a shift
--      link occupy index space.
--   3. Backfill: for each historical settlement, find the single
--      shift whose cashbox + window contains its created_at.
--      Skipped for rows with multiple matches or no cashbox.
--
-- Not touched
--   * Any GL line, journal_entry, or cashbox_transaction.
--   * fn_record_cashbox_txn or its callers.
--   * FinancialEngine.
--   * Any accounting math.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

ALTER TABLE public.employee_settlements
  ADD COLUMN IF NOT EXISTS shift_id uuid NULL
    REFERENCES public.shifts(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS ix_employee_settlements_shift
  ON public.employee_settlements (shift_id)
  WHERE shift_id IS NOT NULL;

COMMENT ON COLUMN public.employee_settlements.shift_id IS
  'Open/pending shift the settlement was paid out from. Auto-set when
   the user picks the open shift in the Pay Wage modal (PR-15);
   backfilled where unambiguous. NULL when paid from a direct cashbox
   or when the historical row spans multiple overlapping shifts.';

-- ─── Backfill: only the unambiguous case ──────────────────────────────────
-- Same pattern as migration 093 (expenses.shift_id backfill). For each
-- settlement whose cashbox is set, count how many shifts on that cashbox
-- enclose its created_at. Backfill only when count = 1.

DO $$
DECLARE
  v_updated int;
BEGIN
  PERFORM set_config(
    'app.engine_context',
    'migration:095_employee_settlements_shift_linkage',
    true
  );

  WITH candidate AS (
    SELECT es.id AS settlement_id,
           (
             SELECT s.id
               FROM public.shifts s
              WHERE s.cashbox_id = es.cashbox_id
                AND s.opened_at <= es.created_at
                AND COALESCE(s.closed_at, NOW()) >= es.created_at
              LIMIT 2
           ) AS one_shift,
           (
             SELECT COUNT(*)::int
               FROM public.shifts s
              WHERE s.cashbox_id = es.cashbox_id
                AND s.opened_at <= es.created_at
                AND COALESCE(s.closed_at, NOW()) >= es.created_at
           ) AS match_count
      FROM public.employee_settlements es
     WHERE es.shift_id IS NULL
       AND es.cashbox_id IS NOT NULL
  )
  UPDATE public.employee_settlements es
     SET shift_id = c.one_shift
    FROM candidate c
   WHERE es.id = c.settlement_id
     AND c.match_count = 1
     AND c.one_shift IS NOT NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE
    'migration 095 backfill: % settlements linked to a unique historical shift',
    v_updated;
END $$;

COMMIT;
