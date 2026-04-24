-- Migration 059: DB-first ledger hardening — close the remaining bypass
--                paths so the database itself is the authority on
--                financial integrity, not the engine.
-- ---------------------------------------------------------------------------
-- Migration 058 made FinancialEngineService the only writer for INSERT and
-- DELETE on journal_entries / journal_lines and for UPDATE of
-- cashboxes.current_balance. Gaps still remained:
--
--   1. UPDATE on journal_lines was unguarded — an attacker with raw SQL
--      access could `UPDATE journal_lines SET debit = 0` on a posted entry
--      and silently un-balance it.
--
--   2. UPDATE on journal_entries was unguarded except for the is_posted
--      balance check. Renaming descriptions, reassigning reference_id, or
--      un-voiding an entry was possible from psql.
--
--   3. journal_entries had no DB-level uniqueness on
--      (reference_type, reference_id). The engine SELECT-then-INSERT check
--      was the only defense against a double-post race; under load two
--      concurrent engine calls could both post the same invoice.
--
--   4. The balance-equals trigger (fn_je_enforce_balance, migration 048)
--      fired only on UPDATE of is_posted. A direct INSERT of a row with
--      is_posted = TRUE would post an unbalanced entry. In engine context
--      the engine always inserts is_posted = FALSE first, but we want
--      defense in depth — no legitimate engine flow should ever INSERT
--      is_posted = TRUE, and the DB should reject it outright.
--
--   5. cashbox_transactions is a physical-cash ledger but had no tamper
--      guard. An UPDATE or DELETE there silently drifts
--      cashboxes.current_balance away from the ledger sum.
--
-- This migration plugs all five. Idempotent. Safe to re-run.
--
-- Sanctioned writers (same as 058):
--   - FinancialEngineService.recordTransaction() — sets app.engine_context
--   - fn_record_cashbox_txn — sets app.engine_context internally
--   - ReconciliationService.rebuildCashboxBalance — sets it for its UPDATE

BEGIN;

-- ───────────────────────────────────────────────────────────────────
-- 1. Journal-lines UPDATE guard.
-- Extend migration 058's INSERT/DELETE trigger to cover UPDATE too.
-- We re-create the trigger with the full operation list; the existing
-- trigger is dropped first so we never have two copies firing.
-- ───────────────────────────────────────────────────────────────────
DROP TRIGGER IF EXISTS trg_guard_journal_lines ON public.journal_lines;
CREATE TRIGGER trg_guard_journal_lines
  BEFORE INSERT OR UPDATE OR DELETE ON public.journal_lines
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_journal_lines();

-- ───────────────────────────────────────────────────────────────────
-- 2. Journal-entries UPDATE guard.
-- Allow all INSERT/DELETE paths to keep the 058 semantics, and add a
-- blanket UPDATE guard so reference_id, entry_date, description, etc.
-- cannot be retroactively altered outside engine context.
--
-- The fn_je_enforce_balance trigger (migration 048) stays intact — it
-- runs on UPDATE OF is_posted inside the engine and validates the
-- balance. This guard runs BEFORE that one and short-circuits non-engine
-- updates.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_guard_journal_entries_update()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT public.fn_is_engine_context() THEN
    RAISE EXCEPTION
      'direct UPDATE on journal_entries is not allowed — route through '
      'FinancialEngineService (recordTransaction / reverseByReference)';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_journal_entries_update ON public.journal_entries;
CREATE TRIGGER trg_guard_journal_entries_update
  BEFORE UPDATE ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_journal_entries_update();

-- ───────────────────────────────────────────────────────────────────
-- 3. Idempotency at the DB level.
-- Partial unique index on (reference_type, reference_id) for LIVE
-- posted entries. Two concurrent engine calls racing on the same
-- invoice will have the second one rejected with a UNIQUE violation
-- even if they both passed the engine's SELECT check.
--
-- Scope deliberately narrow:
--   - is_posted = TRUE excludes in-flight draft entries (engine inserts
--     with is_posted = FALSE first, then flips — we don't want the
--     draft to block the final flip).
--   - is_void = FALSE lets a voided entry be superseded by a replay,
--     which the engine explicitly allows for reversal-and-repost flows.
-- ───────────────────────────────────────────────────────────────────
DROP INDEX IF EXISTS public.uq_je_live_reference;
CREATE UNIQUE INDEX uq_je_live_reference
  ON public.journal_entries (reference_type, reference_id)
  WHERE is_posted = TRUE
    AND is_void   = FALSE
    AND reference_type IS NOT NULL
    AND reference_id   IS NOT NULL;

-- ───────────────────────────────────────────────────────────────────
-- 4. Balance check on INSERT of a posted entry.
-- No legitimate flow inserts a journal_entry with is_posted = TRUE in
-- one shot (the engine inserts is_posted = FALSE, writes lines, then
-- flips). Reject it at the DB so an operator who opens psql with the
-- engine-context GUC raised can't produce an unbalanced live entry.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_je_no_insert_posted()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.is_posted = TRUE THEN
    RAISE EXCEPTION
      'journal_entries cannot be INSERTed with is_posted = TRUE — '
      'insert as draft (is_posted = FALSE), write lines, then UPDATE '
      'is_posted = TRUE so the balance trigger validates the entry';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_je_no_insert_posted ON public.journal_entries;
CREATE TRIGGER trg_je_no_insert_posted
  BEFORE INSERT ON public.journal_entries
  FOR EACH ROW EXECUTE FUNCTION public.fn_je_no_insert_posted();

-- ───────────────────────────────────────────────────────────────────
-- 5. cashbox_transactions tamper guard.
-- Physical cash ledger — insert-only from outside, mutations only
-- through the engine path. UPDATE or DELETE from anywhere else would
-- drift cashboxes.current_balance away from SUM(cashbox_transactions).
--
-- INSERT is intentionally left open: legacy triggers
-- (trg_customer_payment_apply, trg_supplier_payment_apply) and
-- fn_record_cashbox_txn all INSERT here, and migration 058 already
-- ensures they raise app.engine_context before touching the cashbox
-- balance. The risky operations here are UPDATE/DELETE, which no
-- production code ever performs.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_guard_cashbox_transactions()
  RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NOT public.fn_is_engine_context() THEN
    RAISE EXCEPTION
      'cashbox_transactions is append-only — % outside engine context '
      'is not allowed (use ReconciliationService.rebuildCashboxBalance '
      'for sanctioned rebuilds)', TG_OP;
  END IF;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

DROP TRIGGER IF EXISTS trg_guard_cashbox_transactions ON public.cashbox_transactions;
CREATE TRIGGER trg_guard_cashbox_transactions
  BEFORE UPDATE OR DELETE ON public.cashbox_transactions
  FOR EACH ROW EXECUTE FUNCTION public.fn_guard_cashbox_transactions();

-- ───────────────────────────────────────────────────────────────────
-- 6. Harden fn_is_engine_context.
--
-- Two fixes on top of the migration-058 version:
--
--   (a) COALESCE the comparison result to FALSE. When the GUC is unset
--       `current_setting(..., true)` returns NULL, NULL = 'on' is NULL,
--       and `NOT NULL` is NULL — which plpgsql `IF` treats as FALSE.
--       Net effect on 058: `IF NOT fn_is_engine_context() THEN RAISE`
--       never fires for the common "GUC not set" case, silently
--       defeating every guard trigger. COALESCE restores the intended
--       hard-deny default.
--
--   (b) Pin search_path to pg_catalog + public so a role that set its
--       own search_path can't shadow `current_setting` or the function
--       itself with a version that always returns TRUE.
-- ───────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_is_engine_context()
  RETURNS BOOLEAN
  LANGUAGE plpgsql
  STABLE
  SECURITY INVOKER
  SET search_path = pg_catalog, public
AS $$
BEGIN
  RETURN COALESCE(current_setting('app.engine_context', TRUE) = 'on', FALSE);
END;
$$;

COMMIT;
