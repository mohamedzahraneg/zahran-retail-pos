-- 021_vat_support.sql
-- VAT (Value-Added Tax) support for POS
-- Egypt standard VAT rate is 14% on most retail sales.
-- This migration:
--   1. Ensures tax_rate / tax_amount columns exist on invoices + invoice_items
--   2. Seeds default VAT settings under settings key 'vat.config'
--   3. Creates a helper view for VAT reporting

-- --------------------------------------------------------------------
-- 1. Columns (idempotent)
-- --------------------------------------------------------------------
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS tax_rate   numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount numeric(14,2) NOT NULL DEFAULT 0;

ALTER TABLE invoice_items
  ADD COLUMN IF NOT EXISTS tax_rate   numeric(5,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS tax_amount numeric(14,2) NOT NULL DEFAULT 0;

-- --------------------------------------------------------------------
-- 2. Seed default VAT config (editable via Settings page)
-- --------------------------------------------------------------------
INSERT INTO settings (key, value, description)
VALUES (
  'vat.config',
  jsonb_build_object(
    'enabled',        false,
    'rate',           14.0,
    'inclusive',      true,   -- prices include VAT by default (Egypt retail norm)
    'vat_number',     '',
    'display_on_receipt', true
  ),
  'إعدادات ضريبة القيمة المضافة (VAT)'
)
ON CONFLICT (key) DO NOTHING;

-- --------------------------------------------------------------------
-- 3. View: VAT report per invoice
-- --------------------------------------------------------------------
CREATE OR REPLACE VIEW v_vat_per_invoice AS
SELECT
  i.id                    AS invoice_id,
  i.invoice_no,
  i.completed_at,
  i.warehouse_id,
  i.customer_id,
  i.grand_total,
  i.tax_rate,
  i.tax_amount,
  (i.grand_total - i.tax_amount) AS net_amount
FROM invoices i
WHERE i.status = 'paid';

COMMENT ON VIEW v_vat_per_invoice IS
  'VAT broken down per invoice for tax reporting';

-- --------------------------------------------------------------------
-- 4. View: VAT monthly summary
-- --------------------------------------------------------------------
CREATE OR REPLACE VIEW v_vat_monthly AS
SELECT
  date_trunc('month', completed_at)::date AS month,
  COUNT(*)                                AS invoice_count,
  COALESCE(SUM(grand_total - tax_amount), 0) AS net_sales,
  COALESCE(SUM(tax_amount), 0)            AS vat_collected,
  COALESCE(SUM(grand_total), 0)           AS gross_sales
FROM invoices
WHERE status = 'paid'
GROUP BY 1
ORDER BY 1 DESC;

COMMENT ON VIEW v_vat_monthly IS
  'Monthly VAT collected — feed for tax authority filings';
