-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Migration 137 : Purchase edit audit metadata
--                          (PR-PURCHASES-P2.3B)
--
--  WHAT THIS DOES
--    Adds three nullable columns to `purchases` so the new safe-edit
--    replacement flow (received + unpaid only) can record an
--    auditable link between the cancelled OLD invoice and the
--    corrected NEW invoice without relying on free-text notes:
--
--      · replaces_purchase_id     UUID NULL — set on the NEW row,
--                                  points at the OLD (cancelled) row
--      · replaced_by_purchase_id  UUID NULL — set on the OLD
--                                  (cancelled) row, points at the NEW row
--      · edit_reason              TEXT NULL — operator-supplied reason
--                                  for the edit, stored on the OLD row
--
--    Self-referential FKs with ON DELETE SET NULL so deleting one side
--    won't cascade-delete the chain (only the link breaks).
--
--    Partial indexes on `WHERE … IS NOT NULL` keep the index tiny —
--    only purchases involved in an edit chain are stored.
--
--  WHAT THIS DOES NOT DO
--    * No schema change to `purchase_items`, `purchase_extra_costs`,
--      `stock`, `stock_movements`, `supplier_ledger`, `supplier_payments`,
--      `journal_entries`, `journal_lines`, `cashbox_transactions`,
--      `cashbox_balances`, `product_variants`.
--    * No backfill. Pre-P2.3B purchases keep all three new columns NULL.
--    * No mutation of any existing row. Purely additive.
--    * No drop / alter of any existing column / constraint / index.
--    * No new triggers or functions.
--    * No accounting / GL impact. These columns are operator-audit
--      metadata, never read by any posting / cashbox / supplier-ledger
--      code path.
--
--  HOW IT INTEGRATES
--    The new `PurchasesService.edit()` non-draft path (received +
--    unpaid only) writes into these columns inside the same
--    transaction that calls `fn_void_purchase` + `reverseByReference`
--    + `create()` + `receive()`. Either the whole chain succeeds or
--    the transaction rolls back — leaving these columns NULL on a
--    purchase that wasn't actually replaced.
--
--    Paid / partial purchases stay BLOCKED in P2.3B; the columns are
--    inert for them. P2.3C will revisit the paid-edit story with a
--    refund / top-up flow.
-- ============================================================================

ALTER TABLE purchases
  ADD COLUMN IF NOT EXISTS replaces_purchase_id      UUID NULL,
  ADD COLUMN IF NOT EXISTS replaced_by_purchase_id   UUID NULL,
  ADD COLUMN IF NOT EXISTS edit_reason               TEXT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchases_replaces_fk'
  ) THEN
    ALTER TABLE purchases
      ADD CONSTRAINT purchases_replaces_fk
        FOREIGN KEY (replaces_purchase_id)
          REFERENCES purchases(id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'purchases_replaced_by_fk'
  ) THEN
    ALTER TABLE purchases
      ADD CONSTRAINT purchases_replaced_by_fk
        FOREIGN KEY (replaced_by_purchase_id)
          REFERENCES purchases(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_purchases_replaces
  ON purchases(replaces_purchase_id)
  WHERE replaces_purchase_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_purchases_replaced_by
  ON purchases(replaced_by_purchase_id)
  WHERE replaced_by_purchase_id IS NOT NULL;

COMMENT ON COLUMN purchases.replaces_purchase_id IS
  'P2.3B: when set, this purchase replaces an older cancelled one (operator safe-edit). Points at the old purchase row.';
COMMENT ON COLUMN purchases.replaced_by_purchase_id IS
  'P2.3B: when set, this purchase has been superseded by a newer corrected one. Only non-null on rows with status=''cancelled''.';
COMMENT ON COLUMN purchases.edit_reason IS
  'P2.3B: operator-supplied reason for the edit, stored on the OLD (cancelled) row.';
