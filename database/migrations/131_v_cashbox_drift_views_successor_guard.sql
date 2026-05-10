-- Migration 131 — cashbox-drift views: tighten reversal-aware predicate
-- with a successor guard, so cancel-only patterns stay clean.
-- PR-FIX-CASHBOX-DRIFT-VIEWS-SUCCESSOR-GUARD
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Migration 130 made `v_cashbox_gl_drift` and `v_cashbox_drift_per_ref`
--   reversal-aware: a voided original JE is included in the per-account
--   projection iff a live posted reversal references it via reversal_of.
--   That fix correctly cleared the EDIT-AND-REPLAY drift sources
--   (INV-2026-000229 +150, RET-2026-000006 -450) — both of those have
--   a live replacement JE on the same business document, so the voided
--   original + live reversal + live new JE pair to zero on the (cashbox,
--   reference_type, reference_id) group.
--
--   But the CANCEL-ONLY pattern (RET-2026-000003) breaks the symmetry:
--
--     · Original refund JE-2026-000358 — voided
--     · Original refund CT 245 — voided (the cancellation flow voids
--       BOTH the JE side AND the CT side, then emits a single fresh
--       reversal CT in the opposite direction).
--     · Reversal JE-2026-000378 — live, references JE-358 via
--       reversal_of.
--     · Reversal CT 265 — live, reference_type='other', reference_id=
--       <JE-358 id>.
--     · NO replacement JE on the same business document (the return
--       was cancelled outright; nothing replaces it).
--
--   Migration 130's predicate re-included the voided JE-358 in the
--   (return, b65e0e45) projection group → CT side has nothing live on
--   that group (the original CT was voided too) → drift surfaces as
--   ct=0, je=-350, drift=+350.  The header v_cashbox_gl_drift moved
--   from -300 (pre-mig 130) to +350 (post-mig 130), instead of dropping
--   to 0.  The operator dashboard's `clusterPhantomGlobalStats` helper
--   still filters this row from the operator-facing card, so end-user
--   impact was nil — but the raw header is wrong.
--
-- Change
--
--   Tighten the reversal-aware predicate with an additional successor
--   guard:  include a voided original JE only when BOTH (a) a live
--   reversal references it AND (b) a live replacement JE exists on
--   the same business document (same reference_type + reference_id,
--   different id, posted, not void, not itself a reversal).
--
--   The combined predicate becomes:
--
--     je.is_posted = TRUE
--     AND (
--       je.is_void = FALSE
--       OR (
--         EXISTS (
--           SELECT 1 FROM journal_entries r
--            WHERE r.reversal_of = je.id
--              AND r.is_posted   = TRUE
--              AND r.is_void     = FALSE
--         )
--         AND EXISTS (
--           SELECT 1 FROM journal_entries r2
--            WHERE r2.reference_type = je.reference_type
--              AND r2.reference_id   = je.reference_id
--              AND r2.id            <> je.id
--              AND r2.is_posted      = TRUE
--              AND r2.is_void        = FALSE
--              AND r2.reversal_of    IS NULL
--         )
--       )
--     )
--
--   Edit-and-replay (INV-2026-000229, RET-2026-000006): voided original
--   has a live reversal AND a live replacement on the same business
--   doc → INCLUDED.  Drift on the (invoice/return, ref) group pairs
--   to zero.
--
--   Cancel-only (RET-2026-000003): voided original has a live reversal
--   but NO replacement on the same business doc → EXCLUDED.  Drift on
--   the (return, b65e0e45) group goes back to zero (matching the
--   pre-mig-130 behavior for cancellations, which the cluster phantom
--   helper has been masking on the operator card all along).
--
--   Voided JE without any live reversal: still excluded (legitimate
--   cancellation-style void without engine reversal — same as before).
--
--   True orphan CT or JE: unchanged (continues to surface as drift).
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
-- Companion artefacts
--
--   · backend/src/database/migration-131.spec.ts — static spec.
--   · backend/src/cash-desk/v-cashbox-drift-reversal-aware.spec.ts —
--     view-behavior simulation spec, updated for the new predicate
--     (the cancel-return fixture now correctly voids the original CT
--     to match production data, and a new "voided + reversal but
--     no successor → excluded" case is added).
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
      OR (
        EXISTS (
          SELECT 1 FROM journal_entries r
           WHERE r.reversal_of = je.id
             AND r.is_posted   = TRUE
             AND r.is_void     = FALSE
        )
        AND EXISTS (
          SELECT 1 FROM journal_entries r2
           WHERE r2.reference_type = je.reference_type
             AND r2.reference_id   = je.reference_id
             AND r2.id            <> je.id
             AND r2.is_posted      = TRUE
             AND r2.is_void        = FALSE
             AND r2.reversal_of    IS NULL
        )
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
  'PR-FIX-CASHBOX-DRIFT-VIEWS-SUCCESSOR-GUARD (mig 131): per-cashbox '
  'stored vs GL variance.  The je_agg predicate includes voided '
  'originals iff a live posted reversal references them AND a live '
  'replacement JE exists on the same business document — so '
  'edit-and-replay pairs cancel in the projection, while cancel-only '
  'voids stay excluded (matching their CT-side voided counterpart).';

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
  -- by (cashbox, reference).  Voided JEs are included iff a live
  -- posted reversal points to them via reversal_of AND a live
  -- replacement JE exists on the same business document — see
  -- migration header for rationale.  Sign convention: debit = +,
  -- credit = −  (cash account is an asset; debit increases the balance).
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
      OR (
        EXISTS (
          SELECT 1 FROM journal_entries r
           WHERE r.reversal_of = je.id
             AND r.is_posted   = TRUE
             AND r.is_void     = FALSE
        )
        AND EXISTS (
          SELECT 1 FROM journal_entries r2
           WHERE r2.reference_type = je.reference_type
             AND r2.reference_id   = je.reference_id
             AND r2.id            <> je.id
             AND r2.is_posted      = TRUE
             AND r2.is_void        = FALSE
             AND r2.reversal_of    IS NULL
        )
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
  'PR-FIX-CASHBOX-DRIFT-VIEWS-SUCCESSOR-GUARD (mig 131): per-(cashbox, '
  'reference) coverage diff between cashbox_transactions and '
  'journal_lines on cash-mirror accounts (code LIKE 111_).  The je_agg '
  'predicate includes voided originals iff a live posted reversal '
  'references them AND a live replacement JE exists on the same '
  'business document, so reverse-and-replay pairs cancel in the '
  'projection while cancel-only voids stay excluded.';

-- ── 3 — self-validation (idempotent) ───────────────────────────────────────
DO $$
BEGIN
  -- Both views exist.
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
     WHERE schemaname = 'public' AND viewname = 'v_cashbox_gl_drift'
  ) THEN
    RAISE EXCEPTION 'PR-FIX-CASHBOX-DRIFT-VIEWS-SUCCESSOR-GUARD: v_cashbox_gl_drift missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
     WHERE schemaname = 'public' AND viewname = 'v_cashbox_drift_per_ref'
  ) THEN
    RAISE EXCEPTION 'PR-FIX-CASHBOX-DRIFT-VIEWS-SUCCESSOR-GUARD: v_cashbox_drift_per_ref missing';
  END IF;

  -- Both view definitions reference reversal_of (mig 130 marker stays).
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
     WHERE schemaname = 'public'
       AND viewname   = 'v_cashbox_gl_drift'
       AND definition LIKE '%reversal_of%'
  ) THEN
    RAISE EXCEPTION
      'PR-FIX-CASHBOX-DRIFT-VIEWS-SUCCESSOR-GUARD: v_cashbox_gl_drift definition missing reversal_of predicate';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
     WHERE schemaname = 'public'
       AND viewname   = 'v_cashbox_drift_per_ref'
       AND definition LIKE '%reversal_of%'
  ) THEN
    RAISE EXCEPTION
      'PR-FIX-CASHBOX-DRIFT-VIEWS-SUCCESSOR-GUARD: v_cashbox_drift_per_ref definition missing reversal_of predicate';
  END IF;

  -- Both view definitions reference the successor-guard alias (r2.reference_type
  -- + r2.reference_id pair).  Postgres rewrites SQL aliases in pg_views.definition,
  -- so we don't pin the literal `r2` name; instead we assert a fragment that
  -- only the successor guard would produce: `reversal_of IS NULL` correlated
  -- with reference_type + reference_id equality on a self-join over
  -- journal_entries.
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
     WHERE schemaname = 'public'
       AND viewname   = 'v_cashbox_gl_drift'
       AND definition ILIKE '%reversal_of IS NULL%'
  ) THEN
    RAISE EXCEPTION
      'PR-FIX-CASHBOX-DRIFT-VIEWS-SUCCESSOR-GUARD: v_cashbox_gl_drift missing successor guard';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_views
     WHERE schemaname = 'public'
       AND viewname   = 'v_cashbox_drift_per_ref'
       AND definition ILIKE '%reversal_of IS NULL%'
  ) THEN
    RAISE EXCEPTION
      'PR-FIX-CASHBOX-DRIFT-VIEWS-SUCCESSOR-GUARD: v_cashbox_drift_per_ref missing successor guard';
  END IF;

  RAISE NOTICE 'migration 131 ok — cashbox-drift views now have successor guard';
END
$$;
