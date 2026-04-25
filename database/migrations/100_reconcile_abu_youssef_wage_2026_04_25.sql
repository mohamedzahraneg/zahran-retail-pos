-- Migration 100 — Reconcile Abu Youssef's missing wage approval (PR-25).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   On 2026-04-25 the admin approved Abu Youssef's daily wage:
--     · employee_payable_days row id=bfc886f6-… (kind=wage_accrual,
--       amount_accrued=270.00, override_type=full_day)
--     · JE-2026-000192 (DR 521 / CR 213 = 270, both lines tagged with
--       his user_id) — accounting was correct.
--
--   At 17:22 the same admin clicked "edit approval" (override_type
--   already full_day). The intended flow is void-existing + repost-new.
--   The void half ran on the outer transaction's EntityManager (em);
--   the repost half ran on a separate connection (this.ds.query) and
--   therefore could not see the in-flight void. fn_post_employee_wage_accrual's
--   idempotency check found the OLD row still live, returned its id,
--   and created NO replacement. The outer transaction committed the
--   void with no fresh accrual — wiping Abu Youssef's 270 EGP from his
--   ledger.
--
--   PR #125 (this PR) fixes the underlying bug by threading `em` through
--   adminMarkPayableDay / adminApproveWageFromAttendance so void+repost
--   commit atomically. This migration repairs the one row that was
--   already lost on prod before the fix landed.
--
-- Strict
--
--   · Re-posts via the canonical helper fn_post_employee_wage_accrual
--     (no manual INSERT into employee_payable_days, no manual JE/JL
--     fabrication, no cashbox writes — wage approval is an ACCRUAL,
--     not a payout)
--   · Idempotent — NOT EXISTS guard on a live wage_accrual for
--     (user, date); re-running the migration is a NOTICE no-op
--   · Abort-safe — every pre-condition checked before any write
--   · NO change to existing voided row (id=bfc886f6-…) or its voided
--     JE (JE-2026-000192) — they remain in the audit trail
--   · NO cashbox_transactions write (approval ≠ payout)
--   · NO change to cashboxes.current_balance
--   · The new accrual will be tied to the original admin user
--     (مدير النظام) for audit consistency
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

SELECT set_config(
  'app.engine_context',
  'migration:100_reconcile_abu_youssef_wage_2026_04_25',
  true
);

DO $$
DECLARE
  v_user_id            uuid := '3800f38b-cdb9-4347-bf83-2ffc215efd1f'::uuid;
  v_work_date          date := '2026-04-25';
  v_amount             numeric := 270.00;
  v_admin_id           uuid;
  v_existing_live_count int;
  v_existing_void_id   uuid;
  v_void_je_no         text;
  v_user_full_name     text;
  v_daily              numeric;
  v_target_minutes     int;
  v_new_payable_id     uuid;
  v_new_je_no          text;
BEGIN
  -- ─── Pre-condition 1: target user exists, has a daily salary ───
  SELECT full_name, salary_amount,
         CASE WHEN target_hours_day IS NOT NULL
              THEN ROUND(target_hours_day * 60)::int
              ELSE NULL END
    INTO v_user_full_name, v_daily, v_target_minutes
    FROM public.users
   WHERE id = v_user_id AND is_active = TRUE;

  IF v_user_full_name IS NULL THEN
    RAISE EXCEPTION 'reconcile-100: target user % not found or inactive', v_user_id;
  END IF;
  IF v_daily IS NULL OR v_daily <> v_amount THEN
    RAISE EXCEPTION 'reconcile-100: user % salary_amount=% (expected %)',
      v_user_id, v_daily, v_amount;
  END IF;

  -- ─── Pre-condition 2: there is exactly ONE voided wage_accrual on
  -- the target date with the matching JE — confirms the bug we're
  -- fixing (and not unrelated state).
  SELECT id INTO v_existing_void_id
    FROM employee_payable_days
   WHERE user_id = v_user_id
     AND work_date = v_work_date
     AND kind = 'wage_accrual'
     AND is_void = TRUE
   ORDER BY created_at DESC
   LIMIT 1;
  IF v_existing_void_id IS NULL THEN
    RAISE NOTICE 'reconcile-100: no voided wage_accrual found for % on % — nothing to reconcile (no-op)',
      v_user_full_name, v_work_date;
    RETURN;
  END IF;

  -- ─── Pre-condition 3: idempotency — refuse if a LIVE wage_accrual
  -- already exists (PR-25 fix in code may have produced one via a
  -- subsequent re-approval; in that case this migration is a no-op).
  SELECT COUNT(*) INTO v_existing_live_count
    FROM employee_payable_days
   WHERE user_id = v_user_id
     AND work_date = v_work_date
     AND kind = 'wage_accrual'
     AND NOT is_void;
  IF v_existing_live_count > 0 THEN
    RAISE NOTICE 'reconcile-100: live wage_accrual already exists for % on % (count=%) — no-op',
      v_user_full_name, v_work_date, v_existing_live_count;
    RETURN;
  END IF;

  -- ─── Pre-condition 4: pick the original admin (the user who voided
  -- the row). Falls back to the user who created it. Must be active.
  SELECT COALESCE(epd.voided_by, epd.created_by) INTO v_admin_id
    FROM employee_payable_days epd
   WHERE epd.id = v_existing_void_id;
  IF v_admin_id IS NULL THEN
    RAISE EXCEPTION 'reconcile-100: cannot resolve admin user from voided row %', v_existing_void_id;
  END IF;

  SELECT entry_no INTO v_void_je_no
    FROM journal_entries
   WHERE id = (SELECT journal_entry_id FROM employee_payable_days WHERE id = v_existing_void_id);

  -- ─── Apply: re-post via the canonical helper. Source = admin_manual
  -- because the original row had no attendance_record_id (the user's
  -- approval was for a no-fingerprint day).
  SELECT fn_post_employee_wage_accrual(
    v_user_id,
    v_work_date,
    v_amount,                                    -- approved amount
    'admin_manual'::text,                        -- source
    NULL::uuid,                                  -- attendance_record_id
    NULL::int,                                   -- worked_minutes
    v_daily,                                     -- daily_wage_snapshot
    v_target_minutes,                            -- target_minutes_snapshot
    'إعادة اعتماد بعد إصلاح atomicity (migration:100) — '
      || 'القيد السابق ' || COALESCE(v_void_je_no, 'JE-?')
      || ' أُلغي دون استبدال بسبب bug PR-25',    -- reason
    v_admin_id,                                  -- created_by (admin)
    v_amount,                                    -- calculated_amount (no attendance → daily)
    'full_day'::text,                            -- override_type (matches original)
    NULL::text,                                  -- approval_reason
    v_admin_id                                   -- approved_by
  ) INTO v_new_payable_id;

  IF v_new_payable_id IS NULL THEN
    RAISE EXCEPTION 'reconcile-100: fn_post_employee_wage_accrual returned NULL — refusing';
  END IF;

  SELECT entry_no INTO v_new_je_no
    FROM journal_entries
   WHERE id = (SELECT journal_entry_id FROM employee_payable_days WHERE id = v_new_payable_id);

  RAISE NOTICE 'reconcile-100: reposted wage_accrual for % on % — payable_day=%, JE=%',
    v_user_full_name, v_work_date, v_new_payable_id, COALESCE(v_new_je_no, '?');
END $$;

COMMIT;
