-- Migration 094 — Expense edit-request workflow + RBAC.
-- ═══════════════════════════════════════════════════════════════════════════
--
-- Context
--
--   `accounting.service.ts.updateExpense` already rejects edits on
--   approved expenses (line 455 — `is_approved=FALSE` guard) so the
--   only safe path to "fix" an approved expense today is to delete +
--   recreate, which loses the original expense_no, breaks the
--   register's audit trail, and leaves dangling JE references.
--
--   This migration establishes a request-based edit workflow so
--   already-approved expenses can be corrected with full provenance:
--     * cashier/manager files an edit request with a required reason
--     * admin/manager (with the right permission) approves or rejects
--     * on approval, the backend voids the original JE+cashbox txn
--       atomically and posts a corrected one — same expense row,
--       same expense_no, new ledger trail
--     * every step is recorded so the history modal can render
--       requested_by / requested_at / reason / old / new / decided_by
--       / decided_at / rejection_reason / linked JEs
--
-- Change
--
--   1. CREATE TABLE expense_edit_requests — append-only audit ledger.
--      Soft FK to journal_entries via voided_je_id / applied_je_id so
--      a JE delete in dev doesn't cascade-orphan history.
--   2. Two indexes — by expense (history modal), by pending status
--      (inbox query is the hot path).
--   3. Seed two new permission codes:
--        * expenses.daily.edit.request  — file an edit request
--        * expenses.daily.edit.approve  — approve / reject one
--      Granted to admin (wildcard already covers it but the explicit
--      grant makes the catalog complete) + manager (operational
--      need). Cashier intentionally excluded — must request, can't
--      approve.
--
-- Not touched
--   * journal_entries / journal_lines / cashboxes — the engine handles
--     all writes; this migration is metadata only.
--   * fn_record_cashbox_txn or any engine helper.
--   * Existing approval system (expense_approvals / approval_rules) —
--     that's the *initial* approval gate; this is a separate edit
--     gate so the schemas stay independent.
-- ═══════════════════════════════════════════════════════════════════════════

BEGIN;

CREATE TABLE IF NOT EXISTS public.expense_edit_requests (
  id                UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  expense_id        UUID NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  requested_by      UUID NOT NULL REFERENCES public.users(id),
  requested_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  reason            TEXT NOT NULL CHECK (length(trim(reason)) >= 5),
  -- Snapshot of the editable fields BEFORE the change (taken at request time).
  old_values        JSONB NOT NULL,
  -- Subset of editable fields the requester wants to change.
  new_values        JSONB NOT NULL,
  status            VARCHAR(20) NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','approved','rejected','cancelled')),
  decided_by        UUID REFERENCES public.users(id),
  decided_at        TIMESTAMPTZ,
  -- Filled when the request is rejected or cancelled. NULL on approve.
  rejection_reason  TEXT,
  -- Filled on approval IF the change touched accounting fields. The
  -- engine emits a reversal JE (which voids the original) and a fresh
  -- corrected JE. Both ids are recorded so history can deep-link.
  voided_je_id      UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  applied_je_id     UUID REFERENCES public.journal_entries(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_expense_edit_requests_expense
  ON public.expense_edit_requests (expense_id, requested_at DESC);

-- Hot path: inbox query filters WHERE status='pending'. Partial index
-- so only pending rows occupy index space.
CREATE INDEX IF NOT EXISTS ix_expense_edit_requests_pending
  ON public.expense_edit_requests (status, requested_at DESC)
 WHERE status = 'pending';

COMMENT ON TABLE public.expense_edit_requests IS
  'Append-only audit log for edit requests on approved expenses. The
   service handler voids the original JE + posts a corrected one when
   accounting fields change; both ids are recorded here.';

-- ─── Permissions ────────────────────────────────────────────────────────

INSERT INTO public.permissions (code, module, name_ar, name_en) VALUES
  ('expenses.daily.edit.request', 'accounting',
   'طلب تعديل مصروف يومي', 'Request edit on a daily expense'),
  ('expenses.daily.edit.approve', 'accounting',
   'الموافقة على تعديل المصروفات اليومية', 'Approve / reject expense edit requests')
ON CONFLICT (code) DO NOTHING;

-- Catalog grant — admin gets everything explicitly so audit queries
-- against roles.permissions[] are complete (admin's wildcard already
-- satisfies hasPermission at runtime).
UPDATE public.roles
   SET permissions = (
     SELECT array_agg(DISTINCT p ORDER BY p)
       FROM unnest(
         permissions || ARRAY[
           'expenses.daily.edit.request',
           'expenses.daily.edit.approve'
         ]::text[]
       ) AS p
   )
 WHERE code = 'admin';

-- Manager: operational role — can both file and approve edit
-- requests on the operations they oversee.
UPDATE public.roles
   SET permissions = (
     SELECT array_agg(DISTINCT p ORDER BY p)
       FROM unnest(
         permissions || ARRAY[
           'expenses.daily.edit.request',
           'expenses.daily.edit.approve'
         ]::text[]
       ) AS p
   )
 WHERE code = 'manager';

-- Cashier: can request edits to their own day's mistakes. Approval
-- stays with manager/admin — cashier intentionally excluded from the
-- approve permission.
UPDATE public.roles
   SET permissions = (
     SELECT array_agg(DISTINCT p ORDER BY p)
       FROM unnest(
         permissions || ARRAY['expenses.daily.edit.request']::text[]
       ) AS p
   )
 WHERE code = 'cashier';

-- ─── role_permissions junction (kept in sync for explicit lookups) ─────

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.roles r,
       public.permissions p
 WHERE r.code IN ('admin', 'manager', 'cashier')
   AND p.code = 'expenses.daily.edit.request'
ON CONFLICT DO NOTHING;

INSERT INTO public.role_permissions (role_id, permission_id)
SELECT r.id, p.id
  FROM public.roles r,
       public.permissions p
 WHERE r.code IN ('admin', 'manager')
   AND p.code = 'expenses.daily.edit.approve'
ON CONFLICT DO NOTHING;

COMMIT;
