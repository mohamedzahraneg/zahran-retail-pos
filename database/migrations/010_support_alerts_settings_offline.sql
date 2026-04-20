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
