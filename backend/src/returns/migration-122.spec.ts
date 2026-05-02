/**
 * migration-122.spec.ts — PR-FIN-RETURNS-UX-1B
 *
 * Static-content (file-on-disk) assertions for migration 122. The full
 * apply-on-fresh-DB test runs in CI's Database (PostgreSQL 15) job; this
 * spec is the BE-jest companion that locks the DDL contract:
 *
 *   1. Migration file exists at the documented numbered slot.
 *   2. Adds `cancelled` to the `return_status` enum (idempotent path).
 *   3. Adds the 5 new columns on returns with the correct types.
 *      `cancellation_cashbox_transaction_id` is `bigint` because
 *      `cashbox_transactions.id` is bigint; flagged in this test so a
 *      future enum-type drift surfaces immediately.
 *   4. Linkage table `return_cancellation_stock_movements` exists with
 *      `stock_movement_id bigint` (NOT uuid — `stock_movements.id` is
 *      bigint in this schema).
 *   5. Unique constraint `(return_id, stock_movement_id)`.
 *   6. Indexes on the four hot-path columns.
 *   7. Permission seed `returns.cancel`.
 *   8. Admin role grant via `roles.permissions[]` array column.
 *   9. Cancel endpoint / cancel logic NOT introduced in this migration.
 *  10. No production-data UPDATE/DELETE on returns / journal_entries /
 *      cashbox_transactions / stock_movements.
 *
 * The DO $verify$ block at the end of the migration enforces the same
 * invariants at apply time. This spec is a fast pre-flight that catches
 * regressions in code review without spinning up Postgres.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('migration 122 — PR-FIN-RETURNS-UX-1B cancellation schema', () => {
  const SQL = readFileSync(
    resolve(
      __dirname,
      '../../../database/migrations/122_pr_fin_returns_ux_1b_cancellation_schema.sql',
    ),
    'utf8',
  );

  it('1. file exists and is read', () => {
    expect(SQL.length).toBeGreaterThan(500);
    expect(SQL).toContain('PR-FIN-RETURNS-UX-1B');
  });

  it('2. adds `cancelled` to return_status enum (idempotent)', () => {
    expect(SQL).toMatch(
      /ALTER TYPE return_status ADD VALUE IF NOT EXISTS 'cancelled'/,
    );
  });

  it('3. adds the 5 new columns on returns with correct types', () => {
    expect(SQL).toMatch(/cancelled_at\s+timestamptz/);
    expect(SQL).toMatch(/cancelled_by\s+uuid/);
    expect(SQL).toMatch(/cancel_reason\s+text/);
    expect(SQL).toMatch(/cancellation_entry_id\s+uuid/);
    // bigint to match cashbox_transactions.id type (NOT uuid)
    expect(SQL).toMatch(/cancellation_cashbox_transaction_id\s+bigint/);
  });

  it('3a. all 5 column adds use IF NOT EXISTS (idempotent on re-apply)', () => {
    const block = SQL.split(/-- ── 2/)[1] ?? '';
    const cancelCols = [
      'cancelled_at',
      'cancelled_by',
      'cancel_reason',
      'cancellation_entry_id',
      'cancellation_cashbox_transaction_id',
    ];
    for (const c of cancelCols) {
      expect(block).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS\\s+${c}`));
    }
  });

  it('3b. FK constraints on the new columns reference the correct tables', () => {
    expect(SQL).toMatch(
      /returns_cancelled_by_fkey[\s\S]+REFERENCES users\(id\) ON DELETE SET NULL/,
    );
    expect(SQL).toMatch(
      /returns_cancellation_entry_id_fkey[\s\S]+REFERENCES journal_entries\(id\) ON DELETE SET NULL/,
    );
    expect(SQL).toMatch(
      /returns_cancellation_ct_id_fkey[\s\S]+REFERENCES cashbox_transactions\(id\) ON DELETE SET NULL/,
    );
  });

  it('4. linkage table exists with stock_movement_id BIGINT (not uuid)', () => {
    expect(SQL).toMatch(
      /CREATE TABLE IF NOT EXISTS return_cancellation_stock_movements/,
    );
    // stock_movements.id is bigint in this schema. The FK MUST be bigint.
    expect(SQL).toMatch(/stock_movement_id\s+bigint\s+NOT NULL/);
    expect(SQL).toMatch(
      /REFERENCES stock_movements\(id\) ON DELETE RESTRICT/,
    );
    expect(SQL).toMatch(/return_id\s+uuid\s+NOT NULL/);
    expect(SQL).toMatch(
      /REFERENCES returns\(id\)\s+ON DELETE CASCADE/,
    );
  });

  it('5. unique(return_id, stock_movement_id) constraint exists', () => {
    expect(SQL).toMatch(
      /CONSTRAINT return_cancellation_stock_movements_uq[\s\S]+UNIQUE \(return_id, stock_movement_id\)/,
    );
  });

  it('6. indexes on the four hot-path columns', () => {
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS returns_cancelled_at_idx[\s\S]+ON returns \(cancelled_at\)/,
    );
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS returns_cancelled_by_idx[\s\S]+ON returns \(cancelled_by\)/,
    );
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS return_cancellation_stock_movements_return_id_idx[\s\S]+ON return_cancellation_stock_movements \(return_id\)/,
    );
    expect(SQL).toMatch(
      /CREATE INDEX IF NOT EXISTS return_cancellation_stock_movements_stock_movement_id_idx[\s\S]+ON return_cancellation_stock_movements \(stock_movement_id\)/,
    );
  });

  it('7. seeds the returns.cancel permission with module=returns + Arabic + English labels', () => {
    expect(SQL).toMatch(
      /INSERT INTO permissions \(code, module, name_ar, name_en, description\)[\s\S]+'returns\.cancel'[\s\S]+'returns'[\s\S]+'إلغاء مرتجع'[\s\S]+'Cancel return'/,
    );
    expect(SQL).toMatch(/ON CONFLICT \(code\) DO NOTHING/);
  });

  it('8. grants returns.cancel to the admin role only (via roles.permissions[])', () => {
    // Admin grant — uses the canonical array-column update.
    expect(SQL).toMatch(
      /UPDATE roles\s+SET permissions = ARRAY\([\s\S]+'returns\.cancel'[\s\S]+WHERE code = 'admin'/,
    );
    // No grant to manager / cashier / salesperson / accountant.
    expect(SQL).not.toMatch(
      /WHERE code = 'manager'[\s\S]+'returns\.cancel'/,
    );
    expect(SQL).not.toMatch(
      /WHERE code = 'cashier'[\s\S]+'returns\.cancel'/,
    );
    expect(SQL).not.toMatch(
      /WHERE code = 'salesperson'[\s\S]+'returns\.cancel'/,
    );
    // Verify block enforces non-leakage at apply time.
    expect(SQL).toMatch(
      /returns\.cancel grant leaked to non-admin role/,
    );
  });

  it('9. does NOT introduce the cancel endpoint / service method / write logic', () => {
    // This migration is schema only — no INSERT/UPDATE/DELETE on the
    // four production tables that the future cancel endpoint will
    // touch.
    expect(SQL).not.toMatch(
      /INSERT INTO journal_entries|UPDATE journal_entries|DELETE FROM journal_entries/i,
    );
    expect(SQL).not.toMatch(
      /INSERT INTO cashbox_transactions|UPDATE cashbox_transactions|DELETE FROM cashbox_transactions/i,
    );
    expect(SQL).not.toMatch(
      /INSERT INTO stock_movements|UPDATE stock_movements|DELETE FROM stock_movements/i,
    );
    // No UPDATE on returns rows themselves (we only ALTER TABLE which
    // is DDL, not DML).
    expect(SQL).not.toMatch(/^\s*UPDATE returns\b/m);
    expect(SQL).not.toMatch(/^\s*DELETE FROM returns\b/m);
  });

  it('10. self-validates with a DO $verify$ block', () => {
    expect(SQL).toMatch(/DO \$verify\$[\s\S]+\$verify\$;/);
    // Verify block asserts every artefact this migration is supposed
    // to create.
    // SQL literals double single quotes — the file contains
    // `missing ''cancelled''` which PG parses as `missing 'cancelled'`.
    expect(SQL).toMatch(/return_status enum missing ''cancelled''/);
    expect(SQL).toMatch(/returns\.cancelled_at missing/);
    expect(SQL).toMatch(/returns\.cancelled_by missing/);
    expect(SQL).toMatch(/returns\.cancel_reason missing/);
    expect(SQL).toMatch(/returns\.cancellation_entry_id missing/);
    expect(SQL).toMatch(
      /returns\.cancellation_cashbox_transaction_id missing or wrong type/,
    );
    expect(SQL).toMatch(/return_cancellation_stock_movements table missing/);
    expect(SQL).toMatch(
      /unique\(return_id, stock_movement_id\) constraint missing/,
    );
    expect(SQL).toMatch(/permission returns\.cancel not seeded/);
    expect(SQL).toMatch(/role admin missing returns\.cancel grant/);
  });
});
