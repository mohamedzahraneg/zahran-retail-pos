-- ============================================================================
--  ZAHRAN RETAIL SYSTEM  |  Migration 132 : Operational Expense Allocation
--                          (PR-PHASE2-B1 — read-only foundation)
--
--  WHAT THIS DOES
--    Adds a pure management-accounting overlay that lets operators allocate
--    already-recorded operating expenses to products / product-categories /
--    warehouses for REPORTING ONLY.  Creates two new tables, one ENUM, and
--    two reporting views.  All purely additive.
--
--  WHAT THIS DOES NOT DO
--    * No mutation of product_variants.cost_price
--    * No mutation of stock_movements.unit_cost
--    * No mutation of invoice_items.unit_cost
--    * No mutation of invoices.cogs_total / gross_profit
--    * No journal_entries / journal_lines writes
--    * No cashbox_transactions writes
--    * No FinancialEngine invocation
--    * No backfill of historical rows
--    * No drop / alter of any existing object
--    * No change to v_product_profit / v_daily_profit / v_profit_margin_per_product
--    * No change to expense_categories.allocate_to_cogs (legacy daily-P&L
--      flag stays untouched for backward compatibility)
--
--  HOW IT INTEGRATES
--    * v_product_profit_with_overhead is a SIBLING of v_product_profit.
--      It LEFT JOINs aggregated `expense_allocation_lines` per product_id
--      where the parent period is `approved`.  When the new tables are
--      empty (i.e. immediately after migration), every row reports
--      overhead_allocated = 0 and net_profit_after_overhead = gross_profit.
--      The base view is unchanged; reports that already use it stay
--      identical until an operator deliberately creates allocations.
--
--    * v_unallocated_expenses surfaces approved expenses NOT covered by
--      any approved allocation line in their period — a "find the gaps"
--      report.  Returns ALL approved expenses immediately after this
--      migration runs (no allocations exist yet).
--
--  PERMISSIONS
--    No DB-level permission seeding is performed by this migration.
--    Application-layer permissions (`expense_allocation.view` /
--    `expense_allocation.manage`) are introduced by the BE module in the
--    same PR and granted via the existing role/permission mechanism.
--    No new GRANT statements; no new roles created at the DB level.
--
--  HELPERS REUSED
--    touch_updated_at()        — created in migration 011 (line 22-29).
--    gen_random_uuid()         — pgcrypto, already enabled.
-- ============================================================================

BEGIN;

-- ─── 1. Status enum ─────────────────────────────────────────────────────
-- DRAFT  : lines may be added/edited/deleted; period is mutable.
-- APPROVED: lines are read-only; reports use only approved periods.
-- REVERSED: status flipped from approved with a reason; lines kept for
--           audit; reports IGNORE reversed periods.
--
-- A reversed period is terminal: it cannot be re-approved.  Operators who
-- need to redo an allocation create a fresh draft period.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type WHERE typname = 'expense_allocation_period_status'
  ) THEN
    CREATE TYPE expense_allocation_period_status AS ENUM (
      'draft',
      'approved',
      'reversed'
    );
  END IF;
END$$;


-- ─── 2. Period header table ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS expense_allocation_periods (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Scope
  period_start    DATE NOT NULL,
  period_end      DATE NOT NULL,
  warehouse_id    UUID REFERENCES warehouses(id),   -- NULL = all warehouses

  -- State
  status          expense_allocation_period_status NOT NULL DEFAULT 'draft',
  total_allocated NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (total_allocated >= 0),
  notes           TEXT,

  -- Audit trail
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  approved_at     TIMESTAMPTZ,
  reversed_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  reversed_at     TIMESTAMPTZ,
  reversed_reason TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT eap_dates_valid CHECK (period_end >= period_start)
);

CREATE INDEX IF NOT EXISTS idx_eap_period_dates
  ON expense_allocation_periods(period_start, period_end);

CREATE INDEX IF NOT EXISTS idx_eap_warehouse
  ON expense_allocation_periods(warehouse_id);

CREATE INDEX IF NOT EXISTS idx_eap_status
  ON expense_allocation_periods(status);

-- Reuse the shared `touch_updated_at()` function from migration 011.  The
-- trigger only fires on UPDATE; the DEFAULT NOW() on `updated_at` handles
-- the INSERT case.  Idempotent: drop and recreate so re-running the
-- migration in development environments produces a clean trigger.
DROP TRIGGER IF EXISTS trg_eap_touch_updated ON expense_allocation_periods;
CREATE TRIGGER trg_eap_touch_updated
  BEFORE UPDATE ON expense_allocation_periods
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();


-- ─── 3. Line table ──────────────────────────────────────────────────────
-- Source: either a SPECIFIC expense (expense_id set) OR a whole category
-- bucket (expense_category_id set).  Both may be set when the operator
-- wants to record both the category context and the actual expense; the
-- application path normally uses one or the other.
--
-- Target: EXACTLY ONE of product_id / product_category_id / warehouse_id
-- must be non-NULL.  Enforced by `eal_exactly_one_target` below.
--
-- Math: `allocated_amount` is the EGP figure to subtract from the target's
-- gross profit in reports.  `weight_basis_value` and `weight_basis_total`
-- capture the algorithmic basis (e.g. this target's revenue / total
-- revenue) so a reviewer can recompute the math months later.
--
-- IMPORTANT: this table is READ-ONLY in PR-PHASE2-B1.  The BE module
-- exposes only GET endpoints for now; the compute / write / approve /
-- reverse endpoints land in subsequent PRs.
CREATE TABLE IF NOT EXISTS expense_allocation_lines (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  period_id           UUID NOT NULL REFERENCES expense_allocation_periods(id) ON DELETE CASCADE,

  -- Source (at least one must be non-NULL)
  expense_id          UUID REFERENCES expenses(id)            ON DELETE RESTRICT,
  expense_category_id UUID REFERENCES expense_categories(id)  ON DELETE RESTRICT,
  source_amount       NUMERIC(14,2) NOT NULL CHECK (source_amount >= 0),

  -- Target (exactly one must be non-NULL)
  product_id          UUID REFERENCES products(id),
  product_category_id UUID REFERENCES categories(id),
  warehouse_id        UUID REFERENCES warehouses(id),

  -- Method + math
  allocation_method   TEXT NOT NULL CHECK (allocation_method IN (
    'manual',
    'by_revenue',
    'by_units_sold',
    'by_gross_profit',
    'by_category_pct',
    'by_warehouse'
  )),
  allocated_amount    NUMERIC(14,2) NOT NULL CHECK (allocated_amount >= 0),
  weight_basis_value  NUMERIC(18,6),   -- this target's share of the basis
  weight_basis_total  NUMERIC(18,6),   -- the period-wide total of the basis

  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT eal_exactly_one_target CHECK (
    (product_id IS NOT NULL)::int
  + (product_category_id IS NOT NULL)::int
  + (warehouse_id IS NOT NULL)::int = 1
  ),
  CONSTRAINT eal_source_present CHECK (
    expense_id IS NOT NULL OR expense_category_id IS NOT NULL
  )
);

CREATE INDEX IF NOT EXISTS idx_eal_period
  ON expense_allocation_lines(period_id);

CREATE INDEX IF NOT EXISTS idx_eal_product
  ON expense_allocation_lines(product_id)
  WHERE product_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_eal_product_cat
  ON expense_allocation_lines(product_category_id)
  WHERE product_category_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_eal_warehouse
  ON expense_allocation_lines(warehouse_id)
  WHERE warehouse_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_eal_expense
  ON expense_allocation_lines(expense_id)
  WHERE expense_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_eal_expense_cat
  ON expense_allocation_lines(expense_category_id)
  WHERE expense_category_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_eal_method
  ON expense_allocation_lines(allocation_method);


-- ─── 4. Reporting view: product profit WITH allocated overhead ─────────
--
-- Wraps the existing v_product_profit (created in migration 012).  Adds
-- two columns:
--
--   overhead_allocated         : SUM of allocated_amount across all
--                                approved allocation lines targeted at
--                                this product_id, regardless of period
--                                dates.  The API layer applies a date
--                                filter via a wrapping query when needed.
--   net_profit_after_overhead  : gross_profit − overhead_allocated.
--
-- Regression invariant: when expense_allocation_lines is empty,
-- overhead_allocated = 0 and net_profit_after_overhead = gross_profit,
-- so this view is observationally identical to v_product_profit.
--
-- We deliberately use `CREATE OR REPLACE` so re-running the migration is
-- idempotent and a future PR can extend the view definition without a
-- DROP step.
CREATE OR REPLACE VIEW v_product_profit_with_overhead AS
SELECT
    pp.product_id,
    pp.product_name,
    pp.product_type,
    pp.units_sold,
    pp.revenue,
    pp.cogs,
    pp.gross_profit,
    pp.roi_pct,
    COALESCE(o.overhead_allocated, 0)::NUMERIC(14,2)            AS overhead_allocated,
    (pp.gross_profit - COALESCE(o.overhead_allocated, 0))::NUMERIC AS net_profit_after_overhead
FROM v_product_profit pp
LEFT JOIN (
    SELECT
        l.product_id,
        SUM(l.allocated_amount) AS overhead_allocated
    FROM expense_allocation_lines l
    JOIN expense_allocation_periods p ON p.id = l.period_id
    WHERE p.status = 'approved'
      AND l.product_id IS NOT NULL
    GROUP BY l.product_id
) o ON o.product_id = pp.product_id;


-- ─── 5. Reporting view: unallocated approved expenses ───────────────────
--
-- "Approved expenses that no approved allocation period covers."  An
-- expense is considered allocated when either:
--   * a specific allocation line references e.id directly, OR
--   * an allocation line references e.category_id AND the period covers
--     e.expense_date.
--
-- Used by operators to find the holes — e.g. "the rent for March hasn't
-- been allocated yet".
CREATE OR REPLACE VIEW v_unallocated_expenses AS
SELECT
    e.id,
    e.expense_no,
    e.amount,
    e.expense_date,
    e.category_id,
    ec.code     AS category_code,
    ec.name_ar  AS category_name,
    e.warehouse_id,
    w.name_ar   AS warehouse_name
FROM expenses e
JOIN expense_categories ec ON ec.id = e.category_id
LEFT JOIN warehouses     w  ON w.id  = e.warehouse_id
WHERE e.is_approved = TRUE
  AND NOT EXISTS (
    SELECT 1
    FROM expense_allocation_lines l
    JOIN expense_allocation_periods p ON p.id = l.period_id
    WHERE p.status = 'approved'
      AND e.expense_date BETWEEN p.period_start AND p.period_end
      AND (l.expense_id = e.id OR l.expense_category_id = e.category_id)
  );


-- ─── 6. Comments for downstream auditors ────────────────────────────────
COMMENT ON TABLE expense_allocation_periods IS
  'Header for a management-accounting allocation pass. Status FSM: draft -> approved -> reversed (terminal). Migration 132.';
COMMENT ON TABLE expense_allocation_lines IS
  'Allocates a portion of a source expense (or expense category) to ONE target (product / product_category / warehouse) for reporting only. Migration 132.';
COMMENT ON VIEW v_product_profit_with_overhead IS
  'Sibling of v_product_profit; adds overhead_allocated + net_profit_after_overhead from APPROVED allocation lines only. Migration 132.';
COMMENT ON VIEW v_unallocated_expenses IS
  'Approved expenses that no approved allocation period covers. Operator-facing "find the gaps" report. Migration 132.';

COMMIT;
