-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 006 : POS, Invoices, Discounts, Coupons
-- ============================================================================

-- ---------- Invoices (POS sales) ----------
CREATE TABLE invoices (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_no              VARCHAR(30) NOT NULL UNIQUE,         -- INV-2026-0000001
    warehouse_id            UUID NOT NULL REFERENCES warehouses(id),
    customer_id             UUID REFERENCES customers(id)       ON DELETE SET NULL,
    cashier_id              UUID NOT NULL REFERENCES users(id),             -- the user at POS
    salesperson_id          UUID REFERENCES users(id)           ON DELETE SET NULL,
    shift_id                UUID,                                           -- FK to shifts (added later)
    status                  invoice_status NOT NULL DEFAULT 'draft',
    is_return               BOOLEAN NOT NULL DEFAULT FALSE,
    is_exchange             BOOLEAN NOT NULL DEFAULT FALSE,
    source                  VARCHAR(20) NOT NULL DEFAULT 'pos'
                            CHECK (source IN ('pos','online','phone','reservation')),
    -- money
    subtotal                NUMERIC(14,2) NOT NULL DEFAULT 0,  -- sum of line_total before invoice discount
    items_discount_total    NUMERIC(14,2) NOT NULL DEFAULT 0,  -- sum of product-level discounts
    invoice_discount        NUMERIC(14,2) NOT NULL DEFAULT 0,  -- invoice-level discount
    coupon_discount         NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_amount              NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax_rate                NUMERIC(5,2)  NOT NULL DEFAULT 0,  -- % VAT
    grand_total             NUMERIC(14,2) NOT NULL DEFAULT 0,
    paid_amount             NUMERIC(14,2) NOT NULL DEFAULT 0,
    change_amount           NUMERIC(14,2) NOT NULL DEFAULT 0,  -- cash change given
    remaining_amount        NUMERIC(14,2) GENERATED ALWAYS AS (grand_total - paid_amount) STORED,
    -- cost & profit (computed at closure)
    cogs_total              NUMERIC(14,2) NOT NULL DEFAULT 0,  -- cost of goods sold
    gross_profit            NUMERIC(14,2) NOT NULL DEFAULT 0,  -- grand_total - cogs_total - discount_share_of_expenses
    -- linkage
    reservation_id          UUID,                               -- if invoice was created from reservation
    parent_invoice_id       UUID REFERENCES invoices(id),       -- for exchanges/returns
    coupon_id               UUID,                               -- FK added after coupons table
    -- misc
    notes                   TEXT,
    printed_count           INT NOT NULL DEFAULT 0,
    metadata                JSONB NOT NULL DEFAULT '{}'::jsonb, -- device, offline_id, etc.
    offline_id              VARCHAR(60),                        -- UUID from PWA when created offline
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at            TIMESTAMPTZ,
    voided_at               TIMESTAMPTZ,
    voided_by               UUID REFERENCES users(id) ON DELETE SET NULL,
    void_reason             TEXT
);

CREATE INDEX idx_invoices_warehouse     ON invoices(warehouse_id);
CREATE INDEX idx_invoices_customer      ON invoices(customer_id);
CREATE INDEX idx_invoices_cashier       ON invoices(cashier_id);
CREATE INDEX idx_invoices_salesperson   ON invoices(salesperson_id);
CREATE INDEX idx_invoices_status        ON invoices(status);
CREATE INDEX idx_invoices_date          ON invoices(completed_at DESC);
CREATE INDEX idx_invoices_offline       ON invoices(offline_id) WHERE offline_id IS NOT NULL;

-- ---------- Invoice items ----------
CREATE TABLE invoice_items (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id          UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    variant_id          UUID NOT NULL REFERENCES product_variants(id),
    -- snapshot at time of sale
    product_name_snapshot VARCHAR(200) NOT NULL,
    sku_snapshot        VARCHAR(60)  NOT NULL,
    color_name_snapshot VARCHAR(50),
    size_label_snapshot VARCHAR(10),
    -- quantities & money
    quantity            INT NOT NULL CHECK (quantity > 0),
    unit_cost           NUMERIC(14,2) NOT NULL DEFAULT 0,       -- cost at sale time (for profit)
    unit_price          NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
    discount_type       discount_type,
    discount_value      NUMERIC(14,2) NOT NULL DEFAULT 0,       -- the raw value (fixed or %)
    discount_amount     NUMERIC(14,2) NOT NULL DEFAULT 0,       -- computed EGP off this line
    discount_reason     TEXT,
    applied_by          UUID REFERENCES users(id),              -- who approved the discount
    tax_rate            NUMERIC(5,2) NOT NULL DEFAULT 0,
    tax_amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
    line_subtotal       NUMERIC(14,2) NOT NULL,                 -- quantity * unit_price
    line_total          NUMERIC(14,2) NOT NULL,                 -- after discount + tax
    salesperson_id      UUID REFERENCES users(id) ON DELETE SET NULL,   -- per-item salesperson
    notes               TEXT
);

CREATE INDEX idx_items_invoice   ON invoice_items(invoice_id);
CREATE INDEX idx_items_variant   ON invoice_items(variant_id);
CREATE INDEX idx_items_salesperson ON invoice_items(salesperson_id);

-- ---------- Invoice payments (can be split between cash/card/...) ----------
CREATE TABLE invoice_payments (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    invoice_id          UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
    payment_method      payment_method_code NOT NULL,
    amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    reference_number    VARCHAR(60),
    received_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    paid_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes               TEXT
);

CREATE INDEX idx_payments_invoice ON invoice_payments(invoice_id);

-- ---------- Discounts catalog (pre-defined discount rules) ----------
CREATE TABLE discounts (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code                VARCHAR(40) UNIQUE NOT NULL,
    name_ar             VARCHAR(120) NOT NULL,
    name_en             VARCHAR(120),
    scope               discount_scope NOT NULL,            -- product / invoice
    discount_type       discount_type  NOT NULL,            -- fixed / percentage
    value               NUMERIC(14,2) NOT NULL CHECK (value >= 0),
    max_amount          NUMERIC(14,2),                      -- cap for % discounts
    -- scope filters
    applies_to_category UUID REFERENCES categories(id),
    applies_to_product  UUID REFERENCES products(id),
    min_order_amount    NUMERIC(14,2) DEFAULT 0,
    -- scheduling
    starts_at           TIMESTAMPTZ,
    ends_at             TIMESTAMPTZ,
    -- permissions
    requires_approval   BOOLEAN NOT NULL DEFAULT FALSE,
    allowed_role_id     UUID REFERENCES roles(id),
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- Discount usages (tracking who applied which discount) ----------
CREATE TABLE discount_usages (
    id              BIGSERIAL PRIMARY KEY,
    discount_id     UUID REFERENCES discounts(id) ON DELETE SET NULL,
    -- link to either invoice or invoice_item
    invoice_id      UUID REFERENCES invoices(id) ON DELETE CASCADE,
    invoice_item_id UUID REFERENCES invoice_items(id) ON DELETE CASCADE,
    discount_type   discount_type  NOT NULL,
    value           NUMERIC(14,2)  NOT NULL,
    amount          NUMERIC(14,2)  NOT NULL,                 -- EGP saved
    reason          TEXT,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (invoice_id IS NOT NULL OR invoice_item_id IS NOT NULL)
);

CREATE INDEX idx_discount_usages_invoice ON discount_usages(invoice_id);
CREATE INDEX idx_discount_usages_user    ON discount_usages(user_id);
CREATE INDEX idx_discount_usages_disc    ON discount_usages(discount_id);

-- ---------- Coupons ----------
CREATE TABLE coupons (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code                CITEXT UNIQUE NOT NULL,              -- EID2026, RAMADAN10, ...
    name_ar             VARCHAR(120) NOT NULL,
    name_en             VARCHAR(120),
    coupon_type         coupon_type NOT NULL,                -- fixed / percentage
    value               NUMERIC(14,2) NOT NULL CHECK (value >= 0),
    max_discount_amount NUMERIC(14,2),                       -- cap % coupons
    -- scope
    applies_to_category UUID REFERENCES categories(id),
    applies_to_product  UUID REFERENCES products(id),
    min_order_value     NUMERIC(14,2) NOT NULL DEFAULT 0,
    -- scheduling
    starts_at           TIMESTAMPTZ,
    expires_at          TIMESTAMPTZ,
    -- usage limits
    max_uses_total      INT,                                  -- null = unlimited
    max_uses_per_customer INT NOT NULL DEFAULT 1,
    uses_count          INT NOT NULL DEFAULT 0,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_coupons_active ON coupons(is_active) WHERE is_active = TRUE;

-- Deferred FK on invoices.coupon_id
ALTER TABLE invoices
    ADD CONSTRAINT invoices_coupon_fk
    FOREIGN KEY (coupon_id) REFERENCES coupons(id) ON DELETE SET NULL;

-- ---------- Coupon usages ----------
CREATE TABLE coupon_usages (
    id              BIGSERIAL PRIMARY KEY,
    coupon_id       UUID NOT NULL REFERENCES coupons(id) ON DELETE CASCADE,
    customer_id     UUID REFERENCES customers(id) ON DELETE SET NULL,
    invoice_id      UUID REFERENCES invoices(id)  ON DELETE SET NULL,
    amount          NUMERIC(14,2) NOT NULL,
    used_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (coupon_id, invoice_id)
);

CREATE INDEX idx_coupon_usages_coupon   ON coupon_usages(coupon_id);
CREATE INDEX idx_coupon_usages_customer ON coupon_usages(customer_id);
