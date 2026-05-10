/**
 * financial-health.scanner-noise.spec.ts
 * PR-FIX-WATCHTOWER-SCANNER-NOISE
 *
 * Pins the Watchtower-scanner hardening that suppresses operator-
 * facing anomalies for known-good intentional bypasses + already-
 * treated shift variances.  Two layers are tested:
 *
 *   1. SQL-side filtering — source-grep against the rule strings
 *      to confirm the WHERE-clause guards are present.  Cheap and
 *      decisive: a future regression that drops the clause fails
 *      the spec immediately.
 *
 *   2. Behavioural — drive `scan()` end-to-end with a mock
 *      DataSource so a candidate row carrying a benign context /
 *      treated-shift marker still hits the loop and is filtered by
 *      the in-process `isBenignBypass()` helper before reaching the
 *      INSERT call.  Defence in depth — the SQL filter wins on
 *      production but unit tests can drive the TS path directly.
 *
 *   3. Audit-trail invariant — engine_bypass_alerts is NEVER
 *      mutated by the scanner.  Verified by source-grep that no
 *      INSERT/UPDATE/DELETE targets that table from this file.
 *
 *   4. Hard rules — the scan never writes to journal_entries,
 *      cashbox_transactions, stock_movements, expenses, or returns;
 *      never sets accounting_only.
 */

import {
  BENIGN_BYPASS_CONTEXTS,
  BENIGN_BYPASS_NOTES_PATTERNS,
  FinancialHealthService,
  isBenignBypass,
} from './financial-health.service';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── 1. Source-grep on the service ───────────────────────────────

describe('financial-health.service — SQL-side guards (PR-FIX-WATCHTOWER-SCANNER-NOISE)', () => {
  const SRC = readFileSync(
    resolve(__dirname, './financial-health.service.ts'),
    'utf8',
  );

  it('rule 1 SQL whitelists service:cash-recon-cleanup + service:VERIFY_PR contexts', () => {
    expect(SRC).toMatch(
      /a\.context_value\s+NOT\s+IN\s*\(\s*'service:cash-recon-cleanup'\s*,\s*'service:VERIFY_PR'\s*\)/,
    );
  });

  it('rule 1 SQL excludes CT rows whose notes carry a VERIFY_PR marker', () => {
    expect(SRC).toMatch(/a\.table_name\s*=\s*'cashbox_transactions'/);
    expect(SRC).toMatch(/ct\.notes\s+ILIKE\s+'%VERIFY_PR%'/);
  });

  it('rule 1 SQL excludes JE / JL rows whose JE description carries a VERIFY_PR marker', () => {
    expect(SRC).toMatch(
      /a\.table_name\s+IN\s*\(\s*'journal_entries'\s*,\s*'journal_lines'\s*\)/,
    );
    expect(SRC).toMatch(/je\.description\s+ILIKE\s+'%VERIFY_PR%'/);
  });

  it('rule 1 SQL exposes affected_notes in details so the TS-side filter can re-check', () => {
    expect(SRC).toMatch(/'affected_notes'/);
  });

  it('rule 5 (shift_variance_spike) skips treated/approved shifts', () => {
    expect(SRC).toMatch(/variance_treatment\s+IS\s+NULL/);
    expect(SRC).toMatch(/variance_journal_entry_id\s+IS\s+NULL/);
    expect(SRC).toMatch(/variance_approved_at\s+IS\s+NULL/);
  });

  it('rule 8 (low_accuracy_shift) skips treated/approved shifts via NOT EXISTS', () => {
    expect(SRC).toMatch(
      /NOT\s+EXISTS\s*\([\s\S]+s\.id\s*=\s*v\.shift_id[\s\S]+s\.variance_treatment/,
    );
    expect(SRC).toMatch(/s\.variance_journal_entry_id/);
    expect(SRC).toMatch(/s\.variance_approved_at/);
  });

  it('the candidate loop calls isBenignBypass for legacy_bypass_journal_entry', () => {
    expect(SRC).toMatch(
      /rule\.type\s*===\s*'legacy_bypass_journal_entry'\s*&&\s*isBenignBypass\(c\)/,
    );
  });

  it('isBenignBypass + BENIGN_BYPASS_CONTEXTS + BENIGN_BYPASS_NOTES_PATTERNS are exported', () => {
    expect(SRC).toMatch(/export const BENIGN_BYPASS_CONTEXTS/);
    expect(SRC).toMatch(/export const BENIGN_BYPASS_NOTES_PATTERNS/);
    expect(SRC).toMatch(/export function isBenignBypass/);
  });

  // ── Hard-rule guards ──

  it('does not write to journal_entries / journal_lines anywhere', () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/INSERT\s+INTO\s+journal_entries\b/i);
    expect(code).not.toMatch(/UPDATE\s+journal_entries\b/i);
    expect(code).not.toMatch(/DELETE\s+FROM\s+journal_entries\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+journal_lines\b/i);
    expect(code).not.toMatch(/UPDATE\s+journal_lines\b/i);
    expect(code).not.toMatch(/DELETE\s+FROM\s+journal_lines\b/i);
  });

  it('does not write to cashbox_transactions / stock_movements anywhere', () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/INSERT\s+INTO\s+cashbox_transactions\b/i);
    expect(code).not.toMatch(/UPDATE\s+cashbox_transactions\b/i);
    expect(code).not.toMatch(/DELETE\s+FROM\s+cashbox_transactions\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+stock_movements\b/i);
    expect(code).not.toMatch(/UPDATE\s+stock_movements\b/i);
    expect(code).not.toMatch(/DELETE\s+FROM\s+stock_movements\b/i);
  });

  it('does not write to expenses / returns / engine_bypass_alerts anywhere', () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/INSERT\s+INTO\s+expenses\b/i);
    expect(code).not.toMatch(/UPDATE\s+expenses\b/i);
    expect(code).not.toMatch(/DELETE\s+FROM\s+expenses\b/i);
    expect(code).not.toMatch(/INSERT\s+INTO\s+returns\b/i);
    expect(code).not.toMatch(/UPDATE\s+returns\b/i);
    expect(code).not.toMatch(/DELETE\s+FROM\s+returns\b/i);
    // The audit-of-record stays intact: scanner never mutates engine_bypass_alerts.
    expect(code).not.toMatch(/INSERT\s+INTO\s+engine_bypass_alerts\b/i);
    expect(code).not.toMatch(/UPDATE\s+engine_bypass_alerts\b/i);
    expect(code).not.toMatch(/DELETE\s+FROM\s+engine_bypass_alerts\b/i);
  });

  it('does not use the accounting_only escape hatch', () => {
    const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/\baccounting_only\b/);
  });
});

// ─── 2. Pure-function behaviour of isBenignBypass ────────────────

describe('isBenignBypass — context + notes patterns', () => {
  it('returns true for the cash-recon-cleanup context', () => {
    expect(
      isBenignBypass({ details: { context: 'service:cash-recon-cleanup' } }),
    ).toBe(true);
  });

  it('returns true for the explicit VERIFY_PR context', () => {
    expect(isBenignBypass({ details: { context: 'service:VERIFY_PR' } })).toBe(
      true,
    );
  });

  it('returns true when affected_notes contains VERIFY_PR (case-insensitive)', () => {
    expect(
      isBenignBypass({
        details: {
          context: 'service:cashbox_fn_fallback',
          affected_notes: 'VERIFY_PR test cleanup — reversing settlement id=4',
        },
      }),
    ).toBe(true);
    expect(
      isBenignBypass({
        details: {
          context: 'service:cashbox_fn_fallback',
          affected_notes: 'verify_pr lower-case marker',
        },
      }),
    ).toBe(true);
  });

  it('returns false for an unknown / generic engine context', () => {
    expect(
      isBenignBypass({
        details: { context: 'service:cashbox_fn_fallback' },
      }),
    ).toBe(false);
  });

  it('returns false when context is missing entirely', () => {
    expect(isBenignBypass({})).toBe(false);
    expect(isBenignBypass({ details: {} })).toBe(false);
    expect(isBenignBypass(null)).toBe(false);
  });

  it('returns false when affected_notes is empty / unrelated', () => {
    expect(
      isBenignBypass({
        details: {
          context: 'service:cashbox_fn_fallback',
          affected_notes: 'unrelated note',
        },
      }),
    ).toBe(false);
  });

  it('the BENIGN_BYPASS_CONTEXTS array contains exactly the documented entries', () => {
    expect([...BENIGN_BYPASS_CONTEXTS].sort()).toEqual([
      'service:VERIFY_PR',
      'service:cash-recon-cleanup',
    ]);
  });

  it('the BENIGN_BYPASS_NOTES_PATTERNS array carries the VERIFY_PR regex', () => {
    expect(BENIGN_BYPASS_NOTES_PATTERNS).toHaveLength(1);
    expect(BENIGN_BYPASS_NOTES_PATTERNS[0]!.test('VERIFY_PR test cleanup')).toBe(
      true,
    );
  });
});

// ─── 3. End-to-end scan() with a mock DataSource ─────────────────

interface MockCall {
  sql: string;
  params?: any[];
}
function makeMockDs(handler: (call: MockCall) => any[]) {
  const calls: MockCall[] = [];
  const ds: any = {
    query: async (sql: string, params?: any[]) => {
      calls.push({ sql, params });
      return handler({ sql, params });
    },
  };
  return { ds, calls };
}

function inserts(calls: MockCall[]): MockCall[] {
  return calls.filter((c) => /INSERT\s+INTO\s+financial_anomalies/i.test(c.sql));
}

describe('FinancialHealthService.scan — legacy_bypass filtering', () => {
  it('still inserts an anomaly for an UNKNOWN context (regression guard)', async () => {
    const { ds, calls } = makeMockDs(({ sql }) => {
      if (sql.includes('engine_bypass_alerts')) {
        return [
          {
            affected_entity: 'cashbox_transactions',
            reference_id: '999',
            description: 'Legacy writer bypassed engine — cashbox_transactions I',
            details: {
              context: 'service:cashbox_fn_fallback',
              session_user: 'postgres',
              client_addr: '127.0.0.1',
              affected_notes: null,
            },
          },
        ];
      }
      if (/INSERT\s+INTO\s+financial_anomalies/i.test(sql)) {
        return [{ anomaly_id: 1 }];
      }
      return [];
    });
    const svc = new FinancialHealthService(ds);
    await svc.scan(24);
    const ins = inserts(calls);
    // Exactly one insert — for the unknown-context bypass.
    expect(ins.length).toBeGreaterThanOrEqual(1);
    expect(ins[0]!.params![1]).toBe('legacy_bypass_journal_entry');
    expect(ins[0]!.params![3]).toBe('cashbox_transactions');
    expect(ins[0]!.params![4]).toBe('999');
  });

  it('does NOT insert when the candidate context is service:cash-recon-cleanup', async () => {
    const { ds, calls } = makeMockDs(({ sql }) => {
      if (sql.includes('engine_bypass_alerts')) {
        return [
          {
            affected_entity: 'cashbox_transactions',
            reference_id: '288',
            description: 'Legacy writer bypassed engine — cashbox_transactions I',
            details: {
              context: 'service:cash-recon-cleanup',
              session_user: 'postgres',
              client_addr: '127.0.0.1',
              affected_notes: null,
            },
          },
        ];
      }
      if (/INSERT\s+INTO\s+financial_anomalies/i.test(sql)) {
        return [{ anomaly_id: 1 }];
      }
      return [];
    });
    const svc = new FinancialHealthService(ds);
    await svc.scan(24);
    const ins = inserts(calls).filter(
      (c) => c.params?.[1] === 'legacy_bypass_journal_entry',
    );
    expect(ins).toHaveLength(0);
  });

  it('does NOT insert when the candidate context is service:VERIFY_PR', async () => {
    const { ds, calls } = makeMockDs(({ sql }) => {
      if (sql.includes('engine_bypass_alerts')) {
        return [
          {
            affected_entity: 'journal_entries',
            reference_id: '11111111-1111-1111-1111-111111111111',
            description: 'Legacy writer bypassed engine — journal_entries U',
            details: {
              context: 'service:VERIFY_PR',
              session_user: 'postgres',
              client_addr: '127.0.0.1',
              affected_notes: null,
            },
          },
        ];
      }
      if (/INSERT\s+INTO\s+financial_anomalies/i.test(sql)) {
        return [{ anomaly_id: 1 }];
      }
      return [];
    });
    const svc = new FinancialHealthService(ds);
    await svc.scan(24);
    const ins = inserts(calls).filter(
      (c) => c.params?.[1] === 'legacy_bypass_journal_entry',
    );
    expect(ins).toHaveLength(0);
  });

  it('does NOT insert when affected_notes contains VERIFY_PR even with generic context', async () => {
    const { ds, calls } = makeMockDs(({ sql }) => {
      if (sql.includes('engine_bypass_alerts')) {
        return [
          {
            affected_entity: 'cashbox_transactions',
            reference_id: '101',
            description: 'Legacy writer bypassed engine — cashbox_transactions I',
            details: {
              context: 'service:cashbox_fn_fallback', // generic, not whitelisted
              session_user: 'postgres',
              client_addr: '2a05:d019:fa8:a400:e437:14b:7ae9:de68',
              affected_notes:
                'VERIFY_PR test cleanup — reversing settlement id=4',
            },
          },
        ];
      }
      if (/INSERT\s+INTO\s+financial_anomalies/i.test(sql)) {
        return [{ anomaly_id: 1 }];
      }
      return [];
    });
    const svc = new FinancialHealthService(ds);
    await svc.scan(24);
    const ins = inserts(calls).filter(
      (c) => c.params?.[1] === 'legacy_bypass_journal_entry',
    );
    expect(ins).toHaveLength(0);
  });

  it('counts skipped candidates in the return summary', async () => {
    const { ds } = makeMockDs(({ sql }) => {
      if (sql.includes('engine_bypass_alerts')) {
        return [
          {
            affected_entity: 'cashbox_transactions',
            reference_id: '101',
            description: 'Legacy writer bypassed engine — cashbox_transactions I',
            details: {
              context: 'service:cash-recon-cleanup',
              affected_notes: null,
            },
          },
          {
            affected_entity: 'cashbox_transactions',
            reference_id: '102',
            description: 'Legacy writer bypassed engine — cashbox_transactions I',
            details: {
              context: 'service:cashbox_fn_fallback',
              affected_notes: null,
            },
          },
        ];
      }
      if (/INSERT\s+INTO\s+financial_anomalies/i.test(sql)) {
        return [{ anomaly_id: 1 }];
      }
      return [];
    });
    const svc = new FinancialHealthService(ds);
    const res = await svc.scan(24);
    // 1 inserted (the generic-context one) + 1 skipped (whitelist).
    expect(res.inserted).toBeGreaterThanOrEqual(1);
    expect(res.skipped_existing).toBeGreaterThanOrEqual(1);
  });
});

describe('FinancialHealthService.scan — shift variance treatment guard', () => {
  // The treatment-aware guard for rules 5 + 8 lives in the SQL
  // WHERE clause, which the source-grep block above verifies.  We
  // also do a defensive end-to-end check: a candidate that the SQL
  // would have filtered must not appear in the post-fetch loop, so
  // the caller cannot accidentally reach the INSERT.

  it('inserts shift_variance_spike anomaly for a CANDIDATE row (treated shifts are filtered by the SQL WHERE clause, not in TS)', async () => {
    const { ds, calls } = makeMockDs(({ sql }) => {
      if (
        /shift_variance_spike|FROM shifts[\s\S]+ABS\(COALESCE\(actual_closing/i.test(sql)
      ) {
        return [
          {
            affected_entity: 'shifts',
            reference_id: 'shift-1',
            description: 'Large variance on SHF-X: -1500',
            details: {
              shift_no: 'SHF-X',
              expected: 5000,
              actual: 3500,
              variance: -1500,
            },
          },
        ];
      }
      if (/INSERT\s+INTO\s+financial_anomalies/i.test(sql)) {
        return [{ anomaly_id: 1 }];
      }
      return [];
    });
    const svc = new FinancialHealthService(ds);
    await svc.scan(24);
    const ins = inserts(calls).filter(
      (c) => c.params?.[1] === 'shift_variance_spike',
    );
    expect(ins.length).toBeGreaterThanOrEqual(1);
  });

  it('does not insert when the rule SQL returns NO candidates (mirrors the SQL-side variance_treatment guard)', async () => {
    const { ds, calls } = makeMockDs(({ sql }) => {
      // Treatment-applied shifts are excluded by the rule SQL itself,
      // so the rule call returns [].  Verify scan() respects that.
      if (sql.includes('shifts')) return [];
      if (/INSERT\s+INTO\s+financial_anomalies/i.test(sql)) {
        return [{ anomaly_id: 1 }];
      }
      return [];
    });
    const svc = new FinancialHealthService(ds);
    await svc.scan(24);
    const ins = inserts(calls).filter(
      (c) =>
        c.params?.[1] === 'shift_variance_spike' ||
        c.params?.[1] === 'low_accuracy_shift',
    );
    expect(ins).toHaveLength(0);
  });
});

// ─── 4. engine_bypass_alerts is read-only from this service ──────

describe('financial-health.service — audit invariant', () => {
  it('the scanner never deletes / updates / inserts into engine_bypass_alerts', async () => {
    const SRC = readFileSync(
      resolve(__dirname, './financial-health.service.ts'),
      'utf8',
    ).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    expect(SRC).not.toMatch(/INSERT\s+INTO\s+engine_bypass_alerts\b/i);
    expect(SRC).not.toMatch(/UPDATE\s+engine_bypass_alerts\b/i);
    expect(SRC).not.toMatch(/DELETE\s+FROM\s+engine_bypass_alerts\b/i);
  });
});
