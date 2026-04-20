-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 009 : Accounting, Cashbox, Expenses, Shifts
-- ============================================================================

-- ---------- Cashboxes (one per branch/terminal) ----------
CREATE TABLE cashboxes (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name_ar             VARCHAR(120) NOT NULL,
    name_en             VARCHAR(120),
    warehouse_id        UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    current_balance     NUMERIC(14,2) NOT NULL DEFAULT 0,       -- running balance
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cashboxes_warehouse ON cashboxes(warehouse_id);

-- ---------- Cashbox transactions (every cash in/out) ----------
CREATE TABLE cashbox_transactions (
    id              BIGSERIAL PRIMARY KEY,
    cashbox_id      UUID NOT NULL REFERENCES cashboxes(id) ON DELETE CASCADE,
    direction       txn_direction NOT NULL,                    -- in/out
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    category        VARCHAR(40)   NOT NULL,                    -- sale, purchase_pay, expense, opening, closing, refund, deposit, withdrawal
    reference_type  entity_type,
    reference_id    UUID,
    balance_after   NUMERIC(14,2) NOT NULL,
    notes           TEXT,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_cbx_txn_cashbox ON cashbox_transactions(cashbox_id, created_at DESC);
CREATE INDEX idx_cbx_txn_ref     ON cashbox_transactions(reference_type, reference_id);

-- ---------- Expense categories ----------
CREATE TABLE expense_categories (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            VARCHAR(40) UNIQUE NOT NULL,
    name_ar         VARCHAR(120) NOT NULL,
    name_en         VARCHAR(120),
    is_fixed        BOOLEAN NOT NULL DEFAULT FALSE,            -- fixed monthly cost (rent, salaries)
    allocate_to_cogs BOOLEAN NOT NULL DEFAULT FALSE,           -- if true, included in profit engine allocation
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- Expenses ----------
CREATE TABLE expenses (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    expense_no          VARCHAR(30) UNIQUE NOT NULL,           -- EXP-2026-00001
    warehouse_id        UUID NOT NULL REFERENCES warehouses(id),
    cashbox_id          UUID REFERENCES cashboxes(id),
    category_id         UUID NOT NULL REFERENCES expense_categories(id),
    amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    payment_method      payment_method_code NOT NULL DEFAULT 'cash',
    expense_date        DATE NOT NULL DEFAULT CURRENT_DATE,
    description         TEXT,
    receipt_url         TEXT,
    vendor_name         VARCHAR(150),
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    is_approved         BOOLEAN NOT NULL DEFAULT FALSE,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_expenses_date      ON expenses(expense_date DESC);
CREATE INDEX idx_expenses_category  ON expenses(category_id);
CREATE INDEX idx_expenses_warehouse ON expenses(warehouse_id);

-- ---------- Shifts (cashier opening/closing) ----------
CREATE TABLE shifts (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    shift_no            VARCHAR(30) UNIQUE NOT NULL,           -- SHF-2026-00001
    cashbox_id          UUID NOT NULL REFERENCES cashboxes(id),
    warehouse_id        UUID NOT NULL REFERENCES warehouses(id),
    opened_by           UUID NOT NULL REFERENCES users(id),
    closed_by           UUID REFERENCES users(id),
    status              shift_status NOT NULL DEFAULT 'open',
    opening_balance     NUMERIC(14,2) NOT NULL DEFAULT 0,
    expected_closing    NUMERIC(14,2) NOT NULL DEFAULT 0,      -- opening + sales - refunds - expenses
    actual_closing      NUMERIC(14,2),                         -- user-counted cash at close
    difference          NUMERIC(14,2) GENERATED ALWAYS AS (COALESCE(actual_closing,0) - expected_closing) STORED,
    -- analytics on closure
    total_sales         NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_returns       NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_expenses      NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_cash_in       NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_cash_out      NUMERIC(14,2) NOT NULL DEFAULT 0,
    invoice_count       INT NOT NULL DEFAULT 0,
    notes               TEXT,
    opened_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    closed_at           TIMESTAMPTZ
);

CREATE INDEX idx_shifts_cashbox ON shifts(cashbox_id);
CREATE INDEX idx_shifts_user    ON shifts(opened_by);
CREATE INDEX idx_shifts_status  ON shifts(status);

-- Deferred FK on invoices.shift_id
ALTER TABLE invoices
    ADD CONSTRAINT invoices_shift_fk
    FOREIGN KEY (shift_id) REFERENCES shifts(id) ON DELETE SET NULL;

-- ---------- Salesperson commissions ----------
CREATE TABLE salesperson_commissions (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    salesperson_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    invoice_id          UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    invoice_item_id     UUID REFERENCES invoice_items(id)   ON DELETE CASCADE,
    base_amount         NUMERIC(14,2) NOT NULL,               -- amount on which % is applied
    rate_pct            NUMERIC(5,2)  NOT NULL,
    commission_amount   NUMERIC(14,2) NOT NULL,
    is_paid             BOOLEAN NOT NULL DEFAULT FALSE,
    paid_at             TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_commissions_salesperson ON salesperson_commissions(salesperson_id);
CREATE INDEX idx_commissions_invoice     ON salesperson_commissions(invoice_id);
