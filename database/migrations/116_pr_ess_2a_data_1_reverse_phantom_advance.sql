-- ────────────────────────────────────────────────────────────────────
-- Migration 116 — PR-ESS-2A-DATA-1 (V3)
-- Reverse the phantom 1.00 EGP advance JE created by the legacy
-- `fn_mirror_advance_to_txn` cascade BEFORE migration 114 was applied.
-- ────────────────────────────────────────────────────────────────────
--
-- Why this exists
-- ───────────────
-- On 2026-04-27 07:06:18 UTC, before PR-ESS-2A-HOTFIX-1 shipped, a
-- manager approved `employee_requests.id = 2` (kind='advance',
-- amount=1.00 EGP, employee=ابو يوسف). The legacy trigger chain on
-- `employee_requests` mirrored that approval into:
--
--   employee_transactions  d324e975-e36e-4fb6-b97b-028bd8b65425
--   journal_entries        5dae9c41-76e8-424a-bf9d-6735e51a6c14
--                          (entry_no JE-2026-000266)
--   journal_lines × 2      DR 1123 1.00 / CR 1111 1.00
--
-- No actual cash moved, no cashbox_transactions row was written, and
-- no expense was created. Migration 114 introduced a safe
-- `advance_request` kind so future approvals bypass that trigger; this
-- migration cleans up the single phantom record left behind by the
-- pre-hotfix approval.
--
-- Correction strategy (Path C2 per the user's directive — read-only
-- audit trail preserved):
--
--   · Insert a NEW reversal journal_entries row with mirrored
--     DR/CR (DR 1111 1.00 / CR 1123 1.00) tagged with
--     `reversal_of = <phantom_je_id>`. After lines are written, flip
--     the JE to `is_posted=TRUE` AND `is_void=TRUE` in a single
--     UPDATE — matching the pattern used by `fn_post_employee_advance`
--     and `fn_post_employee_txn` (the very functions that produced the
--     phantom). The DB guard `fn_je_no_insert_posted` rejects INSERTs
--     with `is_posted=TRUE`; we honour that contract here.
--
--   · Mark the original phantom JE `is_void=TRUE` with a clear
--     `void_reason` referencing this migration.
--
--   · Annotate the legacy `employee_requests.id = 2` with a
--     decision_reason note (status / kind / amount left unchanged
--     so the audit trail of "this advance was approved" remains
--     intact, but the books are reconciled).
--
--   · employee_transactions row d324e975-... is NOT deleted and NOT
--     mutated.
--
--   · No cashbox_transactions, expenses, or settlements writes.
--
-- Safety / context
-- ────────────────
-- The journal_entries / journal_lines guard (migration 063 + 068)
-- accepts `app.engine_context LIKE 'migration:%'` (any length, silent
-- — no engine_bypass_alerts row written). The `apply_migration` runner
-- sets that context automatically; we ALSO set it explicitly inside
-- the migration so the file is safe to replay manually if needed.
--
-- V3 changes vs V2
-- ────────────────
-- V2 inserted the reversal JE with `is_posted=TRUE` directly. That
-- failed at apply time because `fn_je_no_insert_posted` rejects it.
-- The transaction rolled back atomically; no partial state.
--
-- V3 splits the reversal write into the canonical draft → post + void
-- pattern:
--
--   Step 2: INSERT reversal JE as DRAFT  (is_posted=FALSE, void fields NULL)
--   Step 3: INSERT reversal journal_lines (mirrored DR 1111 / CR 1123)
--   Step 3.5: UPDATE reversal JE — is_posted=TRUE AND is_void=TRUE
--             AND voided_at/by/reason set, posted_at/by set.
--
-- The semantics, all 11 self-validation invariants, the idempotency
-- contract, and every UUID/account mapping are unchanged from V2.
--
-- Idempotency
-- ───────────
-- Pre-validation classifies the live state into exactly one of:
--   FRESH        — original.is_void=FALSE AND no reversal exists
--                  → run all writes, run final validation
--   COMPLETE     — original.is_void=TRUE AND reversal exists AND
--                  reversal is_posted=TRUE AND is_void=TRUE AND
--                  reversal_of=original
--                  → skip writes (every WHERE-guard makes them no-ops),
--                    run final validation only
--   INCONSISTENT — anything else (e.g. reversal exists but original
--                  not voided, or reversal exists in a draft state)
--                  → abort with EXCEPTION; manual escalation required.
--                    A Postgres transaction is atomic, so this state
--                    can only arise from out-of-band manual SQL or a
--                    truly catastrophic rollback failure. We refuse
--                    to touch it.
--
-- Self-validation
-- ───────────────
-- A DO block at the end verifies (post-condition assertions):
--   1. Original JE is_void=TRUE
--   2. Reversal JE exists, is_posted=TRUE, is_void=TRUE,
--      reversal_of=original (covers the "draft cannot remain unposted"
--      requirement explicitly via assertion 2)
--   3. Reversal JL pair: 1.00 DR + 1.00 CR with mirrored accounts
--      AND cashbox_id IS NULL AND warehouse_id IS NULL on both lines
--   4. Net non-void effect on account 1123 across (original + reversal)
--      = 0
--   5. Net non-void effect on account 1111 across (original + reversal)
--      = 0
--   6. trial_balance over non-void entries = 0
--   7. employee_transactions count unchanged vs. pre-migration snapshot
--   8. cashbox_transactions count unchanged vs. pre-migration snapshot
--   9. expenses count unchanged vs. pre-migration snapshot
--  10. v_cashbox_drift_per_ref total = 0
--  11. cashboxes.current_balance == sum of active cashbox_transactions
--      for every cashbox (drift count = 0)
-- Any deviation raises EXCEPTION → the migration's wrapping
-- transaction is rolled back. The migration file does NOT contain its
-- own BEGIN/COMMIT.

-- ────────────────────────────────────────────────────────────────────
-- Step 0 — set engine context so the GL guard accepts our writes
--          silently. The runner already sets a `migration:*` context
--          when applying migrations; we set it explicitly here so the
--          file is safe to replay manually.
-- ────────────────────────────────────────────────────────────────────
SELECT set_config('app.engine_context', 'migration:pr_ess_2a_data_1', true);

-- ────────────────────────────────────────────────────────────────────
-- Step 1 — STRICT PRE-VALIDATION (no writes)
-- ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_orig         journal_entries%ROWTYPE;
  v_dr_line      journal_lines%ROWTYPE;
  v_cr_line      journal_lines%ROWTYPE;
  v_reversal     journal_entries%ROWTYPE;
  v_reversal_id  UUID;
  v_ct_count     INT;
  v_orig_id      CONSTANT UUID := '5dae9c41-76e8-424a-bf9d-6735e51a6c14';
  v_orig_txn_id  CONSTANT UUID := 'd324e975-e36e-4fb6-b97b-028bd8b65425';
  v_acct_1123    CONSTANT UUID := '5cf0dbfc-4433-439f-b2cf-3805a79a3f29';
  v_acct_1111    CONSTANT UUID := 'a7e9457c-b863-488c-9f67-38c5598df0d1';
BEGIN
  -- 1.a) Original JE must exist.
  SELECT * INTO v_orig FROM journal_entries WHERE id = v_orig_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'pre-validation 1.a failed: original phantom JE % not found', v_orig_id;
  END IF;

  -- 1.b) Detect a pre-existing reversal entry, if any.
  SELECT * INTO v_reversal
  FROM journal_entries WHERE reversal_of = v_orig_id;
  v_reversal_id := v_reversal.id;

  -- 1.b.i) COMPLETE state: original voided AND reversal fully posted+voided
  --        → idempotent re-entry. Skip writes; final validation runs.
  IF v_orig.is_void
     AND v_reversal_id IS NOT NULL
     AND v_reversal.is_posted = TRUE
     AND v_reversal.is_void = TRUE
     AND v_reversal.reversal_of = v_orig_id THEN
    RAISE NOTICE
      'pre-validation: migration 116 already fully applied (original voided, reversal % is posted+voided). Skipping write steps; final self-validation will execute.',
      v_reversal_id;
    RETURN;
  END IF;

  -- 1.b.ii) INCONSISTENT state guard: any other combination involving
  --         a pre-existing reversal indicates an out-of-band partial
  --         state. A Postgres transaction is atomic, so reaching this
  --         branch means manual SQL or some catastrophic prior failure.
  --         We refuse to touch it — manual escalation required.
  IF v_reversal_id IS NOT NULL THEN
    RAISE EXCEPTION
      'pre-validation 1.b.ii failed: reversal % already exists in an unexpected state (orig.is_void=%, rev.is_posted=%, rev.is_void=%, rev.reversal_of=%). Refusing to proceed; manual escalation required.',
      v_reversal_id, v_orig.is_void, v_reversal.is_posted,
      v_reversal.is_void, v_reversal.reversal_of;
  END IF;

  -- 1.b.iii) Original voided but no reversal exists → also inconsistent.
  IF v_orig.is_void THEN
    RAISE EXCEPTION
      'pre-validation 1.b.iii failed: original is_void=TRUE but no reversal exists — manual escalation required';
  END IF;

  -- ── At this point: FRESH state (original not voided, no reversal). ──
  -- Run the full original-shape validation before any write.

  -- 1.c) entry_no must match.
  IF v_orig.entry_no <> 'JE-2026-000266' THEN
    RAISE EXCEPTION
      'pre-validation 1.c failed: entry_no mismatch (got %, expected JE-2026-000266)',
      v_orig.entry_no;
  END IF;

  -- 1.d) reference_type / reference_id.
  IF v_orig.reference_type::text <> 'employee_txn' THEN
    RAISE EXCEPTION
      'pre-validation 1.d failed: reference_type mismatch (got %, expected employee_txn)',
      v_orig.reference_type;
  END IF;
  IF v_orig.reference_id IS DISTINCT FROM v_orig_txn_id THEN
    RAISE EXCEPTION
      'pre-validation 1.d failed: reference_id mismatch (got %, expected %)',
      v_orig.reference_id, v_orig_txn_id;
  END IF;

  -- 1.f) Original DR line: account 1123, debit=1.00, credit=0,
  --      cashbox_id IS NULL, warehouse_id IS NULL.
  SELECT * INTO v_dr_line
  FROM journal_lines
  WHERE entry_id = v_orig_id
    AND account_id = v_acct_1123
    AND debit = 1.00 AND credit = 0;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'pre-validation 1.f failed: original DR 1123 1.00 line not found on JE %', v_orig_id;
  END IF;
  IF v_dr_line.cashbox_id IS NOT NULL OR v_dr_line.warehouse_id IS NOT NULL THEN
    RAISE EXCEPTION
      'pre-validation 1.f failed: original DR line has unexpected cashbox_id=% / warehouse_id=%',
      v_dr_line.cashbox_id, v_dr_line.warehouse_id;
  END IF;

  -- 1.g) Original CR line: account 1111, debit=0, credit=1.00,
  --      cashbox_id IS NULL, warehouse_id IS NULL.
  SELECT * INTO v_cr_line
  FROM journal_lines
  WHERE entry_id = v_orig_id
    AND account_id = v_acct_1111
    AND debit = 0 AND credit = 1.00;
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'pre-validation 1.g failed: original CR 1111 1.00 line not found on JE %', v_orig_id;
  END IF;
  IF v_cr_line.cashbox_id IS NOT NULL OR v_cr_line.warehouse_id IS NOT NULL THEN
    RAISE EXCEPTION
      'pre-validation 1.g failed: original CR line has unexpected cashbox_id=% / warehouse_id=%',
      v_cr_line.cashbox_id, v_cr_line.warehouse_id;
  END IF;

  -- 1.h) Exactly TWO journal_lines on the original JE.
  IF (SELECT COUNT(*) FROM journal_lines WHERE entry_id = v_orig_id) <> 2 THEN
    RAISE EXCEPTION
      'pre-validation 1.h failed: original JE has unexpected number of journal_lines';
  END IF;

  -- 1.i) NO cashbox_transactions linked to either txn id OR JE id.
  SELECT COUNT(*) INTO v_ct_count
  FROM cashbox_transactions
  WHERE (reference_id = v_orig_txn_id OR reference_id = v_orig_id);
  IF v_ct_count > 0 THEN
    RAISE EXCEPTION
      'pre-validation 1.i failed: % cashbox_transactions row(s) linked to phantom — refusing to reverse a JE that may have backing cash movement (manual escalation required)',
      v_ct_count;
  END IF;

  RAISE NOTICE 'pre-validation passed (FRESH state) — proceeding with reversal writes';
END $$;

-- ────────────────────────────────────────────────────────────────────
-- Step 1.5 — Snapshot pre-write counts into a session-scoped temp
--            table so the post-write self-validation can prove that
--            the only tables touched were the targeted ones.
-- ────────────────────────────────────────────────────────────────────
DROP TABLE IF EXISTS _pr_ess_2a_data_1_snapshot;
CREATE TEMP TABLE _pr_ess_2a_data_1_snapshot AS
SELECT
  (SELECT COUNT(*) FROM employee_transactions)         AS et_count,
  (SELECT COUNT(*) FROM cashbox_transactions)          AS ct_count,
  (SELECT COUNT(*) FROM expenses)                      AS exp_count,
  (SELECT COALESCE(SUM(drift_amount), 0)
     FROM v_cashbox_drift_per_ref)                     AS drift_sum,
  (SELECT COUNT(*)
     FROM cashboxes c
    WHERE ABS(
            c.current_balance
            - COALESCE((
                SELECT SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END)
                FROM cashbox_transactions t
                WHERE t.cashbox_id = c.id
                  AND COALESCE(t.is_void, FALSE) = FALSE
              ), 0)
          ) > 0.01)                                    AS cashbox_drift_count;

-- ────────────────────────────────────────────────────────────────────
-- Step 2 + 3 — Insert the reversal JE AS DRAFT and its mirrored lines.
--
-- The DB trigger `fn_je_no_insert_posted` rejects INSERTs with
-- is_posted=TRUE. Lines must be inserted while the entry is still a
-- draft; Step 3.5 then flips is_posted=TRUE AND is_void=TRUE so the
-- balance trigger validates the entry on transition.
-- ────────────────────────────────────────────────────────────────────
WITH new_je AS (
  INSERT INTO journal_entries (
    entry_no,
    entry_date,
    description,
    reference_type,
    reference_id,
    is_posted,        -- DRAFT
    posted_at,        -- NULL while draft
    posted_by,        -- NULL while draft
    created_by,
    created_at,
    reversal_of,
    is_void,          -- FALSE while draft
    voided_at,        -- NULL while draft
    voided_by,        -- NULL while draft
    void_reason       -- NULL while draft
  )
  SELECT
    'JE-2026-' || lpad(nextval('seq_journal_entry_no')::text, 6, '0'),
    CURRENT_DATE,
    'تصحيح: عكس قيد سلفة وهمية ' ||
      'JE-2026-000266 — ناتج عن trg_mirror_advance_to_txn القديم. ' ||
      'لم يحدث صرف نقدي. راجع PR-ESS-2A-DATA-1.',
    'employee_advance_correction',
    '5dae9c41-76e8-424a-bf9d-6735e51a6c14'::uuid,
    FALSE,
    NULL,
    NULL,
    '62e5482f-dac0-41e4-bda3-7f7d31f89631'::uuid,
    NOW(),
    '5dae9c41-76e8-424a-bf9d-6735e51a6c14'::uuid,
    FALSE,
    NULL,
    NULL,
    NULL
  WHERE NOT EXISTS (
    SELECT 1 FROM journal_entries
    WHERE reversal_of = '5dae9c41-76e8-424a-bf9d-6735e51a6c14'::uuid
  )
  RETURNING id, entry_no
),
new_jl AS (
  -- Mirrored lines: original was DR 1123 1.00 / CR 1111 1.00,
  -- reversal must be DR 1111 1.00 / CR 1123 1.00.
  -- cashbox_id and warehouse_id are explicitly omitted from the
  -- column list so they default to NULL — matches the original lines.
  INSERT INTO journal_lines (
    entry_id,
    line_no,
    account_id,
    debit,
    credit,
    description,
    employee_id,
    employee_user_id
  )
  SELECT new_je.id, 1,
         'a7e9457c-b863-488c-9f67-38c5598df0d1'::uuid,  -- 1111
         1.00, 0,
         'عكس قيد سلفة وهمية — DR 1111 / CR 1123 (PR-ESS-2A-DATA-1)',
         '3800f38b-cdb9-4347-bf83-2ffc215efd1f'::uuid,
         '3800f38b-cdb9-4347-bf83-2ffc215efd1f'::uuid
  FROM new_je
  UNION ALL
  SELECT new_je.id, 2,
         '5cf0dbfc-4433-439f-b2cf-3805a79a3f29'::uuid,  -- 1123
         0, 1.00,
         'عكس قيد سلفة وهمية — DR 1111 / CR 1123 (PR-ESS-2A-DATA-1)',
         '3800f38b-cdb9-4347-bf83-2ffc215efd1f'::uuid,
         '3800f38b-cdb9-4347-bf83-2ffc215efd1f'::uuid
  FROM new_je
  RETURNING entry_id
)
SELECT 'reversal_je_inserted_as_draft' AS step, COUNT(*) AS count_inserted FROM new_jl;

-- ────────────────────────────────────────────────────────────────────
-- Step 3.5 — Flip the reversal JE from draft to posted+voided in a
-- single UPDATE. The balance trigger fires on the is_posted=TRUE
-- transition and validates DR/CR equality on the lines (1.00 = 1.00).
-- Idempotent: WHERE is_posted=FALSE makes this a no-op on replay.
-- ────────────────────────────────────────────────────────────────────
UPDATE journal_entries
   SET is_posted   = TRUE,
       posted_at   = NOW(),
       posted_by   = '62e5482f-dac0-41e4-bda3-7f7d31f89631'::uuid,
       is_void     = TRUE,
       voided_at   = NOW(),
       voided_by   = '62e5482f-dac0-41e4-bda3-7f7d31f89631'::uuid,
       void_reason = 'Mirror reversal — pairs with original JE-2026-000266 (also voided in this migration).'
 WHERE reversal_of = '5dae9c41-76e8-424a-bf9d-6735e51a6c14'::uuid
   AND is_posted = FALSE;

-- ────────────────────────────────────────────────────────────────────
-- Step 4 — Mark the ORIGINAL phantom JE as voided.
-- Idempotent via the AND is_void=FALSE guard.
-- ────────────────────────────────────────────────────────────────────
UPDATE journal_entries
   SET is_void   = TRUE,
       voided_at = NOW(),
       voided_by = '62e5482f-dac0-41e4-bda3-7f7d31f89631'::uuid,
       void_reason = COALESCE(void_reason || ' | ', '') ||
                     'Auto-posted by legacy fn_mirror_advance_to_txn cascade — ' ||
                     'reversed via PR-ESS-2A-DATA-1 (migration 116).'
 WHERE id = '5dae9c41-76e8-424a-bf9d-6735e51a6c14'::uuid
   AND is_void = FALSE;

-- ────────────────────────────────────────────────────────────────────
-- Step 5 — Annotate the legacy employee_requests row #2.
-- Status / kind / amount preserved (audit trail). Idempotent via the
-- decision_reason NOT LIKE guard.
-- ────────────────────────────────────────────────────────────────────
UPDATE employee_requests
   SET decision_reason = COALESCE(decision_reason || E'\n\n', '') ||
                         'PR-ESS-2A-DATA-1: phantom JE-2026-000266 reversed via migration 116. ' ||
                         'No cash was ever disbursed.'
 WHERE id = 2
   AND (decision_reason IS NULL
        OR decision_reason NOT LIKE '%PR-ESS-2A-DATA-1%');

-- ────────────────────────────────────────────────────────────────────
-- Step 6 — POST-WRITE SELF-VALIDATION (11 invariants)
--
-- Assertion 2 explicitly enforces the "draft cannot remain unposted"
-- requirement: it requires is_posted=TRUE on the reversal JE. Any
-- residual draft (e.g. if Step 3.5 somehow no-op'd unexpectedly)
-- will fail this assertion and roll the migration back.
-- ────────────────────────────────────────────────────────────────────
DO $$
DECLARE
  v_orig_id        CONSTANT UUID := '5dae9c41-76e8-424a-bf9d-6735e51a6c14';
  v_acct_1123      CONSTANT UUID := '5cf0dbfc-4433-439f-b2cf-3805a79a3f29';
  v_acct_1111      CONSTANT UUID := 'a7e9457c-b863-488c-9f67-38c5598df0d1';

  v_orig_void      BOOLEAN;
  v_rev_id         UUID;
  v_rev_void       BOOLEAN;
  v_rev_posted     BOOLEAN;
  v_rev_ref        UUID;
  v_rev_dr_total   NUMERIC;
  v_rev_cr_total   NUMERIC;
  v_rev_dr_line    journal_lines%ROWTYPE;
  v_rev_cr_line    journal_lines%ROWTYPE;
  v_rev_lc         INT;

  v_net_1123       NUMERIC;
  v_net_1111       NUMERIC;
  v_trial_balance  NUMERIC;

  v_et_now         INT;
  v_ct_now         INT;
  v_exp_now        INT;
  v_drift_now      NUMERIC;
  v_cashbox_drift  INT;

  v_snap           RECORD;
BEGIN
  -- 1) Original JE is voided.
  SELECT is_void INTO v_orig_void FROM journal_entries WHERE id = v_orig_id;
  IF NOT v_orig_void THEN
    RAISE EXCEPTION 'self-validation 1 failed: original JE not is_void=TRUE';
  END IF;

  -- 2) Reversal JE exists, is_posted=TRUE, is_void=TRUE,
  --    reversal_of=original. The is_posted=TRUE assertion explicitly
  --    catches any residual draft state.
  SELECT je.id, je.is_void, je.is_posted, je.reversal_of
    INTO v_rev_id, v_rev_void, v_rev_posted, v_rev_ref
  FROM journal_entries je
  WHERE je.reversal_of = v_orig_id;

  IF v_rev_id IS NULL THEN
    RAISE EXCEPTION 'self-validation 2 failed: reversal JE not found';
  END IF;
  IF v_rev_ref IS DISTINCT FROM v_orig_id THEN
    RAISE EXCEPTION
      'self-validation 2 failed: reversal_of mismatch (got %, expected %)',
      v_rev_ref, v_orig_id;
  END IF;
  IF NOT v_rev_posted THEN
    RAISE EXCEPTION
      'self-validation 2 failed: reversal JE not is_posted=TRUE — draft state must not persist past this migration';
  END IF;
  IF NOT v_rev_void THEN
    RAISE EXCEPTION 'self-validation 2 failed: reversal JE not is_void=TRUE';
  END IF;

  -- 3) Reversal JL pair: 1.00 DR + 1.00 CR with mirrored accounts AND
  --    cashbox_id IS NULL AND warehouse_id IS NULL on both lines.
  SELECT SUM(debit), SUM(credit), COUNT(*)
    INTO v_rev_dr_total, v_rev_cr_total, v_rev_lc
  FROM journal_lines
  WHERE entry_id = v_rev_id;

  IF v_rev_lc <> 2 THEN
    RAISE EXCEPTION
      'self-validation 3 failed: reversal JE has % lines (expected 2)', v_rev_lc;
  END IF;
  IF v_rev_dr_total <> 1.00 OR v_rev_cr_total <> 1.00 THEN
    RAISE EXCEPTION
      'self-validation 3 failed: reversal totals wrong (DR=%, CR=%, expected 1.00 / 1.00)',
      v_rev_dr_total, v_rev_cr_total;
  END IF;

  SELECT * INTO v_rev_dr_line
  FROM journal_lines
  WHERE entry_id = v_rev_id AND debit > 0;
  IF v_rev_dr_line.account_id <> v_acct_1111 THEN
    RAISE EXCEPTION
      'self-validation 3 failed: reversal DR account is % (expected 1111 / %)',
      v_rev_dr_line.account_id, v_acct_1111;
  END IF;
  IF v_rev_dr_line.cashbox_id IS NOT NULL OR v_rev_dr_line.warehouse_id IS NOT NULL THEN
    RAISE EXCEPTION
      'self-validation 3 failed: reversal DR line cashbox_id=% / warehouse_id=% (expected both NULL)',
      v_rev_dr_line.cashbox_id, v_rev_dr_line.warehouse_id;
  END IF;

  SELECT * INTO v_rev_cr_line
  FROM journal_lines
  WHERE entry_id = v_rev_id AND credit > 0;
  IF v_rev_cr_line.account_id <> v_acct_1123 THEN
    RAISE EXCEPTION
      'self-validation 3 failed: reversal CR account is % (expected 1123 / %)',
      v_rev_cr_line.account_id, v_acct_1123;
  END IF;
  IF v_rev_cr_line.cashbox_id IS NOT NULL OR v_rev_cr_line.warehouse_id IS NOT NULL THEN
    RAISE EXCEPTION
      'self-validation 3 failed: reversal CR line cashbox_id=% / warehouse_id=% (expected both NULL)',
      v_rev_cr_line.cashbox_id, v_rev_cr_line.warehouse_id;
  END IF;

  -- 4) Net non-void effect on account 1123 across (original + reversal)
  --    must be 0. Both JEs are voided, so non-void contribution is 0.
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)
    INTO v_net_1123
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.entry_id
  WHERE jl.account_id = v_acct_1123
    AND (je.id = v_orig_id OR je.reversal_of = v_orig_id)
    AND je.is_void = FALSE;
  IF v_net_1123 <> 0 THEN
    RAISE EXCEPTION
      'self-validation 4 failed: net non-void effect on 1123 across (original + reversal) = % (expected 0)',
      v_net_1123;
  END IF;

  -- 5) Same for account 1111.
  SELECT COALESCE(SUM(jl.debit) - SUM(jl.credit), 0)
    INTO v_net_1111
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.entry_id
  WHERE jl.account_id = v_acct_1111
    AND (je.id = v_orig_id OR je.reversal_of = v_orig_id)
    AND je.is_void = FALSE;
  IF v_net_1111 <> 0 THEN
    RAISE EXCEPTION
      'self-validation 5 failed: net non-void effect on 1111 across (original + reversal) = % (expected 0)',
      v_net_1111;
  END IF;

  -- 6) Trial balance over non-void entries = 0 (system-wide).
  SELECT COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)
    INTO v_trial_balance
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.entry_id
  WHERE je.is_void = FALSE;
  IF v_trial_balance <> 0 THEN
    RAISE EXCEPTION
      'self-validation 6 failed: trial balance over non-void entries = % (expected 0)',
      v_trial_balance;
  END IF;

  SELECT * INTO v_snap FROM _pr_ess_2a_data_1_snapshot;

  -- 7) employee_transactions count unchanged.
  SELECT COUNT(*) INTO v_et_now FROM employee_transactions;
  IF v_et_now <> v_snap.et_count THEN
    RAISE EXCEPTION
      'self-validation 7 failed: employee_transactions count changed (% → %)',
      v_snap.et_count, v_et_now;
  END IF;

  -- 8) cashbox_transactions count unchanged.
  SELECT COUNT(*) INTO v_ct_now FROM cashbox_transactions;
  IF v_ct_now <> v_snap.ct_count THEN
    RAISE EXCEPTION
      'self-validation 8 failed: cashbox_transactions count changed (% → %)',
      v_snap.ct_count, v_ct_now;
  END IF;

  -- 9) expenses count unchanged.
  SELECT COUNT(*) INTO v_exp_now FROM expenses;
  IF v_exp_now <> v_snap.exp_count THEN
    RAISE EXCEPTION
      'self-validation 9 failed: expenses count changed (% → %)',
      v_snap.exp_count, v_exp_now;
  END IF;

  -- 10) v_cashbox_drift_per_ref total = 0.
  SELECT COALESCE(SUM(drift_amount), 0) INTO v_drift_now
  FROM v_cashbox_drift_per_ref;
  IF v_drift_now <> 0 THEN
    RAISE EXCEPTION
      'self-validation 10 failed: v_cashbox_drift_per_ref total = % (expected 0)',
      v_drift_now;
  END IF;

  -- 11) cashboxes.current_balance == sum of active CT for every cashbox.
  SELECT COUNT(*) INTO v_cashbox_drift
  FROM cashboxes c
  WHERE ABS(
          c.current_balance
          - COALESCE((
              SELECT SUM(CASE WHEN t.direction='in' THEN t.amount ELSE -t.amount END)
              FROM cashbox_transactions t
              WHERE t.cashbox_id = c.id
                AND COALESCE(t.is_void, FALSE) = FALSE
            ), 0)
        ) > 0.01;
  IF v_cashbox_drift <> 0 OR v_snap.cashbox_drift_count <> 0 THEN
    RAISE EXCEPTION
      'self-validation 11 failed: cashbox balance drift count = % (snapshot was %, expected 0 / 0)',
      v_cashbox_drift, v_snap.cashbox_drift_count;
  END IF;

  RAISE NOTICE 'PR-ESS-2A-DATA-1 self-validation passed (11 / 11 invariants).';
  RAISE NOTICE '  Original phantom JE % voided.', v_orig_id;
  RAISE NOTICE '  Reversal JE % (mirrored DR 1111 / CR 1123, posted+voided).', v_rev_id;
  RAISE NOTICE '  Trial balance over non-void entries = 0.';
  RAISE NOTICE '  Net effect on accounts 1123 + 1111 (non-void) = 0 / 0.';
  RAISE NOTICE '  employee_transactions / cashbox_transactions / expenses counts unchanged.';
  RAISE NOTICE '  v_cashbox_drift_per_ref sum = 0.';
  RAISE NOTICE '  cashboxes.current_balance reconciles with active CT sums.';
END $$;

-- Cleanup the session-scoped snapshot.
DROP TABLE IF EXISTS _pr_ess_2a_data_1_snapshot;
