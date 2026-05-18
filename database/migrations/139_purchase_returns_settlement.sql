-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Migration 139 : Purchase Returns — Settlement
--                          (PR-P2.4A)
--
--  WHAT THIS DOES
--    Extends the existing `purchase_returns` + `purchase_return_items`
--    tables (migration 023) with the metadata the P2.4A safe-return
--    flow needs:
--
--    `purchase_returns`:
--      · settlement_type      one of {supplier_credit, cash_refund,
--                              bank_refund, no_settlement}. Default
--                              `supplier_credit` matches today's
--                              implicit behavior so existing rows
--                              stay valid.
--      · refund_amount        nullable; required when settlement_type
--                              ∈ {cash_refund, bank_refund}.
--      · cashbox_id           nullable; required when settlement_type
--                              ∈ {cash_refund, bank_refund}.
--      · posted_at / posted_by    when the return was posted.
--      · cancelled_at / cancelled_by   when the return was cancelled.
--
--    `purchase_return_items`:
--      · purchase_item_id     nullable FK to purchase_items so the
--                              returnable-qty calc can enforce
--                              "received minus already-returned" per
--                              source line. NULL on legacy rows.
--
--    A CHECK constraint on `purchase_returns` rejects impossible
--    settlement combinations:
--      · supplier_credit / no_settlement → cashbox_id & refund_amount
--        MUST be NULL.
--      · cash_refund / bank_refund       → cashbox_id NOT NULL AND
--                                          refund_amount NOT NULL.
--
--  WHAT THIS DOES NOT DO
--    * No mutation of any existing row. Purely additive.
--    * No backfill. Pre-P2.4A rows default to settlement_type=
--      'supplier_credit' (matches their actual behavior in code today).
--    * No drop / alter / rename of any existing column / constraint /
--      index.
--    * No triggers, no functions, no views.
--    * No journal_entries / journal_lines / cashbox_transactions /
--      stock_movements writes from this migration.
--    * No mutation of any other table.
-- ============================================================================

ALTER TABLE purchase_returns
  ADD COLUMN IF NOT EXISTS settlement_type   VARCHAR(20) NOT NULL DEFAULT 'supplier_credit',
  ADD COLUMN IF NOT EXISTS refund_amount     NUMERIC(14,2) NULL,
  ADD COLUMN IF NOT EXISTS cashbox_id        UUID NULL,
  ADD COLUMN IF NOT EXISTS posted_at         TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS posted_by         UUID NULL,
  ADD COLUMN IF NOT EXISTS cancelled_at      TIMESTAMPTZ NULL,
  ADD COLUMN IF NOT EXISTS cancelled_by      UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_returns_settlement_type_check'
  ) THEN
    ALTER TABLE purchase_returns
      ADD CONSTRAINT purchase_returns_settlement_type_check
        CHECK (settlement_type IN
          ('supplier_credit','cash_refund','bank_refund','no_settlement'));
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_returns_cashbox_fk'
  ) THEN
    ALTER TABLE purchase_returns
      ADD CONSTRAINT purchase_returns_cashbox_fk
        FOREIGN KEY (cashbox_id) REFERENCES cashboxes(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_returns_posted_by_fk'
  ) THEN
    ALTER TABLE purchase_returns
      ADD CONSTRAINT purchase_returns_posted_by_fk
        FOREIGN KEY (posted_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_returns_cancelled_by_fk'
  ) THEN
    ALTER TABLE purchase_returns
      ADD CONSTRAINT purchase_returns_cancelled_by_fk
        FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_returns_settlement_consistency'
  ) THEN
    ALTER TABLE purchase_returns
      ADD CONSTRAINT purchase_returns_settlement_consistency
        CHECK (
          (settlement_type IN ('supplier_credit','no_settlement')
             AND cashbox_id IS NULL AND refund_amount IS NULL)
          OR
          (settlement_type IN ('cash_refund','bank_refund')
             AND cashbox_id IS NOT NULL
             AND refund_amount IS NOT NULL
             AND refund_amount >= 0)
        );
  END IF;
END $$;

ALTER TABLE purchase_return_items
  ADD COLUMN IF NOT EXISTS purchase_item_id  UUID NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchase_return_items_purchase_item_fk'
  ) THEN
    ALTER TABLE purchase_return_items
      ADD CONSTRAINT purchase_return_items_purchase_item_fk
        FOREIGN KEY (purchase_item_id)
          REFERENCES purchase_items(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_purchase_return_items_purchase_item
  ON purchase_return_items(purchase_item_id)
  WHERE purchase_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_returns_cashbox
  ON purchase_returns(cashbox_id)
  WHERE cashbox_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_purchase_returns_posted
  ON purchase_returns(posted_at DESC)
  WHERE posted_at IS NOT NULL;

COMMENT ON COLUMN purchase_returns.settlement_type IS
  'P2.4A: how the financial side of the return is settled. supplier_credit reduces AP; cash_refund/bank_refund records a cashbox refund-in; no_settlement records only the stock movement.';
COMMENT ON COLUMN purchase_returns.refund_amount IS
  'P2.4A: amount of cash/bank refund actually received from the supplier. NULL for supplier_credit / no_settlement.';
COMMENT ON COLUMN purchase_returns.cashbox_id IS
  'P2.4A: target cashbox (cash or bank) where the refund landed. NULL for supplier_credit / no_settlement.';
COMMENT ON COLUMN purchase_return_items.purchase_item_id IS
  'P2.4A: source purchase_items row so the returnable-qty calc can enforce "received minus already-returned" per line. NULL on legacy rows.';
