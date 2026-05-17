-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Migration 134 : Variant price history audit
--                          (PR-PURCHASES-P3.2)
--
--  WHAT THIS DOES
--    Adds an append-only audit table that records every operator-initiated
--    update of `product_variants.selling_price` made through the new
--    `POST /products/variants/apply-prices` endpoint.
--
--    Each row captures:
--      · which variant was changed
--      · the old and new selling price
--      · who changed it (optional FK to users)
--      · the source purchase the apply came from (optional FK + snapshot
--        of `purchase_no` so the row stays meaningful even if the
--        purchase is later renumbered or deleted)
--      · the operator-supplied reason and a free-form `metadata` jsonb
--
--  WHAT THIS DOES NOT DO
--    * No mutation of `product_variants` schema — selling_price still
--      flows through the existing repository update.
--    * No journal_entries / journal_lines writes — pricing is NOT an
--      accounting event.
--    * No cashbox_transactions / stock_movements writes.
--    * No mutation of `purchases`, `purchase_items`, or
--      `product_variants.cost_price`.
--    * No mutation of POS / sales invoice lines (existing carts keep
--      their captured `unit_price`; new POS sessions naturally pick up
--      the new selling_price the next time they search the SKU).
--    * No FinancialEngine invocation, no posting.service call sites.
--    * No backfill — historical price changes made before this PR are
--      not retroactively recorded.
--    * No triggers — every INSERT is explicit, server-side, behind the
--      `products.price_change` permission. We do NOT auto-log
--      programmatic updates to selling_price from other code paths.
--    * No drop / alter of any existing table or view.
--
--  HOW IT INTEGRATES
--    The backend's `ProductsService.applyVariantPrices()` opens one
--    transaction per request, and for every variant whose new price
--    differs from the current price by ≥ 0.01:
--      1. UPDATE product_variants SET selling_price = $new
--      2. INSERT variant_price_history (...)
--    Either both succeed (per-variant pair) or the entire transaction
--    rolls back.
--
--  HELPERS REUSED
--    gen_random_uuid()         — pgcrypto, already enabled in 002.
-- ============================================================================

CREATE TABLE IF NOT EXISTS variant_price_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id          UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    old_selling_price   NUMERIC(14,2) NOT NULL,
    new_selling_price   NUMERIC(14,2) NOT NULL,
    -- Optional: surfaced by the apply-prices endpoint when the operator
    -- triggers it from the purchase flow. Kept nullable because a future
    -- "edit-from-products-page" path doesn't have a source purchase.
    source_purchase_id  UUID REFERENCES purchases(id) ON DELETE SET NULL,
    -- Snapshot of the purchase number at apply time. Survives even if
    -- the source purchase is later renumbered or removed.
    source_purchase_no  VARCHAR(50),
    reason              TEXT,
    changed_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT variant_price_history_prices_nonneg
        CHECK (old_selling_price >= 0 AND new_selling_price >= 0)
);

COMMENT ON TABLE variant_price_history IS
  'Append-only audit log of operator-initiated product_variants.selling_price changes via POST /products/variants/apply-prices. Pricing-only — never written by accounting / stock / POS paths.';

CREATE INDEX IF NOT EXISTS idx_variant_price_history_variant_changed_at
    ON variant_price_history(variant_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_variant_price_history_source_purchase
    ON variant_price_history(source_purchase_id)
    WHERE source_purchase_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_variant_price_history_changed_by
    ON variant_price_history(changed_by)
    WHERE changed_by IS NOT NULL;
