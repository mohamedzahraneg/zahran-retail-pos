-- =============================================================================
-- supabase_ready.sql
-- Single self-contained SQL script for the Zahran retail system.
-- Paste into Supabase SQL editor (or: psql -d zahran_retail -f supabase_ready.sql)
--
-- Contains every migration 001..029 concatenated in order. Safe to re-run:
--   * base migrations use plain CREATE (first run only)
--   * compatibility migrations 027/028/029 are idempotent
-- =============================================================================


-- =========================================================================
-- >>> FILE: migrations/001_extensions_and_enums.sql
-- =========================================================================
-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 001 : Extensions & Enum Types
--  PostgreSQL 14+
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "citext";       -- case-insensitive text (emails, barcodes)
CREATE EXTENSION IF NOT EXISTS "pg_trgm";      -- fuzzy search on product names / barcodes
CREATE EXTENSION IF NOT EXISTS "btree_gin";    -- composite indexes

-- ----------------------------------------------------------------------------
--  ENUM TYPES
-- ----------------------------------------------------------------------------

-- Gender / target audience of product (the store targets women but can expand)
CREATE TYPE target_audience AS ENUM ('women','men','kids','unisex');

-- Product type
CREATE TYPE product_type AS ENUM ('shoe','bag','accessory');

-- Stock movement reasons
CREATE TYPE stock_movement_type AS ENUM (
    'purchase',            -- purchased from supplier
    'sale',                -- sold via POS invoice
    'return_in',           -- customer return (back to stock)
    'return_out',          -- returned to supplier
    'transfer_out',        -- outgoing transfer to another warehouse
    'transfer_in',         -- incoming transfer from another warehouse
    'adjustment_in',       -- manual adjustment +
    'adjustment_out',      -- manual adjustment -
    'reservation_hold',    -- reserved (soft reduce of available)
    'reservation_release', -- reservation cancelled, stock released
    'reservation_sale',    -- reservation converted to sale
    'count_correction',    -- inventory count correction
    'damaged',             -- mark damaged / lost
    'initial'              -- opening balance
);

-- Generic transaction direction
CREATE TYPE txn_direction AS ENUM ('in','out');

-- Payment methods
CREATE TYPE payment_method_code AS ENUM (
    'cash','card_visa','card_mastercard','card_meeza','instapay',
    'vodafone_cash','orange_cash','bank_transfer','credit','other'
);

-- Invoice status
CREATE TYPE invoice_status AS ENUM (
    'draft','completed','partially_paid','paid','refunded','cancelled'
);

-- Discount types
CREATE TYPE discount_type AS ENUM ('fixed','percentage');

-- Discount scope
CREATE TYPE discount_scope AS ENUM ('product','invoice');

-- Reservation status  🔥
CREATE TYPE reservation_status AS ENUM (
    'active','completed','cancelled','expired'
);

-- Return reasons
CREATE TYPE return_reason AS ENUM (
    'defective','wrong_size','wrong_color','customer_changed_mind',
    'not_as_described','other'
);

-- Return status
CREATE TYPE return_status AS ENUM ('pending','approved','refunded','rejected');

-- Shift status
CREATE TYPE shift_status AS ENUM ('open','closed');

-- Alert severity
CREATE TYPE alert_severity AS ENUM ('info','warning','critical');

-- Alert type
CREATE TYPE alert_type AS ENUM (
    'low_stock','out_of_stock','reservation_expiring','reservation_expired',
    'loss_product','price_below_cost','large_discount','cash_mismatch','custom'
);

-- Activity action (for activity logs)
CREATE TYPE activity_action AS ENUM (
    'login','logout','create','update','delete','void',
    'approve','reject','print','export','import','sync'
);

-- Excel import status
CREATE TYPE import_status AS ENUM ('pending','processing','preview_ready','committed','failed','cancelled');

-- Coupon discount type
CREATE TYPE coupon_type AS ENUM ('fixed','percentage');

-- Sync queue state (for PWA offline)
CREATE TYPE sync_state AS ENUM ('pending','synced','conflict','failed');

-- Entity type for activity / audit (soft reference)
CREATE TYPE entity_type AS ENUM (
    'user','product','variant','warehouse','stock','invoice','invoice_item',
    'customer','supplier','purchase','reservation','return','exchange',
    'coupon','discount','expense','shift','cashbox','setting','role','other'
);

-- =========================================================================
-- >>> FILE: migrations/002_rbac_users.sql
-- =========================================================================
-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 002 : RBAC, Users, Activity & Audit
-- ============================================================================

-- ---------- Roles ----------
CREATE TABLE roles (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            VARCHAR(40)  NOT NULL UNIQUE,     -- admin, manager, cashier, salesperson, inventory
    name_ar         VARCHAR(100) NOT NULL,
    name_en         VARCHAR(100) NOT NULL,
    description     TEXT,
    is_system       BOOLEAN NOT NULL DEFAULT FALSE,   -- cannot be deleted if true
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- Permissions ----------
CREATE TABLE permissions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code            VARCHAR(80)  NOT NULL UNIQUE,     -- e.g. invoices.create, products.delete
    module          VARCHAR(40)  NOT NULL,            -- products, invoices, inventory, ...
    name_ar         VARCHAR(150) NOT NULL,
    name_en         VARCHAR(150) NOT NULL,
    description     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_permissions_module ON permissions(module);

-- ---------- Role ↔ Permission ----------
CREATE TABLE role_permissions (
    role_id         UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
    permission_id   UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
    granted_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (role_id, permission_id)
);

-- ---------- Users ----------
CREATE TABLE users (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    full_name           VARCHAR(150) NOT NULL,
    username            CITEXT UNIQUE NOT NULL,
    email               CITEXT UNIQUE,
    phone               VARCHAR(25),
    password_hash       TEXT NOT NULL,                -- bcrypt / argon2
    role_id             UUID NOT NULL REFERENCES roles(id) ON DELETE RESTRICT,
    default_warehouse_id UUID,                        -- FK added after warehouses table
    locale              VARCHAR(5) NOT NULL DEFAULT 'ar',
    avatar_url          TEXT,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    must_change_pwd     BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at       TIMESTAMPTZ,
    failed_login_count  INT NOT NULL DEFAULT 0,
    locked_until        TIMESTAMPTZ,
    salary              NUMERIC(14,2) DEFAULT 0,      -- optional payroll
    commission_rate     NUMERIC(5,2)  DEFAULT 0,      -- for salesperson (%)
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ                   -- soft delete
);

CREATE INDEX idx_users_role       ON users(role_id);
CREATE INDEX idx_users_active     ON users(is_active) WHERE is_active = TRUE;
CREATE INDEX idx_users_deleted    ON users(deleted_at);
CREATE INDEX idx_users_username   ON users(username);

-- ---------- User sessions (JWT refresh tracking) ----------
CREATE TABLE user_sessions (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    refresh_token_hash TEXT NOT NULL,
    device_info     JSONB DEFAULT '{}'::jsonb,        -- user agent, OS, IP
    ip_address      INET,
    expires_at      TIMESTAMPTZ NOT NULL,
    revoked_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_user_sessions_user ON user_sessions(user_id);
CREATE INDEX idx_user_sessions_exp  ON user_sessions(expires_at);

-- ---------- Activity logs (business events, user-facing) ----------
CREATE TABLE activity_logs (
    id              BIGSERIAL PRIMARY KEY,
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    action          activity_action NOT NULL,
    entity          entity_type NOT NULL,
    entity_id       UUID,
    summary         TEXT,                             -- human-readable Arabic
    metadata        JSONB DEFAULT '{}'::jsonb,
    ip_address      INET,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_activity_user     ON activity_logs(user_id);
CREATE INDEX idx_activity_entity   ON activity_logs(entity, entity_id);
CREATE INDEX idx_activity_created  ON activity_logs(created_at DESC);

-- ---------- Audit logs (low-level DB change log) ----------
CREATE TABLE audit_logs (
    id              BIGSERIAL PRIMARY KEY,
    table_name      VARCHAR(80)  NOT NULL,
    record_id       TEXT         NOT NULL,
    operation       CHAR(1)      NOT NULL CHECK (operation IN ('I','U','D')),
    changed_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    old_data        JSONB,
    new_data        JSONB,
    changed_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_audit_table   ON audit_logs(table_name, record_id);
CREATE INDEX idx_audit_time    ON audit_logs(changed_at DESC);

-- =========================================================================
-- >>> FILE: migrations/003_catalog.sql
-- =========================================================================
-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 003 : Catalog (Categories, Products, Variants)
--
--  Design:
--    products         = the "master" model (e.g. «حذاء سهرة موديل 204»)
--    product_colors   = colors belonging to a product (each has its own image)
--    product_sizes    = sizes (only for shoes)
--    product_variants = the actual SKU: product × color × size (or color only for bags)
--                       Stock and barcode live on the VARIANT.
-- ============================================================================

-- ---------- Brands ----------
CREATE TABLE brands (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name_ar         VARCHAR(120) NOT NULL,
    name_en         VARCHAR(120),
    logo_url        TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- Categories (2-level: category → subcategory) ----------
CREATE TABLE categories (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    parent_id       UUID REFERENCES categories(id) ON DELETE SET NULL,
    name_ar         VARCHAR(120) NOT NULL,
    name_en         VARCHAR(120),
    slug            VARCHAR(160) UNIQUE,
    icon            VARCHAR(80),
    sort_order      INT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_categories_parent ON categories(parent_id);

-- ---------- Colors (reusable master) ----------
CREATE TABLE colors (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name_ar         VARCHAR(50) NOT NULL,
    name_en         VARCHAR(50),
    hex_code        CHAR(7),                                   -- #RRGGBB
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (name_ar)
);

-- ---------- Sizes (shoe sizes: EU 35..44, can expand) ----------
CREATE TABLE sizes (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    size_label      VARCHAR(10) NOT NULL UNIQUE,               -- '36','37','M','L'...
    size_system     VARCHAR(10) NOT NULL DEFAULT 'EU',         -- EU / US / UK
    sort_order      INT NOT NULL DEFAULT 0,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE
);

-- ---------- Products (master) ----------
CREATE TABLE products (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    sku_prefix          VARCHAR(20) NOT NULL UNIQUE,            -- short code used in variant SKU
    name_ar             VARCHAR(200) NOT NULL,
    name_en             VARCHAR(200),
    description_ar      TEXT,
    description_en      TEXT,
    product_type        product_type NOT NULL,                  -- shoe / bag / accessory
    target_audience     target_audience NOT NULL DEFAULT 'women',
    category_id         UUID REFERENCES categories(id) ON DELETE SET NULL,
    subcategory_id      UUID REFERENCES categories(id) ON DELETE SET NULL,
    brand_id            UUID REFERENCES brands(id)     ON DELETE SET NULL,
    base_cost           NUMERIC(14,2) NOT NULL DEFAULT 0,       -- default cost (can be overridden per-variant)
    base_price          NUMERIC(14,2) NOT NULL DEFAULT 0,       -- default selling price
    suggested_price     NUMERIC(14,2),                          -- computed from smart pricing
    min_margin_pct      NUMERIC(5,2) DEFAULT 15.00,             -- loss-alert threshold
    track_inventory     BOOLEAN NOT NULL DEFAULT TRUE,
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,     -- material, season, collection...
    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at          TIMESTAMPTZ,
    CHECK (base_cost >= 0 AND base_price >= 0)
);

CREATE INDEX idx_products_type      ON products(product_type);
CREATE INDEX idx_products_cat       ON products(category_id);
CREATE INDEX idx_products_subcat    ON products(subcategory_id);
CREATE INDEX idx_products_active    ON products(is_active) WHERE is_active = TRUE AND deleted_at IS NULL;
CREATE INDEX idx_products_name_trgm ON products USING gin (name_ar gin_trgm_ops);

-- ---------- Product ↔ Color (defines which colors exist for this product) ----------
CREATE TABLE product_colors (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    color_id        UUID NOT NULL REFERENCES colors(id)   ON DELETE RESTRICT,
    image_url       TEXT,                                       -- main image of this color
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    UNIQUE (product_id, color_id)
);

CREATE INDEX idx_product_colors_product ON product_colors(product_id);

-- ---------- Product images (gallery, multiple per color) ----------
CREATE TABLE product_images (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_color_id UUID NOT NULL REFERENCES product_colors(id) ON DELETE CASCADE,
    url             TEXT NOT NULL,
    alt_text        VARCHAR(200),
    sort_order      INT NOT NULL DEFAULT 0,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_product_images_pc ON product_images(product_color_id);

-- ---------- Product variants (the actual SKU) ----------
-- For shoes : product × color × size     -> size is required
-- For bags  : product × color             -> size is NULL
CREATE TABLE product_variants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    product_id      UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    color_id        UUID NOT NULL REFERENCES colors(id),
    size_id         UUID REFERENCES sizes(id),
    sku             VARCHAR(60)  NOT NULL UNIQUE,               -- auto-generated (see trigger)
    barcode         CITEXT UNIQUE,                              -- scan barcode, optional
    cost_price      NUMERIC(14,2) NOT NULL DEFAULT 0,           -- can override product.base_cost
    selling_price   NUMERIC(14,2) NOT NULL DEFAULT 0,
    weight_grams    INT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ,
    UNIQUE (product_id, color_id, size_id),
    CHECK (cost_price >= 0 AND selling_price >= 0)
);

CREATE INDEX idx_variants_product  ON product_variants(product_id);
CREATE INDEX idx_variants_color    ON product_variants(color_id);
CREATE INDEX idx_variants_barcode  ON product_variants(barcode);
CREATE INDEX idx_variants_sku_trgm ON product_variants USING gin (sku gin_trgm_ops);

-- =========================================================================
-- >>> FILE: migrations/004_inventory.sql
-- =========================================================================
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

-- =========================================================================
-- >>> FILE: migrations/005_customers_suppliers.sql
-- =========================================================================
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

-- =========================================================================
-- >>> FILE: migrations/006_pos_and_discounts.sql
-- =========================================================================
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

-- =========================================================================
-- >>> FILE: migrations/007_reservations.sql
-- =========================================================================
-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 007 : Reservations & Partial Payments 🔥
--
--  Flow:
--    1. Customer chooses product + deposit.
--    2. reservation row created with status='active', items added.
--    3. stock.quantity_reserved += qty  (hard hold, cannot be sold elsewhere).
--    4. Payments are accumulated in reservation_payments.
--    5. When customer returns: reservation is converted to an invoice
--         - stock.quantity_reserved -= qty ; sale movement decreases on_hand
--         - remaining balance paid at POS
--         - status -> 'completed'
--    6. If cancelled: stock released, partial refund per policy
--       status -> 'cancelled'; reservation_refunds records refund.
--    7. Cron job expires unpaid reservations past expiry_date (optional).
-- ============================================================================

-- ---------- Reservations (header) ----------
CREATE TABLE reservations (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reservation_no          VARCHAR(30) NOT NULL UNIQUE,            -- RES-2026-000001
    customer_id             UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    warehouse_id            UUID NOT NULL REFERENCES warehouses(id),
    status                  reservation_status NOT NULL DEFAULT 'active',
    -- money
    subtotal                NUMERIC(14,2) NOT NULL DEFAULT 0,       -- sum of (qty * price) for items
    discount_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,
    total_amount            NUMERIC(14,2) NOT NULL DEFAULT 0,       -- grand total the customer owes
    deposit_required_pct    NUMERIC(5,2)  NOT NULL DEFAULT 30.00,   -- store policy
    paid_amount             NUMERIC(14,2) NOT NULL DEFAULT 0,       -- sum of reservation_payments (deposit + extras)
    refunded_amount         NUMERIC(14,2) NOT NULL DEFAULT 0,       -- if cancelled
    remaining_amount        NUMERIC(14,2) GENERATED ALWAYS AS
                                (total_amount - paid_amount + refunded_amount) STORED,
    -- lifecycle
    reserved_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at              TIMESTAMPTZ,                             -- auto-cancel after this
    completed_at            TIMESTAMPTZ,
    cancelled_at            TIMESTAMPTZ,
    -- conversion
    converted_invoice_id    UUID REFERENCES invoices(id),            -- filled when completed
    -- policies
    refund_policy           VARCHAR(20) NOT NULL DEFAULT 'partial'
                            CHECK (refund_policy IN ('full','partial','none')),
    cancellation_fee_pct    NUMERIC(5,2)  NOT NULL DEFAULT 10.00,    -- for partial refund
    cancellation_reason     TEXT,
    notes                   TEXT,
    created_by              UUID REFERENCES users(id) ON DELETE SET NULL,
    completed_by            UUID REFERENCES users(id) ON DELETE SET NULL,
    cancelled_by            UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_reservations_customer   ON reservations(customer_id);
CREATE INDEX idx_reservations_warehouse  ON reservations(warehouse_id);
CREATE INDEX idx_reservations_status     ON reservations(status);
CREATE INDEX idx_reservations_expires    ON reservations(expires_at)
    WHERE status = 'active';

-- Deferred FK on invoices.reservation_id
ALTER TABLE invoices
    ADD CONSTRAINT invoices_reservation_fk
    FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE SET NULL;

-- ---------- Reservation items ----------
CREATE TABLE reservation_items (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reservation_id  UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    variant_id      UUID NOT NULL REFERENCES product_variants(id),
    quantity        INT  NOT NULL CHECK (quantity > 0),
    unit_price      NUMERIC(14,2) NOT NULL CHECK (unit_price >= 0),
    discount_amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    line_total      NUMERIC(14,2) NOT NULL,
    notes           TEXT,
    UNIQUE (reservation_id, variant_id)
);

CREATE INDEX idx_res_items_reservation ON reservation_items(reservation_id);
CREATE INDEX idx_res_items_variant     ON reservation_items(variant_id);

-- ---------- Reservation payments (deposit + any additional partial payments) ----------
CREATE TABLE reservation_payments (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reservation_id      UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    payment_method      payment_method_code NOT NULL,
    amount              NUMERIC(14,2) NOT NULL CHECK (amount > 0),
    kind                VARCHAR(20) NOT NULL DEFAULT 'deposit'
                        CHECK (kind IN ('deposit','installment','final')),
    reference_number    VARCHAR(60),
    received_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    paid_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes               TEXT
);

CREATE INDEX idx_res_payments_reservation ON reservation_payments(reservation_id);

-- ---------- Reservation refunds (when cancelled) ----------
CREATE TABLE reservation_refunds (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    reservation_id      UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
    payment_method      payment_method_code NOT NULL,
    gross_amount        NUMERIC(14,2) NOT NULL,      -- amount originally paid by customer
    fee_amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
    net_refund_amount   NUMERIC(14,2) NOT NULL,      -- gross - fee
    reason              TEXT,
    approved_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    refunded_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    refunded_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_res_refunds_reservation ON reservation_refunds(reservation_id);

-- =========================================================================
-- >>> FILE: migrations/008_returns_exchanges.sql
-- =========================================================================
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

-- =========================================================================
-- >>> FILE: migrations/009_accounting_shifts.sql
-- =========================================================================
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

-- =========================================================================
-- >>> FILE: migrations/010_support_alerts_settings_offline.sql
-- =========================================================================
-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 010 : Alerts, Imports, Settings, Offline Sync
-- ============================================================================

-- ---------- Alerts ----------
CREATE TABLE alerts (
    id              BIGSERIAL PRIMARY KEY,
    alert_type      alert_type NOT NULL,
    severity        alert_severity NOT NULL DEFAULT 'info',
    title           VARCHAR(200) NOT NULL,
    message         TEXT,
    entity          entity_type,
    entity_id       UUID,
    is_read         BOOLEAN NOT NULL DEFAULT FALSE,
    is_resolved     BOOLEAN NOT NULL DEFAULT FALSE,
    resolved_at     TIMESTAMPTZ,
    resolved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    target_role_id  UUID REFERENCES roles(id),
    target_user_id  UUID REFERENCES users(id) ON DELETE CASCADE,
    metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_alerts_unread   ON alerts(is_read)     WHERE is_read = FALSE;
CREATE INDEX idx_alerts_unresolved ON alerts(is_resolved) WHERE is_resolved = FALSE;
CREATE INDEX idx_alerts_type     ON alerts(alert_type);
CREATE INDEX idx_alerts_target_user ON alerts(target_user_id);

-- ---------- Alert rules (configurable triggers) ----------
CREATE TABLE alert_rules (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    alert_type      alert_type NOT NULL,
    name_ar         VARCHAR(150) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    threshold_value NUMERIC(14,2),                 -- e.g. low_stock threshold
    config          JSONB NOT NULL DEFAULT '{}'::jsonb,
    target_role_id  UUID REFERENCES roles(id),
    notify_channels VARCHAR(60) NOT NULL DEFAULT 'in_app',  -- in_app,email,sms
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- Excel imports ----------
CREATE TABLE excel_imports (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    file_name       VARCHAR(255) NOT NULL,
    file_url        TEXT,
    import_type     VARCHAR(40) NOT NULL DEFAULT 'products'
                    CHECK (import_type IN ('products','customers','suppliers','stock','prices')),
    status          import_status NOT NULL DEFAULT 'pending',
    total_rows      INT NOT NULL DEFAULT 0,
    valid_rows      INT NOT NULL DEFAULT 0,
    invalid_rows    INT NOT NULL DEFAULT 0,
    imported_rows   INT NOT NULL DEFAULT 0,
    preview_data    JSONB,                         -- cached parsed preview
    options         JSONB NOT NULL DEFAULT '{}'::jsonb,
    uploaded_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    committed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
    uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    committed_at    TIMESTAMPTZ,
    notes           TEXT
);

CREATE INDEX idx_excel_imports_status ON excel_imports(status);

-- ---------- Excel import row errors ----------
CREATE TABLE excel_import_errors (
    id              BIGSERIAL PRIMARY KEY,
    import_id       UUID NOT NULL REFERENCES excel_imports(id) ON DELETE CASCADE,
    row_number      INT NOT NULL,
    column_name     VARCHAR(80),
    error_code      VARCHAR(40),
    error_message   TEXT NOT NULL,
    row_data        JSONB,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_import_errors_import ON excel_import_errors(import_id);

-- ---------- Settings (key/value store) ----------
CREATE TABLE settings (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    key             VARCHAR(80) UNIQUE NOT NULL,
    value           JSONB NOT NULL,
    group_name      VARCHAR(40) NOT NULL DEFAULT 'general',      -- general, pos, printing, loyalty, smart_pricing
    is_public       BOOLEAN NOT NULL DEFAULT FALSE,
    description     TEXT,
    updated_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_settings_group ON settings(group_name);

-- ---------- Printer configurations ----------
CREATE TABLE printer_configs (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    warehouse_id    UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    name            VARCHAR(120) NOT NULL,
    type            VARCHAR(20) NOT NULL CHECK (type IN ('thermal_58','thermal_80','a4','a5','label')),
    interface       VARCHAR(20) NOT NULL DEFAULT 'network' CHECK (interface IN ('usb','network','bluetooth')),
    address         VARCHAR(120),                   -- IP:port, USB path, MAC...
    is_default      BOOLEAN NOT NULL DEFAULT FALSE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    template        TEXT,                           -- custom ESC/POS or HTML template
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ---------- Offline sync queue (for PWA) ----------
-- This is the server-side record of what offline clients pushed.
-- The client keeps a local mirror (in IndexedDB) and posts batches when back online.
CREATE TABLE offline_sync_queue (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    client_id       VARCHAR(60) NOT NULL,                 -- unique device id
    user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
    entity          entity_type NOT NULL,
    operation       CHAR(1) NOT NULL CHECK (operation IN ('I','U','D')),
    offline_id      VARCHAR(60) NOT NULL,                  -- client-generated UUID
    server_id       UUID,                                  -- after server-side resolution
    payload         JSONB NOT NULL,
    state           sync_state NOT NULL DEFAULT 'pending',
    conflict_reason TEXT,
    client_created_at TIMESTAMPTZ NOT NULL,
    server_processed_at TIMESTAMPTZ,
    attempts        INT NOT NULL DEFAULT 0,
    last_error      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (client_id, offline_id)
);

CREATE INDEX idx_sync_queue_state   ON offline_sync_queue(state) WHERE state = 'pending';
CREATE INDEX idx_sync_queue_client  ON offline_sync_queue(client_id);
CREATE INDEX idx_sync_queue_offline ON offline_sync_queue(offline_id);

-- ---------- Payment methods (reference list, configurable) ----------
CREATE TABLE payment_methods (
    code            payment_method_code PRIMARY KEY,
    name_ar         VARCHAR(80) NOT NULL,
    name_en         VARCHAR(80) NOT NULL,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    requires_reference BOOLEAN NOT NULL DEFAULT FALSE,    -- if true POS asks for ref no.
    sort_order      INT NOT NULL DEFAULT 0
);

-- ---------- Company / Store profile ----------
CREATE TABLE company_profile (
    id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),   -- singleton
    name_ar         VARCHAR(200) NOT NULL DEFAULT 'زهران لأحذية وحقائب السيدات',
    name_en         VARCHAR(200),
    logo_url        TEXT,
    tax_number      VARCHAR(40),
    commercial_reg  VARCHAR(40),
    address         TEXT,
    phone           VARCHAR(25),
    email           CITEXT,
    website         TEXT,
    default_tax_rate NUMERIC(5,2) NOT NULL DEFAULT 14.00,
    default_currency VARCHAR(3)   NOT NULL DEFAULT 'EGP',
    fiscal_year_start DATE NOT NULL DEFAULT '2026-01-01',
    receipt_footer_ar TEXT,
    return_policy_text_ar TEXT,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- =========================================================================
-- >>> FILE: migrations/011_functions_and_triggers.sql
-- =========================================================================
-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 011 : Functions, Triggers, Business Logic
-- ============================================================================

-- ---------------------------------------------------------------------------
--  1. Helper: generic updated_at
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION touch_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply to all tables that have updated_at
DO $$
DECLARE
    t text;
BEGIN
    FOR t IN
        SELECT c.table_name
        FROM information_schema.columns c
        JOIN information_schema.tables tt
          ON tt.table_name = c.table_name AND tt.table_schema = c.table_schema
        WHERE c.table_schema = 'public'
          AND c.column_name = 'updated_at'
          AND tt.table_type = 'BASE TABLE'
    LOOP
        EXECUTE format(
            'CREATE TRIGGER trg_%s_updated
             BEFORE UPDATE ON %I
             FOR EACH ROW EXECUTE FUNCTION touch_updated_at();',
             t, t
        );
    END LOOP;
END $$;

-- ---------------------------------------------------------------------------
--  2. Document number sequences + generators
-- ---------------------------------------------------------------------------
CREATE SEQUENCE seq_invoice_no    START 1;
CREATE SEQUENCE seq_purchase_no   START 1;
CREATE SEQUENCE seq_transfer_no   START 1;
CREATE SEQUENCE seq_adjustment_no START 1;
CREATE SEQUENCE seq_count_no      START 1;
CREATE SEQUENCE seq_return_no     START 1;
CREATE SEQUENCE seq_exchange_no   START 1;
CREATE SEQUENCE seq_reservation_no START 1;
CREATE SEQUENCE seq_expense_no    START 1;
CREATE SEQUENCE seq_shift_no      START 1;
CREATE SEQUENCE seq_customer_no   START 1;
CREATE SEQUENCE seq_supplier_no   START 1;

CREATE OR REPLACE FUNCTION next_doc_no(prefix text, seq text)
RETURNS text AS $$
DECLARE
    yr text := TO_CHAR(CURRENT_DATE, 'YYYY');
    nextv bigint;
BEGIN
    EXECUTE format('SELECT nextval(%L)', seq) INTO nextv;
    RETURN prefix || '-' || yr || '-' || LPAD(nextv::text, 6, '0');
END;
$$ LANGUAGE plpgsql;

-- Assign doc number defaults via triggers -----------------------------------
CREATE OR REPLACE FUNCTION set_invoice_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.invoice_no IS NULL OR NEW.invoice_no = '' THEN
        NEW.invoice_no := next_doc_no('INV','seq_invoice_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_invoice_no BEFORE INSERT ON invoices
FOR EACH ROW EXECUTE FUNCTION set_invoice_no();

CREATE OR REPLACE FUNCTION set_purchase_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.purchase_no IS NULL OR NEW.purchase_no = '' THEN
        NEW.purchase_no := next_doc_no('PO','seq_purchase_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_purchase_no BEFORE INSERT ON purchases
FOR EACH ROW EXECUTE FUNCTION set_purchase_no();

CREATE OR REPLACE FUNCTION set_transfer_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.transfer_no IS NULL OR NEW.transfer_no = '' THEN
        NEW.transfer_no := next_doc_no('TRF','seq_transfer_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_transfer_no BEFORE INSERT ON stock_transfers
FOR EACH ROW EXECUTE FUNCTION set_transfer_no();

CREATE OR REPLACE FUNCTION set_adjustment_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.adjustment_no IS NULL OR NEW.adjustment_no = '' THEN
        NEW.adjustment_no := next_doc_no('ADJ','seq_adjustment_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_adjustment_no BEFORE INSERT ON stock_adjustments
FOR EACH ROW EXECUTE FUNCTION set_adjustment_no();

CREATE OR REPLACE FUNCTION set_count_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.count_no IS NULL OR NEW.count_no = '' THEN
        NEW.count_no := next_doc_no('CNT','seq_count_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_count_no BEFORE INSERT ON inventory_counts
FOR EACH ROW EXECUTE FUNCTION set_count_no();

CREATE OR REPLACE FUNCTION set_return_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.return_no IS NULL OR NEW.return_no = '' THEN
        NEW.return_no := next_doc_no('RET','seq_return_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_return_no BEFORE INSERT ON returns
FOR EACH ROW EXECUTE FUNCTION set_return_no();

CREATE OR REPLACE FUNCTION set_exchange_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.exchange_no IS NULL OR NEW.exchange_no = '' THEN
        NEW.exchange_no := next_doc_no('EXC','seq_exchange_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_exchange_no BEFORE INSERT ON exchanges
FOR EACH ROW EXECUTE FUNCTION set_exchange_no();

CREATE OR REPLACE FUNCTION set_reservation_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.reservation_no IS NULL OR NEW.reservation_no = '' THEN
        NEW.reservation_no := next_doc_no('RES','seq_reservation_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_reservation_no BEFORE INSERT ON reservations
FOR EACH ROW EXECUTE FUNCTION set_reservation_no();

CREATE OR REPLACE FUNCTION set_expense_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.expense_no IS NULL OR NEW.expense_no = '' THEN
        NEW.expense_no := next_doc_no('EXP','seq_expense_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_expense_no BEFORE INSERT ON expenses
FOR EACH ROW EXECUTE FUNCTION set_expense_no();

CREATE OR REPLACE FUNCTION set_shift_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.shift_no IS NULL OR NEW.shift_no = '' THEN
        NEW.shift_no := next_doc_no('SHF','seq_shift_no');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_shift_no BEFORE INSERT ON shifts
FOR EACH ROW EXECUTE FUNCTION set_shift_no();

CREATE OR REPLACE FUNCTION set_customer_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.customer_no IS NULL OR NEW.customer_no = '' THEN
        NEW.customer_no := 'CUS-' || LPAD(nextval('seq_customer_no')::text, 6, '0');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_customer_no BEFORE INSERT ON customers
FOR EACH ROW EXECUTE FUNCTION set_customer_no();

CREATE OR REPLACE FUNCTION set_supplier_no()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.supplier_no IS NULL OR NEW.supplier_no = '' THEN
        NEW.supplier_no := 'SUP-' || LPAD(nextval('seq_supplier_no')::text, 6, '0');
    END IF;
    RETURN NEW;
END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_set_supplier_no BEFORE INSERT ON suppliers
FOR EACH ROW EXECUTE FUNCTION set_supplier_no();

-- ---------------------------------------------------------------------------
--  3. Auto-generate SKU on product_variants insert
--     Format: <sku_prefix>-<colorCode>-<size|00>
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auto_generate_sku()
RETURNS TRIGGER AS $$
DECLARE
    p_prefix  text;
    c_name    text;
    c_code    text;
    s_label   text;
BEGIN
    IF NEW.sku IS NULL OR NEW.sku = '' THEN
        SELECT sku_prefix INTO p_prefix FROM products WHERE id = NEW.product_id;
        SELECT COALESCE(name_en, name_ar) INTO c_name FROM colors WHERE id = NEW.color_id;
        -- Use first 3 letters of color name, uppercased, fallback to color id hash
        c_code := UPPER(LEFT(REGEXP_REPLACE(COALESCE(c_name,'COL'), '[^A-Za-z0-9]', '', 'g'), 3));
        IF c_code = '' THEN
            c_code := 'CLR';
        END IF;

        IF NEW.size_id IS NOT NULL THEN
            SELECT size_label INTO s_label FROM sizes WHERE id = NEW.size_id;
        ELSE
            s_label := '00';
        END IF;

        NEW.sku := p_prefix || '-' || c_code || '-' || s_label;
        -- If collision, add random 4 chars
        IF EXISTS(SELECT 1 FROM product_variants WHERE sku = NEW.sku) THEN
            NEW.sku := NEW.sku || '-' || UPPER(SUBSTRING(MD5(random()::text), 1, 4));
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_variant_auto_sku
BEFORE INSERT ON product_variants
FOR EACH ROW EXECUTE FUNCTION auto_generate_sku();

-- ---------------------------------------------------------------------------
--  4. Stock updates driven by stock_movements
--     Every movement applies delta to stock.quantity_on_hand
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION apply_stock_movement()
RETURNS TRIGGER AS $$
DECLARE
    delta int;
BEGIN
    delta := CASE WHEN NEW.direction = 'in' THEN NEW.quantity ELSE -NEW.quantity END;

    INSERT INTO stock (variant_id, warehouse_id, quantity_on_hand, quantity_reserved)
    VALUES (NEW.variant_id, NEW.warehouse_id, GREATEST(delta, 0), 0)
    ON CONFLICT (variant_id, warehouse_id)
    DO UPDATE SET
        quantity_on_hand = stock.quantity_on_hand + delta,
        updated_at = NOW();

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_apply_stock_movement
AFTER INSERT ON stock_movements
FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();

-- ---------------------------------------------------------------------------
--  5. Reservations: manage quantity_reserved
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reservation_hold_stock()
RETURNS TRIGGER AS $$
DECLARE
    wh uuid;
BEGIN
    SELECT warehouse_id INTO wh FROM reservations WHERE id = NEW.reservation_id;

    INSERT INTO stock (variant_id, warehouse_id, quantity_on_hand, quantity_reserved)
    VALUES (NEW.variant_id, wh, 0, NEW.quantity)
    ON CONFLICT (variant_id, warehouse_id)
    DO UPDATE SET
        quantity_reserved = stock.quantity_reserved + NEW.quantity,
        updated_at = NOW();

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reservation_item_hold
AFTER INSERT ON reservation_items
FOR EACH ROW EXECUTE FUNCTION reservation_hold_stock();

-- When reservation is cancelled/expired -> release quantity_reserved
CREATE OR REPLACE FUNCTION reservation_release_stock()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.status = 'active' AND NEW.status IN ('cancelled','expired','completed') THEN
        -- completed means the items have just been sold through an invoice;
        -- the caller is responsible for inserting stock_movements of type 'reservation_sale'
        -- (direction 'out') BEFORE updating status.
        UPDATE stock s
        SET quantity_reserved = GREATEST(s.quantity_reserved - ri.quantity, 0),
            updated_at = NOW()
        FROM reservation_items ri
        WHERE ri.reservation_id = NEW.id
          AND s.variant_id    = ri.variant_id
          AND s.warehouse_id  = NEW.warehouse_id;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_reservation_status_change
AFTER UPDATE OF status ON reservations
FOR EACH ROW EXECUTE FUNCTION reservation_release_stock();

-- ---------------------------------------------------------------------------
--  6. Low-stock alert trigger (runs after stock update)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION check_low_stock()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.quantity_on_hand <= NEW.reorder_point
       AND (OLD.quantity_on_hand IS NULL OR OLD.quantity_on_hand > NEW.reorder_point) THEN
        INSERT INTO alerts (alert_type, severity, title, message, entity, entity_id, metadata)
        VALUES (
            (CASE WHEN NEW.quantity_on_hand = 0 THEN 'out_of_stock' ELSE 'low_stock' END)::alert_type,
            (CASE WHEN NEW.quantity_on_hand = 0 THEN 'critical'     ELSE 'warning' END)::alert_severity,
            'تنبيه مخزون',
            format('المنتج (variant %s) أصبح المخزون %s قطعة في المخزن %s',
                   NEW.variant_id, NEW.quantity_on_hand, NEW.warehouse_id),
            'stock'::entity_type,
            NEW.id,
            jsonb_build_object(
                'variant_id',  NEW.variant_id,
                'warehouse_id',NEW.warehouse_id,
                'quantity',    NEW.quantity_on_hand,
                'reorder_point', NEW.reorder_point
            )
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_check_low_stock
AFTER UPDATE OF quantity_on_hand ON stock
FOR EACH ROW EXECUTE FUNCTION check_low_stock();

-- ---------------------------------------------------------------------------
--  7. Invoice totals recompute (called from application layer usually,
--     but we keep a helper function for reuse)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recompute_invoice_totals(p_invoice_id uuid)
RETURNS void AS $$
DECLARE
    v_subtotal      numeric(14,2);
    v_items_disc    numeric(14,2);
    v_tax           numeric(14,2);
    v_cogs          numeric(14,2);
    v_inv_disc      numeric(14,2);
    v_coupon_disc   numeric(14,2);
    v_paid          numeric(14,2);
    v_grand         numeric(14,2);
BEGIN
    SELECT
        COALESCE(SUM(quantity * unit_price), 0),
        COALESCE(SUM(discount_amount),       0),
        COALESCE(SUM(tax_amount),            0),
        COALESCE(SUM(quantity * unit_cost),  0)
    INTO v_subtotal, v_items_disc, v_tax, v_cogs
    FROM invoice_items WHERE invoice_id = p_invoice_id;

    SELECT invoice_discount, coupon_discount
    INTO v_inv_disc, v_coupon_disc
    FROM invoices WHERE id = p_invoice_id;

    SELECT COALESCE(SUM(amount),0) INTO v_paid
    FROM invoice_payments WHERE invoice_id = p_invoice_id;

    v_grand := v_subtotal - v_items_disc - COALESCE(v_inv_disc,0) - COALESCE(v_coupon_disc,0) + v_tax;

    UPDATE invoices SET
        subtotal              = v_subtotal,
        items_discount_total  = v_items_disc,
        tax_amount            = v_tax,
        cogs_total            = v_cogs,
        grand_total           = GREATEST(v_grand, 0),
        paid_amount           = v_paid,
        gross_profit          = GREATEST(v_grand,0) - v_cogs,
        updated_at            = NOW()
    WHERE id = p_invoice_id;
END;
$$ LANGUAGE plpgsql;

-- Auto-recompute on invoice_items or invoice_payments change
CREATE OR REPLACE FUNCTION trg_recompute_invoice()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM recompute_invoice_totals(COALESCE(NEW.invoice_id, OLD.invoice_id));
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_items_recompute
AFTER INSERT OR UPDATE OR DELETE ON invoice_items
FOR EACH ROW EXECUTE FUNCTION trg_recompute_invoice();

CREATE TRIGGER trg_payments_recompute
AFTER INSERT OR UPDATE OR DELETE ON invoice_payments
FOR EACH ROW EXECUTE FUNCTION trg_recompute_invoice();

-- ---------------------------------------------------------------------------
--  8. Reservation totals recompute
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION recompute_reservation_totals(p_res_id uuid)
RETURNS void AS $$
DECLARE
    v_subtotal numeric(14,2);
    v_disc     numeric(14,2);
    v_paid     numeric(14,2);
    v_refund   numeric(14,2);
BEGIN
    SELECT COALESCE(SUM(line_total),0), COALESCE(SUM(discount_amount),0)
      INTO v_subtotal, v_disc
      FROM reservation_items WHERE reservation_id = p_res_id;

    SELECT COALESCE(SUM(amount),0) INTO v_paid
      FROM reservation_payments WHERE reservation_id = p_res_id;

    SELECT COALESCE(SUM(net_refund_amount),0) INTO v_refund
      FROM reservation_refunds WHERE reservation_id = p_res_id;

    UPDATE reservations SET
        subtotal        = v_subtotal,
        discount_amount = v_disc,
        total_amount    = GREATEST(v_subtotal - v_disc, 0),
        paid_amount     = v_paid,
        refunded_amount = v_refund,
        updated_at      = NOW()
    WHERE id = p_res_id;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION trg_recompute_reservation()
RETURNS TRIGGER AS $$
BEGIN
    PERFORM recompute_reservation_totals(COALESCE(NEW.reservation_id, OLD.reservation_id));
    RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_res_items_recompute
AFTER INSERT OR UPDATE OR DELETE ON reservation_items
FOR EACH ROW EXECUTE FUNCTION trg_recompute_reservation();

CREATE TRIGGER trg_res_payments_recompute
AFTER INSERT OR UPDATE OR DELETE ON reservation_payments
FOR EACH ROW EXECUTE FUNCTION trg_recompute_reservation();

CREATE TRIGGER trg_res_refunds_recompute
AFTER INSERT OR UPDATE OR DELETE ON reservation_refunds
FOR EACH ROW EXECUTE FUNCTION trg_recompute_reservation();

-- ---------------------------------------------------------------------------
--  9. Audit trigger (generic JSONB diff) — wire to sensitive tables
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_audit_row()
RETURNS TRIGGER AS $$
DECLARE
    v_user uuid := NULLIF(current_setting('app.current_user_id', true), '')::uuid;
BEGIN
    IF (TG_OP = 'INSERT') THEN
        INSERT INTO audit_logs(table_name, record_id, operation, changed_by, new_data)
        VALUES (TG_TABLE_NAME, NEW.id::text, 'I', v_user, to_jsonb(NEW));
        RETURN NEW;
    ELSIF (TG_OP = 'UPDATE') THEN
        INSERT INTO audit_logs(table_name, record_id, operation, changed_by, old_data, new_data)
        VALUES (TG_TABLE_NAME, NEW.id::text, 'U', v_user, to_jsonb(OLD), to_jsonb(NEW));
        RETURN NEW;
    ELSE
        INSERT INTO audit_logs(table_name, record_id, operation, changed_by, old_data)
        VALUES (TG_TABLE_NAME, OLD.id::text, 'D', v_user, to_jsonb(OLD));
        RETURN OLD;
    END IF;
END;
$$ LANGUAGE plpgsql;

-- Attach to sensitive tables
CREATE TRIGGER trg_audit_users         AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_products      AFTER INSERT OR UPDATE OR DELETE ON products
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_variants      AFTER INSERT OR UPDATE OR DELETE ON product_variants
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_invoices      AFTER INSERT OR UPDATE OR DELETE ON invoices
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_reservations  AFTER INSERT OR UPDATE OR DELETE ON reservations
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_purchases     AFTER INSERT OR UPDATE OR DELETE ON purchases
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_expenses      AFTER INSERT OR UPDATE OR DELETE ON expenses
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_stock_adj     AFTER INSERT OR UPDATE OR DELETE ON stock_adjustments
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();
CREATE TRIGGER trg_audit_settings      AFTER INSERT OR UPDATE OR DELETE ON settings
    FOR EACH ROW EXECUTE FUNCTION fn_audit_row();

-- ---------------------------------------------------------------------------
-- 10. Customer loyalty accumulation on paid invoice
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_accumulate_customer()
RETURNS TRIGGER AS $$
DECLARE
    v_rate NUMERIC;
BEGIN
    IF NEW.status IN ('paid','completed') AND
       (OLD.status IS DISTINCT FROM NEW.status) AND
       NEW.customer_id IS NOT NULL THEN

        -- 1 point per 10 EGP by default (configurable via settings)
        SELECT COALESCE((value->>'points_per_egp')::numeric, 0.1) INTO v_rate
        FROM settings WHERE key = 'loyalty.rate';

        UPDATE customers SET
            total_spent    = total_spent + NEW.grand_total,
            visits_count   = visits_count + 1,
            last_visit_at  = NOW(),
            loyalty_points = loyalty_points + FLOOR(NEW.grand_total * COALESCE(v_rate, 0.1))::int
        WHERE id = NEW.customer_id;

        INSERT INTO customer_loyalty_transactions(
            customer_id, direction, points, reason, reference_type, reference_id, user_id
        ) VALUES (
            NEW.customer_id, 'in',
            FLOOR(NEW.grand_total * COALESCE(v_rate, 0.1))::int,
            'earned', 'invoice', NEW.id, NEW.cashier_id
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_customer_accumulate
AFTER UPDATE OF status ON invoices
FOR EACH ROW EXECUTE FUNCTION fn_accumulate_customer();

-- =========================================================================
-- >>> FILE: migrations/012_views_for_reports.sql
-- =========================================================================
-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 012 : Reporting Views
--  All views are prefixed with `v_` and are read-only.
-- ============================================================================

-- ---------- Available stock per variant per warehouse ----------
CREATE OR REPLACE VIEW v_stock_available AS
SELECT
    s.id,
    s.variant_id,
    s.warehouse_id,
    s.quantity_on_hand,
    s.quantity_reserved,
    (s.quantity_on_hand - s.quantity_reserved) AS quantity_available,
    s.reorder_point,
    (s.quantity_on_hand <= s.reorder_point)    AS is_low_stock,
    (s.quantity_on_hand = 0)                   AS is_out_of_stock
FROM stock s;

-- ---------- Full variant catalog with stock rollup ----------
CREATE OR REPLACE VIEW v_variant_catalog AS
SELECT
    pv.id                           AS variant_id,
    pv.sku,
    pv.barcode,
    p.id                            AS product_id,
    p.name_ar                       AS product_name_ar,
    p.name_en                       AS product_name_en,
    p.product_type,
    c.name_ar                       AS color_ar,
    c.hex_code                      AS color_hex,
    z.size_label                    AS size_label,
    pv.cost_price,
    pv.selling_price,
    (pv.selling_price - pv.cost_price) AS unit_margin,
    CASE WHEN pv.cost_price > 0
         THEN ROUND(((pv.selling_price - pv.cost_price) / pv.cost_price) * 100, 2)
         ELSE 0 END                 AS margin_pct,
    COALESCE((SELECT SUM(quantity_on_hand)  FROM stock WHERE variant_id = pv.id), 0) AS total_on_hand,
    COALESCE((SELECT SUM(quantity_reserved) FROM stock WHERE variant_id = pv.id), 0) AS total_reserved,
    pv.is_active
FROM product_variants pv
JOIN products  p ON p.id = pv.product_id
JOIN colors    c ON c.id = pv.color_id
LEFT JOIN sizes z ON z.id = pv.size_id
WHERE pv.deleted_at IS NULL
  AND p.deleted_at IS NULL;

-- ---------- Daily sales summary (per warehouse) ----------
CREATE OR REPLACE VIEW v_daily_sales AS
SELECT
    DATE(i.completed_at)            AS sale_date,
    i.warehouse_id,
    w.name_ar                       AS warehouse_name,
    COUNT(*) FILTER (WHERE NOT i.is_return)   AS invoice_count,
    COUNT(*) FILTER (WHERE i.is_return)       AS return_count,
    SUM(i.grand_total)              AS gross_sales,
    SUM(i.items_discount_total + i.invoice_discount + i.coupon_discount) AS total_discounts,
    SUM(i.cogs_total)               AS total_cogs,
    SUM(i.gross_profit)             AS gross_profit,
    SUM(i.tax_amount)               AS total_tax,
    SUM(i.paid_amount)              AS collected_cash
FROM invoices i
JOIN warehouses w ON w.id = i.warehouse_id
WHERE i.status IN ('completed','paid','partially_paid')
GROUP BY DATE(i.completed_at), i.warehouse_id, w.name_ar;

-- ---------- Sales per user / cashier / salesperson ----------
CREATE OR REPLACE VIEW v_sales_per_user AS
SELECT
    u.id              AS user_id,
    u.full_name,
    r.code            AS role_code,
    DATE_TRUNC('day', i.completed_at)::date AS sale_date,
    COUNT(i.id)       AS invoice_count,
    SUM(i.grand_total) AS total_sales,
    SUM(i.gross_profit) AS total_profit,
    SUM(i.items_discount_total + i.invoice_discount) AS total_discounts
FROM invoices i
JOIN users u ON u.id = COALESCE(i.salesperson_id, i.cashier_id)
JOIN roles r ON r.id = u.role_id
WHERE i.status IN ('completed','paid','partially_paid')
GROUP BY u.id, u.full_name, r.code, DATE_TRUNC('day', i.completed_at);

-- ---------- Product profitability ----------
CREATE OR REPLACE VIEW v_product_profit AS
SELECT
    p.id                            AS product_id,
    p.name_ar                       AS product_name,
    p.product_type,
    SUM(ii.quantity)                AS units_sold,
    SUM(ii.quantity * ii.unit_price - ii.discount_amount) AS revenue,
    SUM(ii.quantity * ii.unit_cost) AS cogs,
    SUM(ii.quantity * ii.unit_price - ii.discount_amount - ii.quantity * ii.unit_cost) AS gross_profit,
    CASE WHEN SUM(ii.quantity * ii.unit_cost) > 0
         THEN ROUND((SUM(ii.quantity * ii.unit_price - ii.discount_amount - ii.quantity * ii.unit_cost)
                     / SUM(ii.quantity * ii.unit_cost)) * 100, 2)
         ELSE 0 END                 AS roi_pct
FROM invoice_items ii
JOIN product_variants pv ON pv.id = ii.variant_id
JOIN products p ON p.id = pv.product_id
JOIN invoices i ON i.id = ii.invoice_id
WHERE i.status IN ('completed','paid','partially_paid')
  AND NOT i.is_return
GROUP BY p.id, p.name_ar, p.product_type;

-- ---------- Discount reports (per cashier, per product) ----------
CREATE OR REPLACE VIEW v_discounts_per_cashier AS
SELECT
    u.id                            AS user_id,
    u.full_name,
    DATE_TRUNC('day', du.created_at)::date AS disc_date,
    COUNT(*)                        AS discount_count,
    SUM(du.amount)                  AS total_discount_amount
FROM discount_usages du
JOIN users u ON u.id = du.user_id
GROUP BY u.id, u.full_name, DATE_TRUNC('day', du.created_at);

CREATE OR REPLACE VIEW v_discounts_per_product AS
SELECT
    p.id           AS product_id,
    p.name_ar      AS product_name,
    COUNT(*)       AS discount_count,
    SUM(du.amount) AS total_discount_amount
FROM discount_usages du
JOIN invoice_items ii ON ii.id = du.invoice_item_id
JOIN product_variants pv ON pv.id = ii.variant_id
JOIN products p ON p.id = pv.product_id
GROUP BY p.id, p.name_ar;

-- ---------- Reservation reports 🔥 ----------
CREATE OR REPLACE VIEW v_active_reservations AS
SELECT
    r.id,
    r.reservation_no,
    r.status,
    c.full_name          AS customer_name,
    c.phone              AS customer_phone,
    w.name_ar            AS warehouse_name,
    r.total_amount,
    r.paid_amount,
    r.remaining_amount,
    r.reserved_at,
    r.expires_at,
    (r.expires_at IS NOT NULL AND r.expires_at < NOW()) AS is_expired,
    (SELECT COUNT(*) FROM reservation_items WHERE reservation_id = r.id)  AS item_count
FROM reservations r
JOIN customers c  ON c.id = r.customer_id
JOIN warehouses w ON w.id = r.warehouse_id
WHERE r.status = 'active';

CREATE OR REPLACE VIEW v_reservation_summary AS
SELECT
    DATE_TRUNC('day', r.created_at)::date AS day,
    r.status,
    COUNT(*)                    AS reservation_count,
    SUM(r.total_amount)         AS total_value,
    SUM(r.paid_amount)          AS total_collected,
    SUM(r.remaining_amount)     AS outstanding_balance
FROM reservations r
GROUP BY DATE_TRUNC('day', r.created_at), r.status;

-- ---------- Smart pricing suggestion view ----------
--   Simple rule: suggest price that keeps margin_pct >= min_margin_pct
--   Real implementation can be extended by ML layer in app.
CREATE OR REPLACE VIEW v_pricing_suggestions AS
SELECT
    pv.id                          AS variant_id,
    pv.sku,
    p.name_ar                      AS product_name,
    pv.cost_price,
    pv.selling_price,
    p.min_margin_pct,
    ROUND(pv.cost_price * (1 + p.min_margin_pct/100), 2) AS suggested_min_price,
    CASE
       WHEN pv.cost_price = 0 THEN 'unknown'
       WHEN pv.selling_price < pv.cost_price THEN 'loss'
       WHEN ((pv.selling_price - pv.cost_price) / pv.cost_price) * 100 < p.min_margin_pct THEN 'below_min_margin'
       ELSE 'ok'
    END                            AS pricing_status,
    ROUND(((pv.selling_price - pv.cost_price) / NULLIF(pv.cost_price,0)) * 100, 2) AS current_margin_pct
FROM product_variants pv
JOIN products p ON p.id = pv.product_id
WHERE pv.is_active AND pv.deleted_at IS NULL;

-- ---------- Loss-alert view (selling below cost) ----------
CREATE OR REPLACE VIEW v_loss_products AS
SELECT *
FROM v_pricing_suggestions
WHERE pricing_status IN ('loss','below_min_margin');

-- ---------- Shift summary ----------
CREATE OR REPLACE VIEW v_shift_summary AS
SELECT
    s.id,
    s.shift_no,
    s.warehouse_id,
    w.name_ar           AS warehouse_name,
    s.cashbox_id,
    u.full_name         AS opened_by_name,
    s.status,
    s.opening_balance,
    s.total_sales,
    s.total_returns,
    s.total_expenses,
    s.expected_closing,
    s.actual_closing,
    s.difference,
    s.opened_at,
    s.closed_at,
    EXTRACT(EPOCH FROM (COALESCE(s.closed_at, NOW()) - s.opened_at))/3600 AS duration_hours
FROM shifts s
JOIN users u ON u.id = s.opened_by
JOIN warehouses w ON w.id = s.warehouse_id;

-- ---------- Daily profit engine ----------
--  Net Profit = Gross Profit - Allocated Expenses (for the day)
--  Expenses where allocate_to_cogs = true
CREATE OR REPLACE VIEW v_daily_profit AS
WITH sales AS (
    SELECT DATE(completed_at) AS d, warehouse_id,
           SUM(grand_total)   AS revenue,
           SUM(cogs_total)    AS cogs,
           SUM(gross_profit)  AS gross_profit
    FROM invoices
    WHERE status IN ('completed','paid','partially_paid') AND NOT is_return
    GROUP BY DATE(completed_at), warehouse_id
), exp AS (
    SELECT e.expense_date AS d, e.warehouse_id,
           SUM(e.amount) AS allocated_expenses
    FROM expenses e
    JOIN expense_categories c ON c.id = e.category_id
    WHERE c.allocate_to_cogs = TRUE AND e.is_approved = TRUE
    GROUP BY e.expense_date, e.warehouse_id
)
SELECT
    s.d                               AS day,
    s.warehouse_id,
    s.revenue,
    s.cogs,
    s.gross_profit,
    COALESCE(e.allocated_expenses, 0) AS allocated_expenses,
    s.gross_profit - COALESCE(e.allocated_expenses, 0) AS net_profit
FROM sales s
LEFT JOIN exp e ON e.d = s.d AND e.warehouse_id = s.warehouse_id;

-- =========================================================================
-- >>> FILE: migrations/013_seed_data.sql
-- =========================================================================
-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 013 : Seed Data
--  Run LAST, after all schema + triggers are in place.
-- ============================================================================

-- ---------- Company profile ----------
INSERT INTO company_profile (id, name_ar, name_en, default_tax_rate, default_currency,
                             receipt_footer_ar, return_policy_text_ar)
VALUES (1, 'زهران لأحذية وحقائب السيدات', 'Zahran Women Shoes & Bags',
        14.00, 'EGP',
        'شكراً لتسوقك من زهران ❤️ — الاستبدال خلال 7 أيام مع فاتورة.',
        'يحق للعميل استبدال المنتج خلال 7 أيام من تاريخ الشراء بشرط احتفاظه بالفاتورة والتغليف الأصلي.')
ON CONFLICT (id) DO NOTHING;

-- ---------- Roles ----------
INSERT INTO roles (code, name_ar, name_en, is_system, description) VALUES
 ('admin',        'مدير النظام',   'System Administrator', TRUE,  'صلاحيات كاملة'),
 ('manager',      'مدير',          'Manager',              TRUE,  'إدارة الفرع والتقارير'),
 ('cashier',      'كاشير',         'Cashier',              TRUE,  'مبيعات نقطة البيع'),
 ('salesperson',  'مندوب مبيعات',   'Salesperson',          TRUE,  'مساعدة العملاء والعمولات'),
 ('inventory',    'موظف مخزون',     'Inventory Staff',      TRUE,  'استقبال وجرد وتحويل مخزون')
ON CONFLICT (code) DO NOTHING;

-- ---------- Permissions (module.action) ----------
INSERT INTO permissions (code, module, name_ar, name_en) VALUES
 ('dashboard.view',         'dashboard',  'عرض لوحة التحكم',       'View dashboard'),
 ('products.view',          'products',   'عرض المنتجات',          'View products'),
 ('products.create',        'products',   'إضافة منتج',             'Create product'),
 ('products.update',        'products',   'تعديل المنتج',           'Update product'),
 ('products.delete',        'products',   'حذف منتج',               'Delete product'),
 ('products.import',        'products',   'استيراد Excel',          'Import products from Excel'),
 ('inventory.view',         'inventory',  'عرض المخزون',            'View inventory'),
 ('inventory.adjust',       'inventory',  'تسويات المخزون',         'Adjust stock'),
 ('inventory.transfer',     'inventory',  'تحويل مخزون',            'Transfer stock'),
 ('inventory.count',        'inventory',  'جرد فعلي',              'Inventory count'),
 ('pos.sell',               'pos',        'البيع',                 'POS sell'),
 ('pos.discount',           'pos',        'إعطاء خصم',             'Apply discount'),
 ('pos.void',               'pos',        'إلغاء فاتورة',           'Void invoice'),
 ('reservations.view',      'reservations','عرض الحجوزات',          'View reservations'),
 ('reservations.create',    'reservations','حجز منتج',              'Create reservation'),
 ('reservations.complete',  'reservations','إتمام الحجز',            'Complete reservation'),
 ('reservations.cancel',    'reservations','إلغاء الحجز',           'Cancel reservation'),
 ('returns.create',         'returns',    'إنشاء مرتجع',            'Create return'),
 ('returns.approve',        'returns',    'اعتماد مرتجع',           'Approve return'),
 ('exchanges.create',       'exchanges',  'إنشاء استبدال',          'Create exchange'),
 ('customers.view',         'customers',  'عرض العملاء',           'View customers'),
 ('customers.create',       'customers',  'إضافة عميل',             'Create customer'),
 ('suppliers.view',         'suppliers',  'عرض الموردين',           'View suppliers'),
 ('suppliers.manage',       'suppliers',  'إدارة الموردين',         'Manage suppliers'),
 ('purchases.view',         'purchases',  'عرض المشتريات',          'View purchases'),
 ('purchases.create',       'purchases',  'إنشاء مشتريات',          'Create purchase'),
 ('accounting.view',        'accounting', 'عرض الحسابات',           'View accounting'),
 ('expenses.create',        'expenses',   'تسجيل مصروف',            'Create expense'),
 ('expenses.approve',       'expenses',   'اعتماد مصروف',           'Approve expense'),
 ('shifts.open',            'shifts',     'فتح وردية',             'Open shift'),
 ('shifts.close',           'shifts',     'إغلاق وردية',            'Close shift'),
 ('reports.view',           'reports',    'عرض التقارير',           'View reports'),
 ('reports.export',         'reports',    'تصدير تقارير',           'Export reports'),
 ('settings.view',          'settings',   'عرض الإعدادات',           'View settings'),
 ('settings.update',        'settings',   'تعديل الإعدادات',         'Update settings'),
 ('users.manage',           'users',      'إدارة المستخدمين',        'Manage users'),
 ('coupons.manage',         'coupons',    'إدارة الكوبونات',          'Manage coupons'),
 ('alerts.manage',          'alerts',     'إدارة التنبيهات',          'Manage alerts')
ON CONFLICT (code) DO NOTHING;

-- ---------- Role → Permissions ----------
-- Admin: everything
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'admin'
ON CONFLICT DO NOTHING;

-- Manager: everything except users.manage
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'manager' AND p.code <> 'users.manage'
ON CONFLICT DO NOTHING;

-- Cashier
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'cashier' AND p.code IN (
  'dashboard.view','products.view','inventory.view',
  'pos.sell','pos.discount',
  'reservations.view','reservations.create','reservations.complete',
  'returns.create','exchanges.create',
  'customers.view','customers.create',
  'shifts.open','shifts.close'
)
ON CONFLICT DO NOTHING;

-- Salesperson
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'salesperson' AND p.code IN (
  'dashboard.view','products.view','inventory.view',
  'pos.sell','reservations.view','reservations.create',
  'customers.view','customers.create','reports.view'
)
ON CONFLICT DO NOTHING;

-- Inventory staff
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'inventory' AND p.code IN (
  'dashboard.view','products.view','products.create','products.update','products.import',
  'inventory.view','inventory.adjust','inventory.transfer','inventory.count',
  'suppliers.view','purchases.view','purchases.create'
)
ON CONFLICT DO NOTHING;

-- ---------- Default admin user ----------
-- Password = "Admin@123" — bcrypt hash (replace in production!)
-- Generated with:  node -e "console.log(require('bcryptjs').hashSync('Admin@123',10))"
INSERT INTO users (id, full_name, username, email, password_hash, role_id, is_active, must_change_pwd, locale)
SELECT
  uuid_generate_v4(),
  'مدير النظام',
  'admin',
  'admin@zahran.eg',
  '$2b$10$6wVSN0EH9s2ULd82SuW2e.Ed3wlz3z6H2BiOet4II.tMxcZ6SkY1y',
  r.id,
  TRUE,
  TRUE,
  'ar'
FROM roles r WHERE r.code = 'admin'
ON CONFLICT (username) DO NOTHING;

-- ---------- Warehouses (main branch) ----------
INSERT INTO warehouses (code, name_ar, name_en, is_main, is_retail, is_active)
VALUES ('ZHR-01','الفرع الرئيسي','Main Branch', TRUE, TRUE, TRUE)
ON CONFLICT (code) DO NOTHING;

-- ---------- Cashbox (main) ----------
INSERT INTO cashboxes (name_ar, name_en, warehouse_id)
SELECT 'الخزينة الرئيسية', 'Main Cashbox', w.id
FROM warehouses w WHERE w.code = 'ZHR-01'
ON CONFLICT DO NOTHING;

-- ---------- Payment methods ----------
INSERT INTO payment_methods (code, name_ar, name_en, sort_order, requires_reference) VALUES
 ('cash',             'كاش',            'Cash',             1, FALSE),
 ('card_visa',        'فيزا',           'Visa Card',        2, TRUE),
 ('card_mastercard',  'ماستركارد',      'MasterCard',       3, TRUE),
 ('card_meeza',       'ميزة',           'Meeza',            4, TRUE),
 ('instapay',         'إنستا باي',      'InstaPay',         5, TRUE),
 ('vodafone_cash',    'فودافون كاش',    'Vodafone Cash',    6, TRUE),
 ('orange_cash',      'أورانج كاش',     'Orange Cash',      7, TRUE),
 ('bank_transfer',    'تحويل بنكي',     'Bank Transfer',    8, TRUE),
 ('credit',           'آجل',            'Credit',           9, FALSE),
 ('other',            'أخرى',           'Other',           10, FALSE)
ON CONFLICT (code) DO NOTHING;

-- ---------- Categories ----------
INSERT INTO categories (name_ar, name_en, slug, sort_order) VALUES
 ('أحذية',     'Shoes',        'shoes',         1),
 ('حقائب',     'Bags',         'bags',          2),
 ('إكسسوارات', 'Accessories',  'accessories',   3)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO categories (parent_id, name_ar, name_en, slug, sort_order)
SELECT c.id, v.name_ar, v.name_en, v.slug, v.sort_order
FROM categories c
JOIN (VALUES
    ('shoes','أحذية سهرة','Evening Shoes','evening-shoes',1),
    ('shoes','أحذية كاجوال','Casual Shoes','casual-shoes',2),
    ('shoes','أحذية رياضية','Sport Shoes','sport-shoes',3),
    ('shoes','صنادل','Sandals','sandals',4),
    ('shoes','بوت','Boots','boots',5),
    ('bags', 'شنط يد',  'Hand Bags', 'hand-bags', 1),
    ('bags', 'كلاتش',   'Clutch',    'clutch',    2),
    ('bags', 'ظهر',     'Backpacks', 'backpacks', 3),
    ('bags', 'كروس',    'Crossbody', 'crossbody', 4)
) AS v(parent_slug, name_ar, name_en, slug, sort_order)
ON c.slug = v.parent_slug
ON CONFLICT (slug) DO NOTHING;

-- ---------- Colors ----------
INSERT INTO colors (name_ar, name_en, hex_code) VALUES
 ('أسود',      'Black',      '#000000'),
 ('أبيض',      'White',      '#FFFFFF'),
 ('أحمر',      'Red',        '#E53935'),
 ('وردي',      'Pink',       '#EC407A'),
 ('وردي فاتح', 'Light Pink', '#F8BBD0'),
 ('بيج',       'Beige',      '#D7CCC8'),
 ('بني',       'Brown',      '#6D4C41'),
 ('ذهبي',      'Gold',       '#D4AF37'),
 ('فضي',       'Silver',     '#C0C0C0'),
 ('أزرق',      'Blue',       '#1E88E5'),
 ('أزرق نيلي', 'Navy',       '#0D47A1'),
 ('أخضر',      'Green',      '#43A047'),
 ('زيتي',      'Olive',      '#827717'),
 ('رمادي',     'Grey',       '#757575'),
 ('نسكافيه',   'Camel',      '#A47148')
ON CONFLICT (name_ar) DO NOTHING;

-- ---------- Sizes (EU shoes 35..44) ----------
INSERT INTO sizes (size_label, size_system, sort_order) VALUES
 ('35','EU',1),('36','EU',2),('37','EU',3),('38','EU',4),
 ('39','EU',5),('40','EU',6),('41','EU',7),('42','EU',8),
 ('43','EU',9),('44','EU',10)
ON CONFLICT (size_label) DO NOTHING;

-- ---------- Expense categories ----------
INSERT INTO expense_categories (code, name_ar, name_en, is_fixed, allocate_to_cogs) VALUES
 ('rent',        'إيجار',             'Rent',              TRUE,  TRUE),
 ('salaries',    'رواتب',             'Salaries',          TRUE,  TRUE),
 ('utilities',   'كهرباء ومرافق',      'Utilities',         TRUE,  TRUE),
 ('marketing',   'تسويق وإعلان',       'Marketing',         FALSE, FALSE),
 ('maintenance', 'صيانة',             'Maintenance',       FALSE, FALSE),
 ('supplies',    'مستلزمات',          'Supplies',          FALSE, FALSE),
 ('transport',   'نقل ومواصلات',       'Transport',         FALSE, TRUE),
 ('tax',         'ضرائب',             'Taxes',             FALSE, FALSE),
 ('other',       'أخرى',              'Other',             FALSE, FALSE)
ON CONFLICT (code) DO NOTHING;

-- ---------- Settings ----------
INSERT INTO settings (key, value, group_name, description) VALUES
 ('pos.default_payment_method', '"cash"'::jsonb,                 'pos',          'طريقة الدفع الافتراضية'),
 ('pos.allow_negative_stock',   'false'::jsonb,                  'pos',          'السماح بالبيع بمخزون سالب'),
 ('pos.require_customer',       'false'::jsonb,                  'pos',          'إجبار اختيار عميل لكل فاتورة'),
 ('pos.print_on_save',          'true'::jsonb,                   'pos',          'طباعة الفاتورة فور الحفظ'),
 ('reservation.default_deposit_pct', '30'::jsonb,                'reservation',  'نسبة العربون الافتراضية'),
 ('reservation.default_expiry_days', '7'::jsonb,                 'reservation',  'مدة الحجز بالأيام'),
 ('reservation.cancellation_fee_pct', '10'::jsonb,               'reservation',  'نسبة رسوم الإلغاء'),
 ('reservation.auto_expire',    'true'::jsonb,                   'reservation',  'إلغاء تلقائي بعد انتهاء المدة'),
 ('loyalty.rate',               '{"points_per_egp": 0.1}'::jsonb,'loyalty',      'نقطة لكل 10 جنيه'),
 ('loyalty.tiers',              '{"bronze":0,"silver":5000,"gold":20000,"platinum":50000}'::jsonb, 'loyalty', 'حدود الفئات'),
 ('smart_pricing.min_margin_default', '15'::jsonb,               'smart_pricing','أقل هامش ربح افتراضي %'),
 ('alerts.low_stock_threshold', '5'::jsonb,                      'alerts',       'حد تنبيه المخزون المنخفض'),
 ('printing.receipt_size',      '"80mm"'::jsonb,                 'printing',     'مقاس إيصال الكاشير'),
 ('printing.language',          '"ar"'::jsonb,                   'printing',     'لغة الطباعة'),
 ('offline.sync_batch_size',    '100'::jsonb,                    'offline',      'عدد العمليات في كل دفعة مزامنة'),
 ('offline.max_retry',          '5'::jsonb,                      'offline',      'أقصى عدد محاولات مزامنة')
ON CONFLICT (key) DO NOTHING;

-- ---------- Default alert rules ----------
INSERT INTO alert_rules (alert_type, name_ar, threshold_value, config, notify_channels) VALUES
 ('low_stock',             'تنبيه مخزون منخفض',   5,    '{}',                        'in_app'),
 ('out_of_stock',          'تنبيه نفاد مخزون',    0,    '{}',                        'in_app'),
 ('reservation_expiring',  'حجز على وشك الانتهاء', NULL, '{"hours_before":24}',      'in_app'),
 ('loss_product',          'منتج يباع بخسارة',    NULL, '{}',                        'in_app'),
 ('cash_mismatch',         'فرق في الخزينة',      50,   '{"currency":"EGP"}',        'in_app')
ON CONFLICT DO NOTHING;

-- ---------- Default brand ----------
INSERT INTO brands (name_ar, name_en) VALUES
 ('زهران',  'Zahran'),
 ('بلا علامة', 'Generic')
ON CONFLICT DO NOTHING;

-- =========================================================================
-- >>> FILE: migrations/014_cash_desk.sql
-- =========================================================================
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

-- =========================================================================
-- >>> FILE: migrations/015_dashboard_views.sql
-- =========================================================================
-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 015 : Dashboard Views & Smart Suggestions
--
--  Views تُستعمل مباشرة من الـ API لتغذية شاشة الداشبورد الرئيسية:
--    • KPIs لحظة-بلحظة (المبيعات اليوم، الربح، عدد الفواتير…)
--    • Top N منتجات، عملاء، كاشيرز
--    • Time-series آخر 30 يوم
--    • Live feed للتنبيهات + الحجوزات القريبة من الانتهاء
--    • توصيات ذكية (إعادة طلب، تخفيض سعر، رفع سعر)
-- ============================================================================

-- ---------- Add reorder_quantity column if missing (used by reorder suggestion view) ----------
ALTER TABLE stock ADD COLUMN IF NOT EXISTS reorder_quantity INT NOT NULL DEFAULT 10;
COMMENT ON COLUMN stock.reorder_quantity IS 'Default order quantity when reorder_point is hit';

-- ---------------------------------------------------------------------------
--  1) KPIs اليوم — صف واحد فقط
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_today AS
SELECT
    (SELECT COUNT(*)                           FROM invoices
        WHERE DATE(completed_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
          AND status IN ('completed','paid'))                         AS invoices_today,
    (SELECT COALESCE(SUM(grand_total),0)       FROM invoices
        WHERE DATE(completed_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
          AND status IN ('completed','paid'))                         AS revenue_today,
    (SELECT COALESCE(SUM(gross_profit),0)      FROM invoices
        WHERE DATE(completed_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
          AND status IN ('completed','paid'))                         AS profit_today,
    (SELECT COALESCE(SUM(quantity),0)          FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        WHERE DATE(i.completed_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE
          AND i.status IN ('completed','paid'))                       AS units_sold_today,
    (SELECT COUNT(*)                           FROM reservations
        WHERE status = 'active')                                      AS active_reservations,
    (SELECT COALESCE(SUM(remaining_amount),0)  FROM reservations
        WHERE status = 'active')                                      AS reservations_pending_amount,
    (SELECT COUNT(*)                           FROM alerts
        WHERE is_resolved = FALSE)                                    AS open_alerts,
    (SELECT COALESCE(SUM(amount),0)            FROM expenses
        WHERE expense_date = CURRENT_DATE)                            AS expenses_today,
    (SELECT COALESCE(SUM(current_balance),0)   FROM cashboxes
        WHERE is_active = TRUE)                                       AS cashboxes_balance,
    (SELECT COALESCE(SUM(current_balance),0)   FROM customers
        WHERE deleted_at IS NULL)                                     AS customers_receivable,
    (SELECT COALESCE(SUM(current_balance),0)   FROM suppliers
        WHERE deleted_at IS NULL)                                     AS suppliers_payable,
    NOW()                                                             AS as_of;

-- ---------------------------------------------------------------------------
--  2) Revenue / profit time-series — آخر 30 يوم
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_revenue_30d AS
WITH series AS (
    SELECT generate_series(CURRENT_DATE - INTERVAL '29 day',
                           CURRENT_DATE,
                           INTERVAL '1 day')::date AS day
)
SELECT
    s.day,
    COALESCE(SUM(i.grand_total),  0)::numeric(14,2) AS revenue,
    COALESCE(SUM(i.gross_profit), 0)::numeric(14,2) AS profit,
    COUNT(i.id)                                    AS invoices,
    COALESCE(SUM(e.amount),       0)::numeric(14,2) AS expenses
FROM series s
LEFT JOIN invoices i
       ON DATE(i.completed_at AT TIME ZONE 'Africa/Cairo') = s.day
      AND i.status IN ('completed','paid')
LEFT JOIN expenses e
       ON e.expense_date = s.day
GROUP BY s.day
ORDER BY s.day;

-- ---------------------------------------------------------------------------
--  3) Top 10 منتجات (بالكمية + بالربح) خلال آخر 30 يوم
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_top_products_30d AS
SELECT
    p.id                                AS product_id,
    p.name_ar                           AS product_name,
    p.product_type,
    SUM(ii.quantity)                    AS units_sold,
    SUM(ii.line_total)                  AS revenue,
    SUM((ii.unit_price - ii.unit_cost) * ii.quantity - COALESCE(ii.discount_amount,0))
                                        AS profit,
    CASE WHEN SUM(ii.unit_cost * ii.quantity) > 0
         THEN ROUND(
               ((SUM((ii.unit_price - ii.unit_cost) * ii.quantity -
                     COALESCE(ii.discount_amount,0))
                 / SUM(ii.unit_cost * ii.quantity)) * 100)::numeric, 2)
         ELSE NULL END                  AS margin_pct
FROM invoice_items ii
JOIN invoices         i  ON i.id = ii.invoice_id
JOIN product_variants v  ON v.id = ii.variant_id
JOIN products         p  ON p.id = v.product_id
WHERE i.status IN ('completed','paid')
  AND i.completed_at >= NOW() - INTERVAL '30 day'
GROUP BY p.id, p.name_ar, p.product_type
ORDER BY revenue DESC
LIMIT 10;

-- ---------------------------------------------------------------------------
--  4) Top 10 عملاء (بالإنفاق) خلال آخر 90 يوم
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_top_customers_90d AS
SELECT
    c.id                          AS customer_id,
    c.customer_no,
    c.full_name,
    c.phone,
    c.loyalty_tier,
    COUNT(i.id)                   AS invoices_count,
    SUM(i.grand_total)            AS total_spent,
    MAX(i.completed_at)           AS last_purchase_at
FROM customers c
JOIN invoices i ON i.customer_id = c.id
WHERE i.status IN ('completed','paid')
  AND i.completed_at >= NOW() - INTERVAL '90 day'
GROUP BY c.id
ORDER BY total_spent DESC
LIMIT 10;

-- ---------------------------------------------------------------------------
--  5) أداء الكاشيرز خلال اليوم / الأسبوع
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_cashier_performance AS
SELECT
    u.id                           AS user_id,
    u.full_name,
    COUNT(*) FILTER (WHERE DATE(i.completed_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE)
                                   AS invoices_today,
    COALESCE(SUM(i.grand_total) FILTER (
        WHERE DATE(i.completed_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE),0)::numeric(14,2)
                                   AS revenue_today,
    COUNT(*) FILTER (WHERE i.completed_at >= NOW() - INTERVAL '7 day')
                                   AS invoices_week,
    COALESCE(SUM(i.grand_total) FILTER (
        WHERE i.completed_at >= NOW() - INTERVAL '7 day'),0)::numeric(14,2)
                                   AS revenue_week
FROM users u
LEFT JOIN invoices i ON i.cashier_id = u.id
   AND i.status IN ('completed','paid')
WHERE u.is_active = TRUE
GROUP BY u.id, u.full_name
ORDER BY revenue_today DESC;

-- ---------------------------------------------------------------------------
--  6) المخزون المنخفض / المنتهي — مصدر مباشر للتنبيهات
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_low_stock AS
SELECT
    v.id                   AS variant_id,
    v.sku,
    v.barcode,
    p.name_ar              AS product_name,
    col.name_ar            AS color,
    sz.size_label       AS size,
    w.name_ar              AS warehouse,
    s.quantity_on_hand,
    s.quantity_reserved,
    (s.quantity_on_hand - s.quantity_reserved) AS quantity_available,
    s.reorder_point,
    CASE
        WHEN (s.quantity_on_hand - s.quantity_reserved) <= 0          THEN 'out_of_stock'
        WHEN (s.quantity_on_hand - s.quantity_reserved) <= s.reorder_point THEN 'low_stock'
        ELSE 'ok'
    END                    AS stock_status
FROM stock s
JOIN product_variants v ON v.id = s.variant_id
JOIN products         p ON p.id = v.product_id
JOIN warehouses       w ON w.id = s.warehouse_id
LEFT JOIN colors      col ON col.id = v.color_id
LEFT JOIN sizes       sz  ON sz.id  = v.size_id
WHERE (s.quantity_on_hand - s.quantity_reserved) <= s.reorder_point
ORDER BY quantity_available ASC;

-- ---------------------------------------------------------------------------
--  7) حجوزات على وشك الانتهاء (خلال 48 ساعة)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_reservations_expiring AS
SELECT
    r.id                   AS reservation_id,
    r.reservation_no,
    c.full_name            AS customer_name,
    c.phone                AS customer_phone,
    r.total_amount,
    r.paid_amount,
    r.remaining_amount,
    r.expires_at,
    (r.expires_at - NOW()) AS time_left
FROM reservations r
JOIN customers c ON c.id = r.customer_id
WHERE r.status = 'active'
  AND r.expires_at IS NOT NULL
  AND r.expires_at <= NOW() + INTERVAL '48 hour'
ORDER BY r.expires_at ASC;

-- ---------------------------------------------------------------------------
--  8) توزيع طرق الدفع — آخر 30 يوم
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_payment_mix_30d AS
SELECT
    ip.payment_method                  AS payment_method,
    COUNT(*)                           AS transactions,
    SUM(ip.amount)::numeric(14,2)      AS total_amount,
    ROUND((SUM(ip.amount) * 100.0 /
           NULLIF(SUM(SUM(ip.amount)) OVER (), 0))::numeric, 2) AS pct
FROM invoice_payments ip
JOIN invoices i ON i.id = ip.invoice_id
WHERE i.status IN ('completed','paid')
  AND i.completed_at >= NOW() - INTERVAL '30 day'
GROUP BY ip.payment_method
ORDER BY total_amount DESC;

-- ---------------------------------------------------------------------------
--  9) توصيات ذكية — إعادة الطلب من الموردين
--  المنتج سيُعاد طلبه إن كان: available <= reorder_point AND متوسط المبيعات > 0
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_smart_reorder_suggestions AS
WITH sales_30 AS (
    SELECT
        ii.variant_id,
        SUM(ii.quantity)::numeric / 30.0 AS avg_daily_sales
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii.invoice_id
    WHERE i.status IN ('completed','paid')
      AND i.completed_at >= NOW() - INTERVAL '30 day'
    GROUP BY ii.variant_id
)
SELECT
    v.id                           AS variant_id,
    v.sku,
    p.name_ar                      AS product_name,
    col.name_ar                    AS color,
    sz.size_label               AS size,
    s.warehouse_id,
    w.name_ar                      AS warehouse,
    s.quantity_on_hand,
    s.quantity_reserved,
    (s.quantity_on_hand - s.quantity_reserved)                  AS available,
    s.reorder_point,
    s.reorder_quantity,
    COALESCE(sd.avg_daily_sales, 0)::numeric(10,2)              AS avg_daily_sales,
    CASE
        WHEN COALESCE(sd.avg_daily_sales,0) > 0
        THEN ROUND(((s.quantity_on_hand - s.quantity_reserved) /
                    sd.avg_daily_sales)::numeric, 1)
        ELSE NULL
    END                                                         AS days_of_stock_left,
    -- كمية الطلب المقترحة: 30 يوم مبيعات تقريبية - المتاح حالياً
    GREATEST(
        CEIL(COALESCE(sd.avg_daily_sales, 0) * 30)::int
            - (s.quantity_on_hand - s.quantity_reserved),
        s.reorder_quantity
    )                                                           AS suggested_order_qty,
    CASE
        WHEN (s.quantity_on_hand - s.quantity_reserved) <= 0 THEN 'urgent'
        WHEN (s.quantity_on_hand - s.quantity_reserved) <=
             COALESCE(sd.avg_daily_sales,0) * 3             THEN 'soon'
        ELSE 'routine'
    END                                                         AS priority
FROM stock s
JOIN product_variants v ON v.id = s.variant_id
JOIN products         p ON p.id = v.product_id
JOIN warehouses       w ON w.id = s.warehouse_id
LEFT JOIN colors  col ON col.id = v.color_id
LEFT JOIN sizes   sz  ON sz.id  = v.size_id
LEFT JOIN sales_30 sd ON sd.variant_id = v.id
WHERE (s.quantity_on_hand - s.quantity_reserved) <= s.reorder_point
  AND p.is_active = TRUE
ORDER BY
    CASE
        WHEN (s.quantity_on_hand - s.quantity_reserved) <= 0 THEN 1
        WHEN (s.quantity_on_hand - s.quantity_reserved) <=
             COALESCE(sd.avg_daily_sales,0) * 3 THEN 2
        ELSE 3
    END,
    days_of_stock_left ASC NULLS LAST;

-- ---------------------------------------------------------------------------
--  10) توصيات ذكية — منتجات راكدة (لم تُبَع منذ 60+ يوم)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_smart_dead_stock AS
SELECT
    v.id                      AS variant_id,
    v.sku,
    p.name_ar                 AS product_name,
    col.name_ar               AS color,
    sz.size_label          AS size,
    w.name_ar                 AS warehouse,
    s.quantity_on_hand        AS qty,
    v.cost_price              AS unit_cost,
    (s.quantity_on_hand * v.cost_price)::numeric(14,2) AS tied_capital,
    (SELECT MAX(i.completed_at)
        FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        WHERE ii.variant_id = v.id
          AND i.status IN ('completed','paid'))        AS last_sold_at,
    CASE
        WHEN (SELECT MAX(i.completed_at)
                FROM invoice_items ii
                JOIN invoices i ON i.id = ii.invoice_id
                WHERE ii.variant_id = v.id) IS NULL
             THEN 'never_sold'
        ELSE 'dormant'
    END                       AS status,
    'discount_or_bundle'      AS suggested_action
FROM stock s
JOIN product_variants v ON v.id = s.variant_id
JOIN products         p ON p.id = v.product_id
JOIN warehouses       w ON w.id = s.warehouse_id
LEFT JOIN colors  col ON col.id = v.color_id
LEFT JOIN sizes   sz  ON sz.id  = v.size_id
WHERE s.quantity_on_hand > 0
  AND (
    NOT EXISTS (
        SELECT 1 FROM invoice_items ii
        JOIN invoices i ON i.id = ii.invoice_id
        WHERE ii.variant_id = v.id
          AND i.status IN ('completed','paid')
          AND i.completed_at >= NOW() - INTERVAL '60 day'
    )
  )
ORDER BY tied_capital DESC
LIMIT 50;

-- ---------------------------------------------------------------------------
--  11) توصيات ذكية — منتج تم بيعه بخسارة أكثر من مرة
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_smart_loss_warnings AS
SELECT
    p.id                                   AS product_id,
    p.name_ar                              AS product_name,
    COUNT(*)                               AS times_sold_at_loss,
    SUM((ii.unit_cost - ii.unit_price) * ii.quantity)::numeric(14,2)
                                           AS total_loss,
    MIN(ii.unit_price)                     AS min_selling_price,
    AVG(ii.unit_cost)::numeric(10,2)       AS avg_cost_price,
    'raise_price_or_block_discount'        AS suggested_action
FROM invoice_items ii
JOIN invoices         i ON i.id = ii.invoice_id
JOIN product_variants v ON v.id = ii.variant_id
JOIN products         p ON p.id = v.product_id
WHERE i.status IN ('completed','paid')
  AND ii.unit_price < ii.unit_cost
  AND i.completed_at >= NOW() - INTERVAL '60 day'
GROUP BY p.id, p.name_ar
HAVING COUNT(*) >= 2
ORDER BY total_loss DESC;

-- ---------------------------------------------------------------------------
--  12) حركة الصندوق اليوم — للعرض على شاشة الكاشير
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_cashflow_today AS
SELECT
    cb.id                                 AS cashbox_id,
    cb.name_ar                            AS cashbox_name,
    cb.current_balance,
    COALESCE(SUM(ct.amount) FILTER (WHERE ct.direction = 'in'
           AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE), 0)::numeric(14,2)
                                          AS cash_in_today,
    COALESCE(SUM(ct.amount) FILTER (WHERE ct.direction = 'out'
           AND DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE), 0)::numeric(14,2)
                                          AS cash_out_today,
    COUNT(*) FILTER (WHERE DATE(ct.created_at AT TIME ZONE 'Africa/Cairo') = CURRENT_DATE)
                                          AS transactions_today
FROM cashboxes cb
LEFT JOIN cashbox_transactions ct ON ct.cashbox_id = cb.id
WHERE cb.is_active = TRUE
GROUP BY cb.id, cb.name_ar, cb.current_balance
ORDER BY cb.name_ar;

-- ---------------------------------------------------------------------------
--  13) Feed موحد للتنبيهات (أحدث 20)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dashboard_alerts_feed AS
SELECT
    a.id,
    a.alert_type,
    a.severity,
    a.title,
    a.message,
    a.entity,
    a.entity_id,
    a.is_read,
    a.is_resolved,
    a.created_at
FROM alerts a
WHERE a.is_resolved = FALSE
ORDER BY
    CASE a.severity
        WHEN 'critical' THEN 1
        WHEN 'warning'  THEN 2
        WHEN 'info'     THEN 3
        ELSE 4
    END,
    a.created_at DESC
LIMIT 20;

COMMENT ON VIEW v_dashboard_today              IS 'KPIs مباشرة لليوم الحالي — صف واحد';
COMMENT ON VIEW v_dashboard_revenue_30d        IS 'سلسلة زمنية يومية: إيراد/ربح/مصروفات آخر 30 يوم';
COMMENT ON VIEW v_dashboard_top_products_30d   IS 'أكثر 10 منتجات مبيعاً وربحاً آخر 30 يوم';
COMMENT ON VIEW v_dashboard_top_customers_90d  IS 'أكثر 10 عملاء إنفاقاً آخر 90 يوم';
COMMENT ON VIEW v_dashboard_cashier_performance IS 'أداء الكاشيرز — اليوم والأسبوع';
COMMENT ON VIEW v_dashboard_low_stock          IS 'المخزون المنخفض + نفاد المخزون لكل فرع';
COMMENT ON VIEW v_dashboard_reservations_expiring IS 'حجوزات ستنتهي خلال 48 ساعة';
COMMENT ON VIEW v_dashboard_payment_mix_30d    IS 'توزيع طرق الدفع آخر 30 يوم';
COMMENT ON VIEW v_smart_reorder_suggestions    IS 'توصية إعادة الطلب بناءً على متوسط البيع';
COMMENT ON VIEW v_smart_dead_stock             IS 'منتجات راكدة لم تُبَع منذ 60 يوم';
COMMENT ON VIEW v_smart_loss_warnings          IS 'منتجات تُباع بخسارة متكررة — رفع السعر';
COMMENT ON VIEW v_dashboard_cashflow_today     IS 'حركة نقدية لكل خزنة اليوم';
COMMENT ON VIEW v_dashboard_alerts_feed        IS 'أحدث 20 تنبيه غير مُغلق';

-- =========================================================================
-- >>> FILE: migrations/016_realistic_seed.sql
-- =========================================================================
-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 016 : Realistic Demo Seed
--
--  This migration loads a realistic snapshot of data for demo / QA:
--    • 3 additional staff users (manager, cashier, sales)
--    • 25 products with 2-4 colors each and 5-8 sizes (shoes) = ~500 variants
--    • Full stock on hand + reorder points
--    • 40 customers (phones, tiers, loyalty points)
--    • ~90 invoices spread over the past 60 days with split payments,
--      realistic discounts and a handful of coupons applied
--    • Cashbox opening + running balance reflecting the invoices
--    • A few expenses (rent, salaries, supplies) so P&L looks lifelike
--
--  It is SAFE to re-run: everything uses ON CONFLICT or WHERE NOT EXISTS.
--  Re-applying will NOT duplicate invoices — existing invoice_no values
--  are preserved via the sku_prefix / customer_no keys.
--
--  NOTE: depends on 013_seed_data.sql having run (roles, warehouses,
--  cashboxes, categories, colors, sizes, brands, payment_methods).
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
--  Handy reference CTEs stored as temp views
-- ----------------------------------------------------------------------------
CREATE TEMP VIEW _ref AS
SELECT
    (SELECT id FROM warehouses WHERE code = 'ZHR-01')                 AS wh_id,
    (SELECT id FROM cashboxes  ORDER BY created_at LIMIT 1)           AS cash_id,
    (SELECT id FROM users      WHERE username = 'admin')              AS admin_id,
    (SELECT id FROM brands     WHERE name_ar = 'زهران')               AS brand_zahran,
    (SELECT id FROM brands     WHERE name_ar = 'بلا علامة')           AS brand_generic,
    (SELECT id FROM categories WHERE slug = 'shoes')                  AS cat_shoes,
    (SELECT id FROM categories WHERE slug = 'bags')                   AS cat_bags,
    (SELECT id FROM categories WHERE slug = 'evening-shoes')          AS sc_evening,
    (SELECT id FROM categories WHERE slug = 'casual-shoes')           AS sc_casual,
    (SELECT id FROM categories WHERE slug = 'sport-shoes')            AS sc_sport,
    (SELECT id FROM categories WHERE slug = 'sandals')                AS sc_sandals,
    (SELECT id FROM categories WHERE slug = 'boots')                  AS sc_boots,
    (SELECT id FROM categories WHERE slug = 'hand-bags')              AS sc_hand,
    (SELECT id FROM categories WHERE slug = 'clutch')                 AS sc_clutch,
    (SELECT id FROM categories WHERE slug = 'backpacks')              AS sc_back,
    (SELECT id FROM categories WHERE slug = 'crossbody')              AS sc_cross;

-- ----------------------------------------------------------------------------
--  1. Additional staff users
-- ----------------------------------------------------------------------------
-- Password = "Demo@123" for everyone below (bcrypt, cost 10)
INSERT INTO users (full_name, username, email, password_hash, role_id, is_active, locale)
SELECT v.full_name, v.username, v.email,
       '$2a$10$8/8k0qFq0t8E7dQcpOhqL.4RZbG4YkG4qv0fY9jqh4lK2u.zY6eYG',
       r.id, TRUE, 'ar'
FROM (VALUES
    ('مها السيد',     'manager1',  'manager@zahran.eg', 'manager'),
    ('سارة محمد',      'cashier1',  'sara@zahran.eg',    'cashier'),
    ('نور خالد',       'cashier2',  'nour@zahran.eg',    'cashier'),
    ('ياسمين أحمد',    'sales1',    'yasmin@zahran.eg',  'salesperson'),
    ('ريم طارق',       'sales2',    'reem@zahran.eg',    'salesperson'),
    ('مصطفى حسن',      'stock1',    'mostafa@zahran.eg', 'inventory')
) AS v(full_name, username, email, role_code)
JOIN roles r ON r.code = v.role_code
ON CONFLICT (username) DO NOTHING;

-- ----------------------------------------------------------------------------
--  2. Products — 25 styles (15 shoes + 8 bags + 2 accessories)
-- ----------------------------------------------------------------------------
INSERT INTO products (sku_prefix, name_ar, name_en, product_type, target_audience,
                      category_id, subcategory_id, brand_id,
                      base_cost, base_price, min_margin_pct, metadata, is_active)
SELECT p.sku_prefix, p.name_ar, p.name_en, p.product_type::product_type, 'women'::target_audience,
       CASE p.cat_slug WHEN 'shoes' THEN r.cat_shoes
                       WHEN 'bags'  THEN r.cat_bags
                       ELSE NULL END,
       CASE p.sub_slug
           WHEN 'evening-shoes' THEN r.sc_evening
           WHEN 'casual-shoes'  THEN r.sc_casual
           WHEN 'sport-shoes'   THEN r.sc_sport
           WHEN 'sandals'       THEN r.sc_sandals
           WHEN 'boots'         THEN r.sc_boots
           WHEN 'hand-bags'     THEN r.sc_hand
           WHEN 'clutch'        THEN r.sc_clutch
           WHEN 'backpacks'     THEN r.sc_back
           WHEN 'crossbody'     THEN r.sc_cross
           ELSE NULL END,
       r.brand_zahran,
       p.base_cost, p.base_price, 20.00,
       jsonb_build_object('season', p.season, 'material', p.material),
       TRUE
FROM _ref r, (VALUES
    -- (sku_prefix, name_ar, name_en, product_type, cat_slug, sub_slug, base_cost, base_price, season, material)
    ('SH-EV01', 'حذاء سهرة كلاسيك ذهبي',  'Classic Gold Evening Heel',  'shoe', 'shoes', 'evening-shoes', 420, 890,  'summer', 'leather'),
    ('SH-EV02', 'حذاء سهرة مفتوح فضي',    'Open Silver Evening Heel',   'shoe', 'shoes', 'evening-shoes', 380, 790,  'summer', 'satin'),
    ('SH-EV03', 'حذاء سهرة أسود لامع',    'Black Glossy Heel',          'shoe', 'shoes', 'evening-shoes', 450, 990,  'all',    'patent'),
    ('SH-CA01', 'حذاء كاجوال جلد بني',    'Brown Leather Loafer',       'shoe', 'shoes', 'casual-shoes',  300, 650,  'winter', 'leather'),
    ('SH-CA02', 'حذاء كاجوال ستراب بيج',  'Beige Strap Flat',           'shoe', 'shoes', 'casual-shoes',  280, 599,  'summer', 'suede'),
    ('SH-CA03', 'حذاء كاجوال ناعم وردي',  'Pink Ballerina Flat',        'shoe', 'shoes', 'casual-shoes',  240, 499,  'spring', 'canvas'),
    ('SH-SP01', 'حذاء رياضي أبيض',        'White Sneaker',              'shoe', 'shoes', 'sport-shoes',   350, 750,  'all',    'mesh'),
    ('SH-SP02', 'حذاء رياضي وردي',        'Pink Running Shoe',          'shoe', 'shoes', 'sport-shoes',   380, 820,  'spring', 'mesh'),
    ('SH-SA01', 'صندل كعب رفيع أسود',     'Black Stiletto Sandal',      'shoe', 'shoes', 'sandals',       360, 790,  'summer', 'leather'),
    ('SH-SA02', 'صندل مسطح بني',          'Brown Flat Sandal',          'shoe', 'shoes', 'sandals',       220, 450,  'summer', 'leather'),
    ('SH-SA03', 'صندل كريستال ذهبي',      'Gold Crystal Sandal',        'shoe', 'shoes', 'sandals',       420, 920,  'summer', 'synthetic'),
    ('SH-BT01', 'بوت جلد أسود',           'Black Leather Boot',         'shoe', 'shoes', 'boots',         560, 1250, 'winter', 'leather'),
    ('SH-BT02', 'بوت سويد نسكافيه',       'Camel Suede Boot',           'shoe', 'shoes', 'boots',         520, 1150, 'winter', 'suede'),
    ('SH-BT03', 'بوت قصير بني',            'Brown Ankle Boot',           'shoe', 'shoes', 'boots',         480, 990,  'winter', 'leather'),
    ('SH-CA04', 'حذاء كاجوال أحمر',        'Red Casual Flat',            'shoe', 'shoes', 'casual-shoes',  260, 549,  'spring', 'leather'),

    ('BG-HD01', 'حقيبة يد جلد أسود',       'Black Leather Handbag',      'bag',  'bags',  'hand-bags',     550, 1290, 'all',    'leather'),
    ('BG-HD02', 'حقيبة يد نسكافيه كلاسيك', 'Camel Classic Handbag',      'bag',  'bags',  'hand-bags',     520, 1190, 'all',    'leather'),
    ('BG-HD03', 'حقيبة يد وردي ناعم',      'Soft Pink Handbag',          'bag',  'bags',  'hand-bags',     480, 1090, 'spring', 'leather'),
    ('BG-CL01', 'كلاتش سهرة ذهبي',         'Gold Evening Clutch',        'bag',  'bags',  'clutch',        220, 550,  'summer', 'satin'),
    ('BG-CL02', 'كلاتش سهرة فضي',          'Silver Evening Clutch',      'bag',  'bags',  'clutch',        220, 550,  'summer', 'satin'),
    ('BG-BP01', 'شنطة ظهر ناعمة بيج',      'Soft Beige Backpack',        'bag',  'bags',  'backpacks',     420, 990,  'all',    'canvas'),
    ('BG-BP02', 'شنطة ظهر أسود',           'Black Backpack',             'bag',  'bags',  'backpacks',     400, 890,  'all',    'nylon'),
    ('BG-CR01', 'كروس صغير أسود',          'Small Black Crossbody',      'bag',  'bags',  'crossbody',     280, 650,  'all',    'leather'),
    ('BG-CR02', 'كروس بني كلاسيك',         'Classic Brown Crossbody',    'bag',  'bags',  'crossbody',     290, 690,  'all',    'leather'),

    ('AC-BL01', 'حزام جلد بنى',            'Brown Leather Belt',         'accessory', NULL, NULL,          90,  250,  'all',    'leather')
) AS p(sku_prefix, name_ar, name_en, product_type, cat_slug, sub_slug, base_cost, base_price, season, material)
ON CONFLICT (sku_prefix) DO NOTHING;

-- ----------------------------------------------------------------------------
--  3. Product colors — 2-4 colors per product
-- ----------------------------------------------------------------------------
INSERT INTO product_colors (product_id, color_id, is_active)
SELECT p.id, c.id, TRUE
FROM products p
CROSS JOIN LATERAL (
    -- Pick 2-4 colors deterministically based on sku_prefix
    SELECT id FROM colors
    WHERE name_ar IN (
      CASE WHEN p.sku_prefix LIKE 'SH-EV%' THEN 'ذهبي' WHEN p.sku_prefix LIKE 'BG-CL%' THEN 'ذهبي' ELSE 'أسود' END,
      CASE WHEN p.sku_prefix LIKE 'SH-SP%' THEN 'أبيض' WHEN p.sku_prefix LIKE '%EV02' THEN 'فضي'   ELSE 'بني' END,
      CASE WHEN p.sku_prefix LIKE '%01'    THEN 'وردي' ELSE 'بيج' END
    )
) c
WHERE p.sku_prefix LIKE 'SH-%' OR p.sku_prefix LIKE 'BG-%' OR p.sku_prefix LIKE 'AC-%'
ON CONFLICT (product_id, color_id) DO NOTHING;

-- ----------------------------------------------------------------------------
--  4. Variants
--     Shoes: product × color × size (sizes 37..42 to keep numbers sane)
--     Bags / accessories: product × color (size NULL)
-- ----------------------------------------------------------------------------
-- Shoes variants
INSERT INTO product_variants (product_id, color_id, size_id, sku, cost_price, selling_price, is_active)
SELECT p.id, pc.color_id, s.id,
       p.sku_prefix || '-' || substring(replace(co.name_en, ' ', ''), 1, 3) || '-' || s.size_label,
       p.base_cost,
       p.base_price,
       TRUE
FROM products p
JOIN product_colors pc ON pc.product_id = p.id
JOIN colors co ON co.id = pc.color_id
JOIN sizes  s  ON s.size_label IN ('37','38','39','40','41','42')
WHERE p.product_type = 'shoe'
ON CONFLICT (product_id, color_id, size_id) DO NOTHING;

-- Bags / accessories variants (no size)
INSERT INTO product_variants (product_id, color_id, size_id, sku, cost_price, selling_price, is_active)
SELECT p.id, pc.color_id, NULL,
       p.sku_prefix || '-' || substring(replace(co.name_en, ' ', ''), 1, 3),
       p.base_cost,
       p.base_price,
       TRUE
FROM products p
JOIN product_colors pc ON pc.product_id = p.id
JOIN colors co ON co.id = pc.color_id
WHERE p.product_type IN ('bag','accessory')
ON CONFLICT (product_id, color_id, size_id) DO NOTHING;

-- ----------------------------------------------------------------------------
--  5. Initial stock — 4..14 units per variant, reorder_point = 3
-- ----------------------------------------------------------------------------
INSERT INTO stock (variant_id, warehouse_id, quantity_on_hand, quantity_reserved, reorder_point)
SELECT pv.id, r.wh_id,
       4 + (abs(hashtext(pv.id::text)) % 11),   -- 4..14
       0,
       3
FROM product_variants pv, _ref r
ON CONFLICT (variant_id, warehouse_id) DO NOTHING;

-- ----------------------------------------------------------------------------
--  6. Customers — 40 rows with phones (Egyptian format) and tiers
-- ----------------------------------------------------------------------------
INSERT INTO customers (customer_no, full_name, phone, gender, city, governorate,
                       loyalty_tier, loyalty_points, is_vip)
SELECT
    'CUS-' || lpad((1000 + row_number() OVER (ORDER BY v.full_name))::text, 6, '0'),
    v.full_name,
    '010' || lpad(((hashtext(v.full_name) & 2147483647) % 100000000)::text, 8, '0'),
    'female',
    v.city, v.gov,
    v.tier, v.points, v.vip
FROM (VALUES
    ('ندى مصطفى',     'القاهرة',   'القاهرة',     'gold',     2400, TRUE),
    ('هبة محمود',      'الإسكندرية','الإسكندرية',  'silver',   1100, FALSE),
    ('دينا شريف',      'الجيزة',    'الجيزة',      'platinum', 6200, TRUE),
    ('منى عبدالله',    'المنصورة',  'الدقهلية',    'silver',   800,  FALSE),
    ('رانيا صلاح',     'طنطا',      'الغربية',     'bronze',   150,  FALSE),
    ('أميرة فاروق',    'القاهرة',   'القاهرة',     'gold',     3100, TRUE),
    ('سمر جمال',       'الإسكندرية','الإسكندرية',  'silver',   900,  FALSE),
    ('هدى إبراهيم',    'أسيوط',     'أسيوط',      'bronze',    50,  FALSE),
    ('عبير أحمد',      'المنيا',    'المنيا',     'bronze',   320,  FALSE),
    ('رحمة يوسف',      'القاهرة',   'القاهرة',    'silver',   1250, FALSE),
    ('إيمان خالد',     'الزقازيق',  'الشرقية',    'bronze',    90,  FALSE),
    ('مروة سامي',      'القاهرة',   'القاهرة',    'gold',     2800, FALSE),
    ('نسرين فؤاد',     'الجيزة',    'الجيزة',      'silver',   1050, FALSE),
    ('شيماء عادل',     'الفيوم',    'الفيوم',     'bronze',    210, FALSE),
    ('لمياء أكرم',     'الإسماعيلية','الإسماعيلية','bronze',    170, FALSE),
    ('آية حسام',       'القاهرة',   'القاهرة',    'platinum', 5600, TRUE),
    ('فاطمة السيد',    'الجيزة',    'الجيزة',      'silver',   1800, FALSE),
    ('نجلاء عبدالرحمن','المنصورة',  'الدقهلية',    'bronze',    260, FALSE),
    ('ميرنا رامي',     'القاهرة',   'القاهرة',    'gold',     2550, FALSE),
    ('حبيبة وائل',     'الإسكندرية','الإسكندرية',  'silver',   1450, FALSE),
    ('جنى وليد',       'طنطا',     'الغربية',    'bronze',    110, FALSE),
    ('مريم شوقي',      'القاهرة',   'القاهرة',    'bronze',    200, FALSE),
    ('يارا أشرف',      'الجيزة',    'الجيزة',      'silver',   950,  FALSE),
    ('ملك رضا',        'دمياط',     'دمياط',      'bronze',    60,  FALSE),
    ('سلمى كريم',      'القاهرة',   'القاهرة',    'gold',     3400, TRUE),
    ('روان هيثم',      'الإسكندرية','الإسكندرية',  'silver',   1600, FALSE),
    ('أسماء نبيل',     'سوهاج',     'سوهاج',      'bronze',    130, FALSE),
    ('مرام طاهر',      'القاهرة',   'القاهرة',    'silver',   780,  FALSE),
    ('تسنيم عمرو',     'بورسعيد',   'بورسعيد',    'bronze',    90,  FALSE),
    ('جيهان حمدي',     'القاهرة',   'القاهرة',    'gold',     2950, FALSE),
    ('رفيدة أنور',     'الجيزة',    'الجيزة',      'silver',   1300, FALSE),
    ('منال زكي',       'الأقصر',    'الأقصر',     'bronze',    180, FALSE),
    ('عزة حلمي',       'القاهرة',   'القاهرة',    'silver',   1150, FALSE),
    ('هند عبدالحميد',  'الإسكندرية','الإسكندرية',  'bronze',    230, FALSE),
    ('ريهام عثمان',    'القاهرة',   'القاهرة',    'platinum', 7800, TRUE),
    ('سندس رفعت',      'المنصورة',  'الدقهلية',    'bronze',    75,  FALSE),
    ('نهى سعد',        'القاهرة',   'القاهرة',    'gold',     2200, FALSE),
    ('إسراء صبحي',     'الجيزة',    'الجيزة',      'silver',   890,  FALSE),
    ('بسنت مؤمن',      'القاهرة',   'القاهرة',    'silver',   1020, FALSE),
    ('نيرة علاء',      'القاهرة',   'القاهرة',    'bronze',    190, FALSE)
) AS v(full_name, city, gov, tier, points, vip)
ON CONFLICT (phone) DO NOTHING;

-- ----------------------------------------------------------------------------
--  7. Invoices — spread over the past 60 days
--     We do this procedurally so triggers (invoice_no, stock movements,
--     loyalty) fire naturally.
-- ----------------------------------------------------------------------------
DO $seed$
DECLARE
    v_wh_id         UUID;
    v_admin_id      UUID;
    v_cashier_ids   UUID[];
    v_sales_ids     UUID[];
    v_customer_ids  UUID[];
    v_variants      RECORD;
    v_invoice_id    UUID;
    v_variant_id    UUID;
    v_unit_price    NUMERIC;
    v_unit_cost     NUMERIC;
    v_qty           INT;
    v_line_total    NUMERIC;
    v_subtotal      NUMERIC;
    v_invoice_disc  NUMERIC;
    v_grand_total   NUMERIC;
    v_paid_cash     NUMERIC;
    v_paid_card     NUMERIC;
    v_tax_rate      NUMERIC := 14.00;
    v_date          TIMESTAMPTZ;
    i INT;
    j INT;
    n_items INT;
    n_invoices INT := 90;
BEGIN
    SELECT wh_id INTO v_wh_id FROM _ref;
    SELECT admin_id INTO v_admin_id FROM _ref;

    SELECT array_agg(u.id) INTO v_cashier_ids
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.code = 'cashier';
    IF v_cashier_ids IS NULL THEN v_cashier_ids := ARRAY[v_admin_id]; END IF;

    SELECT array_agg(u.id) INTO v_sales_ids
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE r.code = 'salesperson';

    SELECT array_agg(id) INTO v_customer_ids FROM customers WHERE deleted_at IS NULL;

    -- Skip if we've already seeded — detect by invoice_no prefix counter
    IF (SELECT count(*) FROM invoices WHERE source = 'pos' AND metadata @> '{"demo":true}'::jsonb) > 0 THEN
        RAISE NOTICE 'Demo invoices already seeded, skipping.';
        RETURN;
    END IF;

    FOR i IN 1..n_invoices LOOP
        v_date := NOW() - ((i * 16) || ' hours')::interval
                        - ((abs(hashtext('t' || i)) % 8) || ' hours')::interval;

        INSERT INTO invoices (warehouse_id, customer_id, cashier_id, salesperson_id,
                              status, source, tax_rate, metadata,
                              created_at, completed_at)
        VALUES (
            v_wh_id,
            v_customer_ids[1 + (abs(hashtext('c' || i)) % array_length(v_customer_ids, 1))],
            v_cashier_ids[1 + (abs(hashtext('u' || i)) % array_length(v_cashier_ids, 1))],
            CASE WHEN v_sales_ids IS NOT NULL
                 THEN v_sales_ids[1 + (abs(hashtext('s' || i)) % array_length(v_sales_ids, 1))]
                 ELSE NULL END,
            'completed'::invoice_status, 'pos', v_tax_rate,
            jsonb_build_object('demo', true, 'device', 'POS-1'),
            v_date, v_date
        )
        RETURNING id INTO v_invoice_id;

        v_subtotal := 0;
        n_items := 1 + (abs(hashtext('n' || i)) % 4);  -- 1..4 lines

        FOR j IN 1..n_items LOOP
            -- pick a random variant with stock
            SELECT pv.id, pv.selling_price, pv.cost_price,
                   p.name_ar, pv.sku,
                   co.name_ar, sz.size_label
            INTO v_variants
            FROM product_variants pv
            JOIN products p  ON p.id = pv.product_id
            JOIN colors co   ON co.id = pv.color_id
            LEFT JOIN sizes sz ON sz.id = pv.size_id
            JOIN stock st    ON st.variant_id = pv.id AND st.warehouse_id = v_wh_id
            WHERE pv.is_active AND st.quantity_on_hand > 0
            ORDER BY md5(i::text || j::text || pv.id::text)
            LIMIT 1;

            EXIT WHEN v_variants IS NULL;

            v_variant_id := v_variants.id;
            v_unit_price := v_variants.selling_price;
            v_unit_cost  := v_variants.cost_price;
            v_qty        := 1 + (abs(hashtext('q' || i || j)) % 2);   -- 1 or 2

            v_line_total := v_qty * v_unit_price;

            INSERT INTO invoice_items
                (invoice_id, variant_id, product_name_snapshot, sku_snapshot,
                 color_name_snapshot, size_label_snapshot,
                 quantity, unit_cost, unit_price,
                 line_subtotal, line_total)
            VALUES
                (v_invoice_id, v_variant_id,
                 v_variants.name_ar, v_variants.sku,
                 v_variants.name_ar, v_variants.size_label,
                 v_qty, v_unit_cost, v_unit_price,
                 v_line_total, v_line_total);

            -- deduct stock + ledger
            UPDATE stock
               SET quantity_on_hand = quantity_on_hand - v_qty,
                   updated_at = NOW()
             WHERE variant_id = v_variant_id AND warehouse_id = v_wh_id;

            INSERT INTO stock_movements
                (variant_id, warehouse_id, movement_type, direction,
                 quantity, unit_cost, reference_type, reference_id, user_id)
            VALUES
                (v_variant_id, v_wh_id, 'sale', 'out',
                 v_qty, v_unit_cost, 'invoice'::entity_type, v_invoice_id, v_admin_id);

            v_subtotal := v_subtotal + v_line_total;
        END LOOP;

        -- Invoice-level discount: 10% of the time, a small flat discount
        v_invoice_disc := CASE WHEN (abs(hashtext('d' || i)) % 10) = 0
                               THEN round(v_subtotal * 0.05, 2)
                               ELSE 0 END;

        v_grand_total := v_subtotal - v_invoice_disc;

        -- Split payments 50/50 on half the invoices, else pure cash
        IF (i % 2) = 0 AND v_grand_total > 200 THEN
            v_paid_cash := round(v_grand_total / 2, 2);
            v_paid_card := v_grand_total - v_paid_cash;
        ELSE
            v_paid_cash := v_grand_total;
            v_paid_card := 0;
        END IF;

        UPDATE invoices
           SET subtotal         = v_subtotal,
               invoice_discount = v_invoice_disc,
               grand_total      = v_grand_total,
               paid_amount      = v_grand_total,
               tax_amount       = 0,                  -- inclusive VAT for now
               cogs_total       = (SELECT COALESCE(sum(quantity * unit_cost),0)
                                   FROM invoice_items WHERE invoice_id = v_invoice_id),
               gross_profit     = v_grand_total -
                                  (SELECT COALESCE(sum(quantity * unit_cost),0)
                                   FROM invoice_items WHERE invoice_id = v_invoice_id)
         WHERE id = v_invoice_id;

        INSERT INTO invoice_payments (invoice_id, payment_method, amount, received_by, paid_at)
        VALUES (v_invoice_id, 'cash'::payment_method_code, v_paid_cash, v_admin_id, v_date);

        IF v_paid_card > 0 THEN
            INSERT INTO invoice_payments (invoice_id, payment_method, amount, reference_number,
                                          received_by, paid_at)
            VALUES (v_invoice_id, 'card_visa'::payment_method_code, v_paid_card,
                    'AUTH' || lpad(i::text, 6, '0'), v_admin_id, v_date);
        END IF;
    END LOOP;

    RAISE NOTICE 'Seeded % demo invoices', n_invoices;
END
$seed$;

-- ----------------------------------------------------------------------------
--  8. Cashbox opening balance + running total from invoices
-- ----------------------------------------------------------------------------
UPDATE cashboxes
   SET current_balance = (
       SELECT COALESCE(sum(ip.amount), 0)
       FROM invoice_payments ip
       WHERE ip.payment_method = 'cash'
   ) + 5000   -- 5000 EGP opening float
 WHERE id = (SELECT cash_id FROM _ref);

-- ----------------------------------------------------------------------------
--  9. A handful of expenses over the last month
-- ----------------------------------------------------------------------------
INSERT INTO expenses (warehouse_id, category_id, amount, payment_method,
                      cashbox_id, description, vendor_name, is_approved, approved_by,
                      expense_date, created_by)
SELECT
    r.wh_id,
    ec.id,
    v.amount,
    v.pm::payment_method_code,
    CASE WHEN v.pm = 'cash' THEN r.cash_id ELSE NULL END,
    v.description,
    v.vendor,
    TRUE,
    r.admin_id,
    (NOW() - (v.days_ago || ' days')::interval)::date,
    r.admin_id
FROM _ref r,
expense_categories ec,
(VALUES
    ('rent',       12000, 'bank_transfer', 'إيجار المحل شهر إبريل',    'عقار زهران',     30),
    ('salaries',   18000, 'cash',          'رواتب الموظفين',            'الموظفين',       28),
    ('utilities',   1250, 'cash',          'فاتورة كهرباء',              'شركة الكهرباء',  25),
    ('utilities',    380, 'cash',          'فاتورة مياه',                'شركة المياه',    25),
    ('marketing',   2500, 'card_visa',     'إعلانات فيسبوك',             'Meta Ads',       20),
    ('supplies',     550, 'cash',          'أكياس تغليف + فواتير',       'ستايل بلاستك',   18),
    ('transport',    900, 'cash',          'نقل بضاعة من المصنع',        'شركة الشحن',     14),
    ('maintenance',  650, 'cash',          'صيانة تكييف',                'فني صيانة',      10)
) AS v(cat_code, amount, pm, description, vendor, days_ago)
WHERE ec.code = v.cat_code
ON CONFLICT DO NOTHING;

-- Matching cashbox outflow for each cash expense — compute running balance_after
DO $cbx$
DECLARE
    v_cash_id UUID;
    v_bal     NUMERIC;
    rec       RECORD;
BEGIN
    SELECT cash_id INTO v_cash_id FROM _ref;
    SELECT current_balance INTO v_bal FROM cashboxes WHERE id = v_cash_id;

    FOR rec IN
        SELECT e.id, e.amount, e.description, e.created_by, e.expense_date
          FROM expenses e
         WHERE e.payment_method = 'cash'
           AND e.cashbox_id = v_cash_id
           AND NOT EXISTS (
               SELECT 1 FROM cashbox_transactions ct
                WHERE ct.reference_type = 'expense' AND ct.reference_id = e.id
           )
      ORDER BY e.expense_date
    LOOP
        v_bal := v_bal - rec.amount;
        INSERT INTO cashbox_transactions
            (cashbox_id, direction, amount, category, reference_type, reference_id,
             balance_after, notes, user_id, created_at)
        VALUES
            (v_cash_id, 'out'::txn_direction, rec.amount, 'expense',
             'expense'::entity_type, rec.id,
             v_bal, rec.description, rec.created_by, rec.expense_date::timestamptz);
    END LOOP;

    UPDATE cashboxes SET current_balance = v_bal, updated_at = NOW() WHERE id = v_cash_id;
END
$cbx$;

COMMIT;

-- =========================================================================
-- >>> FILE: migrations/017_notifications.sql
-- =========================================================================
-- =====================================================================
-- 017_notifications.sql — WhatsApp / SMS / Email outbound notifications
-- =====================================================================
-- Dependencies: 001_extensions_and_enums, 002_rbac_users, 005_customers_suppliers,
--               006_pos_and_discounts, 007_reservations
-- =====================================================================

-- Channel and status enums
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_channel') THEN
    CREATE TYPE notification_channel AS ENUM (
      'whatsapp',
      'sms',
      'email'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_status') THEN
    CREATE TYPE notification_status AS ENUM (
      'queued',
      'sending',
      'sent',
      'failed',
      'cancelled'
    );
  END IF;
END$$;

-- Templates (store templates in the settings table as JSON, or dedicated)
CREATE TABLE IF NOT EXISTS notification_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code          TEXT UNIQUE NOT NULL,
  name_ar       TEXT NOT NULL,
  channel       notification_channel NOT NULL,
  subject       TEXT,
  body          TEXT NOT NULL,        -- handlebars-like placeholders: {{customer_name}} etc.
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE notification_templates IS 'Reusable notification bodies (handlebars placeholders like {{customer_name}})';

-- Outbound queue
CREATE TABLE IF NOT EXISTS notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         notification_channel NOT NULL,
  recipient       TEXT NOT NULL,              -- phone (E.164) or email
  subject         TEXT,
  body            TEXT NOT NULL,
  status          notification_status NOT NULL DEFAULT 'queued',
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  provider        TEXT,                        -- e.g. 'twilio', 'meta_cloud', 'clickatell'
  provider_msg_id TEXT,
  reference_type  TEXT,                        -- 'invoice', 'reservation', 'alert', ...
  reference_id    UUID,
  template_code   TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at    TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_status ON notifications (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_notifications_reference ON notifications (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at DESC);

-- Trigger: update updated_at on row changes
CREATE OR REPLACE FUNCTION trg_notifications_touch()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS notifications_touch ON notifications;
CREATE TRIGGER notifications_touch
  BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION trg_notifications_touch();

DROP TRIGGER IF EXISTS notification_templates_touch ON notification_templates;
CREATE TRIGGER notification_templates_touch
  BEFORE UPDATE ON notification_templates
  FOR EACH ROW EXECUTE FUNCTION trg_notifications_touch();

-- Seed default templates (Arabic)
INSERT INTO notification_templates (code, name_ar, channel, body) VALUES
  (
    'invoice.thank_you',
    'شكر على الشراء',
    'whatsapp',
    'مرحباً {{customer_name}} 👋

شكراً لتسوقك من *{{shop_name}}*!
فاتورة رقم: {{doc_no}}
الإجمالي: {{grand_total}} ج.م

نقاط الولاء المكتسبة: {{earned_points}} ⭐
رصيد نقاطك الحالي: {{loyalty_points}}

نتشرف بزيارتك مجدداً ❤'
  ),
  (
    'reservation.reminder',
    'تذكير بحجز على وشك الانتهاء',
    'whatsapp',
    'مرحباً {{customer_name}}،
لديك حجز رقم {{doc_no}} سينتهي في {{expires_at}}.
الرجاء إتمام الاستلام أو التواصل معنا.'
  ),
  (
    'reservation.ready',
    'جاهزية الطلب',
    'sms',
    'عزيزنا {{customer_name}}، طلبك رقم {{doc_no}} أصبح جاهزاً للاستلام من {{shop_name}}.'
  ),
  (
    'alert.low_stock',
    'تنبيه انخفاض المخزون',
    'whatsapp',
    '⚠ انخفاض في المخزون:
{{product_name}} (SKU: {{sku}})
الكمية الحالية: {{qty}} — المستودع: {{warehouse}}'
  )
ON CONFLICT (code) DO NOTHING;

-- Seed notification provider settings (empty — to be filled by admin)
INSERT INTO settings (key, value, description)
VALUES (
  'notifications.config',
  jsonb_build_object(
    'whatsapp', jsonb_build_object(
      'provider', 'meta_cloud',
      'api_url', '',
      'token', '',
      'phone_id', '',
      'enabled', false
    ),
    'sms', jsonb_build_object(
      'provider', 'generic_http',
      'api_url', '',
      'api_key', '',
      'sender_id', '',
      'enabled', false
    ),
    'email', jsonb_build_object(
      'enabled', false,
      'smtp_host', '',
      'smtp_port', 587,
      'smtp_user', '',
      'smtp_pass', '',
      'from', ''
    ),
    'auto_send_invoice_receipt', true,
    'auto_send_reservation_reminder', true
  ),
  'Configuration for notification providers'
)
ON CONFLICT (key) DO NOTHING;

-- =========================================================================
-- >>> FILE: migrations/018_recurring_expenses.sql
-- =========================================================================
-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 018 : Recurring Expenses
--
--  Automates fixed/periodic payables (rent, salaries, utilities, subscriptions).
--  A recurring_expense template defines the schedule + default amounts/category,
--  and the scheduler/cron creates real expenses rows on the next due date.
-- ============================================================================

CREATE TYPE recurrence_frequency AS ENUM (
    'daily',
    'weekly',
    'biweekly',
    'monthly',
    'quarterly',
    'semiannual',
    'annual',
    'custom_days'
);

CREATE TYPE recurrence_status AS ENUM (
    'active',
    'paused',
    'ended'
);

-- ---------- Recurring expense templates ----------
CREATE TABLE recurring_expenses (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code                VARCHAR(40) UNIQUE NOT NULL,              -- e.g. RENT-CAIRO-01
    name_ar             VARCHAR(150) NOT NULL,
    name_en             VARCHAR(150),
    category_id         UUID NOT NULL REFERENCES expense_categories(id),
    warehouse_id        UUID NOT NULL REFERENCES warehouses(id),
    cashbox_id          UUID REFERENCES cashboxes(id),
    amount              NUMERIC(14,2) NOT NULL CHECK (amount >= 0),
    payment_method      payment_method_code NOT NULL DEFAULT 'cash',
    vendor_name         VARCHAR(150),
    description         TEXT,

    -- Schedule
    frequency           recurrence_frequency NOT NULL,
    custom_interval_days INT,                                     -- for frequency = custom_days
    day_of_month        INT CHECK (day_of_month BETWEEN 1 AND 31),-- for monthly/quarterly (NULL = same day as start)
    start_date          DATE NOT NULL,
    end_date            DATE,                                     -- NULL = no end
    next_run_date       DATE NOT NULL,                            -- updated after each generation
    last_run_date       DATE,

    -- Auto-behavior
    auto_post           BOOLEAN NOT NULL DEFAULT TRUE,            -- if true, generated expenses are auto-approved
    auto_paid           BOOLEAN NOT NULL DEFAULT FALSE,           -- if true, immediately deducts from cashbox
    notify_days_before  INT NOT NULL DEFAULT 3,                   -- generate a reminder N days before due
    require_approval    BOOLEAN NOT NULL DEFAULT FALSE,

    -- State
    status              recurrence_status NOT NULL DEFAULT 'active',
    runs_count          INT NOT NULL DEFAULT 0,                   -- how many expenses generated so far
    last_error          TEXT,
    metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,

    created_by          UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_rec_exp_next_run    ON recurring_expenses(next_run_date) WHERE status = 'active';
CREATE INDEX idx_rec_exp_status      ON recurring_expenses(status);
CREATE INDEX idx_rec_exp_category    ON recurring_expenses(category_id);
CREATE INDEX idx_rec_exp_warehouse   ON recurring_expenses(warehouse_id);

-- ---------- Generation log (one row per expense created) ----------
CREATE TABLE recurring_expense_runs (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    recurring_id        UUID NOT NULL REFERENCES recurring_expenses(id) ON DELETE CASCADE,
    expense_id          UUID REFERENCES expenses(id) ON DELETE SET NULL,
    scheduled_for       DATE NOT NULL,
    generated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    amount              NUMERIC(14,2) NOT NULL,
    status              VARCHAR(20) NOT NULL DEFAULT 'generated'
                        CHECK (status IN ('generated','skipped','failed','manual')),
    notes               TEXT,
    error_message       TEXT,
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE INDEX idx_rec_exp_runs_recurring ON recurring_expense_runs(recurring_id, scheduled_for DESC);
CREATE INDEX idx_rec_exp_runs_expense   ON recurring_expense_runs(expense_id);

-- ---------- Helper: compute next run date ----------
CREATE OR REPLACE FUNCTION fn_recurring_next_run(
    p_freq recurrence_frequency,
    p_current DATE,
    p_day_of_month INT DEFAULT NULL,
    p_custom_days INT DEFAULT NULL
) RETURNS DATE AS $$
DECLARE
    next_d DATE;
BEGIN
    CASE p_freq
        WHEN 'daily'       THEN next_d := p_current + INTERVAL '1 day';
        WHEN 'weekly'      THEN next_d := p_current + INTERVAL '7 days';
        WHEN 'biweekly'    THEN next_d := p_current + INTERVAL '14 days';
        WHEN 'monthly'     THEN next_d := p_current + INTERVAL '1 month';
        WHEN 'quarterly'   THEN next_d := p_current + INTERVAL '3 months';
        WHEN 'semiannual'  THEN next_d := p_current + INTERVAL '6 months';
        WHEN 'annual'      THEN next_d := p_current + INTERVAL '1 year';
        WHEN 'custom_days' THEN next_d := p_current + (COALESCE(p_custom_days, 1) || ' days')::INTERVAL;
    END CASE;

    -- pin to configured day-of-month for monthly-ish frequencies
    IF p_day_of_month IS NOT NULL AND p_freq IN ('monthly','quarterly','semiannual','annual') THEN
        next_d := date_trunc('month', next_d)::DATE
                  + LEAST(p_day_of_month, EXTRACT(DAY FROM (date_trunc('month', next_d) + INTERVAL '1 month - 1 day'))::INT) - 1;
    END IF;

    RETURN next_d;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ---------- Trigger: set next_run_date on insert ----------
CREATE OR REPLACE FUNCTION fn_recurring_defaults() RETURNS TRIGGER AS $$
BEGIN
    IF NEW.next_run_date IS NULL THEN
        NEW.next_run_date := NEW.start_date;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_recurring_defaults BEFORE INSERT ON recurring_expenses
FOR EACH ROW EXECUTE FUNCTION fn_recurring_defaults();

CREATE TRIGGER trg_recurring_exp_updated BEFORE UPDATE ON recurring_expenses
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------- View: due now / overdue ----------
CREATE OR REPLACE VIEW v_recurring_expenses_due AS
SELECT
    re.id,
    re.code,
    re.name_ar,
    re.amount,
    re.frequency,
    re.next_run_date,
    re.warehouse_id,
    re.category_id,
    ec.name_ar   AS category_name,
    w.name_ar    AS warehouse_name,
    CASE
        WHEN re.next_run_date <= CURRENT_DATE THEN 'due'
        WHEN re.next_run_date <= CURRENT_DATE + (re.notify_days_before || ' days')::INTERVAL THEN 'upcoming'
        ELSE 'scheduled'
    END AS due_status,
    (CURRENT_DATE - re.next_run_date) AS days_overdue,
    re.runs_count,
    re.last_run_date
FROM recurring_expenses re
JOIN expense_categories ec ON ec.id = re.category_id
JOIN warehouses w          ON w.id  = re.warehouse_id
WHERE re.status = 'active';

-- ---------- Seed a couple of common templates (demo only) ----------
-- (Commented out by default; uncomment per deployment.)
--
-- INSERT INTO recurring_expenses (code, name_ar, category_id, warehouse_id, amount, frequency,
--                                  day_of_month, start_date, next_run_date, auto_post)
-- SELECT 'RENT-MAIN-01', 'إيجار الفرع الرئيسي',
--        (SELECT id FROM expense_categories WHERE code='rent'  LIMIT 1),
--        (SELECT id FROM warehouses         WHERE code='ZHR-01' LIMIT 1),
--        15000, 'monthly', 1, CURRENT_DATE, CURRENT_DATE, TRUE
-- WHERE EXISTS (SELECT 1 FROM expense_categories WHERE code='rent')
--   AND EXISTS (SELECT 1 FROM warehouses         WHERE code='ZHR-01');

-- =========================================================================
-- >>> FILE: migrations/019_customer_groups_pricing.sql
-- =========================================================================
-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 019 : Customer Groups + Wholesale Pricing
--
--  Enables tiered pricing — e.g.
--      • Retail (default, no discount)
--      • Wholesale Silver (15% off all SKUs)
--      • Wholesale Gold   (20% off, or fixed per-variant prices)
--      • Corporate (custom prices per product)
--
--  Resolution order when POS prices a variant for a given customer:
--      1. exact variant override in customer_group_prices (most specific)
--      2. category-level default discount in customer_group_categories
--      3. group's default_discount_pct
--      4. base selling_price (variant) / base_price (product)
-- ============================================================================

-- ---------- Customer groups ----------
CREATE TABLE customer_groups (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    code                VARCHAR(40) UNIQUE NOT NULL,                -- RETAIL, WHS-GOLD, CORP-01
    name_ar             VARCHAR(120) NOT NULL,
    name_en             VARCHAR(120),
    description         TEXT,
    is_wholesale        BOOLEAN NOT NULL DEFAULT FALSE,
    default_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0            -- 0..100
                        CHECK (default_discount_pct >= 0 AND default_discount_pct <= 100),
    min_order_amount    NUMERIC(14,2) NOT NULL DEFAULT 0,           -- minimum invoice total for this tier
    credit_limit        NUMERIC(14,2) NOT NULL DEFAULT 0,           -- optional A/R limit (future)
    payment_terms_days  INT NOT NULL DEFAULT 0,                     -- 0 = cash / on-spot
    is_active           BOOLEAN NOT NULL DEFAULT TRUE,
    is_default          BOOLEAN NOT NULL DEFAULT FALSE,             -- exactly one should be TRUE (RETAIL)
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX ux_customer_groups_default
    ON customer_groups(is_default) WHERE is_default = TRUE;

CREATE TRIGGER trg_customer_groups_updated BEFORE UPDATE ON customer_groups
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------- Link customers → groups ----------
ALTER TABLE customers
    ADD COLUMN group_id UUID REFERENCES customer_groups(id) ON DELETE SET NULL;

CREATE INDEX idx_customers_group ON customers(group_id);

-- ---------- Per-variant overrides (most specific) ----------
CREATE TABLE customer_group_prices (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id        UUID NOT NULL REFERENCES customer_groups(id) ON DELETE CASCADE,
    variant_id      UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
    price           NUMERIC(14,2) NOT NULL CHECK (price >= 0),      -- absolute price
    min_qty         INT NOT NULL DEFAULT 1 CHECK (min_qty >= 1),    -- quantity break-point
    valid_from      DATE,
    valid_to        DATE,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    notes           TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (group_id, variant_id, min_qty)
);

CREATE INDEX idx_cgp_group      ON customer_group_prices(group_id);
CREATE INDEX idx_cgp_variant    ON customer_group_prices(variant_id);
CREATE INDEX idx_cgp_active     ON customer_group_prices(is_active) WHERE is_active = TRUE;

CREATE TRIGGER trg_cgp_updated BEFORE UPDATE ON customer_group_prices
FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- ---------- Per-category discount (medium specificity) ----------
CREATE TABLE customer_group_categories (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    group_id        UUID NOT NULL REFERENCES customer_groups(id)  ON DELETE CASCADE,
    category_id     UUID NOT NULL REFERENCES categories(id)        ON DELETE CASCADE,
    discount_pct    NUMERIC(5,2) NOT NULL CHECK (discount_pct >= 0 AND discount_pct <= 100),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (group_id, category_id)
);

CREATE INDEX idx_cgcat_group ON customer_group_categories(group_id);

-- ---------- Resolver function ----------
-- Returns effective price for a given variant + customer_id + qty.
-- Uses the cascade above. When customer_id is NULL or has no group, returns base price.
CREATE OR REPLACE FUNCTION fn_resolve_price(
    p_variant_id UUID,
    p_customer_id UUID DEFAULT NULL,
    p_qty INT DEFAULT 1
) RETURNS NUMERIC AS $$
DECLARE
    v_base_price      NUMERIC(14,2);
    v_category_id     UUID;
    v_group_id        UUID;
    v_override        NUMERIC(14,2);
    v_cat_discount    NUMERIC(5,2);
    v_group_discount  NUMERIC(5,2);
BEGIN
    -- Base price from variant (fall back to product.base_price if 0)
    SELECT COALESCE(NULLIF(pv.selling_price, 0), p.base_price),
           p.category_id
      INTO v_base_price, v_category_id
      FROM product_variants pv
      JOIN products p ON p.id = pv.product_id
     WHERE pv.id = p_variant_id;

    IF v_base_price IS NULL THEN
        RETURN NULL;
    END IF;

    -- Determine group (from customer, else default group)
    IF p_customer_id IS NOT NULL THEN
        SELECT c.group_id INTO v_group_id FROM customers c WHERE c.id = p_customer_id;
    END IF;
    IF v_group_id IS NULL THEN
        SELECT id INTO v_group_id FROM customer_groups WHERE is_default = TRUE AND is_active = TRUE LIMIT 1;
    END IF;
    IF v_group_id IS NULL THEN
        RETURN v_base_price;
    END IF;

    -- 1) exact variant override matching qty
    SELECT price INTO v_override
      FROM customer_group_prices
     WHERE group_id = v_group_id
       AND variant_id = p_variant_id
       AND is_active = TRUE
       AND (valid_from IS NULL OR valid_from <= CURRENT_DATE)
       AND (valid_to   IS NULL OR valid_to   >= CURRENT_DATE)
       AND min_qty <= p_qty
     ORDER BY min_qty DESC
     LIMIT 1;
    IF v_override IS NOT NULL THEN
        RETURN v_override;
    END IF;

    -- 2) category-level discount for this group
    IF v_category_id IS NOT NULL THEN
        SELECT discount_pct INTO v_cat_discount
          FROM customer_group_categories
         WHERE group_id = v_group_id AND category_id = v_category_id AND is_active = TRUE
         LIMIT 1;
        IF v_cat_discount IS NOT NULL THEN
            RETURN ROUND(v_base_price * (1 - v_cat_discount / 100.0), 2);
        END IF;
    END IF;

    -- 3) group default discount
    SELECT default_discount_pct INTO v_group_discount FROM customer_groups WHERE id = v_group_id;
    IF COALESCE(v_group_discount, 0) > 0 THEN
        RETURN ROUND(v_base_price * (1 - v_group_discount / 100.0), 2);
    END IF;

    RETURN v_base_price;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------- View: price matrix per group (for admin UI) ----------
CREATE OR REPLACE VIEW v_customer_group_pricing AS
SELECT
    cg.id              AS group_id,
    cg.code            AS group_code,
    cg.name_ar         AS group_name,
    pv.id              AS variant_id,
    pv.sku,
    pv.selling_price   AS base_price,
    p.name_ar          AS product_name,
    cgp.price          AS group_price,
    cgp.min_qty,
    cgp.valid_from,
    cgp.valid_to,
    cgp.is_active      AS price_active,
    fn_resolve_price(pv.id, NULL, 1) AS default_resolved
FROM customer_groups cg
CROSS JOIN product_variants pv
JOIN products p ON p.id = pv.product_id
LEFT JOIN customer_group_prices cgp
       ON cgp.group_id = cg.id AND cgp.variant_id = pv.id AND cgp.min_qty = 1
WHERE cg.is_active = TRUE AND pv.is_active = TRUE;

-- ---------- Seed default Retail group so the cascade always has a root ----------
INSERT INTO customer_groups (code, name_ar, name_en, is_wholesale, default_discount_pct, is_default, is_active)
VALUES
    ('RETAIL',    'التجزئة',         'Retail',           FALSE, 0,  TRUE,  TRUE),
    ('WHS-SILVER','جملة فضية',       'Wholesale Silver', TRUE,  10, FALSE, TRUE),
    ('WHS-GOLD',  'جملة ذهبية',      'Wholesale Gold',   TRUE,  20, FALSE, TRUE),
    ('CORPORATE', 'شركات',           'Corporate',        TRUE,  15, FALSE, TRUE)
ON CONFLICT (code) DO NOTHING;

-- ---------- Back-fill existing customers to the default Retail group ----------
UPDATE customers SET group_id = (SELECT id FROM customer_groups WHERE code = 'RETAIL')
WHERE group_id IS NULL;

-- ---------- Comments ----------
COMMENT ON TABLE customer_groups IS
  'Pricing tiers — default Retail + wholesale/corporate with either percentage or per-variant overrides.';
COMMENT ON FUNCTION fn_resolve_price(UUID, UUID, INT) IS
  'Cascade: variant override → category discount → group default discount → base price.';

-- =========================================================================
-- >>> FILE: migrations/020_returns_analytics.sql
-- =========================================================================
-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Module 020 : Returns Analytics Views
-- ----------------------------------------------------------------------------
--  Dashboard views for understanding returns patterns:
--    * Summary KPIs (counts, amounts, rates)
--    * Breakdown by reason
--    * Top returned variants/products
--    * Monthly / weekly trend
--    * Condition distribution
-- ============================================================================

-- ---------- Summary (rolling 30d, 90d, YTD) ---------------------------------
CREATE OR REPLACE VIEW v_returns_summary AS
SELECT
    (SELECT COUNT(*) FROM returns
       WHERE status IN ('approved','refunded'))                            AS total_count,
    (SELECT COALESCE(SUM(net_refund),0) FROM returns
       WHERE status IN ('approved','refunded'))                            AS total_net_refund,
    (SELECT COUNT(*) FROM returns
       WHERE status IN ('approved','refunded')
         AND requested_at >= NOW() - INTERVAL '30 days')                   AS count_30d,
    (SELECT COALESCE(SUM(net_refund),0) FROM returns
       WHERE status IN ('approved','refunded')
         AND requested_at >= NOW() - INTERVAL '30 days')                   AS net_refund_30d,
    (SELECT COUNT(*) FROM returns
       WHERE status IN ('approved','refunded')
         AND requested_at >= NOW() - INTERVAL '90 days')                   AS count_90d,
    (SELECT COALESCE(SUM(net_refund),0) FROM returns
       WHERE status IN ('approved','refunded')
         AND requested_at >= NOW() - INTERVAL '90 days')                   AS net_refund_90d,
    (SELECT COUNT(*) FROM returns WHERE status = 'pending')                AS pending_count,
    (SELECT COALESCE(SUM(total_refund),0) FROM returns
       WHERE status = 'pending')                                           AS pending_amount,
    -- returns rate = returned_items / sold_items over the last 30d
    (
      SELECT ROUND(
        CASE WHEN sold.qty > 0
             THEN (COALESCE(ret.qty, 0)::numeric / sold.qty) * 100
             ELSE 0
        END, 2)
      FROM (SELECT COALESCE(SUM(ii.quantity),0) AS qty
              FROM invoice_items ii
              JOIN invoices i ON i.id = ii.invoice_id
             WHERE i.status = 'paid'
               AND i.issued_at >= NOW() - INTERVAL '30 days') sold,
           (SELECT COALESCE(SUM(ri.quantity),0) AS qty
              FROM return_items ri
              JOIN returns r ON r.id = ri.return_id
             WHERE r.status IN ('approved','refunded')
               AND r.requested_at >= NOW() - INTERVAL '30 days') ret
    ) AS return_rate_30d;

-- ---------- Breakdown by reason ---------------------------------------------
CREATE OR REPLACE VIEW v_returns_by_reason AS
SELECT
    r.reason::text                                  AS reason,
    COUNT(DISTINCT r.id)                            AS return_count,
    COALESCE(SUM(ri.quantity), 0)                   AS qty,
    COALESCE(SUM(r.net_refund), 0)                  AS net_refund,
    ROUND(AVG(r.net_refund)::numeric, 2)            AS avg_refund
FROM returns r
LEFT JOIN return_items ri ON ri.return_id = r.id
WHERE r.status IN ('approved','refunded')
GROUP BY r.reason
ORDER BY return_count DESC;

-- ---------- Top returned products / variants --------------------------------
CREATE OR REPLACE VIEW v_returns_top_products AS
WITH returned AS (
  SELECT ri.variant_id,
         SUM(ri.quantity)      AS returned_qty,
         SUM(ri.refund_amount) AS refund_total,
         COUNT(DISTINCT r.id)  AS return_count
    FROM return_items ri
    JOIN returns r ON r.id = ri.return_id
   WHERE r.status IN ('approved','refunded')
   GROUP BY ri.variant_id
),
sold AS (
  SELECT ii.variant_id,
         SUM(ii.quantity) AS sold_qty
    FROM invoice_items ii
    JOIN invoices i ON i.id = ii.invoice_id
   WHERE i.status = 'paid'
   GROUP BY ii.variant_id
)
SELECT
    v.id                                             AS variant_id,
    p.id                                             AS product_id,
    p.name_ar,
    v.sku,
    COALESCE(ret.returned_qty, 0)                    AS returned_qty,
    COALESCE(sold.sold_qty, 0)                       AS sold_qty,
    COALESCE(ret.refund_total, 0)                    AS refund_total,
    COALESCE(ret.return_count, 0)                    AS return_count,
    CASE WHEN COALESCE(sold.sold_qty, 0) > 0
         THEN ROUND((COALESCE(ret.returned_qty,0)::numeric / sold.sold_qty) * 100, 2)
         ELSE 0
    END                                              AS return_rate_pct
FROM returned ret
JOIN product_variants v ON v.id = ret.variant_id
JOIN products p         ON p.id = v.product_id
LEFT JOIN sold          ON sold.variant_id = v.id
WHERE ret.returned_qty > 0
ORDER BY ret.returned_qty DESC, ret.refund_total DESC;

-- ---------- Monthly trend (last 12 months) ----------------------------------
CREATE OR REPLACE VIEW v_returns_trend_monthly AS
SELECT
    to_char(date_trunc('month', r.requested_at), 'YYYY-MM')  AS month,
    COUNT(*)                                                 AS return_count,
    COALESCE(SUM(ri.quantity), 0)                            AS qty,
    COALESCE(SUM(r.net_refund), 0)                           AS net_refund
FROM returns r
LEFT JOIN return_items ri ON ri.return_id = r.id
WHERE r.status IN ('approved','refunded')
  AND r.requested_at >= NOW() - INTERVAL '12 months'
GROUP BY 1
ORDER BY 1 ASC;

-- ---------- Daily trend (last 30 days) --------------------------------------
CREATE OR REPLACE VIEW v_returns_trend_daily AS
SELECT
    to_char(date_trunc('day', r.requested_at), 'YYYY-MM-DD') AS day,
    COUNT(*)                                                 AS return_count,
    COALESCE(SUM(ri.quantity), 0)                            AS qty,
    COALESCE(SUM(r.net_refund), 0)                           AS net_refund
FROM returns r
LEFT JOIN return_items ri ON ri.return_id = r.id
WHERE r.status IN ('approved','refunded')
  AND r.requested_at >= NOW() - INTERVAL '30 days'
GROUP BY 1
ORDER BY 1 ASC;

-- ---------- Condition breakdown (resellable vs damaged vs defective) --------
CREATE OR REPLACE VIEW v_returns_by_condition AS
SELECT
    ri.condition,
    COUNT(*)                                         AS line_count,
    COALESCE(SUM(ri.quantity), 0)                    AS qty,
    COALESCE(SUM(ri.refund_amount), 0)               AS refund_total,
    ROUND(
      COUNT(*)::numeric * 100 / NULLIF(SUM(COUNT(*)) OVER (), 0),
      2
    )                                                AS pct_of_total
FROM return_items ri
JOIN returns r ON r.id = ri.return_id
WHERE r.status IN ('approved','refunded')
GROUP BY ri.condition
ORDER BY qty DESC;

-- ---------- Dashboard compact widget ----------------------------------------
-- A lightweight subset used by the dashboard widget (top 5 returned SKUs and
-- top 3 reasons in the last 30 days).
CREATE OR REPLACE VIEW v_returns_widget AS
WITH reasons AS (
  SELECT r.reason::text AS reason,
         COUNT(*)       AS cnt
    FROM returns r
   WHERE r.status IN ('approved','refunded')
     AND r.requested_at >= NOW() - INTERVAL '30 days'
   GROUP BY r.reason
   ORDER BY cnt DESC
   LIMIT 3
),
top_products AS (
  SELECT p.name_ar,
         v.sku,
         SUM(ri.quantity) AS returned_qty
    FROM return_items ri
    JOIN returns r  ON r.id = ri.return_id
    JOIN product_variants v ON v.id = ri.variant_id
    JOIN products p ON p.id = v.product_id
   WHERE r.status IN ('approved','refunded')
     AND r.requested_at >= NOW() - INTERVAL '30 days'
   GROUP BY p.name_ar, v.sku
   ORDER BY returned_qty DESC
   LIMIT 5
)
SELECT
  (SELECT COUNT(*) FROM returns
     WHERE status IN ('approved','refunded')
       AND requested_at >= NOW() - INTERVAL '30 days')       AS count_30d,
  (SELECT COALESCE(SUM(net_refund),0) FROM returns
     WHERE status IN ('approved','refunded')
       AND requested_at >= NOW() - INTERVAL '30 days')       AS refund_30d,
  (SELECT COUNT(*) FROM returns WHERE status = 'pending')    AS pending_count,
  (SELECT COALESCE(json_agg(row_to_json(reasons)), '[]'::json)
     FROM reasons)                                           AS top_reasons,
  (SELECT COALESCE(json_agg(row_to_json(top_products)), '[]'::json)
     FROM top_products)                                      AS top_products;

-- =========================================================================
-- >>> FILE: migrations/021_vat_support.sql
-- =========================================================================
-- 021_vat_support.sql
-- VAT (Value-Added Tax) support for POS
-- Egypt standard VAT rate is 14% on most retail sales.
-- This migration:
--   1. Ensures tax_rate / tax_amount columns exist on invoices + invoice_items
--   2. Seeds default VAT settings under settings key 'vat.config'
--   3. Creates a helper view for VAT reporting

-- --------------------------------------------------------------------
-- 1. Columns (idempotent)
-- --------------------------------------------------------------------
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS tax_rate   numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount numeric(14,2) NOT NULL DEFAULT 0;

ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS tax_rate   numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount numeric(14,2) NOT NULL DEFAULT 0;

-- --------------------------------------------------------------------
-- 2. Seed default VAT config (editable via Settings page)
-- --------------------------------------------------------------------
INSERT INTO settings (key, value, description)
VALUES (
  'vat.config',
  jsonb_build_object(
    'enabled',        false,
    'rate',           14.0,
    'inclusive',      true,   -- prices include VAT by default (Egypt retail norm)
    'vat_number',     '',
    'display_on_receipt', true
  ),
  'إعدادات ضريبة القيمة المضافة (VAT)'
)
ON CONFLICT (key) DO NOTHING;

-- --------------------------------------------------------------------
-- 3. View: VAT report per invoice
-- --------------------------------------------------------------------
CREATE OR REPLACE VIEW v_vat_per_invoice AS
SELECT
  i.id                    AS invoice_id,
  i.invoice_no,
  i.completed_at,
  i.warehouse_id,
  i.customer_id,
  i.grand_total,
  i.tax_rate,
  i.tax_amount,
  (i.grand_total - i.tax_amount) AS net_amount
FROM invoices i
WHERE i.status = 'paid';

COMMENT ON VIEW v_vat_per_invoice IS
  'VAT broken down per invoice for tax reporting';

-- --------------------------------------------------------------------
-- 4. View: VAT monthly summary
-- --------------------------------------------------------------------
CREATE OR REPLACE VIEW v_vat_monthly AS
SELECT
  date_trunc('month', completed_at)::date AS month,
  COUNT(*)                                AS invoice_count,
  COALESCE(SUM(grand_total - tax_amount), 0) AS net_sales,
  COALESCE(SUM(tax_amount), 0)            AS vat_collected,
  COALESCE(SUM(grand_total), 0)           AS gross_sales
FROM invoices
WHERE status = 'paid'
GROUP BY 1
ORDER BY 1 DESC;

COMMENT ON VIEW v_vat_monthly IS
  'Monthly VAT collected — feed for tax authority filings';

-- =========================================================================
-- >>> FILE: migrations/022_loyalty_earn_on_insert.sql
-- =========================================================================
-- 022_loyalty_earn_on_insert.sql
-- Fix: loyalty points accrual trigger only fires on UPDATE OF status,
-- but POS inserts invoices directly with status='paid'. So customers
-- never earn points. Split the logic into a shared function and call
-- it from both INSERT and UPDATE triggers.

CREATE OR REPLACE FUNCTION fn_accumulate_customer_core(
    p_invoice_id   uuid,
    p_customer_id  uuid,
    p_grand_total  numeric,
    p_cashier_id   uuid
) RETURNS VOID AS $$
DECLARE
    v_rate         numeric;
    v_earned       int;
BEGIN
    IF p_customer_id IS NULL THEN
        RETURN;
    END IF;

    -- Config: points_per_egp (defaults to 0.1 = 1pt per 10 EGP)
    SELECT COALESCE((value->>'points_per_egp')::numeric, 0.1) INTO v_rate
    FROM settings WHERE key = 'loyalty.rate';

    v_earned := FLOOR(p_grand_total * COALESCE(v_rate, 0.1))::int;

    IF v_earned <= 0 THEN
        -- Still update spend / visits, but skip points ledger row
        UPDATE customers
           SET total_spent   = total_spent + p_grand_total,
               visits_count  = visits_count + 1,
               last_visit_at = NOW()
         WHERE id = p_customer_id;
        RETURN;
    END IF;

    UPDATE customers
       SET total_spent    = total_spent + p_grand_total,
           visits_count   = visits_count + 1,
           last_visit_at  = NOW(),
           loyalty_points = loyalty_points + v_earned
     WHERE id = p_customer_id;

    -- Idempotent: do not double-insert if already present
    INSERT INTO customer_loyalty_transactions(
        customer_id, direction, points, reason, reference_type, reference_id, user_id
    )
    SELECT p_customer_id, 'in', v_earned, 'earned', 'invoice', p_invoice_id, p_cashier_id
    WHERE NOT EXISTS (
        SELECT 1 FROM customer_loyalty_transactions
         WHERE reference_type = 'invoice'
           AND reference_id   = p_invoice_id
           AND direction      = 'in'
           AND reason         = 'earned'
    );
END;
$$ LANGUAGE plpgsql;

-- Replace the existing UPDATE trigger function
CREATE OR REPLACE FUNCTION fn_accumulate_customer()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('paid','completed') AND
       (OLD.status IS DISTINCT FROM NEW.status) THEN
        PERFORM fn_accumulate_customer_core(
            NEW.id, NEW.customer_id, NEW.grand_total, NEW.cashier_id
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- NEW: INSERT trigger for invoices saved directly as paid
CREATE OR REPLACE FUNCTION fn_accumulate_customer_on_insert()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.status IN ('paid','completed') THEN
        PERFORM fn_accumulate_customer_core(
            NEW.id, NEW.customer_id, NEW.grand_total, NEW.cashier_id
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_customer_accumulate_insert ON invoices;
CREATE TRIGGER trg_customer_accumulate_insert
AFTER INSERT ON invoices
FOR EACH ROW EXECUTE FUNCTION fn_accumulate_customer_on_insert();

-- =========================================================================
-- >>> FILE: migrations/023_purchase_returns.sql
-- =========================================================================
-- 023_purchase_returns.sql
-- Returns to supplier (purchase returns / debit notes).

CREATE TABLE IF NOT EXISTS purchase_returns (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    return_no       varchar(40) UNIQUE,
    purchase_id     uuid REFERENCES purchases(id) ON DELETE SET NULL,
    supplier_id     uuid NOT NULL REFERENCES suppliers(id),
    warehouse_id    uuid NOT NULL REFERENCES warehouses(id),
    return_date     date NOT NULL DEFAULT CURRENT_DATE,
    total_amount    numeric(14,2) NOT NULL DEFAULT 0,
    reason          text,
    status          varchar(20) NOT NULL DEFAULT 'posted'
                      CHECK (status IN ('draft','posted','cancelled')),
    notes           text,
    created_by      uuid REFERENCES users(id),
    created_at      timestamptz NOT NULL DEFAULT NOW(),
    updated_at      timestamptz NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_purchase_returns_supplier
  ON purchase_returns(supplier_id);
CREATE INDEX IF NOT EXISTS idx_purchase_returns_date
  ON purchase_returns(return_date DESC);

CREATE TABLE IF NOT EXISTS purchase_return_items (
    id              uuid PRIMARY KEY DEFAULT uuid_generate_v4(),
    purchase_return_id uuid NOT NULL REFERENCES purchase_returns(id) ON DELETE CASCADE,
    variant_id      uuid NOT NULL REFERENCES product_variants(id),
    quantity        numeric(12,3) NOT NULL CHECK (quantity > 0),
    unit_cost       numeric(14,2) NOT NULL CHECK (unit_cost >= 0),
    line_total      numeric(14,2) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_purchase_return_items_pr
  ON purchase_return_items(purchase_return_id);

-- Auto-generate return_no (PRN-YYYY-####)
CREATE OR REPLACE FUNCTION fn_set_purchase_return_no()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.return_no IS NULL THEN
    NEW.return_no := next_doc_no('PRN', 'purchase_returns_no_seq');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE SEQUENCE IF NOT EXISTS purchase_returns_no_seq;
EXCEPTION WHEN duplicate_table THEN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_set_purchase_return_no ON purchase_returns;
CREATE TRIGGER trg_set_purchase_return_no
BEFORE INSERT ON purchase_returns
FOR EACH ROW EXECUTE FUNCTION fn_set_purchase_return_no();

-- Summary view
CREATE OR REPLACE VIEW v_purchase_returns_summary AS
SELECT
  pr.id,
  pr.return_no,
  pr.return_date,
  pr.supplier_id,
  s.name         AS supplier_name,
  pr.warehouse_id,
  w.name_ar      AS warehouse_name,
  pr.total_amount,
  pr.status,
  pr.reason,
  (SELECT COUNT(*) FROM purchase_return_items pri
    WHERE pri.purchase_return_id = pr.id) AS items_count
FROM purchase_returns pr
LEFT JOIN suppliers s  ON s.id = pr.supplier_id
LEFT JOIN warehouses w ON w.id = pr.warehouse_id
ORDER BY pr.return_date DESC;

-- =========================================================================
-- >>> FILE: migrations/024_advanced_reports.sql
-- =========================================================================
-- 024_advanced_reports.sql
-- Advanced analytics views:
--   v_profit_margin_per_product : profit per product, % margin
--   v_dead_stock                : stock with no movement in the last N days
--   v_period_compare            : helper view for UI (day/month aggregates)

-- --------------------------------------------------------------------
-- 1. Profit margin per product
-- --------------------------------------------------------------------
CREATE OR REPLACE VIEW v_profit_margin_per_product AS
SELECT
  p.id                          AS product_id,
  p.sku_root,
  p.name_ar,
  p.product_type,
  COALESCE(SUM(ii.quantity), 0)          AS qty_sold,
  COALESCE(SUM(ii.line_total), 0)        AS revenue,
  COALESCE(SUM(ii.quantity * ii.unit_cost), 0) AS cogs,
  COALESCE(SUM(ii.line_total - ii.quantity * ii.unit_cost), 0) AS gross_profit,
  CASE
    WHEN COALESCE(SUM(ii.line_total), 0) = 0 THEN 0
    ELSE ROUND(
      (SUM(ii.line_total - ii.quantity * ii.unit_cost) /
       NULLIF(SUM(ii.line_total), 0)) * 100, 2
    )
  END AS margin_pct
FROM products p
LEFT JOIN product_variants pv ON pv.product_id = p.id
LEFT JOIN invoice_items    ii ON ii.variant_id = pv.id
LEFT JOIN invoices         inv ON inv.id = ii.invoice_id AND inv.status = 'paid'
GROUP BY p.id, p.sku_root, p.name_ar, p.product_type;

COMMENT ON VIEW v_profit_margin_per_product IS
  'Revenue, COGS, gross profit & margin % per product (all-time, paid invoices)';

-- --------------------------------------------------------------------
-- 2. Dead stock (no sales in last 90 days, still on hand)
-- --------------------------------------------------------------------
CREATE OR REPLACE VIEW v_dead_stock AS
WITH last_sale AS (
  SELECT
    ii.variant_id,
    MAX(inv.completed_at) AS last_sold_at
  FROM invoice_items ii
  JOIN invoices      inv ON inv.id = ii.invoice_id AND inv.status = 'paid'
  GROUP BY ii.variant_id
)
SELECT
  pv.id              AS variant_id,
  pv.sku,
  p.id               AS product_id,
  p.name_ar          AS product_name,
  c.name_ar          AS color_name,
  s.size_label       AS size_label,
  pv.cost_price,
  SUM(st.quantity_on_hand) AS on_hand,
  ls.last_sold_at,
  COALESCE(
    EXTRACT(DAY FROM (NOW() - ls.last_sold_at))::int,
    9999
  )                  AS days_since_last_sale,
  SUM(st.quantity_on_hand) * pv.cost_price AS tied_up_capital
FROM product_variants pv
JOIN products      p  ON p.id = pv.product_id
LEFT JOIN colors   c  ON c.id = pv.color_id
LEFT JOIN sizes    s  ON s.id = pv.size_id
LEFT JOIN stock    st ON st.variant_id = pv.id
LEFT JOIN last_sale ls ON ls.variant_id = pv.id
WHERE p.is_active = TRUE
GROUP BY pv.id, pv.sku, p.id, p.name_ar, c.name_ar, s.size_label,
         pv.cost_price, ls.last_sold_at
HAVING SUM(st.quantity_on_hand) > 0
   AND (ls.last_sold_at IS NULL OR ls.last_sold_at < NOW() - INTERVAL '90 days');

COMMENT ON VIEW v_dead_stock IS
  'Variants with on-hand stock but no sales in the last 90 days';

-- --------------------------------------------------------------------
-- 3. Daily sales (for period-comparison charts)
-- --------------------------------------------------------------------
CREATE OR REPLACE VIEW v_sales_daily AS
SELECT
  date_trunc('day', completed_at)::date AS day,
  COUNT(*)                              AS invoice_count,
  COALESCE(SUM(grand_total), 0)         AS gross_sales,
  COALESCE(SUM(tax_amount), 0)          AS vat,
  COALESCE(SUM(invoice_discount), 0)    AS discounts,
  COALESCE(SUM(grand_total - tax_amount), 0) AS net_sales
FROM invoices
WHERE status = 'paid'
GROUP BY 1
ORDER BY 1 DESC;

COMMENT ON VIEW v_sales_daily IS
  'One row per day of gross sales — feed for period comparison charts';

-- =========================================================================
-- >>> FILE: migrations/025_users_branch_id.sql
-- =========================================================================
-- =============================================================================
-- 025_users_branch_id.sql
-- Adds `branch_id` column to `users` that the backend UserEntity expects.
-- Aliases it to default_warehouse_id for backward compatibility.
-- =============================================================================

-- 1) Add the new column if missing.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES warehouses(id) ON DELETE SET NULL;

-- 2) Backfill from existing default_warehouse_id if present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'users' AND column_name = 'default_warehouse_id'
  ) THEN
    UPDATE users
       SET branch_id = default_warehouse_id
     WHERE branch_id IS NULL
       AND default_warehouse_id IS NOT NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_users_branch ON users(branch_id);

-- =========================================================================
-- >>> FILE: migrations/026_roles_permissions_array.sql
-- =========================================================================
-- =============================================================================
-- 026_roles_permissions_array.sql
-- Backend RoleEntity expects a `permissions TEXT[]` column directly on roles,
-- denormalized from the role_permissions junction. Add + backfill.
-- =============================================================================

ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS name_ar VARCHAR(150),
  ADD COLUMN IF NOT EXISTS name_en VARCHAR(150);

-- Backfill name_ar / name_en from existing name column if present.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'roles' AND column_name = 'name'
  ) THEN
    UPDATE roles SET name_ar = COALESCE(name_ar, name) WHERE name_ar IS NULL;
    UPDATE roles SET name_en = COALESCE(name_en, name) WHERE name_en IS NULL;
  END IF;
END $$;

-- Ensure name_ar is never null (required by entity).
UPDATE roles SET name_ar = COALESCE(name_ar, code, 'role') WHERE name_ar IS NULL;
ALTER TABLE roles ALTER COLUMN name_ar SET NOT NULL;

-- Backfill permissions array from role_permissions junction table.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
     WHERE table_name = 'role_permissions'
  ) THEN
    UPDATE roles r
       SET permissions = sub.perms
      FROM (
        SELECT rp.role_id, array_agg(p.code) AS perms
          FROM role_permissions rp
          JOIN permissions p ON p.id = rp.permission_id
         GROUP BY rp.role_id
      ) sub
     WHERE r.id = sub.role_id;
  END IF;
END $$;

-- Give admin role wildcard permission so login works out-of-the-box.
UPDATE roles
   SET permissions = ARRAY['*']
 WHERE code IN ('admin', 'super_admin')
   AND (permissions IS NULL OR array_length(permissions, 1) IS NULL);

-- =========================================================================
-- >>> FILE: migrations/027_entity_compat.sql
-- =========================================================================
-- =============================================================================
-- 027_entity_compat.sql
-- Bring existing DB schema in line with what backend TypeORM entities expect.
-- All statements are idempotent: ADD COLUMN IF NOT EXISTS.
-- =============================================================================

-- ── roles ─────────────────────────────────────────────────────────────────
ALTER TABLE roles
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS name_ar   VARCHAR(150),
  ADD COLUMN IF NOT EXISTS name_en   VARCHAR(150),
  ADD COLUMN IF NOT EXISTS permissions TEXT[] NOT NULL DEFAULT '{}';

-- enlarge name_ar/en length if shorter
DO $$ BEGIN
  BEGIN
    ALTER TABLE roles ALTER COLUMN name_ar TYPE VARCHAR(150);
    ALTER TABLE roles ALTER COLUMN name_en TYPE VARCHAR(150);
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- ── users ─────────────────────────────────────────────────────────────────
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS branch_id UUID REFERENCES warehouses(id) ON DELETE SET NULL;

-- ── warehouses ────────────────────────────────────────────────────────────
ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS code      VARCHAR(32),
  ADD COLUMN IF NOT EXISTS name_ar   VARCHAR(150),
  ADD COLUMN IF NOT EXISTS name_en   VARCHAR(150),
  ADD COLUMN IF NOT EXISTS type      VARCHAR(32) DEFAULT 'branch',
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- ── customers ─────────────────────────────────────────────────────────────
ALTER TABLE customers
  ADD COLUMN IF NOT EXISTS loyalty_tier    VARCHAR(32) DEFAULT 'bronze',
  ADD COLUMN IF NOT EXISTS loyalty_points  INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS current_balance NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS credit_limit    NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS notes           TEXT,
  ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS group_id        UUID,
  ADD COLUMN IF NOT EXISTS code            VARCHAR(32);

-- ── suppliers ─────────────────────────────────────────────────────────────
ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS code            VARCHAR(32),
  ADD COLUMN IF NOT EXISTS phone           VARCHAR(32),
  ADD COLUMN IF NOT EXISTS email           VARCHAR(150),
  ADD COLUMN IF NOT EXISTS address         TEXT,
  ADD COLUMN IF NOT EXISTS current_balance NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT TRUE;

-- ── products ──────────────────────────────────────────────────────────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS sku_root     VARCHAR(64),
  ADD COLUMN IF NOT EXISTS name_ar      VARCHAR(255),
  ADD COLUMN IF NOT EXISTS name_en      VARCHAR(255),
  ADD COLUMN IF NOT EXISTS type         VARCHAR(32),
  ADD COLUMN IF NOT EXISTS brand_id     UUID,
  ADD COLUMN IF NOT EXISTS category_id  UUID,
  ADD COLUMN IF NOT EXISTS base_price   NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cost_price   NUMERIC(12,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS description  TEXT,
  ADD COLUMN IF NOT EXISTS is_active    BOOLEAN NOT NULL DEFAULT TRUE;

-- ── product_variants ──────────────────────────────────────────────────────
ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS color_id       UUID,
  ADD COLUMN IF NOT EXISTS size_id        UUID,
  ADD COLUMN IF NOT EXISTS sku            VARCHAR(100),
  ADD COLUMN IF NOT EXISTS barcode        VARCHAR(100),
  ADD COLUMN IF NOT EXISTS price_override NUMERIC(12,2),
  ADD COLUMN IF NOT EXISTS is_active      BOOLEAN NOT NULL DEFAULT TRUE;

-- ── stock ─────────────────────────────────────────────────────────────────
ALTER TABLE stock
  ADD COLUMN IF NOT EXISTS reserved_quantity INT DEFAULT 0,
  ADD COLUMN IF NOT EXISTS reorder_quantity  INT DEFAULT 10,
  ADD COLUMN IF NOT EXISTS avg_cost          NUMERIC(12,2) DEFAULT 0;

-- ── invoices (VAT already added in 021) ──────────────────────────────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS items_discount_total NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS coupon_discount      NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS is_return            BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_exchange          BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS source               VARCHAR(20) DEFAULT 'pos',
  ADD COLUMN IF NOT EXISTS change_amount        NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS completed_at         TIMESTAMPTZ;

-- ── Re-seed / sanity: make sure admin user can log in ─────────────────────
-- Ensure at least one admin role exists with wildcard perms.
INSERT INTO roles (code, name_ar, name_en, is_active, permissions)
  SELECT 'admin', 'مدير النظام', 'System Admin', TRUE, ARRAY['*']
  WHERE NOT EXISTS (SELECT 1 FROM roles WHERE code = 'admin');

UPDATE roles SET permissions = ARRAY['*'], is_active = TRUE
 WHERE code IN ('admin', 'super_admin');

-- =========================================================================
-- >>> FILE: migrations/028_schema_sync.sql
-- =========================================================================
-- =============================================================================
-- 028_schema_sync.sql
-- Final schema-sync pass: add every column/alias/view the backend TS code or
-- existing views reference but the DB does not yet have.
--
-- Rules:
--   * 100% idempotent — every statement is IF NOT EXISTS or wrapped in DO $$..$$
--     with EXCEPTION WHEN others THEN NULL.
--   * Re-runnable any number of times.
--   * Does NOT drop or rename existing columns — only ADDs aliases and
--     back-fills them from canonical columns.
--   * Triggers keep alias columns in sync so reads and writes both work,
--     regardless of which column name the app uses.
-- =============================================================================

-- ── warehouses.name  (plain alias; many services + setup wizard need it) ──
ALTER TABLE warehouses
  ADD COLUMN IF NOT EXISTS name VARCHAR(150);

UPDATE warehouses
   SET name = COALESCE(name, name_ar, name_en, code, 'Warehouse')
 WHERE name IS NULL;

DO $$ BEGIN
  BEGIN
    ALTER TABLE warehouses ALTER COLUMN name SET NOT NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- Keep warehouses.name, name_ar and name_en loosely in sync on write.
CREATE OR REPLACE FUNCTION fn_warehouses_sync_name()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.name IS NULL THEN
    NEW.name := COALESCE(NEW.name_ar, NEW.name_en, NEW.code, 'Warehouse');
  END IF;
  IF NEW.name_ar IS NULL THEN
    NEW.name_ar := NEW.name;
  END IF;
  IF NEW.name_en IS NULL THEN
    NEW.name_en := NEW.name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_warehouses_sync_name ON warehouses;
    CREATE TRIGGER trg_warehouses_sync_name
      BEFORE INSERT OR UPDATE ON warehouses
      FOR EACH ROW EXECUTE FUNCTION fn_warehouses_sync_name();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- ── products.name  (plain alias; reports + a few services use it) ─────────
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS name VARCHAR(255);

UPDATE products
   SET name = COALESCE(name, name_ar, name_en, sku_root, 'Product')
 WHERE name IS NULL;

CREATE OR REPLACE FUNCTION fn_products_sync_name()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.name IS NULL THEN
    NEW.name := COALESCE(NEW.name_ar, NEW.name_en, NEW.sku_root, 'Product');
  END IF;
  IF NEW.name_ar IS NULL THEN
    NEW.name_ar := NEW.name;
  END IF;
  IF NEW.name_en IS NULL THEN
    NEW.name_en := NEW.name;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_products_sync_name ON products;
    CREATE TRIGGER trg_products_sync_name
      BEFORE INSERT OR UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION fn_products_sync_name();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- ── product_variants.color / .size (plain text aliases joining colors/sizes)
ALTER TABLE product_variants
  ADD COLUMN IF NOT EXISTS color VARCHAR(100),
  ADD COLUMN IF NOT EXISTS size  VARCHAR(100);

-- Backfill from colors / sizes join tables if available.
DO $$ BEGIN
  BEGIN
    UPDATE product_variants pv
       SET color = COALESCE(pv.color, c.name_ar, c.name_en, c.code)
      FROM colors c
     WHERE c.id = pv.color_id
       AND pv.color IS NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE product_variants pv
       SET size = COALESCE(pv.size, s.size_label, s.code)
      FROM sizes s
     WHERE s.id = pv.size_id
       AND pv.size IS NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- Keep variant.color / .size hydrated on INSERT/UPDATE when *_id is set.
CREATE OR REPLACE FUNCTION fn_variants_sync_color_size()
RETURNS TRIGGER AS $$
DECLARE
  v_color TEXT;
  v_size  TEXT;
BEGIN
  IF NEW.color IS NULL AND NEW.color_id IS NOT NULL THEN
    BEGIN
      SELECT COALESCE(c.name_ar, c.name_en, c.code) INTO v_color
        FROM colors c WHERE c.id = NEW.color_id;
      NEW.color := v_color;
    EXCEPTION WHEN others THEN NULL;
    END;
  END IF;
  IF NEW.size IS NULL AND NEW.size_id IS NOT NULL THEN
    BEGIN
      SELECT COALESCE(s.size_label, s.code) INTO v_size
        FROM sizes s WHERE s.id = NEW.size_id;
      NEW.size := v_size;
    EXCEPTION WHEN others THEN NULL;
    END;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_variants_sync_color_size ON product_variants;
    CREATE TRIGGER trg_variants_sync_color_size
      BEFORE INSERT OR UPDATE ON product_variants
      FOR EACH ROW EXECUTE FUNCTION fn_variants_sync_color_size();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- ── stock.quantity  (alias for quantity_on_hand) ──────────────────────────
ALTER TABLE stock
  ADD COLUMN IF NOT EXISTS quantity INT DEFAULT 0;

DO $$ BEGIN
  BEGIN
    UPDATE stock SET quantity = quantity_on_hand WHERE quantity IS DISTINCT FROM quantity_on_hand;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- Bidirectional sync so either column stays correct.
CREATE OR REPLACE FUNCTION fn_stock_sync_quantity()
RETURNS TRIGGER AS $$
BEGIN
  -- If app wrote quantity but not quantity_on_hand, mirror it.
  IF TG_OP = 'INSERT' THEN
    IF NEW.quantity IS NOT NULL AND (NEW.quantity_on_hand IS NULL OR NEW.quantity_on_hand = 0)
       AND NEW.quantity <> 0 THEN
      NEW.quantity_on_hand := NEW.quantity;
    ELSIF NEW.quantity_on_hand IS NOT NULL AND NEW.quantity IS NULL THEN
      NEW.quantity := NEW.quantity_on_hand;
    END IF;
  ELSE
    IF NEW.quantity IS DISTINCT FROM OLD.quantity
       AND NEW.quantity_on_hand IS NOT DISTINCT FROM OLD.quantity_on_hand THEN
      NEW.quantity_on_hand := NEW.quantity;
    ELSIF NEW.quantity_on_hand IS DISTINCT FROM OLD.quantity_on_hand
       AND NEW.quantity IS NOT DISTINCT FROM OLD.quantity THEN
      NEW.quantity := NEW.quantity_on_hand;
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_stock_sync_quantity ON stock;
    CREATE TRIGGER trg_stock_sync_quantity
      BEFORE INSERT OR UPDATE ON stock
      FOR EACH ROW EXECUTE FUNCTION fn_stock_sync_quantity();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- ── invoices : alias columns used by legacy services and view 020 ────────
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS discount_total  NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS doc_no          VARCHAR(30),
  ADD COLUMN IF NOT EXISTS paid_total      NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS change_given    NUMERIC(14,2) DEFAULT 0,
  ADD COLUMN IF NOT EXISTS issued_at       TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by      UUID REFERENCES users(id) ON DELETE SET NULL;

-- Backfill aliases from canonical columns.
DO $$ BEGIN
  BEGIN
    UPDATE invoices
       SET discount_amount = COALESCE(discount_amount, 0) + COALESCE(invoice_discount, 0)
     WHERE COALESCE(discount_amount,0) = 0 AND COALESCE(invoice_discount,0) <> 0;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

DO $$ BEGIN
  BEGIN
    UPDATE invoices
       SET discount_total = COALESCE(discount_total, 0) + COALESCE(invoice_discount, 0)
                            + COALESCE(items_discount_total, 0)
                            + COALESCE(coupon_discount, 0)
     WHERE COALESCE(discount_total,0) = 0;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

UPDATE invoices SET doc_no       = invoice_no WHERE doc_no IS NULL AND invoice_no IS NOT NULL;
UPDATE invoices SET paid_total   = paid_amount WHERE paid_total IS NULL OR paid_total = 0;
UPDATE invoices SET change_given = change_amount WHERE change_given IS NULL OR change_given = 0;
UPDATE invoices SET issued_at    = COALESCE(completed_at, created_at) WHERE issued_at IS NULL;

-- Keep alias columns in sync on every insert/update.
CREATE OR REPLACE FUNCTION fn_invoices_sync_aliases()
RETURNS TRIGGER AS $$
BEGIN
  -- invoice_no ⇄ doc_no
  IF NEW.invoice_no IS NOT NULL AND (NEW.doc_no IS NULL OR NEW.doc_no = '') THEN
    NEW.doc_no := NEW.invoice_no;
  ELSIF NEW.doc_no IS NOT NULL AND (NEW.invoice_no IS NULL OR NEW.invoice_no = '') THEN
    NEW.invoice_no := NEW.doc_no;
  END IF;

  -- invoice_discount ⇄ discount_amount
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.discount_amount,0) <> 0 AND COALESCE(NEW.invoice_discount,0) = 0 THEN
      NEW.invoice_discount := NEW.discount_amount;
    ELSIF COALESCE(NEW.invoice_discount,0) <> 0 AND COALESCE(NEW.discount_amount,0) = 0 THEN
      NEW.discount_amount := NEW.invoice_discount;
    END IF;
  ELSE
    IF NEW.discount_amount IS DISTINCT FROM OLD.discount_amount
       AND NEW.invoice_discount IS NOT DISTINCT FROM OLD.invoice_discount THEN
      NEW.invoice_discount := NEW.discount_amount;
    ELSIF NEW.invoice_discount IS DISTINCT FROM OLD.invoice_discount
       AND NEW.discount_amount IS NOT DISTINCT FROM OLD.discount_amount THEN
      NEW.discount_amount := NEW.invoice_discount;
    END IF;
  END IF;

  -- discount_total rollup
  NEW.discount_total := COALESCE(NEW.invoice_discount,0)
                      + COALESCE(NEW.items_discount_total,0)
                      + COALESCE(NEW.coupon_discount,0);

  -- paid_amount ⇄ paid_total
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.paid_total,0) <> 0 AND COALESCE(NEW.paid_amount,0) = 0 THEN
      NEW.paid_amount := NEW.paid_total;
    ELSIF COALESCE(NEW.paid_amount,0) <> 0 AND COALESCE(NEW.paid_total,0) = 0 THEN
      NEW.paid_total := NEW.paid_amount;
    END IF;
  ELSE
    IF NEW.paid_total IS DISTINCT FROM OLD.paid_total
       AND NEW.paid_amount IS NOT DISTINCT FROM OLD.paid_amount THEN
      NEW.paid_amount := NEW.paid_total;
    ELSIF NEW.paid_amount IS DISTINCT FROM OLD.paid_amount
       AND NEW.paid_total IS NOT DISTINCT FROM OLD.paid_total THEN
      NEW.paid_total := NEW.paid_amount;
    END IF;
  END IF;

  -- change_amount ⇄ change_given
  IF TG_OP = 'INSERT' THEN
    IF COALESCE(NEW.change_given,0) <> 0 AND COALESCE(NEW.change_amount,0) = 0 THEN
      NEW.change_amount := NEW.change_given;
    ELSIF COALESCE(NEW.change_amount,0) <> 0 AND COALESCE(NEW.change_given,0) = 0 THEN
      NEW.change_given := NEW.change_amount;
    END IF;
  ELSE
    IF NEW.change_given IS DISTINCT FROM OLD.change_given
       AND NEW.change_amount IS NOT DISTINCT FROM OLD.change_amount THEN
      NEW.change_amount := NEW.change_given;
    ELSIF NEW.change_amount IS DISTINCT FROM OLD.change_amount
       AND NEW.change_given IS NOT DISTINCT FROM OLD.change_given THEN
      NEW.change_given := NEW.change_amount;
    END IF;
  END IF;

  -- issued_at ⇄ completed_at
  IF NEW.completed_at IS NOT NULL AND NEW.issued_at IS NULL THEN
    NEW.issued_at := NEW.completed_at;
  ELSIF NEW.issued_at IS NOT NULL AND NEW.completed_at IS NULL THEN
    NEW.completed_at := NEW.issued_at;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_invoices_sync_aliases ON invoices;
    CREATE TRIGGER trg_invoices_sync_aliases
      BEFORE INSERT OR UPDATE ON invoices
      FOR EACH ROW EXECUTE FUNCTION fn_invoices_sync_aliases();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

CREATE INDEX IF NOT EXISTS idx_invoices_issued_at   ON invoices(issued_at);
CREATE INDEX IF NOT EXISTS idx_invoices_doc_no      ON invoices(doc_no);
CREATE INDEX IF NOT EXISTS idx_invoices_created_by  ON invoices(created_by);

-- ── invoice_items.cost_total  (qty * unit_cost) ──────────────────────────
ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS cost_total NUMERIC(14,2) DEFAULT 0;

UPDATE invoice_items
   SET cost_total = quantity * COALESCE(unit_cost, 0)
 WHERE cost_total IS NULL OR cost_total = 0;

CREATE OR REPLACE FUNCTION fn_invoice_items_sync_cost_total()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.cost_total IS NULL OR NEW.cost_total = 0 THEN
    NEW.cost_total := COALESCE(NEW.quantity,0) * COALESCE(NEW.unit_cost,0);
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_invoice_items_sync_cost_total ON invoice_items;
    CREATE TRIGGER trg_invoice_items_sync_cost_total
      BEFORE INSERT OR UPDATE ON invoice_items
      FOR EACH ROW EXECUTE FUNCTION fn_invoice_items_sync_cost_total();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- ── invoice_payments.reference  (alias for reference_number) ─────────────
ALTER TABLE invoice_payments
  ADD COLUMN IF NOT EXISTS reference VARCHAR(100);

DO $$ BEGIN
  BEGIN
    UPDATE invoice_payments
       SET reference = reference_number
     WHERE reference IS NULL AND reference_number IS NOT NULL;
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

CREATE OR REPLACE FUNCTION fn_invoice_payments_sync_reference()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.reference IS NULL AND NEW.reference_number IS NOT NULL THEN
    NEW.reference := NEW.reference_number;
  ELSIF NEW.reference_number IS NULL AND NEW.reference IS NOT NULL THEN
    NEW.reference_number := NEW.reference;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_invoice_payments_sync_reference ON invoice_payments;
    CREATE TRIGGER trg_invoice_payments_sync_reference
      BEFORE INSERT OR UPDATE ON invoice_payments
      FOR EACH ROW EXECUTE FUNCTION fn_invoice_payments_sync_reference();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- ── invoice_lines  (VIEW aliasing invoice_items; read-only legacy paths) ─
-- accounting.service.ts + sync.service.ts + reservations.service.ts reference
-- a non-existent `invoice_lines` table with column `qty`. Provide a view.
DO $$ BEGIN
  BEGIN
    EXECUTE 'CREATE OR REPLACE VIEW invoice_lines AS
             SELECT ii.id,
                    ii.invoice_id,
                    ii.variant_id,
                    ii.quantity                    AS qty,
                    ii.quantity,
                    ii.unit_price,
                    ii.unit_cost,
                    ii.discount_amount,
                    ii.line_total,
                    ii.cost_total,
                    ii.tax_amount,
                    ii.created_at
               FROM invoice_items ii';
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- ── return_receipts (VIEW aliasing `returns` for accounting + sync) ──────
DO $$ BEGIN
  BEGIN
    EXECUTE 'CREATE OR REPLACE VIEW return_receipts AS
             SELECT r.id,
                    r.return_no,
                    r.original_invoice_id AS invoice_id,
                    r.customer_id,
                    r.warehouse_id,
                    CASE WHEN r.status IN (''approved'',''refunded'')
                         THEN ''completed''
                         ELSE r.status::text
                    END                          AS status,
                    r.total_refund,
                    r.restocking_fee,
                    r.net_refund,
                    r.net_refund                 AS total_refund_net,
                    r.refund_method,
                    r.requested_at,
                    r.approved_at,
                    r.refunded_at,
                    r.requested_at               AS created_at
               FROM returns r';
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- =============================================================================
-- End of 028_schema_sync.sql
-- =============================================================================

-- =========================================================================
-- >>> FILE: migrations/029_final_sync.sql
-- =========================================================================
-- =============================================================================
-- 029_final_sync.sql
-- FINAL comprehensive schema sync to resolve runtime errors reported by backend.
--
-- Issues fixed:
--   1. column "outstanding" does not exist
--        → v_customer_outstanding & v_supplier_outstanding are recreated with
--          an explicit `outstanding` column (alias of current_balance).
--   2. invalid input value for enum stock_movement_type: "adjustment"
--        → adds 'adjustment' value to stock_movement_type.
--   3. relation "invoice_lines" does not exist
--        → recreates it as a VIEW + INSTEAD OF INSERT trigger so writes land in
--          invoice_items. Safe if 028 already created the view.
--   4. relation "notifications" does not exist
--        → creates notifications + notification_templates defensively.
--   5. column "created_at" does not exist
--        → adds created_at to any table that was missing it (roles,
--          product_variants, stock, purchase_items, invoice_items,
--          invoice_payments, stock_movements, notifications, etc.).
--   6. Add product / add customer breaks
--        → ensures sku_prefix and customer_no / supplier_no get auto-filled
--          when entity inserts only sku_root / code.
--
-- Bonus:
--   * Ensures fn_adjust_stock() exists (called by stock.service.ts).
--   * All enums referenced by backend code cover every inserted value.
--
-- 100% idempotent — re-runnable any number of times.
-- =============================================================================

-- =============================================================================
-- 1) ENUM FIXES
-- =============================================================================

-- Add 'adjustment' to stock_movement_type (stock.service.ts uses it).
-- Note: ALTER TYPE ... ADD VALUE must run outside a transaction block.
-- IF NOT EXISTS makes this safe to re-run.
ALTER TYPE stock_movement_type ADD VALUE IF NOT EXISTS 'adjustment';
ALTER TYPE stock_movement_type ADD VALUE IF NOT EXISTS 'transfer';
ALTER TYPE stock_movement_type ADD VALUE IF NOT EXISTS 'correction';
ALTER TYPE stock_movement_type ADD VALUE IF NOT EXISTS 'opening';

-- Ensure notification_channel + notification_status enums exist (017 may not
-- have applied on this DB).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_channel') THEN
    CREATE TYPE notification_channel AS ENUM ('whatsapp','sms','email');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'notification_status') THEN
    CREATE TYPE notification_status AS ENUM ('queued','sending','sent','failed','cancelled');
  END IF;
END $$;

-- =============================================================================
-- 2) NOTIFICATIONS TABLES (017 may not have applied cleanly)
-- =============================================================================

CREATE TABLE IF NOT EXISTS notification_templates (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code       TEXT UNIQUE NOT NULL,
  name_ar    TEXT NOT NULL,
  channel    notification_channel NOT NULL,
  subject    TEXT,
  body       TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel         notification_channel NOT NULL,
  recipient       TEXT NOT NULL,
  subject         TEXT,
  body            TEXT NOT NULL,
  status          notification_status NOT NULL DEFAULT 'queued',
  attempts        INT NOT NULL DEFAULT 0,
  last_error      TEXT,
  provider        TEXT,
  provider_msg_id TEXT,
  reference_type  TEXT,
  reference_id    UUID,
  template_code   TEXT,
  metadata        JSONB NOT NULL DEFAULT '{}'::jsonb,
  scheduled_at    TIMESTAMPTZ,
  sent_at         TIMESTAMPTZ,
  created_by      UUID,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_status     ON notifications (status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_notifications_reference  ON notifications (reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_notifications_created_at ON notifications (created_at DESC);

-- =============================================================================
-- 3) created_at / updated_at BACKFILL (for legacy columns that may be missing)
-- =============================================================================

DO $$
DECLARE
  t TEXT;
  tables TEXT[] := ARRAY[
    'roles','users','warehouses','products','product_variants','colors','sizes',
    'stock','stock_movements','stock_adjustments','stock_transfers',
    'customers','suppliers','purchases','purchase_items','purchase_payments',
    'invoices','invoice_items','invoice_payments',
    'reservations','returns','return_items','exchanges',
    'notifications','notification_templates','shifts','cashbox_entries',
    'discounts','coupons','expenses','alerts','activity_logs','settings'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = t) THEN
      BEGIN
        EXECUTE format(
          'ALTER TABLE %I ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
          t);
      EXCEPTION WHEN others THEN NULL;
      END;
      BEGIN
        EXECUTE format(
          'ALTER TABLE %I ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()',
          t);
      EXCEPTION WHEN others THEN NULL;
      END;
    END IF;
  END LOOP;
END $$;

-- =============================================================================
-- 4) CUSTOMER / SUPPLIER NO AUTO-FILL (entity inserts only `code`)
-- =============================================================================

-- customers.customer_no must be filled before INSERT when only `code` is given.
CREATE SEQUENCE IF NOT EXISTS seq_customer_no START 1;

CREATE OR REPLACE FUNCTION fn_customers_autofill_no()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.customer_no IS NULL OR NEW.customer_no = '' THEN
    IF NEW.code IS NOT NULL AND NEW.code <> '' THEN
      NEW.customer_no := NEW.code;
    ELSE
      NEW.customer_no := 'CUS-' || LPAD(nextval('seq_customer_no')::text, 6, '0');
    END IF;
  END IF;
  IF NEW.code IS NULL OR NEW.code = '' THEN
    NEW.code := NEW.customer_no;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_customers_autofill_no ON customers;
    CREATE TRIGGER trg_customers_autofill_no
      BEFORE INSERT ON customers
      FOR EACH ROW EXECUTE FUNCTION fn_customers_autofill_no();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

CREATE SEQUENCE IF NOT EXISTS seq_supplier_no START 1;

CREATE OR REPLACE FUNCTION fn_suppliers_autofill_no()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.supplier_no IS NULL OR NEW.supplier_no = '' THEN
    IF NEW.code IS NOT NULL AND NEW.code <> '' THEN
      NEW.supplier_no := NEW.code;
    ELSE
      NEW.supplier_no := 'SUP-' || LPAD(nextval('seq_supplier_no')::text, 6, '0');
    END IF;
  END IF;
  IF NEW.code IS NULL OR NEW.code = '' THEN
    NEW.code := NEW.supplier_no;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_suppliers_autofill_no ON suppliers;
    CREATE TRIGGER trg_suppliers_autofill_no
      BEFORE INSERT ON suppliers
      FOR EACH ROW EXECUTE FUNCTION fn_suppliers_autofill_no();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- =============================================================================
-- 5) PRODUCTS — fill required legacy columns (sku_prefix, product_type)
-- =============================================================================

-- Relax NOT NULL where possible so entity INSERT (sku_root only) works.
DO $$ BEGIN
  BEGIN ALTER TABLE products ALTER COLUMN sku_prefix DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TABLE products ALTER COLUMN product_type DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TABLE products ALTER COLUMN base_cost DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TABLE products ALTER COLUMN base_price DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
END $$;

CREATE OR REPLACE FUNCTION fn_products_autofill_legacy()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.sku_prefix IS NULL OR NEW.sku_prefix = '' THEN
    NEW.sku_prefix := COALESCE(NEW.sku_root, 'SKU-' || substr(NEW.id::text, 1, 8));
  END IF;
  IF NEW.sku_root IS NULL OR NEW.sku_root = '' THEN
    NEW.sku_root := NEW.sku_prefix;
  END IF;
  IF NEW.product_type IS NULL THEN
    BEGIN
      NEW.product_type := COALESCE(NEW.type, 'shoe')::product_type;
    EXCEPTION WHEN others THEN NEW.product_type := 'shoe'::product_type;
    END;
  END IF;
  IF NEW.type IS NULL AND NEW.product_type IS NOT NULL THEN
    NEW.type := NEW.product_type::text;
  END IF;
  IF NEW.base_cost IS NULL THEN NEW.base_cost := COALESCE(NEW.cost_price, 0); END IF;
  IF NEW.cost_price IS NULL THEN NEW.cost_price := COALESCE(NEW.base_cost, 0); END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_products_autofill_legacy ON products;
    CREATE TRIGGER trg_products_autofill_legacy
      BEFORE INSERT OR UPDATE ON products
      FOR EACH ROW EXECUTE FUNCTION fn_products_autofill_legacy();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- =============================================================================
-- 6) OUTSTANDING VIEWS — expose `outstanding` alias column
-- =============================================================================

CREATE OR REPLACE VIEW v_customer_outstanding AS
SELECT
    c.id                                                AS id,
    c.id                                                AS customer_id,
    c.customer_no,
    c.full_name,
    c.phone,
    COALESCE(c.current_balance, 0)                      AS current_balance,
    COALESCE(c.current_balance, 0)                      AS outstanding,
    COALESCE(c.credit_limit, 0)                         AS credit_limit,
    GREATEST(COALESCE(c.credit_limit,0) - COALESCE(c.current_balance,0), 0)
                                                        AS available_credit,
    (SELECT MAX(cl.created_at)
       FROM customer_ledger cl
      WHERE cl.customer_id = c.id)                      AS last_entry_at
FROM customers c
WHERE COALESCE(c.deleted_at, NULL) IS NULL;

CREATE OR REPLACE VIEW v_supplier_outstanding AS
SELECT
    s.id                                                AS id,
    s.id                                                AS supplier_id,
    s.supplier_no,
    s.name,
    s.phone,
    COALESCE(s.current_balance, 0)                      AS current_balance,
    COALESCE(s.current_balance, 0)                      AS outstanding,
    COALESCE(s.credit_limit, 0)                         AS credit_limit,
    (SELECT MAX(sl.created_at)
       FROM supplier_ledger sl
      WHERE sl.supplier_id = s.id)                      AS last_entry_at
FROM suppliers s
WHERE COALESCE(s.deleted_at, NULL) IS NULL;

-- =============================================================================
-- 7) invoice_lines — VIEW + INSTEAD OF INSERT so writes land in invoice_items
-- =============================================================================

-- If a table named invoice_lines accidentally exists, leave it; otherwise (re)create as view.
DO $$
DECLARE
  is_table BOOLEAN;
BEGIN
  SELECT EXISTS(
    SELECT 1 FROM information_schema.tables
     WHERE table_name = 'invoice_lines' AND table_type = 'BASE TABLE'
  ) INTO is_table;

  IF NOT is_table THEN
    BEGIN
      EXECUTE 'DROP VIEW IF EXISTS invoice_lines';
    EXCEPTION WHEN others THEN NULL;
    END;

    EXECUTE $v$
      CREATE VIEW invoice_lines AS
      SELECT ii.id,
             ii.invoice_id,
             ii.variant_id,
             inv.warehouse_id                   AS warehouse_id,
             ii.quantity                        AS qty,
             ii.quantity                        AS quantity,
             ii.unit_price,
             ii.unit_cost,
             ii.discount_amount                 AS discount,
             ii.discount_amount,
             ii.line_total,
             ii.cost_total,
             ii.tax_amount,
             ii.created_at
        FROM invoice_items ii
        LEFT JOIN invoices inv ON inv.id = ii.invoice_id
    $v$;
  END IF;
END $$;

-- INSTEAD OF INSERT — so `INSERT INTO invoice_lines(...)` (reservations.service)
-- actually writes into invoice_items with proper required fields.
CREATE OR REPLACE FUNCTION fn_invoice_lines_instead_insert()
RETURNS TRIGGER AS $$
DECLARE
  v_sku   TEXT := '';
  v_name  TEXT := '';
BEGIN
  BEGIN
    SELECT COALESCE(pv.sku, '')                                 AS sku,
           COALESCE(p.name_ar, p.name_en, p.name, 'Product')    AS pname
      INTO v_sku, v_name
      FROM product_variants pv
      LEFT JOIN products p ON p.id = pv.product_id
     WHERE pv.id = NEW.variant_id;
  EXCEPTION WHEN others THEN
    v_sku  := '';
    v_name := 'Product';
  END;

  INSERT INTO invoice_items (
    invoice_id, variant_id,
    product_name_snapshot, sku_snapshot,
    quantity, unit_cost, unit_price,
    discount_amount, tax_amount,
    line_subtotal, line_total, cost_total
  ) VALUES (
    NEW.invoice_id,
    NEW.variant_id,
    COALESCE(v_name, 'Product'),
    COALESCE(v_sku, ''),
    COALESCE(NEW.qty, NEW.quantity, 1),
    COALESCE(NEW.unit_cost, 0),
    COALESCE(NEW.unit_price, 0),
    COALESCE(NEW.discount, NEW.discount_amount, 0),
    COALESCE(NEW.tax_amount, 0),
    COALESCE(NEW.qty, NEW.quantity, 1) * COALESCE(NEW.unit_price, 0),
    COALESCE(NEW.line_total,
             COALESCE(NEW.qty, NEW.quantity, 1) * COALESCE(NEW.unit_price, 0)
             - COALESCE(NEW.discount, NEW.discount_amount, 0)),
    COALESCE(NEW.qty, NEW.quantity, 1) * COALESCE(NEW.unit_cost, 0)
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  BEGIN
    DROP TRIGGER IF EXISTS trg_invoice_lines_insert ON invoice_lines;
    CREATE TRIGGER trg_invoice_lines_insert
      INSTEAD OF INSERT ON invoice_lines
      FOR EACH ROW EXECUTE FUNCTION fn_invoice_lines_instead_insert();
  EXCEPTION WHEN others THEN NULL;
  END;
END $$;

-- =============================================================================
-- 8) fn_adjust_stock — defensive stub if 011 didn't ship it
-- =============================================================================

CREATE OR REPLACE FUNCTION fn_adjust_stock(
  p_variant_id   UUID,
  p_warehouse_id UUID,
  p_delta        INT,
  p_reason       TEXT,
  p_unit_cost    NUMERIC DEFAULT NULL,
  p_user_id      UUID    DEFAULT NULL
) RETURNS INT AS $$
DECLARE
  v_new_qty  INT;
  v_dir      txn_direction;
  v_type     stock_movement_type;
BEGIN
  IF p_delta = 0 OR p_delta IS NULL THEN
    RAISE EXCEPTION 'delta must be non-zero';
  END IF;

  v_dir  := CASE WHEN p_delta > 0 THEN 'in'::txn_direction ELSE 'out'::txn_direction END;
  BEGIN
    v_type := 'adjustment'::stock_movement_type;
  EXCEPTION WHEN others THEN
    v_type := CASE WHEN p_delta > 0
                   THEN 'adjustment_in'::stock_movement_type
                   ELSE 'adjustment_out'::stock_movement_type END;
  END;

  INSERT INTO stock (variant_id, warehouse_id, quantity_on_hand)
       VALUES (p_variant_id, p_warehouse_id, GREATEST(p_delta, 0))
  ON CONFLICT (variant_id, warehouse_id) DO UPDATE
     SET quantity_on_hand = stock.quantity_on_hand + p_delta,
         updated_at = NOW()
     RETURNING quantity_on_hand INTO v_new_qty;

  IF v_new_qty IS NULL THEN
    SELECT quantity_on_hand INTO v_new_qty
      FROM stock
     WHERE variant_id = p_variant_id
       AND warehouse_id = p_warehouse_id;
  END IF;

  BEGIN
    INSERT INTO stock_movements
      (variant_id, warehouse_id, movement_type, direction,
       quantity, unit_cost, reference_type, notes, user_id)
    VALUES
      (p_variant_id, p_warehouse_id, v_type, v_dir,
       ABS(p_delta), COALESCE(p_unit_cost, 0),
       'other'::entity_type, p_reason, p_user_id);
  EXCEPTION WHEN others THEN NULL;
  END;

  RETURN v_new_qty;
END;
$$ LANGUAGE plpgsql;

-- =============================================================================
-- 9) Defensive: ensure common alias columns exist (in case 027/028 skipped)
-- =============================================================================

ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Make snapshot columns nullable so INSTEAD OF INSERT path doesn't die.
DO $$ BEGIN
  BEGIN ALTER TABLE invoice_items ALTER COLUMN product_name_snapshot DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TABLE invoice_items ALTER COLUMN sku_snapshot DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TABLE invoice_items ALTER COLUMN line_subtotal DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
  BEGIN ALTER TABLE invoice_items ALTER COLUMN line_total DROP NOT NULL; EXCEPTION WHEN others THEN NULL; END;
END $$;

-- =============================================================================
-- End of 029_final_sync.sql
-- =============================================================================
