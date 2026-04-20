-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 008 : Returns & Exchanges
-- ============================================================================

-- ---------- Returns (customer returns an item) ----------
CREATE TABLE returns (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    return_no           VARCHAR(30) NOT NULL UNIQUE,                 -- RET-2026-000001
    original_invoice_id UUID NOT NULL REFERENCES invoices(id),
    customer_id         UUID REFERENCES customers(id) ON DELETE SET NULL,
    warehouse_id        UUID NOT NULL REFERENCES warehouses(id),
    status              return_status NOT NULL DEFAULT 'pending',
    reason              return_reason NOT NULL DEFAULT 'other',
    reason_details      TEXT,
    -- totals
    total_refund        NUMERIC(14,2) NOT NULL DEFAULT 0,
    restocking_fee      NUMERIC(14,2) NOT NULL DEFAULT 0,
    net_refund          NUMERIC(14,2) NOT NULL DEFAULT 0,
    refund_method       payment_method_code,
    -- lifecycle
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    approved_at         TIMESTAMPTZ,
    refunded_at         TIMESTAMPTZ,
    rejected_at         TIMESTAMPTZ,
    -- users
    requested_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    refunded_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    notes               TEXT
);

CREATE INDEX idx_returns_invoice  ON returns(original_invoice_id);
CREATE INDEX idx_returns_customer ON returns(customer_id);
CREATE INDEX idx_returns_status   ON returns(status);

CREATE TABLE return_items (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    return_id               UUID NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
    original_invoice_item_id UUID REFERENCES invoice_items(id),
    variant_id              UUID NOT NULL REFERENCES product_variants(id),
    quantity                INT  NOT NULL CHECK (quantity > 0),
    unit_price              NUMERIC(14,2) NOT NULL,
    refund_amount           NUMERIC(14,2) NOT NULL,
    condition               VARCHAR(20) NOT NULL DEFAULT 'resellable'
                            CHECK (condition IN ('resellable','damaged','defective')),
    back_to_stock           BOOLEAN NOT NULL DEFAULT TRUE,
    notes                   TEXT
);

CREATE INDEX idx_return_items_return  ON return_items(return_id);
CREATE INDEX idx_return_items_variant ON return_items(variant_id);

-- ---------- Exchanges (return X + sell Y in one transaction) ----------
CREATE TABLE exchanges (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    exchange_no             VARCHAR(30) NOT NULL UNIQUE,             -- EXC-2026-000001
    original_invoice_id     UUID NOT NULL REFERENCES invoices(id),
    customer_id             UUID REFERENCES customers(id) ON DELETE SET NULL,
    warehouse_id            UUID NOT NULL REFERENCES warehouses(id),
    returned_value          NUMERIC(14,2) NOT NULL DEFAULT 0,        -- value of returned items
    new_items_value         NUMERIC(14,2) NOT NULL DEFAULT 0,        -- value of new items
    price_difference        NUMERIC(14,2) GENERATED ALWAYS AS (new_items_value - returned_value) STORED,
    payment_method          payment_method_code,                     -- if customer paid extra
    refund_method           payment_method_code,                     -- if we refunded extra
    status                  VARCHAR(20) NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','completed','cancelled')),
    reason                  return_reason NOT NULL DEFAULT 'other',
    reason_details          TEXT,
    new_invoice_id          UUID REFERENCES invoices(id),            -- invoice created for new items
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at            TIMESTAMPTZ,
    handled_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    notes                   TEXT
);

CREATE INDEX idx_exchanges_invoice ON exchanges(original_invoice_id);

-- ---------- Exchange items (both returned and new) ----------
CREATE TABLE exchange_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    exchange_id     UUID NOT NULL REFERENCES exchanges(id) ON DELETE CASCADE,
    variant_id      UUID NOT NULL REFERENCES product_variants(id),
    kind            VARCHAR(8) NOT NULL CHECK (kind IN ('returned','new')),
    quantity        INT NOT NULL CHECK (quantity > 0),
    unit_price      NUMERIC(14,2) NOT NULL,
    line_total      NUMERIC(14,2) NOT NULL,
    condition       VARCHAR(20) NOT NULL DEFAULT 'resellable'
                    CHECK (condition IN ('resellable','damaged','defective')),
    notes           TEXT
);

CREATE INDEX idx_exchange_items_exchange ON exchange_items(exchange_id);
