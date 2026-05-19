/**
 * employees.service.settlement-client-token-dedupe.spec.ts
 * PR-FIX-SETTLEMENT-DEDUPE
 *
 * Pins the idempotency contract for
 * `EmployeesService.recordSettlement`:
 *
 *   1. Fast-path replay — when the DTO carries a `client_token`
 *      that maps to an already-committed (non-voided) settlement,
 *      return the existing row WITHOUT inserting again, WITHOUT
 *      writing a new cashbox_transaction, and WITHOUT calling
 *      `engine.recordTransaction`. No second CT or JE.
 *
 *   2. New settlement — the INSERT carries `client_token` in the
 *      column list and uses `ON CONFLICT (client_token) WHERE
 *      client_token IS NOT NULL AND is_void = FALSE DO NOTHING`
 *      so a concurrent retry that races past the pre-check is
 *      still deduplicated at the DB layer.
 *
 *   3. Race-loser recovery — if the INSERT swallows the row via
 *      ON CONFLICT (RETURNING empty), the service SELECTs the
 *      winning row by `client_token` and returns it. Engine is NOT
 *      re-invoked.
 *
 *   4. Backward compatibility — a caller that doesn't send
 *      `client_token` sees identical behaviour to before. The
 *      internal `attendance.payWage` orchestrator depends on this:
 *      it triggers two settlements per call (payable leg + bonus
 *      leg) without supplying tokens.
 *
 * The tests stub the DataSource so we can assert the SQL strings
 * emitted by the service without booting Postgres.
 */

import { Test } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { BadRequestException } from '@nestjs/common';
import { EmployeesService } from './employees.service';
import { FinancialEngineService } from '../chart-of-accounts/financial-engine.service';

const ADMIN = '00000000-0000-0000-0000-00000000ad00';
const EMP = '11111111-1111-1111-1111-111111111111';
const CASHBOX = '33333333-3333-3333-3333-333333333333';
const TOKEN_A = '77777777-7777-7777-7777-777777777777';
const TOKEN_B = '88888888-8888-8888-8888-888888888888';

describe('EmployeesService.recordSettlement — PR-FIX-SETTLEMENT-DEDUPE', () => {
  let service: EmployeesService;
  let ds: { query: jest.Mock; transaction: jest.Mock };
  let em: { query: jest.Mock };
  let engine: { recordTransaction: jest.Mock };

  beforeEach(async () => {
    em = { query: jest.fn() };
    ds = {
      query: jest.fn(),
      transaction: jest.fn(async (cb: any) => cb(em)),
    };
    engine = { recordTransaction: jest.fn() };

    const moduleRef = await Test.createTestingModule({
      providers: [
        EmployeesService,
        { provide: DataSource, useValue: ds },
        { provide: FinancialEngineService, useValue: engine },
      ],
    }).compile();
    service = moduleRef.get(EmployeesService);
  });

  // Common DTO factory — direct-cashbox cash settlement, the most
  // common path through the modal.
  function makeDto(overrides: Record<string, any> = {}) {
    return {
      amount: 100,
      method: 'cash' as const,
      cashbox_id: CASHBOX,
      ...overrides,
    };
  }

  // ────────────────────────────────────────────────────────────────
  // 1. FAST-PATH REPLAY — token already maps to an existing row
  // ────────────────────────────────────────────────────────────────
  it('fast-path replay: existing settlement with same client_token → return existing, no INSERT, no engine call', async () => {
    const existingRow = {
      id: 7,
      amount: 100,
      method: 'cash',
      cashbox_id: CASHBOX,
      client_token: TOKEN_A,
      journal_entry_id: 'existing-je-uuid',
    };

    // The pre-check fires FIRST inside the transaction.
    em.query.mockResolvedValueOnce([existingRow]);

    const result = await service.recordSettlement(
      EMP,
      makeDto({ client_token: TOKEN_A }),
      ADMIN,
      ['employees.settlement.direct_cashbox'],
    );

    expect(result).toBe(existingRow);

    // Only ONE em.query call (the pre-check SELECT). No INSERT,
    // no UPDATE, no engine call.
    expect(em.query).toHaveBeenCalledTimes(1);
    const preCheckSql = String(em.query.mock.calls[0][0]);
    expect(preCheckSql).toContain('SELECT * FROM employee_settlements');
    expect(preCheckSql).toContain('client_token');
    expect(preCheckSql).toContain('is_void = FALSE');
    expect(em.query.mock.calls[0][1]).toEqual([TOKEN_A]);

    const insertCalls = em.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO employee_settlements'),
    );
    expect(insertCalls).toHaveLength(0);
    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });

  // ────────────────────────────────────────────────────────────────
  // 2. NEW SETTLEMENT WITH CLIENT_TOKEN — full flow with INSERT
  //    carrying the token + ON CONFLICT clause
  // ────────────────────────────────────────────────────────────────
  it('new settlement: INSERT carries client_token and uses ON CONFLICT DO NOTHING on the partial index', async () => {
    // Pre-check returns nothing (no replay).
    em.query.mockResolvedValueOnce([]);
    // INSERT … RETURNING * — returns the new row.
    em.query.mockResolvedValueOnce([
      { id: 8, amount: 100, method: 'cash', client_token: TOKEN_A },
    ]);
    // SELECT uuid_generate_v5 … AS ref
    em.query.mockResolvedValueOnce([{ ref: 'derived-ref-uuid' }]);
    // UPDATE employee_settlements SET journal_entry_id = …
    em.query.mockResolvedValueOnce([]);
    engine.recordTransaction.mockResolvedValueOnce({
      ok: true,
      entry_id: 'new-je-uuid',
    });

    await service.recordSettlement(
      EMP,
      makeDto({ client_token: TOKEN_A }),
      ADMIN,
      ['employees.settlement.direct_cashbox'],
    );

    // The INSERT call must include client_token in the column list,
    // the matching ON CONFLICT predicate, and the token in the params.
    const insertCall = em.query.mock.calls.find((c) =>
      String(c[0]).includes('INSERT INTO employee_settlements'),
    );
    expect(insertCall).toBeTruthy();
    const insertSql = String(insertCall![0]);
    expect(insertSql).toContain('client_token');
    expect(insertSql).toMatch(/ON CONFLICT\s*\(client_token\)/i);
    expect(insertSql).toMatch(/WHERE\s+client_token\s+IS\s+NOT\s+NULL/i);
    expect(insertSql).toMatch(/AND\s+is_void\s*=\s*FALSE/i);
    expect(insertSql).toMatch(/DO NOTHING/i);

    // Last positional param is the client_token.
    const insertParams = insertCall![1] as any[];
    expect(insertParams[insertParams.length - 1]).toBe(TOKEN_A);

    // Engine called exactly once for the new settlement.
    expect(engine.recordTransaction).toHaveBeenCalledTimes(1);
    const engineArgs = engine.recordTransaction.mock.calls[0][0];
    // The engine writes the JE + paired CT exactly once.
    expect(engineArgs.cash_movements).toHaveLength(1);
    expect(engineArgs.cash_movements[0]).toMatchObject({
      direction: 'out',
      category: 'employee_settlement',
    });
  });

  // ────────────────────────────────────────────────────────────────
  // 3. RACE-LOSER PATH — INSERT swallowed by ON CONFLICT, recovery
  //    SELECT returns the winning row WITHOUT engine call
  // ────────────────────────────────────────────────────────────────
  it('race-loser recovery: when INSERT returns no row, SELECT the winner by client_token and return it WITHOUT engine call', async () => {
    const winnerRow = {
      id: 9,
      amount: 100,
      method: 'cash',
      client_token: TOKEN_A,
      journal_entry_id: 'winner-je-uuid',
    };

    em.query.mockResolvedValueOnce([]); // pre-check finds nothing
    em.query.mockResolvedValueOnce([]); // INSERT … RETURNING * → empty (conflict)
    em.query.mockResolvedValueOnce([winnerRow]); // recovery SELECT

    const result = await service.recordSettlement(
      EMP,
      makeDto({ client_token: TOKEN_A }),
      ADMIN,
      ['employees.settlement.direct_cashbox'],
    );

    expect(result).toBe(winnerRow);
    // Engine NOT called — the side effects were posted by the
    // concurrent winner; doing it again would double-post.
    expect(engine.recordTransaction).not.toHaveBeenCalled();

    // No cashbox transaction written through the engine, so no
    // second `direction: out` movement on the cashbox.
    expect(engine.recordTransaction).not.toHaveBeenCalled();

    // Recovery SELECT used the right key.
    const recoveryCall = em.query.mock.calls
      .slice(1)
      .find((c) => /SELECT \* FROM employee_settlements[\s\S]*client_token/i.test(String(c[0])));
    expect(recoveryCall).toBeTruthy();
    expect(recoveryCall![1]).toEqual([TOKEN_A]);
  });

  // ────────────────────────────────────────────────────────────────
  // 4. NO TOKEN — pre-check is SKIPPED, legacy flow runs untouched
  // ────────────────────────────────────────────────────────────────
  it('no client_token: pre-check is skipped; existing flow runs untouched (engine called, JE linked)', async () => {
    em.query.mockResolvedValueOnce([
      { id: 10, amount: 100, method: 'cash', client_token: null },
    ]); // INSERT
    em.query.mockResolvedValueOnce([{ ref: 'derived-ref-uuid' }]); // SELECT uuid_generate_v5
    em.query.mockResolvedValueOnce([]); // UPDATE journal_entry_id
    engine.recordTransaction.mockResolvedValueOnce({
      ok: true,
      entry_id: 'new-je-uuid',
    });

    await service.recordSettlement(
      EMP,
      makeDto(),
      ADMIN,
      ['employees.settlement.direct_cashbox'],
    );

    // The very first em.query MUST be the INSERT, not a
    // client_token pre-check SELECT.
    expect(String(em.query.mock.calls[0][0])).toContain(
      'INSERT INTO employee_settlements',
    );

    // INSERT still carries client_token column (always present in
    // the schema since migration 141), but the param is NULL.
    const insertCall = em.query.mock.calls[0];
    const insertParams = insertCall[1] as any[];
    expect(insertParams[insertParams.length - 1]).toBeNull();

    // Engine called exactly once — legacy semantics preserved.
    expect(engine.recordTransaction).toHaveBeenCalledTimes(1);
  });

  // ────────────────────────────────────────────────────────────────
  // 5. DIFFERENT TOKENS — two separate settlements commit independently
  // ────────────────────────────────────────────────────────────────
  it('different client_tokens produce two independent settlements (each writes its own CT + JE)', async () => {
    // First call with TOKEN_A — full flow.
    em.query.mockResolvedValueOnce([]); // pre-check
    em.query.mockResolvedValueOnce([
      { id: 11, amount: 100, method: 'cash', client_token: TOKEN_A },
    ]);
    em.query.mockResolvedValueOnce([{ ref: 'ref-A' }]);
    em.query.mockResolvedValueOnce([]);
    engine.recordTransaction.mockResolvedValueOnce({ ok: true, entry_id: 'je-A' });

    const a = await service.recordSettlement(
      EMP,
      makeDto({ client_token: TOKEN_A }),
      ADMIN,
      ['employees.settlement.direct_cashbox'],
    );

    // Second call with TOKEN_B — full flow.
    em.query.mockResolvedValueOnce([]); // pre-check
    em.query.mockResolvedValueOnce([
      { id: 12, amount: 100, method: 'cash', client_token: TOKEN_B },
    ]);
    em.query.mockResolvedValueOnce([{ ref: 'ref-B' }]);
    em.query.mockResolvedValueOnce([]);
    engine.recordTransaction.mockResolvedValueOnce({ ok: true, entry_id: 'je-B' });

    const b = await service.recordSettlement(
      EMP,
      makeDto({ client_token: TOKEN_B }),
      ADMIN,
      ['employees.settlement.direct_cashbox'],
    );

    expect(a).toMatchObject({ id: 11, client_token: TOKEN_A });
    expect(b).toMatchObject({ id: 12, client_token: TOKEN_B });
    // Two engine calls — one per settlement.
    expect(engine.recordTransaction).toHaveBeenCalledTimes(2);
  });

  // ────────────────────────────────────────────────────────────────
  // 6. DOUBLE SUBMIT — two consecutive calls with the SAME token
  //    write at most one CT + one JE (the second call short-circuits)
  // ────────────────────────────────────────────────────────────────
  it('double submit with same client_token: ONE settlement row, ONE engine call, ONE cashbox transaction', async () => {
    const insertedRow = {
      id: 13,
      amount: 100,
      method: 'cash',
      client_token: TOKEN_A,
      journal_entry_id: null,
    };

    // First call — pre-check empty, full flow.
    em.query.mockResolvedValueOnce([]); // pre-check
    em.query.mockResolvedValueOnce([insertedRow]); // INSERT
    em.query.mockResolvedValueOnce([{ ref: 'ref-A' }]); // SELECT ref
    em.query.mockResolvedValueOnce([]); // UPDATE journal_entry_id
    engine.recordTransaction.mockResolvedValueOnce({
      ok: true,
      entry_id: 'je-A',
    });

    await service.recordSettlement(
      EMP,
      makeDto({ client_token: TOKEN_A }),
      ADMIN,
      ['employees.settlement.direct_cashbox'],
    );

    // Second call (the "double-click") — pre-check now finds the
    // existing row → short-circuit.
    em.query.mockResolvedValueOnce([
      { ...insertedRow, journal_entry_id: 'je-A' },
    ]);

    await service.recordSettlement(
      EMP,
      makeDto({ client_token: TOKEN_A }),
      ADMIN,
      ['employees.settlement.direct_cashbox'],
    );

    // ONLY ONE engine call across the two submits. So at most one
    // JE, at most one cashbox movement.
    expect(engine.recordTransaction).toHaveBeenCalledTimes(1);
    const engineArgs = engine.recordTransaction.mock.calls[0][0];
    expect(engineArgs.cash_movements).toHaveLength(1);
    expect(engineArgs.cash_movements[0].direction).toBe('out');

    // Exactly one INSERT — the second call never reached the INSERT
    // because the pre-check short-circuited.
    const insertCalls = em.query.mock.calls.filter((c) =>
      String(c[0]).includes('INSERT INTO employee_settlements'),
    );
    expect(insertCalls).toHaveLength(1);
  });

  // ────────────────────────────────────────────────────────────────
  // 7. IDEMPOTENCY KEY DOES NOT DERIVE FROM POST-INSERT id
  //    Regression guard: the pre-check uses client_token (caller-
  //    supplied) NOT the BIGSERIAL id (generated AFTER insert),
  //    which was the root-cause of the previous gap.
  // ────────────────────────────────────────────────────────────────
  it('pre-check key is the caller-supplied client_token, not the BIGSERIAL id', async () => {
    em.query.mockResolvedValueOnce([
      { id: 14, amount: 100, client_token: TOKEN_A },
    ]);

    await service.recordSettlement(
      EMP,
      makeDto({ client_token: TOKEN_A }),
      ADMIN,
      ['employees.settlement.direct_cashbox'],
    );

    // The pre-check param list is just [client_token]. If a future
    // refactor accidentally keys on something else (row.id, a derived
    // uuid, the amount, etc.) this assertion fails loudly.
    expect(em.query.mock.calls[0][1]).toEqual([TOKEN_A]);
  });

  // ────────────────────────────────────────────────────────────────
  // 8. DEFENSIVE — INSERT returns nothing AND we have no token to
  //    recover with → BadRequestException, no engine call
  // ────────────────────────────────────────────────────────────────
  it('defensive: no token + INSERT returns nothing → BadRequestException, no engine call', async () => {
    em.query.mockResolvedValueOnce([]); // INSERT … RETURNING * → empty (should never happen without ON CONFLICT firing)

    await expect(
      service.recordSettlement(
        EMP,
        makeDto(),
        ADMIN,
        ['employees.settlement.direct_cashbox'],
      ),
    ).rejects.toThrow(BadRequestException);

    expect(engine.recordTransaction).not.toHaveBeenCalled();
  });
});
