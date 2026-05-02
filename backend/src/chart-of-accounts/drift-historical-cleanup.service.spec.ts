/**
 * drift-historical-cleanup.service.spec.ts
 * ────────────────────────────────────────────────────────────────────
 * PR-FIN-PAYACCT-4D-DRIFT-HISTORICAL-CLEANUP-1
 *
 * Verifies the safety contract of the historical drift cleanup:
 *   • dry run is read-only (no UPDATE / INSERT / DELETE)
 *   • execute requires the confirm token
 *   • execute sets `engine:drift-historical-cleanup` BEFORE writes
 *     (this is the only context that does NOT log to engine_bypass_alerts)
 *   • execute issues only the two allowed UPDATE shapes:
 *       - cashbox_transactions: (is_void, voided_at, voided_by, void_reason)
 *       - journal_lines:       (cashbox_id) only
 *   • execute never DELETEs and never INSERTs into JE / JL / CT
 *   • execute is idempotent (second run with empty candidates → no writes)
 *   • execute self-checks for residual candidates and aborts on drift != 0
 *   • rebuildCashboxBalance is called only when opt-in (default true)
 *
 * Detection / SQL is asserted at the SQL-substring level using a
 * content-matched stub of DataSource (single-shot matchers, order is
 * tolerated when the service short-circuits queries).
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';

import {
  DriftHistoricalCleanupService,
  EXECUTE_CONFIRM_TOKEN,
} from './drift-historical-cleanup.service';
import { ReconciliationService } from './reconciliation.service';

type QueryCall = { sql: string; params: any[] };

/**
 * Content-matched fake DataSource. The dispatcher receives every SQL
 * (whether issued via `ds.query` or `em.query` inside a transaction)
 * and returns the FIRST unused matcher whose pattern matches. Short-
 * circuits in the service (e.g. planPatternARows skips its query when
 * candidates are empty) cause no alignment issues — unused matchers
 * stay available for later calls.
 */
function makeFakeDs(dispatch: (sql: string) => any[]) {
  const dsCalls: QueryCall[] = [];
  const emCalls: QueryCall[] = [];

  const em = {
    query: async (sql: string, params: any[] = []) => {
      emCalls.push({ sql, params });
      return dispatch(sql);
    },
  };
  const ds: any = {
    query: async (sql: string, params: any[] = []) => {
      dsCalls.push({ sql, params });
      return dispatch(sql);
    },
    transaction: async (cb: (em: any) => Promise<any>) => cb(em),
  };
  return { ds, em, dsCalls, emCalls };
}

/**
 * Single-shot content matchers. Each entry fires AT MOST once on the
 * first incoming SQL whose pattern matches. Order matters when two
 * patterns could match the same SQL (the earlier one wins). Returns
 * `[]` when no unused matcher matches.
 */
function script(rows: Array<[RegExp | string, any[]]>) {
  const remaining = rows.map(([pat, ret]) => ({ pat, ret, used: false }));
  return (sql: string) => {
    for (const m of remaining) {
      if (m.used) continue;
      const matches =
        typeof m.pat === 'string' ? sql.includes(m.pat) : m.pat.test(sql);
      if (matches) {
        m.used = true;
        return m.ret;
      }
    }
    return [];
  };
}

// Unique patterns per logical query so matchers don't cross-fire.
const PAT_A_DETECT = /sale_ct_total[\s\S]+duplicate_amount/;
const PAT_A_ROWS = /ROW_NUMBER\(\) OVER/;
const PAT_B_DETECT = /jl\.cashbox_id IS NULL[\s\S]+jl\.debit = 0/;
const PAT_B_AMBIGUOUS = /'multiple matching journal_lines for the active JE/;
const PAT_DRIFT = /v_cashbox_gl_drift/;
const PAT_BAL = /FROM cashboxes WHERE id/;
const PAT_EXPECTED_BAL = /CASE WHEN direction='in' THEN amount ELSE -amount/;
const PAT_LOCK = /pg_advisory_xact_lock/;
const PAT_SET_CTX = /SET LOCAL app\.engine_context/;
const PAT_UPDATE_CT = /UPDATE cashbox_transactions/;
const PAT_UPDATE_JL = /UPDATE journal_lines/;

const MAIN_CB = '524646d5-7bd6-4d8d-a484-b1f562b039a4';

const A_CANDIDATE = {
  invoice_no: 'INV-2026-000166',
  invoice_id: 'inv-166',
  cashbox_id: MAIN_CB,
  sale_ct_count: 3,
  sale_ct_total: 1500,
  voided_je_count: 2,
  active_entry_no: 'JE-364',
  active_je_cash: 500,
  duplicate_amount: 1000,
};

const A_ROWS = [
  {
    ct_id: 243,
    invoice_id: 'inv-166',
    invoice_no: 'INV-2026-000166',
    cashbox_id: MAIN_CB,
    amount: 500,
    created_at: '2026-05-01T15:21:36Z',
    rn: 1,
  },
  {
    ct_id: 249,
    invoice_id: 'inv-166',
    invoice_no: 'INV-2026-000166',
    cashbox_id: MAIN_CB,
    amount: 500,
    created_at: '2026-05-01T17:20:16Z',
    rn: 2,
  },
  {
    ct_id: 251,
    invoice_id: 'inv-166',
    invoice_no: 'INV-2026-000166',
    cashbox_id: MAIN_CB,
    amount: 500,
    created_at: '2026-05-01T17:26:01Z',
    rn: 3,
  },
];

const B_CANDIDATE = {
  return_no: 'RET-2026-000003',
  return_id: 'ret-3',
  cashbox_id: MAIN_CB,
  je_id: 'je-358',
  entry_no: 'JE-2026-000358',
  jl_id: 'jl-3',
  debit: 0,
  credit: 350,
  current_jl_cashbox_id: null,
  proposed_jl_cashbox_id: MAIN_CB,
  paired_ct_id: 245,
  ct_amount: 350,
};

async function buildModule(deps: { ds: any; recon: any }) {
  const moduleRef = await Test.createTestingModule({
    providers: [
      DriftHistoricalCleanupService,
      { provide: DataSource, useValue: deps.ds },
      { provide: ReconciliationService, useValue: deps.recon },
    ],
  }).compile();
  return moduleRef.get(DriftHistoricalCleanupService);
}

// ─────────────────────────────────────────────────────────────────────
//  dry run
// ─────────────────────────────────────────────────────────────────────

describe('DriftHistoricalCleanupService — dry run', () => {
  it('returns Pattern A + B candidates and never issues UPDATE/INSERT/DELETE', async () => {
    const { ds, dsCalls } = makeFakeDs(
      script([
        [PAT_A_DETECT, [A_CANDIDATE]],
        [PAT_A_ROWS, A_ROWS],
        [PAT_B_DETECT, [B_CANDIDATE]],
        [PAT_B_AMBIGUOUS, []],
        [PAT_DRIFT, [{ drift: 1000 }]],
        [PAT_BAL, [{ bal: 32930 }]],
        [PAT_EXPECTED_BAL, [{ bal: 31930 }]],
      ]),
    );
    const recon = { rebuildCashboxBalance: jest.fn() };
    const svc = await buildModule({ ds, recon });

    const out = await svc.dryRun();

    expect(out.executed).toBe(false);
    expect(out.patternA.candidates).toHaveLength(1);
    expect(out.patternA.rowsToVoidCount).toBe(2);
    expect(out.patternA.voidAmountTotal).toBe(1000);
    expect(out.patternB.candidates).toHaveLength(1);
    expect(out.patternB.ambiguous).toEqual([]);
    expect(out.cashboxImpact).toHaveLength(1);
    expect(out.cashboxImpact[0].drift_before).toBe(1000);
    expect(out.cashboxImpact[0].drift_after_expected).toBe(0);
    expect(out.cashboxImpact[0].current_balance_before).toBe(32930);
    expect(out.cashboxImpact[0].current_balance_after_expected).toBe(31930);

    for (const c of dsCalls) {
      expect(c.sql).not.toMatch(/^\s*UPDATE\s/i);
      expect(c.sql).not.toMatch(/^\s*INSERT\s/i);
      expect(c.sql).not.toMatch(/^\s*DELETE\s/i);
    }
    expect(recon.rebuildCashboxBalance).not.toHaveBeenCalled();
  });

  it('classifies earliest sale CT as keep and the rest as void (deterministic)', async () => {
    const { ds } = makeFakeDs(
      script([
        [PAT_A_DETECT, [A_CANDIDATE]],
        [PAT_A_ROWS, A_ROWS],
        [PAT_B_DETECT, []],
        [PAT_B_AMBIGUOUS, []],
        [PAT_DRIFT, [{ drift: 1000 }]],
        [PAT_BAL, [{ bal: 32930 }]],
        [PAT_EXPECTED_BAL, [{ bal: 31930 }]],
      ]),
    );
    const svc = await buildModule({
      ds,
      recon: { rebuildCashboxBalance: jest.fn() },
    });
    const out = await svc.dryRun();
    const keeps = out.patternA.rows.filter((r) => r.action === 'keep');
    const voids = out.patternA.rows.filter((r) => r.action === 'void');
    expect(keeps).toHaveLength(1);
    expect(keeps[0].ct_id).toBe(243);
    expect(voids.map((v) => v.ct_id)).toEqual([249, 251]);
    expect(keeps[0].reason).toContain('earliest');
    expect(voids[0].reason).toContain('duplicate sale CT');
  });
});

// ─────────────────────────────────────────────────────────────────────
//  execute — confirm token
// ─────────────────────────────────────────────────────────────────────

describe('DriftHistoricalCleanupService — execute confirm token', () => {
  it('throws and writes nothing when confirm token is missing', async () => {
    const { ds, emCalls, dsCalls } = makeFakeDs(script([]));
    const svc = await buildModule({
      ds,
      recon: { rebuildCashboxBalance: jest.fn() },
    });
    await expect(svc.execute({ confirm: '' })).rejects.toThrow(
      /confirm token does not match/i,
    );
    expect(emCalls).toEqual([]);
    expect(dsCalls).toEqual([]);
  });

  it('throws and writes nothing when confirm token is wrong', async () => {
    const { ds, emCalls } = makeFakeDs(script([]));
    const svc = await buildModule({
      ds,
      recon: { rebuildCashboxBalance: jest.fn() },
    });
    await expect(svc.execute({ confirm: 'WRONG' })).rejects.toThrow(
      /confirm token does not match/i,
    );
    expect(emCalls).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  execute — full happy path with proven safety contract
// ─────────────────────────────────────────────────────────────────────

describe('DriftHistoricalCleanupService — execute (happy path)', () => {
  it('sets engine:drift-historical-cleanup BEFORE any write and applies UPDATEs', async () => {
    const recon = {
      rebuildCashboxBalance: jest
        .fn()
        .mockResolvedValue({ cashbox_id: MAIN_CB, new_balance: 31930 }),
    };

    const { ds, emCalls } = makeFakeDs(
      script([
        // pre-tx dry-run snapshot
        [PAT_A_DETECT, [A_CANDIDATE]],
        [PAT_A_ROWS, A_ROWS],
        [PAT_B_DETECT, [B_CANDIDATE]],
        [PAT_B_AMBIGUOUS, []],
        [PAT_DRIFT, [{ drift: 2100 }]],
        [PAT_BAL, [{ bal: 32930 }]],
        [PAT_EXPECTED_BAL, [{ bal: 31930 }]],

        // inside tx
        [PAT_LOCK, []],
        [PAT_SET_CTX, []],

        // recompute candidates
        [PAT_A_DETECT, [A_CANDIDATE]],
        [PAT_A_ROWS, A_ROWS],
        [PAT_B_DETECT, [B_CANDIDATE]],

        // 2 Pattern-A UPDATEs (one per "void" row)
        [PAT_UPDATE_CT, [[], 1]],
        [PAT_UPDATE_CT, [[], 1]],

        // 1 Pattern-B UPDATE
        [PAT_UPDATE_JL, [[], 1]],

        // idempotency self-check — empty
        [PAT_A_DETECT, []],
        [PAT_B_DETECT, []],

        // drift assertion → 0
        [PAT_DRIFT, [{ drift: 0 }]],
      ]),
    );

    const svc = await buildModule({ ds, recon });
    const out = await svc.execute({
      confirm: EXECUTE_CONFIRM_TOKEN,
      rebuildCashboxBalance: true,
      actorUserId: 'user-1',
    });

    expect(out.executed).toBe(true);
    expect(out.ctVoidedIds).toEqual([249, 251]);
    expect(out.jlUpdatedIds).toEqual(['jl-3']);
    expect(out.driftAfterActual).toEqual([{ cashbox_id: MAIN_CB, drift: 0 }]);

    // engine context literal MUST be the silent (no-alert) prefix
    const ctxIdx = emCalls.findIndex((c) => PAT_SET_CTX.test(c.sql));
    expect(ctxIdx).toBeGreaterThan(-1);
    expect(emCalls[ctxIdx].params[0]).toBe('engine:drift-historical-cleanup');

    // Engine context MUST be set BEFORE any UPDATE inside the tx
    const firstUpdateIdx = emCalls.findIndex((c) => /^\s*UPDATE\s/i.test(c.sql));
    expect(firstUpdateIdx).toBeGreaterThan(ctxIdx);

    // Advisory lock fires before the engine context is set
    const lockIdx = emCalls.findIndex((c) => PAT_LOCK.test(c.sql));
    expect(lockIdx).toBeGreaterThan(-1);
    expect(lockIdx).toBeLessThan(ctxIdx);

    // Pattern A UPDATEs target only the duplicate ct_ids (NOT the keeper 243)
    const ctUpdates = emCalls.filter((c) => PAT_UPDATE_CT.test(c.sql));
    expect(ctUpdates).toHaveLength(2);
    expect(ctUpdates.map((c) => c.params[0]).sort()).toEqual([249, 251]);
    for (const u of ctUpdates) {
      expect(u.sql).toMatch(/SET\s+is_void\s*=\s*true/);
      expect(u.sql).toMatch(/voided_at\s*=\s*now\(\)/);
      expect(u.sql).toMatch(/voided_by\s*=\s*\$2/);
      expect(u.sql).toMatch(/void_reason\s*=\s*\$3/);
      expect(u.sql).toMatch(/WHERE id = \$1 AND is_void = false/);
      // Whitelist columns only — must not touch amount, cashbox_id, etc.
      expect(u.sql).not.toMatch(/SET[\s\S]*\b(amount|reference_id|category|direction)\s*=/);
      expect(u.params[1]).toBe('user-1');
      expect(u.params[2]).toContain(
        'PR-FIN-PAYACCT-4D-DRIFT-HISTORICAL-CLEANUP-1',
      );
    }

    // Pattern B UPDATE only sets cashbox_id, with WHERE cashbox_id IS NULL guard
    const jlUpdates = emCalls.filter((c) => PAT_UPDATE_JL.test(c.sql));
    expect(jlUpdates).toHaveLength(1);
    expect(jlUpdates[0].sql).toMatch(/SET\s+cashbox_id\s*=\s*\$2/);
    expect(jlUpdates[0].sql).toMatch(/WHERE id = \$1 AND cashbox_id IS NULL/);
    expect(jlUpdates[0].sql).not.toMatch(
      /SET[\s\S]*\b(debit|credit|account_id|entry_id|line_no)\s*=/,
    );
    expect(jlUpdates[0].params).toEqual(['jl-3', MAIN_CB]);

    // No DELETE or INSERT against any table at all
    for (const c of emCalls) {
      expect(c.sql).not.toMatch(/^\s*DELETE\s/i);
      expect(c.sql).not.toMatch(/^\s*INSERT\s/i);
    }

    // engine_bypass_alerts invariant — the cleanup tx never INSERTs into
    // engine_bypass_alerts. The post-commit rebuild path delegates to
    // ReconciliationService.rebuildCashboxBalance which only UPDATEs the
    // cashboxes table; the cashboxes UPDATE trigger uses fn_is_engine_context
    // (a pure boolean check, no INSERT into engine_bypass_alerts), so the
    // whole execute path increments the alert count by 0.
    for (const c of emCalls) {
      expect(c.sql).not.toMatch(/engine_bypass_alerts/i);
    }

    // rebuildCashboxBalance was called once for the affected cashbox, after tx
    expect(recon.rebuildCashboxBalance).toHaveBeenCalledTimes(1);
    expect(recon.rebuildCashboxBalance).toHaveBeenCalledWith(MAIN_CB);
    expect(out.cashboxBalanceRebuilt).toEqual([
      { cashbox_id: MAIN_CB, new_balance: 31930 },
    ]);
  });

  it('rebuild path produces no engine_bypass_alerts INSERT (contract test)', async () => {
    // Records every interaction the recon mock receives so we can prove
    // the cleanup orchestration NEVER asks recon to do anything other
    // than rebuildCashboxBalance(cashboxId). Combined with the production
    // implementation of rebuildCashboxBalance (which only UPDATEs the
    // cashboxes table — a trigger surface that does NOT call
    // fn_engine_write_allowed), this guarantees engine_bypass_alerts is
    // not incremented by the post-commit rebuild step.
    const reconCalls: Array<{ method: string; args: any[] }> = [];
    const recon = {
      rebuildCashboxBalance: jest.fn((...args: any[]) => {
        reconCalls.push({ method: 'rebuildCashboxBalance', args });
        return Promise.resolve({ cashbox_id: MAIN_CB, new_balance: 31930 });
      }),
    };

    const { ds, emCalls, dsCalls } = makeFakeDs(
      script([
        // pre-tx dry-run snapshot
        [PAT_A_DETECT, [A_CANDIDATE]],
        [PAT_A_ROWS, A_ROWS],
        [PAT_B_DETECT, [B_CANDIDATE]],
        [PAT_B_AMBIGUOUS, []],
        [PAT_DRIFT, [{ drift: 2100 }]],
        [PAT_BAL, [{ bal: 32930 }]],
        [PAT_EXPECTED_BAL, [{ bal: 31930 }]],
        // inside tx
        [PAT_LOCK, []],
        [PAT_SET_CTX, []],
        [PAT_A_DETECT, [A_CANDIDATE]],
        [PAT_A_ROWS, A_ROWS],
        [PAT_B_DETECT, [B_CANDIDATE]],
        [PAT_UPDATE_CT, [[], 1]],
        [PAT_UPDATE_CT, [[], 1]],
        [PAT_UPDATE_JL, [[], 1]],
        [PAT_A_DETECT, []],
        [PAT_B_DETECT, []],
        [PAT_DRIFT, [{ drift: 0 }]],
      ]),
    );

    const svc = await buildModule({ ds, recon });
    await svc.execute({
      confirm: EXECUTE_CONFIRM_TOKEN,
      rebuildCashboxBalance: true,
    });

    // 1. The cleanup tx itself never references engine_bypass_alerts.
    for (const c of emCalls) {
      expect(c.sql).not.toMatch(/engine_bypass_alerts/i);
      expect(c.sql).not.toMatch(/^\s*INSERT\s/i);
    }
    // 2. The dry-run pre-snapshot also never references engine_bypass_alerts.
    for (const c of dsCalls) {
      expect(c.sql).not.toMatch(/engine_bypass_alerts/i);
      expect(c.sql).not.toMatch(/^\s*INSERT\s/i);
    }
    // 3. The orchestration calls EXACTLY ONE recon method, with EXACTLY
    //    ONE argument shape: rebuildCashboxBalance(cashboxId). It never
    //    asks recon to insert alerts, void rows, or do any other work.
    expect(reconCalls).toEqual([
      { method: 'rebuildCashboxBalance', args: [MAIN_CB] },
    ]);
    // 4. The cleanup engine context literal MUST be 'engine:*' (silent
    //    path); 'service:*' would log to engine_bypass_alerts.
    const ctxCall = emCalls.find((c) => PAT_SET_CTX.test(c.sql));
    expect(ctxCall?.params[0]).toMatch(/^engine:/);
    expect(ctxCall?.params[0]).not.toMatch(/^service:/);
  });

  it('skips rebuildCashboxBalance when opt-out is requested', async () => {
    const recon = { rebuildCashboxBalance: jest.fn() };
    const { ds } = makeFakeDs(
      script([
        // dry-run snapshot — empty candidate sets
        [PAT_A_DETECT, []],
        [PAT_B_DETECT, []],
        [PAT_B_AMBIGUOUS, []],

        // inside tx
        [PAT_LOCK, []],
        [PAT_SET_CTX, []],
        [PAT_A_DETECT, []],
        [PAT_B_DETECT, []],

        // idempotency self-check
        [PAT_A_DETECT, []],
        [PAT_B_DETECT, []],
      ]),
    );
    const svc = await buildModule({ ds, recon });
    const out = await svc.execute({
      confirm: EXECUTE_CONFIRM_TOKEN,
      rebuildCashboxBalance: false,
    });
    expect(out.executed).toBe(true);
    expect(recon.rebuildCashboxBalance).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────
//  execute — idempotency
// ─────────────────────────────────────────────────────────────────────

describe('DriftHistoricalCleanupService — idempotency', () => {
  it('a second invocation finds zero candidates and issues zero UPDATEs', async () => {
    const { ds, emCalls } = makeFakeDs(
      script([
        // dry-run snapshot — empty
        [PAT_A_DETECT, []],
        [PAT_B_DETECT, []],
        [PAT_B_AMBIGUOUS, []],
        // inside tx
        [PAT_LOCK, []],
        [PAT_SET_CTX, []],
        [PAT_A_DETECT, []],
        [PAT_B_DETECT, []],
        // idempotency self-check
        [PAT_A_DETECT, []],
        [PAT_B_DETECT, []],
      ]),
    );
    const svc = await buildModule({
      ds,
      recon: { rebuildCashboxBalance: jest.fn() },
    });
    const out = await svc.execute({
      confirm: EXECUTE_CONFIRM_TOKEN,
      rebuildCashboxBalance: false,
    });
    expect(out.executed).toBe(true);
    expect(out.ctVoidedIds).toEqual([]);
    expect(out.jlUpdatedIds).toEqual([]);
    const updates = emCalls.filter((c) => /^\s*UPDATE\s/i.test(c.sql));
    expect(updates).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  execute — drift assertion / rollback
// ─────────────────────────────────────────────────────────────────────

describe('DriftHistoricalCleanupService — drift assertion', () => {
  it('throws (rolls back via tx) when post-cleanup drift is non-zero', async () => {
    const { ds } = makeFakeDs(
      script([
        // pre-tx
        [PAT_A_DETECT, [A_CANDIDATE]],
        [PAT_A_ROWS, A_ROWS],
        [PAT_B_DETECT, []],
        [PAT_B_AMBIGUOUS, []],
        [PAT_DRIFT, [{ drift: 1000 }]],
        [PAT_BAL, [{ bal: 32930 }]],
        [PAT_EXPECTED_BAL, [{ bal: 31930 }]],
        // inside tx
        [PAT_LOCK, []],
        [PAT_SET_CTX, []],
        [PAT_A_DETECT, [A_CANDIDATE]],
        [PAT_A_ROWS, A_ROWS],
        [PAT_B_DETECT, []],
        [PAT_UPDATE_CT, [[], 1]],
        [PAT_UPDATE_CT, [[], 1]],
        // idempotency check passes (empty)
        [PAT_A_DETECT, []],
        [PAT_B_DETECT, []],
        // drift check FAILS — view returns non-zero residual
        [PAT_DRIFT, [{ drift: 250 }]],
      ]),
    );
    const recon = { rebuildCashboxBalance: jest.fn() };
    const svc = await buildModule({ ds, recon });

    await expect(
      svc.execute({
        confirm: EXECUTE_CONFIRM_TOKEN,
        rebuildCashboxBalance: true,
      }),
    ).rejects.toThrow(/expected drift 0/);
    // The reconcile call must NOT happen if the tx aborted.
    expect(recon.rebuildCashboxBalance).not.toHaveBeenCalled();
  });

  it('throws if idempotency self-check finds residual candidates', async () => {
    const { ds } = makeFakeDs(
      script([
        // pre-tx
        [PAT_A_DETECT, [A_CANDIDATE]],
        [PAT_A_ROWS, A_ROWS],
        [PAT_B_DETECT, []],
        [PAT_B_AMBIGUOUS, []],
        [PAT_DRIFT, [{ drift: 1000 }]],
        [PAT_BAL, [{ bal: 32930 }]],
        [PAT_EXPECTED_BAL, [{ bal: 31930 }]],
        // inside tx
        [PAT_LOCK, []],
        [PAT_SET_CTX, []],
        [PAT_A_DETECT, [A_CANDIDATE]],
        [PAT_A_ROWS, A_ROWS],
        [PAT_B_DETECT, []],
        [PAT_UPDATE_CT, [[], 1]],
        [PAT_UPDATE_CT, [[], 1]],
        // idempotency self-check returns a residual row → must throw
        [PAT_A_DETECT, [A_CANDIDATE]],
        [PAT_A_ROWS, A_ROWS],
        [PAT_B_DETECT, []],
      ]),
    );
    const svc = await buildModule({
      ds,
      recon: { rebuildCashboxBalance: jest.fn() },
    });
    await expect(
      svc.execute({
        confirm: EXECUTE_CONFIRM_TOKEN,
        rebuildCashboxBalance: false,
      }),
    ).rejects.toThrow(/idempotency check failed/);
  });
});

// ─────────────────────────────────────────────────────────────────────
//  detection rules — generalized, no hard-coded IDs
// ─────────────────────────────────────────────────────────────────────

describe('DriftHistoricalCleanupService — detection SQL contracts', () => {
  it('Pattern A SQL requires voided_je_count ≥ 1 AND active_je_count = 1 AND ct_total > active JE cash', async () => {
    const { ds, dsCalls } = makeFakeDs(
      script([
        [PAT_A_DETECT, []],
        [PAT_B_DETECT, []],
        [PAT_B_AMBIGUOUS, []],
      ]),
    );
    const svc = await buildModule({
      ds,
      recon: { rebuildCashboxBalance: jest.fn() },
    });
    await svc.dryRun();
    const aSql = dsCalls.find((c) => PAT_A_DETECT.test(c.sql))!.sql;
    expect(aSql).toMatch(/category = 'sale'/);
    expect(aSql).toMatch(/is_void = false/);
    expect(aSql).toMatch(/HAVING COUNT\(\*\) > 1/);
    expect(aSql).toMatch(/je_voided_count/);
    expect(aSql).toMatch(/je_active_count\.n = 1/);
    expect(aSql).toMatch(
      /sale_ct_total > active_je_cash\.active_je_cash_signed/,
    );
    // Generalized: no hard-coded invoice_no / invoice_id literals
    expect(aSql).not.toMatch(/INV-2026/);
  });

  it('Pattern B SQL requires r.cashbox_id IS NOT NULL AND refund_method=cash AND jl.cashbox_id IS NULL AND ambiguity guard', async () => {
    const { ds, dsCalls } = makeFakeDs(
      script([
        [PAT_A_DETECT, []],
        [PAT_B_DETECT, []],
        [PAT_B_AMBIGUOUS, []],
      ]),
    );
    const svc = await buildModule({
      ds,
      recon: { rebuildCashboxBalance: jest.fn() },
    });
    await svc.dryRun();
    const bSql = dsCalls.find((c) => PAT_B_DETECT.test(c.sql))!.sql;
    expect(bSql).toMatch(/r\.cashbox_id IS NOT NULL/);
    expect(bSql).toMatch(/r\.refund_method = 'cash'/);
    expect(bSql).toMatch(/jl\.cashbox_id IS NULL/);
    expect(bSql).toMatch(/jl\.debit = 0 AND jl\.credit > 0/);
    expect(bSql).toMatch(/ABS\(ct\.amount - jl\.credit\) < 0\.01/);
    expect(bSql).toMatch(/\) = 1/); // ambiguity guard
    expect(bSql).not.toMatch(/RET-2026/); // no hard-coded IDs
  });

  it('reports ambiguous Pattern B candidates separately and never touches them', async () => {
    const { ds, emCalls } = makeFakeDs(
      script([
        [PAT_A_DETECT, []],
        [PAT_B_DETECT, []],
        [
          PAT_B_AMBIGUOUS,
          [
            {
              return_no: 'RET-X',
              return_id: 'ret-x',
              reason:
                'multiple matching journal_lines for the active JE — skipped',
            },
          ],
        ],
      ]),
    );
    const svc = await buildModule({
      ds,
      recon: { rebuildCashboxBalance: jest.fn() },
    });
    const out = await svc.dryRun();
    expect(out.patternB.candidates).toEqual([]);
    expect(out.patternB.ambiguous).toHaveLength(1);
    expect(out.patternB.ambiguous[0].return_no).toBe('RET-X');
    for (const c of emCalls) expect(c.sql).not.toMatch(/^\s*UPDATE\s/i);
  });
});
