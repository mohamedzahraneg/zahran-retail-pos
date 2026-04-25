-- Migration 099 — Returns/Exchanges shift + cashbox linkage (PR-R1).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Today neither `returns` nor `exchanges` persists which shift (if any)
--   the refund / exchange-difference cash flowed through. Visibility in
--   shift closing is 100% derived via cashbox+time-window matching
--   (shifts.service.computeSummary `refundCtRows`), which is fragile:
--   if a refund is processed minutes before a shift opens on the same
--   cashbox, the time-window match silently fails (this is exactly the
--   class of bug PR #120 / PR #121 cleaned up for RET-2026-000001).
--
--   PR-R1 introduces explicit `shift_id` + `cashbox_id` columns so the
--   user can pick "open shift" vs "direct cashbox" at the source, and
--   the closing summary can prefer the explicit linkage over derivation.
--
-- Scope
--
--   1. Additive ALTERs: nullable shift_id (FK → shifts) + cashbox_id
--      (FK → cashboxes) on `returns` and `exchanges`. Both are nullable
--      because:
--        · legacy rows have neither
--        · "direct cashbox" branch deliberately leaves shift_id NULL
--        · IF NOT EXISTS guards make the migration idempotent
--   2. Partial indexes on the new columns (only non-NULL rows index).
--   3. Targeted backfill of `returns` from existing cashbox_transactions:
--      For each refunded return that has exactly one CT mirror, infer
--      (shift_id, cashbox_id) by finding the unique shift whose window
--      contains the CT's created_at on the CT's cashbox. Rows where
--      the shift is ambiguous (multiple opens on the same cashbox in
--      the window) stay NULL — they continue using derived match.
--   4. NO backfill for exchanges — exchanges_total = 0 on prod (audit
--      via PR-R1 audit), and the existing flow never wrote a CT for
--      cash differences anyway. PR-R1's backend changes will start
--      producing those rows; backfill not required.
--
-- Strict
--
--   · Additive only — no column drops, no data destruction
--   · Idempotent — IF NOT EXISTS / NOT EXISTS guards everywhere
--   · NO journal_entries / journal_lines writes
--   · NO cashbox_transactions writes
--   · NO change to cashboxes.current_balance
--   · Backfill only writes returns.shift_id / returns.cashbox_id where
--     the source-of-truth (CT row + shifts table) leaves no ambiguity
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:099_returns_exchanges_shift_linkage',
  true
);

-- ── 1. ALTER tables ────────────────────────────────────────────────────────
ALTER TABLE returns
  ADD COLUMN IF NOT EXISTS shift_id   uuid NULL REFERENCES shifts(id)    ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cashbox_id uuid NULL REFERENCES cashboxes(id) ON DELETE SET NULL;

ALTER TABLE exchanges
  ADD COLUMN IF NOT EXISTS shift_id   uuid NULL REFERENCES shifts(id)    ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS cashbox_id uuid NULL REFERENCES cashboxes(id) ON DELETE SET NULL;

COMMENT ON COLUMN returns.shift_id IS
  'Shift the refund cash flowed through. NULL for non-cash refunds, direct-cashbox refunds, or legacy rows where backfill was ambiguous.';
COMMENT ON COLUMN returns.cashbox_id IS
  'Cashbox the refund cash left. Set for both shift-linked and direct-cashbox cash refunds. NULL for non-cash or legacy.';
COMMENT ON COLUMN exchanges.shift_id IS
  'Shift the exchange-difference cash flowed through. NULL for equal exchanges, non-cash, direct-cashbox, or legacy.';
COMMENT ON COLUMN exchanges.cashbox_id IS
  'Cashbox the exchange-difference cash entered/left. NULL for equal exchanges, non-cash, or legacy.';

-- ── 2. Partial indexes ────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_returns_shift_id
  ON returns(shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_returns_cashbox_id
  ON returns(cashbox_id) WHERE cashbox_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exchanges_shift_id
  ON exchanges(shift_id) WHERE shift_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_exchanges_cashbox_id
  ON exchanges(cashbox_id) WHERE cashbox_id IS NOT NULL;

-- ── 3. Targeted backfill — returns ────────────────────────────────────────
DO $$
DECLARE
  v_updated int;
BEGIN
  WITH candidate AS (
    SELECT r.id            AS return_id,
           ct.cashbox_id   AS ct_cashbox_id,
           ct.created_at   AS ct_at
      FROM returns r
      JOIN cashbox_transactions ct
        ON ct.reference_type::text = 'return'
       AND ct.reference_id = r.id
     WHERE r.shift_id IS NULL
       AND r.cashbox_id IS NULL
       AND ct.direction::text = 'out'
  ),
  resolved AS (
    SELECT c.return_id, c.ct_cashbox_id,
           (SELECT s.id FROM shifts s
             WHERE s.cashbox_id = c.ct_cashbox_id
               AND c.ct_at >= s.opened_at
               AND c.ct_at <= COALESCE(s.closed_at, NOW())) AS unique_shift_id,
           (SELECT COUNT(*) FROM shifts s
             WHERE s.cashbox_id = c.ct_cashbox_id
               AND c.ct_at >= s.opened_at
               AND c.ct_at <= COALESCE(s.closed_at, NOW())) AS match_count
      FROM candidate c
  )
  UPDATE returns r
     SET shift_id   = resolved.unique_shift_id,
         cashbox_id = resolved.ct_cashbox_id
    FROM resolved
   WHERE r.id = resolved.return_id
     AND resolved.match_count = 1
     AND resolved.unique_shift_id IS NOT NULL;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RAISE NOTICE 'migration 099: returns backfilled with explicit shift_id/cashbox_id = %', v_updated;
END $$;

COMMIT;
