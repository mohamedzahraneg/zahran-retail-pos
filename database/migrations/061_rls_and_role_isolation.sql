-- Migration 060: RLS + role isolation — close the final access-control
--                gap so the ledger cannot be written from outside the
--                engine even if a BYPASSRLS role connects (service_role).
-- ---------------------------------------------------------------------------
-- Migrations 048/057/058/059 gave us trigger-based integrity and
-- idempotency. They rely on a session GUC (`app.engine_context`) that the
-- engine sets inside its transaction. A role with BYPASSRLS (Supabase's
-- `service_role` by default) can still reach the tables — the triggers
-- will fire, but anyone who can execute SQL from the Supabase dashboard
-- or from a misused service-role key bypasses the *connection-level*
-- policy we want to enforce.
--
-- This migration adds that connection-level policy as a second layer of
-- defense:
--
--   1. ROW LEVEL SECURITY + FORCE RLS on the four ledger tables. FORCE
--      means policies apply even to the table owner — the engine's own
--      connection must pass the policy too.
--
--   2. Policies keyed on `current_setting('app.engine_context', true)
--      = 'on'`. Reads stay open (reports need to query); writes require
--      the engine GUC. Since the engine already raises that flag, nothing
--      in the application changes.
--
--   3. REVOKE of INSERT/UPDATE/DELETE on ledger tables from every
--      Supabase-managed role (anon, authenticated, service_role) and
--      from PUBLIC. RLS alone doesn't block a BYPASSRLS role — the
--      REVOKE does. Applied conditionally via DO blocks so the
--      migration is safe on non-Supabase installs (no such roles).
--
--   4. A named `financial_engine_role` (NOLOGIN) that owns the write
--      grants. Future work can `SET LOCAL ROLE financial_engine_role`
--      for deeper segregation; for now the role is primarily a grant
--      recipient that makes the ledger's write surface audit-visible
--      in pg_catalog (`\dp journal_entries` shows exactly who can
--      write).
--
-- Idempotent. Safe to re-run. Defense-in-depth: does NOT replace the
-- triggers from 048/057/058/059 — the triggers keep firing; RLS is an
-- additional, earlier barrier.
--
-- cashboxes is intentionally handled differently: it has columns that
-- admin UIs legitimately edit (name, kind, is_active). The current
-- invariant is already `current_balance changes only via engine` which
-- migration 058's trigger enforces. Here we only REVOKE writes from
-- Supabase roles; RLS on cashboxes stays off so admin flows keep working.

BEGIN;

-- ───────────────────────────────────────────────────────────────────
-- 1. Named role for ledger writes.
-- NOLOGIN — the role exists to hold grants, not to be logged in as.
-- ───────────────────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'financial_engine_role') THEN
    CREATE ROLE financial_engine_role NOLOGIN;
    COMMENT ON ROLE financial_engine_role IS
      'Holds INSERT/UPDATE/DELETE grants on the GL + cashbox ledger. Writes still gated by RLS and by the app.engine_context GUC — membership in this role alone does not authorize a write.';
  END IF;
END
$$;

-- Give the current DB owner membership so `SET LOCAL ROLE` works from
-- the app connection if/when the engine opts into that pattern.
DO $$
DECLARE
  v_owner text;
BEGIN
  SELECT tableowner INTO v_owner
    FROM pg_tables
   WHERE schemaname = 'public' AND tablename = 'journal_entries'
   LIMIT 1;
  IF v_owner IS NOT NULL AND v_owner <> 'financial_engine_role' THEN
    EXECUTE format('GRANT financial_engine_role TO %I', v_owner);
  END IF;
EXCEPTION WHEN duplicate_object THEN
  NULL;  -- already a member
END
$$;

-- ───────────────────────────────────────────────────────────────────
-- 2. Enable + FORCE RLS on the four ledger tables.
-- FORCE is critical: without it, the table owner (the role the backend
-- connects as) bypasses RLS silently.
-- ───────────────────────────────────────────────────────────────────
ALTER TABLE public.journal_entries      ENABLE  ROW LEVEL SECURITY;
ALTER TABLE public.journal_entries      FORCE   ROW LEVEL SECURITY;

ALTER TABLE public.journal_lines        ENABLE  ROW LEVEL SECURITY;
ALTER TABLE public.journal_lines        FORCE   ROW LEVEL SECURITY;

ALTER TABLE public.cashbox_transactions ENABLE  ROW LEVEL SECURITY;
ALTER TABLE public.cashbox_transactions FORCE   ROW LEVEL SECURITY;

-- financial_event_log is already append-only via trigger; add RLS as
-- belt + braces so even DELETE-targeting a BYPASSRLS role fails at the
-- policy layer too.
ALTER TABLE public.financial_event_log  ENABLE  ROW LEVEL SECURITY;
ALTER TABLE public.financial_event_log  FORCE   ROW LEVEL SECURITY;

-- ───────────────────────────────────────────────────────────────────
-- 3. Deny-by-default + explicit permissive policies.
-- Each table gets:
--   - a SELECT policy USING (true)           → reads stay open
--   - a write policy keyed on engine_context → writes via engine only
-- Anything not covered by a permissive policy is denied.
-- ───────────────────────────────────────────────────────────────────

-- journal_entries
DROP POLICY IF EXISTS je_read          ON public.journal_entries;
DROP POLICY IF EXISTS je_engine_write  ON public.journal_entries;
CREATE POLICY je_read ON public.journal_entries
  FOR SELECT
  USING (true);
CREATE POLICY je_engine_write ON public.journal_entries
  AS PERMISSIVE
  FOR ALL
  USING      (current_setting('app.engine_context', true) = 'on')
  WITH CHECK (current_setting('app.engine_context', true) = 'on');

-- journal_lines
DROP POLICY IF EXISTS jl_read          ON public.journal_lines;
DROP POLICY IF EXISTS jl_engine_write  ON public.journal_lines;
CREATE POLICY jl_read ON public.journal_lines
  FOR SELECT
  USING (true);
CREATE POLICY jl_engine_write ON public.journal_lines
  AS PERMISSIVE
  FOR ALL
  USING      (current_setting('app.engine_context', true) = 'on')
  WITH CHECK (current_setting('app.engine_context', true) = 'on');

-- cashbox_transactions — INSERT only via engine; UPDATE/DELETE have no
-- matching policy and are therefore denied even to the table owner.
DROP POLICY IF EXISTS cbt_read          ON public.cashbox_transactions;
DROP POLICY IF EXISTS cbt_engine_insert ON public.cashbox_transactions;
CREATE POLICY cbt_read ON public.cashbox_transactions
  FOR SELECT
  USING (true);
CREATE POLICY cbt_engine_insert ON public.cashbox_transactions
  AS PERMISSIVE
  FOR INSERT
  WITH CHECK (current_setting('app.engine_context', true) = 'on');

-- financial_event_log — SELECT open, INSERT engine-gated, no UPDATE/
-- DELETE policy (append-only mirrors the existing trigger).
DROP POLICY IF EXISTS fel_read          ON public.financial_event_log;
DROP POLICY IF EXISTS fel_engine_insert ON public.financial_event_log;
CREATE POLICY fel_read ON public.financial_event_log
  FOR SELECT
  USING (true);
CREATE POLICY fel_engine_insert ON public.financial_event_log
  AS PERMISSIVE
  FOR INSERT
  WITH CHECK (current_setting('app.engine_context', true) = 'on');

-- ───────────────────────────────────────────────────────────────────
-- 4. REVOKE writes from Supabase-managed roles + PUBLIC.
-- RLS only kicks in AFTER the GRANT check passes. Roles with BYPASSRLS
-- (service_role) skip RLS entirely, so the only way to stop them is
-- to revoke the underlying privilege.
--
-- Each REVOKE is conditional on the role existing, so this migration
-- runs cleanly on non-Supabase Postgres (dev/CI) where those roles
-- are absent.
-- ───────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_role text;
  v_tbls text[] := ARRAY[
    'journal_entries',
    'journal_lines',
    'cashbox_transactions',
    'cashboxes',
    'financial_event_log'
  ];
  v_tbl  text;
BEGIN
  -- PUBLIC is always present; treat it first.
  FOREACH v_tbl IN ARRAY v_tbls LOOP
    EXECUTE format(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM PUBLIC',
      v_tbl
    );
  END LOOP;

  -- Supabase-managed roles: only revoke if they exist on this install.
  FOREACH v_role IN ARRAY ARRAY['anon','authenticated','service_role']::text[] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role) THEN
      FOREACH v_tbl IN ARRAY v_tbls LOOP
        EXECUTE format(
          'REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.%I FROM %I',
          v_tbl, v_role
        );
      END LOOP;
    END IF;
  END LOOP;
END
$$;

-- ───────────────────────────────────────────────────────────────────
-- 5. GRANT ledger writes to financial_engine_role.
-- Explicit grant so `\dp` shows one — and only one — write principal.
-- ───────────────────────────────────────────────────────────────────
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.journal_entries      TO financial_engine_role;
GRANT SELECT, INSERT, UPDATE, DELETE
  ON public.journal_lines        TO financial_engine_role;
GRANT SELECT, INSERT
  ON public.cashbox_transactions TO financial_engine_role;
GRANT SELECT, UPDATE
  ON public.cashboxes            TO financial_engine_role;
GRANT SELECT, INSERT
  ON public.financial_event_log  TO financial_engine_role;

-- Sequences the engine needs to nextval() when building entry numbers.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_class WHERE relname = 'seq_journal_entry_no') THEN
    GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.seq_journal_entry_no
      TO financial_engine_role;
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class WHERE relname = 'cashbox_transactions_id_seq'
  ) THEN
    GRANT USAGE, SELECT, UPDATE ON SEQUENCE public.cashbox_transactions_id_seq
      TO financial_engine_role;
  END IF;
END
$$;

COMMIT;
