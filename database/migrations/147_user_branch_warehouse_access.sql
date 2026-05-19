-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Migration 147 : User branch/warehouse access
--                          (PR-USER-BRANCH-WAREHOUSE-ACCESS)
--
--  WHAT THIS DOES
--    Adds two new tables that let an admin scope which branches and
--    which warehouses each user is allowed to see / operate on, plus
--    an idempotent backfill that gives every existing ACTIVE user
--    `view` access to every existing branch + warehouse. Existing
--    users therefore see exactly what they saw before — enforcement
--    in this PR is read-side filtering only, with an explicit
--    fallback-allow-all rule when a user has zero access rows.
--
--      · user_branch_access
--          (user_id, branch_id) PK
--          access_level  view | operate | manage | admin
--          is_default    one default branch per user (partial unique)
--
--      · user_warehouse_access
--          (user_id, warehouse_id) PK
--          access_level  view | operate | manage | admin
--          is_default    one default warehouse per user (partial unique)
--
--  WHAT THIS DOES NOT DO
--    * No schema change to `users`, `roles`, `permissions`,
--      `branches`, `warehouses`, `warehouse_branches`.
--    * No mutation of any existing data row beyond the additive
--      backfill INSERTs (all `ON CONFLICT DO NOTHING`).
--    * No touches to `stock`, `stock_movements`, `invoices`,
--      `purchases`, `returns`, accounting / cashbox / GL tables.
--    * No triggers / views / functions.
--    * No tenant_id / RLS work.
--
--  TENANT-READINESS TODOs
--    TODO(multi-tenant): `user_branch_access.tenant_id` and
--    `user_warehouse_access.tenant_id` will inherit from the joined
--    `branches.tenant_id` / `warehouses.tenant_id` once the tenant
--    foundation ships. The `is_default` partial unique indexes will
--    become `(tenant_id, user_id) WHERE is_default = TRUE` then.
-- ============================================================================

-- ---------- user_branch_access ----------
CREATE TABLE IF NOT EXISTS user_branch_access (
    user_id      UUID NOT NULL REFERENCES users(id)     ON DELETE CASCADE,
    branch_id    UUID NOT NULL REFERENCES branches(id)  ON DELETE CASCADE,
    access_level VARCHAR(16) NOT NULL DEFAULT 'view',
    is_default   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, branch_id)
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_branch_access_level_check'
    ) THEN
        ALTER TABLE user_branch_access
            ADD CONSTRAINT user_branch_access_level_check
            CHECK (access_level IN ('view', 'operate', 'manage', 'admin'));
    END IF;
END $$;

-- TODO(multi-tenant): becomes UNIQUE (tenant_id, user_id) WHERE is_default = TRUE.
CREATE UNIQUE INDEX IF NOT EXISTS uq_user_branch_access_default
    ON user_branch_access(user_id) WHERE is_default = TRUE;

CREATE INDEX IF NOT EXISTS idx_user_branch_access_branch
    ON user_branch_access(branch_id);

-- ---------- user_warehouse_access ----------
CREATE TABLE IF NOT EXISTS user_warehouse_access (
    user_id      UUID NOT NULL REFERENCES users(id)       ON DELETE CASCADE,
    warehouse_id UUID NOT NULL REFERENCES warehouses(id)  ON DELETE CASCADE,
    access_level VARCHAR(16) NOT NULL DEFAULT 'view',
    is_default   BOOLEAN     NOT NULL DEFAULT FALSE,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    PRIMARY KEY (user_id, warehouse_id)
);

DO $$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint WHERE conname = 'user_warehouse_access_level_check'
    ) THEN
        ALTER TABLE user_warehouse_access
            ADD CONSTRAINT user_warehouse_access_level_check
            CHECK (access_level IN ('view', 'operate', 'manage', 'admin'));
    END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_user_warehouse_access_default
    ON user_warehouse_access(user_id) WHERE is_default = TRUE;

CREATE INDEX IF NOT EXISTS idx_user_warehouse_access_warehouse
    ON user_warehouse_access(warehouse_id);

-- ---------- backfill : view access for every active user × every active surface ----------
-- Idempotent: ON CONFLICT DO NOTHING + the partial-unique default
-- index protects the "one default" invariant when re-run.

-- 1) Branch view access for every (active user, active branch) pair
INSERT INTO user_branch_access (user_id, branch_id, access_level, is_default)
SELECT u.id, b.id, 'view', FALSE
  FROM users u
  CROSS JOIN branches b
 WHERE u.is_active = TRUE
   AND b.is_active = TRUE
ON CONFLICT (user_id, branch_id) DO NOTHING;

-- 2) Warehouse view access for every (active user, active warehouse) pair
INSERT INTO user_warehouse_access (user_id, warehouse_id, access_level, is_default)
SELECT u.id, w.id, 'view', FALSE
  FROM users u
  CROSS JOIN warehouses w
 WHERE u.is_active = TRUE
   AND w.is_active = TRUE
ON CONFLICT (user_id, warehouse_id) DO NOTHING;

-- 3) Default warehouse — prefer users.default_warehouse_id when set
--    and matching an existing access row, otherwise fall back to the
--    first active warehouse the user can see. The DISTINCT ON keeps
--    one row per user.
WITH wanted AS (
  SELECT DISTINCT ON (uwa.user_id)
         uwa.user_id, uwa.warehouse_id
    FROM user_warehouse_access uwa
    JOIN users u ON u.id = uwa.user_id
    JOIN warehouses w ON w.id = uwa.warehouse_id
   WHERE w.is_active = TRUE
   ORDER BY uwa.user_id,
            CASE WHEN u.default_warehouse_id = uwa.warehouse_id THEN 0 ELSE 1 END,
            w.created_at ASC
)
UPDATE user_warehouse_access uwa
   SET is_default = TRUE
  FROM wanted
 WHERE uwa.user_id      = wanted.user_id
   AND uwa.warehouse_id = wanted.warehouse_id
   AND NOT EXISTS (
       SELECT 1 FROM user_warehouse_access x
        WHERE x.user_id = uwa.user_id AND x.is_default = TRUE
   );

-- 4) Default branch — pick the primary branch of the chosen default
--    warehouse when one exists, otherwise the user's first allowed
--    branch (deterministic via branches.created_at).
WITH wanted AS (
  SELECT DISTINCT ON (uba.user_id)
         uba.user_id, uba.branch_id
    FROM user_branch_access uba
    JOIN branches b ON b.id = uba.branch_id
    LEFT JOIN user_warehouse_access def_w
           ON def_w.user_id = uba.user_id
          AND def_w.is_default = TRUE
    LEFT JOIN warehouse_branches wb
           ON wb.warehouse_id = def_w.warehouse_id
          AND wb.branch_id    = uba.branch_id
   WHERE b.is_active = TRUE
   ORDER BY uba.user_id,
            CASE WHEN wb.branch_id IS NOT NULL THEN 0 ELSE 1 END,
            b.created_at ASC
)
UPDATE user_branch_access uba
   SET is_default = TRUE
  FROM wanted
 WHERE uba.user_id   = wanted.user_id
   AND uba.branch_id = wanted.branch_id
   AND NOT EXISTS (
       SELECT 1 FROM user_branch_access x
        WHERE x.user_id = uba.user_id AND x.is_default = TRUE
   );

-- ---------- comments ----------
COMMENT ON TABLE user_branch_access IS
    'Per-user allowed branches with access_level (view | operate | manage | admin). '
    'A user with NO rows in this table is fallback-allowed everywhere by the '
    'API layer during the rollout — see AccessScopeService.';

COMMENT ON TABLE user_warehouse_access IS
    'Per-user allowed warehouses with access_level. Same fallback-allow-all '
    'rule applies when the user has zero rows.';

COMMENT ON COLUMN user_branch_access.is_default IS
    'Marks the user''s default branch for UX (pre-fills branch pickers). '
    'Enforced as one-per-user via the partial unique index '
    'uq_user_branch_access_default. Tenant-scoped variant lands later.';

COMMENT ON COLUMN user_warehouse_access.is_default IS
    'Marks the user''s default warehouse for UX. Enforced as one-per-user '
    'via uq_user_warehouse_access_default.';
