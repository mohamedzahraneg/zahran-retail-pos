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
