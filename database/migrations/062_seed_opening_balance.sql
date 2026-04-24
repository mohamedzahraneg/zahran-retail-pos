-- Migration 061: seed an opening-balance journal entry so the GL starts
--                out balanced on a fresh install.
-- ---------------------------------------------------------------------------
-- Context
--
-- Migration 016 (realistic seed) loads ~500 variants of stock directly
-- into the `stock` table, and ~90 sales invoices into `invoices`. When
-- those invoices later get posted to the GL (either by an admin action
-- in the UI or by a backfill job), each sale posts:
--
--     DR Cost-of-Goods-Sold (51x)  ·  CR Inventory (1131)
--
-- …with no matching DR side for the inventory that was "consumed".
-- The seed never records the other half — inventory was effectively
-- "dropped in" via `INSERT INTO stock` but never capitalized into GL.
--
-- Result: `chart_of_accounts.1131` runs negative by the total COGS,
-- Total Assets go negative, and the trial balance only holds because
-- Equity goes negative by the same amount. Demo installs look broken.
--
-- Fix
--
-- At the end of the migration run (after guards/RLS are in place), post
-- ONE balanced opening-balance journal entry:
--
--     DR 1131 Inventory  = value of the seed's initial stock
--                          (remaining stock + already-sold stock, at cost)
--     CR 31   Capital    = same
--
-- That mirrors what a real operator would do on Day 1 of using the
-- system: capitalize opening inventory against owner's equity. Sales
-- that later post COGS now draw 1131 DOWN from a positive opening,
-- which is what accounts are meant to do.
--
-- Safety
--
-- * Idempotent — we only post if NO opening-balance entry already
--   exists, so a re-run is a no-op. The engine's own idempotency index
--   `uq_je_live_reference` is also honoured via a deterministic UUID.
-- * Gated on the seed actually having been loaded — if there's no stock
--   and no invoice_items, we don't post anything. Production databases
--   that skipped the demo seed aren't affected.
-- * Runs inside `app.engine_context = 'on'` so migrations 058/059/060's
--   triggers + RLS accept the write. `SET LOCAL` scope means the GUC
--   is released when the migration transaction commits.

BEGIN;

DO $seed_opening$
DECLARE
  v_remaining_value  NUMERIC(14,2) := 0;
  v_sold_value       NUMERIC(14,2) := 0;
  v_opening          NUMERIC(14,2) := 0;
  v_admin_id         UUID;
  v_entry_id         UUID;
  v_entry_no         TEXT;
  v_seq              BIGINT;
  v_acct_inventory   UUID;
  v_acct_capital     UUID;
  v_ref_id           UUID;
BEGIN
  -- Gate 1: chart_of_accounts + journal tables must exist. (They're
  -- created in 048; this migration runs after 048 so they should be
  -- present, but check anyway so partial installs don't crash.)
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_schema='public' AND table_name='journal_entries'
  ) THEN
    RAISE NOTICE '061: journal_entries missing — skipping opening-balance seed';
    RETURN;
  END IF;

  -- Gate 2: resolve the inventory + capital accounts. If either is
  -- absent (a COA layout that renumbered things, for instance), we
  -- bail out rather than guess.
  SELECT id INTO v_acct_inventory
    FROM chart_of_accounts WHERE code = '1131' AND is_active = TRUE LIMIT 1;
  SELECT id INTO v_acct_capital
    FROM chart_of_accounts WHERE code = '31'   AND is_active = TRUE LIMIT 1;
  IF v_acct_inventory IS NULL OR v_acct_capital IS NULL THEN
    RAISE NOTICE '061: COA codes 1131 or 31 missing — skipping opening-balance seed';
    RETURN;
  END IF;

  -- Gate 3: idempotency. If any opening-balance entry already exists
  -- (from the engine's wizard or a prior run of this migration), we
  -- do nothing. The ledger is already in a consistent state.
  IF EXISTS (
    SELECT 1 FROM journal_entries
     WHERE reference_type = 'opening_balance'
       AND is_void = FALSE
  ) THEN
    RAISE NOTICE '061: opening-balance entry already exists — nothing to do';
    RETURN;
  END IF;

  -- Gate 4: only run on databases that have the demo seed loaded.
  -- Signal: stock table has rows. (A production DB where the operator
  -- will run the opening-balance wizard from the UI doesn't need this
  -- migration to pre-seed anything.)
  IF NOT EXISTS (SELECT 1 FROM stock LIMIT 1)
     AND NOT EXISTS (SELECT 1 FROM invoice_items LIMIT 1) THEN
    RAISE NOTICE '061: no seed stock detected — skipping opening-balance seed';
    RETURN;
  END IF;

  -- Compute the opening inventory value.
  --
  --   remaining = stock.quantity_on_hand × variants.cost_price
  --   sold      = invoice_items.quantity × variants.cost_price
  --   opening   = remaining + sold   (= the original on-hand value
  --                                    before any invoice reduced it)
  --
  -- Invoice items may have been seeded with `cost_at_sale` snapshot —
  -- prefer that if present, else fall back to variants.cost_price.
  SELECT COALESCE(SUM(s.quantity_on_hand * COALESCE(pv.cost_price, 0)), 0)
    INTO v_remaining_value
    FROM stock s
    JOIN product_variants pv ON pv.id = s.variant_id;

  -- invoice_items might have a per-line cost column (cost_at_sale /
  -- unit_cost). Detect and use it; otherwise fall back to the live
  -- variants.cost_price. We use EXISTS on information_schema so the
  -- seed works across schema revisions.
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='invoice_items' AND column_name='cost_at_sale'
  ) THEN
    EXECUTE $dyn$
      SELECT COALESCE(SUM(ii.quantity *
               COALESCE(ii.cost_at_sale, pv.cost_price, 0)), 0)
        FROM invoice_items ii
        JOIN product_variants pv ON pv.id = ii.variant_id
    $dyn$ INTO v_sold_value;
  ELSIF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name='invoice_items' AND column_name='unit_cost'
  ) THEN
    EXECUTE $dyn$
      SELECT COALESCE(SUM(ii.quantity *
               COALESCE(ii.unit_cost, pv.cost_price, 0)), 0)
        FROM invoice_items ii
        JOIN product_variants pv ON pv.id = ii.variant_id
    $dyn$ INTO v_sold_value;
  ELSE
    SELECT COALESCE(SUM(ii.quantity * COALESCE(pv.cost_price, 0)), 0)
      INTO v_sold_value
      FROM invoice_items ii
      JOIN product_variants pv ON pv.id = ii.variant_id;
  END IF;

  v_opening := v_remaining_value + v_sold_value;

  -- If everything was zero-cost (odd seed), nothing meaningful to post.
  IF v_opening < 0.01 THEN
    RAISE NOTICE '061: computed opening value is 0 — skipping';
    RETURN;
  END IF;

  -- Who is the notional "creator" of the opening entry. Pick any active
  -- admin; if none exist, leave NULL (journal_entries.created_by is
  -- nullable).
  SELECT id INTO v_admin_id
    FROM users
   WHERE is_active = TRUE
   ORDER BY created_at ASC
   LIMIT 1;

  -- Deterministic reference_id so the engine's idempotency index
  -- blocks any future replay.
  SELECT uuid_generate_v5(uuid_ns_dns(), 'seed-opening-balance:016')
    INTO v_ref_id;

  -- Raise the engine-context GUC so migrations 058/059/060's guards
  -- and RLS policies let us INSERT/UPDATE the ledger tables. LOCAL
  -- scope reverts at commit time.
  PERFORM set_config('app.engine_context', 'on', TRUE);

  -- Build entry_no from the shared sequence (same shape as the engine).
  SELECT nextval('seq_journal_entry_no') INTO v_seq;
  v_entry_no := 'JE-SEED-OPEN-' || LPAD(v_seq::text, 6, '0');

  INSERT INTO journal_entries (
    entry_no, entry_date, description,
    reference_type, reference_id,
    is_posted, posted_by, created_by
  ) VALUES (
    v_entry_no, CURRENT_DATE, 'قيد افتتاحي — مخزون seed (Migration 061)',
    'opening_balance', v_ref_id,
    FALSE, v_admin_id, v_admin_id
  ) RETURNING id INTO v_entry_id;

  -- Lines: DR 1131 Inventory, CR 31 Capital.
  INSERT INTO journal_lines (entry_id, line_no, account_id, debit, credit, description)
  VALUES
    (v_entry_id, 1, v_acct_inventory, v_opening, 0,
     format('مخزون افتتاحي (remaining %s + sold %s)',
            v_remaining_value::text, v_sold_value::text)),
    (v_entry_id, 2, v_acct_capital,   0, v_opening,
     'رأس المال — مقابل المخزون الافتتاحي');

  -- Post. The balance trigger (trg_je_enforce_balance, migration 048)
  -- validates Σdebit = Σcredit at this step.
  UPDATE journal_entries
     SET is_posted = TRUE, posted_at = NOW()
   WHERE id = v_entry_id;

  -- Audit trail — best-effort (table may not exist on pre-057 installs).
  BEGIN
    INSERT INTO financial_event_log
      (event_kind, reference_type, reference_id, entry_id, amount, user_id)
    VALUES
      ('opening_balance', 'opening_balance', v_ref_id, v_entry_id,
       v_opening, v_admin_id);
  EXCEPTION WHEN undefined_table THEN
    NULL;
  END;

  RAISE NOTICE '061: opening balance posted — DR 1131 = %, CR 31 = % (entry %)',
               v_opening, v_opening, v_entry_no;
END
$seed_opening$;

COMMIT;
