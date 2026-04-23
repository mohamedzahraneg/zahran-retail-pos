-- Migration 065: Cost System Unification
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Phase 3 of the accounting hardening program. Targets the expense /
-- cost-of-sales layer ONLY. Does not touch invoices, POS sales,
-- cashbox structure, or the financial engine itself.
--
-- What this migration does:
--
--   1. Fix the `transport` expense_category mapping — currently points
--      to 529 (miscellaneous) even though 525 (نقل وشحن / transport)
--      was seeded in migration 048. This is pure drift from a
--      pre-engine seed; new expenses on this category will map to
--      the correct 525 account immediately.
--
--   2. Guarantee every expense_category has an `account_id` — the
--      `CostAccountResolver` service depends on this invariant, so
--      enforce at DB level with NOT NULL on new inserts (CHECK via
--      a deferred constraint — won't break existing rows since all
--      12 are already linked).
--
--   3. Create `cost_reconciliation_reports` — append-only history of
--      daily recon runs. One row per (report_date, run_type). Not
--      touched by any business flow; only the new
--      CostReconciliationService writes.
--
--   4. Create `v_cost_unified_ledger` — the single reporting surface
--      for cost analysis. Joins journal_entries (reference_type
--      = 'expense') with the source `expenses` row, de-duplicates,
--      and exposes one row per expense with its canonical GL account,
--      cashbox impact, and employee link. Reporting reads ONLY this
--      view — never raw legacy/engine tables separately.
--
-- INVARIANTS held:
--   * No change to existing journal_entries / journal_lines / cashbox_txns.
--   * No deletion of any row.
--   * No change to expense posting logic — that's enforced already:
--     AccountingService.createExpense → engine.recordExpense
--     AccountingPostingService.postExpense → engine.recordExpense
--     (both audit-verified in phase 1).
--   * Idempotent — re-running this migration is a no-op.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Remap transport → 525 if still pointing to 529 ──────────────────
-- Safe: we only flip the account_id on the category metadata row. No
-- historical JE is rewritten. New expenses posted to this category
-- after the migration will debit 525 instead of 529. Old JEs keep
-- pointing to 529 — correct, because that's what they actually hit.
DO $$
DECLARE
  v_account_525 UUID;
BEGIN
  SELECT id INTO v_account_525 FROM chart_of_accounts WHERE code = '525' LIMIT 1;
  IF v_account_525 IS NOT NULL THEN
    UPDATE expense_categories
       SET account_id = v_account_525
     WHERE code = 'transport'
       AND (account_id IS NULL
            OR account_id IN (SELECT id FROM chart_of_accounts WHERE code = '529'));
  END IF;
END$$;

-- ─── 2. Guarantee every category has an account_id going forward ────────
-- Add a CHECK that requires account_id for newly active categories.
-- Existing rows are already compliant (audit confirmed 12/12 linked).
-- We use DO ... NOT VALID on historical rows to avoid touching old
-- data if a future migration accidentally unlinks something legacy.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
     WHERE table_name = 'expense_categories'
       AND constraint_name = 'ck_expense_categories_has_account'
  ) THEN
    ALTER TABLE expense_categories
      ADD CONSTRAINT ck_expense_categories_has_account
      CHECK (is_active = FALSE OR account_id IS NOT NULL)
      NOT VALID;
  END IF;
END$$;

-- ─── 3. cost_reconciliation_reports — append-only recon history ─────────
CREATE TABLE IF NOT EXISTS cost_reconciliation_reports (
  id                       BIGSERIAL PRIMARY KEY,
  report_date              DATE        NOT NULL,
  run_type                 VARCHAR(20) NOT NULL DEFAULT 'daily'
                             CHECK (run_type IN ('daily','hourly','adhoc','backfill')),
  total_expenses_count     INT         NOT NULL,
  total_expense_engine     NUMERIC(14,2) NOT NULL DEFAULT 0,
  total_expense_legacy     NUMERIC(14,2) NOT NULL DEFAULT 0,
  mismatch_amount          NUMERIC(14,2) NOT NULL DEFAULT 0,
  duplicate_detected_count INT         NOT NULL DEFAULT 0,
  orphan_count             INT         NOT NULL DEFAULT 0,
  unlinked_category_count  INT         NOT NULL DEFAULT 0,
  generated_by             UUID        REFERENCES users(id),
  details                  JSONB       DEFAULT '{}'::jsonb,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_crr_date
  ON cost_reconciliation_reports(report_date DESC, run_type);

-- Append-only: no UPDATE, no DELETE. Same pattern as audit_logs.
CREATE OR REPLACE FUNCTION fn_crr_append_only()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'cost_reconciliation_reports is append-only — % forbidden', TG_OP;
END$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_crr_no_mutate ON cost_reconciliation_reports;
CREATE TRIGGER trg_crr_no_mutate
  BEFORE UPDATE OR DELETE ON cost_reconciliation_reports
  FOR EACH ROW EXECUTE FUNCTION fn_crr_append_only();

-- ─── 4. v_cost_unified_ledger — single reporting surface ────────────────
-- ONE row per expense, joined to its canonical journal entry. The
-- view de-duplicates by taking at most one LIVE (is_posted=TRUE,
-- is_void=FALSE) JE per expense via DISTINCT ON. Any attempts to
-- post twice (which the engine's idempotency guard blocks) would
-- surface here as `je_count > 1`; we still only emit one row.
--
-- Key fields:
--   * expense_id, expense_no, expense_date
--   * amount (from the expenses row)
--   * posted_amount (from the journal line DR 5xx — should match)
--   * posting_drift = amount − posted_amount (non-zero = red flag)
--   * gl_account_code (the 5xx account)
--   * cashbox_id, payment_method
--   * employee_user_id (for the Employee Financial Ledger)
--   * journal_entry_id, entry_no
--   * source: 'engine' | 'legacy' | 'unposted'
--
-- The `source` field classifies by scanning `financial_event_stream`
-- (migration 064). If the mirror row flagged is_engine → 'engine'.
-- If no JE exists yet → 'unposted'. Otherwise → 'legacy'.

CREATE OR REPLACE VIEW v_cost_unified_ledger AS
WITH live_je AS (
  -- One LIVE journal entry per expense (id, created_at) — latest first.
  SELECT DISTINCT ON (je.reference_id)
         je.reference_id AS expense_id,
         je.id            AS entry_id,
         je.entry_no,
         je.entry_date,
         je.description   AS je_description,
         je.created_at    AS je_created_at,
         je.is_posted,
         je.is_void
    FROM journal_entries je
   WHERE je.reference_type = 'expense'
     AND je.is_posted = TRUE
     AND je.is_void   = FALSE
   ORDER BY je.reference_id, je.created_at DESC
),
je_totals AS (
  -- The DR 5xx leg + the CR cashbox leg. Engine recipe always writes
  -- exactly these two; we pull both so reporting can show the cash
  -- side too.
  SELECT live_je.entry_id,
         MAX(CASE WHEN jl.debit > 0  AND a.account_type = 'expense' THEN jl.debit  END) AS dr_expense,
         MAX(CASE WHEN jl.credit > 0 AND a.account_type = 'asset'   THEN jl.credit END) AS cr_cash,
         MAX(CASE WHEN jl.debit > 0  AND a.account_type = 'expense' THEN a.code    END) AS gl_account_code,
         MAX(CASE WHEN jl.debit > 0  AND a.account_type = 'expense' THEN a.name_ar END) AS gl_account_name_ar,
         -- PostgreSQL has no MAX(uuid); cast through text to pick one.
         MAX(CASE WHEN jl.credit > 0                                THEN jl.cashbox_id::text END)::uuid AS gl_cashbox_id
    FROM live_je
    JOIN journal_lines jl ON jl.entry_id = live_je.entry_id
    JOIN chart_of_accounts a ON a.id = jl.account_id
   GROUP BY live_je.entry_id
),
engine_flag AS (
  -- Latest mirror row per reference tells us the writer identity.
  SELECT DISTINCT ON (fes.reference_id)
         fes.reference_id,
         fes.is_engine,
         fes.is_legacy,
         fes.source_service
    FROM financial_event_stream fes
   WHERE fes.event_type = 'journal_entry'
     AND fes.reference_type = 'expense'
   ORDER BY fes.reference_id, fes.event_id DESC
)
SELECT
  e.id                          AS expense_id,
  e.expense_no,
  e.expense_date,
  e.amount::numeric(14,2)       AS amount,
  COALESCE(je_totals.dr_expense, 0)::numeric(14,2) AS posted_amount,
  (e.amount - COALESCE(je_totals.dr_expense, 0))::numeric(14,2) AS posting_drift,
  je_totals.gl_account_code,
  je_totals.gl_account_name_ar,
  ec.code                       AS category_code,
  ec.name_ar                    AS category_name,
  e.payment_method,
  e.cashbox_id,
  e.warehouse_id,
  e.vendor_name,
  e.description,
  e.employee_user_id,
  e.is_approved,
  e.is_advance,
  live_je.entry_id              AS journal_entry_id,
  live_je.entry_no,
  CASE
    WHEN live_je.entry_id IS NULL                THEN 'unposted'
    WHEN COALESCE(engine_flag.is_engine, FALSE)  THEN 'engine'
    WHEN COALESCE(engine_flag.is_legacy, FALSE)  THEN 'legacy'
    ELSE 'legacy'  -- pre-FES rows default to legacy (historical)
  END                            AS source,
  e.created_by,
  e.created_at
FROM expenses e
LEFT JOIN expense_categories ec ON ec.id = e.category_id
LEFT JOIN live_je          ON live_je.expense_id = e.id
LEFT JOIN je_totals        ON je_totals.entry_id = live_je.entry_id
LEFT JOIN engine_flag      ON engine_flag.reference_id = e.id::text;

COMMENT ON VIEW v_cost_unified_ledger IS
  'Single reporting surface for expense/cost analysis. One row per expense, joined to its canonical posted JE. De-duplicated, classified engine/legacy/unposted, with posting_drift flag for reconciliation.';

-- ─── 5. Permission for the cost dashboard ───────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='permissions') THEN
    INSERT INTO permissions (code, module, name_ar, name_en) VALUES
      ('accounting.cost.reconcile', 'accounting',
       'تسوية وتقرير التكاليف', 'Run/view cost reconciliation reports')
    ON CONFLICT (code) DO NOTHING;

    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='role_permissions') THEN
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM roles r, permissions p
       WHERE r.code IN ('admin','manager','accountant')
         AND p.code = 'accounting.cost.reconcile'
      ON CONFLICT DO NOTHING;
    END IF;

    IF EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name='roles' AND column_name='permissions'
    ) THEN
      UPDATE roles
         SET permissions = (
           SELECT ARRAY_AGG(DISTINCT code ORDER BY code) FROM (
             SELECT UNNEST(COALESCE(permissions, ARRAY[]::text[])) AS code
             UNION
             SELECT 'accounting.cost.reconcile'
           ) all_codes
         )
       WHERE code IN ('admin','manager','accountant');
    END IF;
  END IF;
END$$;

COMMIT;
