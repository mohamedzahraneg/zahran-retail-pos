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
