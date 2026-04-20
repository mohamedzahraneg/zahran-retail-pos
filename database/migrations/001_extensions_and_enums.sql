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
