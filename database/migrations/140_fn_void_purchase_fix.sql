-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Migration 140 : fn_void_purchase hotfix
--                          (PR-PURCHASES-P2.3C-FIX)
--
--  WHAT THIS DOES
--    CREATE OR REPLACE FUNCTION `fn_void_purchase` with the same
--    overall contract (reverse stock + reverse cash payments + mark
--    the purchase row 'cancelled') but with two corrections:
--
--      1. The cash-reversal SELECT in migration 033 referenced
--         `sp.purchase_id` on `supplier_payments` — that column does
--         not exist (migration 014 defines supplier_payments without
--         it; the payment ↔ purchase link lives in
--         supplier_payment_allocations). This made every non-draft
--         purchase cancel/edit path crash at runtime with:
--           ERROR: column sp.purchase_id does not exist
--         Replaced with the correct join:
--           supplier_payment_allocations spa
--             JOIN supplier_payments sp ON sp.id = spa.payment_id
--             WHERE spa.purchase_id = p_purchase_id
--
--      2. The original code reversed the full payment amount
--         (`sp.amount`) — wrong for multi-allocation payments where
--         only part of a payment was applied to this purchase.
--         Now uses `spa.allocated_amount` (the portion bound to
--         this purchase). Skips voided payments via
--         `COALESCE(sp.is_void, FALSE) = FALSE`.
--
--    Stock reversal (purchase_items → stock_movements) and the final
--    `UPDATE purchases SET status='cancelled'` are unchanged — same
--    behavior as migration 033 in those legs.
--
--  WHAT THIS DOES NOT DO
--    * No DDL change. `CREATE OR REPLACE FUNCTION` only — same name,
--      same signature `(uuid, uuid, text) RETURNS void`.
--    * No table / column / constraint / index / trigger changes.
--    * No backfill. No data mutation.
--    * No effect on already-cancelled purchases.
--    * No effect on POS, sales returns, or any other module.
-- ============================================================================

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

    -- Reverse the cash portion(s) allocated to this purchase. Joins
    -- through supplier_payment_allocations because supplier_payments
    -- does NOT carry purchase_id directly. spa.allocated_amount is
    -- the slice of each payment that was actually applied to this
    -- purchase. Voided payments are skipped.
    FOR r IN
        SELECT spa.allocated_amount AS amount,
               sp.payment_method,
               ct.cashbox_id
          FROM supplier_payment_allocations spa
          JOIN supplier_payments sp ON sp.id = spa.payment_id
          LEFT JOIN LATERAL (
            SELECT cashbox_id FROM cashbox_transactions
             WHERE reference_type = 'purchase' AND reference_id = p_purchase_id
             LIMIT 1
          ) ct ON TRUE
         WHERE spa.purchase_id = p_purchase_id
           AND sp.payment_method = 'cash'
           AND COALESCE(sp.is_void, FALSE) = FALSE
    LOOP
        IF r.cashbox_id IS NOT NULL AND COALESCE(r.amount, 0) > 0 THEN
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

COMMENT ON FUNCTION public.fn_void_purchase(uuid, uuid, text) IS
  'P2.3C-FIX (migration 140): replaces migration 033 body. Reverses stock for received purchases and reverses cash via supplier_payment_allocations (the supplier_payments table has no purchase_id column). Multi-allocation payments now reverse only their allocated portion (spa.allocated_amount). Voided payments are skipped.';
