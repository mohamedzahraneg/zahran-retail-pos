-- Migration 073 — Deactivate placeholder/person-named expense categories
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   Three user-created expense categories were being misused as
--   employee-payout shortcuts:
--
--     code   name_ar               account_id → 529 مصروفات متفرقة
--     ─────  ──────────────────   ─────────────────────────────────
--     1      zahran                → 529
--     2      محمد الظباطي          → 529
--     3      ابو يوسف              → 529
--
--   Codes 2 and 3 match active users.employee_no for real employees.
--   Selecting them on the Daily Expenses page booked cash out to
--   DR 529 / CR 1111 — hiding what was really cash handed to an
--   employee. The correct treatment is DR 1123 ذمم الموظفين (tagged
--   with employee_user_id) / CR 1111, which the FinancialEngine
--   already supports via is_advance=TRUE.
--
--   The paired code fix in posting.service.ts now forwards is_advance
--   + employee_user_id to the engine, so future flows that correctly
--   flag an advance post to 1123 automatically. These three
--   categories are not real expense types and should not appear in
--   the future dropdown, so we soft-deactivate them here (is_active
--   = FALSE — same path as the soft-delete CRUD endpoint).
--
--   Historical journal entries + expenses referencing these category
--   IDs are intentionally left untouched. A separate controlled
--   reclassification (945 EGP across 4 rows) will follow in its own
--   PR once this bug is safely closed.
--
-- Effect
--
--   * is_active = FALSE on three specific rows (idempotent)
--   * no rows deleted
--   * no FK rewiring, no schema change, no triggers affected
-- ═══════════════════════════════════════════════════════════════════════════

UPDATE expense_categories
   SET is_active = FALSE
 WHERE name_ar IN ('zahran', 'محمد الظباطي', 'ابو يوسف')
   AND code    IN ('1', '2', '3')
   AND is_active = TRUE;
