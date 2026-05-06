/**
 * gl-codes.constants.spec.ts — PR-AUDIT-LIQUID-CODES-CONST
 *
 * Pins the literal values + array shape + SQL-list helper of the
 * shared liquid-asset GL code constants. If a future refactor changes
 * any of these values by accident, this spec fails fast — long
 * before the change reaches the FinancialEngine guard, the dashboard
 * SQL, the analytics liquidity tile, or the posting service's
 * cashbox-account-id resolution.
 *
 * The constants file itself has zero behavior — it just exports
 * literals. So this spec exists purely to prevent silent value
 * drift, not to test logic.
 */

import {
  GL_CASH,
  GL_BANK,
  GL_WALLET,
  GL_CHECKS,
  GL_EMPLOYEE_RECEIVABLE,
  GL_EMPLOYEE_PAYABLE,
  GL_SUPPLIER_PAYABLE,
  LIQUID_GL_CODES,
  LIQUID_CODES_SQL_LIST,
  CASHBOX_KIND_TO_GL_CODE,
  cashboxKindToGlCode,
} from './gl-codes.constants';

describe('gl-codes.constants — PR-AUDIT-LIQUID-CODES-CONST', () => {
  describe('named constants pin literal values', () => {
    it('GL_CASH is "1111"', () => {
      expect(GL_CASH).toBe('1111');
    });
    it('GL_BANK is "1113"', () => {
      expect(GL_BANK).toBe('1113');
    });
    it('GL_WALLET is "1114"', () => {
      expect(GL_WALLET).toBe('1114');
    });
    it('GL_CHECKS is "1115"', () => {
      expect(GL_CHECKS).toBe('1115');
    });
  });

  describe('LIQUID_GL_CODES array', () => {
    it('contains exactly the four liquid codes in canonical order', () => {
      expect([...LIQUID_GL_CODES]).toEqual(['1111', '1113', '1114', '1115']);
    });

    it('has length 4 (no accidental duplicates / additions)', () => {
      expect(LIQUID_GL_CODES).toHaveLength(4);
    });

    it('every code is unique', () => {
      const set = new Set(LIQUID_GL_CODES);
      expect(set.size).toBe(LIQUID_GL_CODES.length);
    });

    it('order is cash → bank → wallet → checks (the engine + dashboard depend on this order)', () => {
      expect(LIQUID_GL_CODES[0]).toBe(GL_CASH);
      expect(LIQUID_GL_CODES[1]).toBe(GL_BANK);
      expect(LIQUID_GL_CODES[2]).toBe(GL_WALLET);
      expect(LIQUID_GL_CODES[3]).toBe(GL_CHECKS);
    });
  });

  describe('LIQUID_CODES_SQL_LIST helper', () => {
    it("equals \"'1111','1113','1114','1115'\" — safe to interpolate into WHERE coa.code IN (...)", () => {
      expect(LIQUID_CODES_SQL_LIST).toBe("'1111','1113','1114','1115'");
    });

    it('is a pure string of static literals (no user input — safe without parameterization)', () => {
      // Defensive: the string MUST contain only digits, single quotes,
      // and commas. Any other char would mean a code with non-digit
      // contents leaked in (rejection check).
      expect(LIQUID_CODES_SQL_LIST).toMatch(/^[\d',]+$/);
    });
  });

  /* ────────────────────────────────────────────────────────────────
   * PR-AUDIT-NON-LIQUID-GL-PHASE-A — pin the 3 new non-liquid GL
   * code constants used by read-only SELECT/reporting sites
   * (employees.service, payroll.controller, shifts.service,
   * finance-dashboard.service). Posting/engine line-creation paths
   * still use literals — Phase B is a separate PR.
   * ────────────────────────────────────────────────────────────────*/
  describe('non-liquid GL code constants — PR-AUDIT-NON-LIQUID-GL-PHASE-A', () => {
    it('GL_EMPLOYEE_RECEIVABLE is "1123" (ذمم الموظفين / advances)', () => {
      expect(GL_EMPLOYEE_RECEIVABLE).toBe('1123');
    });
    it('GL_EMPLOYEE_PAYABLE is "213" (مستحقات الموظفين / accruals)', () => {
      expect(GL_EMPLOYEE_PAYABLE).toBe('213');
    });
    it('GL_SUPPLIER_PAYABLE is "211" (الموردون والدائنون)', () => {
      expect(GL_SUPPLIER_PAYABLE).toBe('211');
    });
  });

  describe('CASHBOX_KIND_TO_GL_CODE map', () => {
    it('maps cash → 1111', () => {
      expect(CASHBOX_KIND_TO_GL_CODE.cash).toBe(GL_CASH);
    });
    it('maps bank → 1113', () => {
      expect(CASHBOX_KIND_TO_GL_CODE.bank).toBe(GL_BANK);
    });
    it('maps ewallet → 1114', () => {
      expect(CASHBOX_KIND_TO_GL_CODE.ewallet).toBe(GL_WALLET);
    });
    it('maps check → 1115', () => {
      expect(CASHBOX_KIND_TO_GL_CODE.check).toBe(GL_CHECKS);
    });
    it('has exactly the four cashbox kinds (no extras)', () => {
      expect(Object.keys(CASHBOX_KIND_TO_GL_CODE).sort()).toEqual([
        'bank',
        'cash',
        'check',
        'ewallet',
      ]);
    });
  });

  /* ──────────────────────────────────────────────────────────────────
   * PR-AUDIT-CASHBOX-KIND-MAP-CENTRALIZE (Sprint 3 / PR-8)
   *
   * The strict resolver `cashboxKindToGlCode(kind)` returns the
   * canonical liquid GL code for the four supported cashbox kinds,
   * or null when the input is null / undefined / not one of the
   * four. Pinning this contract here so any future change to the
   * resolver semantics surfaces in CI immediately.
   *
   * Use-site policy (documented in the helper's docblock):
   *   · Read paths / reporting code → use `cashboxKindToGlCode(kind)`
   *     and treat null as "skip this row".
   *   · Engine / posting paths that downstream-call
   *     `accountIdByCode(code)` (which cannot accept null) →
   *     keep the existing `CASHBOX_KIND_TO_GL_CODE[...] || GL_CASH`
   *     fallback. This PR intentionally does NOT refactor those 2
   *     call sites (`financial-engine.service.ts:997`,
   *     `posting.service.ts:1688`).
   * ──────────────────────────────────────────────────────────────────*/
  describe('cashboxKindToGlCode resolver — PR-AUDIT-CASHBOX-KIND-MAP-CENTRALIZE', () => {
    it("'cash' → '1111'", () => {
      expect(cashboxKindToGlCode('cash')).toBe(GL_CASH);
      expect(cashboxKindToGlCode('cash')).toBe('1111');
    });
    it("'bank' → '1113'", () => {
      expect(cashboxKindToGlCode('bank')).toBe(GL_BANK);
      expect(cashboxKindToGlCode('bank')).toBe('1113');
    });
    it("'ewallet' → '1114'", () => {
      expect(cashboxKindToGlCode('ewallet')).toBe(GL_WALLET);
      expect(cashboxKindToGlCode('ewallet')).toBe('1114');
    });
    it("'check' → '1115'", () => {
      expect(cashboxKindToGlCode('check')).toBe(GL_CHECKS);
      expect(cashboxKindToGlCode('check')).toBe('1115');
    });
    it('null → null (strict — no cash fallback in this resolver)', () => {
      expect(cashboxKindToGlCode(null)).toBeNull();
    });
    it('undefined → null', () => {
      expect(cashboxKindToGlCode(undefined)).toBeNull();
    });
    it("'unknown' → null (any value not in the 4 supported kinds returns null)", () => {
      expect(cashboxKindToGlCode('unknown')).toBeNull();
      expect(cashboxKindToGlCode('')).toBeNull();
      expect(cashboxKindToGlCode('CASH')).toBeNull(); // case-sensitive
      expect(cashboxKindToGlCode('wallet')).toBeNull(); // 'wallet' is not 'ewallet'
    });
    it("does NOT default unknowns to GL_CASH (that's the engine's || GL_CASH job, not this resolver)", () => {
      // This pins the difference between the strict resolver (this PR)
      // and the engine/posting fallback pattern. The two engine call
      // sites at financial-engine.service.ts:997 and
      // posting.service.ts:1688 keep their own `|| GL_CASH` because
      // accountIdByCode(null) would crash. The strict resolver here
      // is for read paths that can safely skip on null.
      expect(cashboxKindToGlCode('unknown')).not.toBe(GL_CASH);
      expect(cashboxKindToGlCode(null)).not.toBe(GL_CASH);
    });
  });
});
