-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Migration 133 : Purchase landed costs
--                          (PR-PURCHASES-P2.1)
--
--  WHAT THIS DOES
--    Adds per-purchase "extra costs" (نقل / عمالة / شحن / تحميل-تنزيل /
--    جمارك / تغليف / أخرى) that can be capitalized to inventory and
--    allocated across purchase lines via three methods:
--      · by_value     — proportional to each line's base total
--      · by_quantity  — proportional to each line's quantity
--      · manual       — operator-supplied per-line amount
--
--    Adds the per-line columns needed to reconstruct the landed unit
--    cost without changing what `purchase_items.unit_cost` already
--    feeds downstream:
--      · base_unit_cost          = raw price paid to the supplier
--      · allocated_cost_total    = capitalized share for this line
--      · allocated_cost_per_unit = allocated_cost_total / quantity
--      · purchase_items.unit_cost remains the SOURCE OF TRUTH for
--        inventory cost and now carries the LANDED value
--        (= base_unit_cost + allocated_cost_per_unit). `receive()`
--        writes `unit_cost` into `product_variants.cost_price`
--        unchanged, so the last-cost policy automatically picks up
--        landed cost without any service-layer rewrite.
--
--    Adds two per-purchase aggregate columns so reports can pin
--    capitalized vs. non-capitalized extras without joining the
--    new child table on every read:
--      · extra_costs_capitalized
--      · extra_costs_non_capitalized
--
--  WHAT THIS DOES NOT DO
--    * No change to product_variants.cost_price semantics — same
--      column, same last-cost update path. Only the *value* it ends
--      up holding changes (raw → landed) because the source column
--      `purchase_items.unit_cost` now carries the landed total.
--    * No change to stock_movements.unit_cost semantics — still a
--      snapshot of `purchase_items.unit_cost` at receive time
--      (which is the landed value going forward).
--    * No change to `purchases.shipping_cost` semantics — keeps its
--      current "capitalized to inventory via subtotal" behavior. The
--      new `purchase_extra_costs.cost_type='shipping'` rows are an
--      OPTIONAL ALTERNATIVE for operators who need allocation across
--      lines; the legacy `shipping_cost` field is still accepted.
--    * No change to stock.avg_cost — still vestigial (added by
--      migration 027, never written to). A future moving-average
--      phase can wire it; out of scope here.
--    * No change to returns / sales / accounting outside the new
--      purchase-creation + post-purchase code paths.
--    * No new journal_entries / journal_lines / cashbox_transactions
--      rows. (postPurchase() updates its existing GL legs to include
--      the new totals — application-level change, not schema.)
--    * No backfill of GL for historical purchases.
--    * No drop / alter of any existing column or constraint.
--
--  BACKFILL
--    For every existing row in purchase_items:
--      · base_unit_cost          := unit_cost
--      · allocated_cost_total    := 0
--      · allocated_cost_per_unit := 0
--      · manual_allocation       := FALSE
--    After the backfill the invariant
--      unit_cost = base_unit_cost + allocated_cost_per_unit
--    holds for every existing row (the allocated portion is 0).
--
--    For every existing row in purchases:
--      · extra_costs_capitalized      := 0
--      · extra_costs_non_capitalized  := 0
--    No grand_total recomputation needed — extras default to 0.
--
--  ROLLBACK
--    The migration is reversible in principle (DROP TABLE +
--    DROP COLUMN). If rollback is needed AFTER the application has
--    started writing extras in production, restore from a pre-deploy
--    snapshot instead of dropping live columns — landed-cost data
--    captured between deploy and rollback would otherwise be lost.
-- ============================================================================

BEGIN;

-- ──────────────────────────────────────────────────────────────────────────
-- 1) purchase_extra_costs : per-invoice extras (transport, labor, etc.).
-- ──────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.purchase_extra_costs (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_id              UUID NOT NULL
                              REFERENCES public.purchases(id)
                              ON DELETE CASCADE,
    cost_type                VARCHAR(40) NOT NULL,
    label                    VARCHAR(120),
    amount                   NUMERIC(14,2) NOT NULL,
    capitalize_to_inventory  BOOLEAN      NOT NULL DEFAULT TRUE,
    allocation_method        VARCHAR(20)  NOT NULL DEFAULT 'by_value',
    notes                    TEXT,
    sort_order               INT          NOT NULL DEFAULT 0,
    created_by               UUID REFERENCES public.users(id),
    created_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at               TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

    -- Allow only the documented cost types. Operators record any
    -- "other" expense under the existing 'other' bucket so reports
    -- don't drown in free-form values.
    CONSTRAINT purchase_extra_costs_cost_type_chk CHECK (
      cost_type IN (
        'transport', 'labor', 'shipping', 'customs', 'packaging', 'other'
      )
    ),

    -- Three allocation methods; matches the service-layer enum.
    CONSTRAINT purchase_extra_costs_allocation_method_chk CHECK (
      allocation_method IN ('by_value', 'by_quantity', 'manual')
    ),

    -- Strictly positive — the UI / service layer rejects 0 / negative
    -- amounts before they ever reach the DB.
    CONSTRAINT purchase_extra_costs_amount_positive_chk CHECK (
      amount > 0
    )
);

CREATE INDEX IF NOT EXISTS ix_purchase_extra_costs_purchase
  ON public.purchase_extra_costs (purchase_id);

COMMENT ON TABLE public.purchase_extra_costs IS
  'P2.1 — per-purchase landed-cost expenses (transport/labor/shipping/customs/'
  'packaging/other). When capitalize_to_inventory=true the amount is allocated '
  'across purchase_items via allocation_method.';

COMMENT ON COLUMN public.purchase_extra_costs.capitalize_to_inventory IS
  'When TRUE the amount increases purchase_items.unit_cost (landed cost) and '
  'is debited to inventory (GL 1131) at postPurchase time. When FALSE the '
  'amount is debited to misc operating expenses (GL 529) and never touches '
  'inventory cost.';

COMMENT ON COLUMN public.purchase_extra_costs.allocation_method IS
  'by_value  → proportional to (qty × base_unit_cost − discount + tax) per line. '
  'by_quantity → proportional to qty per line. '
  'manual    → operator supplies per-line amounts that must sum to amount within '
  '0.01.';

-- ──────────────────────────────────────────────────────────────────────────
-- 2) purchase_items : per-line landed-cost breakdown.
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.purchase_items
  ADD COLUMN IF NOT EXISTS base_unit_cost            NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS allocated_cost_total      NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS allocated_cost_per_unit   NUMERIC(14,4) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS manual_allocation         BOOLEAN       NOT NULL DEFAULT FALSE;

-- Backfill base_unit_cost for every existing row so the invariant
-- "unit_cost = base_unit_cost + allocated_cost_per_unit" holds.
UPDATE public.purchase_items
   SET base_unit_cost = unit_cost
 WHERE base_unit_cost IS NULL;

-- After backfill we can require base_unit_cost to be present going
-- forward — every new row sets it explicitly via the service layer.
ALTER TABLE public.purchase_items
  ALTER COLUMN base_unit_cost SET NOT NULL;

ALTER TABLE public.purchase_items
  ALTER COLUMN base_unit_cost SET DEFAULT 0;

COMMENT ON COLUMN public.purchase_items.base_unit_cost IS
  'Raw price paid to the supplier per piece, BEFORE landed cost allocation. '
  'unit_cost = base_unit_cost + allocated_cost_per_unit (invariant enforced at '
  'service layer).';

COMMENT ON COLUMN public.purchase_items.allocated_cost_total IS
  'Sum of capitalized-extra shares allocated to this line by the P2.1 '
  'allocation engine. Always >= 0.';

COMMENT ON COLUMN public.purchase_items.allocated_cost_per_unit IS
  'allocated_cost_total / quantity, stored at 4-decimal precision so the '
  '2-decimal landed unit_cost stays accurate after rounding.';

COMMENT ON COLUMN public.purchase_items.manual_allocation IS
  'TRUE when at least one capitalized extra on the parent purchase used '
  'allocation_method=manual to set this line''s allocated amount. Future '
  'edit flows use this flag to avoid reallocating manually-pinned shares.';

-- ──────────────────────────────────────────────────────────────────────────
-- 3) purchases : per-invoice aggregate totals.
-- ──────────────────────────────────────────────────────────────────────────
ALTER TABLE public.purchases
  ADD COLUMN IF NOT EXISTS extra_costs_capitalized       NUMERIC(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS extra_costs_non_capitalized   NUMERIC(14,2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.purchases.extra_costs_capitalized IS
  'P2.1 — sum of purchase_extra_costs.amount where capitalize_to_inventory=TRUE. '
  'Included in grand_total and supplier_ledger.amount. Debited to inventory '
  '(GL 1131) at postPurchase time alongside the base subtotal.';

COMMENT ON COLUMN public.purchases.extra_costs_non_capitalized IS
  'P2.1 — sum of purchase_extra_costs.amount where capitalize_to_inventory=FALSE. '
  'Included in grand_total and supplier_ledger.amount. Debited to misc '
  'operating expenses (GL 529) at postPurchase time.';

COMMIT;
