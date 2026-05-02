-- ============================================================================
-- 122 — PR-FIN-RETURNS-UX-1B: schema preparation for admin return cancellation
-- ============================================================================
--
-- This migration is the SCHEMA HALF of the upcoming admin-only return
-- cancellation flow. It does NOT add the cancel endpoint, the cancel UI,
-- the reversal journal entry path, or the stock-deduction path — those
-- ship in PR 1C / 1E. This file is read-only DDL plus one permission
-- seed; no existing return / journal_entry / cashbox_transaction /
-- stock_movement row is touched.
--
-- What this migration adds — and what it does NOT
-- -----------------------------------------------
-- 1. Adds 'cancelled' to the `return_status` enum so the cancel flow
--    can later transition a row into the new state. Uses
--    `ALTER TYPE … ADD VALUE IF NOT EXISTS` (PG ≥12 idempotent path)
--    appended at the end of the enum. The new value is NOT referenced
--    anywhere in this migration — Postgres ≥12 only allows the new
--    enum value to be used in transactions AFTER the ALTER TYPE
--    transaction commits, and our migration runner runs each file in
--    its own BEGIN/COMMIT, so the rule is naturally satisfied: PR 1C's
--    cancel endpoint runs in a later transaction.
-- 2. Adds five nullable columns on `returns` to store the cancellation
--    audit trail and the reversal record FKs:
--      • cancelled_at                          timestamptz
--      • cancelled_by                          uuid → users(id)            ON DELETE SET NULL
--      • cancel_reason                         text
--      • cancellation_entry_id                 uuid → journal_entries(id)  ON DELETE SET NULL
--      • cancellation_cashbox_transaction_id   bigint → cashbox_transactions(id) ON DELETE SET NULL
--    The user-FK ON DELETE SET NULL mirrors the existing
--    `requested_by/approved_by/refunded_by` convention on this table
--    (verified live before writing). The reversal-record FKs use the
--    same defensive policy so a future hard-delete (which the engine
--    guards already block) cannot orphan the link.
-- 3. Normalized linkage table `return_cancellation_stock_movements` —
--    one row per (return, stock_movement) reversal pair, so a single
--    cancellation can reference an arbitrary number of stock-movement
--    reversals without an unbounded array column on `returns`.
--    NOTE on the FK type: `stock_movements.id` is **bigint** in this
--    schema (NOT uuid). The linkage column is therefore `bigint`. This
--    was explicitly verified before writing the migration — the spec
--    asked us to surface this if the type was non-uuid.
-- 4. Indexes on the four hot-path columns:
--      • returns(cancelled_at)            — date-range filters in 1D
--      • returns(cancelled_by)            — operator filter in 1D
--      • return_cancellation_stock_movements(return_id)
--      • return_cancellation_stock_movements(stock_movement_id)
--    The unique constraint (return_id, stock_movement_id) doubles as
--    a btree index on those columns; we still add the standalone
--    return_id index because most queries filter on return alone.
-- 5. Permission seed `returns.cancel`:
--      • Inserted into the `permissions` catalog with module=returns,
--        Arabic + English labels.
--      • Granted to the **admin** role only via the canonical
--        `roles.permissions[]` array column (the same mechanism mig
--        121 used for payment-accounts.*; the legacy `role_permissions`
--        join table is vestigial in this schema).
--      • Manager / cashier / accountant do NOT receive the grant —
--        cancellation is an admin-only action per the RETURNS-UX-1
--        scope. The existing `returns.create` / `returns.approve`
--        permissions stay untouched.
-- 6. DO $verify$ self-validation block. Pattern matches mig 119 / 120 /
--    121: every change above is asserted at the end of the migration
--    so a partial application surfaces immediately on boot.
--
-- What this migration deliberately does NOT do
-- --------------------------------------------
--   • Does NOT modify any existing row in returns / return_items /
--     journal_entries / journal_lines / cashbox_transactions /
--     stock_movements / cashboxes.
--   • Does NOT add the cancel endpoint, service method, controller
--     route, or DTO — those are PR 1C scope.
--   • Does NOT add the cancel UI or button — those are PR 1E scope.
--   • Does NOT loosen permissions on existing roles.
--   • Does NOT add any DB function or trigger.
--   • Does NOT alter FinancialEngine, posting, accounting, POS,
--     ReceiptModal, SupplierPayModal, or @Roles surface.
--
-- Idempotency
-- -----------
-- All DDL uses `IF NOT EXISTS` and `ON CONFLICT DO NOTHING` so re-runs
-- on a partially-applied DB are no-ops. The DO $verify$ block is the
-- forward gate — it raises if any expected artefact is missing after
-- this migration commits.

-- ── 1 — Enum extension ─────────────────────────────────────────────────────
ALTER TYPE return_status ADD VALUE IF NOT EXISTS 'cancelled';

-- ── 2 — Columns on `returns` ───────────────────────────────────────────────
ALTER TABLE returns
  ADD COLUMN IF NOT EXISTS cancelled_at  timestamptz,
  ADD COLUMN IF NOT EXISTS cancelled_by  uuid,
  ADD COLUMN IF NOT EXISTS cancel_reason text,
  ADD COLUMN IF NOT EXISTS cancellation_entry_id                uuid,
  ADD COLUMN IF NOT EXISTS cancellation_cashbox_transaction_id  bigint;

-- FK constraints — added separately so `IF NOT EXISTS` semantics work on
-- the columns. We name the constraints explicitly so the verify block
-- can assert their presence without depending on auto-generated names.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'returns_cancelled_by_fkey'
  ) THEN
    ALTER TABLE returns
      ADD CONSTRAINT returns_cancelled_by_fkey
      FOREIGN KEY (cancelled_by) REFERENCES users(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'returns_cancellation_entry_id_fkey'
  ) THEN
    ALTER TABLE returns
      ADD CONSTRAINT returns_cancellation_entry_id_fkey
      FOREIGN KEY (cancellation_entry_id) REFERENCES journal_entries(id) ON DELETE SET NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'returns_cancellation_ct_id_fkey'
  ) THEN
    ALTER TABLE returns
      ADD CONSTRAINT returns_cancellation_ct_id_fkey
      FOREIGN KEY (cancellation_cashbox_transaction_id)
      REFERENCES cashbox_transactions(id) ON DELETE SET NULL;
  END IF;
END
$$;

-- ── 3 — Linkage table ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS return_cancellation_stock_movements (
  id                 uuid          PRIMARY KEY DEFAULT uuid_generate_v4(),
  return_id          uuid          NOT NULL REFERENCES returns(id)         ON DELETE CASCADE,
  -- stock_movements.id is bigint in this schema, NOT uuid.
  stock_movement_id  bigint        NOT NULL REFERENCES stock_movements(id) ON DELETE RESTRICT,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT return_cancellation_stock_movements_uq
    UNIQUE (return_id, stock_movement_id)
);

-- ── 4 — Indexes ────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS returns_cancelled_at_idx
  ON returns (cancelled_at);
CREATE INDEX IF NOT EXISTS returns_cancelled_by_idx
  ON returns (cancelled_by);
CREATE INDEX IF NOT EXISTS return_cancellation_stock_movements_return_id_idx
  ON return_cancellation_stock_movements (return_id);
CREATE INDEX IF NOT EXISTS return_cancellation_stock_movements_stock_movement_id_idx
  ON return_cancellation_stock_movements (stock_movement_id);

-- ── 5 — Permission catalog + admin grant ───────────────────────────────────
INSERT INTO permissions (code, module, name_ar, name_en, description)
VALUES
  ('returns.cancel',
   'returns',
   'إلغاء مرتجع',
   'Cancel return',
   'Admin-only cancellation of an approved/refunded return — creates a controlled reversal. Required for the POST /returns/:id/cancel endpoint shipping in PR-FIN-RETURNS-UX-1C.')
ON CONFLICT (code) DO NOTHING;

-- Grant to admin only. DISTINCT unnest prevents duplicates on re-apply.
UPDATE roles
   SET permissions = ARRAY(
       SELECT DISTINCT unnest(
         COALESCE(permissions, ARRAY[]::text[])
         || ARRAY['returns.cancel']
       )
     ),
       updated_at = NOW()
 WHERE code = 'admin';

-- ── 6 — Self-validation ────────────────────────────────────────────────────
DO $verify$
DECLARE
  v_rel_id  oid;
BEGIN
  -- 6a. Enum value exists
  IF NOT EXISTS (
    SELECT 1
      FROM pg_type t
      JOIN pg_enum e ON e.enumtypid = t.oid
     WHERE t.typname = 'return_status' AND e.enumlabel = 'cancelled'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-RETURNS-UX-1B: return_status enum missing ''cancelled''';
  END IF;

  -- 6b. New columns on returns exist with the right types
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='returns'
       AND column_name='cancelled_at' AND data_type='timestamp with time zone'
  ) THEN RAISE EXCEPTION 'PR-FIN-RETURNS-UX-1B: returns.cancelled_at missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='returns'
       AND column_name='cancelled_by' AND data_type='uuid'
  ) THEN RAISE EXCEPTION 'PR-FIN-RETURNS-UX-1B: returns.cancelled_by missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='returns'
       AND column_name='cancel_reason' AND data_type='text'
  ) THEN RAISE EXCEPTION 'PR-FIN-RETURNS-UX-1B: returns.cancel_reason missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='returns'
       AND column_name='cancellation_entry_id' AND data_type='uuid'
  ) THEN RAISE EXCEPTION 'PR-FIN-RETURNS-UX-1B: returns.cancellation_entry_id missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema='public' AND table_name='returns'
       AND column_name='cancellation_cashbox_transaction_id'
       AND data_type='bigint'
  ) THEN RAISE EXCEPTION
    'PR-FIN-RETURNS-UX-1B: returns.cancellation_cashbox_transaction_id missing or wrong type (expected bigint)';
  END IF;

  -- 6c. FK constraints
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'returns_cancelled_by_fkey'
  ) THEN RAISE EXCEPTION 'PR-FIN-RETURNS-UX-1B: returns_cancelled_by_fkey missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'returns_cancellation_entry_id_fkey'
  ) THEN RAISE EXCEPTION 'PR-FIN-RETURNS-UX-1B: returns_cancellation_entry_id_fkey missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'returns_cancellation_ct_id_fkey'
  ) THEN RAISE EXCEPTION 'PR-FIN-RETURNS-UX-1B: returns_cancellation_ct_id_fkey missing';
  END IF;

  -- 6d. Linkage table + unique
  SELECT to_regclass('public.return_cancellation_stock_movements') INTO v_rel_id;
  IF v_rel_id IS NULL THEN
    RAISE EXCEPTION 'PR-FIN-RETURNS-UX-1B: return_cancellation_stock_movements table missing';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'return_cancellation_stock_movements_uq'
  ) THEN
    RAISE EXCEPTION
      'PR-FIN-RETURNS-UX-1B: unique(return_id, stock_movement_id) constraint missing';
  END IF;

  -- 6e. Permission catalog row
  IF NOT EXISTS (
    SELECT 1 FROM permissions WHERE code='returns.cancel'
  ) THEN
    RAISE EXCEPTION 'PR-FIN-RETURNS-UX-1B: permission returns.cancel not seeded';
  END IF;

  -- 6f. Admin role grant
  IF NOT EXISTS (
    SELECT 1 FROM roles
     WHERE code = 'admin'
       AND 'returns.cancel' = ANY(permissions)
  ) THEN
    RAISE EXCEPTION
      'PR-FIN-RETURNS-UX-1B: role admin missing returns.cancel grant';
  END IF;

  -- 6g. Sanity: cashier/manager MUST NOT have the grant (admin-only).
  IF EXISTS (
    SELECT 1 FROM roles
     WHERE code IN ('cashier', 'manager', 'salesperson')
       AND 'returns.cancel' = ANY(permissions)
  ) THEN
    RAISE EXCEPTION
      'PR-FIN-RETURNS-UX-1B: returns.cancel grant leaked to non-admin role';
  END IF;
END
$verify$;
