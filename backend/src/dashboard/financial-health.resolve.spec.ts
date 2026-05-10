/**
 * financial-health.resolve.spec.ts
 * PR-FIX-WATCHTOWER-RESOLVE-409
 *
 * Pins the operator-resolve flow against three failure modes the
 * pre-fix code suffered:
 *
 *   1. PATCH on an open anomaly with a resolved twin returned 409
 *      "Duplicate entry" because the UPDATE on `resolved` collided
 *      with the existing twin's `(type, entity, ref, TRUE)` tuple
 *      under unique index `ux_anomalies_open_slot`.  Resolve now
 *      DELETEs the open row in this case (same policy as migrations
 *      072 / 089 / 098).
 *
 *   2. PATCH on an already-resolved anomaly returned 400.  Resolve
 *      now returns the current row as a no-op success.
 *
 *   3. PATCH races (FE retry, double-tap) could leak a 23505 from
 *      concurrent UPDATEs.  Resolve now SELECTs FOR UPDATE inside
 *      a transaction so the twin check + write happen atomically.
 *
 * The spec uses a mock DataSource that records every call (sql +
 * params).  Two layers:
 *
 *   • Behavioural — drive `resolve()` and assert the SELECT / twin /
 *     UPDATE-or-DELETE call sequence + return shape for each case.
 *
 *   • Source-grep invariants — `resolve()` never INSERTs into
 *     financial_anomalies; never writes to journal_entries /
 *     cashbox_transactions / stock_movements / expenses / returns;
 *     never sets `accounting_only`.  Defence in depth so a future
 *     refactor can't quietly grow into a write path.
 */

import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { FinancialHealthService } from './financial-health.service';

// ─── Mock DataSource ──────────────────────────────────────────────

interface MockCall {
  sql: string;
  params?: any[];
}

type Handler = (call: MockCall) => any[] | Promise<any[]>;

function makeTxnMockDs(handler: Handler) {
  const calls: MockCall[] = [];
  const em = {
    query: async (sql: string, params?: any[]) => {
      const call: MockCall = { sql, params };
      calls.push(call);
      return await handler(call);
    },
  };
  const ds: any = {
    transaction: async <T,>(fn: (em: any) => Promise<T>): Promise<T> =>
      await fn(em),
    // The pre-fix code used ds.query directly — kept here so a
    // regression that bypasses the transaction would still be
    // observable in the test (calls would land here, not on em).
    query: async (sql: string, params?: any[]) => {
      const call: MockCall = { sql, params };
      calls.push({ ...call, sql: '[NON-TXN] ' + sql });
      return await handler(call);
    },
  };
  return { ds, em, calls };
}

function findCall(calls: MockCall[], pattern: RegExp): MockCall | undefined {
  return calls.find((c) => pattern.test(c.sql));
}

function findAll(calls: MockCall[], pattern: RegExp): MockCall[] {
  return calls.filter((c) => pattern.test(c.sql));
}

// ─── Behavioural tests ────────────────────────────────────────────

describe('FinancialHealthService.resolve — twin-aware operator resolve', () => {
  const USER_ID = 'user-uuid-1';

  it('open anomaly with NO resolved twin → UPDATE path returns the resolved row', async () => {
    const target = {
      anomaly_id: 100,
      anomaly_type: 'shift_variance_spike',
      affected_entity: 'shifts',
      reference_id: '42',
      resolved: false,
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
    };
    const updated = {
      ...target,
      resolved: true,
      resolved_by: USER_ID,
      resolved_at: new Date('2026-05-10T20:00:00Z'),
      resolution_note: 'all good',
    };

    const { ds, calls } = makeTxnMockDs(({ sql }) => {
      if (/^SELECT[\s\S]+FROM financial_anomalies[\s\S]+FOR UPDATE/i.test(sql))
        return [target];
      if (/SELECT anomaly_id[\s\S]+resolved\s*=\s*TRUE/i.test(sql)) return []; // no twin
      if (/^UPDATE financial_anomalies/i.test(sql)) return [updated];
      return [];
    });

    const svc = new FinancialHealthService(ds as any);
    const out = await svc.resolve(100, USER_ID, 'all good');

    expect(out).toEqual(updated);

    // Verify call sequence: SELECT-FOR-UPDATE → twin SELECT → UPDATE.
    expect(findCall(calls, /FOR UPDATE/i)).toBeDefined();
    expect(findCall(calls, /SELECT anomaly_id[\s\S]+resolved\s*=\s*TRUE/i)).toBeDefined();
    expect(findCall(calls, /^UPDATE financial_anomalies/i)).toBeDefined();
    // No DELETE in the no-twin path.
    expect(findCall(calls, /^DELETE FROM financial_anomalies/i)).toBeUndefined();
  });

  it('open anomaly WITH resolved twin → DELETE path returns resolved-shaped row, NO 409', async () => {
    const target = {
      anomaly_id: 2367,
      anomaly_type: 'legacy_bypass_journal_entry',
      affected_entity: 'journal_entries',
      reference_id: '4b644bd7-2ffe-48b6-aeda-6c82ab6775c2',
      resolved: false,
      resolved_at: null,
      resolved_by: null,
      resolution_note: null,
    };

    const { ds, calls } = makeTxnMockDs(({ sql }) => {
      if (/^SELECT[\s\S]+FROM financial_anomalies[\s\S]+FOR UPDATE/i.test(sql))
        return [target];
      if (/SELECT anomaly_id[\s\S]+resolved\s*=\s*TRUE/i.test(sql))
        return [{ anomaly_id: 1234 }]; // twin found
      if (/^DELETE FROM financial_anomalies/i.test(sql)) return [];
      return [];
    });

    const svc = new FinancialHealthService(ds as any);
    const out = await svc.resolve(2367, USER_ID);

    // Response shape: target fields preserved, resolved=true, default
    // note pointing to the auto-collapse.
    expect(out.anomaly_id).toBe(2367);
    expect(out.anomaly_type).toBe('legacy_bypass_journal_entry');
    expect(out.resolved).toBe(true);
    expect(out.resolved_by).toBe(USER_ID);
    expect(out.resolved_at).toBeInstanceOf(Date);
    expect(out.resolution_note).toMatch(/Auto-collapsed/i);

    // DELETE path was taken.
    const del = findCall(calls, /^DELETE FROM financial_anomalies/i);
    expect(del).toBeDefined();
    // DELETE targets the OPEN row, not the twin.  Migrations 072/089
    // /098 keep the resolved twin as the audit-of-record.
    expect(del?.params).toEqual([2367]);
    expect(del?.params).not.toEqual([1234]);

    // No UPDATE on the path that would have collided.
    expect(findCall(calls, /^UPDATE financial_anomalies/i)).toBeUndefined();
  });

  it('DELETE path does not delete the resolved twin row', async () => {
    const target = {
      anomaly_id: 9001,
      anomaly_type: 'legacy_bypass_journal_entry',
      affected_entity: 'cashbox_transactions',
      reference_id: '102',
      resolved: false,
    };

    const { ds, calls } = makeTxnMockDs(({ sql }) => {
      if (/^SELECT[\s\S]+FROM financial_anomalies[\s\S]+FOR UPDATE/i.test(sql))
        return [target];
      if (/SELECT anomaly_id[\s\S]+resolved\s*=\s*TRUE/i.test(sql))
        return [{ anomaly_id: 7777 }];
      return [];
    });

    const svc = new FinancialHealthService(ds as any);
    await svc.resolve(9001, USER_ID);

    // Exactly one DELETE, and its only param is the open row.
    const deletes = findAll(calls, /^DELETE FROM financial_anomalies/i);
    expect(deletes).toHaveLength(1);
    expect(deletes[0]!.params).toEqual([9001]);
    // Twin id never appears in any DELETE param list.
    for (const d of deletes) {
      expect(d.params).not.toContain(7777);
    }
  });

  it('already-resolved anomaly → no-op success, no UPDATE/DELETE issued', async () => {
    const alreadyResolved = {
      anomaly_id: 500,
      anomaly_type: 'shift_variance_spike',
      affected_entity: 'shifts',
      reference_id: '99',
      resolved: true,
      resolved_at: new Date('2026-04-01T10:00:00Z'),
      resolved_by: 'someone-else',
      resolution_note: 'previously resolved',
    };

    const { ds, calls } = makeTxnMockDs(({ sql }) => {
      if (/^SELECT[\s\S]+FROM financial_anomalies[\s\S]+FOR UPDATE/i.test(sql))
        return [alreadyResolved];
      return [];
    });

    const svc = new FinancialHealthService(ds as any);
    const out = await svc.resolve(500, USER_ID, 'noop');

    // Returns the existing row verbatim.
    expect(out).toEqual(alreadyResolved);
    // No write path executed.
    expect(findCall(calls, /^UPDATE financial_anomalies/i)).toBeUndefined();
    expect(findCall(calls, /^DELETE FROM financial_anomalies/i)).toBeUndefined();
    // Twin lookup is also skipped — short-circuit on the resolved flag.
    expect(findCall(calls, /SELECT anomaly_id[\s\S]+resolved\s*=\s*TRUE/i)).toBeUndefined();
  });

  it('missing id → BadRequestException("id required") before any DB call', async () => {
    const { ds, calls } = makeTxnMockDs(() => []);
    const svc = new FinancialHealthService(ds as any);

    await expect(svc.resolve(0, USER_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(svc.resolve(0, USER_ID)).rejects.toMatchObject({
      message: 'id required',
    });
    // No DB activity for invalid input.
    expect(calls).toHaveLength(0);
  });

  it('nonexistent id → BadRequestException("anomaly not found")', async () => {
    const { ds, calls } = makeTxnMockDs(({ sql }) => {
      if (/^SELECT[\s\S]+FROM financial_anomalies[\s\S]+FOR UPDATE/i.test(sql))
        return []; // not found
      return [];
    });
    const svc = new FinancialHealthService(ds as any);

    await expect(svc.resolve(99999, USER_ID)).rejects.toMatchObject({
      message: 'anomaly not found',
    });
    // SELECT-FOR-UPDATE was attempted, then we bailed out — no UPDATE/DELETE.
    expect(findCall(calls, /FOR UPDATE/i)).toBeDefined();
    expect(findCall(calls, /^UPDATE financial_anomalies/i)).toBeUndefined();
    expect(findCall(calls, /^DELETE FROM financial_anomalies/i)).toBeUndefined();
  });

  it('uses ds.transaction (not raw ds.query) for the resolve flow', async () => {
    let txnEntered = false;
    const target = {
      anomaly_id: 1,
      anomaly_type: 't',
      affected_entity: 'e',
      reference_id: 'r',
      resolved: false,
    };
    const ds: any = {
      transaction: async (fn: (em: any) => Promise<any>) => {
        txnEntered = true;
        return fn({
          query: async (sql: string) => {
            if (/FOR UPDATE/i.test(sql)) return [target];
            if (/SELECT anomaly_id[\s\S]+resolved\s*=\s*TRUE/i.test(sql)) return [];
            if (/^UPDATE financial_anomalies/i.test(sql)) return [{ ...target, resolved: true }];
            return [];
          },
        });
      },
      query: async () => {
        throw new Error('resolve() must run inside ds.transaction, not ds.query');
      },
    };
    const svc = new FinancialHealthService(ds);
    await svc.resolve(1, USER_ID);
    expect(txnEntered).toBe(true);
  });
});

// ─── Source-grep invariants ───────────────────────────────────────

describe('financial-health.service — resolve() write-surface invariants (PR-FIX-WATCHTOWER-RESOLVE-409)', () => {
  const SRC = readFileSync(
    resolvePath(__dirname, './financial-health.service.ts'),
    'utf8',
  );

  // Slice out the resolve() body, anchored on the function signature
  // itself (not its preceding JSDoc, which lazy-regex-matched too
  // greedily and pulled in the scanner's INSERT).  resolve() is the
  // last method in the class, so slicing to EOF covers exactly its
  // body + the class-closing brace.
  const resolveBlock = (() => {
    const sig = 'async resolve(id: number, userId: string, note?: string)';
    const start = SRC.indexOf(sig);
    if (start === -1) throw new Error('resolve() signature not located in source');
    return SRC.slice(start);
  })();

  it('resolve() does NOT INSERT into financial_anomalies', () => {
    const code = resolveBlock
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/INSERT\s+INTO\s+financial_anomalies\b/i);
  });

  it('resolve() runs inside ds.transaction with FOR UPDATE on the target', () => {
    expect(resolveBlock).toMatch(/this\.ds\.transaction\(/);
    expect(resolveBlock).toMatch(/FOR UPDATE/);
  });

  it('resolve() short-circuits on already-resolved (no UPDATE/DELETE for that case)', () => {
    expect(resolveBlock).toMatch(/if\s*\(\s*target\.resolved\s*\)\s*return\s+target/);
  });

  it('resolve() uses IS NOT DISTINCT FROM for the twin lookup (NULL-safe)', () => {
    expect(resolveBlock).toMatch(/affected_entity\s+IS\s+NOT\s+DISTINCT\s+FROM/);
    expect(resolveBlock).toMatch(/reference_id\s+IS\s+NOT\s+DISTINCT\s+FROM/);
  });

  it('resolve() DELETEs the open row when a twin exists (cleanup-twin policy)', () => {
    expect(resolveBlock).toMatch(/DELETE\s+FROM\s+financial_anomalies\s+WHERE\s+anomaly_id\s*=\s*\$1/);
  });

  it('resolve() never writes to ledger / cash / stock / expense / return tables', () => {
    const code = resolveBlock
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    for (const t of [
      'journal_entries',
      'journal_lines',
      'cashbox_transactions',
      'stock_movements',
      'expenses',
      'returns',
      'engine_bypass_alerts',
    ]) {
      const tableRe = new RegExp(`\\b(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${t}\\b`, 'i');
      expect(code).not.toMatch(tableRe);
    }
  });

  it('resolve() never uses the accounting_only escape hatch', () => {
    const code = resolveBlock
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\baccounting_only\b/);
  });
});
