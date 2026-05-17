-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Migration 136 : Variant cost history audit
--                          (PR-PURCHASES-P3.6A)
--
--  WHAT THIS DOES
--    Adds an append-only audit table that records every operator-initiated
--    bulk adjustment of `product_variants.cost_price` made through the
--    new POST /products/variants/cost-adjustments/apply endpoint.
--
--    Each row captures:
--      · which variant was changed
--      · the old and new cost price
--      · the adjustment type (fixed/percent increase/decrease, set_exact)
--      · the operator-supplied raw adjustment value
--      · who changed it (optional FK to users)
--      · a batch_id linking every row from one apply call
--      · the operator-supplied reason
--      · a free-form metadata jsonb (for future filter snapshots etc.)
--
--  WHAT THIS DOES NOT DO
--    * No schema change to `product_variants` — cost_price is still the
--      same column; this table is pure audit.
--    * No journal_entries / journal_lines writes — cost adjustments are
--      explicitly NOT an accounting event in this phase. Inventory
--      revaluation, GL entries, and supplier-ledger movements stay out
--      of scope (see HOLD report).
--    * No cashbox_transactions / stock_movements / supplier_ledger
--      writes. Updating the variant's REFERENCE cost does not move any
--      ledger; it changes the next-sale COGS basis only.
--    * No mutation of `purchases`, `purchase_items`, `invoice_items`,
--      `stock`, or `product_variants.selling_price`.
--    * No FinancialEngine invocation, no posting.service call sites.
--    * No backfill — historical purchase-receive cost changes that
--      pre-date this migration are not retroactively recorded.
--    * No triggers — every INSERT is explicit, server-side, behind the
--      `products.cost_change` permission. Programmatic updates to
--      cost_price from the existing purchase-receive flow are NOT
--      auto-logged here (out of scope for P3.6A).
--    * No drop / alter of any existing table or view.
--
--  HOW IT INTEGRATES
--    The new ProductsService.costAdjustmentApply() runs a single
--    transaction. For every variant whose new cost differs from the
--    current cost by ≥ 0.01:
--      1. UPDATE product_variants SET cost_price = $new, updated_at = NOW()
--      2. INSERT variant_cost_history (...)
--    Either both succeed (per-variant pair) or the entire transaction
--    rolls back.
--
--  HELPERS REUSED
--    gen_random_uuid()         — pgcrypto, already enabled in 002.
-- ============================================================================

CREATE TABLE IF NOT EXISTS variant_cost_history (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    variant_id          UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    old_cost_price      NUMERIC(14,2) NOT NULL,
    new_cost_price      NUMERIC(14,2) NOT NULL,
    -- One of: fixed_increase, fixed_decrease, percent_increase,
    -- percent_decrease, set_exact. Free-text on purpose so new modes
    -- can be added without an enum migration.
    adjustment_type     VARCHAR(40) NOT NULL,
    -- Operator-supplied raw value (e.g. 10 for "+10 EGP" or "+10%").
    -- Stored at 4 dp so percent inputs like 12.5% round-trip cleanly.
    adjustment_value    NUMERIC(14,4) NOT NULL,
    reason              TEXT,
    -- Logical source tag. Defaults match the only writer today; future
    -- writers (e.g. supplier-price-list import) can introduce their
    -- own source string.
    source              VARCHAR(50) NOT NULL DEFAULT 'bulk_cost_adjustment',
    -- Groups every row written by a single apply() call.
    batch_id            UUID NOT NULL,
    changed_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    changed_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT variant_cost_history_costs_nonneg
        CHECK (old_cost_price >= 0 AND new_cost_price >= 0),
    CONSTRAINT variant_cost_history_adjustment_value_nonneg
        CHECK (adjustment_value >= 0)
);

COMMENT ON TABLE variant_cost_history IS
  'Append-only audit log of operator-initiated bulk product_variants.cost_price changes via POST /products/variants/cost-adjustments/apply. Cost-reference-only — never an accounting event, never moves stock or supplier ledger.';

CREATE INDEX IF NOT EXISTS idx_variant_cost_history_variant_changed_at
    ON variant_cost_history(variant_id, changed_at DESC);

CREATE INDEX IF NOT EXISTS idx_variant_cost_history_batch
    ON variant_cost_history(batch_id);

CREATE INDEX IF NOT EXISTS idx_variant_cost_history_changed_by
    ON variant_cost_history(changed_by)
    WHERE changed_by IS NOT NULL;
