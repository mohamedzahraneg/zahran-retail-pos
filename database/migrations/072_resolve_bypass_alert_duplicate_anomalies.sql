-- Migration 072 — Resolve duplicate "legacy_bypass_journal_entry" anomalies
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Background
--
--   Between 2026-04-23 08:22 and 2026-04-23 20:14, eleven legacy-writer
--   events landed `engine_bypass_alerts` rows before Phase 2.4 retired
--   the remaining non-engine writer contexts:
--
--     table                 record_id                                     context
--     ─────────────────────────────────────────────────────────────────────────
--     cashbox_transactions  49                                            'on'
--     cashbox_transactions  51                                            'on'
--     cashbox_transactions  80,81,82,83,84                                'service:cashbox_fn_fallback'
--     journal_entries       55aa19b2-d67d-49a2-81f8-02ccab611676          'on'
--     journal_entries       55aa19b2-… (UPDATE to is_posted)              'on'
--     journal_lines         2a33d2a6-… , 4451c2d9-…                       'on'
--
--   The `financial-health` scanner converts every alert in its rolling
--   window into a `financial_anomalies` row via
--     ON CONFLICT (anomaly_type, affected_entity, reference_id, resolved)
--     DO NOTHING
--
--   Because `resolved` is part of the conflict key, marking a row
--   resolved=TRUE opens a fresh slot for resolved=FALSE. On 2026-04-24
--   06:50 UTC the scanner re-inserted ten resolved=FALSE anomalies for
--   the SAME ten historical reference_ids that had been marked
--   resolved=TRUE on 2026-04-23.
--
-- Proof the math is correct
--
--   For every one of the ten reference_ids, the paired journal_entry is
--   is_posted=TRUE, is_void=FALSE, and has SUM(debit) − SUM(credit) = 0.
--   Verified via the query below (run BEFORE this migration applies);
--   it returns zero rows.
--
--     SELECT anomaly_id, affected_entity, reference_id
--       FROM financial_anomalies fa
--      WHERE fa.anomaly_type = 'legacy_bypass_journal_entry'
--        AND fa.resolved = FALSE
--        AND NOT EXISTS (
--          -- paired JE must exist, be posted, non-void, and balanced
--          SELECT 1
--            FROM journal_entries je
--            LEFT JOIN journal_lines jl ON jl.entry_id = je.id
--           WHERE (
--                   (fa.affected_entity = 'journal_entries' AND je.id::text = fa.reference_id)
--                OR (fa.affected_entity = 'journal_lines'
--                    AND EXISTS (SELECT 1 FROM journal_lines jl2
--                                 WHERE jl2.id::text = fa.reference_id
--                                   AND jl2.entry_id = je.id))
--                OR (fa.affected_entity = 'cashbox_transactions'
--                    AND EXISTS (SELECT 1 FROM cashbox_transactions ct
--                                 WHERE ct.id::text = fa.reference_id
--                                   AND je.reference_type::text = ct.reference_type::text
--                                   AND je.reference_id::text   = ct.reference_id::text))
--                 )
--             AND je.is_posted AND NOT je.is_void
--           GROUP BY je.id
--          HAVING ABS(COALESCE(SUM(jl.debit),0) - COALESCE(SUM(jl.credit),0)) < 0.01
--        );
--
--   This migration was written AFTER the proof query was run and
--   confirmed empty. Resolution note on each row points back to the
--   paired (posted, balanced) JE as evidence.
--
-- What this migration does
--
--   1. Marks the 10 resolved=FALSE anomalies as resolved=TRUE with a
--      resolution_note explaining the writer-identity-only nature of
--      the event and that the ledger math is verified correct.
--   2. Does NOT delete any anomaly rows (append-only by design; we
--      keep the full forensic record).
--   3. Does NOT touch the bypass alerts themselves.
--   4. Is idempotent — re-running it on an already-clean database
--      makes zero changes.
--
-- Follow-up code change (tracked separately)
--
--   `backend/src/dashboard/financial-health.service.ts` should be
--   updated to suppress re-detection when a resolved=TRUE anomaly
--   already exists for the same (anomaly_type, affected_entity,
--   reference_id). Without that fix, the next scheduler run will
--   create new resolved=FALSE rows for the same 10 events.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- Engine-context so the UPDATE passes fn_engine_write_allowed. We use
-- the `migration:*` identity since this is schema-migration bookkeeping,
-- not an application flow.
SET LOCAL app.engine_context = 'migration:072_resolve_bypass_alert_duplicate_anomalies';

WITH safe AS (
  -- Only target anomalies where a paired JE is LIVE, POSTED, and BALANCED.
  -- A row that does NOT satisfy this is untouched — it becomes an
  -- operator-review case, which is the correct default.
  SELECT fa.anomaly_id
    FROM financial_anomalies fa
   WHERE fa.anomaly_type = 'legacy_bypass_journal_entry'
     AND fa.resolved = FALSE
     AND (
       -- Flavour A: affected row IS a journal_entry
       EXISTS (
         SELECT 1
           FROM journal_entries je
           JOIN journal_lines jl ON jl.entry_id = je.id
          WHERE fa.affected_entity = 'journal_entries'
            AND je.id::text = fa.reference_id
            AND je.is_posted AND NOT je.is_void
          GROUP BY je.id
         HAVING ABS(SUM(jl.debit) - SUM(jl.credit)) < 0.01
       )
       -- Flavour B: affected row IS a journal_line → its entry must be balanced
       OR EXISTS (
         SELECT 1
           FROM journal_lines jl
           JOIN journal_entries je ON je.id = jl.entry_id
           JOIN journal_lines  jlx ON jlx.entry_id = je.id
          WHERE fa.affected_entity = 'journal_lines'
            AND jl.id::text = fa.reference_id
            AND je.is_posted AND NOT je.is_void
          GROUP BY je.id
         HAVING ABS(SUM(jlx.debit) - SUM(jlx.credit)) < 0.01
       )
       -- Flavour C: affected row IS a cashbox_transaction → its paired
       -- source-document JE must be balanced
       OR EXISTS (
         SELECT 1
           FROM cashbox_transactions ct
           JOIN journal_entries je
             ON je.reference_type::text = ct.reference_type::text
            AND je.reference_id::text   = ct.reference_id::text
           JOIN journal_lines jl ON jl.entry_id = je.id
          WHERE fa.affected_entity = 'cashbox_transactions'
            AND ct.id::text = fa.reference_id
            AND je.is_posted AND NOT je.is_void
          GROUP BY je.id
         HAVING ABS(SUM(jl.debit) - SUM(jl.credit)) < 0.01
       )
     )
)
UPDATE financial_anomalies fa
   SET resolved        = TRUE,
       resolved_at     = NOW(),
       resolution_note = COALESCE(
         fa.resolution_note,
         'Resolved by migration 072 — duplicate of a historical legacy-context write. '
         || 'The paired journal_entry is posted, non-void, and balanced (DR = CR). '
         || 'Ledger math verified correct; this is a writer-identity-only event. '
         || 'The source bypass was retired by Phase 2.4 (engine-context migration).'
       )
 WHERE fa.anomaly_id IN (SELECT anomaly_id FROM safe);

COMMIT;
