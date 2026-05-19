-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Migration 146b : Inventory counts workflow
--                          (PR-INVENTORY-COUNTS-WORKFLOW)
--
--  WHAT THIS DOES
--    Extends the `inventory_counts` workflow without rewriting it:
--
--      · Relax the `status` CHECK so the new lifecycle values are
--        accepted alongside the legacy ones (`in_progress`,
--        `completed`, `cancelled`). Existing rows keep their values
--        byte-for-byte; new flows emit the richer set:
--
--            draft        — header created, no items snapshotted yet.
--            open         — items frozen, no counted_qty entered yet.
--            counting     — at least one item has counted_qty.
--            review       — every item has counted_qty, awaiting finalize.
--            finalized    — variances applied via fn_adjust_stock_v2.
--            in_progress  — legacy alias (open / counting). Preserved.
--            completed    — legacy alias for finalized. Preserved.
--            cancelled    — unchanged.
--
--      · Add audit columns: `cancelled_at`, `cancelled_by`,
--        `cancel_reason`, `finalized_at`, `finalized_movement_count`
--        — all nullable / defaulted so the change is invisible to
--        every existing reader.
--
--  WHAT THIS DOES NOT DO
--    * No data mutation: zero UPDATE / INSERT against any existing
--      row, no backfill, no DDL beyond ALTERs on this single table.
--    * No touches to stock / stock_movements / products / variants.
--    * No new triggers / functions / views.
--    * No tenant_id / RLS work.
--
--  TENANT-READINESS TODO
--    TODO(multi-tenant): inventory_counts will gain `tenant_id` when
--    the tenant foundation ships; nothing here blocks that.
-- ============================================================================

DO $$
DECLARE
    cname text;
BEGIN
    SELECT conname INTO cname
      FROM pg_constraint
     WHERE conrelid = 'public.inventory_counts'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%IN%';
    IF cname IS NOT NULL THEN
        EXECUTE format(
          'ALTER TABLE public.inventory_counts DROP CONSTRAINT %I',
          cname
        );
    END IF;
END $$;

ALTER TABLE public.inventory_counts
    ADD CONSTRAINT inventory_counts_status_check
    CHECK (status IN (
        'draft',
        'open',
        'counting',
        'review',
        'finalized',
        'in_progress',
        'completed',
        'cancelled'
    ));

ALTER TABLE public.inventory_counts
    ADD COLUMN IF NOT EXISTS cancelled_at              TIMESTAMPTZ;
ALTER TABLE public.inventory_counts
    ADD COLUMN IF NOT EXISTS cancelled_by              UUID
        REFERENCES public.users(id) ON DELETE SET NULL;
ALTER TABLE public.inventory_counts
    ADD COLUMN IF NOT EXISTS cancel_reason             TEXT;
ALTER TABLE public.inventory_counts
    ADD COLUMN IF NOT EXISTS finalized_at              TIMESTAMPTZ;
ALTER TABLE public.inventory_counts
    ADD COLUMN IF NOT EXISTS finalized_movement_count  INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.inventory_counts.cancelled_at IS
    'Timestamp set by POST /inventory-counts/:id/cancel.';
COMMENT ON COLUMN public.inventory_counts.cancelled_by IS
    'User that cancelled the count (FK to users; NULL after user deletion).';
COMMENT ON COLUMN public.inventory_counts.cancel_reason IS
    'Optional free-text rationale captured on cancel.';
COMMENT ON COLUMN public.inventory_counts.finalized_at IS
    'Timestamp set by POST /inventory-counts/:id/finalize on first apply.';
COMMENT ON COLUMN public.inventory_counts.finalized_movement_count IS
    'Number of stock_movements emitted by finalize (= count of items '
    'with counted_qty - system_qty != 0 at the moment of finalize). '
    'Used as a fast-path idempotency hint — the canonical idempotency '
    'check is still EXISTS over stock_movements (reference_type = '
    '''inventory_count'' AND reference_id = inventory_counts.id AND '
    'source_action = ''finalize'').';
