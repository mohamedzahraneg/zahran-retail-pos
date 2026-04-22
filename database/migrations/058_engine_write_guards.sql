-- Migration 058: DB-level write guards — make FinancialEngineService the
--                ONLY path that can mutate GL + cash.
-- ---------------------------------------------------------------------------
-- Until now the "engine is the only writer" rule was enforced only at the
-- application layer (TypeScript). Anyone with `psql` access or a forgotten
-- backend service could still write directly to journal_entries,
-- journal_lines, or cashboxes.current_balance and bypass every invariant
-- the engine guarantees (idempotency, balance check, event-log emission).
--
-- This migration adds BEFORE triggers that REJECT writes unless the
-- calling session has explicitly set `app.engine_context = 'on'`. The
-- engine sets that flag inside every transaction it opens; nobody else
-- does.
--
-- Sanctioned bypasses (the ONLY writers allowed to raise the flag):
--   1. FinancialEngineService (every recordTransaction call)
--   2. fn_record_cashbox_txn — legacy plpgsql function the engine
--      delegates to for the cash half; it raises the flag internally
--   3. ReconciliationService.rebuildCashboxBalance — the rebuild
--      endpoint raises the flag for its single UPDATE
--
-- Everything else (raw psql, forgotten services, rogue scripts) will
-- fail with a clear exception and a pointer to the engine.
--
-- Idempotent. Safe on a partially-deployed DB.

BEGIN;

-- ───────────────────────────────────────────────────────────────────
-- Helper: is_engine_context()
-- Reads the session-local GUC `app.engine_context`. Returns TRUE only
-- when a calling transaction explicitly opted-in. `current_setting(...,
-- true)` returns NULL when the setting doesn't exist, which we treat
-- as "not the engine".
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_is_engine_context()
  RETURNS BOOLEAN LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN current_setting('app.engine_context', TRUE) = 'on';
END;
$$;

-- ───────────────────────────────────────────────────────────────────
-- Guard: journal_entries
-- Inserts are OK only in engine context. UPDATE of `is_posted` /
-- `is_void` is OK (those are legitimate lifecycle transitions done by
-- posting / reversal logic within the engine). DELETE is rejected
-- outright — GL entries must be voided, never hard-deleted.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_guard_journal_entries()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF NOT fn_is_engine_context() THEN
      RAISE EXCEPTION
        'journal_entries rows are immutable — void instead of delete '
        '(use FinancialEngineService.reverseByReference)';
    END IF;
  ELSIF TG_OP = 'INSERT' THEN
    IF NOT fn_is_engine_context() THEN
      RAISE EXCEPTION
        'direct INSERT into journal_entries is not allowed — route through '
        'FinancialEngineService.recordTransaction()';
    END IF;
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_journal_entries ON journal_entries;
CREATE TRIGGER trg_guard_journal_entries
  BEFORE INSERT OR DELETE ON journal_entries
  FOR EACH ROW EXECUTE FUNCTION fn_guard_journal_entries();

-- ───────────────────────────────────────────────────────────────────
-- Guard: journal_lines
-- Same policy — INSERT/DELETE only inside the engine.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_guard_journal_lines()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT fn_is_engine_context() THEN
    RAISE EXCEPTION
      'direct write to journal_lines is not allowed — route through '
      'FinancialEngineService.recordTransaction()';
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_journal_lines ON journal_lines;
CREATE TRIGGER trg_guard_journal_lines
  BEFORE INSERT OR DELETE ON journal_lines
  FOR EACH ROW EXECUTE FUNCTION fn_guard_journal_lines();

-- ───────────────────────────────────────────────────────────────────
-- Guard: cashboxes.current_balance
-- This column is DERIVED from the cashbox_transactions ledger. It must
-- only be mutated by:
--   - fn_record_cashbox_txn (the engine's cash-movement primitive),
--     which raises app.engine_context itself before it runs
--   - ReconciliationService.rebuildCashboxBalance (sanctioned rebuild)
--
-- Other columns on `cashboxes` (name, kind, opening_balance, etc.) are
-- free to edit — only current_balance is locked down.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_guard_cashbox_balance()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.current_balance IS DISTINCT FROM NEW.current_balance THEN
    IF NOT fn_is_engine_context() THEN
      RAISE EXCEPTION
        'direct UPDATE of cashboxes.current_balance is not allowed — '
        'use fn_record_cashbox_txn or ReconciliationService.rebuildCashboxBalance';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_cashbox_balance ON cashboxes;
CREATE TRIGGER trg_guard_cashbox_balance
  BEFORE UPDATE ON cashboxes
  FOR EACH ROW EXECUTE FUNCTION fn_guard_cashbox_balance();

-- ───────────────────────────────────────────────────────────────────
-- Update fn_record_cashbox_txn to raise the flag itself so code that
-- calls it (the engine, legacy triggers like trg_supplier_payment_apply,
-- POS cash payments, etc.) passes the guard.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_record_cashbox_txn(
    p_cashbox_id    uuid,
    p_direction     text,
    p_amount        numeric,
    p_category      text,
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

    -- Opt this transaction into the engine-context so the cashbox
    -- balance-update guard lets us write. LOCAL scope = reverts at end
    -- of txn.
    PERFORM set_config('app.engine_context', 'on', TRUE);

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

-- ───────────────────────────────────────────────────────────────────
-- Update the triggers from migration 014 so they raise the flag too.
-- trg_customer_payment_apply + trg_supplier_payment_apply both do an
-- UPDATE cashboxes SET current_balance directly, so without this the
-- guard above would reject legitimate customer/supplier receipts.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_customer_payment_apply()
RETURNS TRIGGER AS $$
DECLARE
    v_balance NUMERIC(14,2);
    v_cb_balance NUMERIC(14,2);
BEGIN
    PERFORM set_config('app.engine_context', 'on', TRUE);

    IF NEW.payment_method = 'cash' THEN
        SELECT COALESCE(current_balance,0) + NEW.amount INTO v_cb_balance
        FROM cashboxes WHERE id = NEW.cashbox_id;

        UPDATE cashboxes SET current_balance = v_cb_balance, updated_at = NOW()
        WHERE id = NEW.cashbox_id;

        INSERT INTO cashbox_transactions(cashbox_id, direction, amount, category,
                                         reference_type, reference_id, balance_after,
                                         notes, user_id)
        VALUES (NEW.cashbox_id, 'in', NEW.amount, 'customer_payment',
                'other', NEW.id, v_cb_balance,
                format('تحصيل من عميل — %s', NEW.payment_no), NEW.received_by);
    END IF;

    UPDATE customers SET current_balance = current_balance - NEW.amount,
                         updated_at = NOW()
    WHERE id = NEW.customer_id
    RETURNING current_balance INTO v_balance;

    INSERT INTO customer_ledger(customer_id, entry_date, direction, amount,
                                reference_type, reference_id, balance_after,
                                notes, user_id)
    VALUES (NEW.customer_id, CURRENT_DATE, 'in', NEW.amount, 'other', NEW.id, v_balance,
            COALESCE(NEW.notes, 'تحصيل نقدية'), NEW.received_by);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_supplier_payment_apply()
RETURNS TRIGGER AS $$
DECLARE
    v_balance NUMERIC(14,2);
    v_cb_balance NUMERIC(14,2);
BEGIN
    PERFORM set_config('app.engine_context', 'on', TRUE);

    IF NEW.payment_method = 'cash' THEN
        SELECT COALESCE(current_balance,0) - NEW.amount INTO v_cb_balance
        FROM cashboxes WHERE id = NEW.cashbox_id;

        UPDATE cashboxes SET current_balance = v_cb_balance, updated_at = NOW()
        WHERE id = NEW.cashbox_id;

        INSERT INTO cashbox_transactions(cashbox_id, direction, amount, category,
                                         reference_type, reference_id, balance_after,
                                         notes, user_id)
        VALUES (NEW.cashbox_id, 'out', NEW.amount, 'supplier_payment',
                'other', NEW.id, v_cb_balance,
                format('دفع لمورد — %s', NEW.payment_no), NEW.paid_by);
    END IF;

    UPDATE suppliers SET current_balance = current_balance - NEW.amount,
                         updated_at = NOW()
    WHERE id = NEW.supplier_id
    RETURNING current_balance INTO v_balance;

    INSERT INTO supplier_ledger(supplier_id, entry_date, direction, amount,
                                reference_type, reference_id, balance_after,
                                notes, user_id)
    VALUES (NEW.supplier_id, CURRENT_DATE, 'out', NEW.amount, 'other', NEW.id, v_balance,
            COALESCE(NEW.notes, 'دفع نقدية'), NEW.paid_by);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- And the void handlers (migration 014 lines 301-350 area) — these
-- also touch cashboxes.current_balance when a payment is voided.
CREATE OR REPLACE FUNCTION fn_customer_payment_void()
RETURNS TRIGGER AS $$
DECLARE v_cb_balance NUMERIC(14,2);
BEGIN
    PERFORM set_config('app.engine_context', 'on', TRUE);

    IF OLD.is_void = FALSE AND NEW.is_void = TRUE THEN
        IF OLD.payment_method = 'cash' THEN
            SELECT COALESCE(current_balance,0) - OLD.amount INTO v_cb_balance
            FROM cashboxes WHERE id = OLD.cashbox_id;

            UPDATE cashboxes SET current_balance = v_cb_balance, updated_at = NOW()
            WHERE id = OLD.cashbox_id;

            INSERT INTO cashbox_transactions(cashbox_id, direction, amount, category,
                                             reference_type, reference_id, balance_after,
                                             notes, user_id)
            VALUES (OLD.cashbox_id, 'out', OLD.amount, 'customer_payment_void',
                    'other', OLD.id, v_cb_balance,
                    format('إلغاء تحصيل — %s', OLD.payment_no), NEW.voided_by);
        END IF;

        UPDATE customers SET current_balance = current_balance + OLD.amount,
                             updated_at = NOW()
         WHERE id = OLD.customer_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION fn_supplier_payment_void()
RETURNS TRIGGER AS $$
DECLARE v_cb_balance NUMERIC(14,2);
BEGIN
    PERFORM set_config('app.engine_context', 'on', TRUE);

    IF OLD.is_void = FALSE AND NEW.is_void = TRUE THEN
        IF OLD.payment_method = 'cash' THEN
            SELECT COALESCE(current_balance,0) + OLD.amount INTO v_cb_balance
            FROM cashboxes WHERE id = OLD.cashbox_id;

            UPDATE cashboxes SET current_balance = v_cb_balance, updated_at = NOW()
            WHERE id = OLD.cashbox_id;

            INSERT INTO cashbox_transactions(cashbox_id, direction, amount, category,
                                             reference_type, reference_id, balance_after,
                                             notes, user_id)
            VALUES (OLD.cashbox_id, 'in', OLD.amount, 'supplier_payment_void',
                    'other', OLD.id, v_cb_balance,
                    format('إلغاء دفع — %s', OLD.payment_no), NEW.voided_by);
        END IF;

        UPDATE suppliers SET current_balance = current_balance + OLD.amount,
                             updated_at = NOW()
         WHERE id = OLD.supplier_id;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMIT;
