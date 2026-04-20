-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 005 : Customers, Suppliers, Purchases
-- ============================================================================

-- ---------- Customers ----------
CREATE TABLE customers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    customer_no     VARCHAR(20) UNIQUE NOT NULL,    -- CUS-000001 (auto via trigger)
    full_name       VARCHAR(150) NOT NULL,
    phone           VARCHAR(25)  UNIQUE,            -- primary identifier in Egypt
    alt_phone       VARCHAR(25),
    email           CITEXT UNIQUE,
    national_id     VARCHAR(20) UNIQUE,
    birth_date      DATE,
    gender          VARCHAR(10) CHECK (gender IN ('female','male','other')),
    address_line    TEXT,
    city            VARCHAR(80),
    governorate     VARCHAR(80),
    loyalty_points  INT NOT NULL DEFAULT 0,
    loyalty_tier    VARCHAR(20) NOT NULL DEFAULT 'bronze'
                    CHECK (loyalty_tier IN ('bronze','silver','gold','platinum')),
    total_spent     NUMERIC(14,2) NOT NULL DEFAULT 0,
    visits_count    INT NOT NULL DEFAULT 0,
    last_visit_at   TIMESTAMPTZ,
    notes           TEXT,
    is_vip          BOOLEAN NOT NULL DEFAULT FALSE,
    is_blocked      BOOLEAN NOT NULL DEFAULT FALSE,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_customers_phone      ON customers(phone);
CREATE INDEX idx_customers_name_trgm  ON customers USING gin (full_name gin_trgm_ops);
CREATE INDEX idx_customers_tier       ON customers(loyalty_tier);

-- ---------- Customer loyalty transactions (points ledger) ----------
CREATE TABLE customer_loyalty_transactions (
    id              BIGSERIAL PRIMARY KEY,
    customer_id     UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
    direction       txn_direction NOT NULL,                 -- in / out
    points          INT NOT NULL CHECK (points > 0),
    reason          VARCHAR(40) NOT NULL,                   -- earned / redeemed / expired / bonus / adjustment
    reference_type  entity_type,
    reference_id    UUID,
    notes           TEXT,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_loyalty_customer ON customer_loyalty_transactions(customer_id);

-- ---------- Suppliers ----------
CREATE TABLE suppliers (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    supplier_no     VARCHAR(20) UNIQUE NOT NULL,
    name            VARCHAR(150) NOT NULL,
    contact_person  VARCHAR(120),
    phone           VARCHAR(25),
    alt_phone       VARCHAR(25),
    email           CITEXT,
    address         TEXT,
    tax_number      VARCHAR(40),
    payment_terms_days INT NOT NULL DEFAULT 0,      -- net 30, etc
    credit_limit    NUMERIC(14,2) NOT NULL DEFAULT 0,
    current_balance NUMERIC(14,2) NOT NULL DEFAULT 0, -- +ve = we owe them
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    notes           TEXT,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

CREATE INDEX idx_suppliers_active ON suppliers(is_active);

-- ---------- Purchases (purchase orders / purchase invoices from supplier) ----------
CREATE TABLE purchases (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_no         VARCHAR(30) NOT NULL UNIQUE,         -- PO-2026-00001
    supplier_id         UUID NOT NULL REFERENCES suppliers(id),
    warehouse_id        UUID NOT NULL REFERENCES warehouses(id),
    invoice_date        DATE NOT NULL DEFAULT CURRENT_DATE,
    due_date            DATE,
    subtotal            NUMERIC(14,2) NOT NULL DEFAULT 0,
    discount_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
    shipping_cost       NUMERIC(14,2) NOT NULL DEFAULT 0,
    grand_total         NUMERIC(14,2) NOT NULL DEFAULT 0,
    paid_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
    remaining_amount    NUMERIC(14,2) GENERATED ALWAYS AS (grand_total - paid_amount) STORED,
    status              VARCHAR(20) NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft','received','partial','paid','cancelled')),
    supplier_ref        VARCHAR(60),    -- supplier's own invoice number
    notes               TEXT,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    received_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    received_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_purchases_supplier ON purchases(supplier_id);
CREATE INDEX idx_purchases_date     ON purchases(invoice_date DESC);
CREATE INDEX idx_purchases_status   ON purchases(status);

CREATE TABLE purchase_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_id     UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    variant_id      UUID NOT NULL REFERENCES product_variants(id),
    quantity        INT  NOT NULL CHECK (quantity > 0),
    unit_cost       NUMERIC(14,2) NOT NULL CHECK (unit_cost >= 0),
    discount        NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax             NUMERIC(14,2) NOT NULL DEFAULT 0,
    line_total      NUMERIC(14,2) NOT NULL,
    UNIQUE (purchase_id, variant_id)
);

CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);
CREATE INDEX idx_purchase_items_variant  ON purchase_items(variant_id);

-- ---------- Purchase payments (to supplier) ----------
CREATE TABLE purchase_payments (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_id         UUID NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
    payment_method      payment_method_code NOT NULL,
    amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    reference_number    VARCHAR(60),          -- bank reference, etc
    notes               TEXT,
    paid_by             UUID REFERENCES users(id) ON DELETE SET NULL,
    paid_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_purchase_payments_purchase ON purchase_payments(purchase_id);

-- ---------- Supplier ledger entries (running account statement) ----------
CREATE TABLE supplier_ledger (
    id              BIGSERIAL PRIMARY KEY,
    supplier_id     UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
    entry_date      DATE NOT NULL DEFAULT CURRENT_DATE,
    direction       txn_direction NOT NULL,             -- in = purchase (supplier credit), out = payment
    amount          NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    reference_type  entity_type,
    reference_id    UUID,
    balance_after   NUMERIC(14,2) NOT NULL,
    notes           TEXT,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_supplier_ledger_supplier ON supplier_ledger(supplier_id, entry_date DESC);
