-- =============================================================================
--  cashbox-drift-detail.sql — read-only diagnostic for cashbox drift.
--
--  Reads the v_cashbox_drift_per_ref view (migration 102, PR-DRIFT-1) and
--  emits the breakdown an operator needs to triage a non-zero
--  cashbox-drift signal from weekly-drift-check.sh (#10).
--
--  Six sections, top-to-bottom:
--    1. Drift summary by cashbox       (one row per cashbox)
--    2. Drift summary by reference_type
--    3. Top affected rows               (highest |drift| first, capped 50)
--    4. Day-by-day drift path           (Cairo-day windows, last 60 days)
--    5. CT_only rows                    (cashbox transaction with no JE)
--    6. JE_only rows                    (journal entry with no CT)
--    7. Both-but-different rows
--    8. Possible false-mismatch pairs   (semantic offsets, e.g. shift vs
--                                        shift_variance — flagged not fixed)
--
--  Run from a workstation with the prod DATABASE_URL exported:
--    psql "$DATABASE_URL" -X -f scripts/cashbox-drift-detail.sql
--
--  PR-DRIFT-1 — read-only. Does NOT mutate any data.
-- =============================================================================

\echo
\echo '── 1. Drift summary by cashbox ────────────────────────────────────────────'
SELECT
  v.cashbox_id,
  v.cashbox_name,
  COUNT(*)                                  AS rows_with_drift,
  SUM(v.drift_amount)::numeric(18, 2)       AS total_drift,
  SUM(CASE WHEN v.coverage = 'CT_only' THEN v.drift_amount ELSE 0 END)::numeric(18, 2) AS ct_only_drift,
  SUM(CASE WHEN v.coverage = 'JE_only' THEN v.drift_amount ELSE 0 END)::numeric(18, 2) AS je_only_drift,
  SUM(CASE WHEN v.coverage = 'both'    THEN v.drift_amount ELSE 0 END)::numeric(18, 2) AS both_mismatch_drift
FROM v_cashbox_drift_per_ref v
GROUP BY v.cashbox_id, v.cashbox_name
ORDER BY ABS(SUM(v.drift_amount)) DESC;

\echo
\echo '── 2. Drift summary by reference_type ─────────────────────────────────────'
SELECT
  v.cashbox_id,
  v.cashbox_name,
  v.reference_type,
  v.coverage,
  COUNT(*)                                  AS refs,
  SUM(v.ct_signed_amount)::numeric(18, 2)   AS ct_signed_sum,
  SUM(v.je_signed_amount)::numeric(18, 2)   AS je_signed_sum,
  SUM(v.drift_amount)::numeric(18, 2)       AS gap_sum
FROM v_cashbox_drift_per_ref v
GROUP BY v.cashbox_id, v.cashbox_name, v.reference_type, v.coverage
ORDER BY v.cashbox_id, v.reference_type, v.coverage;

\echo
\echo '── 3. Top affected rows (capped 50) ───────────────────────────────────────'
SELECT
  v.cashbox_name,
  v.reference_type,
  v.reference_id,
  v.coverage,
  v.ct_count,
  v.je_line_count,
  v.ct_signed_amount::numeric(18, 2)        AS ct_signed,
  v.je_signed_amount::numeric(18, 2)        AS je_signed,
  v.drift_amount::numeric(18, 2)            AS drift,
  v.sample_entry_no,
  v.first_seen_at,
  v.last_seen_at
FROM v_cashbox_drift_per_ref v
ORDER BY ABS(v.drift_amount) DESC
LIMIT 50;

\echo
\echo '── 4. Day-by-day drift path (Cairo, last 60 days) ─────────────────────────'
WITH ct_day AS (
  SELECT
    ct.cashbox_id,
    (ct.created_at AT TIME ZONE 'Africa/Cairo')::date AS cairo_day,
    SUM(CASE WHEN ct.direction = 'in' THEN ct.amount ELSE -ct.amount END)::numeric AS ct_delta,
    COUNT(*)::int                                                                    AS ct_n
  FROM cashbox_transactions ct
  WHERE COALESCE(ct.is_void, FALSE) = FALSE
    AND ct.created_at >= now() - INTERVAL '60 days'
  GROUP BY ct.cashbox_id, (ct.created_at AT TIME ZONE 'Africa/Cairo')::date
),
je_day AS (
  SELECT
    jl.cashbox_id,
    (je.created_at AT TIME ZONE 'Africa/Cairo')::date AS cairo_day,
    (SUM(jl.debit) - SUM(jl.credit))::numeric                                        AS je_delta,
    COUNT(*)::int                                                                    AS je_n
  FROM journal_entries je
  JOIN journal_lines    jl  ON jl.entry_id = je.id
  JOIN chart_of_accounts coa ON coa.id     = jl.account_id
  WHERE je.is_posted = TRUE
    AND je.is_void   = FALSE
    AND coa.code LIKE '111_'
    AND jl.cashbox_id IS NOT NULL
    AND je.created_at >= now() - INTERVAL '60 days'
  GROUP BY jl.cashbox_id, (je.created_at AT TIME ZONE 'Africa/Cairo')::date
)
SELECT
  COALESCE(ct.cashbox_id, je.cashbox_id)         AS cashbox_id,
  c.name_ar                                       AS cashbox_name,
  COALESCE(ct.cairo_day,  je.cairo_day)          AS cairo_day,
  COALESCE(ct.ct_delta, 0)::numeric(18, 2)       AS ct_delta,
  COALESCE(je.je_delta, 0)::numeric(18, 2)       AS je_delta,
  (COALESCE(ct.ct_delta, 0) - COALESCE(je.je_delta, 0))::numeric(18, 2) AS day_drift,
  COALESCE(ct.ct_n, 0)                           AS ct_count,
  COALESCE(je.je_n, 0)                           AS je_count
FROM ct_day ct
FULL OUTER JOIN je_day je
  ON ct.cashbox_id = je.cashbox_id AND ct.cairo_day = je.cairo_day
LEFT JOIN cashboxes c
  ON c.id = COALESCE(ct.cashbox_id, je.cashbox_id)
WHERE COALESCE(ct.cashbox_id, je.cashbox_id) IS NOT NULL
ORDER BY cashbox_id, cairo_day;

\echo
\echo '── 5. CT_only rows (cashbox txn exists, no matching JE) ───────────────────'
SELECT
  v.cashbox_name,
  v.reference_type,
  v.reference_id,
  v.ct_count,
  v.ct_signed_amount::numeric(18, 2) AS ct_signed,
  v.first_seen_at,
  v.last_seen_at
FROM v_cashbox_drift_per_ref v
WHERE v.coverage = 'CT_only'
ORDER BY ABS(v.ct_signed_amount) DESC, v.first_seen_at;

\echo
\echo '── 6. JE_only rows (journal entry exists, no matching CT) ─────────────────'
SELECT
  v.cashbox_name,
  v.reference_type,
  v.reference_id,
  v.je_line_count,
  v.je_signed_amount::numeric(18, 2) AS je_signed,
  v.sample_entry_no,
  v.first_seen_at,
  v.last_seen_at
FROM v_cashbox_drift_per_ref v
WHERE v.coverage = 'JE_only'
ORDER BY ABS(v.je_signed_amount) DESC, v.first_seen_at;

\echo
\echo '── 7. Both-but-different rows (CT and JE exist, amounts disagree) ─────────'
SELECT
  v.cashbox_name,
  v.reference_type,
  v.reference_id,
  v.ct_count,
  v.je_line_count,
  v.ct_signed_amount::numeric(18, 2) AS ct_signed,
  v.je_signed_amount::numeric(18, 2) AS je_signed,
  v.drift_amount::numeric(18, 2)     AS drift,
  v.sample_entry_no,
  v.first_seen_at,
  v.last_seen_at
FROM v_cashbox_drift_per_ref v
WHERE v.coverage = 'both'
ORDER BY ABS(v.drift_amount) DESC;

\echo
\echo '── 8. Possible false-mismatch pairs (CT_only ↔ JE_only with offsetting Σ) ──'
-- Heuristic: when a CT_only reference_type and a JE_only reference_type on
-- the same cashbox carry the SAME signed amount (within 0.05 EGP), the two
-- are likely the same semantic cash event recorded under two different
-- reference_type names (e.g. shift vs shift_variance — the cash counted at
-- shift close shows up once on the CT log as `shift` and once on the GL
-- side as `shift_variance`). Their *coverage drifts* offset
-- (drift_CT_only = +X, drift_JE_only = −X), so net contribution to the
-- cashbox total is zero.
--
-- This is observability-only. PR-DRIFT-1 does NOT classify or mutate; the
-- operator decides whether each flagged pair is a real false-mismatch or a
-- coincidence.
WITH ct_only AS (
  SELECT cashbox_id, reference_type, SUM(ct_signed_amount)::numeric AS ct_total
  FROM v_cashbox_drift_per_ref
  WHERE coverage = 'CT_only'
  GROUP BY cashbox_id, reference_type
),
je_only AS (
  SELECT cashbox_id, reference_type, SUM(je_signed_amount)::numeric AS je_total
  FROM v_cashbox_drift_per_ref
  WHERE coverage = 'JE_only'
  GROUP BY cashbox_id, reference_type
)
SELECT
  c.name_ar                            AS cashbox_name,
  ct.reference_type                    AS ct_only_reference_type,
  je.reference_type                    AS je_only_reference_type,
  ct.ct_total::numeric(18, 2)          AS ct_only_total,
  je.je_total::numeric(18, 2)          AS je_only_total,
  (ct.ct_total - je.je_total)::numeric(18, 2) AS coverage_gap_after_pairing,
  'possible_false_mismatch'::text      AS note
FROM ct_only ct
JOIN je_only je
  ON ct.cashbox_id = je.cashbox_id
 AND ct.reference_type <> je.reference_type
 AND ABS(ct.ct_total - je.je_total) < 0.05
LEFT JOIN cashboxes c ON c.id = ct.cashbox_id
ORDER BY c.name_ar, ct.reference_type;

\echo
\echo '── done. drift fixes are out of scope for PR-DRIFT-1 (observability only) ─'
