-- Migration 097 — Targeted reconciliation: insert the missing cashbox
--                  mirror for cash refund RET-2026-000001.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   PR #120 (refund-consistency-audit) surfaced exactly one row on
--   prod where the GL credited a cash account but the cashbox mirror
--   was never inserted:
--
--     RET-2026-000001  (cash refund, 250.00 EGP, refunded 2026-04-25T17:00Z)
--       JE-2026-000222  →  CR 1111 الخزينة الرئيسية = 250.00
--       cashbox_transactions for this return.id  →  ZERO rows
--
--   The result: GL cash account 1111 is 250 EGP lower than the
--   physical cashboxes.current_balance for الخزينة الرئيسية. Both
--   sides are internally balanced (trial balance = 0, per-cashbox
--   drift = 0) so the existing checks didn't surface the gap.
--
--   This migration inserts the missing cashbox_transactions row by
--   calling the canonical helper `fn_record_cashbox_txn` (introduced
--   in migration 035, hardened with engine-context gate in 058).
--   The helper:
--     · validates direction + amount
--     · locks the cashbox row FOR UPDATE
--     · inserts the cashbox_transactions row (with balance_after)
--     · updates cashboxes.current_balance atomically
--   Calling it via this migration is the same path the engine itself
--   uses — no manual cashbox.current_balance edit, no journal_lines
--   write, no FinancialEngine bypass.
--
--   Target shift confirmed live: SHF-2026-00006 (open) on
--   الخزينة الرئيسية, opened 2026-04-25T07:57Z. It is the unique
--   open shift on this cashbox (PR-R0 audit showed the candidate is
--   unambiguous), so the new cashbox txn naturally falls inside the
--   shift's window and will surface in its closing summary via the
--   existing time-window match in computeSummary.
--
-- Strict
--
--   · NO new journal_entries created
--   · NO journal_lines edited
--   · NO manual cashbox.current_balance edit
--   · NO duplicate row (NOT EXISTS guard)
--   · NO change to JE-2026-000222 (still posted, still balanced)
--   · Idempotent: re-running the migration is a no-op (NOTICE only)
--   · Abort-safe: any pre-condition mismatch raises EXCEPTION before
--     any write happens, so partial state is impossible
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- The cashbox helper is gated by `app.engine_context` (migration 058).
-- Setting `migration:*` is the canonical pattern used by every prior
-- corrective migration in this codebase (e.g. migration 093, 095).
SET LOCAL app.engine_context = 'migration:097_reconcile_ret_2026_000001';

DO $$
DECLARE
  v_return_id          uuid;
  v_return_amount      numeric;
  v_return_method      text;
  v_return_status      text;
  v_je_id              uuid;
  v_je_void            boolean;
  v_je_cash_credit     numeric;
  v_je_balanced        boolean;
  v_existing_ct_count  int;
  v_target_shift_id    uuid;
  v_target_shift_no    text;
  v_target_cashbox_id  uuid;
  v_target_cashbox_name text;
  v_open_shift_count   int;
  v_balance_before     numeric;
  v_balance_after      numeric;
  v_new_txn_id         bigint;
BEGIN
  -- ─── Pre-condition 1: return exists with the expected shape ───
  SELECT id, net_refund::numeric, refund_method::text, status::text
    INTO v_return_id, v_return_amount, v_return_method, v_return_status
    FROM returns
   WHERE return_no = 'RET-2026-000001';

  IF v_return_id IS NULL THEN
    RAISE EXCEPTION 'reconcile-097: RET-2026-000001 not found — refusing to apply';
  END IF;
  IF v_return_status <> 'refunded' THEN
    RAISE EXCEPTION 'reconcile-097: RET-2026-000001 status is % (expected refunded)', v_return_status;
  END IF;
  IF v_return_method <> 'cash' THEN
    RAISE EXCEPTION 'reconcile-097: RET-2026-000001 refund_method is % (expected cash)', v_return_method;
  END IF;
  IF v_return_amount IS NULL OR v_return_amount <> 250.00 THEN
    RAISE EXCEPTION 'reconcile-097: RET-2026-000001 net_refund is % (expected 250.00)', v_return_amount;
  END IF;

  -- ─── Pre-condition 2: JE-2026-000222 exists, posted, not void ───
  SELECT id, is_void
    INTO v_je_id, v_je_void
    FROM journal_entries
   WHERE entry_no = 'JE-2026-000222'
     AND is_posted = TRUE;

  IF v_je_id IS NULL THEN
    RAISE EXCEPTION 'reconcile-097: JE-2026-000222 not found or not posted';
  END IF;
  IF v_je_void THEN
    RAISE EXCEPTION 'reconcile-097: JE-2026-000222 is voided — refund was reversed; do not insert mirror';
  END IF;

  -- ─── Pre-condition 3: JE credits cash 1111 by exactly 250.00 ───
  SELECT COALESCE(SUM(jl.credit), 0)
    INTO v_je_cash_credit
    FROM journal_lines jl
    JOIN chart_of_accounts coa ON coa.id = jl.account_id
   WHERE jl.entry_id = v_je_id
     AND coa.code = '1111'
     AND jl.credit > 0;

  IF v_je_cash_credit <> 250.00 THEN
    RAISE EXCEPTION 'reconcile-097: JE-2026-000222 cash 1111 credit is % (expected 250.00)', v_je_cash_credit;
  END IF;

  -- ─── Pre-condition 4: JE is balanced ───
  SELECT (SUM(jl.debit) = SUM(jl.credit))
    INTO v_je_balanced
    FROM journal_lines jl
   WHERE jl.entry_id = v_je_id;

  IF NOT v_je_balanced THEN
    RAISE EXCEPTION 'reconcile-097: JE-2026-000222 is unbalanced — refusing to apply';
  END IF;

  -- ─── Pre-condition 5: NO existing cashbox mirror (idempotency) ───
  SELECT COUNT(*) INTO v_existing_ct_count
    FROM cashbox_transactions
   WHERE reference_type::text = 'return'
     AND reference_id = v_return_id;

  IF v_existing_ct_count > 0 THEN
    RAISE NOTICE 'reconcile-097: cashbox mirror already exists (count=%) — no-op', v_existing_ct_count;
    RETURN;
  END IF;

  -- ─── Pre-condition 6: unique open/pending shift on the main
  -- cashbox (الخزينة الرئيسية). Multiple open shifts on the same
  -- cashbox ⇒ stop and require manual disambiguation. The PR-R0
  -- preflight verified at audit time that exactly one shift
  -- (SHF-2026-00006, status=open) was a candidate; we re-verify
  -- here in case the live state changed.
  SELECT COUNT(*) INTO v_open_shift_count
    FROM shifts s
    JOIN cashboxes cb ON cb.id = s.cashbox_id
   WHERE s.status IN ('open', 'pending_close')
     AND cb.name_ar LIKE '%الرئيسية%';

  IF v_open_shift_count = 0 THEN
    RAISE EXCEPTION 'reconcile-097: no open/pending shift on الخزينة الرئيسية — refusing to apply';
  END IF;
  IF v_open_shift_count > 1 THEN
    RAISE EXCEPTION 'reconcile-097: % open/pending shifts on الخزينة الرئيسية — ambiguous, manual review required', v_open_shift_count;
  END IF;

  SELECT s.id, s.shift_no::text, s.cashbox_id, cb.name_ar
    INTO v_target_shift_id, v_target_shift_no, v_target_cashbox_id, v_target_cashbox_name
    FROM shifts s
    JOIN cashboxes cb ON cb.id = s.cashbox_id
   WHERE s.status IN ('open', 'pending_close')
     AND cb.name_ar LIKE '%الرئيسية%';

  -- Snapshot the cashbox balance before the helper runs so the
  -- NOTICE can show the exact delta.
  SELECT current_balance INTO v_balance_before
    FROM cashboxes WHERE id = v_target_cashbox_id;

  -- ─── Apply: insert the missing cashbox mirror via the canonical helper ───
  -- fn_record_cashbox_txn locks the cashbox row, inserts the txn,
  -- updates current_balance atomically. No separate UPDATE on
  -- cashboxes.current_balance happens here.
  v_new_txn_id := public.fn_record_cashbox_txn(
    p_cashbox_id     := v_target_cashbox_id,
    p_direction      := 'out',
    p_amount         := 250.00,
    p_category       := 'refund',
    p_reference_type := 'return',
    p_reference_id   := v_return_id,
    p_user_id        := (SELECT refunded_by FROM returns WHERE id = v_return_id),
    p_notes          :=
      'تصحيح مرآة خزنة لمرتجع نقدي RET-2026-000001 — '
      || 'JE-2026-000222 سبق وحرّك حساب 1111 لكن سطر الخزنة لم يُكتب. '
      || 'تم تطبيق الإصلاح عبر migration:097.'
  );

  SELECT current_balance INTO v_balance_after
    FROM cashboxes WHERE id = v_target_cashbox_id;

  RAISE NOTICE 'reconcile-097: inserted cashbox txn id=% on shift % (cashbox %): balance % → % (Δ=%)',
    v_new_txn_id, v_target_shift_no, v_target_cashbox_name,
    v_balance_before, v_balance_after, (v_balance_after - v_balance_before);
END $$;

COMMIT;
