-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Migration 146a : entity_type ⊕ inventory_count
--                          (PR-INVENTORY-COUNTS-WORKFLOW)
--
--  Adds 'inventory_count' to the `entity_type` enum so the
--  inventory-counts finalize path can stamp:
--      stock_movements.reference_type = 'inventory_count'
--      stock_movements.reference_id   = inventory_counts.id
--
--  IMPORTANT — PostgreSQL refuses to USE a newly-added enum value in
--  the same transaction it was added in. The 143a + 107 precedents
--  ship the enum addition as a STANDALONE migration with no
--  BEGIN/COMMIT block so the migration runner's per-file wrapper
--  commits the ALTER TYPE first, then the next migration (146b) can
--  reference the value safely.
--
--  Idempotent: `ADD VALUE IF NOT EXISTS` is a no-op on re-run.
-- ============================================================================

ALTER TYPE entity_type ADD VALUE IF NOT EXISTS 'inventory_count';
