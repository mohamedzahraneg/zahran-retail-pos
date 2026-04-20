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
