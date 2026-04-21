-- 043_supplier_enhancements.sql
-- -----------------------------------------------------------------------------
-- Adds supplier_type (cash / credit / installments) + opening_balance,
-- renumbers supplier codes to plain digits, and enforces a digits-only
-- format on `code` going forward.
--
-- Additive on columns. Code renumber is a one-time cleanup — anyone
-- re-running the migration gets the same final state because UPDATE is
-- idempotent against the generated sequence.
-- -----------------------------------------------------------------------------

ALTER TABLE suppliers
  ADD COLUMN IF NOT EXISTS supplier_type    VARCHAR(12) NOT NULL DEFAULT 'credit',
  ADD COLUMN IF NOT EXISTS opening_balance  NUMERIC(14,2) NOT NULL DEFAULT 0;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'suppliers_supplier_type_chk'
  ) THEN
    ALTER TABLE suppliers ADD CONSTRAINT suppliers_supplier_type_chk
      CHECK (supplier_type IN ('cash','credit','installments'));
  END IF;
END $$;

-- Renumber codes to plain digits (1, 2, 3 …) ordered by first creation.
WITH ordered AS (
  SELECT id, ROW_NUMBER() OVER (ORDER BY created_at) AS rn
    FROM suppliers
   WHERE deleted_at IS NULL
)
UPDATE suppliers s
   SET code = ordered.rn::text
  FROM ordered
 WHERE s.id = ordered.id;

-- Enforce digits-only going forward.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'suppliers_code_digits_chk'
  ) THEN
    ALTER TABLE suppliers ADD CONSTRAINT suppliers_code_digits_chk
      CHECK (code ~ '^[0-9]+$');
  END IF;
END $$;
