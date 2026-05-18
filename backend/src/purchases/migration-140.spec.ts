/**
 * migration-140.spec.ts — PR-PURCHASES-P2.3C-FIX
 *
 * Static guardrail for migration 140 (fn_void_purchase hotfix). Pins:
 *   · CREATE OR REPLACE FUNCTION (not a new function name)
 *   · forbidden pattern `sp.purchase_id` is gone
 *   · payment ↔ purchase link uses supplier_payment_allocations.purchase_id
 *   · cash reversal uses spa.allocated_amount (not sp.amount)
 *   · voided payments are filtered out via COALESCE(sp.is_void, FALSE) = FALSE
 *   · no destructive DDL / new tables / new columns / triggers
 *   · only fn_void_purchase is touched
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const RAW = readFileSync(
  join(
    __dirname,
    '..',
    '..',
    '..',
    'database',
    'migrations',
    '140_fn_void_purchase_fix.sql',
  ),
  'utf8',
);

const SQL = RAW.split('\n')
  .filter((l) => !/^\s*--/.test(l))
  .join('\n');

describe('migration 140 — fn_void_purchase hotfix', () => {
  it('uses CREATE OR REPLACE FUNCTION on fn_void_purchase with the original signature', () => {
    expect(SQL).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_void_purchase\s*\(\s*p_purchase_id\s+uuid\s*,\s*p_user_id\s+uuid\s*,\s*p_reason\s+text\s*\)/i,
    );
  });

  it('does NOT reference the invalid sp.purchase_id', () => {
    expect(SQL).not.toMatch(/\bsp\.purchase_id\b/);
  });

  it('reverses cash via the supplier_payment_allocations join (spa.purchase_id)', () => {
    // Join shape must include both tables and key by spa.purchase_id.
    expect(SQL).toMatch(/FROM\s+supplier_payment_allocations\s+spa/i);
    expect(SQL).toMatch(/JOIN\s+supplier_payments\s+sp\s+ON\s+sp\.id\s*=\s*spa\.payment_id/i);
    expect(SQL).toMatch(/WHERE\s+spa\.purchase_id\s*=\s*p_purchase_id/i);
  });

  it('reverses by spa.allocated_amount (not the full sp.amount) for multi-allocation correctness', () => {
    expect(SQL).toMatch(/spa\.allocated_amount\s+AS\s+amount/i);
  });

  it('skips voided supplier_payments via COALESCE(sp.is_void, FALSE)=FALSE', () => {
    expect(SQL).toMatch(/COALESCE\(\s*sp\.is_void\s*,\s*FALSE\s*\)\s*=\s*FALSE/i);
  });

  it('still reverses stock and still marks purchase cancelled (legs unchanged from 033)', () => {
    expect(SQL).toMatch(/INSERT\s+INTO\s+stock_movements/i);
    expect(SQL).toMatch(/UPDATE\s+purchases\s+SET\s+status\s*=\s*'cancelled'/i);
  });

  it('still uses fn_record_cashbox_txn for the cashbox reversal primitive', () => {
    expect(SQL).toMatch(/fn_record_cashbox_txn/);
  });

  it('is non-destructive — no DDL on tables / columns / constraints / indexes / triggers', () => {
    expect(SQL).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX|FUNCTION)\b/i);
    expect(SQL).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(SQL).not.toMatch(/\bTRUNCATE\b/i);
    expect(SQL).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(SQL).not.toMatch(/\bCREATE\s+TABLE\b/i);
    expect(SQL).not.toMatch(/\bCREATE\s+(TRIGGER|INDEX|TYPE)\b/i);
  });

  it('only touches fn_void_purchase (no other CREATE/REPLACE FUNCTION)', () => {
    const creates = SQL.match(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([A-Za-z_.]+)/gi) || [];
    expect(creates).toHaveLength(1);
    expect(creates[0]).toMatch(/fn_void_purchase/);
  });

  it('does not reference POS / sales-returns / pricing / provisioning tables', () => {
    expect(SQL).not.toMatch(/\bpos_/i);
    expect(SQL).not.toMatch(/\binvoice_items\b|\binvoices\b/i);
    // `RETURNS void` is part of the function signature; scan only for
    // SQL statements that touch the sales-returns table.
    expect(SQL).not.toMatch(/FROM\s+returns\b/i);
    expect(SQL).not.toMatch(/INTO\s+returns\b/i);
    expect(SQL).not.toMatch(/\bprice_lists\b/i);
    expect(SQL).not.toMatch(/\bprovisioning\b/i);
  });
});
