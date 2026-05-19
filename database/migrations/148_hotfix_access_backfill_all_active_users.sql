-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Migration 148 : Hotfix — full access backfill
--                          (PR-HOTFIX-ACCESS-BACKFILL)
--
--  WHY THIS EXISTS
--    Migration 147 introduced user_branch_access + user_warehouse_access
--    and SHOULD have backfilled `view` access for every active user
--    against every active branch + warehouse. In production we landed
--    with a smaller set than expected:
--
--        active_users     = 4
--        branches         = 3
--        warehouses       = 3
--        user_branch_access  < 12  (expected 12)
--        user_warehouse_access < 12  (expected 12)
--
--    This hotfix rebroadcasts the CROSS JOIN backfill so every
--    (active user × every branch / warehouse) pair exists. The
--    `ON CONFLICT DO NOTHING` clause makes this safe to apply on
--    top of the partial backfill from migration 147 — no row is
--    touched if it already exists.
--
--  WHAT THIS DOES NOT DO
--    * No UPDATE on any existing access row — `is_default`, the
--      `access_level`, and `created_by` of every pre-existing row
--      are left exactly as they are.
--    * No mutation to `stock`, `stock_movements`, `products`,
--      `product_variants`, `invoices`, `purchases`, `returns`,
--      `journal_entries`, `journal_lines`, `cashboxes`, or any
--      other write surface.
--    * No schema change. Pure INSERT … ON CONFLICT DO NOTHING.
--
--  IDEMPOTENCY
--    Re-running this migration is a no-op — every INSERT is
--    guarded by the same composite primary key the production
--    table already enforces.
--
--  TENANT-READINESS
--    TODO(multi-tenant): scope the CROSS JOIN by tenant_id once
--    branches / warehouses / users carry it.
-- ============================================================================

INSERT INTO public.user_branch_access (user_id, branch_id, access_level, is_default)
SELECT u.id, b.id, 'view', FALSE
  FROM public.users u
  CROSS JOIN public.branches b
 WHERE COALESCE(u.is_active, TRUE) = TRUE
ON CONFLICT (user_id, branch_id) DO NOTHING;

INSERT INTO public.user_warehouse_access (user_id, warehouse_id, access_level, is_default)
SELECT u.id, w.id, 'view', FALSE
  FROM public.users u
  CROSS JOIN public.warehouses w
 WHERE COALESCE(u.is_active, TRUE) = TRUE
ON CONFLICT (user_id, warehouse_id) DO NOTHING;
