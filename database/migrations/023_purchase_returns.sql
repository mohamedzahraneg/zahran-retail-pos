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
