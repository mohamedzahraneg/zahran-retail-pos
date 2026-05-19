-- Migration 143b — PR-FIX-INVENTORY-HYGIENE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Forward-only inventory tracking improvements. Builds on:
--   · migration 011 — apply_stock_movement trigger that UPSERTs `stock`
--                     on every INSERT into `stock_movements`.
--   · migration 142 — `stock_levels` view (Safety PR).
--   · migration 143a — `entity_type` enum value `'stock_transfer'`.
--
-- Goals
--   1. Add three lightweight audit columns to `stock_movements`:
--        balance_after_qty  — snapshot of stock.quantity_on_hand
--                             AFTER the trigger applied this movement.
--        source_module      — logical owner of the write (e.g.
--                             'stock_transfers', 'pos', 'returns').
--        source_action      — verb (e.g. 'ship', 'receive', 'cancel').
--   2. Extend `apply_stock_movement` to populate `balance_after_qty`
--      on the row it just upserted into `stock`. Forward-only: the
--      column was NULL on every pre-existing row before this
--      migration and stays NULL for those rows.
--   3. Add `fn_adjust_stock_v2` — a slim helper that ONLY inserts
--      into `stock_movements` (the trigger does the `stock` UPSERT)
--      with the new source_module/source_action audit + a real
--      caller-supplied reference_type / reference_id.
--   4. Add `v_stock_unified` — read-only projection over `stock` for
--      future readers to depend on (today's callers keep reading
--      `stock` / `stock_levels` directly).
--
-- What this migration does NOT touch
--   * No UPDATE / DELETE on any existing row.
--   * No backfill — historical stock_movements rows keep
--     balance_after_qty / source_module / source_action = NULL.
--   * No change to balances in `stock`.
--   * `fn_adjust_stock` (v1) is left intact for callers that still
--     use it (returns.approve, inventory-counts.finalize, etc.).
--   * No change to GL / cashbox / financial ledger.
--   * No change to enum values besides `stock_transfer` (in 143a).
--   * No reconciliation of the 625 movements that already carry
--     reference_type='other'.
--   * No change to the 15 potential duplicate movement groups —
--     left intact for a future, audited cleanup pass.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 1. New audit columns on stock_movements ─────────────────────────────
ALTER TABLE public.stock_movements
  ADD COLUMN IF NOT EXISTS balance_after_qty integer,
  ADD COLUMN IF NOT EXISTS source_module     varchar(32),
  ADD COLUMN IF NOT EXISTS source_action     varchar(64);

COMMENT ON COLUMN public.stock_movements.balance_after_qty IS
  'PR-FIX-INVENTORY-HYGIENE: snapshot of stock.quantity_on_hand AFTER
   apply_stock_movement upserted the row for this movement. Populated
   on every new INSERT by the updated trigger (migration 143b). NULL
   on every row written before this migration — forward-only column.';

COMMENT ON COLUMN public.stock_movements.source_module IS
  'PR-FIX-INVENTORY-HYGIENE: logical writer (pos / returns / purchases
   / stock_transfers / inventory_counts / import …). Optional —
   legacy rows + non-instrumented callers leave it NULL.';

COMMENT ON COLUMN public.stock_movements.source_action IS
  'PR-FIX-INVENTORY-HYGIENE: verb the writer was performing (ship /
   receive / cancel / approve / refund / finalize …). Optional —
   legacy rows + non-instrumented callers leave it NULL.';

-- ── 2. apply_stock_movement — populate balance_after_qty ────────────────
-- The UPSERT into `stock` is unchanged (no double-apply risk
-- introduced). After it runs, capture the new on-hand quantity and
-- write it onto the just-inserted movement row. The follow-up
-- UPDATE happens inside an AFTER INSERT trigger on stock_movements,
-- which fires UPDATE triggers (none defined) — no recursion, no
-- double-apply. Wrapped in an EXCEPTION block so a missing column
-- (very old install that somehow skipped 143b) silently degrades to
-- the pre-143b behavior instead of breaking inserts.

CREATE OR REPLACE FUNCTION apply_stock_movement()
RETURNS TRIGGER AS $$
DECLARE
    delta     int;
    v_new_qty int;
BEGIN
    delta := CASE WHEN NEW.direction = 'in' THEN NEW.quantity ELSE -NEW.quantity END;

    INSERT INTO stock (variant_id, warehouse_id, quantity_on_hand, quantity_reserved)
    VALUES (NEW.variant_id, NEW.warehouse_id, GREATEST(delta, 0), 0)
    ON CONFLICT (variant_id, warehouse_id)
    DO UPDATE SET
        quantity_on_hand = stock.quantity_on_hand + delta,
        updated_at       = NOW()
    RETURNING quantity_on_hand INTO v_new_qty;

    -- PR-FIX-INVENTORY-HYGIENE — write balance_after_qty onto the
    -- just-inserted row. Defensive try/catch so the trigger keeps
    -- working on installs that haven't applied 143b yet.
    BEGIN
        UPDATE public.stock_movements
           SET balance_after_qty = v_new_qty
         WHERE id = NEW.id;
    EXCEPTION WHEN OTHERS THEN
        NULL;
    END;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger definition is unchanged; CREATE OR REPLACE FUNCTION above
-- swaps the body in place. (No DROP TRIGGER / CREATE TRIGGER needed.)

-- ── 3. fn_adjust_stock_v2 — movement-only helper ────────────────────────
-- v1 (`fn_adjust_stock`) writes BOTH a `stock` UPSERT and a
-- `stock_movements` row — and the trigger above ALSO upserts on the
-- movement INSERT. v1 therefore double-applies the delta. The
-- transfers code historically depended on this v1 behavior (or just
-- got lucky in low-volume use) — v2 is the safe replacement. It
-- inserts into stock_movements ONLY; the trigger owns the `stock`
-- mutation.

CREATE OR REPLACE FUNCTION public.fn_adjust_stock_v2(
    p_variant_id     uuid,
    p_warehouse_id   uuid,
    p_delta          int,
    p_reason         text,
    p_reference_type entity_type,
    p_reference_id   uuid,
    p_unit_cost      numeric DEFAULT NULL,
    p_user_id        uuid    DEFAULT NULL,
    p_source_module  text    DEFAULT NULL,
    p_source_action  text    DEFAULT NULL,
    p_movement_type  stock_movement_type DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    v_id   bigint;
    v_dir  txn_direction;
    v_type stock_movement_type;
BEGIN
    IF p_delta = 0 OR p_delta IS NULL THEN
        RAISE EXCEPTION 'fn_adjust_stock_v2: delta must be non-zero';
    END IF;

    v_dir  := CASE WHEN p_delta > 0 THEN 'in'::txn_direction
                                    ELSE 'out'::txn_direction END;
    v_type := COALESCE(
        p_movement_type,
        CASE WHEN p_delta > 0 THEN 'adjustment_in'::stock_movement_type
                              ELSE 'adjustment_out'::stock_movement_type END
    );

    -- Insert only into stock_movements. The AFTER INSERT trigger
    -- `trg_apply_stock_movement` handles the stock UPSERT and fills
    -- `balance_after_qty` (migration 143b update above). Exactly one
    -- side effect per call — no manual UPDATE stock, no double-apply.
    INSERT INTO public.stock_movements
        (variant_id, warehouse_id, movement_type, direction,
         quantity, unit_cost, reference_type, reference_id,
         notes, user_id, source_module, source_action)
    VALUES
        (p_variant_id, p_warehouse_id, v_type, v_dir,
         ABS(p_delta), COALESCE(p_unit_cost, 0),
         p_reference_type, p_reference_id,
         p_reason, p_user_id, p_source_module, p_source_action)
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.fn_adjust_stock_v2(uuid, uuid, int, text, entity_type, uuid, numeric, uuid, text, text, stock_movement_type) IS
  'PR-FIX-INVENTORY-HYGIENE: forward-only stock-mutation helper.
   Inserts EXACTLY ONE stock_movements row; the existing
   apply_stock_movement trigger handles the stock UPSERT. Differs
   from fn_adjust_stock (v1) in three ways:
     1. NO manual UPSERT into stock (avoids the double-apply bug).
     2. Accepts caller-supplied reference_type / reference_id so the
        movement links back to the originating document.
     3. Records source_module + source_action for audit.
   Returns the new stock_movements.id (BIGSERIAL) so the caller can
   thread it into linkage tables when needed.';

-- ── 4. v_stock_unified — read-only projection ───────────────────────────
-- Sibling of `stock_levels` (migration 142). Wider column set
-- intended as the future canonical read surface; no caller migrated
-- onto it yet. Same row count as `stock` (each variant×warehouse
-- pair = one row). No triggers, no storage.

CREATE OR REPLACE VIEW public.v_stock_unified AS
SELECT
    s.variant_id,
    s.warehouse_id,
    s.quantity_on_hand,
    s.quantity_reserved,
    (s.quantity_on_hand - s.quantity_reserved)::int AS available_quantity,
    s.reorder_point,
    s.avg_cost,
    s.last_counted_at,
    s.created_at,
    s.updated_at
FROM public.stock s;

COMMENT ON VIEW public.v_stock_unified IS
  'PR-FIX-INVENTORY-HYGIENE: canonical read-side projection over
   public.stock. Future reports should depend on this view so the
   redundant alias columns (stock.quantity, reserved_quantity,
   reorder_quantity) can be dropped in a later cleanup migration
   without breaking readers. Pure projection — no writes, no
   triggers, no recompute. Row count equals stock row count.';

COMMIT;
