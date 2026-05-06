-- ============================================================================
-- 123 — PR-FIX-EXPENSES-DB-CHECK-CASH-REQUIRES-CASHBOX (Sprint 4 / PR-10B)
-- ============================================================================
--
-- Defense-in-depth at the database layer for the cash-expense invariant
-- enforced at the application layer in PR #304
-- (PR-FIX-EXPENSES-APP-LEVEL-CASHBOX-GUARD).
--
-- Business rule (mirrors the JS helper `assertExpenseInvariants`)
-- ---------------------------------------------------------------
--   IF payment_method is missing / null / default / 'cash'
--   THEN cashbox_id MUST be NOT NULL.
--
-- The DB-level shape is the boolean dual of "throw":
--
--   CHECK (
--     lower(coalesce(payment_method::text, 'cash')) <> 'cash'
--     OR cashbox_id IS NOT NULL
--   )
--
-- The `payment_method::text` cast is required because `payment_method`
-- is the enum `payment_method_code`, and `lower()` is defined on text.
-- The cast is IMMUTABLE so the predicate is constraint-safe.
--
-- Why `lower(coalesce(...::text, 'cash'))` and not `payment_method = 'cash'`
-- ------------------------------------------------------------------------
-- The JS guard normalises with `(payment_method ?? 'cash').toLowerCase()`.
-- The DB shape is kept symmetric so any future enum extension that adds
-- a label like `Cash` or `CASH` (would need an enum ALTER first, but
-- defensive design) is treated identically to plain `'cash'` on both
-- sides. For the current 11 enum values
-- (cash, card_visa, card_mastercard, card_meeza, instapay,
--  vodafone_cash, orange_cash, bank_transfer, credit, other, wallet)
-- the predicate evaluates to TRUE-on-violation **only** for the literal
-- `'cash'` enum value AND missing-payment-method (DB default = 'cash')
-- when paired with `cashbox_id IS NULL`. The `vodafone_cash` and
-- `orange_cash` values do NOT trigger the constraint because
-- `lower('vodafone_cash') <> 'cash'`. This matches the JS guard exactly.
--
-- Why DIRECT VALIDATED CHECK (no NOT VALID + VALIDATE two-step)
-- -------------------------------------------------------------
-- The two-step `ADD CONSTRAINT … NOT VALID` + later
-- `VALIDATE CONSTRAINT` is the canonical pattern for LARGE tables
-- where a synchronous full-table scan would hold an unacceptable lock
-- (or cost). On this database the table is tiny:
--
--   · `expenses` row count at PR-10B precheck (2026-05-06): **34 rows**
--   · Production precheck violator count: **0** (verified read-only)
--
-- For 34 rows, the inline validation is effectively instantaneous and
-- the one-step form is operationally identical to the two-step form
-- in terms of lock duration. The one-step form is also simpler:
-- there is no transient "constraint exists but is NOT VALID" window
-- that a parallel deploy / partial migration could trip over. We take
-- the simpler, fully-atomic shape.
--
-- Idempotency
-- -----------
-- The migration is wrapped in a DO $$ BEGIN … END $$ block that
-- queries `pg_constraint` first. If `expenses_cash_requires_cashbox_chk`
-- is already present the block is a no-op. Re-applying this migration
-- on a partially-applied DB therefore does nothing.
--
-- What this migration does NOT do
-- -------------------------------
--   · No UPDATE / DELETE / INSERT against any row.
--   · No backfill, no data correction, no row repair.
--   · No engine code changes (FinancialEngine / posting service).
--   · No frontend changes.
--   · No new column, no column type change, no FK change.
--   · No `shift_id` rule (out of scope per PR-10B spec).
--   · No relaxation of any other constraint.
--
-- Forward-prevention
-- ------------------
-- After this migration, any INSERT or UPDATE on `expenses` that
-- attempts to set
--   payment_method = 'cash' (or missing → DB default 'cash')
-- AND `cashbox_id = NULL`
-- will fail with PG error 23514 (check_violation) at the DB layer —
-- even if a future bug bypasses the application-layer
-- `assertExpenseInvariants` guard from PR #304.

-- ── 1 — CHECK constraint, idempotent ──────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'expenses_cash_requires_cashbox_chk'
  ) THEN
    ALTER TABLE expenses
      ADD CONSTRAINT expenses_cash_requires_cashbox_chk
      CHECK (
        lower(coalesce(payment_method::text, 'cash')) <> 'cash'
        OR cashbox_id IS NOT NULL
      );
  END IF;
END
$$;

-- ── 2 — Self-validation block ─────────────────────────────────────────────
-- Pattern matches recent migrations (119/120/121/122). The verify block
-- runs in the same transaction as the ALTER above; if any expected
-- artefact is missing the migration aborts with a clear error.
DO $verify$
DECLARE
  v_constraint_count int;
BEGIN
  SELECT COUNT(*)::int
    INTO v_constraint_count
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
   WHERE c.conname = 'expenses_cash_requires_cashbox_chk'
     AND t.relname = 'expenses'
     AND c.contype = 'c';
  IF v_constraint_count <> 1 THEN
    RAISE EXCEPTION
      'expenses_cash_requires_cashbox_chk constraint missing on expenses (got %)',
      v_constraint_count;
  END IF;
END
$verify$;
