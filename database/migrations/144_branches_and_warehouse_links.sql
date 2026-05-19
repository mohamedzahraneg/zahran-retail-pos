-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Migration 144 : Branches & Warehouse Links
--                          (PR-BRANCHES-WAREHOUSES-FOUNDATION)
--
--  WHAT THIS DOES
--    Adds two NEW tables + four NEW columns to support a multi-branch
--    organisation model while keeping the existing `warehouses`
--    semantics 100 % intact:
--
--      · branches                  — organisational unit (retail
--                                    branch / online / mobile / etc).
--      · warehouse_branches        — many-to-many link between an
--                                    existing warehouse and one or
--                                    more branches, with a
--                                    one-primary-per-warehouse rule.
--
--    Then ALTER warehouses to add four convenience columns:
--        warehouse_type        VARCHAR(32)
--        is_sellable           BOOLEAN  DEFAULT TRUE
--        allow_negative_stock  BOOLEAN  DEFAULT FALSE
--        sort_order            INT      DEFAULT 0
--    The legacy columns (`type`, `is_main`, `is_retail`) are left
--    untouched — every existing caller still works.
--
--    Finally, a tiny idempotent backfill creates ONE branch per
--    existing warehouse (matching code, ar/en names, retail/warehouse
--    type) and links it as `is_primary = TRUE` — so every warehouse
--    immediately has a "home" branch and no UI code needs to handle a
--    branch-less state.
--
--  WHAT THIS DOES NOT DO
--    * No schema change to `stock`, `stock_movements`, `invoices`,
--      `invoice_items`, `purchases`, `purchase_items`,
--      `stock_transfers`, `inventory_counts`, `returns`,
--      `cashboxes`, journal entries, or any other write surface.
--    * No mutation of warehouse rows beyond the four new columns'
--      defaults — code/name/type/is_active stay byte-for-byte.
--    * No change to `warehouse_id` semantics in any caller table.
--    * No drop / rename / re-typing of existing columns.
--    * No triggers, no views, no functions.
--    * No tenant_id yet — see TODOs below.
--    * No RLS yet — admin-gated at the API layer only.
--
--  TENANT-READINESS TODOs (deferred until tenant foundation lands)
--    TODO(multi-tenant): `branches.tenant_id UUID NOT NULL REFERENCES
--      tenants(id)` and the UNIQUE constraint on `branches.code`
--      becomes UNIQUE (tenant_id, code).
--    TODO(multi-tenant): `warehouse_branches` will either inherit
--      tenant_id from `branches` or carry it explicitly with a
--      tenant-scoped FK pair. The primary-branch partial index will
--      become UNIQUE (tenant_id, warehouse_id) WHERE is_primary.
--    TODO(rls): enable row-level security on `branches` +
--      `warehouse_branches` once tenants ship.
-- ============================================================================

-- ---------- branches ----------
CREATE TABLE IF NOT EXISTS branches (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    code              VARCHAR(32) NOT NULL,
    name_ar           VARCHAR(160) NOT NULL,
    name_en           VARCHAR(160),
    type              VARCHAR(32) NOT NULL DEFAULT 'retail',
    parent_branch_id  UUID REFERENCES branches(id) ON DELETE SET NULL,
    manager_id        UUID REFERENCES users(id)    ON DELETE SET NULL,
    address           TEXT,
    phone             VARCHAR(40),
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent CHECK on branches.type — the named constraint lets us
-- detect / replace cleanly on re-run.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'branches_type_check'
    ) THEN
        ALTER TABLE branches
            ADD CONSTRAINT branches_type_check
            CHECK (type IN (
                'retail',
                'warehouse',
                'online',
                'mobile',
                'virtual',
                'head_office'
            ));
    END IF;
END $$;

-- TODO(multi-tenant): replace with UNIQUE (tenant_id, code).
CREATE UNIQUE INDEX IF NOT EXISTS uq_branches_code
    ON branches(code);

CREATE INDEX IF NOT EXISTS idx_branches_active
    ON branches(is_active);

-- ---------- warehouse_branches (M:M link) ----------
CREATE TABLE IF NOT EXISTS warehouse_branches (
    warehouse_id  UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
    branch_id     UUID NOT NULL REFERENCES branches(id)   ON DELETE CASCADE,
    is_primary    BOOLEAN NOT NULL DEFAULT FALSE,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (warehouse_id, branch_id)
);

-- Each warehouse has AT MOST one primary branch — partial unique
-- index over warehouse_id where is_primary = TRUE.
CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouse_branches_primary
    ON warehouse_branches(warehouse_id) WHERE is_primary = TRUE;

CREATE INDEX IF NOT EXISTS idx_warehouse_branches_branch
    ON warehouse_branches(branch_id);

-- ---------- warehouses : additive columns ----------
ALTER TABLE warehouses
    ADD COLUMN IF NOT EXISTS warehouse_type        VARCHAR(32);
ALTER TABLE warehouses
    ADD COLUMN IF NOT EXISTS is_sellable           BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE warehouses
    ADD COLUMN IF NOT EXISTS allow_negative_stock  BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE warehouses
    ADD COLUMN IF NOT EXISTS sort_order            INTEGER NOT NULL DEFAULT 0;

-- ---------- backfill : one branch per existing warehouse ----------
-- Pure organisational metadata. NO touch of:
--   stock, stock_movements, invoices, purchases, returns,
--   stock_transfers, inventory_counts, cashboxes, journal_entries.
--
-- Idempotency:
--   · The branches INSERT skips warehouses whose code is already
--     present in branches (NOT EXISTS).
--   · The warehouse_branches INSERT uses ON CONFLICT DO NOTHING
--     on the (warehouse_id, branch_id) primary key.

-- 1) create a branch per warehouse if missing
INSERT INTO branches (code, name_ar, name_en, type, is_active)
SELECT
    w.code,
    COALESCE(w.name_ar, w.name, w.code, 'فرع'),
    w.name_en,
    CASE WHEN COALESCE(w.is_retail, FALSE) THEN 'retail' ELSE 'warehouse' END,
    COALESCE(w.is_active, TRUE)
FROM warehouses w
WHERE w.code IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM branches b WHERE b.code = w.code
  );

-- 2) link each warehouse to the branch with matching code as primary.
--    We avoid duplicate rows via ON CONFLICT and only promote the
--    backfilled link to is_primary if NO primary already exists for
--    that warehouse (NOT EXISTS guard).
INSERT INTO warehouse_branches (warehouse_id, branch_id, is_primary)
SELECT
    w.id,
    b.id,
    NOT EXISTS (
        SELECT 1 FROM warehouse_branches wb2
         WHERE wb2.warehouse_id = w.id
           AND wb2.is_primary = TRUE
    ) AS is_primary
FROM warehouses w
JOIN branches b ON b.code = w.code
ON CONFLICT (warehouse_id, branch_id) DO NOTHING;

-- ---------- documentation row ----------
COMMENT ON TABLE branches IS
    'Organisational units (retail / warehouse / online / mobile / virtual / head_office). '
    'Linked to warehouses many-to-many via warehouse_branches.';

COMMENT ON TABLE warehouse_branches IS
    'Many-to-many link between warehouses and branches with a single '
    'primary branch per warehouse (enforced by partial unique index).';

COMMENT ON COLUMN warehouses.warehouse_type IS
    'Optional fine-grained warehouse classification '
    '(main / branch / retail_floor / returns / damaged / online / reserved / transit / temporary). '
    'Additive — does NOT replace the legacy `type` / `is_main` / `is_retail` columns.';

COMMENT ON COLUMN warehouses.is_sellable IS
    'Whether POS / online channels may sell from this warehouse. '
    'Default TRUE for backwards compatibility.';

COMMENT ON COLUMN warehouses.allow_negative_stock IS
    'Per-warehouse override for the system-wide negative-stock policy. '
    'Default FALSE — explicit opt-in only.';
