-- 035_cashbox_txn_fn.sql
-- Implements the missing fn_record_cashbox_txn used throughout the codebase.
-- Posts a cashbox_transaction row AND updates the cashbox balance atomically.
-- Returns the new transaction id.

CREATE OR REPLACE FUNCTION public.fn_record_cashbox_txn(
    p_cashbox_id    uuid,
    p_direction     text,           -- 'in' | 'out'
    p_amount        numeric,
    p_category      text,           -- 'sale' | 'receipt' | 'payment' | 'purchase' | 'expense' | 'manual' | 'other' | ...
    p_reference_type text DEFAULT NULL,
    p_reference_id  uuid DEFAULT NULL,
    p_user_id       uuid DEFAULT NULL,
    p_notes         text DEFAULT NULL
) RETURNS bigint
LANGUAGE plpgsql AS $$
DECLARE
    v_current   numeric;
    v_new       numeric;
    v_txn_id    bigint;
BEGIN
    IF p_amount IS NULL OR p_amount <= 0 THEN
        RAISE EXCEPTION 'amount must be positive (got %)', p_amount;
    END IF;
    IF p_direction NOT IN ('in', 'out') THEN
        RAISE EXCEPTION 'direction must be in/out (got %)', p_direction;
    END IF;

    SELECT COALESCE(current_balance, 0) INTO v_current
      FROM cashboxes WHERE id = p_cashbox_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'cashbox % not found', p_cashbox_id;
    END IF;

    v_new := v_current + CASE WHEN p_direction = 'in' THEN p_amount ELSE -p_amount END;

    INSERT INTO cashbox_transactions
        (cashbox_id, direction, amount, category,
         reference_type, reference_id, balance_after, user_id, notes)
    VALUES
        (p_cashbox_id, p_direction::txn_direction, p_amount, p_category,
         NULLIF(p_reference_type, '')::entity_type, p_reference_id, v_new, p_user_id, p_notes)
    RETURNING id INTO v_txn_id;

    UPDATE cashboxes
       SET current_balance = v_new,
           updated_at = NOW()
     WHERE id = p_cashbox_id;

    RETURN v_txn_id;
END;
$$;

COMMENT ON FUNCTION public.fn_record_cashbox_txn IS
    'Record a cashbox transaction and update balance atomically. Used by POS (sale cash), cash desk (receipts/payments), expenses, and manual adjustments.';
