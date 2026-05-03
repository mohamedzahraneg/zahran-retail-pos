/**
 * cash-recon-dryrun.spec.ts —
 *   PR-FIN-CASH-RECON-DRYRUN
 *
 * Pin the dry-run script's contract:
 *   1. The script source contains ZERO `INSERT` / `UPDATE` / `DELETE`
 *      / `TRUNCATE` / `DROP` / `ALTER` statements OUTSIDE of string
 *      literals describing PROPOSED steps for the user to review. The
 *      proposed-steps strings are intentional — they're the human-
 *      readable plan for PR-3, NOT statements this script executes.
 *   2. The `runSelect` helper rejects non-SELECT queries (defense-in-
 *      depth — proves the script can never accidentally execute DML
 *      even if the source is later modified).
 *   3. The `buildReport` builder, when fed a recording mock queryFn,
 *      issues queries that all start with SELECT or WITH (CTE).
 *   4. The `renderReport` produces the expected Markdown skeleton for
 *      a known fixture (sections, tables, decisions JSON).
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  buildReport,
  renderReport,
  runSelect,
  CashReconReport,
} from './cash-recon-dryrun';

const SCRIPT_PATH = resolve(__dirname, 'cash-recon-dryrun.ts');

describe('cash-recon-dryrun.ts — script source invariants', () => {
  const src = readFileSync(SCRIPT_PATH, 'utf8');

  it('the runSelect/buildReport implementation never embeds an EXECUTABLE INSERT/UPDATE/DELETE statement', () => {
    // Strip block comments + line comments so we don't trip on
    // explanatory text; then strip string literals so the proposed
    // steps don't trip the check (they're DATA, not code paths).
    const noBlockComments = src.replace(/\/\*[\s\S]*?\*\//g, '');
    const noLineComments = noBlockComments.replace(/(^|[^:])\/\/.*$/gm, '$1');
    const noTemplates = noLineComments.replace(/`[\s\S]*?`/g, '``');
    const noSingles = noTemplates.replace(/'[^'\n]*'/g, "''");
    const noDoubles = noSingles.replace(/"[^"\n]*"/g, '""');
    // Now the remaining text should not contain any DML keyword.
    expect(noDoubles).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(noDoubles).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/i);
    expect(noDoubles).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(noDoubles).not.toMatch(/\bTRUNCATE\b/i);
    expect(noDoubles).not.toMatch(/\bDROP\s+(TABLE|INDEX|SCHEMA)\b/i);
    expect(noDoubles).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it('imports only `pg` Client + node fs/path — no engine, no posting service, no NestJS bootstrap', () => {
    expect(src).toMatch(/from 'pg'/);
    expect(src).not.toMatch(/FinancialEngineService/);
    expect(src).not.toMatch(/PostingService/);
    expect(src).not.toMatch(/NestFactory|@nestjs\/core/);
  });

  it('declares a dedicated runSelect guard that rejects non-SELECT queries', () => {
    expect(src).toMatch(/refusing to run non-SELECT query/);
  });
});

describe('runSelect — guard rejects non-SELECT', () => {
  const dummyQ = jest.fn(async () => []);

  it('accepts SELECT (case-insensitive)', async () => {
    await expect(runSelect(dummyQ, '  select 1')).resolves.toEqual([]);
    await expect(runSelect(dummyQ, 'SELECT * FROM cashboxes')).resolves.toEqual([]);
  });

  it('accepts WITH (CTE that ultimately SELECTs)', async () => {
    await expect(
      runSelect(dummyQ, 'WITH x AS (SELECT 1) SELECT * FROM x'),
    ).resolves.toEqual([]);
  });

  it('rejects INSERT', async () => {
    await expect(
      runSelect(dummyQ, 'INSERT INTO cashboxes (id) VALUES ($1)'),
    ).rejects.toThrow(/refusing to run non-SELECT/);
  });

  it('rejects UPDATE', async () => {
    await expect(
      runSelect(dummyQ, 'UPDATE cashboxes SET name=$1'),
    ).rejects.toThrow(/refusing to run non-SELECT/);
  });

  it('rejects DELETE', async () => {
    await expect(
      runSelect(dummyQ, 'DELETE FROM cashboxes WHERE id=$1'),
    ).rejects.toThrow(/refusing to run non-SELECT/);
  });

  it('rejects TRUNCATE / DROP / ALTER', async () => {
    await expect(runSelect(dummyQ, 'TRUNCATE cashboxes')).rejects.toThrow();
    await expect(runSelect(dummyQ, 'DROP TABLE cashboxes')).rejects.toThrow();
    await expect(runSelect(dummyQ, 'ALTER TABLE cashboxes ADD COLUMN x int')).rejects.toThrow();
  });
});

describe('buildReport — every issued query is SELECT', () => {
  it('records 4 queries (snapshot + 3 evidence selects), all SELECT/WITH', async () => {
    const issued: string[] = [];
    const q = jest.fn(async (sql: string) => {
      issued.push(sql.trimStart());
      // Stub realistic shapes the builder consumes.
      if (/c\.id::text AS cashbox_id/.test(sql)) {
        return [
          {
            cashbox_id: 'cb-x',
            cashbox_name: 'الخزينة الرئيسية',
            current_balance: '34155.00',
            active_ct_sum: '34155.00',
            tagged_gl_1111: '34505.00',
            untagged_gl_1111: '-2095.00',
            global_gl_1111: '32410.00',
          },
        ];
      }
      if (/FROM expenses WHERE id=\$1::uuid/.test(sql)) {
        return [
          {
            expense_no: 'EXP-2026-000003',
            expense_date: '2026-04-21',
            amount: '2000.00',
            cashbox_id: null,
            shift_id: null,
            payment_method: 'cash',
          },
        ];
      }
      if (/FROM cashbox_transactions WHERE id=\$1/.test(sql)) {
        return [
          {
            reference_id: 'b65e0e45',
            amount: '350.00',
            direction: 'out',
            is_void: false,
            notes: 'استرداد نقدي',
          },
        ];
      }
      if (/journal_entries je\s+WHERE je\.reference_id=\$1::uuid/.test(sql)) {
        return [
          {
            entry_no: 'JE-2026-000196',
            description: 'تصحيح اتجاه التسوية رقم 7',
            is_posted: true,
            is_void: false,
          },
        ];
      }
      return [];
    });
    await buildReport(q);
    expect(issued.length).toBeGreaterThanOrEqual(4);
    for (const sql of issued) {
      const upper = sql.toUpperCase();
      const startsCorrectly = upper.startsWith('SELECT') || upper.startsWith('WITH');
      expect(startsCorrectly).toBe(true);
      // No DML keywords anywhere in any issued query.
      expect(upper).not.toMatch(/\bINSERT\s+INTO\b/);
      expect(upper).not.toMatch(/\bUPDATE\s+\w+\s+SET\b/);
      expect(upper).not.toMatch(/\bDELETE\s+FROM\b/);
    }
  });
});

describe('renderReport — Markdown shape', () => {
  // A minimal hand-crafted report that exercises every render branch.
  const report: CashReconReport = {
    generated_at: '2026-05-03T20:30:00.000Z',
    snapshot: {
      cashbox_id: 'cb-x',
      cashbox_name: 'الخزينة الرئيسية',
      current_balance: 34155,
      active_ct_sum: 34155,
      tagged_gl_1111: 34505,
      untagged_gl_1111: -2095,
      global_gl_1111: 32410,
      ct_minus_global_gl: 1745,
    },
    rows: [
      {
        id: 'row-1',
        evidence: {
          row_id: 'row-1',
          reference_no: 'EXP-2026-000003',
          reference_id: 'exp-uuid',
          description: 'سند مصروف غير مرتبط بخزنة',
          amount: 2000,
          current_state: 'cashbox_id=NULL, ct_count=0',
          contribution_to_gap: 2000,
          bucket: 'untagged_gl_no_ct',
        },
        options: [
          {
            label: 'option (a) — link + write CT',
            steps: ['UPDATE expenses SET cashbox_id=...'],
            before_invariant: { current_balance: 34155 },
            after_invariant: { current_balance: 32155 },
            dml_summary: '2× UPDATE + 1× INSERT',
            audit_trail: 'notes prefix',
          },
        ],
      },
    ],
    total_gap_before: 1745,
    decisions_skeleton: { 'row-1': '<choose: a | b>' },
  };

  const md = renderReport(report);

  it('renders the snapshot table with the gap value', () => {
    expect(md).toMatch(/# Cash\/GL reconciliation — DRY RUN \(read-only\)/);
    expect(md).toMatch(/الخزينة الرئيسية/);
    expect(md).toMatch(/\| current_balance \| 34155\.00 \|/);
    expect(md).toMatch(/\| \*\*gap \(operational − global GL\)\*\* \| \*\*1745\.00\*\* \|/);
  });

  it('renders each row with bucket + amount + contribution + state', () => {
    expect(md).toMatch(/## row-1: EXP-2026-000003/);
    expect(md).toMatch(/\*\*Bucket:\*\* `untagged_gl_no_ct`/);
    expect(md).toMatch(/\*\*Amount:\*\* 2000\.00 EGP/);
    expect(md).toMatch(/\*\*Contribution to gap:\*\* 2000\.00 EGP/);
  });

  it('renders each option with steps in SQL fences + before/after table', () => {
    expect(md).toMatch(/### option \(a\) — link \+ write CT/);
    expect(md).toMatch(/```sql/);
    expect(md).toMatch(/UPDATE expenses SET cashbox_id=\.\.\./);
    expect(md).toMatch(/\| current_balance \| 34155\.00 \| 32155\.00 \|/);
  });

  it('emits the decisions JSON skeleton block + safety footer', () => {
    expect(md).toMatch(/## Decisions skeleton/);
    expect(md).toMatch(/"row-1": "<choose: a \| b>"/);
    expect(md).toMatch(/### Safety/);
    expect(md).toMatch(/This script issued only SELECT queries/);
    expect(md).toMatch(/No DML was executed/);
  });
});
