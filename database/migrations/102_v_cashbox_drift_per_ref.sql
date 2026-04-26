-- Migration 102 — Cashbox drift observability view (PR-DRIFT-1).
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Read-only observability layer. NO data mutation. Adds a single VIEW
-- so operators can see, per-cashbox and per-reference, where the
-- cash-mirror GL account (chart_of_accounts.code LIKE '111_') and
-- cashbox_transactions disagree.
--
-- Why this view exists
--
--   The weekly-drift-check.sh script (#10) computes a single number:
--     |cashboxes.current_balance − Σ cashbox_transactions|
--   That catches when the stored balance has fallen out of sync with
--   the CT log, but says nothing about the *separate* GL-vs-CT
--   coverage gap. Audit on 2026-04-26 found cashbox 524646d5… is
--   internally self-consistent on the CT side (16,384.98 = 16,384.98)
--   yet drifts +7,289.98 from the journal_lines tagged on account
--   1111@cashbox. Root causes spread across seven reference_type
--   buckets (legacy invoice writes, expense_edit_reversal pairs,
--   employee_settlement orphan JEs, etc.).
--
--   This view exposes the per-reference coverage so any future drift
--   surfaces in the same shape — without anyone having to write a
--   one-off audit query.
--
-- Strict scope
--
--   · CREATE OR REPLACE VIEW only — no tables changed, no rows
--     written, no balances touched.
--   · Idempotent — re-running the migration replaces the view in
--     place with the same definition.
--   · Filters out near-zero rows (|drift| ≤ 0.01) when coverage is
--     'both' so the view is signal, not noise.
--
-- Companion artefacts
--
--   · scripts/cashbox-drift-detail.sql — diagnostic queries that
--     read this view.
--   · scripts/weekly-drift-check.sh — extended to print the per-ref
--     breakdown when cashbox drift is non-zero.
-- ═══════════════════════════════════════════════════════════════════════════

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
  -- Posted, non-void journal_lines tagged with a cashbox AND posted to a
  -- cash-mirror account (chart_of_accounts.code LIKE '111_'), grouped
  -- by (cashbox, reference). Sign convention: debit = +, credit = −
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
    AND je.is_void       = FALSE
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
  'Per-(cashbox, reference) coverage diff between cashbox_transactions and '
  'journal_lines on cash-mirror accounts (code LIKE 111_). Read-only '
  'observability surface for PR-DRIFT-1. Diagnostic queries: '
  'scripts/cashbox-drift-detail.sql.';
