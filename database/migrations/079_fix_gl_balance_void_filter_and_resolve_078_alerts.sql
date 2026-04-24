-- Migration 079 — Fix v_employee_gl_balance void-filter + resolve migration 078's bypass alerts.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Part A — v_employee_gl_balance void-filter bug
--
--   migration 075 moved the account-scope filter into aggregate
--   FILTER clauses (1123 + 213). But the `je.is_void = FALSE AND
--   je.is_posted = TRUE` check stayed on the LEFT JOIN condition.
--   Because the jl rows survive an unmatched LEFT JOIN (journal_entries
--   goes to NULL but the journal_lines row still exists), SUM(jl.debit)
--   / SUM(jl.credit) silently include voided JE lines.
--
--   Observed on 2026-04-24 after PR #81 voided 5 test JEs:
--     direct query WHERE NOT je.is_void     → 880.00
--     v_employee_gl_balance                 → 879.97  (off by −0.03)
--
--   Fix: move the is_void / is_posted guards into the FILTER
--   predicates alongside the account-scope filter. Same pattern the
--   view already uses for 1123/213.
--
-- Part B — resolve the 4 bypass alerts from migration 078
--
--   Migration 078 cleanup wrote via fn_record_cashbox_txn (2 cash
--   reversal rows) and directly UPDATEd 2 settlement journal_entries
--   to is_void=true. Both paths landed in engine_bypass_alerts under
--   context='service:cashbox_fn_fallback'. Live alert ids:
--     41  cashbox_transactions  INSERT  cbx_txn_id=101
--     42  journal_entries       UPDATE  je_id=075ebea5-…
--     43  cashbox_transactions  INSERT  cbx_txn_id=102
--     44  journal_entries       UPDATE  je_id=4b644bd7-…
--
--   These were intentional cleanup writes (migration 078). Same
--   resolution mechanism migration 072 used for the previous 11
--   legacy alerts — insert a matched financial_anomalies row with
--   resolved=true so the drift check's NOT EXISTS twin lookup
--   excludes them.
--
-- Not touched
--   * FinancialEngine, schema, history, cashbox balances
--   * Any other bypass alerts outside the 4 listed
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── Part A — redefine v_employee_gl_balance with proper void/posted filters ──

CREATE OR REPLACE VIEW v_employee_gl_balance AS
SELECT
  u.id                                                  AS employee_user_id,
  u.username,
  COALESCE(u.full_name, u.username::character varying) AS employee_name,
  u.employee_no,
  COALESCE(
    SUM(jl.debit) FILTER (
      WHERE a.code IN ('1123', '213')
        AND je.is_posted = TRUE
        AND je.is_void   = FALSE
    ), 0
  )::numeric(14,2) AS debit_total,
  COALESCE(
    SUM(jl.credit) FILTER (
      WHERE a.code IN ('1123', '213')
        AND je.is_posted = TRUE
        AND je.is_void   = FALSE
    ), 0
  )::numeric(14,2) AS credit_total,
  (COALESCE(
     SUM(jl.debit) FILTER (
       WHERE a.code IN ('1123', '213')
         AND je.is_posted = TRUE
         AND je.is_void   = FALSE
     ), 0)
   - COALESCE(
     SUM(jl.credit) FILTER (
       WHERE a.code IN ('1123', '213')
         AND je.is_posted = TRUE
         AND je.is_void   = FALSE
     ), 0)
  )::numeric(14,2) AS balance,
  COUNT(DISTINCT jl.entry_id) FILTER (
    WHERE a.code IN ('1123', '213')
      AND je.is_posted = TRUE
      AND je.is_void   = FALSE
  )::int AS entry_count,
  MAX(je.entry_date) FILTER (
    WHERE a.code IN ('1123', '213')
      AND je.is_posted = TRUE
      AND je.is_void   = FALSE
  ) AS last_entry_date
FROM users u
LEFT JOIN journal_lines    jl ON jl.employee_user_id = u.id
LEFT JOIN journal_entries  je ON je.id = jl.entry_id
LEFT JOIN chart_of_accounts a ON a.id = jl.account_id
WHERE u.is_active = TRUE
GROUP BY u.id, u.username, u.full_name, u.employee_no;

COMMENT ON VIEW v_employee_gl_balance IS
  'Per-employee net GL balance combining COA 1123 (ذمم الموظفين receivables) and 213 (مستحقات الموظفين payables). Lines filtered to posted + non-void entries. Positive balance = employee owes company; negative = company owes employee.';

-- ─── Part B — resolve migration 078's 4 bypass alerts ──────────────────────
-- Drift check pairs engine_bypass_alerts rows with a matched
-- financial_anomalies row (anomaly_type='legacy_bypass_journal_entry',
-- same affected_entity, same reference_id, resolved=TRUE) via NOT EXISTS.
-- We insert a resolved row per alert so it counts as triaged and
-- drops out of the unresolved 7d count.

INSERT INTO financial_anomalies
  (severity, anomaly_type, description, affected_entity, reference_id,
   details, detected_at, resolved, resolved_at, resolution_note)
VALUES
  -- cashbox reversal rows (migration 078 via fn_record_cashbox_txn)
  ('low', 'legacy_bypass_journal_entry',
   'Controlled cleanup write from migration 078 (cashbox reversal for VERIFY_PR settlement id=4).',
   'cashbox_transactions', '101',
   '{"migration":"078_cleanup_verify_pr_test_transactions","intent":"reversal"}'::jsonb,
   NOW(), TRUE, NOW(),
   'Intentional cleanup — migration 078 reversed VERIFY_PR test settlements'),
  ('low', 'legacy_bypass_journal_entry',
   'Controlled cleanup write from migration 078 (cashbox reversal for VERIFY_PR settlement id=5).',
   'cashbox_transactions', '102',
   '{"migration":"078_cleanup_verify_pr_test_transactions","intent":"reversal"}'::jsonb,
   NOW(), TRUE, NOW(),
   'Intentional cleanup — migration 078 reversed VERIFY_PR test settlements'),
  -- journal_entries voided by migration 078 (settlement JEs for VERIFY_PR test rows)
  ('low', 'legacy_bypass_journal_entry',
   'Controlled cleanup write from migration 078 (void JE-2026-000183 for VERIFY_PR settlement id=4).',
   'journal_entries', '075ebea5-96f8-4a1c-b84e-0d20f9bb0f15',
   '{"migration":"078_cleanup_verify_pr_test_transactions","intent":"void"}'::jsonb,
   NOW(), TRUE, NOW(),
   'Intentional cleanup — migration 078 voided VERIFY_PR test settlement JE'),
  ('low', 'legacy_bypass_journal_entry',
   'Controlled cleanup write from migration 078 (void JE-2026-000185 for VERIFY_PR settlement id=5).',
   'journal_entries', '4b644bd7-2ffe-48b6-aeda-6c82ab6775c2',
   '{"migration":"078_cleanup_verify_pr_test_transactions","intent":"void"}'::jsonb,
   NOW(), TRUE, NOW(),
   'Intentional cleanup — migration 078 voided VERIFY_PR test settlement JE');

COMMIT;
