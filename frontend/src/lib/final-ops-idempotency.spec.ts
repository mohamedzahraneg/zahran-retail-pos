/**
 * final-ops-idempotency.spec.ts — PR-FE-IDEM-FINAL-OPS
 *   (Sprint 5 / FE-IDEM PR 8)
 *
 * Pins the FE half of the opt-in idempotency contract for the last
 * five mutation routes already protected backend-side. Method-aware
 * (POST + DELETE) — this is the FIRST helper that gates a DELETE
 * route across all 14 sibling idempotency helpers.
 *
 *   · POST   /recurring-expenses/:id/run
 *   · POST   /recurring-expenses/process-due
 *   · POST   /stock/adjust
 *   · POST   /inventory-counts/:id/finalize
 *   · DELETE /payroll/:id
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getOrCreateRecurringRunIdempotencyKey,
  resetRecurringRunIdempotencyKey,
  _resetRecurringRunIdempotencyKeyForTests,
  getOrCreateRecurringProcessDueIdempotencyKey,
  resetRecurringProcessDueIdempotencyKey,
  _resetRecurringProcessDueIdempotencyKeyForTests,
  getOrCreateStockAdjustIdempotencyKey,
  resetStockAdjustIdempotencyKey,
  _resetStockAdjustIdempotencyKeyForTests,
  getOrCreateInventoryFinalizeIdempotencyKey,
  resetInventoryFinalizeIdempotencyKey,
  _resetInventoryFinalizeIdempotencyKeyForTests,
  getOrCreatePayrollVoidIdempotencyKey,
  resetPayrollVoidIdempotencyKey,
  _resetPayrollVoidIdempotencyKeyForTests,
  attachFinalOpsIdempotencyKeyIfApplicable,
} from './final-ops-idempotency';
import {
  attachPayrollIdempotencyKeyIfApplicable,
  _resetPayrollBonusIdempotencyKeyForTests,
  _resetPayrollDeductionIdempotencyKeyForTests,
  _resetPayrollSettlementIdempotencyKeyForTests,
} from './payroll-idempotency';
import {
  attachStockPurchasesIdempotencyKeyIfApplicable,
  _resetStockTransferCreateIdempotencyKeyForTests,
} from './stock-purchases-idempotency';
import {
  attachCheckoutIdempotencyKeyIfApplicable,
  _resetCheckoutIdempotencyKeyForTests,
} from './checkout-idempotency';

const BE_PATTERN = /^[A-Za-z0-9_-]{8,128}$/;
const RECURRING_ID = 'aaaa1111-bbbb-2222-cccc-333344445555';
const COUNT_ID = 'cccc1111-dddd-2222-eeee-333344445555';
const EMPLOYEE_TXN_ID = 'eeee1111-ffff-2222-aaaa-333344445555';
const EMPLOYEE_ID = 'eemp1111-2222-3333-4444-555566667777';

beforeEach(() => {
  _resetRecurringRunIdempotencyKeyForTests();
  _resetRecurringProcessDueIdempotencyKeyForTests();
  _resetStockAdjustIdempotencyKeyForTests();
  _resetInventoryFinalizeIdempotencyKeyForTests();
  _resetPayrollVoidIdempotencyKeyForTests();
  _resetPayrollBonusIdempotencyKeyForTests();
  _resetPayrollDeductionIdempotencyKeyForTests();
  _resetPayrollSettlementIdempotencyKeyForTests();
  _resetStockTransferCreateIdempotencyKeyForTests();
  _resetCheckoutIdempotencyKeyForTests();
});

// ── Per-action key lifecycle ─────────────────────────────────────────
describe('final-ops idempotency module — key lifecycle', () => {
  const cases: Array<[string, () => string, () => void]> = [
    ['recurring-run',         getOrCreateRecurringRunIdempotencyKey,         resetRecurringRunIdempotencyKey],
    ['recurring-process-due', getOrCreateRecurringProcessDueIdempotencyKey, resetRecurringProcessDueIdempotencyKey],
    ['stock-adjust',          getOrCreateStockAdjustIdempotencyKey,          resetStockAdjustIdempotencyKey],
    ['inventory-finalize',    getOrCreateInventoryFinalizeIdempotencyKey,    resetInventoryFinalizeIdempotencyKey],
    ['payroll-void',          getOrCreatePayrollVoidIdempotencyKey,          resetPayrollVoidIdempotencyKey],
  ];
  it.each(cases)('%s: getOrCreate caches; reset mints fresh; matches BE_PATTERN', (_, get, reset) => {
    const a = get();
    expect(get()).toBe(a);
    expect(a).toMatch(BE_PATTERN);
    reset();
    expect(get()).not.toBe(a);
  });

  it('falls back to a regex-valid key when crypto.randomUUID is unavailable', () => {
    const realCrypto = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: { ...realCrypto, randomUUID: undefined },
        configurable: true,
      });
      _resetStockAdjustIdempotencyKeyForTests();
      const k = getOrCreateStockAdjustIdempotencyKey();
      expect(k).toMatch(BE_PATTERN);
    } finally {
      Object.defineProperty(globalThis, 'crypto', {
        value: realCrypto,
        configurable: true,
      });
    }
  });
});

// ── Inter-action isolation ────────────────────────────────────────────
describe('inter-action isolation — five keys are independent', () => {
  it('all 5 keys are distinct', () => {
    const keys = [
      getOrCreateRecurringRunIdempotencyKey(),
      getOrCreateRecurringProcessDueIdempotencyKey(),
      getOrCreateStockAdjustIdempotencyKey(),
      getOrCreateInventoryFinalizeIdempotencyKey(),
      getOrCreatePayrollVoidIdempotencyKey(),
    ];
    expect(new Set(keys).size).toBe(5);
  });

  it('reset on stock-adjust does NOT affect any of the other 4 keys', () => {
    const r = getOrCreateRecurringRunIdempotencyKey();
    const p = getOrCreateRecurringProcessDueIdempotencyKey();
    getOrCreateStockAdjustIdempotencyKey();
    const f = getOrCreateInventoryFinalizeIdempotencyKey();
    const v = getOrCreatePayrollVoidIdempotencyKey();
    resetStockAdjustIdempotencyKey();
    expect(getOrCreateRecurringRunIdempotencyKey()).toBe(r);
    expect(getOrCreateRecurringProcessDueIdempotencyKey()).toBe(p);
    expect(getOrCreateInventoryFinalizeIdempotencyKey()).toBe(f);
    expect(getOrCreatePayrollVoidIdempotencyKey()).toBe(v);
  });

  it('reset on payroll-void does NOT affect any of the other 4 keys', () => {
    const r = getOrCreateRecurringRunIdempotencyKey();
    const p = getOrCreateRecurringProcessDueIdempotencyKey();
    const s = getOrCreateStockAdjustIdempotencyKey();
    const f = getOrCreateInventoryFinalizeIdempotencyKey();
    getOrCreatePayrollVoidIdempotencyKey();
    resetPayrollVoidIdempotencyKey();
    expect(getOrCreateRecurringRunIdempotencyKey()).toBe(r);
    expect(getOrCreateRecurringProcessDueIdempotencyKey()).toBe(p);
    expect(getOrCreateStockAdjustIdempotencyKey()).toBe(s);
    expect(getOrCreateInventoryFinalizeIdempotencyKey()).toBe(f);
  });
});

// ── URL gate — method-aware (POST vs DELETE) ─────────────────────────
describe('attachFinalOpsIdempotencyKeyIfApplicable — URL gate', () => {
  // POST routes
  const postCases: Array<[string, string, () => string]> = [
    ['recurring-run',         `/recurring-expenses/${RECURRING_ID}/run`,    getOrCreateRecurringRunIdempotencyKey],
    ['recurring-process-due', '/recurring-expenses/process-due',            getOrCreateRecurringProcessDueIdempotencyKey],
    ['stock-adjust',          '/stock/adjust',                              getOrCreateStockAdjustIdempotencyKey],
    ['inventory-finalize',    `/inventory-counts/${COUNT_ID}/finalize`,     getOrCreateInventoryFinalizeIdempotencyKey],
  ];
  it.each(postCases)('POST %s attaches the correct key', (_, url, getter) => {
    const cfg: any = { method: 'post', url, headers: {} };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(getter());
  });

  // DELETE route — first of its kind across all 14 helpers
  it('DELETE /payroll/:id attaches the payroll-void key', () => {
    const cfg: any = {
      method: 'delete',
      url: `/payroll/${EMPLOYEE_TXN_ID}`,
      headers: {},
    };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBe(
      getOrCreatePayrollVoidIdempotencyKey(),
    );
  });

  // Method specificity ── core invariant
  it('POST /payroll/:id does NOT attach (BE expects DELETE)', () => {
    const cfg: any = {
      method: 'post',
      url: `/payroll/${EMPLOYEE_TXN_ID}`,
      headers: {},
    };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('PATCH /payroll/:id does NOT attach (state — BE expects DELETE for void)', () => {
    const cfg: any = {
      method: 'patch',
      url: `/payroll/${EMPLOYEE_TXN_ID}`,
      headers: {},
    };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('DELETE on the four POST routes does NOT attach', () => {
    for (const url of [
      `/recurring-expenses/${RECURRING_ID}/run`,
      '/recurring-expenses/process-due',
      '/stock/adjust',
      `/inventory-counts/${COUNT_ID}/finalize`,
    ]) {
      const cfg: any = { method: 'delete', url, headers: {} };
      attachFinalOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('PATCH on the four POST routes does NOT attach', () => {
    for (const url of [
      `/recurring-expenses/${RECURRING_ID}/run`,
      '/recurring-expenses/process-due',
      '/stock/adjust',
      `/inventory-counts/${COUNT_ID}/finalize`,
    ]) {
      const cfg: any = { method: 'patch', url, headers: {} };
      attachFinalOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  // Same-key + reset semantics
  it('SAME stock-adjust key on second POST for same intent (retry)', () => {
    const cfg1: any = { method: 'post', url: '/stock/adjust', headers: {} };
    const cfg2: any = { method: 'post', url: '/stock/adjust', headers: {} };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg1);
    attachFinalOpsIdempotencyKeyIfApplicable(cfg2);
    expect(cfg1.headers['Idempotency-Key']).toBe(cfg2.headers['Idempotency-Key']);
  });

  it('after reset, next POST stock-adjust uses NEW key', () => {
    const cfg1: any = { method: 'post', url: '/stock/adjust', headers: {} };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg1);
    const k1 = cfg1.headers['Idempotency-Key'];
    resetStockAdjustIdempotencyKey();
    const cfg2: any = { method: 'post', url: '/stock/adjust', headers: {} };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['Idempotency-Key']).not.toBe(k1);
  });

  it('SAME payroll-void key on second DELETE for same intent (retry)', () => {
    const cfg1: any = {
      method: 'delete',
      url: `/payroll/${EMPLOYEE_TXN_ID}`,
      headers: {},
    };
    const cfg2: any = {
      method: 'delete',
      url: `/payroll/${EMPLOYEE_TXN_ID}`,
      headers: {},
    };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg1);
    attachFinalOpsIdempotencyKeyIfApplicable(cfg2);
    expect(cfg1.headers['Idempotency-Key']).toBe(cfg2.headers['Idempotency-Key']);
  });

  it('after reset, next DELETE payroll-void uses NEW key', () => {
    const cfg1: any = {
      method: 'delete',
      url: `/payroll/${EMPLOYEE_TXN_ID}`,
      headers: {},
    };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg1);
    const k1 = cfg1.headers['Idempotency-Key'];
    resetPayrollVoidIdempotencyKey();
    const cfg2: any = {
      method: 'delete',
      url: `/payroll/${EMPLOYEE_TXN_ID}`,
      headers: {},
    };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['Idempotency-Key']).not.toBe(k1);
  });

  // ── Out-of-scope rejections — recurring-expenses CRUD/pause/resume ──
  it('does NOT attach on POST /recurring-expenses (create — state)', () => {
    const cfg: any = { method: 'post', url: '/recurring-expenses', headers: {} };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on PATCH /recurring-expenses/:id (state)', () => {
    const cfg: any = {
      method: 'patch',
      url: `/recurring-expenses/${RECURRING_ID}`,
      headers: {},
    };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on DELETE /recurring-expenses/:id (state)', () => {
    const cfg: any = {
      method: 'delete',
      url: `/recurring-expenses/${RECURRING_ID}`,
      headers: {},
    };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on POST /recurring-expenses/:id/pause (state)', () => {
    const cfg: any = {
      method: 'post',
      url: `/recurring-expenses/${RECURRING_ID}/pause`,
      headers: {},
    };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on POST /recurring-expenses/:id/resume (state)', () => {
    const cfg: any = {
      method: 'post',
      url: `/recurring-expenses/${RECURRING_ID}/resume`,
      headers: {},
    };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  // ── Out-of-scope rejections — stock non-adjust ──
  it('does NOT attach on stock read/list/sync routes', () => {
    for (const url of [
      '/stock',
      '/stock/warehouses',
      '/stock/adjustments',
      '/stock/movements',
      '/stock/sync',
      '/stock/forVariant',
      `/stock/${COUNT_ID}`,
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachFinalOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  // ── Out-of-scope rejections — inventory-counts non-finalize ──
  it('does NOT attach on inventory-counts start/entries/cancel/read routes', () => {
    for (const url of [
      '/inventory-counts',
      '/inventory-counts/start',
      `/inventory-counts/${COUNT_ID}`,
      `/inventory-counts/${COUNT_ID}/entries`,
      `/inventory-counts/${COUNT_ID}/cancel`,
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachFinalOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  // ── Out-of-scope rejections — payroll POST/create + employee family ──
  it('does NOT attach on POST /payroll (create — out of scope per audit)', () => {
    const cfg: any = { method: 'post', url: '/payroll', headers: {} };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  it('does NOT attach on /employees/:id/{bonuses,deductions,settlements} (owned by payroll-idempotency)', () => {
    for (const seg of ['bonuses', 'deductions', 'settlements']) {
      const cfg: any = {
        method: 'post',
        url: `/employees/${EMPLOYEE_ID}/${seg}`,
        headers: {},
      };
      attachFinalOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  // ── Out-of-scope rejections — GET on the five target paths ──
  it('does NOT attach on GETs for any of the five target paths', () => {
    for (const url of [
      `/recurring-expenses/${RECURRING_ID}/run`,
      '/recurring-expenses/process-due',
      '/stock/adjust',
      `/inventory-counts/${COUNT_ID}/finalize`,
      `/payroll/${EMPLOYEE_TXN_ID}`,
    ]) {
      const cfg: any = { method: 'get', url, headers: {} };
      attachFinalOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  // ── Look-alike URLs ──
  it('does NOT attach on POSTs to look-alike URLs (exact regex anchor)', () => {
    for (const url of [
      // Suffix attacks
      `/recurring-expenses/${RECURRING_ID}/run/anything-else`,
      '/stock/adjust/abc',
      `/inventory-counts/${COUNT_ID}/finalize/x`,
      // Singular/plural traps
      '/recurring-expense/process-due',
      '/stocks/adjust',
      '/inventory-count/abc/finalize',
      // Look-alike segments
      `/recurring-expenses/${RECURRING_ID}/runs`,
      `/inventory-counts/${RECURRING_ID}/finalized`,
      // Cross-controller siblings
      '/pos/invoices',
      '/cash-desk/transfer',
      '/accounts/journal',
      `/employees/${EMPLOYEE_ID}/bonuses`,
      // Offline sync
      '/sync/push',
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachFinalOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('does NOT attach on DELETEs to look-alike payroll URLs', () => {
    for (const url of [
      // Suffix
      `/payroll/${EMPLOYEE_TXN_ID}/extra`,
      `/payroll/${EMPLOYEE_TXN_ID}/void`,
      // Plural/singular
      '/payrolls/abc',
      // Cross-controller — DELETE on /employees/:id is protected by RBAC,
      // not idempotency, and is owned by the employees flow if anything.
      // Critically, our PAYROLL_VOID_RE must not match it.
      `/employees/${EMPLOYEE_ID}`,
      // POSITIVE: /payroll/:id IS the only DELETE route this helper
      // accepts — guarded by tests above.
    ]) {
      const cfg: any = { method: 'delete', url, headers: {} };
      attachFinalOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('preserves a caller-provided Idempotency-Key in 3 casing variants', () => {
    const cfg1: any = {
      method: 'post', url: '/stock/adjust',
      headers: { 'Idempotency-Key': 'caller-supplied-adjust-1234' },
    };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg1);
    expect(cfg1.headers['Idempotency-Key']).toBe('caller-supplied-adjust-1234');

    const cfg2: any = {
      method: 'post', url: '/recurring-expenses/process-due',
      headers: { 'idempotency-key': 'caller-supplied-procdue-1234' },
    };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['idempotency-key']).toBe('caller-supplied-procdue-1234');
    expect(cfg2.headers['Idempotency-Key']).toBeUndefined();

    const cfg3: any = {
      method: 'delete', url: `/payroll/${EMPLOYEE_TXN_ID}`,
      headers: { 'IDEMPOTENCY-KEY': 'caller-supplied-void-1234' },
    };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg3);
    expect(cfg3.headers['IDEMPOTENCY-KEY']).toBe('caller-supplied-void-1234');
    expect(cfg3.headers['Idempotency-Key']).toBeUndefined();
  });

  it('matches case-insensitively on the HTTP method', () => {
    const cfg1: any = { method: 'POST', url: '/stock/adjust', headers: {} };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg1);
    expect(cfg1.headers['Idempotency-Key']).toMatch(BE_PATTERN);
    const cfg2: any = {
      method: 'DELETE',
      url: `/payroll/${EMPLOYEE_TXN_ID}`,
      headers: {},
    };
    attachFinalOpsIdempotencyKeyIfApplicable(cfg2);
    expect(cfg2.headers['Idempotency-Key']).toMatch(BE_PATTERN);
  });

  it('different recurring_ids on /:id/run SHARE the run key (intent boundary is the click)', () => {
    const cfgA: any = {
      method: 'post',
      url: '/recurring-expenses/aaaa-1111/run',
      headers: {},
    };
    const cfgB: any = {
      method: 'post',
      url: '/recurring-expenses/bbbb-2222/run',
      headers: {},
    };
    attachFinalOpsIdempotencyKeyIfApplicable(cfgA);
    attachFinalOpsIdempotencyKeyIfApplicable(cfgB);
    expect(cfgA.headers['Idempotency-Key']).toBe(cfgB.headers['Idempotency-Key']);
  });
});

// ── Cross-route isolation against unrelated sibling helpers ──────────
describe('cross-route isolation — final-ops helper vs unrelated siblings', () => {
  it('final-ops helper does NOT attach to other controllers', () => {
    for (const url of [
      '/pos/invoices',
      '/cash-desk/transfer',
      '/cash-desk/deposit',
      '/cash-desk/customer-payments',
      '/cash-desk/supplier-payments',
      `/reservations/${COUNT_ID}/cancel`,
      `/returns/${COUNT_ID}/refund`,
      '/exchanges',
      '/accounting/expenses',
      '/accounts/journal',
      `/employees/${EMPLOYEE_ID}/bonuses`,
      `/employees/${EMPLOYEE_ID}/deductions`,
      `/employees/${EMPLOYEE_ID}/settlements`,
      `/shifts/${COUNT_ID}/close`,
      '/stock-transfers',
      `/stock-transfers/${COUNT_ID}/ship`,
      `/purchases/${COUNT_ID}/receive`,
      `/attendance/admin/approve-wage/${EMPLOYEE_ID}`,
    ]) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachFinalOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });

  it('the payroll/stock-purchases/checkout helpers do NOT attach to any of the 5 final-ops routes', () => {
    const fns = [
      attachPayrollIdempotencyKeyIfApplicable,
      attachStockPurchasesIdempotencyKeyIfApplicable,
      attachCheckoutIdempotencyKeyIfApplicable,
    ];
    const targets: Array<[string, string]> = [
      ['post', `/recurring-expenses/${RECURRING_ID}/run`],
      ['post', '/recurring-expenses/process-due'],
      ['post', '/stock/adjust'],
      ['post', `/inventory-counts/${COUNT_ID}/finalize`],
      ['delete', `/payroll/${EMPLOYEE_TXN_ID}`],
    ];
    for (const [method, url] of targets) {
      for (const fn of fns) {
        const cfg: any = { method, url, headers: {} };
        fn(cfg);
        expect(cfg.headers['Idempotency-Key']).toBeUndefined();
      }
    }
  });

  // Critical: the payroll-idempotency helper handles
  // /attendance/admin/* and /employees/:id/{bonuses,deductions,
  // settlements}. It must NOT match /payroll/:id (DELETE) — that's
  // owned by THIS new final-ops helper.
  it('payroll-idempotency helper does NOT match DELETE /payroll/:id', () => {
    const cfg: any = {
      method: 'delete',
      url: `/payroll/${EMPLOYEE_TXN_ID}`,
      headers: {},
    };
    attachPayrollIdempotencyKeyIfApplicable(cfg);
    expect(cfg.headers['Idempotency-Key']).toBeUndefined();
  });

  // And vice-versa: this helper must NOT fire on the
  // payroll-idempotency-owned attendance/employee URLs.
  it('final-ops helper does NOT match attendance admin or employee-financial URLs', () => {
    const urls = [
      `/attendance/admin/approve-wage/${EMPLOYEE_ID}`,
      `/attendance/admin/void-accrual/${EMPLOYEE_ID}`,
      '/attendance/admin/approve-wage-override',
      '/attendance/admin/pay-wage',
      `/employees/${EMPLOYEE_ID}/bonuses`,
      `/employees/${EMPLOYEE_ID}/deductions`,
      `/employees/${EMPLOYEE_ID}/settlements`,
    ];
    for (const url of urls) {
      const cfg: any = { method: 'post', url, headers: {} };
      attachFinalOpsIdempotencyKeyIfApplicable(cfg);
      expect(cfg.headers['Idempotency-Key']).toBeUndefined();
    }
  });
});
