-- Migration 056: auto-repair accounting state on boot (no UI buttons)
-- ---------------------------------------------------------------------------
-- The user's explicit instruction: "الغي الزرار وجود الزرار مش صح" —
-- remove the maintenance buttons, execute the cleanup server-side.
--
-- This migration runs ONCE (tracked by schema_migrations) and performs the
-- non-destructive repairs that the retired admin buttons used to trigger
-- manually:
--
--   1. Void duplicate live journal entries (same reference posted twice)
--   2. Delete duplicate cashbox_transactions rows (same source doc
--      imported twice by an old backfill)
--   3. Recompute every cashbox's current_balance from its transaction log
--   4. Recompute customers.current_balance from invoices − deposits
--   5. Recompute suppliers.current_balance from purchases − payments
--
-- Non-destructive by design — no source document (invoice / expense /
-- payment / return / purchase) is deleted or modified. This is the
-- "repair the ledger" half of the cleanup, not the "factory reset" half
-- (which belongs to the opening-balance wizard the user triggers from
-- the sidebar when they actually want a clean slate).
--
-- Idempotent: running it again on a clean DB is a no-op.

BEGIN;

-- ── (1) Dedupe journal entries ─────────────────────────────────────
-- Keeps the oldest LIVE entry per (reference_type, reference_id) and
-- voids the rest. Skips reversal entries and manual-only entries.
WITH live AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY reference_type, reference_id
           ORDER BY created_at ASC, id ASC
         ) AS rn
    FROM journal_entries
   WHERE reference_type IS NOT NULL
     AND reference_id   IS NOT NULL
     AND reference_type <> 'reversal'
     AND is_posted      = TRUE
     AND is_void        = FALSE
)
UPDATE journal_entries je
   SET is_void     = TRUE,
       void_reason = 'auto dedupe (migration 056) — duplicate of older entry',
       voided_at   = NOW()
  FROM live
 WHERE je.id = live.id
   AND live.rn > 1;

-- ── (2) Dedupe cashbox_transactions ────────────────────────────────
-- Same (cashbox, reference, direction, amount) on multiple rows means
-- a prior backfill imported the same source doc twice. Keep the oldest
-- row and drop the duplicates. Opening-balance / manual rows have
-- reference_id IS NULL and are left alone.
WITH dupes AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY cashbox_id, reference_type, reference_id,
                        direction, amount
           ORDER BY created_at ASC, id ASC
         ) AS rn
    FROM cashbox_transactions
   WHERE reference_id IS NOT NULL
)
DELETE FROM cashbox_transactions
 WHERE id IN (SELECT id FROM dupes WHERE rn > 1);

-- ── (3) Recompute every cashbox balance from its txn log ───────────
-- After dedupe the txn log is the truth. cashboxes.current_balance
-- must equal the running sum (in − out) of its transactions.
UPDATE cashboxes cb
   SET current_balance = COALESCE(agg.computed, 0),
       updated_at      = NOW()
  FROM (
    SELECT cashbox_id,
           SUM(CASE WHEN direction = 'in' THEN amount ELSE -amount END)::numeric(14,2) AS computed
      FROM cashbox_transactions
     GROUP BY cashbox_id
  ) agg
 WHERE cb.id = agg.cashbox_id;

-- Cashboxes with zero transactions: explicitly zero their balance too.
UPDATE cashboxes
   SET current_balance = 0, updated_at = NOW()
 WHERE id NOT IN (SELECT DISTINCT cashbox_id FROM cashbox_transactions)
   AND current_balance <> 0;

-- ── (4) Recompute customer balances from source documents ─────────
-- current_balance = outstanding invoice amount − non-void deposits
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'customers' AND column_name = 'current_balance'
  ) THEN
    UPDATE customers c
       SET current_balance = (agg.outstanding - agg.deposits)::numeric(14,2)
      FROM (
        SELECT c2.id AS customer_id,
               COALESCE((
                 SELECT SUM(i.grand_total - COALESCE(i.paid_amount, 0))
                   FROM invoices i
                  WHERE i.customer_id = c2.id
                    AND COALESCE(i.status::text, '') NOT IN ('cancelled', 'void', 'draft')
               ), 0) AS outstanding,
               COALESCE((
                 SELECT SUM(cp.amount)
                   FROM customer_payments cp
                  WHERE cp.customer_id = c2.id
                    AND cp.is_void = FALSE
                    AND cp.kind = 'deposit'
               ), 0) AS deposits
          FROM customers c2
      ) agg
     WHERE c.id = agg.customer_id;
  END IF;
END $$;

-- ── (5) Recompute supplier balances from source documents ─────────
-- current_balance = outstanding purchase amount (what we owe them)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'suppliers' AND column_name = 'current_balance'
  )
  AND EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_name = 'purchases'
  ) THEN
    UPDATE suppliers s
       SET current_balance = agg.owed::numeric(14,2)
      FROM (
        SELECT s2.id AS supplier_id,
               COALESCE((
                 SELECT SUM(p.grand_total - COALESCE(p.paid_amount, 0))
                   FROM purchases p
                  WHERE p.supplier_id = s2.id
                    AND COALESCE(p.status::text, '') NOT IN ('cancelled', 'draft')
               ), 0) AS owed
          FROM suppliers s2
      ) agg
     WHERE s.id = agg.supplier_id;
  END IF;
END $$;

COMMIT;
