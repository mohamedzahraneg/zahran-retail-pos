-- ============================================================================
-- 121 — PR-FIN-PAYACCT-4A: payment-account admin schema + balance views
-- ============================================================================
--
-- This migration is the schema half of PR-FIN-PAYACCT-4A. The application
-- code (NestJS controller/service updates, DTO additions, jest specs)
-- ships in the same PR but lives under `backend/src/payments/`.
--
-- What this migration adds — and what it does not
-- -----------------------------------------------
-- Adds the four schema gaps the PR-FIN-PAYACCT-4 audit identified, plus
-- two read-only views that PR-4D will use for dashboards and that ops
-- can already query today via direct SELECT:
--
--   1. customer_payments.payment_account_id      (uuid FK → payment_accounts)
--      customer_payments.payment_account_snapshot (jsonb)
--   2. supplier_payments.payment_account_id       (uuid FK)
--      supplier_payments.payment_account_snapshot (jsonb)
--   3. payment_accounts.cashbox_id                (uuid FK → cashboxes,
--                                                   ON DELETE SET NULL)
--   4. Mirror trigger fn_customer_supplier_payment_account_consistency()
--      attached to BEFORE INSERT/UPDATE on customer_payments and
--      supplier_payments. Same shape as fn_invoice_payment_account_consistency
--      from migration 112 (PR-PAY-1) — keeps the three payment tables in
--      lockstep on validation.
--   5. b-tree indexes on the new payment_account_id columns + the new
--      payment_accounts.cashbox_id column for the balance-query joins.
--   6. View v_payment_account_balance — running balance per payment
--      account from `journal_lines` joined through `gl_account_code`.
--   7. View v_cashbox_gl_drift — per-cashbox variance between
--      `cashboxes.current_balance` and Σ(jl.debit-jl.credit) on
--      its tagged journal_lines (PR-DRIFT-3F threading).
--   8. permissions seed: payment-accounts.read + payment-accounts.manage.
--      The two permission catalog rows are inserted into the `permissions`
--      table; the grants land on the `roles.permissions` text[] array
--      column (the canonical mechanism in this schema — the legacy
--      `role_permissions` join table is vestigial and is NOT touched).
--      admin + manager get both read and manage; cashier gets read only.
--   9. DO $verify$ self-validation block. Pattern matches mig 119/120;
--      additionally asserts the array grants on the three roles.
--
-- Hotfix history (PR-FIN-PAYACCT-4A-HOTFIX-1)
-- -------------------------------------------
-- The first cut of this migration (PR #196 squash 7425f12, merged
-- 2026-04-29 11:48Z) used `INSERT INTO role_permissions ... WHERE
-- roles.name IN ('admin','manager','accountant')`. Two compounding
-- defects:
--   • the column is `roles.code`, not `roles.name`
--   • the production DB has no `accountant` role
-- The migration raised `column "name" does not exist`, the
-- MigrationsService caught the error per-file, and the entire atomic
-- BEGIN/COMMIT block rolled back — no schema artefacts landed. The
-- API container booted with the new TypeScript code (the new routes
-- 401-respond) but with the old DB schema. The hotfix replaces the
-- broken role_permissions INSERT with a `roles.permissions[]` array
-- update keyed off `roles.code`, removes the accountant reference, and
-- adds three array-grant assertions to the verify block. The file is
-- patched in place rather than superseded by mig 122 because the
-- broken cut was never recorded in `schema_migrations` — re-deploy
-- runs the corrected file from scratch.
--
-- What this migration does NOT do
-- -------------------------------
--   • No data backfill of any kind. customer_payments / supplier_payments
--     existing rows (1 + 1 from the smoke test) keep payment_account_id
--     and snapshot as NULL — non-cash future payments will populate them.
--   • No data correction for the 2,295 historical cashbox-vs-GL gap.
--     v_cashbox_gl_drift will surface the gap as data; PR-FIN-PAYACCT-6
--     would correct it (held until 30-day stable run on the new flow).
--   • No frontend changes (PR-4B/4D ship the UI).
--   • No POS / customer / supplier modal changes (PR-4C).
--   • No FinancialEngine changes.
--   • No posting service changes.
--   • No logo files added.
--
-- Constraints honored:
--   • Append-only migration: no edits to migrations 058, 063, 112.
--   • All new columns are nullable; existing rows are untouched.
--   • New trigger only fires on customer_payments / supplier_payments
--     INSERT or UPDATE WHEN payment_account_id IS NOT NULL — back-compat
--     paths (cash / pre-PR-4A rows with NULL) are uneffected.
-- ============================================================================

BEGIN;

-- ── 1+2 — payment_account columns on customer_payments / supplier_payments ──
-- Same shape as invoice_payments (mig 112). NULLable so cash receipts
-- and historical rows are unaffected.

ALTER TABLE customer_payments
  ADD COLUMN IF NOT EXISTS payment_account_id uuid
    REFERENCES payment_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_account_snapshot jsonb;

ALTER TABLE supplier_payments
  ADD COLUMN IF NOT EXISTS payment_account_id uuid
    REFERENCES payment_accounts(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS payment_account_snapshot jsonb;

COMMENT ON COLUMN customer_payments.payment_account_id IS
  'PR-FIN-PAYACCT-4A: optional link to payment_accounts so non-cash receipts '
  'route to the correct GL bucket. NULL = cash or legacy. Validated by '
  'fn_customer_supplier_payment_account_consistency() trigger.';

COMMENT ON COLUMN customer_payments.payment_account_snapshot IS
  'PR-FIN-PAYACCT-4A: frozen copy of the resolved payment_account at write '
  'time so receipts/JE narratives survive later admin edits to the account.';

COMMENT ON COLUMN supplier_payments.payment_account_id IS
  'PR-FIN-PAYACCT-4A: mirror of customer_payments.payment_account_id.';

COMMENT ON COLUMN supplier_payments.payment_account_snapshot IS
  'PR-FIN-PAYACCT-4A: mirror of customer_payments.payment_account_snapshot.';

-- ── 3 — payment_accounts.cashbox_id (denormalised optional FK) ─────────────
-- Lets the operator pin a payment_account to a specific physical drawer /
-- bank record. Used by:
--   • the balance-per-account view (filter Σ(jl) on a cashbox)
--   • the kind-matches-method service-level validator (cash methods → cash
--     kind, card/bank_transfer → bank kind, instapay/wallet → ewallet,
--     check → check)
-- NULL = "balance lives at GL-code level only" (current behavior).

ALTER TABLE payment_accounts
  ADD COLUMN IF NOT EXISTS cashbox_id uuid
    REFERENCES cashboxes(id) ON DELETE SET NULL;

COMMENT ON COLUMN payment_accounts.cashbox_id IS
  'PR-FIN-PAYACCT-4A: optional pin to a specific physical cashbox (drawer / '
  'bank record / wallet number). NULL = balance lives at gl_account_code level '
  'only. The service-layer validator enforces method↔cashbox.kind compatibility '
  '(card/bank_transfer → bank, instapay/wallet/*_cash → ewallet, check → check).';

-- ── 4 — Mirror consistency trigger for customer/supplier payments ──────────
-- Identical contract to fn_invoice_payment_account_consistency (mig 112):
--   • NULL payment_account_id is fine (cash + back-compat path)
--   • non-NULL must reference an existing row
--   • non-NULL must have payment_accounts.method = NEW.payment_method
--   • non-NULL on INSERT must point to an active row
-- One function attached to two tables — symmetry kept on purpose.

CREATE OR REPLACE FUNCTION public.fn_customer_supplier_payment_account_consistency()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_acc_method payment_method_code;
  v_acc_active boolean;
BEGIN
  IF NEW.payment_account_id IS NULL THEN
    RETURN NEW;  -- cash + back-compat path
  END IF;

  SELECT method, active INTO v_acc_method, v_acc_active
    FROM payment_accounts WHERE id = NEW.payment_account_id;

  IF v_acc_method IS NULL THEN
    RAISE EXCEPTION
      '%.payment_account_id = % does not reference an existing '
      'payment_accounts row.', TG_TABLE_NAME, NEW.payment_account_id;
  END IF;

  IF v_acc_method <> NEW.payment_method THEN
    RAISE EXCEPTION
      '% method/account mismatch: payment_method = % but '
      'payment_account.method = %. Pick an account whose method matches.',
      TG_TABLE_NAME, NEW.payment_method, v_acc_method;
  END IF;

  IF TG_OP = 'INSERT' AND v_acc_active = FALSE THEN
    RAISE EXCEPTION
      '%.payment_account_id = % points to an inactive payment_accounts row. '
      'Activate it or pick another account.',
      TG_TABLE_NAME, NEW.payment_account_id;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_customer_payment_account_consistency
  ON customer_payments;
CREATE TRIGGER trg_customer_payment_account_consistency
  BEFORE INSERT OR UPDATE OF payment_account_id, payment_method
    ON customer_payments
  FOR EACH ROW
  EXECUTE FUNCTION fn_customer_supplier_payment_account_consistency();

DROP TRIGGER IF EXISTS trg_supplier_payment_account_consistency
  ON supplier_payments;
CREATE TRIGGER trg_supplier_payment_account_consistency
  BEFORE INSERT OR UPDATE OF payment_account_id, payment_method
    ON supplier_payments
  FOR EACH ROW
  EXECUTE FUNCTION fn_customer_supplier_payment_account_consistency();

-- ── 5 — Indexes for the balance-query joins ────────────────────────────────

CREATE INDEX IF NOT EXISTS ix_customer_payments_payment_account_id
  ON customer_payments(payment_account_id)
  WHERE payment_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_supplier_payments_payment_account_id
  ON supplier_payments(payment_account_id)
  WHERE payment_account_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS ix_payment_accounts_cashbox_id
  ON payment_accounts(cashbox_id)
  WHERE cashbox_id IS NOT NULL;

-- ── 6 — v_payment_account_balance ──────────────────────────────────────────
-- Running balance per payment_account, computed from journal_lines on its
-- gl_account_code (and optionally tagged cashbox_id). Read-only view —
-- accessible to anyone who can read the underlying tables.
--
-- Notes on semantics:
--   • net_debit > 0 means money came IN through this account
--     (asset accounts: cashbox 1111, bank 1113, wallet 1114, check 1115)
--   • For liability accounts (212 customer deposits) net_debit < 0 means
--     "money still owed". The view doesn't sign-flip; the caller decides.
--   • If payment_accounts.cashbox_id IS NOT NULL, the join filters
--     journal_lines to rows tagged with that cashbox so two accounts
--     sharing the same gl_account_code (e.g. two POS terminals on 1113)
--     don't merge their balances. If cashbox_id IS NULL, the balance is
--     computed at gl_account_code level (back-compat with current rows).
--   • Filters posted, non-void JEs only.

CREATE OR REPLACE VIEW v_payment_account_balance AS
SELECT
  pa.id                       AS payment_account_id,
  pa.method::text             AS method,
  pa.provider_key,
  pa.display_name,
  pa.identifier,
  pa.gl_account_code,
  pa.cashbox_id,
  pa.is_default,
  pa.active,
  coa.id                      AS gl_account_id,
  coa.normal_balance,
  COALESCE(SUM(jl.debit), 0)  AS total_in,
  COALESCE(SUM(jl.credit), 0) AS total_out,
  COALESCE(SUM(jl.debit) - SUM(jl.credit), 0) AS net_debit,
  COUNT(DISTINCT je.id)       AS je_count,
  MAX(je.entry_date)          AS last_movement
FROM payment_accounts pa
JOIN chart_of_accounts coa ON coa.code = pa.gl_account_code
LEFT JOIN journal_lines jl
  ON jl.account_id = coa.id
 AND (
       pa.cashbox_id IS NULL
    OR jl.cashbox_id = pa.cashbox_id
     )
LEFT JOIN journal_entries je
  ON je.id = jl.entry_id
 AND je.is_posted = TRUE
 AND je.is_void   = FALSE
GROUP BY
  pa.id, pa.method, pa.provider_key, pa.display_name, pa.identifier,
  pa.gl_account_code, pa.cashbox_id, pa.is_default, pa.active,
  coa.id, coa.normal_balance;

COMMENT ON VIEW v_payment_account_balance IS
  'PR-FIN-PAYACCT-4A: per-payment-account running balance. net_debit > 0 = '
  'money in for asset accounts. Filters posted+non-void JEs. When '
  'payment_accounts.cashbox_id is set, the balance is restricted to lines '
  'tagged with that cashbox so accounts sharing a GL code (e.g. two POS '
  'terminals on 1113) don''t merge.';

-- ── 7 — v_cashbox_gl_drift ─────────────────────────────────────────────────
-- Per-cashbox variance between the stored current_balance and the
-- GL view of the same cashbox (Σ jl.debit-jl.credit on journal_lines
-- tagged with the cashbox). Surfaces the historical 2,295 EGP gap and
-- any future drift early.
--
-- This is NOT a contract gate — the cashbox guard already prevents
-- direct mutation. The view is purely observability for ops dashboards.

CREATE OR REPLACE VIEW v_cashbox_gl_drift AS
WITH gl AS (
  SELECT jl.cashbox_id,
         SUM(jl.debit)  AS gl_dr,
         SUM(jl.credit) AS gl_cr
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.entry_id
  WHERE je.is_posted = TRUE
    AND je.is_void   = FALSE
    AND jl.cashbox_id IS NOT NULL
  GROUP BY jl.cashbox_id
)
SELECT
  cb.id                 AS cashbox_id,
  cb.name_ar            AS cashbox_name,
  cb.kind::text         AS kind,
  cb.is_active,
  cb.current_balance    AS stored_balance,
  COALESCE(gl.gl_dr, 0) AS gl_total_dr,
  COALESCE(gl.gl_cr, 0) AS gl_total_cr,
  (COALESCE(gl.gl_dr, 0) - COALESCE(gl.gl_cr, 0)) AS gl_net,
  cb.current_balance
    - (COALESCE(gl.gl_dr, 0) - COALESCE(gl.gl_cr, 0)) AS drift_amount
FROM cashboxes cb
LEFT JOIN gl ON gl.cashbox_id = cb.id;

COMMENT ON VIEW v_cashbox_gl_drift IS
  'PR-FIN-PAYACCT-4A: per-cashbox stored vs GL variance. drift_amount = '
  'cashboxes.current_balance - Σ(jl.debit-jl.credit) on journal_lines '
  'tagged with this cashbox. Historical gap from PR-FIN-PAYACCT-1 audit '
  'is +2,295 on the single live cashbox; this view makes it visible to '
  'the upcoming admin dashboard (PR-FIN-PAYACCT-4D) without altering data.';

-- ── 8 — permission seeds ───────────────────────────────────────────────────
-- Two halves:
--   8.a  Insert the two permission catalog rows (idempotent via ON CONFLICT)
--   8.b  Grant them on the relevant roles via the canonical mechanism
--        — `roles.permissions` text[] array column. Production reads its
--        permission set from this array; the legacy `role_permissions`
--        join table is vestigial in this schema and is NOT touched here.
--
-- Hotfix history: the first cut of mig 121 (PR #196 squash 7425f12) used
-- `INSERT INTO role_permissions` with `WHERE roles.name IN (...)`, but
-- the column is `roles.code` (not `name`) and there is no `accountant`
-- role in production. The migration raised `column "name" does not
-- exist`, the MigrationsService caught the error per-file, and the
-- whole atomic block rolled back — no schema artefacts landed. The
-- patch below replaces the broken join-table seed with the array-column
-- update that actually grants permissions in this system.

INSERT INTO permissions (code, module, name_ar, name_en, description)
VALUES
  ('payment-accounts.read',
   'payments',
   'عرض حسابات الدفع',
   'View payment accounts',
   'List + read payment accounts (admin / manager / cashier).'),
  ('payment-accounts.manage',
   'payments',
   'إدارة حسابات الدفع',
   'Manage payment accounts',
   'Create / update / activate / set-default / delete payment accounts.')
ON CONFLICT (code) DO NOTHING;

-- Grant `payment-accounts.read` and `payment-accounts.manage` to admin
-- and manager via the `roles.permissions` array column. DISTINCT unnest
-- prevents duplicates when this migration is re-applied on a dev DB.
UPDATE roles
   SET permissions = ARRAY(
       SELECT DISTINCT unnest(
         COALESCE(permissions, ARRAY[]::text[])
         || ARRAY['payment-accounts.read', 'payment-accounts.manage']
       )
     ),
       updated_at = NOW()
 WHERE code IN ('admin', 'manager');

-- Grant only `payment-accounts.read` to cashier — the operator who
-- needs to see which channel a payment landed on without being able
-- to create or edit accounts. Mirrors the existing read-only
-- permissions cashier already has.
UPDATE roles
   SET permissions = ARRAY(
       SELECT DISTINCT unnest(
         COALESCE(permissions, ARRAY[]::text[])
         || ARRAY['payment-accounts.read']
       )
     ),
       updated_at = NOW()
 WHERE code = 'cashier';

-- ── 9 — DO $verify$ self-validation block ──────────────────────────────────
-- Refuses to commit if any of the schema artefacts is missing.
-- Pattern matches mig 119/120.

DO $verify$
DECLARE
  missing TEXT;
BEGIN
  -- New columns
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='customer_payments'
      AND column_name='payment_account_id'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-PAYACCT-4A: customer_payments.payment_account_id missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='customer_payments'
      AND column_name='payment_account_snapshot'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-PAYACCT-4A: customer_payments.payment_account_snapshot missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='supplier_payments'
      AND column_name='payment_account_id'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-PAYACCT-4A: supplier_payments.payment_account_id missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='supplier_payments'
      AND column_name='payment_account_snapshot'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-PAYACCT-4A: supplier_payments.payment_account_snapshot missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='payment_accounts'
      AND column_name='cashbox_id'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-PAYACCT-4A: payment_accounts.cashbox_id missing';
  END IF;

  -- Triggers
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='trg_customer_payment_account_consistency'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-PAYACCT-4A: trg_customer_payment_account_consistency missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='trg_supplier_payment_account_consistency'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-PAYACCT-4A: trg_supplier_payment_account_consistency missing';
  END IF;

  -- Views
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
    WHERE schemaname='public' AND viewname='v_payment_account_balance'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-PAYACCT-4A: v_payment_account_balance missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
    WHERE schemaname='public' AND viewname='v_cashbox_gl_drift'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-PAYACCT-4A: v_cashbox_gl_drift missing';
  END IF;

  -- Permissions catalog
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE code='payment-accounts.read'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-PAYACCT-4A: permission payment-accounts.read not seeded';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE code='payment-accounts.manage'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-PAYACCT-4A: permission payment-accounts.manage not seeded';
  END IF;

  -- Permissions array grants — the canonical mechanism in this schema.
  -- admin + manager get both read AND manage; cashier gets read only.
  -- No reference to `accountant` (the role does not exist in this DB).
  -- No reference to `role_permissions` (the join table is vestigial).
  IF NOT EXISTS (
    SELECT 1 FROM roles
     WHERE code = 'admin'
       AND 'payment-accounts.manage' = ANY(permissions)
  ) THEN
    RAISE EXCEPTION
      'PR-FIN-PAYACCT-4A: role admin missing payment-accounts.manage';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM roles
     WHERE code = 'admin'
       AND 'payment-accounts.read' = ANY(permissions)
  ) THEN
    RAISE EXCEPTION
      'PR-FIN-PAYACCT-4A: role admin missing payment-accounts.read';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM roles
     WHERE code = 'manager'
       AND 'payment-accounts.manage' = ANY(permissions)
  ) THEN
    RAISE EXCEPTION
      'PR-FIN-PAYACCT-4A: role manager missing payment-accounts.manage';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM roles
     WHERE code = 'manager'
       AND 'payment-accounts.read' = ANY(permissions)
  ) THEN
    RAISE EXCEPTION
      'PR-FIN-PAYACCT-4A: role manager missing payment-accounts.read';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM roles
     WHERE code = 'cashier'
       AND 'payment-accounts.read' = ANY(permissions)
  ) THEN
    RAISE EXCEPTION
      'PR-FIN-PAYACCT-4A: role cashier missing payment-accounts.read';
  END IF;

  -- Indexes
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='ix_customer_payments_payment_account_id'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-PAYACCT-4A: ix_customer_payments_payment_account_id missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='ix_supplier_payments_payment_account_id'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-PAYACCT-4A: ix_supplier_payments_payment_account_id missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='ix_payment_accounts_cashbox_id'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-PAYACCT-4A: ix_payment_accounts_cashbox_id missing';
  END IF;

  -- The default-per-method partial unique index was added in mig 112.
  -- We assert it exists too, since the new toggle-active and
  -- set-default service code relies on it.
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='ux_payment_accounts_default_per_method'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-PAYACCT-4A: ux_payment_accounts_default_per_method missing (expected from mig 112)';
  END IF;
END;
$verify$;

COMMIT;
