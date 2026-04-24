-- Migration 077 — Unify journal_entries.entry_no generation under seq_journal_entry_no.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Two entry_no generators have coexisted:
--     * FinancialEngineService.recordTransaction uses
--       `nextval('seq_journal_entry_no')` → 'JE-{year}-{seq:06}'.
--     * Stored procedures fn_post_employee_{txn,bonus,deduction,advance}
--       (033/039b/039d/074) use `SELECT MAX(entry_no)+1` per year and
--       bypass the sequence entirely.
--
--   Because the stored procs don't touch the sequence, every
--   trigger-driven post (bonus, deduction, advance via requests,
--   employee_transactions.INSERT) increments the real max without
--   advancing the sequence. The sequence drifts behind, and the next
--   engine call — whose `nextval()` falls inside the gap — collides
--   with an existing entry_no and fails with:
--     duplicate key value violates unique constraint
--     "journal_entries_entry_no_key"
--
--   Observed on 2026-04-24 during PR #78 verification: seq=179 but
--   max=JE-2026-000182, so the next engine-driven settlement's first
--   attempt exploded. A one-time `setval` resynced it to 182, but the
--   same drift will reopen the moment another stored-proc posts.
--
-- Decision
--
--   Make `seq_journal_entry_no` the single source of truth. The four
--   stored procs are rewritten to use `nextval()` — same shape as the
--   engine — so every writer shares one monotonic counter.
--
--   Number format stays `JE-{entry-year}-{seq:06}`. The year is
--   derived from the source row's own date (txn_date / bonus_date /
--   deduction_date / decided_at), matching the existing convention.
--   Note: because the sequence is now globally shared across years,
--   yearly blocks of numbers are no longer contiguous — this is
--   intentional and already true for engine-written entries. The only
--   invariant that matters (and that the UNIQUE constraint enforces)
--   is cross-writer uniqueness.
--
-- Pre-flight baseline on live (2026-04-24 17:55 UTC)
--     seq_journal_entry_no.last_value   183
--     max entry_no numerical part       183   (JE-2026-000183)
--     → already in sync from PR #78 manual setval; this migration
--       re-asserts the invariant and makes drift impossible going
--       forward.
--
-- What this migration does NOT touch
--   * FinancialEngine.recordTransaction — already uses nextval(),
--     unchanged.
--   * Accounting logic — amounts, DR/CR, account codes, references,
--     dimensions — all identical to migration 074.
--   * Historical journal_entries — NO UPDATE, NO DELETE.
--   * journal_lines — NO change.
--   * Source tables (employee_bonuses / _deductions / _transactions /
--     _requests / _settlements) — untouched.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 0. Pre-sync the sequence (belt-and-braces) ────────────────────────────
-- If any drift remains at migration time, close it before the new
-- procs start calling nextval.
SELECT setval(
  'seq_journal_entry_no',
  GREATEST(
    (SELECT last_value FROM seq_journal_entry_no),
    (SELECT COALESCE(
              MAX(SUBSTRING(entry_no FROM 'JE-[0-9]+-([0-9]+)')::int),
              1
            )
       FROM journal_entries
      WHERE entry_no ~ '^JE-[0-9]+-[0-9]+$')
  ),
  true
);

-- ─── 1. fn_post_employee_txn ───────────────────────────────────────────────
-- Uses nextval('seq_journal_entry_no') instead of MAX()+1. Everything
-- else preserved byte-for-byte from migration 074.
CREATE OR REPLACE FUNCTION public.fn_post_employee_txn(p_txn_id uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    t              employee_transactions%ROWTYPE;
    v_entry_id     uuid;
    v_entry_no     text;
    v_year         int;
    v_seq          bigint;
    v_dr_acct      uuid;
    v_cr_acct      uuid;
    v_desc         text;
    v_emp_name     text;
BEGIN
    SELECT * INTO t FROM employee_transactions WHERE id = p_txn_id;
    IF NOT FOUND THEN RETURN NULL; END IF;

    CASE t.type
        WHEN 'wage', 'bonus' THEN
            v_dr_acct := fn_account_id('521');  v_cr_acct := fn_account_id('213');
        WHEN 'expense' THEN
            v_dr_acct := fn_account_id('529');  v_cr_acct := fn_account_id('213');
        WHEN 'deduction' THEN
            v_dr_acct := fn_account_id('213');  v_cr_acct := fn_account_id('521');
        WHEN 'advance' THEN
            v_dr_acct := fn_account_id('1123'); v_cr_acct := fn_account_id('1111');
        WHEN 'payout' THEN
            v_dr_acct := fn_account_id('213');  v_cr_acct := fn_account_id('1111');
        ELSE RETURN NULL;
    END CASE;
    IF v_dr_acct IS NULL OR v_cr_acct IS NULL THEN RETURN NULL; END IF;

    PERFORM set_config('app.engine_context', 'engine:payroll', true);

    SELECT full_name INTO v_emp_name FROM users WHERE id = t.employee_id;
    v_desc := format('%s — %s%s',
        CASE t.type
            WHEN 'wage' THEN 'يومية' WHEN 'bonus' THEN 'مكافأة'
            WHEN 'expense' THEN 'مصروف نيابة' WHEN 'deduction' THEN 'خصم'
            WHEN 'advance' THEN 'سلفة' WHEN 'payout' THEN 'صرف'
            ELSE t.type END,
        COALESCE(v_emp_name, 'موظف'),
        CASE WHEN t.description IS NOT NULL AND t.description <> ''
             THEN ' — ' || t.description ELSE '' END);

    v_year := EXTRACT(YEAR FROM t.txn_date)::int;
    v_seq  := nextval('seq_journal_entry_no');
    v_entry_no := 'JE-' || v_year || '-' || lpad(v_seq::text, 6, '0');

    INSERT INTO journal_entries
        (entry_no, entry_date, description, reference_type, reference_id,
         is_posted, created_by, created_at)
    VALUES (v_entry_no, t.txn_date, v_desc, 'employee_txn', t.id,
            false, t.created_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines
        (entry_id, line_no, account_id, debit, credit, description,
         employee_id, employee_user_id)
    VALUES (v_entry_id, 1, v_dr_acct, t.amount, 0, v_desc, t.employee_id, t.employee_id),
           (v_entry_id, 2, v_cr_acct, 0, t.amount, v_desc, t.employee_id, t.employee_id);

    UPDATE journal_entries
       SET is_posted = true, posted_by = t.created_by, posted_at = NOW()
     WHERE id = v_entry_id;

    RETURN v_entry_id;
END;
$$;

-- ─── 2. fn_post_employee_bonus ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_post_employee_bonus(p_bonus_id bigint)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    b              employee_bonuses%ROWTYPE;
    v_entry_id     uuid;
    v_entry_no     text;
    v_year         int;
    v_seq          bigint;
    v_dr_acct      uuid;
    v_cr_acct      uuid;
    v_desc         text;
    v_emp_name     text;
    v_ref_id       uuid;
BEGIN
    SELECT * INTO b FROM employee_bonuses WHERE id = p_bonus_id;
    IF NOT FOUND OR b.is_void THEN RETURN NULL; END IF;

    v_dr_acct := fn_account_id('521');
    v_cr_acct := fn_account_id('213');
    IF v_dr_acct IS NULL OR v_cr_acct IS NULL THEN RETURN NULL; END IF;

    PERFORM set_config('app.engine_context', 'engine:payroll', true);

    SELECT full_name INTO v_emp_name FROM users WHERE id = b.user_id;
    v_desc := format('مكافأة (%s) — %s%s',
        b.kind, COALESCE(v_emp_name, 'موظف'),
        CASE WHEN b.note IS NOT NULL AND b.note <> '' THEN ' — ' || b.note ELSE '' END);

    v_year := EXTRACT(YEAR FROM b.bonus_date)::int;
    v_seq  := nextval('seq_journal_entry_no');
    v_entry_no := 'JE-' || v_year || '-' || lpad(v_seq::text, 6, '0');
    v_ref_id := uuid_generate_v5(uuid_ns_oid(), b.id::text);

    INSERT INTO journal_entries
        (entry_no, entry_date, description, reference_type, reference_id,
         is_posted, created_by, created_at)
    VALUES (v_entry_no, b.bonus_date, v_desc, 'employee_bonus', v_ref_id,
            false, b.created_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines
        (entry_id, line_no, account_id, debit, credit, description,
         employee_id, employee_user_id)
    VALUES (v_entry_id, 1, v_dr_acct, b.amount, 0, v_desc, b.user_id, b.user_id),
           (v_entry_id, 2, v_cr_acct, 0, b.amount, v_desc, b.user_id, b.user_id);

    UPDATE journal_entries SET is_posted = true, posted_by = b.created_by, posted_at = NOW()
     WHERE id = v_entry_id;
    RETURN v_entry_id;
END;
$$;

-- ─── 3. fn_post_employee_deduction ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_post_employee_deduction(p_id bigint)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    d              employee_deductions%ROWTYPE;
    v_entry_id     uuid;
    v_entry_no     text;
    v_year         int;
    v_seq          bigint;
    v_dr_acct      uuid;
    v_cr_acct      uuid;
    v_desc         text;
    v_emp_name     text;
    v_ref_id       uuid;
BEGIN
    SELECT * INTO d FROM employee_deductions WHERE id = p_id;
    IF NOT FOUND OR d.is_void THEN RETURN NULL; END IF;

    v_dr_acct := fn_account_id('213');
    v_cr_acct := fn_account_id('521');
    IF v_dr_acct IS NULL OR v_cr_acct IS NULL THEN RETURN NULL; END IF;

    PERFORM set_config('app.engine_context', 'engine:payroll', true);

    SELECT full_name INTO v_emp_name FROM users WHERE id = d.user_id;
    v_desc := format('خصم — %s — %s', COALESCE(v_emp_name, 'موظف'), d.reason);

    v_year := EXTRACT(YEAR FROM d.deduction_date)::int;
    v_seq  := nextval('seq_journal_entry_no');
    v_entry_no := 'JE-' || v_year || '-' || lpad(v_seq::text, 6, '0');
    v_ref_id := uuid_generate_v5(uuid_ns_oid(), d.id::text);

    INSERT INTO journal_entries
        (entry_no, entry_date, description, reference_type, reference_id,
         is_posted, created_by, created_at)
    VALUES (v_entry_no, d.deduction_date, v_desc, 'employee_deduction', v_ref_id,
            false, d.created_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines
        (entry_id, line_no, account_id, debit, credit, description,
         employee_id, employee_user_id)
    VALUES (v_entry_id, 1, v_dr_acct, d.amount, 0, v_desc, d.user_id, d.user_id),
           (v_entry_id, 2, v_cr_acct, 0, d.amount, v_desc, d.user_id, d.user_id);

    UPDATE journal_entries SET is_posted = true, posted_by = d.created_by, posted_at = NOW()
     WHERE id = v_entry_id;
    UPDATE employee_deductions SET journal_entry_id = v_entry_id WHERE id = d.id;
    RETURN v_entry_id;
END;
$$;

-- ─── 4. fn_post_employee_advance ───────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.fn_post_employee_advance(p_id bigint)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE
    r              employee_requests%ROWTYPE;
    v_entry_id     uuid;
    v_entry_no     text;
    v_year         int;
    v_seq          bigint;
    v_dr_acct      uuid;
    v_cr_acct      uuid;
    v_desc         text;
    v_emp_name     text;
    v_date         date;
    v_ref_id       uuid;
BEGIN
    SELECT * INTO r FROM employee_requests WHERE id = p_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
    IF r.kind <> 'advance' OR r.status <> 'approved' OR r.amount IS NULL THEN
        RETURN NULL;
    END IF;

    v_dr_acct := fn_account_id('1123');
    v_cr_acct := fn_account_id('1111');
    IF v_dr_acct IS NULL OR v_cr_acct IS NULL THEN RETURN NULL; END IF;

    PERFORM set_config('app.engine_context', 'engine:payroll', true);

    SELECT full_name INTO v_emp_name FROM users WHERE id = r.user_id;
    v_desc := format('سلفة — %s%s',
        COALESCE(v_emp_name, 'موظف'),
        CASE WHEN r.reason IS NOT NULL AND r.reason <> '' THEN ' — ' || r.reason ELSE '' END);

    v_date := COALESCE(r.decided_at::date, r.created_at::date);
    v_year := EXTRACT(YEAR FROM v_date)::int;
    v_seq  := nextval('seq_journal_entry_no');
    v_entry_no := 'JE-' || v_year || '-' || lpad(v_seq::text, 6, '0');
    v_ref_id := uuid_generate_v5(uuid_ns_oid(), r.id::text);

    INSERT INTO journal_entries
        (entry_no, entry_date, description, reference_type, reference_id,
         is_posted, created_by, created_at)
    VALUES (v_entry_no, v_date, v_desc, 'employee_advance', v_ref_id,
            false, r.decided_by, NOW())
    RETURNING id INTO v_entry_id;

    INSERT INTO journal_lines
        (entry_id, line_no, account_id, debit, credit, description,
         employee_id, employee_user_id)
    VALUES (v_entry_id, 1, v_dr_acct, r.amount, 0, v_desc, r.user_id, r.user_id),
           (v_entry_id, 2, v_cr_acct, 0, r.amount, v_desc, r.user_id, r.user_id);

    UPDATE journal_entries SET is_posted = true, posted_by = r.decided_by, posted_at = NOW()
     WHERE id = v_entry_id;
    RETURN v_entry_id;
END;
$$;

COMMIT;
