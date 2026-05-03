/**
 * financial-engine.guards.spec.ts —
 *   PR-FIN-CASHBOX-GL-PREVENTION-GUARDS
 *
 * Pin the cashbox/GL-1111 alignment invariant. The exported pure
 * validator `checkCashGlAlignment` is unit-tested in isolation (no
 * DataSource needed) — this exercises every guard branch and every
 * cash-impacting path the engine supports.
 *
 * Coverage (one spec per branch):
 *   1. Pure non-cash JE (e.g. wage accrual DR 521 / CR 213) → null,
 *      no assertion.
 *   2. Cash GL line WITHOUT cashbox_id → Guard A throws.
 *   3. Cash GL line with cashbox_id but no paired CT → Guard B throws.
 *   4. CT with no paired GL line (leftover) → Guard C throws.
 *   5. Cash GL line + matching CT → null, passes.
 *   6. Multiple cash GL lines + matching CTs (transfer pattern) → null.
 *   7. Sign mismatch (DR with `direction='out'`) → Guard B throws.
 *   8. Cashbox-id mismatch (line tagged A, CT tagged B) → Guard B throws.
 *   9. accounting_only=true with cash GL line + no CT → bypass logged
 *      (no throw).
 *  10. accounting_only=true with no cash lines and no movements → null
 *      (still nothing to assert).
 *  11. Bank account (1113) treated identically to 1111 — guards apply.
 *  12. Float / rounding tolerance ≤ 0.01 → matches.
 *  13. The four cash-impacting "kinds" the engine ships today
 *      (cash_expense, cash_invoice_payment, cash_supplier_payment,
 *      cash_employee_settlement, return_refund) all pass when
 *      properly paired.
 *  14. Direct manual JE 1111 with no cashbox_id and no movement (the
 *      historical JE-2026-000196 / JE-2026-000123 pattern) — Guard A
 *      throws with a message that points the caller at the fix.
 *  15. Cash IN sign (debit 350 → direction='in', amount=350) matches.
 *  16. Cash OUT sign (credit 350 → direction='out', amount=350) matches.
 */

import { checkCashGlAlignment } from './financial-engine.service';

const CB1 = 'cb-اخزينة-1';
const CB2 = 'cb-اخزينة-2';

// ─── Helpers ──────────────────────────────────────────────────────
function codeMap(map: Record<string, string>): Map<string, string> {
  return new Map(Object.entries(map));
}

function makeInput(overrides: Partial<Parameters<typeof checkCashGlAlignment>[0]> = {}): Parameters<typeof checkCashGlAlignment>[0] {
  return {
    reference_type: 'expense',
    reference_id: 'ref-1',
    accounting_only: false,
    resolved_lines: [],
    cash_movements: [],
    code_by_account_id: codeMap({}),
    ...overrides,
  };
}

describe('checkCashGlAlignment — PR-FIN-CASHBOX-GL-PREVENTION-GUARDS', () => {
  // ── Fast-path: no cash impact at all ───────────────────────────
  describe('non-cash JE (no liquid-account lines, no movements)', () => {
    it('passes through cleanly when DR/CR are non-liquid (e.g. wage accrual DR 521 / CR 213)', () => {
      const result = checkCashGlAlignment(
        makeInput({
          reference_type: 'employee_wage_accrual',
          resolved_lines: [
            { account_id: 'a-521', debit: 250, credit: 0, cashbox_id: null },
            { account_id: 'a-213', debit: 0, credit: 250, cashbox_id: null },
          ],
          cash_movements: [],
          code_by_account_id: codeMap({ 'a-521': '521', 'a-213': '213' }),
        }),
      );
      expect(result).toBeNull();
    });

    it('passes through when accounts are receivable/payable only (DR 1123 / CR 211 — non-cash)', () => {
      const result = checkCashGlAlignment(
        makeInput({
          reference_type: 'employee_advance_correction',
          resolved_lines: [
            { account_id: 'a-1123', debit: 100, credit: 0, cashbox_id: null },
            { account_id: 'a-211',  debit: 0, credit: 100, cashbox_id: null },
          ],
          code_by_account_id: codeMap({ 'a-1123': '1123', 'a-211': '211' }),
        }),
      );
      expect(result).toBeNull();
    });
  });

  // ── Guard A — cash GL line MUST have cashbox_id ────────────────
  describe('Guard A — cash GL line requires cashbox_id', () => {
    it('throws on 1111 line with cashbox_id=null (the EXP-2026-000003 / JE-123 historical pattern)', () => {
      const result = checkCashGlAlignment(
        makeInput({
          reference_type: 'expense',
          reference_id: 'EXP-000003',
          resolved_lines: [
            { account_id: 'a-529',  debit: 2000, credit: 0,    cashbox_id: null },
            { account_id: 'a-1111', debit: 0,    credit: 2000, cashbox_id: null },
          ],
          cash_movements: [
            { cashbox_id: CB1, direction: 'out', amount: 2000 },
          ],
          code_by_account_id: codeMap({ 'a-529': '529', 'a-1111': '1111' }),
        }),
      );
      expect(typeof result).toBe('string');
      expect(result).toMatch(/cash GL line on 1111 requires cashbox_id/);
      expect(result).toMatch(/EXP-000003/);
    });

    it('throws on 1113 line with cashbox_id=null (bank — same Guard A applies)', () => {
      const result = checkCashGlAlignment(
        makeInput({
          resolved_lines: [
            { account_id: 'a-528',  debit: 100, credit: 0,   cashbox_id: null },
            { account_id: 'a-1113', debit: 0,   credit: 100, cashbox_id: null },
          ],
          code_by_account_id: codeMap({ 'a-528': '528', 'a-1113': '1113' }),
        }),
      );
      expect(result).toMatch(/cash GL line on 1113 requires cashbox_id/);
    });

    it('points the caller at the fix (resolve_from_cashbox_id OR accounting_only)', () => {
      const result = checkCashGlAlignment(
        makeInput({
          resolved_lines: [
            { account_id: 'a-528',  debit: 50, credit: 0,  cashbox_id: null },
            { account_id: 'a-1111', debit: 0,  credit: 50, cashbox_id: null },
          ],
          code_by_account_id: codeMap({ 'a-528': '528', 'a-1111': '1111' }),
        }),
      );
      expect(result).toMatch(/Use resolve_from_cashbox_id or set cashbox_id explicitly/);
      expect(result).toMatch(/set accounting_only=true on the spec/);
    });
  });

  // ── Guard B — cash GL line MUST be paired with a CT ────────────
  describe('Guard B — cash GL line requires paired cash_movement', () => {
    it('throws when cash GL line has cashbox_id but no movement at all', () => {
      const result = checkCashGlAlignment(
        makeInput({
          reference_type: 'employee_settlement',
          reference_id: 'settlement-7',
          resolved_lines: [
            { account_id: 'a-213',  debit: 100, credit: 0,   cashbox_id: null },
            { account_id: 'a-1111', debit: 0,   credit: 100, cashbox_id: CB1 },
          ],
          cash_movements: [], // ← missing paired CT
          code_by_account_id: codeMap({ 'a-213': '213', 'a-1111': '1111' }),
        }),
      );
      expect(typeof result).toBe('string');
      expect(result).toMatch(/cash GL line on 1111 .* has no paired cashbox_transactions movement/);
      expect(result).toMatch(/settlement-7/);
      expect(result).toMatch(/cashbox_id=cb-اخزينة-1/);
      expect(result).toMatch(/signed=-100\.00/);
      // Guidance includes the missing movement spec.
      expect(result).toMatch(/direction:'out'/);
      expect(result).toMatch(/amount:100\.00/);
    });

    it('throws on cashbox-id mismatch (line tagged CB1, CT tagged CB2)', () => {
      const result = checkCashGlAlignment(
        makeInput({
          resolved_lines: [
            { account_id: 'a-528',  debit: 50, credit: 0,  cashbox_id: null },
            { account_id: 'a-1111', debit: 0,  credit: 50, cashbox_id: CB1 },
          ],
          cash_movements: [
            { cashbox_id: CB2, direction: 'out', amount: 50 }, // ← wrong cashbox
          ],
          code_by_account_id: codeMap({ 'a-528': '528', 'a-1111': '1111' }),
        }),
      );
      expect(result).toMatch(/has no paired cashbox_transactions movement/);
    });

    it('throws on signed-amount mismatch (DR with movement direction=out)', () => {
      // Line debits 1111 (cash IN, signed +50), but movement is out −50.
      const result = checkCashGlAlignment(
        makeInput({
          resolved_lines: [
            { account_id: 'a-1111', debit: 50, credit: 0,  cashbox_id: CB1 },
            { account_id: 'a-411',  debit: 0,  credit: 50, cashbox_id: null },
          ],
          cash_movements: [
            { cashbox_id: CB1, direction: 'out', amount: 50 }, // ← wrong sign
          ],
          code_by_account_id: codeMap({ 'a-1111': '1111', 'a-411': '411' }),
        }),
      );
      expect(result).toMatch(/has no paired cashbox_transactions movement/);
      expect(result).toMatch(/signed=50\.00/);
    });
  });

  // ── Guard C — CT with no GL line counterpart ───────────────────
  describe('Guard C — leftover cash_movement with no GL line', () => {
    it('throws when a cash_movement has no matching liquid-asset line in the JE', () => {
      const result = checkCashGlAlignment(
        makeInput({
          reference_type: 'shift_variance',
          reference_id: 'shift-5',
          resolved_lines: [
            // A non-cash JE (DR 521 / CR 213) but caller passed an extra CT.
            { account_id: 'a-521', debit: 25, credit: 0,  cashbox_id: null },
            { account_id: 'a-213', debit: 0,  credit: 25, cashbox_id: null },
          ],
          cash_movements: [
            { cashbox_id: CB1, direction: 'in', amount: 25 }, // ← orphan CT
          ],
          code_by_account_id: codeMap({ 'a-521': '521', 'a-213': '213' }),
        }),
      );
      expect(result).toMatch(/cashbox_transactions movement \(cashbox_id=cb-اخزينة-1, signed=25\.00\)/);
      expect(result).toMatch(/has no paired cash GL line on a liquid-asset account/);
      expect(result).toMatch(/\(1111\/1113\/1114\/1115\)/);
    });
  });

  // ── Happy-path coverage for every cash-impacting "kind" ────────
  describe('happy paths — every cash-impacting kind passes when paired correctly', () => {
    it('cash_expense (DR 528 / CR 1111 + cash OUT)', () => {
      const result = checkCashGlAlignment(
        makeInput({
          reference_type: 'expense',
          resolved_lines: [
            { account_id: 'a-528',  debit: 310, credit: 0,   cashbox_id: null },
            { account_id: 'a-1111', debit: 0,   credit: 310, cashbox_id: CB1 },
          ],
          cash_movements: [
            { cashbox_id: CB1, direction: 'out', amount: 310 },
          ],
          code_by_account_id: codeMap({ 'a-528': '528', 'a-1111': '1111' }),
        }),
      );
      expect(result).toBeNull();
    });

    it('cash_invoice_payment (DR 1111 / CR 411 + cash IN)', () => {
      const result = checkCashGlAlignment(
        makeInput({
          reference_type: 'invoice',
          resolved_lines: [
            { account_id: 'a-1111', debit: 1000, credit: 0,    cashbox_id: CB1 },
            { account_id: 'a-411',  debit: 0,    credit: 1000, cashbox_id: null },
          ],
          cash_movements: [
            { cashbox_id: CB1, direction: 'in', amount: 1000 },
          ],
          code_by_account_id: codeMap({ 'a-1111': '1111', 'a-411': '411' }),
        }),
      );
      expect(result).toBeNull();
    });

    it('cash_supplier_payment (DR 211 / CR 1111 + cash OUT)', () => {
      const result = checkCashGlAlignment(
        makeInput({
          reference_type: 'supplier_payment',
          resolved_lines: [
            { account_id: 'a-211',  debit: 500, credit: 0,   cashbox_id: null },
            { account_id: 'a-1111', debit: 0,   credit: 500, cashbox_id: CB1 },
          ],
          cash_movements: [
            { cashbox_id: CB1, direction: 'out', amount: 500 },
          ],
          code_by_account_id: codeMap({ 'a-211': '211', 'a-1111': '1111' }),
        }),
      );
      expect(result).toBeNull();
    });

    it('cash_employee_settlement (DR 213 / CR 1111 + cash OUT)', () => {
      const result = checkCashGlAlignment(
        makeInput({
          reference_type: 'employee_settlement',
          resolved_lines: [
            { account_id: 'a-213',  debit: 270, credit: 0,   cashbox_id: null },
            { account_id: 'a-1111', debit: 0,   credit: 270, cashbox_id: CB1 },
          ],
          cash_movements: [
            { cashbox_id: CB1, direction: 'out', amount: 270 },
          ],
          code_by_account_id: codeMap({ 'a-213': '213', 'a-1111': '1111' }),
        }),
      );
      expect(result).toBeNull();
    });

    it('return_refund (DR 49 / CR 1111 + cash OUT)', () => {
      const result = checkCashGlAlignment(
        makeInput({
          reference_type: 'return',
          resolved_lines: [
            { account_id: 'a-49',   debit: 350, credit: 0,   cashbox_id: null },
            { account_id: 'a-1111', debit: 0,   credit: 350, cashbox_id: CB1 },
          ],
          cash_movements: [
            { cashbox_id: CB1, direction: 'out', amount: 350 },
          ],
          code_by_account_id: codeMap({ 'a-49': '49', 'a-1111': '1111' }),
        }),
      );
      expect(result).toBeNull();
    });

    it('cashbox_transfer (two cash GL lines + two CTs in opposite directions)', () => {
      const result = checkCashGlAlignment(
        makeInput({
          reference_type: 'cashbox_transfer',
          resolved_lines: [
            { account_id: 'a-1111', debit: 500, credit: 0, cashbox_id: CB2 }, // IN to dest
            { account_id: 'a-1111', debit: 0, credit: 500, cashbox_id: CB1 }, // OUT from src
          ],
          cash_movements: [
            { cashbox_id: CB1, direction: 'out', amount: 500 },
            { cashbox_id: CB2, direction: 'in',  amount: 500 },
          ],
          code_by_account_id: codeMap({ 'a-1111': '1111' }),
        }),
      );
      expect(result).toBeNull();
    });
  });

  // ── accounting_only escape hatch ───────────────────────────────
  describe('accounting_only=true bypass', () => {
    it('returns the bypass sentinel when set AND there are cash-impacting lines/movements', () => {
      const result = checkCashGlAlignment(
        makeInput({
          accounting_only: true,
          resolved_lines: [
            { account_id: 'a-213',  debit: 100, credit: 0,   cashbox_id: null },
            { account_id: 'a-1111', debit: 0,   credit: 100, cashbox_id: null }, // no cb tag
          ],
          cash_movements: [], // no movement
          code_by_account_id: codeMap({ 'a-213': '213', 'a-1111': '1111' }),
        }),
      );
      expect(result).toBe('accounting_only_bypass_logged');
    });

    it('returns null (not bypass) when accounting_only=true but spec is non-cash anyway', () => {
      // Pure 521/213 wage accrual carries no cash impact — the bypass
      // sentinel would be misleading. Falls through to the fast-path.
      const result = checkCashGlAlignment(
        makeInput({
          accounting_only: true,
          resolved_lines: [
            { account_id: 'a-521', debit: 250, credit: 0, cashbox_id: null },
            { account_id: 'a-213', debit: 0, credit: 250, cashbox_id: null },
          ],
          code_by_account_id: codeMap({ 'a-521': '521', 'a-213': '213' }),
        }),
      );
      expect(result).toBeNull();
    });
  });

  // ── Numerical edge cases ───────────────────────────────────────
  describe('numerical edge cases', () => {
    it('matches with float jitter ≤ 0.01 (310.001 line vs 310.005 movement)', () => {
      const result = checkCashGlAlignment(
        makeInput({
          resolved_lines: [
            { account_id: 'a-528',  debit: 310.001, credit: 0,       cashbox_id: null },
            { account_id: 'a-1111', debit: 0,       credit: 310.001, cashbox_id: CB1 },
          ],
          cash_movements: [
            { cashbox_id: CB1, direction: 'out', amount: 310.005 },
          ],
          code_by_account_id: codeMap({ 'a-528': '528', 'a-1111': '1111' }),
        }),
      );
      expect(result).toBeNull();
    });

    it('rejects when the difference exceeds the 0.01 tolerance', () => {
      const result = checkCashGlAlignment(
        makeInput({
          resolved_lines: [
            { account_id: 'a-528',  debit: 310, credit: 0,    cashbox_id: null },
            { account_id: 'a-1111', debit: 0,   credit: 310,  cashbox_id: CB1 },
          ],
          cash_movements: [
            { cashbox_id: CB1, direction: 'out', amount: 310.50 }, // 0.50 off
          ],
          code_by_account_id: codeMap({ 'a-528': '528', 'a-1111': '1111' }),
        }),
      );
      expect(result).toMatch(/has no paired/);
    });

    it('handles unknown account_id (code_by missing) — non-liquid by default, passes', () => {
      const result = checkCashGlAlignment(
        makeInput({
          resolved_lines: [
            { account_id: 'a-mystery-1', debit: 50, credit: 0,  cashbox_id: null },
            { account_id: 'a-mystery-2', debit: 0,  credit: 50, cashbox_id: null },
          ],
          code_by_account_id: codeMap({}),
        }),
      );
      expect(result).toBeNull();
    });
  });
});

/**
 * PR-FIN-CASHBOX-GL-PREVENTION-GUARDS — engine-level observability
 * contract for `accounting_only=true` bypass.
 *
 * The pure validator (`checkCashGlAlignment`) only signals the
 * sentinel; the engine method (`FinancialEngineService.assertCashGlAlignment`)
 * is responsible for the side effect. The user explicitly asked us
 * NOT to add a new INSERT into `engine_bypass_alerts` (that table is
 * owned by the migration-063 trigger). This block pins:
 *
 *   1. `accounting_only=true` bypass → logger.warn IS called with
 *      a structured message tagged with the reference.
 *   2. The engine's queryFn receives ONLY the COA SELECT during
 *      assertion — never an `INSERT INTO engine_bypass_alerts`.
 *   3. Healthy non-cash JEs do NOT emit a spurious bypass log.
 */
import { FinancialEngineService } from './financial-engine.service';

describe('FinancialEngineService.assertCashGlAlignment — bypass observability (logger-only)', () => {
  function build() {
    // Constructor only stores the DataSource; we never call
    // recordTransaction here, so a stub is enough.
    const ds = { query: jest.fn() } as any;
    const svc = new FinancialEngineService(ds);
    const warnSpy = jest.spyOn((svc as any).logger, 'warn').mockImplementation(() => {});
    const queries: Array<{ sql: string; params: any[] }> = [];
    const q = jest.fn(async (sql: string, params: any[] = []) => {
      queries.push({ sql, params });
      // Stub the COA lookup: return code rows for any account_id.
      if (/SELECT id::text AS id, code\s+FROM chart_of_accounts/.test(sql)) {
        const ids: string[] = (params[0] as string[]) ?? [];
        return ids.map((id) => ({
          id,
          code: id === 'a-1111' ? '1111' : id === 'a-213' ? '213' : 'unknown',
        }));
      }
      return [];
    });
    return { svc, warnSpy, queries, q };
  }

  it('logs a warn line when accounting_only=true triggers the bypass', async () => {
    const { svc, warnSpy, q } = build();
    await (svc as any).assertCashGlAlignment(
      q,
      {
        reference_type: 'employee_settlement',
        reference_id: 'settlement-7',
        description: 'تصحيح اتجاه التسوية',
        gl_lines: [],
        user_id: null,
        accounting_only: true,
      },
      [
        { account_id: 'a-213',  debit: 100, credit: 0,   cashbox_id: null },
        { account_id: 'a-1111', debit: 0,   credit: 100, cashbox_id: null },
      ],
    );
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = warnSpy.mock.calls[0][0] as string;
    expect(msg).toMatch(/accounting_only=true bypass/);
    expect(msg).toMatch(/employee_settlement\/settlement-7/);
    expect(msg).toMatch(/cash-impacting JE recorded without paired CT/);
  });

  it('queryFn never receives an INSERT INTO engine_bypass_alerts during the bypass', async () => {
    const { svc, queries, q } = build();
    await (svc as any).assertCashGlAlignment(
      q,
      {
        reference_type: 'employee_settlement',
        reference_id: 'settlement-7',
        description: 'تصحيح',
        gl_lines: [],
        user_id: null,
        accounting_only: true,
      },
      [
        { account_id: 'a-213',  debit: 100, credit: 0,   cashbox_id: null },
        { account_id: 'a-1111', debit: 0,   credit: 100, cashbox_id: null },
      ],
    );
    // Only the COA SELECT should have hit q. No INSERT/UPDATE/DELETE.
    expect(queries).toHaveLength(1);
    expect(queries[0].sql).toMatch(/SELECT id::text AS id, code\s+FROM chart_of_accounts/);
    for (const c of queries) {
      expect(c.sql).not.toMatch(/INSERT\s+INTO\s+engine_bypass_alerts/i);
      expect(c.sql).not.toMatch(/\bINSERT\s+INTO\b/i);
      expect(c.sql).not.toMatch(/\bUPDATE\b/i);
      expect(c.sql).not.toMatch(/\bDELETE\s+FROM\b/i);
    }
  });

  it('does NOT emit a bypass warn line for healthy non-cash JEs (no false positives)', async () => {
    const { svc, warnSpy, q } = build();
    await (svc as any).assertCashGlAlignment(
      q,
      {
        reference_type: 'employee_wage_accrual',
        reference_id: 'wage-1',
        description: 'استحقاق',
        gl_lines: [],
        user_id: null,
        accounting_only: false,
      },
      [
        // Pure 521/213 JE — non-cash. No bypass needed, no warn expected.
        { account_id: 'a-521', debit: 250, credit: 0,   cashbox_id: null },
        { account_id: 'a-213', debit: 0,   credit: 250, cashbox_id: null },
      ],
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT emit a bypass warn line when accounting_only=true is set on a non-cash spec', async () => {
    // The pure validator returns null (not the bypass sentinel) for
    // non-cash specs even when accounting_only=true — so no warn either.
    const { svc, warnSpy, q } = build();
    await (svc as any).assertCashGlAlignment(
      q,
      {
        reference_type: 'employee_wage_accrual',
        reference_id: 'wage-2',
        description: 'استحقاق',
        gl_lines: [],
        user_id: null,
        accounting_only: true,
      },
      [
        { account_id: 'a-521', debit: 250, credit: 0,   cashbox_id: null },
        { account_id: 'a-213', debit: 0,   credit: 250, cashbox_id: null },
      ],
    );
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
