-- Migration 112 — PR-PAY-1: payment_accounts schema + invoice_payments
--                            wiring for per-account GL routing.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   The POS payment-method system today has two structural gaps:
--
--     1) The frontend cart + DTO used a 4-value union
--        (cash | card | instapay | bank_transfer) while the DB enum
--        payment_method_code carries 10 values
--        (cash, card_visa, card_mastercard, card_meeza, instapay,
--         vodafone_cash, orange_cash, bank_transfer, credit, other).
--        Methods like `card` were silently un-insertable, so cashiers
--        only ever round-tripped cash + instapay.
--
--     2) There was no abstraction for "which InstaPay handle / wallet
--        number / POS terminal collected the money", so every non-cash
--        sale fell into a single bucket account regardless. Treasury
--        could not split InstaPay الأهلي vs CIB.
--
--   PR-PAY-1 (this migration + the matching backend) fixes the
--   schema + posting pieces. Admin UI (PAY-2), POS rich selector
--   (PAY-3), and shift-close breakdown (PAY-4) follow.
--
-- What this migration adds
--
--   1. Table `payment_accounts` — one row per concrete collection
--      channel (e.g. "InstaPay الأهلي", "Vodafone Cash 010xxxx",
--      "POS بنك مصر"). Each row carries: method (uses existing enum),
--      provider_key, display_name, identifier (handle/IBAN/terminal),
--      gl_account_code (must exist in chart_of_accounts), is_default,
--      active, sort_order, metadata.
--   2. ALTER `invoice_payments` ADD `payment_account_id` (nullable FK)
--      + `payment_account_snapshot` (jsonb — frozen copy of the
--      account at payment time, so receipts keep rendering the old
--      name even if admin renames or deactivates).
--   3. Trigger `fn_invoice_payment_account_consistency` — when
--      payment_account_id is set, requires
--      payment_accounts.method = invoice_payments.payment_method AND
--      payment_accounts.active = TRUE. Cash payments may leave it NULL.
--   4. Trigger `fn_payment_account_gl_code_must_exist` — ensures the
--      chosen gl_account_code exists in chart_of_accounts (active).
--   5. Partial unique index — at most one default-active account per
--      method.
--
-- Strict scope
--
--   · DDL only. NO data writes. NO touch on existing invoice rows.
--   · Backward-compatible: payment_account_id is NULL for every
--     historical invoice_payments row (and stays NULL until a future
--     migration explicitly backfills, with operator approval).
--   · No new accounts in chart_of_accounts (1111 / 1113 / 1114 / 1115
--     all already exist).
--   · No change to payment_method_code enum (already covers what we
--     need; PR-PAY-3 may extend later if a real `wallet`/`card` umbrella
--     is wanted).
--   · Engine context = migration:112_pr_pay_1_pay_accts (short to fit
--     financial_event_stream.source_service varchar(40), though no
--     row writes happen here so the trigger never fires).
--
-- Idempotent
--
--   Marker: existence of table `payment_accounts`. First run: not
--   present → create. Re-run: present → all CREATE statements use
--   IF NOT EXISTS / IF EXISTS guards, ALTER TABLE uses IF NOT EXISTS
--   on columns, and the validation block at the end re-asserts the
--   final shape regardless.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:112_pr_pay_1_pay_accts',
  true
);

-- ─── 1) payment_accounts table ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_accounts (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  method          payment_method_code NOT NULL,
  provider_key    text,
  display_name    text NOT NULL,
  identifier      text,
  gl_account_code text NOT NULL,
  is_default      boolean NOT NULL DEFAULT false,
  active          boolean NOT NULL DEFAULT true,
  sort_order      integer NOT NULL DEFAULT 0,
  metadata        jsonb   NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),
  created_by      uuid,
  updated_by      uuid
);

COMMENT ON TABLE payment_accounts IS
  'PR-PAY-1: concrete payment collection channels (one row per InstaPay handle, '
  'wallet number, POS terminal, bank account). admin-managed; POS chooses one '
  'per non-cash payment so the GL line lands on the right bucket.';

-- Method-aware default uniqueness: at most one is_default=true row per
-- (method) where active=true. Inactive rows can carry stale defaults
-- without blocking activation of a new one.
CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_accounts_default_per_method
  ON payment_accounts (method)
 WHERE is_default = true AND active = true;

CREATE INDEX IF NOT EXISTS ix_payment_accounts_method_active
  ON payment_accounts (method, active, sort_order);

-- ─── 2) Trigger: gl_account_code must exist in chart_of_accounts ────────
CREATE OR REPLACE FUNCTION fn_payment_account_gl_code_must_exist()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM chart_of_accounts
     WHERE code = NEW.gl_account_code
       AND is_active = TRUE
  ) INTO v_exists;
  IF NOT v_exists THEN
    RAISE EXCEPTION
      'payment_accounts.gl_account_code = % does not exist in '
      'chart_of_accounts (or is inactive). Pick an existing active code '
      '(e.g. 1111 cash, 1113 bank/card, 1114 e-wallet, 1115 check).',
      NEW.gl_account_code;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_payment_account_gl_code_must_exist ON payment_accounts;
CREATE TRIGGER trg_payment_account_gl_code_must_exist
  BEFORE INSERT OR UPDATE OF gl_account_code ON payment_accounts
  FOR EACH ROW EXECUTE FUNCTION fn_payment_account_gl_code_must_exist();

-- updated_at maintenance
CREATE OR REPLACE FUNCTION fn_payment_accounts_set_updated_at()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := NOW();
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_payment_accounts_updated_at ON payment_accounts;
CREATE TRIGGER trg_payment_accounts_updated_at
  BEFORE UPDATE ON payment_accounts
  FOR EACH ROW EXECUTE FUNCTION fn_payment_accounts_set_updated_at();

-- ─── 3) invoice_payments wiring ──────────────────────────────────────────
ALTER TABLE invoice_payments
  ADD COLUMN IF NOT EXISTS payment_account_id uuid REFERENCES payment_accounts(id);

ALTER TABLE invoice_payments
  ADD COLUMN IF NOT EXISTS payment_account_snapshot jsonb;

CREATE INDEX IF NOT EXISTS ix_invoice_payments_payment_account_id
  ON invoice_payments (payment_account_id)
 WHERE payment_account_id IS NOT NULL;

COMMENT ON COLUMN invoice_payments.payment_account_id IS
  'PR-PAY-1: nullable FK to the chosen payment_accounts row. Cash leaves '
  'this NULL. Non-cash will be required by the POS UI (PR-PAY-3) when at '
  'least one active account exists for the method.';

COMMENT ON COLUMN invoice_payments.payment_account_snapshot IS
  'PR-PAY-1: frozen jsonb copy of the payment_accounts row at payment time '
  '(display_name / provider_key / identifier / gl_account_code). Receipts '
  'render from the snapshot so admin renames or deactivations never alter '
  'historical documents.';

-- ─── 4) Trigger: account/method consistency on invoice_payments ──────────
CREATE OR REPLACE FUNCTION fn_invoice_payment_account_consistency()
RETURNS trigger LANGUAGE plpgsql AS $$
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
      'invoice_payments.payment_account_id = % does not reference an '
      'existing payment_accounts row.', NEW.payment_account_id;
  END IF;

  IF v_acc_method <> NEW.payment_method THEN
    RAISE EXCEPTION
      'invoice_payments method/account mismatch: payment_method = % but '
      'payment_account.method = %. Pick an account whose method matches.',
      NEW.payment_method, v_acc_method;
  END IF;

  -- Block NEW payments on deactivated accounts. UPDATE on existing rows
  -- is allowed so deactivation doesn't break historical edits.
  IF TG_OP = 'INSERT' AND v_acc_active = FALSE THEN
    RAISE EXCEPTION
      'invoice_payments.payment_account_id = % points to an inactive '
      'payment_accounts row. Activate it or pick another account.',
      NEW.payment_account_id;
  END IF;

  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_invoice_payment_account_consistency ON invoice_payments;
CREATE TRIGGER trg_invoice_payment_account_consistency
  BEFORE INSERT OR UPDATE OF payment_account_id, payment_method ON invoice_payments
  FOR EACH ROW EXECUTE FUNCTION fn_invoice_payment_account_consistency();

-- ─── 5) Self-validating contract ─────────────────────────────────────────
DO $$
DECLARE
  v_table_exists       boolean;
  v_col_id_exists      boolean;
  v_col_snap_exists    boolean;
  v_default_idx_exists boolean;
BEGIN
  SELECT EXISTS (SELECT 1 FROM information_schema.tables
                  WHERE table_name='payment_accounts' AND table_schema='public')
    INTO v_table_exists;
  IF NOT v_table_exists THEN
    RAISE EXCEPTION 'PR-PAY-1 post: payment_accounts table missing';
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='invoice_payments'
                    AND column_name='payment_account_id')
    INTO v_col_id_exists;
  IF NOT v_col_id_exists THEN
    RAISE EXCEPTION 'PR-PAY-1 post: invoice_payments.payment_account_id missing';
  END IF;

  SELECT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name='invoice_payments'
                    AND column_name='payment_account_snapshot')
    INTO v_col_snap_exists;
  IF NOT v_col_snap_exists THEN
    RAISE EXCEPTION 'PR-PAY-1 post: invoice_payments.payment_account_snapshot missing';
  END IF;

  SELECT EXISTS (SELECT 1 FROM pg_indexes
                  WHERE tablename='payment_accounts'
                    AND indexname='ux_payment_accounts_default_per_method')
    INTO v_default_idx_exists;
  IF NOT v_default_idx_exists THEN
    RAISE EXCEPTION 'PR-PAY-1 post: default-per-method unique index missing';
  END IF;

  RAISE NOTICE 'PR-PAY-1 post OK: payment_accounts present, invoice_payments wired, default index live';
END $$;

COMMIT;
