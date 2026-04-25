-- Migration 096 — Shift counted-cash adjustment audit (PR-B1).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   When a cashier types the wrong counted cash amount at shift
--   close (typo, miscount, fat-finger), today there is no safe path
--   to correct the reported number. The original `shifts.actual_closing`
--   is locked behind the close flow and there's no audit table for
--   corrections.
--
--   This migration creates the audit ledger for permission-gated
--   counted-cash corrections. The correction itself is a metadata
--   UPDATE on `shifts.actual_closing` — `shifts.difference` is a
--   GENERATED column and recomputes automatically. This is NOT an
--   accounting transaction:
--     · NO journal_entries created
--     · NO cashbox_transactions created
--     · NO cashboxes.current_balance change
--     · NO FinancialEngine call
--   The actual cash movements (sales, expenses, settlements) already
--   posted through the engine and stay untouched. We're correcting
--   the cashier's reported count, not booking a financial event.
--
-- Change
--
--   1. CREATE TABLE shift_count_adjustments — append-only audit log.
--      Snapshots both old + new actual/expected/difference triples
--      so the history is fully reconstructable even if `shifts.*`
--      changes underneath later.
--
--   2. Two indexes — by shift (history modal) + by adjusted_at
--      DESC for cross-shift admin reports.
--
--   3. Seed permission `shifts.close.adjust` and grant to admin +
--      manager. Cashier intentionally excluded so the cashier
--      cannot self-correct after submission — admin / manager
--      review remains the gate.
--
-- Not touched
--   * journal_entries / journal_lines / cashboxes / cashbox_transactions.
--   * FinancialEngine code path.
--   * Shifts close / variance / approval workflows.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.shift_count_adjustments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shift_id UUID NOT NULL REFERENCES public.shifts(id) ON DELETE CASCADE,
  -- Snapshot of the cashier's reported count BEFORE the correction.
  -- May be NULL on the very first adjustment when the cashier never
  -- entered an actual_closing (rare but possible if admin corrects
  -- before close-out completes).
  old_actual_closing   NUMERIC(14,2),
  new_actual_closing   NUMERIC(14,2) NOT NULL CHECK (new_actual_closing >= 0),
  -- Expected closing snapshot — included so the history reflects what
  -- the variance looked like at correction time even if the underlying
  -- expected_closing recomputes later (e.g. a future expense edit
  -- changes the totals).
  old_expected_closing NUMERIC(14,2),
  new_expected_closing NUMERIC(14,2),
  -- Difference = actual − expected. Snapshotted both sides for the
  -- audit table's standalone readability.
  old_difference       NUMERIC(14,2),
  new_difference       NUMERIC(14,2),
  reason               TEXT NOT NULL CHECK (length(trim(reason)) >= 5),
  adjusted_by          UUID NOT NULL REFERENCES public.users(id),
  adjusted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_shift_count_adjustments_shift
  ON public.shift_count_adjustments (shift_id, adjusted_at DESC);

-- Cross-shift index for admin "all corrections this week" reports.
CREATE INDEX IF NOT EXISTS ix_shift_count_adjustments_when
  ON public.shift_count_adjustments (adjusted_at DESC);

COMMENT ON TABLE public.shift_count_adjustments IS
  'Append-only audit log for permission-gated corrections to
   shifts.actual_closing. NOT an accounting transaction — see
   migration 096 header for the rationale.';

-- ─── Permission ────────────────────────────────────────────────────────

INSERT INTO public.permissions (code, module, name_ar, name_en) VALUES
  ('shifts.close.adjust', 'shifts',
   'تعديل مبلغ الإقفال للوردية', 'Adjust shift counted cash')
ON CONFLICT (code) DO NOTHING;

-- Catalog grants — admin's wildcard already satisfies hasPermission
-- at runtime, but the explicit row makes audit queries against
-- roles.permissions[] complete.
UPDATE public.roles
   SET permissions = (
     SELECT array_agg(DISTINCT p ORDER BY p)
       FROM unnest(permissions || ARRAY['shifts.close.adjust']::text[]) AS p
   )
 WHERE code = 'admin';

UPDATE public.roles
   SET permissions = (
     SELECT array_agg(DISTINCT p ORDER BY p)
       FROM unnest(permissions || ARRAY['shifts.close.adjust']::text[]) AS p
   )
 WHERE code = 'manager';

-- Cashier is intentionally NOT granted — corrections after submission
-- need admin/manager oversight by policy.

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.roles r,
       public.permissions p
 WHERE r.code IN ('admin', 'manager')
   AND p.code = 'shifts.close.adjust'
ON CONFLICT DO NOTHING;

COMMIT;
