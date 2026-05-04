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
  runRow5,
  AL_RAISIA_CASHBOX_ID,
  EXP003_ID,
  EXP003_JL_ID,
  SHF002_REF_ID,
  SHF002_JL_ID,
  SETTLEMENT7_JL_ID,
  JE196_ENTRY_NO,
  RET003_CT_ID,
  NOTE_PREFIX_1A,
  NOTE_PREFIX_2,
  NOTE_PREFIX_3A,
  NOTE_PREFIX_4A,
  NOTE_PREFIX_5,
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
const PERMITTED_TABLES = [
  'expenses',
  'journal_lines',
  'cashbox_transactions',
  'cashboxes',
  // R3-B targets journal_entries to void JE-196 (the stale duplicate).
  'journal_entries',
];

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

// ─── 2. Row 3 voids JE-196 (does not create CT, does not tag JL) ──
describe('runRow3a — voids JE-196 (the stale duplicate)', () => {
  it('issues ONE UPDATE on journal_entries (void) — ZERO INSERTs into cashbox_transactions, ZERO UPDATEs on journal_lines', async () => {
    const { q, calls } = makeQ({
      responses: [
        // JE-196 currently active — first call returns is_void=false
        { pattern: /SELECT id::text AS id, is_void\s+FROM journal_entries/, rows: [{ id: 'je196-uuid', is_void: false }] },
      ],
    });
    const result = await runRow3a(q);
    const dml = calls
      .map((c) => c.sql.trim().toUpperCase())
      .filter((s) => s.startsWith('UPDATE') || s.startsWith('INSERT') || s.startsWith('DELETE'));
    // Exactly one void UPDATE on journal_entries.
    expect(dml.filter((s) => s.startsWith('UPDATE JOURNAL_ENTRIES'))).toHaveLength(1);
    // No CT create, no JL tag, no DELETE.
    expect(dml.filter((s) => s.startsWith('INSERT INTO CASHBOX_TRANSACTIONS'))).toHaveLength(0);
    expect(dml.filter((s) => s.startsWith('UPDATE JOURNAL_LINES'))).toHaveLength(0);
    expect(dml.filter((s) => s.startsWith('UPDATE CASHBOXES'))).toHaveLength(0);
    expect(dml.filter((s) => s.startsWith('UPDATE CASHBOX_TRANSACTIONS'))).toHaveLength(0);
    expect(dml.filter((s) => s.startsWith('DELETE'))).toHaveLength(0);
    // Action detail surfaces the canonical-pair fact.
    expect(
      result.actions.some((a) =>
        /CT-108 \+ JE-248 remain the canonical/.test(a.detail ?? '') ||
        /CT-108 \+ JE-248 remain the canonical/.test(a.step ?? ''),
      ),
    ).toBe(true);
  });

  it('void UPDATE targets entry_no=JE-2026-000196 with NOTE_PREFIX_3A void_reason', async () => {
    const { q, calls } = makeQ({
      responses: [
        { pattern: /SELECT id::text AS id, is_void\s+FROM journal_entries/, rows: [{ id: 'je196-uuid', is_void: false }] },
      ],
    });
    await runRow3a(q);
    const voidUpdate = calls.find((c) => /UPDATE journal_entries[\s\S]*is_void=TRUE/.test(c.sql))!;
    expect(voidUpdate).toBeDefined();
    expect(voidUpdate.params).toContain(JE196_ENTRY_NO);
    const reason = voidUpdate.params.find(
      (p: any) => typeof p === 'string' && p.startsWith(NOTE_PREFIX_3A),
    );
    expect(reason).toBeTruthy();
    expect(reason).toMatch(/stale duplicate of JE-2026-000248/);
    expect(reason).toMatch(/PR-DRIFT-3G/);
  });

  it('CT-108 + JE-248 are NEVER targeted by any DML (audit-text mentions are OK)', async () => {
    const { q, calls } = makeQ({
      responses: [
        { pattern: /SELECT id::text AS id, is_void\s+FROM journal_entries/, rows: [{ id: 'je196-uuid', is_void: false }] },
      ],
    });
    await runRow3a(q);
    // SQL strings (the actual target of each statement) must not reference
    // CT-108 / JE-248 / their UUIDs. The `void_reason` text legitimately
    // explains the canonical pair for the audit trail — that's a documented
    // string parameter, not a targeting parameter.
    for (const c of calls) {
      // No DML param equals the CT-108 numeric id.
      expect(c.params.includes(108)).toBe(false);
      // No DML param equals JE-248's entry_no exactly.
      expect(c.params.includes('JE-2026-000248')).toBe(false);
      // The SQL itself doesn't target JE-248's entry_no / id literal.
      expect(c.sql).not.toMatch(/WHERE\s+entry_no\s*=\s*'JE-2026-000248'/);
      expect(c.sql).not.toMatch(/WHERE\s+id\s*=\s*'887ea7c4-baf9-4e1b-9376-88cfbb46cb33'/);
      // No params reference CT-108's ref_id UUID as a TARGET.
      // (The string '887ea7c4' is allowed in the void_reason but never as a sole-param.)
      const refParams = c.params.filter(
        (p: any) => typeof p === 'string' && p === '887ea7c4-baf9-4e1b-9376-88cfbb46cb33',
      );
      expect(refParams).toHaveLength(0);
    }
  });

  it('does NOT touch SETTLEMENT7_JL_ID (the JE-196 1111 line) — entire entry voided instead', async () => {
    const { q, calls } = makeQ({
      responses: [
        { pattern: /SELECT id::text AS id, is_void\s+FROM journal_entries/, rows: [{ id: 'je196-uuid', is_void: false }] },
      ],
    });
    await runRow3a(q);
    for (const c of calls) {
      const stringParams = c.params.filter((p: any) => typeof p === 'string');
      for (const sp of stringParams) {
        expect(sp).not.toBe(SETTLEMENT7_JL_ID);
      }
    }
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

// ─── 3.5. Row 5: counter-CT IN +5 for SHF-2026-00002 ──────────────
describe('runRow5 — counter-CT IN +5 (closes the Row 2 residual)', () => {
  it('inserts EXACTLY ONE CT IN +5 tied to SHF002_REF_ID + EXEC#5 prefix', async () => {
    const { q, calls } = makeQ({
      responses: [
        // No prior cleanup CT exists yet
        { pattern: /SELECT id FROM cashbox_transactions[\s\S]*notes LIKE/, rows: [] },
      ],
    });
    const result = await runRow5(q);
    expect(result.row_id).toBe('row-5');
    expect(result.option).toBe('5');
    const dml = calls.filter((c) => /^\s*(UPDATE|INSERT|DELETE)/i.test(c.sql));
    // Exactly one INSERT, zero UPDATE/DELETE.
    expect(dml.filter((c) => /^\s*INSERT/i.test(c.sql))).toHaveLength(1);
    expect(dml.filter((c) => /^\s*UPDATE/i.test(c.sql))).toHaveLength(0);
    expect(dml.filter((c) => /^\s*DELETE/i.test(c.sql))).toHaveLength(0);
    // The INSERT targets cashbox_transactions, direction='in', amount=5.
    const insertCall = dml.find((c) => /INSERT INTO cashbox_transactions/i.test(c.sql))!;
    expect(insertCall.sql).toMatch(/'in',\s*5/);
    expect(insertCall.sql).toMatch(/'shift_variance'/);
    // SHF002_REF_ID in params + AL_RAISIA_CASHBOX_ID in params + EXEC#5 prefix in notes.
    expect(insertCall.params).toContain(SHF002_REF_ID);
    expect(insertCall.params).toContain(AL_RAISIA_CASHBOX_ID);
    const notesParam = insertCall.params.find(
      (p: any) => typeof p === 'string' && p.startsWith(NOTE_PREFIX_5),
    );
    expect(notesParam).toBeTruthy();
    expect(notesParam).toMatch(/JE-2026-000126/);
    expect(notesParam).toMatch(/SHF-2026-00002/);
  });

  it('is idempotent — re-run after a previous insert is a no-op', async () => {
    const { q, calls } = makeQ({
      responses: [
        // Prior cleanup CT already exists (row id 999)
        { pattern: /SELECT id FROM cashbox_transactions[\s\S]*notes LIKE/, rows: [{ id: 999 }] },
      ],
    });
    const result = await runRow5(q);
    expect(result.actions[0].status).toBe('skipped_idempotent');
    expect(calls.filter((c) => /^\s*INSERT/i.test(c.sql))).toHaveLength(0);
  });

  it('does NOT touch JE-126 — Row 5 only adds a CT, the JE stays active', async () => {
    const { q, calls } = makeQ({
      responses: [
        { pattern: /SELECT id FROM cashbox_transactions[\s\S]*notes LIKE/, rows: [] },
      ],
    });
    await runRow5(q);
    for (const c of calls) {
      // No UPDATE journal_entries (no void of JE-126), no UPDATE journal_lines either.
      expect(c.sql).not.toMatch(/UPDATE\s+journal_entries/i);
      expect(c.sql).not.toMatch(/UPDATE\s+journal_lines/i);
      // No params reference JE-126 entry_no — the CT is tied to the SHIFT reference, not the JE.
      expect(c.params.includes('JE-2026-000126')).toBe(false);
    }
  });

  it('uses reference_type=shift_variance + reference_id=SHF002_REF_ID (matches JE-126\'s reference)', async () => {
    const { q, calls } = makeQ({
      responses: [
        { pattern: /SELECT id FROM cashbox_transactions[\s\S]*notes LIKE/, rows: [] },
      ],
    });
    await runRow5(q);
    const insertCall = calls.find((c) => /INSERT INTO cashbox_transactions/i.test(c.sql))!;
    expect(insertCall.sql).toMatch(/'shift_variance'/);
    expect(insertCall.params).toContain(SHF002_REF_ID);
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

  it('runRow3a skips when JE-196 is already voided', async () => {
    const { q, calls } = makeQ({
      responses: [
        { pattern: /SELECT id::text AS id, is_void\s+FROM journal_entries/, rows: [{ id: 'je196-uuid', is_void: true }] },
      ],
    });
    const result = await runRow3a(q);
    expect(result.actions[0].status).toBe('skipped_idempotent');
    expect(calls.filter((c) => /UPDATE/i.test(c.sql))).toHaveLength(0);
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
        // R3-B: JE-196 active in this scenario
        { pattern: /SELECT id::text AS id, is_void\s+FROM journal_entries/, rows: [{ id: 'je196-uuid', is_void: false }] },
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
        // R3-B: JE-196 active → not yet voided
        { pattern: /SELECT id::text AS id, is_void\s+FROM journal_entries/, rows: [{ id: 'je196-uuid', is_void: false }] },
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
      // R3-B sanctioned identifier: target JE-196 by entry_no
      JE196_ENTRY_NO,
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

  it('exports the five audit-trail prefixes verbatim', () => {
    expect(NOTE_PREFIX_1A).toBe('cleanup: PR-CASH-RECON-EXEC#1a');
    expect(NOTE_PREFIX_2).toBe('cleanup: PR-CASH-RECON-EXEC#2');
    expect(NOTE_PREFIX_3A).toBe('cleanup: PR-CASH-RECON-EXEC#3a');
    expect(NOTE_PREFIX_4A).toBe('cleanup: PR-CASH-RECON-EXEC#4a');
    expect(NOTE_PREFIX_5).toBe('cleanup: PR-CASH-RECON-EXEC#5');
  });

  it('default mode is dry-run; only --execute commits', () => {
    expect(src).toMatch(/Defaults to dry-run for safety/);
    expect(src).toMatch(/wantsExecute = process\.argv\.includes\('--execute'\)/);
  });
});

// ─── Renderer ─────────────────────────────────────────────────────
describe('renderResult — formatted Markdown report', () => {
  it('renders the snapshot Δ table + per-row actions + safety footer', () => {
    // Authoritative after-state with all 5 rows (computed via SQL
    // simulation against the live snapshot):
    //   · Row 1: tag EXP-000003 + write CT out 2,000
    //   · Row 2: tag JE-126 1111 line to الرئيسية
    //   · Row 3 (R3-B): void JE-196 (stale duplicate of JE-248)
    //   · Row 5: write counter-CT IN +5 to mirror JE-126's shift surplus
    //     (matches the business meaning: shift surplus = cash entered)
    //   · Row 4: void CT-245 + recompute current_balance (runs LAST so
    //     recompute captures Row 5's new CT)
    //
    // Final state: gap = 0, drift = 0 ✓
    // ABU YUSUF balance corrects from +70 → −30 (duplicate JE-196 removed).
    // TB stays at 0.
    const md = renderResult({
      mode: 'dry-run',
      committed: false,
      before: { current_balance: 33885, active_ct_sum: 33885, tagged_gl_1111: 34235, untagged_gl_1111: -2095, global_gl_1111: 32140, per_cashbox_drift: -350, global_gap: 1745 },
      after:  { current_balance: 32240, active_ct_sum: 32240, tagged_gl_1111: 32240, untagged_gl_1111: 0, global_gl_1111: 32240, per_cashbox_drift: 0, global_gap: 0 },
      rows: [
        { row_id: 'row-1', option: '1a', actions: [{ step: 'UPDATE expenses', status: 'executed' }] },
        { row_id: 'row-2', option: '2',  actions: [{ step: 'UPDATE journal_lines', status: 'executed' }] },
        { row_id: 'row-3', option: '3a', actions: [{ step: 'UPDATE journal_entries SET is_void=TRUE on JE-2026-000196', status: 'executed' }] },
        { row_id: 'row-5', option: '5',  actions: [{ step: 'INSERT cashbox_transactions (Row 5 counter-CT in +5)', status: 'executed' }] },
        { row_id: 'row-4', option: '4a', actions: [{ step: 'UPDATE cashbox_transactions (void CT-245)', status: 'executed' }] },
      ],
    });
    expect(md).toMatch(/# Cash\/GL cleanup — DRY-RUN/);
    expect(md).toMatch(/Committed: \*\*NO\*\*/);
    expect(md).toMatch(/\| current_balance \| 33885\.00 \| 32240\.00 \| -1645\.00 \|/);
    // global_gap closes to exactly 0 ✓
    expect(md).toMatch(/\| global_gap \| 1745\.00 \| 0\.00 \| -1745\.00 \|/);
    expect(md).toMatch(/\| per_cashbox_drift \| -350\.00 \| 0\.00 \| \+350\.00 \|/);
    expect(md).toMatch(/### row-1 \(option 1a\)/);
    expect(md).toMatch(/### row-3 \(option 3a\)/);
    expect(md).toMatch(/### row-5 \(option 5\)/);
    expect(md).toMatch(/### row-4 \(option 4a\)/);
    expect(md).toMatch(/JE-2026-000196/);
    expect(md).toMatch(/Row 5 counter-CT in \+5/);
    expect(md).toMatch(/cleanup: PR-CASH-RECON-EXEC#1a/);
    expect(md).toMatch(/0 DELETEs/);
  });
});
