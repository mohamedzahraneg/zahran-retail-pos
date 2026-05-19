-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Migration 145 : Stock-transfers workflow
--                          (PR-STOCK-TRANSFERS-WORKFLOW)
--
--  WHAT THIS DOES
--    Extends the `stock_transfers` workflow without rewriting it:
--
--      · Relax the `status` CHECK so the new lifecycle values are
--        accepted in addition to the legacy ones. Existing rows
--        (draft / in_transit / received / cancelled) keep their
--        values exactly as they are.
--
--      · Add three nullable audit columns so the lifecycle UI can
--        render a precise per-step timestamp:
--            approved_at     — set by POST /stock-transfers/:id/approve
--            cancelled_at    — set by POST /stock-transfers/:id/cancel
--            cancelled_by    — user that performed the cancellation
--
--    NEW status value set (CHECK):
--        draft               (legacy, unchanged)
--        pending             (NEW — awaiting approval)
--        approved            (NEW — approved, ready to ship)
--        in_transit          (legacy, unchanged — used post-ship)
--        partially_received  (NEW — some items received, some still
--                              in transit; emitted by the receive
--                              path when not all items reach
--                              quantity_requested)
--        received            (legacy, unchanged)
--        cancelled           (legacy, unchanged)
--        rejected            (NEW — for a future reject-approval
--                              affordance; no backend write path
--                              creates this status in this PR but the
--                              column allows it so a later PR can add
--                              the verb without another migration)
--
--  WHAT THIS DOES NOT DO
--    * No data mutation: no UPDATE on any existing row, no
--      backfill, no movement / stock writes.
--    * No schema change on `stock`, `stock_movements`,
--      `stock_transfer_items`, `warehouses`, `branches`,
--      `warehouse_branches`, or any other table.
--    * No new triggers / functions / views.
--    * No tenant_id / RLS work.
--
--  TENANT-READINESS TODO
--    TODO(multi-tenant): `stock_transfers` will gain `tenant_id`
--    when the tenant foundation ships; nothing here blocks that.
-- ============================================================================

-- Drop the existing CHECK constraint (whatever PG named it) and
-- replace it with the extended value set.
DO $$
DECLARE
    cname text;
BEGIN
    SELECT conname INTO cname
      FROM pg_constraint
     WHERE conrelid = 'public.stock_transfers'::regclass
       AND contype = 'c'
       AND pg_get_constraintdef(oid) ILIKE '%status%IN%';
    IF cname IS NOT NULL THEN
        EXECUTE format(
          'ALTER TABLE public.stock_transfers DROP CONSTRAINT %I',
          cname
        );
    END IF;
END $$;

ALTER TABLE public.stock_transfers
    ADD CONSTRAINT stock_transfers_status_check
    CHECK (status IN (
        'draft',
        'pending',
        'approved',
        'in_transit',
        'partially_received',
        'received',
        'cancelled',
        'rejected'
    ));

-- Additive audit columns. All nullable so the change is invisible to
-- any code path that still reads the legacy columns only.
ALTER TABLE public.stock_transfers
    ADD COLUMN IF NOT EXISTS approved_at  TIMESTAMPTZ;
ALTER TABLE public.stock_transfers
    ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE public.stock_transfers
    ADD COLUMN IF NOT EXISTS cancelled_by UUID
        REFERENCES public.users(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.stock_transfers.approved_at  IS
    'Timestamp set by POST /stock-transfers/:id/approve. Null until approval.';
COMMENT ON COLUMN public.stock_transfers.cancelled_at IS
    'Timestamp set by POST /stock-transfers/:id/cancel.';
COMMENT ON COLUMN public.stock_transfers.cancelled_by IS
    'User that cancelled the transfer (FK to users; NULL after user deletion).';
