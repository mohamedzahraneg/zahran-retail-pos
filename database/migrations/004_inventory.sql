-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 004 : Multi-warehouse Inventory
--
--  Core tables:
--    warehouses           - physical branch / warehouse / store
--    stock                - quantity on hand per (variant × warehouse)
--    stock_movements      - immutable ledger of every +/- stock change
--    stock_transfers      - transfer variants between warehouses
--    stock_adjustments    - manual +/- with reason
--    inventory_counts     - periodic physical counts (reconciliation)
-- ============================================================================

-- ---------- Warehouses (branches) ----------
CREATE TABLE warehouses (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            VARCHAR(20) NOT NULL UNIQUE,       -- ZHR-01, ZHR-02...
    name_ar         VARCHAR(120) NOT NULL,
    name_en         VARCHAR(120),
    address         TEXT,
    phone           VARCHAR(25),
    manager_id      UUID REFERENCES users(id) ON DELETE SET NULL,
    is_main         BOOLEAN NOT NULL DEFAULT FALSE,
    is_retail       BOOLEAN NOT NULL DEFAULT TRUE,     -- if true -> sells from POS
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add the FK that we deferred from users.default_warehouse_id
ALTER TABLE users
    ADD CONSTRAINT users_default_warehouse_fk
    FOREIGN KEY (default_warehouse_id) REFERENCES warehouses(id) ON DELETE SET NULL;

-- ---------- Stock (quantity on hand per variant per warehouse) ----------
CREATE TABLE stock (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    variant_id          UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    warehouse_id        UUID NOT NULL REFERENCES warehouses(id)       ON DELETE CASCADE,
    quantity_on_hand    INT  NOT NULL DEFAULT 0,
    quantity_reserved   INT  NOT NULL DEFAULT 0,       -- held by active reservations
    reorder_point       INT  NOT NULL DEFAULT 0,       -- trigger low-stock alert
    last_counted_at     TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (variant_id, warehouse_id),
    CHECK (quantity_on_hand  >= 0),
    CHECK (quantity_reserved >= 0)
);

CREATE INDEX idx_stock_variant   ON stock(variant_id);
CREATE INDEX idx_stock_warehouse ON stock(warehouse_id);
CREATE INDEX idx_stock_low       ON stock(warehouse_id) WHERE quantity_on_hand <= reorder_point;

-- Available = on_hand - reserved (computed via view later)

-- ---------- Stock movements (immutable ledger) ----------
CREATE TABLE stock_movements (
    id              BIGSERIAL PRIMARY KEY,
    variant_id      UUID NOT NULL REFERENCES product_variants(id),
    warehouse_id    UUID NOT NULL REFERENCES warehouses(id),
    movement_type   stock_movement_type NOT NULL,
    direction       txn_direction NOT NULL,             -- 'in' / 'out'
    quantity        INT NOT NULL CHECK (quantity > 0),  -- always positive, direction decides sign
    unit_cost       NUMERIC(14,2) DEFAULT 0,            -- avg cost at the time
    reference_type  entity_type,                        -- invoice / purchase / transfer / adjustment
    reference_id    UUID,
    notes           TEXT,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_movements_variant   ON stock_movements(variant_id);
CREATE INDEX idx_movements_warehouse ON stock_movements(warehouse_id);
CREATE INDEX idx_movements_ref       ON stock_movements(reference_type, reference_id);
CREATE INDEX idx_movements_created   ON stock_movements(created_at DESC);

-- ---------- Stock transfers ----------
CREATE TABLE stock_transfers (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transfer_no         VARCHAR(30) NOT NULL UNIQUE,            -- TRF-2026-00001
    from_warehouse_id   UUID NOT NULL REFERENCES warehouses(id),
    to_warehouse_id     UUID NOT NULL REFERENCES warehouses(id),
    status              VARCHAR(20) NOT NULL DEFAULT 'draft'    -- draft / in_transit / received / cancelled
                        CHECK (status IN ('draft','in_transit','received','cancelled')),
    notes               TEXT,
    requested_by        UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    received_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    requested_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    shipped_at          TIMESTAMPTZ,
    received_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (from_warehouse_id <> to_warehouse_id)
);

CREATE TABLE stock_transfer_items (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    transfer_id         UUID NOT NULL REFERENCES stock_transfers(id) ON DELETE CASCADE,
    variant_id          UUID NOT NULL REFERENCES product_variants(id),
    quantity_requested  INT  NOT NULL CHECK (quantity_requested > 0),
    quantity_received   INT  NOT NULL DEFAULT 0,
    notes               TEXT,
    UNIQUE (transfer_id, variant_id)
);

CREATE INDEX idx_transfer_items_transfer ON stock_transfer_items(transfer_id);

-- ---------- Stock adjustments (manual +/- with reason) ----------
CREATE TABLE stock_adjustments (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    adjustment_no   VARCHAR(30) NOT NULL UNIQUE,
    warehouse_id    UUID NOT NULL REFERENCES warehouses(id),
    reason_code     VARCHAR(40) NOT NULL,      -- DAMAGED / LOST / FOUND / EXPIRY / CORRECTION / OTHER
    notes           TEXT,
    status          VARCHAR(20) NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft','approved','cancelled')),
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    approved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE stock_adjustment_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    adjustment_id   UUID NOT NULL REFERENCES stock_adjustments(id) ON DELETE CASCADE,
    variant_id      UUID NOT NULL REFERENCES product_variants(id),
    delta           INT  NOT NULL CHECK (delta <> 0),           -- +5 or -3
    unit_cost       NUMERIC(14,2) DEFAULT 0,
    notes           TEXT,
    UNIQUE (adjustment_id, variant_id)
);

-- ---------- Inventory counts (physical reconciliation) ----------
CREATE TABLE inventory_counts (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    count_no        VARCHAR(30) NOT NULL UNIQUE,
    warehouse_id    UUID NOT NULL REFERENCES warehouses(id),
    status          VARCHAR(20) NOT NULL DEFAULT 'in_progress'
                    CHECK (status IN ('in_progress','completed','cancelled')),
    started_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    completed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at    TIMESTAMPTZ,
    notes           TEXT
);

CREATE TABLE inventory_count_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    count_id        UUID NOT NULL REFERENCES inventory_counts(id) ON DELETE CASCADE,
    variant_id      UUID NOT NULL REFERENCES product_variants(id),
    system_qty      INT  NOT NULL,             -- frozen at count time
    counted_qty     INT,                       -- null until counted
    difference      INT GENERATED ALWAYS AS (COALESCE(counted_qty,0) - system_qty) STORED,
    notes           TEXT,
    UNIQUE (count_id, variant_id)
);
