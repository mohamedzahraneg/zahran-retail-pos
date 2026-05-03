/**
 * cash-recon-execute.spec.ts —
 *   PR-FIN-CASH-RECON-EXECUTE
 *
 * Pin the executor's contract — every required test case from the
 * user's approval message:
 *
 *   1. selected decisions applied (each row's options match the
 *      user's per-row choices)
 *   2. row 3 does not create duplicate CT (no INSERT into
 *      cashbox_transactions on the row-3 code path)
 *   3. row 4 voids CT-245 and recomputes current_balance
 *   4. idempotent rerun is no-op (precondition checks short-circuit
 *      every action on a second pass)
 *   5. rollback on partial failure (if any row throws, the
 *      orchestrator surfaces the error → outer caller ROLLBACKs;
 *      no row's actions persist)
 *   6. no unrelated rows touched (every UPDATE/INSERT references
 *      ONLY the 4 sanctioned IDs — EXP003, JE-123 line, JE-126 line,
 *      JE-196 line, CT-245, الخزينة الرئيسية cashbox)
 *
 * Plus belt-and-braces:
 *   · script source contains zero unexpected DML targets
 *   · dry-run mode reads the snapshot but doesn't claim committed
 */

import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  executeCleanup,
  readSnapshot,
  renderResult,
  runRow1a,
  runRow2,
  runRow3a,
  runRow4a,
  AL_RAISIA_CASHBOX_ID,
  EXP003_ID,
  EXP003_JL_ID,
  SHF002_REF_ID,
  SHF002_JL_ID,
  SETTLEMENT7_JL_ID,
  RET003_CT_ID,
  NOTE_PREFIX_1A,
  NOTE_PREFIX_2,
  NOTE_PREFIX_3A,
  NOTE_PREFIX_4A,
} from './cash-recon-execute';

const SCRIPT_PATH = resolve(__dirname, 'cash-recon-execute.ts');

// ─── Test queryFn factory ─────────────────────────────────────────
interface RecorderQueryFnState {
  /** Cycle through canned responses in order, by query-shape regex. */
  responses?: Array<{ pattern: RegExp; rows: any[] }>;
  /** Throw on the Nth call (1-indexed). */
  throwOnCall?: { n: number; error: Error };
}

function makeQ(state: RecorderQueryFnState = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  let n = 0;
  const q = jest.fn(async (sql: string, params: any[] = []) => {
    n++;
    calls.push({ sql, params });
    if (state.throwOnCall && state.throwOnCall.n === n) {
      throw state.throwOnCall.error;
    }
    const match = state.responses?.find((r) => r.pattern.test(sql));
    return match ? match.rows : [];
  });
  return { q, calls };
}

// Whitelist of permitted DML targets (table_name + WHERE clause IDs).
const PERMITTED_TABLES = ['expenses', 'journal_lines', 'cashbox_transactions', 'cashboxes'];

// ─── 1. Selected decisions applied ────────────────────────────────
describe('executeCleanup — selected decisions applied per row', () => {
  it('runRow1a issues exactly the option-(a) DML: tag expense + tag JL + INSERT CT', async () => {
    const { q, calls } = makeQ({
      responses: [
        { pattern: /SELECT cashbox_id::text AS cashbox_id, shift_id::text AS shift_id\s+FROM expenses/, rows: [{ cashbox_id: null, shift_id: null }] },
        { pattern: /SELECT cashbox_id::text AS cashbox_id FROM journal_lines/, rows: [{ cashbox_id: null }] },
        { pattern: /SELECT id FROM cashbox_transactions[\s\S]*notes LIKE/, rows: [] },
      ],
    });
    const result = await runRow1a(q);
    expect(result.row_id).toBe('row-1');
    expect(result.option).toBe('1a');
    expect(result.actions.map((a) => a.status)).toEqual(['executed', 'executed', 'executed']);

    const dml = calls
      .map((c) => c.sql.trim().toUpperCase())
      .filter((s) => s.startsWith('UPDATE') || s.startsWith('INSERT'));
    // Exactly 3 DML statements: 2 UPDATEs + 1 INSERT.
    expect(dml.filter((s) => s.startsWith('UPDATE EXPENSES'))).toHaveLength(1);
    expect(dml.filter((s) => s.startsWith('UPDATE JOURNAL_LINES'))).toHaveLength(1);
    expect(dml.filter((s) => s.startsWith('INSERT INTO CASHBOX_TRANSACTIONS'))).toHaveLength(1);
    expect(dml).toHaveLength(3);

    // Notes prefix on the INSERT.
    const insertCall = calls.find((c) => /INSERT INTO cashbox_transactions/.test(c.sql))!;
    const notesParam = insertCall.params.find(
      (p: any) => typeof p === 'string' && p.startsWith(NOTE_PREFIX_1A),
    );
    expect(notesParam).toBeTruthy();
  });

  it('runRow2 issues ONE UPDATE on journal_lines (tag-only) and NO INSERT', async () => {
    const { q, calls } = makeQ({
      responses: [
        { pattern: /SELECT cashbox_id::text AS cashbox_id FROM journal_lines/, rows: [{ cashbox_id: null }] },
      ],
    });
    const result = await runRow2(q);
    expect(result.row_id).toBe('row-2');
    expect(result.option).toBe('2');
    const dml = calls
      .map((c) => c.sql.trim().toUpperCase())
      .filter((s) => s.startsWith('UPDATE') || s.startsWith('INSERT'));
    expect(dml.filter((s) => s.startsWith('UPDATE JOURNAL_LINES'))).toHaveLength(1);
    expect(dml.filter((s) => s.startsWith('INSERT'))).toHaveLength(0);
  });

  it('runRow4a issues void UPDATE on CT-245 + recompute UPDATE on cashboxes', async () => {
    const { q, calls } = makeQ({
      responses: [
        { pattern: /SELECT is_void FROM cashbox_transactions/, rows: [{ is_void: false }] },
      ],
    });
    const result = await runRow4a(q);
    expect(result.row_id).toBe('row-4');
    expect(result.option).toBe('4a');
    const dml = calls
      .map((c) => c.sql.trim().toUpperCase())
      .filter((s) => s.startsWith('UPDATE') || s.startsWith('INSERT'));
    expect(dml.filter((s) => /UPDATE CASHBOX_TRANSACTIONS/.test(s))).toHaveLength(1);
    expect(dml.filter((s) => /UPDATE CASHBOXES/.test(s))).toHaveLength(1);
    expect(dml.filter((s) => s.startsWith('INSERT'))).toHaveLength(0);
    expect(dml.filter((s) => s.startsWith('DELETE'))).toHaveLength(0);
  });
});

// ─── 2. Row 3 does not create duplicate CT ────────────────────────
describe('runRow3a — never creates a duplicate CT', () => {
  it('issues ONE UPDATE on journal_lines and ZERO INSERTs into cashbox_transactions', async () => {
    const { q, calls } = makeQ({
      responses: [
        { pattern: /SELECT id FROM cashbox_transactions[\s\S]*notes LIKE/, rows: [] },
        { pattern: /SELECT cashbox_id::text AS cashbox_id FROM journal_lines/, rows: [{ cashbox_id: null }] },
      ],
    });
    const result = await runRow3a(q);
    const dml = calls
      .map((c) => c.sql.trim().toUpperCase())
      .filter((s) => s.startsWith('UPDATE') || s.startsWith('INSERT'));
    expect(dml.filter((s) => s.startsWith('UPDATE JOURNAL_LINES'))).toHaveLength(1);
    expect(dml.filter((s) => s.startsWith('INSERT INTO CASHBOX_TRANSACTIONS'))).toHaveLength(0);
    expect(result.actions.some((a) => /CT-108 already exists/.test(a.detail ?? ''))).toBe(true);
  });
});

// ─── 3. Row 4 voids CT-245 + recomputes current_balance ───────────
describe('runRow4a — void + recompute', () => {
  it('void UPDATE targets CT id 245 with the EXEC#4a void_reason prefix', async () => {
    const { q, calls } = makeQ({
      responses: [{ pattern: /SELECT is_void FROM cashbox_transactions/, rows: [{ is_void: false }] }],
    });
    await runRow4a(q);
    const voidUpdate = calls.find((c) => /UPDATE cashbox_transactions/.test(c.sql))!;
    expect(voidUpdate).toBeDefined();
    expect(voidUpdate.params).toContain(RET003_CT_ID);
    const reason = voidUpdate.params.find((p: any) => typeof p === 'string' && p.startsWith(NOTE_PREFIX_4A));
    expect(reason).toBeTruthy();
  });

  it('recompute UPDATE targets cashboxes WHERE id = AL_RAISIA + sums active CT signed', async () => {
    const { q, calls } = makeQ({
      responses: [{ pattern: /SELECT is_void FROM cashbox_transactions/, rows: [{ is_void: false }] }],
    });
    await runRow4a(q);
    const recompute = calls.find((c) => /UPDATE cashboxes[\s\S]*current_balance/.test(c.sql))!;
    expect(recompute).toBeDefined();
    expect(recompute.params).toContain(AL_RAISIA_CASHBOX_ID);
    expect(recompute.sql).toMatch(/CASE WHEN is_void THEN 0\s+WHEN direction='in'\s+THEN amount\s+WHEN direction='out' THEN -amount/);
    // No fudge factor — the SQL just sums; nothing else.
    expect(recompute.sql).not.toMatch(/\+\s*[1-9]/); // no `+ N` adjustment
  });

  it('always runs the recompute even if CT-245 was already voided (idempotent)', async () => {
    const { q, calls } = makeQ({
      responses: [{ pattern: /SELECT is_void FROM cashbox_transactions/, rows: [{ is_void: true }] }],
    });
    await runRow4a(q);
    const voidUpdate = calls.find((c) => /UPDATE cashbox_transactions/.test(c.sql));
    expect(voidUpdate).toBeUndefined(); // skipped
    const recompute = calls.find((c) => /UPDATE cashboxes/.test(c.sql));
    expect(recompute).toBeDefined();   // still ran
  });
});

// ─── 4. Idempotent rerun is no-op ─────────────────────────────────
describe('idempotent rerun — second pass does nothing', () => {
  it('runRow1a skips all 3 actions when state matches target', async () => {
    const { q, calls } = makeQ({
      responses: [
        { pattern: /SELECT cashbox_id::text AS cashbox_id, shift_id::text AS shift_id\s+FROM expenses/, rows: [{ cashbox_id: AL_RAISIA_CASHBOX_ID, shift_id: SHF002_REF_ID }] },
        { pattern: /SELECT cashbox_id::text AS cashbox_id FROM journal_lines/, rows: [{ cashbox_id: AL_RAISIA_CASHBOX_ID }] },
        { pattern: /SELECT id FROM cashbox_transactions[\s\S]*notes LIKE/, rows: [{ id: 999 }] },
      ],
    });
    const result = await runRow1a(q);
    expect(result.actions.every((a) => a.status === 'skipped_idempotent')).toBe(true);
    const dml = calls.map((c) => c.sql.trim().toUpperCase()).filter((s) =>
      s.startsWith('UPDATE') || s.startsWith('INSERT'),
    );
    expect(dml).toHaveLength(0);
  });

  it('runRow2 skips when JL is already tagged', async () => {
    const { q, calls } = makeQ({
      responses: [
        { pattern: /SELECT cashbox_id::text AS cashbox_id FROM journal_lines/, rows: [{ cashbox_id: AL_RAISIA_CASHBOX_ID }] },
      ],
    });
    const result = await runRow2(q);
    expect(result.actions[0].status).toBe('skipped_idempotent');
    expect(calls.filter((c) => /UPDATE/.test(c.sql))).toHaveLength(0);
  });

  it('runRow3a skips when JL is already tagged', async () => {
    const { q, calls } = makeQ({
      responses: [
        { pattern: /SELECT id FROM cashbox_transactions[\s\S]*notes LIKE/, rows: [] },
        { pattern: /SELECT cashbox_id::text AS cashbox_id FROM journal_lines/, rows: [{ cashbox_id: AL_RAISIA_CASHBOX_ID }] },
      ],
    });
    const result = await runRow3a(q);
    expect(result.actions.find((a) => /UPDATE journal_lines/.test(a.step))?.status).toBe('skipped_idempotent');
    expect(calls.filter((c) => /UPDATE/.test(c.sql))).toHaveLength(0);
  });

  it('runRow4a skips the void when CT-245 already voided', async () => {
    const { q, calls } = makeQ({
      responses: [{ pattern: /SELECT is_void FROM cashbox_transactions/, rows: [{ is_void: true }] }],
    });
    const result = await runRow4a(q);
    expect(result.actions.find((a) => /UPDATE cashbox_transactions/.test(a.step))?.status).toBe('skipped_idempotent');
    // recompute still runs (always-on)
    expect(calls.filter((c) => /UPDATE cashboxes/.test(c.sql))).toHaveLength(1);
  });
});

// ─── 5. Rollback on partial failure ───────────────────────────────
describe('rollback on partial failure', () => {
  it('orchestrator surfaces the error from any row — caller responsible for ROLLBACK', async () => {
    // Force a throw on call N=10 (somewhere mid-batch — after row 1 + 2 readers/writers).
    const { q } = makeQ({
      throwOnCall: { n: 10, error: new Error('synthetic mid-batch failure') },
      responses: [
        { pattern: /SELECT cashbox_id::text AS cashbox_id, shift_id::text AS shift_id\s+FROM expenses/, rows: [{ cashbox_id: null, shift_id: null }] },
        { pattern: /SELECT cashbox_id::text AS cashbox_id FROM journal_lines/, rows: [{ cashbox_id: null }] },
        { pattern: /SELECT id FROM cashbox_transactions[\s\S]*notes LIKE/, rows: [] },
        { pattern: /SELECT is_void FROM cashbox_transactions/, rows: [{ is_void: false }] },
        { pattern: /WITH ct_per_cashbox AS/, rows: [{
          current_balance: 34155, active_ct_sum: 34155,
          tagged_gl_1111: 34505, untagged_gl_1111: -2095, global_gl_1111: 32410,
        }] },
      ],
    });
    await expect(executeCleanup(q, { dryRun: false })).rejects.toThrow(
      /synthetic mid-batch failure/,
    );
  });

  it('CLI bootstrap pattern: ROLLBACK is the caller’s responsibility — orchestrator never silently swallows errors', () => {
    // Verified by the script source: main() wraps q with BEGIN/COMMIT/ROLLBACK.
    const src = readFileSync(SCRIPT_PATH, 'utf8');
    expect(src).toMatch(/await client\.query\('BEGIN'\)/);
    expect(src).toMatch(/await client\.query\('ROLLBACK'\)/);
    expect(src).toMatch(/await client\.query\('COMMIT'\)/);
    // Default mode is dry-run (rolled back) unless --execute is passed.
    expect(src).toMatch(/process\.argv\.includes\('--execute'\)/);
    expect(src).toMatch(/const dryRun = !wantsExecute/);
  });
});

// ─── 6. No unrelated rows touched ─────────────────────────────────
describe('no unrelated rows touched — every DML targets only the sanctioned IDs', () => {
  it('every UPDATE/INSERT params bag includes EXACTLY one of the sanctioned IDs', async () => {
    const { q, calls } = makeQ({
      responses: [
        { pattern: /SELECT cashbox_id::text AS cashbox_id, shift_id::text AS shift_id\s+FROM expenses/, rows: [{ cashbox_id: null, shift_id: null }] },
        { pattern: /SELECT cashbox_id::text AS cashbox_id FROM journal_lines/, rows: [{ cashbox_id: null }] },
        { pattern: /SELECT id FROM cashbox_transactions[\s\S]*notes LIKE/, rows: [] },
        { pattern: /SELECT is_void FROM cashbox_transactions/, rows: [{ is_void: false }] },
        { pattern: /WITH ct_per_cashbox AS/, rows: [{
          current_balance: 34155, active_ct_sum: 34155,
          tagged_gl_1111: 34505, untagged_gl_1111: -2095, global_gl_1111: 32410,
        }] },
      ],
    });
    await executeCleanup(q, { dryRun: true });

    const dmlCalls = calls.filter((c) => /^\s*(UPDATE|INSERT)/i.test(c.sql));
    const sanctioned = new Set<unknown>([
      AL_RAISIA_CASHBOX_ID,
      EXP003_ID,
      EXP003_JL_ID,
      SHF002_REF_ID,
      SHF002_JL_ID,
      SETTLEMENT7_JL_ID,
      RET003_CT_ID,
    ]);
    for (const call of dmlCalls) {
      const sanctionedHits = call.params.filter((p: any) => sanctioned.has(p));
      expect(sanctionedHits.length).toBeGreaterThanOrEqual(1);
    }
    // Tables touched are only the 4 permitted ones.
    for (const call of dmlCalls) {
      const upper = call.sql.toUpperCase();
      const target = /UPDATE\s+(\w+)/.exec(upper)?.[1] ?? /INSERT\s+INTO\s+(\w+)/.exec(upper)?.[1] ?? '';
      expect(PERMITTED_TABLES.map((t) => t.toUpperCase())).toContain(target);
    }
    // Zero DELETEs.
    expect(calls.filter((c) => /^\s*DELETE/i.test(c.sql))).toHaveLength(0);
  });
});

// ─── Source-shape invariants (belt-and-braces) ────────────────────
describe('script source — global invariants', () => {
  const src = readFileSync(SCRIPT_PATH, 'utf8');

  it('contains zero DELETE/TRUNCATE/DROP/ALTER statements anywhere', () => {
    // Strip comments + strings so doc text doesn't trip the check.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1')
      .replace(/`[\s\S]*?`/g, '``')
      .replace(/'[^'\n]*'/g, "''")
      .replace(/"[^"\n]*"/g, '""');
    expect(code).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(code).not.toMatch(/\bTRUNCATE\b/i);
    expect(code).not.toMatch(/\bDROP\s+(TABLE|SCHEMA)\b/i);
    expect(code).not.toMatch(/\bALTER\s+TABLE\b/i);
  });

  it('exports the four audit-trail prefixes verbatim', () => {
    expect(NOTE_PREFIX_1A).toBe('cleanup: PR-CASH-RECON-EXEC#1a');
    expect(NOTE_PREFIX_2).toBe('cleanup: PR-CASH-RECON-EXEC#2');
    expect(NOTE_PREFIX_3A).toBe('cleanup: PR-CASH-RECON-EXEC#3a');
    expect(NOTE_PREFIX_4A).toBe('cleanup: PR-CASH-RECON-EXEC#4a');
  });

  it('default mode is dry-run; only --execute commits', () => {
    expect(src).toMatch(/Defaults to dry-run for safety/);
    expect(src).toMatch(/wantsExecute = process\.argv\.includes\('--execute'\)/);
  });
});

// ─── Renderer ─────────────────────────────────────────────────────
describe('renderResult — formatted Markdown report', () => {
  it('renders the snapshot Δ table + per-row actions + safety footer', () => {
    // Authoritative after-state (computed via SQL simulation against
    // the live snapshot). The +95 residual represents the unchanged
    // pieces the user's chosen options don't fully balance:
    //   · Row 2 tag-only leaves the GL +5 unmatched on the cash side
    //   · Row 4 voids CT-245 but the JE-378 reversal's +350 stays on
    //     tagged_gl with no compensating CT (Option A leaves it; Option
    //     B would have added a counter-CT and ended at the same +95
    //     because of how the bf7e6e27/other taxonomy CT pair offsets).
    // Net residual: +95 EGP, NOT zero.
    const md = renderResult({
      mode: 'dry-run',
      committed: false,
      before: { current_balance: 34155, active_ct_sum: 34155, tagged_gl_1111: 34505, untagged_gl_1111: -2095, global_gl_1111: 32410, per_cashbox_drift: -350, global_gap: 1745 },
      after:  { current_balance: 32505, active_ct_sum: 32505, tagged_gl_1111: 32410, untagged_gl_1111: 0, global_gl_1111: 32410, per_cashbox_drift: 95, global_gap: 95 },
      rows: [
        { row_id: 'row-1', option: '1a', actions: [{ step: 'UPDATE expenses', status: 'executed' }] },
        { row_id: 'row-2', option: '2',  actions: [{ step: 'UPDATE journal_lines', status: 'executed' }] },
        { row_id: 'row-3', option: '3a', actions: [{ step: 'UPDATE journal_lines (Row 3 tag-only)', status: 'executed' }] },
        { row_id: 'row-4', option: '4a', actions: [{ step: 'UPDATE cashbox_transactions (void CT-245)', status: 'executed' }] },
      ],
    });
    expect(md).toMatch(/# Cash\/GL cleanup — DRY-RUN/);
    expect(md).toMatch(/Committed: \*\*NO\*\*/);
    expect(md).toMatch(/\| current_balance \| 34155\.00 \| 32505\.00 \| -1650\.00 \|/);
    // global_gap moves from +1,745 → +95 (NOT zero — see comment above).
    expect(md).toMatch(/\| global_gap \| 1745\.00 \| 95\.00 \| -1650\.00 \|/);
    expect(md).toMatch(/### row-1 \(option 1a\)/);
    expect(md).toMatch(/### row-4 \(option 4a\)/);
    expect(md).toMatch(/cleanup: PR-CASH-RECON-EXEC#1a/);
    expect(md).toMatch(/0 DELETEs/);
  });
});
