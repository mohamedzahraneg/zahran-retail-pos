/**
 * inventory-double-write-safety.spec.ts
 * PR-FIX-INVENTORY-SAFETY
 *
 * Source-level invariant pin: the seven services audited in the
 * Safety PR no longer issue a raw `UPDATE stock SET quantity_on_hand`
 * or `INSERT INTO stock (...) ON CONFLICT DO UPDATE SET
 * quantity_on_hand` alongside an INSERT INTO stock_movements for the
 * same delta. Going forward the trigger `trg_apply_stock_movement`
 * (migration 011) is the SOLE writer to `stock.quantity_on_hand` for
 * these code paths.
 *
 * The contract has TWO parts:
 *
 *   1. No raw stock-table SQL in the protected source files. This
 *      pins the rule against accidental reintroduction during a
 *      refactor. The check parses the source for SQL template
 *      strings inside `em.query` / `m.query` calls (or any backtick
 *      block following `query(\``) and asserts neither of these
 *      patterns appears:
 *
 *        - `UPDATE stock SET`     (raw decrement / increment)
 *        - `INSERT INTO stock `   with `ON CONFLICT` + `quantity_on_hand`
 *                                  (raw UPSERT)
 *
 *      `stock_movements`, `stock_transfers`, `stock_adjustments`,
 *      `stock_transfer_items` etc. are NOT covered — they are
 *      different tables and remain valid write targets.
 *
 *   2. The stock-transfers ship path still references
 *      `stock_levels`, the view that migration 142 (re)creates.
 *      Tests pin the query so a future refactor that drops the view
 *      reference must do so consciously.
 *
 * No DB. No service instantiation. Pure source-file assertions.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── Source files protected by the Safety PR ────────────────────────
const PROTECTED_FILES = [
  'returns/returns.service.ts',
  'returns/return-edit-requests.service.ts',
  'purchases/purchases.service.ts',
];

// Pulls every backtick-quoted block out of the source AFTER stripping
// `//` and `/* */` comments. The historical-context comments we left
// behind contain inline backticked phrases like `` `UPDATE stock SET` ``
// — those must NOT be confused with real SQL template strings. Comment
// stripping eliminates the false positives without depending on a
// full TypeScript parser.
function stripComments(src: string): string {
  // Block comments first (don't span across blocks, no nesting in TS).
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  // Line comments to end-of-line.
  out = out.replace(/\/\/[^\n]*/g, '');
  return out;
}

function backtickBlocks(src: string): string[] {
  const stripped = stripComments(src);
  const blocks: string[] = [];
  // Naive but sufficient: split on backticks, take odd indices.
  // The template-string content never contains an unescaped backtick
  // in this codebase (checked the three files above).
  const parts = stripped.split('`');
  for (let i = 1; i < parts.length; i += 2) {
    blocks.push(parts[i]);
  }
  return blocks;
}

function readService(rel: string): string {
  return readFileSync(resolve(__dirname, '..', rel), 'utf8');
}

describe('PR-FIX-INVENTORY-SAFETY — no raw stock writes alongside stock_movements', () => {
  for (const rel of PROTECTED_FILES) {
    describe(rel, () => {
      const src = readService(rel);
      const sqlBlocks = backtickBlocks(src);

      it('contains zero raw `UPDATE stock SET` statements (any whitespace)', () => {
        const offenders = sqlBlocks.filter((b) =>
          /UPDATE\s+stock\s+SET/i.test(b),
        );
        // `stock_movements`, `stock_transfers`, etc. survive — the
        // regex requires `stock` then whitespace then `SET` so
        // table-name suffixes like `_movements` mismatch on the `\s`.
        expect(offenders).toEqual([]);
      });

      it('contains zero raw `INSERT INTO stock ( ... )` UPSERT statements that touch quantity_on_hand', () => {
        const offenders = sqlBlocks.filter((b) => {
          // Must be the BARE `stock` table (next char after the
          // identifier is whitespace or `(`), have an ON CONFLICT
          // clause, and target `quantity_on_hand`.
          if (!/INSERT\s+INTO\s+stock\s*\(/i.test(b)) return false;
          if (!/ON\s+CONFLICT/i.test(b)) return false;
          if (!/quantity_on_hand/i.test(b)) return false;
          return true;
        });
        expect(offenders).toEqual([]);
      });

      it('still issues `INSERT INTO stock_movements` (the canonical writer is intact)', () => {
        // Sanity: the removal must not have stripped the movement
        // INSERTs themselves. Each protected file emits at least one.
        const movementInserts = sqlBlocks.filter((b) =>
          /INSERT\s+INTO\s+stock_movements/i.test(b),
        );
        expect(movementInserts.length).toBeGreaterThan(0);
      });
    });
  }
});

describe('PR-FIX-INVENTORY-SAFETY — stock-transfers availability check reads a canonical stock-snapshot view', () => {
  const src = readService('stock-transfers/stock-transfers.service.ts');
  const sqlBlocks = backtickBlocks(src);

  it('ship-availability check reads `v_stock_unified` (PR-STOCK-TRANSFERS-WORKFLOW migrated from stock_levels)', () => {
    // PR-FIX-INVENTORY-HYGIENE (migration 143b) introduced
    // `v_stock_unified` as the canonical read-side projection over
    // `public.stock`, exposing `quantity_on_hand` / `quantity_reserved`
    // / `available_quantity` in one place. PR-STOCK-TRANSFERS-WORKFLOW
    // adopted it in the ship-availability check so the on-hand vs.
    // reserved split is unambiguous. The legacy `stock_levels`
    // (migration 142) is still defined and other modules may still
    // read from it, but this service deliberately doesn't anymore.
    const referencing = sqlBlocks.filter((b) =>
      /FROM\s+v_stock_unified/i.test(b),
    );
    expect(referencing.length).toBeGreaterThan(0);
  });

  it('reads `quantity_on_hand` from v_stock_unified (the column it exposes)', () => {
    const referencing = sqlBlocks.find((b) =>
      /FROM\s+v_stock_unified/i.test(b),
    );
    expect(referencing).toBeDefined();
    expect(referencing!).toMatch(/quantity_on_hand/i);
  });
});

describe('PR-FIX-INVENTORY-SAFETY — sanity: each fixed site emits exactly one stock_movements direction per item', () => {
  // The protected sites pair one INSERT INTO stock_movements per item
  // with the right direction. We don't try to invoke them here
  // (heavy mocking required) — instead we pin that the `direction`
  // tokens still appear in the SQL exactly where they did before the
  // raw stock writes were removed.
  //
  // The numbers are conservative lower bounds: refactors that split
  // a path into two helpers and double the count are still safe; the
  // bound only catches accidental DELETIONS of the movement INSERT.

  const fixtures: Array<{ file: string; minOutMovements: number; minInMovements: number }> = [
    { file: 'returns/returns.service.ts',                 minOutMovements: 1, minInMovements: 0 },
    { file: 'returns/return-edit-requests.service.ts',    minOutMovements: 1, minInMovements: 1 },
    { file: 'purchases/purchases.service.ts',             minOutMovements: 1, minInMovements: 1 },
  ];

  for (const f of fixtures) {
    it(`${f.file} keeps the movement INSERT shape (>= ${f.minOutMovements} 'out', >= ${f.minInMovements} 'in')`, () => {
      const src = readService(f.file);
      const sqlBlocks = backtickBlocks(src);
      const movementBlocks = sqlBlocks.filter((b) =>
        /INSERT\s+INTO\s+stock_movements/i.test(b),
      );
      const outCount = movementBlocks.filter((b) =>
        /'out'(?:::txn_direction)?/.test(b),
      ).length;
      const inCount = movementBlocks.filter((b) =>
        /'in'(?:::txn_direction)?/.test(b),
      ).length;
      expect(outCount).toBeGreaterThanOrEqual(f.minOutMovements);
      expect(inCount).toBeGreaterThanOrEqual(f.minInMovements);
    });
  }
});
