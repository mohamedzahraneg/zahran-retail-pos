-- 033_void_invoice_and_edit.sql
-- 1) Implements the missing fn_void_invoice stored procedure.
-- 2) Adds fn_void_purchase helper for purchase cancel/reversal.
--
-- Model for fn_void_invoice(invoice_id, user_id, reason):
--   - Refuses if already voided.
--   - Creates reversing stock_movements (direction='in', type='adjustment')
--     which trigger fn_recalc_stock_on_move and put stock back.
--   - Creates a reversing cashbox transaction (direction='out', source='sale')
--     for each cash payment originally made against the invoice, so the
--     cashbox balance drops back.
--   - Reverses any loyalty points earned or redeemed via invoice reference.
--   - Marks the invoice status='cancelled', voided_at/voided_by/void_reason.
--
-- This SP is intentionally idempotent-safe: a repeated call on an already
-- cancelled invoice raises an exception rather than silently reversing again.

CREATE OR REPLACE FUNCTION public.fn_void_invoice(
    p_invoice_id uuid,
    p_user_id    uuid,
    p_reason     text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_status text;
    v_warehouse_id uuid;
    r record;
BEGIN
    SELECT status, warehouse_id INTO v_status, v_warehouse_id
      FROM invoices WHERE id = p_invoice_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'الفاتورة غير موجودة: %', p_invoice_id;
    END IF;
    IF v_status = 'cancelled' THEN
        RAISE EXCEPTION 'الفاتورة ملغاة بالفعل';
    END IF;

    -- 1) Reverse stock: one "adjustment in" per line
    FOR r IN
        SELECT variant_id, quantity, unit_cost
          FROM invoice_items
         WHERE invoice_id = p_invoice_id
    LOOP
        INSERT INTO stock_movements
            (variant_id, warehouse_id, movement_type, direction,
             quantity, unit_cost, reference_type, reference_id, user_id, notes)
        VALUES
            (r.variant_id, v_warehouse_id, 'adjustment', 'in',
             r.quantity, COALESCE(r.unit_cost, 0),
             'invoice', p_invoice_id, p_user_id,
             'إلغاء فاتورة: ' || COALESCE(p_reason, ''));
    END LOOP;

    -- 2) Reverse cashbox: one "out" per cash payment
    FOR r IN
        SELECT ip.amount, ct.cashbox_id
          FROM invoice_payments ip
          LEFT JOIN LATERAL (
            SELECT cashbox_id FROM cashbox_transactions
             WHERE reference_type = 'invoice' AND reference_id = p_invoice_id
             LIMIT 1
          ) ct ON TRUE
         WHERE ip.invoice_id = p_invoice_id
           AND ip.payment_method = 'cash'
    LOOP
        IF r.cashbox_id IS NOT NULL THEN
            PERFORM fn_record_cashbox_txn(
                r.cashbox_id, 'out', r.amount,
                'sale', 'invoice', p_invoice_id, p_user_id,
                'عكس صندوق لإلغاء فاتورة'
            );
        END IF;
    END LOOP;

    -- 3) Reverse loyalty:
    --    - earned points go negative via a fresh 'out' ledger row
    --    - redeemed points come back via an 'in' ledger row
    FOR r IN
        SELECT customer_id, direction, points, reason
          FROM customer_loyalty_transactions
         WHERE reference_type = 'invoice' AND reference_id = p_invoice_id
    LOOP
        IF r.direction = 'in' THEN
            UPDATE customers
               SET loyalty_points = GREATEST(0, loyalty_points - r.points),
                   updated_at = NOW()
             WHERE id = r.customer_id;
            INSERT INTO customer_loyalty_transactions
                (customer_id, direction, points, reason,
                 reference_type, reference_id, user_id)
            VALUES
                (r.customer_id, 'out', r.points, 'void_reverse',
                 'invoice', p_invoice_id, p_user_id);
        ELSIF r.direction = 'out' THEN
            UPDATE customers
               SET loyalty_points = loyalty_points + r.points,
                   updated_at = NOW()
             WHERE id = r.customer_id;
            INSERT INTO customer_loyalty_transactions
                (customer_id, direction, points, reason,
                 reference_type, reference_id, user_id)
            VALUES
                (r.customer_id, 'in', r.points, 'void_reverse',
                 'invoice', p_invoice_id, p_user_id);
        END IF;
    END LOOP;

    -- 4) Mark the invoice cancelled
    UPDATE invoices
       SET status       = 'cancelled',
           voided_at    = NOW(),
           voided_by    = p_user_id,
           void_reason  = p_reason,
           updated_at   = NOW()
     WHERE id = p_invoice_id;
END;
$$;

-- fn_void_purchase — mirrors the above for purchases. For received purchases
-- we create reversing stock 'out' movements; for paid purchases we reverse
-- cashbox 'in' by emitting an opposite txn.
CREATE OR REPLACE FUNCTION public.fn_void_purchase(
    p_purchase_id uuid,
    p_user_id     uuid,
    p_reason      text
) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
    v_status text;
    v_warehouse_id uuid;
    r record;
BEGIN
    SELECT status, warehouse_id INTO v_status, v_warehouse_id
      FROM purchases WHERE id = p_purchase_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'فاتورة المشتريات غير موجودة: %', p_purchase_id;
    END IF;
    IF v_status = 'cancelled' THEN
        RAISE EXCEPTION 'فاتورة المشتريات ملغاة بالفعل';
    END IF;

    -- Reverse stock only if the purchase was actually received.
    IF v_status IN ('received', 'partially_received', 'paid', 'partially_paid') THEN
        FOR r IN
            SELECT variant_id, quantity AS qty, unit_cost
              FROM purchase_items
             WHERE purchase_id = p_purchase_id
        LOOP
            IF COALESCE(r.qty, 0) > 0 THEN
                INSERT INTO stock_movements
                    (variant_id, warehouse_id, movement_type, direction,
                     quantity, unit_cost, reference_type, reference_id, user_id, notes)
                VALUES
                    (r.variant_id, v_warehouse_id, 'adjustment', 'out',
                     r.qty, COALESCE(r.unit_cost, 0),
                     'purchase', p_purchase_id, p_user_id,
                     'إلغاء فاتورة شراء: ' || COALESCE(p_reason, ''));
            END IF;
        END LOOP;
    END IF;

    -- Reverse any cash payments made against this purchase.
    FOR r IN
        SELECT sp.amount, sp.payment_method, ct.cashbox_id
          FROM supplier_payments sp
          LEFT JOIN LATERAL (
            SELECT cashbox_id FROM cashbox_transactions
             WHERE reference_type = 'purchase' AND reference_id = p_purchase_id
             LIMIT 1
          ) ct ON TRUE
         WHERE sp.purchase_id = p_purchase_id
           AND sp.payment_method = 'cash'
    LOOP
        IF r.cashbox_id IS NOT NULL THEN
            PERFORM fn_record_cashbox_txn(
                r.cashbox_id, 'in', r.amount,
                'purchase', 'purchase', p_purchase_id, p_user_id,
                'عكس صندوق لإلغاء فاتورة شراء'
            );
        END IF;
    END LOOP;

    UPDATE purchases
       SET status     = 'cancelled',
           updated_at = NOW()
     WHERE id = p_purchase_id;
END;
$$;
