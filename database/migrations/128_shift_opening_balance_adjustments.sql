-- Migration 128 — Shift opening-balance adjustment audit (PR-FIX-SHIFTS-OPENING-BALANCE-ADJUST).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   When the cashier opens a shift, they enter the cash that was in
--   the till at open time as `shifts.opening_balance`.  Today there
--   is no safe way to correct that value if it was typed wrong
--   (typo, miscount at hand-over, drawer not actually re-counted).
--   Closing-time variance ends up wrong because expected_closing was
--   initialised = opening_balance.
--
--   Pattern mirrors migration 096 (shift_count_adjustments): permission-
--   gated metadata UPDATE on `shifts.opening_balance`, append-only
--   audit log, no JE/CT/SM writes, no FinancialEngine call.  The
--   live `summary()` recompute (opening_balance + cash_in − cash_out)
--   picks up the new value automatically; cashbox.current_balance is
--   independent and is NOT affected (opening_balance is a label, not
--   a financial event).
--
-- Change
--
--   1. CREATE TABLE shift_opening_balance_adjustments — append-only
--      audit log.  Snapshots both old + new opening/expected values
--      plus context flags (shift_status_at_adjust,
--      has_movements_at_adjust) so the trail is fully reconstructable
--      even if shifts.* changes underneath later.
--
--   2. Two indexes — by shift (history modal) + by adjusted_at DESC
--      for cross-shift admin reports.
--
--   3. Seed permission `shifts.opening_balance.adjust` and grant to
--      admin + manager.  Cashier intentionally excluded so the
--      cashier cannot self-correct opening cash without admin /
--      manager review.
--
-- Not touched
--   * journal_entries / journal_lines / cashboxes / cashbox_transactions /
--     stock_movements / FinancialEngine code path.
--   * Open / close / variance / approval workflows on shifts.
--   * shifts schema itself (no new columns).  The mutation path UPDATEs
--     the existing opening_balance / expected_closing columns only.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.shift_opening_balance_adjustments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  shift_id UUID NOT NULL REFERENCES public.shifts(id) ON DELETE CASCADE,
  -- Snapshot of the shift's opening_balance BEFORE the correction.
  old_opening_balance   NUMERIC(14,2) NOT NULL,
  -- The new value being written into shifts.opening_balance.  Cash is
  -- always non-negative (the cashier counted some amount in the till
  -- at open time; they can't have a negative count).
  new_opening_balance   NUMERIC(14,2) NOT NULL CHECK (new_opening_balance >= 0),
  -- expected_closing snapshot.  Initialised = opening_balance at open
  -- time; updated together when the shift has no cash movements yet,
  -- otherwise left to summary()'s live recompute.  Stored both sides
  -- so the audit row is self-contained even if either column changes
  -- later for unrelated reasons.
  old_expected_closing  NUMERIC(14,2),
  new_expected_closing  NUMERIC(14,2),
  -- Context flags captured at adjustment time so the audit trail can
  -- be read without re-deriving from live data.  shift_status_at_adjust
  -- is currently 'open' (the service rejects 'closed' / 'pending_close'
  -- on the live row), but we store it explicitly so future relaxations
  -- of the rule remain auditable.  has_movements_at_adjust is the
  -- existence-flag from the cashbox_transactions scan in the service.
  shift_status_at_adjust   VARCHAR(20) NOT NULL,
  has_movements_at_adjust  BOOLEAN     NOT NULL,
  reason  TEXT NOT NULL CHECK (length(trim(reason)) >= 5),
  notes   TEXT,
  adjusted_by UUID NOT NULL REFERENCES public.users(id),
  adjusted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_shift_opening_balance_adjustments_shift
  ON public.shift_opening_balance_adjustments (shift_id, adjusted_at DESC);

-- Cross-shift index for "all opening-balance corrections this week" admin reports.
CREATE INDEX IF NOT EXISTS ix_shift_opening_balance_adjustments_when
  ON public.shift_opening_balance_adjustments (adjusted_at DESC);

COMMENT ON TABLE public.shift_opening_balance_adjustments IS
  'Append-only audit log for permission-gated corrections to
   shifts.opening_balance.  NOT an accounting transaction — see
   migration 128 header for the rationale.  Mirrors migration 096
   (shift_count_adjustments) shape.';

-- ─── Permission ────────────────────────────────────────────────────────

INSERT INTO public.permissions (code, module, name_ar, name_en) VALUES
  ('shifts.opening_balance.adjust', 'shifts',
   'تعديل الرصيد الافتتاحي للوردية', 'Adjust shift opening balance')
ON CONFLICT (code) DO NOTHING;

-- Catalog grants — admin's wildcard already satisfies hasPermission
-- at runtime, but the explicit row makes audit queries against
-- roles.permissions[] complete.  Cashier is intentionally NOT granted
-- so an opening-balance fix always goes through admin / manager.
UPDATE public.roles
   SET permissions = (
     SELECT array_agg(DISTINCT p ORDER BY p)
       FROM unnest(permissions || ARRAY['shifts.opening_balance.adjust']::text[]) AS p
   )
 WHERE code = 'admin';

UPDATE public.roles
   SET permissions = (
     SELECT array_agg(DISTINCT p ORDER BY p)
       FROM unnest(permissions || ARRAY['shifts.opening_balance.adjust']::text[]) AS p
   )
 WHERE code = 'manager';

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.roles r,
       public.permissions p
 WHERE r.code IN ('admin', 'manager')
   AND p.code = 'shifts.opening_balance.adjust'
ON CONFLICT DO NOTHING;

COMMIT;
