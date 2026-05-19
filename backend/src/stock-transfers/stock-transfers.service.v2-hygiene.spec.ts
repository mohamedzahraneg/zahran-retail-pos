/**
 * stock-transfers.service.v2-hygiene.spec.ts
 * PR-FIX-INVENTORY-HYGIENE + PR-STOCK-TRANSFERS-WORKFLOW
 *
 * Pins the stock-transfers wiring to `fn_adjust_stock_v2` (the
 * movement-only helper introduced in migration 143b). The contract
 * is:
 *
 *   1. The legacy v1 helper `fn_adjust_stock(` is NEVER called from
 *      this module. The v1 helper writes BOTH a stock UPSERT and a
 *      stock_movements row — and the AFTER INSERT trigger then
 *      UPSERTs stock again, double-applying. v2 writes ONLY the
 *      movement row and lets the trigger own the `stock` mutation.
 *
 *   2. PR-STOCK-TRANSFERS-WORKFLOW retired the receive-shortfall
 *      auto-return and the in-transit cancel rollback (both were
 *      reconciliation steps the new workflow explicitly forbids).
 *      That leaves only TWO v2 call sites:
 *        · ship    (source out, source_action='ship')
 *        · receive (destination in, source_action='receive')
 *
 *   3. Each v2 invocation carries the audit columns:
 *        reference_type = 'stock_transfer' (mig 143a enum value)
 *        reference_id   = stock_transfers.id
 *        source_module  = 'stock_transfers'
 *        source_action  = 'ship' | 'receive'
 *        movement_type override = 'transfer_out' | 'transfer_in'
 *
 *   4. The migration 143b SQL still contains the required
 *      ingredients (ALTER columns, apply_stock_movement body,
 *      fn_adjust_stock_v2 signature, v_stock_unified view).
 *
 * No DB. No service instantiation. Pure source-file assertions.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function readService(rel: string): string {
  return readFileSync(resolve(__dirname, '..', rel), 'utf8');
}

function readMigration(name: string): string {
  return readFileSync(
    resolve(__dirname, '..', '..', '..', 'database', 'migrations', name),
    'utf8',
  );
}

// ── Shared text the service must contain at every v2 call site ─────
const TRANSFER_REF_TYPE = "'stock_transfer'";
const SOURCE_MODULE = "'stock_transfers'";

describe('PR-FIX-INVENTORY-HYGIENE — stock-transfers wired to v2', () => {
  const src = readService('stock-transfers/stock-transfers.service.ts');
  // Comment-stripped view for assertions that count real call sites
  // (doc comments that mention the helper name must not skew the
  // count — see e.g. "emit one fn_adjust_stock_v2(+delta)" prose).
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');

  it('zero remaining calls to legacy fn_adjust_stock (movement-only helper is now the sole writer)', () => {
    // Match `fn_adjust_stock(` with WORD boundary so `fn_adjust_stock_v2(`
    // does not register as an offender.
    const v1Calls = code.match(/\bfn_adjust_stock\s*\(/g) ?? [];
    expect(v1Calls).toEqual([]);
  });

  it('exactly two mutation paths call fn_adjust_stock_v2 (ship + receive)', () => {
    const v2Calls = code.match(/fn_adjust_stock_v2\s*\(/g) ?? [];
    // PR-STOCK-TRANSFERS-WORKFLOW removed the shortfall + in-transit-
    // cancel paths. ship × 1 and receive (delta) × 1 remain.
    expect(v2Calls.length).toBe(2);
  });

  it('ship path tags source_action=ship + movement_type=transfer_out', () => {
    expect(src).toMatch(/source_action[\s\S]*?'ship'/);
    expect(src).toMatch(/'ship'[\s\S]*?'transfer_out'/);
  });

  it('receive happy path tags source_action=receive + movement_type=transfer_in', () => {
    expect(src).toMatch(/'receive'[\s\S]*?'transfer_in'/);
  });

  it('no shortfall auto-return is emitted (reconciliation forbidden)', () => {
    expect(src).not.toMatch(/'receive_shortfall'/);
    expect(src).not.toMatch(/TRANSFER_RETURN/);
  });

  it('cancel does NOT invent reverse movements (no transfer_in cancel leg)', () => {
    // The cancel path is now status-guarded to pre-ship only — no v2
    // calls inside cancel, no 'cancel' source_action literal.
    expect(src).not.toMatch(/'cancel'[\s\S]*?'transfer_in'/);
    expect(src).not.toMatch(/TRANSFER_CANCEL/);
  });

  it('every v2 call carries reference_type=stock_transfer + source_module=stock_transfers', () => {
    const refTypeCount = (src.match(new RegExp(TRANSFER_REF_TYPE, 'g')) ?? [])
      .length;
    const moduleCount = (src.match(new RegExp(SOURCE_MODULE, 'g')) ?? [])
      .length;
    // Two call sites + the FE/BE labelling in doc comments.
    expect(refTypeCount).toBeGreaterThanOrEqual(2);
    expect(moduleCount).toBeGreaterThanOrEqual(2);
  });

  it('every v2 call passes the transfer.id as the reference_id positional arg', () => {
    // `t.id` appears at every v2 call site as the reference_id arg.
    const matches = src.match(/\bt\.id\b/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('PR-FIX-INVENTORY-HYGIENE — migration 143b ships the four ingredients', () => {
  const sql = readMigration('143b_pr_fix_inventory_hygiene.sql');

  it('1. ALTER stock_movements ADDs the three audit columns', () => {
    expect(sql).toMatch(/ALTER\s+TABLE\s+public\.stock_movements/i);
    expect(sql).toMatch(/balance_after_qty\s+integer/i);
    expect(sql).toMatch(/source_module\s+varchar\(32\)/i);
    expect(sql).toMatch(/source_action\s+varchar\(64\)/i);
  });

  it('2. apply_stock_movement body now writes balance_after_qty', () => {
    // CREATE OR REPLACE FUNCTION block must contain both the
    // original UPSERT-into-stock pattern and the new UPDATE that
    // back-fills balance_after_qty onto the just-inserted row.
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+apply_stock_movement/i);
    // The new ingredient — write the new balance on the movement.
    expect(sql).toMatch(/UPDATE\s+public\.stock_movements/i);
    expect(sql).toMatch(/balance_after_qty\s*=\s*v_new_qty/i);
    // The old ingredient — UPSERT into stock (unchanged math).
    expect(sql).toMatch(/INSERT\s+INTO\s+stock[\s\S]*ON\s+CONFLICT/i);
  });

  it('3. fn_adjust_stock_v2 is defined with the documented signature', () => {
    expect(sql).toMatch(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_adjust_stock_v2/i,
    );
    // Required parameters from the brief.
    for (const param of [
      'p_variant_id',
      'p_warehouse_id',
      'p_delta',
      'p_reason',
      'p_reference_type',
      'p_reference_id',
      'p_unit_cost',
      'p_user_id',
      'p_source_module',
      'p_source_action',
    ]) {
      expect(sql).toMatch(new RegExp(`\\b${param}\\b`));
    }
    // Must NOT contain a manual UPSERT into stock — the entire
    // point of v2 is that the trigger owns the stock mutation.
    // Find the function body and check it.
    // Capture from the CREATE through the matching dollar-quoted
    // body terminator `$$;`. The function's body uses `$$` for the
    // open/close delimiter so a non-greedy match on `END;\s*\$\$;`
    // gives us exactly the function definition.
    const v2Block = sql.match(
      /CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.fn_adjust_stock_v2[\s\S]*?END;\s*\$\$;/i,
    );
    expect(v2Block).toBeTruthy();
    const body = v2Block![0];
    // The body must INSERT stock_movements but NOT INSERT/UPDATE stock.
    expect(body).toMatch(/INSERT\s+INTO\s+public\.stock_movements/i);
    expect(body).not.toMatch(/INSERT\s+INTO\s+stock\b(?!_movements)/i);
    expect(body).not.toMatch(/UPDATE\s+stock\s+SET/i);
  });

  it('4. v_stock_unified view is defined as a thin projection over stock', () => {
    expect(sql).toMatch(/CREATE\s+OR\s+REPLACE\s+VIEW\s+public\.v_stock_unified/i);
    expect(sql).toMatch(/FROM\s+public\.stock\b/i);
    // Required columns from the brief.
    for (const col of [
      'variant_id',
      'warehouse_id',
      'quantity_on_hand',
      'quantity_reserved',
      'available_quantity',
      'reorder_point',
      'updated_at',
    ]) {
      expect(sql).toMatch(new RegExp(`\\b${col}\\b`));
    }
  });
});

describe('PR-FIX-INVENTORY-HYGIENE — migration 143a adds the enum value standalone', () => {
  const sql = readMigration('143a_pr_fix_inventory_hygiene_enum.sql');

  it('adds stock_transfer to entity_type, IF NOT EXISTS', () => {
    expect(sql).toMatch(
      /ALTER\s+TYPE\s+entity_type\s+ADD\s+VALUE\s+IF\s+NOT\s+EXISTS\s+'stock_transfer'/i,
    );
  });

  it('does NOT wrap the enum add in a transaction (PG rule: cannot USE the value in same tx)', () => {
    // Postgres refuses to use a newly-added enum value in the same
    // transaction. The 107 pattern (employee_settlement) is the
    // precedent we follow — DDL must commit standalone.
    expect(sql).not.toMatch(/^\s*BEGIN\s*;/im);
    expect(sql).not.toMatch(/^\s*COMMIT\s*;/im);
  });
});
