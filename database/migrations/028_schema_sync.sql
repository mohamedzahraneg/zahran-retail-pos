-- =============================================================================
-- 028_schema_sync.sql
-- Final schema-sync pass: add every column/alias/view the backend TS code or
-- existing views reference but the DB does not yet have.
--
-- Rules:
--   * 100% idempotent — every statement is IF NOT EXISTS or wrapped in DO $$..$$
--     with EXCEPTION WHEN others THEN NULL.
--   * Re-runnable any number of times.
--   * Does NOT drop or rename existing columns — only ADDs aliases and
--     back-fills them from canonical columns.
--   * Triggers keep alias columns in sync so reads and writes both work,
--     regardless of which column name the app uses.
-- =============================================================================

-- ── warehouses.name  (plain alias; many services + setup wizard need it) ──
ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS name VARCHAR(150);

UPDATE warehouses
   SET name = COALESCE(name, name_ar, name_en, code, 'Warehouse')
 WHERE name IS NULL;

DO $$ BEGIN
  BEGIN
    ALTER TABLE warehouses ALTER COLUMN name SET NOT NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- Keep warehouses.name, name_ar and name_en loosely in sync on write.
CREATE OR REPLACE FUNCTION fn_warehouses_sync_name()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.name IS NULL THEN
    NEW.name := COALESCE(NEW.name_ar, NEW.name_en, NEW.code, 'Warehouse');
  END IF;
  IF NEW.name_ar IS NULL THEN
    NEW.name_ar := NEW.name;
  END IF;
  IF NEW.name_en IS NULL THEN
    NEW.name_en := NEW.name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_warehouses_sync_name ON warehouses;
    CREATE TRIGGER trg_warehouses_sync_name
      BEFORE INSERT OR UPDATE ON warehouses
      FOR EACH ROW EXECUTE FUNCTION fn_warehouses_sync_name();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- ── products.name  (plain alias; reports + a few services use it) ─────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS name VARCHAR(255);

UPDATE products
   SET name = COALESCE(name, name_ar, name_en, sku_root, 'Product')
 WHERE name IS NULL;

CREATE OR REPLACE FUNCTION fn_products_sync_name()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.name IS NULL THEN
    NEW.name := COALESCE(NEW.name_ar, NEW.name_en, NEW.sku_root, 'Product');
  END IF;
  IF NEW.name_ar IS NULL THEN
    NEW.name_ar := NEW.name;
  END IF;
  IF NEW.name_en IS NULL THEN
    NEW.name_en := NEW.name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_products_sync_name ON products;
    CREATE TRIGGER trg_products_sync_name
      BEFORE INSERT OR UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION fn_products_sync_name();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- ── product_variants.color / .size (plain text aliases joining colors/sizes)
ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS color VARCHAR(100),
  ADD COLUMN IF NOT EXISTS size  VARCHAR(100);

-- Backfill from colors / sizes join tables if available.
DO $$ BEGIN
  BEGIN
    UPDATE product_variants pv
       SET color = COALESCE(pv.color, c.name_ar, c.name_en, c.code)
      FROM colors c
     WHERE c.id = pv.color_id
       AND pv.color IS NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE product_variants pv
       SET size = COALESCE(pv.size, s.size_label, s.code)
      FROM sizes s
     WHERE s.id = pv.size_id
       AND pv.size IS NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- Keep variant.color / .size hydrated on INSERT/UPDATE when *_id is set.
CREATE OR REPLACE FUNCTION fn_variants_sync_color_size()
RETURNS TRIGGER AS $$
DECLARE
  v_color TEXT;
  v_size  TEXT;
BEGIN
  IF NEW.color IS NULL AND NEW.color_id IS NOT NULL THEN
    BEGIN
      SELECT COALESCE(c.name_ar, c.name_en, c.code) INTO v_color
        FROM colors c WHERE c.id = NEW.color_id;
      NEW.color := v_color;
    EXCEPTION WHEN others THEN NULL;
    END;
  END IF;
  IF NEW.size IS NULL AND NEW.size_id IS NOT NULL THEN
    BEGIN
      SELECT COALESCE(s.size_label, s.code) INTO v_size
        FROM sizes s WHERE s.id = NEW.size_id;
      NEW.size := v_size;
    EXCEPTION WHEN others THEN NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_variants_sync_color_size ON product_variants;
    CREATE TRIGGER trg_variants_sync_color_size
      BEFORE INSERT OR UPDATE ON product_variants
      FOR EACH ROW EXECUTE FUNCTION fn_variants_sync_color_size();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- ── stock.quantity  (alias for quantity_on_hand) ──────────────────────────
ALTER TABLE stock
  ADD COLUMN IF NOT EXISTS quantity INT DEFAULT 0;

DO $$ BEGIN
  BEGIN
    UPDATE stock SET quantity = quantity_on_hand WHERE quantity IS DISTINCT FROM quantity_on_hand;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- Bidirectional sync so either column stays correct.
CREATE OR REPLACE FUNCTION fn_stock_sync_quantity()
RETURNS TRIGGER AS $$
BEGIN
  -- If app wrote quantity but not quantity_on_hand, mirror it.
  IF TG_OP = 'INSERT' THEN
    IF NEW.quantity IS NOT NULL AND (NEW.quantity_on_hand IS NULL OR NEW.quantity_on_hand = 0)
       AND NEW.quantity <> 0 THEN
      NEW.quantity_on_hand := NEW.quantity;
    ELSIF NEW.quantity_on_hand IS NOT NULL AND NEW.quantity IS NULL THEN
      NEW.quantity := NEW.quantity_on_hand;
    END IF;
  ELSE
    IF NEW.quantity IS DISTINCT FROM OLD.quantity
       AND NEW.quantity_on_hand IS NOT DISTINCT FROM OLD.quantity_on_hand THEN
      NEW.quantity_on_hand := NEW.quantity;
    ELSIF NEW.quantity_on_hand IS DISTINCT FROM OLD.quantity_on_hand
       AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity THEN
      NEW.quantity := NEW.quantity_on_hand;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_stock_sync_quantity ON stock;
    CREATE TRIGGER trg_stock_sync_quantity
      BEFORE INSERT OR UPDATE ON stock
      FOR EACH ROW EXECUTE FUNCTION fn_stock_sync_quantity();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- ── invoices : alias columns used by legacy services and view 020 ────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_total  NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS doc_no          VARCHAR(30),
  ADD COLUMN IF NOT EXISTS paid_total      NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS change_given    NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS issued_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by      UUID REFERENCES users(id) ON DELETE SET NULL;

-- Backfill aliases from canonical columns.
DO $$ BEGIN
  BEGIN
    UPDATE invoices
       SET discount_amount = COALESCE(discount_amount, 0) + COALESCE(invoice_discount, 0)
     WHERE COALESCE(discount_amount,0) = 0 AND COALESCE(invoice_discount,0) <> 0;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE invoices
       SET discount_total = COALESCE(discount_total, 0) + COALESCE(invoice_discount, 0)
                            + COALESCE(items_discount_total, 0)
                            + COALESCE(coupon_discount, 0)
     WHERE COALESCE(discount_total,0) = 0;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

UPDATE invoices SET doc_no       = invoice_no WHERE doc_no IS NULL AND invoice_no IS NOT NULL;
UPDATE invoices SET paid_total   = paid_amount WHERE paid_total IS NULL OR paid_total = 0;
UPDATE invoices SET change_given = change_amount WHERE change_given IS NULL OR change_given = 0;
UPDATE invoices SET issued_at    = COALESCE(completed_at, created_at) WHERE issued_at IS NULL;

-- Keep alias columns in sync on every insert/update.
CREATE OR REPLACE FUNCTION fn_invoices_sync_aliases()
RETURNS TRIGGER AS $$
BEGIN
  -- invoice_no ⇄ doc_no
  IF NEW.invoice_no IS NOT NULL AND (NEW.doc_no IS NULL OR NEW.doc_no = '') THEN
    NEW.doc_no := NEW.invoice_no;
  ELSIF NEW.doc_no IS NOT NULL AND (NEW.invoice_no IS NULL OR NEW.invoice_no = '') THEN
    NEW.invoice_no := NEW.doc_no;
  END IF;

  -- invoice_discount ⇄ discount_amount
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.discount_amount,0) <> 0 AND COALESCE(NEW.invoice_discount,0) = 0 THEN
      NEW.invoice_discount := NEW.discount_amount;
    ELSIF COALESCE(NEW.invoice_discount,0) <> 0 AND COALESCE(NEW.discount_amount,0) = 0 THEN
      NEW.discount_amount := NEW.invoice_discount;
    END IF;
  ELSE
    IF NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
       AND NEW.invoice_discount IS NOT DISTINCT FROM OLD.invoice_discount THEN
      NEW.invoice_discount := NEW.discount_amount;
    ELSIF NEW.invoice_discount IS DISTINCT FROM OLD.invoice_discount
       AND NEW.discount_amount IS NOT DISTINCT FROM OLD.discount_amount THEN
      NEW.discount_amount := NEW.invoice_discount;
    END IF;
  END IF;

  -- discount_total rollup
  NEW.discount_total := COALESCE(NEW.invoice_discount,0)
                      + COALESCE(NEW.items_discount_total,0)
                      + COALESCE(NEW.coupon_discount,0);

  -- paid_amount ⇄ paid_total
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.paid_total,0) <> 0 AND COALESCE(NEW.paid_amount,0) = 0 THEN
      NEW.paid_amount := NEW.paid_total;
    ELSIF COALESCE(NEW.paid_amount,0) <> 0 AND COALESCE(NEW.paid_total,0) = 0 THEN
      NEW.paid_total := NEW.paid_amount;
    END IF;
  ELSE
    IF NEW.paid_total IS DISTINCT FROM OLD.paid_total
       AND NEW.paid_amount IS NOT DISTINCT FROM OLD.paid_amount THEN
      NEW.paid_amount := NEW.paid_total;
    ELSIF NEW.paid_amount IS DISTINCT FROM OLD.paid_amount
       AND NEW.paid_total IS NOT DISTINCT FROM OLD.paid_total THEN
      NEW.paid_total := NEW.paid_amount;
    END IF;
  END IF;

  -- change_amount ⇄ change_given
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.change_given,0) <> 0 AND COALESCE(NEW.change_amount,0) = 0 THEN
      NEW.change_amount := NEW.change_given;
    ELSIF COALESCE(NEW.change_amount,0) <> 0 AND COALESCE(NEW.change_given,0) = 0 THEN
      NEW.change_given := NEW.change_amount;
    END IF;
  ELSE
    IF NEW.change_given IS DISTINCT FROM OLD.change_given
       AND NEW.change_amount IS NOT DISTINCT FROM OLD.change_amount THEN
      NEW.change_amount := NEW.change_given;
    ELSIF NEW.change_amount IS DISTINCT FROM OLD.change_amount
       AND NEW.change_given IS NOT DISTINCT FROM OLD.change_given THEN
      NEW.change_given := NEW.change_amount;
    END IF;
  END IF;

  -- issued_at ⇄ completed_at
  IF NEW.completed_at IS NOT NULL AND NEW.issued_at IS NULL THEN
    NEW.issued_at := NEW.completed_at;
  ELSIF NEW.issued_at IS NOT NULL AND NEW.completed_at IS NULL THEN
    NEW.completed_at := NEW.issued_at;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_invoices_sync_aliases ON invoices;
    CREATE TRIGGER trg_invoices_sync_aliases
      BEFORE INSERT OR UPDATE ON invoices
      FOR EACH ROW EXECUTE FUNCTION fn_invoices_sync_aliases();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoices_issued_at   ON invoices(issued_at);
CREATE INDEX IF NOT EXISTS idx_invoices_doc_no      ON invoices(doc_no);
CREATE INDEX IF NOT EXISTS idx_invoices_created_by  ON invoices(created_by);

-- ── invoice_items.cost_total  (qty * unit_cost) ──────────────────────────
ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS cost_total NUMERIC(14,2) DEFAULT 0;

UPDATE invoice_items
   SET cost_total = quantity * COALESCE(unit_cost, 0)
 WHERE cost_total IS NULL OR cost_total = 0;

CREATE OR REPLACE FUNCTION fn_invoice_items_sync_cost_total()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.cost_total IS NULL OR NEW.cost_total = 0 THEN
    NEW.cost_total := COALESCE(NEW.quantity,0) * COALESCE(NEW.unit_cost,0);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_invoice_items_sync_cost_total ON invoice_items;
    CREATE TRIGGER trg_invoice_items_sync_cost_total
      BEFORE INSERT OR UPDATE ON invoice_items
      FOR EACH ROW EXECUTE FUNCTION fn_invoice_items_sync_cost_total();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- ── invoice_payments.reference  (alias for reference_number) ─────────────
ALTER TABLE invoice_payments
  ADD COLUMN IF NOT EXISTS reference VARCHAR(100);

DO $$ BEGIN
  BEGIN
    UPDATE invoice_payments
       SET reference = reference_number
     WHERE reference IS NULL AND reference_number IS NOT NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

CREATE OR REPLACE FUNCTION fn_invoice_payments_sync_reference()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.reference IS NULL AND NEW.reference_number IS NOT NULL THEN
    NEW.reference := NEW.reference_number;
  ELSIF NEW.reference_number IS NULL AND NEW.reference IS NOT NULL THEN
    NEW.reference_number := NEW.reference;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_invoice_payments_sync_reference ON invoice_payments;
    CREATE TRIGGER trg_invoice_payments_sync_reference
      BEFORE INSERT OR UPDATE ON invoice_payments
      FOR EACH ROW EXECUTE FUNCTION fn_invoice_payments_sync_reference();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- ── invoice_lines  (VIEW aliasing invoice_items; read-only legacy paths) ─
-- accounting.service.ts + sync.service.ts + reservations.service.ts reference
-- a non-existent `invoice_lines` table with column `qty`. Provide a view.
DO $$ BEGIN
  BEGIN
    EXECUTE 'CREATE OR REPLACE VIEW invoice_lines AS
             SELECT ii.id,
                    ii.invoice_id,
                    ii.variant_id,
                    ii.quantity                    AS qty,
                    ii.quantity,
                    ii.unit_price,
                    ii.unit_cost,
                    ii.discount_amount,
                    ii.line_total,
                    ii.cost_total,
                    ii.tax_amount,
                    ii.created_at
               FROM invoice_items ii';
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- ── return_receipts (VIEW aliasing `returns` for accounting + sync) ──────
DO $$ BEGIN
  BEGIN
    EXECUTE 'CREATE OR REPLACE VIEW return_receipts AS
             SELECT r.id,
                    r.return_no,
                    r.original_invoice_id AS invoice_id,
                    r.customer_id,
                    r.warehouse_id,
                    CASE WHEN r.status IN (''approved'',''refunded'')
                         THEN ''completed''
                         ELSE r.status::text
                    END                          AS status,
                    r.total_refund,
                    r.restocking_fee,
                    r.net_refund,
                    r.net_refund                 AS total_refund_net,
                    r.refund_method,
                    r.requested_at,
                    r.approved_at,
                    r.refunded_at,
                    r.requested_at               AS created_at
               FROM returns r';
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- =============================================================================
-- End of 028_schema_sync.sql
-- =============================================================================
