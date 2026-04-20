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
