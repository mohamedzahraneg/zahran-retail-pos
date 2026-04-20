-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 014 : Cash Desk (Customer & Supplier)
--
--  تسجيل الاستلامات من العملاء والدفعات للموردين بشكل مستقل عن فواتير
--  البيع والمشتريات. يدعم:
--    • استلام دفعة مقدّمة / آجل من عميل  (customer_payments)
--    • دفع دفعة / تسوية آجل لمورد        (supplier_payments)
--    • ربط الدفعة بفواتير/مشتريات متعددة  (allocations)
--    • تحديث تلقائي لرصيد العميل/المورد والخزينة.
-- ============================================================================

-- ---------- Receipt/payment kind enum ----------
CREATE TYPE party_payment_kind AS ENUM (
    'deposit',              -- مقدم / دفعة ضمان
    'invoice_settlement',   -- سداد فاتورة آجل
    'purchase_settlement',  -- سداد مشتريات آجل
    'advance',              -- دفعة مقدّمة (قبل فاتورة)
    'refund_in',            -- استرداد من مورد
    'refund_out',           -- استرداد لعميل
    'opening_balance',      -- رصيد افتتاحي
    'other'
);

-- ---------------------------------------------------------------------------
--  Customer payments (receiving cash from customers)
-- ---------------------------------------------------------------------------
CREATE TABLE customer_payments (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_no          VARCHAR(30) NOT NULL UNIQUE,          -- CR-2026-000001
    customer_id         UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    cashbox_id          UUID NOT NULL REFERENCES cashboxes(id),
    warehouse_id        UUID NOT NULL REFERENCES warehouses(id),
    payment_method      payment_method_code NOT NULL DEFAULT 'cash',
    kind                party_payment_kind  NOT NULL DEFAULT 'invoice_settlement',
    amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    allocated_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,     -- sum of allocations
    unallocated_amount  NUMERIC(14,2) GENERATED ALWAYS AS (amount - allocated_amount) STORED,
    reference_number    VARCHAR(60),                          -- InstaPay ref, card slip...
    shift_id            UUID REFERENCES shifts(id) ON DELETE SET NULL,
    received_by         UUID NOT NULL REFERENCES users(id),
    notes               TEXT,
    is_void             BOOLEAN NOT NULL DEFAULT FALSE,
    voided_by           UUID REFERENCES users(id),
    voided_at           TIMESTAMPTZ,
    void_reason         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cust_pay_customer ON customer_payments(customer_id, created_at DESC);
CREATE INDEX idx_cust_pay_cashbox  ON customer_payments(cashbox_id);
CREATE INDEX idx_cust_pay_date     ON customer_payments(created_at DESC);
CREATE INDEX idx_cust_pay_shift    ON customer_payments(shift_id);

-- ---------- Customer payment allocations (link receipt → invoice) ----------
CREATE TABLE customer_payment_allocations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_id      UUID NOT NULL REFERENCES customer_payments(id) ON DELETE CASCADE,
    invoice_id      UUID NOT NULL REFERENCES invoices(id),
    allocated_amount NUMERIC(14,2) NOT NULL CHECK (allocated_amount > 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (payment_id, invoice_id)
);

CREATE INDEX idx_cust_pay_alloc_payment ON customer_payment_allocations(payment_id);
CREATE INDEX idx_cust_pay_alloc_invoice ON customer_payment_allocations(invoice_id);

-- ---------- Customer ledger (running statement) ----------
CREATE TABLE customer_ledger (
    id              BIGSERIAL PRIMARY KEY,
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    entry_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    direction       txn_direction NOT NULL,   -- in = customer owes (credit invoice), out = customer paid us
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    reference_type  entity_type,
    reference_id    UUID,
    balance_after   NUMERIC(14,2) NOT NULL,   -- +ve = customer owes us
    notes           TEXT,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cust_ledger_customer ON customer_ledger(customer_id, entry_date DESC);

-- Add current_balance column to customers
ALTER TABLE customers ADD COLUMN current_balance NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN credit_limit    NUMERIC(14,2) NOT NULL DEFAULT 0;
COMMENT ON COLUMN customers.current_balance IS 'Positive = customer owes us (credit invoices not yet paid)';

-- ---------------------------------------------------------------------------
--  Supplier payments (paying cash to suppliers, not tied to one purchase)
-- ---------------------------------------------------------------------------
CREATE TABLE supplier_payments (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_no          VARCHAR(30) NOT NULL UNIQUE,          -- CP-2026-000001
    supplier_id         UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    cashbox_id          UUID NOT NULL REFERENCES cashboxes(id),
    warehouse_id        UUID NOT NULL REFERENCES warehouses(id),
    payment_method      payment_method_code NOT NULL DEFAULT 'cash',
    kind                party_payment_kind  NOT NULL DEFAULT 'purchase_settlement',
    amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    allocated_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,
    unallocated_amount  NUMERIC(14,2) GENERATED ALWAYS AS (amount - allocated_amount) STORED,
    reference_number    VARCHAR(60),
    shift_id            UUID REFERENCES shifts(id) ON DELETE SET NULL,
    paid_by             UUID NOT NULL REFERENCES users(id),
    approved_by         UUID REFERENCES users(id),
    notes               TEXT,
    is_void             BOOLEAN NOT NULL DEFAULT FALSE,
    voided_by           UUID REFERENCES users(id),
    voided_at           TIMESTAMPTZ,
    void_reason         TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sup_pay_supplier ON supplier_payments(supplier_id, created_at DESC);
CREATE INDEX idx_sup_pay_cashbox  ON supplier_payments(cashbox_id);
CREATE INDEX idx_sup_pay_date     ON supplier_payments(created_at DESC);
CREATE INDEX idx_sup_pay_shift    ON supplier_payments(shift_id);

-- ---------- Supplier payment allocations ----------
CREATE TABLE supplier_payment_allocations (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    payment_id      UUID NOT NULL REFERENCES supplier_payments(id) ON DELETE CASCADE,
    purchase_id     UUID NOT NULL REFERENCES purchases(id),
    allocated_amount NUMERIC(14,2) NOT NULL CHECK (allocated_amount > 0),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (payment_id, purchase_id)
);

CREATE INDEX idx_sup_pay_alloc_payment  ON supplier_payment_allocations(payment_id);
CREATE INDEX idx_sup_pay_alloc_purchase ON supplier_payment_allocations(purchase_id);

-- ---------------------------------------------------------------------------
--  Sequences + numbering triggers
-- ---------------------------------------------------------------------------
CREATE SEQUENCE seq_customer_payment_no START 1;
CREATE SEQUENCE seq_supplier_payment_no START 1;

CREATE OR REPLACE FUNCTION set_customer_payment_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.payment_no IS NULL OR NEW.payment_no = '' THEN
        NEW.payment_no := next_doc_no('CR','seq_customer_payment_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_customer_payment_no BEFORE INSERT ON customer_payments
FOR EACH ROW EXECUTE FUNCTION set_customer_payment_no();

CREATE OR REPLACE FUNCTION set_supplier_payment_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.payment_no IS NULL OR NEW.payment_no = '' THEN
        NEW.payment_no := next_doc_no('CP','seq_supplier_payment_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_supplier_payment_no BEFORE INSERT ON supplier_payments
FOR EACH ROW EXECUTE FUNCTION set_supplier_payment_no();

-- ---------------------------------------------------------------------------
--  Business-logic triggers
-- ---------------------------------------------------------------------------

-- 1) When a customer_payment is inserted (not void):
--    • Insert cashbox_transaction (direction IN)
--    • Insert customer_ledger entry (direction OUT = reduces customer debt)
--    • Decrement customers.current_balance
CREATE OR REPLACE FUNCTION fn_customer_payment_apply()
RETURNS TRIGGER AS $$
DECLARE
    v_balance NUMERIC(14,2);
    v_cb_balance NUMERIC(14,2);
BEGIN
    -- cashbox only affected if method = cash
    IF NEW.payment_method = 'cash' THEN
        SELECT COALESCE(current_balance,0) + NEW.amount INTO v_cb_balance
        FROM cashboxes WHERE id = NEW.cashbox_id;

        UPDATE cashboxes SET current_balance = v_cb_balance, updated_at = NOW()
        WHERE id = NEW.cashbox_id;

        INSERT INTO cashbox_transactions(cashbox_id, direction, amount, category,
                                         reference_type, reference_id, balance_after,
                                         notes, user_id)
        VALUES (NEW.cashbox_id, 'in', NEW.amount, 'customer_receipt',
                'other', NEW.id, v_cb_balance,
                format('استلام من عميل — %s', NEW.payment_no), NEW.received_by);
    END IF;

    -- customer balance
    UPDATE customers SET current_balance = current_balance - NEW.amount,
                         updated_at = NOW()
    WHERE id = NEW.customer_id
    RETURNING current_balance INTO v_balance;

    INSERT INTO customer_ledger(customer_id, direction, amount, reference_type,
                                reference_id, balance_after, notes, user_id)
    VALUES (NEW.customer_id, 'out', NEW.amount, 'other', NEW.id, v_balance,
            COALESCE(NEW.notes, 'استلام نقدية'), NEW.received_by);

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customer_payment_apply
AFTER INSERT ON customer_payments
FOR EACH ROW
WHEN (NEW.is_void = FALSE)
EXECUTE FUNCTION fn_customer_payment_apply();

-- 2) Reverse when voided
CREATE OR REPLACE FUNCTION fn_customer_payment_void()
RETURNS TRIGGER AS $$
DECLARE
    v_balance NUMERIC(14,2);
    v_cb_balance NUMERIC(14,2);
BEGIN
    IF OLD.is_void = FALSE AND NEW.is_void = TRUE THEN
        IF OLD.payment_method = 'cash' THEN
            SELECT COALESCE(current_balance,0) - OLD.amount INTO v_cb_balance
            FROM cashboxes WHERE id = OLD.cashbox_id;

            UPDATE cashboxes SET current_balance = v_cb_balance, updated_at = NOW()
            WHERE id = OLD.cashbox_id;

            INSERT INTO cashbox_transactions(cashbox_id, direction, amount, category,
                                             reference_type, reference_id, balance_after,
                                             notes, user_id)
            VALUES (OLD.cashbox_id, 'out', OLD.amount, 'void_customer_receipt',
                    'other', OLD.id, v_cb_balance,
                    format('إلغاء استلام %s : %s', OLD.payment_no, COALESCE(NEW.void_reason,'')),
                    NEW.voided_by);
        END IF;

        UPDATE customers SET current_balance = current_balance + OLD.amount,
                             updated_at = NOW()
        WHERE id = OLD.customer_id
        RETURNING current_balance INTO v_balance;

        INSERT INTO customer_ledger(customer_id, direction, amount, reference_type,
                                    reference_id, balance_after, notes, user_id)
        VALUES (OLD.customer_id, 'in', OLD.amount, 'other', OLD.id, v_balance,
                format('إلغاء استلام %s', OLD.payment_no), NEW.voided_by);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customer_payment_void
AFTER UPDATE OF is_void ON customer_payments
FOR EACH ROW EXECUTE FUNCTION fn_customer_payment_void();

-- 3) Supplier payment apply (mirror)
CREATE OR REPLACE FUNCTION fn_supplier_payment_apply()
RETURNS TRIGGER AS $$
DECLARE
    v_balance NUMERIC(14,2);
    v_cb_balance NUMERIC(14,2);
BEGIN
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

    -- supplier balance decreases when we pay
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

CREATE TRIGGER trg_supplier_payment_apply
AFTER INSERT ON supplier_payments
FOR EACH ROW
WHEN (NEW.is_void = FALSE)
EXECUTE FUNCTION fn_supplier_payment_apply();

-- 4) Reverse supplier payment void
CREATE OR REPLACE FUNCTION fn_supplier_payment_void()
RETURNS TRIGGER AS $$
DECLARE
    v_balance NUMERIC(14,2);
    v_cb_balance NUMERIC(14,2);
BEGIN
    IF OLD.is_void = FALSE AND NEW.is_void = TRUE THEN
        IF OLD.payment_method = 'cash' THEN
            SELECT COALESCE(current_balance,0) + OLD.amount INTO v_cb_balance
            FROM cashboxes WHERE id = OLD.cashbox_id;

            UPDATE cashboxes SET current_balance = v_cb_balance, updated_at = NOW()
            WHERE id = OLD.cashbox_id;

            INSERT INTO cashbox_transactions(cashbox_id, direction, amount, category,
                                             reference_type, reference_id, balance_after,
                                             notes, user_id)
            VALUES (OLD.cashbox_id, 'in', OLD.amount, 'void_supplier_payment',
                    'other', OLD.id, v_cb_balance,
                    format('إلغاء دفع %s : %s', OLD.payment_no, COALESCE(NEW.void_reason,'')),
                    NEW.voided_by);
        END IF;

        UPDATE suppliers SET current_balance = current_balance + OLD.amount,
                             updated_at = NOW()
        WHERE id = OLD.supplier_id
        RETURNING current_balance INTO v_balance;

        INSERT INTO supplier_ledger(supplier_id, entry_date, direction, amount,
                                    reference_type, reference_id, balance_after,
                                    notes, user_id)
        VALUES (OLD.supplier_id, CURRENT_DATE, 'in', OLD.amount, 'other', OLD.id, v_balance,
                format('إلغاء دفع %s', OLD.payment_no), NEW.voided_by);
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_supplier_payment_void
AFTER UPDATE OF is_void ON supplier_payments
FOR EACH ROW EXECUTE FUNCTION fn_supplier_payment_void();

-- 5) Recompute allocated_amount when allocations change
CREATE OR REPLACE FUNCTION fn_recompute_customer_alloc()
RETURNS TRIGGER AS $$
DECLARE
    v_pid uuid := COALESCE(NEW.payment_id, OLD.payment_id);
BEGIN
    UPDATE customer_payments SET allocated_amount = (
        SELECT COALESCE(SUM(allocated_amount), 0)
        FROM customer_payment_allocations WHERE payment_id = v_pid
    ), updated_at = NOW()
    WHERE id = v_pid;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customer_alloc_recompute
AFTER INSERT OR UPDATE OR DELETE ON customer_payment_allocations
FOR EACH ROW EXECUTE FUNCTION fn_recompute_customer_alloc();

CREATE OR REPLACE FUNCTION fn_recompute_supplier_alloc()
RETURNS TRIGGER AS $$
DECLARE
    v_pid uuid := COALESCE(NEW.payment_id, OLD.payment_id);
BEGIN
    UPDATE supplier_payments SET allocated_amount = (
        SELECT COALESCE(SUM(allocated_amount), 0)
        FROM supplier_payment_allocations WHERE payment_id = v_pid
    ), updated_at = NOW()
    WHERE id = v_pid;
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_supplier_alloc_recompute
AFTER INSERT OR UPDATE OR DELETE ON supplier_payment_allocations
FOR EACH ROW EXECUTE FUNCTION fn_recompute_supplier_alloc();

-- 6) Audit triggers
CREATE TRIGGER trg_audit_customer_payments AFTER INSERT OR UPDATE OR DELETE ON customer_payments
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_supplier_payments AFTER INSERT OR UPDATE OR DELETE ON supplier_payments
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

-- 7) updated_at touch triggers (manual since we're past the DO block)
CREATE TRIGGER trg_customer_payments_updated BEFORE UPDATE ON customer_payments
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER trg_supplier_payments_updated BEFORE UPDATE ON supplier_payments
    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------------------------------------------------------------------------
--  Helper views for quick party balances
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_customer_outstanding AS
SELECT
    c.id            AS customer_id,
    c.customer_no,
    c.full_name,
    c.phone,
    c.current_balance,
    c.credit_limit,
    GREATEST(c.credit_limit - c.current_balance, 0) AS available_credit,
    (SELECT MAX(created_at) FROM customer_ledger WHERE customer_id = c.id) AS last_entry_at
FROM customers c
WHERE c.deleted_at IS NULL;

CREATE OR REPLACE VIEW v_supplier_outstanding AS
SELECT
    s.id            AS supplier_id,
    s.supplier_no,
    s.name,
    s.phone,
    s.current_balance,
    s.credit_limit,
    (SELECT MAX(created_at) FROM supplier_ledger WHERE supplier_id = s.id) AS last_entry_at
FROM suppliers s
WHERE s.deleted_at IS NULL;
