-- Migration 129 — expense_approval_rules dedupe + uniqueness invariant.
-- PR-FIX-EXPENSE-APPROVAL-RULES-DEDUPE
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Investigation on 2026-05-10 surfaced two duplicate-rule pairs in
--   expense_approval_rules created by a double-clicked seed on
--   2026-04-22 (the two rows in each pair share the same name_ar,
--   level, required_role, and [min_amount..max_amount] bracket and
--   were created ~19 hours apart):
--
--     manager / level=1 / [10000..50000] — 83d49133-… + 52b3baee-…
--     admin   / level=1 / [50000..NULL ] — 66ad21ef-… + 9a101e6f-…
--
--   ApprovalService.spawnForExpense() iterates active rules whose
--   bracket contains the expense amount and inserts ONE
--   expense_approvals row per matching rule.  With both rules of a
--   pair active, every expense in the affected bracket spawned TWO
--   identical approval rows — the user-visible "duplicate cards"
--   bug fixed at the display layer in commit 88de1ea (FE inbox
--   grouping).  This migration cleans up the source-of-truth so
--   future expenses spawn exactly one approval per natural key,
--   AND adds a partial unique index so no future writer can
--   reintroduce a duplicate active rule (defence-in-depth alongside
--   the service-level validation added in approval.service.ts).
--
-- Change
--
--   1. Soft-deactivate duplicate active rules.  Keep the OLDEST
--      active row per (required_role, level, min_amount,
--      COALESCE(max_amount, -1)).  Set is_active=FALSE on every
--      other row in the group.  Annotate `notes` with a
--      [migration-129] marker so audit queries can identify
--      cleanup-time deactivations.
--
--   2. Create a PARTIAL unique index that enforces the natural
--      key invariant ONLY across active rules.  Inactive rules
--      can still co-exist (history preservation; an admin can
--      re-activate one later if the active rule is removed).
--      COALESCE(max_amount, -1) normalizes the open-ended bracket
--      case (NULL max_amount = no upper bound).  -1 is unreachable
--      because the service guards `min_amount >= 0` and
--      `max_amount > min_amount`.
--
-- Not touched
--   * expense_approvals rows  — historical decisions stay readable
--     with their original rule_id pointers; FK is ON DELETE RESTRICT
--     (we don't delete) so this is invariant-safe.
--   * expenses                — the deactivation only affects future
--     spawnForExpense() matches; existing expenses remain in their
--     current is_approved state.
--   * journal_entries / journal_lines / cashbox_transactions /
--     stock_movements / FinancialEngine code path.
--   * No DROP / TRUNCATE / DELETE FROM anywhere.
--   * No accounting_only branch.
--
-- Idempotent re-apply
--   * The dedupe UPDATE is keyed off `rn > 1` from a per-group
--     row_number().  After the first apply, no group has more than
--     one active row, so subsequent applies do nothing.
--   * The unique index uses `IF NOT EXISTS`.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

-- ─── 1. Soft-deactivate duplicate active rules ────────────────────────
WITH duplicates AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY required_role, level, min_amount,
                        COALESCE(max_amount, '-1'::numeric)
           ORDER BY created_at, id
         ) AS rn
    FROM public.expense_approval_rules
   WHERE is_active = TRUE
)
UPDATE public.expense_approval_rules r
   SET is_active = FALSE,
       notes     = COALESCE(r.notes || E'\n', '')
                 || '[migration-129] deactivated as duplicate (kept oldest in group)',
       updated_at = NOW()
  FROM duplicates d
 WHERE r.id = d.id
   AND d.rn > 1;

-- ─── 2. Partial unique index — defence-in-depth invariant ──────────────
-- Active rules MUST be unique on (required_role, level, min_amount,
-- COALESCE(max_amount, -1)).  Step 1 ensured the table has zero
-- violating rows by the time this index is built.
CREATE UNIQUE INDEX IF NOT EXISTS uq_expense_approval_rules_active_natural_key
  ON public.expense_approval_rules (
       required_role,
       level,
       min_amount,
       COALESCE(max_amount, '-1'::numeric)
     )
 WHERE is_active = TRUE;

COMMIT;
