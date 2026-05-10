-- Migration 130 — cashbox-drift views become reversal-aware.
-- PR-FIX-CASHBOX-DRIFT-VIEWS-REVERSAL-AWARE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Investigation on 2026-05-10 surfaced a structural mismatch between
--   the financial-engine's reverse-and-replay pattern and the two
--   cashbox-drift observability views:
--
--     · `FinancialEngineService.recordTransaction({ reversal_of: X })`
--       both POSTS a counter-JE (with swapped DR/CR) AND flips the
--       original entry to is_void=TRUE.
--     · The two views (`v_cashbox_gl_drift`, `v_cashbox_drift_per_ref`)
--       filter `je.is_void = FALSE`, dropping the original's cash leg
--       from the per-account projection while keeping the live
--       counter-JE.
--     · Result: every reverse-and-replay (POS invoice edit, return
--       edit-apply, return cancel, payment void, manual journal void,
--       purchase cancel) leaks the original cash leg into "drift" even
--       though `cashboxes.current_balance` and the trial balance are
--       both correct.
--
--   Three production cases on الخزينة الرئيسية
--   (524646d5-7bd6-4d8d-a484-b1f562b039a4) currently surface this
--   phantom drift:
--
--     · invoice INV-2026-000229 (1263e8c4-…) — drift +150
--     · return  RET-2026-000006 (6f3f6369-…) — drift -450
--     · return  RET-2026-000003 (b65e0e45-…) — already filtered by
--       cashbox-gl-drift.helper.ts:clusterPhantomGlobalStats (cancelled
--       returns); the view fix makes that helper-side filter redundant
--       for this case.
--
-- Change
--
--   Both views' `je_agg` predicate becomes reversal-aware.  Where they
--   currently filter:
--
--     je.is_posted = TRUE
--     AND je.is_void  = FALSE
--
--   They now filter:
--
--     je.is_posted = TRUE
--     AND (
--       je.is_void = FALSE
--       OR EXISTS (
--         SELECT 1 FROM journal_entries r
--          WHERE r.reversal_of = je.id
--            AND r.is_posted   = TRUE
--            AND r.is_void     = FALSE
--       )
--     )
--
--   Semantics: a voided JE re-enters the per-account projection iff a
--   live posted reversal points to it via reversal_of.  Together they
--   pair to zero on every account they touch (DR/CR swap), so the
--   projection net is the same as if neither had been posted — which
--   is what the CT side already represents.  Voided JEs without a
--   live reversal continue to be excluded (legitimate cancellations
--   stay hidden).  Trial balance is per-JE balanced and remains 0
--   regardless.
--
-- Strict scope
--
--   · CREATE OR REPLACE VIEW for the two views only.
--   · No DDL on tables, no DML, no triggers, no functions touched.
--   · No journal_entries / journal_lines / cashbox_transactions /
--     stock_movements / cashboxes mutation.
--   · Idempotent — re-running the migration replaces the views in
--     place with the same definitions.
--
-- Not touched
--   * journal_entries / journal_lines              — no UPDATE
--   * cashbox_transactions                          — no UPDATE
--   * stock_movements                               — no UPDATE
--   * cashboxes.current_balance                     — no UPDATE
--   * FinancialEngineService.recordTransaction      — engine model
--     (void-on-reversal) stays as documented in
--     financial-engine.service.ts:179-189.  This migration fixes the
--     projection layer, leaving the engine and every is_void consumer
--     (UI, audit panels, payments recon) unchanged.
--   * cashbox-gl-drift.helper.ts                    — clusterPhantom /
--     taxonomyMismatch helpers continue to compute; their inputs (the
--     per-ref view) become reversal-aware so the helpers' phantom
--     subtraction simply has nothing to subtract for these cases.
--
-- Companion artefacts
--
--   · backend/src/database/migration-130.spec.ts — static spec.
--   · backend/src/cash-desk/v-cashbox-drift-reversal-aware.spec.ts —
--     view-behavior integration spec on a live local Postgres.
-- ═══════════════════════════════════════════════════════════════════════════

-- ── 1 — v_cashbox_gl_drift ─────────────────────────────────────────────────
CREATE OR REPLACE VIEW v_cashbox_gl_drift AS
WITH gl AS (
  SELECT jl.cashbox_id,
         SUM(jl.debit)  AS gl_dr,
         SUM(jl.credit) AS gl_cr
  FROM journal_lines jl
  JOIN journal_entries je ON je.id = jl.entry_id
  WHERE je.is_posted = TRUE
    AND (
      je.is_void = FALSE
      OR EXISTS (
        SELECT 1 FROM journal_entries r
         WHERE r.reversal_of = je.id
           AND r.is_posted   = TRUE
           AND r.is_void     = FALSE
      )
    )
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
  'PR-FIX-CASHBOX-DRIFT-VIEWS-REVERSAL-AWARE (mig 130): per-cashbox '
  'stored vs GL variance.  The je_agg predicate now includes voided '
  'originals iff a live posted reversal references them via '
  'reversal_of.  drift_amount = current_balance - Σ(jl.debit-jl.credit) '
  'on cashbox-tagged journal_lines from posted entries that are either '
  'live OR voided-but-paired-with-a-live-reversal.  Trial balance is '
  'per-JE balanced and is unaffected.';

-- ── 2 — v_cashbox_drift_per_ref ────────────────────────────────────────────
CREATE OR REPLACE VIEW v_cashbox_drift_per_ref AS
WITH ct_agg AS (
  -- Active cashbox_transactions grouped by (cashbox, reference).
  -- Sign convention: in = +, out = −  (matches cashboxes.current_balance).
  SELECT
    ct.cashbox_id,
    ct.reference_type::text                                            AS reference_type,
    ct.reference_id,
    SUM(CASE WHEN ct.direction = 'in' THEN ct.amount ELSE -ct.amount END)::numeric
                                                                       AS ct_signed_amount,
    COUNT(*)::int                                                      AS ct_count,
    MIN(ct.created_at)                                                 AS ct_first_seen_at,
    MAX(ct.created_at)                                                 AS ct_last_seen_at
  FROM cashbox_transactions ct
  WHERE COALESCE(ct.is_void, FALSE) = FALSE
    AND ct.cashbox_id   IS NOT NULL
    AND ct.reference_id IS NOT NULL
  GROUP BY ct.cashbox_id, ct.reference_type, ct.reference_id
),
je_agg AS (
  -- Posted journal_lines tagged with a cashbox AND posted to a
  -- cash-mirror account (chart_of_accounts.code LIKE '111_'), grouped
  -- by (cashbox, reference).  Voided JEs are now included iff a live
  -- posted reversal points to them via reversal_of — see migration
  -- header for rationale.  Sign convention: debit = +, credit = −
  -- (cash account is an asset; debit increases the balance).
  SELECT
    jl.cashbox_id,
    je.reference_type::text                                            AS reference_type,
    je.reference_id,
    (SUM(jl.debit) - SUM(jl.credit))::numeric                          AS je_signed_amount,
    COUNT(*)::int                                                      AS je_line_count,
    MIN(je.created_at)                                                 AS je_first_seen_at,
    MAX(je.created_at)                                                 AS je_last_seen_at,
    -- A representative entry_no for the per-reference cohort. Stable
    -- against re-runs because we pick MIN(entry_no).
    MIN(je.entry_no)                                                   AS sample_entry_no
  FROM journal_entries je
  JOIN journal_lines    jl  ON jl.entry_id = je.id
  JOIN chart_of_accounts coa ON coa.id     = jl.account_id
  WHERE je.is_posted     = TRUE
    AND (
      je.is_void = FALSE
      OR EXISTS (
        SELECT 1 FROM journal_entries r
         WHERE r.reversal_of = je.id
           AND r.is_posted   = TRUE
           AND r.is_void     = FALSE
      )
    )
    AND coa.code LIKE '111_'
    AND jl.cashbox_id    IS NOT NULL
    AND je.reference_id  IS NOT NULL
  GROUP BY jl.cashbox_id, je.reference_type, je.reference_id
),
joined AS (
  SELECT
    COALESCE(ct.cashbox_id,     je.cashbox_id)     AS cashbox_id,
    COALESCE(ct.reference_type, je.reference_type) AS reference_type,
    COALESCE(ct.reference_id,   je.reference_id)   AS reference_id,
    COALESCE(ct.ct_signed_amount, 0)::numeric      AS ct_signed_amount,
    COALESCE(je.je_signed_amount, 0)::numeric      AS je_signed_amount,
    (COALESCE(ct.ct_signed_amount, 0)
       - COALESCE(je.je_signed_amount, 0))::numeric AS drift_amount,
    COALESCE(ct.ct_count,      0)                  AS ct_count,
    COALESCE(je.je_line_count, 0)                  AS je_line_count,
    LEAST(ct.ct_first_seen_at, je.je_first_seen_at) AS first_seen_at,
    GREATEST(ct.ct_last_seen_at, je.je_last_seen_at) AS last_seen_at,
    je.sample_entry_no,
    CASE
      WHEN ct.cashbox_id IS NOT NULL AND je.cashbox_id IS NULL THEN 'CT_only'
      WHEN ct.cashbox_id IS NULL     AND je.cashbox_id IS NOT NULL THEN 'JE_only'
      ELSE 'both'
    END                                            AS coverage
  FROM ct_agg ct
  FULL OUTER JOIN je_agg je
    ON ct.cashbox_id     = je.cashbox_id
   AND ct.reference_type = je.reference_type
   AND ct.reference_id   = je.reference_id
)
SELECT
  j.cashbox_id,
  c.name_ar                  AS cashbox_name,
  '111_'                     AS cash_account_pattern,
  j.reference_type,
  j.reference_id,
  j.coverage,
  j.ct_count,
  j.je_line_count,
  j.ct_signed_amount,
  j.je_signed_amount,
  j.drift_amount,
  j.first_seen_at,
  j.last_seen_at,
  j.sample_entry_no
FROM joined j
LEFT JOIN cashboxes c ON c.id = j.cashbox_id
-- Surface every coverage gap. For 'both' rows, hide the float-noise
-- (|drift| ≤ 0.01); for CT_only / JE_only, surface unconditionally
-- because the missing side itself is the signal.
WHERE j.coverage <> 'both'
   OR ABS(j.drift_amount) > 0.01
ORDER BY ABS(j.drift_amount) DESC, j.cashbox_id, j.reference_type, j.reference_id;

COMMENT ON VIEW v_cashbox_drift_per_ref IS
  'PR-FIX-CASHBOX-DRIFT-VIEWS-REVERSAL-AWARE (mig 130): per-(cashbox, '
  'reference) coverage diff between cashbox_transactions and '
  'journal_lines on cash-mirror accounts (code LIKE 111_).  The je_agg '
  'predicate now includes voided originals iff a live posted reversal '
  'points to them via reversal_of, so reverse-and-replay pairs cancel '
  'in the projection (which the CT side already does).';

-- ── 3 — self-validation (idempotent) ───────────────────────────────────────
DO $$
BEGIN
  -- Both views exist.
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
     WHERE schemaname = 'public' AND viewname = 'v_cashbox_gl_drift'
  ) THEN
    RAISE EXCEPTION 'PR-FIX-CASHBOX-DRIFT-VIEWS-REVERSAL-AWARE: v_cashbox_gl_drift missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
     WHERE schemaname = 'public' AND viewname = 'v_cashbox_drift_per_ref'
  ) THEN
    RAISE EXCEPTION 'PR-FIX-CASHBOX-DRIFT-VIEWS-REVERSAL-AWARE: v_cashbox_drift_per_ref missing';
  END IF;

  -- Both view definitions reference reversal_of (the new predicate).
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
     WHERE schemaname = 'public'
       AND viewname   = 'v_cashbox_gl_drift'
       AND definition LIKE '%reversal_of%'
  ) THEN
    RAISE EXCEPTION
      'PR-FIX-CASHBOX-DRIFT-VIEWS-REVERSAL-AWARE: v_cashbox_gl_drift definition missing reversal_of predicate';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
     WHERE schemaname = 'public'
       AND viewname   = 'v_cashbox_drift_per_ref'
       AND definition LIKE '%reversal_of%'
  ) THEN
    RAISE EXCEPTION
      'PR-FIX-CASHBOX-DRIFT-VIEWS-REVERSAL-AWARE: v_cashbox_drift_per_ref definition missing reversal_of predicate';
  END IF;

  RAISE NOTICE 'migration 130 ok — cashbox-drift views are reversal-aware';
END
$$;
