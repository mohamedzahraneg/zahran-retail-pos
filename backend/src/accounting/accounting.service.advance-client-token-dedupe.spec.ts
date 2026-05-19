/**
 * accounting.service.advance-client-token-dedupe.spec.ts
 * PR-FIX-ADVANCE-EXPENSE-DEDUPE
 *
 * Pins the idempotency contract for the advance branch of
 * `AccountingService.createExpense`:
 *
 *   1. Fast-path replay — when the DTO carries a `client_token` that
 *      maps to an already-committed advance expense, the service
 *      returns the existing row WITHOUT inserting again, WITHOUT
 *      spawning approvals, and WITHOUT calling
 *      `engine.recordExpense`. No second CT or JE.
 *
 *   2. New advance — the INSERT carries `client_token` in the column
 *      list and uses `ON CONFLICT (client_token) WHERE is_advance =
 *      TRUE AND client_token IS NOT NULL DO NOTHING` so a concurrent
 *      retry that races past the pre-check is still deduplicated at
 *      the DB layer.
 *
 *   3. Race-loser recovery — if the INSERT swallows the row via ON
 *      CONFLICT (RETURNING empty), the service SELECTs the winning
 *      row by `client_token` and returns it.
 *
 *   4. Backward compatibility — the existing
 *      `source_employee_request_id` linkage path (migration 117) is
 *      untouched. A caller that uses the linked-request flow without
 *      `client_token` sees identical behaviour to before.
 *
 * The tests stub the DataSource so we can assert the SQL strings
 * emitted by the service without booting Postgres.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { AccountingService } from './accounting.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

const ADMIN = '00000000-0000-0000-0000-00000000ad00';
const EMP = '11111111-1111-1111-1111-111111111111';
const CASHBOX = '33333333-3333-3333-3333-333333333333';
const SHIFT = '44444444-4444-4444-4444-444444444444';
const CATEGORY = '55555555-5555-5555-5555-555555555555';
const WAREHOUSE = '66666666-6666-6666-6666-666666666666';
const TOKEN_A = '77777777-7777-7777-7777-777777777777';
const TOKEN_B = '88888888-8888-8888-8888-888888888888';

function makeAdvanceDto(overrides: Record<string, any> = {}) {
  return {
    warehouse_id: WAREHOUSE,
    cashbox_id: CASHBOX,
    category_id: CATEGORY,
    amount: 250,
    payment_method: 'cash',
    employee_user_id: EMP,
    is_advance: true,
    shift_id: SHIFT,
    ...overrides,
  };
}

describe('AccountingService.createExpense — PR-FIX-ADVANCE-EXPENSE-DEDUPE', () => {
  let service: AccountingService;
  let ds: { query: jest.Mock; transaction: jest.Mock };
  let em: { query: jest.Mock };
  let engine: { recordExpense: jest.Mock; recordTransaction: jest.Mock };

  beforeEach(async () => {
    em = { query: jest.fn() };
    ds = {
      query: jest.fn(),
      transaction: jest.fn(async (cb: any) => cb(em)),
    };
    engine = {
      recordExpense: jest.fn(),
      recordTransaction: jest.fn(),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        AccountingService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    service = moduleRef.get(AccountingService);
  });

  // Stub the shift-validation query that runs first whenever shift_id
  // is supplied. Returns an "open" shift on the requested cashbox.
  function stubShiftResolution() {
    em.query.mockResolvedValueOnce([
      { id: SHIFT, status: 'open', cashbox_id: CASHBOX },
    ]);
  }

  // ────────────────────────────────────────────────────────────────
  // 1. FAST-PATH REPLAY — token already maps to an existing row
  // ────────────────────────────────────────────────────────────────
  it('fast-path replay: existing advance with same client_token → return existing, no INSERT, no engine call', async () => {
    const existingRow = {
      id: 'existing-exp-uuid',
      expense_no: 'EXP-2026-0001',
      amount: 250,
      is_advance: true,
      client_token: TOKEN_A,
      cashbox_id: CASHBOX,
    };

    // The pre-check fires FIRST inside the transaction — before
    // shift validation, before any other side effect.
    em.query.mockResolvedValueOnce([existingRow]);

    const result = await service.createExpense(
      makeAdvanceDto({ client_token: TOKEN_A }) as any,
      ADMIN,
    );

    expect(result).toBe(existingRow);

    // Only ONE em.query call (the pre-check SELECT). No INSERT, no
    // approve, no engine call.
    expect(em.query).toHaveBeenCalledTimes(1);
    const preCheckSql = String(em.query.mock.calls[0][0]);
    expect(preCheckSql).toContain('SELECT * FROM expenses');
    expect(preCheckSql).toContain('client_token');
    expect(preCheckSql).toContain('is_advance = TRUE');
    expect(em.query.mock.calls[0][1]).toEqual([TOKEN_A]);

    // No INSERT, no engine call.
    const insertCalls = em.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    expect(insertCalls).toHaveLength(0);
    expect(engine.recordExpense).not.toHaveBeenCalled();
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────
  // 2. NEW ADVANCE WITH CLIENT_TOKEN — full flow with INSERT carrying
  //    the token + ON CONFLICT clause
  // ────────────────────────────────────────────────────────────────
  it('new advance: INSERT carries client_token and uses ON CONFLICT DO NOTHING on the partial index', async () => {
    // Pre-check returns nothing (no replay).
    em.query.mockResolvedValueOnce([]);
    // Then the existing flow stubs.
    stubShiftResolution();
    em.query.mockResolvedValueOnce([
      {
        id: 'new-exp-uuid',
        expense_no: 'EXP-2026-0002',
        amount: 250,
        is_advance: true,
        client_token: TOKEN_A,
        cashbox_id: CASHBOX,
        category_id: CATEGORY,
      },
    ]); // INSERT … RETURNING *
    em.query.mockResolvedValueOnce([]); // UPDATE expenses SET is_approved
    em.query.mockResolvedValueOnce([
      { account_id: '99999999-9999-9999-9999-999999999999' },
    ]); // SELECT account_id FROM expense_categories (legacy resolver fallback)
    engine.recordExpense.mockResolvedValueOnce({
      ok: true,
      entry_id: 'je-uuid',
    });

    const result = await service.createExpense(
      makeAdvanceDto({ client_token: TOKEN_A }) as any,
      ADMIN,
    );

    // The INSERT call must include client_token in the column list,
    // the matching ON CONFLICT predicate, and the token in the params.
    const insertCall = em.query.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    expect(insertCall).toBeTruthy();
    const insertSql = String(insertCall![0]);
    expect(insertSql).toContain('client_token');
    expect(insertSql).toMatch(/ON CONFLICT\s*\(client_token\)/i);
    expect(insertSql).toMatch(/WHERE\s+is_advance\s*=\s*TRUE/i);
    expect(insertSql).toMatch(/AND\s+client_token\s+IS\s+NOT\s+NULL/i);
    expect(insertSql).toMatch(/DO NOTHING/i);

    // Last positional param is the client_token.
    const insertParams = insertCall![1] as any[];
    expect(insertParams[insertParams.length - 1]).toBe(TOKEN_A);

    // Engine called exactly once for the new advance.
    expect(engine.recordExpense).toHaveBeenCalledTimes(1);

    // Returned the new row.
    expect(result).toMatchObject({
      id: 'new-exp-uuid',
      client_token: TOKEN_A,
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 3. RACE-LOSER PATH — INSERT swallowed by ON CONFLICT, recovery
  //    SELECT returns the winning row
  // ────────────────────────────────────────────────────────────────
  it('race-loser recovery: when INSERT returns no row, SELECT the winner by client_token and return it WITHOUT engine call', async () => {
    const winnerRow = {
      id: 'winner-exp-uuid',
      expense_no: 'EXP-2026-0003',
      amount: 250,
      is_advance: true,
      client_token: TOKEN_A,
    };

    em.query.mockResolvedValueOnce([]); // pre-check finds nothing
    stubShiftResolution();
    em.query.mockResolvedValueOnce([]); // INSERT … RETURNING * → empty (conflict)
    em.query.mockResolvedValueOnce([winnerRow]); // recovery SELECT

    const result = await service.createExpense(
      makeAdvanceDto({ client_token: TOKEN_A }) as any,
      ADMIN,
    );

    expect(result).toBe(winnerRow);
    // Engine never called — the side effects were posted by the
    // concurrent winner; doing it again would double-post.
    expect(engine.recordExpense).not.toHaveBeenCalled();

    // Recovery SELECT used the right key.
    const recoveryCall = em.query.mock.calls.find(
      (c, i) => i > 0 && /SELECT \* FROM expenses[\s\S]*client_token/i.test(String(c[0])),
    );
    expect(recoveryCall).toBeTruthy();
    expect(recoveryCall![1]).toEqual([TOKEN_A]);
  });

  // ────────────────────────────────────────────────────────────────
  // 4. NO TOKEN — pre-check is SKIPPED so legacy flow is unaffected
  // ────────────────────────────────────────────────────────────────
  it('no client_token: pre-check is skipped; existing flow runs untouched', async () => {
    // No pre-check SELECT. First query is shift validation.
    stubShiftResolution();
    em.query.mockResolvedValueOnce([
      {
        id: 'legacy-exp-uuid',
        expense_no: 'EXP-2026-0004',
        amount: 250,
        is_advance: true,
        client_token: null,
      },
    ]); // INSERT
    em.query.mockResolvedValueOnce([]); // UPDATE is_approved
    em.query.mockResolvedValueOnce([
      { account_id: '99999999-9999-9999-9999-999999999999' },
    ]); // category account
    engine.recordExpense.mockResolvedValueOnce({
      ok: true,
      entry_id: 'je-uuid',
    });

    await service.createExpense(makeAdvanceDto() as any, ADMIN);

    // The very first em.query MUST be the shift validation, not a
    // client_token SELECT.
    const firstSql = String(em.query.mock.calls[0][0]);
    expect(firstSql).toContain('FROM shifts');
    expect(firstSql).not.toContain('client_token');

    // INSERT still carries client_token column (always present in
    // the schema since migration 140), but the param is NULL.
    const insertCall = em.query.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO expenses'),
    );
    expect(insertCall).toBeTruthy();
    const insertParams = insertCall![1] as any[];
    expect(insertParams[insertParams.length - 1]).toBeNull();

    expect(engine.recordExpense).toHaveBeenCalledTimes(1);
  });

  // ────────────────────────────────────────────────────────────────
  // 5. BACKWARD COMPAT — source_employee_request_id flow without token
  //    behaves exactly as before
  // ────────────────────────────────────────────────────────────────
  it('legacy source_employee_request_id flow (no client_token): unchanged behaviour, both validations + INSERT + engine + status flip', async () => {
    stubShiftResolution();
    em.query.mockResolvedValueOnce([
      {
        id: 7,
        user_id: EMP,
        kind: 'advance_request',
        status: 'approved',
        amount: '250',
      },
    ]); // SELECT FOR UPDATE employee_requests
    em.query.mockResolvedValueOnce([]); // no existing link
    em.query.mockResolvedValueOnce([
      {
        id: 'linked-exp-uuid',
        expense_no: 'EXP-2026-0005',
        amount: 250,
        source_employee_request_id: 7,
        is_advance: true,
        client_token: null,
      },
    ]); // INSERT
    em.query.mockResolvedValueOnce([]); // UPDATE is_approved
    em.query.mockResolvedValueOnce([
      { account_id: '99999999-9999-9999-9999-999999999999' },
    ]); // category account
    engine.recordExpense.mockResolvedValueOnce({
      ok: true,
      entry_id: 'je-uuid',
    });
    em.query.mockResolvedValueOnce([{ id: 7 }]); // UPDATE employee_requests SET status='disbursed'

    const result = await service.createExpense(
      makeAdvanceDto({ source_employee_request_id: 7 }) as any,
      ADMIN,
    );

    // First em.query is shift validation (NOT a client_token check).
    expect(String(em.query.mock.calls[0][0])).toContain('FROM shifts');

    // Migration 117's existing FOR UPDATE lock is still there.
    const lockCall = em.query.mock.calls.find((c) =>
      /employee_requests[\s\S]*FOR UPDATE/.test(String(c[0])),
    );
    expect(lockCall).toBeTruthy();

    // Status flip ran after engine success.
    const flipCall = em.query.mock.calls.find((c) =>
      /UPDATE employee_requests[\s\S]*'disbursed'/.test(String(c[0])),
    );
    expect(flipCall).toBeTruthy();

    expect(engine.recordExpense).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      source_employee_request_id: 7,
      client_token: null,
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 6. BOTH IDEMPOTENCY KEYS — token AND source_request — coexist
  // ────────────────────────────────────────────────────────────────
  it('caller may send BOTH client_token AND source_employee_request_id: replay returns existing row without re-validating request', async () => {
    const existingRow = {
      id: 'existing-linked-exp-uuid',
      amount: 250,
      is_advance: true,
      client_token: TOKEN_A,
      source_employee_request_id: 7,
    };
    em.query.mockResolvedValueOnce([existingRow]);

    const result = await service.createExpense(
      makeAdvanceDto({
        client_token: TOKEN_A,
        source_employee_request_id: 7,
      }) as any,
      ADMIN,
    );

    expect(result).toBe(existingRow);

    // The replay short-circuit ran BEFORE the source_request
    // validation — we never hit the employee_requests SELECT FOR
    // UPDATE on a replay.
    const lockCall = em.query.mock.calls.find((c) =>
      /employee_requests[\s\S]*FOR UPDATE/.test(String(c[0])),
    );
    expect(lockCall).toBeUndefined();

    expect(engine.recordExpense).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────
  // 7. DIFFERENT TOKENS — two separate advances commit independently
  // ────────────────────────────────────────────────────────────────
  it('different client_tokens produce two independent advances', async () => {
    // First call with TOKEN_A — pre-check empty, full flow. Returning
    // category_id on the INSERT row triggers the legacy account_id
    // fallback inside postViaEngine, so the next em.query stub is
    // consumed predictably and the second call starts on a clean slate.
    em.query.mockResolvedValueOnce([]); // pre-check
    stubShiftResolution();
    em.query.mockResolvedValueOnce([
      { id: 'exp-A', is_advance: true, client_token: TOKEN_A, category_id: CATEGORY },
    ]);
    em.query.mockResolvedValueOnce([]); // UPDATE is_approved
    em.query.mockResolvedValueOnce([
      { account_id: '99999999-9999-9999-9999-999999999999' },
    ]); // SELECT account_id (legacy fallback)
    engine.recordExpense.mockResolvedValueOnce({ ok: true, entry_id: 'je-A' });

    const a = await service.createExpense(
      makeAdvanceDto({ client_token: TOKEN_A }) as any,
      ADMIN,
    );

    // Second call with TOKEN_B — pre-check empty, full flow.
    em.query.mockResolvedValueOnce([]); // pre-check
    stubShiftResolution();
    em.query.mockResolvedValueOnce([
      { id: 'exp-B', is_advance: true, client_token: TOKEN_B, category_id: CATEGORY },
    ]);
    em.query.mockResolvedValueOnce([]); // UPDATE is_approved
    em.query.mockResolvedValueOnce([
      { account_id: '99999999-9999-9999-9999-999999999999' },
    ]); // SELECT account_id
    engine.recordExpense.mockResolvedValueOnce({ ok: true, entry_id: 'je-B' });

    const b = await service.createExpense(
      makeAdvanceDto({ client_token: TOKEN_B }) as any,
      ADMIN,
    );

    expect(a).toMatchObject({ id: 'exp-A', client_token: TOKEN_A });
    expect(b).toMatchObject({ id: 'exp-B', client_token: TOKEN_B });
    expect(engine.recordExpense).toHaveBeenCalledTimes(2);
  });

  // ────────────────────────────────────────────────────────────────
  // 8. DEFENSIVE — INSERT returns nothing AND we have no token to
  //    recover with → BadRequestException, no engine call
  // ────────────────────────────────────────────────────────────────
  it('defensive: no token + INSERT returns nothing → BadRequestException, no engine call', async () => {
    stubShiftResolution();
    em.query.mockResolvedValueOnce([]); // INSERT … RETURNING * → empty (should never happen without ON CONFLICT firing)

    await expect(
      service.createExpense(makeAdvanceDto() as any, ADMIN),
    ).rejects.toThrow(BadRequestException);

    expect(engine.recordExpense).not.toHaveBeenCalled();
  });
});
