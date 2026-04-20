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
