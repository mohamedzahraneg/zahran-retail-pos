-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 011 : Functions, Triggers, Business Logic
-- ============================================================================

-- ---------------------------------------------------------------------------
--  1. Helper: generic updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables that have updated_at
DO $$
DECLARE
    t text;
BEGIN
    FOR t IN
        SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables tt
          ON tt.table_name = c.table_name AND tt.table_schema = c.table_schema
        WHERE c.table_schema = 'public'
          AND c.column_name = 'updated_at'
          AND tt.table_type = 'BASE TABLE'
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%s_updated
             BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION touch_updated_at();',
             t, t
        );
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
--  2. Document number sequences + generators
-- ---------------------------------------------------------------------------
CREATE SEQUENCE seq_invoice_no    START 1;
CREATE SEQUENCE seq_purchase_no   START 1;
CREATE SEQUENCE seq_transfer_no   START 1;
CREATE SEQUENCE seq_adjustment_no START 1;
CREATE SEQUENCE seq_count_no      START 1;
CREATE SEQUENCE seq_return_no     START 1;
CREATE SEQUENCE seq_exchange_no   START 1;
CREATE SEQUENCE seq_reservation_no START 1;
CREATE SEQUENCE seq_expense_no    START 1;
CREATE SEQUENCE seq_shift_no      START 1;
CREATE SEQUENCE seq_customer_no   START 1;
CREATE SEQUENCE seq_supplier_no   START 1;

CREATE OR REPLACE FUNCTION next_doc_no(prefix text, seq text)
RETURNS text AS $$
DECLARE
    yr text := TO_CHAR(CURRENT_DATE, 'YYYY');
    nextv bigint;
BEGIN
    EXECUTE format('SELECT nextval(%L)', seq) INTO nextv;
    RETURN prefix || '-' || yr || '-' || LPAD(nextv::text, 6, '0');
END;
$$ LANGUAGE plpgsql;

-- Assign doc number defaults via triggers -----------------------------------
CREATE OR REPLACE FUNCTION set_invoice_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.invoice_no IS NULL OR NEW.invoice_no = '' THEN
        NEW.invoice_no := next_doc_no('INV','seq_invoice_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_invoice_no BEFORE INSERT ON invoices
FOR EACH ROW EXECUTE FUNCTION set_invoice_no();

CREATE OR REPLACE FUNCTION set_purchase_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.purchase_no IS NULL OR NEW.purchase_no = '' THEN
        NEW.purchase_no := next_doc_no('PO','seq_purchase_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_purchase_no BEFORE INSERT ON purchases
FOR EACH ROW EXECUTE FUNCTION set_purchase_no();

CREATE OR REPLACE FUNCTION set_transfer_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.transfer_no IS NULL OR NEW.transfer_no = '' THEN
        NEW.transfer_no := next_doc_no('TRF','seq_transfer_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_transfer_no BEFORE INSERT ON stock_transfers
FOR EACH ROW EXECUTE FUNCTION set_transfer_no();

CREATE OR REPLACE FUNCTION set_adjustment_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.adjustment_no IS NULL OR NEW.adjustment_no = '' THEN
        NEW.adjustment_no := next_doc_no('ADJ','seq_adjustment_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_adjustment_no BEFORE INSERT ON stock_adjustments
FOR EACH ROW EXECUTE FUNCTION set_adjustment_no();

CREATE OR REPLACE FUNCTION set_count_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.count_no IS NULL OR NEW.count_no = '' THEN
        NEW.count_no := next_doc_no('CNT','seq_count_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_count_no BEFORE INSERT ON inventory_counts
FOR EACH ROW EXECUTE FUNCTION set_count_no();

CREATE OR REPLACE FUNCTION set_return_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.return_no IS NULL OR NEW.return_no = '' THEN
        NEW.return_no := next_doc_no('RET','seq_return_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_return_no BEFORE INSERT ON returns
FOR EACH ROW EXECUTE FUNCTION set_return_no();

CREATE OR REPLACE FUNCTION set_exchange_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.exchange_no IS NULL OR NEW.exchange_no = '' THEN
        NEW.exchange_no := next_doc_no('EXC','seq_exchange_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_exchange_no BEFORE INSERT ON exchanges
FOR EACH ROW EXECUTE FUNCTION set_exchange_no();

CREATE OR REPLACE FUNCTION set_reservation_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.reservation_no IS NULL OR NEW.reservation_no = '' THEN
        NEW.reservation_no := next_doc_no('RES','seq_reservation_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_reservation_no BEFORE INSERT ON reservations
FOR EACH ROW EXECUTE FUNCTION set_reservation_no();

CREATE OR REPLACE FUNCTION set_expense_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.expense_no IS NULL OR NEW.expense_no = '' THEN
        NEW.expense_no := next_doc_no('EXP','seq_expense_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_expense_no BEFORE INSERT ON expenses
FOR EACH ROW EXECUTE FUNCTION set_expense_no();

CREATE OR REPLACE FUNCTION set_shift_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.shift_no IS NULL OR NEW.shift_no = '' THEN
        NEW.shift_no := next_doc_no('SHF','seq_shift_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_shift_no BEFORE INSERT ON shifts
FOR EACH ROW EXECUTE FUNCTION set_shift_no();

CREATE OR REPLACE FUNCTION set_customer_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.customer_no IS NULL OR NEW.customer_no = '' THEN
        NEW.customer_no := 'CUS-' || LPAD(nextval('seq_customer_no')::text, 6, '0');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_customer_no BEFORE INSERT ON customers
FOR EACH ROW EXECUTE FUNCTION set_customer_no();

CREATE OR REPLACE FUNCTION set_supplier_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.supplier_no IS NULL OR NEW.supplier_no = '' THEN
        NEW.supplier_no := 'SUP-' || LPAD(nextval('seq_supplier_no')::text, 6, '0');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_supplier_no BEFORE INSERT ON suppliers
FOR EACH ROW EXECUTE FUNCTION set_supplier_no();

-- ---------------------------------------------------------------------------
--  3. Auto-generate SKU on product_variants insert
--     Format: <sku_prefix>-<colorCode>-<size|00>
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auto_generate_sku()
RETURNS TRIGGER AS $$
DECLARE
    p_prefix  text;
    c_name    text;
    c_code    text;
    s_label   text;
BEGIN
    IF NEW.sku IS NULL OR NEW.sku = '' THEN
        SELECT sku_prefix INTO p_prefix FROM products WHERE id = NEW.product_id;
        SELECT COALESCE(name_en, name_ar) INTO c_name FROM colors WHERE id = NEW.color_id;
        -- Use first 3 letters of color name, uppercased, fallback to color id hash
        c_code := UPPER(LEFT(REGEXP_REPLACE(COALESCE(c_name,'COL'), '[^A-Za-z0-9]', '', 'g'), 3));
        IF c_code = '' THEN
            c_code := 'CLR';
        END IF;

        IF NEW.size_id IS NOT NULL THEN
            SELECT size_label INTO s_label FROM sizes WHERE id = NEW.size_id;
        ELSE
            s_label := '00';
        END IF;

        NEW.sku := p_prefix || '-' || c_code || '-' || s_label;
        -- If collision, add random 4 chars
        IF EXISTS(SELECT 1 FROM product_variants WHERE sku = NEW.sku) THEN
            NEW.sku := NEW.sku || '-' || UPPER(SUBSTRING(MD5(random()::text), 1, 4));
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_variant_auto_sku
BEFORE INSERT ON product_variants
FOR EACH ROW EXECUTE FUNCTION auto_generate_sku();

-- ---------------------------------------------------------------------------
--  4. Stock updates driven by stock_movements
--     Every movement applies delta to stock.quantity_on_hand
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_stock_movement()
RETURNS TRIGGER AS $$
DECLARE
    delta int;
BEGIN
    delta := CASE WHEN NEW.direction = 'in' THEN NEW.quantity ELSE -NEW.quantity END;

    INSERT INTO stock (variant_id, warehouse_id, quantity_on_hand, quantity_reserved)
    VALUES (NEW.variant_id, NEW.warehouse_id, GREATEST(delta, 0), 0)
    ON CONFLICT (variant_id, warehouse_id)
    DO UPDATE SET
        quantity_on_hand = stock.quantity_on_hand + delta,
        updated_at = NOW();

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_apply_stock_movement
AFTER INSERT ON stock_movements
FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

-- ---------------------------------------------------------------------------
--  5. Reservations: manage quantity_reserved
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reservation_hold_stock()
RETURNS TRIGGER AS $$
DECLARE
    wh uuid;
BEGIN
    SELECT warehouse_id INTO wh FROM reservations WHERE id = NEW.reservation_id;

    INSERT INTO stock (variant_id, warehouse_id, quantity_on_hand, quantity_reserved)
    VALUES (NEW.variant_id, wh, 0, NEW.quantity)
    ON CONFLICT (variant_id, warehouse_id)
    DO UPDATE SET
        quantity_reserved = stock.quantity_reserved + NEW.quantity,
        updated_at = NOW();

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reservation_item_hold
AFTER INSERT ON reservation_items
FOR EACH ROW EXECUTE FUNCTION reservation_hold_stock();

-- When reservation is cancelled/expired -> release quantity_reserved
CREATE OR REPLACE FUNCTION reservation_release_stock()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'active' AND NEW.status IN ('cancelled','expired','completed') THEN
        -- completed means the items have just been sold through an invoice;
        -- the caller is responsible for inserting stock_movements of type 'reservation_sale'
        -- (direction 'out') BEFORE updating status.
        UPDATE stock s
        SET quantity_reserved = GREATEST(s.quantity_reserved - ri.quantity, 0),
            updated_at = NOW()
        FROM reservation_items ri
        WHERE ri.reservation_id = NEW.id
          AND s.variant_id    = ri.variant_id
          AND s.warehouse_id  = NEW.warehouse_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reservation_status_change
AFTER UPDATE OF status ON reservations
FOR EACH ROW EXECUTE FUNCTION reservation_release_stock();

-- ---------------------------------------------------------------------------
--  6. Low-stock alert trigger (runs after stock update)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_low_stock()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.quantity_on_hand <= NEW.reorder_point
       AND (OLD.quantity_on_hand IS NULL OR OLD.quantity_on_hand > NEW.reorder_point) THEN
        INSERT INTO alerts (alert_type, severity, title, message, entity, entity_id, metadata)
        VALUES (
            CASE WHEN NEW.quantity_on_hand = 0 THEN 'out_of_stock' ELSE 'low_stock' END,
            CASE WHEN NEW.quantity_on_hand = 0 THEN 'critical'     ELSE 'warning' END,
            'تنبيه مخزون',
            format('المنتج (variant %s) أصبح المخزون %s قطعة في المخزن %s',
                   NEW.variant_id, NEW.quantity_on_hand, NEW.warehouse_id),
            'stock',
            NEW.id,
            jsonb_build_object(
                'variant_id',  NEW.variant_id,
                'warehouse_id',NEW.warehouse_id,
                'quantity',    NEW.quantity_on_hand,
                'reorder_point', NEW.reorder_point
            )
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_low_stock
AFTER UPDATE OF quantity_on_hand ON stock
FOR EACH ROW EXECUTE FUNCTION check_low_stock();

-- ---------------------------------------------------------------------------
--  7. Invoice totals recompute (called from application layer usually,
--     but we keep a helper function for reuse)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recompute_invoice_totals(p_invoice_id uuid)
RETURNS void AS $$
DECLARE
    v_subtotal      numeric(14,2);
    v_items_disc    numeric(14,2);
    v_tax           numeric(14,2);
    v_cogs          numeric(14,2);
    v_inv_disc      numeric(14,2);
    v_coupon_disc   numeric(14,2);
    v_paid          numeric(14,2);
    v_grand         numeric(14,2);
BEGIN
    SELECT
        COALESCE(SUM(quantity * unit_price), 0),
        COALESCE(SUM(discount_amount),       0),
        COALESCE(SUM(tax_amount),            0),
        COALESCE(SUM(quantity * unit_cost),  0)
    INTO v_subtotal, v_items_disc, v_tax, v_cogs
    FROM invoice_items WHERE invoice_id = p_invoice_id;

    SELECT invoice_discount, coupon_discount
    INTO v_inv_disc, v_coupon_disc
    FROM invoices WHERE id = p_invoice_id;

    SELECT COALESCE(SUM(amount),0) INTO v_paid
    FROM invoice_payments WHERE invoice_id = p_invoice_id;

    v_grand := v_subtotal - v_items_disc - COALESCE(v_inv_disc,0) - COALESCE(v_coupon_disc,0) + v_tax;

    UPDATE invoices SET
        subtotal              = v_subtotal,
        items_discount_total  = v_items_disc,
        tax_amount            = v_tax,
        cogs_total            = v_cogs,
        grand_total           = GREATEST(v_grand, 0),
        paid_amount           = v_paid,
        gross_profit          = GREATEST(v_grand,0) - v_cogs,
        updated_at            = NOW()
    WHERE id = p_invoice_id;
END;
$$ LANGUAGE plpgsql;

-- Auto-recompute on invoice_items or invoice_payments change
CREATE OR REPLACE FUNCTION trg_recompute_invoice()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM recompute_invoice_totals(COALESCE(NEW.invoice_id, OLD.invoice_id));
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_items_recompute
AFTER INSERT OR UPDATE OR DELETE ON invoice_items
FOR EACH ROW EXECUTE FUNCTION trg_recompute_invoice();

CREATE TRIGGER trg_payments_recompute
AFTER INSERT OR UPDATE OR DELETE ON invoice_payments
FOR EACH ROW EXECUTE FUNCTION trg_recompute_invoice();

-- ---------------------------------------------------------------------------
--  8. Reservation totals recompute
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recompute_reservation_totals(p_res_id uuid)
RETURNS void AS $$
DECLARE
    v_subtotal numeric(14,2);
    v_disc     numeric(14,2);
    v_paid     numeric(14,2);
    v_refund   numeric(14,2);
BEGIN
    SELECT COALESCE(SUM(line_total),0), COALESCE(SUM(discount_amount),0)
      INTO v_subtotal, v_disc
      FROM reservation_items WHERE reservation_id = p_res_id;

    SELECT COALESCE(SUM(amount),0) INTO v_paid
      FROM reservation_payments WHERE reservation_id = p_res_id;

    SELECT COALESCE(SUM(net_refund_amount),0) INTO v_refund
      FROM reservation_refunds WHERE reservation_id = p_res_id;

    UPDATE reservations SET
        subtotal        = v_subtotal,
        discount_amount = v_disc,
        total_amount    = GREATEST(v_subtotal - v_disc, 0),
        paid_amount     = v_paid,
        refunded_amount = v_refund,
        updated_at      = NOW()
    WHERE id = p_res_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_recompute_reservation()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM recompute_reservation_totals(COALESCE(NEW.reservation_id, OLD.reservation_id));
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_res_items_recompute
AFTER INSERT OR UPDATE OR DELETE ON reservation_items
FOR EACH ROW EXECUTE FUNCTION trg_recompute_reservation();

CREATE TRIGGER trg_res_payments_recompute
AFTER INSERT OR UPDATE OR DELETE ON reservation_payments
FOR EACH ROW EXECUTE FUNCTION trg_recompute_reservation();

CREATE TRIGGER trg_res_refunds_recompute
AFTER INSERT OR UPDATE OR DELETE ON reservation_refunds
FOR EACH ROW EXECUTE FUNCTION trg_recompute_reservation();

-- ---------------------------------------------------------------------------
--  9. Audit trigger (generic JSONB diff) — wire to sensitive tables
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_audit_row()
RETURNS TRIGGER AS $$
DECLARE
    v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
    IF (TG_OP = 'INSERT') THEN
        INSERT INTO audit_logs(table_name, record_id, operation, changed_by, new_data)
        VALUES (TG_TABLE_NAME, NEW.id::text, 'I', v_user, to_jsonb(NEW));
        RETURN NEW;
    ELSIF (TG_OP = 'UPDATE') THEN
        INSERT INTO audit_logs(table_name, record_id, operation, changed_by, old_data, new_data)
        VALUES (TG_TABLE_NAME, NEW.id::text, 'U', v_user, to_jsonb(OLD), to_jsonb(NEW));
        RETURN NEW;
    ELSE
        INSERT INTO audit_logs(table_name, record_id, operation, changed_by, old_data)
        VALUES (TG_TABLE_NAME, OLD.id::text, 'D', v_user, to_jsonb(OLD));
        RETURN OLD;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Attach to sensitive tables
CREATE TRIGGER trg_audit_users         AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_products      AFTER INSERT OR UPDATE OR DELETE ON products
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_variants      AFTER INSERT OR UPDATE OR DELETE ON product_variants
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_invoices      AFTER INSERT OR UPDATE OR DELETE ON invoices
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_reservations  AFTER INSERT OR UPDATE OR DELETE ON reservations
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_purchases     AFTER INSERT OR UPDATE OR DELETE ON purchases
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_expenses      AFTER INSERT OR UPDATE OR DELETE ON expenses
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_stock_adj     AFTER INSERT OR UPDATE OR DELETE ON stock_adjustments
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_settings      AFTER INSERT OR UPDATE OR DELETE ON settings
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

-- ---------------------------------------------------------------------------
-- 10. Customer loyalty accumulation on paid invoice
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_accumulate_customer()
RETURNS TRIGGER AS $$
DECLARE
    v_rate NUMERIC;
BEGIN
    IF NEW.status IN ('paid','completed') AND
       (OLD.status IS DISTINCT FROM NEW.status) AND
       NEW.customer_id IS NOT NULL THEN

        -- 1 point per 10 EGP by default (configurable via settings)
        SELECT COALESCE((value->>'points_per_egp')::numeric, 0.1) INTO v_rate
        FROM settings WHERE key = 'loyalty.rate';

        UPDATE customers SET
            total_spent    = total_spent + NEW.grand_total,
            visits_count   = visits_count + 1,
            last_visit_at  = NOW(),
            loyalty_points = loyalty_points + FLOOR(NEW.grand_total * COALESCE(v_rate, 0.1))::int
        WHERE id = NEW.customer_id;

        INSERT INTO customer_loyalty_transactions(
            customer_id, direction, points, reason, reference_type, reference_id, user_id
        ) VALUES (
            NEW.customer_id, 'in',
            FLOOR(NEW.grand_total * COALESCE(v_rate, 0.1))::int,
            'earned', 'invoice', NEW.id, NEW.cashier_id
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customer_accumulate
AFTER UPDATE OF status ON invoices
FOR EACH ROW EXECUTE FUNCTION fn_accumulate_customer();
