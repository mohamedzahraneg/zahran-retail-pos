-- 022_loyalty_earn_on_insert.sql
-- Fix: loyalty points accrual trigger only fires on UPDATE OF status,
-- but POS inserts invoices directly with status='paid'. So customers
-- never earn points. Split the logic into a shared function and call
-- it from both INSERT and UPDATE triggers.

CREATE OR REPLACE FUNCTION fn_accumulate_customer_core(
    p_invoice_id   uuid,
    p_customer_id  uuid,
    p_grand_total  numeric,
    p_cashier_id   uuid
) RETURNS VOID AS $$
DECLARE
    v_rate         numeric;
    v_earned       int;
BEGIN
    IF p_customer_id IS NULL THEN
        RETURN;
    END IF;

    -- Config: points_per_egp (defaults to 0.1 = 1pt per 10 EGP)
    SELECT COALESCE((value->>'points_per_egp')::numeric, 0.1) INTO v_rate
    FROM settings WHERE key = 'loyalty.rate';

    v_earned := FLOOR(p_grand_total * COALESCE(v_rate, 0.1))::int;

    IF v_earned <= 0 THEN
        -- Still update spend / visits, but skip points ledger row
        UPDATE customers
           SET total_spent   = total_spent + p_grand_total,
               visits_count  = visits_count + 1,
               last_visit_at = NOW()
         WHERE id = p_customer_id;
        RETURN;
    END IF;

    UPDATE customers
       SET total_spent    = total_spent + p_grand_total,
           visits_count   = visits_count + 1,
           last_visit_at  = NOW(),
           loyalty_points = loyalty_points + v_earned
     WHERE id = p_customer_id;

    -- Idempotent: do not double-insert if already present
    INSERT INTO customer_loyalty_transactions(
        customer_id, direction, points, reason, reference_type, reference_id, user_id
    )
    SELECT p_customer_id, 'in', v_earned, 'earned', 'invoice', p_invoice_id, p_cashier_id
    WHERE NOT EXISTS (
        SELECT 1 FROM customer_loyalty_transactions
         WHERE reference_type = 'invoice'
           AND reference_id   = p_invoice_id
           AND direction      = 'in'
           AND reason         = 'earned'
    );
END;
$$ LANGUAGE plpgsql;

-- Replace the existing UPDATE trigger function
CREATE OR REPLACE FUNCTION fn_accumulate_customer()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('paid','completed') AND
       (OLD.status IS DISTINCT FROM NEW.status) THEN
        PERFORM fn_accumulate_customer_core(
            NEW.id, NEW.customer_id, NEW.grand_total, NEW.cashier_id
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- NEW: INSERT trigger for invoices saved directly as paid
CREATE OR REPLACE FUNCTION fn_accumulate_customer_on_insert()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('paid','completed') THEN
        PERFORM fn_accumulate_customer_core(
            NEW.id, NEW.customer_id, NEW.grand_total, NEW.cashier_id
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customer_accumulate_insert ON invoices;
CREATE TRIGGER trg_customer_accumulate_insert
AFTER INSERT ON invoices
FOR EACH ROW EXECUTE FUNCTION fn_accumulate_customer_on_insert();
