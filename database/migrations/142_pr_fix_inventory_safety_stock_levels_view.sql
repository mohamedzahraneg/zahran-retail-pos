-- Migration 142 — PR-FIX-INVENTORY-SAFETY (stock_levels view)
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   `backend/src/stock-transfers/stock-transfers.service.ts:95-99`
--   reads `stock_levels` while validating availability before shipping
--   a transfer. There is no CREATE VIEW / CREATE TABLE statement for
--   `stock_levels` anywhere in `database/migrations/` — every transfer
--   ship call therefore raises `relation "stock_levels" does not exist`
--   at runtime (the path has effectively never executed in production).
--
--   Companion to the backend Safety PR that removed the raw
--   `UPDATE stock` writes that were double-applying every cancelled
--   return / return-edit / exchange-edit / purchase-return delta.
--
-- Change
--
--   Create a read-only VIEW `public.stock_levels` exposing the
--   columns the service queries (`quantity`) plus a small superset
--   that future callers may need. The view is a thin projection over
--   `public.stock` — no separate storage, no triggers, no risk of
--   drift. All columns come directly from `stock` so existing
--   triggers (`apply_stock_movement`, `fn_stock_sync_quantity`)
--   remain the only writers.
--
-- What this migration does NOT touch
--   * Any existing row — no UPDATE, no DELETE, no backfill.
--   * `stock` table — no schema or data change.
--   * `stock_movements` — unchanged.
--   * Any trigger or function.
--   * No reconciliation, no balance recalculation.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE OR REPLACE VIEW public.stock_levels AS
SELECT
  s.variant_id,
  s.warehouse_id,
  s.quantity,
  s.quantity_on_hand,
  s.quantity_reserved,
  (s.quantity_on_hand - s.quantity_reserved)::int AS available_quantity,
  s.reorder_point,
  s.updated_at
FROM public.stock s;

COMMENT ON VIEW public.stock_levels IS
  'PR-FIX-INVENTORY-SAFETY: read-only projection over public.stock.
   Restores the relation that stock-transfers.service.ts has been
   querying (column `quantity`) so the transfer ship path stops
   failing with "relation does not exist". Pure projection — no
   storage, no triggers, no writes. All canonical inventory
   mutations still flow through INSERT INTO stock_movements →
   trg_apply_stock_movement (migration 011).';

COMMIT;
