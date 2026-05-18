-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Migration 138 : Custom Product Groups
--                          (PR-P9.1a)
--
--  WHAT THIS DOES
--    Adds two new tables for operator-curated manual product groups:
--
--      · product_groups            — group header (name, description,
--                                    optional color tag, is_active)
--      · product_group_variants    — variant-level membership (M:M
--                                    against product_variants)
--
--    Variant-level (not product-level) because pricing / cost / sales
--    are variant-scoped in this system.
--
--    Soft-delete on groups is the `is_active=FALSE` flag — no
--    `deleted_at` (matches the simpler `categories` pattern).
--    Variant rows are hard-deleted on cascade (`ON DELETE CASCADE`
--    on both FKs) because group membership has no audit-history
--    requirement in P9.1a.
--
--  WHAT THIS DOES NOT DO
--    * No schema change to `products`, `product_variants`,
--      `categories`, `brands`, or any other catalog table.
--    * No mutation of any existing row. Purely additive.
--    * No backfill. Pre-P9.1a variants stay ungrouped.
--    * No drop / alter / rename of any existing column / constraint
--      / index.
--    * No triggers, no functions, no views.
--    * No accounting / cashbox / stock / supplier-ledger impact.
--      These tables are pure operator-curation metadata and are
--      never read by any posting / cashbox / supplier code path.
--    * No new `selling_price` / `cost_price` write surface. Group
--      membership is selector-only; P9.1b will wire `group_id` as
--      a filter for the existing smart-pricing / cost-adjustment
--      preview/apply paths.
--
--  HOW IT INTEGRATES (P9.1a scope)
--    * Backend `ProductGroupsModule` exposes pure CRUD + membership
--      add/remove. No apply endpoints. All writes gated by the new
--      `products.groups_manage` permission slug.
--    * Frontend ships a dedicated `/product-groups` page so
--      operators can curate groups; the report/assistant filter
--      integration lands separately in P9.1b.
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_groups (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name_ar     VARCHAR(120) NOT NULL,
    name_en     VARCHAR(120) NULL,
    description TEXT NULL,
    -- Optional hex tag like '#22c55e' for the UI badge. Free-text on
    -- purpose so the UI can evolve without an enum migration.
    color       VARCHAR(20) NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_by  UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT product_groups_name_ar_not_blank
        CHECK (length(btrim(name_ar)) > 0)
);

COMMENT ON TABLE product_groups IS
  'P9.1: operator-curated manual groups for filtering reports + pricing/cost assistants. NEVER references prices, stock, GL, or cashbox. Selector-only.';

CREATE INDEX IF NOT EXISTS idx_product_groups_active
    ON product_groups(is_active)
    WHERE is_active = TRUE;

CREATE TABLE IF NOT EXISTS product_group_variants (
    group_id   UUID NOT NULL REFERENCES product_groups(id) ON DELETE CASCADE,
    variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    added_by   UUID NULL REFERENCES users(id) ON DELETE SET NULL,
    added_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (group_id, variant_id)
);

COMMENT ON TABLE product_group_variants IS
  'P9.1: variant-level membership in a manual product group. Variant-level (not product-level) because pricing/cost/sales are variant-scoped. CASCADE delete cleans up when either side disappears.';

-- (group_id is the leading PK column → its lookup index is free.)
-- Reverse lookup (variant → groups) needs its own index.
CREATE INDEX IF NOT EXISTS idx_product_group_variants_variant
    ON product_group_variants(variant_id);
