-- ============================================================================
-- 120 — PR-FIN-PAYACCT-3: customer/supplier payment triggers stop dropping
--                          legacy 'on' bypass alerts
-- ============================================================================
--
-- Background — what this migration is fixing
-- ------------------------------------------
-- Migration 058 introduced four trigger functions that mirror the
-- physical-cash and ledger half of every customer/supplier payment:
--
--   • fn_customer_payment_apply   — AFTER INSERT on customer_payments
--   • fn_supplier_payment_apply   — AFTER INSERT on supplier_payments
--   • fn_customer_payment_void    — AFTER UPDATE on customer_payments
--                                    (when is_void flips F→T)
--   • fn_supplier_payment_void    — AFTER UPDATE on supplier_payments
--
-- Each of those four functions opens its trigger body with:
--
--   PERFORM set_config('app.engine_context', 'on', TRUE);
--
-- That literal 'on' was the original engine-context signal. Migration 063
-- ("bank-grade immutable ledger") tightened the write-guard helpers to
-- prefer a stronger signature: the canonical value is
--   'engine:<token of length ≥ 10>'
-- and the legacy 'on' value is now accepted ONLY through a transitional
-- branch that records every write to `engine_bypass_alerts`. The new
-- guard helper `fn_engine_write_allowed` is used by the BEFORE-INSERT
-- triggers on `cashbox_transactions`, `journal_entries`, and
-- `journal_lines`. Whenever `app.engine_context = 'on'` and one of those
-- guarded INSERTs fires, a row is appended to engine_bypass_alerts.
--
-- Net effect today: a cash customer payment fires
-- fn_customer_payment_apply, which inserts one cashbox_transactions row
-- under context 'on'. The `cashbox_transactions` BEFORE-INSERT guard
-- accepts the write (transitional path) but drops one alert. Same for
-- supplier payments and same for the void mirrors. Non-cash payments
-- skip the cashbox_transactions branch entirely so they generate no
-- alert.
--
-- The PR-FIN-PAYACCT-2 hardening (atomic posting) made the customer/
-- supplier payment paths safe for first production usage. PR-FIN-
-- PAYACCT-3 is the observability cleanup: every cash payment that flows
-- through the new buttons on the Customers / Suppliers pages now writes
-- with a proper engine:<descriptive_name> context, so the trigger does
-- NOT generate any bypass alert.
--
-- Production state at audit time (verified read-only, 2026-04-29):
--
--   customer_payments      = 0 rows  (PR-CASH-DESK-REORG-1's new
--   supplier_payments      = 0 rows   buttons just shipped; no real
--                                     usage yet)
--   engine_bypass_alerts   = 22 rows
--     └ context 'on'       =  6   (NOT from these triggers — none
--                                  of the 4 has ever fired in prod)
--     └ context 'service:%' = 16
--   trial-balance imbalance = 0.00
--
-- So this migration is a forward-compatibility cleanup that lands BEFORE
-- the first real customer/supplier payment is taken. Zero historical
-- alerts come from these four functions; that means there is nothing to
-- correct, only forward behavior to fix.
--
-- What this migration does — exactly
-- ----------------------------------
-- Replaces the four trigger function bodies via CREATE OR REPLACE
-- FUNCTION. Every UPDATE / INSERT / SELECT statement, every column
-- list, every literal value, every conditional branch, every notes
-- string, every direction / category / reference_type — all kept
-- byte-for-byte identical to the bodies retrieved from production via
-- pg_get_functiondef on 2026-04-29. The ONLY change is the engine_context
-- literal each function sets at its top:
--
--   fn_customer_payment_apply  →  'engine:customer_payment_apply'   (30 chars)
--   fn_supplier_payment_apply  →  'engine:supplier_payment_apply'   (30 chars)
--   fn_customer_payment_void   →  'engine:customer_payment_void'    (28 chars)
--   fn_supplier_payment_void   →  'engine:supplier_payment_void'    (28 chars)
--
-- Each new literal is ≥ 10 characters and starts with `engine:`, which
-- satisfies fn_engine_write_allowed's canonical-token branch (no alert
-- recorded). The descriptive suffix is so the audit log shows which
-- trigger path was active if a future regression ever does land an
-- alert.
--
-- The trigger attachments themselves (CREATE TRIGGER … EXECUTE FUNCTION …)
-- are NOT touched — CREATE OR REPLACE FUNCTION updates the body in place
-- and existing triggers continue to call the same function name.
--
-- Out of scope (per PR-FIN-PAYACCT-3 audit constraints):
--   • No backend src changes.
--   • No frontend changes.
--   • No FinancialEngine changes.
--   • No posting.service changes.
--   • No POS / payment_accounts / logos changes.
--   • No data correction (zero historical bypass alerts to back-fill).
--   • No edits to migrations 058 or 063 — append-only.
-- ============================================================================

BEGIN;

-- ── 1/4 — fn_customer_payment_apply ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_customer_payment_apply()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
    v_balance NUMERIC(14,2);
    v_cb_balance NUMERIC(14,2);
BEGIN
    PERFORM set_config('app.engine_context', 'engine:customer_payment_apply', TRUE);

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
$function$;

-- ── 2/4 — fn_supplier_payment_apply ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_supplier_payment_apply()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE
    v_balance NUMERIC(14,2);
    v_cb_balance NUMERIC(14,2);
BEGIN
    PERFORM set_config('app.engine_context', 'engine:supplier_payment_apply', TRUE);

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
$function$;

-- ── 3/4 — fn_customer_payment_void ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_customer_payment_void()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE v_cb_balance NUMERIC(14,2);
BEGIN
    PERFORM set_config('app.engine_context', 'engine:customer_payment_void', TRUE);

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
$function$;

-- ── 4/4 — fn_supplier_payment_void ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_supplier_payment_void()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
DECLARE v_cb_balance NUMERIC(14,2);
BEGIN
    PERFORM set_config('app.engine_context', 'engine:supplier_payment_void', TRUE);

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
$function$;

-- ── Self-validation block ───────────────────────────────────────────────────
-- Migration-time gate: refuses to commit if any of the four functions
-- still uses the legacy `'on'` literal or fails to register an
-- `engine:*` context. Pattern adopted from migration 110
-- (settlement7_reconciliation) and 063 (bank-grade ledger).
DO $verify$
DECLARE
    fn   TEXT;
    body TEXT;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'fn_customer_payment_apply',
        'fn_supplier_payment_apply',
        'fn_customer_payment_void',
        'fn_supplier_payment_void'
    ] LOOP
        SELECT pg_get_functiondef(oid) INTO body
        FROM pg_proc WHERE proname = fn LIMIT 1;

        IF body IS NULL THEN
            RAISE EXCEPTION 'PR-FIN-PAYACCT-3: function % missing', fn;
        END IF;

        -- The legacy 'on' literal must NOT remain in any of the four
        -- functions. The exact pattern the audit greps is:
        --     engine_context', 'on'
        IF position(E'engine_context'', ''on''' IN body) > 0 THEN
            RAISE EXCEPTION
              'PR-FIN-PAYACCT-3: function % still uses legacy ''on'' engine_context',
              fn;
        END IF;

        -- Each function must register an engine:* context. Without it,
        -- fn_engine_write_allowed would reject the trigger's
        -- cashbox_transactions INSERT at runtime.
        IF position(E'engine_context'', ''engine:' IN body) = 0 THEN
            RAISE EXCEPTION
              'PR-FIN-PAYACCT-3: function % is missing the engine:* context literal',
              fn;
        END IF;
    END LOOP;
END;
$verify$;

COMMIT;
