-- 040_unify_employee_accounting.sql
-- ============================================================================
-- SYSTEM UNIFICATION — single source of truth for employee financial flows.
-- ============================================================================
--
-- BEFORE (fragmented):
--     employee_bonuses          ─┐
--     employee_deductions       ─┼──► 3 direct GL triggers (mine, 039d)
--     employee_requests (advance)─┘
--     employee_transactions      ──► its own GL trigger
--     employee_settlements       ──► nothing (no posting at all)
--
--     → 4 parallel posting paths, balance fragility, audit holes.
--
-- AFTER (unified):
--     employee_bonuses      ─┐
--     employee_deductions   ─┤ mirror trigger (INSERT only) ─►
--     employee_requests     ─┤                                 employee_transactions ─► fn_post_employee_txn ─► journal_entries/lines
--     employee_settlements  ─┘                                 (SINGLE posting pipeline)
--     direct POS/manual ────►  employee_transactions           ─► journal_entries/lines
--
--     → ONE operational table (employee_transactions).
--     → ONE GL writer function (fn_post_employee_txn).
--     → ONE balance view (v_employee_balances_gl, unchanged).
--
-- CRITICAL: historical GL entries posted by the 039d triggers stay valid
-- (balanced + dimensioned). This migration only changes the forward path.
-- No backfill of employee_transactions for historical rows — that would
-- create duplicate GL entries.

-- ─── 1. Drop the direct GL-posting triggers on legacy tables ────────────
-- They are replaced by mirror triggers that route through employee_transactions.
DROP TRIGGER IF EXISTS trg_employee_bonus_post      ON employee_bonuses;
DROP TRIGGER IF EXISTS trg_employee_deduction_post  ON employee_deductions;
DROP TRIGGER IF EXISTS trg_employee_advance_post    ON employee_requests;

-- ─── 2. Source-tracing columns on employee_transactions ────────────────
-- So we can tell which legacy row (if any) spawned each transaction, and
-- so the mirror triggers can enforce idempotency — one txn per legacy id.
ALTER TABLE employee_transactions
    ADD COLUMN IF NOT EXISTS source_ref_type text,
    ADD COLUMN IF NOT EXISTS source_ref_id   bigint;

CREATE UNIQUE INDEX IF NOT EXISTS uq_emp_txn_source
    ON employee_transactions(source_ref_type, source_ref_id)
 WHERE source_ref_type IS NOT NULL AND source_ref_id IS NOT NULL;

-- ─── 3. Mirror trigger: employee_bonuses → employee_transactions ────────
CREATE OR REPLACE FUNCTION public.fn_mirror_bonus_to_txn()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Forward path only — voids/updates handled by the txn row itself.
    IF TG_OP = 'INSERT' AND NEW.is_void = false THEN
        INSERT INTO employee_transactions
            (employee_id, type, amount, txn_date, description,
             source_ref_type, source_ref_id, created_by)
        VALUES
            (NEW.user_id, 'bonus', NEW.amount, NEW.bonus_date,
             COALESCE(NEW.note, format('مكافأة (%s)', NEW.kind)),
             'employee_bonus', NEW.id, NEW.created_by)
        ON CONFLICT (source_ref_type, source_ref_id) DO NOTHING;
    ELSIF TG_OP = 'UPDATE' AND NEW.is_void = true AND OLD.is_void = false THEN
        -- Cascade the void into the mirrored transaction (which in turn
        -- voids its GL entry).
        DELETE FROM employee_transactions
         WHERE source_ref_type = 'employee_bonus' AND source_ref_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mirror_bonus_to_txn ON employee_bonuses;
CREATE TRIGGER trg_mirror_bonus_to_txn
    AFTER INSERT OR UPDATE ON employee_bonuses
    FOR EACH ROW EXECUTE FUNCTION fn_mirror_bonus_to_txn();

-- ─── 4. Mirror: employee_deductions → employee_transactions ─────────────
CREATE OR REPLACE FUNCTION public.fn_mirror_deduction_to_txn()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.is_void = false THEN
        INSERT INTO employee_transactions
            (employee_id, type, amount, txn_date, description,
             source_ref_type, source_ref_id, created_by)
        VALUES
            (NEW.user_id, 'deduction', NEW.amount, NEW.deduction_date,
             NEW.reason, 'employee_deduction', NEW.id, NEW.created_by)
        ON CONFLICT (source_ref_type, source_ref_id) DO NOTHING;
    ELSIF TG_OP = 'UPDATE' AND NEW.is_void = true AND OLD.is_void = false THEN
        DELETE FROM employee_transactions
         WHERE source_ref_type = 'employee_deduction' AND source_ref_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mirror_deduction_to_txn ON employee_deductions;
CREATE TRIGGER trg_mirror_deduction_to_txn
    AFTER INSERT OR UPDATE ON employee_deductions
    FOR EACH ROW EXECUTE FUNCTION fn_mirror_deduction_to_txn();

-- ─── 5. Mirror: employee_requests (approved advances) → employee_transactions ─
CREATE OR REPLACE FUNCTION public.fn_mirror_advance_to_txn()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    -- Fire only on the approval transition for kind='advance'.
    IF NEW.kind = 'advance' AND NEW.status = 'approved' AND NEW.amount IS NOT NULL
       AND (OLD IS NULL OR OLD.status IS DISTINCT FROM NEW.status) THEN
        INSERT INTO employee_transactions
            (employee_id, type, amount, txn_date, description,
             source_ref_type, source_ref_id, created_by)
        VALUES
            (NEW.user_id, 'advance', NEW.amount,
             COALESCE(NEW.decided_at::date, NEW.created_at::date),
             NEW.reason, 'employee_request', NEW.id, NEW.decided_by)
        ON CONFLICT (source_ref_type, source_ref_id) DO NOTHING;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mirror_advance_to_txn ON employee_requests;
CREATE TRIGGER trg_mirror_advance_to_txn
    AFTER INSERT OR UPDATE ON employee_requests
    FOR EACH ROW EXECUTE FUNCTION fn_mirror_advance_to_txn();

-- ─── 6. Mirror: employee_settlements → employee_transactions (payout) ───
-- Settlements are cash payouts to the employee. Type = 'payout'.
CREATE OR REPLACE FUNCTION public.fn_mirror_settlement_to_txn()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' AND NEW.is_void = false THEN
        INSERT INTO employee_transactions
            (employee_id, type, amount, txn_date, description,
             source_ref_type, source_ref_id,
             cashbox_id, created_by)
        VALUES
            (NEW.user_id, 'payout', NEW.amount, NEW.settlement_date,
             COALESCE(NEW.notes, format('تسوية — %s', NEW.method)),
             'employee_settlement', NEW.id,
             NEW.cashbox_id, NEW.created_by)
        ON CONFLICT (source_ref_type, source_ref_id) DO NOTHING;
    ELSIF TG_OP = 'UPDATE' AND NEW.is_void = true AND OLD.is_void = false THEN
        DELETE FROM employee_transactions
         WHERE source_ref_type = 'employee_settlement' AND source_ref_id = NEW.id;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mirror_settlement_to_txn ON employee_settlements;
CREATE TRIGGER trg_mirror_settlement_to_txn
    AFTER INSERT OR UPDATE ON employee_settlements
    FOR EACH ROW EXECUTE FUNCTION fn_mirror_settlement_to_txn();

-- ─── 7. Hard guard: prevent direct writes to legacy GL posting functions ─
-- These four functions are kept in case external callers use them, but are
-- now no-ops with a RAISE notice — we want a loud signal if anything still
-- tries to bypass the mirror pipeline.
CREATE OR REPLACE FUNCTION public.fn_post_employee_bonus(p_bonus_id bigint)
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
    RAISE NOTICE
        'fn_post_employee_bonus is deprecated (migration 040). The mirror '
        'trigger now routes through employee_transactions.';
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_post_employee_deduction(p_id bigint)
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
    RAISE NOTICE
        'fn_post_employee_deduction is deprecated (migration 040). Mirror '
        'trigger routes through employee_transactions.';
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION public.fn_post_employee_advance(p_id bigint)
RETURNS uuid LANGUAGE plpgsql AS $$
BEGIN
    RAISE NOTICE
        'fn_post_employee_advance is deprecated (migration 040). Mirror '
        'trigger routes through employee_transactions.';
    RETURN NULL;
END;
$$;

COMMENT ON VIEW v_employee_balances_gl IS
    'AUTHORITATIVE employee balance view (migration 039 + 040 unification). '
    'Sourced ONLY from posted, non-void GL lines on accounts 213 + 1123. '
    'Positive net = company owes employee; negative = employee owes company. '
    'All employee events — bonuses, deductions, advances, wages, expenses, '
    'reimbursements, payouts, settlements — pass through employee_transactions '
    'which is the single GL writer. DO NOT query balances from any other source.';
