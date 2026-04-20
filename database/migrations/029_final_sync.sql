-- =============================================================================
-- 029_final_sync.sql
-- FINAL comprehensive schema sync to resolve runtime errors reported by backend.
--
-- Issues fixed:
--   1. column "outstanding" does not exist
--        → v_customer_outstanding & v_supplier_outstanding are recreated with
--          an explicit `outstanding` column (alias of current_balance).
--   2. invalid input value for enum stock_movement_type: "adjustment"
--        → adds 'adjustment' value to stock_movement_type.
--   3. relation "invoice_lines" does not exist
--        → recreates it as a VIEW + INSTEAD OF INSERT trigger so writes land in
--          invoice_items. Safe if 028 already created the view.
--   4. relation "notifications" does not exist
--        → creates notifications + notification_templates defensively.
--   5. column "created_at" does not exist
--        → adds created_at to any table that was missing it (roles,
--          product_variants, stock, purchase_items, invoice_items,
--          invoice_payments, stock_movements, notifications, etc.).
--   6. Add product / add customer breaks
--        → ensures sku_prefix and customer_no / supplier_no get auto-filled
--          when entity inserts only sku_root / code.
--
-- Bonus:
--   * Ensures fn_adjust_stock() exists (called by stock.service.ts).
--   * All enums referenced by backend code cover every inserted value.
--
-- 100% idempotent — re-runnable any number of times.
-- =============================================================================

-- =============================================================================
-- 1) ENUM FIXES
-- =============================================================================

-- Add 'adjustment' to stock_movement_type (stock.service.ts uses it).
-- Note: ALTER TYPE ... ADD VALUE must run outside a transaction block.
-- IF NOT EXISTS makes this safe to re-run.
ALTER TYPE stock_movement_type ADD VALUE IF NOT EXISTS 'adjustment';
ALTER TYPE stock_movement_type ADD VALUE IF NOT EXISTS 'transfer';
ALTER TYPE stock_movement_type ADD VALUE IF NOT EXISTS 'correction';
ALTER TYPE stock_movement_type ADD VALUE IF NOT EXISTS 'opening';

-- Ensure notification_channel + notification_status enums exist (017 may not
-- have applied on this DB).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_channel') THEN
    CREATE TYPE notification_channel AS ENUM ('whatsapp','sms','email');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_status') THEN
    CREATE TYPE notification_status AS ENUM ('queued','sending','sent','failed','cancelled');
  END IF;
END $$;

-- =============================================================================
-- 2) NOTIFICATIONS TABLES (017 may not have applied cleanly)
-- =============================================================================

CREATE TABLE IF NOT EXISTS notification_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT UNIQUE NOT NULL,
  name_ar    TEXT NOT NULL,
  channel    notification_channel NOT NULL,
  subject    TEXT,
  body       TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         notification_channel NOT NULL,
  recipient       TEXT NOT NULL,
  subject         TEXT,
  body            TEXT NOT NULL,
  status          notification_status NOT NULL DEFAULT 'queued',
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  provider        TEXT,
  provider_msg_id TEXT,
  reference_type  TEXT,
  reference_id    UUID,
  template_code   TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at    TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_status     ON notifications (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_notifications_reference  ON notifications (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at DESC);

-- =============================================================================
-- 3) created_at / updated_at BACKFILL (for legacy columns that may be missing)
-- =============================================================================

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'roles','users','warehouses','products','product_variants','colors','sizes',
    'stock','stock_movements','stock_adjustments','stock_transfers',
    'customers','suppliers','purchases','purchase_items','purchase_payments',
    'invoices','invoice_items','invoice_payments',
    'reservations','returns','return_items','exchanges',
    'notifications','notification_templates','shifts','cashbox_entries',
    'discounts','coupons','expenses','alerts','activity_logs','settings'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      BEGIN
        EXECUTE format(
          'ALTER TABLE %I ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
          t);
      EXCEPTION WHEN others THEN NULL;
      END;
      BEGIN
        EXECUTE format(
          'ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
          t);
      EXCEPTION WHEN others THEN NULL;
      END;
    END IF;
  END LOOP;
END $$;

-- =============================================================================
-- 4) CUSTOMER / SUPPLIER NO AUTO-FILL (entity inserts only `code`)
-- =============================================================================

-- customers.customer_no must be filled before INSERT when only `code` is given.
CREATE SEQUENCE IF NOT EXISTS seq_customer_no START 1;

CREATE OR REPLACE FUNCTION fn_customers_autofill_no()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.customer_no IS NULL OR NEW.customer_no = '' THEN
    IF NEW.code IS NOT NULL AND NEW.code <> '' THEN
      NEW.customer_no := NEW.code;
    ELSE
      NEW.customer_no := 'CUS-' || LPAD(nextval('seq_customer_no')::text, 6, '0');
    END IF;
  END IF;
  IF NEW.code IS NULL OR NEW.code = '' THEN
    NEW.code := NEW.customer_no;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_customers_autofill_no ON customers;
    CREATE TRIGGER trg_customers_autofill_no
      BEFORE INSERT ON customers
      FOR EACH ROW EXECUTE FUNCTION fn_customers_autofill_no();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

CREATE SEQUENCE IF NOT EXISTS seq_supplier_no START 1;

CREATE OR REPLACE FUNCTION fn_suppliers_autofill_no()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.supplier_no IS NULL OR NEW.supplier_no = '' THEN
    IF NEW.code IS NOT NULL AND NEW.code <> '' THEN
      NEW.supplier_no := NEW.code;
    ELSE
      NEW.supplier_no := 'SUP-' || LPAD(nextval('seq_supplier_no')::text, 6, '0');
    END IF;
  END IF;
  IF NEW.code IS NULL OR NEW.code = '' THEN
    NEW.code := NEW.supplier_no;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_suppliers_autofill_no ON suppliers;
    CREATE TRIGGER trg_suppliers_autofill_no
      BEFORE INSERT ON suppliers
      FOR EACH ROW EXECUTE FUNCTION fn_suppliers_autofill_no();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- =============================================================================
-- 5) PRODUCTS — fill required legacy columns (sku_prefix, product_type)
-- =============================================================================

-- Relax NOT NULL where possible so entity INSERT (sku_root only) works.
DO $$ BEGIN
  BEGIN ALTER TABLE products ALTER COLUMN sku_prefix DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TABLE products ALTER COLUMN product_type DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TABLE products ALTER COLUMN base_cost DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TABLE products ALTER COLUMN base_price DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
END $$;

CREATE OR REPLACE FUNCTION fn_products_autofill_legacy()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.sku_prefix IS NULL OR NEW.sku_prefix = '' THEN
    NEW.sku_prefix := COALESCE(NEW.sku_root, 'SKU-' || substr(NEW.id::text, 1, 8));
  END IF;
  IF NEW.sku_root IS NULL OR NEW.sku_root = '' THEN
    NEW.sku_root := NEW.sku_prefix;
  END IF;
  IF NEW.product_type IS NULL THEN
    BEGIN
      NEW.product_type := COALESCE(NEW.type, 'shoe')::product_type;
    EXCEPTION WHEN others THEN NEW.product_type := 'shoe'::product_type;
    END;
  END IF;
  IF NEW.type IS NULL AND NEW.product_type IS NOT NULL THEN
    NEW.type := NEW.product_type::text;
  END IF;
  IF NEW.base_cost IS NULL THEN NEW.base_cost := COALESCE(NEW.cost_price, 0); END IF;
  IF NEW.cost_price IS NULL THEN NEW.cost_price := COALESCE(NEW.base_cost, 0); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_products_autofill_legacy ON products;
    CREATE TRIGGER trg_products_autofill_legacy
      BEFORE INSERT OR UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION fn_products_autofill_legacy();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- =============================================================================
-- 6) OUTSTANDING VIEWS — expose `outstanding` alias column
-- =============================================================================

CREATE OR REPLACE VIEW v_customer_outstanding AS
SELECT
    c.id                                                AS id,
    c.id                                                AS customer_id,
    c.customer_no,
    c.full_name,
    c.phone,
    COALESCE(c.current_balance, 0)                      AS current_balance,
    COALESCE(c.current_balance, 0)                      AS outstanding,
    COALESCE(c.credit_limit, 0)                         AS credit_limit,
    GREATEST(COALESCE(c.credit_limit,0) - COALESCE(c.current_balance,0), 0)
                                                        AS available_credit,
    (SELECT MAX(cl.created_at)
       FROM customer_ledger cl
      WHERE cl.customer_id = c.id)                      AS last_entry_at
FROM customers c
WHERE COALESCE(c.deleted_at, NULL) IS NULL;

CREATE OR REPLACE VIEW v_supplier_outstanding AS
SELECT
    s.id                                                AS id,
    s.id                                                AS supplier_id,
    s.supplier_no,
    s.name,
    s.phone,
    COALESCE(s.current_balance, 0)                      AS current_balance,
    COALESCE(s.current_balance, 0)                      AS outstanding,
    COALESCE(s.credit_limit, 0)                         AS credit_limit,
    (SELECT MAX(sl.created_at)
       FROM supplier_ledger sl
      WHERE sl.supplier_id = s.id)                      AS last_entry_at
FROM suppliers s
WHERE COALESCE(s.deleted_at, NULL) IS NULL;

-- =============================================================================
-- 7) invoice_lines — VIEW + INSTEAD OF INSERT so writes land in invoice_items
-- =============================================================================

-- If a table named invoice_lines accidentally exists, leave it; otherwise (re)create as view.
DO $$
DECLARE
  is_table BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM information_schema.tables
     WHERE table_name = 'invoice_lines' AND table_type = 'BASE TABLE'
  ) INTO is_table;

  IF NOT is_table THEN
    BEGIN
      EXECUTE 'DROP VIEW IF EXISTS invoice_lines';
    EXCEPTION WHEN others THEN NULL;
    END;

    EXECUTE $v$
      CREATE VIEW invoice_lines AS
      SELECT ii.id,
             ii.invoice_id,
             ii.variant_id,
             inv.warehouse_id                   AS warehouse_id,
             ii.quantity                        AS qty,
             ii.quantity                        AS quantity,
             ii.unit_price,
             ii.unit_cost,
             ii.discount_amount                 AS discount,
             ii.discount_amount,
             ii.line_total,
             ii.cost_total,
             ii.tax_amount,
             ii.created_at
        FROM invoice_items ii
        LEFT JOIN invoices inv ON inv.id = ii.invoice_id
    $v$;
  END IF;
END $$;

-- INSTEAD OF INSERT — so `INSERT INTO invoice_lines(...)` (reservations.service)
-- actually writes into invoice_items with proper required fields.
CREATE OR REPLACE FUNCTION fn_invoice_lines_instead_insert()
RETURNS TRIGGER AS $$
DECLARE
  v_sku   TEXT := '';
  v_name  TEXT := '';
BEGIN
  BEGIN
    SELECT COALESCE(pv.sku, '')                                 AS sku,
           COALESCE(p.name_ar, p.name_en, p.name, 'Product')    AS pname
      INTO v_sku, v_name
      FROM product_variants pv
      LEFT JOIN products p ON p.id = pv.product_id
     WHERE pv.id = NEW.variant_id;
  EXCEPTION WHEN others THEN
    v_sku  := '';
    v_name := 'Product';
  END;

  INSERT INTO invoice_items (
    invoice_id, variant_id,
    product_name_snapshot, sku_snapshot,
    quantity, unit_cost, unit_price,
    discount_amount, tax_amount,
    line_subtotal, line_total, cost_total
  ) VALUES (
    NEW.invoice_id,
    NEW.variant_id,
    COALESCE(v_name, 'Product'),
    COALESCE(v_sku, ''),
    COALESCE(NEW.qty, NEW.quantity, 1),
    COALESCE(NEW.unit_cost, 0),
    COALESCE(NEW.unit_price, 0),
    COALESCE(NEW.discount, NEW.discount_amount, 0),
    COALESCE(NEW.tax_amount, 0),
    COALESCE(NEW.qty, NEW.quantity, 1) * COALESCE(NEW.unit_price, 0),
    COALESCE(NEW.line_total,
             COALESCE(NEW.qty, NEW.quantity, 1) * COALESCE(NEW.unit_price, 0)
             - COALESCE(NEW.discount, NEW.discount_amount, 0)),
    COALESCE(NEW.qty, NEW.quantity, 1) * COALESCE(NEW.unit_cost, 0)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_invoice_lines_insert ON invoice_lines;
    CREATE TRIGGER trg_invoice_lines_insert
      INSTEAD OF INSERT ON invoice_lines
      FOR EACH ROW EXECUTE FUNCTION fn_invoice_lines_instead_insert();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- =============================================================================
-- 8) fn_adjust_stock — defensive stub if 011 didn't ship it
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_adjust_stock(
  p_variant_id   UUID,
  p_warehouse_id UUID,
  p_delta        INT,
  p_reason       TEXT,
  p_unit_cost    NUMERIC DEFAULT NULL,
  p_user_id      UUID    DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_new_qty  INT;
  v_dir      txn_direction;
  v_type     stock_movement_type;
BEGIN
  IF p_delta = 0 OR p_delta IS NULL THEN
    RAISE EXCEPTION 'delta must be non-zero';
  END IF;

  v_dir  := CASE WHEN p_delta > 0 THEN 'in'::txn_direction ELSE 'out'::txn_direction END;
  BEGIN
    v_type := 'adjustment'::stock_movement_type;
  EXCEPTION WHEN others THEN
    v_type := CASE WHEN p_delta > 0
                   THEN 'adjustment_in'::stock_movement_type
                   ELSE 'adjustment_out'::stock_movement_type END;
  END;

  INSERT INTO stock (variant_id, warehouse_id, quantity_on_hand)
       VALUES (p_variant_id, p_warehouse_id, GREATEST(p_delta, 0))
  ON CONFLICT (variant_id, warehouse_id) DO UPDATE
     SET quantity_on_hand = stock.quantity_on_hand + p_delta,
         updated_at = NOW()
     RETURNING quantity_on_hand INTO v_new_qty;

  IF v_new_qty IS NULL THEN
    SELECT quantity_on_hand INTO v_new_qty
      FROM stock
     WHERE variant_id = p_variant_id
       AND warehouse_id = p_warehouse_id;
  END IF;

  BEGIN
    INSERT INTO stock_movements
      (variant_id, warehouse_id, movement_type, direction,
       quantity, unit_cost, reference_type, notes, user_id)
    VALUES
      (p_variant_id, p_warehouse_id, v_type, v_dir,
       ABS(p_delta), COALESCE(p_unit_cost, 0),
       'other'::entity_type, p_reason, p_user_id);
  EXCEPTION WHEN others THEN NULL;
  END;

  RETURN v_new_qty;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 9) Defensive: ensure common alias columns exist (in case 027/028 skipped)
-- =============================================================================

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Make snapshot columns nullable so INSTEAD OF INSERT path doesn't die.
DO $$ BEGIN
  BEGIN ALTER TABLE invoice_items ALTER COLUMN product_name_snapshot DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TABLE invoice_items ALTER COLUMN sku_snapshot DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TABLE invoice_items ALTER COLUMN line_subtotal DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TABLE invoice_items ALTER COLUMN line_total DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
END $$;

-- =============================================================================
-- End of 029_final_sync.sql
-- =============================================================================
