-- Migration 113b — PR-PAY-3.1 part 2: retag the seeded WE Pay
--                                       payment_account from method
--                                       'other' → 'wallet'.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   PR-PAY-2 (admin UI) was used to create a payment_account for WE
--   Pay during PR-PAY-3 testing. The provider catalog at the time
--   mapped the `we_pay` provider_key to enum value `other` because
--   the enum had no generic `wallet` value. `other` is intentionally
--   excluded from POS_METHODS (admin-only bucket) so WE Pay never
--   appeared for the cashier.
--
--   Migration 113 added 'wallet' to the enum (in a separate
--   transaction so the new value is committed before it's
--   referenced). This migration uses it.
--
-- The 1 affected row (verified by audit before write)
--
--     id                                   provider_key  display_name  method  used_in_invoices
--     e98a65b0-60aa-4278-ae33-ff25d03ea368 we_pay        WE Pay        other   0
--
-- Strict eligibility (every clause must hold or no UPDATE happens)
--
--   · payment_accounts.id = e98a65b0-…
--   · current method = 'other'
--   · provider_key = 'we_pay'
--   · display_name LIKE '%WE Pay%'
--   · gl_account_code = '1114' (already routed to e-wallets)
--   · active = TRUE
--   · zero references in invoice_payments.payment_account_id
--
-- Strict scope
--
--   · UPDATE on exactly one column (method) on exactly one
--     payment_accounts row.
--   · NO touch on any other payment_account.
--   · NO journal_entries / journal_lines / cashbox_transactions writes.
--   · NO invoice_payments writes (none reference this account anyway).
--   · NO accounting effect — gl_account_code stays 1114.
--   · Engine context = migration:113b_pr_pay_3_1_retag (short for
--     financial_event_stream.source_service varchar(40)).
--
-- Idempotent
--
--   The eligibility WHERE clause includes `method = 'other'` so a
--   re-run finds 0 rows. Self-validating contract at the end RAISEs
--   EXCEPTION if any invariant is broken.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:113b_pr_pay_3_1_retag',
  true
);

-- ─── Preconditions ───────────────────────────────────────────────────────
DO $$
DECLARE
  v_already   int;
  v_eligible  int;
  v_used      int;
BEGIN
  -- Idempotency short-circuit
  SELECT COUNT(*) INTO v_already FROM payment_accounts
   WHERE id = 'e98a65b0-60aa-4278-ae33-ff25d03ea368'
     AND method::text = 'wallet';
  IF v_already > 0 THEN
    RAISE NOTICE 'PR-PAY-3.1: WE Pay already retagged (re-run no-op)';
    RETURN;
  END IF;

  SELECT COUNT(*) INTO v_eligible FROM payment_accounts
   WHERE id = 'e98a65b0-60aa-4278-ae33-ff25d03ea368'
     AND method::text = 'other'
     AND provider_key = 'we_pay'
     AND display_name LIKE '%WE Pay%'
     AND gl_account_code = '1114'
     AND active = TRUE;
  IF v_eligible <> 1 THEN
    RAISE EXCEPTION 'PR-PAY-3.1 pre: WE Pay account not in expected '
      'shape (eligible=%). Aborting — manual review required.', v_eligible;
  END IF;

  SELECT COUNT(*) INTO v_used FROM invoice_payments
   WHERE payment_account_id = 'e98a65b0-60aa-4278-ae33-ff25d03ea368';
  IF v_used <> 0 THEN
    RAISE EXCEPTION 'PR-PAY-3.1 pre: WE Pay account is referenced by '
      '% invoice_payments row(s). Auto-retag refused; ship a manual '
      'reconciliation migration instead.', v_used;
  END IF;

  RAISE NOTICE 'PR-PAY-3.1 pre OK: 1 eligible row, 0 invoice references';
END $$;

-- ─── The actual update ───────────────────────────────────────────────────
UPDATE payment_accounts
   SET method = 'wallet',
       updated_at = NOW()
 WHERE id = 'e98a65b0-60aa-4278-ae33-ff25d03ea368'
   AND method::text = 'other'
   AND provider_key = 'we_pay'
   AND gl_account_code = '1114'
   AND active = TRUE;

-- ─── Postconditions ──────────────────────────────────────────────────────
DO $$
DECLARE
  v_we_pay_method text;
  v_we_pay_active boolean;
  v_we_pay_gl     text;
BEGIN
  SELECT method::text, active, gl_account_code
    INTO v_we_pay_method, v_we_pay_active, v_we_pay_gl
    FROM payment_accounts
   WHERE id = 'e98a65b0-60aa-4278-ae33-ff25d03ea368';

  IF v_we_pay_method <> 'wallet' THEN
    RAISE EXCEPTION 'PR-PAY-3.1 post: WE Pay method is %, expected wallet',
      v_we_pay_method;
  END IF;
  IF NOT v_we_pay_active THEN
    RAISE EXCEPTION 'PR-PAY-3.1 post: WE Pay no longer active';
  END IF;
  IF v_we_pay_gl <> '1114' THEN
    RAISE EXCEPTION 'PR-PAY-3.1 post: WE Pay gl_account_code drifted to %',
      v_we_pay_gl;
  END IF;

  RAISE NOTICE 'PR-PAY-3.1 post OK: WE Pay now method=wallet active=true gl=1114';
END $$;

COMMIT;
